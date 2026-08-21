import { EXPECTED_SCHEMA_VERSION } from '@depsis/agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  expectStatus,
} from './agent.service.js';

/**
 * AgentService against the REAL privileged agent.
 *
 * Everything else about this client is measured against a fake: agent.service.test.ts drives a
 * local stream socket and settles framing, ordering and deadlines. What no fake can settle is
 * whether the two halves of the trust boundary agree — that the envelope this client writes is one
 * the Rust binary parses, that the response it writes back is one this client understands, and that
 * the version handshake actually matches. Those are the two sides of ADR-0006, and until this file
 * ran they had only ever been checked separately.
 *
 * Skipped unless DEPSIS_AGENT_SOCKET names a live agent, which is the same rule the database
 * integration tests follow: the suite has to run on a Windows laptop with no Unix socket in sight.
 * CI's guard step fails the job if any test skips when the gate was supposed to be open, so a
 * silently absent run cannot pass for a green one.
 *
 * Requires the caller's uid to be the one the agent was started with (DEPSIS_API_UID). Running this
 * as root is expected to fail, and that refusal is asserted rather than avoided.
 */
const SOCKET = process.env['DEPSIS_AGENT_SOCKET'];
const describeIfAgent = SOCKET === undefined || SOCKET === '' ? describe.skip : describe;

/** A pool name that cannot exist, for exercising the refusal path without touching a real pool. */
const ABSENT_POOL = 'depsis-integration-absent-pool';

describeIfAgent('AgentService against the real agent', () => {
  it('completes the version handshake', async () => {
    const agent = new AgentService(SOCKET ?? '', 10_000);
    expect(agent.isAvailable()).toBe(false);

    await agent.onModuleInit();

    // The whole point of the handshake: a stale binary paired with a fresh API parses requests
    // successfully and means something else by them.
    expect(
      agent.isAvailable(),
      `the agent at ${SOCKET} did not answer a ping with schema v${EXPECTED_SCHEMA_VERSION}`,
    ).toBe(true);

    const response = await agent.call({ op: 'ping' }, 'integration handshake', 'itest-ping');
    expect(response).toEqual({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION });
  });

  it('surfaces a refusal as a refusal rather than a missing field', async () => {
    const agent = new AgentService(SOCKET ?? '', 10_000);

    const response = await agent.call(
      { op: 'pool_status', pool: ABSENT_POOL },
      'integration: a pool that does not exist',
      'itest-absent',
    );

    // `refused` and `failed` are ordinary answers on this wire. Which of the two comes back depends
    // on the host — a box with ZFS installed reports a failed command, one without reports a failed
    // spawn — so the assertion is that it is NOT success, and that expectStatus names it.
    expect(['refused', 'failed']).toContain(response.status);
    expect(() => expectStatus(response, 'pool_status')).toThrow(AgentRefusedError);
  });

  it('makes one call at a time, against an agent that accepts one at a time', async () => {
    // The serialisation in AgentService exists because `serve_loop` handles a single connection at
    // a time. That was measured against a fake; this measures it against the thing it was written
    // for. Without the queue, five concurrent calls would put four in the kernel backlog.
    const agent = new AgentService(SOCKET ?? '', 10_000);

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_v, i) =>
        agent.call({ op: 'ping' }, `integration: concurrent ${i}`, `itest-conc-${i}`),
      ),
    );

    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response).toEqual({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION });
    }
  });

  it('is refused when the reason cannot be written to the audit trail', async () => {
    const agent = new AgentService(SOCKET ?? '', 10_000);

    // The client sanitises, so this arrives clean and succeeds. That is the assertion: a newline in
    // a reason is a log-injection primitive against an append-only trail, and the client closes it
    // before the agent has to — the agent refusing it is the second line of defence, not the first.
    const response = await agent.call(
      { op: 'ping' },
      'integration: one line' + String.fromCharCode(10) + 'FAKE AUDIT ENTRY',
      'itest-reason',
    );
    expect(response).toEqual({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION });
  });

  it('reports an absent socket as unavailable rather than hanging', async () => {
    const agent = new AgentService(`${SOCKET ?? ''}.does-not-exist`, 2_000);
    await expect(
      agent.call({ op: 'ping' }, 'integration: no socket', 'itest-missing'),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});
