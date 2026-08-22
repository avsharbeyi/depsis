import { Injectable, Logger } from '@nestjs/common';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { DbService, type TenantQuery } from '../db/db.service.js';

/**
 * A row in `file_entries`, as the database returns it.
 *
 * `path` is display only. Authority is `parent_id` (ADR-0005): every check in this file resolves an
 * id, and no decision anywhere reads the path string.
 */
export interface FileEntryRow {
  id: string;
  share_id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  path: string;
  size_bytes: string;
  content_type: string | null;
  trashed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShareRow {
  id: string;
  name: string;
  dataset: string;
  read_only: boolean;
}

/** A name the caller supplied that the filesystem or the schema will not accept. */
export class InvalidNameError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidNameError';
  }
}

/** The entry does not exist, or belongs to another tenant — deliberately the same answer. */
export class EntryNotFoundError extends Error {
  constructor() {
    super('no such entry');
    this.name = 'EntryNotFoundError';
  }
}

/** A sibling already has this name. */
export class NameTakenError extends Error {
  constructor(readonly takenName: string) {
    super(`${takenName} already exists here`);
    this.name = 'NameTakenError';
  }
}

/**
 * A move whose destination is in another share.
 *
 * Refused rather than performed as a copy. Every DEPSIS share is its own ZFS dataset and
 * `rename(2)` across datasets returns `EXDEV` (ADR-0008), so the only way to honour this request
 * would be to copy the bytes and delete the original — a different operation with a different
 * cost and a different failure mode, which therefore deserves its own endpoint rather than a
 * surprise inside this one.
 */
export class CrossShareMoveError extends Error {
  constructor() {
    super('a move cannot cross shares; copy it instead');
    this.name = 'CrossShareMoveError';
  }
}

/**
 * A folder moved into its own subtree.
 *
 * The cycle this makes is not a cosmetic problem. `parent_id` is the authority for the whole tree,
 * so a folder that is its own ancestor turns every recursive walk — the path rebuild below, the
 * search scope, `componentsOf` — into a query that never terminates. The database has no
 * constraint that can see it, so this check is the only thing standing between a user's drag and a
 * statement timeout on every subsequent listing.
 */
export class MoveIntoDescendantError extends Error {
  constructor(readonly folderName: string) {
    super(`'${folderName}' cannot be moved inside itself`);
    this.name = 'MoveIntoDescendantError';
  }
}

/** Permanent deletion works on the trash, and only on the trash. */
export class NotTrashedError extends Error {
  constructor(readonly entryName: string) {
    super(`'${entryName}' is not in the trash; move it there first`);
    this.name = 'NotTrashedError';
  }
}

/**
 * The row is here and the file is not.
 *
 * Deliberately NOT `EntryNotFoundError`. A 404 would tell the caller its id is wrong, and it is
 * not — the entry exists, the tenant owns it, and the thing that is missing is on the other side
 * of a boundary the caller cannot see. The two stores disagree, which is a state to report rather
 * than an identity to deny.
 */
export class EntryMissingOnDiskError extends Error {
  constructor(readonly agentReason: string) {
    // The agent's own words stay on `agentReason` and out of the message. They are Rust error
    // prose written for whoever reads the journal — `SeamError::PathEscape("alice/docs/x:
    // Operation not permitted (os error 1)")`, or the classify_openat2 paragraph naming kernel
    // versions — and a person looking at a file listing can act on none of it. `shares.service.ts`
    // refuses to pass the same text through for exactly this reason; the controller logs the field
    // beside the correlation id so the detail is one grep away rather than in an HTTP body.
    super('the filesystem does not have this entry where the database says it is');
    this.name = 'EntryMissingOnDiskError';
  }
}

/**
 * The move needs a directory that DEPSIS has never created.
 *
 * Not a corruption and not the caller's mistake. `createFolder` writes a row and stops, because
 * the agent's operation set has no `mkdir` and §2.2 keeps that set closed to anything the API can
 * decide on its own. So folders are records, files live flat at the share root, and the three
 * moves that touch a folder — a file in, a file out, a folder anywhere — all fail inside the
 * agent's `open_dir`. Reported as its own state so the 409 can say what is actually missing
 * instead of accusing the database of being wrong about a file it is right about.
 */
export class FolderNotOnDiskError extends Error {
  constructor(readonly agentReason: string) {
    super(
      'this folder exists as a record but not yet as a directory on disk, so an entry cannot be ' +
        'moved into or out of it',
    );
    this.name = 'FolderNotOnDiskError';
  }
}

/**
 * A directory the agent refused to remove because it still has entries in it.
 *
 * Reachable only when the disk holds something the database does not know about — a file written
 * over SMB, most likely — because the permanent delete walks the tree it stores from the leaves
 * up. Reported rather than forced: the alternative is a recursive delete in the agent, and §2.2
 * exists to keep that operation from existing at all.
 */
export class DirectoryNotEmptyError extends Error {
  constructor(readonly agentReason: string) {
    // Same as `EntryMissingOnDiskError` above: the reason travels on the field, not in the body.
    super('the folder still has entries the database does not know about');
    this.name = 'DirectoryNotEmptyError';
  }
}

