/**
 * @depsis/contracts — the single source of truth for the DEPSIS HTTP API surface.
 *
 * Scope note (ADR-0006): the SYSTEM AGENT IPC schema is NOT here. It is owned by the Rust agent
 * and emitted from its own types via schemars, because the side that enforces a trust boundary
 * must own the contract for it. The generated .d.ts is committed and CI fails on drift; the
 * unprivileged side never gets to define what the privileged side accepts.
 */

export * from './errors.js';
export * from './pagination.js';
