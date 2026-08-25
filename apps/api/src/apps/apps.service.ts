import { Injectable, Logger } from '@nestjs/common';
import { createServer } from 'node:net';
import { z } from 'zod';

import { DbService } from '../db/db.service.js';
import { SecretBox } from '../auth/secret-box.js';
import {
  asContainerName,
  asPodName,
  hostPathUnder,
  imageReference,
  podNameFor,
  PodmanClient,
  PodmanError,
  PodmanUnavailableError,
  stackContainerName,
  volumeNameFor,
  type BindMount,
  type ContainerName,
  type ContainerSummary,
  type NamedVolume,
  type PodmanInfo,
  type PodName,
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

/**
 * This application needs a derived secret and the appliance has no key to derive it from.
 *
 * A refusal rather than a fallback. The fallbacks available here are all worse than not starting:
 * a constant password would be the same on every DEPSIS, and a random one written into the
 * database would put a plaintext server password in every backup. See `SecretBox.derive`.
 */
export class SecretKeyMissingError extends Error {
  constructor(slug: string) {
    super(
      `${slug} needs a generated password for its own database, and DEPSIS_SECRET_KEY_FILE is ` +
        'not set. Generate a key with `openssl rand -base64 32`, point the setting at the file, ' +
        'and install again (ADR-0016).',
    );
    this.name = 'SecretKeyMissingError';
  }
}

/**
 * The record describes a single-container install of an application that is now a stack.
 *
 * Only reachable for Immich, and only on a box that installed it before migration 0031: the old
 * catalogue row claimed one container, which could never actually run. Reported as its own thing
 * rather than driven anyway, because driving it would start one quarter of an application and
 * report it running.
 */
export class StaleInstallError extends Error {
  constructor(slug: string) {
    super(
      `${slug} was installed from an older catalogue entry that described one container, and it ` +
        'now needs several. Remove it and install it again; your shares are not touched.',
    );
    this.name = 'StaleInstallError';
  }
}

/** A catalogue row that cannot be turned into containers. Only a migration can cause this. */
export class CatalogueShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueShapeError';
  }
}

/** No free port could be found in the range applications are given. */
export class NoFreePortError extends Error {
  /**
   * `because` names the constraint that kept refusing, when one did.
   *
   * Without it this error is a thousand swallowed unique violations reported as "the port range is
   * full" — which is what it looked like the first time a device-wide index that had nothing to do
   * with ports started rejecting every candidate. The loop's whole design is to treat a collision
   * as "try the next one", so the one thing it must not do is forget what it collided with.
   */
  constructor(because?: string) {
    super(
      because === undefined
        ? 'no free port is available for a new application'
        : `no free port is available for a new application; every candidate was refused by ${because}`,
    );
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

/** A managed volume is a target and a sentence; the user never picks where it lives. */
const catalogueVolumesSchema = z.array(
  z.object({ target: z.string().min(1), purpose: z.string() }),
);

export interface CatalogueRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  icon: string;
  /** The port the POD publishes on 127.0.0.1 — a fact about the application, not a container. */
  container_port: number;
}

/** One container of one application, in start order. Migration 0031. */
export interface ContainerRow {
  catalogue_id: string;
  role: string;
  ordinal: number;
  is_primary: boolean;
  image: string;
  tag: string;
  env: unknown;
  mounts: unknown;
  volumes: unknown;
}

export interface InstanceRow {
  id: string;
  catalogue_id: string;
  container_name: string;
  host_port: number;
  created_at: Date;
  /**
   * The pod, or null for an install made before migration 0031.
   *
   * Null is not "no pod yet" — it is a complete, working, single-container install of the kind
   * this module made for its whole life until now, and it goes on being driven that way.
   */
  pod_name: string | null;
}

export interface RequestedMount {
  target: string;
  shareId: string;
}

/** One container, resolved down to exactly what podman will be asked to create. */
interface ContainerPlan {
  name: ContainerName;
  ordinal: number;
  isPrimary: boolean;
  image: ReturnType<typeof imageReference>;
  env: Record<string, string>;
  mounts: BindMount[];
  volumes: NamedVolume[];
}

/**
 * `${secret:db}` — an environment value the appliance derives instead of the catalogue naming.
 *
 * Anchored at both ends. See `substitute` for why a placeholder inside a longer string is refused
 * rather than supported.
 */
const SECRET_PLACEHOLDER = /^\$\{secret:([a-z][a-z0-9-]{0,30})\}$/u;

export type AppState = 'running' | 'stopped' | 'starting' | 'error' | 'unknown';

export interface AppView {
  catalogue: CatalogueRow;
  /** Every container this application is made of, in start order. Never empty. */
  containers: readonly ContainerRow[];
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
    /**
     * The appliance key, for applications that need a password of their own (`SecretBox.derive`).
     *
     * Null on a box with no key file. Installing something that needs one then REFUSES rather than
     * falling back — see `SecretKeyMissingError` — and everything else installs as before.
     */
    private readonly secrets: SecretBox | null = null,
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

