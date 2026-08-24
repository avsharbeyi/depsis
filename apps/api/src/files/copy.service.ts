import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { FilesService, type ShareRef } from './files.service.js';

/** What one `files.copy` job was asked to do. */
export interface CopyPayload {
  shareId: string;
  sourceIds: string[];
  destinationId: string | null;
  /**
   * Who asked. NOT a uid pair.
   *
   * `FilesService.createFolder` takes an actor and resolves the uid itself, allocating one on
   * first need; carrying numbers here would be a second answer to "who owns this" written at
   * enqueue time and used minutes later. The copy is owned by the person who asked for it and not
   * by whoever owned the source — a copy that arrived owned by somebody else is a file its maker
   * cannot delete.
   */
  actorId: string;
  /** Where the walk left off, for a job that queued its own continuation. */
  doneIds?: string[];
}

/** What one chunk accomplished. */
export interface CopyProgress {
  copied: number;
  skipped: number;
  total: number;
  /** Present when there is more to do — the payload for the successor job. */
  next: CopyPayload | null;
}

interface Node {
  id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  size_bytes: string;
  content_type: string | null;
}

/**
 * `POST /file-operations`, the copy half.
 *
 * WHY THE WALK IS HERE AND NOT IN THE WORKER. The same argument `worker-surface.ts` makes for
 * `AclApplyService`: the tree lives in `file_entries` and the rules for reading it — what a folder
 * contains, what a name may be, what a conflict is — are written once, in the API package, and the
 * worker imports them. A second walk in the worker would be a second answer to "what is in this
 * folder", and the two would drift with neither looking wrong on its own.
 *
 * ONE `CopyFile` PER FILE AND ONE `CreateDirectory` PER FOLDER. The agent has no recursive copy and
 * must not get one (§2.2, ADR-0006: no single call may have a blast radius the caller chooses). The
 * loop is here, which is also what makes progress reportable — a user watching a thousand-file copy
 * sees it advance because this is the thing that advances.
 *
 * CHUNKED, like `AclApplyService`. Each file is a round trip to a daemon that serves the whole
 * appliance one connection at a time, so a single job copying a hundred thousand files would hold
 * the agent for hours and starve every upload behind it. Between chunks the worker returns to
 * `claim_job` and other work interleaves.
 *
 * AT-LEAST-ONCE, which the queue requires (§17). A redelivered chunk re-copies files it already
 * copied; the agent answers `conflict` because `RENAME_NOREPLACE` refuses to overwrite, and this
 * treats that as "already done" rather than as a failure — after checking that a row exists for it,
 * which is what recovers the one window the design cannot close: a worker that died between the
 * filesystem copy and the database row.
 */
@Injectable()
export class CopyService {
  /**
   * Files per job.
   *
   * Small, because each one is an agent round trip and the point of chunking is that the agent
   * comes back to other work. `AclApplyService` uses a thousand for a call that is one `setfacl`;
   * a copy moves bytes, so this is two orders of magnitude lower.
   */
  static readonly CHUNK = 25;

  /**
   * The largest tree this will copy.
   *
   * Not a performance bound — a refusal. A copy is one of two operations in the product that can
   * multiply stored bytes without a single upload, and a user who selects the share root should be
   * told the number rather than discovering it as a full dataset an hour later.
   */
  static readonly MAX_ENTRIES = 100_000;

  private readonly logger = new Logger(CopyService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly files: FilesService,
    private readonly posix: PosixIdentityService,
  ) {}

