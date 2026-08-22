//! Session bookkeeping: the parts of a console session that are not a terminal.
//!
//! Nothing here opens a file or touches a syscall, which is the point — the two rules that make
//! a console safe to leave running (it expires, and every line is recorded) are pure functions
//! of time and bytes, and can be tested as such.

use std::time::{Duration, Instant};

/// How long a session may sit with no INPUT before it is closed (ADR-0018).
///
/// Input, not activity: a `top` left running while the administrator walks away produces output
/// forever and is exactly the session this timeout exists to close.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The ceiling on a session's whole life, however busy it is (ADR-0018).
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(4 * 60 * 60);

/// Refuse a configured duration that is short enough to be wrong under any policy.
///
/// A one-second idle timeout is not a stricter deployment, it is a console that cannot be used,
/// and the operator would discover that only by trying to type into one.
pub const MIN_CONFIGURABLE: Duration = Duration::from_secs(10);

// ─── expiry ───────────────────────────────────────────────────────────────────

/// Why a session ran out of time.
///
/// The strings are `public.console_sessions.close_reason`'s vocabulary verbatim, so the API can
/// store what it receives instead of translating it. See `packages/db/migrations/0013`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expiry {
    Idle,
    MaxAge,
}

impl Expiry {
    #[must_use]
    pub fn close_reason(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::MaxAge => "max_age",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub idle_timeout: Duration,
    pub max_age: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_age: DEFAULT_MAX_AGE,
        }
    }
}

/// The two clocks a session runs against.
///
/// `budget` returns how long the caller may block waiting for the next message. Arming the
/// socket's receive timeout from it is what makes the timeout a property of the session rather
/// than of a single `recv(2)`: a client that dribbles one byte every fourteen minutes re-arms a
/// per-syscall timer forever, but it cannot push back a deadline.
#[derive(Debug, Clone, Copy)]
pub struct Deadlines {
    limits: Limits,
    opened: Instant,
    last_input: Instant,
}

impl Deadlines {
    #[must_use]
    pub fn open(limits: Limits, now: Instant) -> Self {
        Self {
            limits,
            opened: now,
            last_input: now,
        }
    }

    pub fn touch(&mut self, now: Instant) {
        self.last_input = now;
    }

    /// `Ok(d)` — may wait `d` longer. `Err(e)` — already over, and `e` says which limit.
    pub fn budget(&self, now: Instant) -> Result<Duration, Expiry> {
        let age_left = self
            .limits
            .max_age
            .saturating_sub(now.saturating_duration_since(self.opened));
        let idle_left = self
            .limits
            .idle_timeout
            .saturating_sub(now.saturating_duration_since(self.last_input));

        // Max age first when both are spent: it is the limit that cannot be reset by typing, so
        // it is the truer explanation of why this session is over.
        if age_left.is_zero() {
            return Err(Expiry::MaxAge);
        }
        if idle_left.is_zero() {
            return Err(Expiry::Idle);
        }
        Ok(age_left.min(idle_left))
    }
}

// ─── audit line extraction ────────────────────────────────────────────────────

/// Longest audited line, in bytes.
///
/// `console_commands_bounded` in migration 0013 is `length(line) <= 8192`. Sending the API
/// something it cannot store would turn a paste accident into a failing insert on the audit
/// path, which is the last place that should break.
pub const AUDIT_LINE_LIMIT: usize = 8192;

const TRUNCATION_MARKER: &str = "…[truncated]";

/// Raw bytes buffered before the line is declared over-long. Below the limit by the marker's
/// width so the marker always fits.
const RAW_LIMIT: usize = AUDIT_LINE_LIMIT - TRUNCATION_MARKER.len();

/// Pulls whole lines out of the byte stream the operator is typing.
///
/// What this records is KEYSTROKES, not the command line the shell finally ran. The two differ
/// whenever readline is used: typing `lz`, backspace, `s`, Enter is audited as `lzs`, and an
/// arrow-key history recall is audited as almost nothing at all. Recording the shell's resolved
/// command line instead would mean parsing the shell's output or instrumenting the shell, and
/// both are worse than an honest, imperfect record — but the imperfection has to be stated,
/// because an auditor reading `console_commands` will otherwise assume it is the command list.
#[derive(Debug, Default)]
pub struct LineExtractor {
    buf: Vec<u8>,
    /// Set once the current line passed `RAW_LIMIT`; the rest of it is dropped rather than
    /// buffered, because a stream that never sends a terminator is otherwise unbounded memory.
    over_limit: bool,
    /// So `\r\n` is one terminator rather than two, even when the two bytes arrive in separate
    /// reads.
    last_was_cr: bool,
}

impl LineExtractor {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed input bytes; get back whichever lines were completed by them.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for byte in bytes {
            match *byte {
                b'\n' if self.last_was_cr => {
                    self.last_was_cr = false;
                }
                b'\r' | b'\n' => {
                    self.last_was_cr = *byte == b'\r';
                    let over = std::mem::replace(&mut self.over_limit, false);
                    let raw = std::mem::take(&mut self.buf);
                    if let Some(line) = render(&raw, over) {
                        lines.push(line);
                    }
                }
                other => {
                    self.last_was_cr = false;
                    if self.over_limit {
                        continue;
                    }
                    if self.buf.len() >= RAW_LIMIT {
                        self.over_limit = true;
                        continue;
                    }
                    self.buf.push(other);
                }
            }
        }
        lines
    }
}

