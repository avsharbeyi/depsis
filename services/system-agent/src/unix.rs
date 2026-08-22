//! Real Unix seam implementations.
//!
//! The `#[cfg(unix)]` lives on the MODULE DECLARATION in `main.rs`, not inside this file
//! (ADR-0006). Scattering `cfg` through function bodies is how a core stops being portable
//! without anyone noticing; keeping it at one declaration means the boundary is visible.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use depsis_agent::audit::Sink;
use depsis_agent::data::DataChannel;
use depsis_agent::dispatch::Agent;
use depsis_agent::op::Response;
use depsis_agent::seams::{
    CommandRunner, OpenIntent, PeerIdentity, SafePath, SeamError, TokenSource,
};

/// Path resolution confined by the kernel, not by string inspection.
///
/// `root_fd` is opened once at startup and held for the process lifetime. The root is never
/// re-resolved from a string: doing so would reintroduce exactly the race the fd exists to
/// close.
// Not constructed outside tests yet, and that is the honest state rather than an oversight: no
// operation in `Request` takes a caller-supplied path inside a share. Phase 1 introduces the
// first ones (upload publish, move), and this is deliberately in place and kernel-tested before
// then rather than written under time pressure alongside the feature that needs it. See lib.rs.
#[allow(
    dead_code,
    reason = "wired into dispatch in Phase 1; kernel-tested now so the confinement is not               designed in a hurry next to the first operation that depends on it"
)]
pub struct Openat2SafePath {
    root: rustix::fd::OwnedFd,
    root_display: PathBuf,
}

#[allow(
    dead_code,
    reason = "same as the struct above: constructed only by tests until Phase 1 wires path-taking operations into dispatch"
)]
impl Openat2SafePath {
    pub fn open_root(path: impl Into<PathBuf>) -> Result<Self, SeamError> {
        let root_display = path.into();
        let root = rustix::fs::open(
            &root_display,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(|e| SeamError::Io(format!("open root {}: {e}", root_display.display())))?;
        let confined = Self { root, root_display };
        confined.prove_openat2_works()?;
        Ok(confined)
    }

    /// Resolve `.` under the root, once, at startup.
    ///
    /// Not a formality. `openat2` is the entire containment mechanism — everything else in this
    /// file assumes the kernel is enforcing RESOLVE_BENEATH — and it can be absent for two reasons
    /// that have nothing to do with the code: a kernel older than 5.6, or a seccomp filter.
    ///
    /// The second one is not hypothetical and was not predictable from the documentation. P1-D
    /// measured `RestrictSUIDSGID=yes` in the agent's own unit blocking `openat2` outright: systemd
    /// implements that directive by filtering the mode argument of every file-creating syscall, and
    /// for `openat2` the mode lives inside a `struct open_how` in userspace memory, which seccomp
    /// cannot dereference — so it denies the call rather than let a setuid file through. The unit
    /// now sets `RestrictSUIDSGID=no` and says why, but a unit file is edited by people, and the
    /// failure mode without this probe is every upload failing individually with a containment
    /// error while the agent reports itself healthy.
    ///
    /// Failing at startup instead means the journal says it once, plainly, and the service does not
    /// come up pretending it can confine anything.
    fn prove_openat2_works(&self) -> Result<(), SeamError> {
        rustix::fs::openat2(
            &self.root,
            OsStr::new(".").as_bytes(),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::DIRECTORY
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
            Self::resolve_flags(),
        )
        .map(drop)
        .map_err(|e| classify_openat2(".", e))
    }
}

#[allow(
    dead_code,
    reason = "same as the struct: the helpers are exercised by the kernel tests below and are \
              wired into dispatch with the first path-taking operation"
)]
impl Openat2SafePath {
    /// The flag set, in one place so the two entry points cannot drift apart.
    ///
    /// BENEATH, not IN_ROOT. IN_ROOT would silently clamp an escape attempt to the root, which
    /// means a traversal succeeds quietly and nobody ever learns it was attempted. BENEATH
    /// refuses, and a refusal is an audit event.
    ///
    /// NO_XDEV matters specifically on a ZFS box: every dataset is its own mount, so without it a
    /// nested dataset mountpoint is a way out of the share the caller was confined to.
    fn resolve_flags() -> rustix::fs::ResolveFlags {
        rustix::fs::ResolveFlags::BENEATH
            | rustix::fs::ResolveFlags::NO_SYMLINKS
            | rustix::fs::ResolveFlags::NO_MAGICLINKS
            | rustix::fs::ResolveFlags::NO_XDEV
    }

    fn openat2(
        &self,
        relative: &[&str],
        oflags: rustix::fs::OFlags,
        mode: rustix::fs::Mode,
    ) -> Result<std::fs::File, SeamError> {
        let joined = relative.join("/");
        let fd = rustix::fs::openat2(
            &self.root,
            OsStr::new(&joined).as_bytes(),
            oflags | rustix::fs::OFlags::CLOEXEC,
            mode,
            Self::resolve_flags(),
        )
        .map_err(|e| classify_openat2(&joined, e))?;

        // The descriptor IS the result. It is not dropped and no path is handed back: whoever
        // holds this file holds the object the kernel just confined, and no second resolution
        // happens anywhere.
        Ok(std::fs::File::from(fd))
    }
}

/// Turn an `openat2` errno into the right kind of `SeamError`.
///
/// ENOSYS gets its own branch because reporting it as a path escape is a false diagnosis at the
/// worst possible moment. P1-D measured exactly that: every transfer failed with "path escapes the
/// share root: alice/.depsis/staging/probe.part", which reads as a containment violation — a
/// caller trying to break out — when the truth was that the syscall had been switched off by a
/// line in a unit file. It took a directive-by-directive bisection to find, and the misleading
/// message is what made the bisection necessary.
fn classify_openat2(joined: &str, e: rustix::io::Errno) -> SeamError {
    if e == rustix::io::Errno::NOSYS {
        return SeamError::Io(format!(
            "openat2 is unavailable ({joined}): the kernel is older than 5.6, or a seccomp filter \
             is blocking it — RestrictSUIDSGID=yes does exactly that"
        ));
    }
    SeamError::PathEscape(format!("{joined}: {e}"))
}

