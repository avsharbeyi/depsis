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
      owner_gid: PosixId;
      /**
       * A numeric POSIX uid or gid, inside the range migration 0015 reserved for DEPSIS.
       *
       * A type rather than a comparison, for the reason `AclType` is a type: the agent exists not to
       * trust the API, and a rule the API is asked to follow is not a rule the agent enforces. Before
       * this, the privileged side refused the value 0 and nothing else — so uid 33 (`www-data`), gid 27
       * (`sudo`), gid 42 (`shadow`) and the appliance's own service accounts were all accepted operands
       * of `PublishTransfer`, `CreateDirectory` and `AclEntry`. The 300000-399999 range that 0015
       * introduced *precisely* so that "sistem gruplarıyla çakışan bir gid, cihazdaki bir servis
       * hesabına kullanıcının dosyalarını açmaktır" was enforced in exactly two places, both
       * unprivileged: the `CHECK` constraints and `assertUsable` in `posix.service.ts`.
       *
       * The agent's own stated reason for refusing 0 — an API that skipped the uid mapping must fail
       * loudly here — applies with the same force to an API that mapped it to the WRONG number, and
       * that was the case being waved through. Now a system id cannot be expressed in a request at all,
       * the same way `nfsv4` cannot be expressed at dataset creation.
       *
       * The bounds are duplicated from `0015_teams_and_grants.sql` rather than read from anywhere. That
       * is deliberate and it is the point: the agent must not depend on the database to know what it
       * will accept, because the database is on the unprivileged side of the boundary.
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
      /**
       * Where it is now, relative to the share root. The last element is the entry's own name.
       */
      from: SafeComponent[];
      op: 'move_entry';
      share: SafeComponent;
      /**
       * Where it goes, relative to the same share root. The last element is the new name; the
       * elements before it must already exist and be directories.
       */
      to: SafeComponent[];
    }
  | {
      /**
       * Is the entry a directory? The caller knows and has to say.
       */
      directory: boolean;
      op: 'remove_entry';
      path: SafeComponent[];
      share: SafeComponent;
    }
  | {
      op: 'create_directory';
      owner_gid: PosixId;
      /**
       * A numeric POSIX uid or gid, inside the range migration 0015 reserved for DEPSIS.
       *
       * A type rather than a comparison, for the reason `AclType` is a type: the agent exists not to
       * trust the API, and a rule the API is asked to follow is not a rule the agent enforces. Before
       * this, the privileged side refused the value 0 and nothing else — so uid 33 (`www-data`), gid 27
       * (`sudo`), gid 42 (`shadow`) and the appliance's own service accounts were all accepted operands
       * of `PublishTransfer`, `CreateDirectory` and `AclEntry`. The 300000-399999 range that 0015
       * introduced *precisely* so that "sistem gruplarıyla çakışan bir gid, cihazdaki bir servis
       * hesabına kullanıcının dosyalarını açmaktır" was enforced in exactly two places, both
       * unprivileged: the `CHECK` constraints and `assertUsable` in `posix.service.ts`.
       *
       * The agent's own stated reason for refusing 0 — an API that skipped the uid mapping must fail
       * loudly here — applies with the same force to an API that mapped it to the WRONG number, and
       * that was the case being waved through. Now a system id cannot be expressed in a request at all,
       * the same way `nfsv4` cannot be expressed at dataset creation.
       *
       * The bounds are duplicated from `0015_teams_and_grants.sql` rather than read from anywhere. That
       * is deliberate and it is the point: the agent must not depend on the database to know what it
       * will accept, because the database is on the unprivileged side of the boundary.
       */
      owner_uid: number;
      /**
       * Relative to the share root; the LAST element is the name of the directory to create.
       * Every element before it must already exist and be a directory.
       */
      path: SafeComponent[];
      share: SafeComponent;
    }
  | {
      groups: PosixGroupSpec[];
      op: 'sync_posix_identity';
      users: PosixUserSpec[];
    }
  | {
      op: 'secure_share_root';
      share: SafeComponent;
    }
  | {
      entries: AclEntry[];
      op: 'apply_folder_acl';
      /**
       * Relative to the share root. EMPTY names the share root itself, which is the ordinary
       * case for a share-wide grant. Unlike `CreateDirectory` — where an empty path would mean
       * creating the share — there is nothing to lose here: the caller already named the share,
       * and granting on the root of the tree it named is the point.
       *
       * `.depsis/` is refused, like everywhere else a caller-supplied path is accepted.
       */
      path: SafeComponent[];
      share: SafeComponent;
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
 * A name that may appear in `valid users`.
 *
 * A TYPE rather than a `Vec<String>`, and the reason is the file this ends up in. `smb.conf` is
 * line-oriented and has no escaping: a principal containing a newline would not be a malformed
 * name, it would be a new DIRECTIVE: a line break followed by `guest ok = yes`, appended by
 * whatever the API believed was a username. `PosixName` already forbids every character that could do it, so reusing it
 * here means the injection is unrepresentable rather than filtered.
 *
 * The user/group split is an enum rather than a leading `@` in the string for the same reason.
 * `@` is not a legal `PosixName` character, so a caller wanting a group cannot smuggle one
 * through the user variant; the sigil is added by the renderer, which is the only place that
 * knows Samba's syntax.
 */
export type SmbPrincipal =
  | {
      kind: 'user';
      name: PosixName;
    }
  | {
      kind: 'group';
      name: PosixName;
    };
/**
 * A Unix login name the agent is willing to create.
 *
 * THE ONE CALLER-SUPPLIED STRING IN THE IDENTITY OPERATION, and it is supplied for a reason worth
 * stating: the alternative is deriving the account name from the uid, which works perfectly and
 * tells a person to type `depsis-u-300001` into Windows. Group names ARE derived, because nobody
 * types one.
 *
 * The shape is exactly migration 0010's `users_username_format` — `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
 * — re-stated here rather than inherited, because §2.2 is that the agent does not trust the API.
 * Debian's `useradd` was measured accepting every string this admits, leading digits, uppercase
 * and 64 characters included, so a name the database allows is a name the agent can create.
 *
 * What it CANNOT express is the shape that would matter: no NUL, no slash, no leading dash, no
 * space. A name beginning with a dash would become a flag to `useradd` — and unlike `zfs`, which
 * at least fails, `useradd -M` would be read as a valid option.
 *
 * It does NOT prevent naming a system account: `root` and `postgres` both match. That check
 * cannot be a type because it is a question about the machine, and `identity::sync` asks it
 * against `getent` before creating anything.
 */
export type PosixName = string;
/**
 * A numeric POSIX uid or gid, inside the range migration 0015 reserved for DEPSIS.
 *
 * A type rather than a comparison, for the reason `AclType` is a type: the agent exists not to
 * trust the API, and a rule the API is asked to follow is not a rule the agent enforces. Before
 * this, the privileged side refused the value 0 and nothing else — so uid 33 (`www-data`), gid 27
 * (`sudo`), gid 42 (`shadow`) and the appliance's own service accounts were all accepted operands
 * of `PublishTransfer`, `CreateDirectory` and `AclEntry`. The 300000-399999 range that 0015
 * introduced *precisely* so that "sistem gruplarıyla çakışan bir gid, cihazdaki bir servis
 * hesabına kullanıcının dosyalarını açmaktır" was enforced in exactly two places, both
 * unprivileged: the `CHECK` constraints and `assertUsable` in `posix.service.ts`.
 *
 * The agent's own stated reason for refusing 0 — an API that skipped the uid mapping must fail
 * loudly here — applies with the same force to an API that mapped it to the WRONG number, and
 * that was the case being waved through. Now a system id cannot be expressed in a request at all,
 * the same way `nfsv4` cannot be expressed at dataset creation.
 *
 * The bounds are duplicated from `0015_teams_and_grants.sql` rather than read from anywhere. That
 * is deliberate and it is the point: the agent must not depend on the database to know what it
 * will accept, because the database is on the unprivileged side of the boundary.
 */
export type PosixId = number;
/**
 * An NTLM password hash — `MD4(UTF-16LE(password))`, uppercase hex.
 *
 * A TYPE rather than a `String`, because the failure it prevents is silent. The smbpasswd import
 * format is fixed-width: a lowercase or short field produces a line `pdbedit` accepts and a user
 * who cannot log in, with no error anywhere. `tools/poc/p2-b-smb-password.sh` measured that shape
 * of failure from the other direction with the `LCT` field.
 *
 * The agent never computes this and never sees a password. The API computes it — see
 * `apps/api/src/auth/nt-hash.ts`, which carries its own MD4 because OpenSSL 3 moved MD4 to the
 * legacy provider and Node cannot reach it. What crosses the boundary is password-EQUIVALENT for
 * one protocol, which is worse than nothing and much better than the user's actual password.
 */
export type NtHash = string;
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
  /**
   * Who smbd will let connect to this share at all.
   *
   * Empty means the line is not written and every principal the operator's `[global]`
   * authenticates may connect — which is what this file did before the field existed, and is
   * still the honest rendering of "the API named nobody". It is NOT rendered as an empty
   * `valid users =`: Samba reads that as no restriction, so the two cases would produce
   * different text with the same meaning and one of them would look like a closed door.
   */
  valid_users?: SmbPrincipal[];
}
/**
 * One group and the membership it must END UP with.
 */
