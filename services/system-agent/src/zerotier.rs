//! The ZeroTier local API client (ADR-0020).
//!
//! `zerotier-one` exposes a JSON API on `127.0.0.1:9993`, opened by a token in
//! `/var/lib/zerotier-one/authtoken.secret` — mode 0600, and it grants network control. That is
//! why this lives in the agent and not in the API: holding privileged secrets is the agent's
//! reason to exist, and the unprivileged side must not be able to read this one.
//!
//! Three properties are load-bearing here.
//!
//!   1. **The address is a constant.** Making it configurable would turn the agent into a device
//!      for issuing HTTP requests to wherever the configuration says — a request forgery
//!      primitive running as root. There is no setting, no environment variable, no argument.
//!   2. **The operation set is closed.** Nothing in this module takes a caller-supplied path,
//!      method or body. The only caller-supplied value that reaches a request line is a
//!      `NetworkId`, which is sixteen hex digits by construction.
//!   3. **The token never leaves.** It is read, put in one header, and dropped. It is not in any
//!      error message, any audit entry, or any `Debug` output — `ZeroTierError` has no variant
//!      that can carry it.
//!
//! ## Why `std::net` and not `rustix::net`
//!
//! Both were available and neither adds a crate. `std::net::TcpStream` wins on two counts that
//! matter more than the syscall being one layer closer: it carries `connect_timeout` and
//! `set_read_timeout` — the two things a client of a daemon that might be wedged cannot do
//! without — and it compiles on Windows, so this module needs no `cfg` at all. `rustix` is a
//! `cfg(unix)` dependency of this crate, and a `cfg` here would be the first one in the library
//! half, which CI cross-checks against the Windows target precisely to keep that from happening
//! (ADR-0006). On a machine with no ZeroTier the calls below simply report it as unavailable,
//! which is the same answer they give on a Linux box without the daemon.
//!
//! ## Why the HTTP is written out by hand
//!
//! No HTTP crate is worth adding to a root daemon for four requests to loopback. What is written
//! by hand has to be written correctly, and the parts that break silently when skipped are:
//! reading the response's `Content-Length` instead of guessing at EOF (the daemon answers with
//! `Keep-Alive: timeout=5`, so reading to EOF stalls for five seconds on every call), refusing
//! `Transfer-Encoding: chunked` out loud rather than parsing the chunk headers as body, and
//! bounding the response so that a reply decides at most a fixed amount of the agent's memory.

use crate::op::{NetworkId, ZeroTierNetwork, ZeroTierNetworkStatus};
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::Duration;

/// The local API. A `const`, and see the module note: this is the whole reason the agent cannot
/// be talked into addressing anything else.
pub const LOCAL_API: SocketAddr =
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 9993));

/// Where `zerotier-one` writes the token that opens the local API.
pub const AUTH_TOKEN_PATH: &str = "/var/lib/zerotier-one/authtoken.secret";

/// A daemon on loopback either answers at once or is not there. Two seconds is generous.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// Read and write deadline. A wedged `zerotier-one` must not block the agent's serial control
/// loop indefinitely — an unresponsive third-party daemon would otherwise take the whole
/// privileged surface down with it.
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// Header ceiling. Far above anything the daemon sends; low enough that a peer that never sends
/// a blank line cannot grow the buffer without bound.
const MAX_HEAD: usize = 16 * 1024;

/// Body ceiling. `/network` on a node in a hundred networks is a few tens of kilobytes.
const MAX_BODY: usize = 256 * 1024;

/// A token is 24 URL-safe characters today. The bound is a sanity check on the file, not a
/// format claim.
const MAX_TOKEN: usize = 128;

/// What went wrong talking to `zerotier-one`.
///
/// No variant carries the token, and none can: the two that touch it (`NoToken`,
/// `MalformedToken`) describe the file, never its contents. That is deliberate — an error string
/// ends up in the audit trail and in the journal, and §16 forbids secrets in both.
#[derive(Debug, thiserror::Error)]
pub enum ZeroTierError {
    /// The token file is missing or unreadable. On a box that does not run ZeroTier this is the
    /// normal state, not a fault — DEPSIS does not package it (ADR-0020).
    #[error("zerotier-one is not installed here: {AUTH_TOKEN_PATH} cannot be read ({detail})")]
    NoToken { detail: String },

    /// The token file exists but does not hold a plain token.
    ///
    /// Distinct from `NoToken` because it means the opposite thing: ZeroTier is installed and
    /// something is wrong with it. Reporting that as "not installed" would send the operator to
    /// `apt install` instead of to the file.
    #[error("the local API token file exists but does not contain a plain token")]
    MalformedToken,

