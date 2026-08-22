import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

/**
 * One `upload_sessions` row as the transfer list needs it, with the state the DATABASE decided.
 *
 * `length_bytes` and `offset_bytes` arrive as strings because node-postgres will not narrow a
 * `bigint` to a JavaScript number for us — the same reason `FileEntryRow.size_bytes` is a string.
 */
export interface TransferRow {
  id: string;
  filename: string;
  length_bytes: string;
  offset_bytes: string;
  state: 'active' | 'stalled' | 'completed';
  created_at: Date;
  updated_at: Date;
}

/**
 * How long a silent upload stays `active`.
 *
 * A tus client PATCHes continuously while it has bytes to send, so a minute without a write is
 * already far outside normal behaviour — and the case this exists for produces no write at all:
 * a closed browser tab leaves a session sitting at a partial offset forever with nothing to
 * announce it. Shorter than a minute would flag a client that is merely between chunks on a slow
 * link; much longer and the list would keep claiming an upload is running long after the tab that
 * was running it is gone.
 */
const STALLED_AFTER_SECONDS = 60;

/**
 * How far back the list reaches.
 *
 * Nothing prunes `upload_sessions` today — a completed session is kept so a client retrying its
 * last PATCH gets a coherent answer instead of a 404 (migration 0008), and no job removes it
 * afterwards — so an unbounded query would grow with the age of the appliance and would bury
 * today's stalled upload under every upload the box has ever accepted. A transfer list is a view
 * of what is happening now; what happened last week belongs to the file tree, which already lists
 * the files that resulted.
 *
 * The cut is on `updated_at`, not `created_at`, and that difference is the point: an upload that
 * started thirty hours ago and is still writing is exactly the row this list must not lose.
 */
const WINDOW_HOURS = 24;

/**
 * A hard ceiling on the response.
 *
 * The contract's `TransferPage` has no cursor, so this endpoint cannot page and the only honest
 * protection against a bulk import that opened thousands of sessions in one day is to cap the
 * answer. Ordered newest-first, so the rows that are cut are the least interesting ones.
 */
const MAX_ROWS = 200;

/**
 * Recent and in-flight uploads, read from the table the uploads themselves write.
 *
 * There is deliberately no second record of a transfer. A separate progress table would have to be
 * kept in step with `upload_sessions` by whatever writes the bytes, and the moment those two
 * disagree the list becomes actively misleading — it would report progress for an upload that had
 * already failed. Reading the authoritative row means the list is stale at worst, never wrong.
 */
@Injectable()
export class TransfersService {
  constructor(private readonly db: DbService) {}

  /**
   * List transfers for one organisation, optionally narrowed to a single user.
   *
   * `restrictToUserId` is the caller's scope decision, not this class's: pass a user id to see only
   * that user's uploads, or `null` for the whole organisation.
   */
  async list(organizationId: string, restrictToUserId: string | null): Promise<TransferRow[]> {
    // `organization_id = $1` sits next to RLS rather than instead of it (ADR-0013), and that is the
    // whole of why it is here. An earlier version of this comment claimed the predicate let the
    // planner use `upload_sessions_incomplete`; it cannot. That index is
    // `(organization_id, created_at) WHERE completed_at IS NULL` (migration 0008), and this query
    // deliberately returns completed sessions and both filters and orders on `updated_at`. Nothing
    // indexes `(organization_id, updated_at)` today, so this is a sequential scan over a table
    // nothing prunes — the index to add when the poll starts costing something.
    //
    // `state` comes from `completed_at`, NOT from `offset_bytes >= length_bytes`, and the two are
    // not the same claim. `UploadsController.sendChunk` writes the last chunk's offset FIRST and
    // only then publishes the staging file and records the entry; a publish that fails — no space
    // (507), the name taken (409), the agent gone — leaves the row permanently at 100% with
    // `completed_at IS NULL` and nothing in the file tree. Reading the offset therefore told the
    // user their upload had finished at the exact moment it had not, which is the one case a
    // transfer list exists to be trusted in. Migration 0008 pairs `completed_at` with `file_id`
    // under a CHECK, so a non-null `completed_at` means an entry really exists.
    return this.db.withTenant(organizationId, (db) =>
      db.query<TransferRow>(
        `SELECT id::text            AS id,
                filename,
                length_bytes::text  AS length_bytes,
                offset_bytes::text  AS offset_bytes,
                created_at,
                updated_at,
                CASE
                  WHEN completed_at IS NOT NULL THEN 'completed'
                  WHEN updated_at < now() - make_interval(secs => $2::double precision)
                    THEN 'stalled'
                  ELSE 'active'
                END AS state
           FROM public.upload_sessions
          WHERE organization_id = $1
            AND updated_at >= now() - make_interval(hours => $3::int)
            AND ($4::uuid IS NULL OR created_by = $4::uuid)
          ORDER BY updated_at DESC
          LIMIT $5`,
        [organizationId, STALLED_AFTER_SECONDS, WINDOW_HOURS, restrictToUserId, MAX_ROWS],
      ),
    );
  }
}

export const TRANSFER_STALLED_AFTER_SECONDS = STALLED_AFTER_SECONDS;
export const TRANSFER_WINDOW_HOURS = WINDOW_HOURS;
