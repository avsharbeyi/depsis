import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { EXPECTED_SCHEMA_VERSION } from '@depsis/agent-protocol';

import {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  expectStatus,
  type AgentResponse,
} from './agent.service.js';

/**
 * These run against a REAL local stream socket, not a mocked `net` module.
 *
 * On Linux that is an AF_UNIX socket — the same kind the agent listens on. On Windows, where
 * AF_UNIX filesystem sockets are not available to Node the way they are on Linux, it is a named
 * pipe. `net.createConnection({path})` drives both, and everything asserted below — framing,
 * ordering, deadlines, parse failures — is transport-independent.
 *
 * What that does NOT cover, and what ADR-0007 forbids reporting as if it did: SO_PEERCRED, the
 * socket's DAC bits, systemd socket activation, and the agent's own parsing. Those are properties
 * of the deployed pair and are measured by tools/poc/p0-e-agent-boundary.sh on the VM. A green run
 * here means this client speaks the protocol correctly; it says nothing about the boundary holding.
 *
 * One measured difference between the two transports shapes the helpers below. A Windows named pipe
 * DISCARDS buffered data when the handle closes: writing a response and closing in the same tick
 * lost the payload in 2 of 6 attempts, with the client seeing EOF and zero bytes even though
 * `write()` had returned true. Separating the write from the close was 6 of 6. A Unix socket has no
 * such behaviour: measured under WSL2 (Linux 6.6), a server that writes and closes in the same tick
 * — which is exactly what the agent does — delivered 20 of 20. The delay in `answerRaw()` therefore
 * exists to make the FAKE behave like a Unix socket, not to paper over anything in the client.
 */

interface Fake {
  path: string;
  /** Every request line the server received, in arrival order. */
  received: string[];
  /**
   * The most requests ever outstanding at once — received but not yet answered.
   *
   * NOT a count of open sockets, which is what an earlier version of this measured and why it read
   * 2 for a client that is provably serial: the client destroys its socket the instant it has the
   * response line and connects again immediately, while the server's `close` for the previous
   * connection lands a tick later. Two sockets briefly exist; two REQUESTS never do. Counting
   * request-to-answer measures the invariant being claimed instead of a socket-reaping artefact.
   */
  peakInFlight: number;
  close: () => Promise<void>;
}

/**
 * `reply` writes a well-formed answer and closes the outstanding request. Handlers that need to
 * send something deliberately malformed write to `socket` directly.
 */
type Handler = (
  line: string,
  socket: Socket,
  reply: (response: AgentResponse | Record<string, unknown>) => void,
) => void;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