    /// Nothing is listening, or it did not answer in time.
    #[error("zerotier-one is not answering on {LOCAL_API}: {detail}")]
    NotRunning { detail: String },

    #[error("local API i/o: {0}")]
    Io(String),

    /// The daemon refused the token. Installed, running, and misconfigured — a fault.
    #[error("the local API refused our token (HTTP {status}); is the agent reading the running daemon's token file?")]
    Unauthorized { status: u16 },

    #[error("the local API answered HTTP {status}")]
    Http { status: u16 },

    #[error("the local API's answer was not understood: {0}")]
    Protocol(String),

    #[error("the local API's {what} exceeded the {limit} byte ceiling")]
    TooLarge { what: &'static str, limit: usize },
}

impl ZeroTierError {
    /// Is this "ZeroTier is switched off here" rather than "ZeroTier is broken"?
    ///
    /// The distinction the operator needs most (ADR-0020): the API turns `true` into 503 and a
    /// card that says "not installed", and everything else into a failure that wants looking at.
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::NoToken { .. } | Self::NotRunning { .. })
    }
}

/// The local node, as `/status` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeStatus {
    pub node_id: String,
    pub online: bool,
    pub version: String,
}

// ── the four operations ──

pub fn status() -> Result<NodeStatus, ZeroTierError> {
    parse_status_body(&call(Method::Get, "/status", "")?)
}

pub fn networks() -> Result<Vec<ZeroTierNetwork>, ZeroTierError> {
    parse_networks_body(&call(Method::Get, "/network", "")?)
}

/// Join a network.
///
/// The body is an empty JSON object: joining takes no settings from DEPSIS, and sending a
/// configuration would mean the agent deciding things (`allowManaged`, `allowGlobal`) that the
/// network's own configuration should decide.
pub fn join(network_id: &NetworkId) -> Result<ZeroTierNetwork, ZeroTierError> {
    let body = call(Method::Post, &network_path(network_id), "{}")?;
    parse_network_body(&body, network_id)
}

pub fn leave(network_id: &NetworkId) -> Result<(), ZeroTierError> {
    call(Method::Delete, &network_path(network_id), "")?;
    Ok(())
}

/// The one place a caller-supplied value becomes part of a request path.
///
/// It takes a `NetworkId`, not a `&str`, so there is no version of this function that can be
/// called with something unvalidated.
fn network_path(network_id: &NetworkId) -> String {
    format!("/network/{}", network_id.as_str())
}

// ── the client ──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
    Delete,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Delete => "DELETE",
        }
    }
}

/// One request, one connection, one response body.
///
/// No connection reuse. The agent makes at most a handful of these per user action, and a pooled
/// connection to a daemon that may restart underneath us would trade a measurable amount of
/// nothing for a class of bug that only appears in production.
fn call(method: Method, path: &str, body: &str) -> Result<Vec<u8>, ZeroTierError> {
    // Read per call rather than cached. The daemon rewrites this file when it is reinstalled or
    // its state directory is recreated, and a cached token would then produce a 401 that looks
    // like a permissions problem until somebody restarts the agent.
    let token = auth_token()?;
    let request = build_request(method, path, &token, body);

    let mut stream = TcpStream::connect_timeout(&LOCAL_API, CONNECT_TIMEOUT).map_err(|e| {
        ZeroTierError::NotRunning {
            detail: e.to_string(),
        }
    })?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| ZeroTierError::Io(format!("set read timeout: {e}")))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| ZeroTierError::Io(format!("set write timeout: {e}")))?;

    stream.write_all(&request).map_err(write_error)?;
    stream.flush().map_err(write_error)?;

    let (status, body) = read_response(&mut stream)?;
    match status {
        200 | 201 | 204 => Ok(body),
        // 403 is the daemon's answer to a request from a non-loopback address; 401 to a bad
        // token. Neither is something a DEPSIS user did, and both mean the same to the operator.
        401 | 403 => Err(ZeroTierError::Unauthorized { status }),
        other => Err(ZeroTierError::Http { status: other }),
    }
}

/// A failed write is a daemon that went away mid-request more often than it is a broken socket,
/// so it reports as "not running" — which is the answer that sends the operator to
/// `systemctl status zerotier-one` rather than to us.
fn write_error(e: std::io::Error) -> ZeroTierError {
    ZeroTierError::NotRunning {
        detail: format!("writing the request: {e}"),
    }
}

fn read_error(e: std::io::Error) -> ZeroTierError {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            ZeroTierError::NotRunning {
                detail: format!("no answer within {IO_TIMEOUT:?}"),
            }
        }
        _ => ZeroTierError::Io(format!("reading the response: {e}")),
    }
}

