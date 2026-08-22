import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReplaySubject, type Observable } from 'rxjs';

import { DbService } from '../db/db.service.js';
import {
  consoleData,
  consoleUuid,
  ConsoleConnection,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_MAX_AGE_SECONDS,
  probeConsole,
  terminalSize,
} from './console.client.js';

/** Nothing by that id in this organisation. Also what another administrator's session looks like. */
export class ConsoleSessionNotFoundError extends Error {
  constructor() {
    super('no such console session');
    this.name = 'ConsoleSessionNotFoundError';
  }
}

/** The session existed and has ended — idle timeout, age ceiling, or the shell exited. A 410. */
export class ConsoleSessionClosedError extends Error {
  constructor(readonly reason: string) {
    super(`this console session is closed (${reason})`);
    this.name = 'ConsoleSessionClosedError';
  }
}

/** What one event stream carries. Output stays base64 the whole way to the browser. */
export type ConsoleEvent =
  | { kind: 'out'; data: string }
  | { kind: 'exit'; code: number }
  | { kind: 'error'; message: string };

export interface ConsoleSessionView {
  id: string;
  username: string;
  privileged: boolean;
  openedAt: string;
  idleTimeoutSeconds: number;
  maxAgeSeconds: number;
}

export interface ConsoleOverview {
  items: ConsoleSessionView[];
  available: boolean;
}

/**
 * How much recent output a stream that attaches late is given.
 *
 * A browser opens `GET /console/{id}/stream` a moment AFTER `POST /console`, and in that moment the
 * shell has already printed its prompt. Without a replay the terminal would open blank and stay
 * blank until the operator typed something, which reads as a console that does not work.
 *
 * Counted in MESSAGES, and the messages are sized by the producer: `OUT_CHUNK` in
 * `services/console/src/main.rs` is 32 kB raw, so about 44 kB once base64'd. Eight is therefore a
 * real ceiling of roughly 350 kB per session and 2.8 MB across all eight — say what the number
 * costs rather than only that it is bounded. It was 64, which was ten times that for no gain: the
 * replay only has to cover the gap between `POST /console` and the browser opening `/stream`, and
 * what belongs in that gap is a prompt.
 */
const REPLAY_MESSAGES = 8;

/**
 * How often a live session's `last_seen_at` is written.
 *
 * Terminal input is one keystroke per request, so writing on every one would be an UPDATE per
 * character typed. The column is for the operator's benefit — the idle timer that actually ends
 * sessions lives in the console service and is re-armed by the bytes themselves.
 */
const LAST_SEEN_INTERVAL_MS = 10_000;

/** `console_commands.line`'s CHECK constraint in migration 0013. */
const MAX_AUDIT_LINE = 8192;

/** The vocabulary `console_sessions.close_reason` accepts, as the service words it. */
const EXPIRY_REASONS = new Set(['idle', 'max_age']);

interface LiveSession {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly username: string;
  readonly privileged: boolean;
  readonly openedAt: Date;
  readonly connection: ConsoleConnection;
  readonly events: ReplaySubject<ConsoleEvent>;
  /** Set when the service says why it is about to end, so `exit` can record the real reason. */
  pendingReason: string | null;
  lastSeenWrittenAt: number;
  /** Audit writes go through here in order: a shell history out of order is a shell history. */
  writes: Promise<unknown>;
  closed: boolean;
}

/**
 * Administrator console sessions (ADR-0018).
 *
 * The bytes do not pass through the database and they do not pass through the privileged agent:
 * this service holds one socket per open session and the rows it writes are the AUDIT record —
 * who opened a shell, when, and which lines they typed. Output is never recorded. Copying the
 * output of a `cat /etc/shadow` into an audit log moves the secret rather than recording it.
 *
 * Everything here is process memory. When the API restarts, every session dies with it, and the
 * rows left behind are closed with `shutdown` the next time the organisation's list is read —
 * see `reap`.
 */
@Injectable()
export class ConsoleService implements OnModuleDestroy {
  private readonly logger = new Logger(ConsoleService.name);
  private readonly live = new Map<string, LiveSession>();

