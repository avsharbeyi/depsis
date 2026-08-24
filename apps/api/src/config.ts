import { readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * The URL prefix every route sits behind.
 *
 * Must match the `servers` entry in packages/contracts/openapi/depsis.yaml, and `contract.test.ts`
 * asserts that it does. It lives here rather than in `main.ts` because importing a constant should
 * not start a web server: the test that reads it was, briefly, booting the application as a side
 * effect of an import.
 */
export const API_PREFIX = 'api/v1';

/**
 * Where podman listens when nothing says otherwise.
 *
 * The root socket, which is what a distribution package installs and what the development box has.
 * ADR-0019 wants the rootless one in production (`/run/user/<uid>/podman/podman.sock`) and the
 * deployment sets `DEPSIS_PODMAN_SOCKET` to it; `GET /apps` reports `runtime.rootless` so that a
 * box still on this default is visible rather than silently off-ADR.
 */
export const PODMAN_SOCKET_DEFAULT = '/run/podman/podman.sock';

/**
 * Where the administrator console service listens when nothing says otherwise (ADR-0018).
 *
 * The socket is created by `depsis-console.socket`, not by either process, and its path is that
 * unit's `ListenStream=`. The two have to agree, and a constant in the API plus a line in a unit
 * file is exactly the sort of pair that drifts — which is why this is a default rather than a
 * hard-coded path, and why the deployment sets `DEPSIS_CONSOLE_SOCKET` when it moves.
 */
export const CONSOLE_SOCKET_DEFAULT = '/run/depsis/console.sock';

/**
 * The server name in the `\\server\share` address DEPSIS shows for an SMB share.
 *
 * NOT the box's hostname, and not derived from the request's Host header either. Which name
 * resolves to this appliance from a Windows client is a fact about the network the appliance
 * cannot see: it may be a NetBIOS name Samba announces, a DNS name an operator created, a
 * `.local` name mDNS answers for, or a ZeroTier address on a machine that never sees the LAN.
 * `gethostname()` agrees with none of those reliably.
 *
 * So it is configuration with a default, and the default is the product's own name because that is
 * what the appliance ships announcing itself as. Getting it wrong shows a user an address that
 * looks authoritative and does not answer — the exact failure `GET /shares` exists to prevent —
 * which is why a deployment that renamed the box sets `DEPSIS_SMB_HOST`.
 */
export const SMB_HOST_DEFAULT = 'depsis';

/**
 * ADR-0001 makes runtime validation mandatory at every boundary, and process.env is a boundary:
 * TypeScript will happily type `process.env.X` as `string | undefined` and then let a `!` silence
 * it. A missing DEPSIS_DATABASE_URL should stop the process at startup with a sentence someone can
 * act on, not surface later as a connection error with no context.
 */
const schema = z.object({
  // Deliberately NOT accepting DEPSIS_MIGRATION_DATABASE_URL as a fallback. ADR-0014 keeps the two
  // in separate variables so that the application cannot end up connected as the migration owner,
  // which bypasses row level security; accepting a fallback here would hand that back.
  //
  // Optional HERE only because exactly one of it and DEPSIS_DATABASE_URL_FILE must be set, which is
  // checked below — zod cannot express "one of these two" inside a field.
  DEPSIS_DATABASE_URL: z.string().min(1).optional(),

  // The same connection string, in a file, for the same reason DEPSIS_SECRET_KEY_FILE is a file.
  //
  // A connection string contains a password, so leaving it only as an environment variable would
  // have made ADR-0016 argue against a form this project was still using one line away: readable
  // through /proc/<pid>/environ by anything running as the same user, inherited by every child
  // process, and present in crash reports. On a systemd deployment both secrets now arrive the same
  // way, through LoadCredential=, and neither is in the environment.
  DEPSIS_DATABASE_URL_FILE: z.string().trim().min(1).optional(),
  DEPSIS_API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Optional, unlike the database URL, and the asymmetry is deliberate. Without a database the API
  // can do nothing at all; without the agent it can still authenticate, and a development machine
  // has no agent to point at. Absence is a warning at startup and a 503 on the endpoints that need
  // it — see AgentService. An empty string is treated as absent, because that is what a shell
  // exports when a variable is set from an unset variable and it should not read as a valid path.
  DEPSIS_AGENT_SOCKET: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),

  // The agent's BULK DATA socket, separate from the control one above (ADR-0017).
  //
  // Two variables rather than one derived from the other, because a deployment that moves one has
  // no reason to have moved the other in the same way, and deriving `agent-data.sock` from
  // `agent.sock` would be a rule nobody wrote down. Optional for the same reason as the control
  // socket: a development machine has neither.
  DEPSIS_AGENT_DATA_SOCKET: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),

  // The file holding the key that seals TOTP secrets at rest (ADR-0016).
  //
  // A FILE, not the key itself in the environment: an environment variable is readable through
  // /proc/<pid>/environ by anything running as the same user, is inherited by every child process,
  // and turns up in crash reporters. On a systemd deployment this is what LoadCredential= presents
  // under $CREDENTIALS_DIRECTORY, mode 0400, owned by the service user.
  //
  // Optional, so the API still starts without it — but enrolment then refuses rather than quietly
  // storing a raw secret, and existing sealed secrets stop verifying while recovery codes keep
  // working. See MfaService.
  DEPSIS_SECRET_KEY_FILE: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),

  // The podman socket the application catalogue talks to (ADR-0019).
  //
  // A path from configuration rather than a constant, because the path is where the privilege
  // decision shows up. ADR-0019 puts containers under a rootless `depsis-apps` user, whose socket
  // is `/run/user/<uid>/podman/podman.sock`; the development box has only the root socket at the
  // default below. Code that hard-coded either one would make the deployment that got the other a
  // code change.
  //
  // Not optional and not nullable, unlike the agent sockets: an absent socket is indistinguishable
  // from a podman that is not installed, and both are the same answer — 503 from the endpoints
  // that need it. A null here would add a second way to say the same thing.
  DEPSIS_PODMAN_SOCKET: z.string().trim().min(1).default(PODMAN_SOCKET_DEFAULT),

  // Permission to create and start containers through a ROOTFUL podman socket.
  //
  // The default above is the root socket, because that is what a distribution package installs —
  // and ADR-0019's whole privilege argument is that a catalogue container runs as an unprivileged
  // user. On a rootful socket a container runs as real uid 0 on the host with a user share bound
  // in rw, so a compromised upstream image is host root. Left as it was, a deployment that simply
  // never set `DEPSIS_PODMAN_SOCKET` was off-ADR BY OMISSION.
  //
  // So the unsafe direction is the one that has to be written down. Absent or anything other than
  // `1` means no: `/apps` still lists and still stops and removes on a rootful socket, and it
  // refuses to install or start. Deliberately not `z.coerce.boolean()`, which treats every
  // non-empty string as true — including `0` and `false`.
  DEPSIS_PODMAN_ALLOW_ROOTFUL: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === '1'),

  // Where the console service listens (ADR-0018).
  //
  // Not optional and not nullable, for the reason the podman socket is neither: an absent socket
  // and a console service that is not running are the same condition and have the same answer, a
  // 503 from the console endpoints. A null here would be a second way to say "switched off", and
  // the endpoints would then have two paths to get that answer right.
  DEPSIS_CONSOLE_SOCKET: z.string().trim().min(1).default(CONSOLE_SOCKET_DEFAULT),

  // Where the share tree is mounted — the same directory the agent opens as its resolution root
  // (`DEPSIS_SHARES_ROOT` in services/system-agent/src/main.rs).
  //
  // The application catalogue needs it because a bind mount into a container is a HOST PATH, and
  // ADR-0019 will not let that path come from the request. `shares` records a dataset and a name;
  // the path a container is given is this root joined with the share's name, which is exactly the
  // path the agent would resolve for the same share. Deriving it any other way would mean two
  // components disagreeing about where a share lives.
  //
  // Optional, because a box before setup has no share tree — installing an app then answers 503
  // rather than binding a path nobody configured.
  DEPSIS_SHARES_ROOT: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),

  // The dataset new shares are created UNDER, e.g. `tank/depsis`. `POST /shares` needs it and
  // refuses without it.
  //
  // Configuration rather than discovery, for the same reason as DEPSIS_ZFS_POOLS below: the
  // agent's operation set is closed and has no "list datasets", so there is nothing to enumerate.
  //
  // NOT because the pool is out of the product — it no longer is. `POST /storage/pools` creates
  // one, under §8.1's sequence. What is still the operator's is this PAIRING: the pool is created
  // with `-m none`, so the dataset that shares live under has to be created and mounted at
  // `DEPSIS_SHARES_ROOT` deliberately, and this variable is where that decision is recorded.
  //
  // IT MUST BE THE DATASET MOUNTED AT `DEPSIS_SHARES_ROOT`, and that pairing is the whole design.
  // `CreateDataset` sets no mountpoint — deliberately, because a mountpoint operand would let the
  // API mount a tenant's dataset anywhere on the box — so a child dataset lands wherever ZFS
  // inheritance puts it. With `tank/depsis` mounted at `/srv/depsis`, creating `tank/depsis/belgeler`
  // produces `/srv/depsis/belgeler`, which is precisely the directory the agent resolves for the
  // share named `belgeler`. Point this at a dataset mounted somewhere else and the appliance
  // creates datasets nothing serves: the row exists, `zfs list` shows it, and the share is empty
  // in the file manager because the agent is looking at a directory that was never created.
  //
  // Optional, because a box before setup has no pool. Creating a share then answers 503 with that
  // sentence rather than inventing a dataset name against a pool that may not exist.
  DEPSIS_SHARE_PARENT_DATASET: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value))
    .refine(
      (value) => value === null || /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(value),
      'must be a ZFS dataset path such as tank/depsis — no leading dash, no spaces',
    ),

  // The server name in the UNC paths /shares reports. See SMB_HOST_DEFAULT.
  //
  // The pattern is not decoration. This value is concatenated into `\\host\share` and handed to a
  // person to type into Explorer, so a value containing a backslash or a space would produce an
  // address that names a different host, or no host at all, while looking like a DEPSIS bug. The
  // shape below is the intersection of what NetBIOS and DNS will both carry: letters, digits, dot,
  // dash, underscore, no leading punctuation, and short enough for a NetBIOS name.
  DEPSIS_SMB_HOST: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'must be a host name, not a path or an address')
    .default(SMB_HOST_DEFAULT),

  // Which ZFS pools /system/telemetry reports on, comma-separated.
  //
  // Configuration rather than discovery: the agent's operation set is closed and has no "list
  // pools", and adding one is a change to the Rust-side contract (ADR-0006) rather than something
  // the API decides. Empty means the endpoint reports no pools, which is correct on a machine that
  // has none — a wrong NAME is the visible failure, because the agent refuses and the refusal is
  // reported rather than swallowed.
  DEPSIS_ZFS_POOLS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),

  // Which disks /system/telemetry asks the agent for a SMART summary about, comma-separated.
  //
  // Configuration for the same reason as DEPSIS_ZFS_POOLS, and not a weaker one: the agent's
  // operation set is closed and contains `ReadSmartSummary` but no "list disks", so there is
  // nothing to discover from. Adding a listing operation is a change to the Rust-side contract
  // (ADR-0006).
  //
  // The values are `/dev/disk/by-id` names, NOT `/dev/sdX`. The agent types the operand as a
  // SafeComponent under that directory and rejects a path outright, which is what closes risk R1:
  // `sdb` can name a different physical disk after a reboot, so a temperature graphed against it
  // would silently change subject. Empty means the endpoint reports no disks, which is correct on
  // a machine nobody has configured them for.
  DEPSIS_SMART_DISKS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    ),
});