  /**
   * Copy one chunk of the requested tree.
   *
   * Returns the payload for a successor when there is more, exactly as `AclApplyService.apply`
   * does — the worker queues it, so a chunk boundary is a place other jobs can run rather than a
   * loop inside one lease.
   */
  async copy(organizationId: string, payload: CopyPayload, reason: string): Promise<CopyProgress> {
    const share = await this.files.shareFor(organizationId, payload.shareId);
    const ref: ShareRef = { id: share.id, name: share.name };

    // Resolved once per chunk rather than per file: it allocates on first need, and a
    // thousand-file copy should not ask a thousand times.
    const ownerUid = await this.posix.posixUidFor(organizationId, payload.actorId);

    const plan = await this.plan(organizationId, payload);
    const done = new Set(payload.doneIds ?? []);
    const chunk = plan.filter((step) => !done.has(step.node.id)).slice(0, CopyService.CHUNK);

    let copied = 0;
    let skipped = 0;

    for (const step of chunk) {
      const outcome = await this.one(organizationId, ref, step, payload, ownerUid, reason);
      if (outcome === 'copied') copied += 1;
      else skipped += 1;
      done.add(step.node.id);
    }

    const remaining = plan.length - done.size;
    return {
      copied,
      skipped,
      total: plan.length,
      next:
        remaining > 0
          ? // Only the ids that are DONE travel to the successor, not the plan. The plan is
            // re-derived from the database each time, so a folder created by the previous chunk is
            // present when the next one runs — and a source that was deleted mid-copy simply stops
            // being in it, rather than becoming a failure.
            { ...payload, doneIds: [...done] }
          : null,
    };
  }

  /**
   * Everything that has to be created, parents before children.
   *
   * Breadth-first from the sources, so a folder always appears before anything inside it. The
   * order is the whole correctness of the operation: `CreateDirectory` refuses to `mkdir -p`, so a
   * file whose parent has not been made yet comes back `not_found`.
   */
  private async plan(
    organizationId: string,
    payload: CopyPayload,
  ): Promise<Array<{ node: Node; destinationParentId: string | null; depth: number }>> {
    const roots = await this.nodes(organizationId, payload.shareId, payload.sourceIds);
    const steps: Array<{ node: Node; destinationParentId: string | null; depth: number }> = [];

    let frontier = roots.map((node) => ({
      node,
      destinationParentId: payload.destinationId,
      depth: 0,
    }));

    while (frontier.length > 0) {
      steps.push(...frontier);
      if (steps.length > CopyService.MAX_ENTRIES) {
        throw new CopyTooLargeError(CopyService.MAX_ENTRIES);
      }
      const folders = frontier.filter((step) => step.node.kind === 'folder');
      if (folders.length === 0) break;

      const children = await this.childrenOf(
        organizationId,
        folders.map((step) => step.node.id),
      );
      frontier = children.map((child) => ({
        node: child,
        // The destination parent of a child is the SOURCE folder's id, and the mapping from source
        // folder to destination folder is resolved when the child is actually copied — by then the
        // destination folder exists and has a row. Carrying a not-yet-existing id here would mean
        // planning against rows the plan itself has to create.
        destinationParentId: child.parent_id,
        depth: (folders.find((f) => f.node.id === child.parent_id)?.depth ?? 0) + 1,
      }));
    }

    return steps;
  }

  /** One node: a directory to create, or a file to copy. */
  private async one(
    organizationId: string,
    share: ShareRef,
    step: { node: Node; destinationParentId: string | null },
    payload: CopyPayload,
    ownerUid: number,
    reason: string,
  ): Promise<'copied' | 'skipped'> {
    const parentId = await this.destinationParent(organizationId, step, payload);

    // FIRST, and before a name is chosen. The queue is at-least-once, so this chunk may have run
    // before; if it did, the row it wrote names this source and the work is done. Resolving a name
    // first and asking afterwards is what produced a second `a (2).txt` on every redelivery —
    // `keep_both` derives the name from what the destination holds, and the first attempt is
    // exactly what changed that.
    if (step.node.kind === 'file') {
      const already = await this.copyOf(organizationId, parentId, step.node.id);
      if (already !== null) return 'skipped';
    } else {
      const made = await this.folderCopiedFrom(organizationId, payload, step.node.id);
      if (made !== null) {
        this.copiedFolders.set(step.node.id, made);
        return 'skipped';
      }
    }

    const name = await this.freeName(organizationId, share.id, parentId, step.node.name);

    const parentComponents =
      parentId === null ? [] : await this.files.componentsOf(organizationId, parentId);
    const destination = [...parentComponents, name];

    if (step.node.kind === 'folder') {
      await this.files.createFolder(
        organizationId,
        share,
        parentId,
        name,
        payload.actorId,
        randomUUID(),
        reason,
      );
      this.copiedFolders.set(step.node.id, { parentId, name });
      return 'copied';
    }

    const source = await this.files.componentsOf(organizationId, step.node.id);
    const response = await this.agent.call(
      {
        op: 'copy_file',
        share: share.name,
        from: source,
        to: destination,
        staging_name: `${randomUUID()}.copy`,
        owner_uid: ownerUid,
        // The user's own private group, which is their uid. ADR-0004 allocates user uids and team
        // gids from ONE counter precisely so a uid can be used as a group id without colliding.
        owner_gid: ownerUid,
      },
      reason,
    );

    if (response.status === 'conflict') {
      // A redelivered chunk. The bytes are already there under this name; what may be missing is
      // the row, because the worker can die between the two. Recording it here is what recovers a
      // file that would otherwise be on disk, readable over SMB, and invisible to DEPSIS forever.
      const existing = await this.rowAt(organizationId, share.id, parentId, name);
      if (existing === null) {
        await this.files.recordPublishedFile(
          organizationId,
          share.id,
          parentId,
          name,
          Number(step.node.size_bytes),
          step.node.content_type,
          step.node.id,
        );
        this.logger.warn(
          `recovered a copy that reached the filesystem and not the database: ${name}`,
        );
        return 'copied';
      }
      return 'skipped';
    }

    const { bytes } = expectStatus(response, 'copied');
    await this.files.recordPublishedFile(
      organizationId,
      share.id,
      parentId,
      name,
      bytes,
      step.node.content_type,
      step.node.id,
    );
    return 'copied';
  }

