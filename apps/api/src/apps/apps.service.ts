import { Injectable, Logger } from '@nestjs/common';
import { createServer } from 'node:net';
import { z } from 'zod';

import { DbService } from '../db/db.service.js';
import {
  containerNameFor,
  hostPathUnder,
  imageReference,
  PodmanClient,
  PodmanError,
  PodmanUnavailableError,
  type BindMount,
  type ContainerName,
  type ContainerSummary,
  type PodmanInfo,
} from './podman.client.js';

/**
 * The application catalogue.
 *
 * Everything dangerous about this file is about where a string came from. The user picks a slug
 * that must already be a row in `app_catalogue`, and a share id that must already be a row in
 * their own `shares`; the image, the tag, the container port, the mount targets and the
 * environment all come from the catalogue row, and the host side of every mount is DERIVED from
 * the share rather than supplied. There is no path in this file from a request body to a podman
 * argument that does not pass through one of those two lookups.
 */

/** No such slug in the catalogue. Deliberately the same answer as "not installed": 404. */
export class AppNotInCatalogueError extends Error {
  constructor(slug: string) {
    super(`no application named ${JSON.stringify(slug)} in the catalogue`);
    this.name = 'AppNotInCatalogueError';
  }
}

/** The request's mounts do not match the ones the catalogue row describes. */
export class MountTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MountTargetError';
  }
}

/** No such share in the caller's organisation. Another tenant's share id lands here. */
export class ShareNotFoundError extends Error {
  constructor() {
    super('no such share');
    this.name = 'ShareNotFoundError';
  }
}

/** Already installed in this organisation. */
export class AlreadyInstalledError extends Error {
  constructor(slug: string) {
    super(`${slug} is already installed`);
    this.name = 'AlreadyInstalledError';
  }
}

/** In the catalogue, but this organisation has not installed it. */
export class NotInstalledError extends Error {
  constructor(slug: string) {
    super(`${slug} is not installed`);
    this.name = 'NotInstalledError';
  }
}

/** No share tree is configured, so no host path can be derived for a bind mount. */
export class SharesRootMissingError extends Error {
  constructor() {
    super(
      'DEPSIS_SHARES_ROOT is not set, so there is no host path to bind a share from. ' +
        'This box has no share tree configured yet.',
    );
    this.name = 'SharesRootMissingError';
  }
}

/** No free port could be found in the range applications are given. */
export class NoFreePortError extends Error {
  constructor() {
    super('no free port is available for a new application');
    this.name = 'NoFreePortError';
  }
}

/**
 * The configured podman socket is the ROOT one, and this operation would start code through it.
 *
 * ADR-0019's privilege argument is that the worst thing reachable through the podman client is the
 * unprivileged `depsis-apps` user's own authority. On a rootful socket that sentence is simply
 * false: a catalogue container runs as real uid 0 on the host with a user share bind-mounted rw,
 * so a compromised upstream image is host root. The default socket in `config.ts` is the rootful
 * one — that is what a distribution package installs — which means a deployment that never set
 * `DEPSIS_PODMAN_SOCKET` was off-ADR by OMISSION, with a boolean in the UI as the only signal.
 *
 * Refusing here makes the unsafe direction explicit: it takes `DEPSIS_PODMAN_ALLOW_ROOTFUL=1` to
 * create or start a root container from a web request. Reading state, stopping and removing stay
 * allowed on a rootful socket — an operator who ends up in this state has to be able to see it and
 * wind it down, and neither of those starts anything.
 */
export class RootfulRuntimeError extends Error {
  constructor() {
    super(
      'the container runtime is running as root, and DEPSIS will not start a root container from ' +
        'a web request (ADR-0019). Point DEPSIS_PODMAN_SOCKET at a rootless podman socket, or set ' +
        'DEPSIS_PODMAN_ALLOW_ROOTFUL=1 to accept the risk deliberately.',
    );
    this.name = 'RootfulRuntimeError';
  }
}

const catalogueMountSchema = z.object({
  target: z.string().min(1),
  mode: z.enum(['ro', 'rw']),
  purpose: z.string(),
});

const catalogueMountsSchema = z.array(catalogueMountSchema);
const catalogueEnvSchema = z.record(z.string(), z.string());

export interface CatalogueRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  image: string;
  tag: string;
  icon: string;
  container_port: number;
  mounts: unknown;
  env: unknown;
}

export interface InstanceRow {
  id: string;
  catalogue_id: string;
  container_name: string;
  host_port: number;
  created_at: Date;
}

export interface RequestedMount {
  target: string;
  shareId: string;
}

export type AppState = 'running' | 'stopped' | 'starting' | 'error' | 'unknown';

export interface AppView {
  catalogue: CatalogueRow;
  instance: InstanceRow | null;
  state: AppState | null;
}

