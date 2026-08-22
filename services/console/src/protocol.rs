//! The wire between the API and the console service.
//!
//! One connection per session, bidirectional, newline-delimited JSON. The connection IS the
//! session: when it closes the pty closes, so there is no separate liveness mechanism to get
//! out of step with reality.
//!
//! Everything the API sends arrives here as a `String`. Nothing in this module lets one leave
//! as a `String`: geometry becomes a [`TermSize`] that cannot hold a zero, identifiers become a
//! [`Uuid`] that cannot hold a path separator, and input becomes `Vec<u8>` through a strict
//! base64 decoder. The parse step is the validation step, so no later caller can forget it.

use serde::{Deserialize, Serialize};

/// Largest single wire line this service will read, in bytes.
///
/// A line is one message, and the biggest legitimate one is an `in` carrying a paste. The
/// contract caps `ConsoleInput.data` at 8192 base64 characters; 256 kB leaves the API room to
/// change its mind without leaving this service reading an unbounded line from a socket, which
/// is a memory-exhaustion primitive whoever is on the other end.
pub const MAX_LINE_BYTES: usize = 256 * 1024;

/// Terminal geometry bounds.
///
/// These are the contract's numbers (`ConsoleResize` in `packages/contracts/openapi/depsis.yaml`:
/// cols 20–500, rows 5–200), repeated here on purpose. The API validates them because a request
/// body is untrusted; this service validates them because the API is a separate process that can
/// be wrong, and because `tcsetwinsize` with a zero happily produces a terminal that no curses
/// program can draw in.
pub const MIN_COLS: u16 = 20;
pub const MAX_COLS: u16 = 500;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;

/// Largest input payload accepted in a single `in` message, after decoding.
///
/// The contract's 8192 base64 characters decode to 6144 bytes. This is deliberately looser than
/// that and still a bound.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("malformed message: {0}")]
    Malformed(String),
    #[error("{field} is not a uuid")]
    NotAUuid { field: &'static str },
    #[error("{cols}x{rows} is outside {MIN_COLS}-{MAX_COLS} by {MIN_ROWS}-{MAX_ROWS}")]
    Geometry { cols: u16, rows: u16 },
    #[error("input is not valid base64")]
    NotBase64,
    #[error("input is {0} bytes, over the {MAX_INPUT_BYTES} byte limit")]
    InputTooLarge(usize),
    #[error("line is {0} bytes, over the {MAX_LINE_BYTES} byte limit")]
    LineTooLong(usize),
}

// ─── typed field values ───────────────────────────────────────────────────────

/// A terminal size that is a terminal size.
///
/// A struct rather than two `u16` arguments, because `resize(rows, cols)` and `resize(cols, rows)`
/// are both plausible-looking calls and only one of them is right. The constructor is the only
/// way in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    cols: u16,
    rows: u16,
}

impl TermSize {
    pub fn new(cols: u16, rows: u16) -> Result<Self, ProtocolError> {
        if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
            return Err(ProtocolError::Geometry { cols, rows });
        }
        Ok(Self { cols, rows })
    }

    #[must_use]
    pub fn cols(self) -> u16 {
        self.cols
    }

    #[must_use]
    pub fn rows(self) -> u16 {
        self.rows
    }
}

/// A UUID as a value, not as a string that happens to look like one.
///
/// These identifiers are only ever logged and echoed, never joined to a path — but "never" is a
/// property of today's code, and the cheapest way to keep it true tomorrow is to make the type
/// incapable of carrying a `/` or a `..` in the first place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uuid(String);