/// Turn a completed raw line into the string the audit log stores, or nothing.
///
/// Control bytes are dropped (tab survives) for two reasons: they are not part of what was
/// typed in any meaningful sense, and a raw escape sequence pasted into a log viewer is a way
/// to move a cursor around somebody else's terminal.
fn render(raw: &[u8], hit_raw_limit: bool) -> Option<String> {
    let decoded = String::from_utf8_lossy(raw);
    let mut text: String = decoded
        .chars()
        .filter(|c| *c == '\t' || !c.is_control())
        .collect();

    // Lossy decoding can GROW the string — every invalid byte becomes a three-byte replacement
    // character — so a buffer that fit under `RAW_LIMIT` as bytes can still land over the
    // column's limit as text.
    let mut truncated = hit_raw_limit;
    if text.len() > RAW_LIMIT {
        let mut cut = RAW_LIMIT;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        truncated = true;
    }
    if truncated {
        text.push_str(TRUNCATION_MARKER);
    }

    // A bare Enter at an empty prompt ran nothing. Recording it would fill the audit table with
    // rows that say a user pressed a key.
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ─── privilege ────────────────────────────────────────────────────────────────

/// Decide, from the unit's flag and the process's real identity, whether this is a root console.
///
/// The environment variable does not GRANT anything — `User=` in the unit does. What the
/// variable does is declare the operator's intent, and this function refuses to start when the
/// declaration and the reality disagree. A service that says `privileged: false` in `ready`
/// while running as root, or the reverse, is worse than one that will not start: the API shows
/// that flag to the user, and the user decides what to type based on it.
pub fn privilege_from(flag: Option<&str>, euid: u32) -> Result<bool, String> {
    let declared = match flag.map(str::trim) {
        None | Some("") | Some("0") | Some("false") | Some("no") => false,
        Some("1") | Some("true") | Some("yes") => true,
        Some(other) => {
            return Err(format!(
                "DEPSIS_CONSOLE_PRIVILEGED is {other:?}; expected 0 or 1"
            ))
        }
    };

    match (declared, euid == 0) {
        (true, true) | (false, false) => Ok(declared),
        (true, false) => Err(format!(
            "DEPSIS_CONSOLE_PRIVILEGED=1 but this process runs as uid {euid}; \
             set User=root in depsis-console.service or clear the flag"
        )),
        (false, true) => Err(
            "this process runs as root but DEPSIS_CONSOLE_PRIVILEGED is not set; \
             set User=depsis-console in depsis-console.service or set the flag to 1"
                .to_string(),
        ),
    }
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

    // ── line extraction ──

    #[test]
    fn a_line_is_emitted_once_its_terminator_arrives() {
        let mut ex = LineExtractor::new();
        assert!(ex.feed(b"ls -la").is_empty());
        assert_eq!(ex.feed(b"\n"), vec!["ls -la".to_string()]);
    }

    #[test]
    fn crlf_is_one_terminator_not_two() {
        let mut ex = LineExtractor::new();
        assert_eq!(ex.feed(b"whoami\r\n"), vec!["whoami".to_string()]);
        assert!(ex.feed(b"\r\n").is_empty(), "a bare Enter records nothing");
    }

    #[test]
    fn crlf_split_across_two_reads_is_still_one_terminator() {
        // xterm.js sends \r for Enter; a client that translates it may split the pair.
        let mut ex = LineExtractor::new();
        assert_eq!(ex.feed(b"id\r"), vec!["id".to_string()]);
        assert!(ex.feed(b"\nwhoami\n").len() == 1);
    }

    #[test]
    fn a_multibyte_character_split_across_reads_survives() {
        // "merhaba dünyağ" — the ü and ğ are two bytes each, and the reads cut both in half.
        let text = "echo merhaba dünyağ\n".as_bytes().to_vec();
        for cut in 1..text.len() {
            let mut ex = LineExtractor::new();
            let mut lines = ex.feed(&text[..cut]);
            lines.extend(ex.feed(&text[cut..]));
            assert_eq!(
                lines,
                vec!["echo merhaba dünyağ".to_string()],
                "split at {cut}"
            );
        }
    }

    #[test]
    fn invalid_utf8_becomes_replacement_characters_rather_than_an_error() {
        let mut ex = LineExtractor::new();
        let lines = ex.feed(b"echo \xff\xfe\n");
        assert_eq!(lines, vec!["echo \u{fffd}\u{fffd}".to_string()]);
    }

    #[test]
    fn control_bytes_are_dropped_but_tabs_are_kept() {
        let mut ex = LineExtractor::new();
        // An arrow key, then a real tab.
        let lines = ex.feed(b"cd \x1b[A\tsrc\n");
        assert_eq!(lines, vec!["cd [A\tsrc".to_string()]);
    }

    #[test]
    fn an_endless_line_does_not_grow_the_buffer_without_bound() {
        let mut ex = LineExtractor::new();
        for _ in 0..1000 {
            assert!(ex.feed(&vec![b'x'; 4096]).is_empty());
            assert!(
                ex.buf.len() <= RAW_LIMIT,
                "buffer grew to {} bytes",
                ex.buf.len()
            );
        }
        let lines = ex.feed(b"\n");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].ends_with(TRUNCATION_MARKER));
        assert!(lines[0].len() <= AUDIT_LINE_LIMIT);
    }

    #[test]
    fn a_truncated_line_never_exceeds_what_the_audit_column_accepts() {
        // Every byte invalid, so lossy decoding triples the length of whatever was buffered.
        let mut ex = LineExtractor::new();
        let mut lines = ex.feed(&vec![0xffu8; RAW_LIMIT * 2]);
        lines.extend(ex.feed(b"\n"));
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].len() <= AUDIT_LINE_LIMIT,
            "line was {} bytes",
            lines[0].len()
        );
        assert!(lines[0].ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn the_extractor_recovers_after_an_over_long_line() {
        let mut ex = LineExtractor::new();
        let _ = ex.feed(&vec![b'y'; RAW_LIMIT + 10]);
        let lines = ex.feed(b"\nwhoami\n");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], "whoami");
    }

    #[test]
    fn several_lines_in_one_paste_come_out_in_order() {
        let mut ex = LineExtractor::new();
        assert_eq!(
            ex.feed(b"one\ntwo\nthree\n"),
            vec!["one".to_string(), "two".to_string(), "three".to_string()]
        );
    }

    // ── deadlines ──

    #[test]
    fn a_fresh_session_may_wait_up_to_the_idle_timeout() {
        let start = Instant::now();
        let d = Deadlines::open(Limits::default(), start);
        assert_eq!(d.budget(start), Ok(DEFAULT_IDLE_TIMEOUT));
    }

    #[test]
    fn silence_past_the_idle_timeout_expires_the_session() {
        let start = Instant::now();
        let d = Deadlines::open(Limits::default(), start);
        assert_eq!(
            d.budget(start + DEFAULT_IDLE_TIMEOUT + Duration::from_secs(1)),
            Err(Expiry::Idle)
        );
    }

    #[test]
    fn typing_pushes_the_idle_deadline_back_but_not_the_age_one() {
        let start = Instant::now();
        let mut d = Deadlines::open(Limits::default(), start);
        let mut now = start;
        // Type every minute for just under four hours. Idle never fires...
        for _ in 0..(4 * 60 - 1) {
            now += Duration::from_secs(60);
            assert!(
                d.budget(now).is_ok(),
                "idle fired while the user was typing"
            );
            d.touch(now);
        }
        // ...and the ceiling still lands on the hour, because typing cannot move it.
        assert_eq!(d.budget(start + DEFAULT_MAX_AGE), Err(Expiry::MaxAge));
    }

    #[test]
    fn the_budget_never_runs_past_the_age_ceiling() {
        let start = Instant::now();
        let limits = Limits {
            idle_timeout: Duration::from_secs(900),
            max_age: Duration::from_secs(1000),
        };
        let mut d = Deadlines::open(limits, start);
        // Typing at 200 seconds hands the idle window a fresh 900 — but only 800 of the session's
        // 1000 remain, and the budget must be the smaller of the two.
        let now = start + Duration::from_secs(200);
        d.touch(now);
        assert_eq!(d.budget(now), Ok(Duration::from_secs(800)));
    }

    #[test]
    fn max_age_wins_when_both_limits_are_spent() {
        let start = Instant::now();
        let d = Deadlines::open(Limits::default(), start);
        assert_eq!(d.budget(start + DEFAULT_MAX_AGE), Err(Expiry::MaxAge));
    }

    #[test]
    fn close_reasons_are_the_vocabulary_the_audit_column_accepts() {
        assert_eq!(Expiry::Idle.close_reason(), "idle");
        assert_eq!(Expiry::MaxAge.close_reason(), "max_age");
    }

    // ── privilege ──

    #[test]
    fn the_default_is_an_unprivileged_console() {
        assert_eq!(privilege_from(None, 991), Ok(false));
        assert_eq!(privilege_from(Some("0"), 991), Ok(false));
        assert_eq!(privilege_from(Some(""), 991), Ok(false));
    }

    #[test]
    fn a_root_console_is_only_reported_when_the_process_really_is_root() {
        assert_eq!(privilege_from(Some("1"), 0), Ok(true));
        assert!(privilege_from(Some("1"), 991).is_err());
    }

    #[test]
    fn running_as_root_without_declaring_it_is_a_startup_failure() {
        // Otherwise the API would show "unprivileged" above a root prompt.
        assert!(privilege_from(Some("0"), 0).is_err());
        assert!(privilege_from(None, 0).is_err());
    }

    #[test]
    fn a_flag_that_is_neither_zero_nor_one_is_refused() {
        assert!(privilege_from(Some("maybe"), 991).is_err());
    }
}
