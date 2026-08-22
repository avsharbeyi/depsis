import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXPECTED_SCHEMA_VERSION,
  MAX_CORRELATION_ID,
  MAX_REASON,
  sanitiseCorrelationId,
  sanitiseReason,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(here, '../schema/agent.schema.json');

interface Schema {
  request: {
    oneOf?: Array<{ properties?: Record<string, unknown> }>;
    $defs?: Record<string, unknown>;
  };
  response: { oneOf?: unknown[] };
}

function schema(): Schema {
  return JSON.parse(readFileSync(SCHEMA, 'utf8')) as Schema;
}

/**
 * The properties ADR-0006 relies on, asserted against the schema the binary actually emitted.
 *
 * The committed schema is a build artefact, and a stale or hand-edited one would generate types
 * describing an agent nobody is running. CI diffs the file against a fresh emit; these catch the
 * other case — the emit is current and the CONTENT has regressed.
 */
describe('the emitted agent schema', () => {
  it('describes a closed operation set with no free-form command', () => {
    const ops = (schema().request.oneOf ?? []).map(
      (v) => (v.properties?.['op'] as { const?: string } | undefined)?.const,
    );
    expect(ops.filter(Boolean).sort()).toEqual([
      'create_dataset',
      'create_snapshot',
      'diff_snapshots',
      // The reclaim half, and the reason the set has one at all: `.depsis/staging` counts against
      // the user's refquota, Samba vetoes `/.depsis/` and this API filters the prefix server-side,
      // so an abandoned chunk was invisible to the user, undeletable by the user, undeletable here
      // — the API cannot write inside a share — and undeletable by the agent. Without this the
      // upload path leaked quota nobody could free.
      'discard_transfer',
      // The bulk data path's control half. `open_transfer` resolves and opens a staging file and
      // returns a one-time token; the bytes travel on a separate socket, because Node cannot
      // receive an SCM_RIGHTS descriptor and so the cleanest design — the agent passing the fd —
      // is unreachable. `publish_transfer` is the durable move: rename, then fsync the
      // destination directory (ADR-0008 steps 4 and 5).
      'open_transfer',
      'ping',
      'pool_status',
      'publish_samba_config',
      'publish_transfer',
      'read_smart_summary',
    ]);

    // Property NAMES, not a text search. The words appear in prose inside the descriptions, and
    // grepping the document is exactly how an earlier version of this check produced two false
    // alarms — 'raw' is a field of the smartctl RESPONSE, and 'nfsv4' appears in the comment
    // explaining why nfsv4 is absent.
    const names = new Set(
      (schema().request.oneOf ?? []).flatMap((v) => Object.keys(v.properties ?? {})),
    );
    for (const forbidden of ['command', 'cmd', 'exec', 'shell', 'argv', 'script', 'raw']) {
      expect(names.has(forbidden), `request must not have a '${forbidden}' property`).toBe(false);
    }
  });

  it('cannot express acltype=nfsv4', () => {
    // P0-B measured nfsv4 reporting itself as configured while enforcing nothing. The defence is
    // that the value is unrepresentable, so this reads the enum rather than searching the text.
    const acl = schema().request.$defs?.['AclType'] as { oneOf?: Array<{ const?: string }> };
    expect(acl.oneOf?.map((v) => v.const)).toEqual(['posixacl']);
  });

  it('has a response for every outcome the client must handle', () => {
    expect(schema().response.oneOf?.length).toBeGreaterThanOrEqual(11);
  });
});

describe('envelope sanitising', () => {
  it('replaces control characters rather than dropping them', () => {
    // Built with fromCharCode rather than escape sequences, because a literal control character
    // in a source file is invisible: an earlier version of this test had them written plainly,
    // they were lost in an edit, and the assertions quietly became tautologies comparing a
    // string to itself.
    const bel = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    const c1 = String.fromCharCode(0x9f);

    // Dropping would turn a newline into nothing and silently change the text; a space keeps it
    // readable as what it was, which matters because this reaches an append-only audit trail.
    expect(sanitiseReason('a' + bel + 'bc')).toBe('a bc');
    expect(sanitiseReason('a' + del + 'b')).toBe('a b');
    expect(sanitiseReason('a' + c1 + 'b')).toBe('a b');
    expect(sanitiseReason('a\nb')).toBe('a b');
    expect(sanitiseReason('ordinary text')).toBe('ordinary text');
  });

  it('bounds the reason at the length the agent accepts', () => {
    expect(sanitiseReason('x'.repeat(500))).toHaveLength(MAX_REASON);
  });

  it('bounds the correlation id and refuses an empty one', () => {
    expect(sanitiseCorrelationId('y'.repeat(200))).toHaveLength(MAX_CORRELATION_ID);
    // An empty correlation id means a privileged call nobody can trace back to an HTTP request,
    // which is the one thing the audit trail exists to prevent.
    expect(() => sanitiseCorrelationId('')).toThrow();
    expect(() => sanitiseCorrelationId(String.fromCharCode(10, 10))).toThrow();
  });

  it('pins the schema version the API expects', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(1);
  });
});
