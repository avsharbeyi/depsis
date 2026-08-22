import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import {
  consoleData,
  InvalidConsoleValueError,
  terminalSize,
  ConsoleConnection,
  consoleUuid,
  probeConsole,
} from './console.client.js';
import {
  ConsoleService,
  ConsoleSessionClosedError,
  ConsoleSessionNotFoundError,
  type ConsoleEvent,
} from './console.service.js';

/**
 * The console endpoints, against a real PostgreSQL and a real Unix socket.
 *
 * The socket is a stand-in for `services/console`, not a mock of this module: it speaks the wire
 * protocol from `services/console/src/protocol.rs` and nothing here knows it is not the real thing.
 * That is the part worth testing at this level — the audit rows, the ownership rule and the
 * lifecycle are all driven by what comes back over that socket, and a test that stubbed the
 * connection would be testing the stub.
 *
 * The real console service is not used because it needs a pty, systemd socket activation and a
 * shell; what it does with those is tested in its own crate.
 *
 * Skipped loudly rather than quietly: no test database, no database tests. The socket itself is
 * portable — Windows has no Unix domain sockets, so `endpoint()` hands out a named pipe there and
 * `net` treats the two the same. The console service is Unix-only; this test is about the API's
 * side of the wire, which is not.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const dbRunnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeConsole = dbRunnable ? describe : describe.skip;

/** A socket path `net` can listen on: a filesystem socket on Unix, a named pipe on Windows. */
function endpoint(prefix: string): string {
  const name = `depsis-console-${prefix}-${randomUUID()}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

/** A named pipe is not a file and has nothing to unlink. */
function forget(path: string): void {
  if (process.platform !== 'win32') rmSync(path, { force: true });
}

// ─── a console service that is not a console service ──────────────────────────

interface OpenRecord {
  cols: number;
  rows: number;
  session: string;
  user: string;
  privileged: boolean;
}

/** One accepted connection: what it was told, and a way to talk back. */
class FakeSession {
  readonly opens: OpenRecord[] = [];
  readonly input: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  closeRequested = false;
  private pending = '';

  constructor(
    private readonly socket: Socket,
    private readonly privileged: boolean,
  ) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk.toString('utf8')));
  }

  send(message: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  out(text: string): void {
    this.send({ t: 'out', d: Buffer.from(text, 'utf8').toString('base64') });
  }

  end(): void {
    this.socket.destroy();
  }

  private feed(text: string): void {
    this.pending += text;
    for (;;) {
      const at = this.pending.indexOf('\n');
      if (at < 0) return;
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      switch (message['t']) {
        case 'open':
          this.opens.push(message as unknown as OpenRecord);
          this.send({ t: 'ready', pid: 4242, privileged: this.privileged });
          break;
        case 'in':
          this.input.push(String(message['d']));
          break;
        case 'resize':
          this.resizes.push({ cols: Number(message['cols']), rows: Number(message['rows']) });
          break;
        case 'close':
          this.closeRequested = true;
          break;
        default:
          break;
      }
    }
  }
}

class FakeConsole {
  readonly sessions: FakeSession[] = [];
  private constructor(
    readonly path: string,
    private readonly server: Server,
  ) {}

  static listen(privileged = false): Promise<FakeConsole> {
    const path = endpoint('fake');
    const server = createServer();
    const fake = new FakeConsole(path, server);
    server.on('connection', (socket) => fake.sessions.push(new FakeSession(socket, privileged)));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve(fake));
    });
  }

  latest(): FakeSession {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error('nothing connected to the fake console');
    return session;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) session.end();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    forget(this.path);
  }
}

/** Poll until an assertion holds. The audit writes are queued behind the socket, not awaited. */
async function until<T>(
  fn: () => T | null | Promise<T | null>,
  what: string,
  budgetMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─── the values a request supplies ────────────────────────────────────────────

describe('nothing reaches a shell without being a typed value first', () => {
  it('refuses a terminal a curses program could not draw in', () => {
    expect(() => terminalSize(0, 24)).toThrow(InvalidConsoleValueError);
    expect(() => terminalSize(80, 0)).toThrow(InvalidConsoleValueError);
    expect(() => terminalSize(9000, 24)).toThrow(InvalidConsoleValueError);
    expect(() => terminalSize(80.5, 24)).toThrow(InvalidConsoleValueError);
    expect(terminalSize(80, 24)).toMatchObject({ cols: 80, rows: 24 });
  });

  it('refuses input that is not strict base64 rather than guessing at it', () => {
    // The shapes a lenient decoder would accept. Guessing here means *some* bytes reach a shell.
    for (const bad of ['rm -rf /', 'Zg=', 'Zg ==', 'Zm9v\nYmFy', 'Zm=9', 'Zm9-']) {
      expect(() => consoleData(bad), bad).toThrow(InvalidConsoleValueError);
    }
    expect(consoleData('ZWNobyBtZXJoYWJhCg==')).toBe('ZWNobyBtZXJoYWJhCg==');
  });

  it('refuses an identifier that is a path', () => {
    expect(() => consoleUuid('../../etc/passwd', 'session')).toThrow(InvalidConsoleValueError);
  });
});

// ─── the endpoints' service, against the real thing ───────────────────────────

describeConsole('console sessions, against a real PostgreSQL and a real socket', () => {
  let db: DbService;
  let owner: DbService;
  let organizationId = '';
  let adminA = '';
  let adminB = '';
  const usernameA = `console-a-${randomUUID().slice(0, 8)}`;
  const usernameB = `console-b-${randomUUID().slice(0, 8)}`;

  const started: FakeConsole[] = [];
  const services: ConsoleService[] = [];

  async function withConsole(privileged = false): Promise<[ConsoleService, FakeConsole]> {
    const fake = await FakeConsole.listen(privileged);
    started.push(fake);
    const service = new ConsoleService(db, fake.path);
    services.push(service);
    return [service, fake];
  }

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      const orgs = await q.query<{ id: string }>(
        `INSERT INTO organizations (slug, name) VALUES ('console-org','Console Org')
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name
         RETURNING id::text AS id`,
      );
      organizationId = orgs[0]?.id ?? '';

      // Unique per run, because the organisation is reused between runs and a username is unique
      // within one. `usernameA` is asserted against later, so it is kept rather than derived twice.
      const users = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
              VALUES ($1, $2, 'admin', 'x'), ($1, $3, 'admin', 'x')
           RETURNING username, id::text AS id`,
        [organizationId, usernameA, usernameB],
      );
      adminA = users.find((u) => u.username === usernameA)?.id ?? '';
      adminB = users.find((u) => u.username === usernameB)?.id ?? '';
    });

    expect(organizationId).not.toBe('');
    expect(adminA).not.toBe('');
    expect(adminB).not.toBe('');
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.onModuleDestroy();
    for (const fake of started.splice(0)) await fake.stop();
    // Sessions from one test must not be listed by the next: `list` reaps them, and a test that
    // relied on that would be testing its own leftovers.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `UPDATE console_sessions SET closed_at = now(), close_reason = 'shutdown'
          WHERE organization_id = $1 AND closed_at IS NULL`,
        [organizationId],
      ),
    );
  });

  afterAll(async () => {
    await db.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  it('opens a session, records it, and reports what the service said', async () => {
    const [service, fake] = await withConsole();
    const view = await service.open(organizationId, adminA, 100, 30);

    expect(view.username).toBe(usernameA);
    expect(view.privileged).toBe(false);

    const open = fake.latest().opens[0];
    expect(open).toMatchObject({ cols: 100, rows: 30, session: view.id, user: adminA });
    // The API never ASKS for root. Whether this box has a privileged console is its unit file's
    // decision, and a request that could ask would eventually be made to ask.
    expect(open?.privileged).toBe(false);

    const rows = await db.withTenant(organizationId, (q) =>
      q.query<{ user_id: string; privileged: boolean; closed_at: Date | null }>(
        `SELECT user_id::text AS user_id, privileged, closed_at FROM console_sessions WHERE id = $1`,
        [view.id],
      ),
    );
    expect(rows[0]).toMatchObject({ user_id: adminA, privileged: false, closed_at: null });
  });

  it('reports a privileged shell as privileged, because the operator has to know', async () => {
    const [service, fake] = await withConsole(true);
    const view = await service.open(organizationId, adminA, 80, 24);
    expect(view.privileged).toBe(true);
    expect(fake.latest().opens[0]?.privileged).toBe(false);

    const rows = await db.withTenant(organizationId, (q) =>
      q.query<{ privileged: boolean }>(`SELECT privileged FROM console_sessions WHERE id = $1`, [
        view.id,
      ]),
    );
    expect(rows[0]?.privileged).toBe(true);
  });

  it('records the lines that were typed and never the output', async () => {
    const [service, fake] = await withConsole();
    const view = await service.open(organizationId, adminA, 80, 24);

    fake.latest().send({ t: 'line', s: 'cat /etc/shadow' });
    fake.latest().out('root:$6$verysecrethash:19000:0:99999:7:::\n');

    const lines = await until(
      async () => {
        const rows = await db.withTenant(organizationId, (q) =>
          q.query<{ line: string }>(
            `SELECT line FROM console_commands WHERE session_id = $1 ORDER BY at`,
            [view.id],
          ),
        );
        return rows.length > 0 ? rows : null;
      },
      'the typed line to be recorded',
    );

    expect(lines.map((row) => row.line)).toEqual(['cat /etc/shadow']);
    // The whole point of ADR-0018's "no output" rule: copying the output of that command into the
    // audit log would move the secret rather than record the act.
    const all = await db.withTenant(organizationId, (q) =>
      q.query<{ line: string }>(`SELECT line FROM console_commands WHERE session_id = $1`, [
        view.id,
      ]),
    );
    expect(all.some((row) => row.line.includes('verysecrethash'))).toBe(false);
  });

  it('streams output to a subscriber that attaches after the prompt was printed', async () => {
    const [service, fake] = await withConsole();
    const view = await service.open(organizationId, adminA, 80, 24);
    fake.latest().out('depsis:~$ ');

    const seen: ConsoleEvent[] = [];
    const subscription = service.stream(organizationId, adminA, view.id).subscribe((event) => {
      seen.push(event);
    });
    try {
      await until(() => (seen.length > 0 ? seen : null), 'the replayed prompt');
    } finally {
      // A browser that navigates away unsubscribes; the shell must survive it.
      subscription.unsubscribe();
    }

    expect(seen[0]).toEqual({ kind: 'out', data: Buffer.from('depsis:~$ ').toString('base64') });
    expect(service.stream(organizationId, adminA, view.id)).toBeDefined();
  });

  it('will not let one administrator type into another administrator’s shell', async () => {
    const [service, fake] = await withConsole();
    const view = await service.open(organizationId, adminA, 80, 24);

    await expect(
      service.input(organizationId, adminB, view.id, consoleData('cm0gLXJmIC8=')),
    ).rejects.toBeInstanceOf(ConsoleSessionNotFoundError);
    expect(() => service.stream(organizationId, adminB, view.id)).toThrow(
      ConsoleSessionNotFoundError,
    );
    await expect(service.resize(organizationId, adminB, view.id, 120, 40)).rejects.toBeInstanceOf(
      ConsoleSessionNotFoundError,
    );

    // Not one byte reached the shell, which is the claim that matters: the refusal is not merely a
    // different status code on the way out.
    expect(fake.latest().input).toEqual([]);
    expect(fake.latest().resizes).toEqual([]);

    await service.input(organizationId, adminA, view.id, 'ZWNobyBoaQo=');
    await until(
      () => (fake.latest().input.length > 0 ? fake.latest().input : null),
      'the owner’s keystrokes',
    );
    expect(fake.latest().input).toEqual(['ZWNobyBoaQo=']);
  });

  it('answers a timed-out session with gone, and records why it ended', async () => {
    const [service, fake] = await withConsole();
    const view = await service.open(organizationId, adminA, 80, 24);

    // Exactly what the service does on expiry: the close_reason vocabulary as an `error`, then
    // `exit`. See `run_session` in services/console/src/main.rs.
    fake.latest().send({ t: 'error', message: 'idle' });
    fake.latest().send({ t: 'exit', code: 0 });

    const reason = await until(
      async () => {
        const rows = await db.withTenant(organizationId, (q) =>
          q.query<{ close_reason: string | null }>(
            `SELECT close_reason FROM console_sessions WHERE id = $1 AND closed_at IS NOT NULL`,
            [view.id],
          ),
        );
        return rows[0]?.close_reason ?? null;
      },
      'the session to be closed with a reason',
    );
    expect(reason).toBe('idle');

    await expect(service.input(organizationId, adminA, view.id, 'aGk=')).rejects.toBeInstanceOf(
      ConsoleSessionClosedError,
    );
  });

  it('closes the row when the console service goes away underneath it', async () => {
    const [service, fake] = await withConsole();
    const view = await service.open(organizationId, adminA, 80, 24);

    fake.latest().end();

    const reason = await until(
      async () => {
        const rows = await db.withTenant(organizationId, (q) =>
          q.query<{ close_reason: string | null }>(
            `SELECT close_reason FROM console_sessions WHERE id = $1 AND closed_at IS NOT NULL`,
            [view.id],
          ),
        );
        return rows[0]?.close_reason ?? null;
      },
      'the dropped session to be closed',
    );
    expect(reason).toBe('shutdown');
  });

  it('does not list sessions left behind by a previous run of the API', async () => {
    const [service, fake] = await withConsole();
    const live = await service.open(organizationId, adminA, 80, 24);
    expect(fake.latest().opens).toHaveLength(1);

    // A row from a process that is gone: open in the table, no socket anywhere.
    const orphan = randomUUID();
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO console_sessions (id, organization_id, user_id) VALUES ($1, $2, $3)`,
        [orphan, organizationId, adminB],
      ),
    );

    const page = await service.list(organizationId);
    expect(page.available).toBe(true);
    expect(page.items.map((item) => item.id)).toEqual([live.id]);

    const rows = await db.withTenant(organizationId, (q) =>
      q.query<{ close_reason: string | null }>(
        `SELECT close_reason FROM console_sessions WHERE id = $1`,
        [orphan],
      ),
    );
    expect(rows[0]?.close_reason).toBe('shutdown');
  });

  it('reports a switched-off console as switched off, not as a failure', async () => {
    const absent = endpoint('absent');
    const service = new ConsoleService(db, absent);
    services.push(service);

    await expect(service.open(organizationId, adminA, 80, 24)).rejects.toMatchObject({
      name: 'ConsoleUnavailableError',
    });

    const page = await service.list(organizationId);
    expect(page).toEqual({ items: [], available: false });
  });

  it('turns the service’s refusal into a refusal rather than a hang', async () => {
    // What the real service does when all eight session slots are taken, or when a privileged
    // shell is asked of a unit that has none: one `error`, then the connection goes. A client that
    // sat waiting for `ready` would hang until its own timeout and report the wrong thing.
    const path = endpoint('busy');
    const refusing = createServer((socket) => {
      // Waits for `open` before refusing, which is what the real service does — and what makes
      // this test pass on Linux. Refusing on the connection alone closed the socket before the
      // client's `open` write left, so the write failed with EPIPE, Node destroyed the client
      // socket on that error, and the refusal sitting unread in its receive buffer went with it:
      // the test then measured "the console dropped the connection" on the only platform the
      // console service runs on. Windows named pipes forgave it, so it passed there.
      socket.once('data', () => {
        socket.write('{"t":"error","message":"8 console sessions are already open"}\n', () =>
          socket.destroy(),
        );
      });
    });
    await new Promise<void>((resolve) => refusing.listen(path, () => resolve()));

    try {
      await expect(
        ConsoleConnection.open(path, {
          session: consoleUuid(randomUUID(), 'session'),
          user: consoleUuid(adminA, 'user'),
          size: terminalSize(80, 24),
        }),
      ).rejects.toMatchObject({ name: 'ConsoleRefusedError' });
    } finally {
      await new Promise<void>((resolve) => refusing.close(() => resolve()));
      forget(path);
    }
  });
});