/// Read the local API token.
///
/// Missing or unreadable means "no ZeroTier here" and gets its own error variant, because it is
/// the state of every box that never installed it — a generic i/o error would make the ordinary
/// case look like a fault.
fn auth_token() -> Result<String, ZeroTierError> {
    let raw = std::fs::read(AUTH_TOKEN_PATH).map_err(|e| ZeroTierError::NoToken {
        detail: e.to_string(),
    })?;
    let text = String::from_utf8(raw).map_err(|_| ZeroTierError::MalformedToken)?;
    let token = text.trim();
    if !token_is_well_formed(token) {
        return Err(ZeroTierError::MalformedToken);
    }
    Ok(token.to_string())
}

/// Would this be safe to put in a header value?
///
/// The charset check is a header-injection guard, not tidiness. The token is interpolated into a
/// request line, so a file containing a CR/LF would let whoever can write it append headers — or
/// a whole second request — to everything the agent sends. The file is root-owned, which makes
/// this defence in depth; it costs one line and removes the need to reason about who can write
/// there.
///
/// Its own function so the rule can be tested without a token file on disk. `auth_token` is the
/// only caller.
fn token_is_well_formed(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_TOKEN
        && token.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Build one HTTP/1.1 request.
///
/// `Content-Length` is always written, `0` included. The daemon keeps the connection alive, so
/// "the request ends where the bytes stop" is not available to it: without a length it waits for
/// a body that never comes and the call dies on the read timeout instead of answering.
fn build_request(method: Method, path: &str, token: &str, body: &str) -> Vec<u8> {
    format!(
        "{method} {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         X-ZT1-Auth: {token}\r\n\
         Accept: application/json\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        method = method.as_str(),
        host = LOCAL_API,
        len = body.len(),
    )
    .into_bytes()
}

#[derive(Debug, PartialEq, Eq)]
struct Head {
    status: u16,
    content_length: Option<usize>,
    chunked: bool,
}

/// The index just past the blank line that ends the headers.
fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn parse_head(head: &[u8]) -> Result<Head, ZeroTierError> {
    let text = std::str::from_utf8(head)
        .map_err(|_| ZeroTierError::Protocol("the response head is not UTF-8".to_string()))?;
    let mut lines = text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| ZeroTierError::Protocol("empty response".to_string()))?;

    let mut parts = status_line.split(' ');
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/1.") {
        return Err(ZeroTierError::Protocol(format!(
            "expected an HTTP/1.x status line, got {status_line:?}"
        )));
    }
    let status: u16 = parts
        .next()
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| ZeroTierError::Protocol(format!("no status code in {status_line:?}")))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(ZeroTierError::Protocol(format!(
                "malformed header line {line:?}"
            )));
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "content-length" => {
                let n: usize = value.parse().map_err(|_| {
                    ZeroTierError::Protocol(format!("Content-Length {value:?} is not a number"))
                })?;
                // Two different lengths is a request-smuggling shape, not a quirk. Refuse
                // rather than pick one.
                if content_length.is_some_and(|prev| prev != n) {
                    return Err(ZeroTierError::Protocol(
                        "the response carried conflicting Content-Length headers".to_string(),
                    ));
                }
                content_length = Some(n);
            }
            // `contains` rather than `==`: the header may be a list, and `gzip, chunked` is
            // still chunked.
            "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => {
                chunked = true;
            }
            _ => {}
        }
    }
    Ok(Head {
        status,
        content_length,
        chunked,
    })
}

