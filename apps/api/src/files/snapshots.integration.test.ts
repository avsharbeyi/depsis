import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentRequest, AgentResponse, AgentService } from '../agent/agent.service.js';
import { ProblemException } from '../common/problem.filter.js';
import { AuditService } from '../audit/audit.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { BackupsService } from '../system/backups.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { CopyService } from './copy.service.js';
import { FilesService } from './files.service.js';
import { SnapshotBrowseController } from './snapshots.controller.js';

/**
 * Browsing a snapshot and restoring out of it, against a real PostgreSQL.
 *
 * The split is the one the rest of this repository draws. Whether the agent can actually cross into
 * `<share>/.zfs/snapshot/<name>` — one mount boundary and no more — is measured in `unix.rs`
 * against a real `mount --bind`, because it can only be measured there. What is measured HERE is
 * everything the agent cannot see: who is allowed to look at a snapshot at all, that an
 * unreachable pool is reported as unreachable rather than as an empty history, that a restore
 * never lands on a name that is taken, and that the job it enqueues carries what the worker needs.
 *
 * The permission rule is the reason this file exists. Browsing history is share-wide — grants are
 * per folder and a snapshot's tree cannot be mapped onto them, because the folder somebody wants
 * back is usually the one that no longer exists. So the rule is `download` on the share ROOT, it
 * fails closed, and a test that did not pin it would let a later refactor widen it silently.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

interface AgentBehaviour {
  /** What `snapshot_entries` answers. Default: one folder and one file. */
  listing?: AgentResponse;
}

function stubAgent(behaviour: AgentBehaviour = {}): {
  agent: AgentService;
  calls: AgentRequest[];
} {
  const calls: AgentRequest[] = [];
  const agent = {
    isAvailable: () => true,
    call: (request: AgentRequest): Promise<AgentResponse> => {
      calls.push(request);
      if (request.op === 'snapshot_entries') {
        return Promise.resolve<AgentResponse>(
          behaviour.listing ?? {
            status: 'listing',
            truncated: false,
            entries: [
              { name: 'belgeler', directory: true, size: 0, modified_unix: 1_700_000_000 },
              { name: 'rapor.txt', directory: false, size: 12, modified_unix: 1_700_000_100 },
            ],
          },
        );
      }
      return Promise.resolve<AgentResponse>({ status: 'ok', schema_version: 17 });
    },
  } as unknown as AgentService;
  return { agent, calls };
}

interface Enqueued {
  kind: string;
  payload: Record<string, unknown>;
  options: unknown;
}

function stubJobs(): { jobs: JobsService; enqueued: Enqueued[] } {
  const enqueued: Enqueued[] = [];
  const jobs = {
    enqueue: (
      _organizationId: string,
      kind: string,
      payload: Record<string, unknown>,
      options: unknown,
    ): Promise<string> => {
      enqueued.push({ kind, payload, options });
      return Promise.resolve('00000000-0000-4000-8000-0000000000aa');
    },
  } as unknown as JobsService;
  return { jobs, enqueued };
}

function stubBackups(answer: Awaited<ReturnType<BackupsService['inventory']>>): BackupsService {
  return { inventory: () => Promise.resolve(answer) } as unknown as BackupsService;
}

function asRequest(organizationId: string, userId: string, role: string): AuthenticatedRequest {
  // `headers` as well as the session: `requireSameOrigin` reads `origin`, `referer` and `host`,
  // and a fixture without them throws a TypeError that every assertion below would then be
  // measuring instead of the thing it names.
  return {
    depsis: { organizationId, userId, role },
    headers: {},
  } as unknown as AuthenticatedRequest;
}

