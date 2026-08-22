//! Append-only audit of every privileged request.
//!
//! Master prompt §16: the audit trail must never contain passwords, tokens, secrets or file
//! contents. That is easy to honour here because the operation surface has no field that can
//! carry one — which is another reason the enum is closed and typed.
//!
//! Every entry carries the correlation id the API generated, so one user action can be followed
//! from the HTTP request through the agent call and into the journal.

use crate::op::Request;
use crate::seams::PeerIdentity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub correlation_id: String,
    pub uid: u32,
    pub pid: i32,
    /// The operation name only — never the full request, so a future field carrying something
    /// sensitive cannot leak here by default.
    pub operation: &'static str,
    /// Why the caller says it is doing this. Supplied by the API, recorded verbatim.
    pub reason: String,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Allowed,
    Refused(String),
    Failed(String),
}

pub fn operation_name(request: &Request) -> &'static str {
    match request {
        Request::Ping {} => "ping",
        Request::PoolStatus { .. } => "pool_status",
        Request::CreateDataset { .. } => "create_dataset",
        Request::CreateSnapshot { .. } => "create_snapshot",
        Request::DiffSnapshots { .. } => "diff_snapshots",
        Request::ReadSmartSummary { .. } => "read_smart_summary",
        Request::PublishSambaConfig { .. } => "publish_samba_config",
        Request::OpenTransfer { .. } => "open_transfer",
        Request::PublishTransfer { .. } => "publish_transfer",
    }
}

/// Where audit entries go. Real deployment writes to the journal; tests collect in memory.
///
/// `Sync`, and the bound is load-bearing rather than tidy. The data channel runs on worker threads
/// (ADR-0017) and every one of them has to be able to record what it did — §16 requires a
/// privileged call to be explicable afterwards, and the data connection is the one that actually
/// writes user data as root. Without this bound `&Agent` cannot cross a thread boundary at all, and
/// the path of least resistance when writing that loop is to drop the audit rather than fix the
/// types. Putting the bound here first makes the compiler enforce that the channel is auditable.
pub trait Sink: Sync {
    fn record(&self, entry: Entry);
}

#[derive(Default)]
pub struct MemorySink {
    /// A `Mutex`, not a `RefCell`, for the reason on the trait above: a `RefCell` is not `Sync`, so
    /// the test sink would be the one thing preventing the real code from being tested at all.
    pub entries: std::sync::Mutex<Vec<Entry>>,
}

impl MemorySink {
    /// The recorded entries. Poison is recovered: a test that panicked while holding the lock has
    /// already failed, and a second panic here would replace its message with a less useful one.
    pub fn entries(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Sink for MemorySink {
    fn record(&self, entry: Entry) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(entry);
    }
}

/// The production sink: one JSON object per line on stderr.
///
/// Under systemd, stderr goes to the journal, so this needs no journald library and no
/// dependency in a process running as root. It also means the audit trail is readable with
/// `journalctl -u depsis-agent -o cat` on a box with nothing else installed, which matters when
/// you are diagnosing a NAS over SSH at the worst possible moment.
///
/// The fields are written by hand rather than via `serde` because `Entry` deliberately does not
/// derive `Serialize`: making it serialisable is the first step towards someone adding the full
/// `Request` to it, which §16 forbids.
pub struct StderrSink;

impl Sink for StderrSink {
    fn record(&self, entry: Entry) {
        let (outcome, detail) = match &entry.outcome {
            Outcome::Allowed => ("allowed", String::new()),
            Outcome::Refused(why) => ("refused", why.clone()),
            Outcome::Failed(why) => ("failed", why.clone()),
        };
        // `reason` and `detail` are attacker-influenced, so they are JSON-escaped. The envelope
        // parser already rejects control characters, but a sink that assumes its input was
        // validated upstream is a sink that breaks the day someone adds a second caller.
        eprintln!(
            r#"{{"audit":1,"correlation_id":{},"uid":{},"pid":{},"operation":{},"reason":{},"outcome":"{}","detail":{}}}"#,
            json_string(&entry.correlation_id),
            entry.uid,
            entry.pid,
            json_string(entry.operation),
            json_string(&entry.reason),
            outcome,
            json_string(&detail),
        );
    }
}

/// JSON-encode one string, escaping included.
///
/// Delegated to `serde_json` rather than hand-rolled. A hand-rolled escaper in an audit sink is
/// a poor trade: the sink is the one component whose output must stay parseable precisely when
/// the input is hostile, and `serde_json` already handles the cases a hand-rolled version gets
/// wrong (lone surrogates, U+2028, the full C0 range).
fn json_string(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

pub fn entry(
    correlation_id: &str,
    peer: PeerIdentity,
    request: &Request,
    reason: &str,
    outcome: Outcome,
) -> Entry {
    Entry {
        correlation_id: correlation_id.to_string(),
        uid: peer.uid,
        pid: peer.pid,
        operation: operation_name(request),
        reason: reason.to_string(),
        outcome,
    }
}
