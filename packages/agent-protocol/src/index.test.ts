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
      // The kernel half of ADR-0004's access-control model. `folder_grants` in the database says
      // who may reach a folder; until this runs the kernel has never been told, and SMB — which
      // does not go through the API at all — enforces the mode bits and nothing else. The entry
      // list is COMPLETE rather than a delta, because "here is who may reach this folder" is a
      // statement the caller can make correctly and "here is what changed" is one it would have to
      // reconstruct from a disk it cannot read.
      'apply_folder_acl',
      'create_dataset',
      // ONE directory, never `mkdir -p`. Its absence was a hole under the product rather than a
      // gap in the set: `FilesService.createFolder` could write a row and nothing else, so a
      // folder existed in Postgres and did not exist on disk — which made every move through it
      // fail, every upload into it fail, and every SMB client see no folders at all. An implicit
      // mkdir is refused for the same reason `move_entry` will not create its destination parent:
      // it turns a typo into a directory the user never asked for, and it breaks the one-row
      // one-directory correspondence that keeps the two stores in step.
      'create_directory',
      'create_snapshot',
      'diff_snapshots',
      // The reclaim half, and the reason the set has one at all: `.depsis/staging` counts against
      // the user's refquota, Samba vetoes `/.depsis/` and this API filters the prefix server-side,
      // so an abandoned chunk was invisible to the user, undeletable by the user, undeletable here
      // — the API cannot write inside a share — and undeletable by the agent. Without this the
      // upload path leaked quota nobody could free.
      'discard_transfer',
      // Rename and relocate, one `renameat2(RENAME_NOREPLACE)` on two descriptors the agent
      // resolved itself. Named for the entry rather than for the syscall because the API asks for
      // an outcome, and because `rename` in this product already means the metadata-only kind.
      'move_entry',
      // The bulk data path's control half. `open_transfer` resolves and opens a staging file and
      // returns a one-time token; the bytes travel on a separate socket, because Node cannot
      // receive an SCM_RIGHTS descriptor and so the cleanest design — the agent passing the fd —
      // is unreachable. `publish_transfer` is the durable move: rename, then fsync the
      // destination directory (ADR-0008 steps 4 and 5).
      // The reverse direction, added when GET /files/{id}/content was built: the unprivileged API
      // cannot open a file inside a share — it has no descriptor and, in the general case, no
      // permission — so the bytes come back through the agent on the same socket they went out on.
      'open_download',
      'open_transfer',
      'ping',
      'pool_status',
      'publish_samba_config',
      'publish_transfer',
      'read_smart_summary',
      // ONE entry, never a tree. The recursive delete the permanent-delete endpoint appears to
      // need is deliberately absent: an operation whose blast radius the caller chooses is `rm -rf`
      // behind a typed name, in the one process that can reach every tenant's data. The API walks
      // the tree from the leaves up, because the API is the side that stores it (§2.2, ADR-0006).
      'remove_entry',
      // ADR-0020's four, and the shape of them is the point. A general `ZeroTierRequest { path }`
      // proxy would have been the network form of the free-form command §2.2 forbids: one variant
      // through which every other endpoint of zerotier-one's local API becomes reachable. Instead
      // the join takes a typed network id, the leave takes the same, and the two reads take
      // nothing. Adding a fifth means writing a fifth variant, which is the friction that keeps
      // the set closed.
      'zerotier_join',
      'zerotier_leave',
      'zerotier_networks',
      'zerotier_status',
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
    // Must equal `SCHEMA_VERSION` in services/system-agent/src/op.rs. 3 since `MoveEntry` and
    // `RemoveEntry`; the pair is what makes a new API against a stale agent fail at the handshake
    // instead of on the first privileged call.
    expect(EXPECTED_SCHEMA_VERSION).toBe(4);
  });

  it('agrees with the number the agent actually reports', () => {
    // The literal above has already drifted once: op.rs went to 3 with `MoveEntry`/`RemoveEntry`
    // and this constant stayed at 2, which would have made `AgentService.onModuleInit` fail the
    // handshake and answer 503 from EVERY agent-backed endpoint on a correctly matched pair. A
    // test that only pins the literal cannot see that, because the literal is the thing that was
    // wrong. So this one reads the other language.
    const opRs = readFileSync(resolve(here, '../../../services/system-agent/src/op.rs'), 'utf8');
    const declared = /pub const SCHEMA_VERSION: u32 = (\d+);/.exec(opRs)?.[1];
    expect(declared, 'SCHEMA_VERSION was not found in op.rs — has it been renamed?').toBeDefined();
    expect(Number(declared)).toBe(EXPECTED_SCHEMA_VERSION);
  });
});