/**
 * A restore that would produce an entry nothing can reach.
 *
 * The trash is a column, not a folder (0008), so restoring a child clears only that child's
 * `trashed_at`. Its parent stays trashed, and every listing filters on the PARENT's id — so the
 * restored row appears in no folder listing and in no trash listing either. It exists, it is
 * reachable by id, and no screen in the product can show it. Refusing beats manufacturing that.
 */
export class TrashedParentError extends Error {
  constructor(readonly parentName: string) {
    super(`'${parentName}' is still in the trash; restore it first`);
    this.name = 'TrashedParentError';
  }
}

/** A page of file entries, ordered by whatever the query that produced it decided. */
export interface FileEntryPage {
  items: FileEntryRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The columns every list query selects, as one string.
 *
 * Written once because the four listing queries have to agree: a column that appears in one and
 * not another produces a `FileEntryRow` with an undefined field, which TypeScript cannot catch
 * because the row type is asserted rather than inferred from the database.
 */
const ENTRY_COLUMNS = `id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                       trashed_at, created_at, updated_at`;

/**
 * The share this entry lives in, as the caller resolved it from the session.
 *
 * Both halves are needed and neither is optional: the id is what proves the entry belongs to the
 * share the session is working in, and the name is what the agent resolves its root fd from. A
 * call site holding only the name could send a privileged operation against the right share for
 * the wrong entry.
 */
export interface ShareRef {
  id: string;
  name: string;
}

/**
 * Below this many characters a query is matched as a PREFIX rather than as a substring.
 *
 * pg_trgm indexes trigrams, so a one- or two-character pattern has no trigram to look up and
 * `LIKE '%ab%'` degrades to a sequential scan of every name in the share. 0008 anticipated this
 * and shipped a second index — `file_entries_name_norm_prefix`, a B-tree with `text_pattern_ops` —
 * for exactly this branch, and `LIKE 'ab%'` is the shape that can use it.
 */
const TRIGRAM_MIN_LENGTH = 3;

/**
 * Turn "limit + 1 rows" into a page.
 *
 * Every paged query here asks for one row more than the caller wanted, and that spare row is the
 * whole answer to `hasMore` — the contract has no total count, because an unfiltered total beside
 * a filtered list leaks the existence of rows the tenant may not see. The cursor is the last
 * RETURNED row's id, never the spare one's.
 */
function page(rows: FileEntryRow[], limit: number): FileEntryPage {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null, hasMore };
}

/**
 * Recompute `path` for everything under `rootId`, in the caller's transaction.
 *
 * ONE implementation, shared by `move` and `rename`, because they are two spellings of the same
 * user-visible change and a cache the two disagreed about would be worse than no cache. Rebuilt
 * from `parent_id` rather than by splicing a new prefix onto the old strings: same cost, and it
 * REPAIRS a stale descendant instead of carrying it forward — a prefix splice on a row whose cache
 * was already wrong produces a second wrong value that looks freshly computed.
 *
 * The root row itself is excluded because its caller has just written it and holds the returned
 * copy; touching it again here would make that copy stale in the same statement.
 */
