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
  DEPSIS_DATABASE_URL: z.string().min(1, 'DEPSIS_DATABASE_URL is required'),
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
});

export interface AppConfig {
  databaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  agentSocket: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid environment: ${detail}`);
  }
  return {
    databaseUrl: parsed.data.DEPSIS_DATABASE_URL,
    port: parsed.data.DEPSIS_API_PORT,
    nodeEnv: parsed.data.NODE_ENV,
    agentSocket: parsed.data.DEPSIS_AGENT_SOCKET,
  };
}
