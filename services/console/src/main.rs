//! DEPSIS administrator console binary.
//!
//! Speaks the console socket protocol on a socket systemd hands over, and runs one pty session
//! per connection. See `lib.rs` for why this is a separate process from the privileged agent
//! and what constrains it.
//!
//! The `cfg` gate is on the inner module declaration, not scattered through function bodies —
//! the same arrangement as `services/system-agent`, so the Unix boundary is visible in one
//! place and the portable core keeps compiling for Windows.

// `deny`, not `forbid`. `forbid` cannot be lifted locally and exactly one place here needs
// `unsafe`: adopting the listening descriptor systemd passes over. The library crate
// `depsis_console` — including the pty — remains `forbid(unsafe_code)` with no exceptions.
#![deny(unsafe_code)]

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--serve") => serve(),
        _ => {
            eprintln!(
                "depsis-console

  --serve   accept console sessions on the socket handed over by systemd

The socket is created by depsis-console.socket, not by this process: letting systemd own it
makes the socket file's ownership and mode the first authorization gate, checked by the kernel
before this service sees a byte. Its path is configured there (ListenStream=), not here.

--serve requires DEPSIS_API_UID to be set to the uid the DEPSIS API runs as. It is read from
the environment, never inferred from a caller.

Optional:
  DEPSIS_CONSOLE_PRIVILEGED       0 (default) or 1; must agree with the unit's User=
  DEPSIS_CONSOLE_IDLE_TIMEOUT_SECS  default 900
  DEPSIS_CONSOLE_MAX_AGE_SECS       default 14400"
            );
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(unix)]
fn serve() -> std::process::ExitCode {
    unix::serve()
}

