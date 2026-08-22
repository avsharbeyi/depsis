import { Logger } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

/**
 * The libpod HTTP client, over a Unix socket.
 *
 * ADR-0019 puts this in the API rather than behind the privileged agent, and the reason is worth
 * repeating where the code is: the socket this file talks to is meant to be an UNPRIVILEGED one.
 * Containers run as `depsis-apps`, rootless, and the worst thing reachable through this client is
 * that user's own authority. Putting it behind the agent would have added ten variants to a closed
 * operation set without removing a single capability from anybody.
 *
 * That argument only holds while the socket really is rootless, which is why `info()` reports
 * `rootless` and the endpoint surfaces it: a deployment that pointed this at the root socket has
 * left the ADR's privilege decision behind, and the interface says so instead of the code
 * pretending it did not happen.
 *
 * `node:http` with `socketPath` rather than `fetch`. Undici does not speak Unix sockets, and the
 * Host header it insists on rewriting is the one libpod uses to route.
 */

/** The runtime could not be reached: no socket, connection refused, or it stopped answering. */
export class PodmanUnavailableError extends Error {
  constructor(reason: string) {
    super(`the container runtime is not available: ${reason}`);
    this.name = 'PodmanUnavailableError';
  }
}

/** Podman answered, understood, and said no. `status` is its HTTP status. */
export class PodmanError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`podman answered ${status}: ${detail}`);
    this.name = 'PodmanError';
  }
}

/**
 * A container name this client will accept.
 *
 * Branded, and the brand is the point. Every method below takes a `ContainerName` rather than a
 * `string`, so a value that did not pass `containerNameFor` cannot reach a URL path — the check
 * cannot be forgotten at a call site because there is no call site that compiles without it.
 * Migration 0013's CHECK constraint wants the same shape; agreeing with it here means a name the
 * database would reject never gets as far as podman.
 */
declare const containerNameBrand: unique symbol;
export type ContainerName = string & { readonly [containerNameBrand]: true };

// `app_catalogue_slug_format` from migration 0013, exactly.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// `app_instances_container_name` from the same migration. Checked in addition to the slug, because
// the two are separate constraints and a name this rejects is a row the database would reject.
const CONTAINER_NAME_PATTERN = /^depsis-app-[a-z0-9-]{1,80}$/;

/** Thrown when a slug or an image reference does not have the shape its type promises. */
export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNameError';
  }
}

/**
 * `depsis-app-<slug>` — the one naming scheme, so `podman ps` is readable by an operator.
 *
 * The slug is expected to have come from `app_catalogue`, whose own CHECK constraint is narrower
 * than this. Validated again anyway: a value that reaches a URL path deserves to be checked where
 * it is used, not only where it was stored.
 */
export function containerNameFor(slug: string, organizationId: string): ContainerName {
  // The SLUG is checked, not just the name it produces. Prefixing hides a leading dash — `-flag`
  // becomes `depsis-app--flag`, which the container-name pattern happily accepts — and a value that
  // could be read as an option by anything downstream should not survive being concatenated.
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidNameError(`not a usable application slug: ${JSON.stringify(slug)}`);
  }

  // The tenant is part of the name, and it is not decoration.
  //
  // Podman's container namespace is DEVICE-WIDE while this schema is multi-tenant, so a name
  // built from the slug alone lets the database accept a second organisation installing Jellyfin
  // and then lets `podman create` fail with "name already in use" — a refusal that arrives from
  // the privileged side, after the row was written, and reads to the user as a fault rather than
  // a conflict. Migration 0014 makes the database agree by making both uniqueness indexes
  // device-wide; this is the half that keeps two tenants from colliding in the first place.
  //
  // Eight hex digits, not the whole uuid: `podman ps` output has to stay readable, and the
  // organisation id is not a secret but there is no reason to paste all of it onto a device the
  // whole household can `podman ps`.
  const suffix = organizationId.replace(/-/gu, '').slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/u.test(suffix)) {
    throw new InvalidNameError(`not a usable organization id: ${JSON.stringify(organizationId)}`);
  }

  const name = `depsis-app-${slug}-${suffix}`;
  if (!CONTAINER_NAME_PATTERN.test(name)) {
    throw new InvalidNameError(`not a usable container name: ${JSON.stringify(name)}`);
  }
  return name as ContainerName;
}

