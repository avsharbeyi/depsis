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

  /**
   * The organisation this box IS.
   *
   * `system_setup` is a singleton, so a claimed DEPSIS appliance holds exactly one organisation and
   * always will. Asking a person to name it at sign-in is a question with one possible answer and
   * several ways to get it wrong — measured on a real sign-in, where a slug with one trailing space
   * produced the same refusal as a wrong password.
   *
   * Returns null when there is not exactly one, rather than picking the first. If DEPSIS ever hosts
   * a second organisation per box, sign-in fails loudly and gets its tenant field back; silently
   * signing somebody into whichever tenant sorted first is the worst outcome available here.
   */
  async resolveSoleId(): Promise<string | null> {
    const rows = await this.db.withoutTenant('resolve-sole-organization', (db) =>
      db.query<{ id: string | null }>('SELECT public.resolve_sole_organization()::text AS id'),
    );
    return rows[0]?.id ?? null;
  }

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
