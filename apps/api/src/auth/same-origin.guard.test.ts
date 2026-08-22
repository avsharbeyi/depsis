import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { SameOriginGuard } from './same-origin.guard.js';

/**
 * The CSRF check, as a rule about METHODS rather than a rule about controllers.
 *
 * This suite exists because the previous arrangement — every controller calling
 * `requireSameOrigin` itself — passed its own tests while leaving `/files` and `/uploads` open.
 * Nothing could fail, because nothing was asserting about the routes that had forgotten. The
 * question here is therefore not "does the check work" (origin.ts settles that) but "does it run
 * for a request nobody wrote a line of code about".
 */

function contextFor(request: Partial<Request>): ExecutionContext {
  const full = { headers: {}, method: 'POST', secure: false, ...request } as Request;
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => full }),
  } as unknown as ExecutionContext;
}

describe('SameOriginGuard', () => {
  const guard = new SameOriginGuard();

  it('refuses an unsafe request declaring a foreign origin', () => {
    // Measured against the running appliance before this guard existed: this exact request
    // answered 201 on POST /api/v1/files/folders.
    expect(() =>
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'http://evil.example', host: '172.24.110.83:3200' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows the same origin', () => {
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { origin: 'http://172.24.110.83:3200', host: '172.24.110.83:3200' },
        }),
      ),
    ).toBe(true);
  });

  it.each(['PATCH', 'DELETE', 'PUT'])('covers %s, not only POST', (method) => {
    // Renaming and trashing are PATCH and DELETE. A guard that only thought about POST would leave
    // the two operations that destroy something.
    expect(() =>
      guard.canActivate(
        contextFor({ method, headers: { origin: 'http://evil.example', host: 'depsis.local' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('leaves %s alone', (method) => {
    // A cross-origin GET cannot be stopped this way and does not need to be: the browser will not
    // let the initiating page read the answer. Refusing it would break nothing but would say
    // something untrue about what this defends.
    expect(
      guard.canActivate(
        contextFor({ method, headers: { origin: 'http://evil.example', host: 'depsis.local' } }),
      ),
    ).toBe(true);
  });

  it('allows a request that declares no origin at all', () => {
    // curl, the agent, a health probe. Nobody can make a non-browser client send somebody else's
    // cookie, so there is no CSRF to defend against — and refusing here would break every
    // scripted client for no gain.
    expect(
      guard.canActivate(contextFor({ method: 'POST', headers: { host: 'depsis.local' } })),
    ).toBe(true);
  });

  it('falls back to the Referer when there is no Origin', () => {
    expect(() =>
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { referer: 'http://evil.example/page', host: 'depsis.local' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('compares against https when the connection is secure', () => {
    // The expected origin is built from the scheme as well as the host. Getting this wrong in the
    // other direction — always comparing against http — would refuse every request on a TLS
    // deployment, which is the failure that looks like "the product does not work".
    expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          secure: true,
          headers: { origin: 'https://depsis.local', host: 'depsis.local' },
        }),
      ),
    ).toBe(true);
  });

  it('does nothing outside an HTTP context', () => {
    const other = {
      getType: () => 'rpc',
      switchToHttp: () => {
        throw new Error('must not be reached');
      },
    } as unknown as ExecutionContext;
    expect(guard.canActivate(other)).toBe(true);
  });
});
