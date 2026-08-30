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
      op: 'zerotier_peers';
    }
  | {
      /**
       * A snapshot both sides already have, for an incremental send.
       *
       * Absent means a FULL send. The caller decides rather than the agent guessing: a full
       * send of a terabyte is not something to start on the agent's own initiative, and the
       * caller is the only side that knows what the target already holds.
       */
      base?: SafeComponent | null;
      op: 'replicate_dataset';
      snapshot: SafeComponent;
      /**
       * A ZFS dataset name, e.g. `tank/depsis/users/1001`.
       *
       * The leading-dash check is not paranoia: P0-E's whole point is that `zfs`, `zpool`,
       * `smbcacls` and `smartctl` parse their own argv, so an operand that begins with `-` becomes a
       * flag even when it arrives as a separate argument. Inserting `--` helps but is not sufficient
       * because these tools do not all honour it consistently, so the value is rejected outright.
       */
      source: string;
      /**
       * A ZFS dataset name, e.g. `tank/depsis/users/1001`.
       *
       * The leading-dash check is not paranoia: P0-E's whole point is that `zfs`, `zpool`,
       * `smbcacls` and `smartctl` parse their own argv, so an operand that begins with `-` becomes a
       * flag even when it arrives as a separate argument. Inserting `--` helps but is not sufficient
       * because these tools do not all honour it consistently, so the value is rejected outright.
       */
      target: string;
    }
  | {
      dataset: DatasetName;
      op: 'list_snapshots';
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
      op: 'list_disks';
    }
  | {
      op: 'list_processes';
    }
  | {
      op: 'list_pools';
    }
  | {
      op: 'share_root_status';
    }
  | {
      op: 'prepare_share_root';
      pool: SafeComponent;
    }
  | {
      container_gid: number;
      container_uid: number;
      directory: SafeComponent;
      op: 'prepare_app_data_dir';
      share: SafeComponent;
    }
  | {
      /**
       * The members, each named twice.
       */
      disks: DiskRef[];
      op: 'create_pool';
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      pool: string;
      topology: PoolTopology;
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
       * The file to read, relative to the share root. The last element is its name.
       */
      from: SafeComponent[];
      /**
       * The most this call will copy before returning.
       *
       * THE SLICE IS WHY THIS FIELD EXISTS. The control socket is served strictly one connection
       * at a time (`unix.rs`), so whatever this call does, nothing else on the appliance can ask
       * the agent anything — no listing, no upload, no folder creation. Copying a whole file
       * here would make a 50 GB copy a total control-plane outage, and the API's own 60-second
       * call budget would make such a file impossible to copy at all: every attempt would time
       * out, and each of the twenty retries would leave another full-size staging file behind.
       *
       * So the caller asks for a slice and calls again. The agent bounds it too — see
       * `MAX_COPY_SLICE` — because a caller that asks for the whole file must not get it.
       */
      max_bytes: number;
      /**
       * How many bytes of the source are already staged.
       *
       * Checked against the staging file's actual length and refused on a mismatch, exactly as
       * `OpenTransfer` does: a number kept beside the data can disagree with it, and the file is
       * the authority.
       */
      offset: number;
      op: 'copy_file';
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
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      staging_name: string;
      /**
       * Where the copy goes, relative to the same share root. The last element is the new name;
       * every element before it must already exist and be a directory.
       */
      to: SafeComponent[];
    }
  | {
      op: 'list_directory';
      /**
       * Relative to the share root. Empty means the share root itself.
       */
      path: SafeComponent[];
      share: SafeComponent;
    }
  | {
      op: 'snapshot_entries';
      /**
       * Relative to the snapshot's root. Empty means the snapshot of the share root itself.
       */
      path: SafeComponent[];
      share: SafeComponent;
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      snapshot: string;
    }
  | {
      /**
       * The file to read, relative to the SNAPSHOT's root. The last element is its name.
       */
      from: SafeComponent[];
      /**
       * The most this call will copy before returning. Bounded by `MAX_COPY_SLICE`.
       */
      max_bytes: number;
      /**
       * How many bytes are already staged. The file is the authority; see `CopyFile`.
       */
      offset: number;
      op: 'restore_from_snapshot';
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
      snapshot: SafeComponent;
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      staging_name: string;
      /**
       * Where the restored copy goes, relative to the LIVE share root. The last element is the
       * new name and must not already exist; every element before it must.
       */
      to: SafeComponent[];
    }
  | {
      op: 'offsite_status';
    }
  | {
      op: 'offsite_create_identity';
    }
  | {
      host: SshHostName;
      op: 'offsite_scan_host';
      /**
       * 1..=65535. Part of the `known_hosts` lookup key, so it is an operand rather than an
       * assumption — a key confirmed for port 22 must not authorise port 2222.
       */
      port: number;
    }
  | {
      host: SshHostName;
      line: KnownHostsLine;
      op: 'offsite_trust_host';
      port: number;
    }
  | {
      /**
       * The common snapshot to send FROM, when there is one. Absent means a full send.
       */
      base?: SafeComponent | null;
      host: SshHostName;
      op: 'replicate_offsite';
      port: number;
      snapshot: SafeComponent;
      source: DatasetName;
      /**
       * A ZFS dataset name, e.g. `tank/depsis/users/1001`.
       *
       * The leading-dash check is not paranoia: P0-E's whole point is that `zfs`, `zpool`,
       * `smbcacls` and `smartctl` parse their own argv, so an operand that begins with `-` becomes a
       * flag even when it arrives as a separate argument. Inserting `--` helps but is not sufficient
       * because these tools do not all honour it consistently, so the value is rejected outright.
       */
      target: string;
      user: SshUserName;
    }
  | {
      dataset: DatasetName;
      op: 'destroy_snapshot';
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      snapshot: string;
    }
  | {
      op: 'start_scrub';
      pool: SafeComponent;
    }
  | {
      op: 'prepare_backup_root';
      passphrase: Passphrase;
      pool: SafeComponent;
    }
  | {
      op: 'backup_root_status';
      pool: SafeComponent;
    }
  | {
      op: 'load_backup_key';
      passphrase: Passphrase;
      pool: SafeComponent;
    }
  | {
      op: 'unload_backup_key';
      pool: SafeComponent;
    }
  | {
      from: SafeComponent[];
      max_bytes: number;
      offset: number;
      op: 'copy_file_to_backup';
      share: SafeComponent;
      staging_name: SafeComponent;
      to: SafeComponent[];
    }
  | {
      /**
       * Yedek ağacındaki yol (`Dosyalar/...` ya da `DEPSIS-YEDEK/silinenler/...`).
       */
      from: SafeComponent[];
      max_bytes: number;
      offset: number;
      op: 'restore_file_from_backup';
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      share: string;
      staging_name: SafeComponent;
      to: SafeComponent[];
    }
  | {
      content: string;
      name: SafeComponent;
      op: 'backup_write_meta';
    }
  | {
      op: 'backup_list_directory';
      path: SafeComponent[];
    }
  | {
      op: 'backup_create_directory';
      path: SafeComponent[];
    }
  | {
      from: SafeComponent[];
      op: 'backup_move_entry';
      to: SafeComponent[];
    }
  | {
      directory: boolean;
      op: 'backup_remove_entry';
      path: SafeComponent[];
    }
  | {
      disk: DiskRef;
      op: 'wipe_disk';
    }
  | {
      comm: string;
      op: 'kill_process';
      pid: number;
    }
  | {
      op: 'update_status';
    }
  | {
      op: 'check_update';
    }
  | {
      op: 'apply_update';
    }
  | {
      op: 'tls_status';
    }
  | {
      /**
       * PEM. Zincir de olabilir: ara sertifikalar sunucu tarafından sunulmazsa bazı istemciler
       * bağlanamaz, ve operatörün elindeki dosya çoğunlukla zaten zincirdir.
       */
      certificate: string;
      op: 'install_certificate';
      /**
       * PEM. Şifreli bir anahtar KABUL EDİLMİYOR: parolayı da istemek, o parolanın kutuda bir
       * yerde durması demek olurdu, ve dosyanın kendisi zaten 0400 kök.
       */
      private_key: string;
    }
  | {
      op: 'scrub_status';
      pool: SafeComponent;
    }
  | {
      /**
       * How many dumps to keep. Pruning only ever touches files ending in `.dump`.
       */
      keep: number;
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      name: string;
      op: 'dump_database';
    }
  | {
      /**
       * How many archives to keep. Pruning only touches `zerotier-*.tar`.
       */
      keep: number;
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      name: string;
      op: 'backup_node_identity';
    }
  | {
      op: 'list_database_dumps';
    }
  | {
      op: 'zerotier_controller_status';
    }
  | {
      op: 'zerotier_controller_networks';
    }
  | {
      /**
       * A single path component under a share root — never a path, never absolute.
       *
       * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
       * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
       * `/` or `..` through, so this type refuses them rather than sanitising.
       */
      name: string;
      op: 'zerotier_create_network';
      /**
       * The IPv4 range members are given. `/24`, RFC1918 — see `Ipv4Prefix`.
       */
      subnet: string;
    }
  | {
      network_id: NetworkId;
      op: 'zerotier_controller_members';
    }
  | {
      authorized: boolean;
      /**
       * A name for the device. Absent leaves whatever name it already had — sending an empty
       * one would erase the household's own label on the action most likely to be repeated.
       */
      label?: SafeComponent | null;
      member: NodeAddress;
      network_id: NetworkId;
      op: 'zerotier_set_member_authorized';
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
 * How the members are arranged.
 *
 * A multi-disk STRIPE is deliberately not expressible. It is the arrangement in which losing any
 * one disk loses the whole pool, and on an appliance whose purpose is keeping files it is the one
 * configuration nobody should be able to reach by picking the wrong item in a list. `Single` says
 * what a one-disk pool actually is, and says it in its own word rather than as "a stripe of one".
 */
export type PoolTopology = 'single' | 'mirror' | 'raidz1' | 'raidz2';
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
 * A host name or address that may be handed to `ssh` and to `ssh-keyscan`.
 *
 * Its own type for the reason `NetworkId` has one, with the stakes a level higher: the value
 * becomes an argv element for a program that takes `-o` options, so a "hostname" of
 * `-oProxyCommand=id` is arbitrary command execution ON THIS BOX. It also becomes half of a
 * `known_hosts` lookup key, where a stray `[`, `]` or `:` silently matches the wrong entry — and
 * the whole point of that file is that it matches the right one.
 *
 * IPv6 LITERALS ARE REFUSED rather than half-supported. `known_hosts` brackets them and so does
 * the non-default-port syntax; accepting a bare literal here would produce a key that matches
 * nothing, which reads to the user as "this host is not trusted" forever with no way to fix it.
 * An IPv6 destination therefore needs a name, and that is written down rather than discovered.
 */
export type SshHostName = string;
/**
 * A `known_hosts` line, as `ssh-keyscan` printed it and as it will be stored.
 *
 * Validated as a WHOLE LINE rather than trusted, because it is written into a file `ssh` reads
 * with the authority to decide which machine a copy of every file on this appliance goes to. A
 * newline in it would let one confirmation write two entries — the second for a host nobody was
 * shown.
 */
export type KnownHostsLine = string;
/**
 * The account on the far end. Same argument as `SshHostName`, one character narrower.
 */
export type SshUserName = string;
/**
 * Yedek diskinin parolası — ZFS'in kendi anahtarı olarak.
 *
 * ── NEDEN AYRI BİR TİP ───────────────────────────────────────────────────────────────────────
 *
 * Bu, ajanın gördüğü tek KULLANICI SIRRIDIR ve `String` olarak taşınamaz. Üç sebep, üçü de bir
 * `String`in kendiliğinden yaptığı şeyler:
 *
 * BİR — `Debug`. Bu depoda hemen her tip `#[derive(Debug)]` taşıyor ve istekler hata
 * mesajlarında, `unexpected request` dallarında ve panik yollarında basılıyor. Bir `String`
 * parola, ilk beklenmedik istekte journald'a düz metin olarak düşerdi. Buradaki `Debug`
 * elle yazılmış ve içeriği ASLA basmıyor.
 *
 * İKİ — SATIR SONU. Parola `zfs load-key`e stdin'den, bir satır olarak veriliyor. İçinde satır
 * sonu olan bir parola, ZFS'e parolanın yalnız ilk parçasını verirdi: disk kurulurken kabul
 * edilen değerle sonra açarken verilen değer birbirini tutmazdı, ve kullanıcı "parolam doğru
 * ama açılmıyor" derdi. Reddetmek, sessizce kesmekten iyi.
 *
 * ÜÇ — UZUNLUK. Alt sınır ZFS'in kendi kuralı (`keyformat=passphrase` en az sekiz bayt ister);
 * üst sınır kontrol soketinin istek satırına sığmak için. İkisi de burada reddediliyor ki
 * kullanıcı hatayı diski kurarken görsün, kurduktan sonra değil.
 */
export type Passphrase = string;
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
/**
 * A ZeroTier node address: exactly ten lowercase hexadecimal digits.
 *
 * Its own type next to `NetworkId`, for the same reason and with one extra. It is CONCATENATED
 * INTO A REQUEST PATH (`/controller/network/<nwid>/member/<address>`), so a `String` here would
 * have to be remembered at every call site. And it is the value an administrator TYPES from a
 * friend's screen — the one operand in this whole surface that arrives by human transcription —
 * so the shape check is also the typo check.
 *
 * NOT A CREDENTIAL. The address is the low 40 bits of a node's public identity; the controller
 * authenticates with the full identity and pins it on first contact, refusing any later node that
 * presents the same address with a different identity. So it is safe to display, copy and put in
 * a QR code. What it is NOT is safe to get wrong: authorizing one wrong digit admits a real
 * stranger's node, and until that node first appears there is nothing on screen to say so.
 *
 * Uppercase is REFUSED rather than folded, exactly as `NetworkId` refuses it: the controller
 * emits lowercase everywhere, and accepting two spellings means the audit trail and the member
 * list can hold both and "is this the device we authorized?" stops being a string comparison.
 */
export type NodeAddress = string;
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

export interface DiskRef {
  /**
   * A single path component under a share root — never a path, never absolute.
   *
   * ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
   * to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
   * `/` or `..` through, so this type refuses them rather than sanitising.
   */
  by_id: string;
  /**
   * The WWN the caller believes this disk has, from a `ListDisks` answer.
   *
   * NOT decoration and not a second name for the same thing. `by_id` identifies a DEVICE, and a
   * device can be unplugged and a different one put in its place between the inventory and the
   * confirmation. The agent re-reads the inventory and refuses if this does not match, which is
   * the only check in the sequence that survives somebody swapping a disk mid-wizard.
   *
   * A `String` rather than a validated type because it is COMPARED, never passed to a command:
   * it never reaches an argv, so there is no flag to smuggle and nothing to escape.
   */
  wwn: string;
}
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
      entries: DiffEntry[];
      status: 'diff';
      truncated: boolean;
    }
  | {
      api_version: number;
      controller: boolean;
      database_ready: boolean;
      /**
       * This node's own 10-hex address — the prefix of every network it can control, and the
       * address the interface must never offer to de-authorize.
       */
      node_id: string;
      status: 'zerotier_controller';
    }
  | {
      networks: ZeroTierControlledNetwork[];
      status: 'zerotier_controller_networks';
    }
  | {
      network: ZeroTierControlledNetwork;
      /**
       * What the controller silently did not apply, in sentences.
       *
       * NOT AN ERROR, because the network exists by then and calling it a failure would make
       * the next attempt create a second one. It is the difference between "your network is
       * ready" and "your network exists but hands out no addresses", and the interface has to
       * be able to say the second one.
       */
      shortfall: string[];
      status: 'zerotier_network_created';
    }
  | {
      members: ZeroTierMember[];
      status: 'zerotier_controller_members';
    }
  | {
      member: ZeroTierMember;
      status: 'zerotier_member_updated';
    }
  | {
      /**
       * What went in: some subset of identity.secret, identity.public, controller.d.
       *
       * EMPTY IS AN ANSWER, not a failure: a box with no ZeroTier installed has none of them.
       * The caller reports it as "nothing to back up" rather than as a backup that happened.
       */
      included: string[];
      name: string;
      size_bytes: number;
      status: 'node_identity_backed_up';
      /**
       * `controller.d` records that would not parse, by relative path.
       *
       * They are IN the archive — a half-written record carries more than a missing one — and
       * they are named here because `FileDB` writes without a temp file or an fsync, and a NAS
       * is exactly the device that loses power mid-write. A truncated record backed up in
       * silence is a network or a member that is simply gone on the day the archive is opened.
       */
      unreadable: string[];
    }
  | {
      /**
       * Where they are, so an operator reading the screen knows what to copy off the box.
       */
      directory: string;
      dumps: DatabaseDump[];
      status: 'database_dumps';
    }
  | {
      /**
       * The `errors:` line, verbatim.
       */
      errors: string;
      /**
       * The ONE inference: `zpool status` writes exactly "No known data errors" when there are
       * none, and anything else is a person's problem. Built this way round on purpose — the
       * opposite ("these patterns mean trouble") would silently pass a wording it had not seen.
       */
      has_errors: boolean;
      in_progress: boolean;
      /**
       * The `scan:` line, verbatim, continuation lines included. Empty when there is none.
       *
       * NOT PARSED INTO A DATE. `zpool status` is written for a person and the timestamp is in
       * the local format; turning it into an instant would mean answering "when was it last
       * scrubbed" confidently and wrongly whenever the parse missed. The reader sees what
       * `zpool status` said.
       */
      scan: string;
      status: 'scrub';
    }
  | {
      full_name: string;
      status: 'snapshot_destroyed';
    }
  | {
      /**
       * SHA-256, iki nokta ile ayrılmış. Tarayıcının uyarı ekranında karşılaştırılan şey.
       */
      fingerprint: string;
      issuer: string;
      /**
       * SAN listesi: `DNS:nas.example.com`, `IP Address:192.168.1.10`.
       */
      names: string[];
      not_after: string;
      not_before: string;
      /**
       * Konu ile veren aynı. Tarayıcı uyarısının sebebi, ve ekranda söylenmesi gereken şey.
       */
      self_signed: boolean;
      status: 'tls';
      /**
       * Sertifikanın konusu, `openssl`in yazdığı gibi.
       */
      subject: string;
    }
  | {
      /**
       * Son denetimin bulduğu sürüm. Hiç denetim yapılmadıysa yok.
       */
      available?: UpdateCandidate | null;
      checked_at?: string | null;
      /**
       * Son başarısızlığın cümlesi. Faz `failed` değilken de dolu olabilir: geri alınmış bir
       * güncellemenin sebebi, kutu yeniden çalışır hâle geldikten sonra da okunmalıdır.
       */
      error?: string | null;
      finished_at?: string | null;
      /**
       * Şu anda bir şey koşuyor mu. `phase` ile systemd'nin cevabının BİRLEŞİMİ, ve tanınmayan
       * bir faz koşuyor sayılır: bilinmezlikte doğru davranış, ikinci bir güncellemeye izin
       * vermemektir.
       */
      in_progress: boolean;
      /**
       * Kurulu commit. `install.sh` yazmadıysa YOK — ve yokluk "güncel" diye okunmaz.
       */
      installed?: string | null;
      /**
       * Güncelleyicinin günlüğünün son satırları. Uzun bir kurulumun "hâlâ yaşıyor" kanıtı.
       */
      log_tail: string[];
      /**
       * Güncelleyicinin kendi yazdığı faz, yorumlanmadan. Bilinen değerler `idle`, `checking`,
       * `downloading`, `building`, `installing`, `verifying`, `rolling_back`, `done`, `failed`.
       */
      phase: string;
      /**
       * Kutu İMZALI kipte mi: yalnız yayınlanmış ve imzalanmış sürümleri mi kuruyor.
       *
       * Kipi belirleyen şey kutudaki açık anahtarın varlığı. Bilinmiyorsa `false` — güvenin
       * kaynağı hakkında ekranda duran bir yalan, hiç bilgi vermemekten kötüdür.
       */
      signed: boolean;
      started_at?: string | null;
      status: 'update';
      /**
       * Kurulu sürüm ile bulunan sürüm aynı mı. İkisinden biri bilinmiyorsa `false`.
       */
      up_to_date: boolean;
    }
  | {
      /**
       * `256 SHA256:… depsis-offsite (ED25519)`, as `ssh-keygen -l` prints it.
       */
      fingerprint?: string | null;
      /**
       * Has a key been generated? Everything else is meaningless while this is false.
       */
      has_identity: boolean;
      /**
       * The PUBLIC half, to paste into the destination's `authorized_keys`.
       */
      public_key?: string | null;
      status: 'offsite';
      /**
       * The `known_hosts` patterns this appliance will connect to — `host` or `[host]:port`.
       */
      trusted: string[];
    }
  | {
      keys: OffsiteHostKey[];
      status: 'offsite_host_keys';
    }
  | {
      peers: ZeroTierPeer[];
      status: 'zerotier_peers';
    }
  | {
      /**
       * The send was incremental from this snapshot, or absent for a full send.
       *
       * Echoed back because the caller's request is not proof of what happened: an incremental
       * that the target refused is retried as a full send, and a job history that recorded the
       * REQUEST would say "incremental" about a transfer that moved the whole dataset.
       */
      base?: string | null;
      /**
       * What `zfs recv` printed, kept so an operator can read the real words on a bad day.
       */
      detail: string;
      status: 'replicated';
    }
  | {
      /**
       * The dataset is not there at all.
       *
       * Reported rather than collapsed into an empty list because the two mean different things
       * to the screen: "no snapshots yet" invites taking one, "no dataset" means the box has not
       * been set up. An empty list for both would offer an action that cannot work.
       */
      missing: boolean;
      snapshots: SnapshotEntry[];
      status: 'snapshots';
    }
  | {
      healthy: boolean;
      raw: string;
      status: 'smart';
      temperature_celsius?: number | null;
    }
  | {
      pools: string[];
      status: 'pools';
    }
  | {
      /**
       * The dataset mounted EXACTLY there, or absent.
       *
       * Exactly, not "containing": a dataset mounted at `/srv` is not the one holding
       * `/srv/depsis`, and reporting it as such would make the API believe the share tree was
       * prepared when nothing had been created for it.
       */
      dataset?: string | null;
      /**
       * Does the directory have any entries?
       *
       * Reported so that `PrepareShareRoot`'s refusal can be explained BEFORE it is attempted.
       * A caller that cannot tell "not set up" from "set up with files in it" would offer to
       * mount over somebody's data.
       */
      empty: boolean;
      /**
       * The agent's configured shares root, or absent when it has none.
       */
      path?: string | null;
      status: 'share_root';
    }
  | {
      dataset: string;
      status: 'share_root_prepared';
    }
  | {
      detail: string;
      status: 'disk_wiped';
    }
  | {
      /**
       * What `zpool` printed, kept so an operator can see the real words on a bad day.
       */
      detail: string;
      status: 'pool_created';
    }
  | {
      processes: ProcessSummary[];
      status: 'processes';
      truncated: boolean;
    }
  | {
      status: 'process_killed';
    }
  | {
      disks: DiskInfo[];
      status: 'disks';
      /**
       * More devices than `MAX_DISKS`, so the list is a prefix.
       *
       * Reported rather than silently cut for the same reason `Listing` reports it: a caller
       * about to write a confirmation dialogue from a truncated inventory would be naming a
       * subset of the disks it is about to affect.
       */
      truncated: boolean;
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
      done: boolean;
      offset: number;
      status: 'copied';
    }
  | {
      reason: string;
      status: 'out_of_space';
    }
  | {
      entries: DirEntry[];
      status: 'listing';
      truncated: boolean;
    }
  | {
      status: 'moved';
    }
  | {
      status: 'removed';
    }
  | {
      status: 'written';
    }
  | {
      /**
       * Şifreli yarıya daha ne kadar yazılabilir. Kilitliyken 0 dönebilir.
       */
      available_bytes: number;
      /**
       * Şifreli yarının anahtarı yüklü mü.
       */
      key_loaded: boolean;
      /**
       * Şifreli yarı bağlı mı — yani dosyalar okunabiliyor mu.
       */
      mounted: boolean;
      /**
       * İki veri kümesi de yerinde mi.
       */
      prepared: boolean;
      status: 'backup_root';
      used_bytes: number;
    }
  | {
      status: 'directory_created';
    }
  | {
      created: boolean;
      status: 'app_data_dir_ready';
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
 * Bir nesneye ne olduğu.
 */
export type DiffChange = 'added' | 'modified' | 'removed' | 'renamed';
/**
 * Nesnenin ne olduğu.
 *
 * `zfs diff -F`'in tip sütunu dokuz değer üretebiliyor; yedekleme yalnız ikisini taşıyabiliyor
 * (dosya ve dizin) ve geri kalan her şey `Other`. Soket, fifo ve aygıt düğümü için DEPSIS'in bir
 * satır biçimi yok — `entries_of` da onları aynı gerekçeyle atıyor — ama burada ATILMIYORLAR:
 * silinmiş bir fifo'nun yedekten kaldırılması gereken bir karşılığı olabilir, ve çağıran tarafın
 * "bu neydi" sorusuna cevap verebilmesi gerekiyor.
 */
export type DiffKind = 'file' | 'directory' | 'other';
/**
 * A joined network's membership state, as ZeroTier reports it.
 */
export type ZeroTierNetworkStatus =
  | ('OK' | 'NOT_FOUND' | 'REQUESTING_CONFIGURATION' | 'PORT_ERROR' | 'AUTHENTICATION_REQUIRED')
  | 'ACCESS_DENIED'
  | 'UNKNOWN';

/**
 * Tek bir değişiklik.
 */
export interface DiffEntry {
  change: DiffChange;
  kind: DiffKind;
  /**
   * Yalnız `Renamed` için dolu: eski yol. Diğerlerinde `None`.
   */
  old_path?: string | null;
  /**
   * Veri kümesinin bağlama noktasına göre MUTLAK yol, kaçışları çözülmüş hâlde.
   */
  path: string;
}
/**
 * A network this appliance controls, as the interface reads it.
 */
export interface ZeroTierControlledNetwork {
  /**
   * Is IPv4 auto-assignment actually on? False means no device will ever get an address.
   */
  assigns_addresses: boolean;
  name: string;
  network_id: string;
  /**
   * Always true for a network DEPSIS made; carried so a network made elsewhere and restored
   * into this controller cannot look private when it is not.
   */
  private: boolean;
  /**
   * The route pushed to members, when there is one.
   */
  subnet?: string | null;
}
/**
 * One member of a controlled network.
 */
export interface ZeroTierMember {
  addresses: string[];
  authorized: boolean;
  /**
   * Is this the appliance itself? The interface must not offer to de-authorize this row.
   */
  is_this_appliance: boolean;
  /**
   * The household's own name for the device. Empty when never named.
   */
  label: string;
  /**
   * The device's 10-hex node address. Not a credential — see `NodeAddress`.
   */
  member_id: string;
  /**
   * Has this device ever actually contacted the controller?
   *
   * FALSE MEANS PRE-AUTHORIZED AND NOT YET SEEN, and the distinction is the one that catches a
   * mistyped address: until a device turns up, an authorized row looks exactly the same whether
   * it names a friend's laptop or a stranger's. The controller pins the full identity on first
   * contact and refuses any later node claiming the same address, so once this is true the row
   * means what it says.
   */
  seen: boolean;
}
/**
 * One database dump on disk.
 */
export interface DatabaseDump {
  created_unix: number;
  name: string;
  size_bytes: number;
}
/**
 * One whole disk, as `ListDisks` found it.
 *
 * Partitions are not reported as disks. They appear only through `holds`, `mounted` and
 * `holds_system` — which is what a caller about to overwrite the device needs to know, and a
 * per-partition inventory is not.
 * Kurulabilecek bir sürüm — DENETİMİN bulduğu, isteğin seçtiği değil.
 */
export interface UpdateCandidate {
  /**
   * Commit kimliği. DEPSIS'in sürüm kavramı bu: kutuya kurulan şey deponun bir anıdır, ve
   * etiketlenmiş bir sürüm akışı henüz yok (§21'in 13. teslimatı).
   */
  commit: string;
  committed_at?: string | null;
  /**
   * Commit başlığının ilk satırı. Operatörün "bu ne getiriyor" sorusuna verilebilecek tek
   * dürüst cevap, ve yorumlanmadan taşınıyor.
   */
  subject?: string | null;
}
/**
 * One host key a destination offered, and the fingerprint a person compares.
 */
export interface OffsiteHostKey {
  /**
   * `256 SHA256:… (ED25519)`, computed by `ssh-keygen -l`.
   *
   * BY OPENSSH ITSELF, not by DEPSIS. The user compares this against what
   * `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the far end, and two
   * implementations of a fingerprint format are two chances for the comparison to fail for a
   * reason that has nothing to do with the key.
   */
  fingerprint: string;
  /**
   * `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`.
   */
  kind: string;
  /**
   * The whole `known_hosts` line, which is what gets confirmed and stored.
   */
  line: string;
}
/**
 * One ZeroTier peer, as the diagnostics screen reads it.
 */
export interface ZeroTierPeer {
  /**
   * The 10-hex-digit node address.
   */
  address: string;
  /**
   * Is there an active path to this peer, or is every byte going through a root?
   *
   * DERIVED here, not reported by ZeroTier: a peer with an active path is reached over it, one
   * with none is relayed. The derivation lives in the agent so the API and the browser cannot
   * each grow their own copy of it.
   */
  direct: boolean;
  /**
   * Round trip in milliseconds, or absent when it has not been measured.
   *
   * Absent rather than -1, which is what ZeroTier writes: a screen printing "-1 ms" would be
   * showing a measurement that was never taken as though it were a bad one.
   */
  latency_ms?: number | null;
  /**
   * `LEAF`, `PLANET` or `MOON`, as the daemon words it.
   */
  role: string;
  version: string;
}
/**
 * One snapshot on the wire.
 *
 * Its own type rather than `snapshots::SnapshotInfo` for the reason every other wire type here is
 * separate: the protocol is a contract with another process, and a parser's internal shape
 * changing must not silently change what the API receives.
 */
export interface SnapshotEntry {
  /**
   * Seconds since the epoch.
   */
  created_at: number;
  name: string;
  /**
   * What destroying it would free — not what it "contains". See `snapshots::SnapshotInfo`.
   */
  used_bytes: number;
}
/**
 * A disk named twice: the stable link to use, and the WWN it must still be.
 */
export interface ProcessSummary {
  args: string;
  comm: string;
  pid: number;
  /**
   * Sistem süreci mi — `KillProcess` bunu reddeder. Kural `procs::is_protected`'ta tek yerde.
   */
  protected: boolean;
  rss_bytes: number;
  uid: number;
  user: string;
}
export interface DiskInfo {
  /**
   * The `/dev/disk/by-id` name, when the kernel gave the device a stable link.
   *
   * THE ONLY IDENTITY WORTH STORING, and the one `ReadSmartSummary` takes. `kname` is reported
   * beside it because an operator reads `sdb` on a chassis label, but a `/dev/sdX` name can
   * belong to a different physical disk after a reboot — risk R1, and the reason
   * `ReadSmartSummary` refuses to take one.
   *
   * Optional because a device can genuinely have no stable link: a loopback device, or a
   * virtual disk whose backend supplies no identity page.
   */
  by_id?: string | null;
  /**
   * What is already on the disk: partition table type and filesystem signatures found on it or
   * on its partitions, deduplicated.
   *
   * EMPTY IS THE ONLY SAFE STATE. Anything in this list means creating a pool on this device
   * destroys something, and §8.1's written confirmation exists for exactly that sentence.
   */
  holds: string[];
  /**
   * A filesystem of this disk is mounted at `/`, `/boot` or `/boot/efi`.
   *
   * Its own flag rather than something a caller derives from `holds`, because it is the one
   * answer that must never be a judgement call: overwriting this disk destroys the appliance
   * itself, and the API refuses it outright rather than asking for a confirmation somebody
   * could type.
   */
  holds_system: boolean;
  /**
   * The kernel name — `sda`, `nvme0n1`. For display beside the stable id, never as identity.
   */
  kname: string;
  model?: string | null;
  /**
   * Any partition of this disk is mounted, anywhere.
   */
  mounted: boolean;
  /**
   * A device that can be unplugged. Never a pool candidate without the operator saying so
   * twice: a USB stick that goes away takes a vdev with it.
   */
  removable: boolean;
  /**
   * Spinning rust, as the kernel reports it (`queue/rotational`).
   */
  rotational: boolean;
  /**
   * The device serial, which is NULLABLE ON PURPOSE and not because it is uninteresting.
   *
   * ADR-0000 recorded the measurement: SCSI VPD page 0x80 is broken under Hyper-V — the
   * `storvsc_drv.c` workaround exists for it — so a serial read there is absent or wrong. The
   * identity chain the baseline settled on is page 0x83 (the WWN below) first, then partuuid,
   * then the ZFS label GUID. A confirmation dialogue that keyed on the serial alone would show
   * an empty field on exactly the hypervisor the project develops against.
   */
  serial?: string | null;
  size_bytes: number;
  /**
   * `sata`, `nvme`, `usb`, … as the kernel names the transport.
   */
  transport?: string | null;
  /**
   * The World Wide Name — SCSI VPD page 0x83. The first link in that chain.
   */
  wwn?: string | null;
}
/**
 * One thing in a directory, as the agent found it.
 *
 * `size` is 0 for a directory, matching `file_entries_folder_has_no_size`. The database
 * constraint and the filesystem answer have to agree, or every reconciliation would report a
 * difference that is not one.
 */
export interface DirEntry {
  directory: boolean;
  /**
   * Seconds since the epoch, from the kernel. Fills `updated_at` for a row DEPSIS is learning
   * about, so a file that arrived over SMB last week does not appear as modified just now.
   */
  modified_unix: number;
  /**
   * A `SafeComponent`, not a `String`: a name the agent cannot address is a name the API must
   * not be handed, because a row written for it would be permanently unreachable.
   */
  name: string;
  size: number;
}
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