export interface AppsOverview {
  /**
   * Null when there is no container runtime on this box.
   *
   * NOT an error. `/apps` is the one page that has to be able to say "this appliance has no
   * container runtime" — the catalogue itself is a database table and renders perfectly well
   * without podman, and a caller cannot read `runtime.available` on a body it was never sent.
   * `/remote` reached the same conclusion for the same reason; the two siblings now behave alike.
   */
  runtime: PodmanInfo | null;
  apps: readonly AppView[];
}

/**
 * Where host ports for applications start.
 *
 * Above 1024 because rootless podman cannot bind below it (ADR-0019's accepted limit), and high
 * enough to sit clear of anything a NAS is likely to already be running. The database's CHECK
 * agrees on the floor.
 */
const PORT_BASE = 39_000;
const PORT_SPAN = 1_000;

@Injectable()
export class AppsService {
  private readonly logger = new Logger(AppsService.name);

  constructor(
    private readonly db: DbService,
    private readonly podman: PodmanClient,
    /** Where the share tree is mounted; the same root the agent resolves from. */
    private readonly sharesRoot: string | null,
    /**
     * `DEPSIS_PODMAN_ALLOW_ROOTFUL`. Defaulted here so the safe answer is the one a caller that
     * says nothing gets — see `RootfulRuntimeError`.
     */
    private readonly allowRootful: boolean = false,
  ) {}

  /**
   * The whole catalogue, with the state of anything installed read from podman.
   *
   * State comes from the runtime on every call and is never stored. Migration 0013 says why in the
   * table's own comment: a column would be wrong the moment the box rebooted, and a wrong "running"
   * is worse than no answer at all.
   *
   * A missing runtime DEGRADES rather than fails. The catalogue is a database table and the
   * installed rows are database rows; neither needs podman to be readable, and a page that cannot
   * render at all is a worse answer than a page that says the container runtime is not installed.
   * Only unavailability degrades — a podman that answered and said something unexpected is still a
   * fault and still propagates.
   */
  async list(organizationId: string): Promise<AppsOverview> {
    let runtime: PodmanInfo | null = null;
    let containers: readonly ContainerSummary[] = [];
    try {
      runtime = await this.podman.info();
      containers = await this.podman.listContainers();
    } catch (error) {
      if (!(error instanceof PodmanUnavailableError)) throw error;
      runtime = null;
    }

    const byName = new Map<string, string>();
    for (const container of containers) {
      for (const name of container.names) byName.set(name, container.state);
    }

    const { catalogue, instances } = await this.readTenantView(organizationId);
    const instanceByCatalogue = new Map(instances.map((row) => [row.catalogue_id, row]));

    const apps = catalogue.map((entry): AppView => {
      const instance = instanceByCatalogue.get(entry.id) ?? null;
      if (instance === null) return { catalogue: entry, instance: null, state: null };
      // `unknown` and not `error` when there is no runtime to ask. `error` means the record and a
      // WORKING podman disagree, which sends the operator somewhere else entirely.
      if (runtime === null) return { catalogue: entry, instance, state: 'unknown' };
      const podmanState = byName.get(instance.container_name);
      return { catalogue: entry, instance, state: mapState(podmanState) };
    });

    return { runtime, apps };
  }

  /**
   * Install one catalogue entry.
   *
   * The order is deliberate and so is the compensation. The database row is written first because
   * it is what reserves the port, and a port reserved after the container was created would be a
   * port two applications could both be told they own. If podman then refuses, the row is removed
   * again — a reservation for a container that does not exist is exactly the kind of stale record
   * that makes the next install fail for a reason nobody can see.
   */
  async install(
    organizationId: string,
    userId: string,
    slug: string,
    requested: readonly RequestedMount[],
  ): Promise<AppView> {
    await this.refuseRootful();

    const entry = await this.requireCatalogue(organizationId, slug);
    const wanted = catalogueMountsSchema.parse(entry.mounts);
    const env = catalogueEnvSchema.parse(entry.env);

    const mounts = await this.resolveMounts(organizationId, wanted, requested);
    const name = containerNameFor(entry.slug, organizationId);
    const reference = imageReference(entry.image, entry.tag);

    const instance = await this.reserve(organizationId, userId, entry, name);

    try {
      await this.podman.pullImage(reference);
      await this.podman.createContainer({
        name,
        image: reference,
        env,
        containerPort: entry.container_port,
        hostPort: instance.host_port,
        mounts,
      });
    } catch (error) {
      await this.unreserve(organizationId, entry.id, name);
      throw error;
    }

    return { catalogue: entry, instance, state: 'stopped' };
  }

