import { Injectable, Logger } from '@nestjs/common';

import {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  type AgentRequest,
} from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';

/** One row of `public.shares`. */
export interface ShareRow {
  id: string;
  name: string;
  dataset: string;
  read_only: boolean;
}

/** A share, as this module reports it: the row plus the two things only the agent can settle. */
export interface ShareView extends ShareRow {
  unc_path: string;
  published: boolean;
}

export interface ShareListing {
  items: ShareView[];
  smbAvailable: boolean;
}

/** Samba is not installed on this box. Not a fault — DEPSIS does not package it (ADR-0020). */
export class SmbUnavailableError extends Error {
  constructor(readonly agentReason: string) {
    super('samba is not installed on this appliance');
    this.name = 'SmbUnavailableError';
  }
}

/**
 * The publish failed and nobody may claim the previous configuration survived.
 *
 * Distinct from `AgentRefusedError` because the agent's two answers are distinct facts. A refusal
 * is `SambaError::RejectedRolledBack` — Samba said no and the old file is back, shares keep
 * working, retry after fixing what the message names. This is everything else, and the case it
 * exists for is `SambaError::RollbackFailed`: rejected AND the restore failed, which the agent
 * itself describes as the box being worse than it was found. Both arrive as `failed` because the
 * wire has one status for them, so this errs toward the serious reading and says the state is
 * unknown rather than asserting a rollback that may not have happened.
 *
 * What would sharpen it: a machine-readable answer for the unrecoverable case — `Response::
 * SmbBroken { reason }`, or a discriminator on `Failed`. That is a change to the Rust-side
 * operation set and its schema version, so it is noted rather than made here.
 */
export class SmbPublishFailedError extends Error {
  constructor(readonly agentReason: string) {
    super('the samba configuration was not published and its previous state is unknown');
    this.name = 'SmbPublishFailedError';
  }
}

/**
 * The device holds more than one organisation, so a tenant-scoped publish would be wrong.
 *
 * See `publish`. This is a refusal to do damage, not a missing feature.
 */
export class ShareListNotDeviceWideError extends Error {
  constructor() {
    super('the share list this publish would send is not the whole device');
    this.name = 'ShareListNotDeviceWideError';
  }
}

/** A share cannot be expressed as an `smb.conf` section, so nothing was sent to the agent. */
export class UnpublishableShareError extends Error {
  constructor(
    readonly shareName: string,
    readonly why: string,
  ) {
    super(`share '${shareName}' cannot be published: ${why}`);
    this.name = 'UnpublishableShareError';
  }
}

/**
 * Section names that would take over the operator's own configuration rather than add to it.
 *
 * The same four `samba.rs` refuses, checked here as well, and NOT as belt-and-braces: migration
 * 0008's `shares_name_format` accepts `global`, so a tenant can create a share the database is
 * happy with and the agent will refuse — and it refuses the WHOLE publish, which means one badly
 * named share stops every other share on the box from being served. Catching it here names the
 * offending share instead of failing the publish with the agent's prose.
 */
const RESERVED_SECTIONS: readonly string[] = ['global', 'homes', 'printers', 'print$'];

