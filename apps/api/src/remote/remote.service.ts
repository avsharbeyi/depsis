import { Injectable, Logger } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';

import {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  type AgentRequest,
  type AgentResponse,
} from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';

type Schemas = OpenApi.components['schemas'];
export type RemoteStatus = Schemas['RemoteStatus'];
export type RemoteNetwork = Schemas['RemoteNetwork'];

/**
 * One network as the agent reports it, derived from the response union rather than imported.
 *
 * `@depsis/agent-protocol` owns the shape (ADR-0006) and `Extract` keeps this file tied to the
 * generated union: if the agent renames a field, this alias stops matching and every use of it
 * fails to compile, which is the point.
 */
type AgentNetwork = Extract<AgentResponse, { status: 'zerotier_networks' }>['networks'][number];

/**
 * Exactly sixteen lowercase hexadecimal digits.
 *
 * The same rule as `NetworkId` in `services/system-agent/src/op.rs` and as
 * `remote_networks_id_format` in migration 0013. Three copies is deliberate: this value is
 * concatenated into a request path on the privileged side, and the cost of checking it in three
 * places is far below the cost of the one place that forgot.
 */
export const NETWORK_ID = /^[0-9a-f]{16}$/u;

/**
 * zerotier-one is not installed here, or is not running, or its local API answered with a fault.
 *
 * The API turns this into 503 and never into 500 (ADR-0020). `detail` is safe to show: it is
 * either one of the agent's two `zerotier_unavailable` reasons — both of which name a file path or
 * a socket address and nothing else — or a fixed sentence written here. The local API's own error
 * text never reaches it, because that text can quote a response body.
 */
export class RemoteUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`remote access is unavailable: ${detail}`);
    this.name = 'RemoteUnavailableError';
  }
}

/** This organisation already has an active row for that network. The partial index said so. */
export class NetworkAlreadyJoinedError extends Error {
  constructor() {
    super('this device has already joined that network');
    this.name = 'NetworkAlreadyJoinedError';
  }
}

/**
 * No active `remote_networks` row for this organisation and that id.
 *
 * Covers "never joined", "already left", and "joined by another organisation" as one answer, the
 * same way `UserNotFoundError` does — the daemon is device-wide while the table is tenant-scoped,
 * so distinguishing them would tell one tenant something about another.
 */
export class NetworkNotJoinedError extends Error {
  constructor() {
    super('this device has not joined that network');
    this.name = 'NetworkNotJoinedError';
  }
}

interface NetworkRow {
  network_id: string;
  label: string | null;
  joined_at: Date;
}

/**
 * Remote access over ZeroTier (ADR-0020).
 *
 * The daemon is the source of truth and this table is the audit record — which network, whose
 * decision, when. That ordering is why the two writing paths look asymmetric: joining calls the
 * agent BEFORE inserting, so a refusal cannot leave a row claiming a membership that does not
 * exist; leaving reads the row FIRST, so the device is never removed from a network this tenant
 * has no record of joining.
 *
 * The token that reaches ZeroTier's local API lives in the agent and is never held here (ADR-0020).
 * Nothing in this file can log it, because nothing in this file has it.
 */
@Injectable()
export class RemoteService {
  private readonly logger = new Logger(RemoteService.name);

  constructor(
    private readonly agent: AgentService,
    private readonly db: DbService,
  ) {}