impl SafePath for Openat2SafePath {
    fn open(&self, relative: &[&str], intent: OpenIntent) -> Result<std::fs::File, SeamError> {
        let (oflags, mode) = match intent {
            OpenIntent::Read => (rustix::fs::OFlags::RDONLY, rustix::fs::Mode::empty()),
            // EXCL is the atomic part: two callers racing to claim the same staging name cannot
            // both win, and the loser finds out rather than silently sharing a file.
            OpenIntent::CreateNew => (
                rustix::fs::OFlags::WRONLY | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL,
                // 0600 while it is being written: a staging file readable by everyone on the box
                // is a cross-tenant read of data that has not even landed yet.
                //
                // KNOWN GAP, stated here because an earlier version of this comment claimed the
                // opposite. It said ownership "is fixed up at publish" — nothing does that. There
                // is no chown or fchown anywhere in this crate, so a published file stays root:root
                // 0600 and its owner cannot read it over SMB or through the API. That presents as
                // "uploads are broken", and the fastest-looking repair is to widen the mode, which
                // is precisely the cross-tenant read the threat model exists to prevent. The fix is
                // ownership operands on OpenTransfer and an fchown of the held descriptor before
                // publish — on the fd, not a path, so it stays the object openat2 confined. Until
                // that lands, publishing is incomplete and this comment says so rather than
                // asserting a step that is missing.
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            ),
            // APPEND, and the flag is load-bearing. Without it the write position comes only from
            // the one `seek(End(0))` the caller does at open time — a number captured then and
            // trusted up to TRANSFER_TTL later, which is exactly the "a number kept beside the data
            // can disagree with it" failure the caller's own comment claims to avoid. With O_APPEND
            // the kernel resolves the position at every write, so a writer that slips past the
            // registry's interlock degrades to interleaving rather than to silent mutual overwrite.
            //
            // The variant was named `Append` and did not append. A name that promises semantics the
            // implementation does not have is worse than a wrong name.
            OpenIntent::Append => (
                rustix::fs::OFlags::WRONLY
                    | rustix::fs::OFlags::CREATE
                    | rustix::fs::OFlags::APPEND,
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            ),
        };
        self.openat2(relative, oflags, mode)
    }

    fn open_dir(&self, relative: &[&str]) -> Result<std::fs::File, SeamError> {
        self.openat2(
            relative,
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY,
            rustix::fs::Mode::empty(),
        )
    }

    fn publish(
        &self,
        from_dir: &[&str],
        from: &str,
        to_dir: &[&str],
        to: &str,
    ) -> Result<(), SeamError> {
        let source = self.open_dir(from_dir)?;
        let destination = self.open_dir(to_dir)?;

        // renameat2 with NOREPLACE, aimed at two directory descriptors this call just resolved.
        // Neither side is a path, so nothing re-resolves between the check and the move.
        //
        // P0-G measured this working on ZFS 2.3.2 and returning EEXIST when the destination is
        // taken — the point of the measurement being that a silently-ignored flag would turn
        // "refuse to overwrite" into "overwrite", which is the worst possible way for a flag to
        // fail.
        match rustix::fs::renameat_with(
            &source,
            from,
            &destination,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {}
            Err(rustix::io::Errno::EXIST) => {
                return Err(SeamError::Io(format!("{to}: already exists")));
            }
            Err(e) => return Err(SeamError::Io(format!("rename {from} -> {to}: {e}"))),
        }

        // ADR-0008 step 5, in the same call as the rename so it cannot be forgotten separately.
        destination
            .sync_all()
            .map_err(|e| SeamError::Io(format!("fsync destination directory: {e}")))
    }
}

/// Tokens from the kernel's CSPRNG.
///
/// `getrandom(2)`, not `/dev/urandom`: no descriptor to run out of, no path that can be replaced
/// on a compromised box, and it cannot fail for want of an open file. The agent runs as root and
/// mints values that authorize writes, so this is not a place for a userspace generator seeded
/// once at startup.
pub struct KernelTokens;

impl TokenSource for KernelTokens {
    fn token(&self) -> String {
        let mut bytes = [0u8; depsis_agent::transfer::TOKEN_BYTES];
        // On failure this loops rather than returning a weak value. getrandom only fails for
        // EINTR or an unavailable pool, and a token is exactly the wrong thing to degrade: a
        // predictable one lets a caller write into somebody else's upload.
        while rustix::rand::getrandom(&mut bytes, rustix::rand::GetRandomFlags::empty()).is_err() {
            std::thread::yield_now();
        }
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            use std::fmt::Write as _;
            let _ = write!(out, "{b:02x}");
        }
        out
    }
}

/// Is this an "out of file descriptors" error rather than a real fault?
///
/// EMFILE (this process's limit) and ENFILE (the system's). Neither has a `std::io::ErrorKind`, so
/// they can only be told apart by errno — and without telling them apart an accept loop treats a
/// momentary shortage the same as a broken socket and exits.
fn is_descriptor_shortage(e: &std::io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(n) if n == rustix::io::Errno::MFILE.raw_os_error()
                || n == rustix::io::Errno::NFILE.raw_os_error()
    )
}

/// Peer credentials straight from the kernel.
pub fn peer_of(stream: &std::os::unix::net::UnixStream) -> Result<PeerIdentity, SeamError> {
    let creds = rustix::net::sockopt::socket_peercred(stream)
        .map_err(|e| SeamError::NoPeerCred(e.to_string()))?;
    Ok(PeerIdentity {
        uid: creds.uid.as_raw(),
        gid: creds.gid.as_raw(),
        pid: creds.pid.as_raw_nonzero().get(),
    })
}

/// argv-only execution. No shell exists anywhere in this path.
pub struct ExecRunner;

impl CommandRunner for ExecRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
        debug_assert!(program.starts_with('/'), "program path must be absolute");

        let mut cmd = Command::new(program);
        cmd.args(args);

        // Inherit nothing. A privileged process that inherits its caller's environment inherits
        // whatever the caller decided LD_PRELOAD, PATH or IFS should be.
        cmd.env_clear();
        cmd.env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin");
        // Output of zfs/zpool/smartctl is parsed; a locale-dependent format would make the
        // parser wrong in a way that only shows up on someone else's machine.
        cmd.env("LC_ALL", "C");
        cmd.env("TZ", "UTC");

        let out = cmd
            .output()
            .map_err(|e| SeamError::Io(format!("spawn {program}: {e}")))?;

        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(SeamError::Command {
                program: program.to_string(),
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            })
        }
    }
}

// ─── socket activation ────────────────────────────────────────────────────────

/// Number of the first file descriptor systemd hands over (`SD_LISTEN_FDS_START`).
const SD_LISTEN_FDS_START: RawFd = 3;

/// Largest request line the agent will read, in bytes.
///
/// A privileged process reading an unbounded line from a socket is a memory-exhaustion
/// primitive. The largest legitimate request is `PublishSambaConfig` carrying every share in the
/// deployment, and 256 kB is far above any plausible one.
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

/// How long one connection may take. A client that opens the socket and then goes quiet must not
/// be able to wedge the agent, which serves one caller at a time.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// Take the listening socket systemd created for us.
///
/// The agent does NOT create its own socket. systemd owns it, which means the socket file's
/// ownership and mode are the first authorization gate — enforced by the kernel before the agent
/// has read a single byte, and declared in a unit file reviewable independently of this code
/// (ADR-0006).
///
/// This implements the `sd_listen_fds` protocol directly rather than pulling in a crate. The
/// protocol is three environment variables; a dependency would add an unaudited transitive tree
/// to a process running as root, which is a worse trade than the lines below.
#[allow(
    unsafe_code,
    reason = "The one unavoidable unsafe in the binary: adopting a descriptor from systemd means \
              asserting ownership of an integer, which no safe API can express. The assertion is \
              discharged by the LISTEN_PID check — the descriptor was passed to *this* pid — and \
              by this function being called once, from main. The core crate `depsis_agent` \
              remains forbid(unsafe_code)."
)]
/// The two listening sockets systemd hands over, taken BY NAME.
///
/// A struct rather than a `Vec`, because a positional list is exactly the bug this exists to
/// prevent. Two `.socket` units pointing at one service produce two descriptors, and their order
/// is systemd's business, not ours — it depends on unit load order and can change when a unit is
/// renamed, reordered or restarted. Reading fd 3 as "the control socket" is therefore a coin
/// flip, and losing it means the agent answers control requests on the socket the API streams
/// user data into, and reads file bytes as if they were JSON commands.
#[derive(Debug)]
pub struct Listeners {
    pub control: UnixListener,
    pub data: UnixListener,
}