function socketPath(): string {
  // A named pipe on Windows, a filesystem socket everywhere else. Randomised because a leftover
  // path from a crashed run would otherwise make the next run connect to nothing.
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\depsis-agent-test-${randomUUID()}`
    : join(tmpdir(), `depsis-agent-test-${randomUUID()}.sock`);
}

async function fakeAgent(handler: Handler): Promise<Fake> {
  const path = socketPath();
  const fake: Fake = {
    path,
    received: [],
    peakInFlight: 0,
    close: () => Promise.resolve(),
  };
  let inFlight = 0;
  const live = new Set<Socket>();

  // allowHalfOpen so the fake keeps its read side open after the client's, matching the agent,
  // which reads a line and then writes on the same descriptor.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    // Errors here are expected: the client destroys the socket on timeout while the fake may still
    // be holding it. Without a listener that becomes an unhandled 'error' event and kills the run.
    socket.on('error', () => undefined);

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      fake.received.push(line);

      inFlight += 1;
      fake.peakInFlight = Math.max(fake.peakInFlight, inFlight);
      let answered = false;
      handler(line, socket, (response) => {
        if (answered) return;
        answered = true;
        inFlight -= 1;
        answerRaw(socket, JSON.stringify(response) + '\n');
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });

  fake.close = async () => {
    // Destroy the server's own sockets first. `server.close()` waits for open connections, and a
    // named pipe whose client has already destroyed its end does not always report the close to the
    // server — measured: the callback simply never fired, hanging the afterEach hook for its full
    // 10s timeout. Tearing them down from this side makes cleanup deterministic on both platforms.
    for (const socket of live) socket.destroy();
    live.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await unlink(path).catch(() => undefined);
  };
  servers.push(fake.close);
  return fake;
}

/**
 * Write bytes and then close, the way the agent does.
 *
 * The close is deferred by a tick-and-a-bit rather than folded into `end(data)` because of the
 * named-pipe discard described at the top of this file: on Linux the two are equivalent, on Windows
 * the combined form loses the payload often enough to make every test here intermittently red.
 */
function answerRaw(socket: Socket, bytes: string): void {
  socket.write(bytes);
  setTimeout(() => socket.end(), 25);
}

describe('AgentService, speaking to a real socket', () => {
  it('sends one line carrying the request inside an audit envelope', async () => {
    const fake = await fakeAgent((_line, _socket, reply) => {
      reply({ status: 'created', dataset: 'tank/data' });
    });
    const agent = new AgentService(fake.path, 2_000);

    const response = await agent.call(
      { op: 'create_dataset', dataset: 'tank/data', acltype: 'posixacl', refquota_bytes: 1024 },
      'operator asked for a new share',
      'req-42',
    );

    expect(response).toEqual({ status: 'created', dataset: 'tank/data' });
    expect(fake.received).toHaveLength(1);

    const sent = JSON.parse(fake.received[0] ?? '') as Record<string, unknown>;
    expect(sent['correlation_id']).toBe('req-42');
    expect(sent['reason']).toBe('operator asked for a new share');
    expect(sent['request']).toMatchObject({ op: 'create_dataset', dataset: 'tank/data' });
  });

  it('sanitises the envelope before it reaches the agent', async () => {
    const fake = await fakeAgent((_line, _socket, reply) =>
      reply({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION }),
    );
    const agent = new AgentService(fake.path, 2_000);

    // A newline in the reason is a log-injection primitive against an append-only audit trail, and
    // it would also break the framing: the agent would read the first half as a whole request.
    await agent.call({ op: 'ping' }, 'line one' + String.fromCharCode(10) + 'FAKE ENTRY', 'c-1');

    const line = fake.received[0] ?? '';
    expect(line.includes(String.fromCharCode(10))).toBe(false);
    expect((JSON.parse(line) as { reason: string }).reason).toBe('line one FAKE ENTRY');
  });

  it('rejects a correlation id that cannot identify anything, without opening a connection', async () => {
    const fake = await fakeAgent((_line, _socket, reply) =>
      reply({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION }),
    );
    const agent = new AgentService(fake.path, 2_000);

    await expect(agent.call({ op: 'ping' }, 'why', '   ')).rejects.toThrow(/correlation id/);
    // The point of failing at the call site: nothing privileged was attempted.
    expect(fake.received).toHaveLength(0);
  });

  it('makes one call at a time even when callers do not', async () => {
    const fake = await fakeAgent((_line, _socket, reply) => {
      // Answer slowly, so an overlapping request would be visible if one happened.
      setTimeout(() => reply({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION }), 40);
    });
    const agent = new AgentService(fake.path, 5_000);

    await Promise.all(
      Array.from({ length: 5 }, (_v, i) => agent.call({ op: 'ping' }, `call ${i}`, `c-${i}`)),
    );

    expect(fake.received).toHaveLength(5);
    // The assertion that matters. The agent accepts one connection at a time; if this client
    // opened five at once, four would sit in the kernel backlog and a slow operation would start
    // producing connection errors that name nothing.
    expect(fake.peakInFlight).toBe(1);
    // And they went out in the order they were asked for, which is what makes the audit log a
    // history rather than a set.
    expect(fake.received.map((l) => (JSON.parse(l) as { reason: string }).reason)).toEqual([
      'call 0',
      'call 1',
      'call 2',
      'call 3',
      'call 4',
    ]);
  });

  it('gives up on a silent agent and stays usable afterwards', async () => {
    let answerThis = false;
    const fake = await fakeAgent((_line, _socket, reply) => {
      if (answerThis) reply({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION });
      // Otherwise: accept the line and say nothing at all.
    });
    const agent = new AgentService(fake.path, 150);

    await expect(agent.call({ op: 'ping' }, 'first', 'c-1')).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );

    // A failed call must not poison the queue. An earlier draft chained with `.then(onOk, onErr)`
    // in a way that made every later call reject with the FIRST call's error, which would have
    // turned one timeout into a permanently broken agent connection.
    answerThis = true;
    await expect(agent.call({ op: 'ping' }, 'second', 'c-2')).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('treats a closed connection and a truncated answer as failures, not as answers', async () => {
    const silent = await fakeAgent((_line, socket) => socket.end());
    await expect(
      new AgentService(silent.path, 2_000).call({ op: 'ping' }, 'r', 'c'),
    ).rejects.toThrow(/without answering/);

    // No trailing newline. The bytes parse as valid JSON, so a client that simply parsed whatever
    // arrived on 'end' would accept a half-delivered response as a complete one.
    const truncated = await fakeAgent((_line, socket) => {
      socket.write(`{"status":"ok","schema_version":${EXPECTED_SCHEMA_VERSION}}`);
      setTimeout(() => socket.end(), 25);
    });
    await expect(
      new AgentService(truncated.path, 2_000).call({ op: 'ping' }, 'r', 'c'),
    ).rejects.toThrow(/terminating newline/);
  });

  it('reassembles an answer that arrives in pieces', async () => {
    const fake = await fakeAgent((_line, socket) => {
      socket.write('{"status":"pool_status","health":"ONLINE",');
      setTimeout(() => socket.write('"used_bytes":1,"available_bytes":2}\n'), 20);
      setTimeout(() => socket.end(), 45);
    });

    await expect(
      new AgentService(fake.path, 2_000).call({ op: 'pool_status', pool: 'tank' }, 'r', 'c'),
    ).resolves.toEqual({
      status: 'pool_status',
      health: 'ONLINE',
      used_bytes: 1,
      available_bytes: 2,
    });
  });

  it('refuses to hand back something that is not a response', async () => {
    const garbage = await fakeAgent((_line, socket) => answerRaw(socket, 'not json\n'));
    await expect(
      new AgentService(garbage.path, 2_000).call({ op: 'ping' }, 'r', 'c'),
    ).rejects.toThrow(/unparseable/);

    // Valid JSON with no discriminant. The generated types describe what the agent promises, which
    // is not the same as what arrived on a socket; without this check `undefined` reaches a switch.
    const shapeless = await fakeAgent((_line, socket) => answerRaw(socket, '{"ok":true}\n'));
    await expect(
      new AgentService(shapeless.path, 2_000).call({ op: 'ping' }, 'r', 'c'),
    ).rejects.toThrow(/no status field/);
  });
});

describe('the startup handshake', () => {
  it('marks the agent available only when the versions agree', async () => {
    const matching = await fakeAgent((_l, _s, reply) =>
      reply({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION }),
    );
    const good = new AgentService(matching.path, 2_000);
    expect(good.isAvailable()).toBe(false);
    await good.onModuleInit();
    expect(good.isAvailable()).toBe(true);

    // A stale agent paired with a fresh API parses requests successfully and means something else
    // by them. That has to be caught while somebody is watching a deployment.
    // Any number that is not the expected one. Written as an arithmetic offset rather than a
    // literal so that bumping the protocol cannot silently turn this case into the matching one.
    const stale = await fakeAgent((_l, _s, reply) =>
      reply({ status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION - 1 }),
    );
    const bad = new AgentService(stale.path, 2_000);
    await bad.onModuleInit();
    expect(bad.isAvailable()).toBe(false);
  });

  it('does not throw when there is no agent at all', async () => {
    // A development machine has no socket. Refusing to start would mean the API only runs on Linux.
    const absent = new AgentService(null);
    await expect(absent.onModuleInit()).resolves.toBeUndefined();
    expect(absent.isAvailable()).toBe(false);
    await expect(absent.call({ op: 'ping' }, 'r', 'c')).rejects.toThrow(/not configured/);

    // Configured but unreachable is the same outcome for callers, and a loud log for operators.
    const missing = new AgentService(socketPath(), 2_000);
    await expect(missing.onModuleInit()).resolves.toBeUndefined();
    expect(missing.isAvailable()).toBe(false);
  });
});

describe('expectStatus', () => {
  it('turns a refusal into a refusal rather than a missing field', () => {
    const refused: AgentResponse = { status: 'refused', reason: 'dataset name is not safe' };
    // The trap this exists for: `refused` and `failed` are ordinary answers on this wire. A caller
    // that only tested for its own variant would read `.dataset` off a refusal and get undefined.
    expect(() => expectStatus(refused, 'created')).toThrow(AgentRefusedError);
    expect(() => expectStatus(refused, 'created')).toThrow(/dataset name is not safe/);

    const failed: AgentResponse = { status: 'failed', reason: 'zfs exited 1' };
    expect(() => expectStatus(failed, 'created')).toThrow(AgentRefusedError);
  });

  it('distinguishes the wrong answer from a refusal', () => {
    const wrong: AgentResponse = { status: 'ok', schema_version: EXPECTED_SCHEMA_VERSION };
    expect(() => expectStatus(wrong, 'created')).toThrow(AgentUnavailableError);
  });

  it('narrows to the expected variant', () => {
    const created: AgentResponse = { status: 'created', dataset: 'tank/x' };
    expect(expectStatus(created, 'created').dataset).toBe('tank/x');
  });
});