/**
 * The availability probe, and the third state the socket unit measured.
 *
 * `deploy/systemd/depsis-console.socket` documents three states, not two: socket stopped
 * (`connect` fails), socket running with the service stopped (normal, systemd starts it), and
 * socket running with the service FAILING to start — where the kernel queues the connection on
 * systemd's listening socket, `connect` succeeds, and nothing is ever on the other end. The unit
 * file's own conclusion is that the API "must not treat the connect succeeded as the console is
 * up". Needs no database: this is about a socket.
 */
describe('is the console actually there', () => {
  it('does not call a socket with nothing behind it available', async () => {
    // The failing-service state, in the shape a client sees it: the connection is accepted and
    // then immediately goes. `probeConsole` used to resolve `true` on the `connect` event alone,
    // so `GET /console` reported `available: true` while `POST /console` answered 503 — the exact
    // misconfiguration where an honest `false` points the operator at `systemctl status`.
    const path = endpoint('hangup');
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));

    try {
      await expect(probeConsole(path, 1_000, 100)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      forget(path);
    }
  });

  it('calls a socket that holds the connection available', async () => {
    // What the real service does while it waits for `open`: nothing, for ten seconds. Silence is
    // the healthy answer here, which is why the probe waits rather than asking a question.
    const path = endpoint('healthy');
    const held: Socket[] = [];
    const server = createServer((socket) => held.push(socket));
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));

    try {
      await expect(probeConsole(path, 1_000, 100)).resolves.toBe(true);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      forget(path);
    }
  });

  it('calls a socket that is not there unavailable', async () => {
    await expect(probeConsole(endpoint('nothing'), 500, 100)).resolves.toBe(false);
  });
});
