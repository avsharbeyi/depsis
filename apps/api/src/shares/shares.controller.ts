import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { requireSession } from '../files/files.controller.js';
import { SharesService, type ShareView } from './shares.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * The share list, and the addresses that make a NAS a NAS.
 *
 * No `AdminGuard`. A member needs to know where their own files live, and the answer — a share
 * name and a UNC path — is something they can already read off the file tree they have access to.
 * The list is tenant-scoped by RLS rather than by role, which is the narrowing that matters here.
 */
@Controller('shares')
@UseGuards(SessionGuard)
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['SharePage']> {
    const session = requireSession(request);
    const listing = await this.shares.list(session.organizationId);

    // `dataset` is optional in the contract and is shown to administrators only. `GET /backups`
    // restricts its whole listing on the grounds that a list of datasets is a map of the
    // appliance's storage layout that an ordinary member has no other endpoint to assemble; the
    // same column here would hand out that map anyway and make the other restriction decorative.
    // The rest of the row is what a member needs and can already infer from their own files.
    const withDataset = request.depsis?.role === 'admin';

    return {
      items: listing.items.map((row) => toShare(row, withDataset)),
      smbAvailable: listing.smbAvailable,
    };
  }
}

function toShare(row: ShareView, withDataset: boolean): Schemas['Share'] {
  return {
    id: row.id,
    name: row.name,
    readOnly: row.read_only,
    published: row.published,
    uncPath: row.unc_path,
    // Spread rather than a `dataset: undefined`, because `exactOptionalPropertyTypes` makes
    // "absent" and "present and undefined" different types and only the first is the contract's
    // optional field.
    ...(withDataset ? { dataset: row.dataset } : {}),
  };
}