/**
 * Shares, their SMB addresses, and the republish that makes them real.
 *
 * The one thing to understand before changing anything here: a row in `public.shares` and a share
 * smbd is serving are DIFFERENT FACTS, and this service exists mostly to keep them apart. The
 * contract's `Share.published` says so too. Reporting a row as published because it is in the
 * database would send a user to type `\\depsis\belgeler` into Explorer and get nothing back, with
 * no way to tell whether they mistyped it or the appliance never configured it.
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  /**
   * The share ids the agent confirmed it was serving, at the last successful publish.
   *
   * THIS IS A CACHE, and its limits are the reason it is written down rather than presented as
   * knowledge:
   *
   *   * It lives in this process. A restart empties it, so a box whose shares are being served
   *     perfectly well reports every one of them as `published: false` until somebody republishes.
   *     That is the direction to be wrong in — the alternative is telling a user an address works
   *     when nothing checked, and the recovery from a false `false` is one click on republish
   *     while the recovery from a false `true` is a support call.
   *   * It goes stale. `smb.conf` is the operator's file and a shell on the box can edit it, stop
   *     smbd, or remove the `include` line, and none of that reaches this set.
   *
   * What would replace it: an agent operation that asks smbd what it is offering right now. The
   * agent already does exactly that inside `samba::publish` (`offered_shares`, the live connection
   * P0-B showed `testparm` cannot substitute for), so the capability exists — it is simply not
   * reachable as an operation of its own, and adding one is a change to the closed Rust-side
   * operation set (§2.2, ADR-0006) rather than something the API can decide. Until then this set
   * is the honest half of the answer, and `false` is what unknown means.
   *
   * Keyed by share id rather than by name because the id is the identity the contract exposes and
   * the thing a name change survives.
   */
  private publishedShareIds: ReadonlySet<string> = new Set();

  /**
   * What the last publish attempt learned about Samba being installed here.
   *
   * `unknown` reports as available, unlike `publishedShareIds` reporting unknown as false, and the
   * asymmetry is deliberate rather than an oversight. The contract says `smbAvailable: false` means
   * "Samba is not installed" — a positive claim about the machine. Making that claim because
   * nobody has published since boot would tell an administrator to install a package that is
   * already there. `published: false` claims nothing; it withholds. So the field that withholds
   * defaults to withholding and the field that asserts defaults to not asserting.
   */
  private smbInstalled: 'unknown' | 'yes' | 'no' = 'unknown';

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    /**
     * Only for `resolveSoleId`. See `publish` — the device-wide question this service has to ask
     * has exactly one answer available to it today, and this is where that answer comes from.
     */
    private readonly organizations: OrganizationsService,
    /**
     * The name that goes in `\\host\share`.
     *
     * Configuration (`DEPSIS_SMB_HOST`), not the box's own hostname, and not derived from the
     * request's Host header either. Which name resolves to this appliance from a Windows client is
     * a fact about the network — a NetBIOS name, a DNS name, or the name behind a ZeroTier
     * address — and the appliance cannot see it. Guessing produces an address that looks
     * authoritative and does not answer, which is the one failure this endpoint exists to prevent.
     */
    private readonly smbHost: string,
  ) {}

  /**
   * The tenant's shares.
   *
   * `withTenant`, so RLS decides what is visible rather than a WHERE clause anyone could forget.
   */
  async list(organizationId: string): Promise<ShareListing> {
    const rows = await this.rows(organizationId);

    // `isAvailable()` is the startup handshake's verdict and is not refreshed per request, so an
    // agent that died an hour ago still reads as reachable. It is still the right input: the
    // alternative is a `ping` on every list, which puts an agent round trip in front of a page
    // that is mostly database, and the failure it would catch is already visible the moment
    // anybody publishes.
    const smbAvailable = this.agent.isAvailable() && this.smbInstalled !== 'no';

    return {
      smbAvailable,
      items: rows.map((row) => ({
        ...row,
        unc_path: uncPath(this.smbHost, row.name),
        // The contract's invariant, enforced rather than assumed: `smbAvailable: false` means every
        // `published` is false. When the agent is unreachable the cache may well still describe
        // shares smbd is serving — smbd does not depend on the agent — but a page that says
        // "Samba is not available" beside a share marked "published" is a page nobody can act on.
        published: smbAvailable && this.publishedShareIds.has(row.id),
      })),
    };
  }

  /**
   * Write the Samba configuration for THIS DEVICE, and prove it.
   *
   * The hazard this method spends most of its length on: `PublishSambaConfig` replaces the whole
   * generated file. The agent renders exactly the shares it is given and nothing else, so a list
   * filtered to one tenant does not add that tenant's shares — it DELETES every other tenant's.
   * One organisation clicking republish would take another organisation's drives offline, and the
   * two would not even be able to see each other in order to understand what happened.
   *
   * The correct list is therefore every share on the box, which needs an untenanted read. That is
   * not available: `UntenantedJustification` is a closed union and ADR-0015 §1 requires a new
   * member to be a decision written into the ADR, not a string added in passing.
   *
   * So this refuses instead. `resolve_sole_organization()` returns an id only when the box holds
   * exactly one organisation — the state `OrganizationsService` documents as the one a claimed
   * appliance is always in, because `system_setup` is a singleton — and in that state the tenant's
   * shares ARE the device's shares and the publish is safe. Anything else is refused with the
   * reason, which is the behaviour to want on the day the assumption stops holding: a loud refusal
   * rather than a tenant discovering their shares vanished when somebody else pressed a button.
   *
   * A consequence worth stating: because there is exactly one organisation, the device-wide
   * uniqueness of `smb.conf` section names is already guaranteed by `shares_name_unique`, which
   * folds case per organisation exactly as SMB clients do. There is no collision check below
   * because in the only state this method proceeds in, a collision cannot exist — and in the
   * states where it could, the method has already refused.
   */
  async publish(
    organizationId: string,
    correlationId: string,
  ): Promise<{ shares: number; verified: boolean }> {
    const soleId = await this.organizations.resolveSoleId();
    if (soleId === null || soleId !== organizationId) {
      this.logger.warn(
        'refusing to publish the Samba configuration: the device does not hold exactly one ' +
          "organisation, so this tenant's share list is not the whole device and publishing it " +
          'would unpublish everyone else',
      );
      throw new ShareListNotDeviceWideError();
    }

    const rows = await this.rows(organizationId);
    for (const row of rows) {
      if (RESERVED_SECTIONS.some((reserved) => reserved.toLowerCase() === row.name.toLowerCase())) {
        // Before the agent is called, so a name the database accepted and Samba cannot express
        // never becomes a failed publish for every other share on the box.
        throw new UnpublishableShareError(
          row.name,
          "it is a reserved smb.conf section name and would rewrite the server's own settings",
        );
      }
    }

    const request: AgentRequest = {
      op: 'publish_samba_config',
      shares: rows.map((row) => ({
        name: row.name,
        dataset: row.dataset,
        read_only: row.read_only,
      })),
    };

    const response = await this.agent.call(
      request,
      `publish ${rows.length} samba share(s) for organization ${organizationId}`,
      correlationId,
    );

    if (response.status === 'smb_unavailable') {
      // Nothing is being served, so nothing may be reported as published. Clearing here is what
      // keeps the list honest after Samba is uninstalled under a running appliance.
      this.smbInstalled = 'no';
      this.publishedShareIds = new Set();
      // Logged rather than shown: the agent names the missing binary, which is the detail an
      // operator needs and a user cannot act on. `agentReason` rides along on the error for the
      // same reason `AgentRefusedError` carries one — so a caller that wants it has it.
      this.logger.warn(`samba is not available on this box: ${response.reason}`);
      throw new SmbUnavailableError(response.reason);
    }

    if (response.status === 'refused') {
      // The agent rolled back, so whatever was being served still is: the cache is left ALONE
      // rather than cleared. Clearing it would report every working share as unpublished because
      // an unrelated new share had a bad mountpoint.
      this.logger.warn(`samba publish refused by the agent: ${response.reason}`);
      throw new AgentRefusedError(response.reason);
    }

    if (response.status === 'failed') {
      // NOT the branch above, and the difference is the whole point of separating them. `refused`
      // is the agent's word for "Samba said no and the previous configuration is back" — it maps
      // to `SambaError::RejectedRolledBack`, and every sentence `describeRefusal` returns ends by
      // promising exactly that. `failed` is everything else, and the outcome it exists to carry is
      // `SambaError::RollbackFailed`: the new configuration was rejected AND putting the old one
      // back also failed, which the agent describes as SMB being down until somebody repairs the
      // file by hand. Answering that with "the previous one has been put back, so shares that were
      // working still are" is the one lie this endpoint must never tell, because it is told at the
      // exact moment an operator needs to go and look.
      //
      // The cache is cleared here where the refusal leaves it alone. After a `failed` nothing on
      // this box may be claimed as served: `published: false` withholds, and the recovery from a
      // false `false` is one click on republish while the recovery from a false `true` is an
      // administrator being told their shares are fine while Explorer shows nothing.
      this.publishedShareIds = new Set();
      this.logger.error(
        `samba publish FAILED and the previous configuration may not have been restored: ` +
          `${response.reason}`,
      );
      throw new SmbPublishFailedError(response.reason);
    }

    if (response.status !== 'published') {
      throw new AgentUnavailableError(
        `expected a 'published' answer, the agent answered '${response.status}'`,
      );
    }

    // Only now, and only from a response that carries `verified`. The agent never returns
    // `verified: false` — a publish it cannot prove rolls back and comes back as a refusal — but
    // the field is in the contract precisely so a client can tell "a file was written" from
    // "a client connected and saw the shares", and treating it as decoration here would be the
    // API deciding that distinction does not matter.
    this.smbInstalled = 'yes';
    this.publishedShareIds = response.verified ? new Set(rows.map((row) => row.id)) : new Set();

    return { shares: response.shares, verified: response.verified };
  }

  private async rows(organizationId: string): Promise<ShareRow[]> {
    return this.db.withTenant(organizationId, (q) =>
      q.query<ShareRow>(
        `SELECT id::text AS id, name, dataset, read_only
           FROM public.shares
          ORDER BY public.fold_identity(name), id`,
      ),
    );
  }
}