  /**
   * The node, and the networks it has joined.
   *
   * Two privileged calls under one correlation id, then one tenant-scoped read to attach the two
   * facts the daemon does not have: the label somebody typed, and when DEPSIS recorded the join.
   */
  async status(organizationId: string, correlationId: string): Promise<RemoteStatus> {
    const node = await this.ask(
      { op: 'zerotier_status' },
      'remote access: read the local node',
      correlationId,
    );
    if (node.status !== 'zerotier_status') throw this.unexpected('zerotier_status', node);

    const joined = await this.ask(
      { op: 'zerotier_networks' },
      'remote access: list joined networks',
      correlationId,
    );
    if (joined.status !== 'zerotier_networks') throw this.unexpected('zerotier_networks', joined);

    const records = await this.records(organizationId);

    // The daemon's list, not the table's. A row whose network the daemon no longer reports is a
    // divergence — somebody ran `zerotier-cli leave` on the box — and listing it would show the
    // user a working remote connection that does not exist. It is logged instead, because the
    // opposite mistake (a silent divergence) is what makes an audit table worthless.
    for (const record of records.values()) {
      if (!joined.networks.some((n) => n.network_id === record.network_id)) {
        this.logger.warn(
          `remote_networks has an active row for ${record.network_id} but zerotier-one does not ` +
            'report it as joined; the daemon is the source of truth and the row is stale',
        );
      }
    }

    return {
      // Always true on this path, because the contract answers 503 for a daemon that is absent or
      // stopped rather than a 200 carrying `available: false`. See the note in the module.
      available: true,
      nodeId: node.node_id,
      online: node.online,
      version: node.version,
      networks: joined.networks.map((network) => {
        const record = records.get(network.network_id);
        return toRemoteNetwork(network, record?.label ?? null, record?.joined_at ?? null);
      }),
    };
  }