impl Uuid {
    pub fn parse(raw: &str, field: &'static str) -> Result<Self, ProtocolError> {
        let bytes = raw.as_bytes();
        if bytes.len() != 36 {
            return Err(ProtocolError::NotAUuid { field });
        }
        for (index, byte) in bytes.iter().enumerate() {
            let ok = match index {
                8 | 13 | 18 | 23 => *byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            };
            if !ok {
                return Err(ProtocolError::NotAUuid { field });
            }
        }
        Ok(Self(raw.to_ascii_lowercase()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// ─── API → console ────────────────────────────────────────────────────────────

/// What the API asked for when it opened the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Open {
    pub size: TermSize,
    pub session: Uuid,
    pub user: Uuid,
    /// What the API *asked* for. Not what it gets — the service reports the truth in `ready`,
    /// and refuses outright if a privileged shell was requested and this unit is not configured
    /// to provide one. Silently handing back an unprivileged shell to a caller that asked for
    /// root is the kind of mismatch an operator only discovers when a command mysteriously fails.
    pub privileged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    Open(Open),
    Input(Vec<u8>),
    Resize(TermSize),
    Close,
}

/// The wire shape, before validation. Private on purpose: nothing outside this module should be
/// able to hold a `cols: u16` that was never range-checked.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", deny_unknown_fields)]
enum RawClientMessage {
    Open {
        cols: u16,
        rows: u16,
        session: String,
        user: String,
        #[serde(default)]
        privileged: bool,
    },
    In {
        d: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Close,
}

impl ClientMessage {
    /// Parse one wire line.
    ///
    /// The line arrives without its terminator; trailing `\r` is tolerated because a JSON line
    /// protocol that breaks on CRLF breaks for exactly one caller and does so at 3am.
    pub fn parse(line: &str) -> Result<Self, ProtocolError> {
        if line.len() > MAX_LINE_BYTES {
            return Err(ProtocolError::LineTooLong(line.len()));
        }
        let raw: RawClientMessage = serde_json::from_str(line.trim_end_matches(['\r', '\n']))
            .map_err(|e| ProtocolError::Malformed(e.to_string()))?;

        Ok(match raw {
            RawClientMessage::Open {
                cols,
                rows,
                session,
                user,
                privileged,
            } => Self::Open(Open {
                size: TermSize::new(cols, rows)?,
                session: Uuid::parse(&session, "session")?,
                user: Uuid::parse(&user, "user")?,
                privileged,
            }),
            RawClientMessage::In { d } => {
                let bytes = base64_decode(&d)?;
                if bytes.len() > MAX_INPUT_BYTES {
                    return Err(ProtocolError::InputTooLarge(bytes.len()));
                }
                Self::Input(bytes)
            }
            RawClientMessage::Resize { cols, rows } => Self::Resize(TermSize::new(cols, rows)?),
            RawClientMessage::Close => Self::Close,
        })
    }
}

// ─── console → API ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMessage {
    Ready {
        pid: i32,
        privileged: bool,
    },
    Out {
        d: String,
    },
    /// One full line the operator typed, for `console_commands`. Output is never sent here —
    /// copying the output of a `cat /etc/shadow` into an audit log moves the secret, it does not
    /// record it (ADR-0018).
    Line {
        s: String,
    },
    Exit {
        code: i32,
    },
    Error {
        message: String,
    },
}

impl ServerMessage {
    #[must_use]
    pub fn out(bytes: &[u8]) -> Self {
        Self::Out {
            d: base64_encode(bytes),
        }
    }

    /// Serialize with its newline.
    ///
    /// Infallible by construction: every variant is a struct of `String`/`i32`/`bool`, none of
    /// which can fail to serialize. The fallback exists so a `serde_json` change can never turn
    /// a message into a panic in a process holding somebody's shell open.
    #[must_use]
    pub fn to_wire(&self) -> String {
        match serde_json::to_string(self) {
            Ok(mut s) => {
                s.push('\n');
                s
            }
            Err(_) => "{\"t\":\"error\",\"message\":\"unserializable message\"}\n".to_string(),
        }
    }
}

// ─── base64 ───────────────────────────────────────────────────────────────────
//
// Hand-rolled, and the reason is the workspace rule that this service adds no new crate. Sixty
// lines of table lookup with tests against known vectors is a smaller thing to own than a
// dependency in a process that spawns shells.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn symbol(index: u32) -> char {
    // `index` is always masked to 0..=63 by the callers below, so the fallback is unreachable.
    // It is written out rather than unwrapped because this crate denies `unwrap_used`: an
    // unreachable branch that panics is still a panic in a process holding a shell open.
    char::from(*ALPHABET.get(index as usize).unwrap_or(&b'A'))
}

#[must_use]
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk.first().copied().unwrap_or(0));
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let packed = (b0 << 16) | (b1 << 8) | b2;

