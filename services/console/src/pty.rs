//! A real pseudo-terminal, opened without a line of `unsafe`.
//!
//! `rustix::pty` covers `posix_openpt`/`grantpt`/`unlockpt` and Linux's `TIOCGPTPEER`, all of
//! them safe wrappers, and the user side comes back as an `OwnedFd` that `Stdio::from` accepts
//! directly. So a genuine terminal — line editing, `top`, `vim`, colour — is reachable from a
//! crate that forbids `unsafe_code` outright.
//!
//! # What this pty CANNOT do, and why
//!
//! There is no controlling terminal. Making the child's pty its controlling terminal means
//! `setsid()` plus `ioctl(TIOCSCTTY)` between fork and exec, and the only hook `std` offers
//! there is `CommandExt::pre_exec`, which is `unsafe` — it runs in a forked child where only
//! async-signal-safe calls are legal, and this crate does not take that exception.
//!
//! The consequence is concrete and the operator will meet it:
//!
//!   * Job control does not work. `Ctrl-Z`, `fg`, `bg` and `jobs` will not behave; bash prints
//!     "no job control in this shell" at startup for exactly this reason.
//!   * `Ctrl-C` still works, because the tty's line discipline sends SIGINT to the foreground
//!     process group and [`Pty::open`] puts the shell in its own group — but signals are
//!     delivered to that whole group rather than to a foreground job within it.
//!   * `/dev/tty` does not resolve inside the session, so the handful of programs that open it
//!     directly (some password prompts, `ssh` asking for a passphrase) will fail rather than
//!     prompt.
//!
//! Everything else about the terminal is real: `stty size` reports the true geometry, SIGWINCH
//! arrives on resize, and readline edits lines.
//!
//! Getting job control back is a small, self-contained change — a `pre_exec` closure calling
//! `setsid` and `TIOCSCTTY`, or a tiny helper binary that does it before exec'ing the shell —
//! and it should be a deliberate decision, not something that arrives by accident.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use rustix::pty::OpenptFlags;
use rustix::termios::Winsize;

use crate::protocol::TermSize;

/// Login shells, in the order they are tried.
///
/// A fixed list, not a configurable string. The shell is the one thing in this service that
/// executes, and an environment variable naming an arbitrary program would be a general-purpose
/// exec primitive wearing a configuration key's clothes.
const SHELLS: [&str; 2] = ["/bin/bash", "/bin/sh"];

/// How long a shell gets between the hangup and the kill.
///
/// Long enough for bash to write its history file, short enough that closing a browser tab does
/// not feel like it hung.
const GRACE: std::time::Duration = std::time::Duration::from_millis(300);

/// The first shell on this box, or nothing.
///
/// Nothing is a legitimate answer — a container image without a shell should produce "console
/// unavailable", which the API turns into 503, rather than a spawn failure at the moment a user
/// clicks Open.
#[must_use]
pub fn find_shell() -> Option<PathBuf> {
    SHELLS
        .iter()
        .map(Path::new)
        .find(|p| p.is_file())
        .map(Path::to_path_buf)
}

/// A pty with a shell running in it.
pub struct Pty {
    /// The controlling side. Reading it yields whatever the shell printed; writing to it is
    /// keyboard input.
    master: File,
    child: Child,
    /// Set by [`Pty::wait`]. What [`Drop`] checks so a normal ending pays nothing extra.
    reaped: bool,
}

impl Pty {
    /// Open a terminal and start `shell` inside it.
    pub fn open(shell: &Path, size: TermSize, home: Option<&OsStr>) -> io::Result<Self> {
        let master =
            rustix::pty::openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC)?;
        // A no-op on Linux (the kernel has already granted access), kept because leaving it out
        // is the kind of omission that only shows up on the one platform that needs it.
        rustix::pty::grantpt(&master)?;
        rustix::pty::unlockpt(&master)?;

        // Geometry BEFORE the shell starts. Setting it afterwards means the shell's first prompt
        // is drawn for an 80x24 terminal that is not the user's, and readline gets the wrap point
        // wrong until the first resize.
        rustix::termios::tcsetwinsize(&master, winsize(size))?;

