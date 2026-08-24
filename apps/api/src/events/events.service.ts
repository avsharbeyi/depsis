import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

import { DbService } from '../db/db.service.js';

/** What a subscriber is told about. */
export interface DepsisEvent {
  /** `job` or `transfer`. The SSE event name the browser dispatches on. */
  type: 'job' | 'transfer' | 'ping';
  /** The resume point. Milliseconds since the epoch, as text — see `since` below. */
  id: string;
  data: unknown;
}

interface Subscriber {
  organizationId: string;
  userId: string;
  isAdmin: boolean;
  subject: Subject<DepsisEvent>;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  progress: number;
  created_at: Date;
  updated_at: Date;
  last_error: string | null;
}

interface TransferRow {
  id: string;
  filename: string;
  length_bytes: string;
  offset_bytes: string;
  completed: boolean;
  updated_at: Date;
}

/**
 * §14's event stream, as a watermark poller with a fan-out.
 *
 * WHY POLLING AND NOT `LISTEN`/`NOTIFY`. The work that produces these events happens in the WORKER
 * process, not this one, so a push would have to cross a process boundary. PostgreSQL can do that
 * and ADR-0003 asks for it — but it also says in the same breath that `NOTIFY` cannot be the only
 * wake mechanism, because a notification delivered while nothing is listening is simply gone. So a
 * poller is needed either way, and a design that needs the poller anyway plus a dedicated
 * `LISTEN` connection is two mechanisms where one suffices. `apps/worker` reached the same
 * conclusion for the same reason and says so in `worker.service.ts`.
 *
 * ONE TIMER FOR THE WHOLE PROCESS, not one per subscriber. Ten open tabs are ten subscribers and
 * one query per tick; the alternative multiplies database load by the number of browser windows,
 * which is exactly the shape of load a NAS with four users should never generate.
 *
 * THE TIMER ONLY RUNS WHILE SOMEBODY IS LISTENING. It is started by the first subscriber and
 * cleared by the last, so an appliance nobody is looking at does no work.
 *
 * DELIVERY IS AT-LEAST-ONCE and the watermark is why. `updated_at` is compared with `>`, and two
 * rows written in the same microsecond would otherwise race the cursor; on reconnect the client's
 * `Last-Event-ID` is rewound by a millisecond for the same reason. A duplicate is harmless here —
 * every event carries the whole row and the client replaces by id — while a miss is a job that
 * stays "running" on screen forever.
 */
@Injectable()
export class EventsService implements OnModuleDestroy {
  /**
   * Two seconds, matching what `Transfers.tsx` was already polling at.
   *
   * The stream is not here to be faster than that; it is here so ten screens cost one query
   * instead of ten, and so a screen that is NOT open costs nothing.
   */
  private static readonly TICK_MS = 2_000;

  /**
   * Twenty seconds between pings.
   *
   * An idle SSE connection is indistinguishable from a dead one to anything in the path — a
   * reverse proxy will close it, and the browser will not notice until it tries to read. A comment
   * frame keeps the connection observably alive and gives the client a heartbeat it can time out
   * against.
   */
  private static readonly PING_MS = 20_000;

  /**
   * How many streams this process will hold at once.
   *
   * Each is an open HTTP response and a row in the map, which is cheap — the number is here so
   * that "cheap" has a bound, not because 64 is expensive. A NAS with four users and three tabs
   * each is at twelve.
   */
  static readonly MAX_STREAMS = 64;

  private readonly logger = new Logger(EventsService.name);
  private readonly subscribers = new Map<number, Subscriber>();
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  /** Per organisation, the newest `updated_at` already sent. */
  private watermark = new Map<string, Date>();
  private ticking = false;

  constructor(private readonly db: DbService) {}

  /** True when this process has no room for another stream. */
  get full(): boolean {
    return this.subscribers.size >= EventsService.MAX_STREAMS;
  }

