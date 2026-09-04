//! A real pseudo-terminal, opened without a line of `unsafe`.
//!
//! `rustix::pty` covers `posix_openpt`/`grantpt`/`unlockpt` and Linux's `TIOCGPTPEER`, all of
//! them safe wrappers, and the user side comes back as an `OwnedFd` that `Stdio::from` accepts
//! directly. So a genuine terminal — line editing, `top`, `vim`, colour — is reachable from a
//! crate that forbids `unsafe_code` outright.
//!
//! # The controlling terminal, and why it arrives through `setsid(1)`
//!
//! A pty nobody claimed is a terminal in appearance only. The kernel's line discipline sends
//! SIGINT to `tty->ctrl.pgrp`, and a resize sends SIGWINCH to that same field; the field is
//! filled in by `TIOCSCTTY` and by nothing else. So on an unclaimed pty `Ctrl-C` is echoed as
//! `^C` and signals no one — a `ping` or a `tail -f` opened in the browser console could not be
//! stopped at all, only escaped by closing the tab — and a full-screen program never learns the
//! window changed size. `/dev/tty` does not resolve either.
//!
//! Claiming it means `setsid()` plus `ioctl(TIOCSCTTY)` BETWEEN fork and exec, and the only hook
//! `std` offers there is `CommandExt::pre_exec`, which is `unsafe`. This crate is
//! `forbid(unsafe_code)`, so the two syscalls are made by a program that exists for exactly this:
//! `setsid -c`, exec'ed in front of the shell.
//!
//! One detail makes that safe to rely on. `setsid(1)` forks when it finds itself a process group
//! leader, and the pid this struct holds would then belong to a process that exits immediately.
//! It does not fork here, because [`Pty::open`] deliberately does NOT call `process_group(0)`:
//! the child inherits this service's group, its own fresh pid therefore differs from that group's
//! id, and `setsid(1)` calls `setsid()` in place and `exec`s. [`Pty::pid`] stays the shell's pid,
//! and that pid is now also the session id.
//!
//! Where no `setsid` is installed the console still opens, without a controlling terminal — a
//! shell that cannot be interrupted is worth more than no shell — and the operator is told once
//! at startup. [`find_setsid`] is what the binary asks.
//!
//! # What that costs [`Pty::terminate`]
//!
//! Job control is the point of a controlling terminal, and job control puts every job in a
//! process group of its OWN. `kill_process_group(shell)` then names a group holding the shell
//! alone, and `sleep 900 &` survives it — still holding the user side of the pty open, which is
//! what makes a read on the master block forever. The session is the unit that still contains
//! everything the console started, so [`Pty::terminate`] signals the shell's group AND every
//! process the kernel reports in the shell's session.

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

/// Where `setsid(1)` lives. util-linux installs it under `/usr/bin`, busybox links it from
/// `/bin`; a fixed list for the same reason as [`SHELLS`], since this is the second and last
/// program the service execs.
const SETSIDS: [&str; 2] = ["/usr/bin/setsid", "/bin/setsid"];

/// Where the kernel publishes the session of every process.
const PROC: &str = "/proc";

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

