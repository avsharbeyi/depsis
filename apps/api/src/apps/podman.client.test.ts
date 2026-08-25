import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  containerNameFor,
  demultiplex,
  hostPathUnder,
  imageReference,
  InvalidNameError,
  PodmanClient,
  PodmanError,
} from './podman.client.js';

/**
 * The parts of the podman client that hold a boundary, tested without podman.
 *
 * Everything here is about a string that becomes part of a URL path, a container name, an image
 * reference or a bind mount source. None of it needs a container runtime, and all of it is what
 * stands between a request body and something being executed as `depsis-apps`.
 */

// Two real-shaped organisation ids. The container name carries the LAST eight hex digits of one.
const ORG_A = '01a02904-caa5-754b-9006-3c27a9621647';
const ORG_B = '01a0293a-b610-7627-84d9-fbac8ad6c69e';

/**
 * Two ids the way `uuidv7()` actually makes them: same millisecond, different randomness.
 *
 * These two share their first TWELVE hex digits, because that is what a uuidv7 is — a 48-bit
 * millisecond timestamp followed by randomness. Any two organisations created in the same window
 * look like this, and the pair above does not, which is why the pair above could not catch what
 * these do.
 */
const TWIN_A = '01a02904-caa5-7000-8000-111111111111';
const TWIN_B = '01a02904-caa5-7000-8000-222222222222';

describe('container names', () => {
  it('builds the one name podman and both migrations accept', () => {
    expect(containerNameFor('jellyfin', ORG_A)).toBe('depsis-app-jellyfin-a9621647');
    expect(containerNameFor('qbittorrent', ORG_A)).toBe('depsis-app-qbittorrent-a9621647');
  });

  it('gives two tenants different names for the same application', () => {
    // The finding this pins: podman's namespace is device-wide while the schema is multi-tenant,
    // so a name built from the slug alone let the database accept a second organisation's
    // Jellyfin and then let `podman create` fail with "name already in use" — a refusal arriving
    // from the privileged side after the row was already written.
    expect(containerNameFor('jellyfin', ORG_A)).not.toBe(containerNameFor('jellyfin', ORG_B));
  });

  it('gives two tenants created in the same second different names', () => {
    // The suffix used to be the FIRST eight hex digits, and organisation ids are `uuidv7()`, whose
    // leading bits are a millisecond timestamp. Its top 32 bits change about once a minute, so two
    // organisations created in one window produced ONE container name. The device-wide unique
    // index refused it — from inside the port-allocation loop, which read the refusal as "this
    // port is taken", tried the next thousand, and reported "no free port is available".
    //
    // The old test passed throughout, because its two fixtures were hand-picked to differ in the
    // first eight digits. Real ones do not.
    expect(TWIN_A.slice(0, 13)).toBe(TWIN_B.slice(0, 13));
    expect(containerNameFor('jellyfin', TWIN_A)).not.toBe(containerNameFor('jellyfin', TWIN_B));
  });

  it('refuses an organization id that is not a uuid', () => {
    // The suffix is concatenated into a container name and therefore into a URL path. A value
    // that is not eight hex digits has no business getting that far.
    for (const bad of ['', 'not-a-uuid', '../../etc', 'ZZZZZZZZ-0000-0000-0000-000000000000']) {
      expect(() => containerNameFor('jellyfin', bad), bad).toThrow(InvalidNameError);
    }
  });

  it('refuses anything that would leave the name and reach the URL', () => {
    // Each of these is a path escape, an option injection, or a name the CHECK constraint would
    // reject after podman had already been asked.
    for (const slug of [
      '../etc',
      'a/b',
      '-flag',
      'Jellyfin',
      'jelly fin',
      '',
      'x'.repeat(200),
      'jellyfin?force=true',
    ]) {
      expect(() => containerNameFor(slug, ORG_A), slug).toThrow(InvalidNameError);
    }
  });
});

