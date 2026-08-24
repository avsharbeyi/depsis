import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, from, of, switchMap, tap } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { IdempotencyService, REPLAYED_HEADERS } from './idempotency.service.js';
import { ProblemException } from './problem.filter.js';

const HEADER = 'idempotency-key';

/**
 * `Idempotency-Key`, applied to the routes that declare it.
 *
 * OPT-IN RATHER THAN GLOBAL, and that is the one design decision here. A global interceptor would
 * make every POST idempotent-if-a-key-is-sent, which sounds generous and is a promise the API
 * cannot keep: replaying a stored response is only correct where the SIDE EFFECT was also
 * prevented, and that is a claim about a specific route. So it goes where the contract says it
 * goes — four routes — and adding a fifth means declaring it in the document and mounting this.
 *
 * NO KEY, NO BEHAVIOUR. The header is optional in the contract, so a request without it runs
 * exactly as before. That is what makes this safe to mount on existing routes.
 *
 * THE HANDLER'S OWN RESPONSE IS WHAT GETS STORED, including its status — which is read off the
 * express response rather than assumed, because `POST /uploads` answers 201 with no body and
 * `POST /file-operations` answers 202, and a replay that changed the status would be a different
 * response to the same request.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly keys: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const raw = request.headers[HEADER];
    const key = typeof raw === 'string' ? raw.trim() : '';
    const session = request.depsis;
    // No session means this ran without `SessionGuard`, which for these four routes cannot happen.
    // Passing through rather than throwing keeps the failure where it belongs: the guard's.
    if (key === '' || session === undefined) return next.handle();

    if (key.length > 255) {
      // The contract's own limit. Refused rather than truncated, because a truncated key is a key
      // that collides with a different request.
      throw new ProblemException('bad-request', 'Idempotency-Key en fazla 255 karakter olabilir.');
    }

    const endpoint = `${request.method.toUpperCase()} ${request.path}`;
    const fingerprint = IdempotencyService.fingerprint(request.method, request.path, request.body);
    const { organizationId, userId } = session;

    return from(this.keys.claim(organizationId, userId, endpoint, key, fingerprint)).pipe(
      switchMap((claim) => {
        if (claim.outcome === 'reused') {
          throw new ProblemException(
            'idempotency-key-reused',
            'Bu Idempotency-Key daha önce başka bir istekle kullanıldı.',
          );
        }
        if (claim.outcome === 'in-flight') {
          throw new ProblemException(
            'operation-in-progress',
            'Aynı anahtarla bir istek hâlâ sürüyor. Birazdan tekrar deneyin.',
          );
        }
        if (claim.outcome === 'replay') {
          // The stored status, not the route's default. `of(...)` returns the body through Nest's
          // normal path so serialisation stays identical to the original answer.
          response.status(claim.status);
          for (const [name, value] of Object.entries(claim.headers)) {
            response.setHeader(name, value);
          }
          return of(claim.body);
        }

        return next.handle().pipe(
          tap({
            next: (body: unknown) => {
              // `statusCode` is whatever the route set — 201 from `@HttpCode`, 202, 200. Read
              // rather than guessed so a replay is the same response, not a similar one.
              const headers: Record<string, string> = {};
              for (const name of REPLAYED_HEADERS) {
                const value = response.getHeader(name);
                if (typeof value === 'string') headers[name] = value;
                else if (typeof value === 'number') headers[name] = String(value);
              }
              void this.keys
                .complete(organizationId, userId, endpoint, key, response.statusCode, body, headers)
                .catch(() => {
                  // A key that could not be recorded is a key that will be re-claimable. That is
                  // the safe direction: the work happened once and a retry may make it happen
                  // again, which is exactly the pre-existing behaviour rather than a new failure.
                });
            },
            error: () => {
              // Failed requests do not consume the key. A client that hit a transient 503 must be
              // able to retry with the same key — telling them to mint a new one for a retry is
              // telling them the header does nothing.
              void this.keys.release(organizationId, userId, endpoint, key).catch(() => {});
            },
          }),
        );
      }),
    );
  }
}
