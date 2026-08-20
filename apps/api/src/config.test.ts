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