/// The `setsid(1)` on this box, or nothing.
///
/// Nothing is survivable — the shell still starts, just without a controlling terminal — but it
/// changes what the console can do, so the binary asks once at startup and says so in the
/// journal instead of leaving the operator to discover that Ctrl-C does nothing.
#[must_use]
pub fn find_setsid() -> Option<PathBuf> {
    SETSIDS
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

        // `setsid -c <shell>` rather than the shell directly: those two syscalls between fork and
        // exec are what give the pty a controlling terminal, and without one Ctrl-C and SIGWINCH
        // reach nobody. See the module comment for why it is an exec and not a `pre_exec`.
        //
        // The short flag, not `--ctty`: busybox's setsid understands `-c` and no long options,
        // and an appliance image may well ship busybox rather than util-linux. The `--` is what
        // keeps the shell's own `-l` from being read as a flag OF setsid by an option parser that
        // permutes its arguments.
        let mut cmd = match find_setsid() {
            Some(setsid) => {
                let mut cmd = Command::new(setsid);
                cmd.arg("-c");
                cmd.arg("--");
                cmd.arg(shell);
                cmd
            }
            // No setsid anywhere. The console opens without job control — bash will announce
            // that itself — and the shell gets its own process group, because that group is then
            // the only thing `terminate` has to signal.
            None => {
                let mut cmd = Command::new(shell);
                cmd.process_group(0);
                cmd
            }
        };
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

        // NOTHING sets the process group here, and that omission is load-bearing on the setsid
        // path: `setsid(1)` forks when it is already a group leader, and the pid returned by
        // `spawn` would then name a process that exits at once — leaving `wait` with setsid's
        // status instead of the shell's and `terminate` signalling an empty session.
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
        // On the master. The kernel propagates it to the user side and raises SIGWINCH on the
        // terminal's foreground process group, which is what makes `stty size` and full-screen
        // programs agree with the browser. The signal half only happens because the shell claimed
        // this pty as its controlling terminal; the ioctl alone updates a number nobody is told
        // about.
        rustix::termios::tcsetwinsize(&self.master, winsize(size))?;
        Ok(())
    }

    /// End the session: signal everything it started, not just the shell.
    ///
    /// `sleep 900 &` holds the user side of the pty open after bash is gone, and a master read
    /// blocked on a descriptor a background job still owns never returns. Reaching that job takes
    /// both halves of [`signal_session`], because the shell can be in either shape: with a
    /// controlling terminal job control has moved the job into a group of its own and only the
    /// SESSION still contains it, and without one there is no session to enumerate and the
    /// shell's own group is the whole of it.
    pub fn terminate(&self) {
        // SIGHUP, not SIGTERM: "the terminal went away" is exactly what happened, it is the
        // signal a shell has a handler for, and bash runs its EXIT trap and writes its history
        // on it. A grace period, then SIGKILL — because the point of a timeout is that it
        // completes, and a process that ignores a hangup is the case the timeout exists for.
        signal_session(self.pid(), rustix::process::Signal::HUP);
        std::thread::sleep(GRACE);
        signal_session(self.pid(), rustix::process::Signal::KILL);
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

/// Signal the shell's process group and everything else in the shell's session.
///
/// Both, deliberately. The group covers the no-controlling-terminal fallback, where the session
/// belongs to this service and enumerating it would sweep the console itself. The session covers
/// the normal path, where job control has scattered the shell's jobs across process groups the
/// shell's pid does not name.
fn signal_session(shell: i32, signal: rustix::process::Signal) {
    let Some(pid) = rustix::process::Pid::from_raw(shell) else {
        return;
    };
    let _ = rustix::process::kill_process_group(pid, signal);
    for member in session_members(Path::new(PROC), shell) {
        // The leader is already covered by its own group above.
        if member == shell {
            continue;
        }
        if let Some(member) = rustix::process::Pid::from_raw(member) {
            let _ = rustix::process::kill_process(member, signal);
        }
    }
}

/// Every pid the kernel reports as belonging to session `sid`.
///
/// A directory walk, not a shell out to `ps`: this crate execs a shell for the user and nothing
/// else, and /proc is the kernel's own word. A process that ends mid-walk gives ENOENT on its
/// `stat`, which is not an error but the normal life of the file — the list is a snapshot either
/// way, which is why [`Pty::terminate`] takes a fresh one before the SIGKILL pass.
fn session_members(proc_root: &Path, sid: i32) -> Vec<i32> {
    let mut members = Vec::new();
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return members;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue; // /proc/self, /proc/meminfo and the rest
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if stat_session(&stat) == Some(sid) {
            members.push(pid);
        }
    }
    members
}