        let slave = open_user_side(&master)?;
        // Three descriptors because `Stdio::from` consumes one each. All three are moved into the
        // child's stdio below, which is what leaves the parent holding NO copy of the user side —
        // and that is what lets a read on the master report end-of-file when the shell exits. A
        // stray copy here would hang the reader thread forever instead.
        let stdin = slave.try_clone()?;
        let stdout = slave.try_clone()?;
        let stderr = slave;

        let mut cmd = Command::new(shell);
        cmd.arg("-l");
        cmd.stdin(Stdio::from(stdin));
        cmd.stdout(Stdio::from(stdout));
        cmd.stderr(Stdio::from(stderr));

        // Inherit nothing. Even unprivileged, a shell that inherits this service's environment
        // inherits LISTEN_FDS, DEPSIS_API_UID and whatever else systemd put there, and the first
        // of those makes a child think it was socket-activated.
        cmd.env_clear();
        cmd.env(
            "PATH",
            "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
        );
        // xterm.js is what renders this (ADR-0018), and it speaks 256 colours.
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", "C.UTF-8");
        cmd.env("SHELL", shell);
        if let Some(home) = home {
            cmd.env("HOME", home);
        }

        // Its own process group, so the tty's line discipline has a foreground group to signal
        // and so terminating the session can take background jobs with it. This is NOT a
        // controlling terminal — see the module comment for what that costs.
        cmd.process_group(0);

        let child = cmd.spawn()?;

        Ok(Self {
            master: File::from(master),
            child,
            reaped: false,
        })
    }

    #[must_use]
    pub fn pid(&self) -> i32 {
        // `Child::id` is a u32 that came from a pid; the cast back cannot lose anything real.
        i32::try_from(self.child.id()).unwrap_or(-1)
    }

    /// The master side, for reading output and writing input. `File` implements `Read` and
    /// `Write` through `&File`, so two threads can share it without a lock.
    #[must_use]
    pub fn master(&self) -> &File {
        &self.master
    }

    pub fn resize(&self, size: TermSize) -> io::Result<()> {
        // On the master. The kernel propagates it to the user side and raises SIGWINCH there,
        // which is what makes `stty size` and full-screen programs agree with the browser.
        rustix::termios::tcsetwinsize(&self.master, winsize(size))?;
        Ok(())
    }

    /// End the session: signal the whole process group, not just the shell.
    ///
    /// `sleep 900 &` holds the user side of the pty open after bash is gone, and a master read
    /// blocked on a descriptor a background job still owns never returns. Signalling the group
    /// is what makes "the session is over" true for everything the session started.
    pub fn terminate(&self) {
        let Some(pid) = rustix::process::Pid::from_raw(self.pid()) else {
            return;
        };
        // SIGHUP, not SIGTERM: "the terminal went away" is exactly what happened, it is the
        // signal a shell has a handler for, and bash runs its EXIT trap and writes its history
        // on it. A grace period, then SIGKILL — because the point of a timeout is that it
        // completes, and a process that ignores a hangup is the case the timeout exists for.
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::HUP);
        std::thread::sleep(GRACE);
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }

    /// Reap the shell and report its exit status the way a shell would.
    pub fn wait(&mut self) -> io::Result<i32> {
        // Before the call, not after: whether it succeeds or fails with ECHILD, this `Pty` has
        // had its chance to reap and `Drop` has nothing left to do.
        self.reaped = true;
        let status = self.child.wait()?;
        Ok(match (status.code(), status.signal()) {
            (Some(code), _) => code,
            // The convention every shell uses for "killed by a signal", so the number the API
            // stores means the same thing as `$?` would have.
            (None, Some(signal)) => 128 + signal,
            (None, None) => -1,
        })
    }
}

