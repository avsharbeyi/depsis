import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { ReauthService } from '../auth/reauth.service.js';
import type { JobsService } from '../jobs/jobs.service.js';
import type { BackupsService } from './backups.service.js';
import { OffsiteController } from './offsite.controller.js';
import type { SystemService } from './system.service.js';

/**
 * The gate in front of sending a copy of every file on this appliance to another machine.
 *
 * Two things are measured here and neither of them is in the agent's reach.
 *
 * FIRST, §8.1's sequence and its ORDER: administrator, written confirmation, re-authentication,
 * job. Somebody who mistyped the confirmation must not be asked to hand over their password to
 * find that out — the same rule `pools.controller.test.ts` pins for the route that erases disks.
 *
 * SECOND, the shape of the confirmation itself. It is `user@host:dataset` and not the dataset
 * alone, because the thing being destroyed is on ANOTHER machine and a local dataset of the same
 * name may well exist. A test that accepted the bare name would be pinning the wrong ritual.
 *
 * What is deliberately NOT tested here, because it is deliberately not done here: whether the
 * destination's host key is trusted, and whether an identity exists. Those live in the agent,
 * checked against files it owns immediately before it connects. A check in this process would be a
 * check against a list this process was handed.
 */

const PASSWORD = 'the-right-one';

const VALID = {
  host: 'yedek.ornek.org',
  port: 22,
  user: 'depsis',
  source: 'tank/depsis',
  snapshot: 'gunluk-2026-08-25',
  target: 'yedek/depsis',
  confirm: 'depsis@yedek.ornek.org:yedek/depsis',
  password: PASSWORD,
};

function request(): AuthenticatedRequest {
  return {
    depsis: { userId: 'u-1', organizationId: 'o-1', role: 'admin' },
    headers: {},
  } as unknown as AuthenticatedRequest;
}

const STATUS: AgentResponse = {
  status: 'offsite',
  has_identity: true,
  public_key: 'ssh-ed25519 AAAA depsis-offsite',
  fingerprint: '256 SHA256:abc depsis-offsite (ED25519)',
  trusted: ['yedek.ornek.org', '[other.example.org]:2222'],
};

function controller(options: {
  admin?: boolean;
  answer?: (request: AgentRequest) => AgentResponse;
  snapshots?: Awaited<ReturnType<BackupsService['inventory']>>;
  enqueue?: ReturnType<typeof vi.fn>;
}): {
  controller: OffsiteController;
  enqueue: ReturnType<typeof vi.fn>;
  calls: AgentRequest[];
} {
  const enqueue = options.enqueue ?? vi.fn().mockResolvedValue('job-1');
  const calls: AgentRequest[] = [];

  const system = {
    isSystemAdministrator: () => Promise.resolve(options.admin ?? true),
  } as unknown as SystemService;

  const agent = {
    call: (agentRequest: AgentRequest): Promise<AgentResponse> => {
      calls.push(agentRequest);
      return Promise.resolve(options.answer?.(agentRequest) ?? STATUS);
    },
  } as unknown as AgentService;

  const jobs = { enqueue } as unknown as JobsService;

  const reauth = {
    require: (_org: string, _user: string, given: string) =>
      given === PASSWORD
        ? Promise.resolve()
        : Promise.reject(new UnauthorizedException('the password is wrong')),
  } as unknown as ReauthService;

  const backups = {
    inventory: () =>
      Promise.resolve(
        options.snapshots === undefined
          ? [
              {
                dataset: VALID.source,
                name: VALID.snapshot,
                usedBytes: 1,
                createdAt: new Date('2026-08-25T03:00:00Z'),
              },
            ]
          : options.snapshots,
      ),
  } as unknown as BackupsService;

  return {
    controller: new OffsiteController(system, agent, jobs, reauth, backups),
    enqueue,
    calls,
  };
}

