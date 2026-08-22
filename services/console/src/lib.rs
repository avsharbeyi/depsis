//! DEPSIS administrator console — core.
//!
//! This service exists so that `depsis-agent` does not have to change. §2.2 of the
//! specification forbids the privileged agent from accepting free-form shell commands, and
//! ADR-0006 made that sentence the agent's whole reason to exist: a closed, typed operation
//! enum where a `RunCommand { line: String }` variant would make every other variant
//! decorative. A console cannot be added there without deleting that property.
//!
//! ADR-0018 resolves it by observing that §2.2 constrains the AGENT, not DEPSIS. So the console
//! is its own process, with its own unit, its own user and its own socket. The agent's
//! operation set is untouched, and the blast radius of a bug in this crate is one shell running
//! as `depsis-console` — not ZFS, Samba and the data channel.
//!
//! What keeps this service honest, in the order the bytes arrive:
//!
//!   1. **The socket's DAC.** systemd creates and owns `/run/depsis/console.sock`; this process
//!      never creates one. Mode and ownership are declared in a unit file that can be reviewed
//!      without reading any Rust.
//!   2. **`SO_PEERCRED`.** The kernel says who connected. Only the configured API uid is served,
//!      and uid 0 is refused by name so a stray root script cannot open shells that the audit
//!      log would attribute to the API.
//!   3. **Types, not strings** (`protocol`). Geometry that cannot be zero, identifiers that
//!      cannot contain a path separator, input that arrives through a strict base64 decoder.
//!      Validation happens in the parse, so no later caller can skip it.
//!   4. **Expiry** (`session`). Fifteen idle minutes, four hours of life. A console tab left
//!      open is otherwise an unbounded shell.
//!   5. **Audit** (`session::LineExtractor`). Every completed input line goes to the API as a
//!      `line` message. Output never does — ADR-0018 is explicit that copying the output of a
//!      `cat /etc/shadow` into a log moves the secret rather than recording it.
//!
//! `protocol` and `session` are platform-free and are compiled and tested on Windows too, the
//! same arrangement the agent's core uses. `pty` is Unix by nature and says so with a `cfg` on
//! the module declaration rather than scattered through function bodies.

#![forbid(unsafe_code)]

pub mod protocol;
pub mod session;

#[cfg(unix)]
pub mod pty;
