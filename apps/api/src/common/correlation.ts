import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * The one identifier that ties a response, a log line and a privileged call together.
 *
 * §14 asks for it on every response and on every log line for the same request. Until now it
 * existed only inside `AgentService`, which minted its own per privileged call — so an operator
 * reading the agent's audit trail could find the call and had nothing to join it back to.
 *
 * MINTED HERE, NEVER READ OFF THE REQUEST. Accepting a client-supplied `X-Correlation-Id` is the
 * obvious convenience and it is a log-injection primitive: the value lands in an append-only audit
 * trail, and a caller who chooses it chooses what the trail says. The agent already refuses
 * control characters in the field for exactly this reason; not taking the value at all is the
 * cheaper version of the same defence.
 */
export const CORRELATION_HEADER = 'X-Correlation-Id';

/** Where the id lives on the request. A symbol, so it cannot collide with a body or query field. */
const KEY = Symbol.for('depsis.correlationId');

interface Carrier {
  [KEY]?: string;
}

export function correlationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const id = randomUUID();
  (request as Request & Carrier)[KEY] = id;
  // On the response before anything else runs, so it is present on a success, on a handled error
  // and on a crash the filter never sees.
  response.setHeader(CORRELATION_HEADER, id);
  next();
}

/**
 * The id for this request.
 *
 * Falls back to a fresh one rather than throwing: a filter that could not produce an error body
 * because it could not find a correlation id would turn every error into a different, worse error.
 * The fallback is still unique, so it is traceable to this response even when it ties to nothing
 * else — which is the honest outcome when the middleware did not run.
 */
export function correlationIdOf(request: unknown): string {
  const carrier = request as Carrier | null;
  const found = carrier?.[KEY];
  return typeof found === 'string' ? found : randomUUID();
}