export interface PosixGroupSpec {
  gid: PosixId;
  /**
   * EXACT, not additive. `gpasswd -M` replaces the whole list, which is what makes a member who
   * left the team actually leave the group — an additive sync would let their ACL access
   * outlive the grant that justified it.
   */
  members: PosixId[];
}
/**
 * One account the appliance must have, as the wire carries it.
 */
export interface PosixUserSpec {
  login: PosixName;
  /**
   * Absent leaves the existing password alone. A user who has not set one since this feature
   * existed has no passdb entry at all, which is the honest state rather than a broken one:
   * they cannot reach SMB until they next change their password.
   */
  nt_hash?: NtHash | null;
  uid: PosixId;
}
/**
 * One POSIX ACL entry: a GROUP and the three permission bits.
 *
 * There is no `uid` field and there must not be one. ADR-0004 chose the grant model, and this
 * struct is where the choice is enforced rather than remembered: POSIX ACLs become unwieldy past
 * roughly thirty entries and the mask semantics start biting, so a share-role is a POSIX group and
 * users join groups. A per-user entry is expressible in the syscall and wrong in the design — so
 * it is not expressible here, the same way `AclType` makes `nfsv4` unrepresentable rather than
 * checking for it.
 *
 * The bits are three booleans rather than a mode number for the same reason every other operand in
 * this file is typed: `0o755` reaching the wrong field is a silent widening, while a missing
 * `execute` is a parse error. On a directory `execute` is the bit that permits *entering* it, so a
 * read-only grant is `r-x` and not `r--`; the API decides that, because the agent does not know
 * whether the target is a directory and must not guess.
 */
