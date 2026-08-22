import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AdminGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import {
  AlreadyInstalledError,
  AppNotInCatalogueError,
  AppsService,
  MountTargetError,
  NotInstalledError,
  RootfulRuntimeError,
  ShareNotFoundError,
  SharesRootMissingError,
  mapState,
} from './apps.service.js';
import {
  containerNameFor,
  imageReference,
  PodmanClient,
  PodmanError,
  PodmanUnavailableError,
  type ContainerName,
  type CreateContainerSpec,
  type ContainerSummary,
  type PodmanInfo,
} from './podman.client.js';

/**
 * The application catalogue, in three layers.
 *
 * The first two need a database and no container runtime, because that is where the rules that
 * matter live: the catalogue is a boundary (a user cannot name an image), and a share id is a
 * capability (a user cannot bind another tenant's data). Both are refused before podman is
 * contacted, and a test that needed a container runtime to prove it would be a test nobody runs.
 *
 * The third needs a real podman and creates a real container. It uses `docker.io/library/alpine`
 * — three megabytes — and drives `PodmanClient` DIRECTLY rather than going through the catalogue,
 * which is a deliberate trade: every catalogue row is a media server of several hundred megabytes,
 * and a test suite that pulls Jellyfin is a test suite that gets disabled. What is being checked
 * there is the client's own contract with libpod (create, start, state, logs, remove with volumes
 * intact), which is the part that would break silently if podman changed its API.
 *
 * Skipped, loudly, when the thing under test is absent: no `DEPSIS_TEST_DATABASE_URL`, no database
 * layers; no podman socket, no runtime layer.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];

const dbRunnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = dbRunnable ? describe : describe.skip;

const PODMAN_SOCKET = process.env['DEPSIS_TEST_PODMAN_SOCKET'] ?? '/run/podman/podman.sock';
const podmanRunnable = existsSync(PODMAN_SOCKET);
const describePodman = podmanRunnable ? describe : describe.skip;

const SHARES_ROOT = '/srv/depsis/shares';

/**
 * A podman that answers without a podman.
 *
 * Records what it was asked to create, which is the only way to assert the thing this module is
 * really for: that the host side of every bind mount was derived from a share row and not taken
 * from the request.
 */
class RecordingPodman {
  created: CreateContainerSpec[] = [];
  pulled: string[] = [];
  removed: ContainerName[] = [];
  started: ContainerName[] = [];
  stopped: ContainerName[] = [];
  containers: ContainerSummary[] = [];
  /** ADR-0019's privilege decision, as the client would report it. */
  rootless = true;

  info(): Promise<PodmanInfo> {
    return Promise.resolve({ version: '5.4.2', rootless: this.rootless });
  }
  listContainers(): Promise<ContainerSummary[]> {
    return Promise.resolve(this.containers);
  }
  pullImage(reference: string): Promise<void> {
    this.pulled.push(reference);
    return Promise.resolve();
  }
  createContainer(spec: CreateContainerSpec): Promise<void> {
    this.created.push(spec);
    return Promise.resolve();
  }
  startContainer(name: ContainerName): Promise<void> {
    this.started.push(name);
    return Promise.resolve();
  }
  stopContainer(name: ContainerName): Promise<void> {
    this.stopped.push(name);
    return Promise.resolve();
  }
  removeContainer(name: ContainerName): Promise<void> {
    this.removed.push(name);
    return Promise.resolve();
  }
  logs(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

describeDb('the catalogue is a boundary, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let podman: RecordingPodman;
  let apps: AppsService;

  let orgA = '';
  let orgB = '';
  let adminA = '';
  let shareMedia = '';
  let shareConfig = '';
  let shareOther = '';

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);
    podman = new RecordingPodman();
    apps = new AppsService(db, podman as unknown as PodmanClient, SHARES_ROOT);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('apps-a','Apps A'), ('apps-b','Apps B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('apps-a','apps-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'apps-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'apps-b')?.id ?? '';

      const seeded = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'apps-admin', 'admin', 'x')
         RETURNING id::text AS id`,
        [orgA],
      );
      adminA = seeded[0]?.id ?? '';

      const sharesA = await q.query<{ name: string; id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'Filmler','tank/shares/filmler'), ($1,'AppData','tank/shares/appdata')
         RETURNING name, id::text AS id`,
        [orgA],
      );
      shareMedia = sharesA.find((r) => r.name === 'Filmler')?.id ?? '';
      shareConfig = sharesA.find((r) => r.name === 'AppData')?.id ?? '';

