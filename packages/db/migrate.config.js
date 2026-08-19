// node-pg-migrate configuration.
//
// Kept as a file rather than CLI flags so that "how are migrations run" is reviewable in the same
// place as "what do they do", and so CI and a developer's shell cannot drift apart.

/** @type {import('node-pg-migrate').RunnerOption} */
export default {
  // The OWNER connection, never the application one. ADR-0013 forbids the app connecting as the
  // owner; keeping the two in separate environment variables means a copy-paste error produces a
  // missing-variable failure rather than a silent RLS bypass.
  databaseUrl: process.env.DEPSIS_MIGRATION_DATABASE_URL,

  dir: 'migrations',
  direction: 'up',

  // Named explicitly rather than left to the tool's default, so a future default change does not
  // silently create a second history table and re-run every migration.
  migrationsTable: 'depsis_migrations',

  // Wait for the advisory lock instead of failing. Two deploy jobs racing is a normal thing to
  // survive; the lock is what makes it safe, and failing the second one just moves the problem
  // into whatever retries it.
  advisoryLockMode: 'wait',

  // One transaction per migration, not one for the whole run. A migration that fails leaves the
  // ones before it applied and recorded, which is what makes a partial deploy diagnosable.
  singleTransaction: false,

  // No JS migrations exist and none may be added (ADR-0014). This makes that a loader-level fact
  // rather than a convention someone has to remember during review.
  ignorePattern: '.*\.(js|ts|mjs|cjs)$',
};