export interface AclEntry {
  /**
   * On a directory this is the bit that permits entering it, not executing anything.
   */
  execute: boolean;
  /**
   * A numeric POSIX uid or gid, inside the range migration 0015 reserved for DEPSIS.
   *
   * A type rather than a comparison, for the reason `AclType` is a type: the agent exists not to
   * trust the API, and a rule the API is asked to follow is not a rule the agent enforces. Before
   * this, the privileged side refused the value 0 and nothing else — so uid 33 (`www-data`), gid 27
   * (`sudo`), gid 42 (`shadow`) and the appliance's own service accounts were all accepted operands
   * of `PublishTransfer`, `CreateDirectory` and `AclEntry`. The 300000-399999 range that 0015
   * introduced *precisely* so that "sistem gruplarıyla çakışan bir gid, cihazdaki bir servis
   * hesabına kullanıcının dosyalarını açmaktır" was enforced in exactly two places, both
   * unprivileged: the `CHECK` constraints and `assertUsable` in `posix.service.ts`.
   *
   * The agent's own stated reason for refusing 0 — an API that skipped the uid mapping must fail
   * loudly here — applies with the same force to an API that mapped it to the WRONG number, and
   * that was the case being waved through. Now a system id cannot be expressed in a request at all,
   * the same way `nfsv4` cannot be expressed at dataset creation.
   *
   * The bounds are duplicated from `0015_teams_and_grants.sql` rather than read from anywhere. That
   * is deliberate and it is the point: the agent must not depend on the database to know what it
   * will accept, because the database is on the unprivileged side of the boundary.
   */
  gid: number;
  read: boolean;
  write: boolean;
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
      verified: boolean;
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
      status: 'moved';
    }
  | {
      status: 'removed';
    }
  | {
      status: 'directory_created';
    }
  | {
      groups_created: number;
      passwords_set: number;
      status: 'posix_identity_synced';
      users_created: number;
    }
  | {
      mode: number;
      status: 'share_root_secured';
    }
  | {
      entries: number;
      status: 'acl_applied';
    }
  | {
      reason: string;
      status: 'acl_unavailable';
    }
  | {
      reason: string;
      status: 'not_found';
    }
  | {
      reason: string;
      status: 'conflict';
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
      status: 'smb_unavailable';
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
