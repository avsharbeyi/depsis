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
    use depsis_agent::dispatch::Agent;

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

    let listener = match unix::listener_from_systemd() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("depsis-agent: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let runner = unix::ExecRunner;
    let audit = StderrSink;
    let agent = Agent::new(Policy { api_uid }, &runner, &audit);

    eprintln!("depsis-agent: serving, api_uid={api_uid}");
    match unix::serve_loop(&listener, &agent) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("depsis-agent: serve loop failed: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(unix))]
fn serve() -> std::process::ExitCode {
    // Windows is a development host only. The agent's real work is inherently Unix; what must
    // keep working here is compiling and running the core's tests against the mock seams.
    eprintln!("--serve is Unix-only; this build exists so the core can be tested on Windows.");
    std::process::ExitCode::FAILURE
}