  /**
   * Start or stop an installed application.
   *
   * The state that comes back is READ from podman, not assumed from what was asked. The contract
   * says `state` comes from the runtime, and after a start that libpod answered 304 to — the
   * container was already running — the assumed value happens to be right while being a guess.
   * The extra listing is one call, and it is the difference between reporting and asserting.
   */
  async setState(
    organizationId: string,
    slug: string,
    desired: 'running' | 'stopped',
  ): Promise<AppView> {
    // Starting is the direction that runs code; stopping is not, and an operator on a rootful box
    // has to be able to turn things off.
    if (desired === 'running') await this.refuseRootful();

    const { entry, instance } = await this.requireInstalled(organizationId, slug);
    const name = containerNameFor(entry.slug, organizationId);

    if (desired === 'running') {
      await this.podman.startContainer(name);
    } else {
      await this.podman.stopContainer(name);
    }

    const containers = await this.podman.listContainers();
    const found = containers.find((container) => container.names.includes(name));
    return { catalogue: entry, instance, state: mapState(found?.state) };
  }

  /**
   * Remove the container and the record, and NOTHING ELSE.
   *
   * `removeContainer` passes `v=false`. The shares that were bound stay exactly as they were,
   * because they are the user's data and an uninstall is not a delete. This is the single most
   * destructive thing this module could get wrong, so it is stated twice — here and at the client
   * method that carries the flag.
   */
  async remove(organizationId: string, slug: string): Promise<void> {
    const { entry } = await this.requireInstalled(organizationId, slug);
    const name = containerNameFor(entry.slug, organizationId);

    try {
      await this.podman.removeContainer(name);
    } catch (error) {
      // A container that podman has already lost should not leave a row nobody can remove. Any
      // other failure is reported, because the row still names something that exists.
      if (!(error instanceof PodmanError) || error.status !== 404) throw error;
      this.logger.warn(`${name} was already gone from podman; removing the record anyway`);
    }

    await this.unreserve(organizationId, entry.id, name);
  }