describe('off-site backup', () => {
  it('is closed to anybody who is not the system administrator', async () => {
    const { controller: c } = controller({ admin: false });
    // EVERY route, not just the destructive one. The public key is not a secret, but the list of
    // machines this appliance will send a copy of everything to is a map somebody could use.
    await expect(c.status(request())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.createIdentity(request())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.scan(request(), { host: VALID.host })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(c.replicate(request(), VALID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is closed to a request with no session at all', async () => {
    const { controller: c } = controller({});
    await expect(
      c.status({ headers: {} } as unknown as AuthenticatedRequest),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reports the identity and the trusted destinations', async () => {
    const { controller: c } = controller({});
    const status = await c.status(request());
    expect(status.hasIdentity).toBe(true);
    expect(status.publicKey).toContain('ssh-ed25519');
    expect(status.trusted).toEqual(['yedek.ornek.org', '[other.example.org]:2222']);
  });

  it('answers 409 when a key already exists, rather than replacing it', async () => {
    // Replacing is never the right answer: the far end's `authorized_keys` holds the public half of
    // the OLD key, so a silent regeneration turns every future replication into a permission error
    // at the far end, hours later, with nothing on this side saying why.
    const { controller: c } = controller({
      answer: () => ({ status: 'refused', reason: 'an off-site key already exists' }),
    });
    await expect(c.createIdentity(request())).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports an unreachable destination as unavailable, not as a fault of this box', async () => {
    // Off, firewalled, or not running SSH. The user's next move is to look at the far end, and a
    // 500 would send them looking at this one.
    const { controller: c } = controller({
      answer: () => ({ status: 'refused', reason: 'could not reach yedek.ornek.org' }),
    });
    await expect(c.scan(request(), { host: VALID.host })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('passes the scan through and keeps the fingerprints intact', async () => {
    const { controller: c, calls } = controller({
      answer: () => ({
        status: 'offsite_host_keys',
        keys: [
          {
            kind: 'ssh-ed25519',
            line: 'yedek.ornek.org ssh-ed25519 AAAA',
            fingerprint: '256 SHA256:xyz yedek.ornek.org (ED25519)',
          },
        ],
      }),
    });
    const page = await c.scan(request(), { host: VALID.host, port: 2222 });
    expect(page.items[0]?.fingerprint).toBe('256 SHA256:xyz yedek.ornek.org (ED25519)');
    // The port reaches the agent. It is half the `known_hosts` lookup key, and a key confirmed for
    // 22 must not authorise 2222.
    expect(calls[0]).toMatchObject({ op: 'offsite_scan_host', host: VALID.host, port: 2222 });
  });

  it('refuses a host key line the agent says is for another machine', async () => {
    // The substitution the whole compare-the-fingerprint ritual exists to prevent: a line checked
    // for one destination, stored as authorisation for a different one.
    const { controller: c } = controller({
      answer: () => ({
        status: 'refused',
        reason: 'that host key line is for "evil.example.org", not for "yedek.ornek.org"',
      }),
    });
    await expect(
      c.trust(request(), { host: VALID.host, line: 'evil.example.org ssh-ed25519 AAAA' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a mistyped confirmation BEFORE asking for the password', async () => {
    const { controller: c, enqueue } = controller({});
    await expect(
      c.replicate(request(), { ...VALID, confirm: 'yedek/depsis', password: 'anything' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('requires the full user@host:dataset, not the dataset alone', async () => {
    // A local dataset called `yedek/depsis` may well exist. What is being destroyed is on another
    // machine, and the string somebody types has to say which one.
    const { controller: c } = controller({});
    await expect(
      c.replicate(request(), { ...VALID, confirm: VALID.target }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a wrong password after a correct confirmation', async () => {
    const { controller: c, enqueue } = controller({});
    await expect(c.replicate(request(), { ...VALID, password: 'wrong' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a snapshot the pool does not hold', async () => {
    const { controller: c, enqueue } = controller({ snapshots: [] });
    await expect(c.replicate(request(), VALID)).rejects.toBeInstanceOf(ConflictException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one attempt, and never puts the password in the payload', async () => {
    const { controller: c, enqueue } = controller({});
    const accepted = await c.replicate(request(), VALID);
    expect(accepted.jobId).toBe('job-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, kind, payload, options] = enqueue.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      { maxAttempts?: number },
    ];
    expect(kind).toBe('storage.replicate-offsite');
    expect(payload).toMatchObject({
      source: VALID.source,
      snapshot: VALID.snapshot,
      host: VALID.host,
      port: 22,
      user: VALID.user,
      target: VALID.target,
      base: null,
    });
    // The password proved the person at the keyboard and its job is done. A job row outlives the
    // request, is readable through `GET /jobs`, and passes into `job_history`.
    expect(JSON.stringify(payload)).not.toContain(PASSWORD);
    // ONE attempt. `zfs recv -F` looks retryable — the same stream reapplies — but a retry after an
    // ambiguous failure destroys the far end again without knowing what state it reached, and over
    // a network an ambiguous failure is the ordinary case rather than the rare one.
    expect(options.maxAttempts).toBe(1);
  });

  it('refuses a host that could be read as an option', async () => {
    // `-oProxyCommand=…` as a hostname is command execution on THIS box. The agent refuses it too;
    // this is the edge refusing it before it ever becomes an operand.
    const { controller: c } = controller({});
    for (const host of ['-oProxyCommand=id', 'host name', 'host;id', 'fd00::1']) {
      await expect(c.scan(request(), { host }), host).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