      const sharesB = await q.query<{ id: string }>(
        `INSERT INTO shares (organization_id, name, dataset)
         VALUES ($1,'Gizli','tank/shares/gizli')
         RETURNING id::text AS id`,
        [orgB],
      );
      shareOther = sharesB[0]?.id ?? '';
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM app_instances WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM shares WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  it('lists the seeded catalogue and reports nothing installed', async () => {
    const overview = await apps.list(orgA);
    expect(overview.apps.map((a) => a.catalogue.slug)).toEqual(
      expect.arrayContaining(['jellyfin', 'navidrome', 'immich', 'syncthing', 'qbittorrent']),
    );
    expect(overview.apps.every((a) => a.instance === null)).toBe(true);
    expect(overview.runtime?.version).toBe('5.4.2');
  });

  it('pins every catalogue image and never says latest', async () => {
    // Migration 0013 has a CHECK for this; asserted here too because the reason is a product one —
    // a NAS whose media server silently changes version overnight is a NAS that loses data — and a
    // future row added by a future migration should trip this test, not just the constraint.
    const overview = await apps.list(orgA);
    for (const app of overview.apps) {
      expect(app.catalogue.tag, app.catalogue.slug).not.toBe('latest');
      expect(() => imageReference(app.catalogue.image, app.catalogue.tag)).not.toThrow();
    }
  });

  it('refuses a slug that is not in the catalogue', async () => {
    await expect(apps.install(orgA, adminA, 'my-own-image', [])).rejects.toBeInstanceOf(
      AppNotInCatalogueError,
    );
  });

  it('refuses a mount point the catalogue does not describe', async () => {
    // The one that matters most: if this passed, an administrator could bind a share anywhere in a
    // container's filesystem, which is most of the way to arbitrary code with that share's data.
    await expect(
      apps.install(orgA, adminA, 'jellyfin', [
        { target: '/media', shareId: shareMedia },
        { target: '/config', shareId: shareConfig },
        { target: '/etc', shareId: shareMedia },
      ]),
    ).rejects.toBeInstanceOf(MountTargetError);
    expect(podman.created).toHaveLength(0);
  });

  it('refuses an install that leaves a catalogue mount point unfilled', async () => {
    await expect(
      apps.install(orgA, adminA, 'jellyfin', [{ target: '/media', shareId: shareMedia }]),
    ).rejects.toBeInstanceOf(MountTargetError);
  });