/// The names the units declare via `FileDescriptorName=`.
pub const CONTROL_FD_NAME: &str = "control";
pub const DATA_FD_NAME: &str = "data";

/// Map `LISTEN_FDNAMES` onto descriptor offsets, or refuse.
///
/// Split out from the adoption below so it can be tested without conjuring real listening sockets
/// at fixed descriptor numbers. Everything that can go wrong lives here; the adoption itself is
/// three lines with no decisions in it.
///
/// Fails closed at every step. An agent that starts with a socket it cannot name is an agent whose
/// attack surface nobody can review, and one that starts with only the control socket accepts
/// `OpenTransfer` calls whose data connections can never arrive — the API would mint tokens,
/// stage files and time them out, reporting a plausible-looking upload failure every time.
fn socket_offsets(fdnames: Option<&str>, listen_fds: i32) -> Result<(i32, i32), SeamError> {
    let Some(fdnames) = fdnames else {
        return Err(SeamError::Io(
            "LISTEN_FDNAMES unset: the socket units must declare FileDescriptorName=".into(),
        ));
    };

    let names: Vec<&str> = fdnames.split(':').collect();
    if i32::try_from(names.len()).unwrap_or(i32::MAX) != listen_fds {
        // Without a name per descriptor there is no mapping at all, only a guess.
        return Err(SeamError::Io(format!(
            "LISTEN_FDS is {listen_fds} but LISTEN_FDNAMES names {} sockets",
            names.len()
        )));
    }

    let mut control: Option<i32> = None;
    let mut data: Option<i32> = None;
    for (index, name) in names.iter().enumerate() {
        let offset = i32::try_from(index).unwrap_or(i32::MAX);
        let slot = match *name {
            CONTROL_FD_NAME => &mut control,
            DATA_FD_NAME => &mut data,
            other => {
                return Err(SeamError::Io(format!(
                    "systemd passed a socket named {other:?}, which this agent does not serve"
                )))
            }
        };
        if slot.is_some() {
            // Two units with the same FileDescriptorName=. Picking either one would leave a
            // listening root socket that nothing ever accepts on.
            return Err(SeamError::Io(format!(
                "two sockets are both named {name:?}"
            )));
        }
        *slot = Some(offset);
    }

    match (control, data) {
        (Some(c), Some(d)) => Ok((c, d)),
        (None, _) => Err(SeamError::Io(format!(
            "no socket named {CONTROL_FD_NAME:?}; is depsis-agent.socket running?"
        ))),
        (_, None) => Err(SeamError::Io(format!(
            "no socket named {DATA_FD_NAME:?}; is depsis-agent-data.socket running?"
        ))),
    }
}

/// Adopt the listening sockets systemd created.
///
/// The agent does NOT create its own sockets. systemd owning them is what makes each socket file's
/// ownership and mode the first authorization gate — enforced by the kernel before the agent has
/// read a single byte, and declared in a unit file reviewable independently of this code
/// (ADR-0006).
///
/// This implements the `sd_listen_fds` protocol directly rather than pulling in a crate. The
/// protocol is three environment variables; a dependency would add an unaudited transitive tree to
/// a process running as root, which is a worse trade than the lines below.
#[allow(
    unsafe_code,
    reason = "The one unavoidable unsafe in the binary: adopting a descriptor from systemd means               asserting ownership of an integer, which no safe API can express. The assertion is               discharged by the LISTEN_PID check — the descriptors were passed to *this* pid — by               `socket_offsets` refusing duplicate names so neither is adopted twice, and by this               function being called once, from main. The core crate `depsis_agent` remains               forbid(unsafe_code)."
)]
pub fn listeners_from_systemd() -> Result<Listeners, SeamError> {
    // LISTEN_PID guards against a descriptor inherited by a process that was never meant to have
    // it: systemd stamps the pid it activated, so anything forked from us sees a mismatch.
    let listen_pid: u32 = std::env::var("LISTEN_PID")
        .map_err(|_| SeamError::Io("LISTEN_PID unset: not socket-activated".into()))?
        .parse()
        .map_err(|_| SeamError::Io("LISTEN_PID is not a number".into()))?;
    if listen_pid != std::process::id() {
        return Err(SeamError::Io(format!(
            "LISTEN_PID is {listen_pid}, this process is {}; refusing an fd meant for someone else",
            std::process::id()
        )));
    }

    let listen_fds: i32 = std::env::var("LISTEN_FDS")
        .map_err(|_| SeamError::Io("LISTEN_FDS unset".into()))?
        .parse()
        .map_err(|_| SeamError::Io("LISTEN_FDS is not a number".into()))?;

    let fdnames = std::env::var("LISTEN_FDNAMES").ok();
    let (control_offset, data_offset) = socket_offsets(fdnames.as_deref(), listen_fds)?;

    // Clear the variables so nothing spawned later can mistake itself for the activated service.
    // `ExecRunner` calls `env_clear` as well, so this is belt and braces — but leaving pid-stamped
    // variables lying in the environment is the kind of thing that becomes a bug two refactors on.
    std::env::remove_var("LISTEN_PID");
    std::env::remove_var("LISTEN_FDS");
    std::env::remove_var("LISTEN_FDNAMES");

    // SAFETY: systemd passed these descriptors to this pid (verified above), nothing else in the
    // process owns them, and this function runs exactly once. The two offsets are distinct because
    // `socket_offsets` refuses duplicate names, so neither descriptor is adopted twice.
    let (control, data) = unsafe {
        (
            OwnedFd::from_raw_fd(SD_LISTEN_FDS_START + control_offset),
            OwnedFd::from_raw_fd(SD_LISTEN_FDS_START + data_offset),
        )
    };

    Ok(Listeners {
        control: UnixListener::from(expect_stream_socket(control, CONTROL_FD_NAME)?),
        data: UnixListener::from(expect_stream_socket(data, DATA_FD_NAME)?),
    })
}

/// Confirm an adopted descriptor really is a stream socket.
///
/// A misconfigured unit (`ListenDatagram=`, say) then fails here with a clear message rather than
/// producing baffling behaviour at accept time.
fn expect_stream_socket(fd: OwnedFd, name: &str) -> Result<OwnedFd, SeamError> {
    let kind = rustix::net::sockopt::socket_type(&fd)
        .map_err(|e| SeamError::Io(format!("the {name} fd is not a socket: {e}")))?;
    if kind != rustix::net::SocketType::STREAM {
        return Err(SeamError::Io(format!(
            "the {name} fd is a socket but not SOCK_STREAM ({kind:?})"
        )));
    }
    Ok(fd)
}

