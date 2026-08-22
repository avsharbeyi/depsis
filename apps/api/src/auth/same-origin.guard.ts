import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { requireSameOrigin } from './origin.js';

/**
 * The same-origin check, applied to every unsafe request instead of to the ones somebody
 * remembered.
 *
 * `requireSameOrigin` was already extracted into its own file, with a comment explaining that
 * leaving it private to one controller had left other routes unprotected. Extracting it did not fix
 * that: it still had to be CALLED, and `files.controller.ts` and `uploads.controller.ts` — written
 * afterwards — never called it. Measured against the running appliance: a POST to
 * `/api/v1/files/folders` carrying `Origin: http://evil.example` and a valid session cookie
 * answered 201. Creating a folder is the mild end of that; renaming and trashing are on the same
 * controller.
 *
 * So the decision moves off the controllers entirely. A route is protected because it is a state
 * change, not because its author thought of it.
 *
 * Safe methods are exempt for the obvious reason — a cross-origin GET cannot be stopped this way
 * and does not need to be, since the browser will not let the initiating page read the answer.
 * OPTIONS is exempt so a preflight can be answered rather than 403'd.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SameOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // HTTP only. A guard that assumed an HTTP context would throw on any other transport, and
    // there is nothing here to check for one.
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE.has(request.method.toUpperCase())) return true;

    requireSameOrigin(request);
    return true;
  }
}
