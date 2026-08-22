import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { requireSession } from './files.controller.js';
import { TransfersService, type TransferRow } from './transfers.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The transfer list.
 *
 * Read-only, and only uploads. A download is a single HTTP request with no server-side state to
 * report on, so there is nothing here that could describe one — the contract says so and this
 * controller keeps that promise by having no other route.
 *
 * No `AdminGuard`: every signed-in user may ask what their own uploads are doing. The role only
 * decides how WIDE the answer is, which is settled in the handler rather than by a guard, because
 * a guard can refuse a request but cannot change its scope.
 */
@Controller('transfers')
@UseGuards(SessionGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['TransferPage']> {
    const session = requireSession(request);

    // `upload_sessions.created_by` exists, so this list can be per-user, and per-user is the right
    // default: a member seeing a colleague's filenames scroll past is a disclosure nobody asked
    // this endpoint to make, and the filename is the whole content of a row here.
    //
    // An administrator gets the organisation instead. Their question is not "what am I uploading"
    // but "who is filling the disk", and an answer narrowed to their own uploads cannot address
    // it — the staging tree is shared and the upload consuming it is by definition someone else's.
    // The role is read from the session the guard resolved, never from the request (ADR-0015 §6).
    const restrictToUserId = request.depsis?.role === 'admin' ? null : session.userId;

    const rows = await this.transfers.list(session.organizationId, restrictToUserId);
    return { items: rows.map(toTransfer) };
  }
}

function toTransfer(row: TransferRow): Schemas['Transfer'] {
  return {
    id: row.id,
    filename: row.filename,
    // `bigint` arrives from node-postgres as a string on purpose — a JavaScript number cannot hold
    // every int64 — and is parsed here because the contract asks for a number. An upload above
    // 2^53 bytes is not a case this appliance has, and the file tree makes the same trade for
    // `size`.
    lengthBytes: Number(row.length_bytes),
    offsetBytes: Number(row.offset_bytes),
    state: row.state,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