/**
 * `\\host\share`, the string a person types into Explorer.
 *
 * Assembled from two values that are both already constrained — `DEPSIS_SMB_HOST` by the config
 * schema, `name` by `shares_name_format` — so this does no escaping. There is no escaping to do: a
 * UNC path has no quoting rules, and a name that needed some would be a name neither the database
 * nor the agent would have accepted in the first place.
 */
export function uncPath(host: string, shareName: string): string {
  return `\\\\${host}\\${shareName}`;
}

/**
 * The agent's refusal, as a sentence for a person.
 *
 * Reached ONLY for `Response::Refused`, which the agent returns for `RejectedRolledBack` and
 * `Unrepresentable` — the two outcomes in which the previous configuration is provably still in
 * place. `Response::Failed` does not come here, because the promise every branch below makes is
 * the one thing that is false when a rollback fails.
 *
 * This reads the agent's prose, which everywhere else in this codebase is the thing not to do —
 * `Response::NotFound` and `Response::Conflict` exist as separate variants specifically so the API
 * does not match on text. The exception is deliberate and narrow: nothing here BRANCHES on the
 * prose. The HTTP status comes from the response's `status` alone; this function only chooses
 * which sentence to show, and every branch says the same operationally important thing — the
 * previous configuration is back and the shares that worked still work.
 *
 * The one cause worth naming is the missing `include` line, because it is both the most likely
 * refusal on a fresh install and the only one the reader can fix in ten seconds. Without it they
 * are told "Samba said no" and given a journal to go and read.
 *
 * What would remove this function: a machine-readable reason on `Response::Refused` for this
 * operation. That is a change to the Rust-side contract, so it is noted rather than made.
 */
export function describeRefusal(agentReason: string): string {
  if (agentReason.includes('include =')) {
    return (
      'Samba is running but has never read the configuration DEPSIS writes. Add the line ' +
      '`include = /etc/samba/depsis.conf` to /etc/samba/smb.conf and reload smbd, then try again. ' +
      'The previous configuration has been put back, so shares that were working still are.'
    );
  }
  if (agentReason.includes('cannot be shared') || agentReason.includes('cannot be written')) {
    return (
      'One of the shares cannot be expressed as a Samba share — usually a dataset with no ' +
      'mountpoint, or one mounted somewhere Samba will not serve. Nothing was changed and the ' +
      'previous configuration is still in place.'
    );
  }
  return (
    'Samba did not accept the new configuration. The previous one has been put back, so shares ' +
    'that were working still are. The agent recorded the reason in the system journal.'
  );
}
