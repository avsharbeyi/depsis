//! DEPSIS system agent binary.
//!
//! Runs as root behind a Unix socket. See `lib.rs` for why that is acceptable and what
//! constrains it.
//!
//! The `cfg` gate is here, on the module declaration — the core in `lib.rs` has none
//! (ADR-0006). CI cross-checks the Windows target so this stays true.

// `deny`, not `forbid`, and the difference is deliberate. `forbid` cannot be lifted locally, and
// exactly one place in this binary needs `unsafe`: adopting the listening descriptor systemd
// passes in, which no safe API can express. That single site carries an `#[allow(unsafe_code)]`
// with its SAFETY argument written out. Everywhere else the lint still bites, and the core crate
// `depsis_agent` remains `forbid(unsafe_code)` with no exceptions at all.
#![deny(unsafe_code)]

#[cfg(unix)]
mod unix;

use depsis_agent::{request_schema_json, response_schema_json};

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        // Used by the build step that keeps the TypeScript side in sync. Emitting the schema
        // from the binary rather than hand-maintaining a copy is what makes the Rust types the
        // single source of truth (ADR-0006).
        Some("--emit-schema") => {
            println!(
                "{{\"request\":{},\"response\":{}}}",
                request_schema_json(),
                response_schema_json()
            );
            std::process::ExitCode::SUCCESS
        }
        Some("--serve") => serve(),
        _ => {
            eprintln!(
                "depsis-agent

  --emit-schema   print the request/response JSON Schema and exit
  --serve         listen on the socket handed over by systemd

The socket is created by depsis-agent.socket, not by this process: letting systemd own it
means the socket file's DAC is the first authorization gate, checked before the agent sees a
single byte.

--serve requires DEPSIS_API_UID to be set to the uid the DEPSIS API runs as. It is read from
the environment, never inferred from a caller."
            );
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(unix)]
fn serve() -> std::process::ExitCode {
    use depsis_agent::audit::StderrSink;
    use depsis_agent::authz::Policy;
    use depsis_agent::data::DataChannel;
    use depsis_agent::dispatch::Agent;
    use depsis_agent::sweep;
    use depsis_agent::transfer::TransferRegistry;

    // The uid the API runs as is configuration, not something to discover. Guessing it — by
    // looking up a username, say — would mean a rename or a uid collision silently widened who
    // may drive privileged operations. Absent or unparseable is a startup failure, loudly.
    let api_uid: u32 = match std::env::var("DEPSIS_API_UID").map(|v| v.trim().parse::<u32>()) {
        Ok(Ok(uid)) => uid,
        Ok(Err(e)) => {
            eprintln!("depsis-agent: DEPSIS_API_UID is not a uid: {e}");
            return std::process::ExitCode::FAILURE;
        }
        Err(_) => {
            eprintln!("depsis-agent: DEPSIS_API_UID is unset; refusing to start");
            return std::process::ExitCode::FAILURE;
        }
    };
    if api_uid == 0 {
        // Would make the root-refusal in `authz` unreachable and every privileged action
        // indistinguishable from any other root process on the box.
        eprintln!("depsis-agent: DEPSIS_API_UID must not be 0");
        return std::process::ExitCode::FAILURE;
    }

    let listeners = match unix::listeners_from_systemd() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("depsis-agent: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let runner = unix::ExecRunner;
    let audit = StderrSink;
    // The share tree, if this box has one yet. A NAS before setup has no storage configured, and
    // refusing to start would make the agent unavailable for the very operations that set it up.
    // Absent means the transfer operations refuse with a reason; it does not mean they are silently
    // missing.
    let shares = match std::env::var("DEPSIS_SHARES_ROOT") {
        Ok(root) if !root.trim().is_empty() => {
            match unix::Openat2SafePath::open_root(root.trim()) {
                Ok(paths) => Some(paths),
                Err(e) => {
                    eprintln!("depsis-agent: DEPSIS_SHARES_ROOT is set but unusable: {e}");
                    return std::process::ExitCode::FAILURE;
                }
            }
        }
        _ => {
            eprintln!("depsis-agent: DEPSIS_SHARES_ROOT is not set; transfers will be refused");
            None
        }
    };

    let transfers = std::sync::Mutex::new(TransferRegistry::new());
    let tokens = unix::KernelTokens;

    let agent = Agent::new(
        Policy { api_uid },
        &runner,
        &audit,
        shares.as_ref(),
        &tokens,
        &transfers,
    );

    // How long an untouched staging file survives. Configuration rather than a constant, because
    // the number that makes it safe lives in the API — it must exceed the upload lifetime the API
    // advertises to tus clients, or the agent deletes uploads the API promised to keep. The agent
    // cannot check that from here; what it CAN refuse is a value short enough to be wrong under any
    // policy, and it does.
    let max_age = match std::env::var("DEPSIS_STAGING_MAX_AGE_HOURS") {
        Ok(raw) if !raw.trim().is_empty() => match raw.trim().parse::<u64>() {
            Ok(hours) => {
                match sweep::checked_max_age(std::time::Duration::from_secs(hours * 3600)) {
                    Ok(age) => age,
                    Err(e) => {
                        eprintln!("depsis-agent: {e}");
                        return std::process::ExitCode::FAILURE;
                    }
                }
            }
            Err(e) => {
                eprintln!("depsis-agent: DEPSIS_STAGING_MAX_AGE_HOURS is not a number: {e}");
                return std::process::ExitCode::FAILURE;
            }
        },
        _ => sweep::DEFAULT_MAX_AGE,
    };

    let data = DataChannel {
        policy: Policy { api_uid },
        audit: &audit,
        transfers: &transfers,
    };

    eprintln!(
        "depsis-agent: serving, api_uid={api_uid}, data workers={}",
        unix::MAX_DATA_CONNECTIONS
    );

    // Two loops, and neither ever returns in normal operation. The control loop stays on this
    // thread and keeps its deliberate one-connection-at-a-time behaviour; the data loop runs its
    // own fixed pool beside it.
    //
    // `thread::scope` is what lets both borrow the same registry and audit sink off this stack
    // without an `Arc` around either. Its cost is that it JOINS, and that is why a failure below
    // exits the process rather than returning: if the control loop died and this function simply
    // returned an error, the scope would block forever waiting for a data loop that is still
    // happily accepting connections, and systemd would see a service that is neither working nor
    // dead. Skipping destructors on the way out is acceptable for a daemon whose durable state is
    // already fsynced before any reply is sent; a half-served agent is not.
    std::thread::scope(|scope| {
        scope.spawn(|| {
            if let Err(e) = unix::serve_data_loop(&listeners.data, &data) {
                eprintln!("depsis-agent: data loop failed: {e}");
                std::process::exit(1);
            }
        });

        // Housekeeping, and deliberately NOT a systemd .timer running a script. Only this process
        // holds both the share root descriptor — so the sweep stays inside openat2(RESOLVE_BENEATH)
        // instead of walking paths as root — and the transfer registry, so "old" can be told apart
        // from "old but streaming right now". An external collector has neither and would
        // eventually delete a live upload (ADR-0017).
        //
        // Absent share root means nothing to sweep, and no thread. A box before storage is set up
        // has no staging directories at all.
        if let Some(paths) = shares.as_ref() {
            // Reborrowed before the `move`, which the thread needs for `paths`. Writing `&transfers`
            // inside a `move` closure captures the registry BY VALUE — the mutex would go with the
            // sweeper and the two socket loops would lose it.
            let registry = &transfers;
            let journal = &audit;
            scope.spawn(move || loop {
                let report = sweep::sweep_once(paths, registry, journal, max_age);
                if report.removed > 0 || report.unreadable > 0 {
                    eprintln!(
                        "depsis-agent: sweep removed {} abandoned staging file(s), spared {}, \
                         could not read {}",
                        report.removed, report.spared, report.unreadable
                    );
                }
                std::thread::sleep(sweep::SWEEP_INTERVAL);
            });
        }

        if let Err(e) = unix::serve_loop(&listeners.control, &agent) {
            eprintln!("depsis-agent: control loop failed: {e}");
            std::process::exit(1);
        }
        // The control listener closed cleanly, which only happens on shutdown.
        std::process::exit(0);
    })
}

#[cfg(not(unix))]
fn serve() -> std::process::ExitCode {
    // Windows is a development host only. The agent's real work is inherently Unix; what must
    // keep working here is compiling and running the core's tests against the mock seams.
    eprintln!("--serve is Unix-only; this build exists so the core can be tested on Windows.");
    std::process::ExitCode::FAILURE
}