  it("refuses another tenant's share id", async () => {
    // §20's access-control gate, in the shape this module can get it wrong: the request names a
    // share by id, and the id of a share in another organisation must not resolve. Row level
    // security is what makes it not resolve — the query carries no organisation and could not.
    await expect(
      apps.install(orgA, adminA, 'jellyfin', [
        { target: '/media', shareId: shareOther },
        { target: '/config', shareId: shareConfig },
      ]),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
    expect(podman.created).toHaveLength(0);
  });

  it('refuses a share id that exists nowhere', async () => {
    await expect(
      apps.install(orgA, adminA, 'jellyfin', [
        { target: '/media', shareId: '00000000-0000-4000-8000-000000000000' },
        { target: '/config', shareId: shareConfig },
      ]),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it('refuses to install when no share tree is configured', async () => {
    const rootless = new AppsService(db, podman as unknown as PodmanClient, null);
    await expect(
      rootless.install(orgA, adminA, 'jellyfin', [
        { target: '/media', shareId: shareMedia },
        { target: '/config', shareId: shareConfig },
      ]),
    ).rejects.toBeInstanceOf(SharesRootMissingError);
  });

  it('derives the host path from the share and binds only 127.0.0.1', async () => {
    const view = await apps.install(orgA, adminA, 'jellyfin', [
      { target: '/media', shareId: shareMedia },
      { target: '/config', shareId: shareConfig },
    ]);

    expect(view.instance?.container_name).toBe(containerNameFor('jellyfin', orgA));
    expect(view.instance?.host_port).toBeGreaterThanOrEqual(1024);
    expect(view.instance?.host_port).toBeLessThanOrEqual(65535);

    const spec = podman.created.at(-1);
    expect(spec?.image).toBe('docker.io/jellyfin/jellyfin:10.10.7');
    // The paths were never in the request. `Filmler` and `AppData` are the share NAMES, joined to
    // the configured root — the request only ever carried two uuids.
    expect(spec?.mounts.map((m) => [m.destination, m.source, m.readOnly])).toEqual([
      ['/media', `${SHARES_ROOT}/Filmler`, true],
      ['/config', `${SHARES_ROOT}/AppData`, false],
    ]);
    // The catalogue's environment, and only the catalogue's.
    expect(spec?.env).toEqual({ TZ: 'Europe/Istanbul' });
    expect(spec?.containerPort).toBe(8096);
  });

  it('reports it as installed, with state read from the runtime', async () => {
    podman.containers = [{ names: [containerNameFor('jellyfin', orgA)], state: 'running' }];
    const overview = await apps.list(orgA);
    const jellyfin = overview.apps.find((a) => a.catalogue.slug === 'jellyfin');
    expect(jellyfin?.instance).not.toBeNull();
    expect(jellyfin?.state).toBe('running');

    // And when podman stops reporting it, the answer changes without anything being written.
    podman.containers = [];
    const again = await apps.list(orgA);
    expect(again.apps.find((a) => a.catalogue.slug === 'jellyfin')?.state).toBe('error');
  });

  it('does not show one tenant the other tenant’s installs', async () => {
    const overview = await apps.list(orgB);
    expect(overview.apps.every((a) => a.instance === null)).toBe(true);
  });

  it('refuses a second install of the same application', async () => {
    await expect(
      apps.install(orgA, adminA, 'jellyfin', [
        { target: '/media', shareId: shareMedia },
        { target: '/config', shareId: shareConfig },
      ]),
    ).rejects.toBeInstanceOf(AlreadyInstalledError);
  });

  it('gives a second application a different port', async () => {
    const first = await apps.install(orgA, adminA, 'syncthing', [
      { target: '/var/syncthing', shareId: shareConfig },
    ]);
    const overview = await apps.list(orgA);
    const ports = overview.apps
      .map((a) => a.instance?.host_port)
      .filter((port): port is number => port !== undefined);
    expect(new Set(ports).size).toBe(ports.length);
    expect(first.instance?.host_port).not.toBeUndefined();
  });

  it('removes the container and leaves the shares alone', async () => {
    const before = await countShares(owner, orgA);
    await apps.remove(orgA, 'syncthing');

    expect(podman.removed).toContain(containerNameFor('syncthing', orgA));
    expect(await countShares(owner, orgA)).toBe(before);

    const overview = await apps.list(orgA);
    expect(overview.apps.find((a) => a.catalogue.slug === 'syncthing')?.instance).toBeNull();
  });

  it('refuses to act on an application that is not installed', async () => {
    await expect(apps.setState(orgA, 'immich', 'running')).rejects.toBeInstanceOf(
      NotInstalledError,
    );
    await expect(apps.logs(orgA, 'immich', 10)).rejects.toBeInstanceOf(NotInstalledError);
    await expect(apps.remove(orgA, 'immich')).rejects.toBeInstanceOf(NotInstalledError);
  });

  it('refuses to install through a ROOT podman socket unless told to', async () => {
    // ADR-0019's privilege argument — "the worst thing reachable is the depsis-apps user's own
    // authority" — is only true while the socket is rootless, and `config.ts` DEFAULTS to the root
    // socket because that is what a distribution package installs. So a deployment that set
    // nothing at all was creating uid-0 containers with a user share bound in rw, with a boolean
    // in the UI as the only sign. The refusal is what makes the unsafe direction deliberate.
    const rootful = new RecordingPodman();
    rootful.rootless = false;
    const strict = new AppsService(db, rootful as unknown as PodmanClient, SHARES_ROOT);

    await expect(
      strict.install(orgA, adminA, 'navidrome', [
        { target: '/music', shareId: shareMedia },
        { target: '/data', shareId: shareConfig },
      ]),
    ).rejects.toBeInstanceOf(RootfulRuntimeError);
    // Refused BEFORE anything was pulled or reserved: an image is code downloaded from the
    // internet, so the check has to come before the download, not after it.
    expect(rootful.pulled).toHaveLength(0);
    expect(rootful.created).toHaveLength(0);

    // Starting runs the code, so it is refused too.
    await expect(strict.setState(orgA, 'jellyfin', 'running')).rejects.toBeInstanceOf(
      RootfulRuntimeError,
    );
    expect(rootful.started).toHaveLength(0);

    // Stopping and removing are not: an operator who ends up on a rootful box has to be able to
    // wind it down, and neither of those starts anything.
    await expect(strict.setState(orgA, 'jellyfin', 'stopped')).resolves.toBeDefined();
    expect(rootful.stopped).toContain(containerNameFor('jellyfin', orgA));
  });

  it('installs through a root socket when the deployment says so in writing', async () => {
    const rootful = new RecordingPodman();
    rootful.rootless = false;
    const permissive = new AppsService(db, rootful as unknown as PodmanClient, SHARES_ROOT, true);

    const view = await permissive.install(orgA, adminA, 'navidrome', [
      { target: '/music', shareId: shareMedia },
      { target: '/data', shareId: shareConfig },
    ]);
    expect(view.instance?.container_name).toBe(containerNameFor('navidrome', orgA));
    await permissive.remove(orgA, 'navidrome');
  });

  it('reads the state back from podman rather than repeating what was asked', async () => {
    // The contract says `state` comes from the runtime. It matters most in the case that produced
    // the 304 bug: a start on a container that was already running is a success, and the value
    // reported afterwards should be a reading rather than an echo of the request.
    podman.containers = [{ names: [containerNameFor('jellyfin', orgA)], state: 'running' }];
    const started = await apps.setState(orgA, 'jellyfin', 'running');
    expect(started.state).toBe('running');

    // podman disagreeing with the request is reported, not overwritten.
    podman.containers = [{ names: [containerNameFor('jellyfin', orgA)], state: 'running' }];
    const stopped = await apps.setState(orgA, 'jellyfin', 'stopped');
    expect(stopped.state).toBe('running');
  });

  it('still shows the catalogue when there is no container runtime at all', async () => {
    // The graceful-degradation decision, mirroring `/remote`. The catalogue is a database table
    // and the installed rows are database rows; neither needs podman. A 503 here would mean the
    // page cannot render at all on a box without a runtime, so there would be nowhere to draw the
    // "no container runtime here" card — and `AppPage.runtime.available` could never be false.
    const absent = {
      info: () => Promise.reject(new PodmanUnavailableError('ENOENT')),
      listContainers: () => Promise.reject(new PodmanUnavailableError('ENOENT')),
    };
    const offline = new AppsService(db, absent as unknown as PodmanClient, SHARES_ROOT);

    const overview = await offline.list(orgA);
    expect(overview.runtime).toBeNull();
    expect(overview.apps.map((a) => a.catalogue.slug)).toContain('jellyfin');
    // Installed, but nobody can say what it is doing. `unknown`, not `error` — `error` means a
    // WORKING podman has never heard of the container, which is a different problem.
    expect(overview.apps.find((a) => a.catalogue.slug === 'jellyfin')?.state).toBe('unknown');
  });

  it('still fails when podman answers and says something unexpected', async () => {
    // Only unavailability degrades. A runtime that answered is a runtime whose answer counts.
    const angry = {
      info: () => Promise.reject(new PodmanError(500, 'no space left on device')),
      listContainers: () => Promise.resolve([]),
    };
    const brittle = new AppsService(db, angry as unknown as PodmanClient, SHARES_ROOT);
    await expect(brittle.list(orgA)).rejects.toBeInstanceOf(PodmanError);
  });

  it('removes the reservation again when podman refuses the create', async () => {
    // A row left behind here would hold a port for a container that does not exist, and the next
    // install would fail with a unique-violation nobody could explain.
    const failing = {
      info: () => Promise.resolve({ version: '5.4.2', rootless: true }),
      listContainers: () => Promise.resolve([]),
      pullImage: () => Promise.resolve(),
      createContainer: () => Promise.reject(new PodmanError(500, 'no space left on device')),
    };
    const brittle = new AppsService(db, failing as unknown as PodmanClient, SHARES_ROOT);

    await expect(
      brittle.install(orgA, adminA, 'navidrome', [
        { target: '/music', shareId: shareMedia },
        { target: '/data', shareId: shareConfig },
      ]),
    ).rejects.toBeInstanceOf(PodmanError);

    const overview = await apps.list(orgA);
    expect(overview.apps.find((a) => a.catalogue.slug === 'navidrome')?.instance).toBeNull();
  });
});

async function countShares(owner: DbService, organizationId: string): Promise<number> {
  const rows = await owner.withoutTenant('migration-status', (q) =>
    q.query<{ n: string }>(`SELECT count(*)::text AS n FROM shares WHERE organization_id = $1`, [
      organizationId,
    ]),
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * The guard, which needs neither a database nor a runtime.
 *
 * Outside both gated blocks on purpose: §20's access-control assertions should not be skipped on a
 * machine that happens to have no podman.
 */
describe('who may change what in /apps', () => {
  function contextWith(role: string | undefined): ExecutionContext {
    const request = {
      depsis: role === undefined ? undefined : { organizationId: 'o', userId: 'u', role },
    } as unknown as AuthenticatedRequest;
    return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  }

  it('refuses a member with 403', () => {
    // Installing an application downloads code from the internet and binds a share to it, and
    // stopping one takes a service away from the whole household. `GET /apps` carries no
    // `AdminGuard` and is deliberately not represented here.
    expect(() => new AdminGuard().canActivate(contextWith('member'))).toThrow(ForbiddenException);
  });

  it('admits an administrator', () => {
    expect(new AdminGuard().canActivate(contextWith('admin'))).toBe(true);
  });

  it('fails closed with no session', () => {
    expect(() => new AdminGuard().canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('podman state, translated', () => {
  it('calls a container DEPSIS installed and podman has never heard of an error', () => {
    // Not `stopped`. The two mean different things to whoever is looking at the screen: one is an
    // application somebody turned off, the other is a record and a runtime that disagree.
    expect(mapState(undefined)).toBe('error');
    expect(mapState('running')).toBe('running');
    expect(mapState('exited')).toBe('stopped');
    expect(mapState('created')).toBe('stopped');
    expect(mapState('paused')).toBe('unknown');
  });
});

describePodman('a real container, against the real podman socket', () => {
  const client = new PodmanClient(PODMAN_SOCKET);
  // This block never touches PostgreSQL, so it cannot use the seeded organisation the suite above
  // creates — but `containerNameFor` needs a tenant now, and a fixed literal keeps the container
  // it leaves behind identifiable if a run is killed mid-test.
  const orgA = '01a02904-caa5-754b-9006-3c27a9621647';
  // Alpine, three megabytes. A catalogue row would be several hundred, and a suite that downloads
  // a media server on every run is a suite somebody turns off.
  const image = imageReference('docker.io/library/alpine', '3.21');
  const name = containerNameFor('itest', orgA);

  beforeAll(async () => {
    // Left over from a crashed run. Removing it here rather than only in afterAll is what makes
    // the suite re-runnable after a failure.
    try {
      await client.removeContainer(name);
    } catch {
      // Nothing to remove; that is the normal case.
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await client.removeContainer(name);
    } catch {
      // Already gone.
    }
  }, 60_000);

  it('reports a version, and says whether it is rootless', async () => {
    const info = await client.info();
    expect(info.version).toMatch(/^\d+\./);
    // NOT asserted true. The development box runs the root socket and ADR-0019 wants the rootless
    // one in production; the endpoint reports this field so the difference is visible, and a test
    // that demanded `true` would only be red on the machine that has to run it.
    expect(typeof info.rootless).toBe('boolean');
  });

  it('creates, starts, reads back state and logs, then removes', async () => {
    await client.pullImage(image);
    await client.createContainer({
      name,
      image,
      env: { DEPSIS_ITEST: 'yes' },
      containerPort: 8080,
      // Deliberately in the same range the service allocates from, and freed at the end.
      hostPort: 39_987,
      mounts: [],
    });

    await client.startContainer(name);
    // Twice, against the real daemon. libpod answers 304 to the second one and this client used to
    // call that a failure, so two administrators pressing Start at the same moment — or one
    // impatient double-click — produced a 503 saying the container runtime had refused.
    await client.startContainer(name);

    const running = await client.listContainers();
    const found = running.find((c) => c.names.includes(name));
    expect(found, 'the container should be listed after start').toBeDefined();

    const lines = await client.logs(name, 50);
    // The framing is decoded, so no line begins with the NUL byte a raw multiplexed stream would
    // have put there. This is the assertion the log endpoint exists for.
    for (const line of lines) {
      expect(line.charCodeAt(0)).not.toBe(0);
    }

    // And the same on the way down: stop, then stop again.
    await client.stopContainer(name);
    await client.stopContainer(name);

    await client.removeContainer(name);
    const after = await client.listContainers();
    expect(after.find((c) => c.names.includes(name))).toBeUndefined();
  }, 300_000);

  it('answers 404 for a container that does not exist, not a connection error', async () => {
    // The distinction the controller depends on: podman ANSWERING no is a 404, and only an
    // unreachable socket is a 503.
    await expect(client.startContainer(containerNameFor('nope', orgA))).rejects.toBeInstanceOf(
      PodmanError,
    );
  });
});

describe('a podman that is not there', () => {
  it('is unavailable, not broken', async () => {
    // The §3 rule, asserted rather than assumed: a missing socket must produce the error the
    // controller turns into 503. A 500 would send the operator looking for a DEPSIS bug instead of
    // a `podman.socket` that is not enabled.
    const absent = new PodmanClient('/run/depsis/definitely-not-a-podman.sock', 2_000);
    await expect(absent.info()).rejects.toThrowError(/not available/);
  });
});