  async logs(organizationId: string, slug: string, lines: number): Promise<string[]> {
    const { entry } = await this.requireInstalled(organizationId, slug);
    return this.podman.logs(containerNameFor(entry.slug, organizationId), lines);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Refuse to start code through a root podman socket. See `RootfulRuntimeError`.
   *
   * Asked of podman on every call rather than cached: the socket path is configuration, but which
   * podman is behind it is a fact about the running system, and a value cached at startup would go
   * on being reported after somebody pointed the unit at a different one.
   */
  private async refuseRootful(): Promise<void> {
    if (this.allowRootful) return;
    const info = await this.podman.info();
    if (!info.rootless) throw new RootfulRuntimeError();
  }

  private async readTenantView(organizationId: string): Promise<{
    catalogue: CatalogueRow[];
    instances: InstanceRow[];
  }> {
    return this.db.withTenant(organizationId, async (db) => {
      const catalogue = await db.query<CatalogueRow>(
        `SELECT id::text AS id, slug, name, summary, image, tag, icon, container_port, mounts, env
           FROM public.app_catalogue
          ORDER BY name`,
      );
      const instances = await db.query<InstanceRow>(
        `SELECT id::text AS id, catalogue_id::text AS catalogue_id, container_name, host_port,
                created_at
           FROM public.app_instances`,
      );
      return { catalogue, instances };
    });
  }

  private async requireCatalogue(organizationId: string, slug: string): Promise<CatalogueRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<CatalogueRow>(
        `SELECT id::text AS id, slug, name, summary, image, tag, icon, container_port, mounts, env
           FROM public.app_catalogue
          WHERE slug = $1`,
        [slug],
      ),
    );
    const entry = rows[0];
    if (entry === undefined) throw new AppNotInCatalogueError(slug);
    return entry;
  }

  private async requireInstalled(
    organizationId: string,
    slug: string,
  ): Promise<{ entry: CatalogueRow; instance: InstanceRow }> {
    const entry = await this.requireCatalogue(organizationId, slug);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<InstanceRow>(
        `SELECT id::text AS id, catalogue_id::text AS catalogue_id, container_name, host_port,
                created_at
           FROM public.app_instances
          WHERE catalogue_id = $1`,
        [entry.id],
      ),
    );
    const instance = rows[0];
    if (instance === undefined) throw new NotInstalledError(slug);
    return { entry, instance };
  }

  /**
   * Turn `{target, shareId}` pairs into bind mounts.
   *
   * Three refusals, and each one closes a different door. A target the catalogue does not describe
   * is refused, so a request cannot invent a mount point. A catalogue target left unfilled is
   * refused, so an application does not start missing the directory it was configured around. A
   * share id that is not this tenant's is refused by row level security returning nothing — the
   * request never says which organisation it means, so the only shares in scope are the caller's.
   *
   * The host path is built by `hostPathUnder`, which takes the configured root and the share's own
   * name. The request contributes an id and nothing else; it cannot contribute a path.
   */
  private async resolveMounts(
    organizationId: string,
    wanted: readonly z.infer<typeof catalogueMountSchema>[],
    requested: readonly RequestedMount[],
  ): Promise<BindMount[]> {
    if (wanted.length === 0) return [];

    const root = this.sharesRoot;
    if (root === null) throw new SharesRootMissingError();

    const targets = new Set(wanted.map((mount) => mount.target));
    const chosen = new Map<string, string>();
    for (const mount of requested) {
      if (!targets.has(mount.target)) {
        throw new MountTargetError(
          `this application has no mount point ${JSON.stringify(mount.target)}`,
        );
      }
      if (chosen.has(mount.target)) {
        throw new MountTargetError(`${mount.target} was given twice`);
      }
      chosen.set(mount.target, mount.shareId);
    }
    for (const mount of wanted) {
      if (!chosen.has(mount.target)) {
        throw new MountTargetError(`this application needs a share for ${mount.target}`);
      }
    }

    const shareIds = [...new Set(chosen.values())];
    const shares = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; name: string }>(
        `SELECT id::text AS id, name FROM public.shares WHERE id = ANY($1::uuid[])`,
        [shareIds],
      ),
    );
    const nameById = new Map(shares.map((row) => [row.id, row.name]));

    return wanted.map((mount): BindMount => {
      const shareId = chosen.get(mount.target);
      // Unreachable — every target was filled above — but `noUncheckedIndexedAccess` is right to
      // ask, and a throw here is cheaper than a non-null assertion nobody rechecks.
      if (shareId === undefined) throw new MountTargetError(`missing share for ${mount.target}`);
      const shareName = nameById.get(shareId);
      if (shareName === undefined) throw new ShareNotFoundError();
      return {
        destination: mount.target,
        source: hostPathUnder(root, shareName),
        readOnly: mount.mode === 'ro',
      };
    });
  }

  /**
   * Claim a port and write the row that owns it.
   *
   * Two things have to agree: the database, whose unique index stops two applications in one
   * organisation holding the same port, and the machine, where another tenant's container or
   * something outside DEPSIS entirely may already be listening. The index is checked by inserting;
   * the machine is checked by trying to bind. A candidate that fails either is skipped.
   */
  private async reserve(
    organizationId: string,
    userId: string,
    entry: CatalogueRow,
    name: ContainerName,
  ): Promise<InstanceRow> {
    const taken = await this.db.withTenant(organizationId, (db) =>
      db.query<{ host_port: number }>(`SELECT host_port FROM public.app_instances`),
    );
    const used = new Set(taken.map((row) => row.host_port));

    for (let offset = 0; offset < PORT_SPAN; offset += 1) {
      const port = PORT_BASE + offset;
      if (used.has(port)) continue;
      if (!(await isPortFree(port))) continue;

      try {
        const rows = await this.db.withTenant(organizationId, (db) =>
          db.query<InstanceRow>(
            `INSERT INTO public.app_instances
                    (organization_id, catalogue_id, installed_by, container_name, host_port)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id::text AS id, catalogue_id::text AS catalogue_id, container_name,
                       host_port, created_at`,
            [organizationId, entry.id, userId, name, port],
          ),
        );
        const row = rows[0];
        if (row === undefined) throw new NoFreePortError();
        return row;
      } catch (error) {
        if (isUniqueViolation(error, 'app_instances_one_per_app')) {
          throw new AlreadyInstalledError(entry.slug);
        }
        // Another install took this port between the read and the insert. Try the next one.
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }

    throw new NoFreePortError();
  }

  private async unreserve(
    organizationId: string,
    catalogueId: string,
    name: ContainerName,
  ): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(`DELETE FROM public.app_instances WHERE catalogue_id = $1 AND container_name = $2`, [
        catalogueId,
        name,
      ]),
    );
  }
}

/**
 * podman's vocabulary, narrowed to the contract's.
 *
 * A container DEPSIS has a record of but podman has never heard of is `error`, not `stopped`. The
 * two are different problems: one is an application the user turned off, the other is a record and
 * a runtime that disagree, and telling the user "stopped" would hide the second behind a Start
 * button that will not work.
 */
export function mapState(podmanState: string | undefined): AppState {
  switch (podmanState) {
    case undefined:
      return 'error';
    case 'running':
      return 'running';
    case 'created':
    case 'configured':
    case 'initialized':
    case 'exited':
    case 'stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}

/** Can this process bind 127.0.0.1:port right now. Not a lock, and not pretending to be one. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  if (record.code !== '23505') return false;
  if (constraint === undefined) return true;
  return record.constraint === constraint;
}