export interface AppConfig {
  databaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  agentSocket: string | null;
  agentDataSocket: string | null;
  secretKeyFile: string | null;
  // The two settings the application catalogue needs. OPTIONAL in the interface although
  // `loadConfig` always fills them, because both have a usable answer when absent — the podman
  // socket has a default and an unset share root is a box with no share tree — and because a test
  // that builds an `AppConfig` literal to exercise something else should not have to name every
  // setting the appliance has grown. See `PODMAN_SOCKET_DEFAULT`.
  podmanSocket?: string;
  /** See `DEPSIS_PODMAN_ALLOW_ROOTFUL`. Absent reads as false, which is the safe direction. */
  podmanAllowRootful?: boolean;
  sharesRoot?: string | null;
  /**
   * See `DEPSIS_SHARE_PARENT_DATASET`. Absent or null means no share can be created, which is the
   * honest state of a box whose pool the operator has not made yet — `POST /shares` answers 503
   * and says so, rather than guessing a pool name and failing inside the agent.
   */
  shareParentDataset?: string | null;
  // Optional in the interface for the same reason as the two above: it has a usable answer when
  // absent, and a test building an `AppConfig` literal for something else should not have to name
  // every socket the appliance has grown. See `CONSOLE_SOCKET_DEFAULT`.
  consoleSocket?: string;
  // Optional in the interface for the reason the three above are: it has a usable answer when
  // absent (`SMB_HOST_DEFAULT`), and a test building an `AppConfig` literal for something else
  // should not have to name every setting the appliance has grown.
  smbHost?: string;
  zfsPools: readonly string[];
  smartDisks: readonly string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid environment: ${detail}`);
  }
  return {
    databaseUrl: resolveDatabaseUrl(parsed.data),
    port: parsed.data.DEPSIS_API_PORT,
    nodeEnv: parsed.data.NODE_ENV,
    agentSocket: parsed.data.DEPSIS_AGENT_SOCKET,
    agentDataSocket: parsed.data.DEPSIS_AGENT_DATA_SOCKET,
    secretKeyFile: parsed.data.DEPSIS_SECRET_KEY_FILE,
    podmanSocket: parsed.data.DEPSIS_PODMAN_SOCKET,
    podmanAllowRootful: parsed.data.DEPSIS_PODMAN_ALLOW_ROOTFUL,
    consoleSocket: parsed.data.DEPSIS_CONSOLE_SOCKET,
    sharesRoot: parsed.data.DEPSIS_SHARES_ROOT,
    shareParentDataset: parsed.data.DEPSIS_SHARE_PARENT_DATASET,
    smbHost: parsed.data.DEPSIS_SMB_HOST,
    zfsPools: parsed.data.DEPSIS_ZFS_POOLS,
    smartDisks: parsed.data.DEPSIS_SMART_DISKS,
  };
}

/**
 * Exactly one of DEPSIS_DATABASE_URL and DEPSIS_DATABASE_URL_FILE.
 *
 * Not "the file wins if both are set", and not "fall back to the other". A deployment that sets
 * both has two answers to one question and no way to know which one is live — and on the day they
 * disagree, the API connects somewhere nobody expected, which is precisely the failure ADR-0014's
 * two-variable split exists to prevent. Refusing is cheap and happens at startup.
 */
function resolveDatabaseUrl(data: {
  // `| undefined` written out, because `exactOptionalPropertyTypes` makes "may be absent" and "may
  // be undefined" different types, and zod's output is the second.
  DEPSIS_DATABASE_URL?: string | undefined;
  DEPSIS_DATABASE_URL_FILE?: string | undefined;
}): string {
  const inline = data.DEPSIS_DATABASE_URL;
  const path = data.DEPSIS_DATABASE_URL_FILE;

  if (inline !== undefined && path !== undefined) {
    throw new Error(
      'invalid environment: DEPSIS_DATABASE_URL and DEPSIS_DATABASE_URL_FILE are both set; ' +
        'set exactly one so there is no question which connection is live',
    );
  }
  if (inline !== undefined) return inline;
  if (path === undefined) {
    throw new Error(
      'invalid environment: one of DEPSIS_DATABASE_URL or DEPSIS_DATABASE_URL_FILE is required',
    );
  }

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `invalid environment: cannot read DEPSIS_DATABASE_URL_FILE at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      // The original carries the errno and the resolved path, which is what tells an operator
      // whether the credential did not mount or the unit named the wrong file.
      { cause: error },
    );
  }
  // Trimmed, because a credential file written by an installer almost always ends in a newline and
  // a connection string with a trailing newline fails in a way that names neither the file nor the
  // newline.
  const url = contents.trim();
  if (url === '') {
    throw new Error(`invalid environment: DEPSIS_DATABASE_URL_FILE at ${path} is empty`);
  }
  return url;
}