  /**
   * Join a network, then record who did it.
   *
   * The agent runs first and that order is load-bearing. Inserting first would leave a row naming a
   * network the device never joined whenever the agent refuses — and this table exists to answer
   * "which networks is this appliance reachable from?", which a false positive ruins.
   */
  async join(
    organizationId: string,
    userId: string,
    networkId: string,
    label: string | null,
    correlationId: string,
  ): Promise<RemoteNetwork> {
    const joined = await this.ask(
      { op: 'zerotier_join', network_id: networkId },
      `remote access: join network ${networkId}`,
      correlationId,
    );
    if (joined.status !== 'zerotier_joined') throw this.unexpected('zerotier_joined', joined);

    try {
      const rows = await this.db.withTenant(organizationId, (q) =>
        q.query<{ label: string | null; joined_at: Date }>(
          `INSERT INTO public.remote_networks (organization_id, joined_by, network_id, label)
           VALUES ($1, $2, $3, $4)
           RETURNING label, joined_at`,
          [organizationId, userId, networkId, label],
        ),
      );
      const row = rows[0];
      if (row === undefined) throw new Error('the remote_networks row was not returned');
      return toRemoteNetwork(joined.network, row.label, row.joined_at);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Joining is idempotent at the daemon, so the call above changed nothing: the device was
        // already a member and this organisation already has the row. 409 is the honest answer and
        // no compensating leave is owed.
        throw new NetworkAlreadyJoinedError();
      }
      // Joined, unrecorded. Deliberately NOT compensated with a leave: the device may have been a
      // member before this request, and undoing somebody else's membership because our INSERT
      // failed is a worse outcome than a missing audit row. `GET /remote` still reports the
      // membership, because it reads the daemon.
      this.logger.error(
        `joined ZeroTier network ${networkId} [${correlationId}] but the audit row could not be ` +
          `written: ${describe(error)}`,
      );
      throw error;
    }
  }

  /**
   * Leave a network this organisation joined through DEPSIS.
   *
   * The row is read first, and that order is as deliberate as the reverse one in `join`. Calling
   * the agent first would let any administrator remove the appliance from any network the daemon
   * happens to be in — including one another tenant joined, or one an operator set up by hand —
   * on the strength of a sixteen-digit string.
   */
  async leave(organizationId: string, networkId: string, correlationId: string): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id
           FROM public.remote_networks
          WHERE organization_id = $1 AND network_id = $2 AND left_at IS NULL`,
        [organizationId, networkId],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new NetworkNotJoinedError();

    const left = await this.ask(
      { op: 'zerotier_leave', network_id: networkId },
      `remote access: leave network ${networkId}`,
      correlationId,
    );
    if (left.status !== 'zerotier_left') throw this.unexpected('zerotier_left', left);

    // The row is closed rather than deleted: rejoining writes a new row, and "who put this
    // appliance on that network, and for how long" stays answerable (migration 0013).
    await this.db.withTenant(organizationId, (q) =>
      q.query(`UPDATE public.remote_networks SET left_at = now() WHERE id = $1 AND left_at IS NULL`, [
        row.id,
      ]),
    );
  }

  /** The active rows for this tenant, by network id. RLS makes the scoping structural. */
  private async records(organizationId: string): Promise<Map<string, NetworkRow>> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<NetworkRow>(
        `SELECT network_id, label, joined_at
           FROM public.remote_networks
          WHERE organization_id = $1 AND left_at IS NULL`,
        [organizationId],
      ),
    );
    return new Map(rows.map((row) => [row.network_id, row]));
  }

  /**
   * One privileged call, with the three answers that are not an answer already translated.
   *
   * Every caller would otherwise repeat the same four branches, and the one that forgot
   * `zerotier_unavailable` would turn a stopped daemon into a 500 — the exact failure ADR-0020's
   * verification checks for.
   */
  private async ask(
    request: AgentRequest,
    reason: string,
    correlationId: string,
  ): Promise<AgentResponse> {
    const response = await this.agent.call(request, reason, correlationId);

    if (response.status === 'zerotier_unavailable') {
      // Passed through, unlike the two below. The agent produces this only for `NoToken` and
      // `NotRunning`, whose messages name `/var/lib/zerotier-one/authtoken.secret` and
      // `127.0.0.1:9993` — no token, and exactly the difference between "run apt install" and
      // "start the service" that the operator needs.
      throw new RemoteUnavailableError(oneLine(response.reason));
    }

    if (response.status === 'refused') {
      throw new AgentRefusedError(oneLine(response.reason));
    }

    if (response.status === 'failed') {
      // Withheld. A failure here is the local API's own text — an HTTP status, a parse error, or a
      // fragment of a response body — and none of it is actionable by the caller while all of it
      // describes the privileged side's internals. It goes to the journal beside the agent's own
      // audit entry for the same correlation id (§16).
      this.logger.error(
        `${request.op} failed [${correlationId}]: ${oneLine(response.reason)}`,
      );
      throw new RemoteUnavailableError(
        'the local ZeroTier API answered with a fault; see the system log for this request',
      );
    }

    return response;
  }

  /**
   * The agent answered something this build does not expect.
   *
   * A version mismatch or a bug, not a state of the world, so it is `AgentUnavailableError` rather
   * than `RemoteUnavailableError`: the caller should retry rather than be told ZeroTier is off.
   */
  private unexpected(wanted: string, got: AgentResponse): Error {
    return new AgentUnavailableError(`expected a ${wanted} answer, got '${got.status}'`);
  }
}

/**
 * The agent's network plus the two things only DEPSIS knows.
 *
 * `authorized` is `status === 'OK'` and nothing looser. `ACCESS_DENIED` means joined and NOT
 * approved, `REQUESTING_CONFIGURATION` means the answer has not arrived yet, and both carry no
 * traffic — reporting either as authorized is how a user concludes the product is broken while
 * waiting for a tick-box in ZeroTier Central (ADR-0020).
 */
export function toRemoteNetwork(
  network: AgentNetwork,
  label: string | null,
  joinedAt: Date | null,
): RemoteNetwork {
  return {
    networkId: network.network_id,
    name: network.name ?? null,
    label,
    status: network.status,
    authorized: network.status === 'OK',
    addresses: network.addresses,
    joinedAt: joinedAt === null ? null : joinedAt.toISOString(),
  };
}

/** `remote_networks_active_unique` — the partial index on (organization_id, network_id). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

/**
 * One line, capped.
 *
 * A newline in a value that reaches a log is a log-injection primitive against an append-only
 * journal, and an unbounded one in a Problem Details document is a way to push arbitrary text onto
 * somebody else's screen.
 */
function oneLine(reason: string): string {
  const flat = reason.replace(/\s+/gu, ' ').trim();
  if (flat === '') return 'no reason given';
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