/// Serve requests until the listener closes.
///
/// Connections are handled ONE AT A TIME, deliberately. Agent operations mutate global system
/// state — a pool, a dataset, `smb.conf` — so concurrency would demand a lock around nearly
/// everything anyway. Serialising at the accept loop makes that lock unnecessary and makes the
/// audit log a true serial history of privileged actions. The call rate is a handful per minute;
/// there is nothing to win by overlapping them.
pub fn serve_loop<R: CommandRunner, S: Sink, P: SafePath>(
    listener: &UnixListener,
    agent: &Agent<'_, R, S, P>,
) -> Result<(), SeamError> {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _addr)) => stream,
            // A client that vanished between the kernel queueing the connection and our accept is
            // routine, not something to die over.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            // EMFILE/ENFILE is a TRANSIENT shortage, not a reason to exit. There is no
            // `std::io::ErrorKind` for either, so without this arm they fall through to the fatal
            // one and the process dies — and StartLimitBurst=5/StartLimitIntervalSec=60, which
            // P1-D moved into [Unit] and therefore actually put in effect, turns five of those into
            // a permanently failed unit needing `systemctl reset-failed` at the console. An accept
            // loop that exits on a transient errno is a crash primitive, not a safety measure.
            Err(e) if is_descriptor_shortage(&e) => {
                eprintln!("depsis-agent: out of descriptors on accept ({e}); retrying");
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(SeamError::Io(format!("accept: {e}"))),
        };

        // One bad connection must never take the agent down.
        if let Err(e) = serve_one(&stream, agent) {
            eprintln!("depsis-agent: connection failed: {e}");
        }
    }
}

fn serve_one<R: CommandRunner, S: Sink, P: SafePath>(
    stream: &UnixStream,
    agent: &Agent<'_, R, S, P>,
) -> Result<(), SeamError> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|e| SeamError::Io(format!("set timeouts: {e}")))?;

    // Identity comes from the kernel, before a single byte of the request is read or trusted.
    // Nothing on the wire can influence it (ADR-0006, threat model TB4).
    let peer = peer_of(stream)?;

    let line = read_request_line(stream)?;

    if line.is_empty() {
        // Peer closed without sending anything — a liveness probe, typically.
        return Ok(());
    }

    // `read_line` returns a line with no trailing newline in two situations that could hardly be
    // more different: the peer sent a complete request and closed its write side, which is what
    // any ordinary request/response client does; or the request hit the size cap and was cut off
    // mid-line. An earlier version told them apart by the missing newline alone and therefore
    // answered every well-behaved client with "request exceeds 262144 bytes" — P0-E measured it
    // on its first run, and it was invisible in unit tests because the mock transport is
    // line-oriented and never closes a stream mid-request.
    //
    // The byte count is what actually distinguishes them. A line at or over the cap is refused;
    // anything shorter is a complete request whether or not it ends in a newline.
    if line.len() as u64 >= MAX_REQUEST_BYTES {
        return respond(
            stream,
            &Response::Refused {
                reason: format!("request exceeds {MAX_REQUEST_BYTES} bytes"),
            },
        );
    }

    let (correlation_id, reason, request_json) = match split_envelope(line.trim_end()) {
        Ok(v) => v,
        Err(why) => return respond(stream, &Response::Failed { reason: why }),
    };

    let response = agent.handle(&request_json, peer, &correlation_id, &reason);
    respond(stream, &response)
}

/// How many data connections may be in flight at once.
///
/// A FIXED pool, not a thread per connection. The control loop can be serial because its
/// operations are short and mutate global state; a data connection is neither — it holds a worker
/// for as long as a client takes to send a chunk, so serialising it would let one slow uploader
/// stall every other one. Spawning per connection is the other extreme and is worse: connection
/// rate would become thread count on a root daemon, which is a denial-of-service primitive handed
/// to anyone in the `depsis-api` group.
///
/// Sixteen because the memory ceiling is this times `data::COPY_BUFFER` (1 MiB in total) and the
/// descriptor ceiling is this plus `MAX_PENDING_TRANSFERS`, both small enough to state out loud.
pub const MAX_DATA_CONNECTIONS: usize = 16;

/// Serve data connections until the listener closes.
///
/// The queue is a RENDEZVOUS channel — capacity zero — so a connection is only accepted once a
/// worker is free to take it. Any buffer here would be a place for connections to pile up out of
/// sight of the kernel's own `Backlog=`, and the honest backpressure is to leave them queued where
/// the socket unit already bounds them.
pub fn serve_data_loop<S: Sink>(
    listener: &UnixListener,
    channel: &DataChannel<'_, S>,
) -> Result<(), SeamError> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<UnixStream>(0);
    let rx = std::sync::Mutex::new(rx);

    std::thread::scope(|scope| {
        for _ in 0..MAX_DATA_CONNECTIONS {
            let rx = &rx;
            scope.spawn(move || data_worker(rx, channel));
        }

        let result = accept_into(listener, &tx);
        // Dropping the last sender is what lets the workers finish; without it the scope would
        // join on threads still blocked in `recv`.
        drop(tx);
        result
    })
}

/// Hand every accepted connection to whichever worker is free.
fn accept_into(
    listener: &UnixListener,
    tx: &std::sync::mpsc::SyncSender<UnixStream>,
) -> Result<(), SeamError> {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _addr)) => stream,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            // Same reasoning as the control loop: EMFILE/ENFILE is transient and has no
            // `std::io::ErrorKind`, so without this arm it falls through to the fatal one and an
            // exhausted descriptor table becomes a crash.
            Err(e) if is_descriptor_shortage(&e) => {
                eprintln!("depsis-agent: out of descriptors on data accept ({e}); retrying");
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(SeamError::Io(format!("data accept: {e}"))),
        };

        if tx.send(stream).is_err() {
            // Every worker is gone. Continuing would accept connections nothing will ever read.
            return Err(SeamError::Io("all data workers have exited".into()));
        }
    }
}

fn data_worker<S: Sink>(
    rx: &std::sync::Mutex<std::sync::mpsc::Receiver<UnixStream>>,
    channel: &DataChannel<'_, S>,
) {
    loop {
        let stream = {
            // Poison is recovered rather than propagated: one worker panicking must not take the
            // whole data channel down with it, which is what `unwrap` here would do to all sixteen.
            let guard = rx.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match guard.recv() {
                Ok(stream) => stream,
                Err(_) => return,
            }
        };
        if let Err(e) = serve_data_one(&stream, channel) {
            eprintln!("depsis-agent: data connection failed: {e}");
        }
    }
}

fn serve_data_one<S: Sink>(
    stream: &UnixStream,
    channel: &DataChannel<'_, S>,
) -> Result<(), SeamError> {
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| SeamError::Io(format!("set data write timeout: {e}")))?;

    // Identity comes from the kernel, before a single byte of the preamble is read or trusted.
    let peer = peer_of(stream)?;

    // `&UnixStream` implements both `Read` and `Write`, which is what lets the closure below keep
    // its own shared borrow for `set_read_timeout` while the channel reads through this one. A
    // `&mut UnixStream` would have made the two mutually exclusive and forced a `try_clone`.
    let mut io = stream;
    channel.serve(&mut io, peer, |budget| {
        stream
            .set_read_timeout(Some(budget))
            .map_err(|e| SeamError::Io(format!("arm the data read timeout: {e}")))
    })
}