        out.push(symbol((packed >> 18) & 63));
        out.push(symbol((packed >> 12) & 63));
        out.push(if chunk.len() > 1 {
            symbol((packed >> 6) & 63)
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            symbol(packed & 63)
        } else {
            '='
        });
    }
    out
}

fn value_of(byte: u8) -> Option<u32> {
    let v = match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Strict base64: standard alphabet, mandatory padding, no whitespace, no line breaks.
///
/// Strict because a lenient decoder in front of a terminal turns a malformed message into
/// *some* bytes going to a shell rather than into an error. The right answer to "I could not
/// read this" is not "here is my best guess at what you typed".
pub fn base64_decode(input: &str) -> Result<Vec<u8>, ProtocolError> {
    let bytes = input.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err(ProtocolError::NotBase64);
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);

    let chunks: Vec<&[u8]> = bytes.chunks(4).collect();
    let last = chunks.len().saturating_sub(1);
    for (position, chunk) in chunks.iter().enumerate() {
        let mut packed: u32 = 0;
        let mut pad = 0usize;
        for (offset, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                // Padding is only ever the tail of the final quantum, and only one or two bytes
                // of it. Anywhere else it is a truncated or spliced message.
                if position != last || offset < 2 {
                    return Err(ProtocolError::NotBase64);
                }
                pad += 1;
                packed <<= 6;
                continue;
            }
            if pad > 0 {
                return Err(ProtocolError::NotBase64);
            }
            let Some(v) = value_of(*byte) else {
                return Err(ProtocolError::NotBase64);
            };
            packed = (packed << 6) | v;
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "each byte is masked to 8 bits before the cast"
        )]
        {
            out.push(((packed >> 16) & 0xff) as u8);
            if pad < 2 {
                out.push(((packed >> 8) & 0xff) as u8);
            }
            if pad < 1 {
                out.push((packed & 0xff) as u8);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic drops a live shell. In a test the \
              opposite is true: a failed assertion SHOULD panic."
)]
mod tests {
    use super::*;

    const SESSION: &str = "018f3b2a-7c4d-7e8f-9a0b-1c2d3e4f5a6b";
    const USER: &str = "018f3b2a-7c4d-7e8f-9a0b-000000000001";

    #[test]
    fn open_is_parsed_into_typed_fields() {
        let line = format!(
            r#"{{"t":"open","cols":80,"rows":24,"session":"{SESSION}","user":"{USER}","privileged":false}}"#
        );
        let ClientMessage::Open(open) = ClientMessage::parse(&line).unwrap() else {
            panic!("expected open");
        };
        assert_eq!(open.size.cols(), 80);
        assert_eq!(open.size.rows(), 24);
        assert_eq!(open.session.as_str(), SESSION);
        assert!(!open.privileged);
    }

    #[test]
    fn a_session_id_that_is_a_path_is_refused() {
        let line = format!(
            r#"{{"t":"open","cols":80,"rows":24,"session":"../../etc/passwd","user":"{USER}"}}"#
        );
        assert_eq!(
            ClientMessage::parse(&line),
            Err(ProtocolError::NotAUuid { field: "session" })
        );
    }

