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
      reason: string;
      status: 'refused';
    }
  | {
      reason: string;
      status: 'failed';
    };