  /**
   * Ids that have been written to `console_sessions` but are not in `live` yet.
   *
   * `reap` closes every open row this process is not serving, and "serving" used to mean "in the
   * `live` map". Between the COMMIT in `open` and the `live.set` that follows it there is a real
   * microtask gap, and a concurrent `GET /console` landing in it would close the audit row of a
   * session that had just started: the shell keeps working, the row says `shutdown` at the instant
   * it opened, and `markClosed` later updates nothing because of its `closed_at IS NULL` guard.
   * ADR-0018 promises every open and close is audited, and that row is the promise being broken.
   */
  private readonly opening = new Set<string>();

  constructor(
    private readonly db: DbService,
    private readonly socketPath: string,
  ) {}

  /**
   * Open a shell.
   *
   * The order is: connect and complete the handshake, THEN write the row. A row written first
   * would have to be walked back when the console service is switched off, and an audit table
   * containing sessions that never existed is worse than one written a few milliseconds late.
   */
  async open(
    organizationId: string,
    userId: string,
    cols: number,
    rows: number,
  ): Promise<ConsoleSessionView> {
    const size = terminalSize(cols, rows);
    const id = randomUUID();

    const connection = await ConsoleConnection.open(this.socketPath, {
      session: consoleUuid(id, 'session'),
      user: consoleUuid(userId, 'user'),
      size,
    });

    // Claimed BEFORE the row exists, so there is no instant at which the row is visible and
    // unclaimed. See `opening`.
    this.opening.add(id);

    let opened: { openedAt: Date; username: string };
    try {
      opened = await this.db.withTenant(organizationId, async (q) => {
        const inserted = await q.query<{ opened_at: Date }>(
          `INSERT INTO console_sessions (id, organization_id, user_id, privileged)
                VALUES ($1, $2, $3, $4)
             RETURNING opened_at`,
          [id, organizationId, userId, connection.privileged],
        );
        const names = await q.query<{ username: string }>(
          `SELECT username FROM users WHERE id = $1`,
          [userId],
        );
        const row = inserted[0];
        if (row === undefined) throw new Error('console_sessions insert returned no row');
        return { openedAt: row.opened_at, username: names[0]?.username ?? '' };
      });
    } catch (error) {
      // The shell is already running behind that socket. Dropping the connection kills it, which
      // is the only honest outcome: a session with no audit row is a shell nobody can account for.
      this.opening.delete(id);
      connection.destroy();
      throw error;
    }

    const session: LiveSession = {
      id,
      organizationId,
      userId,
      username: opened.username,
      privileged: connection.privileged,
      openedAt: opened.openedAt,
      connection,
      events: new ReplaySubject<ConsoleEvent>(REPLAY_MESSAGES),
      pendingReason: null,
      lastSeenWrittenAt: Date.now(),
      writes: Promise.resolve(),
      closed: false,
    };
    this.live.set(id, session);
    // The handover is complete: `live` now answers for this id, so the claim is not needed and
    // holding it would leak an entry per session.
    this.opening.delete(id);

    connection.listen({
      output: (data) => session.events.next({ kind: 'out', data }),
      line: (line) => this.record(session, line),
      error: (message) => {
        // On expiry the service sends the close_reason vocabulary verbatim just ahead of `exit`,
        // so this is where a session says why it is ending. Anything else is a fault, and `error`
        // is the reason the audit table has for one.
        if (EXPIRY_REASONS.has(message)) {
          session.pendingReason = message;
        } else {
          session.pendingReason ??= 'error';
          this.logger.warn(`console session ${id}: ${message}`);
        }
        session.events.next({ kind: 'error', message });
      },
      exit: (code) => {
        session.events.next({ kind: 'exit', code });
        this.finish(session, session.pendingReason ?? 'user');
      },
      closed: () => {
        // No `exit` first means the console service went away underneath us — a stopped unit, a
        // crash — rather than a shell that ended.
        this.finish(session, session.pendingReason ?? 'shutdown');
      },
    });

    return toView(session);
  }