/// Read one complete HTTP response: status code and body.
///
/// Generic over `Read` so the whole parser can be exercised against byte slices, including the
/// cases a socket almost never produces on loopback and always produces eventually — headers
/// split across reads, a body that stops early, a length that lies.
fn read_response<R: Read>(reader: &mut R) -> Result<(u16, Vec<u8>), ZeroTierError> {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];

    let end = loop {
        if let Some(end) = head_end(&buf) {
            break end;
        }
        if buf.len() > MAX_HEAD {
            return Err(ZeroTierError::TooLarge {
                what: "response headers",
                limit: MAX_HEAD,
            });
        }
        let n = reader.read(&mut chunk).map_err(read_error)?;
        if n == 0 {
            return Err(ZeroTierError::Protocol(
                "the connection closed before the response headers were complete".to_string(),
            ));
        }
        buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
    };

    let head = parse_head(buf.get(..end).unwrap_or_default())?;
    if head.chunked {
        // Refused out loud. Parsing chunk-size lines as though they were body would hand
        // `serde_json` something that fails with a confusing message on a good day and parses
        // into a wrong answer on a bad one. The daemon does not do this today; if a future one
        // does, this says so instead of misreading it.
        return Err(ZeroTierError::Protocol(
            "the local API answered with Transfer-Encoding: chunked, which this client does not \
             decode"
                .to_string(),
        ));
    }
    // 204 has no body by definition, and waiting for one would mean waiting for the read
    // timeout on a connection the daemon is keeping alive.
    if head.status == 204 {
        return Ok((head.status, Vec::new()));
    }

    let mut body = buf.split_off(end);
    match head.content_length {
        Some(len) => {
            if len > MAX_BODY {
                return Err(ZeroTierError::TooLarge {
                    what: "response body",
                    limit: MAX_BODY,
                });
            }
            while body.len() < len {
                let n = reader.read(&mut chunk).map_err(read_error)?;
                if n == 0 {
                    return Err(ZeroTierError::Protocol(format!(
                        "the connection closed after {} of {len} body bytes",
                        body.len()
                    )));
                }
                body.extend_from_slice(chunk.get(..n).unwrap_or_default());
            }
            // A keep-alive peer may have pipelined something after this response. Whatever it
            // is, it is not part of this body.
            body.truncate(len);
        }
        None => {
            // No length and not chunked: the body ends at EOF (RFC 9112 §6.3). We asked for
            // `Connection: close`, so this is well defined — and it is still bounded, by the
            // ceiling here and by the read timeout on the socket.
            loop {
                if body.len() > MAX_BODY {
                    return Err(ZeroTierError::TooLarge {
                        what: "response body",
                        limit: MAX_BODY,
                    });
                }
                let n = reader.read(&mut chunk).map_err(read_error)?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(chunk.get(..n).unwrap_or_default());
            }
        }
    }
    Ok((head.status, body))
}

// ── the daemon's JSON, projected onto our types ──

#[derive(Debug, Deserialize)]
struct RawStatus {
    /// ZeroTier's name for the node id.
    address: String,
    online: bool,
    version: String,
}

#[derive(Debug, Deserialize)]
struct RawNetwork {
    /// Current daemons send `id`; older ones sent `nwid`. Both are accepted rather than
    /// depending on which one is installed.
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    nwid: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "assignedAddresses")]
    assigned_addresses: Vec<String>,
}

impl RawNetwork {
    fn reported_id(&self) -> Option<&str> {
        self.id
            .as_deref()
            .or(self.nwid.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    fn into_network(self, network_id: String) -> ZeroTierNetwork {
        ZeroTierNetwork {
            network_id,
            name: self.name.filter(|n| !n.is_empty()),
            status: network_status(self.status.as_deref()),
            addresses: self.assigned_addresses,
        }
    }
}

/// Map the daemon's status string onto ours.
///
/// Anything unrecognised becomes `Unknown`, never `Ok`. A newer daemon inventing a state and
/// this build reading it as healthy is how an operator ends up looking at a green card for a
/// device that is not reachable.
fn network_status(raw: Option<&str>) -> ZeroTierNetworkStatus {
    match raw.unwrap_or_default() {
        "OK" => ZeroTierNetworkStatus::Ok,
        "ACCESS_DENIED" => ZeroTierNetworkStatus::AccessDenied,
        "NOT_FOUND" => ZeroTierNetworkStatus::NotFound,
        "REQUESTING_CONFIGURATION" => ZeroTierNetworkStatus::RequestingConfiguration,
        "PORT_ERROR" => ZeroTierNetworkStatus::PortError,
        "AUTHENTICATION_REQUIRED" => ZeroTierNetworkStatus::AuthenticationRequired,
        _ => ZeroTierNetworkStatus::Unknown,
    }
}

fn parse_status_body(body: &[u8]) -> Result<NodeStatus, ZeroTierError> {
    let raw: RawStatus = serde_json::from_slice(body)
        .map_err(|e| ZeroTierError::Protocol(format!("/status: {e}")))?;
    Ok(NodeStatus {
        node_id: raw.address,
        online: raw.online,
        version: raw.version,
    })
}

fn parse_networks_body(body: &[u8]) -> Result<Vec<ZeroTierNetwork>, ZeroTierError> {
    let raw: Vec<RawNetwork> = serde_json::from_slice(body)
        .map_err(|e| ZeroTierError::Protocol(format!("/network: {e}")))?;
    let mut out = Vec::with_capacity(raw.len());
    for network in raw {
        // No fallback available here, and inventing an empty id would put a row in
        // `remote_networks` that names nothing.
        let id = network
            .reported_id()
            .map(str::to_owned)
            .ok_or_else(|| ZeroTierError::Protocol("a listed network has no id".to_string()))?;
        out.push(network.into_network(id));
    }
    Ok(out)
}

/// The answer to a join. Falls back to the id we asked for, which is the one value in this
/// function known to be well formed.
fn parse_network_body(
    body: &[u8],
    requested: &NetworkId,
) -> Result<ZeroTierNetwork, ZeroTierError> {
    let raw: RawNetwork = serde_json::from_slice(body)
        .map_err(|e| ZeroTierError::Protocol(format!("/network/<id>: {e}")))?;
    let id = raw
        .reported_id()
        .map(str::to_owned)
        .unwrap_or_else(|| requested.as_str().to_owned());
    Ok(raw.into_network(id))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of               service on the one component that cannot be restarted casually. In tests the               opposite is true: a failed assertion SHOULD panic, and indexing a fixture is               clearer than unwrapping an Option."
)]
mod tests {
    use super::*;