/**
 * A pinned `image:tag`, built only from a catalogue row.
 *
 * Same brand trick, same reason, higher stakes: an image reference is the name of code that will
 * be downloaded from the internet and executed. There is deliberately no function here that turns
 * an arbitrary string into one — `imageReference` takes the two columns of a catalogue row, and a
 * catalogue row is a thing only a migration can create (0013 grants `depsis_app` SELECT and
 * nothing else).
 */
declare const imageReferenceBrand: unique symbol;
export type ImageReference = string & { readonly [imageReferenceBrand]: true };

// Registry/repository and tag, as narrow as the seeded rows need and no wider. No whitespace, no
// '@' (a digest would be fine but nothing produces one yet), nothing that could be read as a query
// parameter after `encodeURIComponent` — which is applied anyway.
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._\-/]{0,199}$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function imageReference(image: string, tag: string): ImageReference {
  if (!IMAGE_PATTERN.test(image)) {
    throw new InvalidNameError(`not a usable image name: ${JSON.stringify(image)}`);
  }
  if (!TAG_PATTERN.test(tag)) {
    throw new InvalidNameError(`not a usable image tag: ${JSON.stringify(tag)}`);
  }
  return `${image}:${tag}` as ImageReference;
}

/**
 * An absolute host path that may be bind-mounted into a container.
 *
 * The third branded type, and the one that would hurt most if it were a `string`. A bind mount
 * source is a directory on the appliance; a request that could name one could name `/`. Only
 * `hostPathUnder` produces one, and it takes a configured root plus a single path component that
 * has already been matched against the share-name shape.
 */
declare const hostPathBrand: unique symbol;
export type HostPath = string & { readonly [hostPathBrand]: true };

// Identical to `shares_name_format` in migration 0008 and to the agent's `SafeComponent`: no
// slash, no leading dot, nothing that traverses.
const SHARE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;

export function hostPathUnder(root: string, component: string): HostPath {
  if (!root.startsWith('/')) {
    throw new InvalidNameError(`the share root must be absolute, got ${JSON.stringify(root)}`);
  }
  if (!SHARE_NAME_PATTERN.test(component)) {
    throw new InvalidNameError(`not a usable share name: ${JSON.stringify(component)}`);
  }
  return `${root.replace(/\/+$/, '')}/${component}` as HostPath;
}

export interface PodmanInfo {
  version: string;
  /** ADR-0019 wants this true. False is a deployment that kept the default socket. */
  rootless: boolean;
}

export interface ContainerSummary {
  names: readonly string[];
  /** libpod's own vocabulary: created, running, exited, paused, stopping, … */
  state: string;
}

export interface BindMount {
  destination: string;
  source: HostPath;
  readOnly: boolean;
}

export interface CreateContainerSpec {
  name: ContainerName;
  image: ImageReference;
  env: Readonly<Record<string, string>>;
  containerPort: number;
  hostPort: number;
  mounts: readonly BindMount[];
}

/** The libpod API version this client is written against. */
const API = '/v5.0.0/libpod';

/** Enough for a create or a stop on a loaded box; not enough to hide a hung daemon. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Pulling is a download, and a first pull of a media server is hundreds of megabytes.
 *
 * Separate from the default because a timeout that fits both is either useless for one or
 * dangerous for the other.
 */
const PULL_TIMEOUT_MS = 15 * 60_000;

/**
 * Beyond this a BUFFERED response is truncated rather than kept.
 *
 * Named for the body rather than for logs, because it applies to every buffered call and a
 * constant called `MAX_LOG_BYTES` invited the assumption that it did not. The one call that
 * legitimately produces more than this — a first image pull, whose progress stream is hundreds of
 * lines per layer — does not buffer at all; see `pullImage`.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Beyond this, a streamed body has stopped being newline-delimited.
 *
 * The streaming reader holds one incomplete line at a time. Without a ceiling that is an
 * unbounded buffer fed by another process, which is a memory-exhaustion primitive rather than a
 * tolerant parser.
 */
const MAX_LINE_BYTES = 1024 * 1024;

/** libpod's answer to "start a container that is already running", and the stop equivalent. */
const NOT_MODIFIED = 304;

/** One HTTP exchange, before anything has been decided about its status. */
interface RawResponse {
  status: number;
  body: Buffer;
  /** The body passed `MAX_BODY_BYTES`; what is in `body` is a prefix of it. */
  truncated: boolean;
}