  /**
   * Who has a shell open.
   *
   * Read from the database rather than from the map, because the row is the record and the map is
   * this process's memory. They can disagree in exactly one direction — rows left open by a
   * previous run of the API — and `reap` closes those before the list is built, so the answer is
   * never a session nobody can connect to.
   */
  async list(organizationId: string): Promise<ConsoleOverview> {
    await this.reap(organizationId);

    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string; username: string; privileged: boolean; opened_at: Date }>(
        `SELECT s.id::text AS id, u.username, s.privileged, s.opened_at
           FROM console_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.closed_at IS NULL
          ORDER BY s.opened_at DESC`,
      ),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        username: row.username,
        privileged: row.privileged,
        openedAt: row.opened_at.toISOString(),
        idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
        maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
      })),
      // A live session is proof enough. The probe costs a connection to the console service and
      // there is no reason to spend one to learn something already known.
      available: this.live.size > 0 ? true : await probeConsole(this.socketPath),
    };
  }

  /**
   * Keystrokes.
   *
   * OWNED sessions only. Without the `user_id` check two administrators share one shell: the
   * second one's keystrokes arrive in the first one's terminal, attributed in `console_commands`
   * to the person whose session it is. That is not a leak of data so much as a forged record.
   */
  async input(organizationId: string, userId: string, id: string, data: string): Promise<void> {
    const session = await this.require(organizationId, userId, id);
    session.connection.input(consoleData(data));
    this.touch(session);
  }

  async resize(
    organizationId: string,
    userId: string,
    id: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const size = terminalSize(cols, rows);
    const session = await this.require(organizationId, userId, id);
    session.connection.resize(size);
  }

  /**
   * The output stream, for `@Sse`.
   *
   * Synchronous and served from memory: a stream that is closed by the browser navigating away
   * must not take the shell with it, so the subscription owns nothing. The socket and the pty
   * belong to the session, and they end when the session ends — on `exit`, on `DELETE`, or when
   * the console service's own idle timer fires.
   */
  stream(organizationId: string, userId: string, id: string): Observable<ConsoleEvent> {
    const session = this.live.get(id);
    if (
      session === undefined ||
      session.organizationId !== organizationId ||
      session.userId !== userId
    ) {
      throw new ConsoleSessionNotFoundError();
    }
    return session.events.asObservable();
  }

  /**
   * Close a session.
   *
   * Any administrator of the organisation may close any of them, unlike input: `GET /console`
   * already shows everyone's sessions, and a shell somebody left running on the appliance is
   * exactly the thing another administrator needs to be able to end. The audit row still records
   * whose session it was.
   */
  async close(organizationId: string, id: string): Promise<void> {
    const session = this.live.get(id);
    if (session !== undefined && session.organizationId === organizationId) {
      session.connection.requestClose();
      this.finish(session, 'user');
      return;
    }

    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ closed_at: Date | null }>(`SELECT closed_at FROM console_sessions WHERE id = $1`, [
        id,
      ]),
    );
    const row = rows[0];
    if (row === undefined) throw new ConsoleSessionNotFoundError();
    // Open in the table but not in this process: a leftover from a previous run, so `shutdown` is
    // what actually ended it. Already closed is not an error — the row says what the caller wanted
    // it to say, and a 404 would be a lie about a session that plainly exists.
    if (row.closed_at === null) {
      await this.markClosed(organizationId, id, 'shutdown');
    }
  }

  /**
   * Close rows this process cannot possibly be serving.
   *
   * An API restart takes every socket with it, and the rows left behind would otherwise list
   * sessions that answer 404 to everything. Called on read rather than at startup because
   * `console_sessions` is tenant-scoped and startup has no tenant — see the notes on
   * `UntenantedJustification`.
   */
  private async reap(organizationId: string): Promise<void> {
    const mine = [
      ...[...this.live.values()]
        .filter((session) => session.organizationId === organizationId)
        .map((session) => session.id),
      // Sessions mid-handover. Not filtered by organisation because the set does not know one —
      // and it does not need to: the UPDATE is tenant-scoped, so another organisation's id simply
      // matches no row.
      ...this.opening,
    ];

    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE console_sessions
            SET closed_at = now(), close_reason = 'shutdown'
          WHERE closed_at IS NULL
            AND NOT (id = ANY($1::uuid[]))`,
        [mine],
      ),
    );
  }

  /**
   * The live session behind an id, or the right refusal.
   *
   * A closed session is a 410 and an unknown one is a 404, and the difference is the whole reason
   * this is not one lookup: "your shell timed out" and "there is no such shell" send an operator
   * to different places.
   */
  private async require(organizationId: string, userId: string, id: string): Promise<LiveSession> {
    const session = this.live.get(id);
    if (
      session !== undefined &&
      session.organizationId === organizationId &&
      session.userId === userId
    ) {
      return session;
    }

    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ user_id: string; closed_at: Date | null; close_reason: string | null }>(
        `SELECT user_id::text AS user_id, closed_at, close_reason
           FROM console_sessions
          WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    // Another administrator's session answers exactly as a missing one does. It is not theirs to
    // know about, and a 403 here would confirm that the id is real.
    if (row === undefined || row.user_id !== userId) throw new ConsoleSessionNotFoundError();
    if (row.closed_at !== null) throw new ConsoleSessionClosedError(row.close_reason ?? 'closed');
    // Open in the table, absent from the map: this process is not the one that opened it.
    await this.markClosed(organizationId, id, 'shutdown');
    throw new ConsoleSessionClosedError('shutdown');
  }

  /** Record one typed line. Never output — ADR-0018 and migration 0013 both say so. */
  private record(session: LiveSession, line: string): void {
    session.writes = session.writes
      .then(() =>
        this.db.withTenant(session.organizationId, (q) =>
          q.query(
            `INSERT INTO console_commands (organization_id, session_id, line)
                  VALUES ($1, $2, left($3, ${MAX_AUDIT_LINE}))`,
            [session.organizationId, session.id, line],
          ),
        ),
      )
      .catch((error: unknown) => {
        this.logger.error(
          `could not record a console command for session ${session.id}: ${describe(error)}`,
        );
      });
  }

  private touch(session: LiveSession): void {
    const now = Date.now();
    if (now - session.lastSeenWrittenAt < LAST_SEEN_INTERVAL_MS) return;
    session.lastSeenWrittenAt = now;
    session.writes = session.writes
      .then(() =>
        this.db.withTenant(session.organizationId, (q) =>
          q.query(
            `UPDATE console_sessions SET last_seen_at = now()
              WHERE id = $1 AND closed_at IS NULL`,
            [session.id],
          ),
        ),
      )
      .catch((error: unknown) => {
        this.logger.warn(`could not touch console session ${session.id}: ${describe(error)}`);
      });
  }

  /** End a session once: drop the socket, end the stream, close the row. */
  private finish(session: LiveSession, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    this.live.delete(session.id);
    session.connection.destroy();
    session.events.complete();

    session.writes = session.writes
      .then(() => this.markClosed(session.organizationId, session.id, reason))
      .catch((error: unknown) => {
        this.logger.error(
          `could not close console session ${session.id} in the audit table: ${describe(error)}`,
        );
      });
  }

  private async markClosed(organizationId: string, id: string, reason: string): Promise<void> {
    await this.db.withTenant(organizationId, (q) =>
      q.query(
        `UPDATE console_sessions
            SET closed_at = now(), close_reason = $2
          WHERE id = $1 AND closed_at IS NULL`,
        [id, reason],
      ),
    );
  }

  /**
   * Shut every shell before the process goes.
   *
   * The sockets would die with the process anyway; what would not happen by itself is the row
   * being closed, and `enableShutdownHooks` in `main.ts` is what gives this the chance to run.
   */
  async onModuleDestroy(): Promise<void> {
    const sessions = [...this.live.values()];
    for (const session of sessions) {
      session.connection.requestClose();
      this.finish(session, 'shutdown');
    }
    // The audit writes are queued behind each session's chain; waiting for them is the difference
    // between a recorded shutdown and a table full of sessions that look open forever.
    await Promise.allSettled(sessions.map((session) => session.writes));
  }
}

function toView(session: LiveSession): ConsoleSessionView {
  return {
    id: session.id,
    username: session.username,
    privileged: session.privileged,
    openedAt: session.openedAt.toISOString(),
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