/** The code a `ProblemException` carries, or the error itself if it is not one. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProblemException) return error.code;
    return `not a ProblemException: ${error instanceof Error ? error.message : String(error)}`;
  }
  return 'no error was thrown';
}

describeDb('browsing a snapshot and restoring out of it', () => {
  let db: DbService;
  let owner: DbService;
  let org = '';
  let admin = '';
  let stranger = '';
  let share = '';
  let folder = '';

  const SNAPSHOTS = [
    {
      dataset: 'tank/snap/share',
      name: 'gunluk-2026-08-24',
      usedBytes: 4096,
      createdAt: new Date('2026-08-24T03:00:00Z'),
    },
    {
      dataset: 'tank/snap/share',
      name: 'gunluk-2026-08-25',
      usedBytes: 8192,
      createdAt: new Date('2026-08-25T03:00:00Z'),
    },
  ];

  function controller(options: {
    agent?: AgentService;
    jobs?: JobsService;
    backups?: BackupsService;
  }): SnapshotBrowseController {
    const agent = options.agent ?? stubAgent().agent;
    const posix = new PosixIdentityService(db);
    const files = new FilesService(db, agent, posix, new JobsService(db));
    const copies = new CopyService(db, agent, files, posix);
    return new SnapshotBrowseController(
      files,
      copies,
      options.backups ?? stubBackups(SNAPSHOTS),
      agent,
      options.jobs ?? stubJobs().jobs,
      new AuditService(db),
    );
  }

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name) VALUES ('snap-a','Snap A')
         ON CONFLICT (slug) DO NOTHING`,
      );
      org =
        (
          await q.query<{ id: string }>(
            `SELECT id::text AS id FROM organizations WHERE slug = 'snap-a'`,
          )
        )[0]?.id ?? '';
      await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
      await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);

      const users = await q.query<{ username: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1,'snap-admin','admin','x'), ($1,'snap-stranger','member','x')
         RETURNING username, id::text AS id`,
        [org],
      );
      admin = users.find((row) => row.username === 'snap-admin')?.id ?? '';
      stranger = users.find((row) => row.username === 'snap-stranger')?.id ?? '';

      share =
        (
          await q.query<{ id: string }>(
            `INSERT INTO shares (organization_id, name, dataset)
             VALUES ($1,'Belgeler','tank/snap/share') RETURNING id::text AS id`,
            [org],
          )
        )[0]?.id ?? '';

      folder =
        (
          await q.query<{ id: string }>(
            `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path)
             VALUES ($1,$2,NULL,'folder','Arsiv','/Arsiv') RETURNING id::text AS id`,
            [org, share],
          )
        )[0]?.id ?? '';

      // A file already holding the name the restore will ask for, so the free-name rule has
      // something to collide with.
      await q.query(
        `INSERT INTO file_entries (organization_id, share_id, parent_id, kind, name, path, size_bytes)
         VALUES ($1,$2,$3,'file','rapor.txt','/Arsiv/rapor.txt',5)`,
        [org, share, folder],
      );
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM job_queue WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM file_entries WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM folder_grants WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM shares WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM team_members WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM teams WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM audit_events WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM users WHERE organization_id = $1`, [org]);
        await q.query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('lists the pool’s snapshots, newest first', async () => {
    const page = await controller({}).list(asRequest(org, admin, 'admin'), share);
    expect(page.available).toBe(true);
    // Newest first, and asserted rather than assumed: the agent returns them oldest-first and a
    // history is read from the most recent version backwards.
    expect(page.items.map((item) => item.name)).toEqual(['gunluk-2026-08-25', 'gunluk-2026-08-24']);
    expect(page.items[0]?.usedBytes).toBe(8192);
  });

  it('says the pool could not be asked rather than reporting no history', async () => {
    // THE ANSWER THAT MATTERS MOST ON THIS SCREEN. `inventory` returns null when the agent could
    // not be reached, and flattening that into an empty list would tell somebody hunting for a
    // deleted file that there is nothing left to look in — on a box whose backups are all intact
    // and whose agent is restarting.
    const page = await controller({ backups: stubBackups(null) }).list(
      asRequest(org, admin, 'admin'),
      share,
    );
    expect(page.available).toBe(false);
    expect(page.items).toEqual([]);
  });

  it('answers 404 and not 403 to somebody with no grant on the share', async () => {
    // The existence oracle §14 refuses. A member holding a share id from a log line must not learn
    // from the status code that the share is real.
    expect(await codeOf(() => controller({}).list(asRequest(org, stranger, 'member'), share))).toBe(
      'not-found',
    );
  });

  it('refuses a member who can read the share but not download from it', async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO folder_grants (organization_id, share_id, entry_id, user_id, permissions)
         VALUES ($1,$2,NULL,$3,ARRAY['list','read']::public.folder_permission[])`,
        [org, share, stranger],
      );
    });

    // `read` is metadata — a name, a size, a date. Browsing history shows the same shape, but a
    // restore takes CONTENTS, and this gate is the one that governs contents for the whole share.
    // Somebody who may see that a file exists must not be able to take yesterday's copy of it.
    expect(await codeOf(() => controller({}).list(asRequest(org, stranger, 'member'), share))).toBe(
      'forbidden',
    );

    // And the same gate on the browsing endpoint, not just on the snapshot list: two routes read
    // the past, and a check on only one of them is a door beside an open window.
    expect(
      await codeOf(() =>
        controller({}).entries(asRequest(org, stranger, 'member'), share, 'gunluk-2026-08-25', ''),
      ),
    ).toBe('forbidden');
  });

  it('passes the share and the snapshot through, and refuses a path that traverses', async () => {
    const { agent, calls } = stubAgent();
    const listing = await controller({ agent }).entries(
      asRequest(org, admin, 'admin'),
      share,
      'gunluk-2026-08-25',
      'belgeler/2026',
    );

    expect(listing.items.map((item) => item.name)).toEqual(['belgeler', 'rapor.txt']);
    expect(listing.path).toEqual(['belgeler', '2026']);
    const asked = calls.find((call) => call.op === 'snapshot_entries');
    expect(asked).toMatchObject({
      share: 'Belgeler',
      snapshot: 'gunluk-2026-08-25',
      path: ['belgeler', '2026'],
    });

    // The agent checks every component again — it is the side that enforces the boundary — but a
    // `..` refused here never becomes an operand at all.
    expect(
      await codeOf(() =>
        controller({ agent }).entries(
          asRequest(org, admin, 'admin'),
          share,
          'gunluk-2026-08-25',
          'belgeler/../../etc',
        ),
      ),
    ).toBe('validation-failed');

    // And a snapshot name that could be read as a path, or as an option.
    for (const bad of ['../evil', '-rf', 'a/b']) {
      expect(
        await codeOf(() =>
          controller({ agent }).entries(asRequest(org, admin, 'admin'), share, bad, ''),
        ),
        bad,
      ).toBe('validation-failed');
    }
  });

  it('reports an unreadable snapshot rather than showing it as an empty folder', async () => {
    // The failure the limitations document called a door believed to be shut. If the agent could
    // not cross into the snapshot's mount, an empty listing would read as "this snapshot holds
    // nothing" — and the person looking at it would conclude their file is really gone.
    const { agent } = stubAgent({
      listing: { status: 'refused', reason: 'daily-1: refused by the path confinement' },
    });
    expect(
      await codeOf(() =>
        controller({ agent }).entries(asRequest(org, admin, 'admin'), share, 'daily-1', ''),
      ),
    ).toBe('dependency-unavailable');
  });

  it('restores under a free name, says which, and enqueues what the worker needs', async () => {
    const { jobs, enqueued } = stubJobs();
    const accepted = await controller({ jobs }).restore(
      asRequest(org, admin, 'admin'),
      share,
      'gunluk-2026-08-24',
      { path: ['Arsiv', 'rapor.txt'], destinationId: folder },
    );

    // `rapor.txt` is already in that folder. The restore does NOT overwrite it — the whole reason
    // somebody opens history is not being sure which copy they want — and the name it chose is in
    // the answer so the interface can say where the file will land.
    expect(accepted.name).toBe('rapor (2).txt');
    expect(accepted.jobId).toBe('00000000-0000-4000-8000-0000000000aa');

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.kind).toBe('files.restore-snapshot');
    expect(enqueued[0]?.payload).toMatchObject({
      shareId: share,
      snapshot: 'gunluk-2026-08-24',
      from: ['Arsiv', 'rapor.txt'],
      destinationId: folder,
      name: 'rapor (2).txt',
      actorId: admin,
    });
  });

  it('keeps the original name when nothing holds it', async () => {
    const { jobs, enqueued } = stubJobs();
    const accepted = await controller({ jobs }).restore(
      asRequest(org, admin, 'admin'),
      share,
      'gunluk-2026-08-24',
      { path: ['Arsiv', 'sunum.pdf'], destinationId: folder },
    );
    expect(accepted.name).toBe('sunum.pdf');
    expect(enqueued[0]?.payload['name']).toBe('sunum.pdf');
  });

  it('refuses a restore with no file named', async () => {
    expect(
      await codeOf(() =>
        controller({}).restore(asRequest(org, admin, 'admin'), share, 'gunluk-2026-08-24', {
          path: [],
          destinationId: null,
        }),
      ),
    ).toBe('validation-failed');
  });

  it('refuses a path component the agent will refuse, instead of enqueuing a job that dies', async () => {
    // The body's `path` went straight into the job. The agent parses each component as an
    // `EntryName` and refuses `..`, a separator or a NUL — but it does that in the WORKER, after
    // this endpoint has already answered 202 and written "geri yükleme istendi" into the audit
    // log. The user was told their file was coming back and then watched a job die five times
    // with no reason anywhere they could see.
    const { jobs, enqueued } = stubJobs();
    for (const path of [['..', 'rapor.txt'], ['Arsiv/rapor.txt'], ['rapor\0.txt'], ['.depsis']]) {
      expect(
        await codeOf(() =>
          controller({ jobs }).restore(asRequest(org, admin, 'admin'), share, 'gunluk-2026-08-24', {
            path,
            destinationId: folder,
          }),
        ),
      ).toBe('validation-failed');
    }
    expect(enqueued).toEqual([]);
  });

  it('still restores a file whose name begins with a dash', async () => {
    // The browse path refuses a leading dash and this one must not: `EntryName` (schema 43) took
    // path and entry-name positions out of every argv, so `-eski.txt` is an ordinary file that
    // gets indexed and backed up — and therefore a file somebody can lose and want back.
    const { jobs, enqueued } = stubJobs();
    const accepted = await controller({ jobs }).restore(
      asRequest(org, admin, 'admin'),
      share,
      'gunluk-2026-08-24',
      { path: ['Arsiv', '-eski.txt'], destinationId: folder },
    );

    expect(accepted.name).toBe('-eski.txt');
    expect(enqueued).toHaveLength(1);
  });
});
