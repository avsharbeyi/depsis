import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { ReauthService } from '../auth/reauth.service.js';
import type { JobsService } from '../jobs/jobs.service.js';
import { PoolsController } from './pools.controller.js';
import type { SystemService } from './system.service.js';

/**
 * The gate in front of the one route in this API that erases disks.
 *
 * §8.1's sequence is administrator, written confirmation, re-authentication, job — in that order,
 * and the ORDER is part of what is tested here: somebody who mistyped the confirmation must not be
 * asked to hand over their password to find that out.
 *
 * What is deliberately NOT tested here, because it is deliberately not done here: that the disks
 * are blank, that they exist, and that none of them is the system disk. Those live in the agent,
 * checked against an inventory it reads for itself immediately before creating the pool. A check
 * in this process would be a check against a list this process was handed.
 */

const VALID = {
  name: 'tank',
  topology: 'mirror' as const,
  disks: [
    { byId: 'ata-A', wwn: '0xA' },
    { byId: 'ata-B', wwn: '0xB' },
  ],
  confirm: 'tank',
  password: 'the-right-one',
};

function request(): AuthenticatedRequest {
  return {
    depsis: { userId: 'u-1', organizationId: 'o-1', role: 'admin' },
  } as unknown as AuthenticatedRequest;
}

function controller(options: {
  admin?: boolean;
  passwordOk?: boolean;
  poolExists?: boolean | (() => Promise<boolean>);
  enqueue?: ReturnType<typeof vi.fn>;
}): { controller: PoolsController; enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = options.enqueue ?? vi.fn().mockResolvedValue('job-1');
  const system = {
    isSystemAdministrator: () => Promise.resolve(options.admin ?? true),
    poolExists:
      typeof options.poolExists === 'function'
        ? options.poolExists
        : () => Promise.resolve(options.poolExists ?? false),
  } as unknown as SystemService;
  const jobs = { enqueue } as unknown as JobsService;
  // A stub for the SHARED re-authentication, which is measured on its own in
  // `reauth.service.test.ts` — including the throttling and the recording, which is the half this
  // route used to be missing entirely.
  const reauth = {
    require: (_org: string, _user: string, given: string) =>
      (options.passwordOk ?? true) && given === VALID.password
        ? Promise.resolve()
        : Promise.reject(new UnauthorizedException('the password is wrong')),
  } as unknown as ReauthService;

  // The agent is only reached by the scrub routes, which this file does not exercise: what it
  // measures is §8.1's sequence in front of pool creation. A stub that throws would make an
  // accidental call loud rather than silent.
  const agent = {
    call: () => Promise.reject(new Error('this suite does not drive the agent')),
  } as unknown as AgentService;
  // Denetim gerçek tabloya yazamaz — bu dosya veritabanısız çalışıyor. Kayıt çağrısının
  // kendisi bu suite'in ölçtüğü şey değil; sessiz bir stub yeter.
  const audit = { record: () => Promise.resolve() } as unknown as AuditService;
  return { controller: new PoolsController(system, jobs, reauth, agent, audit), enqueue };
}

describe('POST /storage/pools', () => {
  it('refuses somebody who is not the system administrator', async () => {
    const { controller: c, enqueue } = controller({ admin: false });
    await expect(c.create(request(), VALID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one job, with one attempt, and without the password in it', async () => {
    // `maxAttempts: 1` is the difference between this and every other kind in the queue. A retry
    // after an ambiguous failure is the request nobody wants made twice on their behalf against
    // real disks. And the password proved the person at the keyboard; putting it in a jsonb column
    // that outlives the request, is read by `GET /jobs` and ends up in `job_history` would keep it
    // long after its job was done.
    const { controller: c, enqueue } = controller({});
    const answer = await c.create(request(), VALID);

    expect(answer).toEqual({ jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, kind, payload, options] = enqueue.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(kind).toBe('storage.pool.create');
    expect(options).toMatchObject({ maxAttempts: 1 });
    expect(payload).not.toHaveProperty('password');
    expect(payload).not.toHaveProperty('confirm');
    expect(payload['disks']).toEqual(VALID.disks);
    expect(payload['requestedBy']).toBe('u-1');
  });

  it('asks for the confirmation BEFORE the password', async () => {
    // Order, not just presence. Somebody who mistyped the confirmation should not have to hand
    // over their password to be told so.
    const { controller: c, enqueue } = controller({ passwordOk: false });
    await expect(
      c.create(request(), { ...VALID, confirm: 'tnak', password: 'also-wrong' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that is not the pool name', async () => {
    const { controller: c } = controller({});
    for (const confirm of ['', 'TANK', 'tank ', 'yes']) {
      await expect(c.create(request(), { ...VALID, confirm })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('refuses a wrong password even with a valid session', async () => {
    // §0.5: an operation carrying this much risk is not performed on the strength of a cookie.
    const { controller: c, enqueue } = controller({});
    await expect(
      c.create(request(), { ...VALID, password: 'not-the-right-one' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a pool name the machine already has', async () => {
    const { controller: c, enqueue } = controller({ poolExists: true });
    await expect(c.create(request(), VALID)).rejects.toBeInstanceOf(ConflictException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still enqueues when the existence check itself could not be answered', async () => {
    // The check is the courteous half, not the enforcing one: the agent refuses a duplicate pool
    // too, with better words. Treating "we could not ask" as "it exists" would make an unreachable
    // agent look like a name collision.
    const { controller: c, enqueue } = controller({
      poolExists: () => Promise.reject(new Error('socket is gone')),
    });
    await expect(c.create(request(), VALID)).resolves.toEqual({ jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses a pool name that a command line would read as a flag', async () => {
    // P0-E: every tool in this product parses its own argv, so a leading `-` is an option however
    // it was passed. The agent refuses it by construction too; this is the readable 400.
    const { controller: c } = controller({});
    for (const name of ['-f', '1tank', 'tank/child', 'tank space', '']) {
      await expect(c.create(request(), { ...VALID, name, confirm: name })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('refuses a body that names no disks, or more than one call should carry', async () => {
    const { controller: c } = controller({});
    await expect(c.create(request(), { ...VALID, disks: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const many = Array.from({ length: 25 }, (_, n) => ({ byId: `ata-${n}`, wwn: `0x${n}` }));
    await expect(c.create(request(), { ...VALID, disks: many })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a disk with no WWN to check against', async () => {
    // The WWN is the only part of the confirmation that survives somebody swapping a disk between
    // the wizard and the job. A blank one would reach the agent and be refused there; refusing it
    // here makes it a 400 about the request rather than a 409 about the machine.
    const { controller: c } = controller({});
    await expect(
      c.create(request(), { ...VALID, disks: [{ byId: 'ata-A', wwn: '' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an arrangement it does not know', async () => {
    const { controller: c } = controller({});
    await expect(
      c.create(request(), { ...VALID, topology: 'stripe' as unknown as 'mirror' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