/// Read one newline-terminated request under an ABSOLUTE deadline.
///
/// `set_read_timeout` arms `SO_RCVTIMEO`, which bounds a single `recv(2)` — not a connection. A
/// peer that sends one byte every twenty-nine seconds re-arms the window on every byte, so
/// `read_line` returns only on a newline or at the size cap. With a 30-second timeout and a 256 kB
/// cap that is a single connection holding the agent for roughly 88 days, and because `serve_loop`
/// handles one connection at a time, nothing else is served for the duration. Any member of the
/// `depsis-api` group can do it, which under threat-model TB4 includes a compromised API.
///
/// The fix is a deadline the peer cannot push back: the socket timeout is re-armed before every
/// read to whatever remains of the budget, and the budget is checked between reads. A slow client
/// is then bounded by `IO_TIMEOUT` in total rather than per syscall.
///
/// Reading by hand rather than through `BufRead::read_line` is what makes that possible — the
/// buffered reader owns its own loop and offers no place to re-arm.
fn read_request_line(stream: &UnixStream) -> Result<String, SeamError> {
    read_request_line_within(stream, IO_TIMEOUT)
}

/// The budget is a parameter so a test can use one short enough to run. `IO_TIMEOUT` is thirty
/// seconds, and a test that waits thirty seconds to prove a timeout works is a test that gets
/// deleted.
fn read_request_line_within(stream: &UnixStream, budget: Duration) -> Result<String, SeamError> {
    let deadline = Instant::now() + budget;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let mut reader = stream;

    let expired = || SeamError::Io(format!("request not complete within {budget:?}"));

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(expired());
        }
        // A zero Duration means "no timeout" to setsockopt, which would be the opposite of what is
        // wanted; `remaining` is known non-zero here.
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| SeamError::Io(format!("re-arm read timeout: {e}")))?;

        // Stop at the cap rather than growing without bound. The cap is the memory-exhaustion
        // guard and has to hold even though the caller is authenticated.
        let room = (MAX_REQUEST_BYTES as usize).saturating_sub(buf.len());
        if room == 0 {
            break;
        }

        // `.get_mut(..n)` rather than `&mut chunk[..n]`: the crate denies indexing_slicing because
        // a panic in a root daemon is a denial of service on the one component that cannot be
        // restarted casually. `want` is bounded by `chunk.len()` so this cannot actually be None,
        // and the error path says so rather than unwrapping.
        let want = room.min(chunk.len());
        let target = chunk
            .get_mut(..want)
            .ok_or_else(|| SeamError::Io("read buffer window out of range".into()))?;

        let read = match reader.read(target) {
            Ok(0) => break, // peer closed its write side; whatever we have is the request
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // A timeout here IS the deadline expiring, because the window was armed from it.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(expired())
            }
            Err(e) => return Err(SeamError::Io(format!("read request: {e}"))),
        };

        let data = chunk
            .get(..read)
            .ok_or_else(|| SeamError::Io("short read window out of range".into()))?;
        let saw_newline = data.contains(&b'\n');
        buf.extend_from_slice(data);
        if saw_newline {
            break;
        }
    }

    // Lossy rather than strict: invalid UTF-8 should be refused by the JSON parser as a malformed
    // request, with the audit entry that goes with it, not dropped as an IO error before the
    // dispatcher ever sees it.
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn respond(stream: &UnixStream, response: &Response) -> Result<(), SeamError> {
    let mut body = serde_json::to_string(response)
        .map_err(|e| SeamError::Io(format!("serialize response: {e}")))?;
    body.push('\n');
    let mut w = stream;
    w.write_all(body.as_bytes())
        .and_then(|()| w.flush())
        .map_err(|e| SeamError::Io(format!("write response: {e}")))
}

/// Split the wire envelope into `(correlation_id, reason, request_json)`.
///
/// The envelope exists because `correlation_id` and `reason` are audit metadata, not parameters
/// of an operation. Putting them inside `Request` would mean every variant carried two fields no
/// operation uses, and would let a future variant quietly omit them.
///
/// Both are bounded and sanitised here rather than trusted, because they are written to the audit
/// log: an unbounded `reason` containing newlines is a log-injection primitive that lets a caller
/// forge audit entries.
fn split_envelope(line: &str) -> Result<(String, String, String), String> {
    const MAX_CORRELATION: usize = 64;
    const MAX_REASON: usize = 200;

    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("malformed envelope: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "envelope must be a JSON object".to_string())?;

    let field = |key: &str, max: usize| -> Result<String, String> {
        let raw = obj
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("envelope field '{key}' missing or not a string"))?;
        if raw.chars().count() > max {
            return Err(format!("envelope field '{key}' exceeds {max} characters"));
        }
        if raw.chars().any(char::is_control) {
            return Err(format!(
                "envelope field '{key}' contains control characters"
            ));
        }
        Ok(raw.to_string())
    };

    let correlation_id = field("correlation_id", MAX_CORRELATION)?;
    let reason = field("reason", MAX_REASON)?;

    let request = obj
        .get("request")
        .ok_or_else(|| "envelope field 'request' missing".to_string())?;
    let request_json =
        serde_json::to_string(request).map_err(|e| format!("re-encode request: {e}"))?;

    Ok((correlation_id, reason, request_json))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test code: a failed assertion should panic loudly"
)]
mod tests {
    use super::*;
    use depsis_agent::audit::MemorySink;
    use depsis_agent::authz::Policy;
    use depsis_agent::seams::mock::{MockCommandRunner, MockSafePath, MockTokenSource};
    use depsis_agent::transfer::TransferRegistry;
    use std::sync::Mutex;

    // ── SO_PEERCRED ──
    //
    // These need a real socket and a real kernel; the mock seam cannot demonstrate them, and
    // ADR-0007 forbids treating mock results as evidence of system behaviour. They are the
    // load-bearing half of threat-model boundary TB4: if `peer_of` were wrong or spoofable, the
    // agent's entire authorization model would rest on nothing.

