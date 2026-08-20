import type { OpenApi } from '@depsis/contracts';
import createClient from 'openapi-fetch';

/**
 * The API client, typed by the generated view of `openapi/depsis.yaml`.
 *
 * ADR-0001: "`apps/web` istemcisi ÜRETİLİR, elle yazılmaz." This is that rule in force — every
 * path, every request body and every response shape below comes from the document, so calling an
 * endpoint the contract does not describe, or reading a field it does not return, is a compile
 * error rather than a runtime surprise.
 *
 * `credentials: 'same-origin'` because the session is a cookie. The dev server proxies /api rather
 * than pointing at another origin, so this behaves the same in development and in production —
 * a cross-origin dev setup would work locally and diverge exactly where it matters.
 */
/**
 * Exported so a test can compare it against the `servers` entry in the OpenAPI document.
 *
 * A base URL that drifts from the contract produces 404s on every call — loud, but only once
 * something actually calls it, which on a screen nobody has opened yet can be a long time.
 */
export const API_BASE_URL = '/api/v1';

export const api = createClient<OpenApi.paths>({
  baseUrl: API_BASE_URL,
  credentials: 'same-origin',
});

/**
 * RFC 9457 problem details, reduced to something a form can show.
 *
 * The API deliberately says very little when it refuses a login — the same answer for a wrong
 * password, an unknown address and an unknown tenant — so the UI must not invent detail it was not
 * given. What it can do is not show `[object Object]`.
 */
export function problemMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const problem = error as { detail?: unknown; title?: unknown; message?: unknown };
    for (const candidate of [problem.detail, problem.message, problem.title]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    }
  }
  return fallback;
}
