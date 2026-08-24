import {
  BadRequestException,
  ConflictException,
  Controller,
  Head,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { AgentDataService, AgentOutOfSpaceError } from '../agent/agent-data.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProblemException } from '../common/problem.filter.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import { assertValidName, FilesService } from './files.service.js';
import { requirePermission, requireSession, requireUuid, translate } from './files.controller.js';

interface SessionRow {
  id: string;
  share_id: string;
  parent_id: string | null;
  filename: string;
  staging_name: string;
  length_bytes: string;
  offset_bytes: string;
  file_id: string | null;
}

/**
 * Resumable upload, the tus subset DEPSIS needs (ADR-0008).
 *
 * The bytes do not pass through this process's memory: the request stream is piped straight into
 * the agent's data socket. That matters for more than efficiency — buffering a chunk would make an
 * upload's peak memory a function of what a client chooses to send.
 *
 * The offsets have two sources and only one authority. `upload_sessions.offset_bytes` is a cache
 * that makes HEAD cheap; the agent seeks the staging file on every `open_transfer` and refuses a
 * mismatch, so a stale cache produces a refusal the client corrects with a HEAD — never a
 * duplicated or missing region.
 */
@Controller('uploads')
@UseGuards(SessionGuard)
export class UploadsController {
  constructor(
    private readonly db: DbService,
    private readonly files: FilesService,
    private readonly agent: AgentService,
    private readonly data: AgentDataService,
    private readonly posix: PosixIdentityService,
  ) {}

  // §8's `Idempotency-Key`, on the route the contract declares it on. Without a key the request
  // behaves exactly as before; with one, a client that lost the response and retried gets the
  // first answer back instead of a second upload session.
  @UseInterceptors(IdempotencyInterceptor)
  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('upload-length') uploadLength?: string,
    @Headers('upload-metadata') uploadMetadata?: string,
  ): Promise<void> {
    const session = requireSession(request);
    this.requireAgent();

    const length = Number.parseInt(uploadLength ?? '', 10);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new BadRequestException('Upload-Length must be a non-negative integer');
    }
    const metadata = parseUploadMetadata(uploadMetadata ?? '');
    const filename = metadata.get('filename');
    if (filename === undefined) {
      throw new BadRequestException('Upload-Metadata must carry a filename');
    }
    try {
      assertValidName(filename);
    } catch (error) {
      throw translate(error);
    }

    const parentId = metadata.get('parentId') ?? null;
    // The tus metadata header is caller-supplied text, so this id gets the same treatment every
    // path parameter gets. Without it a `parentId` that is not a uuid reaches `id = $2` against a
    // `uuid` column, comes back as SQLSTATE 22P02 that nothing maps, and surfaces as a 500 — an
    // answer that also distinguishes a malformed id from a well-formed one naming another tenant's
    // folder, which is the distinction RLS exists to erase.
    if (parentId !== null) requireUuid(parentId);
    // From the destination folder, so an upload into a share created after the first one lands in
    // the right tree instead of being staged under the default share.
    const share = await this.shareFor(session.organizationId, parentId).catch((e: unknown) => {
      throw translate(e);
    });
    if (parentId !== null) {
      const parent = await this.files.find(session.organizationId, parentId).catch((e: unknown) => {
        throw translate(e);
      });
      if (parent.kind !== 'folder' || parent.trashed_at !== null) throw new NotFoundException();
    }

    // §6.2 is checked HERE and not on each chunk. This is where the destination is chosen and
    // where nothing has been transferred yet, so a refusal costs the client one request; a check
    // on the final PATCH would kill an upload after its last byte had already crossed the wire.
    // What that trades away is the case of a grant revoked mid-upload, which lands the file and
    // leaves it to be removed afterwards — the same window every long-running write has.
    requirePermission(
      await this.files.effectiveAt(session, share.id, parentId),
      'create',
      parentId !== null,
    );

    // The staging name comes from a fresh uuid, not from the filename. Two people uploading
    // `report.pdf` into different folders share one staging directory, and a name collision there
    // would make the agent refuse the second upload for a reason the user could not act on.
    const stagingName = `${randomUUID()}.part`;

    const rows = await this.db.withTenant(session.organizationId, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO public.upload_sessions
           (organization_id, share_id, parent_id, created_by, filename, staging_name, length_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [session.organizationId, share.id, parentId, session.userId, filename, stagingName, length],
      ),
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('the upload session was not created');

    response.setHeader('Location', `/api/v1/uploads/${id}`);
    response.setHeader('Upload-Offset', '0');
  }

  @Head(':uploadId')
  @HttpCode(200)
  async status(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('uploadId') uploadId: string,
  ): Promise<void> {
    const session = requireSession(request);
    const upload = await this.loadSession(session.organizationId, session.userId, uploadId);
    response.setHeader('Upload-Offset', upload.offset_bytes);
    response.setHeader('Upload-Length', upload.length_bytes);
    // tus requires this on every response, and a client that does not see it falls back to a
    // non-resumable POST — silently turning a resumable upload into one that restarts from zero.
    response.setHeader('Tus-Resumable', '1.0.0');
  }

  @Patch(':uploadId')
  @HttpCode(204)
  async sendChunk(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('uploadId') uploadId: string,
    @Headers('upload-offset') uploadOffset?: string,
    @Headers('content-length') contentLength?: string,
    @Headers('upload-checksum') uploadChecksum?: string,
  ): Promise<void> {
    const session = requireSession(request);
    this.requireAgent();
    const upload = await this.loadSession(session.organizationId, session.userId, uploadId);
    if (upload.file_id !== null) throw new ConflictException('this upload is already complete');

    const offset = Number.parseInt(uploadOffset ?? '', 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BadRequestException('Upload-Offset must be a non-negative integer');
    }
    if (offset !== Number(upload.offset_bytes)) {
      // 409 is what tus specifies for a mismatch, and the current offset goes with it so the
      // client can resume without a second round trip.
      response.setHeader('Upload-Offset', upload.offset_bytes);
      throw new ConflictException(
        `the upload is at ${upload.offset_bytes}, the request declared ${offset}`,
      );
    }

    // A declared length, not "whatever arrives". The agent reads exactly this many bytes; a
    // request without Content-Length cannot be framed and is refused rather than guessed at.
    const chunkLength = Number.parseInt(contentLength ?? '', 10);
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0) {
      throw new BadRequestException('Content-Length is required and must be positive');
    }
    if (offset + chunkLength > Number(upload.length_bytes)) {
      throw new BadRequestException(
        `this chunk would take the upload past the declared ${upload.length_bytes} bytes`,
      );
    }

    // The share the SESSION was opened against, not the tenant's default: a chunk has to be staged
    // in the same tree its `OpenTransfer` resolved, or the publish at the end has nothing to move.
    const share = await this.shareFor(session.organizationId, upload.parent_id).catch(
      (e: unknown) => {
        throw translate(e);
      },
    );
    const correlationId = randomUUID();

    // Two connections, in this order. The control call resolves the staging file under
    // openat2(RESOLVE_BENEATH) and hands back a one-time token; the data connection presents that
    // token and streams. Nothing on the data socket names a path, so it cannot reach anything the
    // control call did not already confine (ADR-0017).
    const opened = expectStatus(
      await this.agent.call(
        { op: 'open_transfer', share: share.name, staging_name: upload.staging_name },
        `tus PATCH for ${upload.filename}`,
        correlationId,
      ),
      'transfer',
    );

    if (opened.offset !== offset) {
      // The FILE disagreed with the cache. The agent is right; correct the cache and make the
      // client retry rather than writing at an offset nobody agrees on.
      await this.setOffset(session.organizationId, upload.id, opened.offset);
      response.setHeader('Upload-Offset', String(opened.offset));
      throw new ConflictException(
        `the staged file is at ${opened.offset}, not ${offset}; resume from there`,
      );
    }

    // Parsed BEFORE a byte is forwarded. A malformed header discovered after the chunk is on
    // disk would mean refusing an upload for a client mistake that cost the appliance the write.
    const expected = parseChecksum(uploadChecksum);
    const digest = expected === null ? undefined : createHash('sha256');

    let stored: number;
    try {
      stored = await this.data.send(opened.token, opened.offset, chunkLength, request, digest);
    } catch (error) {
      if (error instanceof AgentOutOfSpaceError) {
        // 507, not 500. ADR-0008: a full dataset is a permanent condition the client must not
        // retry, and a 500 is exactly what a client retries.
        throw new InsufficientStorageException(error.agentReason);
      }
      throw error;
    }

    if (expected !== null && digest !== undefined) {
      const actual = digest.digest();
      if (!timingSafeEqualBuffers(actual, expected)) {
        // The offset is NOT advanced, and that is the whole mechanism. The bytes reached the
        // staging file — they were streamed straight through — so there is nothing to undo here;
        // leaving the recorded offset where it was means the next PATCH is told to resume from the
        // same place and rewrites the region. tus specifies exactly this: the chunk is discarded
        // by being overwritten, not by being erased.
        response.setHeader('Upload-Offset', String(offset));
        response.setHeader('Tus-Resumable', '1.0.0');
        throw new ProblemException(
          'checksum-mismatch',
          'Gönderilen parçanın sha256 özeti Upload-Checksum ile uyuşmadı; aynı konumdan tekrar ' +
            'gönderin.',
        );
      }
    }

    const next = offset + stored;
    await this.setOffset(session.organizationId, upload.id, next);
    response.setHeader('Upload-Offset', String(next));
    response.setHeader('Tus-Resumable', '1.0.0');

    if (next < Number(upload.length_bytes)) return;

    // Complete. Publish moves the staging file into the tree with RENAME_NOREPLACE and fsyncs the
    // destination directory (ADR-0008 steps 4 and 5), and the agent checks the size itself rather
    // than trusting this process's belief that the upload finished.
    // The parent's components, then the name. An earlier version published `[filename]` alone,
    // which put every upload at the share root no matter which folder the user chose — and the
    // probe missed it because its check fell back to the root path with a `||`. The file landed,
    // the listing looked right, and the download 404'd.
    const destination =
      upload.parent_id === null
        ? [upload.filename]
        : [
            ...(await this.files.componentsOf(session.organizationId, upload.parent_id)),
            upload.filename,
          ];

    // The uploader's own POSIX identity, not this process's. Until now every published file was
    // owned by the API's service account, which is the state the agent's refusal of uid 0 was
    // written to make impossible and the mode bits could not fix: a share is a tenant's, and a
    // file inside it that the tenant does not own is one they cannot chmod, cannot delete over
    // SMB, and cannot be given a quota for. `PosixIdentityService` allocates on first need, so an
    // account created before migration 0015 gets its uid here.
    //
    // The gid is the same number. See `FilesService.createFolder`: uids and team gids come from
    // one counter, so a user's own id is a group nothing else holds, and ADR-0004 gives team
    // access through the POSIX ACL rather than through the owning group.
    const uid = await this.posix
      .posixUidFor(session.organizationId, session.userId)
      .catch((error: unknown) => {
        throw translate(error);
      });

    const bytes = await this.files.publish(
      share.name,
      upload.staging_name,
      destination,
      Number(upload.length_bytes),
      uid,
      uid,
      correlationId,
      `publishing ${upload.filename}`,
    );

    const entry = await this.files
      .recordPublishedFile(
        session.organizationId,
        upload.share_id,
        upload.parent_id,
        upload.filename,
        bytes,
        null,
      )
      .catch((error: unknown) => {
        throw translate(error);
      });

    await this.db.withTenant(session.organizationId, (db) =>
      db.query(
        `UPDATE public.upload_sessions
            SET file_id = $3, completed_at = now(), offset_bytes = $4
          WHERE organization_id = $1 AND id = $2`,
        [session.organizationId, upload.id, entry.id, next],
      ),
    );
  }

  private async setOffset(organizationId: string, id: string, offset: number): Promise<void> {
    await this.db.withTenant(organizationId, (db) =>
      db.query(
        `UPDATE public.upload_sessions SET offset_bytes = $3
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id, offset],
      ),
    );
  }

  /**
   * One upload session, belonging to THIS caller.
   *
   * `created_by` is in the predicate, and that is the authorization for both routes that take an
   * upload id. §6.2 is resolved once, at POST, against the folder the session names — a trade the
   * comment on `create` explains — and that trade only holds if the account driving the chunks is
   * the account the check was made for. Without this clause any member of the tenant holding an
   * upload id could finish somebody else's transfer: `sendChunk` publishes into `upload.parent_id`,
   * a folder they may have no `create` on, and stamps the file with THEIR posix uid. The ids are
   * uuidv7 and not guessable, but `GET /transfers` hands an organisation administrator every
   * session in the tenant, so "unguessable" was never the whole answer.
   *
   * A session belonging to someone else is therefore 404 rather than 403 — the same answer as one
   * that does not exist, because an upload id is not something one member should be able to
   * confirm about another.
   */
  private async loadSession(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<SessionRow> {
    // The same validator every other id path uses, rather than a hand-rolled shape test. The old
    // one accepted thirty-six hyphens and passed them to the same `uuid` cast.
    requireUuid(id);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<SessionRow>(
        `SELECT id, share_id, parent_id, filename, staging_name, length_bytes, offset_bytes, file_id
           FROM public.upload_sessions
          WHERE organization_id = $1 AND id = $2 AND created_by = $3`,
        [organizationId, id, userId],
      ),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * The share an upload lands in.
   *
   * From the DESTINATION FOLDER when there is one, and the tenant's default only for an upload
   * aimed at a share root. Resolving the default unconditionally is what made every share created
   * after the first one unwritable: the parent lived in share B and the staging file was opened
   * under share A, so the publish either failed or landed in the wrong tree.
   */
  private async shareFor(
    organizationId: string,
    parentId: string | null,
  ): Promise<{ id: string; name: string }> {
    if (parentId !== null) {
      const parent = await this.files.find(organizationId, parentId);
      return this.files.shareFor(organizationId, parent.share_id);
    }
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ slug: string }>(`SELECT slug FROM public.organizations WHERE id = $1`, [
        organizationId,
      ]),
    );
    const slug = rows[0]?.slug;
    if (slug === undefined) throw new NotFoundException();
    return this.files.defaultShare(organizationId, slug);
  }

  private requireAgent(): void {
    if (!this.agent.isAvailable() || !this.data.isAvailable()) {
      throw new ServiceUnavailableException(
        'the system agent is not reachable; uploads are unavailable',
      );
    }
  }
}

/** 507, which Nest has no built-in exception for. */
class InsufficientStorageException extends ConflictException {
  constructor(reason: string) {
    super(reason);
    this.name = 'InsufficientStorageException';
    Object.defineProperty(this, 'status', { value: 507 });
  }
  override getStatus(): number {
    return 507;
  }
}

/**
 * tus `Upload-Metadata`: comma-separated `key base64value` pairs.
 *
 * A key with no value is legal in tus and means the empty string; a key that is not valid base64
 * is not, and is dropped rather than half-decoded — `Buffer.from` is lenient and would otherwise
 * turn a corrupt filename into a plausible one.
 */
export function parseUploadMetadata(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of header.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space < 0) {
      out.set(trimmed, '');
      continue;
    }
    const key = trimmed.slice(0, space);
    const encoded = trimmed.slice(space + 1).trim();
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) continue;
    out.set(key, decoded.toString('utf8'));
  }
  return out;
}

/**
 * `Upload-Checksum: sha256 <base64>`, or nothing.
 *
 * The tus checksum extension's format: an algorithm name, a space, and the digest in base64. Only
 * sha256 is accepted, and the contract says why — a browser's SubtleCrypto offers the SHA family
 * and nothing else, so an algorithm no client can compute would be a parameter nobody could use.
 *
 * A HEADER THAT CANNOT BE UNDERSTOOD IS REFUSED, not ignored. Ignoring it would mean a client that
 * misspelled the algorithm believes its uploads are being checked and they are not — the same
 * failure this whole change exists to end, one level down.
 */
export function parseChecksum(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw.trim() === '') return null;

  const [algorithm, ...rest] = raw.trim().split(/\s+/);
  if (algorithm?.toLowerCase() !== 'sha256') {
    throw new ProblemException(
      'bad-request',
      'Upload-Checksum yalnız sha256 kabul ediyor: `sha256 <base64>`.',
    );
  }

  const encoded = rest.join('');
  const decoded = Buffer.from(encoded, 'base64');
  // `Buffer.from(..., 'base64')` never throws — it stops at the first character it cannot read —
  // so the length is what says the value was a digest rather than a typo.
  if (decoded.length !== 32) {
    throw new ProblemException(
      'bad-request',
      'Upload-Checksum bir sha256 özeti olmalı: 32 baytın base64 hâli.',
    );
  }
  return decoded;
}

/**
 * Constant-time comparison, for a value that is not a secret.
 *
 * Deliberate anyway: `timingSafeEqual` throws on a length mismatch, so the guard has to come
 * first, and using it everywhere a digest is compared means nobody has to decide case by case
 * which digests are secret.
 */
function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