    #[test]
    fn a_zero_column_terminal_is_refused() {
        let line =
            format!(r#"{{"t":"open","cols":0,"rows":24,"session":"{SESSION}","user":"{USER}"}}"#);
        assert_eq!(
            ClientMessage::parse(&line),
            Err(ProtocolError::Geometry { cols: 0, rows: 24 })
        );
    }

    #[test]
    fn geometry_outside_the_contract_range_is_refused_on_resize_too() {
        assert!(matches!(
            ClientMessage::parse(r#"{"t":"resize","cols":9000,"rows":40}"#),
            Err(ProtocolError::Geometry { .. })
        ));
        assert_eq!(
            ClientMessage::parse(r#"{"t":"resize","cols":120,"rows":40}"#).unwrap(),
            ClientMessage::Resize(TermSize::new(120, 40).unwrap())
        );
    }

    #[test]
    fn input_is_decoded_from_base64() {
        assert_eq!(
            ClientMessage::parse(r#"{"t":"in","d":"ZWNobyBtZXJoYWJhCg=="}"#).unwrap(),
            ClientMessage::Input(b"echo merhaba\n".to_vec())
        );
    }

    #[test]
    fn input_that_is_not_base64_is_refused_rather_than_guessed_at() {
        assert_eq!(
            ClientMessage::parse(r#"{"t":"in","d":"rm -rf /"}"#),
            Err(ProtocolError::NotBase64)
        );
    }

    #[test]
    fn an_unknown_field_is_refused() {
        // The protocol is fixed and shared with the API. A field nobody reads is either a typo
        // or a caller talking a version this service does not implement; both should be loud.
        assert!(matches!(
            ClientMessage::parse(r#"{"t":"resize","cols":80,"rows":24,"shell":"/bin/zsh"}"#),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn an_unknown_message_type_is_refused() {
        assert!(matches!(
            ClientMessage::parse(r#"{"t":"exec","d":"aGk="}"#),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn close_needs_nothing_else() {
        assert_eq!(
            ClientMessage::parse(r#"{"t":"close"}"#).unwrap(),
            ClientMessage::Close
        );
    }

    #[test]
    fn a_line_over_the_cap_is_refused_without_parsing() {
        let line = "x".repeat(MAX_LINE_BYTES + 1);
        assert_eq!(
            ClientMessage::parse(&line),
            Err(ProtocolError::LineTooLong(MAX_LINE_BYTES + 1))
        );
    }

    #[test]
    fn oversized_input_is_refused() {
        let payload = base64_encode(&vec![b'a'; MAX_INPUT_BYTES + 1]);
        let line = format!(r#"{{"t":"in","d":"{payload}"}}"#);
        assert_eq!(
            ClientMessage::parse(&line),
            Err(ProtocolError::InputTooLarge(MAX_INPUT_BYTES + 1))
        );
    }

    #[test]
    fn server_messages_serialize_to_the_agreed_shape() {
        assert_eq!(
            ServerMessage::Ready {
                pid: 1234,
                privileged: false
            }
            .to_wire(),
            "{\"t\":\"ready\",\"pid\":1234,\"privileged\":false}\n"
        );
        assert_eq!(
            ServerMessage::out(b"hi").to_wire(),
            "{\"t\":\"out\",\"d\":\"aGk=\"}\n"
        );
        assert_eq!(
            ServerMessage::Line { s: "ls -la".into() }.to_wire(),
            "{\"t\":\"line\",\"s\":\"ls -la\"}\n"
        );
        assert_eq!(
            ServerMessage::Exit { code: 0 }.to_wire(),
            "{\"t\":\"exit\",\"code\":0}\n"
        );
        assert_eq!(
            ServerMessage::Error {
                message: "idle".into()
            }
            .to_wire(),
            "{\"t\":\"error\",\"message\":\"idle\"}\n"
        );
    }

    #[test]
    fn an_out_message_never_contains_a_newline_of_its_own() {
        // The framing is one message per line. Terminal output is full of newlines, which is
        // exactly why it is base64 and not a raw string.
        let wire = ServerMessage::out(b"line one\nline two\n").to_wire();
        assert_eq!(wire.matches('\n').count(), 1);
    }

    #[test]
    fn base64_round_trips_every_byte_value() {
        let all: Vec<u8> = (0..=255u8).collect();
        for len in 0..=all.len() {
            let slice = &all[..len];
            let encoded = base64_encode(slice);
            assert_eq!(base64_decode(&encoded).unwrap(), slice, "length {len}");
        }
    }

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(plain.as_bytes()), encoded);
            assert_eq!(base64_decode(encoded).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn base64_rejects_the_shapes_a_lenient_decoder_would_accept() {
        for bad in [
            "Zg=",        // length not a multiple of four
            "Zg ==",      // whitespace
            "Zm9v\nYmFy", // line break
            "Zm=9",       // padding in the middle
            "Z===",       // three pad bytes
            "Zm==Zm9v",   // padding in a non-final quantum
            "Zm9-",       // url-safe alphabet is not the standard one
        ] {
            assert_eq!(base64_decode(bad), Err(ProtocolError::NotBase64), "{bad}");
        }
    }
}
