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
 * The status a request that never got an answer is reported as.
 *
 * 504 because it means "no answer from upstream", which is exactly what happened, and because
 * nothing in `openapi/depsis.yaml` declares it — so a caller testing for it cannot be confused by a
 * real server response. Use [`isTransportFailure`] rather than comparing to this directly.
 */
const TRANSPORT_FAILURE = 504;

/**
 * Did this request fail to reach the server, or fail to come back?
 *
 * THE DISTINCTION MATTERS MOST WHERE IT IS EASIEST TO GET WRONG. For a read it is cosmetic. For a
 * request that changes something — and especially for `POST /storage/pools`, which erases disks —
 * "it failed" is a claim the client cannot make: the request may have been received, committed and
 * acted on, and only the answer lost. A screen that says "could not create the pool" while the
 * pool is being created is worse than one that says it does not know.
 */
export function isTransportFailure(response: Response): boolean {
  return (
    response.status === TRANSPORT_FAILURE && response.headers.get('x-depsis-transport') === '1'
  );
}

api.use({
  /**
   * Turn a thrown transport failure into an ordinary `{ error, response }` answer.
   *
   * `onError` returning a Response makes openapi-fetch use it instead of rethrowing, so every
   * existing call site — all of which already handle `data === undefined` — starts handling a
   * dropped connection without being touched. The alternative was a try/catch at each of them, and
   * the one that gets forgotten is the one that matters.
   *
   * NOT retried here. A retry belongs to the caller, because whether it is safe depends entirely on
   * what was being asked: re-reading a list is free, and re-sending a pool creation is not.
   */
  onError({ error }) {
    const detail =
      error instanceof Error && error.message !== ''
        ? `Sunucuya ulaşılamadı: ${error.message}`
        : 'Sunucuya ulaşılamadı.';

    // Shaped like the API's own RFC 9457 body, so `problemMessage` reads it the same way it reads a
    // real refusal and no call site needs a second code path.
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title: 'Sunucuya ulaşılamadı',
        status: TRANSPORT_FAILURE,
        detail,
        code: 'transport-failure',
        correlationId: '',
      }),
      {
        status: TRANSPORT_FAILURE,
        headers: {
          'content-type': 'application/problem+json',
          // The marker `isTransportFailure` reads. A header rather than the status alone, so that a
          // proxy in front of the appliance returning its own 504 is not mistaken for this.
          'x-depsis-transport': '1',
        },
      },
    );
  },
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