  /**
   * Where a node's copy goes.
   *
   * A root's parent is the destination the caller named. A descendant's parent is the copy of ITS
   * parent, which an earlier step in this same plan created — remembered in `copiedFolders` rather
   * than looked up by name, because two folders in one destination can end up with different names
   * after conflict resolution and matching by name would put children under the wrong one.
   */
  private readonly copiedFolders = new Map<string, { parentId: string | null; name: string }>();

  private async destinationParent(
    organizationId: string,
    step: { node: Node; destinationParentId: string | null },
    payload: CopyPayload,
  ): Promise<string | null> {
    const sourceParent = step.destinationParentId;
    if (sourceParent === null || payload.sourceIds.includes(step.node.id)) {
      return payload.destinationId;
    }
    const made = this.copiedFolders.get(sourceParent);
    if (made === undefined) {
      // The parent's copy is not in this process's memory: a continuation job is running the tail
      // of a plan whose head another chunk did. Resolve it from the database instead.
      const resolved = await this.resolveCopiedFolder(organizationId, payload, sourceParent);
      if (resolved === null) {
        throw new Error(`the copy of folder ${sourceParent} could not be found`);
      }
      return resolved;
    }
    const row = await this.rowAt(organizationId, payload.shareId, made.parentId, made.name);
    return row?.id ?? null;
  }

  /** A folder's copy, found by walking the same name chain from the destination. */
  private async resolveCopiedFolder(
    organizationId: string,
    payload: CopyPayload,
    sourceFolderId: string,
  ): Promise<string | null> {
    const sourceComponents = await this.files.componentsOf(organizationId, sourceFolderId);
    const rootComponents = await Promise.all(
      payload.sourceIds.map((id) => this.files.componentsOf(organizationId, id)),
    );
    // The chain BELOW whichever selected root this folder sits under. Copying `a/b/c` into `d`
    // makes `d/b/c`, so the part of the path that survives is everything after the root's parent.
    const root = rootComponents.find(
      (parts) => sourceComponents.slice(0, parts.length).join('/') === parts.join('/'),
    );
    if (root === undefined) return null;
    const tail = sourceComponents.slice(root.length - 1);

    let parentId = payload.destinationId;
    for (const part of tail) {
      const row = await this.rowAt(organizationId, payload.shareId, parentId, part);
      if (row === null) return null;
      parentId = row.id;
    }
    return parentId;
  }

  private async nodes(
    organizationId: string,
    shareId: string,
    ids: readonly string[],
  ): Promise<Node[]> {
    if (ids.length === 0) return [];
    return this.db.withTenant(organizationId, (q) =>
      q.query<Node>(
        `SELECT id::text AS id, parent_id::text AS parent_id, kind, name,
                size_bytes::text AS size_bytes, content_type
           FROM public.file_entries
          WHERE organization_id = $1 AND share_id = $2 AND id = ANY($3::uuid[])
            AND trashed_at IS NULL
          ORDER BY kind, name`,
        [organizationId, shareId, [...ids]],
      ),
    );
  }