describe('image references', () => {
  it('joins the two catalogue columns', () => {
    expect(imageReference('docker.io/jellyfin/jellyfin', '10.10.7')).toBe(
      'docker.io/jellyfin/jellyfin:10.10.7',
    );
  });

  it('refuses an image name or tag that is not one', () => {
    expect(() => imageReference('docker.io/x', 'a tag')).toThrow(InvalidNameError);
    expect(() => imageReference('Docker.IO/x', '1.0')).toThrow(InvalidNameError);
    expect(() => imageReference('docker.io/x;rm -rf /', '1.0')).toThrow(InvalidNameError);
    expect(() => imageReference('', '1.0')).toThrow(InvalidNameError);
  });
});

describe('host paths for bind mounts', () => {
  it('joins the configured root with a share name', () => {
    expect(hostPathUnder('/srv/depsis/shares', 'Belgeler')).toBe('/srv/depsis/shares/Belgeler');
    expect(hostPathUnder('/srv/depsis/shares/', 'Belgeler')).toBe('/srv/depsis/shares/Belgeler');
  });

  it('refuses a component that would climb out of the share tree', () => {
    for (const component of ['..', '../..', 'a/b', '.hidden', '-rf', '', '/etc']) {
      expect(() => hostPathUnder('/srv/depsis/shares', component), component).toThrow(
        InvalidNameError,
      );
    }
  });

  it('refuses a relative root', () => {
    expect(() => hostPathUnder('shares', 'Belgeler')).toThrow(InvalidNameError);
  });
});

