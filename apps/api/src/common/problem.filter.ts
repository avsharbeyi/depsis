import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  problem,
  statusForCode,
  type ErrorCode,
  type ProblemDetails,
  type ProblemFieldError,
} from '@depsis/contracts';
import type { Request, Response } from 'express';

import { CORRELATION_HEADER, correlationIdOf } from './correlation.js';

/**
 * An error that already knows what it is.
 *
 * Throw this where the code matters — `checksum-mismatch` and `precondition-failed` are not
 * derivable from a status, because 422 and 412 each carry more than one meaning. Everything else
 * can keep throwing Nest's own exceptions and be mapped by status below; the point of the filter
 * is that no route has to be rewritten for the body to become correct.
 */
export class ProblemException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly fields?: readonly ProblemFieldError[],
    readonly retryAfter?: number,
  ) {
    super(detail ?? code, statusForCode(code));
  }
}

/** The line between "the caller did something" and "we did something". */
const SERVER_ERROR = 500;

/**
 * Every status the API answers with, and the code that means it.
 *
 * A `Record` over the numbers the contract declares rather than a `switch` with a default: adding
 * a status to the document without deciding what it MEANS should be visible here, and the fallback
 * below is deliberately the blandest thing that can be said rather than a guess.
 */
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'bad-request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  410: 'gone',
  412: 'precondition-failed',
  413: 'quota-exceeded',
  415: 'unsupported-media-type',
  416: 'range-not-satisfiable',
  422: 'validation-failed',
  429: 'rate-limited',
  500: 'internal-error',
  503: 'dependency-unavailable',
  507: 'insufficient-storage',
};

/**
 * RFC 9457 for every error the API produces.
 *
 * WHY THIS IS A FILTER AND NOT A CONVENTION. The contract has declared `application/problem+json`
 * with a `ProblemDetails` body on 170-odd responses since the beginning, and the API produced
 * Nest's `{ statusCode, message, error }` on every one of them: every generated client's error
 * type was a description of a body that did not exist, and `code` — the closed set the document
 * says clients may branch on — was never sent at all. A convention would have fixed the routes
 * somebody remembered. A filter fixes the ones nobody will write for another year.
 *
 * WHAT IT WILL NOT DO IS INVENT DETAIL. Nest's default message for a bare `NotFoundException()` is
 * the string "Not Found", which as a `detail` is worse than nothing: it looks like an explanation
 * and carries none. Those are dropped, and only a message a route actually wrote survives.
 *
 * A 500 NEVER carries a detail. Whatever the thrown error says was written for a log, and the one
 * thing an unexpected error's message reliably contains is the shape of the inside of the system —
 * a query, a path, a column name. The correlation id is what connects the user's screen to the log
 * line that has the real text.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlationId = correlationIdOf(request);

    const body = this.describe(exception, correlationId, request);

    if (body.status >= SERVER_ERROR) {
      // The whole error, once, on the server. This is the other half of withholding `detail`: the
      // text still exists, it is just not on the wire, and the correlation id is in both places.
      this.logger.error(
        `${request.method} ${request.url} -> ${body.status} [${correlationId}]: ` +
          (exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)),
      );
    }

    // Set again rather than assumed: a filter can run for a request the middleware never touched
    // (a 404 from the router itself), and a body carrying a correlation id the header contradicts
    // would be worse than either alone.
    response.setHeader(CORRELATION_HEADER, correlationId);
    if (body.retryAfter !== undefined) response.setHeader('Retry-After', String(body.retryAfter));
    response.status(body.status).type('application/problem+json').send(body);
  }

  private describe(exception: unknown, correlationId: string, request: Request): ProblemDetails {
    const instance = request.url;

    if (exception instanceof ProblemException) {
      return problem(exception.code, correlationId, {
        instance,
        ...(exception.detail !== undefined ? { detail: exception.detail } : {}),
        ...(exception.fields !== undefined ? { errors: [...exception.fields] } : {}),
        ...(exception.retryAfter !== undefined ? { retryAfter: exception.retryAfter } : {}),
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? fallbackCode(status);
      const detail = detailOf(exception);
      return {
        ...problem(code, correlationId, { instance, ...(detail !== undefined ? { detail } : {}) }),
        // The exception's OWN status, not the code's. They agree for every entry in the table
        // above, and where a route throws a status the table does not cover, answering with the
        // status the route chose is less surprising than answering with 500 because a lookup
        // missed. The `code` is the honest part of the pair — it says the API does not have a
        // name for this.
        status,
      };
    }

    return problem('internal-error', correlationId, { instance });
  }
}

/** A status the contract does not declare. Say so in the code rather than guessing a meaning. */
function fallbackCode(status: number): ErrorCode {
  return status >= SERVER_ERROR ? 'internal-error' : 'bad-request';
}

/**
 * The message a route wrote, or nothing.
 *
 * Nest fills `message` with the status text when the thrower gave none — "Not Found",
 * "Forbidden resource", "Unauthorized". As a `detail` those read as an explanation and are not
 * one, so they are dropped and the reader is left with the `title`, which at least says the same
 * thing in the product's own language.
 */
const EMPTY_MESSAGES = new Set([
  'Not Found',
  'Forbidden',
  'Forbidden resource',
  'Unauthorized',
  'Bad Request',
  'Conflict',
  'Internal Server Error',
  'Unprocessable Entity',
  'Service Unavailable',
  'Gone',
  'Payload Too Large',
  'Unsupported Media Type',
  'Too Many Requests',
  'Precondition Failed',
]);

function detailOf(exception: HttpException): string | undefined {
  if (exception.getStatus() >= SERVER_ERROR) return undefined;

  const payload: unknown = exception.getResponse();
  const raw =
    typeof payload === 'string'
      ? payload
      : typeof payload === 'object' && payload !== null && 'message' in payload
        ? payload.message
        : undefined;

  // `message` is an array when a Nest ValidationPipe rejected several fields at once.
  const text = Array.isArray(raw) ? raw.filter((m) => typeof m === 'string').join('; ') : raw;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed === '' || EMPTY_MESSAGES.has(trimmed)) return undefined;
  return trimmed;
}