  /**
   * Open a stream.
   *
   * `since` is the client's `Last-Event-ID`, when it sent one. It seeds this organisation's
   * watermark BACKWARDS only — a reconnecting client may ask to see events again, and must not be
   * able to make another subscriber skip forward past events it has not received.
   */
  subscribe(
    organizationId: string,
    userId: string,
    isAdmin: boolean,
    since: Date | null,
  ): Observable<DepsisEvent> {
    const subject = new Subject<DepsisEvent>();
    const key = this.nextId++;
    this.subscribers.set(key, { organizationId, userId, isAdmin, subject });

    const current = this.watermark.get(organizationId);
    if (since !== null && (current === undefined || since < current)) {
      this.watermark.set(organizationId, since);
    } else if (current === undefined) {
      // No history for a fresh stream. The client fetches a snapshot over the ordinary REST route
      // and this carries what changes AFTER it — replaying yesterday's finished jobs into a
      // just-opened screen would be noise, not state.
      this.watermark.set(organizationId, new Date());
    }

    this.start();

    return new Observable<DepsisEvent>((observer) => {
      const inner = subject.subscribe(observer);
      return () => {
        inner.unsubscribe();
        this.subscribers.delete(key);
        this.stopIfIdle();
      };
    });
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.pinger !== null) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    for (const subscriber of this.subscribers.values()) subscriber.subject.complete();
    this.subscribers.clear();
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), EventsService.TICK_MS);
    this.pinger = setInterval(() => {
      const at = String(Date.now());
      for (const subscriber of this.subscribers.values()) {
        subscriber.subject.next({ type: 'ping', id: at, data: { at } });
      }
    }, EventsService.PING_MS);
  }

  private stopIfIdle(): void {
    if (this.subscribers.size > 0 || this.timer === null) return;
    clearInterval(this.timer);
    if (this.pinger !== null) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    // Dropped, not kept: the next subscriber starts from now, and a stale mark held across an idle
    // hour would replay that hour into the first screen that opened.
    this.watermark.clear();
  }

  /**
   * One pass.
   *
   * Guarded by `ticking` rather than by trusting the interval: a slow database would otherwise
   * overlap two passes, and the second would read the watermark the first has not written yet and
   * send everything twice.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const organizationId of new Set(
        [...this.subscribers.values()].map((s) => s.organizationId),
      )) {
        await this.pump(organizationId);
      }
    } catch (error) {
      // Logged and swallowed. A failed poll must not tear down every open stream — the next tick
      // is two seconds away and the watermark has not moved, so nothing is lost.
      this.logger.warn(
        `event poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async pump(organizationId: string): Promise<void> {
    const since = this.watermark.get(organizationId);
    if (since === undefined) return;

    const listeners = [...this.subscribers.values()].filter(
      (s) => s.organizationId === organizationId,
    );
    if (listeners.length === 0) return;

    const wantsJobs = listeners.some((s) => s.isAdmin);
    const owners = new Set(listeners.map((s) => s.userId));

    let newest = since;
    const emit = (event: DepsisEvent, to: Subscriber[]): void => {
      for (const subscriber of to) subscriber.subject.next(event);
    };

    if (wantsJobs) {
      const jobs = await this.jobsSince(organizationId, since);
      const admins = listeners.filter((s) => s.isAdmin);
      for (const row of jobs) {
        if (row.updated_at > newest) newest = row.updated_at;
        emit(
          {
            type: 'job',
            id: String(row.updated_at.getTime()),
            data: {
              id: row.id,
              kind: row.kind,
              status: row.status,
              progress: row.progress,
              createdAt: row.created_at.toISOString(),
              ...(row.last_error === null ? {} : { error: { title: row.last_error } }),
            },
          },
          admins,
        );
      }
    }

    for (const userId of owners) {
      const rows = await this.transfersSince(organizationId, userId, since);
      const mine = listeners.filter((s) => s.userId === userId);
      for (const row of rows) {
        if (row.updated_at > newest) newest = row.updated_at;
        emit(
          {
            type: 'transfer',
            id: String(row.updated_at.getTime()),
            data: {
              id: row.id,
              filename: row.filename,
              lengthBytes: Number(row.length_bytes),
              offsetBytes: Number(row.offset_bytes),
              completed: row.completed,
            },
          },
          mine,
        );
      }
    }

    this.watermark.set(organizationId, newest);
  }

  /**
   * Jobs that moved, from BOTH tables.
   *
   * `finish_job` deletes the row from `job_queue` and inserts it into `job_history`, so the one
   * transition a screen most needs — running to succeeded, or to dead — is the transition where
   * the row leaves the table a poller would naturally watch. Reading only `job_queue` would show
   * every job progressing and none of them ever finishing.
   */
  private async jobsSince(organizationId: string, since: Date): Promise<JobRow[]> {
    return this.db.withTenant(organizationId, (q) =>
      q.query<JobRow>(
        `SELECT id::text AS id, kind, status, progress, created_at, updated_at, last_error
           FROM public.job_queue
          WHERE organization_id = $1 AND updated_at > $2
          UNION ALL
         SELECT id::text AS id, kind, status, progress, created_at, updated_at, last_error
           FROM public.job_history
          WHERE organization_id = $1 AND updated_at > $2
          ORDER BY updated_at
          LIMIT 200`,
        [organizationId, since],
      ),
    );
  }

  /**
   * This user's uploads that moved.
   *
   * Scoped to `created_by` rather than to the organisation, and that is the whole authorisation
   * model of this half: `GET /transfers` shows a person their own uploads, so the stream shows the
   * same set. A tenant-wide transfer feed would tell every member what every other member is
   * uploading, by filename.
   */
  private async transfersSince(
    organizationId: string,
    userId: string,
    since: Date,
  ): Promise<TransferRow[]> {
    return this.db.withTenant(organizationId, (q) =>
      q.query<TransferRow>(
        `SELECT id::text AS id, filename, length_bytes::text AS length_bytes,
                offset_bytes::text AS offset_bytes,
                (completed_at IS NOT NULL) AS completed, updated_at
           FROM public.upload_sessions
          WHERE organization_id = $1 AND created_by = $2 AND updated_at > $3
          ORDER BY updated_at
          LIMIT 200`,
        [organizationId, userId, since],
      ),
    );
  }
}
