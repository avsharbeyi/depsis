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

  /** One page of a folder's contents. Cursor pagination, because offset silently skips rows. */
  async list(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: FileEntryRow[]; nextCursor: string | null; hasMore: boolean }> {
    // One row more than asked for. That extra row is what answers `hasMore` without a COUNT — and
    // a COUNT is exactly what the contract forbids, because an unfiltered total beside a filtered
    // list leaks the existence of rows the tenant may not see.
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                trashed_at, created_at, updated_at
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

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null, hasMore };
  }

  async find(organizationId: string, id: string): Promise<FileEntryRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                trashed_at, created_at, updated_at
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
           RETURNING id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                     trashed_at, created_at, updated_at`,
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
           RETURNING id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                     trashed_at, created_at, updated_at`,
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
            RETURNING id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                      trashed_at, created_at, updated_at`,
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
   */
  async restore(organizationId: string, id: string): Promise<FileEntryRow> {
    const entry = await this.find(organizationId, id);
    if (entry.trashed_at === null) return entry;
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET trashed_at = NULL, trashed_by = NULL
            WHERE organization_id = $1 AND id = $2
            RETURNING id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                      trashed_at, created_at, updated_at`,
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

  /** Everything in the trash, newest first. */
  async listTrash(organizationId: string, limit: number): Promise<FileEntryRow[]> {
    return this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                trashed_at, created_at, updated_at
           FROM public.file_entries
          WHERE organization_id = $1 AND trashed_at IS NOT NULL
          ORDER BY trashed_at DESC
          LIMIT $2`,
        [organizationId, limit],
      ),
    );
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