    /// A reader that hands back one byte at a time.
    ///
    /// Not a curiosity: a socket is free to split a response anywhere, and a parser that only
    /// ever sees whole responses in one buffer is a parser whose header scanning has never been
    /// tested. Every read here crosses a boundary.
    struct Dribble<'a> {
        rest: &'a [u8],
    }

    impl Read for Dribble<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.rest.is_empty() || buf.is_empty() {
                return Ok(0);
            }
            buf[0] = self.rest[0];
            self.rest = &self.rest[1..];
            Ok(1)
        }
    }

    /// The dev box's `/status`, trimmed to the fields this client reads.
    const REAL_STATUS_BODY: &str = r#"{"address":"ef780bec87","online":true,"version":"1.16.2"}"#;

    /// The daemon's own headers, `Keep-Alive` included — that header is the reason this client
    /// cannot read a body to EOF.
    fn real_status_head() -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\
             Keep-Alive: timeout=5, max=5\r\n\r\n",
            REAL_STATUS_BODY.len()
        )
    }

    // ── the head parser ──

    #[test]
    fn parses_a_real_status_head() {
        let head = parse_head(real_status_head().as_bytes()).expect("parse");
        assert_eq!(
            head,
            Head {
                status: 200,
                content_length: Some(REAL_STATUS_BODY.len()),
                chunked: false,
            }
        );
    }

    #[test]
    fn parses_a_head_with_no_content_length() {
        let head = parse_head(b"HTTP/1.0 200 OK\r\n\r\n").expect("parse");
        assert_eq!(head.content_length, None);
        assert!(!head.chunked);
    }

    #[test]
    fn rejects_a_non_http_status_line() {
        for head in [
            &b"NOT HTTP AT ALL\r\n\r\n"[..],
            &b"HTTP/1.1 banana\r\n\r\n"[..],
            &b"HTTP/1.1\r\n\r\n"[..],
        ] {
            assert!(
                matches!(parse_head(head), Err(ZeroTierError::Protocol(_))),
                "should have refused {:?}",
                String::from_utf8_lossy(head)
            );
        }
    }

    #[test]
    fn rejects_conflicting_content_lengths() {
        let head = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 9\r\n\r\n";
        assert!(matches!(parse_head(head), Err(ZeroTierError::Protocol(_))));
    }

    #[test]
    fn header_names_are_case_insensitive() {
        let head = parse_head(b"HTTP/1.1 200 OK\r\ncOnTeNt-LeNgTh: 7\r\n\r\n").expect("parse");
        assert_eq!(head.content_length, Some(7));
    }

    // ── the response reader ──

    #[test]
    fn reads_a_body_of_exactly_content_length() {
        let wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]{}",
            "trailing junk from a keep-alive peer"
        );
        let (status, body) = read_response(&mut wire.as_bytes()).expect("read");
        assert_eq!(status, 200);
        // The junk is NOT part of this response; a reader that returns it would feed the next
        // response's bytes to `serde_json`.
        assert_eq!(body, b"[]");
    }

    #[test]
    fn reads_correctly_when_the_socket_dribbles_one_byte_at_a_time() {
        let wire = format!("{}{REAL_STATUS_BODY}", real_status_head());
        let mut dribble = Dribble {
            rest: wire.as_bytes(),
        };
        let (status, body) = read_response(&mut dribble).expect("read");
        assert_eq!(status, 200);
        assert_eq!(body.len(), REAL_STATUS_BODY.len());
        let parsed = parse_status_body(&body).expect("parse");
        assert_eq!(parsed.node_id, "ef780bec87");
    }

    #[test]
    fn a_truncated_body_is_an_error_and_not_a_short_answer() {
        // The failure this prevents is the quiet one: returning the six bytes that did arrive
        // and letting `serde_json` report a syntax error somewhere else entirely.
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\n{\"a\":1}";
        assert!(matches!(
            read_response(&mut &wire[..]),
            Err(ZeroTierError::Protocol(_))
        ));
    }

    #[test]
    fn headers_that_never_end_are_refused_rather_than_buffered() {
        let mut wire = String::from("HTTP/1.1 200 OK\r\n");
        while wire.len() <= MAX_HEAD {
            wire.push_str("X-Padding: ....................................................\r\n");
        }
        assert!(matches!(
            read_response(&mut wire.as_bytes()),
            Err(ZeroTierError::TooLarge {
                what: "response headers",
                ..
            })
        ));
    }

    #[test]
    fn a_body_larger_than_the_ceiling_is_refused_before_it_is_read() {
        // The length alone is enough to refuse. Reading it first to find out how big it is would
        // be letting the answer decide the agent's memory.
        let wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(matches!(
            read_response(&mut wire.as_bytes()),
            Err(ZeroTierError::TooLarge {
                what: "response body",
                ..
            })
        ));
    }

    #[test]
    fn an_unbounded_body_is_also_capped() {
        let mut wire = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        wire.resize(wire.len() + MAX_BODY + 4096, b'x');
        assert!(matches!(
            read_response(&mut &wire[..]),
            Err(ZeroTierError::TooLarge {
                what: "response body",
                ..
            })
        ));
    }

    #[test]
    fn a_body_with_no_content_length_is_read_to_eof() {
        let wire = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n[]";
        let (status, body) = read_response(&mut &wire[..]).expect("read");
        assert_eq!(status, 200);
        assert_eq!(body, b"[]");
    }

    #[test]
    fn chunked_is_refused_out_loud_rather_than_misparsed() {
        let wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n[]\r\n0\r\n\r\n";
        match read_response(&mut &wire[..]) {
            Err(ZeroTierError::Protocol(msg)) => assert!(
                msg.contains("chunked"),
                "the refusal must name the reason: {msg}"
            ),
            other => panic!("chunked must be refused, got {other:?}"),
        }
    }

    #[test]
    fn a_closed_connection_before_the_headers_is_an_error() {
        assert!(matches!(
            read_response(&mut &b"HTTP/1.1 200 OK\r\n"[..]),
            Err(ZeroTierError::Protocol(_))
        ));
    }

    #[test]
    fn a_204_needs_no_body_and_does_not_wait_for_one() {
        // No Content-Length, and the peer is keeping the connection alive: a reader that fell
        // through to read-to-EOF here would block until the read timeout on every leave.
        struct NeverEnds;
        impl Read for NeverEnds {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("must not read a body after 204");
            }
        }
        struct Head204 {
            sent: bool,
        }
        impl Read for Head204 {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.sent {
                    return NeverEnds.read(buf);
                }
                self.sent = true;
                let head = b"HTTP/1.1 204 No Content\r\nKeep-Alive: timeout=5\r\n\r\n";
                buf[..head.len()].copy_from_slice(head);
                Ok(head.len())
            }
        }
        let (status, body) = read_response(&mut Head204 { sent: false }).expect("read");
        assert_eq!(status, 204);
        assert!(body.is_empty());
    }

    // ── the request builder ──

    #[test]
    fn a_request_is_well_formed_and_declares_its_length() {
        let wire = build_request(Method::Post, "/network/8056c2e21c000001", "t0ken", "{}");
        let text = String::from_utf8(wire).expect("ascii");
        assert!(text.starts_with("POST /network/8056c2e21c000001 HTTP/1.1\r\n"));
        assert!(text.contains("\r\nHost: 127.0.0.1:9993\r\n"));
        assert!(text.contains("\r\nX-ZT1-Auth: t0ken\r\n"));
        assert!(text.contains("\r\nContent-Length: 2\r\n"));
        assert!(text.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn a_bodyless_request_still_declares_a_length() {
        // Without it the daemon waits for a body that never arrives and the call dies on the
        // read timeout instead of answering.
        let text =
            String::from_utf8(build_request(Method::Get, "/status", "t0ken", "")).expect("ascii");
        assert!(text.contains("\r\nContent-Length: 0\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn the_only_caller_supplied_value_in_a_path_is_a_network_id() {
        // `network_path` cannot be handed anything else: it takes the type, and the type is
        // sixteen hex digits. This test is the reminder, not the enforcement.
        let id = NetworkId::parse("8056c2e21c000001").expect("valid");
        assert_eq!(network_path(&id), "/network/8056c2e21c000001");
        let text = String::from_utf8(build_request(
            Method::Delete,
            &network_path(&id),
            "t0ken",
            "",
        ))
        .expect("ascii");
        assert_eq!(text.matches("\r\n").count(), 8, "no smuggled header break");
    }

    // ── the JSON projection ──

    #[test]
    fn projects_a_real_status_document() {
        // Trimmed from the dev box's actual `/status`, extra fields included, because ignoring
        // fields we do not model is the behaviour being asserted.
        let body = br#"{"address":"ef780bec87","clock":1787403092367,"online":true,
            "planetWorldId":149604618,"tcpFallbackActive":false,"version":"1.16.2",
            "versionMajor":1,"versionMinor":16,"versionRev":2}"#;
        let status = parse_status_body(body).expect("parse");
        assert_eq!(status.node_id, "ef780bec87");
        assert!(status.online);
        assert_eq!(status.version, "1.16.2");
    }

    #[test]
    fn an_empty_network_list_is_a_valid_answer() {
        // A node that has joined nothing answers `[]`, and that is the correct answer rather
        // than a reason to report ZeroTier as unavailable.
        assert_eq!(parse_networks_body(b"[]").expect("parse"), Vec::new());
    }

    #[test]
    fn projects_a_joined_but_unauthorized_network() {
        let body = br#"[{"id":"8056c2e21c000001","nwid":"8056c2e21c000001","name":"",
            "status":"ACCESS_DENIED","type":"PRIVATE","mtu":2800,"assignedAddresses":[]}]"#;
        let networks = parse_networks_body(body).expect("parse");
        let network = networks.first().expect("one network");
        assert_eq!(network.network_id, "8056c2e21c000001");
        assert_eq!(network.status, ZeroTierNetworkStatus::AccessDenied);
        // An empty name is absent, not the empty string: the UI has a fallback for absent and
        // would render "" as a nameless row.
        assert_eq!(network.name, None);
        assert!(network.addresses.is_empty());
    }

    #[test]
    fn projects_an_authorized_network_with_its_addresses() {
        let body = br#"[{"id":"8056c2e21c000001","name":"home","status":"OK",
            "assignedAddresses":["10.147.17.42/24","fd80:56c2::1/88"]}]"#;
        let networks = parse_networks_body(body).expect("parse");
        let network = networks.first().expect("one network");
        assert_eq!(network.name.as_deref(), Some("home"));
        assert_eq!(network.status, ZeroTierNetworkStatus::Ok);
        assert_eq!(network.addresses.len(), 2);
    }

    #[test]
    fn an_unrecognised_status_becomes_unknown_and_never_ok() {
        for raw in [
            Some("MOO"),
            Some("ok"),
            Some(""),
            Some("OK "),
            None,
            Some("REQUESTING_CONFIGURATION_V2"),
        ] {
            assert_eq!(
                network_status(raw),
                ZeroTierNetworkStatus::Unknown,
                "{raw:?} must not be read as a state this build understands"
            );
        }
        // And the ones it does understand still map.
        assert_eq!(network_status(Some("OK")), ZeroTierNetworkStatus::Ok);
        assert_eq!(
            network_status(Some("PORT_ERROR")),
            ZeroTierNetworkStatus::PortError
        );
        assert_eq!(
            network_status(Some("AUTHENTICATION_REQUIRED")),
            ZeroTierNetworkStatus::AuthenticationRequired
        );
        assert_eq!(
            network_status(Some("NOT_FOUND")),
            ZeroTierNetworkStatus::NotFound
        );
        assert_eq!(
            network_status(Some("REQUESTING_CONFIGURATION")),
            ZeroTierNetworkStatus::RequestingConfiguration
        );
    }

    #[test]
    fn an_old_daemon_reporting_only_nwid_still_projects() {
        let body = br#"[{"nwid":"8056c2e21c000001","status":"OK","assignedAddresses":[]}]"#;
        let networks = parse_networks_body(body).expect("parse");
        assert_eq!(
            networks.first().expect("one network").network_id,
            "8056c2e21c000001"
        );
    }

    #[test]
    fn a_listed_network_with_no_id_is_refused_rather_than_named_nothing() {
        let body = br#"[{"status":"OK","assignedAddresses":[]}]"#;
        assert!(matches!(
            parse_networks_body(body),
            Err(ZeroTierError::Protocol(_))
        ));
    }

    #[test]
    fn a_join_answer_falls_back_to_the_id_we_asked_for() {
        let requested = NetworkId::parse("8056c2e21c000001").expect("valid");
        let network = parse_network_body(br#"{"status":"REQUESTING_CONFIGURATION"}"#, &requested)
            .expect("parse");
        assert_eq!(network.network_id, "8056c2e21c000001");
        assert_eq!(
            network.status,
            ZeroTierNetworkStatus::RequestingConfiguration
        );
    }

    #[test]
    fn a_body_that_is_not_json_is_a_protocol_error_not_a_panic() {
        assert!(matches!(
            parse_status_body(b"<html>nope</html>"),
            Err(ZeroTierError::Protocol(_))
        ));
        assert!(matches!(
            parse_networks_body(b""),
            Err(ZeroTierError::Protocol(_))
        ));
    }

    // ── errors ──

    #[test]
    fn absent_and_broken_are_different_answers() {
        assert!(ZeroTierError::NoToken { detail: "x".into() }.is_unavailable());
        assert!(ZeroTierError::NotRunning { detail: "x".into() }.is_unavailable());
        // Installed and misconfigured. Reporting these as "not installed" would send the
        // operator to `apt install` for a daemon that is already running.
        assert!(!ZeroTierError::MalformedToken.is_unavailable());
        assert!(!ZeroTierError::Unauthorized { status: 401 }.is_unavailable());
        assert!(!ZeroTierError::Http { status: 500 }.is_unavailable());
        assert!(!ZeroTierError::Protocol("x".into()).is_unavailable());
    }

    #[test]
    fn a_token_shaped_file_is_never_echoed_back() {
        // §16: these strings reach the audit trail and the journal, so none of them may carry
        // the secret. The enum is what makes this hold — the two variants that touch the token
        // describe the FILE (`AUTH_TOKEN_PATH` is a constant, not a secret) and have no field a
        // token could be put in. The assertion below is the reminder for whoever adds the next
        // variant.
        for message in [
            ZeroTierError::NoToken {
                detail: "No such file or directory (os error 2)".to_string(),
            }
            .to_string(),
            ZeroTierError::MalformedToken.to_string(),
            ZeroTierError::Unauthorized { status: 401 }.to_string(),
        ] {
            // Whatever the running daemon's token happens to be, it is 24 alphanumerics. No
            // error message may contain a run that long.
            let longest_alnum_run = message
                .split(|c: char| !c.is_ascii_alphanumeric())
                .map(str::len)
                .max()
                .unwrap_or(0);
            assert!(
                longest_alnum_run < 24,
                "an error message carried a token-shaped run: {message}"
            );
        }
    }

    #[test]
    fn a_token_file_that_could_forge_headers_is_refused() {
        // The value is interpolated into a request line, so a CR or LF in the file would let
        // whoever can write it append headers — or a whole second request. The file is
        // root-owned, which makes this defence in depth rather than the only barrier.
        for candidate in [
            "0123456789abcdefghijklmn\r\nX-ZT1-Auth: other",
            "0123456789abcdefghijklmn\nHost: elsewhere",
            "token with spaces",
            "token:with:colons",
            "",
            &"a".repeat(MAX_TOKEN + 1),
        ] {
            assert!(
                !token_is_well_formed(candidate),
                "{candidate:?} must not pass the token check"
            );
        }
        // A real one — 24 URL-safe characters — still passes.
        assert!(token_is_well_formed("abcdefghij0123456789klmn"));
    }

    // ── against the real daemon ──
    //
    // These are the only tests here that need `zerotier-one`. When it is absent they SAY they
    // were skipped rather than passing quietly; run with `--nocapture` to see it. What they must
    // never do is turn absence into a pass by asserting nothing.

    #[test]
    fn the_real_daemon_reports_its_node_id() {
        match status() {
            Ok(node) => {
                assert_eq!(
                    node.node_id.len(),
                    10,
                    "a ZeroTier node id is ten hex digits: {:?}",
                    node.node_id
                );
                assert!(node.node_id.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(!node.version.is_empty());
            }
            Err(e) if e.is_unavailable() => {
                eprintln!("SKIPPED the_real_daemon_reports_its_node_id: {e}");
            }
            Err(e) => panic!("zerotier-one is present but the status call failed: {e}"),
        }
    }

    #[test]
    fn the_real_daemon_lists_its_networks() {
        match networks() {
            Ok(joined) => {
                // An empty list is the right answer on a node that has joined nothing, so the
                // assertion is about shape rather than count.
                for network in joined {
                    assert_eq!(network.network_id.len(), NetworkId::LEN);
                    assert_ne!(
                        network.status,
                        ZeroTierNetworkStatus::Unknown,
                        "the running daemon reports a status this build does not map"
                    );
                }
            }
            Err(e) if e.is_unavailable() => {
                eprintln!("SKIPPED the_real_daemon_lists_its_networks: {e}");
            }
            Err(e) => panic!("zerotier-one is present but the network call failed: {e}"),
        }
    }
}
