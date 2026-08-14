import { z } from 'zod';

/**
 * RFC 9457 Problem Details — the single error shape for every DEPSIS API response.
 *
 * Master prompt §14 requires a consistent error body, and §14 also requires that an
 * authorization failure must not leak whether a hidden resource exists. Those two rules pull
 * against each other: a genuinely useful error body is exactly what leaks. The resolution here
 * is that `detail` is written for the person who is ALLOWED to see the resource, and the
 * NOT_FOUND / FORBIDDEN choice is made by the rules in `notFoundOrForbidden` below.
 */

export const PROBLEM_BASE_URI = 'https://depsis.local/problems/';

/**
 * Error codes are a closed set so that clients can branch on them without string matching,
 * and so that adding a code is a deliberate act reviewable in a diff.
 */
export const ERROR_CODES = [
  // auth
  'unauthenticated',
  'invalid-credentials',
  'mfa-required',
  'mfa-invalid',
  'session-expired',
  // authz
  'forbidden',
  'not-found',
  // validation
  'validation-failed',
  'unsupported-media-type',
  // concurrency
  'conflict',
  'precondition-failed',
  'idempotency-key-reused',
  // storage
  'quota-exceeded',
  'insufficient-storage',
  'upload-offset-mismatch',
  'checksum-mismatch',
  // operational
  'rate-limited',
  'dependency-unavailable',
  'operation-in-progress',
  'internal-error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** One field-level validation failure. Never echoes the rejected value — it may be a secret. */
export const problemFieldErrorSchema = z.object({
  /** JSON Pointer (RFC 6901) to the offending member, e.g. "/name". */
  pointer: z.string(),
  code: z.string(),
  message: z.string(),
});

export const problemDetailsSchema = z.object({
  /** Stable URI identifying the problem type. `PROBLEM_BASE_URI + code`. */
  type: z.string(),
  /** Short, human-readable summary. Must not change between occurrences of the same type. */
  title: z.string(),
  status: z.number().int().min(400).max(599),
  /** Occurrence-specific explanation. MUST NOT contain secrets, file contents, or paths the
   *  caller is not authorized to see. */
  detail: z.string().optional(),
  /** URI of the specific occurrence. */
  instance: z.string().optional(),

  // ── DEPSIS extensions ──────────────────────────────────────────────────────
  code: z.enum(ERROR_CODES),
  /** Present on every response and every log line for the same request (§14). */
  correlationId: z.string(),
  errors: z.array(problemFieldErrorSchema).optional(),
  /** Seconds. Set on 429 and on 503 when the caller should retry. */
  retryAfter: z.number().int().nonnegative().optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthenticated: 401,
  'invalid-credentials': 401,
  'mfa-required': 401,
  'mfa-invalid': 401,
  'session-expired': 401,
  forbidden: 403,
  'not-found': 404,
  'validation-failed': 422,
  'unsupported-media-type': 415,
  conflict: 409,
  'precondition-failed': 412,
  'idempotency-key-reused': 409,
  'quota-exceeded': 413,
  'insufficient-storage': 507,
  'upload-offset-mismatch': 409,
  'checksum-mismatch': 422,
  'rate-limited': 429,
  'dependency-unavailable': 503,
  'operation-in-progress': 409,
  'internal-error': 500,
};

const TITLE_BY_CODE: Record<ErrorCode, string> = {
  unauthenticated: 'Kimlik doğrulaması gerekli',
  'invalid-credentials': 'Kimlik bilgileri geçersiz',
  'mfa-required': 'İki adımlı doğrulama gerekli',
  'mfa-invalid': 'İki adımlı doğrulama kodu geçersiz',
  'session-expired': 'Oturum süresi doldu',
  forbidden: 'Bu işlem için yetkiniz yok',
  'not-found': 'Kaynak bulunamadı',
  'validation-failed': 'Girdi doğrulanamadı',
  'unsupported-media-type': 'Desteklenmeyen içerik türü',
  conflict: 'Çakışma',
  'precondition-failed': 'Ön koşul sağlanmadı',
  'idempotency-key-reused': 'Idempotency anahtarı farklı bir istekle kullanılmış',
  'quota-exceeded': 'Kota aşıldı',
  'insufficient-storage': 'Yetersiz depolama alanı',
  'upload-offset-mismatch': 'Yükleme konumu uyuşmuyor',
  'checksum-mismatch': 'Sağlama toplamı uyuşmuyor',
  'rate-limited': 'Çok fazla istek',
  'dependency-unavailable': 'Servis geçici olarak kullanılamıyor',
  'operation-in-progress': 'Bu kaynak üzerinde başka bir işlem sürüyor',
  'internal-error': 'Beklenmeyen bir hata oluştu',
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function problem(
  code: ErrorCode,
  correlationId: string,
  extra: Partial<Omit<ProblemDetails, 'code' | 'correlationId' | 'type' | 'status' | 'title'>> = {},
): ProblemDetails {
  return {
    type: `${PROBLEM_BASE_URI}${code}`,
    title: TITLE_BY_CODE[code],
    status: STATUS_BY_CODE[code],
    code,
    correlationId,
    ...extra,
  };
}

/**
 * Decide between 404 and 403 without leaking existence.
 *
 * The rule (master prompt §14, and the tenant-isolation criterion in §18.2):
 *
 *   - If the caller cannot even LIST the parent, they must not learn that the resource exists.
 *     Return 404 — identical to the response for a genuinely absent resource.
 *   - Only once the caller demonstrably knows the resource exists (they can list its parent)
 *     is 403 safe, and then it is strictly more useful than 404.
 *
 * Getting this backwards turns every 403 into an existence oracle. That is the API-layer
 * counterpart of the constraint covert channel documented in ADR-0013 §2.2.
 */
export function notFoundOrForbidden(
  canSeeParent: boolean,
): Extract<ErrorCode, 'not-found' | 'forbidden'> {
  return canSeeParent ? 'forbidden' : 'not-found';
}