    const { catalogue, containers: parts, instances } = await this.readTenantView(organizationId);
    const instanceByCatalogue = new Map(instances.map((row) => [row.catalogue_id, row]));
    const containersByCatalogue = new Map<string, ContainerRow[]>();
    for (const row of parts) {
      const list = containersByCatalogue.get(row.catalogue_id);
      if (list === undefined) containersByCatalogue.set(row.catalogue_id, [row]);
      else list.push(row);
    }

    const apps = catalogue.map((entry): AppView => {
      const own = containersByCatalogue.get(entry.id) ?? [];
      const instance = instanceByCatalogue.get(entry.id) ?? null;
      if (instance === null) {
        return { catalogue: entry, containers: own, instance: null, state: null };
      }
      // `unknown` and not `error` when there is no runtime to ask. `error` means the record and a
      // WORKING podman disagree, which sends the operator somewhere else entirely.
      if (runtime === null) {
        return { catalogue: entry, containers: own, instance, state: 'unknown' };
      }

      // A single-container record for an application that now needs several. Nothing to read a
      // state from — the three containers it is missing were never created. See StaleInstallError.
      if (instance.pod_name === null && own.length > 1) {
        return { catalogue: entry, containers: own, instance, state: 'error' };
      }

      const names =
        instance.pod_name === null
          ? [instance.container_name]
          : own.map((part) => `${instance.pod_name ?? ''}-${part.role}`);
      const state = aggregate(names.map((name) => mapState(byName.get(name))));
      return { catalogue: entry, containers: own, instance, state };
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

    const { entry, containers } = await this.requireCatalogue(organizationId, slug);
    const resolved = await this.resolveMounts(organizationId, containers, requested);

    // EVERY new install is a pod, including a one-container one. The alternative — a bare
    // container when there is only one, a pod when there are several — would be two shapes of
    // installed application to drive, to reason about and to get wrong, in exchange for one
    // infra container of about a megabyte.
    const pod = podNameFor(entry.slug, organizationId);
    const plan = this.plan(organizationId, entry, containers, resolved, pod);

    const primary = plan.find((container) => container.isPrimary);
    if (primary === undefined) {
      throw new CatalogueShapeError(`${entry.slug} has no primary container`);
    }

    const instance = await this.reserve(organizationId, userId, entry, primary.name, pod);

    try {
      await this.podman.createPod({
        name: pod,
        containerPort: entry.container_port,
        hostPort: instance.host_port,
      });
      // In ORDINAL order, which is also pull order: the database image is small and comes first,
      // so a stack whose last image fails to download has not already spent ten minutes.
      for (const container of plan) {
        await this.podman.pullImage(container.image);
        await this.podman.createContainer({
          name: container.name,
          image: container.image,
          env: container.env,
          mounts: container.mounts,
          volumes: container.volumes,
          pod,
        });
      }
    } catch (error) {
      await this.rollback(organizationId, entry, pod, plan);
      throw error;
    }

    return { catalogue: entry, containers, instance, state: 'stopped' };
  }

  /**
   * Undo a half-made install.
   *
   * Volumes are NOT removed, and that is not laziness. A failed install of an application that was
   * installed before leaves the earlier install's database volume in place, and removing it here
   * would turn "the download failed" into "your photo library is gone".
   */
  private async rollback(
    organizationId: string,
    entry: CatalogueRow,
    pod: PodName,
    plan: readonly ContainerPlan[],
  ): Promise<void> {
    for (const container of plan) {
      await this.forget(() => this.podman.removeContainer(container.name));
    }
    await this.forget(() => this.podman.removePod(pod));
    await this.unreserve(organizationId, entry.id);
  }

  /** Run a cleanup step, and let a failure inside it not replace the failure being cleaned up. */
  private async forget(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger.warn(
        `cleanup step failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
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

    const { entry, containers, instance } = await this.requireInstalled(organizationId, slug);
    const names = this.namesFor(entry, containers, instance);

    if (desired === 'running') {
      // In ordinal order, and podman brings the pod's infra container up with the first one. The
      // order reduces how long a server spends retrying its database; it does not remove the
      // retrying, because a started PostgreSQL is not a ready PostgreSQL. Migration 0031 says the
      // same thing on the `ordinal` column, deliberately, because a reader arriving at either one
      // will draw the wrong conclusion without it.
      for (const name of names) await this.podman.startContainer(name);
    } else {
      // In REVERSE, so the thing that talks to the database stops before the database does.
      for (const name of [...names].reverse()) await this.podman.stopContainer(name);
    }

    const running = await this.podman.listContainers();
    const byName = new Map<string, string>();
    for (const container of running) {
      for (const name of container.names) byName.set(name, container.state);
    }
    const state = aggregate(names.map((name) => mapState(byName.get(name))));
    return { catalogue: entry, containers, instance, state };
  }

  /**
   * Remove the containers, the pod, and NOTHING ELSE.
   *
   * `removeContainer` passes `v=false` and `removePod` cannot remove volumes at all. The shares
   * that were bound stay exactly as they were, and so does every managed volume — which means
   * Immich's database and Nextcloud's configuration survive an uninstall and are still there if
   * the same application is installed again. This is the single most destructive thing this module
   * could get wrong, so it is stated three times: here, at the client method that carries the
   * flag, and on the volume column in migration 0031.
   */
  async remove(organizationId: string, slug: string): Promise<void> {
    const { entry, containers, instance } = await this.requireInstalled(organizationId, slug);

    // Removal is the one operation a stale record must still be able to finish — it is the way
    // out of that state — so it asks for names without the stale-install refusal.
    const names =
      instance.pod_name === null
        ? [asContainerName(instance.container_name)]
        : containers.map((container) =>
            stackContainerName(asPodName(instance.pod_name ?? ''), container.role),
          );

    for (const name of names) {
      try {
        await this.podman.removeContainer(name);
      } catch (error) {
        // A container that podman has already lost should not leave a row nobody can remove. Any
        // other failure is reported, because the row still names something that exists.
        if (!(error instanceof PodmanError) || error.status !== 404) throw error;
        this.logger.warn(`${name} was already gone from podman; removing the record anyway`);
      }
    }

    if (instance.pod_name !== null) {
      try {
        await this.podman.removePod(asPodName(instance.pod_name));
      } catch (error) {
        if (!(error instanceof PodmanError) || error.status !== 404) throw error;
      }
    }

    await this.unreserve(organizationId, entry.id);
  }

  async logs(organizationId: string, slug: string, lines: number): Promise<string[]> {
    const { entry, containers, instance } = await this.requireInstalled(organizationId, slug);
    const names = this.namesFor(entry, containers, instance);
    // The PRIMARY container's logs. A stack has four log streams and only one of them answers the
    // question a user opens this for; the database's log is where somebody goes next, and going
    // there is a `podman logs` away for the operator who needs it.
    const primary = containers.findIndex((container) => container.is_primary);
    const name = names[primary === -1 ? 0 : primary] ?? names[0];
    if (name === undefined) throw new CatalogueShapeError(`${entry.slug} has no containers`);
    return this.podman.logs(name, lines);
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
    containers: ContainerRow[];
    instances: InstanceRow[];
  }> {
    return this.db.withTenant(organizationId, async (db) => {
      const catalogue = await db.query<CatalogueRow>(
        `SELECT id::text AS id, slug, name, summary, icon, container_port
           FROM public.app_catalogue
          ORDER BY name`,
      );
      // The WHOLE catalogue's containers in one query rather than one query per application. Six
      // applications is six round trips saved today and a page that does not get slower as the
      // catalogue grows.
      const containers = await db.query<ContainerRow>(
        `SELECT catalogue_id::text AS catalogue_id, role, ordinal, is_primary, image, tag, env, mounts, volumes
           FROM public.app_catalogue_containers
          ORDER BY ordinal`,
      );
      const instances = await db.query<InstanceRow>(
        `SELECT id::text AS id, catalogue_id::text AS catalogue_id, container_name, host_port,
                created_at, pod_name
           FROM public.app_instances`,
      );
      return { catalogue, containers, instances };
    });
  }

  /**
   * One catalogue row and the containers it is made of.
   *
   * The shape checks are here rather than at every caller: a row with no containers, or with no
   * primary, is a broken migration, and every path that installs or drives an application would
   * otherwise have to notice it separately.
   */
  private async requireCatalogue(
    organizationId: string,
    slug: string,
  ): Promise<{ entry: CatalogueRow; containers: ContainerRow[] }> {
    const { entry, containers } = await this.db.withTenant(organizationId, async (db) => {
      const rows = await db.query<CatalogueRow>(
        `SELECT id::text AS id, slug, name, summary, icon, container_port
           FROM public.app_catalogue
          WHERE slug = $1`,
        [slug],
      );
      const found = rows[0];
      if (found === undefined) return { entry: undefined, containers: [] };
      return {
        entry: found,
        containers: await db.query<ContainerRow>(
          `SELECT catalogue_id::text AS catalogue_id, role, ordinal, is_primary, image, tag, env, mounts, volumes
             FROM public.app_catalogue_containers
            WHERE catalogue_id = $1
            ORDER BY ordinal`,
          [found.id],
        ),
      };
    });

    if (entry === undefined) throw new AppNotInCatalogueError(slug);
    if (containers.length === 0) {
      throw new CatalogueShapeError(`${slug} has no containers in the catalogue`);
    }
    if (containers.filter((container) => container.is_primary).length !== 1) {
      throw new CatalogueShapeError(`${slug} does not have exactly one primary container`);
    }
    return { entry, containers };
  }

  private async requireInstalled(
    organizationId: string,
    slug: string,
  ): Promise<{ entry: CatalogueRow; containers: ContainerRow[]; instance: InstanceRow }> {
    const { entry, containers } = await this.requireCatalogue(organizationId, slug);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<InstanceRow>(
        `SELECT id::text AS id, catalogue_id::text AS catalogue_id, container_name, host_port,
                created_at, pod_name
           FROM public.app_instances
          WHERE catalogue_id = $1`,
        [entry.id],
      ),
    );
    const instance = rows[0];
    if (instance === undefined) throw new NotInstalledError(slug);
    return { entry, containers, instance };
  }

  /**
   * The containers of an installed application, in start order.
   *
   * REFUSES a single-container record for an application that now needs several — see
   * `StaleInstallError`. Starting one container of a four-container application would leave a
   * green light next to something that cannot work.
   */
  private namesFor(
    entry: CatalogueRow,
    containers: readonly ContainerRow[],
    instance: InstanceRow,
  ): ContainerName[] {
    if (instance.pod_name === null) {
      if (containers.length > 1) throw new StaleInstallError(entry.slug);
      return [asContainerName(instance.container_name)];
    }
    const pod = asPodName(instance.pod_name);
    return containers.map((container) => stackContainerName(pod, container.role));
  }

  /**
   * Turn catalogue rows into the exact podman specs to create, in start order.
   *
   * Everything a container will be created with is decided here, from two sources and no others:
   * the catalogue rows, and the mounts the caller's share ids resolved to. The one value that is
   * neither is a derived password, and it is derived from this appliance's key rather than
   * supplied or stored.
   */
  private plan(
    organizationId: string,
    entry: CatalogueRow,
    containers: readonly ContainerRow[],
    resolved: ReadonlyMap<string, BindMount>,
    pod: PodName,
  ): ContainerPlan[] {
    return containers.map((container): ContainerPlan => {
      const name = stackContainerName(pod, container.role);
      const wanted = catalogueMountsSchema.parse(container.mounts);
      const volumes = catalogueVolumesSchema.parse(container.volumes);
      const env = catalogueEnvSchema.parse(container.env);

      return {
        name,
        ordinal: container.ordinal,
        isPrimary: container.is_primary,
        image: imageReference(container.image, container.tag),
        env: Object.fromEntries(
          Object.entries(env).map(([key, value]) => [
            key,
            this.substitute(organizationId, entry.slug, value),
          ]),
        ),
        mounts: wanted.map((mount) => {
          const bind = resolved.get(mount.target);
          // Unreachable: `resolveMounts` refused anything it could not fill. Kept because a
          // non-null assertion here would be a promise nobody rechecks after the next edit.
          if (bind === undefined) throw new MountTargetError(`missing share for ${mount.target}`);
          return bind;
        }),
        volumes: volumes.map((volume, index): NamedVolume => ({
          name: volumeNameFor(name, index, volume.target),
          destination: volume.target,
        })),
      };
    });
  }

  /**
   * Replace a `${secret:name}` placeholder with a value derived from the appliance key.
   *
   * WHOLE VALUE ONLY. A placeholder embedded in a longer string — a connection URL, say — would
   * mean a generated password being spliced into a syntax with quoting rules, which is how a
   * password containing the wrong character silently breaks an application. Everything that needs
   * one today wants the password on its own, in its own variable.
   */
  private substitute(organizationId: string, slug: string, value: string): string {
    const match = SECRET_PLACEHOLDER.exec(value);
    if (match === null) return value;
    const label = match[1] ?? '';
    if (this.secrets === null) throw new SecretKeyMissingError(slug);
    // base64url, so the result can be pasted into an environment variable, a URL and a shell
    // without any of them needing to quote it. 24 bytes is 32 characters.
    return this.secrets.derive(`app:${organizationId}:${slug}:${label}`, 24).toString('base64url');
  }

  /**
   * Turn `{target, shareId}` pairs into bind mounts, for the WHOLE application.
   *
   * Three refusals, and each one closes a different door. A target the catalogue does not describe
   * is refused, so a request cannot invent a mount point. A catalogue target left unfilled is
   * refused, so an application does not start missing the directory it was configured around. A
   * share id that is not this tenant's is refused by row level security returning nothing — the
   * request never says which organisation it means, so the only shares in scope are the caller's.
   *
   * The host path is built by `hostPathUnder`, which takes the configured root and the share's own
   * name. The request contributes an id and nothing else; it cannot contribute a path.
   *
   * TARGETS ARE UNIQUE ACROSS THE APPLICATION, not per container, which is what lets the install
   * request stay a flat list and the interface stay unaware that an application has parts. Two
   * containers declaring the same target would be a migration mistake, and it is refused here
   * rather than silently resolved to whichever came last.
   */
  private async resolveMounts(
    organizationId: string,
    containers: readonly ContainerRow[],
    requested: readonly RequestedMount[],
  ): Promise<Map<string, BindMount>> {
    const wanted: z.infer<typeof catalogueMountSchema>[] = [];
    for (const container of containers) {
      for (const mount of catalogueMountsSchema.parse(container.mounts)) {
        if (wanted.some((seen) => seen.target === mount.target)) {
          throw new CatalogueShapeError(`two containers both want ${JSON.stringify(mount.target)}`);
        }
        wanted.push(mount);
      }
    }

    const out = new Map<string, BindMount>();
    if (wanted.length === 0) return out;

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

    for (const mount of wanted) {
      const shareId = chosen.get(mount.target);
      // Unreachable — every target was filled above — but `noUncheckedIndexedAccess` is right to
      // ask, and a throw here is cheaper than a non-null assertion nobody rechecks.
      if (shareId === undefined) throw new MountTargetError(`missing share for ${mount.target}`);
      const shareName = nameById.get(shareId);
      if (shareName === undefined) throw new ShareNotFoundError();
      out.set(mount.target, {
        destination: mount.target,
        source: hostPathUnder(root, shareName),
        readOnly: mount.mode === 'ro',
      });
    }
    return out;
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
    pod: PodName,
  ): Promise<InstanceRow> {
    const taken = await this.db.withTenant(organizationId, (db) =>
      db.query<{ host_port: number }>(`SELECT host_port FROM public.app_instances`),
    );
    const used = new Set(taken.map((row) => row.host_port));

    let refusedBy: string | undefined;
    for (let offset = 0; offset < PORT_SPAN; offset += 1) {
      const port = PORT_BASE + offset;
      if (used.has(port)) continue;
      if (!(await isPortFree(port))) continue;

      try {
        const rows = await this.db.withTenant(organizationId, (db) =>
          db.query<InstanceRow>(
            `INSERT INTO public.app_instances
                    (organization_id, catalogue_id, installed_by, container_name, host_port,
                     pod_name)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id::text AS id, catalogue_id::text AS catalogue_id, container_name,
                       host_port, created_at, pod_name`,
            [organizationId, entry.id, userId, name, port, pod],
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
        if (isUniqueViolation(error)) {
          refusedBy = constraintOf(error) ?? 'a unique index';
          continue;
        }
        throw error;
      }
    }

    throw new NoFreePortError(refusedBy);
  }

  /**
   * Drop the record, by application.
   *
   * By catalogue id alone: `app_instances_one_per_app` makes that exactly one row inside one
   * tenant, and row level security makes "inside one tenant" the only scope this statement has.
   * Naming the container as well used to be a second guard, and became a liability the moment an
   * application had four containers and no single name to be identified by.
   */
  private async unreserve(organizationId: string, catalogueId: string): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(`DELETE FROM public.app_instances WHERE catalogue_id = $1`, [catalogueId]),
    );
  }
}

/**
 * One state for an application made of several containers.
 *
 * The order of the tests is the whole content of this function. A member podman has never heard of
 * is `error` before anything else, because that is a record and a runtime disagreeing and no
 * amount of the others being fine makes it not so. A member still starting outranks the rest,
 * because a stack coming up is normal and reporting `error` for the two seconds PostgreSQL takes
 * to open its socket would train the user to ignore the word.
 *
 * The last line is the one worth arguing about: some running and some stopped, none of them
 * starting, is `error`. It looks like a half-answer, and it is exactly the state a user needs to
 * be told about — an application whose database exited an hour ago while its web server kept
 * serving errors. `running` would be a green light on something broken.
 */
export function aggregate(states: readonly AppState[]): AppState {
  if (states.length === 0) return 'error';
  if (states.includes('error')) return 'error';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('starting')) return 'starting';
  if (states.every((state) => state === 'running')) return 'running';
  if (states.every((state) => state === 'stopped')) return 'stopped';
  return 'error';
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

/** The index or constraint a Postgres error names, when it names one. */
function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  if (record.code !== '23505') return false;
  if (constraint === undefined) return true;
  return record.constraint === constraint;
}