export class PodmanClient {
  private readonly logger = new Logger(PodmanClient.name);

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Version and privilege. Also the cheapest "is it there at all" probe. */
  async info(): Promise<PodmanInfo> {
    const body = await this.json('GET', `${API}/info`);
    const parsed = parseInfo(body);
    if (parsed === null) {
      throw new PodmanUnavailableError('/info did not answer with a version this client can read');
    }
    return parsed;
  }

  /** Every container on the box, running or not. Filtering by name happens in the caller. */
  async listContainers(): Promise<ContainerSummary[]> {
    const body = await this.json('GET', `${API}/containers/json?all=true`);
    if (!Array.isArray(body)) return [];
    const out: ContainerSummary[] = [];
    for (const entry of body) {
      const summary = parseContainerSummary(entry);
      if (summary !== null) out.push(summary);
    }
    return out;
  }

  /**
   * Download an image, reading the progress stream to its end.
   *
   * Reading to the end is not politeness: libpod streams the pull and reports a failure INSIDE the
   * body, after a 200 header. A client that hung up at the header would treat "manifest unknown"
   * as success and only find out at create time, with a worse message.
   *
   * Read line by line and DISCARDED. A first pull of a media server emits progress JSON per layer
   * for as long as the download lasts, and buffering that was the bug that made this endpoint the
   * one place the whole feature could hang: past the buffer's ceiling the promise was abandoned,
   * so `POST /apps/{slug}` never answered and the port reservation was never rolled back. Nothing
   * in this stream is wanted except a line carrying `error`.
   */
  async pullImage(reference: ImageReference): Promise<void> {
    const path = `${API}/images/pull?reference=${encodeURIComponent(reference)}`;

    // The FIRST failure, kept rather than thrown from inside the reader: throwing there would
    // abandon the response mid-stream and lose the socket to a half-read body.
    let failure: string | null = null;
    const response = await this.send('POST', path, undefined, PULL_TIMEOUT_MS, (line) => {
      if (failure !== null) return;
      const trimmed = line.trim();
      if (trimmed === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const error = readString(parsed, 'error');
      if (error !== null && error !== '') failure = error;
    });

    this.expectSuccess(response);
    if (failure !== null) {
      throw new PodmanError(500, `pulling ${reference} failed: ${String(failure)}`);
    }
  }

  async createContainer(spec: CreateContainerSpec): Promise<void> {
    // The SpecGenerator, written out here rather than assembled from caller-supplied fields. Every
    // value in it is either a branded type or a number this class range-checks; there is no
    // passthrough for "extra options", because an extra option is how `-v /:/host` gets in.
    const payload = {
      name: spec.name,
      image: spec.image,
      env: { ...spec.env },
      // ADR-0019: 127.0.0.1, never 0.0.0.0. A container that binds the LAN is the user installing
      // more than they think they are installing.
      portmappings: [
        {
          host_ip: '127.0.0.1',
          host_port: spec.hostPort,
          container_port: spec.containerPort,
          protocol: 'tcp',
        },
      ],
      mounts: spec.mounts.map((mount) => ({
        destination: mount.destination,
        source: mount.source,
        type: 'bind',
        options: [mount.readOnly ? 'ro' : 'rw', 'rbind'],
      })),
      // Restart on boot, but not in a crash loop that hides a broken app from its own logs.
      restart_policy: 'on-failure',
      restart_tries: 3,
    };
    await this.json('POST', `${API}/containers/create`, payload);
  }

  /** Start it. Already running is success, not a refusal — see `transition`. */
  async startContainer(name: ContainerName): Promise<void> {
    await this.transition('POST', `${API}/containers/${name}/start`);
  }

  /** Stop it. Already stopped is success, for the same reason. */
  async stopContainer(name: ContainerName): Promise<void> {
    await this.transition('POST', `${API}/containers/${name}/stop?timeout=10`);
  }

  /**
   * Remove the container and NOT its volumes.
   *
   * `v=false` is the whole reason this method exists as its own line rather than inline in the
   * service. Removing an application must never remove the user's data; a `v=true` here would make
   * uninstalling Immich delete the photographs it was installed to keep.
   */
  async removeContainer(name: ContainerName): Promise<void> {
    await this.text('DELETE', `${API}/containers/${name}?force=true&v=false`);
  }

  /**
   * The last `tail` lines, demultiplexed.
   *
   * libpod streams logs in Docker's framing when there is no TTY: an 8-byte header per chunk,
   * stream type in byte 0 and a big-endian length in bytes 4..8. Handing those bytes to a JSON
   * response puts a NUL and a length prefix at the start of every line, which is what "garbage
   * characters in the log viewer" looks like. Asking for a plain stream is not an option the API
   * offers, so this decodes.
   */
  async logs(name: ContainerName, tail: number): Promise<string[]> {
    const lines = Math.max(1, Math.min(500, Math.trunc(tail)));
    const raw = await this.buffer(
      'GET',
      `${API}/containers/${name}/logs?stdout=true&stderr=true&tail=${lines}`,
    );
    return demultiplex(raw)
      .split('\n')
      .filter((line) => line !== '')
      .slice(-lines);
  }

  private async json(method: string, path: string, payload?: unknown): Promise<unknown> {
    const body = await this.text(method, path, payload);
    if (body.trim() === '') return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new PodmanUnavailableError(
        `${method} ${path} answered with something that is not JSON`,
      );
    }
  }