#[cfg(not(unix))]
fn serve() -> std::process::ExitCode {
    // Windows is a development host only. What must keep working here is compiling and testing
    // the protocol and session logic; a pty is not a thing this platform has.
    eprintln!("--serve is Unix-only; this build exists so the core can be tested on Windows.");
    std::process::ExitCode::FAILURE
}

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::io::{Read as _, Write as _};
    use std::net::Shutdown;
    use std::os::fd::{FromRawFd as _, OwnedFd, RawFd};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::process::ExitCode;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use depsis_console::protocol::{ClientMessage, Open, ServerMessage, MAX_LINE_BYTES};
    use depsis_console::pty::{find_setsid, find_shell, Pty};
    use depsis_console::session::{
        privilege_from, Deadlines, Expiry, Limits, LineExtractor, DEFAULT_IDLE_TIMEOUT,
        DEFAULT_MAX_AGE, MIN_CONFIGURABLE,
    };

    /// Number of the first file descriptor systemd hands over (`SD_LISTEN_FDS_START`).
    const SD_LISTEN_FDS_START: RawFd = 3;

    /// The name the socket unit declares via `FileDescriptorName=`.
    const CONSOLE_FD_NAME: &str = "console";

    /// How many sessions may be open at once.
    ///
    /// A thread per session, unlike the agent's serial control loop — a console is held open by
    /// a human for minutes at a time, so serialising would mean the second administrator's
    /// terminal simply never opens. Eight because the number of people who can be at a NAS's
    /// admin console at once is small, and because an unbounded thread-per-connection accept
    /// loop is a denial-of-service primitive handed to whoever can reach the socket.
    const MAX_SESSIONS: usize = 8;

    /// How long the API has to send its `open` after connecting.
    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

    /// How long a single write to the API may block before the session is written off.
    ///
    /// Without it, an API that stops reading (a wedged SSE consumer) leaves this service blocked
    /// in `write` forever with a shell still running behind it.
    const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

    /// Bytes read from the pty in one go. Terminal output is bursty — a `find /` produces
    /// megabytes — and a small buffer would turn that into a message per few hundred bytes.
    const OUT_CHUNK: usize = 32 * 1024;

    #[derive(Debug, Clone)]
    pub struct Config {
        pub limits: Limits,
        pub privileged: bool,
        pub shell: PathBuf,
        pub home: Option<OsString>,
    }

    // ─── startup ──────────────────────────────────────────────────────────────

    pub fn serve() -> ExitCode {
        // The uid the API runs as is configuration, not something to discover. Looking a
        // username up at runtime would mean a rename or a uid reuse silently changed who may
        // open a shell on this box.
        let api_uid: u32 = match std::env::var("DEPSIS_API_UID").map(|v| v.trim().parse::<u32>()) {
            Ok(Ok(uid)) => uid,
            Ok(Err(e)) => return fail(&format!("DEPSIS_API_UID is not a uid: {e}")),
            Err(_) => return fail("DEPSIS_API_UID is unset; refusing to start"),
        };
        if api_uid == 0 {
            // Would make the root refusal below unreachable and every session indistinguishable
            // from any other root process on the box.
            return fail("DEPSIS_API_UID must not be 0");
        }

        let euid = rustix::process::geteuid().as_raw();
        let flag = std::env::var("DEPSIS_CONSOLE_PRIVILEGED").ok();
        let privileged = match privilege_from(flag.as_deref(), euid) {
            Ok(p) => p,
            Err(why) => return fail(&why),
        };

        let limits = match read_limits() {
            Ok(l) => l,
            Err(why) => return fail(&why),
        };

        // No shell means no console. Failing the unit is the right shape: the API then finds
        // nothing serving the socket and answers 503 — "switched off" rather than "broken".
        let Some(shell) = find_shell() else {
            return fail("no /bin/bash and no /bin/sh; there is no console to serve");
        };

        // A missing `setsid` is not fatal — the shell still starts — but it takes the controlling
        // terminal with it, and a console where Ctrl-C does nothing is a support call. Once here,
        // where the operator looks when the console misbehaves, rather than per session.
        if find_setsid().is_none() {
            eprintln!(
                "depsis-console: no setsid on this system; sessions will open WITHOUT a \
                 controlling terminal, so Ctrl-C and window resizes will not reach the programs \
                 running in the shell"
            );
        }

        let listener = match listener_from_systemd() {
            Ok(l) => l,
            Err(why) => return fail(&why),
        };

        let config = Config {
            limits,
            privileged,
            shell,
            home: std::env::var_os("HOME"),
        };

        eprintln!(
            "depsis-console: serving, api_uid={api_uid}, privileged={privileged}, shell={}, \
             idle={}s, max_age={}s",
            config.shell.display(),
            config.limits.idle_timeout.as_secs(),
            config.limits.max_age.as_secs()
        );

        accept_loop(&listener, api_uid, &config)
    }

    fn fail(message: &str) -> ExitCode {
        eprintln!("depsis-console: {message}");
        ExitCode::FAILURE
    }

    /// Read a configurable duration, refusing values short enough to be wrong under any policy.
    fn read_duration(key: &str, default: Duration) -> Result<Duration, String> {
        let Some(raw) = std::env::var(key).ok().filter(|v| !v.trim().is_empty()) else {
            return Ok(default);
        };
        let secs: u64 = raw
            .trim()
            .parse()
            .map_err(|e| format!("{key} is not a number of seconds: {e}"))?;
        let value = Duration::from_secs(secs);
        if value < MIN_CONFIGURABLE {
            return Err(format!(
                "{key} is {secs}s; anything under {}s is a console nobody can type into",
                MIN_CONFIGURABLE.as_secs()
            ));
        }
        Ok(value)
    }

    fn read_limits() -> Result<Limits, String> {
        Ok(Limits {
            idle_timeout: read_duration("DEPSIS_CONSOLE_IDLE_TIMEOUT_SECS", DEFAULT_IDLE_TIMEOUT)?,
            max_age: read_duration("DEPSIS_CONSOLE_MAX_AGE_SECS", DEFAULT_MAX_AGE)?,
        })
    }

    // ─── socket activation ────────────────────────────────────────────────────
    //
    // Copied in shape from `services/system-agent/src/unix.rs`, deliberately and with the same
    // reasoning: the `sd_listen_fds` protocol is three environment variables, and a crate for it
    // would add an unaudited transitive tree to a daemon that spawns shells. Factoring the two
    // copies into a shared crate is a larger change than this service, and would drag the
    // agent — the most security-sensitive binary in the product — through a refactor it does not
    // need. If a third service ever wants this, that is the moment.

    /// Map `LISTEN_FDNAMES` onto a descriptor offset, or refuse.
    ///
    /// Split out from the adoption below so it can be tested without conjuring real listening
    /// sockets at fixed descriptor numbers.
    fn socket_offset(fdnames: Option<&str>, listen_fds: i32) -> Result<i32, String> {
        let Some(fdnames) = fdnames else {
            return Err(
                "LISTEN_FDNAMES unset: the socket unit must declare FileDescriptorName=".into(),
            );
        };
        let names: Vec<&str> = fdnames.split(':').collect();
        if i32::try_from(names.len()).unwrap_or(i32::MAX) != listen_fds {
            return Err(format!(
                "LISTEN_FDS is {listen_fds} but LISTEN_FDNAMES names {} sockets",
                names.len()
            ));
        }
        let mut found: Option<i32> = None;
        for (index, name) in names.iter().enumerate() {
            if *name != CONSOLE_FD_NAME {
                // Not "ignore the ones we do not know": a descriptor this service cannot name is
                // a listening socket nobody will ever accept on, which looks to an operator like
                // a console that hangs.
                return Err(format!(
                    "systemd passed a socket named {name:?}, which this service does not serve"
                ));
            }
            if found.is_some() {
                return Err(format!("two sockets are both named {CONSOLE_FD_NAME:?}"));
            }
            found = Some(i32::try_from(index).unwrap_or(i32::MAX));
        }
        found.ok_or_else(|| {
            format!("no socket named {CONSOLE_FD_NAME:?}; is depsis-console.socket running?")
        })
    }

    /// Adopt the listening socket systemd created.
    #[allow(
        unsafe_code,
        reason = "The one unavoidable unsafe in this binary: adopting a descriptor from systemd \
                  means asserting ownership of an integer, which no safe API can express. The \
                  assertion is discharged by the LISTEN_PID check — the descriptor was passed to \
                  *this* pid — and by this function being called once, from `serve`. The library \
                  crate `depsis_console` remains forbid(unsafe_code)."
    )]
    fn listener_from_systemd() -> Result<UnixListener, String> {
        let listen_pid: u32 = std::env::var("LISTEN_PID")
            .map_err(|_| "LISTEN_PID unset: not socket-activated".to_string())?
            .parse()
            .map_err(|_| "LISTEN_PID is not a number".to_string())?;
        if listen_pid != std::process::id() {
            return Err(format!(
                "LISTEN_PID is {listen_pid}, this process is {}; refusing an fd meant for \
                 someone else",
                std::process::id()
            ));
        }

        let listen_fds: i32 = std::env::var("LISTEN_FDS")
            .map_err(|_| "LISTEN_FDS unset".to_string())?
            .parse()
            .map_err(|_| "LISTEN_FDS is not a number".to_string())?;

        let fdnames = std::env::var("LISTEN_FDNAMES").ok();
        let offset = socket_offset(fdnames.as_deref(), listen_fds)?;

        // Clear them so the shells started below cannot mistake themselves for an activated
        // service. `Pty::open` calls `env_clear` as well; this is belt and braces.
        std::env::remove_var("LISTEN_PID");
        std::env::remove_var("LISTEN_FDS");
        std::env::remove_var("LISTEN_FDNAMES");

        // SAFETY: systemd passed this descriptor to this pid (verified above), nothing else in
        // the process owns it, and this function runs exactly once, from `serve`.
        let fd = unsafe { OwnedFd::from_raw_fd(SD_LISTEN_FDS_START + offset) };

        let kind = rustix::net::sockopt::socket_type(&fd)
            .map_err(|e| format!("the {CONSOLE_FD_NAME} fd is not a socket: {e}"))?;
        if kind != rustix::net::SocketType::STREAM {
            return Err(format!(
                "the {CONSOLE_FD_NAME} fd is a socket but not SOCK_STREAM ({kind:?})"
            ));
        }
        Ok(UnixListener::from(fd))
    }

    // ─── who may connect ──────────────────────────────────────────────────────

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct PeerIdentity {
        pub uid: u32,
        pub pid: i32,
    }

    /// Peer credentials straight from the kernel.
    ///
    /// Nothing on the wire can influence this. The same reasoning as the agent's `authz`: the
    /// request body is written by the caller, the credentials are written by the kernel.
    fn peer_of(stream: &UnixStream) -> Result<PeerIdentity, String> {
        let creds = rustix::net::sockopt::socket_peercred(stream)
            .map_err(|e| format!("no peer credentials on this connection: {e}"))?;
        Ok(PeerIdentity {
            uid: creds.uid.as_raw(),
            pid: creds.pid.as_raw_nonzero().get(),
        })
    }

    /// One caller, the API. There is no per-user rule here because the application already has
    /// one — `AdminGuard` plus password re-authentication (ADR-0018) — and two authorization
    /// models drift. The application decides *whether this user may open a console*; this
    /// service decides *whether the caller is the application*.
    pub fn peer_is_api(peer: PeerIdentity, api_uid: u32) -> Result<(), String> {
        if peer.uid == api_uid {
            Ok(())
        } else if peer.uid == 0 {
            // Root could bypass the socket entirely, so refusing is not a security control — but
            // accepting would let a stray root script open shells that `console_sessions` would
            // attribute to a logged-in administrator. Refuse and make it visible.
            Err(format!(
                "pid {} is root, not the API; use the API's uid",
                peer.pid
            ))
        } else {
            Err(format!(
                "pid {} runs as uid {}, which is not the configured API uid",
                peer.pid, peer.uid
            ))
        }
    }

    // ─── accept ───────────────────────────────────────────────────────────────

    fn accept_loop(listener: &UnixListener, api_uid: u32, config: &Config) -> ExitCode {
        let live = Arc::new(AtomicUsize::new(0));
        loop {
            let mut stream = match listener.accept() {
                Ok((stream, _addr)) => stream,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                // EMFILE/ENFILE is a transient shortage. There is no `ErrorKind` for either, so
                // without this arm they fall through to the fatal one and the process dies — and
                // a rate-limited unit turns five of those into a permanently failed service.
                Err(e) if is_descriptor_shortage(&e) => {
                    eprintln!("depsis-console: out of descriptors on accept ({e}); retrying");
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(e) => {
                    eprintln!("depsis-console: accept failed: {e}");
                    return ExitCode::FAILURE;
                }
            };

            // Before a slot is spent, so a caller that is not the API cannot exhaust the pool.
            match peer_of(&stream).and_then(|peer| peer_is_api(peer, api_uid)) {
                Ok(()) => {}
                Err(why) => {
                    eprintln!("depsis-console: refused a connection: {why}");
                    let _ = stream.write_all(
                        ServerMessage::Error {
                            message: "not authorized on this socket".into(),
                        }
                        .to_wire()
                        .as_bytes(),
                    );
                    continue;
                }
            }

            if live.load(Ordering::SeqCst) >= MAX_SESSIONS {
                eprintln!("depsis-console: {MAX_SESSIONS} sessions already open; refusing");
                let _ = stream.write_all(
                    ServerMessage::Error {
                        message: format!("{MAX_SESSIONS} console sessions are already open"),
                    }
                    .to_wire()
                    .as_bytes(),
                );
                continue;
            }

            live.fetch_add(1, Ordering::SeqCst);
            let counter = Arc::clone(&live);
            let config = config.clone();
            let spawned = std::thread::Builder::new()
                .name("console-session".into())
                .spawn(move || {
                    if let Err(why) = serve_connection(&stream, &config) {
                        eprintln!("depsis-console: session ended badly: {why}");
                    }
                    counter.fetch_sub(1, Ordering::SeqCst);
                });
            if let Err(e) = spawned {
                eprintln!("depsis-console: could not start a session thread: {e}");
                live.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    fn is_descriptor_shortage(e: &std::io::Error) -> bool {
        matches!(
            e.raw_os_error(),
            Some(n) if n == rustix::io::Errno::MFILE.raw_os_error()
                    || n == rustix::io::Errno::NFILE.raw_os_error()
        )
    }

    // ─── one session ──────────────────────────────────────────────────────────

    /// Everything one connection can be doing.
    struct Wire<'a> {
        stream: &'a UnixStream,
        /// Two threads write here — the command loop sends `line`, the output pump sends `out` —
        /// and a half-written JSON line would desynchronise the framing for the rest of the
        /// session.
        guard: Mutex<()>,
    }

    impl Wire<'_> {
        fn send(&self, message: &ServerMessage) -> std::io::Result<()> {
            let _held = self
                .guard
                .lock()
                .map_err(|_| std::io::Error::other("console wire lock poisoned"))?;
            let mut w = self.stream;
            w.write_all(message.to_wire().as_bytes())?;
            w.flush()
        }
    }

    /// Why the session ended. The `close_reason` strings are `console_sessions.close_reason`'s
    /// vocabulary from migration 0013, so the API stores what it is told rather than translating.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum End {
        /// The API sent `close`, or the operator typed `exit`.
        Requested,
        /// The connection went away. Nothing left to tell.
        PeerGone,
        Expired(Expiry),
        Protocol(String),
    }

    pub fn serve_connection(stream: &UnixStream, config: &Config) -> Result<(), String> {
        stream
            .set_write_timeout(Some(WRITE_TIMEOUT))
            .map_err(|e| format!("arm the write timeout: {e}"))?;
        let wire = Wire {
            stream,
            guard: Mutex::new(()),
        };
        let mut reader = LineReader::new();

        // ── handshake ──
        let handshake = Deadlines::open(
            Limits {
                idle_timeout: HANDSHAKE_TIMEOUT,
                max_age: HANDSHAKE_TIMEOUT,
            },
            Instant::now(),
        );
        let open = match reader.next(stream, &handshake) {
            Ok(Incoming::Line(line)) => match ClientMessage::parse(&line) {
                Ok(ClientMessage::Open(open)) => open,
                Ok(_) => return refuse(&wire, "the first message must be open"),
                Err(e) => return refuse(&wire, &format!("{e}")),
            },
            Ok(Incoming::Eof) => return Ok(()),
            Ok(Incoming::TooLong) => return refuse(&wire, "the open message is too long"),
            Ok(Incoming::Expired(_)) => return refuse(&wire, "no open message arrived"),
            Err(e) => return Err(format!("read the open message: {e}")),
        };

        // Asked for root and this unit does not provide it. Refusing rather than quietly handing
        // back an ordinary shell: the administrator would run a command, watch it fail on
        // permissions, and have no way to tell that from the command being wrong.
        //
        // The reverse — asked for an ordinary shell on a unit configured privileged — is served,
        // because on such a box EVERY console is root and there is nothing else to give. `ready`
        // reports the truth, and ADR-0018 requires a hand edit of the unit file to get there.
        if open.privileged && !config.privileged {
            return refuse(
                &wire,
                "this console is not privileged; DEPSIS_CONSOLE_PRIVILEGED is not set",
            );
        }

        // The same reader, not a fresh one. The API is free to pipeline — an `open` and the
        // first `in` can arrive in a single read — and a second reader would silently drop
        // whatever was already buffered behind the open message.
        run_session(&wire, stream, config, &open, &mut reader)
    }

    fn refuse(wire: &Wire<'_>, message: &str) -> Result<(), String> {
        let _ = wire.send(&ServerMessage::Error {
            message: message.to_string(),
        });
        let _ = wire.stream.shutdown(Shutdown::Both);
        Err(message.to_string())
    }

    fn run_session(
        wire: &Wire<'_>,
        stream: &UnixStream,
        config: &Config,
        open: &Open,
        reader: &mut LineReader,
    ) -> Result<(), String> {
        let mut pty = Pty::open(&config.shell, open.size, config.home.as_deref())
            .map_err(|e| format!("open a pty: {e}"))?;

        eprintln!(
            "depsis-console: session {} opened for user {} (pid {}, privileged={})",
            open.session.as_str(),
            open.user.as_str(),
            pty.pid(),
            config.privileged
        );

        // The `?` here returns without the `terminate()`/`wait()` below, and it is a reachable
        // return: the API's wait for `ready` is shorter than this service's handshake window, so a
        // loaded box can be inside `Pty::open` when the API hangs up, and this send then fails with
        // EPIPE. What keeps that from leaving an unsignalled process group behind is `Drop for
        // Pty`, which terminates and reaps anything nobody waited on.
        wire.send(&ServerMessage::Ready {
            pid: pty.pid(),
            privileged: config.privileged,
        })
        .map_err(|e| format!("send ready: {e}"))?;

        let end = std::thread::scope(|scope| {
            let pump = scope.spawn(|| pump_output(&pty, wire, stream));
            let end = command_loop(wire, stream, &pty, config.limits, reader);
            // Whatever ended it, the shell goes — and with it the background jobs holding the
            // user side of the pty open, which is what lets the pump below reach end-of-file.
            pty.terminate();
            let _ = pump.join();
            end
        });

        let code = pty.wait().unwrap_or(-1);

        // Why the session ended has to survive the ending. A send failure here is logged
        // rather than swallowed: without it, an API that recorded no close reason looks like an
        // API bug rather than a socket that went away half a message ago.
        let farewell = match &end {
            // The protocol's `exit` carries no reason, so the reason travels as an `error` just
            // ahead of it, using `console_sessions.close_reason`'s exact vocabulary.
            End::Expired(expiry) => Some(expiry.close_reason().to_string()),
            End::Protocol(why) => Some(why.clone()),
            End::Requested | End::PeerGone => None,
        };
        if let Some(message) = farewell {
            if let Err(e) = wire.send(&ServerMessage::Error { message }) {
                eprintln!("depsis-console: could not send the close reason: {e}");
            }
        }
        if end != End::PeerGone {
            if let Err(e) = wire.send(&ServerMessage::Exit { code }) {
                eprintln!("depsis-console: could not send exit: {e}");
            }
        }
        let _ = stream.shutdown(Shutdown::Both);

        eprintln!(
            "depsis-console: session {} closed, code {code}, reason {end:?}",
            open.session.as_str()
        );
        Ok(())
    }

    /// Pump pty output to the API until the terminal is gone.
    fn pump_output(pty: &Pty, wire: &Wire<'_>, stream: &UnixStream) {
        let mut buf = [0u8; OUT_CHUNK];
        let mut master = pty.master();
        loop {
            let read = match master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                // On Linux a pty master reports EIO, not end-of-file, once the last user-side
                // descriptor is closed. That is the normal end of a session, not a fault.
                Err(_) => break,
            };
            let Some(chunk) = buf.get(..read) else { break };
            if wire.send(&ServerMessage::out(chunk)).is_err() {
                break;
            }
        }
        // Wake the command loop. It is blocked reading the socket against a deadline measured in
        // minutes, and the shell has just exited — without this the session would sit there,
        // terminal gone, until the idle timer noticed.
        let _ = stream.shutdown(Shutdown::Read);
    }

    /// Read commands from the API until something ends the session.
    fn command_loop(
        wire: &Wire<'_>,
        stream: &UnixStream,
        pty: &Pty,
        limits: Limits,
        reader: &mut LineReader,
    ) -> End {
        let mut deadlines = Deadlines::open(limits, Instant::now());
        let mut audit = LineExtractor::new();
        let mut master = pty.master();

        loop {
            let incoming = match reader.next(stream, &deadlines) {
                Ok(incoming) => incoming,
                Err(_) => return End::PeerGone,
            };
            let line = match incoming {
                Incoming::Line(line) => line,
                // Either the API disconnected or the output pump shut the read side down
                // because the shell exited. Both mean the same thing here.
                Incoming::Eof => return End::Requested,
                Incoming::Expired(expiry) => return End::Expired(expiry),
                Incoming::TooLong => return End::Protocol("message too long".into()),
            };

            match ClientMessage::parse(&line) {
                Ok(ClientMessage::Input(bytes)) => {
                    deadlines.touch(Instant::now());
                    // Audit before the bytes reach the shell. A line that got the session killed
                    // mid-command still belongs in the record.
                    for entry in audit.feed(&bytes) {
                        if wire.send(&ServerMessage::Line { s: entry }).is_err() {
                            return End::PeerGone;
                        }
                    }
                    if master
                        .write_all(&bytes)
                        .and_then(|()| master.flush())
                        .is_err()
                    {
                        // The terminal is gone; the pump will notice too.
                        return End::Requested;
                    }
                }
                Ok(ClientMessage::Resize(size)) => {
                    if let Err(e) = pty.resize(size) {
                        eprintln!("depsis-console: resize failed: {e}");
                    }
                }
                Ok(ClientMessage::Close) => return End::Requested,
                // A second `open` on a live session. Not fatal in itself, but it means the API
                // and this service disagree about what is going on, and continuing would leave
                // the operator typing into a session the API thinks is a different one.
                Ok(ClientMessage::Open(_)) => {
                    return End::Protocol("this session is already open".into())
                }
                Err(e) => return End::Protocol(format!("{e}")),
            }
        }
    }

    // ─── line framing ─────────────────────────────────────────────────────────

    #[derive(Debug, PartialEq, Eq)]
    pub enum Incoming {
        Line(String),
        Eof,
        Expired(Expiry),
        TooLong,
    }

    /// Newline-delimited reader with the session's deadline armed on every read.
    ///
    /// `set_read_timeout` arms `SO_RCVTIMEO`, which bounds one `recv(2)` and not a session: a
    /// peer sending one byte just under the timeout re-arms the window forever. Re-arming from a
    /// deadline the peer cannot move is what turns the idle timeout into a real limit — the same
    /// correction the agent's `read_request_line_within` carries, for the same reason.
    pub struct LineReader {
        pending: Vec<u8>,
        chunk: Box<[u8; 8192]>,
    }

    impl LineReader {
        #[must_use]
        pub fn new() -> Self {
            Self {
                pending: Vec::with_capacity(4096),
                chunk: Box::new([0u8; 8192]),
            }
        }

        pub fn next(
            &mut self,
            stream: &UnixStream,
            deadlines: &Deadlines,
        ) -> std::io::Result<Incoming> {
            loop {
                if let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = self.pending.drain(..=at).collect();
                    return Ok(Incoming::Line(
                        String::from_utf8_lossy(&line).trim_end().to_string(),
                    ));
                }
                // A peer that never sends a newline is otherwise an unbounded buffer.
                if self.pending.len() > MAX_LINE_BYTES {
                    return Ok(Incoming::TooLong);
                }

                let budget = match deadlines.budget(Instant::now()) {
                    Ok(budget) => budget,
                    Err(expiry) => return Ok(Incoming::Expired(expiry)),
                };
                stream.set_read_timeout(Some(budget))?;

                let mut source = stream;
                match source.read(self.chunk.as_mut_slice()) {
                    Ok(0) => return Ok(Incoming::Eof),
                    Ok(n) => match self.chunk.get(..n) {
                        Some(data) => self.pending.extend_from_slice(data),
                        None => return Ok(Incoming::Eof),
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // The window was armed from the deadline, so a timeout here means the
                    // deadline moved closer, not that it arrived — the loop re-checks it.
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        continue
                    }
                    Err(e) => return Err(e),
                }
            }
        }
    }

    impl Default for LineReader {
        fn default() -> Self {
            Self::new()
        }
    }

    #[cfg(test)]
    #[allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        reason = "The crate-level denials exist because a panic drops a live shell. In a test \
                  the opposite is true: a failed assertion SHOULD panic."
    )]
    mod tests {
        use super::*;
        use depsis_console::protocol::{base64_decode, base64_encode};
        use std::io::BufRead as _;

        const SESSION: &str = "018f3b2a-7c4d-7e8f-9a0b-1c2d3e4f5a6b";
        const USER: &str = "018f3b2a-7c4d-7e8f-9a0b-000000000001";

        // ── socket activation ──

        #[test]
        fn the_console_socket_is_found_by_name() {
            assert_eq!(socket_offset(Some("console"), 1), Ok(0));
        }

        #[test]
        fn an_unnamed_socket_is_refused_rather_than_guessed_at() {
            let err = socket_offset(None, 1).unwrap_err();
            assert!(err.contains("LISTEN_FDNAMES unset"), "got: {err}");
        }

        #[test]
        fn a_socket_this_service_does_not_serve_is_refused() {
            assert!(socket_offset(Some("control"), 1).is_err());
            assert!(socket_offset(Some("console:control"), 2).is_err());
        }

        #[test]
        fn a_name_count_that_disagrees_with_the_descriptor_count_is_refused() {
            assert!(socket_offset(Some("console"), 2).is_err());
        }

        // ── SO_PEERCRED ──

        #[test]
        fn peer_credentials_come_from_the_kernel_not_the_wire() {
            // A real socketpair, not a mock: the point of the check is that it reads something
            // the peer cannot write.
            let (a, _b) = UnixStream::pair().unwrap();
            let peer = peer_of(&a).unwrap();
            assert_eq!(peer.uid, rustix::process::geteuid().as_raw());
            assert_eq!(peer.pid, std::process::id() as i32);
            assert_eq!(peer_is_api(peer, peer.uid), Ok(()));
        }

        #[test]
        fn a_caller_that_is_not_the_api_is_refused() {
            let stranger = PeerIdentity { uid: 1000, pid: 42 };
            assert!(peer_is_api(stranger, 991).is_err());
        }

        #[test]
        fn root_is_refused_by_name_so_sessions_stay_attributable() {
            let root = PeerIdentity { uid: 0, pid: 42 };
            let err = peer_is_api(root, 991).unwrap_err();
            assert!(err.contains("root"), "got: {err}");
        }

        // ── framing ──

        fn forever() -> Deadlines {
            Deadlines::open(
                Limits {
                    idle_timeout: Duration::from_secs(60),
                    max_age: Duration::from_secs(60),
                },
                Instant::now(),
            )
        }

        #[test]
        fn lines_are_reassembled_across_reads_and_split_out_of_one() {
            let (mine, theirs) = UnixStream::pair().unwrap();
            let mut writer = &theirs;
            writer.write_all(b"{\"t\":\"clo").unwrap();
            writer.write_all(b"se\"}\n{\"t\":\"close\"}\n").unwrap();

            let mut reader = LineReader::new();
            let deadlines = forever();
            assert_eq!(
                reader.next(&mine, &deadlines).unwrap(),
                Incoming::Line("{\"t\":\"close\"}".into())
            );
            assert_eq!(
                reader.next(&mine, &deadlines).unwrap(),
                Incoming::Line("{\"t\":\"close\"}".into())
            );
        }

        #[test]
        fn a_closed_peer_reads_as_end_of_file() {
            let (mine, theirs) = UnixStream::pair().unwrap();
            drop(theirs);
            let mut reader = LineReader::new();
            assert_eq!(reader.next(&mine, &forever()).unwrap(), Incoming::Eof);
        }

        #[test]
        fn the_deadline_is_not_re_armed_by_a_peer_that_dribbles() {
            // The bug this reader exists to avoid: with a plain SO_RCVTIMEO, a byte sent just
            // inside every window keeps a session alive forever.
            let (mine, theirs) = UnixStream::pair().unwrap();
            let limits = Limits {
                idle_timeout: Duration::from_millis(600),
                max_age: Duration::from_secs(60),
            };
            let deadlines = Deadlines::open(limits, Instant::now());

            let dribbler = std::thread::spawn(move || {
                let mut writer = &theirs;
                for _ in 0..10 {
                    if writer.write_all(b"x").is_err() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            });

            let started = Instant::now();
            let mut reader = LineReader::new();
            assert_eq!(
                reader.next(&mine, &deadlines).unwrap(),
                Incoming::Expired(Expiry::Idle)
            );
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the dribbler pushed the deadline back"
            );
            let _ = dribbler.join();
        }

        // ── a whole session, against a real shell ──

        fn test_config(limits: Limits) -> Option<Config> {
            Some(Config {
                limits,
                // Not `privilege_from`: these tests run as root in the development WSL image,
                // and what is under test is the session, not the unit's configuration.
                privileged: false,
                shell: find_shell()?,
                home: Some(OsString::from("/tmp")),
            })
        }

        fn open_line(cols: u16, rows: u16) -> String {
            format!(
                "{{\"t\":\"open\",\"cols\":{cols},\"rows\":{rows},\"session\":\"{SESSION}\",\
                 \"user\":\"{USER}\",\"privileged\":false}}\n"
            )
        }

        /// What the API has seen so far: every message as it arrived, plus the terminal text
        /// rebuilt from the `out` payloads.
        ///
        /// The rebuilt text is the point. Matching a base64 SUBSTRING against a `d` field only
        /// works when the needle happens to start on a three-byte boundary of the chunk it
        /// landed in, so such a test passes or hangs depending on how the scheduler split the
        /// shell's output — and a test that waits for luck spends its whole timeout doing it.
        #[derive(Debug, Default)]
        struct Seen {
            raw: Vec<String>,
            screen: String,
        }

        impl Seen {
            fn has(&self, needle: &str) -> bool {
                self.raw.iter().any(|l| l.contains(needle))
            }
            fn audited(&self) -> Vec<&String> {
                self.raw
                    .iter()
                    .filter(|l| l.contains("\"t\":\"line\""))
                    .collect()
            }
        }

        /// Read server messages until `done` is satisfied, or the clock runs out.
        fn until(
            lines: &mut std::io::Lines<std::io::BufReader<UnixStream>>,
            budget: Duration,
            mut done: impl FnMut(&Seen) -> bool,
        ) -> Seen {
            let deadline = Instant::now() + budget;
            let mut seen = Seen::default();
            while Instant::now() < deadline {
                let Some(Ok(line)) = lines.next() else { break };
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if value.get("t").and_then(serde_json::Value::as_str) == Some("out") {
                        let payload = value.get("d").and_then(serde_json::Value::as_str);
                        if let Some(bytes) = payload.and_then(|d| base64_decode(d).ok()) {
                            seen.screen.push_str(&String::from_utf8_lossy(&bytes));
                        }
                    }
                }
                seen.raw.push(line);
                if done(&seen) {
                    return seen;
                }
            }
            seen
        }

        #[test]
        fn a_session_runs_a_command_and_audits_the_line_that_ran_it() {
            let Some(config) = test_config(Limits::default()) else {
                eprintln!("skipped: no /bin/sh on this box");
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer.write_all(open_line(80, 24).as_bytes()).unwrap();
            writer
                .write_all(
                    format!(
                        "{{\"t\":\"in\",\"d\":\"{}\"}}\n",
                        base64_encode(b"echo merhaba\n")
                    )
                    .as_bytes(),
                )
                .unwrap();

            api.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();

            // Twice: the terminal echoes the keystrokes, then `echo` prints its argument.
            let seen = until(&mut lines, Duration::from_secs(20), |s| {
                s.screen.matches("merhaba").count() >= 2
            });
            assert!(
                seen.raw
                    .first()
                    .is_some_and(|l| l.contains("\"t\":\"ready\"")),
                "the first message must be ready, got {:?}",
                seen.raw.first()
            );
            assert!(
                seen.raw
                    .iter()
                    .any(|l| l == "{\"t\":\"line\",\"s\":\"echo merhaba\"}"),
                "the typed line must be audited, saw {seen:#?}"
            );
            assert!(
                seen.screen.contains("merhaba"),
                "no terminal output arrived, saw {seen:#?}"
            );

            writer.write_all(b"{\"t\":\"close\"}\n").unwrap();
            let tail = until(&mut lines, Duration::from_secs(20), |s| {
                s.has("\"t\":\"exit\"")
            });
            assert!(tail.has("\"t\":\"exit\""), "no exit message, saw {tail:#?}");
            let _ = session.join();
        }

        #[test]
        fn output_never_carries_the_audit_of_itself() {
            // `line` messages must only ever come from input. If output were audited, the echo
            // of every keystroke would double every command in `console_commands` — and a
            // `cat` of a secret would land in the audit table, which ADR-0018 forbids.
            let Some(config) = test_config(Limits::default()) else {
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer.write_all(open_line(80, 24).as_bytes()).unwrap();
            writer
                .write_all(
                    format!(
                        "{{\"t\":\"in\",\"d\":\"{}\"}}\n",
                        base64_encode(b"echo sirdir\n")
                    )
                    .as_bytes(),
                )
                .unwrap();
            api.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();
            let seen = until(&mut lines, Duration::from_secs(20), |s| {
                s.screen.matches("sirdir").count() >= 2
            });

            let audited = seen.audited();
            assert_eq!(
                audited.len(),
                1,
                "exactly one line should be audited, saw {seen:#?}"
            );

            writer.write_all(b"{\"t\":\"close\"}\n").unwrap();
            let _ = session.join();
        }

        #[test]
        fn an_idle_session_is_closed_and_says_why() {
            let Some(config) = test_config(Limits {
                idle_timeout: Duration::from_secs(1),
                max_age: Duration::from_secs(60),
            }) else {
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer.write_all(open_line(80, 24).as_bytes()).unwrap();
            api.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();

            let seen = until(&mut lines, Duration::from_secs(20), |s| {
                s.has("\"t\":\"exit\"")
            });
            assert!(
                seen.raw
                    .iter()
                    .any(|l| l == "{\"t\":\"error\",\"message\":\"idle\"}"),
                "the close reason must reach the API, saw {seen:#?}"
            );
            assert!(seen.has("\"t\":\"exit\""), "saw {seen:#?}");
            let _ = session.join();
        }

        #[test]
        fn the_shell_exiting_ends_the_session_without_waiting_for_a_timeout() {
            let Some(config) = test_config(Limits::default()) else {
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer.write_all(open_line(80, 24).as_bytes()).unwrap();
            writer
                .write_all(
                    format!(
                        "{{\"t\":\"in\",\"d\":\"{}\"}}\n",
                        base64_encode(b"exit 7\n")
                    )
                    .as_bytes(),
                )
                .unwrap();
            api.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();

            let started = Instant::now();
            let seen = until(&mut lines, Duration::from_secs(20), |s| {
                s.has("\"t\":\"exit\"")
            });
            assert!(
                seen.has("\"code\":7"),
                "the shell's exit code must reach the API, saw {seen:#?}"
            );
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the session waited for the idle timer instead of noticing the shell"
            );
            let _ = session.join();
        }

        #[test]
        fn stty_inside_a_session_reports_the_geometry_the_api_asked_for() {
            // The end-to-end version of the pty test: if the geometry did not survive the
            // protocol, every full-screen program in the browser terminal would draw wrong.
            let Some(config) = test_config(Limits::default()) else {
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer.write_all(open_line(132, 43).as_bytes()).unwrap();
            writer
                .write_all(
                    format!(
                        "{{\"t\":\"in\",\"d\":\"{}\"}}\n",
                        base64_encode(b"stty size\n")
                    )
                    .as_bytes(),
                )
                .unwrap();
            api.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();

            let seen = until(&mut lines, Duration::from_secs(20), |s| {
                s.screen.contains("43 132")
            });
            assert!(
                seen.screen.contains("43 132"),
                "stty size did not report 43 132, saw {seen:#?}"
            );

            writer.write_all(b"{\"t\":\"close\"}\n").unwrap();
            let _ = session.join();
        }

        #[test]
        fn the_first_message_must_be_open() {
            let Some(config) = test_config(Limits::default()) else {
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer
                .write_all(b"{\"t\":\"in\",\"d\":\"aGk=\"}\n")
                .unwrap();
            api.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();
            let first = lines.next().unwrap().unwrap();
            assert!(first.contains("\"t\":\"error\""), "got {first}");
            assert!(session.join().unwrap().is_err());
        }

        #[test]
        fn a_privileged_console_is_not_faked_when_the_unit_did_not_ask_for_one() {
            let Some(config) = test_config(Limits::default()) else {
                return;
            };
            let (api, service) = UnixStream::pair().unwrap();
            let session = std::thread::spawn(move || serve_connection(&service, &config));

            let mut writer = &api;
            writer
                .write_all(
                    format!(
                        "{{\"t\":\"open\",\"cols\":80,\"rows\":24,\"session\":\"{SESSION}\",\
                         \"user\":\"{USER}\",\"privileged\":true}}\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
            api.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut lines = std::io::BufReader::new(api.try_clone().unwrap()).lines();
            let first = lines.next().unwrap().unwrap();
            assert!(
                first.contains("not privileged"),
                "a root shell must not be silently downgraded, got {first}"
            );
            assert!(session.join().unwrap().is_err());
        }
    }
}