/// The session id out of a `/proc/<pid>/stat` line.
///
/// Split on the LAST `)`, never on spaces from the front: field 2 is the executable's name
/// unescaped, so a process called `sh (old)` shifts every field after it and a naive split would
/// read somebody else's number as a session id and then signal it.
fn stat_session(stat: &str) -> Option<i32> {
    // After the comm the fields are: state, ppid, pgrp, session.
    let after_comm = stat.rsplit_once(')')?.1;
    after_comm.split_whitespace().nth(3)?.parse().ok()
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
    /// Bir dizge görünene kadar oku, ama SÜRENİN İÇİNDE.
    ///
    /// SÜRE GERÇEKTEN UYGULANIYOR. Bu döngü bitiş anını yalnız okumaların ARASINDA sınıyordu ve
    /// bir pty ustası bloke okur: kabuk hiç bayt yollamazsa `read` geri dönmez, bitiş anı bir daha
    /// hiç sınanmaz ve testin bütçesi kâğıt üstünde kalır. CI'da bir kez oldu — 45 testin hepsi
    /// `ok` yazdı, süit özetini hiç basmadı, ikili çıkmadı ve `cargo` kırk dakika bekledikten
    /// sonra iş elle iptal edildi. Kabuğun beklenen çıktıyı vermemesi bir test BAŞARISIZLIĞI
    /// olmalı; bütün koşuyu durduran bir asılma değil.
    ///
    /// Bekçi, süre dolduğunda oturumu öldürüyor: usta o an EOF döndüğü için bloke okuma çözülüyor
    /// ve döngü elindeki çıktıyla bitiyor — çağıran da onu iddiasında gösteriyor. `poll` yerine bu
    /// seçildi çünkü tek gereken şey `std` ve modülün kendi `signal_session`ı; testin okuduğu tek
    /// bir bayt da kaybolmuyor.
    fn read_until(pty: &Pty, needle: &str, budget: Duration) -> String {
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watch = std::sync::Arc::clone(&done);
        let pid = pty.pid();
        let deadline = Instant::now() + budget;
        let watchdog = std::thread::spawn(move || {
            while Instant::now() < deadline {
                if watch.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            if !watch.load(std::sync::atomic::Ordering::Relaxed) {
                signal_session(pid, rustix::process::Signal::KILL);
            }
        });

        let mut seen = String::new();
        let mut buf = [0u8; 4096];
        let mut master = pty.master();
        while Instant::now() < deadline {
            match master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if seen.contains(needle) {
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = watchdog.join();
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

    /// True when this box can have a controlling terminal at all.
    ///
    /// Not a quiet pass: without `setsid` the kernel genuinely cannot deliver these signals, and
    /// saying so beats a green tick that means nothing. Every ordinary Linux has it, so the two
    /// tests below do assert for real everywhere it matters.
    fn ctty_or_skip() -> bool {
        if find_setsid().is_some() {
            return true;
        }
        eprintln!("skipped: no setsid on this box, so the pty has no controlling terminal");
        false
    }

    #[test]
    fn ctrl_c_interrupts_a_running_command() {
        // The defect this guards. With no controlling terminal the line discipline has no
        // foreground process group to signal: `\x03` is echoed as ^C, `sleep` runs to the end,
        // and the `echo` typed after it is not read for another 30 s — far past the budget here.
        // The administrator's only escape was closing the browser tab, which killed the shell.
        if !ctty_or_skip() {
            return;
        }
        let mut pty = open_test_pty(80, 24);
        let mut master = pty.master();

        master.write_all(b"sleep 30\n").unwrap();
        master.flush().unwrap();
        // The shell must have reached `sleep` first: an interrupt that arrives while bash is
        // still reading the line only cancels the line, which would pass for the wrong reason.
        std::thread::sleep(Duration::from_millis(700));

        master.write_all(b"\x03").unwrap();
        master.flush().unwrap();
        // SIGINT flushes the terminal's input queue, so the next command goes in after the shell
        // has taken the interrupt rather than in the same write.
        std::thread::sleep(Duration::from_millis(300));

        // The needle is split across two literals so the terminal's echo of the command does not
        // contain it — `read_until` stops at the first match, and the echo arrives first.
        master.write_all(b"echo \"KES\"\"ILDI\"\n").unwrap();
        master.flush().unwrap();

        let seen = read_until(&pty, "KESILDI", Duration::from_secs(10));
        assert!(
            seen.contains("KESILDI"),
            "Ctrl-C did not interrupt `sleep 30`; the pty produced: {seen:?}"
        );

        pty.terminate();
        let _ = pty.wait();
    }

    #[test]
    fn a_resize_raises_sigwinch_in_the_shell() {
        // `a_resize_reaches_the_shell` proves the ioctl lands, which it does even on a pty nobody
        // claimed. This proves the other half: that a SIGNAL was delivered. `htop` and `vim`
        // redraw on the signal and never re-query the ioctl, so without this they keep drawing at
        // the old size for as long as the session lives.
        if !ctty_or_skip() {
            return;
        }
        let mut pty = open_test_pty(80, 24);
        let mut master = pty.master();

        master
            .write_all(b"trap 'echo \"YENI\"\"BOY\"' WINCH\necho \"HAZ\"\"IR\"\n")
            .unwrap();
        master.flush().unwrap();
        let seen = read_until(&pty, "HAZIR", Duration::from_secs(10));
        assert!(
            seen.contains("HAZIR"),
            "the shell never got as far as installing the trap: {seen:?}"
        );

        pty.resize(TermSize::new(120, 40).unwrap()).unwrap();

        let seen = read_until(&pty, "YENIBOY", Duration::from_secs(10));
        assert!(
            seen.contains("YENIBOY"),
            "the resize raised no SIGWINCH; the pty produced: {seen:?}"
        );

        pty.terminate();
        let _ = pty.wait();
    }

    #[test]
    fn the_session_id_is_read_past_a_command_name_that_contains_spaces() {
        // Field 2 of /proc/<pid>/stat is unescaped. Counting spaces from the front reads field 6
        // correctly for `bash` and reads some other process's number for `sh (old) x` — and
        // `signal_session` would then SIGKILL whatever pid that number happened to be.
        assert_eq!(
            stat_session("4242 (bash) S 1 4200 4242 34816 4200 4194304"),
            Some(4242)
        );
        assert_eq!(
            stat_session("77 (sh (old) x) S 1 55 4242 34816 55 4194304"),
            Some(4242)
        );
        assert_eq!(stat_session("not a stat line"), None);
    }

    #[test]
    fn session_members_lists_only_the_pids_in_that_session() {
        let root = std::env::temp_dir().join(format!("depsis-console-proc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let write = |pid: &str, stat: &str| {
            let dir = root.join(pid);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("stat"), stat).unwrap();
        };
        // The shell, a job that job control has moved into a group of its own, and a stranger.
        write("100", "100 (bash) S 1 100 100 34816 100 4194304");
        write("101", "101 (sleep) S 100 101 100 34816 100 4194304");
        write("102", "102 (stranger) S 1 102 999 34816 999 4194304");
        // A /proc entry that is not a pid, and a process whose `stat` disappeared mid-walk.
        std::fs::create_dir_all(root.join("meminfo")).unwrap();
        std::fs::create_dir_all(root.join("103")).unwrap();

        let mut found = session_members(&root, 100);
        found.sort_unstable();
        assert_eq!(found, vec![100, 101]);

        let _ = std::fs::remove_dir_all(&root);
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

        // Gone, not merely orphaned. Job control has given this job a process group of its own,
        // so what ends it is the SESSION half of `signal_session`, and its new parent (pid 1)
        // reaps it — the /proc entry disappears rather than turning into a zombie.
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
        // The reason `terminate` reaches past the shell. With a plain `kill(pid)` — or, once job
        // control has moved the job into a group of its own, with a plain
        // `kill_process_group(pid)` — the sleep below keeps the user side of the pty open and the
        // read never ends.
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
