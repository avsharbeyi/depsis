import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('requires DEPSIS_DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DEPSIS_DATABASE_URL/);
  });

  it('does NOT fall back to the migration connection string', () => {
    // ADR-0014 keeps the two apart so the application cannot end up connected as the migration
    // owner, which bypasses row level security. A convenience fallback here would hand that back
    // and the symptom would be every tenant's rows, with no error anywhere.
    expect(() =>
      loadConfig({ DEPSIS_MIGRATION_DATABASE_URL: 'postgresql://depsis_owner@localhost/depsis' }),
    ).toThrow(/DEPSIS_DATABASE_URL/);
  });

  it('defaults the port and environment', () => {
    const c = loadConfig({ DEPSIS_DATABASE_URL: 'postgresql://depsis_app@localhost/depsis' });
    expect(c.port).toBe(3000);
    expect(c.nodeEnv).toBe('development');
  });

  it('rejects a port that is not a port', () => {
    expect(() => loadConfig({ DEPSIS_DATABASE_URL: 'x', DEPSIS_API_PORT: '70000' })).toThrow(
      /DEPSIS_API_PORT/,
    );
  });
});

describe('the database connection can arrive in a file', () => {
  const URL = 'postgresql://depsis_app:hunter2@localhost/depsis';

  it('reads it, and tolerates the newline an installer leaves', () => {
    // A connection string carries a password, so it gets the same treatment as the secret key: out
    // of the environment, where /proc/<pid>/environ and every child process can see it.
    const path = join(tmpdir(), `depsis-db-url-${randomUUID()}`);
    writeFileSync(path, `${URL}\n`);
    try {
      expect(loadConfig({ DEPSIS_DATABASE_URL_FILE: path }).databaseUrl).toBe(URL);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('refuses both forms at once rather than picking one', () => {
    // Two answers to one question, and on the day they disagree the API connects somewhere nobody
    // expected. Neither "the file wins" nor "fall back" is safe; refusing at startup is.
    expect(() =>
      loadConfig({ DEPSIS_DATABASE_URL: URL, DEPSIS_DATABASE_URL_FILE: '/tmp/whatever' }),
    ).toThrow(/are both set/);
  });

  it('names the file when it cannot be read', () => {
    const missing = join(tmpdir(), `depsis-absent-${randomUUID()}`);
    expect(() => loadConfig({ DEPSIS_DATABASE_URL_FILE: missing })).toThrow(missing);
  });

  it('refuses an empty file instead of connecting to nowhere', () => {
    const path = join(tmpdir(), `depsis-empty-${randomUUID()}`);
    writeFileSync(path, '   \n');
    try {
      expect(() => loadConfig({ DEPSIS_DATABASE_URL_FILE: path })).toThrow(/is empty/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('still refuses when neither is set', () => {
    expect(() => loadConfig({})).toThrow(/DEPSIS_DATABASE_URL_FILE/);
  });
});
