import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  PROBLEM_BASE_URI,
  notFoundOrForbidden,
  problem,
  problemDetailsSchema,
  statusForCode,
  type ErrorCode,
} from './errors.js';
import type { components } from './generated/api.js';

describe('problem()', () => {
  it('produces a body that validates against the schema', () => {
    const p = problem('forbidden', 'corr-123');
    expect(() => problemDetailsSchema.parse(p)).not.toThrow();
    expect(p.type).toBe(`${PROBLEM_BASE_URI}forbidden`);
    expect(p.status).toBe(403);
    expect(p.correlationId).toBe('corr-123');
  });

  it('carries a correlation id on every problem — §14 requires it on every response', () => {
    for (const code of ERROR_CODES) {
      const p = problem(code, 'corr-x');
      expect(p.correlationId).toBe('corr-x');
      expect(problemDetailsSchema.safeParse(p).success).toBe(true);
    }
  });

  it('maps every code to a status in the 4xx/5xx range', () => {
    for (const code of ERROR_CODES) {
      const s = statusForCode(code);
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThanOrEqual(599);
    }
  });

  it('rejects a body whose status is outside the error range', () => {
    const bad = { ...problem('forbidden', 'c'), status: 200 };
    expect(problemDetailsSchema.safeParse(bad).success).toBe(false);
  });
});

/**
 * Kapalı küme gerçekten sözleşmeye ulaşıyor mu?
 *
 * `ERROR_CODES` "istemci metin karşılaştırması yapmasın" diye kapalı bir küme, ama OpenAPI'de
 * `code` düz `string` ilan edilmişti: üretilen istemci tipi de `code: string` oluyordu. Yani
 * `name-taken` bir gün `name-conflict` olarak yeniden adlandırılsaydı derleme yeşil kalır, web
 * yükleme çakışmasında kullanıcıya "değiştir mi, ikisini de tut mu" diye sormayı bırakır ve
 * yerine genel bir hata gösterirdi — `errors.ts`teki yorumun tam olarak engellemek istediği
 * kırılma, bu kez kodun ADI üzerinden.
 *
 * Belgeye bir enum yazmak tek başına ikinci bir liste demek, ve iki liste sessizce ayrışır.
 * Aşağıdaki tip eşitliği o ayrışmayı derleme hatasına çeviriyor: `ContractCode` üretilen
 * `api.d.ts`ten geliyor, `api.d.ts` `generate:check` ile belgeye bağlı, belge de bu iddiayla
 * `ERROR_CODES`a bağlanıyor. Zincirin bir halkası koparsa `pnpm typecheck` düşer.
 */
type ContractCode = components['schemas']['ProblemDetails']['code'];

/** Çift yönlü: eksik bir kod da, belgede olup burada olmayan bir kod da `false` üretir. */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** `true` dışında bir şey verilirse tip kontrolü burada durur. */
type AssertTrue<T extends true> = T;

export type ErrorCodesMatchTheContract = AssertTrue<SameSet<ErrorCode, ContractCode>>;

describe('ERROR_CODES ile belgenin kapalı kümesi', () => {
  it('her kodu belgenin kabul ettiği bir değer olarak taşıyor', () => {
    // Atamanın kendisi `ERROR_CODES ⊆ ContractCode` iddiası; ters yönü yukarıdaki tip eşitliği
    // taşıyor. Çalışma zamanında kalan iş, listenin kendini tekrarlamadığını doğrulamak: aynı
    // kodun iki kez yazılması `statusForCode` haritasında sessizce birinin diğerini ezmesi olurdu.
    const asContract: ContractCode[] = [...ERROR_CODES];
    expect(new Set(asContract).size).toBe(ERROR_CODES.length);
  });
});

describe('notFoundOrForbidden — the existence oracle rule', () => {
  // Getting this backwards turns every 403 into a way to probe for hidden files, which is the
  // API-layer version of the constraint covert channel in ADR-0013 §2.2 and would break the
  // §18.2 criterion "user A cannot see user B's filename".

  it('returns not-found when the caller cannot see the parent', () => {
    expect(notFoundOrForbidden(false)).toBe('not-found');
  });

  it('returns forbidden only once the caller already knows the resource exists', () => {
    expect(notFoundOrForbidden(true)).toBe('forbidden');
  });

  it('makes a hidden resource indistinguishable from an absent one', () => {
    // Absent resource: the caller can list the parent but the child is not there. The handler
    // would produce 'not-found'. A resource that exists but is invisible must produce exactly
    // the same status, or the difference itself is the leak.
    const hiddenFromCaller = statusForCode(notFoundOrForbidden(false));
    const genuinelyAbsent = statusForCode('not-found');
    expect(hiddenFromCaller).toBe(genuinelyAbsent);
  });
});
