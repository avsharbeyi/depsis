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
      // A copy the bytes never leave the agent for. The obvious shape — the API reading over the
      // data channel and writing back — holds TWO of the sixteen rendezvous-served data
      // connections at once, and that many concurrent copies deadlock the whole socket rather than
      // merely queueing. Both ends are under one root, so `copy_file_range(2)` inside the agent is
      // both safer and faster. One FILE: the API issues one `create_directory` per folder and one
      // of these per file, because a recursive copy is a blast radius the caller chose.
      'copy_file',
      'create_dataset',
      // ONE directory, never `mkdir -p`. Its absence was a hole under the product rather than a
      // gap in the set: `FilesService.createFolder` could write a row and nothing else, so a
      // folder existed in Postgres and did not exist on disk — which made every move through it
      // fail, every upload into it fail, and every SMB client see no folders at all. An implicit
      // mkdir is refused for the same reason `move_entry` will not create its destination parent:
      // it turns a typo into a directory the user never asked for, and it breaks the one-row
      // one-directory correspondence that keeps the two stores in step.
      'create_directory',
      // THE ONE DESTRUCTIVE STORAGE OPERATION. ADR-0007 does not forbid it — it keeps destructive
      // work out of a GENERIC storage interface and requires it to be written explicitly per
      // backend — and §8.1 prescribes the sequence around it. Three refusals live in the agent
      // rather than in a dialogue: the system disk is never a member, the WWN named for each disk
      // must match what the box reports at the moment of creation, and `-f` is never passed, so
      // `zpool` itself still refuses a disk that already holds a filesystem.
      'create_pool',
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
      // What is on disk, so DEPSIS can find out what it does not know. Names and metadata only:
      // a directory read under RESOLVE_BENEATH plus an fstatat per entry. Without it a file
      // written over SMB — which is what a NAS is for — was invisible to the web interface, to
      // search and to the permission walk.
      'list_directory',
      // What disks the box has. NO OPERANDS, which is the whole of its security argument: nothing
      // in the request reaches the command line, so there is no `-d` and no second device to
      // smuggle. It exists because §8.1 requires a destructive storage operation to be preceded by
      // an analysis naming the affected disks by serial or WWN — an analysis nothing could produce
      // while the set had `read_smart_summary` and no way to enumerate. The same gap made
      // `DEPSIS_SMART_DISKS` a list of `/dev/disk/by-id` names an operator typed in by hand, with
      // nothing to type them from.
      'list_disks',
      // What pools the box has. `DEPSIS_ZFS_POOLS` was a list an operator typed into `api.env`,
      // which was defensible while the pool was made from a shell at install time and stopped
      // being so the moment the product could create one: the wizard finished and the pool
      // appeared nowhere until somebody edited a file and restarted the API.
      'list_pools',
      'list_snapshots',
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
      // Create `<pool>/depsis` and mount it where this agent serves shares from. THE MOUNTPOINT IS
      // NOT AN OPERAND — it is the agent's own `DEPSIS_SHARES_ROOT`, and the dataset name is
      // derived. `CreateDataset` refuses a mountpoint operand because a caller that could choose
      // one could mount a tenant's data anywhere on the box; here the caller chooses the POOL.
      // Refused when a dataset is already mounted there, and refused when the directory is not
      // empty: `zfs create -o mountpoint=X` mounts over X without complaint, and everything
      // underneath vanishes from view while still occupying the disk.
      'prepare_share_root',
      'publish_samba_config',
      'publish_transfer',
      'read_smart_summary',
      // ONE entry, never a tree. The recursive delete the permanent-delete endpoint appears to
      // need is deliberately absent: an operation whose blast radius the caller chooses is `rm -rf`
      // behind a typed name, in the one process that can reach every tenant's data. The API walks
      // the tree from the leaves up, because the API is the side that stores it (§2.2, ADR-0006).
      'remove_entry',
      'replicate_dataset',
      'restore_from_snapshot',
      // The one operation that touches a share root's MODE, and the reason it is separate from
      // `create_dataset`. `zfs create` leaves a mountpoint at 0755 root:root and `apply_folder_acl`
      // refuses to touch the user::/group::/other:: triple, so every share root was `other::r-x`
      // and any principal Samba authenticated could enumerate its top-level names whatever
      // `folder_grants` said. An operand on creation would only ever have fixed the next share;
      // this can be aimed at one that already exists, and the API runs it before every root ACL
      // write. It takes no mode: the value is the agent's, so a caller cannot ask for 0777.
      'secure_share_root',
      // The last link between the permission model and SMB, and the most privileged thing in the
      // set: it creates system accounts. The operands are narrowed until the dangerous shapes
      // cannot be expressed — every id is a `PosixId` confined to 300000-399999, so `root` and
      // `www-data` are unrepresentable, and GROUP names are derived from the gid rather than
      // supplied, which is what stops `gpasswd -M` being pointed at `sudo`. The one caller-supplied
      // string is the login, because the alternative is a person typing `depsis-u-300001` into
      // Windows; the agent checks it against `getent` and refuses a name that belongs to an
      // account outside the reserved range.
      //
      // Passwords never appear. What crosses is an NT hash the API computed
      // (`apps/api/src/auth/nt-hash.ts`), because `tools/poc/p2-b-smb-password.sh` measured that a
      // precomputed hash installs and authenticates — so the user's actual password, which they
      // may have reused elsewhere, stays on the unprivileged side.
      // Which dataset is mounted where shares are served from, and whether anything is there.
      // The question `DEPSIS_SHARE_PARENT_DATASET` was configuration for — and getting that
      // pairing wrong produces an appliance that creates datasets nothing serves.
      'share_root_status',
      // Per-file restore, and the pair is deliberate: one reads a snapshot, one copies out of
      // it. Neither writes into one — a ZFS snapshot is immutable, so a write variant could
      // only ever fail, and its presence would suggest otherwise.
      'snapshot_entries',
      'sync_posix_identity',
      // ADR-0020's four, and the shape of them is the point. A general `ZeroTierRequest { path }`
      // proxy would have been the network form of the free-form command §2.2 forbids: one variant
      // through which every other endpoint of zerotier-one's local API becomes reachable. Instead
      // the join takes a typed network id, the leave takes the same, and the two reads take
      // nothing. Adding a fifth means writing a fifth variant, which is the friction that keeps
      // the set closed.
      'zerotier_join',
      'zerotier_leave',
      'zerotier_networks',
      'zerotier_peers',
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
    // Must equal `SCHEMA_VERSION` in services/system-agent/src/op.rs. 17 since
    // `SnapshotEntries` and `RestoreFromSnapshot` — per-file restore, and the one place the
    // agent is allowed to cross a mount boundary. A stale agent that did not know them would
    // answer a restore with a parse failure rather than half-performing one. 16 since
    // `ZeroTierPeers`, the connection diagnostic. 15 since
    // `ReplicateDataset`, the second most destructive operation in the set: a stale agent
    // that did not know it would answer with a parse failure rather than running a
    // `zfs recv -F` it did not understand. 14 since `ListSnapshots`,
    // which is what turned the backups list from DEPSIS's own record into the pool's inventory —
    // an API that believed it could ask a stale agent would show every recorded snapshot as
    // unverified forever. 6 since
    // `SyncPosixIdentity`; the pair is what makes a new API against a stale agent fail at the
    // handshake instead of on the first privileged call. For these last two operations that
    // matters more than usual: a stale agent would leave share roots world-traversable and every
    // ACL entry pointing at a uid no account holds, with the API believing both were handled.
    expect(EXPECTED_SCHEMA_VERSION).toBe(17);
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
