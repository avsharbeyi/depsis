import { of, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { ProblemException } from './problem.filter.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';

/**
 * §14'ün hız sınırı.
 *
 * Ölçülen iki şey var ve ikisi de aynı ağırlıkta: taşkın bir istemcinin kesildiği, VE sıradan
 * kullanımın kesilmediği. Bir sınırın çalışan bir ürünü bozması, olmayan bir sınırdan kötüdür.
 */

interface Who {
  userId?: string;
  ip?: string;
  method?: string;
  url?: string;
}

function contextFor({ userId, ip = '10.0.0.5', method = 'GET', url = '/api/v1/search' }: Who) {
  const request = {
    method,
    url,
    ip,
    depsis: userId === undefined ? undefined : { userId },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const handler: CallHandler = { handle: (): Observable<unknown> => of('ok') };

/** Send `n` requests and return how many were refused. */
function flood(limiter: RateLimitInterceptor, who: Who, n: number): number {
  let refused = 0;
  for (let i = 0; i < n; i += 1) {
    try {
      limiter.intercept(contextFor(who), handler);
    } catch {
      refused += 1;
    }
  }
  return refused;
}

describe('the rate limit', () => {
  it('lets ordinary use through', () => {
    // İki yüz küçük resmi olan bir klasörü açmak tek bir yol anahtarında iki yüz istek demek. Bu
    // rakam bütçenin altında olmak zorunda, yoksa sınırın kendisi bir arıza olur.
    const limiter = new RateLimitInterceptor();
    expect(flood(limiter, { userId: 'ayse', url: '/api/v1/files/x/thumbnail' }, 200)).toBe(0);
  });

  it('cuts off a flood on one endpoint', () => {
    // Senaryo: `GET /search?q=a`, saniyede yüzlerce kez, her biri bir pg_trgm taraması.
    const limiter = new RateLimitInterceptor();
    const refused = flood(limiter, { userId: 'ayse' }, RateLimitInterceptor.MAX_PER_WINDOW + 5);
    expect(refused).toBe(5);
  });

  it('answers with a 429 that says when to come back', () => {
    const limiter = new RateLimitInterceptor();
    flood(limiter, { userId: 'ayse' }, RateLimitInterceptor.MAX_PER_WINDOW);
    try {
      limiter.intercept(contextFor({ userId: 'ayse' }), handler);
      expect.unreachable('the request past the budget must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemException);
      const problem = error as ProblemException;
      expect(problem.code).toBe('rate-limited');
      expect(problem.getStatus()).toBe(429);
      expect(problem.retryAfter ?? 0).toBeGreaterThan(0);
    }
  });

  it('does not spend one person’s budget on another’s behalf', () => {
    // Anahtarın "kim" yarısı. Yalnız adrese bakan bir sınır — nginx'in `$binary_remote_addr`ı —
    // aynı evdeki iki kişiyi tek bir bütçeye koyar, ve ters vekilin arkasında bütün ev tek bir
    // adrestir.
    const limiter = new RateLimitInterceptor();
    flood(limiter, { userId: 'ayse' }, RateLimitInterceptor.MAX_PER_WINDOW);
    expect(flood(limiter, { userId: 'veli' }, 1)).toBe(0);
  });

  it('does not let a flood on one endpoint close another', () => {
    // Anahtarın "ne" yarısı: aramayı yoran bir sekme dosya listesini kapatmamalı.
    const limiter = new RateLimitInterceptor();
    flood(limiter, { userId: 'ayse' }, RateLimitInterceptor.MAX_PER_WINDOW);
    expect(flood(limiter, { userId: 'ayse', url: '/api/v1/files' }, 1)).toBe(0);
  });

  it('counts two ids on the same route as one action', () => {
    // Yoldaki kimlik `:id`ye indirgenmezse her dosya kendi bütçesiyle gelir ve sınır hiç ısırmaz.
    const limiter = new RateLimitInterceptor();
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const budget = RateLimitInterceptor.MAX_PER_WINDOW;
    flood(limiter, { userId: 'ayse', url: `/api/v1/files/${a}` }, budget);
    expect(flood(limiter, { userId: 'ayse', url: `/api/v1/files/${b}` }, 1)).toBe(1);
  });

  it('never touches the stream or an upload in progress', () => {
    // `/events` uzun ömürlü tek bir bağlantı ve zaten sayılı; on gigabaytlık bir yükleme ise
    // tanım gereği binlerce PATCH eder ve onu kesmek yüklemenin kendisini bozar (ADR-0008).
    const limiter = new RateLimitInterceptor();
    expect(flood(limiter, { userId: 'ayse', url: '/api/v1/events' }, 5_000)).toBe(0);
    expect(
      flood(limiter, { userId: 'ayse', method: 'PATCH', url: '/api/v1/uploads/abc' }, 5_000),
    ).toBe(0);
  });
});
