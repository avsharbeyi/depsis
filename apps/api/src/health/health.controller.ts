import { Controller, Get } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'reachable' | 'unreachable';
  role: string | null;
}

/**
 * Liveness, and one fact worth reporting: which role the API is connected as.
 *
 * Surfacing the role is not decoration. ADR-0015 §4 refuses to start under a role that bypasses
 * row level security, but a deployment can still be pointed at the wrong DATABASE and pass that
 * check; having the role visible in a health response is how an operator notices before a support
 * ticket does.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    try {
      const rows = await this.db.withoutTenant('health-check', (db) =>
        db.query<{ role: string }>('SELECT current_user AS role'),
      );
      return { status: 'ok', database: 'reachable', role: rows[0]?.role ?? null };
    } catch {
      // The reason is deliberately not echoed to the caller: a connection string, a hostname or a
      // role name in an unauthenticated response is information the caller has no need for. It is
      // logged by the framework's exception path instead.
      return { status: 'degraded', database: 'unreachable', role: null };
    }
  }
}
