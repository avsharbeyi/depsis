import {
  Controller,
  ForbiddenException,
  Get,
  Module,
  NotFoundException,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ERROR_CODES, PROBLEM_BASE_URI } from '@depsis/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORRELATION_HEADER } from './correlation.js';
import { correlationMiddleware } from './correlation.js';
import { ProblemException, ProblemFilter } from './problem.filter.js';

/**
 * The error body, over real HTTP.
 *
 * Asserted end to end rather than by calling the filter directly, because the two things most
 * likely to be wrong are not in the filter's logic: whether it is REGISTERED, and whether the
 * response actually carries `application/problem+json`. A unit test of `describe()` would have
 * passed on every day the API was still answering with Nest's own shape.
 */

@Controller('boom')
class BoomController {
  @Get('missing')
  missing(): never {
    // No message. Nest fills in "Not Found", which must NOT become a `detail`.
    throw new NotFoundException();
  }

  @Get('explained')
  explained(): never {
    throw new ForbiddenException("renaming needs 'modify'");
  }

  @Get('typed')
  typed(): never {
    throw new ProblemException('checksum-mismatch', 'gönderilen sağlama tutmadı', [
      { pointer: '/checksum', code: 'mismatch', message: 'beklenen sha-256' },
    ]);
  }

  @Get('throttled')
  throttled(): never {
    throw new ProblemException('rate-limited', undefined, undefined, 30);
  }

  @Get('crash')
  crash(): never {
    throw new Error('SELECT secret FROM users WHERE id = 42');
  }

  @Get('fine')
  fine(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [BoomController],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
class BoomModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}

describe('the error body', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BoomModule] }).compile();
    app = moduleRef.createNestApplication();
    // Silenced: the 500 test deliberately throws, and a stack trace in the middle of a green run
    // reads as a failure.
    app.useLogger(false);
    await app.listen(0);
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is RFC 9457, with the media type that says so', async () => {
    const response = await fetch(`${base}/boom/explained`);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/problem+json');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['type']).toBe(`${PROBLEM_BASE_URI}forbidden`);
    expect(body['code']).toBe('forbidden');
    expect(body['status']).toBe(403);
    expect(body['title']).toBe('Bu işlem için yetkiniz yok');
    // The route's own sentence, kept: it was written for the person reading it.
    expect(body['detail']).toBe("renaming needs 'modify'");
    expect(body['instance']).toBe('/boom/explained');
  });

  it('drops Nest’s filler message rather than passing it off as an explanation', async () => {
    // "Not Found" as a `detail` looks like an explanation and is not one. The `title` already says
    // that much, in the product's language.
    const response = await fetch(`${base}/boom/missing`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body['code']).toBe('not-found');
    expect(body).not.toHaveProperty('detail');
  });

  it('carries the code and the field errors a route chose', async () => {
    const response = await fetch(`${base}/boom/typed`);
    const body = (await response.json()) as Record<string, unknown>;

    // 422 is shared by `validation-failed` and `checksum-mismatch`, which is the whole reason a
    // route can name its code instead of having one derived from the status.
    expect(response.status).toBe(422);
    expect(body['code']).toBe('checksum-mismatch');
    expect(body['errors']).toEqual([
      { pointer: '/checksum', code: 'mismatch', message: 'beklenen sha-256' },
    ]);
  });

  it('puts a retry hint in the body and in the header', async () => {
    const response = await fetch(`${base}/boom/throttled`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(body['retryAfter']).toBe(30);
    // The header too: an HTTP client that honours `Retry-After` never reads the body.
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('never lets an unexpected error’s message reach the caller', async () => {
    // The single most important assertion here. The thrown message names a table and a column;
    // whatever a 500 says on the wire, it must not be that.
    const response = await fetch(`${base}/boom/crash`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('users');

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body['code']).toBe('internal-error');
    expect(body).not.toHaveProperty('detail');
    // What the caller gets instead: the id that finds the log line holding the real text.
    expect(typeof body['correlationId']).toBe('string');
  });

  it('gives every response a correlation id, and the same one in the body', async () => {
    const failed = await fetch(`${base}/boom/missing`);
    const body = (await failed.json()) as Record<string, unknown>;
    const header = failed.headers.get(CORRELATION_HEADER.toLowerCase());

    expect(header).toBeTruthy();
    expect(body['correlationId']).toBe(header);

    // §14 asks for it on every response, not only the failures — a success that cannot be traced
    // is half a trail.
    const ok = await fetch(`${base}/boom/fine`);
    expect(ok.headers.get(CORRELATION_HEADER.toLowerCase())).toBeTruthy();
    expect(ok.headers.get(CORRELATION_HEADER.toLowerCase())).not.toBe(header);
  });

  it('answers a route that does not exist with a problem too', async () => {
    // The reason the middleware is middleware. A 404 from the router never reaches a controller,
    // and it is exactly the response somebody will be trying to trace.
    const response = await fetch(`${base}/boom/nothing-here`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.headers.get(CORRELATION_HEADER.toLowerCase())).toBeTruthy();
  });

  it('only ever names a code the contract declares', () => {
    // The closed set is the promise clients branch on. A code the document does not list is a
    // client's `default:` branch, silently.
    const known = new Set<string>(ERROR_CODES);
    for (const code of ['forbidden', 'not-found', 'checksum-mismatch', 'rate-limited', 'gone']) {
      expect(known.has(code)).toBe(true);
    }
  });
});