  private async text(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<string> {
    const buffer = await this.buffer(method, path, payload, timeoutMs);
    return buffer.toString('utf8');
  }

  /**
   * The whole body, or a `PodmanError` if podman said no.
   *
   * Truncation is reported rather than fatal: the one caller that can realistically reach the
   * ceiling is `logs`, and a truncated tail is more use to whoever is reading it than a 503.
   */
  private async buffer(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<Buffer> {
    const response = await this.send(method, path, payload, timeoutMs, null);
    if (response.truncated) {
      this.logger.warn(`${method} ${path} was longer than ${MAX_BODY_BYTES} bytes; truncated`);
    }
    return this.expectSuccess(response);
  }

  /**
   * A state change where "it was already like that" is not a failure.
   *
   * libpod answers 304 to a start on a running container and to a stop on a stopped one. Measured
   * against podman 5.4.2 on the development box: create 201, start 204, start again 304, stop 204,
   * stop again 304. Treating that as an error turned two administrators pressing Start at the same
   * moment into a 503 — and 503 is reserved for "there is no container runtime here", which is
   * exactly the distinction §3 of this round's rules is about.
   */
  private async transition(method: string, path: string): Promise<void> {
    const response = await this.send(method, path, undefined, undefined, null);
    if (response.status === NOT_MODIFIED) return;
    this.expectSuccess(response);
  }

  private expectSuccess(response: RawResponse): Buffer {
    if (response.status >= 200 && response.status < 300) return response.body;
    throw new PodmanError(response.status, describeFailure(response.body));
  }

  /**
   * One HTTP exchange over the socket, settled EXACTLY once.
   *
   * Every branch out of the response handler settles the promise, and `close` is wired as a
   * backstop so that a branch nobody thought of cannot leave it pending. That is not defensive
   * decoration: `IncomingMessage.destroy()` with no error argument emits neither `end` nor
   * `error` — only `close` — so the size ceiling used to abandon its caller forever, which on the
   * install path meant `POST /apps/{slug}` never answering and the port reservation never being
   * rolled back.
   *
   * `onLine` is how a body gets read without being kept. A pull's progress stream is unbounded by
   * nature and the client only ever looks for one field in it, so buffering it was always a
   * choice, and the wrong one.
   */
  private send(
    method: string,
    path: string,
    payload: unknown,
    timeoutMs: number | undefined,
    onLine: ((line: string) => void) | null,
  ): Promise<RawResponse> {
    const budget = timeoutMs ?? this.timeoutMs;
    const encoded = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');

    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          // libpod routes on this and will not accept an empty one. Any value works; a fixed one
          // means the request is identical on every box.
          headers: {
            host: 'd',
            ...(encoded === null
              ? {}
              : { 'content-type': 'application/json', 'content-length': encoded.length }),
          },
          timeout: budget,
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          // Streaming is only for a body the caller wants discarded, and only when there IS a
          // body worth discarding. An error body is small and carries podman's own sentence, so
          // it is buffered whatever the caller asked for.
          const streaming = onLine !== null && status >= 200 && status < 300;
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          let pending = '';
          // A chunk boundary lands wherever the network put it, including the middle of a
          // multi-byte character. `chunk.toString('utf8')` would turn that into two replacement
          // characters and quietly corrupt the one line this reader exists to find.
          const decoder = new StringDecoder('utf8');

          response.on('data', (chunk: Buffer) => {
            if (streaming) {
              pending += decoder.write(chunk);
              for (;;) {
                const at = pending.indexOf('\n');
                if (at < 0) break;
                onLine(pending.slice(0, at));
                pending = pending.slice(at + 1);
              }
              if (pending.length > MAX_LINE_BYTES) {
                response.destroy();
                finish(() =>
                  reject(
                    new PodmanUnavailableError(
                      `${method} ${path} sent ${MAX_LINE_BYTES} bytes with no line break`,
                    ),
                  ),
                );
              }
              return;
            }

            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              // SETTLE here, not merely destroy. See this method's own comment.
              truncated = true;
              response.destroy();
              finish(() => resolve({ status, body: Buffer.concat(chunks), truncated }));
              return;
            }
            chunks.push(chunk);
          });

          response.on('end', () => {
            if (streaming) {
              pending += decoder.end();
              if (pending !== '') onLine(pending);
            }
            finish(() => resolve({ status, body: Buffer.concat(chunks), truncated }));
          });

          response.on('error', (error: Error) => {
            finish(() => reject(new PodmanUnavailableError(error.message)));
          });

          // The backstop, and the reason no path through this method can hang.
          response.on('close', () => {
            finish(() =>
              reject(
                new PodmanUnavailableError(`${method} ${path} closed before the response ended`),
              ),
            );
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        finish(() =>
          reject(new PodmanUnavailableError(`${method} ${path} did not answer within ${budget}ms`)),
        );
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        // ENOENT means there is no socket at that path, ECONNREFUSED that nothing is listening on
        // it. Both are "podman is not running here", which is a 503 — the operator's difference
        // between broken and switched off (§3 of this round's rules) depends on not turning these
        // into a 500.
        this.logger.debug(`${method} ${path}: ${error.code ?? error.message}`);
        finish(() => reject(new PodmanUnavailableError(error.message)));
      });

      if (encoded !== null) req.write(encoded);
      req.end();
    });
  }
}

