/**
 * Errors from the tenant-context chokepoint.
 *
 * Separate classes rather than one with a code, because the two mean very different things to
 * whoever reads the log: one is a programming mistake, the other is a sign the database or the
 * connection path is not behaving the way ADR-0013 assumes.
 */

/** A caller used the chokepoint wrongly — a bad organization id, an unusable connection. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * `set_config` ran, and the value a policy would read back is not the one that was set.
 *
 * This is the alarm ADR-0015 §3 exists to raise. Without it the symptom is an empty result set,
 * which a handler cannot tell apart from "this tenant has no data" — the silent-failure shape this
 * project keeps finding. If this is ever thrown in production, the connection path is not what the
 * tenancy model assumes: PgBouncer in session pooling mode is the usual cause.
 */
export class TenantContextNotEstablishedError extends Error {
  constructor(
    readonly expected: string,
    readonly observed: string | null,
  ) {
    super(
      `tenant context was not established: set '${expected}', but current_organization_id() ` +
        `reads back ${observed === null ? 'NULL' : `'${observed}'`}. Every query in this ` +
        `transaction would have returned zero rows instead of failing. Check that the connection ` +
        `is not going through a session-pooling PgBouncer (ADR-0013 §2.3).`,
    );
    this.name = 'TenantContextNotEstablishedError';
  }
}
