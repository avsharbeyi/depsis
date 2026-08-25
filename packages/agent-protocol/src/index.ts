/**
 * @depsis/agent-protocol — the wire contract with the privileged system agent.
 *
 * Deliberately NOT part of `@depsis/contracts`. That package describes the HTTP surface, which the
 * OpenAPI document owns; this one describes a trust boundary, and ADR-0006 puts the contract for a
 * trust boundary on the side that ENFORCES it. The types below are generated from the schema the
 * Rust binary emits, and the unprivileged API never gets to widen them.
 *
 * What lives here is the generated types plus the envelope, and nothing else — no client, no
 * socket. A package that also knew how to connect would be a package that could be imported for
 * its types and quietly bring a connection along.
 */

export type * as Agent from './generated/agent.js';

/**
 * The line the agent reads.
 *
 * `correlation_id` and `reason` are audit metadata rather than parameters of an operation, which is
 * why they wrap the request instead of living inside it: every variant would otherwise carry two
 * fields no variant uses, and a new variant could quietly omit them.
 *
 * The agent bounds both and refuses control characters in either — a `reason` containing a newline
 * is a log-injection primitive against an append-only audit trail. The limits are repeated here so
 * a caller finds out at the call site rather than from a refusal.
 */
export interface AgentEnvelope<Request> {
  /** Max 64 characters, no control characters. Ties an HTTP request to the privileged call. */
  correlation_id: string;
  /** Max 200 characters, no control characters. Why the caller says it is doing this. */
  reason: string;
  request: Request;
}

export const MAX_CORRELATION_ID = 64;
export const MAX_REASON = 200;

/**
 * The version the agent reports from a ping.
 *
 * Checked at startup rather than on the first privileged call: a mismatched pair should fail while
 * someone is watching a deployment, not halfway through creating a dataset.
 */
export const EXPECTED_SCHEMA_VERSION = 18;

/**
 * Bound and sanitise an envelope field before it goes on the wire.
 *
 * The agent refuses out-of-range values, so this is not what makes the system safe — it is what
 * turns "the agent refused and I do not know why" into a local error naming the field. Truncation
 * rather than rejection for the reason, because losing the tail of an explanation is better than
 * failing a privileged operation over the length of its description.
 */
export function sanitiseReason(reason: string): string {
  return stripControl(reason).slice(0, MAX_REASON);
}

export function sanitiseCorrelationId(id: string): string {
  const clean = stripControl(id).slice(0, MAX_CORRELATION_ID).trim();
  // Trimmed, not merely checked for emptiness. Control characters become spaces, so an id of
  // two newlines survived as two spaces — not empty, and completely useless: a privileged call
  // in the audit trail that nobody can tie back to an HTTP request is the one thing the trail
  // exists to prevent. The test that caught this was asserting the behaviour I thought I had
  // already written.
  if (clean === '') throw new Error('correlation id is empty after sanitising');
  return clean;
}

function stripControl(value: string): string {
  // Replaced with a space rather than removed: `a\nb` becoming `ab` silently changes the text,
  // while `a b` reads as what it was.
  return [...value].map((c) => (isControl(c) ? ' ' : c)).join('');
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
