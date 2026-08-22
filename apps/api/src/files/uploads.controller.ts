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
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { AgentDataService, AgentOutOfSpaceError } from '../agent/agent-data.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { DbService } from '../db/db.service.js';
import { assertValidName, FilesService } from './files.service.js';
import { requireSession, translate } from './files.controller.js';

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
  ) {}

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
    const share = await this.shareFor(session.organizationId);
    if (parentId !== null) {
      const parent = await this.files.find(session.organizationId, parentId).catch((e: unknown) => {
        throw translate(e);
      });
      if (parent.kind !== 'folder' || parent.trashed_at !== null) throw new NotFoundException();
    }

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
    const upload = await this.loadSession(session.organizationId, uploadId);
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
  ): Promise<void> {
    const session = requireSession(request);
    this.requireAgent();
    const upload = await this.loadSession(session.organizationId, uploadId);
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

    const share = await this.shareFor(session.organizationId);
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

    let stored: number;
    try {
      stored = await this.data.send(opened.token, opened.offset, chunkLength, request);
    } catch (error) {
      if (error instanceof AgentOutOfSpaceError) {
        // 507, not 500. ADR-0008: a full dataset is a permanent condition the client must not
        // retry, and a 500 is exactly what a client retries.
        throw new InsufficientStorageException(error.agentReason);
      }
      throw error;
    }

    const next = offset + stored;
    await this.setOffset(session.organizationId, upload.id, next);
    response.setHeader('Upload-Offset', String(next));
    response.setHeader('Tus-Resumable', '1.0.0');

    if (next < Number(upload.length_bytes)) return;

    // Complete. Publish moves the staging file into the tree with RENAME_NOREPLACE and fsyncs the
    // destination directory (ADR-0008 steps 4 and 5), and the agent checks the size itself rather
    // than trusting this process's belief that the upload finished.
    const bytes = await this.files.publish(
      share.name,
      upload.staging_name,
      destinationOf(upload),
      Number(upload.length_bytes),
      ownerUid(),
      ownerGid(),
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

  private async loadSession(organizationId: string, id: string): Promise<SessionRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<SessionRow>(
        `SELECT id, share_id, parent_id, filename, staging_name, length_bytes, offset_bytes, file_id
           FROM public.upload_sessions
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private async shareFor(organizationId: string): Promise<{ id: string; name: string }> {
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
 * The published file's path inside the share.
 *
 * Only the leaf is needed today because every upload lands directly under its parent, and the
 * agent takes the destination as validated components rather than a joined string.
 */
function destinationOf(upload: SessionRow): string[] {
  return [upload.filename];
}

/**
 * Who owns a published file, until user-to-uid mapping exists.
 *
 * The API's own service account, and stated plainly rather than dressed up: ADR-0004's mapping of
 * DEPSIS users onto POSIX identities is not built, so there is no per-user uid to hand the agent.
 * Using the API's uid keeps the file readable by the process that will serve the download, and the
 * agent refuses uid 0 so this cannot silently become root-owned. When the mapping lands, this is
 * the one function that changes.
 */
function ownerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new ServiceUnavailableException(
      'file ownership cannot be determined on this platform; uploads are unavailable',
    );
  }
  return uid;
}

function ownerGid(): number {
  const gid = process.getgid?.();
  if (gid === undefined || gid === 0) {
    throw new ServiceUnavailableException(
      'file ownership cannot be determined on this platform; uploads are unavailable',
    );
  }
  return gid;
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