describe('log demultiplexing', () => {
  /** One Docker/libpod frame: stream byte, three zero bytes, big-endian length, payload. */
  function frame(stream: 1 | 2, payload: string): Buffer {
    const body = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  it('strips the framing that would otherwise show as garbage at every line start', () => {
    // Byte-for-byte what /run/podman/podman.sock returned for an alpine container that wrote one
    // line to each stream, captured with od -c.
    const raw = Buffer.concat([frame(1, 'hello-stdout\n'), frame(2, 'hello-stderr\n')]);
    expect(demultiplex(raw)).toBe('hello-stdout\nhello-stderr\n');
  });

  it('does not eat the output of a TTY container, which is not framed', () => {
    expect(demultiplex(Buffer.from('plain text with no header\n', 'utf8'))).toBe(
      'plain text with no header\n',
    );
  });

  it('passes through a trailing partial frame rather than dropping it', () => {
    const raw = Buffer.concat([frame(1, 'complete\n'), Buffer.from([1, 0, 0])]);
    expect(demultiplex(raw)).toContain('complete\n');
  });

  it('terminates on a zero-length frame', () => {
    const raw = Buffer.concat([frame(1, ''), frame(1, 'after\n')]);
    expect(demultiplex(raw)).toBe('after\n');
  });

  it('handles an empty body', () => {
    expect(demultiplex(Buffer.alloc(0))).toBe('');
  });
});

/**
 * The transport, against a REAL HTTP server on a real local socket.
 *
 * Not a mocked `node:http`. Every bug in this section was a bug in how Node's own streams behave —
 * which events an `IncomingMessage.destroy()` does and does not emit, what a 304 with no body does
 * — and a mock would have been written from the same wrong belief as the code.
 *
 * AF_UNIX on Linux, a named pipe on Windows. `http.request({socketPath})` drives both, and
 * everything asserted here is transport behaviour rather than anything libpod-specific.
 */
describe('the podman transport', () => {
  const servers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of servers.splice(0, servers.length)) await close();
  });

  function socketPath(): string {
    const id = randomUUID();
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\depsis-podman-${id}`
      : join(tmpdir(), `depsis-podman-${id}.sock`);
  }

  function fakePodman(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<string> {
    const path = socketPath();
    const server = createServer((req, res) => {
      // The client hangs up mid-body on purpose in one of these tests; the write that lands
      // afterwards must not take the test process down with it.
      res.on('error', () => {});
      req.on('error', () => {});
      handler(req, res);
    });
    servers.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return new Promise<string>((resolve, reject) => {
      server.on('error', reject);
      server.listen(path, () => resolve(path));
    });
  }

  /** Roughly `bytes` of newline-delimited JSON, the shape libpod's pull progress has. */
  function progress(bytes: number): string {
    const line = `${JSON.stringify({ status: 'Downloading', progressDetail: { current: 1 } })}\n`;
    return line.repeat(Math.ceil(bytes / line.length));
  }

  it('settles when a buffered body passes the ceiling instead of hanging forever', async () => {
    // The bug this exists for: the size ceiling called `response.destroy()` and returned, and
    // `IncomingMessage.destroy()` with no error emits neither `end` nor `error` — only `close`,
    // which nothing listened for. The promise stayed pending for the life of the process, so the
    // HTTP request behind it never answered.
    const path = await fakePodman((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(3 * 1024 * 1024, 0x61));
      res.end();
    });

    const client = new PodmanClient(path, 5_000);
    // The assertion is that this RESOLVES AT ALL. A truncated tail is a usable log; a request that
    // never answers is not an answer.
    const lines = await client.logs(containerNameFor('big', ORG_A), 10);
    expect(Array.isArray(lines)).toBe(true);
  }, 20_000);

  it('reads a pull progress stream far past that ceiling', async () => {
    // The realistic trigger. A first pull of a media server emits progress JSON for as long as the
    // download lasts, and libpod reports failures INSIDE the body after a 200 header — so the
    // failing line arrives at the very end, past any buffer ceiling.
    const path = await fakePodman((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(progress(3 * 1024 * 1024));
      res.write(`${JSON.stringify({ error: 'manifest unknown' })}\n`);
      res.end();
    });

    const client = new PodmanClient(path, 5_000);
    await expect(
      client.pullImage(imageReference('docker.io/library/alpine', '3.21')),
    ).rejects.toThrow(/manifest unknown/);
  }, 20_000);

  it('completes a large clean pull', async () => {
    const path = await fakePodman((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(progress(3 * 1024 * 1024));
      res.write(`${JSON.stringify({ status: 'Writing manifest' })}\n`);
      res.end();
    });

    const client = new PodmanClient(path, 5_000);
    await expect(
      client.pullImage(imageReference('docker.io/library/alpine', '3.21')),
    ).resolves.toBeUndefined();
  }, 20_000);

  it('treats 304 on start and stop as "it was already like that"', async () => {
    // Measured against podman 5.4.2 on the development box: create 201, start 204, start again
    // 304, stop 204, stop again 304. Calling that a failure turned two administrators pressing
    // Start at the same moment into a 503 — and 503 is reserved for "there is no container
    // runtime here", which is the distinction §3 of this round's rules protects.
    const path = await fakePodman((_req, res) => {
      res.writeHead(304);
      res.end();
    });

    const client = new PodmanClient(path, 5_000);
    await expect(client.startContainer(containerNameFor('idle', ORG_A))).resolves.toBeUndefined();
    await expect(client.stopContainer(containerNameFor('idle', ORG_A))).resolves.toBeUndefined();
  }, 20_000);

  it('still reports a real refusal from start and stop', async () => {
    // 304 is forgiven; 404 is not. The controller maps this one to a 404 of its own, and a start
    // that silently succeeded against a container podman has never heard of would be worse than
    // any status code.
    const path = await fakePodman((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'no such container' }));
    });

    const client = new PodmanClient(path, 5_000);
    await expect(client.startContainer(containerNameFor('gone', ORG_A))).rejects.toBeInstanceOf(
      PodmanError,
    );
    await expect(client.startContainer(containerNameFor('gone', ORG_A))).rejects.toThrow(
      /no such container/,
    );
  }, 20_000);

  it('answers rather than hangs when the server hangs up mid-body', async () => {
    // The `close` backstop. Nothing here settles through `end` or `error`, so before it this was
    // another pending promise.
    const path = await fakePodman((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      res.destroy();
    });

    const client = new PodmanClient(path, 5_000);
    await expect(client.info()).rejects.toThrow(/not available/);
  }, 20_000);
});
