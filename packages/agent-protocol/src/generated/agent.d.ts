/**
 * GENERATED FROM schema/agent.schema.json — DO NOT EDIT.
 *
 * The schema is emitted by `depsis-agent --emit-schema`; the Rust crate owns it (ADR-0006).
 * Regenerate with `pnpm --filter @depsis/agent-protocol generate`.
 */
/**
 * The closed operation set.
 *
 * Every variant is something the API cannot do for itself because it needs root. Nothing here
 * takes a command, a shell fragment, or a free-form argument list.
 */
export type AgentRequest =
  | {
      op: 'ping';
    }
  | {
      op: 'pool_status';
      pool: DatasetName;
    }
  | {
      /**
       * Only `posixacl` is expressible. See `AclType`.
       */
      acltype: 'posixacl';
      dataset: DatasetName;
      op: 'create_dataset';
      /**
       * Per-user visible limit. `refquota` excludes snapshots, so admin snapshot policy
       * cannot block a user out of their own space (ADR-0008).
       */
      refquota_bytes?: number | null;
    }
  | {
      dataset: DatasetName;
      name: SafeComponent;
      op: 'create_snapshot';
    }
  | {
      dataset: DatasetName;
      from: SafeComponent;
      op: 'diff_snapshots';
      to: SafeComponent;
    }
  | {
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      disk_by_id: string;
      op: 'read_smart_summary';
    }
  | {
      op: 'publish_samba_config';
      shares: ShareSpec[];
    }
  | {
      op: 'open_transfer';
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      share: string;
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      staging_name: string;
    }
  | {
      /**
       * Where it lands, relative to the share root. Components are validated individually.
       */
      destination: SafeComponent[];
      /**
       * How many bytes the caller believes are staged.
       *
       * Checked, not trusted. The agent must not rest on the API's belief that an upload
       * finished (ADR-0006): a client that dies at 90% plus a buggy API would otherwise rename a
       * short file to the user's chosen name, and RENAME_NOREPLACE then makes that name
       * permanently unavailable to the good copy.
       */
      expected_bytes: number;
      op: 'publish_transfer';
      owner_gid: number;
      /**
       * Who owns the file once it lands.
       *
       * On PUBLISH rather than on `OpenTransfer`, deliberately. Staging happens inside the share
       * — `.depsis/staging/` — so a staging file owned by the tenant is a file the tenant can
       * reach over SMB and rewrite while the agent is still appending to it. Root-owned until
       * the moment it becomes visible under its real name is the only window that closes.
       *
       * The agent refuses uid or gid 0. Not because a root-owned file in a share is a privilege
       * escalation — it is not, the mode is 0600 and nothing is setuid — but because it is
       * precisely the broken state these two fields exist to fix, and an API that omits the
       * mapping should fail loudly rather than reproduce the bug.
       */
      owner_uid: number;
      share: SafeComponent;
      staging_name: SafeComponent;
    }
  | {
      op: 'open_download';
      /**
       * Where the file is, relative to the share root. Components are validated individually,
       * so no element can be `..`, a separator or an absolute-looking string.
       */
      path: SafeComponent[];
      share: SafeComponent;
    }
  | {
      op: 'discard_transfer';
      share: SafeComponent;
      staging_name: SafeComponent;
    }
  | {
      op: 'zerotier_status';
    }
  | {
      op: 'zerotier_networks';
    }
  | {
      network_id: NetworkId;
      op: 'zerotier_join';
    }
  | {
      network_id: NetworkId;
      op: 'zerotier_leave';
    };
/**
 * A ZFS dataset name, e.g. `tank/depsis/users/1001`.
 *
 * The leading-dash check is not paranoia: P0-E's whole point is that `zfs`, `zpool`,
 * `smbcacls` and `smartctl` parse their own argv, so an operand that begins with `-` becomes a
 * flag even when it arrives as a separate argument. Inserting `--` helps but is not sufficient
 * because these tools do not all honour it consistently, so the value is rejected outright.
 */
export type DatasetName = string;
/**
 * A single path component under a share root — never a path, never absolute.
 *
 * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
 * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
 * `/` or `..` through, so this type refuses them rather than sanitising.
 */
export type SafeComponent = string;
/**
 * A ZeroTier network id: exactly sixteen lowercase hexadecimal digits.
 *
 * Its own type, next to `SafeComponent`, for the same reason and one more. The value is
 * CONCATENATED INTO A REQUEST PATH (`/network/<id>`) and into an HTTP request line, so a
 * `String` here would have to be remembered at every call site — and the site that forgot
 * would be the one that let `../` reach the local API's router, or a `\r\n` split one request
 * into two. A type is a validation nobody can skip.
 *
 * Uppercase is REFUSED rather than folded to lowercase. ZeroTier prints ids in lowercase and
 * the same value is a key in `public.remote_networks`, so accepting two spellings for one
 * network means the audit trail and the table can end up holding both, and "is this the
 * network we joined?" stops being a string comparison.
 */
export type NetworkId = string;

export interface ShareSpec {
  dataset: DatasetName;
  name: SafeComponent;
  read_only: boolean;
}

export type AgentResponse =
  | {
      schema_version: number;
      status: 'ok';
    }
  | {
      available_bytes: number;
      health: string;
      status: 'pool_status';
      used_bytes: number;
    }
  | {
      dataset: string;
      status: 'created';
    }
  | {
      full_name: string;
      status: 'snapshot';
    }
  | {
      lines: string[];
      status: 'diff';
    }
  | {
      healthy: boolean;
      raw: string;
      status: 'smart';
      temperature_celsius?: number | null;
    }
  | {
      shares: number;
      status: 'published';
    }
  | {
      offset: number;
      status: 'transfer';
      token: string;
    }
  | {
      bytes: number;
      status: 'publish';
    }
  | {
      size: number;
      status: 'download';
      token: string;
    }
  | {
      existed: boolean;
      status: 'discarded';
    }
  | {
      node_id: string;
      online: boolean;
      status: 'zerotier_status';
      version: string;
    }
  | {
      networks: ZeroTierNetwork[];
      status: 'zerotier_networks';
    }
  | {
      network: ZeroTierNetwork;
      status: 'zerotier_joined';
    }
  | {
      network_id: string;
      status: 'zerotier_left';
    }
  | {
      reason: string;
      status: 'zerotier_unavailable';
    }
  | {
      reason: string;
      status: 'refused';
    }
  | {
      reason: string;
      status: 'failed';
    };
/**
 * A joined network's membership state, as ZeroTier reports it.
 */
export type ZeroTierNetworkStatus =
  | ('OK' | 'NOT_FOUND' | 'REQUESTING_CONFIGURATION' | 'PORT_ERROR' | 'AUTHENTICATION_REQUIRED')
  | 'ACCESS_DENIED'
  | 'UNKNOWN';

/**
 * One joined network, as the agent reports it.
 *
 * A typed projection, not the daemon's JSON. Passing the raw object through would make every
 * field ZeroTier ever adds part of the DEPSIS contract, and would put the agent in the position
 * of forwarding something it has not read.
 */
export interface ZeroTierNetwork {
  /**
   * The addresses this network assigned to the node, in CIDR form. Empty until the network
   * authorizes the device, which is what makes an empty list here meaningful rather than a
   * missing value.
   */
  addresses: string[];
  name?: string | null;
  network_id: string;
  status: ZeroTierNetworkStatus;
}
