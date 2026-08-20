import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

/**
 * The one place a tenant id is obtained without already having one.
 *
 * ADR-0015 §5: the policy on `organizations` is `id = current_organization_id()`, so a user
 * arriving with a slug cannot be looked up — the tenant has to be known before the tenant can be
 * read. `resolve_organization_by_slug` is a SECURITY DEFINER function that returns the id and
 * nothing else, for an exact slug match.
 *
 * This service returns an id, never a row. Handing back a name or a created_at here would widen a
 * leak the ADR accepts only because it is exactly one column wide.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly db: DbService) {}

  async resolveIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.db.withoutTenant('resolve-organization-by-slug', (db) =>
      db.query<{ id: string | null }>(
        'SELECT public.resolve_organization_by_slug($1)::text AS id',
        [slug],
      ),
    );
    return rows[0]?.id ?? null;
  }
}
