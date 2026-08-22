import { Injectable, Logger } from '@nestjs/common';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';

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

  async rename(organizationId: string, id: string, name: string): Promise<FileEntryRow> {
    assertValidName(name);
    const entry = await this.find(organizationId, id);
    if (entry.trashed_at !== null) throw new EntryNotFoundError();

    const parentPath = entry.path.slice(0, entry.path.lastIndexOf('/'));
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET name = $3, path = $4
            WHERE organization_id = $1 AND id = $2
            RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, id, name, `${parentPath}/${name}`],
        ),
      );
      const row = rows[0];
      if (!row) throw new EntryNotFoundError();
      return row;
    } catch (error) {
      throw this.asNameConflict(error, name);
    }
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