  private async childrenOf(organizationId: string, parentIds: readonly string[]): Promise<Node[]> {
    if (parentIds.length === 0) return [];
    return this.db.withTenant(organizationId, (q) =>
      q.query<Node>(
        `SELECT id::text AS id, parent_id::text AS parent_id, kind, name,
                size_bytes::text AS size_bytes, content_type
           FROM public.file_entries
          WHERE organization_id = $1 AND parent_id = ANY($2::uuid[]) AND trashed_at IS NULL
          ORDER BY kind, name`,
        [organizationId, [...parentIds]],
      ),
    );
  }

  /**
   * The row under `parentId` that is a copy of `sourceId`, if this chunk already made one.
   *
   * The exact question, answered by the link rather than by the name. A file whose copy was
   * renamed by hand afterwards still matches; two unrelated files that happen to share a name do
   * not.
   */
  private async copyOf(
    organizationId: string,
    parentId: string | null,
    sourceId: string,
  ): Promise<{ id: string } | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.file_entries
          WHERE organization_id = $1 AND parent_id IS NOT DISTINCT FROM $2
            AND copied_from_entry_id = $3 AND trashed_at IS NULL`,
        [organizationId, parentId, sourceId],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * A folder's copy, if a previous chunk made it.
   *
   * Folders carry no link — `CreateDirectory` writes its row through `FilesService.createFolder`,
   * which knows nothing about copying — so this walks the same name chain from the destination
   * that `resolveCopiedFolder` does. That is sound for a folder in a way it is not for a file:
   * `createFolder` refuses a name that is already taken, so a folder's copy keeps the name the
   * first attempt gave it and a second attempt finds it.
   */
  private async folderCopiedFrom(
    organizationId: string,
    payload: CopyPayload,
    sourceFolderId: string,
  ): Promise<{ parentId: string | null; name: string } | null> {
    const resolved = await this.resolveCopiedFolder(organizationId, payload, sourceFolderId);
    if (resolved === null) return null;
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ parent_id: string | null; name: string }>(
        `SELECT parent_id::text AS parent_id, name FROM public.file_entries
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, resolved],
      ),
    );
    const row = rows[0];
    return row === undefined ? null : { parentId: row.parent_id, name: row.name };
  }

  private async rowAt(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
  ): Promise<{ id: string } | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.file_entries
          WHERE organization_id = $1 AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND public.fold_identity(name) = public.fold_identity($4)
            AND trashed_at IS NULL`,
        [organizationId, shareId, parentId, name],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * `keep_both`, which is the contract's default and the only policy this implements.
   *
   * The other three are declared and refused at the endpoint. `replace` would destroy a file the
   * user did not name — the one thing `RENAME_NOREPLACE` exists to prevent, all the way down to
   * the syscall — and implementing it would mean giving the agent an overwrite it does not have.
   * `version` needs a version store that does not exist. `skip` is defensible and is simply not
   * built yet; refusing it is better than silently doing `keep_both` under its name.
   */
  private async freeName(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    wanted: string,
  ): Promise<string> {
    if ((await this.rowAt(organizationId, shareId, parentId, wanted)) === null) return wanted;

    const dot = wanted.lastIndexOf('.');
    const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
    const extension = dot > 0 ? wanted.slice(dot) : '';

    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${stem} (${n})${extension}`;
      if ((await this.rowAt(organizationId, shareId, parentId, candidate)) === null) {
        return candidate;
      }
    }
    throw new CopyNameExhaustedError(wanted);
  }
}

/** The selection is larger than this operation will attempt. */
export class CopyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`a copy of more than ${limit} entries is refused`);
    this.name = 'CopyTooLargeError';
  }
}

/** A thousand files called `rapor (n).pdf` already sit in the destination. */
export class CopyNameExhaustedError extends Error {
  constructor(readonly wanted: string) {
    super(`could not find a free name for ${wanted}`);
    this.name = 'CopyNameExhaustedError';
  }
}

export const COPY_KIND = 'files.copy';

/**
 * Twenty, matching `permissions.apply`.
 *
 * A chunked job queues its own successor, and a successor written with the queue's default of five
 * attempts would have a thirty-second life while its predecessor had an hour.
 */
export const COPY_MAX_ATTEMPTS = 20;