/// Nothing this struct owns outlives it — including the shell.
///
/// Dropping the `File` closes the master, and closing the master usually makes `bash -l` exit on
/// EIO. Usually is not a guarantee, and it says nothing at all about what the session STARTED:
/// `sleep 900 &` holds the user side open and keeps running, unsignalled, which is the exact case
/// [`Pty::terminate`] exists for. In a long-lived daemon that is one zombie per occurrence, held
/// against `TasksMax=` for as long as the service runs.
///
/// The path this closes is not exotic. `run_session` opens the pty and then sends `ready`; if the
/// API has already hung up — its own `ready` deadline is shorter than this service's handshake
/// window, so a loaded box reaches this — the send fails with EPIPE and the function returns
/// early, past the `terminate()`/`wait()` that every other ending goes through.
///
/// A normal ending calls [`Pty::wait`] and pays nothing here.
impl Drop for Pty {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        self.terminate();
        let _ = self.child.wait();
    }
}

fn winsize(size: TermSize) -> Winsize {
    Winsize {
        ws_row: size.rows(),
        ws_col: size.cols(),
        // Pixel dimensions are advisory and nothing in a browser terminal reads them.
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

/// Open the user side of the pty.
///
/// `TIOCGPTPEER` first: it derives the descriptor from the master with no path involved, so
/// there is no window in which the `/dev/pts/N` entry could be replaced, and it works when
/// `/dev/pts` is not where this process expects it. It needs Linux 4.13 and a `devpts` mounted
/// without `newinstance`; where either is missing the kernel says `EINVAL`/`ENOTTY` and the
/// `ptsname` path below is the portable answer.
///
/// `CLOEXEC` on both paths, and it is not decoration. This service runs several sessions in one
/// process, so session B's shell is being `fork`/`exec`ed while session A's user-side descriptor
/// exists. Without close-on-exec, B's shell inherits A's terminal — and then A's master never
/// reports end-of-file when A's own shell exits, because a stranger is still holding the other
/// end open. The session hangs until the unrelated shell happens to die. Measured: the two
/// end-to-end tests in `main.rs` failed exactly this way when run in parallel, and passed alone.
fn open_user_side(master: &rustix::fd::OwnedFd) -> io::Result<rustix::fd::OwnedFd> {
    match rustix::pty::ioctl_tiocgptpeer(
        master,
        OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC,
    ) {
        Ok(fd) => return Ok(fd),
        Err(rustix::io::Errno::INVAL | rustix::io::Errno::NOTTY | rustix::io::Errno::NOSYS) => {}
        Err(e) => return Err(e.into()),
    }

    let name = rustix::pty::ptsname(master, Vec::new())?;
    let fd = rustix::fs::open(
        name.as_c_str(),
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOCTTY | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )?;
    Ok(fd)
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
    use std::io::{Read as _, Write as _};
    use std::time::{Duration, Instant};

    /// Read from the pty until `needle` shows up or the clock runs out.
    ///
    /// A fixed number of reads would be a flaky test: a shell's startup output arrives in
    /// however many chunks the scheduler feels like.
    fn read_until(pty: &Pty, needle: &str, budget: Duration) -> String {
        let deadline = Instant::now() + budget;
        let mut seen = String::new();
        let mut buf = [0u8; 4096];
        let mut master = pty.master();
        while Instant::now() < deadline {
            match master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if seen.contains(needle) {
                        return seen;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        seen
    }

    fn open_test_pty(cols: u16, rows: u16) -> Pty {
        let shell = find_shell().expect("a test box without /bin/sh cannot run this crate");
        Pty::open(
            &shell,
            TermSize::new(cols, rows).unwrap(),
            Some(OsStr::new("/tmp")),
        )
        .expect("open a pty")
    }

    #[test]
    fn a_shell_runs_in_the_pty_and_its_output_comes_back() {
        let mut pty = open_test_pty(80, 24);
        assert!(pty.pid() > 0);

        let mut master = pty.master();
        master.write_all(b"echo merhaba\n").unwrap();
        master.flush().unwrap();

        let seen = read_until(&pty, "merhaba", Duration::from_secs(10));
        assert!(seen.contains("merhaba"), "pty produced: {seen:?}");

        master.write_all(b"exit 3\n").unwrap();
        master.flush().unwrap();
        assert_eq!(pty.wait().unwrap(), 3, "the shell's exit code must survive");
    }

    #[test]
    fn stty_reports_the_geometry_it_was_opened_with() {
        // If this fails the thing on the other end is a pipe wearing a terminal's name, and
        // every full-screen program in it would draw at the wrong size.
        let mut pty = open_test_pty(132, 43);
        let mut master = pty.master();
        master.write_all(b"stty size\n").unwrap();
        master.flush().unwrap();

        let seen = read_until(&pty, "43 132", Duration::from_secs(10));
        assert!(seen.contains("43 132"), "stty size said: {seen:?}");

        pty.terminate();
        let _ = pty.wait();
    }

    #[test]
    fn a_resize_reaches_the_shell() {
        let mut pty = open_test_pty(80, 24);
        let mut master = pty.master();

        pty.resize(TermSize::new(120, 40).unwrap()).unwrap();
        master.write_all(b"stty size\n").unwrap();
        master.flush().unwrap();

        let seen = read_until(&pty, "40 120", Duration::from_secs(10));
        assert!(seen.contains("40 120"), "stty size said: {seen:?}");

        pty.terminate();
        let _ = pty.wait();
    }

    #[test]
    fn dropping_a_pty_nobody_waited_on_takes_the_session_with_it() {
        // The regression this guards. `run_session` sends `ready` immediately after opening the
        // pty, and on a loaded box the API's own 5 s deadline can expire first — the send then
        // fails with EPIPE and the function returns early, past the `terminate()`/`wait()` that
        // every other ending goes through. In a daemon that is one unsignalled process group and
        // one unreaped shell per occurrence, forever.
        //
        // Deliberately NO `terminate()` and NO `wait()` anywhere below: the drop is the subject.
        let background = {
            let pty = open_test_pty(80, 24);
            {
                let mut master = pty.master();
                // The needle is split across two string literals so that the terminal's echo of
                // the command does not contain it — `read_until` stops at the first match, and
                // the echo arrives before the answer.
                master
                    .write_all(b"sleep 300 &\necho \"JO\"\"B=$!\"\n")
                    .unwrap();
                master.flush().unwrap();
            }
            let seen = read_until(&pty, "JOB=", Duration::from_secs(10));
            // Not line-oriented: bash's bracketed-paste escapes share a line with the answer, so
            // the digits are taken from immediately after the marker wherever it lands.
            let digits: String = seen
                .rsplit("JOB=")
                .next()
                .unwrap_or_default()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            let pid = digits
                .parse::<i32>()
                .unwrap_or_else(|_| panic!("the shell did not report a background pid: {seen:?}"));
            assert!(
                Path::new(&format!("/proc/{pid}")).exists(),
                "the background job should be running before the pty is dropped"
            );
            pid
        };

        // Gone, not merely orphaned. SIGKILL to the group is what ends it, and its new parent
        // (pid 1) reaps it — so the /proc entry disappears rather than turning into a zombie.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Path::new(&format!("/proc/{background}")).exists() {
            assert!(
                Instant::now() < deadline,
                "the background job outlived the pty that started it"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn terminate_takes_background_jobs_with_it() {
        // The reason `terminate` signals the group. With a plain `kill(pid)` the sleep below
        // keeps the user side of the pty open and the read never ends.
        let mut pty = open_test_pty(80, 24);
        {
            let mut master = pty.master();
            master.write_all(b"sleep 300 &\necho started\n").unwrap();
            master.flush().unwrap();
        }
        let seen = read_until(&pty, "started", Duration::from_secs(10));
        assert!(seen.contains("started"), "pty produced: {seen:?}");

        pty.terminate();
        let _ = pty.wait();

        // With the whole group gone, the master reports end-of-file. Linux surfaces that as
        // EIO once the last user-side descriptor is closed.
        let mut master = pty.master();
        let mut buf = [0u8; 1024];
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(
                Instant::now() < deadline,
                "master never reached end-of-file"
            );
            match master.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => continue,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break, // EIO — the expected end for a pty master
            }
        }
    }
}
