import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { JobsController } from './jobs.controller.js';
import type { Job, JobsService } from './jobs.service.js';

/**
 * What this controller decides before anything reaches PostgreSQL.
 *
 * A fake service is right here, and only here: what is being measured is the shape of the id and
 * what happens to a missing row, neither of which is a property of the database. Everything the
 * queue itself promises is measured in `jobs.integration.test.ts` against a real one.
 */

interface Calls {
  found: string[];
}

function controller(job: Job | null): [JobsController, Calls] {
  const calls: Calls = { found: [] };
  const jobs = {
    find: (_org: string, id: string) => {
      calls.found.push(id);
      return Promise.resolve(job);
    },
  } as unknown as JobsService;
  return [new JobsController(jobs), calls];
}

const request = {
  depsis: {
    sessionId: 's',
    organizationId: 'org',
    userId: 'u',
    role: 'admin',
    expiresAt: new Date(),
  },
} as unknown as AuthenticatedRequest;

const A_JOB: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'files.copy',
  status: 'running',
  progress: 0.5,
  createdAt: new Date(),
  lastError: null,
};

describe('GET /jobs/{jobId}', () => {
  it('answers a malformed id with 404 and never asks the database', async () => {
    // `find_job(p_id uuid)` bir uuid bekliyor: doğrulanmadan geçirilen `abc` PostgreSQL'de 22P02
    // fırlatıyor, ve `HttpException` olmadığı için filtre bunu 500 `internal-error` yapıp her
    // istekte günlüğe yığın izi yazıyordu. Bozuk bir bağlantı sunucu hatası değildir.
    const [jobs, calls] = controller(A_JOB);
    await expect(jobs.find(request, 'abc')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.found, 'the malformed id must not reach the query').toEqual([]);
  });

  it('still answers a well-formed id', async () => {
    const [jobs] = controller(A_JOB);
    await expect(jobs.find(request, A_JOB.id)).resolves.toMatchObject({ id: A_JOB.id });
  });

  it('answers a job in another tenant exactly as it answers one that never existed', async () => {
    // RLS ikisini aynı sorgu sonucu yapıyor, ve ikisi aynı CEVAP da olmalı: 403 burada kimliğin
    // gerçek bir şeyi adlandırdığını doğrular ve ucu bir kehanete çevirirdi.
    const [jobs, calls] = controller(null);
    await expect(jobs.find(request, A_JOB.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.found).toEqual([A_JOB.id]);
  });
});
