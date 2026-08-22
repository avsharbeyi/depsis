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
});

export interface AppConfig {
  databaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  agentSocket: string | null;
  agentDataSocket: string | null;
  secretKeyFile: string | null;
  zfsPools: readonly string[];
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
    zfsPools: parsed.data.DEPSIS_ZFS_POOLS,
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