/**
 * Strip Docker/libpod stream framing.
 *
 * Exported for its own test: the failure this prevents is cosmetic-looking and would be shipped
 * without a test that looks at the bytes.
 */
export function demultiplex(raw: Buffer): string {
  const parts: string[] = [];
  let offset = 0;

  while (offset < raw.length) {
    // A frame needs a header. Anything shorter than one is either a plain-text log (a TTY
    // container) or a truncated read; both are better shown than dropped.
    if (raw.length - offset < 8) {
      parts.push(raw.subarray(offset).toString('utf8'));
      break;
    }
    const streamType = raw[offset];
    // Bytes 1..4 are padding and must be zero in a real frame. If they are not, this is not
    // framed output — an image with a TTY writes raw bytes — so pass the rest through untouched.
    const framed =
      (streamType === 0 || streamType === 1 || streamType === 2) &&
      raw[offset + 1] === 0 &&
      raw[offset + 2] === 0 &&
      raw[offset + 3] === 0;
    if (!framed) {
      parts.push(raw.subarray(offset).toString('utf8'));
      break;
    }
    const length = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, raw.length);
    parts.push(raw.subarray(start, end).toString('utf8'));
    offset = end;
    // A zero-length frame with a full header would otherwise spin forever.
    if (length === 0) offset = start;
  }

  return parts.join('');
}

/** libpod's error bodies are `{"cause":…,"message":…,"response":404}`; fall back to raw text. */
function describeFailure(body: Buffer): string {
  const text = body.toString('utf8').trim();
  if (text === '') return 'no detail';
  try {
    const parsed: unknown = JSON.parse(text);
    return readString(parsed, 'message') ?? readString(parsed, 'cause') ?? text;
  } catch {
    return text.slice(0, 500);
  }
}

function parseInfo(body: unknown): PodmanInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const version = readString(record['version'], 'Version');
  const host = record['host'];
  const security =
    typeof host === 'object' && host !== null
      ? (host as Record<string, unknown>)['security']
      : undefined;
  const rootless =
    typeof security === 'object' && security !== null
      ? (security as Record<string, unknown>)['rootless']
      : undefined;
  if (version === null) return null;
  // Absent reads as "not rootless": ADR-0019's warning should appear when the answer is unknown,
  // not be suppressed by it.
  return { version, rootless: rootless === true };
}

function parseContainerSummary(entry: unknown): ContainerSummary | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const names = record['Names'];
  const state = record['State'];
  if (!Array.isArray(names) || typeof state !== 'string') return null;
  return {
    names: names.filter((name): name is string => typeof name === 'string'),
    state,
  };
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : null;
}