    fn socket_pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().expect("socketpair")
    }

    #[test]
    fn peer_credentials_report_this_process() {
        let (a, _b) = socket_pair();
        let peer = peer_of(&a).expect("peercred");

        assert_eq!(peer.uid, rustix::process::getuid().as_raw(), "uid");
        assert_eq!(peer.gid, rustix::process::getgid().as_raw(), "gid");
        assert_eq!(
            u32::try_from(peer.pid).unwrap(),
            std::process::id(),
            "pid must be the peer's, and for a socketpair that is us"
        );
    }

    #[test]
    fn peer_identity_is_not_derived_from_anything_on_the_wire() {
        // The attack: a caller writes a request claiming to be uid 0. `peer_of` must be
        // unaffected — it reads the kernel's record of who opened the socket, and there is no
        // code path from bytes to identity.
        let (mut a, b) = socket_pair();
        a.write_all(br#"{"uid":0,"gid":0,"pid":1}"#).expect("write");

        // The claim is that the uid comes from the kernel's record of the peer, not from the
        // bytes. Comparing against `getuid()` states exactly that and holds whoever runs the
        // suite. An earlier version additionally asserted `uid != 0` to prove the wire had not
        // won — but P0-E runs `cargo test` as root, where that assertion fails for a reason
        // that has nothing to do with the property under test.
        let peer = peer_of(&b).expect("peercred");
        assert_eq!(
            peer.uid,
            rustix::process::getuid().as_raw(),
            "peer uid must be the kernel's, not the one asserted in the payload"
        );
        // When the suite is NOT run as root, the payload's claim of uid 0 is also directly
        // contradicted, which is the sharper version of the same statement.
        if rustix::process::getuid().as_raw() != 0 {
            assert_ne!(
                peer.uid, 0,
                "the wire's claim of uid 0 must not be honoured"
            );
        }
    }

    // ── envelope parsing ──
    //
    // Everything below is reached BEFORE dispatch, so a bug here is a bug in front of the
    // authorization check.

    #[test]
    fn a_well_formed_envelope_splits() {
        let (c, r, req) = split_envelope(
            r#"{"correlation_id":"abc123","reason":"user requested","request":{"op":"ping"}}"#,
        )
        .expect("split");
        assert_eq!(c, "abc123");
        assert_eq!(r, "user requested");
        assert_eq!(req, r#"{"op":"ping"}"#);
    }

    #[test]
    fn a_reason_containing_a_newline_is_refused() {
        // Log injection: without this check a caller could append a forged line to the audit
        // trail, e.g. a fabricated entry attributing an action to another operator.
        let err = split_envelope(
            "{\"correlation_id\":\"a\",\"reason\":\"ok\\ndepsis-audit: allow root\",\"request\":{\"op\":\"ping\"}}",
        )
        .expect_err("must refuse control characters");
        assert!(err.contains("control characters"), "got: {err}");
    }

    #[test]
    fn an_overlong_reason_is_refused() {
        let long = "x".repeat(500);
        let line =
            format!(r#"{{"correlation_id":"a","reason":"{long}","request":{{"op":"ping"}}}}"#);
        let err = split_envelope(&line).expect_err("must refuse");
        assert!(err.contains("exceeds"), "got: {err}");
    }

    #[test]
    fn a_missing_request_field_is_refused_not_defaulted() {
        let err =
            split_envelope(r#"{"correlation_id":"a","reason":"b"}"#).expect_err("must refuse");
        assert!(err.contains("'request' missing"), "got: {err}");
    }

    #[test]
    fn a_bare_request_without_an_envelope_is_refused() {
        // There is exactly one wire format. Accepting a bare request "helpfully" would mean
        // privileged calls that carry no reason and no correlation id — unattributable in the
        // audit log, which is the one thing the audit log exists to prevent.
        let err = split_envelope(r#"{"op":"ping"}"#).expect_err("must refuse");
        assert!(err.contains("correlation_id"), "got: {err}");
    }

    #[test]
    fn malformed_json_is_refused_without_panicking() {
        assert!(split_envelope("{not json").is_err());
        assert!(split_envelope("").is_err());
        assert!(split_envelope("[]").is_err());
        assert!(split_envelope("null").is_err());
    }

    // ── socket activation ──

    #[test]
    fn a_listen_pid_for_another_process_is_refused() {
        // Guards the SAFETY assertion above. If this check regressed, the unsafe block would be
        // adopting a descriptor that may belong to another process's socket.
        temp_env(
            &[
                ("LISTEN_PID", Some("1")),
                ("LISTEN_FDS", Some("2")),
                ("LISTEN_FDNAMES", Some("control:data")),
            ],
            || {
                let err = listeners_from_systemd().expect_err("must refuse a foreign LISTEN_PID");
                assert!(
                    err.to_string().contains("meant for someone else"),
                    "got: {err}"
                );
            },
        );
    }

    #[test]
    fn running_without_socket_activation_is_refused() {
        temp_env(&[("LISTEN_PID", None), ("LISTEN_FDS", None)], || {
            let err = listeners_from_systemd().expect_err("must refuse");
            assert!(err.to_string().contains("LISTEN_PID unset"), "got: {err}");
        });
    }

    // ── which descriptor is which ──
    //
    // These drive `socket_offsets` directly rather than `listeners_from_systemd`, because the
    // latter would need two real listening sockets sitting at fixed descriptor numbers. Every
    // decision lives in the pure function; the adoption around it has none. The end-to-end proof
    // that systemd really sets these variables is in the P1-D deployment probe, against pid 1.

    #[test]
    fn the_control_socket_is_found_by_name_and_not_by_position() {
        // The whole reason `Listeners` is a struct. systemd's descriptor order follows unit load
        // order, so `data` arriving first is not a hypothetical — and reading fd 3 as the control
        // socket would make the agent parse uploaded file bytes as JSON commands and stream a
        // user's data into whatever answered the control connection.
        assert_eq!(
            socket_offsets(Some("control:data"), 2).expect("both named"),
            (0, 1)
        );
        assert_eq!(
            socket_offsets(Some("data:control"), 2).expect("both named"),
            (1, 0)
        );
    }

    #[test]
    fn a_descriptor_nobody_named_is_refused() {
        // systemd always sets LISTEN_FDNAMES when it passes descriptors, so an absent value means
        // something other than systemd handed them over.
        let err = socket_offsets(None, 2).expect_err("must refuse");
        assert!(
            err.to_string().contains("LISTEN_FDNAMES unset"),
            "got: {err}"
        );
    }

    #[test]
    fn a_name_this_agent_does_not_serve_is_refused() {
        // Fail closed. A listening root socket nobody accepts on is worse than not starting.
        let err = socket_offsets(Some("control:data:debug"), 3).expect_err("must refuse");
        assert!(err.to_string().contains("\"debug\""), "got: {err}");
    }

    #[test]
    fn the_control_socket_alone_is_not_enough_to_start() {
        // Starting here would be the worst of both worlds: the API mints transfer tokens and
        // stages files for data connections that can never arrive, so every upload fails after a
        // five-minute timeout and looks like a network problem.
        let err = socket_offsets(Some("control"), 1).expect_err("must refuse");
        assert!(
            err.to_string().contains("depsis-agent-data.socket"),
            "got: {err}"
        );
    }

    #[test]
    fn the_data_socket_alone_is_not_enough_to_start() {
        let err = socket_offsets(Some("data"), 1).expect_err("must refuse");
        assert!(
            err.to_string().contains("depsis-agent.socket"),
            "got: {err}"
        );
    }

    #[test]
    fn two_sockets_sharing_a_name_are_refused() {
        let err = socket_offsets(Some("control:control"), 2).expect_err("must refuse");
        assert!(err.to_string().contains("both named"), "got: {err}");
    }

    #[test]
    fn a_name_list_that_does_not_match_the_descriptor_count_is_refused() {
        // Without one name per descriptor there is no mapping, only a guess — and a guess here
        // picks a socket for the agent to trust.
        let err = socket_offsets(Some("control:data"), 3).expect_err("must refuse");
        assert!(err.to_string().contains("names 2 sockets"), "got: {err}");
        let err = socket_offsets(Some("control:data:extra"), 2).expect_err("must refuse");
        assert!(err.to_string().contains("names 3 sockets"), "got: {err}");
    }

    /// Set environment variables for the duration of `f`, then restore them.
    ///
    /// `std::env::set_var` is process-global and Rust runs tests in threads, so these three tests
    /// must not run concurrently with each other. A mutex, not `--test-threads=1`, because the
    /// constraint belongs with the code that has it rather than in a CI invocation someone will
    /// eventually copy without it.
    fn temp_env(vars: &[(&str, Option<&str>)], f: impl FnOnce()) {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let saved: Vec<(String, Option<String>)> = vars
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in vars {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }

        f();

        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(&k, val),
                None => std::env::remove_var(&k),
            }
        }
    }

    // ── openat2 containment ──
    //
    // These exercise `Openat2SafePath` itself, against a real kernel. They lived in
    // `tests/openat2_containment.rs` for one build, which was a mistake: an integration test
    // cannot import a binary's modules, so it had to re-declare the flag set and was therefore
    // testing a copy that could drift from the real one. Here they drive the actual struct.
    //
    // A mock cannot stand in for any of this — the confinement is the kernel's, and ADR-0007 is
    // explicit that mock results are not evidence of filesystem behaviour. Risk R3 (path
    // traversal and symlink TOCTOU) is what they defend.

    #[test]
    fn a_file_inside_the_root_resolves() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("inside.txt"), b"hello").expect("write");

        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        assert!(sp.open(&["inside.txt"], OpenIntent::Read).is_ok());
    }

    #[test]
    fn dotdot_cannot_climb_out_of_the_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(tmp.path().join("secret.txt"), b"not yours").expect("write");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        assert!(
            sp.open(&["..", "secret.txt"], OpenIntent::Read).is_err(),
            "RESOLVE_BENEATH must refuse .. — it escaped instead"
        );
    }

    #[test]
    fn a_symlink_pointing_outside_is_refused_rather_than_followed() {
        // The attack: a user creates a symlink inside their own share pointing at /etc/shadow,
        // then asks the agent to read it. Without NO_SYMLINKS the agent, running as root, would
        // follow it happily.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(tmp.path().join("secret.txt"), b"not yours").expect("write");
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("link"))
            .expect("symlink");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        assert!(
            sp.open(&["link"], OpenIntent::Read).is_err(),
            "RESOLVE_NO_SYMLINKS must refuse a symlink even before asking where it points"
        );
    }

    #[test]
    fn an_absolute_looking_component_cannot_reset_the_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        // Under a plain `join`, an absolute component discards everything before it. BENEATH
        // refuses instead. `SafeComponent` also rejects this earlier — belt and braces, because
        // the two defences fail for different reasons.
        assert!(sp.open(&["/etc/passwd"], OpenIntent::Read).is_err());
    }

    #[test]
    fn what_comes_back_is_the_object_that_was_checked_not_a_path_to_re_resolve() {
        // The TOCTOU test, and the reason this trait hands back a File.
        //
        // The old implementation resolved with openat2, dropped the descriptor and returned a
        // joined path for somebody else to open later. Between those two moments the name can be
        // repointed — and the second open is an ordinary resolution with none of the RESOLVE_
        // flags, so it follows the new target straight out of the root.
        //
        // Here the name is repointed at a file outside the root AFTER the open. Holding the
        // descriptor, the agent still reads what it was given; a path would have read the
        // attacker's file.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("share");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(root.join("upload.part"), b"the real contents").expect("write");
        std::fs::write(tmp.path().join("secret.txt"), b"not yours").expect("write");

        let sp = Openat2SafePath::open_root(&root).expect("open root");
        let mut held = sp.open(&["upload.part"], OpenIntent::Read).expect("open");

        // The swap, after the check.
        std::fs::remove_file(root.join("upload.part")).expect("unlink");
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("upload.part"))
            .expect("symlink");

        let mut got = String::new();
        std::io::Read::read_to_string(&mut held, &mut got).expect("read");
        assert_eq!(
            got, "the real contents",
            "the open descriptor must still be the file that was confined, not whatever the name \
             now points at"
        );

        // And a fresh open of the same name is refused outright, because it is now a symlink.
        assert!(
            sp.open(&["upload.part"], OpenIntent::Read).is_err(),
            "the swapped-in symlink must be refused on the next open"
        );
    }

    #[test]
    fn two_appenders_do_not_overwrite_each_other() {
        // What O_APPEND buys, made observable. Without it each descriptor writes at its OWN cached
        // position, so the second writer lands on top of the first and the file ends up the length
        // of one write instead of two — silently, with no error at any layer. With it the kernel
        // resolves the position at every write and the worst case degrades to interleaving.
        //
        // A flag nothing tests is a flag that gets removed in a cleanup.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        let mut first = sp
            .open(&["shared.part"], OpenIntent::Append)
            .expect("open a");
        let mut second = sp
            .open(&["shared.part"], OpenIntent::Append)
            .expect("open b");

        use std::io::Write as _;
        first.write_all(b"AAAA").expect("write a");
        second.write_all(b"BBBB").expect("write b");
        first.write_all(b"CCCC").expect("write a again");

        let got = std::fs::read(tmp.path().join("shared.part")).expect("read");
        assert_eq!(
            got.len(),
            12,
            "every write must land at the end; got {:?}",
            String::from_utf8_lossy(&got)
        );
        // Order between the two writers is not guaranteed, but no byte may be lost.
        for needle in [&b"AAAA"[..], &b"BBBB"[..], &b"CCCC"[..]] {
            assert!(
                got.windows(4).any(|w| w == needle),
                "{:?} was overwritten",
                String::from_utf8_lossy(needle)
            );
        }
    }

    #[test]
    fn create_new_refuses_a_name_that_already_exists() {
        // Two callers racing to claim the same staging name must not both win. EXCL is what makes
        // the claim atomic; without it the loser silently shares a file with the winner and the
        // upload is interleaved garbage.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        assert!(sp.open(&["claim.part"], OpenIntent::CreateNew).is_ok());
        assert!(
            sp.open(&["claim.part"], OpenIntent::CreateNew).is_err(),
            "the second claim on the same name must lose"
        );
    }

    #[test]
    fn a_created_file_is_not_readable_by_everyone_while_it_is_written() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");
        sp.open(&["private.part"], OpenIntent::CreateNew)
            .expect("create");

        let mode = std::fs::metadata(tmp.path().join("private.part"))
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "staging data must not be world-readable while it is being written"
        );
    }

    #[test]
    fn a_directory_can_be_opened_for_its_own_fsync() {
        // ADR-0008 step 5: the destination DIRECTORY is fsynced after the rename. Skipping it can
        // lose the rename in a power cut even though the file's contents survived, so the
        // confinement has to be able to hand back a directory too.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(tmp.path().join("dest")).expect("mkdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        let dir = sp.open_dir(&["dest"]).expect("open dir");
        dir.sync_all()
            .expect("fsync on a directory fd must succeed");

        // And a FILE must not come back from open_dir, or an fsync would be aimed at the wrong
        // object and report success having flushed nothing relevant.
        std::fs::write(tmp.path().join("plain.txt"), b"x").expect("write");
        assert!(sp.open_dir(&["plain.txt"]).is_err());
    }

    /// NO_XDEV, against a real mount boundary.
    ///
    /// Ignored by default because a tempdir on ext4 has no mount boundary to cross, so the test
    /// would pass without demonstrating anything. P0-E creates a nested ZFS dataset — which on
    /// ZFS is a separate mount, not merely a subdirectory — and runs this with the two paths in
    /// the environment. That distinction is the whole reason NO_XDEV is in the flag set: on a
    /// box where every share is a dataset, a nested dataset's mountpoint is a way out of the
    /// share the caller was confined to, and BENEATH alone does not stop it.
    #[test]
    #[ignore = "needs a real nested mount; P0-E supplies DEPSIS_XDEV_ROOT and DEPSIS_XDEV_CHILD"]
    fn no_xdev_refuses_crossing_into_a_nested_mount() {
        let root = std::env::var("DEPSIS_XDEV_ROOT").expect("DEPSIS_XDEV_ROOT");
        let child = std::env::var("DEPSIS_XDEV_CHILD").expect("DEPSIS_XDEV_CHILD");

        let sp = Openat2SafePath::open_root(&root).expect("open root");

        // A plain subdirectory of the same mount still resolves — otherwise this test would pass
        // for the wrong reason on any filesystem.
        std::fs::create_dir_all(format!("{root}/plain")).expect("mkdir");
        assert!(
            sp.open_dir(&["plain"]).is_ok(),
            "a same-mount subdirectory must still resolve"
        );

        match sp.open_dir(&[&child]) {
            Err(SeamError::PathEscape(_)) => {}
            Err(other) => panic!("expected PathEscape crossing into {child}, got {other:?}"),
            Ok(_) => panic!("NO_XDEV did not stop the crossing: the nested mount opened"),
        }
    }

    #[test]
    fn refusal_is_an_error_not_a_silent_clamp() {
        // Why ADR-0006 chose BENEATH over IN_ROOT. IN_ROOT resolves `../../etc` to the root and
        // succeeds, so a traversal attempt looks like an ordinary read and never reaches the
        // audit trail. This pins the loud behaviour.
        let tmp = tempfile::tempdir().expect("tempdir");
        let sp = Openat2SafePath::open_root(tmp.path()).expect("open root");

        match sp.open_dir(&["..", "..", "etc"]) {
            Err(SeamError::PathEscape(_)) => {}
            Err(other) => panic!("expected PathEscape, got {other:?}"),
            Ok(_) => panic!("traversal silently succeeded: /etc opened from inside the root"),
        }
    }

    // ── serve_one over a real socket ──
    //
    // These drive the actual read path rather than `split_envelope` in isolation, because the
    // bug they pin lived between the two: the framing, not the parsing. A socketpair is a real
    // AF_UNIX stream socket, so SO_PEERCRED works and `shutdown` behaves as it does in
    // production — which is precisely what the in-memory mock transport cannot reproduce.

    /// The collaborators the framing tests need, owned by the caller so the borrows outlive the
    /// `Agent`. None of these tests exercise transfers — they are about the read path — so the
    /// share root is absent and the registry stays empty.
    #[derive(Default)]
    struct ServeFixtures {
        transfers: Mutex<TransferRegistry>,
        tokens: MockTokenSource,
    }

    fn serving_agent<'a>(
        runner: &'a MockCommandRunner,
        sink: &'a MemorySink,
        fixtures: &'a ServeFixtures,
    ) -> Agent<'a, MockCommandRunner, MemorySink, MockSafePath> {
        // The tests below connect to themselves, so the peer uid is this process's uid. Telling
        // the policy that this uid is the API is what lets the request through to the framing
        // code, which is what is under test here.
        Agent::new(
            Policy {
                api_uid: rustix::process::getuid().as_raw(),
            },
            runner,
            sink,
            None,
            &fixtures.tokens,
            &fixtures.transfers,
        )
    }

    /// Run `serve_one` against one side of a socketpair while `payload` is written to the other,
    /// and return the response line.
    fn round_trip(payload: &[u8], shutdown_write: bool) -> String {
        let (client, server) = socket_pair();
        let payload = payload.to_vec();

        let writer = std::thread::spawn(move || {
            let mut c = client;
            c.write_all(&payload).expect("write payload");
            if shutdown_write {
                c.shutdown(std::net::Shutdown::Write).expect("shutdown");
            }
            let mut out = String::new();
            let _ = c.read_to_string(&mut out);
            out
        });

        let runner = MockCommandRunner::default();
        let sink = MemorySink::default();
        let fixtures = ServeFixtures::default();
        let agent = serving_agent(&runner, &sink, &fixtures);
        serve_one(&server, &agent).expect("serve_one");
        drop(server);

        writer.join().expect("writer thread")
    }

    #[test]
    fn a_request_without_a_trailing_newline_is_answered_not_called_oversized() {
        // The regression. A client that sends a complete request and shuts down its write side
        // is behaving correctly; answering it with "request exceeds 262144 bytes" is both wrong
        // and actively misleading to whoever has to debug it.
        let out = round_trip(
            br#"{"correlation_id":"t1","reason":"no newline","request":{"op":"ping"}}"#,
            true,
        );
        assert!(out.contains(r#""status":"ok""#), "expected ok, got: {out}");
        assert!(
            !out.contains("exceeds"),
            "a complete request was reported as oversized: {out}"
        );
    }

    #[test]
    fn a_request_with_a_trailing_newline_is_answered_too() {
        let out = round_trip(
            b"{\"correlation_id\":\"t2\",\"reason\":\"newline\",\"request\":{\"op\":\"ping\"}}\n",
            false,
        );
        assert!(out.contains(r#""status":"ok""#), "got: {out}");
    }

    #[test]
    fn a_dribbling_client_is_cut_off_by_the_deadline() {
        // The regression: `set_read_timeout` arms SO_RCVTIMEO, which bounds ONE recv(2), not a
        // connection. A peer that sends a byte just under the timeout re-arms the window forever,
        // and because the agent serves one connection at a time that wedges the whole daemon.
        //
        // The writer end is held open for the duration, so `read` cannot see EOF — only the
        // deadline can end this. With the per-syscall behaviour the call would never return.
        let (client, server) = socket_pair();
        let mut c = client;
        c.write_all(b"{\"correlation_id\":\"d\"")
            .expect("partial write");

        let budget = Duration::from_millis(250);
        let started = Instant::now();
        let result = read_request_line_within(&server, budget);
        let elapsed = started.elapsed();

        match result {
            Err(SeamError::Io(msg)) => assert!(
                msg.contains("not complete"),
                "expected a deadline error, got: {msg}"
            ),
            Ok(partial) => panic!("a partial request was accepted as complete: {partial:?}"),
            Err(other) => panic!("unexpected error kind: {other:?}"),
        }
        assert!(
            elapsed < budget * 8,
            "the read ran for {elapsed:?}, far past its {budget:?} budget"
        );

        drop(c);
    }

    #[test]
    fn a_complete_request_still_arrives_well_inside_the_budget() {
        // The other half: bounding the read must not have broken the normal path.
        let (client, server) = socket_pair();
        let mut c = client;
        c.write_all(
            b"{\"correlation_id\":\"ok\",\"reason\":\"r\",\"request\":{\"op\":\"ping\"}}\n",
        )
        .expect("write");

        let line = read_request_line_within(&server, Duration::from_secs(5)).expect("read");
        assert!(line.contains("\"op\":\"ping\""), "got: {line}");
        drop(c);
    }

    #[test]
    fn a_request_at_the_size_cap_is_still_refused() {
        // The check the regression fix must not have removed.
        let mut payload =
            br#"{"correlation_id":"t3","reason":"big","request":{"op":"ping","pad":""#.to_vec();
        payload.resize(MAX_REQUEST_BYTES as usize + 64, b'x');
        let out = round_trip(&payload, true);
        assert!(
            out.contains("exceeds"),
            "oversized request not refused: {out}"
        );
    }
}
