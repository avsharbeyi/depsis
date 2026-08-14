import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  PROBLEM_BASE_URI,
  notFoundOrForbidden,
  problem,
  problemDetailsSchema,
  statusForCode,
} from './errors.js';

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
