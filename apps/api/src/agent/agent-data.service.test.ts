import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentDataService,
  AgentOutOfSpaceError,
  AgentTransferFailedError,
} from './agent-data.service.js';
import { AgentUnavailableError } from './agent.service.js';

/**
 * A REAL local stream socket, speaking the agent's data protocol, not a mocked `net`.
 *
 * What that covers: framing, the two-phase exchange, the declared length, and what happens when a
 * body is short, long, or dies mid-stream. What it does NOT cover, and what ADR-0007 forbids
 * reporting as if it did: SO_PEERCRED, the socket's DAC bits, the transfer registry, and the
 * agent's own `ftruncate` rollback. Those belong to the deployed pair and are measured end to end
 * in `tools/poc/p1-d-systemd-deployment.sh`.
 */

interface FakeDataAgent {
  path: string;
  /** The preamble line of every connection, in arrival order. */
  preambles: string[];
  /** The payload bytes each connection delivered. */
  bodies: Buffer[];
  close: () => Promise<void>;
}

type Policy =
  | { kind: 'store' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'fail'; reason: string; failure: 'out_of_space' | 'io' | 'refused' }
  | { kind: 'vanish' };

function socketPath(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\depsis-data-test-${randomUUID()}`
    : join(tmpdir(), `depsis-data-test-${randomUUID()}.sock`);
}

/**
 * A fake that reads EXACTLY the declared length, the way the agent does.
 *
 * That detail is what makes the over-length test meaningful. A fake that drained whatever arrived
 * would accept a body longer than its preamble said and the client's guard would never be
 * exercised — and the real failure it prevents is a hang, which a permissive fake cannot produce.
 */
async function fakeDataAgent(policy: Policy): Promise<FakeDataAgent> {
  const path = socketPath();
  const fake: FakeDataAgent = {
    path,
    preambles: [],
    bodies: [],
    close: () => Promise.resolve(),
  };
  const live = new Set<Socket>();

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    socket.on('error', () => undefined);

    let buffered = Buffer.alloc(0);
    let want: number | null = null;
    let body = Buffer.alloc(0);

    const answer = (line: string): void => {
      // The write and the close are separated by a tick throughout this file: a Windows named pipe
      // DISCARDS buffered data when the handle closes, so writing and closing together loses the
      // payload. Measured in `agent.service.test.ts`; the same helper shape is used here.
      socket.write(`${line}\n`);
    };

    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);

      if (want === null) {
        const at = buffered.indexOf(0x0a);
        if (at < 0) return;
        const line = buffered.subarray(0, at).toString('utf8');
        fake.preambles.push(line);
        // The LEFTOVER, kept rather than dropped. A client that writes the preamble and its first
        // payload bytes in one syscall is the ordinary case, and a fake that discarded the tail
        // would silently pass a client that had lost it.
        buffered = buffered.subarray(at + 1);

        if (policy.kind === 'vanish') {
          socket.destroy();
          return;
        }
        if (policy.kind === 'refuse') {
          answer(JSON.stringify({ status: 'failed', reason: policy.reason, kind: 'refused' }));
          return;
        }
        want = (JSON.parse(line) as { length: number }).length;
        answer(JSON.stringify({ status: 'ready' }));
      }

      const take = Math.min(want - body.length, buffered.length);
      body = Buffer.concat([body, buffered.subarray(0, take)]);
      buffered = buffered.subarray(take);

      if (body.length === want) {
        fake.bodies.push(body);
        if (policy.kind === 'fail') {
          answer(JSON.stringify({ status: 'failed', reason: policy.reason, kind: policy.failure }));
        } else {
          answer(JSON.stringify({ status: 'stored', bytes: body.length }));
        }
        want = -1; // Nothing more is expected; further bytes are the client's bug, not ours.
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });

  fake.close = async () => {
    for (const socket of live) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function serviceFor(policy: Policy): Promise<[AgentDataService, FakeDataAgent]> {
  const fake = await fakeDataAgent(policy);
  cleanups.push(fake.close);
  return [new AgentDataService(fake.path), fake];
}

describe('the bulk data client', () => {
  it('declares what it is about to send, then sends exactly that', async () => {
    const [service, fake] = await serviceFor({ kind: 'store' });
    const body = Buffer.from('hello world');

    const stored = await service.send('tok', 0, body.length, Readable.from([body]));

    expect(stored).toBe(body.length);
    expect(JSON.parse(fake.preambles[0] ?? '{}')).toEqual({
      token: 'tok',
      offset: 0,
      length: 11,
    });
    expect(fake.bodies[0]?.toString('utf8')).toBe('hello world');
  });

  it('delivers a body split across many chunks whole, and still reads the answer', async () => {
    // This test does NOT measure the `end: false` given to `pipeline`, and an earlier version of it
    // claimed to. A mutation run flipped that option to `end: true` and this stayed green: on
    // AF_UNIX a half-close shuts only the write direction, so the reply comes back either way. The
    // option is kept for the transport where it was measured to matter — Windows named pipes, on
    // the control channel — and the honest name for what this checks is the one above.
    const [service, fake] = await serviceFor({ kind: 'store' });
    const chunks = Array.from({ length: 32 }, (_, i) => Buffer.from(`chunk-${i};`));
    const total = chunks.reduce((sum, c) => sum + c.length, 0);

    await expect(service.send('tok', 0, total, Readable.from(chunks))).resolves.toBe(total);
    expect(fake.bodies[0]?.length).toBe(total);
  });

  it('refuses a body longer than the length it declared, rather than hanging', async () => {
    // The agent reads exactly `length` and then stops reading. Surplus bytes fill the socket buffer
    // and the write never drains — a hang, which holds one of the agent's sixteen workers for the
    // full idle budget while the caller's own logs show nothing at all.
    const [service] = await serviceFor({ kind: 'store' });
    const tooMuch = Readable.from([Buffer.from('four'), Buffer.from('more')]);

    await expect(service.send('tok', 0, 4, tooMuch)).rejects.toBeInstanceOf(
      AgentTransferFailedError,
    );
  });

  it('surfaces a quota failure as its own type, so the caller can answer 507', async () => {
    // ADR-0008 needs 507 rather than 500 when a tenant's refquota is exhausted. The only
    // alternative is matching on `strerror` text across a trust boundary, in whatever locale the
    // daemon happens to run — and the day that match fails the client calls a permanent failure
    // transient and retries the same chunk into the same full dataset forever.
    const [service] = await serviceFor({
      kind: 'fail',
      reason: 'Disk quota exceeded (os error 122)',
      failure: 'out_of_space',
    });

    await expect(
      service.send('tok', 0, 3, Readable.from([Buffer.from('abc')])),
    ).rejects.toBeInstanceOf(AgentOutOfSpaceError);
  });

  it('keeps an ordinary IO failure distinguishable from a quota one', async () => {
    const [service] = await serviceFor({
      kind: 'fail',
      reason: 'Input/output error',
      failure: 'io',
    });

    const failure = await service
      .send('tok', 0, 3, Readable.from([Buffer.from('abc')]))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentTransferFailedError);
    expect(failure).not.toBeInstanceOf(AgentOutOfSpaceError);
    expect((failure as AgentTransferFailedError).kind).toBe('io');
  });

  it('does not send a byte when the transfer is refused up front', async () => {
    // The refusal arrives instead of `ready`. A client that started streaming anyway would be
    // writing into a socket nobody is reading — and on a refusal for a token that belongs to
    // somebody else, it would be writing a tenant's data at a connection that was told no.
    const [service, fake] = await serviceFor({ kind: 'refuse', reason: 'no such transfer' });

    await expect(
      service.send('stolen', 0, 5, Readable.from([Buffer.from('hello')])),
    ).rejects.toBeInstanceOf(AgentTransferFailedError);
    expect(fake.bodies).toHaveLength(0);
  });

  it('reports a connection that dies mid-transfer rather than resolving', async () => {
    // Silence is not success. The agent terminates every answer with a newline, so a connection
    // that closes without one has failed — and resolving here would let the caller publish a file
    // whose bytes never landed.
    const [service] = await serviceFor({ kind: 'vanish' });

    await expect(
      service.send('tok', 0, 5, Readable.from([Buffer.from('hello')])),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it('fails loudly when a source stream dies partway', async () => {
    // The agent sees fewer bytes than declared, treats it as short, and rolls the staging file back
    // to where it found it. What matters here is that the caller is told: a resolved promise would
    // mean the API then publishes a file that was never written.
    const [service] = await serviceFor({ kind: 'store' });
    const broken = new Readable({
      read() {
        this.push(Buffer.from('half'));
        this.destroy(new Error('the source went away'));
      },
    });

    await expect(service.send('tok', 0, 100, broken)).rejects.toThrow();
  });

  it('answers straight away when no data socket is configured', async () => {
    // A development machine has no agent at all. Failing here with a legible error is what keeps
    // the API runnable off Linux, which is the same choice `AgentService` makes for the control
    // socket.
    const service = new AgentDataService(null);
    expect(service.isAvailable()).toBe(false);
    await expect(
      service.send('tok', 0, 1, Readable.from([Buffer.from('x')])),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});

/**
 * İndirme yönü, ve asıl olarak BAŞLIKLA YÜKÜN AYNI PAKETE SIĞDIĞI durum.
 *
 * Ölçülen hata buradaydı: `LineReader`, `takeLeftover` çağrılana kadar satır ayrıştırmayı
 * bırakmıyordu, ve o çağrı `await next()` çözüldükten SONRA — bir mikro görev sonra — geliyordu.
 * Ajan `sending` başlığını ve dosyanın ilk baytlarını aynı `write` ile gönderdiğinde `onData`
 * ikisini birden alıyor, başlığı teslim ediyor, ve SENKRON olarak devam edip yükün içinde 0x0A
 * arıyordu.
 *
 * İkili bir dosyada 0x0A sıradan bir bayt. Bulunan "satır" boşluğa indirgeniyorsa sessizce
 * atılıyordu — yani dosya EKSİK iniyordu — değilse `JSON.parse` patlayıp aktarımı düşürüyordu.
 *
 * Büyük dosyalarda görünmüyordu: yükün geri kalanı sonraki paketlerde geliyor, o zamana kadar
 * `takeLeftover` çalışmış oluyor. Yalnız küçük dosyalar bu yola giriyor.
 */
function servingAgent(
  payload: Buffer,
  options: { split?: boolean } = {},
): {
  path: string;
  close: () => Promise<void>;
} {
  const path = socketPath();
  const live = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const at = buffered.indexOf(0x0a);
      if (at < 0) return;
      const asked = JSON.parse(buffered.subarray(0, at).toString('utf8')) as {
        offset: number;
        length: number;
      };
      buffered = Buffer.alloc(0);
      const slice = payload.subarray(asked.offset, asked.offset + asked.length);
      const header = Buffer.from(
        `${JSON.stringify({ status: 'sending', bytes: slice.length })}\n`,
        'utf8',
      );
      if (options.split === true) {
        // Ayrı yazmalar: büyük bir dosyanın davranışı, ve hatanın GÖRÜNMEDİĞİ hâl.
        socket.write(header);
        setTimeout(() => socket.end(slice), 5);
      } else {
        // TEK yazma — ajanın küçük bir dosya için gerçekte yaptığı şey.
        socket.end(Buffer.concat([header, slice]));
      }
    });
  });
  server.listen(path);
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function collect(service: AgentDataService, token: string, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await service.receive(token, 0, length, sink);
  return Buffer.concat(chunks);
}

describe('the bulk data client, reading', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  /**
   * 0x0A TAŞIYAN bir yük, ve başlıkla aynı pakette.
   *
   * Bayt dizisi kasıtlı: iki tane 0x0A var ve aralarındaki bayt bir boşluk (0x20), yani eski kod
   * o parçayı `line.trim() === ''` dalına düşürüp SESSİZCE atıyordu. Sonuç, doğru uzunlukta
   * olduğunu sanan ama içinden bayt eksilmiş bir dosya.
   */
  it('keeps every byte when the header and the payload arrive together', async () => {
    const payload = Buffer.from([0xff, 0xd8, 0x0a, 0x20, 0x0a, 0x00, 0x7b, 0x22, 0x0a, 0xff, 0xd9]);
    const agent = servingAgent(payload);
    closers.push(agent.close);
    const service = new AgentDataService(agent.path);

    expect(await collect(service, 'tok', payload.length)).toEqual(payload);
  });

  it('reads the same payload when the agent writes it in two packets', async () => {
    // Aynı yük, ayrı yazmalarla: hatanın hiç görünmediği yol. İkisi de aynı sonucu vermeli, yoksa
    // düzeltme yalnız bir zamanlamada doğru olurdu.
    const payload = Buffer.from([0xff, 0xd8, 0x0a, 0x20, 0x0a, 0x00, 0xff, 0xd9]);
    const agent = servingAgent(payload, { split: true });
    closers.push(agent.close);
    const service = new AgentDataService(agent.path);

    expect(await collect(service, 'tok', payload.length)).toEqual(payload);
  });

  it('carries a payload that is entirely newlines', async () => {
    // Uç durum, ve eski kodda tam bir kayıp: her bayt bir satır sınırı, her "satır" boş.
    const payload = Buffer.alloc(64, 0x0a);
    const agent = servingAgent(payload);
    closers.push(agent.close);
    const service = new AgentDataService(agent.path);

    expect(await collect(service, 'tok', payload.length)).toEqual(payload);
  });

  it('reads a payload that looks like a JSON line', async () => {
    // Eski kod bunu ayrıştırıp bir cevap sanardı — ya da ayrıştıramayıp aktarımı düşürürdü.
    const payload = Buffer.from(`{"status":"stored","bytes":9}\nsonra\n`, 'utf8');
    const agent = servingAgent(payload);
    closers.push(agent.close);
    const service = new AgentDataService(agent.path);

    expect(await collect(service, 'tok', payload.length)).toEqual(payload);
  });
});