async function rebuildSubtreePaths(
  db: TenantQuery,
  organizationId: string,
  rootId: string,
): Promise<void> {
  await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, path
         FROM public.file_entries
        WHERE organization_id = $1 AND id = $2
       UNION ALL
       SELECT child.id, subtree.path || '/' || child.name
         FROM public.file_entries child
         JOIN subtree ON child.parent_id = subtree.id
        WHERE child.organization_id = $1
     )
     UPDATE public.file_entries entry
        SET path = subtree.path
       FROM subtree
      WHERE entry.organization_id = $1
        AND entry.id = subtree.id
        AND entry.id <> $2
        AND entry.path IS DISTINCT FROM subtree.path`,
    [organizationId, rootId],
  );
}

/**
 * The same component rules the agent enforces in `op::SafeComponent`.
 *
 * Checked here as well as there, and not because the agent might forget: a name the database would
 * store and the agent would refuse produces a row describing a file that cannot exist, which is the
 * "two realities" the project forbids. Rejecting at the edge keeps the two stores in step.
 */
const MAX_NAME_BYTES = 255;

export function assertValidName(name: string): void {
  if (name.length === 0) throw new InvalidNameError('a name may not be empty');
  if (name === '.' || name === '..') throw new InvalidNameError(`'${name}' is not a name`);
  if (name.includes('/') || name.includes('\\')) {
    throw new InvalidNameError('a name is one component and may not contain a separator');
  }
  // NUL terminates a C string, so a name containing one is stored whole in PostgreSQL and
  // truncated by every syscall that later receives it — two different names for one file.
  if (name.includes('\0')) throw new InvalidNameError('a name may not contain a NUL');
  if (name.startsWith('-')) {
    throw new InvalidNameError('a name may not begin with a dash, which reads as a flag');
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new InvalidNameError(`a name may not exceed ${MAX_NAME_BYTES} bytes`);
  }
  // `.depsis` is the staging and quarantine tree. A user-visible entry with that name would put
  // half-written uploads and quarantined content into listings and search results.
  if (name === '.depsis') throw new InvalidNameError("'.depsis' is reserved");
}

/**
 * Everything the file tree does, apart from moving bytes.
 *
 * Bytes are the agent's business (`UploadsController` drives that); this class owns the metadata
 * and the one invariant that ties them together — a row exists only for a file the agent has
 * actually published.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
  ) {}

  /**
   * The organisation's default share, created on first use.
   *
   * A deliberate stopgap with a visible name, not a design. DEPSIS is multi-share by intent and
   * there is no share administration surface yet; without something here a freshly claimed box has
   * nowhere at all to put a file, so every file endpoint would 404 on a correctly configured
   * appliance. When share administration lands, this becomes the seed of the first share rather
   * than a hidden special case — which is why it is an ordinary row with an ordinary name.
   */
  async defaultShare(organizationId: string, slug: string): Promise<ShareRow> {
    return this.db.withTenant(organizationId, async (db) => {
      const existing = await db.query<ShareRow>(
        `SELECT id, name, dataset, read_only FROM public.shares
          WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
        [organizationId],
      );
      if (existing[0]) return existing[0];

      // The share name has to satisfy the agent's component rules, and an organisation slug is
      // already constrained to `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` — a superset-safe source.
      const name = slug;
      const created = await db.query<ShareRow>(
        `INSERT INTO public.shares (organization_id, name, dataset)
         VALUES ($1, $2, $3)
         RETURNING id, name, dataset, read_only`,
        [organizationId, name, name],
      );
      const share = created[0];
      if (!share) throw new Error('the default share was not created');
      this.logger.log(`created the default share '${name}' for ${organizationId}`);
      return share;
    });
  }

  /**
   * The share this caller's tenant works in, resolved from the session's organisation alone.
   *
   * Lives here rather than in a controller because two controllers now need it — the tree and
   * search — and a second copy of "which share am I in" is the kind of duplication that survives
   * long enough to disagree with itself once share administration lands.
   */
  async shareOf(organizationId: string): Promise<ShareRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ slug: string }>(`SELECT slug FROM public.organizations WHERE id = $1`, [
        organizationId,
      ]),
    );
    const slug = rows[0]?.slug;
    // An organisation the session names and RLS cannot see is not a fault to report in detail:
    // the same 404 the rest of this file gives for a row belonging to somebody else.
    if (slug === undefined) throw new EntryNotFoundError();
    return this.defaultShare(organizationId, slug);
  }

  /** One page of a folder's contents. Cursor pagination, because offset silently skips rows. */
  async list(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<FileEntryPage> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT ${ENTRY_COLUMNS}
           FROM public.file_entries
          WHERE organization_id = $1
            AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND trashed_at IS NULL
            AND ($4::text IS NULL OR (kind, name_fold) > (SELECT kind, name_fold
                                                            FROM public.file_entries
                                                           WHERE id = $4::uuid))
          ORDER BY kind, name_fold
          LIMIT $5`,
        [organizationId, shareId, parentId, cursor, limit + 1],
      ),
    );

    return page(rows, limit);
  }

  async find(organizationId: string, id: string): Promise<FileEntryRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT ${ENTRY_COLUMNS}
           FROM public.file_entries
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new EntryNotFoundError();
    return row;
  }

  /**
   * Create a folder — in the database and on disk, in that order.
   *
   * The database first, because its unique index is the only thing that can arbitrate two
   * simultaneous requests for the same name; the filesystem's own `mkdir` would let both proceed
   * with one silently winning. If the agent then refuses, the row is removed rather than left
   * behind: a folder that appears in a listing and does not exist is worse than a failed request.
   *
   * The agent has no `mkdir` operation yet, so the second half is not done and the row is created
   * alone. That is recorded here rather than in a comment claiming otherwise — see `MISSING` below.
   */
  async createFolder(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
  ): Promise<FileEntryRow> {
    assertValidName(name);
    let parentPath = '';
    if (parentId !== null) {
      const parent = await this.find(organizationId, parentId);
      if (parent.kind !== 'folder') throw new InvalidNameError('the parent is not a folder');
      // A trashed folder reads as absent rather than as a rejected parent: telling the caller the
      // folder exists but is in the bin is a distinction it cannot act on and did not earn.
      if (parent.trashed_at !== null) throw new EntryNotFoundError();
      parentPath = parent.path;
    }

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `INSERT INTO public.file_entries
             (organization_id, share_id, parent_id, kind, name, path)
           VALUES ($1, $2, $3, 'folder', $4, $5)
           RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, shareId, parentId, name, `${parentPath}/${name}`],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the folder row was not returned');
      return row;
    } catch (error) {
      throw this.asNameConflict(error, name);
    }
  }

  /** Record a file the agent has already published. */
  async recordPublishedFile(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
    sizeBytes: number,
    contentType: string | null,
  ): Promise<FileEntryRow> {
    const parentPath = parentId === null ? '' : (await this.find(organizationId, parentId)).path;
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `INSERT INTO public.file_entries
             (organization_id, share_id, parent_id, kind, name, path, size_bytes, content_type)
           VALUES ($1, $2, $3, 'file', $4, $5, $6, $7)
           RETURNING ${ENTRY_COLUMNS}`,
          [
            organizationId,
            shareId,
            parentId,
            name,
            `${parentPath}/${name}`,
            sizeBytes,
            contentType,
          ],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the file row was not returned');
      return row;
    } catch (error) {
      throw this.asNameConflict(error, name);
    }
  }

  /**
   * Change an entry's name, keeping the bytes and the row in step.
   *
   * A FILE's rename is delegated to `move` — same parent, new name — and that is not tidiness, it
   * is the fix for a divergence this method used to create on its own. It changed `name` and
   * `path` and never told the agent, so the row said `b.txt` while the disk still held `a.txt`.
   * Nothing noticed until the file was permanently deleted: `purge` asked the agent to remove
   * `b.txt`, the agent answered `not_found`, the row went, and `a.txt` stayed on disk — readable
   * over SMB, counting against the dataset's refquota, and unreachable through DEPSIS forever.
   * The user had been told it was permanently deleted. One rename through the agent and one
   * rename around it must not both be spellings of the same request.
   *
   * A FOLDER keeps the database-only rename, because a folder has no directory on disk to move:
   * `createFolder` cannot make one, the agent has no `mkdir`, and asking it to rename something
   * that was never created would fail every folder rename in the product. This is folders-only
   * for exactly as long as that is true, and the day a directory-creating operation lands, this
   * branch goes with it.
   */
  async rename(
    organizationId: string,
    id: string,
    name: string,
    share: ShareRef,
    correlationId: string,
    reason: string,
  ): Promise<FileEntryRow> {
    assertValidName(name);
    const entry = await this.find(organizationId, id);
    if (entry.trashed_at !== null) throw new EntryNotFoundError();

    if (entry.kind === 'file') {
      return this.move(
        organizationId,
        id,
        share,
        { parentId: entry.parent_id, name },
        correlationId,
        reason,
      );
    }

    const parentPath = entry.path.slice(0, entry.path.lastIndexOf('/'));
    try {
      return await this.db.withTenant(organizationId, async (db) => {
        const rows = await db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET name = $3, path = $4
            WHERE organization_id = $1 AND id = $2
            RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, id, name, `${parentPath}/${name}`],
        );
        const row = rows[0];
        if (!row) throw new EntryNotFoundError();
        // The same rebuild `move` does, in the same transaction as the row it follows from. Left
        // out, a renamed folder's children kept a `path` naming the old folder — harmless only
        // because ADR-0005 makes nothing authorise on `path`, and harmless is not a property to
        // rest a cache on when the two routes to a rename would then disagree about it.
        await rebuildSubtreePaths(db, organizationId, id);
        return row;
      });
    } catch (error) {
      throw this.asNameConflict(error, name);
    }
  }

  /**
   * Move an entry into another folder — ON DISK FIRST, in the database SECOND.
   *
   * The order is the whole design and it is not reversible. If the row moved first and the agent
   * then refused, the row would name a place the bytes are not: every download would resolve
   * `componentsOf` to the new path, find nothing, and answer 404, while an SMB client kept showing
   * the file in the old folder. That is the two-realities split this product does not accept, and
   * it is unrecoverable without a reconciliation pass that does not exist yet. The other order
   * fails safely: a successful rename followed by a failed `UPDATE` is a file the database still
   * describes correctly enough to find, and the compensating move below closes even that.
   *
   * A rename is expressible here too — `name` alongside `parentId` — because on the filesystem the
   * two are one `renameat2`. Splitting them into two agent calls would put a window between them in
   * which the entry sits in the destination under its old name.
   */
  async move(
    organizationId: string,
    id: string,
    share: ShareRef,
    target: { parentId: string | null; name?: string | undefined },
    correlationId: string,
    reason: string,
  ): Promise<FileEntryRow> {
    const entry = await this.find(organizationId, id);
    // A trashed entry has no place in the tree to move within, and the same 404 a rename gives is
    // the honest answer: as far as every listing is concerned it is not there.
    if (entry.trashed_at !== null || entry.share_id !== share.id) throw new EntryNotFoundError();

    const name = target.name ?? entry.name;
    assertValidName(name);

    let parentPath = '';
    if (target.parentId !== null) {
      const parent = await this.find(organizationId, target.parentId);
      if (parent.trashed_at !== null) throw new EntryNotFoundError();
      if (parent.share_id !== entry.share_id) throw new CrossShareMoveError();
      if (parent.kind !== 'folder') throw new InvalidNameError('the destination is not a folder');
      // Only a folder can contain itself, and only a folder has descendants to be swallowed by
      // the cycle — a file's move is always acyclic.
      if (
        entry.kind === 'folder' &&
        (await this.isSelfOrDescendant(organizationId, parent.id, id))
      ) {
        throw new MoveIntoDescendantError(entry.name);
      }
      parentPath = parent.path;
    }

    if (entry.parent_id === target.parentId && name === entry.name) return entry;

    // Asked of the database BEFORE the agent, even though the agent's `RENAME_NOREPLACE` refuses a
    // taken destination anyway. Two reasons: a folder has no directory on disk yet (see
    // `createFolder`), so the kernel's refusal cannot see a folder collision at all; and a row
    // whose bytes are missing would let the rename succeed and the `UPDATE` then fail on the
    // unique index — the one ordering that leaves the file moved and the row behind.
    await this.requireNameFree(organizationId, entry.share_id, target.parentId, name, id);

    const from = await this.componentsOf(organizationId, id);
    const to =
      target.parentId === null
        ? [name]
        : [...(await this.componentsOf(organizationId, target.parentId)), name];

    await this.moveOnDisk(share.name, from, to, name, correlationId, reason).catch(
      (error: unknown) => {
        // `EntryMissingOnDiskError` says "the two stores disagree", which is the right thing to say
        // when they do and a slander on the database when they do not. A folder is a row with no
        // directory behind it (see `createFolder`), so the moment either end of this move runs
        // through one, `open_dir` inside the agent's `publish` fails with ENOENT and the answer
        // comes back `not_found` — not because anything is corrupt, but because the destination
        // was never created. Whoever reads the first message goes looking for a broken database;
        // whoever reads this one learns the feature is waiting on an agent operation.
        //
        // Three ways a folder gets into it: the entry being moved is one (nothing to rename), the
        // source sits inside one, or the destination is one. The last two are what the component
        // counts test — a path of length 1 is at the share root, where files actually live.
        const touchesAFolder = entry.kind === 'folder' || from.length > 1 || to.length > 1;
        if (error instanceof EntryMissingOnDiskError && touchesAFolder) {
          throw new FolderNotOnDiskError(error.agentReason);
        }
        throw error;
      },
    );

    const newPath = `${parentPath}/${name}`;
    try {
      return await this.db.withTenant(organizationId, async (db) => {
        const rows = await db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET parent_id = $3, name = $4, path = $5
            WHERE organization_id = $1 AND id = $2
            RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, id, target.parentId, name, newPath],
        );
        const row = rows[0];
        if (!row) throw new EntryNotFoundError();

        await rebuildSubtreePaths(db, organizationId, id);
        return row;
      });
    } catch (error) {
      // The file is at its new name and the row is not. Put it back, because the alternative is
      // exactly the divergence the ordering above exists to prevent — and this is the one window
      // in which it can still be closed from here.
      await this.moveOnDisk(
        share.name,
        to,
        from,
        entry.name,
        correlationId,
        `undo: ${reason}`,
      ).catch((undoError: unknown) => {
        this.logger.error(
          `moved ${share.name}/${from.join('/')} to ${to.join('/')} on disk, then failed to ` +
            `record it, and could not move it back: ${messageOf(undoError)}. The database still ` +
            `describes the OLD location; the file is at the new one.`,
        );
      });
      throw this.asNameConflict(error, name);
    }
  }

  /**
   * Delete an entry and everything under it, permanently: from the leaves up.
   *
   * One `RemoveEntry` per node, deepest first, and the row goes only after the agent says its
   * entry is gone. The agent has no recursive delete and will not get one (ADR-0006, §2.2): an
   * operation whose blast radius the caller chooses is `rm -rf` behind a typed name, and the API
   * is the side that knows the tree because the API is the side that stores it.
   *
   * NOT atomic, and it cannot be — there is no transaction spanning a filesystem and a database.
   * Each node is committed as it is removed, so an interruption leaves the removed ones removed
   * and the rest still in the trash, and calling again continues from there. That is what the
   * contract promises, and it is also why an agent answer of `not_found` counts as success below:
   * a retry after a crash between the unlink and the `DELETE` must not deadlock on the row it is
   * there to clean up.
   *
   * The whole subtree goes, including children whose own `trashed_at` is null. Trashing a folder
   * sets one flag on one row, so its children are unreachable rather than trashed — and
   * `parent_id`'s `ON DELETE RESTRICT` would refuse to leave them behind in any case.
   */
  async purge(
    organizationId: string,
    id: string,
    share: ShareRef,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const entry = await this.find(organizationId, id);
    if (entry.share_id !== share.id) throw new EntryNotFoundError();
    // 409 rather than a silent deletion. The trash is the click between a user and permanent data
    // loss; an endpoint that skipped it on request would make the trash optional, which is the
    // same as not having one.
    if (entry.trashed_at === null) throw new NotTrashedError(entry.name);

    const root = await this.componentsOf(organizationId, id);
    const nodes = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; kind: 'file' | 'folder'; parts: string[] }>(
        `WITH RECURSIVE tree AS (
           SELECT id, kind, 0 AS depth, $3::text[] AS parts
             FROM public.file_entries
            WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT child.id, child.kind, tree.depth + 1, tree.parts || child.name
             FROM public.file_entries child
             JOIN tree ON child.parent_id = tree.id
            WHERE child.organization_id = $1
         )
         SELECT id, kind, parts FROM tree ORDER BY depth DESC, id`,
        [organizationId, id, root],
      ),
    );

    for (const node of nodes) {
      const response = await this.agent.call(
        {
          op: 'remove_entry',
          share: share.name,
          path: node.parts,
          directory: node.kind === 'folder',
        },
        reason,
        correlationId,
      );
      if (response.status === 'conflict') throw new DirectoryNotEmptyError(response.reason);
      // `not_found` beside `removed`, and it is the line that makes a retry work: an entry that is
      // already gone is the end state this call exists to produce, so the row goes too. Refusing
      // here instead would leave a crash between the unlink and the DELETE as a row nothing can
      // ever clean up.
      if (response.status !== 'removed' && response.status !== 'not_found') {
        expectStatus(response, 'removed');
      }
      if (response.status === 'not_found' && node.kind === 'file') {
        // The one direction this endpoint can be wrong in that nobody would ever find out about.
        // A folder has no directory on disk (see `createFolder`), so `not_found` for one is the
        // expected answer; a FILE the agent cannot find means either a retry after a crash — the
        // case the acceptance above exists for — or bytes sitting somewhere the database does not
        // name, which this call is about to make unreachable by deleting the only row that knew
        // about them. They stay readable over SMB and keep counting against the dataset's
        // refquota. It is still accepted, because refusing would make a crashed purge permanently
        // unretryable, but it is written down with enough to find the file by hand.
        this.logger.error(
          `permanently deleting ${share.name}/${node.parts.join('/')}: the agent reports no such ` +
            `entry (${response.reason}). If this is not a retry of an interrupted delete, the ` +
            'bytes are still on disk with no row left to reach them.',
        );
      }

      // One transaction per node, deliberately. A single transaction around the loop would roll
      // the rows back while leaving every unlink done — the database would then describe files
      // that no longer exist, which is the divergence this endpoint is most able to cause.
      await this.db.withTenant(organizationId, async (db) => {
        // BEFORE the entry, in the same transaction, because `upload_sessions` references
        // `file_entries` twice and both references block this delete rather than following it:
        // `parent_id` is ON DELETE RESTRICT, and `file_id` is ON DELETE SET NULL guarded by
        // `upload_sessions_completion_pair`, which refuses a null `file_id` beside a non-null
        // `completed_at`. So every file that arrived through tus, and every folder that was ever
        // named as an upload target, was unpurgeable — the agent unlinked the bytes and then the
        // DELETE failed on the constraint, leaving a row in the trash that no retry could ever
        // clear and whose data was already gone.
        //
        // Deleted rather than detached because there is no third option without a migration, and
        // because a session is a record of a transfer INTO a file: once the file is permanently
        // gone the session describes nothing. It disappears from the transfer list, which is the
        // same thing the user asked for when they emptied the trash.
        await db.query(
          `DELETE FROM public.upload_sessions
            WHERE organization_id = $1 AND (parent_id = $2 OR file_id = $2)`,
          [organizationId, node.id],
        );
        await db.query(`DELETE FROM public.file_entries WHERE organization_id = $1 AND id = $2`, [
          organizationId,
          node.id,
        ]);
      });
    }
  }

  /** Is the privileged agent reachable? Endpoints that need it answer 503 when it is not. */
  agentAvailable(): boolean {
    return this.agent.isAvailable();
  }

  /**
   * Ask the agent to rename one entry, and turn its answer into this file's errors.
   *
   * `moved`, `not_found` and `conflict` are all ORDINARY answers on this wire — the agent reports
   * them as outcomes, not faults — so each is mapped here rather than left to `expectStatus`,
   * which would collapse the last two into a single unhelpful refusal.
   */
  private async moveOnDisk(
    share: string,
    from: string[],
    to: string[],
    name: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const response = await this.agent.call(
      { op: 'move_entry', share, from, to },
      reason,
      correlationId,
    );
    switch (response.status) {
      case 'moved':
        return;
      case 'not_found':
        throw new EntryMissingOnDiskError(response.reason);
      // `RENAME_NOREPLACE` refused: something is already at the destination and the source has not
      // moved. The name is what the user has to change, which is what `NameTakenError` says.
      case 'conflict':
        throw new NameTakenError(name);
      default:
        expectStatus(response, 'moved');
    }
  }

  /**
   * Is `candidateId` the folder itself, or somewhere underneath it?
   *
   * Walked UP from the candidate rather than down from the folder: an upward walk visits one row
   * per level and stops at the share root, while a downward one visits the whole subtree to prove
   * a negative.
   */
  private async isSelfOrDescendant(
    organizationId: string,
    candidateId: string,
    folderId: string,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ hit: number }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id
             FROM public.file_entries
            WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT parent.id, parent.parent_id
             FROM public.file_entries parent
             JOIN up ON parent.id = up.parent_id
            WHERE parent.organization_id = $1
         )
         SELECT 1 AS hit FROM up WHERE id = $3 LIMIT 1`,
        [organizationId, candidateId, folderId],
      ),
    );
    return rows.length > 0;
  }

  /** The destination sibling set, checked for the name before anything privileged happens. */
  private async requireNameFree(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
    exceptId: string,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        // `name_fold`, not `name`: uniqueness is case- and Turkish-i-folded, so a check on the raw
        // name would pass here and then hit the unique index after the file had already moved.
        `SELECT id FROM public.file_entries
          WHERE organization_id = $1
            AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND name_fold = public.fold_identity($4)
            AND trashed_at IS NULL
            AND id <> $5
          LIMIT 1`,
        [organizationId, shareId, parentId, name, exceptId],
      ),
    );
    if (rows.length > 0) throw new NameTakenError(name);
  }

  /**
   * Move to the trash.
   *
   * A flag on the row, not a move to another table: a second table would mean a new id on the way
   * back, and the id is what tasks, shares and audit entries point at. The bytes are not touched —
   * emptying the trash is what asks the agent to unlink, and that is a separate decision a user
   * has to make.
   */
  async trash(organizationId: string, id: string, userId: string): Promise<FileEntryRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `UPDATE public.file_entries
            SET trashed_at = now(), trashed_by = $3
          WHERE organization_id = $1 AND id = $2 AND trashed_at IS NULL
          RETURNING id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                    trashed_at, created_at, updated_at`,
        [organizationId, id, userId],
      ),
    );
    const row = rows[0];
    if (!row) throw new EntryNotFoundError();
    return row;
  }

  /**
   * Take it back out of the trash.
   *
   * Can fail with a name conflict, and that is correct rather than unfortunate: the partial unique
   * index deliberately excludes trashed rows so the name is free again the moment something is
   * deleted. If somebody has since taken it, restoring silently under a suffixed name would hide
   * which file is which.
   *
   * Restoring something already out of the trash is a no-op rather than an error, so a client that
   * retries a request whose response it never saw gets the same answer the first attempt gave.
   */
  async restore(organizationId: string, id: string): Promise<FileEntryRow> {
    const entry = await this.find(organizationId, id);
    if (entry.trashed_at === null) return entry;

    // The parent has to be out of the trash first — see `TrashedParentError`. Checked before the
    // UPDATE and not after, because the alternative is restoring the row and then rolling back a
    // change the caller may already have been told about.
    if (entry.parent_id !== null) {
      const parent = await this.find(organizationId, entry.parent_id);
      if (parent.trashed_at !== null) throw new TrashedParentError(parent.name);
    }

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET trashed_at = NULL, trashed_by = NULL
            WHERE organization_id = $1 AND id = $2
            RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, id],
        ),
      );
      const row = rows[0];
      if (!row) throw new EntryNotFoundError();
      return row;
    } catch (error) {
      throw this.asNameConflict(error, entry.name);
    }
  }

  /**
   * The trash, most recently discarded first, one page at a time.
   *
   * Flat and not a tree, because the trash is a column rather than a folder: trashing a directory
   * sets the flag on that one row and leaves its children pointing at a parent that is no longer
   * in any listing. Nesting the view would therefore show the children twice or not at all
   * depending on which row the user happened to delete, so it shows every trashed row at one level.
   *
   * The keyset is `(trashed_at, id)` and not `trashed_at` alone. Emptying a folder trashes many
   * rows inside one statement, and `now()` is fixed for a whole transaction — so a page boundary
   * that lands in the middle of such a batch would, with a `trashed_at`-only cursor, either repeat
   * the whole batch or skip the rest of it. The id breaks the tie and is unique by definition.
   */
  async listTrash(
    organizationId: string,
    shareId: string,
    cursor: string | null,
    limit: number,
  ): Promise<FileEntryPage> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT ${ENTRY_COLUMNS}
           FROM public.file_entries
          WHERE organization_id = $1
            AND share_id = $2
            AND trashed_at IS NOT NULL
            AND ($3::uuid IS NULL
                 OR (trashed_at, id) < (SELECT trashed_at, id
                                          FROM public.file_entries
                                         WHERE id = $3::uuid))
          ORDER BY trashed_at DESC, id DESC
          LIMIT $4`,
        [organizationId, shareId, cursor, limit + 1],
      ),
    );

    return page(rows, limit);
  }

  /**
   * Name search across the caller's share.
   *
   * Both sides go through `depsis_norm`. Normalising only the stored side is the bug ADR-0010 was
   * written against: `name_norm` holds `istanbul` for a file called `İstanbul`, so a user who types
   * the file's own name back gets nothing. The function is the same one the generated column uses,
   * which is what makes the two comparable at all.
   *
   * Ordering is prefix-first and similarity-second, and the pair is deliberate. Trigram similarity
   * alone ranks a short name containing the query above a long name STARTING with it, so typing
   * `rapor` puts `x-rapor-y.txt` above `Rapor 2026 Q1.pdf` — the opposite of what someone who is
   * navigating rather than exploring wants. Prefix is the strong signal; similarity only breaks
   * the ties inside each of the two groups.
   *
   * Matching itself is a plain substring, not the `%` similarity operator. `%` is governed by
   * `pg_trgm.similarity_threshold`, a session GUC nothing in this codebase sets, so the set of
   * results would depend on a value an operator can change out from under the API. A substring the
   * user typed is a result the user can explain.
   */
  async search(
    organizationId: string,
    shareId: string,
    scopeId: string | null,
    query: string,
    cursor: string | null,
    limit: number,
  ): Promise<FileEntryPage> {
    // `%` and `_` are LIKE wildcards, and a user typing either into a search box means the
    // character, not "match anything". Escaped here rather than stripped, so searching for a file
    // whose name genuinely contains one still finds it. The backslash is LIKE's default escape.
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
    const pattern =
      query.length < TRIGRAM_MIN_LENGTH
        ? `public.depsis_norm($7::text) || '%'`
        : `'%' || public.depsis_norm($7::text) || '%'`;

    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        // The ranking keys are stored NEGATED — `NOT is_prefix`, `-similarity` — so that all four
        // sort ascending. That is what lets the cursor be a single row-value comparison; with
        // mixed directions the keyset predicate has to be expanded into nested ORs, which is the
        // form that quietly drops or repeats rows when somebody edits it later.
        `WITH RECURSIVE scope_tree AS (
           SELECT id
             FROM public.file_entries
            WHERE organization_id = $1 AND parent_id = $4::uuid
           UNION ALL
           SELECT child.id
             FROM public.file_entries child
             JOIN scope_tree ON child.parent_id = scope_tree.id
            WHERE child.organization_id = $1
         ),
         matched AS (
           SELECT ${ENTRY_COLUMNS}, name_fold,
                  NOT (name_norm LIKE public.depsis_norm($7::text) || '%') AS rank_prefix,
                  -public.similarity(name_norm, public.depsis_norm($3::text)) AS rank_score
             FROM public.file_entries
            WHERE organization_id = $1
              AND share_id = $2
              AND trashed_at IS NULL
              AND ($4::uuid IS NULL OR id IN (SELECT id FROM scope_tree))
              AND name_norm LIKE ${pattern}
         )
         SELECT ${ENTRY_COLUMNS}
           FROM matched
          WHERE ($5::uuid IS NULL
                 OR (rank_prefix, rank_score, name_fold, id)
                    > (SELECT rank_prefix, rank_score, name_fold, id
                         FROM matched WHERE id = $5::uuid))
          ORDER BY rank_prefix, rank_score, name_fold, id
          LIMIT $6`,
        [organizationId, shareId, query, scopeId, cursor, limit + 1, escaped],
      ),
    );

    return page(rows, limit);
  }

  /**
   * Turn PostgreSQL's unique violation into something the HTTP layer can answer 409 with.
   *
   * Matching on SQLSTATE `23505` rather than on the message: the message contains the index name
   * and is localised by the server's `lc_messages`, so a box installed in Turkish would stop
   * producing 409s and start producing 500s.
   */
  private asNameConflict(error: unknown, name: string): Error {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if ((error as { code?: string }).code === '23505') return new NameTakenError(name);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * The entry's location inside its share, as validated components.
   *
   * Walked up `parent_id` rather than split out of the `path` column, and the difference is not
   * cosmetic. ADR-0005 makes `parent_id` the authority and `path` a derived cache that a rename
   * updates afterwards — for a large subtree, in a job. Splitting the cache would mean that during
   * that job a download resolves to where the file USED to be: a 404 at best, and at worst a read
   * of whatever now occupies the old name.
   *
   * One recursive query rather than a loop of them, so the answer is a single consistent snapshot.
   */
  async componentsOf(organizationId: string, id: string): Promise<string[]> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ name: string; depth: number }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id, name, 0 AS depth
             FROM public.file_entries
            WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.name, up.depth + 1
             FROM public.file_entries parent
             JOIN up ON parent.id = up.parent_id
            WHERE parent.organization_id = $1
         )
         SELECT name, depth FROM up ORDER BY depth DESC`,
        [organizationId, id],
      ),
    );
    if (rows.length === 0) throw new EntryNotFoundError();
    return rows.map((r) => r.name);
  }

  /**
   * Open a published file for reading and get a one-time token for the data socket.
   *
   * `size` comes back from the agent's own descriptor. The caller should prefer it over the
   * `size_bytes` column when validating a Range: the column is what DEPSIS last recorded, and a
   * file changed over SMB is precisely the case where the two differ.
   */
  async openDownload(
    share: string,
    components: string[],
    correlationId: string,
    reason: string,
  ): Promise<{ token: string; size: number }> {
    const response = await this.agent.call(
      { op: 'open_download', share, path: components },
      reason,
      correlationId,
    );
    const opened = expectStatus(response, 'download');
    return { token: opened.token, size: opened.size };
  }

  /** Ask the agent to publish a staged file into the tree. */
  async publish(
    share: string,
    stagingName: string,
    destination: string[],
    expectedBytes: number,
    ownerUid: number,
    ownerGid: number,
    correlationId: string,
    reason: string,
  ): Promise<number> {
    const response = await this.agent.call(
      {
        op: 'publish_transfer',
        share,
        staging_name: stagingName,
        destination,
        expected_bytes: expectedBytes,
        owner_uid: ownerUid,
        owner_gid: ownerGid,
      },
      reason,
      correlationId,
    );
    return expectStatus(response, 'publish').bytes;
  }
}

/** An unknown thrown value, as something a log line can carry. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
