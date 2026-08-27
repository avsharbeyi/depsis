//! Request dispatch — the single chokepoint every privileged operation passes through.
//!
//! Order matters and is not negotiable:
//!
//!   parse → authorize → audit(intent) → execute → audit(outcome)
//!
//! Parsing first means a malformed or flag-shaped operand is refused before any identity work,
//! and an unparseable request never reaches an executor. Auditing intent *before* execution
//! means a call that hangs or crashes the agent still left a trace of what was attempted.

use crate::acl::{self, AclError};
use crate::audit::{self, Outcome, Sink};
use crate::authz::{Decision, Policy};
use crate::op::{
    AclEntry, AclType, DatabaseDump, DirEntry, NodeAddress, OffsiteHostKey, PosixId, Request,
    Response, SafeComponent, SnapshotEntry, ZeroTierControlledNetwork, ZeroTierMember,
    SCHEMA_VERSION, SHARE_ROOT_MODE,
};
use crate::seams::{CommandRunner, OpenIntent, PeerIdentity, SafePath, SeamError, TokenSource};
use crate::transfer::{
    Abandoned, Direction, InsertError, PendingTransfer, TransferRegistry, MAX_PENDING_TRANSFERS,
};
use crate::zerotier::{self, ZeroTierError};
use std::io::Seek;
use std::sync::Mutex;

/// Absolute paths only.
///
/// `execvp` falls back to searching `/bin:/usr/bin` when `PATH` is unset, so a relative program
/// name is a supply chain question rather than a convenience. These constants are the complete
/// set of binaries the agent will ever run.
pub mod bin {
    pub const ZFS: &str = "/usr/sbin/zfs";
    pub const ZPOOL: &str = "/usr/sbin/zpool";
    pub const SMARTCTL: &str = "/usr/sbin/smartctl";
    pub const WIPEFS: &str = "/usr/sbin/wipefs";
    pub const TESTPARM: &str = "/usr/bin/testparm";
    pub const LSBLK: &str = crate::disks::LSBLK;
    /// Off-site replication's three. Absolute, for the reason every path here is: the agent runs
    /// with systemd's `PATH` and a bare program name is a supply-chain question.
    pub const SSH: &str = "/usr/bin/ssh";
    pub const SSH_KEYGEN: &str = "/usr/bin/ssh-keygen";
    pub const SSH_KEYSCAN: &str = "/usr/bin/ssh-keyscan";
    /// The appliance's own backup. Absolute, for the reason every path here is.
    pub const PG_DUMP: &str = "/usr/bin/pg_dump";
    /// The ZeroTier identity archive. Absolute, for the reason every path here is.
    pub const TAR: &str = "/usr/bin/tar";
}

/// Where staging files live inside a share.
///
/// Literal components, never caller-supplied. ADR-0008 keeps staging INSIDE the destination
/// dataset so publishing is an O(1) same-dataset rename rather than a copy — a separate staging
/// dataset would mean writing every byte twice and doubling the user's quota mid-upload.
pub const STAGING_DIR: [&str; 2] = [".depsis", "staging"];

fn depsis_agent_max_pending() -> usize {
    MAX_PENDING_TRANSFERS
}

/// En fazla kaç üye okunuyor.
///
/// Üye listesi N+1: liste çağrısı yalnız kimlikten sürüme bir eşleme veriyor — ad yok, yetki yok —
/// yani her üye ayrı bir istek. 256, bir evin cihaz sayısının çok üstünde; aşıldığında liste
/// KESİLMİYOR, sayıyı söyleyen bir hata dönüyor. Kesilmiş bir üye listesi, tam sanılan bir liste
/// olurdu, ve o ekranın tek işi orada olmaması gereken satırı göstermek.
const MAX_CONTROLLER_MEMBERS: usize = 256;

/// Controller'ın ağ kaydını arayüzün okuduğu şekle indir.
fn describe_network(record: &crate::ztcontroller::NetworkRecord) -> ZeroTierControlledNetwork {
    ZeroTierControlledNetwork {
        network_id: record.id.clone(),
        name: record.name.clone(),
        private: record.private,
        assigns_addresses: record.v4_assign_mode.zt,
        subnet: record.routes.first().map(|route| route.target.clone()),
    }
}

/// Üye kaydını arayüzün okuduğu şekle indir.
///
/// `seen`, `identity` alanının DOLU olması. Controller o alanı ilk temasta öğrenip sabitliyor, yani
/// boş olması "bu adres yetkilendirildi ama sahibi hiç görünmedi" demek — bir yanlış yazılmış
/// hanenin tek görünür izi.
fn describe_member(record: &crate::ztcontroller::MemberRecord, own: &str) -> ZeroTierMember {
    ZeroTierMember {
        member_id: record.id.clone(),
        authorized: record.authorized,
        label: record.name.clone(),
        addresses: record.ip_assignments.clone(),
        seen: !record.identity.is_empty(),
        is_this_appliance: record.id == own,
    }
}

/// Turn a ZeroTier client error into the answer the API needs.
///
/// The split IS ADR-0020's third rule. "Not installed" and "not running" are ordinary states of a
/// box — DEPSIS packages neither ZeroTier nor podman — and the API turns them into 503 with a
/// card that explains itself. Everything else is a fault: it goes back as an error so that
/// `handle` audits it as one, because a misconfigured daemon that reports itself as merely absent
/// is a bug nobody goes looking for.
fn zerotier_error(e: ZeroTierError) -> Result<Response, SeamError> {
    if e.is_unavailable() {
        Ok(Response::ZeroTierUnavailable {
            reason: e.to_string(),
        })
    } else {
        Err(SeamError::Io(e.to_string()))
    }
}

/// One slice of one copy, as a named record rather than nine positional arguments.
///
/// The same argument `AclEntry` makes about its three booleans: a call site with two `u64`s and two
/// `u32`s in a row invites a silent swap, and swapping `offset` with `max_bytes` here would produce
/// a file that looks complete and is not.
struct CopySlice<'a> {
    share: &'a str,
    /// `Some` when the source is inside a snapshot rather than the live share.
    ///
    /// The ONE field that separates a copy from a restore. Everything else — the slicing, the
    /// staging file, the out-of-space answer, the ownership fix-up, the `RENAME_NOREPLACE`
    /// publish — is identical, and giving restore its own implementation would have meant two
    /// copies of the steps people skip.
    snapshot: Option<&'a str>,
    from: &'a [&'a str],
    to: &'a [&'a str],
    staging_name: &'a str,
    offset: u64,
    max_bytes: u64,
    owner_uid: u32,
    owner_gid: u32,
}

pub struct Agent<'a, R: CommandRunner, S: Sink, P: SafePath> {
    pub policy: Policy,
    pub runner: &'a R,
    pub audit: &'a S,
    /// The share tree, confined by `openat2`. `None` on a box with no storage configured yet,
    /// which is the normal state of a NAS before setup — the transfer operations then refuse,
    /// with a reason, rather than the agent refusing to start at all.
    pub paths: Option<&'a P>,
    /// Deliberately NOT `+ Sync`, unlike `Sink`.
    ///
    /// The design review recommended making every one of `Agent`'s shared types `Sync` so the whole
    /// struct could cross into the data channel's worker threads. Passing the whole struct is what
    /// makes that necessary, and passing less is better: the data channel needs the policy, the
    /// audit sink and the confined paths, and it never mints a token or runs a command. Requiring
    /// `Sync` here would spread the constraint to `MockTokenSource` and, by the same argument,
    /// `CommandRunner` and `MockCommandRunner` — contagion bought for nothing.
    pub tokens: &'a dyn TokenSource,
    /// Shared with the data socket's accept loop, which runs concurrently with this one. The
    /// control loop is deliberately serial (ADR-0006), but bulk transfers must not be: a 10 GB
    /// upload holding the control socket would block every other privileged call for its duration.
    pub transfers: &'a Mutex<TransferRegistry>,
    /// How a file only its owner can read is written. See [`crate::identity::PrivateWriter`].
    ///
    /// A FIFTH THING SUPPLIED FROM OUTSIDE, and it is here for the reason the other four are:
    /// setting a file's mode is platform-specific, and ADR-0006 says the core contains none of
    /// that. `identity.rs` used `std::os::unix::fs::OpenOptionsExt` inline instead, so the library
    /// did not compile for Windows and no local gate could tell — `cargo test` on Linux never
    /// tries. CI's `cargo check --target x86_64-pc-windows-msvc` does, and CI had never completed
    /// a run until the day this was found.
    pub private_writer: crate::identity::PrivateWriter,
}

impl<'a, R: CommandRunner, S: Sink, P: SafePath> Agent<'a, R, S, P> {
    pub fn new(
        policy: Policy,
        runner: &'a R,
        audit: &'a S,
        paths: Option<&'a P>,
        tokens: &'a dyn TokenSource,
        transfers: &'a Mutex<TransferRegistry>,
        private_writer: crate::identity::PrivateWriter,
    ) -> Self {
        Self {
            policy,
            runner,
            audit,
            paths,
            tokens,
            transfers,
            private_writer,
        }
    }

    /// Open the staging file and hand back a token for the data channel.
    ///
    /// The resolution happens HERE, once, and the descriptor is what survives. The token names
    /// that descriptor; nothing the caller sends on the data socket can change which file it
    /// writes to. That is the property which makes splitting one upload across two connections
    /// safe, and it is why the data socket takes a token rather than repeating the file name.
    fn open_transfer(
        &self,
        share: &str,
        staging_name: &str,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        let relative = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        // Append, not CreateNew: tus uploads resume, and the second PATCH for one upload must
        // continue the same `.part` rather than being refused for existing.
        let mut file = paths.open(&relative, OpenIntent::Append)?;

        // Where a resumed upload continues from. Read from the file itself rather than tracked
        // separately: a number kept beside the data is a number that can disagree with it.
        let offset = file
            .seek(std::io::SeekFrom::End(0))
            .map_err(|e| SeamError::Io(format!("seek staging file: {e}")))?;

        let token = self.tokens.token();

        // Poison is RECOVERED, not treated as fatal. Refusing on a poisoned mutex means refusing
        // forever, for every tenant, while the process stays alive — so `Restart=on-failure` never
        // fires, `ping` still answers and telemetry stays green. That is neither recovering nor
        // dying, which is the worst of the three.
        //
        // It is safe here because of what the registry is: a HashMap with no invariant spanning
        // entries, in a crate that carries `forbid(unsafe_code)`. A panic cannot leave it torn —
        // it can only leave it missing an insert, which is indistinguishable from the insert not
        // having happened yet.
        let mut registry = self
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let inserted = registry.insert(
            token.clone(),
            PendingTransfer {
                file,
                direction: Direction::Receive,
                share: share.to_string(),
                staging_name: staging_name.to_string(),
                // The peer the CONTROL connection authenticated. The data connection must present
                // the same uid, or a token that leaked into a log line becomes a bearer write.
                opened_by: peer,
                correlation_id: correlation_id.to_string(),
                reason: reason.to_string(),
                opened_at: std::time::Instant::now(),
            },
        );
        drop(registry);

        match inserted {
            Ok(()) => Ok(Response::Transfer { token, offset }),
            // Both refusals are states a caller can legitimately hit, so both say which one it is.
            Err(InsertError::Occupied) => Ok(Response::Refused {
                reason: format!("{staging_name} already has a transfer open or streaming"),
            }),
            Err(InsertError::Full) => Ok(Response::Refused {
                reason: format!(
                    "too many transfers are open (limit {})",
                    depsis_agent_max_pending()
                ),
            }),
        }
    }

    /// Move a finished staging file into place, durably.
    ///
    /// ADR-0008 steps 4 and 5. The directory fsync is the one people skip, and skipping it means
    /// a power cut can leave the data on disk with nothing pointing at it — the file survived and
    /// the rename did not.
    /// Open a published file for reading and register a one-time token for it.
    ///
    /// The mirror of `open_transfer`, and deliberately built from the same pieces: the same
    /// `openat2(RESOLVE_BENEATH)` resolution, the same registry, the same one-time token bound to
    /// the same uid. What differs is one field, and everything that follows from it lives in the
    /// data channel rather than here.
    fn open_download(
        &self,
        share: &str,
        path: &[&str],
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        if path.is_empty() {
            return Ok(Response::Refused {
                reason: "a download needs a path".to_string(),
            });
        }

        let mut relative: Vec<&str> = Vec::with_capacity(path.len() + 1);
        relative.push(share);
        relative.extend_from_slice(path);
        let file = match paths.open(&relative, OpenIntent::Read) {
            Ok(file) => file,
            // A refusal, not an error. The file being gone is an ordinary answer to a download —
            // it was deleted, or renamed over SMB since the listing the caller is working from —
            // and an error here becomes a 500 for something the client can act on.
            Err(SeamError::NotFound(_)) => {
                return Ok(Response::Refused {
                    reason: "no such file".to_string(),
                })
            }
            Err(other) => return Err(other),
        };

        // The size comes from the descriptor the agent just opened, never from the caller. A Range
        // validated against a number the caller supplied is not validated at all.
        let size = file
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat the file to be read: {e}")))?
            .len();

        let key = path.join("/");
        let token = self.tokens.token();
        let mut registry = self
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let inserted = registry.insert(
            token.clone(),
            PendingTransfer {
                file,
                direction: Direction::Send,
                share: share.to_string(),
                staging_name: key,
                opened_by: peer,
                correlation_id: correlation_id.to_string(),
                reason: reason.to_string(),
                opened_at: std::time::Instant::now(),
            },
        );
        drop(registry);

        match inserted {
            Ok(()) => Ok(Response::Download { token, size }),
            // A second reader while one is still open. Refused rather than queued: the interlock
            // exists so a publish cannot rename a file out from under an open descriptor, and one
            // reader at a time is a price a download can pay by retrying.
            Err(InsertError::Occupied) => Ok(Response::Refused {
                reason: "this file already has a reader".to_string(),
            }),
            Err(InsertError::Full) => Ok(Response::Refused {
                reason: format!("too many transfers are open (limit {MAX_PENDING_TRANSFERS})"),
            }),
        }
    }

    /// Throw a staging file away.
    ///
    /// Two steps that must happen in this order: release the registry entry, then unlink. Doing it
    /// the other way round would unlink a file whose descriptor the registry still holds, and the
    /// entry would keep a deleted inode alive against `MAX_PENDING_TRANSFERS` until it timed out.
    fn discard_transfer(&self, share: &str, staging_name: &str) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        {
            let mut registry = self
                .transfers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if registry.abandon(share, staging_name) == Abandoned::Streaming {
                return Ok(Response::Refused {
                    reason: format!("{staging_name} is being written right now"),
                });
            }
        }

        let staging = [share, STAGING_DIR[0], STAGING_DIR[1]];
        let existed = paths.remove_file(&staging, staging_name)?;
        Ok(Response::Discarded { existed })
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Every operand is one the agent must not infer. The share and the staging name \
                  come from the caller because only it knows which upload this is; the destination \
                  because only it knows where the user asked for the file; expected_bytes and the \
                  owner pair because both are checked rather than trusted. Bundling them into a \
                  struct would satisfy the lint and put a parameter list behind one more name."
    )]
    fn publish_transfer(
        &self,
        share: &str,
        staging_name: &str,
        destination: &[&str],
        expected_bytes: u64,
        owner_uid: PosixId,
        owner_gid: PosixId,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        let Some((file_name, dirs)) = destination.split_last() else {
            return Ok(Response::Refused {
                reason: "destination is empty".to_string(),
            });
        };
        // There is no owner check here any more and its absence is the fix, not an omission.
        // `PosixId` refuses 0 and everything outside the reserved range at PARSE time, so a
        // root-owned or service-account-owned publish never becomes a `Request` at all — it is
        // answered "unparseable" before authorization, before the registry is consulted and before
        // anything is opened. The old check compared against 0 and let uid 33 (www-data) and gid 27
        // (sudo) straight through.

        // Publishing a file that is still being written renames a half-written object into the
        // user's tree — the exact outcome atomic publish exists to prevent. The agent holds the
        // state that answers this; it does not have to trust the API's belief that the upload
        // finished, which is the one assumption ADR-0006 says it must not make.
        {
            let registry = self
                .transfers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if registry.is_busy(share, staging_name) {
                return Ok(Response::Refused {
                    reason: format!("{staging_name} is still open or streaming"),
                });
            }
        }

        let staged = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        let file = paths.open(&staged, OpenIntent::Read)?;
        let size = file
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat staging file: {e}")))?
            .len();

        // Ownership BEFORE the fsync, and the order is the whole reason this is not one line
        // further down. `fchown` changes inode metadata; `fsync` is what makes inode metadata
        // durable. Chowning after the fsync would leave a window where a power cut publishes the
        // file under its real name with the old owner still recorded — a file the user can see and
        // cannot read, with nothing left to fix it, because the staging entry is gone.
        paths.set_owner(&file, owner_uid.get(), owner_gid.get())?;

        // ADR-0008 step 2, done HERE rather than assumed.
        //
        // `SafePath::publish` bundles step 5 (the destination-directory fsync) so a call site
        // cannot skip it. Step 2 — the file's own data — had no such home: it was left to whoever
        // wrote the bytes, on the far side of a process boundary and a possible agent restart, with
        // nothing recording that it ever ran. Doing it again on the descriptor being published
        // costs one syscall on already-clean pages and removes the assumption. fsync on an
        // O_RDONLY descriptor is permitted on Linux.
        file.sync_all()
            .map_err(|e| SeamError::Io(format!("fsync staging file before publish: {e}")))?;

        // The API says how many bytes it believes are there; the agent checks. Without this, a
        // client that died at 90% plus a buggy or compromised API renames a short file to the name
        // the user chose — and because publish uses RENAME_NOREPLACE, the good copy can then NEVER
        // be written over it. The rule that publishing never destroys a file the user already has
        // would have permanently given the name to a corrupt one.
        if size != expected_bytes {
            return Ok(Response::Refused {
                reason: format!("staged file is {size} bytes, caller expected {expected_bytes}"),
            });
        }

        let mut dest_dir: Vec<&str> = vec![share];
        dest_dir.extend_from_slice(dirs);
        let staging_dir = [share, STAGING_DIR[0], STAGING_DIR[1]];

        // Rename and directory fsync in one call, so step 5 cannot be left out here.
        paths.publish(&staging_dir, staging_name, &dest_dir, file_name)?;

        Ok(Response::Publish { bytes: size })
    }

    /// Does this caller-supplied path reach into the agent's own bookkeeping?
    ///
    /// `.depsis/` is inside the share — ADR-0008 puts staging there so a publish is an O(1)
    /// same-dataset rename — which means a caller-supplied `Vec<SafeComponent>` can name it, and
    /// `MoveEntry`/`RemoveEntry` would otherwise be a second door into it.
    ///
    /// Both doors are dangerous in the same direction. A move OUT of staging renames a `.part`
    /// into the user's tree without the byte-count check `PublishTransfer` performs — precisely
    /// the "the client died at 90% and the short file permanently took the good copy's name"
    /// failure that check exists to prevent. A move INTO staging, or a remove inside it, steps
    /// past the transfer registry's interlock on a file a data connection may be appending to.
    /// The upload path has three operations of its own and they are the only way in.
    fn touches_agent_state(path: &[&str]) -> bool {
        path.first() == Some(&STAGING_DIR[0])
    }

    /// Where shares are served from, and whether anything is there yet.
    ///
    /// The path is the agent's own, never a caller's. Every field is reported rather than reduced
    /// to a "ready" boolean, because the three states the API has to tell apart — no root
    /// configured, a root with nothing on it, a root that already has a dataset — need different
    /// sentences on screen and a boolean would collapse two of them.
    /// Which dataset DEPSIS serves shares from, for `ReplicateDataset`'s refusals.
    ///
    /// `Ok(None)` means the agent serves NO shares — `DEPSIS_SHARES_ROOT` is unset — so there is
    /// nothing for a target to collide with. That is a real state on a box before setup.
    ///
    /// `Err` means the question could not be ANSWERED, and the caller must refuse rather than
    /// carry on. Treating "I could not ask" as "there is nothing to protect" would remove the two
    /// refusals that matter most (`recv -F` onto the share root erases every tenant's files)
    /// exactly when the agent is least sure of itself. A destructive operation fails closed.
    fn share_dataset(&self) -> Result<Option<String>, SeamError> {
        let Ok(root) = crate::acl::shares_root_from_env() else {
            return Ok(None);
        };
        let listing = self
            .runner
            .run(bin::ZFS, &crate::pools::list_filesystems_argv())?;
        let filesystems = crate::pools::parse_filesystems(&listing);
        Ok(crate::pools::mounted_at(&filesystems, &root.to_string_lossy()).map(str::to_string))
    }

    fn share_root_status(&self) -> Result<Response, SeamError> {
        let Ok(root) = crate::acl::shares_root_from_env() else {
            return Ok(Response::ShareRoot {
                path: None,
                dataset: None,
                empty: false,
            });
        };
        let path = root.to_string_lossy().to_string();

        // `zfs list` with NO operand, filtered here. See `crate::pools` for why the filtering is in
        // Rust rather than in the command line.
        let listing = self
            .runner
            .run(bin::ZFS, &crate::pools::list_filesystems_argv())?;
        let filesystems = crate::pools::parse_filesystems(&listing);
        let dataset = crate::pools::mounted_at(&filesystems, &path).map(str::to_string);

        // Through the confined root rather than by reading the path again: this is the same
        // directory the agent resolves every share under, and asking it twice by two routes is how
        // the two answers start to disagree.
        let empty = match self.paths {
            Some(paths) => paths
                .list_entries(&[])
                .map(|e| e.is_empty())
                .unwrap_or(false),
            None => false,
        };

        Ok(Response::ShareRoot {
            path: Some(path),
            dataset,
            empty,
        })
    }

    /// Create `<pool>/depsis` and mount it where this agent serves shares from.
    ///
    /// The two refusals are the whole of it. A dataset already mounted there means the box is
    /// already set up and doing this again would stack a second filesystem on the same directory.
    /// A NON-EMPTY directory is the dangerous one: `zfs create -o mountpoint=X` mounts over X
    /// without complaint, and everything underneath vanishes from view while still occupying the
    /// disk it is on — a data-loss report that takes a long time to diagnose because nothing was
    /// actually deleted.
    fn prepare_share_root(&self, pool: &str) -> Result<Response, SeamError> {
        let Ok(root) = crate::acl::shares_root_from_env() else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        let path = root.to_string_lossy().to_string();
        crate::pools::check_shares_root(&path)?;

        let listing = self
            .runner
            .run(bin::ZFS, &crate::pools::list_filesystems_argv())?;
        let filesystems = crate::pools::parse_filesystems(&listing);
        if let Some(existing) = crate::pools::mounted_at(&filesystems, &path) {
            return Ok(Response::Refused {
                reason: format!("{existing} is already mounted at {path}"),
            });
        }

        match self.paths {
            Some(paths) => {
                if !paths.list_entries(&[])?.is_empty() {
                    return Ok(Response::Refused {
                        reason: format!(
                            "{path} is not empty; mounting a dataset over it would hide what is \
                             there without deleting it"
                        ),
                    });
                }
            }
            None => {
                return Ok(Response::Refused {
                    reason: "no share root is configured; storage is not set up".to_string(),
                })
            }
        }

        // Derived, never chosen. ADR-0004's two properties are set here as well as on the pool,
        // because this dataset can also be created on a pool made outside DEPSIS.
        let dataset = crate::pools::share_dataset(pool);
        let mountpoint = format!("mountpoint={path}");
        self.runner.run(
            bin::ZFS,
            &[
                "create",
                "-o",
                &mountpoint,
                "-o",
                "acltype=posixacl",
                "-o",
                "xattr=sa",
                &dataset,
            ],
        )?;
        Ok(Response::ShareRootPrepared { dataset })
    }

    /// Create a ZFS pool, after checking the disks against what the box reports RIGHT NOW.
    ///
    /// THE INVENTORY IS RE-READ HERE and not taken from the request. That ordering is the entire
    /// value of the WWN check: a caller that supplied both the disk list and the disks to check it
    /// against would be confirming only that it had copied its own screen correctly. Between the
    /// wizard that listed the disks and the button that created the pool, a disk can be pulled and
    /// another put in its place — and `/dev/disk/by-id` names a DEVICE, not a slot.
    ///
    /// A truncated inventory is refused rather than planned against. `plan` reports a disk that is
    /// not in the list as unknown, so a cut list would turn "there are more disks than we can
    /// report" into "that disk does not exist" — a confusing refusal for a correct request, and
    /// worse, a possible ACCEPTANCE if the disk that fell off the end was the system disk.
    fn create_pool(
        &self,
        pool: &str,
        topology: crate::op::PoolTopology,
        disks: &[crate::op::DiskRef],
    ) -> Result<Response, SeamError> {
        let listing = self.runner.run(bin::LSBLK, &crate::disks::argv())?;
        let (inventory, truncated) = crate::disks::parse(&listing)?;
        if truncated {
            return Ok(Response::Refused {
                reason: "this machine reports more block devices than one inventory can carry; \
                         a pool cannot be checked against a partial list"
                    .to_string(),
            });
        }

        let argv = match crate::disks::plan(pool, topology, disks, &inventory) {
            Ok(argv) => argv,
            // A refusal, not a failure. Every one of these is a fact about the request that the
            // operator can act on — a disk that is not there, a disk that is not the one they
            // confirmed, an arrangement that needs more disks — and `handle` records it with its
            // reason attached, which for the WWN mismatch is the whole point: the audit trail is
            // where "the disk in that slot changed" has to survive.
            Err(error) => {
                return Ok(Response::Refused {
                    reason: error.to_string(),
                })
            }
        };

        let borrowed: Vec<&str> = argv.iter().map(String::as_str).collect();
        let out = self.runner.run(bin::ZPOOL, &borrowed)?;
        Ok(Response::PoolCreated { detail: out })
    }

    /// Erase one disk so the pool wizard can accept it. See `op::Request::WipeDisk`.
    fn wipe_disk(&self, disk: &crate::op::DiskRef) -> Result<Response, SeamError> {
        // A FRESH inventory, taken here and not reused from whatever dialogue the caller was
        // looking at — the WWN re-check inside `wipe_plan` is only worth anything against the
        // box's state at the moment of the erase.
        let listing = self.runner.run(bin::LSBLK, &crate::disks::argv())?;
        let (inventory, truncated) = crate::disks::parse(&listing)?;
        if truncated {
            return Ok(Response::Refused {
                reason: "this machine reports more block devices than one inventory can carry;                          a wipe cannot be checked against a partial list"
                    .to_string(),
            });
        }
        if let Err(error) = crate::disks::wipe_plan(disk, &inventory) {
            return Ok(Response::Refused {
                reason: error.to_string(),
            });
        }

        // The path is built from a `SafeComponent`, so it cannot climb out of by-id or carry a
        // flag; `--` ends option parsing anyway, the same discipline as every other argv here.
        let device = format!("/dev/disk/by-id/{}", disk.by_id.as_str());
        let out = self
            .runner
            .run(bin::WIPEFS, &["--all", "--", device.as_str()])?;
        Ok(Response::DiskWiped { detail: out })
    }

    /// Move one entry to another name inside a share, durably, without ever overwriting.
    fn move_entry(&self, share: &str, from: &[&str], to: &[&str]) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        // An empty side names the share root. Renaming a share is a dataset operation with a
        // dataset's consequences, and it must not be reachable by leaving a list empty.
        let (Some((from_name, from_dirs)), Some((to_name, to_dirs))) =
            (from.split_last(), to.split_last())
        else {
            return Ok(Response::Refused {
                reason: "a move needs a source and a destination; the share root is not an entry"
                    .to_string(),
            });
        };
        if Self::touches_agent_state(from) || Self::touches_agent_state(to) {
            return Ok(Response::Refused {
                reason: format!(
                    "{}/ is the agent's own tree; use the transfer operations",
                    STAGING_DIR[0]
                ),
            });
        }

        let mut source_dir: Vec<&str> = vec![share];
        source_dir.extend_from_slice(from_dirs);
        let mut destination_dir: Vec<&str> = vec![share];
        destination_dir.extend_from_slice(to_dirs);

        // `SafePath::publish` IS this operation: `renameat2(RENAME_NOREPLACE)` between two
        // directory descriptors resolved under `RESOLVE_BENEATH`, followed by an `fsync` of the
        // destination directory, in ONE call so the fsync cannot be skipped here the way it was
        // never skippable there. Reusing it rather than adding a second seam method is the whole
        // point — two implementations of ADR-0008 step 5 is one too many, and the second is always
        // the one that forgets.
        //
        // Nothing here checks first and moves afterwards. The refusal to overwrite is the kernel's,
        // inside the same syscall as the move, so there is no window in which the destination can
        // appear between a check and a rename.
        //
        // A destination parent that does not exist arrives as `NotFound` from `open_dir`, which is
        // the honest answer: the folder the caller named is not there.
        match paths.publish(&source_dir, from_name, &destination_dir, to_name) {
            Ok(()) => Ok(Response::Moved {}),
            Err(SeamError::NotFound(what)) => Ok(Response::NotFound {
                reason: format!("{what}: no such entry"),
            }),
            // The destination is taken and the source is STILL THERE — `RENAME_NOREPLACE` is
            // all-or-nothing, so a refused move has changed nothing at all.
            Err(SeamError::AlreadyExists(what)) => Ok(Response::Conflict {
                reason: format!("{what}: something is already there"),
            }),
            Err(other) => Err(other),
        }
    }

    /// Delete exactly ONE entry inside a share.
    ///
    /// Not a tree. A directory with children comes back as `Conflict`, and the API — which stores
    /// the tree and therefore knows it — walks the children itself. See `op::Request::RemoveEntry`
    /// for why the agent must not be given an operation whose blast radius the caller chooses.
    /// Copy at most one SLICE of a file into staging, and publish when the source is exhausted.
    ///
    /// WHY THE AGENT DOES THE COPY AT ALL. The obvious shape is for the API to read the source over
    /// the data channel and write the destination back — the two halves already exist. That shape
    /// has a measured hazard: `unix.rs` hands data connections to `MAX_DATA_CONNECTIONS` worker
    /// threads over a rendezvous `sync_channel(0)`, so a connection is only accepted once a thread
    /// is free. Every operation that exists today holds exactly ONE. A copy done that way holds two
    /// at once, and that many concurrent copies each holding their read connection while waiting
    /// for a write connection no thread is free to accept is a hard deadlock of the entire data
    /// socket — every upload and every download on the appliance.
    ///
    /// WHY IT IS A SLICE. The control socket, where this runs, is served strictly one connection at
    /// a time. Whatever this call does, nothing else can ask the agent anything meanwhile. Copying a
    /// whole file here would make a 50 GB copy a total control-plane outage, and the API's own
    /// 60-second budget would make such a file impossible to copy at all — every attempt timing
    /// out, each of the twenty retries leaving another full-size staging file behind. So the caller
    /// asks for a slice and calls again, and the agent clamps the size itself because a caller that
    /// asks for the whole file must not get it.
    ///
    /// The order on the LAST slice is the contract, and it is the same order `publish_transfer`
    /// follows for the same reasons: own it, then fsync it — `fchown` changes inode metadata and
    /// `fsync` is what makes inode metadata durable — then `publish`, which is
    /// `renameat2(RENAME_NOREPLACE)` plus the destination-directory fsync in one call so ADR-0008's
    /// step 5 cannot be skipped.
    ///
    /// A FAILURE MID-COPY LEAVES A STAGING FILE, deliberately. The caller can resume it by passing
    /// the same staging name and the offset it was told, and if it never does, the agent's own
    /// sweeper walks `.depsis/staging` in every share and unlinks by mtime (`sweep.rs`).
    fn copy_file(&self, spec: &CopySlice<'_>) -> Result<Response, SeamError> {
        let &CopySlice {
            share,
            snapshot,
            from,
            to,
            staging_name,
            offset,
            max_bytes,
            owner_uid,
            owner_gid,
        } = spec;
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        // An empty side names the share root, which is a directory and not a file either way.
        let (Some(_), Some((to_name, to_dirs))) = (from.last(), to.split_last()) else {
            return Ok(Response::Refused {
                reason: "a copy needs a source and a destination; the share root is not a file"
                    .to_string(),
            });
        };

        // The same door `MoveEntry` and `RemoveEntry` close. A copy OUT of staging would publish a
        // half-finished upload under a name of the caller's choosing, with none of
        // `PublishTransfer`'s byte-count check; a copy INTO it would put a file where the sweeper
        // will delete it and the transfer registry does not know about it.
        if Self::touches_agent_state(from) || Self::touches_agent_state(to) {
            return Ok(Response::Refused {
                reason: format!(
                    "{}/ is the agent's own tree; use the transfer operations",
                    STAGING_DIR[0]
                ),
            });
        }

        let mut source: Vec<&str> = vec![share];
        source.extend_from_slice(from);

        let opened = match snapshot {
            // Four steps and exactly one mount crossing; the argument is on
            // `SafePath::list_snapshot_entries`.
            Some(name) => paths.open_snapshot(share, name, from),
            None => paths.open(&source, OpenIntent::Read),
        };
        let source_file = match opened {
            Ok(file) => file,
            Err(SeamError::NotFound(what)) => {
                return Ok(Response::NotFound {
                    reason: format!("{what}: no such entry"),
                });
            }
            // A snapshot whose mount could not be crossed lands here rather than looking like an
            // empty directory. "This snapshot holds nothing" is what a user acts on by concluding
            // their file is really gone.
            Err(SeamError::PathEscape(what)) => {
                return Ok(Response::Refused {
                    reason: format!("{what}: refused by the path confinement"),
                });
            }
            Err(other) => return Err(other),
        };
        let total = source_file
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat source: {e}")))?
            .len();

        let staged = [share, STAGING_DIR[0], STAGING_DIR[1], staging_name];
        // `Append`, not `CreateNew`: this call may be the second or the twentieth on one staging
        // file. O_APPEND also means the kernel resolves the write position at every write, so a
        // caller's idea of the offset can never place bytes in the wrong part of the file.
        let mut staging_file = paths.open(&staged, OpenIntent::Append)?;
        let staged_len = staging_file
            .metadata()
            .map_err(|e| SeamError::Io(format!("stat staging file: {e}")))?
            .len();

        // The FILE is the authority, not the caller's number. A mismatch means the caller and the
        // filesystem disagree about how much is there, and continuing would either duplicate a
        // region or leave a hole — both of which produce a file that looks complete and is not.
        if staged_len != offset {
            return Ok(Response::Conflict {
                reason: format!(
                    "the staged copy is {staged_len} bytes, the caller expected {offset}"
                ),
            });
        }

        let slice = max_bytes.min(crate::op::MAX_COPY_SLICE);
        // Seek, not read-and-discard. Reading past the staged prefix would make every slice cost
        // the whole file so far, which on a 50 GB copy is quadratic and would defeat the entire
        // point of slicing.
        let mut reader = &source_file;
        std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(offset))
            .map_err(|e| SeamError::Io(format!("seek source to {offset}: {e}")))?;
        let mut window = std::io::Read::take(reader, slice);

        let copied = match std::io::copy(&mut window, &mut staging_file) {
            Ok(n) => n,
            Err(e)
                if matches!(
                    crate::data::classify(&e),
                    crate::data::FailureKind::OutOfSpace
                ) =>
            {
                // Its own answer, not `Failed`. ADR-0008: a full dataset is permanent and the
                // caller must not retry — and twenty retries would park twenty more part-files
                // against the refquota that is already exhausted.
                return Ok(Response::OutOfSpace {
                    reason: format!("no space for the copy of {}: {e}", from.join("/")),
                });
            }
            Err(e) => return Err(SeamError::Io(format!("copy slice into staging: {e}"))),
        };

        let now = offset.saturating_add(copied);
        if now < total {
            return Ok(Response::Copied {
                offset: now,
                done: false,
            });
        }

        paths.set_owner(&staging_file, owner_uid, owner_gid)?;
        if let Err(e) = staging_file.sync_all() {
            if matches!(
                crate::data::classify(&e),
                crate::data::FailureKind::OutOfSpace
            ) {
                // ZFS accounts quota at transaction-group commit, so this is where a full dataset
                // most often shows up — `data.rs` says the same about uploads.
                return Ok(Response::OutOfSpace {
                    reason: format!("no space to flush the copy: {e}"),
                });
            }
            return Err(SeamError::Io(format!("fsync copy before publish: {e}")));
        }

        let mut dest_dir: Vec<&str> = vec![share];
        dest_dir.extend_from_slice(to_dirs);
        let staging_dir = [share, STAGING_DIR[0], STAGING_DIR[1]];

        match paths.publish(&staging_dir, staging_name, &dest_dir, to_name) {
            Ok(()) => Ok(Response::Copied {
                offset: now,
                done: true,
            }),
            // The destination parent is gone, or was never there. `RENAME_NOREPLACE` is
            // all-or-nothing, so the staging file is still where it was and the sweeper will take
            // it.
            Err(SeamError::NotFound(what)) => Ok(Response::NotFound {
                reason: format!("{what}: no such entry"),
            }),
            Err(SeamError::AlreadyExists(what)) => Ok(Response::Conflict {
                reason: format!("{what}: something is already there"),
            }),
            Err(other) => Err(other),
        }
    }

    /// The off-site identity and the destinations this appliance trusts.
    ///
    /// The PUBLIC key only. There is no path from this operation set to the private half, which is
    /// the property that makes generating the key on the privileged side worth anything at all.
    fn offsite_status(&self) -> Result<Response, SeamError> {
        let key = crate::offsite::key_path();
        let has_identity = key.exists();

        let public_key = if has_identity {
            std::fs::read_to_string(crate::offsite::public_key_path())
                .ok()
                .map(|s| s.trim().to_string())
        } else {
            None
        };
        let fingerprint = if has_identity {
            let argv = crate::offsite::fingerprint_argv(&crate::offsite::public_key_path());
            let borrowed: Vec<&str> = argv.iter().map(String::as_str).collect();
            self.runner
                .run(bin::SSH_KEYGEN, &borrowed)
                .ok()
                .map(|s| s.trim().to_string())
        } else {
            None
        };

        // The PATTERNS, not the key material. What a person needs to see is which destinations
        // this box will talk to; the base64 blob answers nothing they can act on.
        let trusted = std::fs::read_to_string(crate::offsite::known_hosts_path())
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .filter_map(|line| line.split_whitespace().next().map(str::to_string))
            .collect();

        Ok(Response::Offsite {
            has_identity,
            public_key,
            fingerprint,
            trusted,
        })
    }

    /// `ssh-keygen -l` on one host key line, through a file because that is what the tool takes.
    ///
    /// OpenSSH computes it, not DEPSIS. The user compares this string against what
    /// `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the far end, and a second
    /// implementation of the format would be a second chance for that comparison to fail for a
    /// reason that has nothing to do with the key.
    fn fingerprint_of(&self, line: &str) -> Result<String, SeamError> {
        let dir = crate::offsite::state_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| SeamError::Io(format!("{}: {e}", dir.display())))?;
        let scratch = dir.join("scan.pub");
        (self.private_writer)(&scratch, &format!("{line}\n"))
            .map_err(|e| SeamError::Io(format!("{}: {e}", scratch.display())))?;

        let argv = crate::offsite::fingerprint_argv(&scratch);
        let borrowed: Vec<&str> = argv.iter().map(String::as_str).collect();
        let out = self.runner.run(bin::SSH_KEYGEN, &borrowed);
        // Removed whether or not the fingerprint worked: a leftover file under the agent's own
        // state directory is a public key nobody asked to keep.
        let _ = std::fs::remove_file(&scratch);
        Ok(out?.trim().to_string())
    }

    /// The dumps on disk, newest first.
    fn database_dumps(&self) -> Result<Response, SeamError> {
        let dir = crate::dbdump::dump_dir();
        Ok(Response::DatabaseDumps {
            dumps: crate::dbdump::read_dumps(&dir)?
                .into_iter()
                .map(|dump| DatabaseDump {
                    name: dump.name,
                    size_bytes: dump.size_bytes,
                    created_unix: dump.created_unix,
                })
                .collect(),
            directory: dir.display().to_string(),
        })
    }

    /// The networks this appliance controls, each read in full.
    ///
    /// The list endpoint gives bare ids and nothing else, so each one is fetched — the interface
    /// needs to say whether a network actually hands out addresses, and that is only in the
    /// record. A network that fails to read ABORTS the listing rather than being skipped: a
    /// silently short list on this screen is a network the household cannot see and cannot manage.
    fn controlled_networks(
        &self,
    ) -> Result<Vec<ZeroTierControlledNetwork>, crate::zerotier::ZeroTierError> {
        let ids = crate::ztcontroller::networks()?;
        let mut found = Vec::with_capacity(ids.len());
        for id in &ids {
            found.push(describe_network(&crate::ztcontroller::network(id)?));
        }
        Ok(found)
    }

    /// `zpool status`, read for the two lines a person acts on.
    fn scrub_status(&self, pool: &str) -> Result<Response, SeamError> {
        let out = self
            .runner
            .run(bin::ZPOOL, &crate::scrub::status_argv(pool))?;
        let info = crate::scrub::parse_status(&out);
        Ok(Response::Scrub {
            scan: info.scan,
            errors: info.errors,
            in_progress: info.in_progress,
            has_errors: info.has_errors,
        })
    }

    /// One directory's contents, so the API can compare disk against `file_entries`.
    ///
    /// Names and metadata only — see `op::Request::ListDirectory` for why that is the whole point.
    /// The seam drops symlinks and everything that is neither a regular file nor a directory, and
    /// this drops anything whose name is not a `SafeComponent`: a name DEPSIS could never address
    /// must not become a row, because the row would be permanently unreachable.
    fn list_directory(
        &self,
        share: &str,
        path: &[&str],
        snapshot: Option<&str>,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        if Self::touches_agent_state(path) {
            return Ok(Response::Refused {
                reason: format!(
                    "{}/ is the agent's own tree and is not part of the share",
                    STAGING_DIR[0]
                ),
            });
        }

        let mut relative: Vec<&str> = vec![share];
        relative.extend_from_slice(path);

        let listed = match snapshot {
            Some(name) => paths.list_snapshot_entries(share, name, path),
            None => paths.list_entries(&relative),
        };
        let found = match listed {
            Ok(found) => found,
            Err(SeamError::NotFound(what)) => {
                return Ok(Response::NotFound {
                    reason: format!("{what}: no such directory"),
                });
            }
            Err(SeamError::NotADirectory(what)) => {
                return Ok(Response::NotFound {
                    reason: format!("{what}: not a directory"),
                });
            }
            // A snapshot mount that could not be crossed. Reported, not flattened into an empty
            // listing: an empty listing reads as "the snapshot holds nothing", and a person
            // looking for a file they deleted would act on that by giving up.
            Err(SeamError::PathEscape(what)) => {
                return Ok(Response::Refused {
                    reason: format!("{what}: refused by the path confinement"),
                });
            }
            Err(other) => return Err(other),
        };

        let truncated = found.len() > crate::op::MAX_LISTING;
        let entries = found
            .into_iter()
            .take(crate::op::MAX_LISTING)
            .filter_map(|entry| {
                // `.depsis` is the agent's own tree and never part of what the API indexes. It is
                // filtered here as well as refused above, because the share ROOT's listing would
                // otherwise report it as an ordinary folder for DEPSIS to create a row for.
                if path.is_empty() && entry.name == STAGING_DIR[0] {
                    return None;
                }
                Some(DirEntry {
                    name: SafeComponent::parse(entry.name).ok()?,
                    directory: entry.directory,
                    size: entry.size,
                    modified_unix: entry.modified_unix,
                })
            })
            .collect();

        Ok(Response::Listing { entries, truncated })
    }

    fn remove_entry(
        &self,
        share: &str,
        path: &[&str],
        directory: bool,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        let Some((name, dirs)) = path.split_last() else {
            return Ok(Response::Refused {
                reason: "a remove needs a path; the share root is not an entry".to_string(),
            });
        };
        if Self::touches_agent_state(path) {
            return Ok(Response::Refused {
                reason: format!(
                    "{}/ is the agent's own tree; use discard_transfer",
                    STAGING_DIR[0]
                ),
            });
        }

        // The same interlock `DiscardTransfer` asks, and it is worth being precise about what it
        // does and does not catch here, because the obvious reading of it is wrong.
        //
        // A READ takes no reservation — `TransferRegistry::insert` says why, and P1-D measured the
        // bug that made it so — therefore this does NOT refuse while a download is streaming. It
        // does not need to: unlinking a file whose reader holds an open descriptor leaves that
        // reader on the same inode with the same bytes, and the space comes back when it closes.
        // The dangerous direction is a WRITER, and a writer is always in `.depsis/staging`, which
        // the refusal above has already made unreachable.
        //
        // The check stays because it is the honest statement of the invariant — the agent does not
        // unlink a name the registry has spoken for — and because the day a read does take a
        // reservation, this is the line that would otherwise have to be remembered.
        let key = path.join("/");
        {
            let registry = self
                .transfers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if registry.is_busy(share, &key) {
                return Ok(Response::Refused {
                    reason: format!("{key} has a transfer open right now"),
                });
            }
        }

        let mut parent: Vec<&str> = vec![share];
        parent.extend_from_slice(dirs);

        let removed = if directory {
            match paths.remove_dir(&parent, name) {
                Ok(removed) => removed,
                // Not a fault. There is no loop above this and no recursive flag below it: the
                // agent's answer to a populated directory is "no", and the caller's answer is to
                // remove the children first.
                Err(SeamError::NotEmpty(_)) => {
                    return Ok(Response::Conflict {
                        reason: format!("{key} still has entries in it"),
                    })
                }
                Err(other) => return Err(other),
            }
        } else {
            paths.remove_file(&parent, name)?
        };

        if !removed {
            // Distinguishable, deliberately, and the opposite of `Discarded { existed: false }`.
            // A discard races the sweeper, so "already gone" is a success there. A remove the user
            // asked for finding nothing means the caller's picture of the tree and the disk have
            // diverged; answering "done" would hide that and the API would report a deletion that
            // never happened.
            return Ok(Response::NotFound {
                reason: format!("{key}: no such entry"),
            });
        }

        Ok(Response::Removed {})
    }

    /// Close a share root to everyone its ACL does not name.
    ///
    /// One `openat2` and one `fchmod`, and both halves matter. The resolution is the ordinary
    /// confined one — `RESOLVE_BENEATH` under the shares root — so a share name that tried to
    /// leave the tree never reaches the syscall. The `fchmod` is aimed at the DESCRIPTOR, so the
    /// directory it changes is the one the kernel already pinned; a path-taking `chmod` could be
    /// redirected between the resolve and the call, which for a mode change on the top of a share
    /// is about the worst redirection available.
    ///
    /// Nothing to undo and nothing to verify afterwards, unlike `apply_folder_acl`: the mode is a
    /// constant this agent owns rather than a list the caller sent, so there is no "did it write
    /// what I asked" question to answer. `fchmod` either succeeded or returned an error.
    ///
    /// Idempotent. Running it on a root that is already 0750 is a no-op that reports the same
    /// answer, which is what lets the API run it before every root ACL write instead of tracking
    /// which shares have been done.
    fn secure_share_root(&self, share: &str) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        // The share itself, as a directory. A share that does not exist comes back as `NotFound`
        // rather than being created — this operation secures, it does not provision.
        let root = match paths.open_dir(&[share]) {
            Ok(dir) => dir,
            Err(SeamError::NotFound(what)) => {
                return Ok(Response::NotFound {
                    reason: format!("no such share: {what}"),
                });
            }
            Err(e) => return Err(e),
        };

        paths.set_mode(&root, SHARE_ROOT_MODE)?;
        Ok(Response::ShareRootSecured {
            mode: SHARE_ROOT_MODE,
        })
    }

    /// Create ONE directory inside a share, owned by the user, durably.
    ///
    /// The operation that was missing while `FilesService.createFolder` wrote a row and nothing
    /// else. What it must not become is `mkdir -p`: the API keeps one row per directory, so the
    /// agent creating intermediate nodes silently would leave directories on disk that nothing in
    /// the database names — invisible to the UI, unmovable, undeletable. A missing parent is an
    /// error the API needs to hear about, not one to work around here.
    ///
    /// `CopyService.plan` depends on the no-implicit-mkdir rule: it walks breadth-first precisely
    /// so that every folder exists before anything inside it is copied. A silent `mkdir -p` here
    /// would make that ordering unnecessary and its absence undetectable.
    fn create_directory(
        &self,
        share: &str,
        path: &[&str],
        owner_uid: PosixId,
        owner_gid: PosixId,
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };
        // An empty path names the share root, which already exists and is a dataset rather than a
        // folder. Reachable only by leaving the list empty, so it is refused explicitly rather
        // than allowed to arrive at `mkdirat` as an empty name.
        let Some((name, dirs)) = path.split_last() else {
            return Ok(Response::Refused {
                reason: "a directory needs a name; the share root is not one to create".to_string(),
            });
        };
        // The same door `MoveEntry` and `RemoveEntry` close. `.depsis/` lives inside the share, so
        // a caller-supplied path can name it, and a directory the API believes is the user's
        // sitting inside the agent's staging tree would be swept, published into, or collided with
        // by a staging name. The upload path has its own operations and they are the only way in.
        if Self::touches_agent_state(path) {
            return Ok(Response::Refused {
                reason: format!("{}/ is the agent's own tree", STAGING_DIR[0]),
            });
        }
        // No owner check here either, and for the reason `publish_transfer` gives: `PosixId` makes
        // root and the host's own accounts unrepresentable, so the refusal happens at parse time.
        // A directory owned by root at 0750 is one the user cannot enter, and the obvious-looking
        // repair for "my folder will not open" is to widen the mode — which is the cross-tenant
        // listing the mode is 0750 to prevent.

        let mut parent: Vec<&str> = vec![share];
        parent.extend_from_slice(dirs);

        // Filesystem FIRST, and the database row afterwards on the caller's side. Reversed, a row
        // exists for a directory that is not on disk — which is precisely the state this operation
        // was added to end.
        match paths.create_dir(&parent, name, owner_uid.get(), owner_gid.get()) {
            Ok(()) => Ok(Response::DirectoryCreated {}),
            // 409. The name is taken — by this user's own earlier folder, by a file, or by a
            // directory created over SMB — and the caller can act on it. Answering "created" would
            // hand the API a second row for one directory.
            Err(SeamError::AlreadyExists(what)) => Ok(Response::Conflict {
                reason: format!("{what}: something is already there"),
            }),
            // 404. A component between the share root and the new name does not exist. No implicit
            // mkdir: see the note on the operation.
            Err(SeamError::NotFound(_)) => Ok(Response::NotFound {
                reason: format!("{}: the parent folder does not exist", parent.join("/")),
            }),
            // Also 404-shaped, and it used to be a 500. A component of the chain is a FILE, which
            // `openat2(O_DIRECTORY)` answers with ENOTDIR; before that errno had its own variant it
            // collapsed into `PathEscape` and fell through to `Err(other)`, so "there is a file in
            // the way" reached the API as an agent fault. The caller can act on this one — it has
            // to stop materialising and tell the user — so it must not look like a crash.
            Err(SeamError::NotADirectory(what)) => Ok(Response::NotFound {
                reason: format!("{what}: a file is in the way; this component is not a folder"),
            }),
            Err(other) => Err(other),
        }
    }

    /// Rewrite one folder's POSIX ACL — access ACL and default ACL both.
    ///
    /// Only the environment lookup lives here; the work is `acl::Applier`, for the same reason the
    /// Samba arm below is three lines over `samba::publish`. What stays in the dispatcher is the
    /// mapping onto the answers the API can act on, and here they are four:
    ///
    ///   acl_applied      the kernel now enforces the grant, inheritance included
    ///   acl_unavailable  the `acl` package is not here — a 503, not a fault (ADR-0004, §17)
    ///   refused          the request could not be written correctly and NOTHING was cleared
    ///   failed           the dataset has no working ACL layer, or a pass died half-done
    ///
    /// The third and fourth are worth separating precisely because the first thing `Applier` does
    /// is `setfacl -b`. A refusal that never reached the clear has left the folder's existing
    /// permissions exactly as they were; a failure may not have.
    fn apply_folder_acl(
        &self,
        share: &str,
        path: &[&str],
        entries: &[AclEntry],
    ) -> Result<Response, SeamError> {
        // The share tree's location is operator configuration, on the same footing as
        // `samba::config_path`. "Which tree does the privileged daemon rewrite the permissions of"
        // is not a question an unprivileged caller may answer, so it is read from the environment
        // and the request enum has no operand for it.
        let root = match acl::shares_root_from_env() {
            Ok(root) => root,
            Err(e) => {
                return Ok(Response::Refused {
                    reason: e.to_string(),
                })
            }
        };
        self.apply_folder_acl_with(&acl::Applier::new(self.runner, root), share, path, entries)
    }

    /// The half of the arm with no environment in it, so it can be driven from a test.
    ///
    /// Split off rather than inlined above because the alternative was to leave the whole mapping
    /// untested: the applier reaches the real filesystem to decide whether `setfacl` is installed,
    /// and on a box without the `acl` package — every developer machine on this project, and the
    /// Windows target CI cross-checks — every path through here would stop at the same early
    /// return. A test supplies an applier whose probe and runner it controls; production supplies
    /// one built from the environment.
    fn apply_folder_acl_with<Q: CommandRunner>(
        &self,
        applier: &acl::Applier<'_, Q>,
        share: &str,
        path: &[&str],
        entries: &[AclEntry],
    ) -> Result<Response, SeamError> {
        let Some(paths) = self.paths else {
            return Ok(Response::Refused {
                reason: "no share root is configured; storage is not set up".to_string(),
            });
        };

        // The same door `MoveEntry`, `RemoveEntry` and `CreateDirectory` close, and this was the
        // one path-taking operation that left it open. `.depsis/` lives inside the share, so a
        // caller-supplied path can name it — and an ACL is the worst of the four things to let in
        // there. A group entry on `staging` overrides the 0600 that keeps a half-uploaded file from
        // being read by another tenant, and the write bit is sharper still: a group member can
        // rewrite a `.part` in flight, and `PublishTransfer` checks only the byte count, so
        // substituted content of equal length publishes as the uploader's own file.
        if Self::touches_agent_state(path) {
            return Ok(Response::Refused {
                reason: format!("{}/ is the agent's own tree", STAGING_DIR[0]),
            });
        }

        match applier.apply(paths, share, path, entries) {
            Ok(written) => Ok(Response::AclApplied { entries: written }),

            // Not a fault. DEPSIS does not package `acl`, so its absence is an ordinary state of
            // a machine, and 503-with-a-card is what the API SHOULD answer here. It does not yet:
            // nothing in `apps/api/src` sends `apply_folder_acl` and nothing writes `folder_grants`
            // (both verified by grep, not assumed), so this response has no consumer at all. Said
            // in the future tense on purpose — a comment describing a caller that does not exist is
            // the same "two realities" this project refuses everywhere else.
            Err(e) if e.is_unavailable() => Ok(Response::AclUnavailable {
                reason: e.to_string(),
            }),

            // 404. The folder the caller named is not on disk — which is a real state while the
            // database and the share tree can disagree, and the caller does something about it.
            Err(AclError::Path(SeamError::NotFound(what))) => Ok(Response::NotFound {
                reason: format!("{what}: no such folder"),
            }),

            // Also 404, and it needs the honest sentence rather than the containment one. A file
            // where a folder was named is ENOTDIR; while every non-ENOENT errno became
            // `PathEscape`, this arrived as "path escapes the share root", which reads as a caller
            // trying to break out. ADR-0017 exists because that misdiagnosis cost a bisection.
            Err(AclError::Path(SeamError::NotADirectory(what))) => Ok(Response::NotFound {
                reason: format!("{what}: that name is a file, and only folders carry an ACL"),
            }),

            // 400-shaped: the request itself could not be written correctly, and `Applier` refuses
            // all of these BEFORE the clear, so the folder still carries whatever it carried.
            Err(
                e @ (AclError::DuplicateGroup { .. }
                | AclError::TooManyEntries { .. }
                | AclError::NoSharesRoot
                | AclError::Escape(_)
                | AclError::NonUtf8Path
                | AclError::Path(SeamError::PathEscape(_))),
            ) => Ok(Response::Refused {
                reason: e.to_string(),
            }),

            // Everything else is a fault someone must read, and it goes back as an error rather
            // than a response so that `handle` records it as one. `AclTypeNotPosix` is the reason
            // this branch matters: the dataset is not `acltype=posixacl`, so the kernel enforces no
            // access control there at all (ADR-0004), and that is a page-the-operator event rather
            // than a bad request. `TimedOut` and `DefaultAclFailed` belong here for the opposite
            // half of the same argument — both may have left the tree partly rewritten.
            Err(other) => Err(SeamError::Io(other.to_string())),
        }
    }

    /// Handle one raw request line.
    ///
    /// Returns a `Response` in every case, including refusal — the caller is a program, and a
    /// dropped connection is harder to diagnose than a structured refusal.
    pub fn handle(
        &self,
        raw: &str,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Response {
        let request: Request = match serde_json::from_str(raw) {
            Ok(r) => r,
            Err(e) => {
                // No audit entry with an operation name here: we do not know what was asked,
                // and inventing one would put a fiction in an append-only log.
                return Response::Refused {
                    reason: format!("unparseable request: {e}"),
                };
            }
        };

        match self.policy.authorize(peer, &request) {
            Decision::Deny(why) => {
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Refused(why.to_string()),
                ));
                return Response::Refused {
                    reason: why.to_string(),
                };
            }
            Decision::Allow => {}
        }

        self.audit.record(audit::entry(
            correlation_id,
            peer,
            &request,
            reason,
            Outcome::Allowed,
        ));

        match self.execute(&request, peer, correlation_id, reason) {
            // A refusal decided by the OPERATION rather than by the policy, and it gets its own
            // entry for the same reason a failure does. The line above says the request was
            // allowed to proceed, which is true and is not the outcome — and the refusals that
            // reach here are the ones most worth having in an append-only log: a WWN that no
            // longer matches means somebody swapped a disk between the confirmation and the
            // button, and without this the trail records that as `allowed` and nothing else.
            //
            // TWO ENTRIES FOR ONE REQUEST, deliberately. The first is written before the work
            // starts, so an agent that dies mid-operation still leaves the attempt behind; this
            // one carries the answer. They share a correlation id.
            Ok(Response::Refused { reason: why }) => {
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Refused(why.clone()),
                ));
                Response::Refused { reason: why }
            }
            Ok(response) => response,
            Err(e) => {
                let msg = e.to_string();
                self.audit.record(audit::entry(
                    correlation_id,
                    peer,
                    &request,
                    reason,
                    Outcome::Failed(msg.clone()),
                ));
                Response::Failed { reason: msg }
            }
        }
    }

    /// Run one already-parsed, already-authorized request.
    ///
    /// Takes the peer and the envelope's audit fields because the transfer operations must RECORD
    /// them: a token has an owner (only that uid may redeem it on the data socket) and a data
    /// connection has to be traceable back to the HTTP request that caused it. Threading them here
    /// rather than looking them up later is what makes both properties impossible to forget.
    fn execute(
        &self,
        request: &Request,
        peer: PeerIdentity,
        correlation_id: &str,
        reason: &str,
    ) -> Result<Response, SeamError> {
        match request {
            Request::Ping {} => Ok(Response::Ok {
                schema_version: SCHEMA_VERSION,
            }),

            Request::PoolStatus { pool } => {
                // -H -p: script-parsable, exact byte counts. Never statvfs (ADR-0008, P0-G).
                let out = self.runner.run(
                    bin::ZFS,
                    &["get", "-Hp", "-o", "value", "used,available", pool.as_str()],
                )?;
                let mut it = out.split_whitespace();
                let used = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let available = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let health = self
                    .runner
                    .run(bin::ZPOOL, &["list", "-H", "-o", "health", pool.as_str()])?
                    .trim()
                    .to_string();
                Ok(Response::PoolStatus {
                    health,
                    used_bytes: used,
                    available_bytes: available,
                })
            }

            Request::CreateDataset {
                dataset,
                acltype,
                refquota_bytes,
            } => {
                let acl = match acltype {
                    // The only variant that exists. P0-B measured that `nfsv4` reports itself
                    // as configured while enforcing nothing, so it is unrepresentable in `op`.
                    AclType::Posixacl => "acltype=posixacl",
                };
                let quota;
                let mut args: Vec<&str> = vec![
                    "create",
                    "-o",
                    acl,
                    "-o",
                    "xattr=sa",
                    "-o",
                    "dnodesize=auto",
                ];
                if let Some(bytes) = refquota_bytes {
                    quota = format!("refquota={bytes}");
                    args.push("-o");
                    args.push(&quota);
                }
                args.push(dataset.as_str());
                self.runner.run(bin::ZFS, &args)?;

                // Verify rather than assume. P0-B: acltype=nfsv4 sets cleanly and reports
                // itself back, so "the create command succeeded" proves nothing about whether
                // ACLs work. Read the property and refuse to hand over a dataset that would
                // silently enforce nothing.
                let got = self
                    .runner
                    .run(
                        bin::ZFS,
                        &["get", "-H", "-o", "value", "acltype", dataset.as_str()],
                    )?
                    .trim()
                    .to_string();
                // `posixacl` reads back as `posix` — a documented alias, measured in P0-A.
                if !matches!(got.as_str(), "posixacl" | "posix") {
                    return Ok(Response::Failed {
                        reason: format!(
                            "dataset created but acltype reads back as {got:?}; refusing to \
                             publish a dataset that may enforce no ACLs at all"
                        ),
                    });
                }
                Ok(Response::Created {
                    dataset: dataset.as_str().to_string(),
                })
            }

            Request::CreateSnapshot { dataset, name } => {
                let full = format!("{}@{}", dataset.as_str(), name.as_str());
                self.runner.run(bin::ZFS, &["snapshot", &full])?;
                Ok(Response::Snapshot { full_name: full })
            }

            Request::ReplicateDataset {
                source,
                snapshot,
                target,
                base,
            } => {
                // BEFORE ANYTHING IS SPAWNED. `recv -F` is not undoable, so the refusals cannot be
                // something the operation discovers half way through.
                let shares = self.share_dataset()?;
                if let Err(refusal) =
                    crate::replicate::check(source.as_str(), target.as_str(), shares.as_deref())
                {
                    return Ok(Response::Refused {
                        reason: refusal.reason().to_string(),
                    });
                }

                let full = format!("{}@{}", source.as_str(), snapshot.as_str());
                let from = base
                    .as_ref()
                    .map(|b| format!("{}@{}", source.as_str(), b.as_str()));
                let send = crate::replicate::send_argv(&full, from.as_deref());
                let recv = crate::replicate::recv_argv(target.as_str());

                match self.runner.run_piped(bin::ZFS, &send, bin::ZFS, &recv) {
                    Ok(detail) => Ok(Response::Replicated { detail, base: from }),
                    // The target has drifted, so the incremental cannot apply. Reported rather
                    // than retried as a full send on the agent's own initiative: moving a terabyte
                    // is a decision, and the caller is the side that gets to make it.
                    Err(error) if crate::replicate::incremental_rejected(&error) => {
                        Ok(Response::Refused {
                            reason: "the target does not hold the base snapshot; a full send is \
                                     needed"
                                .to_string(),
                        })
                    }
                    Err(error) => Err(error),
                }
            }

            Request::OffsiteStatus {} => self.offsite_status(),

            Request::OffsiteCreateIdentity {} => {
                // CHECKED FIRST, and not left to `ssh-keygen`. Asked to overwrite, `ssh-keygen`
                // PROMPTS — and a prompt on a daemon's stdin never returns, so the operation would
                // hang holding the control socket rather than refuse.
                if crate::offsite::key_path().exists() {
                    return Ok(Response::Refused {
                        reason: crate::offsite::Refusal::IdentityExists.reason().to_string(),
                    });
                }
                let dir = crate::offsite::state_dir();
                std::fs::create_dir_all(&dir)
                    .map_err(|e| SeamError::Io(format!("{}: {e}", dir.display())))?;

                let key = crate::offsite::key_path();
                let argv = crate::offsite::keygen_argv(&key);
                let borrowed: Vec<&str> = argv.iter().map(String::as_str).collect();
                self.runner.run(bin::SSH_KEYGEN, &borrowed)?;
                self.offsite_status()
            }

            Request::OffsiteScanHost { host, port } => {
                let argv = crate::offsite::keyscan_argv(host, *port);
                let borrowed: Vec<&str> = argv.iter().map(String::as_str).collect();
                let scanned = match self.runner.run(bin::SSH_KEYSCAN, &borrowed) {
                    Ok(out) => out,
                    // A destination that is off, firewalled or not running SSH is an ORDINARY
                    // state of the world, not a fault of this appliance. Reported as a refusal
                    // with the reason so the user reads "could not reach it" rather than a 500.
                    Err(error) => {
                        return Ok(Response::Refused {
                            reason: format!("could not reach {}: {error}", host.as_str()),
                        })
                    }
                };

                let mut keys = Vec::new();
                for found in crate::offsite::parse_keyscan(&scanned) {
                    // Fingerprinted by OPENSSH, through a file, because `ssh-keygen -l` takes a
                    // file. One key per file so the pairing is by construction rather than by
                    // trusting two outputs to come back in the same order.
                    let fingerprint = self.fingerprint_of(&found.line)?;
                    keys.push(OffsiteHostKey {
                        kind: found.kind,
                        line: found.line,
                        fingerprint,
                    });
                }
                Ok(Response::OffsiteHostKeys { keys })
            }

            Request::OffsiteTrustHost { host, port, line } => {
                // The line must actually BE for this host and port. Without this, confirming a
                // fingerprint the user checked for one destination would write an entry that
                // authorises a completely different one — the exact substitution the whole
                // confirm-the-fingerprint ritual exists to prevent.
                let pattern = crate::offsite::host_key_pattern(host, *port);
                let names = line.as_str().split_whitespace().next().unwrap_or("");
                if !names.split(',').any(|name| name == pattern) {
                    return Ok(Response::Refused {
                        reason: format!("that host key line is for {names:?}, not for {pattern:?}"),
                    });
                }

                let path = crate::offsite::known_hosts_path();
                let existing = std::fs::read_to_string(&path).unwrap_or_default();
                // Idempotent: confirming the same key twice is a user pressing a button twice,
                // and a duplicated line is a file that grows without bound.
                if !existing.lines().any(|had| had.trim() == line.as_str()) {
                    let mut body = existing;
                    if !body.is_empty() && !body.ends_with('\n') {
                        body.push('\n');
                    }
                    body.push_str(line.as_str());
                    body.push('\n');
                    let dir = crate::offsite::state_dir();
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| SeamError::Io(format!("{}: {e}", dir.display())))?;
                    (self.private_writer)(&path, &body)
                        .map_err(|e| SeamError::Io(format!("{}: {e}", path.display())))?;
                }
                self.offsite_status()
            }

            Request::ReplicateOffsite {
                source,
                snapshot,
                base,
                host,
                port,
                user,
                target,
            } => {
                // BEFORE ANYTHING IS SPAWNED, and both refusals matter. Without a key `ssh` would
                // fall back to asking for a password on a stdin nobody is holding; without a
                // confirmed host key it would either prompt or — with the wrong options — accept
                // whatever answered, which on a replication is an attacker receiving a copy of
                // every file this appliance holds.
                if !crate::offsite::key_path().exists() {
                    return Ok(Response::Refused {
                        reason: crate::offsite::Refusal::NoIdentity.reason().to_string(),
                    });
                }
                let known =
                    std::fs::read_to_string(crate::offsite::known_hosts_path()).unwrap_or_default();
                if !crate::offsite::trusts(&known, host, *port) {
                    return Ok(Response::Refused {
                        reason: crate::offsite::Refusal::HostNotTrusted.reason().to_string(),
                    });
                }

                let full = format!("{}@{}", source.as_str(), snapshot.as_str());
                let from = base
                    .as_ref()
                    .map(|b| format!("{}@{}", source.as_str(), b.as_str()));
                let send = crate::replicate::send_argv(&full, from.as_deref());
                let ssh = crate::offsite::ssh_recv_argv(
                    user,
                    host,
                    *port,
                    target.as_str(),
                    &crate::offsite::key_path(),
                    &crate::offsite::known_hosts_path(),
                );
                let ssh_borrowed: Vec<&str> = ssh.iter().map(String::as_str).collect();

                match self
                    .runner
                    .run_piped(bin::ZFS, &send, bin::SSH, &ssh_borrowed)
                {
                    Ok(detail) => Ok(Response::Replicated { detail, base: from }),
                    // A CHANGED HOST KEY IS ITS OWN ANSWER. It is either a reinstalled server or
                    // somebody standing in the middle, and DEPSIS must not guess which — the user
                    // re-confirms deliberately or not at all.
                    Err(error) if crate::offsite::host_key_changed(&error) => {
                        Ok(Response::Refused {
                            reason: format!(
                                "{} is no longer presenting the host key that was confirmed. \
                                 Either it was reinstalled, or something is answering in its \
                                 place. Scan and confirm it again only if you know which.",
                                host.as_str()
                            ),
                        })
                    }
                    Err(error) if crate::replicate::incremental_rejected(&error) => {
                        Ok(Response::Refused {
                            reason: "the destination does not hold the base snapshot; a full \
                                     send is needed"
                                .to_string(),
                        })
                    }
                    Err(error) => Err(error),
                }
            }

            Request::DestroySnapshot { dataset, snapshot } => {
                // `@` REFUSED IN THE SNAPSHOT NAME, and not because `zfs` would accept it —
                // `tank/x@a@b` is an invalid name and `zfs destroy` says so. It is refused here so
                // that the argument this agent constructs is provably one dataset and one snapshot
                // by reading these six lines, rather than by reasoning about another program's
                // parser. `DatasetName` already has no `@` in its character set.
                if snapshot.as_str().contains('@') {
                    return Ok(Response::Refused {
                        reason: "a snapshot name may not contain '@'".to_string(),
                    });
                }
                let full = format!("{}@{}", dataset.as_str(), snapshot.as_str());

                // No flags at all. `-r` walks children, `-R` walks clones and dependents, `-d`
                // defers and hides the outcome; each hands the blast radius to the caller, which
                // is the one thing §2.2 says a single accepted call must never do.
                self.runner.run(bin::ZFS, &["destroy", &full])?;
                Ok(Response::SnapshotDestroyed { full_name: full })
            }

            Request::DumpDatabase { name, keep } => {
                let Some(url) = std::env::var_os(crate::dbdump::DATABASE_URL_ENV) else {
                    // REFUSED rather than defaulted. Inventing `postgres://localhost/depsis` would
                    // mean dumping the wrong database and reporting "you have a backup", which is
                    // worse than having none.
                    return Ok(Response::Refused {
                        reason: format!(
                            "{} is not set, so there is no database to dump",
                            crate::dbdump::DATABASE_URL_ENV
                        ),
                    });
                };
                let Some(url) = url.to_str().map(str::to_string) else {
                    return Ok(Response::Refused {
                        reason: format!("{} is not valid UTF-8", crate::dbdump::DATABASE_URL_ENV),
                    });
                };

                let dir = crate::dbdump::dump_dir();
                std::fs::create_dir_all(&dir)
                    .map_err(|e| SeamError::Io(format!("{}: {e}", dir.display())))?;

                let out = dir.join(format!("{}{}", name.as_str(), crate::dbdump::DUMP_SUFFIX));
                let out_display = out.display().to_string();

                // 0600 BEFORE `pg_dump` writes into it. `pg_dump` creates the file itself with the
                // process umask, so creating it here first — empty and already private — is what
                // keeps the window between "file exists" and "file is not world-readable" from
                // existing at all. The same ordering `identity::write_private` explains.
                (self.private_writer)(&out, "")
                    .map_err(|e| SeamError::Io(format!("{out_display}: {e}")))?;

                let argv = crate::dbdump::dump_argv(&url, &out_display);
                if let Err(error) = self.runner.run(bin::PG_DUMP, &argv) {
                    // A failed dump leaves the empty 0600 file behind, and an empty `.dump` in the
                    // directory is worse than no file: the next listing would show it as a backup.
                    let _ = std::fs::remove_file(&out);
                    return Err(error);
                }

                // Budama dökümden SONRA: yeni döküm sayıya dahil, ve önce budasaydık `keep` her
                // turda bir fazla tutardı. Anlık görüntü budamasındaki aynı sıra.
                let existing = crate::dbdump::read_dumps(&dir)?;
                for doomed in crate::dbdump::prunable(&existing, (*keep).max(1) as usize) {
                    let path = dir.join(&doomed);
                    if let Err(error) = std::fs::remove_file(&path) {
                        // Not fatal, and not silent either: the dump itself succeeded, and a
                        // directory that grows is a disk-space problem rather than a lost backup —
                        // but a pruning that quietly stops working is how the disk fills.
                        eprintln!("depsis-agent: could not prune {}: {error}", path.display());
                    }
                }

                self.database_dumps()
            }

            Request::BackupNodeIdentity { name, keep } => {
                let home = crate::ztstate::home();
                let parts = crate::ztstate::present_parts(&home);
                if parts.is_empty() {
                    // NOT an error and not a silent success: a box with no ZeroTier has nothing to
                    // archive, and writing an empty tar would put a file in the directory that
                    // the next listing counts as a backup.
                    return Ok(Response::NodeIdentityBackedUp {
                        name: String::new(),
                        size_bytes: 0,
                        included: Vec::new(),
                        unreadable: Vec::new(),
                    });
                }

                let dir = crate::dbdump::dump_dir();
                std::fs::create_dir_all(&dir)
                    .map_err(|e| SeamError::Io(format!("{}: {e}", dir.display())))?;

                let file = format!(
                    "{}{}{}",
                    crate::ztstate::BACKUP_PREFIX,
                    name.as_str(),
                    crate::ztstate::BACKUP_SUFFIX
                );
                let out = dir.join(&file);
                let out_display = out.display().to_string();

                // 0600 BEFORE any bytes, exactly as the database dump does and for a sharper
                // reason: this archive contains `identity.secret`, which is the appliance's whole
                // ZeroTier identity. `tar` would otherwise create it with the process umask.
                (self.private_writer)(&out, "")
                    .map_err(|e| SeamError::Io(format!("{out_display}: {e}")))?;

                // Counted BEFORE the archive is written, so the answer describes what went in.
                let unreadable = crate::ztstate::unreadable_records(&home);

                let home_display = home.display().to_string();
                let argv = crate::ztstate::tar_argv(&out_display, &home_display, &parts);
                if let Err(error) = self.runner.run(bin::TAR, &argv) {
                    // A failed archive leaves an empty 0600 file behind, and an empty
                    // `zerotier-*.tar` is worse than none: the next listing shows it as a backup.
                    let _ = std::fs::remove_file(&out);
                    return Err(error);
                }

                let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);

                // Prune AFTER, so the new archive counts — the same ordering as the snapshot and
                // database prunings, and the same reason: pruning first keeps one too many.
                let mut mine: Vec<(String, i64)> = std::fs::read_dir(&dir)
                    .map_err(|e| SeamError::Io(format!("{}: {e}", dir.display())))?
                    .flatten()
                    .filter_map(|entry| {
                        let file_name = entry.file_name().into_string().ok()?;
                        if !crate::ztstate::is_backup(&file_name) {
                            return None;
                        }
                        let when = entry
                            .metadata()
                            .ok()?
                            .modified()
                            .ok()?
                            .duration_since(std::time::UNIX_EPOCH)
                            .ok()?
                            .as_secs() as i64;
                        Some((file_name, when))
                    })
                    .collect();
                mine.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
                for (doomed, _) in mine.into_iter().skip((*keep).max(1) as usize) {
                    if let Err(error) = std::fs::remove_file(dir.join(&doomed)) {
                        eprintln!("depsis-agent: could not prune {doomed}: {error}");
                    }
                }

                Ok(Response::NodeIdentityBackedUp {
                    name: file,
                    size_bytes: size,
                    included: parts,
                    unreadable,
                })
            }

            Request::ListDatabaseDumps {} => self.database_dumps(),

            Request::StartScrub { pool } => {
                self.runner
                    .run(bin::ZPOOL, &crate::scrub::scrub_argv(pool.as_str()))?;
                // The status is read back rather than assumed. `zpool scrub` returns immediately
                // and says nothing; reporting "started" without looking would be an echo of the
                // request, and the one thing the caller wants to know is whether it IS running.
                self.scrub_status(pool.as_str())
            }

            Request::ScrubStatus { pool } => self.scrub_status(pool.as_str()),

            Request::ListSnapshots { dataset } => {
                let argv = crate::snapshots::list_snapshots_argv(dataset.as_str());
                match self.runner.run(bin::ZFS, &argv) {
                    Ok(out) => Ok(Response::Snapshots {
                        snapshots: crate::snapshots::parse_snapshots(dataset.as_str(), &out)
                            .into_iter()
                            .map(|s| SnapshotEntry {
                                name: s.name,
                                used_bytes: s.used_bytes,
                                created_at: s.created_at,
                            })
                            .collect(),
                        missing: false,
                    }),
                    // A dataset that is not there is an ANSWER, not a fault: it is the ordinary
                    // state of a box the setup wizard has not run on. Reporting it as an error
                    // would make an unconfigured appliance look broken.
                    Err(error) if crate::snapshots::missing_dataset(&error) => {
                        Ok(Response::Snapshots {
                            snapshots: Vec::new(),
                            missing: true,
                        })
                    }
                    Err(error) => Err(error),
                }
            }

            Request::DiffSnapshots { dataset, from, to } => {
                let a = format!("{}@{}", dataset.as_str(), from.as_str());
                let b = format!("{}@{}", dataset.as_str(), to.as_str());
                // -H tab-separated, -F include file type. R lines carry both paths, which is
                // what lets reconciliation see a rename as a rename (ADR-0011, P0-D).
                let out = self.runner.run(bin::ZFS, &["diff", "-H", "-F", &a, &b])?;
                Ok(Response::Diff {
                    lines: out.lines().map(str::to_string).collect(),
                })
            }

            Request::ListDisks {} => {
                // A constant argv. The operation has no operands, so there is nothing here that
                // came from the caller — see `Request::ListDisks` for why that is the point.
                let out = self.runner.run(bin::LSBLK, &crate::disks::argv())?;
                let (disks, truncated) = crate::disks::parse(&out)?;
                Ok(Response::Disks { disks, truncated })
            }

            Request::CreatePool {
                pool,
                topology,
                disks,
            } => self.create_pool(pool.as_str(), *topology, disks),
            crate::op::Request::WipeDisk { disk } => self.wipe_disk(disk),

            Request::ListPools {} => {
                let out = self
                    .runner
                    .run(bin::ZPOOL, &crate::pools::list_pools_argv())?;
                Ok(Response::Pools {
                    pools: crate::pools::parse_pools(&out),
                })
            }

            Request::ShareRootStatus {} => self.share_root_status(),

            Request::PrepareShareRoot { pool } => self.prepare_share_root(pool.as_str()),

            Request::ReadSmartSummary { disk_by_id } => {
                // Built from a validated single component, so the caller cannot reach outside
                // /dev/disk/by-id or smuggle a flag (risk R1).
                let path = format!("/dev/disk/by-id/{}", disk_by_id.as_str());
                let out = self
                    .runner
                    .run(bin::SMARTCTL, &["-H", "-A", "--json=c", &path])?;
                let summary = crate::smart::parse(&out);
                Ok(Response::Smart {
                    healthy: summary.healthy,
                    temperature_celsius: summary.temperature_celsius,
                    raw: out,
                })
            }

            Request::OpenTransfer {
                share,
                staging_name,
            } => self.open_transfer(
                share.as_str(),
                staging_name.as_str(),
                peer,
                correlation_id,
                reason,
            ),

            Request::PublishTransfer {
                share,
                staging_name,
                destination,
                expected_bytes,
                owner_uid,
                owner_gid,
            } => {
                let dest: Vec<&str> = destination.iter().map(|c| c.as_str()).collect();
                self.publish_transfer(
                    share.as_str(),
                    staging_name.as_str(),
                    &dest,
                    *expected_bytes,
                    *owner_uid,
                    *owner_gid,
                )
            }

            Request::DiscardTransfer {
                share,
                staging_name,
            } => self.discard_transfer(share.as_str(), staging_name.as_str()),

            Request::OpenDownload { share, path } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                self.open_download(share.as_str(), &parts, peer, correlation_id, reason)
            }

            Request::MoveEntry { share, from, to } => {
                let from: Vec<&str> = from.iter().map(|c| c.as_str()).collect();
                let to: Vec<&str> = to.iter().map(|c| c.as_str()).collect();
                self.move_entry(share.as_str(), &from, &to)
            }

            Request::CopyFile {
                share,
                from,
                to,
                staging_name,
                offset,
                max_bytes,
                owner_uid,
                owner_gid,
            } => {
                let from: Vec<&str> = from.iter().map(|c| c.as_str()).collect();
                let to: Vec<&str> = to.iter().map(|c| c.as_str()).collect();
                self.copy_file(&CopySlice {
                    share: share.as_str(),
                    snapshot: None,
                    from: &from,
                    to: &to,
                    staging_name: staging_name.as_str(),
                    offset: *offset,
                    max_bytes: *max_bytes,
                    owner_uid: owner_uid.get(),
                    owner_gid: owner_gid.get(),
                })
            }

            Request::ListDirectory { share, path } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                self.list_directory(share.as_str(), &parts, None)
            }

            Request::SnapshotEntries {
                share,
                snapshot,
                path,
            } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                self.list_directory(share.as_str(), &parts, Some(snapshot.as_str()))
            }

            Request::RestoreFromSnapshot {
                share,
                snapshot,
                from,
                to,
                staging_name,
                offset,
                max_bytes,
                owner_uid,
                owner_gid,
            } => {
                let from: Vec<&str> = from.iter().map(|c| c.as_str()).collect();
                let to: Vec<&str> = to.iter().map(|c| c.as_str()).collect();
                self.copy_file(&CopySlice {
                    share: share.as_str(),
                    snapshot: Some(snapshot.as_str()),
                    from: &from,
                    to: &to,
                    staging_name: staging_name.as_str(),
                    offset: *offset,
                    max_bytes: *max_bytes,
                    owner_uid: owner_uid.get(),
                    owner_gid: owner_gid.get(),
                })
            }

            Request::RemoveEntry {
                share,
                path,
                directory,
            } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                let response = self.remove_entry(share.as_str(), &parts, *directory)?;

                // A second audit record, and only for a removal that actually happened.
                //
                // `handle` already logged the intent before this ran, but `audit::Entry` carries
                // the operation NAME and nothing else — §16 keeps operands out of the trail by
                // default so that a field added later cannot leak a secret into it. That default is
                // right everywhere except here: this is the one operation with no undo, and
                // "remove_entry, allowed" does not answer "which file is gone?".
                //
                // A share name and a path are names, not contents, so recording them breaks none of
                // §16's rules. They go beside the caller's own reason because that is the field
                // that carries free text; the correlation id, uid and pid come from the envelope,
                // so the deletion can be followed back to the HTTP request that caused it.
                if matches!(response, Response::Removed {}) {
                    self.audit.record(audit::entry(
                        correlation_id,
                        peer,
                        request,
                        &format!(
                            "{reason} | removed {}/{}{}",
                            share.as_str(),
                            parts.join("/"),
                            if *directory { " (directory)" } else { "" }
                        ),
                        Outcome::Allowed,
                    ));
                }
                Ok(response)
            }

            Request::CreateDirectory {
                share,
                path,
                owner_uid,
                owner_gid,
            } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                self.create_directory(share.as_str(), &parts, *owner_uid, *owner_gid)
            }

            Request::SecureShareRoot { share } => self.secure_share_root(share.as_str()),

            Request::SyncPosixIdentity { users, groups } => {
                // The whole sequence — check every login against the machine, create the private
                // groups, the accounts, the team groups, the membership, then one passdb import —
                // lives in `identity`, because every step is a real effect on the box that has to
                // be tested against real `getent` output rather than asserted about an argv. What
                // stays here is the mapping onto the answers the API can act on, and there are
                // three:
                //
                //   posix_identity_synced  the machine matches; the counts say what changed
                //   smb_unavailable        Samba is not installed — a 503, not a fault (§17)
                //   refused                a login belongs to an account DEPSIS did not create,
                //                          or a uid is taken by a different name. Nothing was
                //                          changed: the checks run before the first `useradd`.
                let specs: Vec<crate::identity::UserSpec> = users
                    .iter()
                    .map(|u| crate::identity::UserSpec {
                        uid: u.uid,
                        login: u.login.clone(),
                        nt_hash: u.nt_hash.clone(),
                    })
                    .collect();
                let want: Vec<crate::identity::GroupSpec> = groups
                    .iter()
                    .map(|g| crate::identity::GroupSpec {
                        gid: g.gid,
                        members: g.members.clone(),
                    })
                    .collect();
                match crate::identity::sync(self.runner, self.private_writer, &specs, &want) {
                    Ok(outcome) => Ok(Response::PosixIdentitySynced {
                        users_created: outcome.users_created,
                        groups_created: outcome.groups_created,
                        passwords_set: outcome.passwords_set,
                    }),
                    Err(e) if e.is_unavailable() => Ok(Response::SmbUnavailable {
                        reason: e.to_string(),
                    }),
                    Err(
                        e @ (crate::identity::IdentityError::NotOurs { .. }
                        | crate::identity::IdentityError::UidTaken { .. }),
                    ) => Ok(Response::Refused {
                        reason: e.to_string(),
                    }),
                    Err(e) => Err(SeamError::Io(e.to_string())),
                }
            }

            Request::ApplyFolderAcl {
                share,
                path,
                entries,
            } => {
                let parts: Vec<&str> = path.iter().map(|c| c.as_str()).collect();
                self.apply_folder_acl(share.as_str(), &parts, entries)
            }

            Request::PublishSambaConfig { shares } => {
                // The whole sequence — generate, write atomically, testparm, live connection,
                // roll back on any refusal — lives in `samba`, because every step of it is
                // filesystem work that has to be tested against a real directory rather than
                // asserted about an argv. What stays here is the mapping onto the three answers
                // the API can act on, and they are deliberately three:
                //
                //   published        the shares are being served, proved by a client connecting
                //   smb_unavailable  Samba is not installed here — a 503, not a fault (§17)
                //   refused          Samba said no and the PREVIOUS configuration is back, so
                //                    whatever worked before still works (409)
                //
                // Anything else, the failed rollback above all, is an error: it must be audited
                // as a failure, because it is the one outcome that leaves the box worse than it
                // was found.
                let config = crate::samba::config_path();
                let host = crate::samba::Host::new(self.runner);
                match crate::samba::publish(&config, shares, &host) {
                    Ok(outcome) => Ok(Response::Published {
                        shares: outcome.shares,
                        verified: outcome.verified,
                    }),
                    Err(e) if e.is_unavailable() => Ok(Response::SmbUnavailable {
                        reason: e.to_string(),
                    }),
                    Err(
                        e @ (crate::samba::SambaError::RejectedRolledBack(_)
                        | crate::samba::SambaError::Unrepresentable(_)),
                    ) => Ok(Response::Refused {
                        reason: e.to_string(),
                    }),
                    Err(e) => Err(SeamError::Io(e.to_string())),
                }
            }

            // ── ZeroTier (ADR-0020) ──
            //
            // No `CommandRunner` and no `zerotier-cli`. The CLI is a thin wrapper over the same
            // local API, and going through it would mean a fork, an argv, and a text format to
            // parse — three things the closed operation set exists to avoid — in exchange for
            // nothing the HTTP call does not already give.
            Request::ZeroTierStatus {} => match zerotier::status() {
                Ok(node) => Ok(Response::ZeroTierStatus {
                    node_id: node.node_id,
                    online: node.online,
                    version: node.version,
                }),
                Err(e) => zerotier_error(e),
            },

            Request::ZeroTierNetworks {} => match zerotier::networks() {
                Ok(networks) => Ok(Response::ZeroTierNetworks { networks }),
                Err(e) => zerotier_error(e),
            },

            Request::ZeroTierJoin { network_id } => match zerotier::join(network_id) {
                Ok(network) => Ok(Response::ZeroTierJoined { network }),
                Err(e) => zerotier_error(e),
            },

            Request::ZerotierControllerStatus {} => {
                let node = match crate::zerotier::status() {
                    Ok(node) => node,
                    Err(e) => return zerotier_error(e),
                };
                match crate::ztcontroller::status() {
                    Ok(found) => Ok(Response::ZeroTierController {
                        controller: found.controller,
                        api_version: found.api_version,
                        database_ready: found.database_ready,
                        node_id: node.node_id,
                    }),
                    Err(e) => zerotier_error(e),
                }
            }

            Request::ZerotierControllerNetworks {} => match self.controlled_networks() {
                Ok(networks) => Ok(Response::ZeroTierControllerNetworks { networks }),
                Err(e) => zerotier_error(e),
            },

            Request::ZerotierCreateNetwork { name, subnet } => {
                let node = match crate::zerotier::status() {
                    Ok(node) => node,
                    Err(e) => return zerotier_error(e),
                };
                // The node's own address is parsed rather than trusted: it is about to become the
                // top 40 bits of a network id and part of a request path, and `/status` gives it
                // as a plain string.
                let Ok(address) = NodeAddress::parse(node.node_id.clone()) else {
                    return Ok(Response::Failed {
                        reason: format!(
                            "zerotier-one kendi adresi olarak {:?} bildirdi; bu bir düğüm adresi değil",
                            node.node_id
                        ),
                    });
                };

                match crate::ztcontroller::create_network(&address, name.as_str(), subnet) {
                    Ok((record, shortfall)) => {
                        // KENDİNİ KAT VE İÇERİ AL. İlk saha kurulumunda eksikti ve sonucu tam bir
                        // kilitlenmeydi: kutu kendi ağına katıldı, kendi bekleyenler listesine
                        // "onay bekliyor" diye düştü, ve arayüz cihazın kendi satırında düğme
                        // göstermediği için sahibi onu İÇERİ ALAMADI — ağa ulaşılabilen tek
                        // cihaz, ağın kurulma sebebi olan NAS'ın kendisi değildi. Bir ağ kurmanın
                        // anlamı bu cihaza uzaktan erişmek; kurulan ağda kurucunun yetkili olması
                        // işlemin parçası, ayrı bir onayın konusu değil.
                        //
                        // İkisi de EN İYİ ÇABA: ağ bu noktada var ve kayıt onu söylüyor; katılım
                        // ya da öz-yetki düşerse eksik `shortfall` listesine yazılır ve arayüz
                        // gösterir — yarım hâli sessizce "kuruldu" saymak yerine.
                        let mut shortfall = shortfall;
                        if let Ok(network_id) = crate::op::NetworkId::parse(record.id.clone()) {
                            if let Err(e) = crate::zerotier::join(&network_id) {
                                shortfall.push(format!("cihaz ağa katılamadı: {e}"));
                            }
                            if let Err(e) = crate::ztcontroller::set_authorized(
                                &network_id,
                                &address,
                                true,
                                Some("DEPSIS"),
                            ) {
                                shortfall.push(format!("cihaz kendini yetkilendiremedi: {e}"));
                            }
                        }
                        Ok(Response::ZeroTierNetworkCreated {
                            network: describe_network(&record),
                            shortfall,
                        })
                    }
                    Err(e) => zerotier_error(e),
                }
            }

            Request::ZerotierControllerMembers { network_id } => {
                let node = match crate::zerotier::status() {
                    Ok(node) => node,
                    Err(e) => return zerotier_error(e),
                };
                match crate::ztcontroller::members(network_id, MAX_CONTROLLER_MEMBERS) {
                    Ok(found) => Ok(Response::ZeroTierControllerMembers {
                        members: found
                            .iter()
                            .map(|m| describe_member(m, &node.node_id))
                            .collect(),
                    }),
                    Err(e) => zerotier_error(e),
                }
            }

            Request::ZerotierSetMemberAuthorized {
                network_id,
                member,
                authorized,
                label,
            } => {
                let node = match crate::zerotier::status() {
                    Ok(node) => node,
                    Err(e) => return zerotier_error(e),
                };

                // THE SELF-LOCKOUT REFUSAL, and it lives here rather than only in the interface
                // because the interface is the thing that gets rewritten. De-authorizing the
                // appliance drops it off the network it is serving; the controller keeps running
                // for every other device, so nothing looks broken from anywhere except the one
                // place that could fix it — and the fix is on the far side of the link that just
                // went away.
                if !*authorized && member.as_str() == node.node_id {
                    return Ok(Response::Refused {
                        reason: "bu, cihazın kendisi. Kendi yetkisini kaldırmak, onu kendi \
                                 sunduğu ağdan düşürür ve geri almanın yolu tam da kopan bağlantının \
                                 arkasında kalır"
                            .to_string(),
                    });
                }

                match crate::ztcontroller::set_authorized(
                    network_id,
                    member,
                    *authorized,
                    label.as_ref().map(crate::op::SafeComponent::as_str),
                ) {
                    Ok(updated) => Ok(Response::ZeroTierMemberUpdated {
                        member: describe_member(&updated, &node.node_id),
                    }),
                    Err(e) => zerotier_error(e),
                }
            }

            Request::ZeroTierPeers {} => match zerotier::peers() {
                Ok(peers) => Ok(Response::ZeroTierPeers { peers }),
                Err(e) => zerotier_error(e),
            },

            Request::ZeroTierLeave { network_id } => match zerotier::leave(network_id) {
                Ok(()) => Ok(Response::ZeroTierLeft {
                    network_id: network_id.as_str().to_string(),
                }),
                Err(e) => zerotier_error(e),
            },
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of               service on the one component that cannot be restarted casually. In tests the               opposite is true: a failed assertion SHOULD panic, and indexing a fixture is               clearer than unwrapping an Option."
)]
mod tests {
    use super::*;
    use crate::audit::MemorySink;
    use crate::seams::mock::{MockCommandRunner, MockSafePath, MockTokenSource};

    const API_UID: u32 = 999;

    fn peer(uid: u32) -> PeerIdentity {
        PeerIdentity {
            uid,
            gid: uid,
            pid: 4242,
        }
    }

    /// The collaborators every dispatch test needs.
    ///
    /// A struct rather than five arguments: the transfer registry and the share root have to
    /// outlive the `Agent` that borrows them, and returning the `Agent` alone would borrow
    /// temporaries that die at the end of the call.
    struct Harness {
        transfers: Mutex<TransferRegistry>,
        tokens: MockTokenSource,
        root: tempfile::TempDir,
        paths: Option<MockSafePath>,
    }

    impl Harness {
        /// No share root: the state of a box before storage is set up.
        fn bare() -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths: None,
            }
        }

        /// A share root that exists and is EMPTY — the state of a box whose storage has been
        /// installed and never used, which is exactly the state `prepare_share_root` is for.
        fn empty_root() -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            let paths = Some(MockSafePath::new(root.path()));
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths,
            }
        }

        fn root_path(&self) -> std::path::PathBuf {
            self.root.path().to_path_buf()
        }

        /// A share root with `<share>/.depsis/staging` already in place.
        fn with_share(share: &str) -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            let staging = root
                .path()
                .join(share)
                .join(STAGING_DIR[0])
                .join(STAGING_DIR[1]);
            std::fs::create_dir_all(&staging).expect("mkdir staging");
            let paths = Some(MockSafePath::new(root.path()));
            Self {
                transfers: Mutex::new(TransferRegistry::new()),
                tokens: MockTokenSource::default(),
                root,
                paths,
            }
        }

        fn share_path(&self, parts: &[&str]) -> std::path::PathBuf {
            let mut p = self.root.path().to_path_buf();
            for part in parts {
                p.push(part);
            }
            p
        }

        fn agent<'a, R: CommandRunner, S: Sink>(
            &'a self,
            runner: &'a R,
            sink: &'a S,
        ) -> Agent<'a, R, S, MockSafePath> {
            Agent::new(
                Policy { api_uid: API_UID },
                runner,
                sink,
                self.paths.as_ref(),
                &self.tokens,
                &self.transfers,
                // Portable, because these tests run on every developer box. The mode is the Unix
                // implementation's business and is asserted where that implementation lives.
                |path, body| std::fs::write(path, body),
            )
        }
    }

    fn agent<'a, R: CommandRunner, S: Sink>(
        runner: &'a R,
        sink: &'a S,
        harness: &'a Harness,
    ) -> Agent<'a, R, S, MockSafePath> {
        harness.agent(runner, sink)
    }

    #[test]
    fn ping_reports_the_schema_version() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp =
            agent(&r, &s, &h).handle(r#"{"op":"ping"}"#, peer(API_UID), "c1", "health check");
        assert_eq!(
            resp,
            Response::Ok {
                schema_version: SCHEMA_VERSION
            }
        );
    }

    #[test]
    fn a_free_form_command_is_refused_and_runs_nothing() {
        // The headline property of TB4: there is no way to ask the agent to run a command.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"exec","argv":["/bin/sh","-c","zpool destroy tank"]}"#,
            peer(API_UID),
            "c2",
            "attack",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty(), "nothing may be executed");
    }

    #[test]
    fn an_unauthorized_uid_is_refused_and_audited() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(r#"{"op":"ping"}"#, peer(1000), "c3", "probe");
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
        let entries = s.entries();
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0].outcome, Outcome::Refused(_)));
        assert_eq!(entries[0].uid, 1000);
    }

    #[test]
    fn a_dataset_name_shaped_like_a_flag_never_reaches_the_runner() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_snapshot","dataset":"-R","name":"s1"}"#,
            peer(API_UID),
            "c4",
            "snapshot",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn create_dataset_always_passes_posixacl_and_sa() {
        let r = MockCommandRunner::with_responses(["".into(), "posix".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_dataset","dataset":"tank/u/1","acltype":"posixacl","refquota_bytes":1048576}"#,
            peer(API_UID),
            "c5",
            "provision user",
        );
        assert!(matches!(resp, Response::Created { .. }));
        let argv = r.call(0).expect("create was run");
        assert_eq!(argv[0], bin::ZFS);
        assert!(argv.contains(&"acltype=posixacl".to_string()));
        assert!(argv.contains(&"xattr=sa".to_string()));
        assert!(argv.contains(&"refquota=1048576".to_string()));
        assert!(!argv.iter().any(|a| a.contains("nfsv4")));
    }

    #[test]
    fn create_dataset_refuses_to_publish_when_acltype_reads_back_wrong() {
        // The measured failure mode: the create succeeds and the property reports itself as
        // configured while enforcing nothing. Verification, not optimism.
        let r = MockCommandRunner::with_responses(["".into(), "nfsv4".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_dataset","dataset":"tank/u/2","acltype":"posixacl"}"#,
            peer(API_UID),
            "c6",
            "provision user",
        );
        match resp {
            Response::Failed { reason } => assert!(reason.contains("nfsv4")),
            other => panic!("expected refusal to publish, got {other:?}"),
        }
    }

    #[test]
    fn smart_reads_are_confined_to_dev_disk_by_id() {
        // The fixture is what `--json=c` actually writes. It used to be the bare word `PASSED`,
        // which smartctl cannot produce under the flags this code passes — so the test agreed with
        // the substring check and neither agreed with the program. See `crate::smart`.
        let r = MockCommandRunner::with_responses([
            r#"{"smart_status":{"passed":true},"temperature":{"current":34}}"#.into(),
        ]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"read_smart_summary","disk_by_id":"wwn-0x600224801b119da9"}"#,
            peer(API_UID),
            "c7",
            "telemetry",
        );
        assert!(
            matches!(
                resp,
                Response::Smart {
                    healthy: true,
                    temperature_celsius: Some(34),
                    ..
                }
            ),
            "{resp:?}"
        );
        let argv = r.call(0).expect("smartctl was run");
        assert!(argv
            .last()
            .expect("path arg")
            .starts_with("/dev/disk/by-id/"));
    }

    /// Two disks, one of them carrying the running system.
    const TWO_DISKS: &str = r#"{"blockdevices":[
      {"kname":"sda","type":"disk","size":100,"wwn":"0xA","id-link":"ata-A"},
      {"kname":"sdb","type":"disk","size":100,"wwn":"0xB","id-link":"ata-B"},
      {"kname":"sdc","type":"disk","size":100,"wwn":"0xS","id-link":"ata-SYS","pttype":"gpt",
       "children":[{"kname":"sdc1","type":"part","size":100,"fstype":"ext4","mountpoint":"/"}]}
    ]}"#;

    /// İçinde eski bir sistem imajı olan (GPT + bölümler, BAĞLI DEĞİL) ve çıkarılabilir bir disk.
    const WIPE_DISKS: &str = r#"{"blockdevices":[
      {"kname":"sdd","type":"disk","size":100,"wwn":"0xD","id-link":"ata-DOLU","pttype":"gpt",
       "children":[{"kname":"sdd1","type":"part","size":100,"fstype":"vfat"}]},
      {"kname":"sde","type":"disk","size":100,"wwn":"0xE","id-link":"usb-CUBUK","rm":true,
       "pttype":"dos"},
      {"kname":"sdc","type":"disk","size":100,"wwn":"0xS","id-link":"ata-SYS","pttype":"gpt",
       "children":[{"kname":"sdc1","type":"part","size":100,"fstype":"ext4","mountpoint":"/"}]}
    ]}"#;

    #[test]
    fn wiping_reads_the_box_first_and_then_runs_one_wipefs_all() {
        // Havuz oluşturmadaki sıra özelliğinin aynısı: envanter TAZE, sonra tek bir wipefs.
        // İçinde vfat olan bir disk (havuzun reddettiği durum) burada MEŞRU hedef — silmenin
        // var olma sebebi içerik.
        let r = MockCommandRunner::with_responses([WIPE_DISKS.into(), String::new()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"wipe_disk","disk":{"by_id":"ata-DOLU","wwn":"0xD"}}"#,
            peer(API_UID),
            "wd1",
            "operator wiped a disk",
        );
        assert!(matches!(resp, Response::DiskWiped { .. }), "{resp:?}");

        let inventory = r.call(0).expect("lsblk ran first");
        assert_eq!(inventory[0], crate::disks::LSBLK);
        let wipe = r.call(1).expect("wipefs ran second");
        assert_eq!(wipe[0], bin::WIPEFS);
        assert_eq!(wipe[1], "--all");
        assert_eq!(wipe[2], "--");
        assert_eq!(wipe[3], "/dev/disk/by-id/ata-DOLU");
        assert!(r.call(2).is_none(), "wipefs'ten sonra başka komut yok");
    }

    #[test]
    fn wiping_a_removable_stick_is_allowed_but_the_system_disk_never_is() {
        // Çıkarılabilirlik havuz İÇİN ret sebebi, silme için değil: USB bellek silinebilir.
        let r = MockCommandRunner::with_responses([WIPE_DISKS.into(), String::new()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"wipe_disk","disk":{"by_id":"usb-CUBUK","wwn":"0xE"}}"#,
            peer(API_UID),
            "wd2",
            "operator wiped a stick",
        );
        assert!(matches!(resp, Response::DiskWiped { .. }), "{resp:?}");

        // Sistem diski: hiçbir onay geçiremez, ve wipefs HİÇ çalışmaz.
        let r = MockCommandRunner::with_responses([WIPE_DISKS.into()]);
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"wipe_disk","disk":{"by_id":"ata-SYS","wwn":"0xS"}}"#,
            peer(API_UID),
            "wd3",
            "operator wiped the system disk",
        );
        assert!(matches!(resp, Response::Refused { .. }), "{resp:?}");
        assert!(r.call(1).is_none(), "reddedilen silmede wipefs çalışmadı");
    }

    #[test]
    fn wiping_refuses_a_swapped_disk_by_wwn() {
        // Sihirbaz açıkken yuvadaki disk değişti: by-id aynı ada çözülüyor ama WWN başka.
        // Onaylanan disk bu değil — silinmez.
        let r = MockCommandRunner::with_responses([WIPE_DISKS.into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"wipe_disk","disk":{"by_id":"ata-DOLU","wwn":"0xBASKA"}}"#,
            peer(API_UID),
            "wd4",
            "operator wiped a disk",
        );
        assert!(matches!(resp, Response::Refused { .. }), "{resp:?}");
        assert!(r.call(1).is_none());
    }

    #[test]
    fn creating_a_pool_reads_the_box_first_and_then_runs_one_zpool_create() {
        // The ORDER is the property. A caller that supplied both the disks and the inventory to
        // check them against would be confirming that it had copied its own screen correctly.
        let r = MockCommandRunner::with_responses([TWO_DISKS.into(), String::new()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_pool","pool":"tank","topology":"mirror","disks":[
                 {"by_id":"ata-A","wwn":"0xA"},{"by_id":"ata-B","wwn":"0xB"}]}"#,
            peer(API_UID),
            "cp1",
            "operator created a pool",
        );
        assert!(matches!(resp, Response::PoolCreated { .. }), "{resp:?}");

        let inventory = r.call(0).expect("lsblk ran first");
        assert_eq!(inventory[0], crate::disks::LSBLK);
        let create = r.call(1).expect("zpool ran second");
        assert_eq!(create[0], bin::ZPOOL);
        assert_eq!(create[1], "create");
        assert!(create.iter().any(|a| a == "mirror"));
        assert!(create.iter().any(|a| a == "/dev/disk/by-id/ata-A"));
        assert!(!create.iter().any(|a| a == "-f"));
    }

    #[test]
    fn a_pool_naming_the_system_disk_never_reaches_zpool() {
        // Refused, and — the part worth a test of its own — refused BEFORE the command runs. A
        // check that produced the right answer after `zpool` had already been handed the disk
        // would be no check at all.
        let r = MockCommandRunner::with_responses([TWO_DISKS.into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_pool","pool":"tank","topology":"mirror","disks":[
                 {"by_id":"ata-A","wwn":"0xA"},{"by_id":"ata-SYS","wwn":"0xS"}]}"#,
            peer(API_UID),
            "cp2",
            "operator created a pool",
        );
        match resp {
            Response::Refused { reason } => assert!(reason.contains("system"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(r.calls.borrow().len(), 1, "only lsblk ran");
    }

    #[test]
    fn a_disk_swapped_since_the_wizard_read_it_never_reaches_zpool() {
        // `/dev/disk/by-id` names a DEVICE and not a slot, so the same name can be a different
        // disk. This is the only check in §8.1's sequence that survives somebody swapping a disk
        // between the confirmation and the button.
        let swapped = r#"{"blockdevices":[
          {"kname":"sda","type":"disk","size":100,"wwn":"0xSOMEONE-ELSES","id-link":"ata-A"}]}"#;
        let r = MockCommandRunner::with_responses([swapped.into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_pool","pool":"tank","topology":"single","disks":[
                 {"by_id":"ata-A","wwn":"0xA"}]}"#,
            peer(API_UID),
            "cp3",
            "operator created a pool",
        );
        assert!(matches!(resp, Response::Refused { .. }), "{resp:?}");
        assert_eq!(r.calls.borrow().len(), 1, "only lsblk ran");
    }

    #[test]
    fn a_truncated_inventory_refuses_rather_than_planning_against_a_partial_list() {
        // `plan` calls a disk it cannot see "unknown", so a cut list turns a correct request into
        // a confusing refusal — and, far worse, could ACCEPT one whose system disk fell off the
        // end of the list.
        let many: String = format!(
            r#"{{"blockdevices":[{}]}}"#,
            (0..crate::op::MAX_DISKS + 1)
                .map(|n| format!(
                    r#"{{"kname":"sd{n}","type":"disk","size":1,"wwn":"0x{n}","id-link":"ata-{n}"}}"#
                ))
                .collect::<Vec<_>>()
                .join(",")
        );
        let r = MockCommandRunner::with_responses([many]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"create_pool","pool":"tank","topology":"single","disks":[
                 {"by_id":"ata-0","wwn":"0x0"}]}"#,
            peer(API_UID),
            "cp4",
            "operator created a pool",
        );
        assert!(matches!(resp, Response::Refused { .. }), "{resp:?}");
        assert_eq!(r.calls.borrow().len(), 1, "only lsblk ran");
    }

    #[test]
    fn a_pool_name_cannot_be_a_path_or_a_flag() {
        // `SafeComponent`, so both are refused by construction rather than by a check somebody
        // could reorder. A name with a slash would be a DATASET, and one starting with `-` would
        // be read by `zpool` as an option — P0-E's finding about every tool in this product.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for evil in [
            r#"{"op":"create_pool","pool":"tank/x","topology":"single","disks":[{"by_id":"ata-A","wwn":"0xA"}]}"#,
            r#"{"op":"create_pool","pool":"-f","topology":"single","disks":[{"by_id":"ata-A","wwn":"0xA"}]}"#,
            r#"{"op":"create_pool","pool":"tank","topology":"single","disks":[{"by_id":"../../dev/sda","wwn":"0xA"}]}"#,
            r#"{"op":"create_pool","pool":"tank","topology":"stripe","disks":[{"by_id":"ata-A","wwn":"0xA"}]}"#,
        ] {
            let resp = agent(&r, &s, &h).handle(evil, peer(API_UID), "cp5", "attack");
            assert!(matches!(resp, Response::Refused { .. }), "{evil}");
        }
        // Not one command ran: these are refused while parsing the operands.
        assert!(r.calls.borrow().is_empty());
    }

    /// What `zfs list -H -o name,mountpoint` says on a box whose share tree is not set up.
    const NO_SHARE_DATASET: &str = "tank\tnone\ntank/other\t/mnt/other\n";

    #[test]
    fn the_pool_list_runs_one_fixed_argv() {
        let r = MockCommandRunner::with_responses(["tank\nyedek\n".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"list_pools"}"#,
            peer(API_UID),
            "lp1",
            "which pools does this box have",
        );
        match resp {
            Response::Pools { pools } => assert_eq!(pools, ["tank", "yedek"]),
            other => panic!("expected a pool list, got {other:?}"),
        }
        let argv = r.call(0).expect("zpool ran");
        assert_eq!(argv[0], bin::ZPOOL);
        assert_eq!(&argv[1..], crate::pools::list_pools_argv().as_slice());
    }

    #[test]
    fn preparing_the_share_root_refuses_a_directory_that_is_not_empty() {
        // THE REFUSAL THAT MATTERS. `zfs create -o mountpoint=X` mounts over X without complaint,
        // and everything underneath vanishes from view while still occupying the disk — a
        // data-loss report that takes a long time to diagnose because nothing was deleted.
        let h = Harness::empty_root();
        std::fs::write(h.root_path().join("bir-dosya.txt"), b"somebody's file").expect("fixture");

        let r = MockCommandRunner::with_responses([NO_SHARE_DATASET.into()]);
        let s = MemorySink::default();
        with_shares_root(&h.root_path(), || {
            let resp = agent(&r, &s, &h).handle(
                r#"{"op":"prepare_share_root","pool":"tank"}"#,
                peer(API_UID),
                "sr1",
                "prepare the share tree",
            );
            match resp {
                Response::Refused { reason } => assert!(reason.contains("not empty"), "{reason}"),
                other => panic!("expected a refusal, got {other:?}"),
            }
        });
        // Only the listing ran: `zfs create` was never reached.
        assert_eq!(r.calls.borrow().len(), 1);
    }

    #[test]
    fn preparing_the_share_root_refuses_when_a_dataset_is_already_mounted_there() {
        let h = Harness::empty_root();
        let mounted = format!("tank/depsis\t{}\n", h.root_path().display());
        let r = MockCommandRunner::with_responses([mounted]);
        let s = MemorySink::default();
        with_shares_root(&h.root_path(), || {
            let resp = agent(&r, &s, &h).handle(
                r#"{"op":"prepare_share_root","pool":"tank"}"#,
                peer(API_UID),
                "sr2",
                "prepare the share tree",
            );
            match resp {
                Response::Refused { reason } => {
                    assert!(reason.contains("already mounted"), "{reason}");
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        });
        assert_eq!(r.calls.borrow().len(), 1);
    }

    #[test]
    fn preparing_the_share_root_derives_the_dataset_and_the_mountpoint() {
        // Neither is a caller operand. `CreateDataset` refuses a mountpoint precisely because a
        // caller that could choose one could mount a tenant's data anywhere on the box; here the
        // caller chooses the POOL and the agent supplies the rest from its own environment.
        let h = Harness::empty_root();
        let r = MockCommandRunner::with_responses([NO_SHARE_DATASET.into(), String::new()]);
        let s = MemorySink::default();
        with_shares_root(&h.root_path(), || {
            let resp = agent(&r, &s, &h).handle(
                r#"{"op":"prepare_share_root","pool":"tank"}"#,
                peer(API_UID),
                "sr3",
                "prepare the share tree",
            );
            match resp {
                Response::ShareRootPrepared { dataset } => assert_eq!(dataset, "tank/depsis"),
                other => panic!("expected a prepared root, got {other:?}"),
            }
        });
        let argv = r.call(1).expect("zfs create ran");
        assert_eq!(argv[0], bin::ZFS);
        assert_eq!(argv[1], "create");
        assert!(argv.contains(&format!("mountpoint={}", h.root_path().display())));
        // ADR-0004's pair, set here as well as on the pool, because this dataset can also be
        // created on a pool that DEPSIS did not make.
        assert!(argv.contains(&"acltype=posixacl".to_string()));
        assert!(argv.contains(&"xattr=sa".to_string()));
        assert_eq!(argv.last().map(String::as_str), Some("tank/depsis"));
    }

    #[test]
    fn the_share_root_status_reports_the_agents_own_path_and_nothing_a_caller_chose() {
        let h = Harness::empty_root();
        let mounted = format!("tank\tnone\ntank/depsis\t{}\n", h.root_path().display());
        let r = MockCommandRunner::with_responses([mounted]);
        let s = MemorySink::default();
        with_shares_root(&h.root_path(), || {
            let resp = agent(&r, &s, &h).handle(
                r#"{"op":"share_root_status"}"#,
                peer(API_UID),
                "sr4",
                "is the share tree set up",
            );
            match resp {
                Response::ShareRoot {
                    path,
                    dataset,
                    empty,
                } => {
                    assert_eq!(path, Some(h.root_path().display().to_string()));
                    assert_eq!(dataset.as_deref(), Some("tank/depsis"));
                    assert!(empty);
                }
                other => panic!("expected a share root, got {other:?}"),
            }
        });
    }

    #[test]
    fn the_share_root_status_says_so_when_no_dataset_is_mounted_there() {
        // The state a fresh box is in, and the one the wizard offers to fix. It has to be
        // distinguishable from "we could not tell", which is why `dataset` is an option rather
        // than an empty string.
        let h = Harness::empty_root();
        let r = MockCommandRunner::with_responses([NO_SHARE_DATASET.into()]);
        let s = MemorySink::default();
        with_shares_root(&h.root_path(), || {
            let resp = agent(&r, &s, &h).handle(
                r#"{"op":"share_root_status"}"#,
                peer(API_UID),
                "sr5",
                "is the share tree set up",
            );
            match resp {
                Response::ShareRoot { dataset, empty, .. } => {
                    assert_eq!(dataset, None);
                    assert!(empty);
                }
                other => panic!("expected a share root, got {other:?}"),
            }
        });
    }

    #[test]
    fn neither_new_read_takes_an_operand() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for evil in [
            r#"{"op":"list_pools","pool":"tank"}"#,
            r#"{"op":"share_root_status","path":"/etc"}"#,
            r#"{"op":"prepare_share_root","pool":"tank","mountpoint":"/etc"}"#,
            r#"{"op":"prepare_share_root","pool":"tank/child"}"#,
        ] {
            let resp = agent(&r, &s, &h).handle(evil, peer(API_UID), "sr6", "attack");
            assert!(matches!(resp, Response::Refused { .. }), "{evil}");
        }
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn the_disk_inventory_runs_one_fixed_argv() {
        // The security property of `list_disks`, and the only one it has: the request carries no
        // operands, so every element of the command line is a literal in this crate. A future
        // field on this variant would show up here as an argv that stopped matching.
        let r = MockCommandRunner::with_responses([
            r#"{"blockdevices":[{"kname":"sda","type":"disk","size":100,"id-link":"ata-X"}]}"#
                .into(),
        ]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"list_disks"}"#,
            peer(API_UID),
            "c9",
            "disk inventory",
        );

        match resp {
            Response::Disks { disks, truncated } => {
                assert!(!truncated);
                assert_eq!(disks.len(), 1);
                assert_eq!(disks[0].by_id.as_deref(), Some("ata-X"));
            }
            other => panic!("expected an inventory, got {other:?}"),
        }

        let argv = r.call(0).expect("lsblk was run");
        assert_eq!(argv[0], crate::disks::LSBLK);
        assert_eq!(&argv[1..], crate::disks::argv().as_slice());
    }

    #[test]
    fn the_disk_inventory_takes_no_operands() {
        // `deny_unknown_fields`, exercised on the one variant where a stray field would be an
        // argument to a command. A caller that could add `"device":"-d"` here would be choosing
        // part of a privileged command line.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"list_disks","device":"/dev/sda"}"#,
            peer(API_UID),
            "c9",
            "attack",
        );
        assert!(matches!(resp, Response::Refused { .. }));
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn unreadable_lsblk_output_is_a_failure_and_not_an_empty_box() {
        // "There are no disks in this machine" is the most dangerous wrong answer this operation
        // can give, because its caller is about to offer disks to overwrite.
        let r = MockCommandRunner::with_responses(["<html>404</html>".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle(
            r#"{"op":"list_disks"}"#,
            peer(API_UID),
            "c9",
            "disk inventory",
        );
        assert!(matches!(resp, Response::Failed { .. }), "{resp:?}");
    }

    #[test]
    fn a_smart_read_cannot_be_pointed_at_an_arbitrary_device() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for evil in [
            r#"{"op":"read_smart_summary","disk_by_id":"../../dev/sda"}"#,
            r#"{"op":"read_smart_summary","disk_by_id":"-d"}"#,
        ] {
            let resp = agent(&r, &s, &h).handle(evil, peer(API_UID), "c8", "attack");
            assert!(matches!(resp, Response::Refused { .. }), "{evil}");
        }
        assert!(r.calls.borrow().is_empty());
    }

    #[test]
    fn every_executed_program_is_an_absolute_path() {
        let r = MockCommandRunner::with_responses(["1024 2048".into(), "ONLINE".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        agent(&r, &s, &h).handle(
            r#"{"op":"pool_status","pool":"tank"}"#,
            peer(API_UID),
            "c9",
            "telemetry",
        );
        for argv in r.calls.borrow().iter() {
            assert!(
                argv[0].starts_with('/'),
                "program {:?} must be absolute — execvp falls back to /bin:/usr/bin",
                argv[0]
            );
        }
    }

    /// Replication, at the dispatch layer.
    ///
    /// `replicate.rs` tests the rules in isolation; these test that dispatch APPLIES them, and
    /// applies them BEFORE spawning anything. The distinction is the whole point: a refusal that
    /// arrives after `zfs recv -F` has started is not a refusal, and `recv -F` has no undo.
    ///
    /// EVERY ONE OF THESE SETS A SHARE ROOT, and the first attempt did not — which made the two
    /// most important tests pass for the wrong reason. With `DEPSIS_SHARES_ROOT` unset the agent
    /// serves no shares, so "the target is the share dataset" cannot be true and the refusal never
    /// fires. The tests went green while measuring nothing. A refusal test on a box with nothing
    /// to protect is not a refusal test.
    ///
    /// The mock runner records a pipeline as one call with a literal `|` in the middle, so an
    /// assertion can read the whole decision — which snapshot, which base, which target — in one
    /// string.
    ///
    /// Call 0 is always the `zfs list -H -o name,mountpoint` that finds the share dataset; the
    /// pipeline, when it runs at all, is call 1.
    fn replicating(
        mounted_at: &str,
        responses: Vec<String>,
        request: &str,
        check: impl FnOnce(Response, &MockCommandRunner, &MemorySink),
    ) {
        let root = tempfile::tempdir().expect("tempdir");
        let listing = format!("tank/depsis\t{}\n", root.path().display());
        let mut all = vec![listing];
        all.extend(responses);
        let r = MockCommandRunner::with_responses(all);
        let s = MemorySink::default();
        let h = Harness::bare();
        assert_eq!(
            mounted_at, "tank/depsis",
            "the fixture pins one share dataset"
        );
        with_shares_root(root.path(), || {
            let resp = agent(&r, &s, &h).handle(request, peer(API_UID), "c-rep", "replication");
            check(resp, &r, &s);
        });
    }

    #[test]
    fn a_replication_runs_send_piped_into_recv() {
        replicating(
            "tank/depsis",
            vec!["received 1.2M stream".into()],
            r#"{"op":"replicate_dataset","source":"tank/other","snapshot":"nightly","target":"backup/depsis","base":null}"#,
            |resp, r, _| {
                match resp {
                    Response::Replicated { ref base, .. } => assert!(base.is_none(), "a full send"),
                    other => panic!("expected a replication, got {other:?}"),
                }
                assert_eq!(
                    r.call(1).expect("the pipeline ran"),
                    vec![
                        "/usr/sbin/zfs",
                        "send",
                        "-p",
                        "tank/other@nightly",
                        "|",
                        "/usr/sbin/zfs",
                        "recv",
                        "-F",
                        "-u",
                        "backup/depsis",
                    ]
                );
            },
        );
    }

    #[test]
    fn an_incremental_replication_names_the_base_and_reports_it_back() {
        replicating(
            "tank/depsis",
            vec!["received 4K stream".into()],
            r#"{"op":"replicate_dataset","source":"tank/other","snapshot":"tuesday","target":"backup/depsis","base":"monday"}"#,
            |resp, r, _| {
                match resp {
                    // Echoed back rather than taken from the request: an incremental the target
                    // refuses is reported as a refusal, and a history that recorded the REQUEST
                    // would claim a transfer that did not happen.
                    Response::Replicated { base, .. } => {
                        assert_eq!(base.as_deref(), Some("tank/other@monday"));
                    }
                    other => panic!("expected a replication, got {other:?}"),
                }
                let pipeline = r.call(1).expect("the pipeline ran");
                assert!(pipeline.contains(&"-i".to_string()));
                assert!(pipeline.contains(&"tank/other@monday".to_string()));
            },
        );
    }

    #[test]
    fn refuses_to_receive_onto_the_share_dataset_and_spawns_nothing() {
        // THE ONE THAT WOULD ERASE EVERY TENANT'S FILES.
        replicating(
            "tank/depsis",
            vec![],
            r#"{"op":"replicate_dataset","source":"backup/old","snapshot":"s","target":"tank/depsis","base":null}"#,
            |resp, r, _| {
                match resp {
                    Response::Refused { ref reason } => assert!(reason.contains("every share")),
                    other => panic!("expected a refusal, got {other:?}"),
                }
                // ONLY the lookup ran. A second call would mean `zfs recv -F` had already started,
                // and it has no undo.
                assert_eq!(
                    r.calls.borrow().len(),
                    1,
                    "nothing may be spawned after a refusal"
                );
            },
        );
    }

    #[test]
    fn refuses_a_target_inside_the_share_tree() {
        replicating(
            "tank/depsis",
            vec![],
            r#"{"op":"replicate_dataset","source":"backup/old","snapshot":"s","target":"tank/depsis/acme","base":null}"#,
            |resp, r, _| {
                assert!(matches!(resp, Response::Refused { .. }));
                assert_eq!(r.calls.borrow().len(), 1);
            },
        );
    }

    #[test]
    fn a_refused_replication_is_audited_as_refused() {
        // A refusal the audit records as `allowed` is a refusal nobody can find afterwards.
        replicating(
            "tank/depsis",
            vec![],
            r#"{"op":"replicate_dataset","source":"backup/old","snapshot":"s","target":"tank/depsis","base":null}"#,
            |_, _, s| {
                let entries = s.entries();
                assert!(
                    entries.iter().any(|e| e.operation == "replicate_dataset"
                        && matches!(e.outcome, Outcome::Refused(_))),
                    "the refusal must be in the audit trail: {entries:?}"
                );
            },
        );
    }

    #[test]
    fn refuses_when_the_share_dataset_cannot_be_determined() {
        // FAIL CLOSED. If the lookup itself fails the agent cannot tell whether the target is the
        // share root, and carrying on would run `recv -F` on exactly the guess it could not make.
        let root = tempfile::tempdir().expect("tempdir");
        let r = FailingRunner;
        let s = MemorySink::default();
        let h = Harness::bare();
        with_shares_root(root.path(), || {
            let resp = agent(&r, &s, &h).handle(
                r#"{"op":"replicate_dataset","source":"tank/a","snapshot":"s","target":"backup/b","base":null}"#,
                peer(API_UID),
                "c-blind",
                "replication with a broken lookup",
            );
            assert!(
                matches!(resp, Response::Failed { .. }),
                "a lookup that cannot answer must not become a replication: {resp:?}"
            );
        });
    }

    /// A runner whose every call fails, for the fail-closed test above.
    struct FailingRunner;
    impl CommandRunner for FailingRunner {
        fn run(&self, program: &str, _args: &[&str]) -> Result<String, SeamError> {
            Err(SeamError::Command {
                program: program.to_string(),
                status: 1,
                stderr: "the pool is not imported".to_string(),
            })
        }
    }

    #[test]
    fn the_audit_entry_carries_identity_and_correlation_id() {
        let r = MockCommandRunner::with_responses(["".into()]);
        let s = MemorySink::default();
        let h = Harness::bare();
        agent(&r, &s, &h).handle(
            r#"{"op":"create_snapshot","dataset":"tank/u/1","name":"nightly"}"#,
            peer(API_UID),
            "corr-abc",
            "scheduled snapshot",
        );
        let entries = s.entries();
        let e = entries.first().expect("an entry was recorded");
        assert_eq!(e.correlation_id, "corr-abc");
        assert_eq!(e.uid, API_UID);
        assert_eq!(e.pid, 4242);
        assert_eq!(e.operation, "create_snapshot");
        assert_eq!(e.reason, "scheduled snapshot");
    }

    #[test]
    fn an_unparseable_request_is_not_audited_under_an_invented_operation() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = agent(&r, &s, &h).handle("{not json", peer(API_UID), "c10", "junk");
        assert!(matches!(resp, Response::Refused { .. }));
        // An append-only log must not contain a guess about what was asked.
        assert!(s.entries().is_empty());
    }
    // ── transfers ──
    //
    // The bulk data path's control half. The byte-carrying socket is separate; these settle what
    // the control channel does, which is where the confinement decision is made.

    fn open_transfer(h: &Harness, share: &str, name: &str) -> Response {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = format!(r#"{{"op":"open_transfer","share":"{share}","staging_name":"{name}"}}"#);
        h.agent(&r, &s)
            .handle(&raw, peer(API_UID), "c-transfer", "upload")
    }

    #[test]
    fn opening_a_transfer_creates_the_staging_file_and_returns_a_token() {
        let h = Harness::with_share("alice");

        match open_transfer(&h, "alice", "u1.part") {
            Response::Transfer { token, offset } => {
                assert_eq!(token, "token-1", "the mock source mints predictable tokens");
                assert_eq!(offset, 0, "a new upload starts at zero");
            }
            other => panic!("expected a transfer, got {other:?}"),
        }

        assert!(
            h.share_path(&["alice", ".depsis", "staging", "u1.part"])
                .exists(),
            "the staging file must exist once a transfer is open"
        );
    }

    #[test]
    fn a_resumed_transfer_reports_where_to_continue() {
        // tus resumes. The second PATCH for one upload must continue the same `.part` rather than
        // being refused for existing, and the offset has to come from the FILE — a number tracked
        // beside the data is a number that can disagree with it.
        let h = Harness::with_share("alice");
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "u2.part"]),
            b"twelve bytes",
        )
        .expect("seed a partial upload");

        match open_transfer(&h, "alice", "u2.part") {
            Response::Transfer { offset, .. } => assert_eq!(offset, 12),
            other => panic!("expected a transfer, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_is_refused_when_no_share_root_is_configured() {
        // The state of a NAS before setup. Refused with a reason, not silently missing — and the
        // agent still starts, because the operations that SET UP storage run through it.
        let h = Harness::bare();
        match open_transfer(&h, "alice", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("no share root")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_cannot_name_a_share_outside_the_root() {
        // `SafeComponent` refuses this at parse time, before any path work — which is the point of
        // typing the operand rather than checking it later.
        let h = Harness::with_share("alice");
        match open_transfer(&h, "../etc", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("unparseable")),
            other => panic!("expected a parse refusal, got {other:?}"),
        }
    }

    #[test]
    fn publishing_moves_the_file_and_refuses_to_overwrite() {
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "done.part"]),
            b"final contents",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"done.part","destination":["report.txt"],"expected_bytes":14,"owner_uid":300100,"owner_gid":300100}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-pub", "publish")
        {
            Response::Publish { bytes } => assert_eq!(bytes, 14),
            other => panic!("expected a publish, got {other:?}"),
        }

        assert!(
            h.share_path(&["alice", "report.txt"]).exists(),
            "the file must be where the user asked for it"
        );
        assert!(
            !h.share_path(&["alice", ".depsis", "staging", "done.part"])
                .exists(),
            "and gone from staging"
        );

        // A second publish onto the same name must lose. Publishing is not allowed to destroy a
        // file the user already has, which is why the real implementation uses RENAME_NOREPLACE.
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "again.part"]),
            b"different",
        )
        .expect("stage again");
        let raw2 = r#"{"op":"publish_transfer","share":"alice","staging_name":"again.part","destination":["report.txt"],"expected_bytes":9,"owner_uid":300100,"owner_gid":300100}"#;
        match h
            .agent(&r, &s)
            .handle(raw2, peer(API_UID), "c-pub2", "publish")
        {
            Response::Failed { reason } => assert!(reason.contains("already exists")),
            other => panic!("expected a refusal to overwrite, got {other:?}"),
        }
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "report.txt"])).expect("read"),
            b"final contents",
            "the original must be untouched"
        );
    }

    // ── discarding ──

    fn discard(h: &Harness, share: &str, staging_name: &str) -> Response {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = format!(
            r#"{{"op":"discard_transfer","share":"{share}","staging_name":"{staging_name}"}}"#
        );
        h.agent(&r, &s)
            .handle(&raw, peer(API_UID), "c-discard", "cancelled upload")
    }

    #[test]
    fn a_discarded_staging_file_is_gone_and_its_name_is_free_again() {
        // The dead end this closes: `.depsis/staging` counts against the user's refquota, Samba
        // vetoes `/.depsis/` and the API filters the prefix server-side, so an abandoned chunk was
        // invisible to the user, undeletable by the user, undeletable by the API — which cannot
        // write inside a share at all — and undeletable by the agent. Quota nobody could reclaim.
        let h = Harness::with_share("alice");
        assert!(matches!(
            open_transfer(&h, "alice", "cancelled.part"),
            Response::Transfer { .. }
        ));
        assert!(h
            .share_path(&["alice", ".depsis", "staging", "cancelled.part"])
            .exists());

        match discard(&h, "alice", "cancelled.part") {
            Response::Discarded { existed } => assert!(existed),
            other => panic!("expected a discard, got {other:?}"),
        }
        assert!(!h
            .share_path(&["alice", ".depsis", "staging", "cancelled.part"])
            .exists());

        // The registry entry went with it. Without that the descriptor would sit against
        // MAX_PENDING_TRANSFERS holding a deleted inode alive until the TTL expired, and the name
        // would stay reserved for five minutes after every cancelled upload.
        {
            let registry = h.transfers.lock().expect("lock");
            assert_eq!(registry.pending_count(), 0);
            assert!(!registry.is_busy("alice", "cancelled.part"));
        }
        assert!(
            matches!(
                open_transfer(&h, "alice", "cancelled.part"),
                Response::Transfer { .. }
            ),
            "and the user can retry under the same name immediately"
        );
    }

    #[test]
    fn discarding_a_file_that_is_already_gone_is_a_success() {
        // A caller retrying a discard must not have to tell "already clean" apart from a fault —
        // and the sweeper can legitimately have got there first.
        let h = Harness::with_share("alice");
        match discard(&h, "alice", "never-existed.part") {
            Response::Discarded { existed } => assert!(!existed),
            other => panic!("expected a discard, got {other:?}"),
        }
    }

    #[test]
    fn discarding_is_refused_while_a_data_connection_is_writing() {
        // Unlinking a file a worker is still appending to leaves that worker writing into an
        // unlinked inode and reporting `stored`. The bytes go nowhere and nothing says so.
        let h = Harness::with_share("alice");
        let token = match open_transfer(&h, "alice", "live.part") {
            Response::Transfer { token, .. } => token,
            other => panic!("expected a transfer, got {other:?}"),
        };

        // Claim it the way the data channel does, and hold the in-flight guard for the call.
        let key = {
            let mut registry = h.transfers.lock().expect("lock");
            let (_transfer, key) = registry.claim(&token, peer(API_UID)).expect("claim");
            key
        };
        let guard = crate::transfer::guard_in_flight(&h.transfers, key);

        match discard(&h, "alice", "live.part") {
            Response::Refused { reason } => {
                assert!(reason.contains("being written right now"), "got: {reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(
            h.share_path(&["alice", ".depsis", "staging", "live.part"])
                .exists(),
            "the file must still be there for the connection that is writing it"
        );

        // And once the connection ends, the same call works.
        drop(guard);
        assert!(matches!(
            discard(&h, "alice", "live.part"),
            Response::Discarded { existed: true }
        ));
    }

    #[test]
    fn a_second_transfer_on_one_staging_file_is_refused() {
        // The interlock, through the dispatcher. Both would sit at the same offset and their data
        // connections would overwrite each other with no error at any layer.
        let h = Harness::with_share("alice");
        assert!(matches!(
            open_transfer(&h, "alice", "u.part"),
            Response::Transfer { .. }
        ));
        match open_transfer(&h, "alice", "u.part") {
            Response::Refused { reason } => assert!(reason.contains("already has a transfer")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn publishing_is_refused_while_the_file_is_still_open() {
        // A PublishTransfer arriving mid-upload would renameat2 a half-written file into the user's
        // tree — exactly what atomic publish exists to prevent. The agent answers from state it
        // holds itself rather than trusting the API's belief that the upload finished.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "live.part"]),
            b"partial",
        )
        .expect("stage");
        assert!(matches!(
            open_transfer(&h, "alice", "live.part"),
            Response::Transfer { .. }
        ));

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"live.part","destination":["out.txt"],"expected_bytes":7,"owner_uid":300100,"owner_gid":300100}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-busy", "publish")
        {
            Response::Refused { reason } => assert!(reason.contains("still open")),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(
            !h.share_path(&["alice", "out.txt"]).exists(),
            "nothing may have been moved"
        );
    }

    #[test]
    fn a_published_file_is_handed_to_the_uploader_not_left_with_root() {
        // The gap that P1-D asserted for two commits: a published file stayed root-owned at 0600,
        // so the person who uploaded it could not read it back. What is measured here is that the
        // publish path ASKS for the right owner; that the ask takes effect is measured against a
        // real kernel in `unix.rs` and end to end in P1-D, because a chown needs CAP_CHOWN and a
        // portable test running as an ordinary user could only ever assert that it failed.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "owned.part"]),
            b"twelve bytes",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"owned.part","destination":["mine.txt"],"expected_bytes":12,"owner_uid":300100,"owner_gid":300101}"#;
        match h.agent(&r, &s).handle(raw, peer(API_UID), "c", "publish") {
            Response::Publish { bytes } => assert_eq!(bytes, 12),
            other => panic!("expected a publish, got {other:?}"),
        }
        assert_eq!(
            h.paths.as_ref().expect("paths").owners(),
            vec![(300100, 300101)],
            "the uid and gid the caller supplied must reach the filesystem seam unchanged"
        );
    }

    #[test]
    fn a_publish_that_would_leave_the_file_root_owned_is_refused() {
        // Not because root ownership is an escalation — the mode is 0600 and nothing is setuid —
        // but because it is exactly the broken state the operands exist to end. A caller that
        // forgot the mapping must fail loudly rather than reproduce the bug it was sent to fix.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "root.part"]),
            b"x",
        )
        .expect("stage");

        for raw in [
            r#"{"op":"publish_transfer","share":"alice","staging_name":"root.part","destination":["a.txt"],"expected_bytes":1,"owner_uid":0,"owner_gid":300100}"#,
            r#"{"op":"publish_transfer","share":"alice","staging_name":"root.part","destination":["b.txt"],"expected_bytes":1,"owner_uid":300100,"owner_gid":0}"#,
        ] {
            match h.agent(&r, &s).handle(raw, peer(API_UID), "c", "publish") {
                Response::Refused { reason } => {
                    assert!(reason.contains("owned by root"), "got: {reason}");
                }
                other => panic!("root ownership must be refused, got {other:?}"),
            }
        }
        assert!(
            h.paths.as_ref().expect("paths").owners().is_empty(),
            "a refused publish must not have touched the file at all"
        );
        assert!(
            h.share_path(&["alice", ".depsis", "staging", "root.part"])
                .exists(),
            "and the staging file must survive so a corrected call can still publish it"
        );
    }

    #[test]
    fn publishing_refuses_a_size_the_caller_did_not_expect() {
        // A client that died at 90%, plus an API that believes it finished. Without this the short
        // file takes the user's chosen name — and RENAME_NOREPLACE then makes that name permanently
        // unavailable to the good copy.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "short.part"]),
            b"only nine",
        )
        .expect("stage");

        let raw = r#"{"op":"publish_transfer","share":"alice","staging_name":"short.part","destination":["full.txt"],"expected_bytes":9999,"owner_uid":300100,"owner_gid":300100}"#;
        match h
            .agent(&r, &s)
            .handle(raw, peer(API_UID), "c-short", "publish")
        {
            Response::Refused { reason } => assert!(reason.contains("expected 9999")),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(!h.share_path(&["alice", "full.txt"]).exists());
    }

    #[test]
    fn the_number_of_open_transfers_has_a_ceiling() {
        // Every open transfer is a descriptor held by a root daemon. Without a cap a burst of opens
        // exhausts RLIMIT_NOFILE and takes the control socket down with it.
        let h = Harness::with_share("alice");
        for i in 0..MAX_PENDING_TRANSFERS {
            assert!(
                matches!(
                    open_transfer(&h, "alice", &format!("f{i}.part")),
                    Response::Transfer { .. }
                ),
                "open {i} should be within the cap"
            );
        }
        match open_transfer(&h, "alice", "one-too-many.part") {
            Response::Refused { reason } => assert!(reason.contains("too many transfers")),
            other => panic!("expected a refusal at the cap, got {other:?}"),
        }
    }

    #[test]
    fn a_transfer_records_who_opened_it_and_why() {
        // The data connection needs both: the uid to check that the redeemer is the opener, and the
        // correlation id so its audit entry ties back to the HTTP request. Taken from the control
        // envelope, never from the data wire.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = r#"{"op":"open_transfer","share":"alice","staging_name":"traced.part"}"#;
        h.agent(&r, &s)
            .handle(raw, peer(API_UID), "corr-77", "upload for job 9");

        let registry = h.transfers.lock().expect("lock");
        assert_eq!(registry.pending_count(), 1);
        assert!(
            registry.is_busy("alice", "traced.part"),
            "the name must be reserved from the moment it is opened"
        );
    }

    #[test]
    fn a_transfer_is_audited_under_its_own_name() {
        // §16: a privileged call has to be explicable afterwards, and "open_transfer" is what the
        // journal should say — not a generic name that makes every upload look the same.
        let h = Harness::with_share("alice");
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let raw = r#"{"op":"open_transfer","share":"alice","staging_name":"a.part"}"#;
        h.agent(&r, &s)
            .handle(raw, peer(API_UID), "c-audit", "upload for job 7");

        let entries = s.entries();
        assert!(
            entries.iter().any(|e| e.operation == "open_transfer"),
            "the audit trail must name the operation, got {entries:?}"
        );
        assert!(
            entries.iter().any(|e| e.reason == "upload for job 7"),
            "and carry the caller's reason"
        );
    }

    // ── ZeroTier ──
    //
    // These go through `handle`, so they cover parsing, authorization and audit as well as the
    // handler. They do NOT require zerotier-one: on a box without it the answer is
    // `ZeroTierUnavailable`, which is the behaviour worth asserting either way.

    #[test]
    fn a_malformed_network_id_never_reaches_the_handler() {
        // The point of `NetworkId`: these are refused at parse time, before authorization, before
        // audit, and long before anything could be concatenated into a request path.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for raw in [
            r#"{"op":"zerotier_join","network_id":"../../../etc/pas"}"#,
            r#"{"op":"zerotier_join","network_id":"8056C2E21C000001"}"#,
            r#"{"op":"zerotier_leave","network_id":"8056c2e21c00000"}"#,
            r#"{"op":"zerotier_leave","network_id":"0123456789ab\r\ncd"}"#,
        ] {
            let resp = h.agent(&r, &s).handle(raw, peer(API_UID), "c-zt", "join");
            assert!(
                matches!(resp, Response::Refused { .. }),
                "{raw} must be refused, got {resp:?}"
            );
        }
        assert!(r.calls.borrow().is_empty(), "nothing may be executed");
        assert!(
            s.entries().is_empty(),
            "an unparseable request has no operation name to audit"
        );
    }

    #[test]
    fn a_status_request_answers_either_the_node_or_that_zerotier_is_absent() {
        // Never `Failed`. "Switched off" and "broken" are the distinction the operator needs
        // most (ADR-0020), and this is the assertion that keeps them apart.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = h.agent(&r, &s).handle(
            r#"{"op":"zerotier_status"}"#,
            peer(API_UID),
            "c-zt-status",
            "remote access card",
        );
        match &resp {
            Response::ZeroTierStatus { node_id, .. } => assert_eq!(node_id.len(), 10),
            Response::ZeroTierUnavailable { reason } => assert!(!reason.is_empty()),
            other => panic!("unexpected answer: {other:?}"),
        }
        assert!(
            s.entries().iter().any(|e| e.operation == "zerotier_status"),
            "the call must be audited under its own name"
        );
        assert!(
            r.calls.borrow().is_empty(),
            "the local API is spoken to directly; no process is spawned"
        );
    }

    #[test]
    fn a_networks_request_answers_either_a_list_or_that_zerotier_is_absent() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = h.agent(&r, &s).handle(
            r#"{"op":"zerotier_networks"}"#,
            peer(API_UID),
            "c-zt-nets",
            "remote access card",
        );
        assert!(
            matches!(
                resp,
                Response::ZeroTierNetworks { .. } | Response::ZeroTierUnavailable { .. }
            ),
            "unexpected answer: {resp:?}"
        );
    }

    #[test]
    fn zerotier_operations_still_require_the_api_uid() {
        // The agent holds the local API token because it grants network control. A caller that
        // is not the API must not be able to spend it, and the check is the same one every other
        // operation gets — which is the reason there is only one.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        for raw in [
            r#"{"op":"zerotier_status"}"#,
            r#"{"op":"zerotier_join","network_id":"8056c2e21c000001"}"#,
        ] {
            let resp = h
                .agent(&r, &s)
                .handle(raw, peer(1000), "c-zt-deny", "probe");
            assert!(matches!(resp, Response::Refused { .. }));
        }
    }

    #[test]
    fn a_zerotier_status_request_takes_no_arguments() {
        // `deny_unknown_fields` on an empty struct variant, and the braces in `ZeroTierStatus {}`
        // are what make it bite. A unit variant would have accepted the smuggled field.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::bare();
        let resp = h.agent(&r, &s).handle(
            r#"{"op":"zerotier_status","path":"/controller/network"}"#,
            peer(API_UID),
            "c-zt-smuggle",
            "attack",
        );
        assert!(matches!(resp, Response::Refused { .. }));
    }

    // ── MoveEntry / RemoveEntry ──
    //
    // Against `MockSafePath`, which is a REAL filesystem under a tempdir. What these pin is what
    // the dispatcher decides — which refusal, which status, and what is left on disk afterwards.
    // The syscall-level claims (RENAME_NOREPLACE actually refusing, AT_REMOVEDIR actually not
    // recursing, NO_SYMLINKS actually confining) are measured against a real kernel in `unix.rs`,
    // because a lexical mock could report any of them and prove none.

    fn call(h: &Harness, raw: &str) -> Response {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        h.agent(&r, &s)
            .handle(raw, peer(API_UID), "c-entry", "user asked")
    }

    #[test]
    fn securing_a_share_root_asks_for_0750_on_the_resolved_directory() {
        // WHAT THIS CLOSES. `zfs create` leaves a mountpoint at 0755 root:root, and
        // `ApplyFolderAcl` refuses to touch the base triple — so every share root was
        // `other::r-x` and any principal SMB authenticated could enumerate its top-level names
        // whatever `folder_grants` said.
        let h = Harness::with_share("alice");

        let raw = r#"{"op":"secure_share_root","share":"alice"}"#;
        match call(&h, raw) {
            Response::ShareRootSecured { mode } => assert_eq!(mode, crate::op::SHARE_ROOT_MODE),
            other => panic!("expected the root to be secured, got {other:?}"),
        }

        // The mock records the mode rather than applying it: a real chmod is measured against a
        // kernel in `unix.rs`, and what a portable test can pin is that the dispatcher asked for
        // the right number. `0o750` is the whole point — the last digit is what closes the share.
        assert_eq!(
            h.paths.as_ref().expect("share root").modes(),
            vec![0o750],
            "the share root must be asked for 0750, and nothing else"
        );
    }

    #[test]
    fn securing_a_share_that_does_not_exist_is_a_not_found_rather_than_a_new_directory() {
        // It secures; it does not provision. Creating the directory here would let a typo in a
        // share name produce a root-owned folder in the share tree that nothing in the database
        // names — and the next `openat2` for the real share would still fail.
        let h = Harness::with_share("alice");

        match call(&h, r#"{"op":"secure_share_root","share":"yok"}"#) {
            Response::NotFound { reason } => assert!(reason.contains("yok"), "{reason}"),
            other => panic!("expected not_found, got {other:?}"),
        }
        assert!(
            h.paths.as_ref().expect("share root").modes().is_empty(),
            "nothing should have been chmodded"
        );
    }

    #[test]
    fn securing_a_share_root_is_refused_when_no_share_root_is_configured() {
        // The same refusal every filesystem operation gives on a box whose storage is not set up.
        // A 503 the API can report, not a fault.
        //
        // `Harness::bare`, not `without_shares_root`: the env var is read when the agent is BUILT,
        // and the harness already holds a resolved root. Unsetting the variable afterwards changes
        // nothing, which is exactly what the first version of this test discovered by passing when
        // it should not have.
        let h = Harness::bare();
        match call(&h, r#"{"op":"secure_share_root","share":"alice"}"#) {
            Response::Refused { reason } => assert!(reason.contains("no share root"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_share_name_that_tries_to_leave_the_tree_never_reaches_the_chmod() {
        // `SafeComponent` refuses these at parse time, so the request does not deserialise at all
        // — which is the point of the typed operand set. Asserted here anyway because this
        // operation changes the MODE of a directory, and a redirected chmod on the top of a share
        // is about the worst thing in the operation set to get wrong.
        let h = Harness::with_share("alice");
        for raw in [
            r#"{"op":"secure_share_root","share":"../etc"}"#,
            r#"{"op":"secure_share_root","share":".."}"#,
            r#"{"op":"secure_share_root","share":"a/b"}"#,
            r#"{"op":"secure_share_root","share":"-rf"}"#,
        ] {
            match call(&h, raw) {
                Response::Refused { .. } => {}
                other => panic!("expected {raw} to be refused, got {other:?}"),
            }
            assert!(
                h.paths.as_ref().expect("share root").modes().is_empty(),
                "a refused request must not have chmodded anything: {raw}"
            );
        }
    }

    // ── ListDirectory ──
    //
    // The operation that makes an SMB write visible to DEPSIS at all. What these pin is what the
    // dispatcher DECIDES: which entries are reported, which are silently dropped, and whether a
    // caller can tell a complete listing from a clipped one.

    #[test]
    fn a_listing_reports_files_and_folders_with_their_sizes() {
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "docs"])).expect("mkdir");
        std::fs::write(h.share_path(&["alice", "not.txt"]), b"seven!!").expect("write");

        let raw = r#"{"op":"list_directory","share":"alice","path":[]}"#;
        match call(&h, raw) {
            Response::Listing {
                mut entries,
                truncated,
            } => {
                assert!(!truncated);
                entries.sort_by(|a, b| a.name.as_str().cmp(b.name.as_str()));
                assert_eq!(entries.len(), 2, "got {entries:?}");
                assert_eq!(entries[0].name.as_str(), "docs");
                assert!(entries[0].directory);
                assert_eq!(entries[0].size, 0, "a folder has no bytes of its own");
                assert_eq!(entries[1].name.as_str(), "not.txt");
                assert!(!entries[1].directory);
                assert_eq!(entries[1].size, 7);
            }
            other => panic!("expected a listing, got {other:?}"),
        }
    }

    #[test]
    fn a_listing_never_reports_the_agents_own_tree() {
        // `.depsis/staging` is inside the share, so the share root's listing would otherwise offer
        // it as an ordinary folder for DEPSIS to write a row for — and the API would then show
        // users a folder full of other people's half-finished uploads.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"list_directory","share":"alice","path":[]}"#;
        match call(&h, raw) {
            Response::Listing { entries, .. } => {
                assert!(
                    entries.iter().all(|e| e.name.as_str() != ".depsis"),
                    "got {entries:?}"
                );
            }
            other => panic!("expected a listing, got {other:?}"),
        }
    }

    #[test]
    fn listing_inside_the_agents_own_tree_is_refused() {
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"list_directory","share":"alice","path":[".depsis","staging"]}"#;
        assert!(matches!(call(&h, raw), Response::Refused { .. }));
    }

    #[test]
    fn listing_something_that_is_not_a_directory_is_a_not_found() {
        // The API turns this into 404. Arriving as `Failed` would make it a 500 for a case the
        // caller can act on: the folder it is reconciling was replaced by a file over SMB.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");

        for raw in [
            r#"{"op":"list_directory","share":"alice","path":["a.txt"]}"#,
            r#"{"op":"list_directory","share":"alice","path":["ghost"]}"#,
        ] {
            assert!(
                matches!(call(&h, raw), Response::NotFound { .. }),
                "must be not_found: {raw}"
            );
        }
    }

    #[test]
    fn a_listing_says_when_it_had_to_stop() {
        // A caller that could not tell a complete listing from a clipped one would reconcile the
        // first MAX_LISTING names and conclude everything else had been deleted.
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "many"])).expect("mkdir");
        for n in 0..(crate::op::MAX_LISTING + 5) {
            std::fs::write(h.share_path(&["alice", "many"]).join(format!("f{n}")), b"x")
                .expect("write");
        }

        let raw = r#"{"op":"list_directory","share":"alice","path":["many"]}"#;
        match call(&h, raw) {
            Response::Listing { entries, truncated } => {
                assert!(truncated, "a clipped listing must say so");
                assert_eq!(entries.len(), crate::op::MAX_LISTING);
            }
            other => panic!("expected a listing, got {other:?}"),
        }
    }

    #[test]
    fn a_listing_drops_what_depsis_cannot_represent() {
        // A symlink is dropped by the seam and a name that is not a `SafeComponent` by the
        // dispatcher. Both would otherwise become a row naming something the agent itself refuses
        // to open — a file the interface offers and cannot deliver.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "real.txt"]), b"x").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", h.share_path(&["alice", "escape"]))
            .expect("link");

        let raw = r#"{"op":"list_directory","share":"alice","path":[]}"#;
        match call(&h, raw) {
            Response::Listing { entries, .. } => {
                assert!(
                    entries.iter().all(|e| e.name.as_str() != "escape"),
                    "a symlink must not be reported: {entries:?}"
                );
                assert!(entries.iter().any(|e| e.name.as_str() == "real.txt"));
            }
            other => panic!("expected a listing, got {other:?}"),
        }
    }

    #[test]
    fn a_listing_is_refused_when_no_share_root_is_configured() {
        let h = Harness::bare();
        let raw = r#"{"op":"list_directory","share":"alice","path":[]}"#;
        assert!(matches!(call(&h, raw), Response::Refused { .. }));
    }

    // ── CopyFile ──

    #[test]
    fn a_copy_leaves_the_source_alone_and_writes_the_same_bytes() {
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "docs"])).expect("mkdir docs");
        std::fs::write(h.share_path(&["alice", "docs", "a.txt"]), b"keep me").expect("write");

        let raw = r#"{"op":"copy_file","share":"alice","from":["docs","a.txt"],"to":["b.txt"],"staging_name":"s1.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        match call(&h, raw) {
            Response::Copied { offset, done } => {
                assert_eq!(offset, 7);
                assert!(done, "one slice was enough for seven bytes");
            }
            other => panic!("expected a copy, got {other:?}"),
        }

        assert_eq!(
            std::fs::read(h.share_path(&["alice", "docs", "a.txt"])).expect("read src"),
            b"keep me",
            "a copy must not touch the source"
        );
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "b.txt"])).expect("read dst"),
            b"keep me"
        );
    }

    #[test]
    fn a_copy_leaves_nothing_in_staging_when_it_succeeds() {
        // The staging file is renamed, not left behind. A copy that published AND kept its staged
        // copy would double the space every copy costs until the sweeper's ten-minute pass.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");

        let raw = r#"{"op":"copy_file","share":"alice","from":["a.txt"],"to":["b.txt"],"staging_name":"s2.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        assert!(matches!(call(&h, raw), Response::Copied { done: true, .. }));
        assert!(
            !h.share_path(&["alice", STAGING_DIR[0], STAGING_DIR[1], "s2.part"])
                .exists(),
            "the staging file must be gone after a publish"
        );
    }

    #[test]
    fn a_copy_onto_an_existing_name_is_refused_and_changes_nothing() {
        // The rule the whole product rests on: publishing never destroys a file the user already
        // has. `RENAME_NOREPLACE` decides it inside the syscall, so there is no window.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"the source").expect("write src");
        std::fs::write(h.share_path(&["alice", "b.txt"]), b"the resident").expect("write dst");

        let raw = r#"{"op":"copy_file","share":"alice","from":["a.txt"],"to":["b.txt"],"staging_name":"s3.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        match call(&h, raw) {
            Response::Conflict { reason } => assert!(reason.contains("b.txt"), "{reason}"),
            other => panic!("expected a conflict, got {other:?}"),
        }

        assert_eq!(
            std::fs::read(h.share_path(&["alice", "b.txt"])).expect("read dst"),
            b"the resident",
            "the destination was overwritten"
        );
    }

    #[test]
    fn copying_something_that_is_not_there_is_a_not_found() {
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"copy_file","share":"alice","from":["ghost.txt"],"to":["b.txt"],"staging_name":"s4.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        assert!(matches!(call(&h, raw), Response::NotFound { .. }));
    }

    #[test]
    fn a_copy_into_a_folder_that_does_not_exist_is_refused_rather_than_creating_it() {
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");

        let raw = r#"{"op":"copy_file","share":"alice","from":["a.txt"],"to":["nope","a.txt"],"staging_name":"s5.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        assert!(matches!(call(&h, raw), Response::NotFound { .. }));
        assert!(!h.share_path(&["alice", "nope"]).exists());
    }

    #[test]
    fn a_staging_file_that_disagrees_with_the_offset_is_refused_rather_than_appended_to() {
        // Slicing made the staging file resumable, so a name that is already taken is no longer
        // decided by an exclusive create. What decides it now is the LENGTH: the file is the
        // authority, and a caller whose number disagrees with it would either duplicate a region
        // or leave a hole — both of which produce a file that looks complete and is not.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");
        std::fs::write(
            h.share_path(&["alice", STAGING_DIR[0], STAGING_DIR[1], "taken.part"]),
            b"somebody else",
        )
        .expect("write staged");

        let raw = r#"{"op":"copy_file","share":"alice","from":["a.txt"],"to":["b.txt"],"staging_name":"taken.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        assert!(matches!(call(&h, raw), Response::Conflict { .. }));
        assert_eq!(
            std::fs::read(h.share_path(&["alice", STAGING_DIR[0], STAGING_DIR[1], "taken.part"]))
                .expect("read staged"),
            b"somebody else",
            "the other job's staging file was written into"
        );
    }

    #[test]
    fn a_file_larger_than_one_slice_takes_several_calls_and_arrives_whole() {
        // The reason slicing exists, measured. The control socket is served one connection at a
        // time, so an unbounded copy is a control-plane outage; what has to be true in exchange is
        // that several bounded calls reassemble the file byte for byte.
        let h = Harness::with_share("alice");
        let body: Vec<u8> = (0..1000u32).map(|n| (n % 251) as u8).collect();
        std::fs::write(h.share_path(&["alice", "big.bin"]), &body).expect("write");

        let mut offset = 0u64;
        let mut calls = 0;
        loop {
            let raw = format!(
                r#"{{"op":"copy_file","share":"alice","from":["big.bin"],"to":["copy.bin"],"staging_name":"big.part","offset":{offset},"max_bytes":256,"owner_uid":300001,"owner_gid":300001}}"#
            );
            calls += 1;
            match call(&h, &raw) {
                Response::Copied { offset: next, done } => {
                    assert!(next > offset, "a slice must make progress");
                    offset = next;
                    if done {
                        break;
                    }
                }
                other => panic!("expected a slice, got {other:?}"),
            }
            assert!(calls < 20, "the loop is not terminating");
        }

        assert_eq!(calls, 4, "1000 bytes in 256-byte slices");
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "copy.bin"])).expect("read copy"),
            body,
            "the reassembled copy must be byte-identical"
        );
    }

    #[test]
    fn nothing_is_published_until_the_last_slice() {
        // A destination that appeared halfway through would be a file the user can open and read
        // as truncated — and `RENAME_NOREPLACE` would then make the good copy's name permanently
        // unusable.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "big.bin"]), vec![7u8; 600]).expect("write");

        let raw = r#"{"op":"copy_file","share":"alice","from":["big.bin"],"to":["copy.bin"],"staging_name":"part.part","offset":0,"max_bytes":256,"owner_uid":300001,"owner_gid":300001}"#;
        match call(&h, raw) {
            Response::Copied { offset, done } => {
                assert_eq!(offset, 256);
                assert!(!done);
            }
            other => panic!("expected an unfinished slice, got {other:?}"),
        }
        assert!(
            !h.share_path(&["alice", "copy.bin"]).exists(),
            "the destination must not exist until the copy is whole"
        );
        assert_eq!(
            std::fs::metadata(h.share_path(&[
                "alice",
                STAGING_DIR[0],
                STAGING_DIR[1],
                "part.part"
            ]))
            .expect("stat staged")
            .len(),
            256
        );
    }

    #[test]
    fn a_slice_the_caller_asked_to_make_huge_is_handled_rather_than_overflowing() {
        // A caller that asks for the whole file must not get it — the clamp is what makes "no
        // single agent call can be made long" true rather than a convention the API is trusted to
        // follow. Measured against the behaviour, not the constant: asserting the constant equals
        // itself would pass with the clamp deleted. What this pins is that `u64::MAX` is neither
        // refused nor overflowed by `offset.saturating_add(slice)`.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "big.bin"]), vec![3u8; 400]).expect("write");

        let raw = format!(
            r#"{{"op":"copy_file","share":"alice","from":["big.bin"],"to":["copy.bin"],"staging_name":"clamp.part","offset":0,"max_bytes":{},"owner_uid":300001,"owner_gid":300001}}"#,
            u64::MAX
        );
        match call(&h, &raw) {
            Response::Copied { offset, done } => {
                assert_eq!(offset, 400);
                assert!(done);
            }
            other => panic!("expected a completed copy, got {other:?}"),
        }
    }

    #[test]
    fn a_copy_cannot_reach_into_or_out_of_the_agents_own_tree() {
        // The same door `MoveEntry` and `RemoveEntry` close. A copy OUT of staging publishes a
        // half-finished upload under a name of the caller's choosing with none of
        // `PublishTransfer`'s byte-count check; a copy INTO it puts a file where the sweeper will
        // delete it and the transfer registry does not know about it.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");

        for raw in [
            r#"{"op":"copy_file","share":"alice","from":[".depsis","staging","x.part"],"to":["stolen.txt"],"staging_name":"s6.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#,
            r#"{"op":"copy_file","share":"alice","from":["a.txt"],"to":[".depsis","staging","planted.part"],"staging_name":"s7.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#,
        ] {
            assert!(
                matches!(call(&h, raw), Response::Refused { .. }),
                "must refuse: {raw}"
            );
        }
        assert!(!h.share_path(&["alice", "stolen.txt"]).exists());
    }

    #[test]
    fn a_copy_is_refused_when_no_share_root_is_configured() {
        let h = Harness::bare();
        let raw = r#"{"op":"copy_file","share":"alice","from":["a.txt"],"to":["b.txt"],"staging_name":"s8.part","offset":0,"max_bytes":4096,"owner_uid":300001,"owner_gid":300001}"#;
        assert!(matches!(call(&h, raw), Response::Refused { .. }));
    }

    #[test]
    fn a_move_relocates_the_entry_and_keeps_its_contents() {
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "docs"])).expect("mkdir docs");
        std::fs::create_dir(h.share_path(&["alice", "archive"])).expect("mkdir archive");
        std::fs::write(h.share_path(&["alice", "docs", "a.txt"]), b"keep me").expect("write");

        let raw = r#"{"op":"move_entry","share":"alice","from":["docs","a.txt"],"to":["archive","b.txt"]}"#;
        assert!(
            matches!(call(&h, raw), Response::Moved {}),
            "the move must succeed"
        );

        assert!(!h.share_path(&["alice", "docs", "a.txt"]).exists());
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "archive", "b.txt"])).expect("read"),
            b"keep me",
            "a move must not touch the bytes"
        );
    }

    #[test]
    fn a_move_onto_an_existing_name_is_refused_and_changes_nothing() {
        // The one outcome this product cannot accept: a silent overwrite. Both files must be
        // exactly where they were, with exactly the contents they had.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "from.txt"]), b"the mover").expect("write src");
        std::fs::write(h.share_path(&["alice", "to.txt"]), b"the resident").expect("write dst");

        let raw = r#"{"op":"move_entry","share":"alice","from":["from.txt"],"to":["to.txt"]}"#;
        match call(&h, raw) {
            Response::Conflict { reason } => assert!(reason.contains("to.txt"), "{reason}"),
            other => panic!("expected a conflict, got {other:?}"),
        }

        assert_eq!(
            std::fs::read(h.share_path(&["alice", "to.txt"])).expect("read dst"),
            b"the resident",
            "the destination was overwritten"
        );
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "from.txt"])).expect("read src"),
            b"the mover",
            "a refused move must leave the source in place"
        );
    }

    #[test]
    fn moving_something_that_is_not_there_is_a_not_found_and_not_a_failure() {
        // The API turns this into 404. Arriving as `Failed` would make it a 500 for a case the
        // client can act on — the file was renamed over SMB since the listing it is working from.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"move_entry","share":"alice","from":["ghost.txt"],"to":["b.txt"]}"#;
        assert!(
            matches!(call(&h, raw), Response::NotFound { .. }),
            "a missing source must be distinguishable"
        );
    }

    #[test]
    fn a_move_into_a_folder_that_does_not_exist_is_refused_rather_than_creating_it() {
        // No implicit mkdir. Creating the parent would make a typo in the destination produce a
        // directory the user never asked for, containing the file they can no longer find.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");

        let raw = r#"{"op":"move_entry","share":"alice","from":["a.txt"],"to":["nope","a.txt"]}"#;
        assert!(matches!(call(&h, raw), Response::NotFound { .. }));
        assert!(
            h.share_path(&["alice", "a.txt"]).exists(),
            "the source must survive a refused move"
        );
        assert!(!h.share_path(&["alice", "nope"]).exists());
    }

    #[test]
    fn a_move_cannot_carry_a_file_out_of_or_into_the_agents_own_tree() {
        // Out of staging would rename a half-written `.part` into the user's tree without the
        // byte-count check `PublishTransfer` performs; into it would step past the registry's
        // interlock. The upload path has its own three operations and they are the only way in.
        let h = Harness::with_share("alice");
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "half.part"]),
            b"incomplete",
        )
        .expect("stage");
        std::fs::write(h.share_path(&["alice", "mine.txt"]), b"x").expect("write");

        let out = r#"{"op":"move_entry","share":"alice","from":[".depsis","staging","half.part"],"to":["report.txt"]}"#;
        assert!(matches!(call(&h, out), Response::Refused { .. }));
        assert!(
            !h.share_path(&["alice", "report.txt"]).exists(),
            "a half-written upload reached the user's tree"
        );

        let into = r#"{"op":"move_entry","share":"alice","from":["mine.txt"],"to":[".depsis","staging","mine.txt"]}"#;
        assert!(matches!(call(&h, into), Response::Refused { .. }));
        assert!(h.share_path(&["alice", "mine.txt"]).exists());
    }

    #[test]
    fn a_move_cannot_name_the_share_root_as_either_end() {
        // An empty list is the share itself. Renaming a share is a dataset operation with a
        // dataset's consequences and must not be reachable by omitting elements.
        let h = Harness::with_share("alice");
        for raw in [
            r#"{"op":"move_entry","share":"alice","from":[],"to":["x"]}"#,
            r#"{"op":"move_entry","share":"alice","from":["x"],"to":[]}"#,
        ] {
            assert!(matches!(call(&h, raw), Response::Refused { .. }), "{raw}");
        }
    }

    #[test]
    fn a_traversing_move_never_reaches_the_filesystem() {
        // Refused at parse time by `SafeComponent`, before authorization and before any path work.
        // The dispatcher half of the type test in `op.rs`.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"move_entry","share":"alice","from":["..","..","etc","passwd"],"to":["stolen"]}"#;
        match call(&h, raw) {
            Response::Refused { reason } => assert!(reason.contains("unparseable"), "{reason}"),
            other => panic!("expected a parse refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_file_is_removed_and_a_second_removal_says_so() {
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "gone.txt"]), b"x").expect("write");

        let raw = r#"{"op":"remove_entry","share":"alice","path":["gone.txt"],"directory":false}"#;
        assert!(matches!(call(&h, raw), Response::Removed {}));
        assert!(!h.share_path(&["alice", "gone.txt"]).exists());

        // NOT a success on the second call, unlike `DiscardTransfer`. A discard races the sweeper;
        // a remove the user asked for finding nothing means their picture of the tree and the disk
        // have diverged, and the API has to answer 404 rather than report a deletion.
        assert!(
            matches!(call(&h, raw), Response::NotFound { .. }),
            "removing something that is not there must be distinguishable"
        );
    }

    #[test]
    fn an_empty_directory_is_removed_and_a_populated_one_is_refused() {
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "empty"])).expect("mkdir");
        std::fs::create_dir(h.share_path(&["alice", "full"])).expect("mkdir");
        std::fs::write(h.share_path(&["alice", "full", "child.txt"]), b"still mine")
            .expect("write");

        let empty = r#"{"op":"remove_entry","share":"alice","path":["empty"],"directory":true}"#;
        assert!(matches!(call(&h, empty), Response::Removed {}));
        assert!(!h.share_path(&["alice", "empty"]).exists());

        // The headline property: there is no way to ask the agent for a tree. The API walks it.
        let full = r#"{"op":"remove_entry","share":"alice","path":["full"],"directory":true}"#;
        match call(&h, full) {
            Response::Conflict { reason } => assert!(reason.contains("full"), "{reason}"),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "full", "child.txt"])).expect("read"),
            b"still mine",
            "the child was destroyed on the way to refusing"
        );
    }

    #[test]
    fn removing_a_file_that_is_being_downloaded_is_allowed_and_the_reader_keeps_its_bytes() {
        // Pinning the behaviour rather than the guess. A read takes no registry reservation
        // (`TransferRegistry::insert`, measured in P1-D), so `is_busy` is false here and the remove
        // goes through — which is correct: the reader holds an open descriptor, so it stays on the
        // same inode with the same contents, and the space comes back when it closes.
        //
        // The case that WOULD be dangerous is unlinking a file a writer is appending to, and that
        // one is unreachable: a writer is always in `.depsis/staging`, which `remove_entry`
        // refuses outright.
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "busy.txt"]), b"being read").expect("write");

        let open = r#"{"op":"open_download","share":"alice","path":["busy.txt"]}"#;
        let token = match call(&h, open) {
            Response::Download { token, .. } => token,
            other => panic!("expected a download, got {other:?}"),
        };

        let remove =
            r#"{"op":"remove_entry","share":"alice","path":["busy.txt"],"directory":false}"#;
        assert!(matches!(call(&h, remove), Response::Removed {}));
        assert!(!h.share_path(&["alice", "busy.txt"]).exists());

        // The descriptor the agent opened is still in the registry and still readable — the whole
        // reason a download does not have to hold the name.
        let mut registry = h
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (mut transfer, _) = registry.claim(&token, peer(API_UID)).expect("claim");
        drop(registry);
        let mut bytes = Vec::new();
        transfer
            .file
            .seek(std::io::SeekFrom::Start(0))
            .expect("rewind");
        std::io::Read::read_to_end(&mut transfer.file, &mut bytes).expect("read");
        assert_eq!(
            bytes, b"being read",
            "the unlinked inode must still serve the reader"
        );
    }

    #[test]
    fn a_remove_cannot_reach_the_agents_own_tree_or_the_share_root() {
        let h = Harness::with_share("alice");
        std::fs::write(
            h.share_path(&["alice", ".depsis", "staging", "live.part"]),
            b"in flight",
        )
        .expect("stage");

        let staging = r#"{"op":"remove_entry","share":"alice","path":[".depsis","staging","live.part"],"directory":false}"#;
        assert!(matches!(call(&h, staging), Response::Refused { .. }));
        assert!(h
            .share_path(&["alice", ".depsis", "staging", "live.part"])
            .exists());

        let root = r#"{"op":"remove_entry","share":"alice","path":[],"directory":true}"#;
        assert!(
            matches!(call(&h, root), Response::Refused { .. }),
            "an empty path names the share itself and must never be a delete"
        );
        assert!(h.share_path(&["alice"]).exists());
    }

    #[test]
    fn a_removal_is_recorded_with_the_share_the_path_and_the_correlation_id() {
        // An operation with no undo has to be answerable afterwards. `Entry` carries the operation
        // NAME only by design (§16), which is right everywhere except here — "remove_entry,
        // allowed" does not answer "which file is gone?".
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "docs"])).expect("mkdir");
        std::fs::write(h.share_path(&["alice", "docs", "receipt.pdf"]), b"x").expect("write");

        let raw = r#"{"op":"remove_entry","share":"alice","path":["docs","receipt.pdf"],"directory":false}"#;
        assert!(matches!(
            h.agent(&r, &s)
                .handle(raw, peer(API_UID), "corr-42", "user emptied the trash"),
            Response::Removed {}
        ));

        let entries = s.entries();
        let recorded = entries
            .iter()
            .find(|e| e.reason.contains("removed"))
            .unwrap_or_else(|| panic!("no removal record in {entries:?}"));
        assert_eq!(recorded.operation, "remove_entry");
        assert_eq!(recorded.correlation_id, "corr-42");
        assert!(
            recorded.reason.contains("alice/docs/receipt.pdf"),
            "{}",
            recorded.reason
        );
        assert!(
            recorded.reason.contains("user emptied the trash"),
            "the caller's own reason must survive: {}",
            recorded.reason
        );
    }

    #[test]
    fn a_refused_removal_leaves_no_record_claiming_the_file_is_gone() {
        // The other half of the audit claim. A trail that says "removed" for a delete that did not
        // happen is worse than no trail: it is evidence for the wrong conclusion.
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"remove_entry","share":"alice","path":["ghost.txt"],"directory":false}"#;
        assert!(matches!(
            h.agent(&r, &s)
                .handle(raw, peer(API_UID), "corr-43", "user emptied the trash"),
            Response::NotFound { .. }
        ));
        assert!(
            !s.entries().iter().any(|e| e.reason.contains("removed")),
            "a removal that did not happen was recorded as one"
        );
    }

    #[test]
    fn move_and_remove_are_refused_before_storage_is_set_up() {
        let h = Harness::bare();
        for raw in [
            r#"{"op":"move_entry","share":"alice","from":["a"],"to":["b"]}"#,
            r#"{"op":"remove_entry","share":"alice","path":["a"],"directory":false}"#,
        ] {
            match call(&h, raw) {
                Response::Refused { reason } => {
                    assert!(reason.contains("no share root"), "{reason}");
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    #[test]
    fn move_and_remove_still_require_the_api_uid() {
        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::with_share("alice");
        std::fs::write(h.share_path(&["alice", "a.txt"]), b"x").expect("write");
        for raw in [
            r#"{"op":"move_entry","share":"alice","from":["a.txt"],"to":["b.txt"]}"#,
            r#"{"op":"remove_entry","share":"alice","path":["a.txt"],"directory":false}"#,
        ] {
            assert!(matches!(
                h.agent(&r, &s).handle(raw, peer(1000), "c-deny", "probe"),
                Response::Refused { .. }
            ));
        }
        assert!(
            h.share_path(&["alice", "a.txt"]).exists(),
            "an unauthorized caller changed the filesystem"
        );
    }

    // ── CreateDirectory ──
    //
    // Against `MockSafePath`, which is a REAL filesystem under a tempdir: what these pin is what
    // the dispatcher decides and what is on disk afterwards. The claims that need a kernel — the
    // mode really being 0750, `fchown` really changing hands, NO_SYMLINKS really refusing a
    // symlinked parent — are measured in `unix.rs`, because a mock could report any of them and
    // prove none (ADR-0007).

    #[test]
    fn a_directory_is_created_on_disk_and_handed_to_the_named_owner() {
        // The gap this operation closes: before it, a folder was a database row and nothing else.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":300101,"owner_gid":302001}"#;
        assert!(matches!(call(&h, raw), Response::DirectoryCreated {}));

        assert!(
            h.share_path(&["alice", "docs"]).is_dir(),
            "the folder exists in the API's mind and not on the disk — the whole bug"
        );
        assert_eq!(
            h.paths.as_ref().expect("share root").owners(),
            vec![(300101, 302001)],
            "the directory must be handed to the user, not left to the service account"
        );
    }

    #[test]
    fn a_nested_directory_is_created_one_node_at_a_time() {
        // One call, one node, one row. The second call proves the first left a real directory
        // behind: a `mkdir -p` implementation would pass the second assertion without the first
        // call having happened at all, so the order here is the test.
        let h = Harness::with_share("alice");
        let parent = r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":300101,"owner_gid":302001}"#;
        let child = r#"{"op":"create_directory","share":"alice","path":["docs","2026"],"owner_uid":300101,"owner_gid":302001}"#;

        assert!(matches!(call(&h, parent), Response::DirectoryCreated {}));
        assert!(matches!(call(&h, child), Response::DirectoryCreated {}));
        assert!(h.share_path(&["alice", "docs", "2026"]).is_dir());
    }

    #[test]
    fn a_name_that_is_already_taken_is_a_conflict_and_not_a_quiet_success() {
        // `mkdir` looks idempotent; this operation must not be. The API writes one row per call,
        // so answering "created" for a directory that is already there is how two rows come to
        // describe one directory on disk — and then one of them can never be deleted.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":300101,"owner_gid":302001}"#;
        assert!(matches!(call(&h, raw), Response::DirectoryCreated {}));

        match call(&h, raw) {
            Response::Conflict { reason } => assert!(reason.contains("docs"), "{reason}"),
            other => panic!("expected a conflict, got {other:?}"),
        }

        // A FILE at the name is the same answer. It is a different kind of collision and the
        // caller does the same thing about it: pick another name.
        std::fs::write(h.share_path(&["alice", "notes.txt"]), b"mine").expect("write");
        let onto_file = r#"{"op":"create_directory","share":"alice","path":["notes.txt"],"owner_uid":300101,"owner_gid":302001}"#;
        assert!(matches!(call(&h, onto_file), Response::Conflict { .. }));
        assert_eq!(
            std::fs::read(h.share_path(&["alice", "notes.txt"])).expect("read"),
            b"mine",
            "a refused create must not have touched the file that was in the way"
        );
    }

    #[test]
    fn a_missing_parent_is_a_not_found_rather_than_an_implicit_mkdir_p() {
        // Distinguishable from the conflict above, because the API answers 404 for one and 409 for
        // the other. And nothing is created on the way to refusing: an implicit parent would be a
        // directory on disk that no row names, invisible to the UI and unremovable through it.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"create_directory","share":"alice","path":["nope","deep"],"owner_uid":300101,"owner_gid":302001}"#;
        match call(&h, raw) {
            Response::NotFound { reason } => assert!(reason.contains("nope"), "{reason}"),
            other => panic!("expected a not-found, got {other:?}"),
        }
        assert!(
            !h.share_path(&["alice", "nope"]).exists(),
            "the missing parent was created for the caller"
        );
    }

    #[test]
    fn a_directory_may_not_be_owned_by_root() {
        // The same refusal as `PublishTransfer`, and the same reason: an API that skipped the
        // uid mapping must fail loudly rather than produce a folder the tenant cannot enter. It is
        // refused BEFORE the filesystem is touched, which is what the second assertion pins — a
        // check after the mkdir would leave the name taken by a root-owned directory.
        let h = Harness::with_share("alice");
        for raw in [
            r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":0,"owner_gid":302001}"#,
            r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":300101,"owner_gid":0}"#,
            r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":0,"owner_gid":0}"#,
        ] {
            match call(&h, raw) {
                Response::Refused { reason } => assert!(reason.contains("root"), "{reason}"),
                other => panic!("expected a refusal for {raw}, got {other:?}"),
            }
            assert!(
                !h.share_path(&["alice", "docs"]).exists(),
                "a refused create left a root-owned directory holding the name"
            );
        }
        assert!(
            h.paths.as_ref().expect("share root").owners().is_empty(),
            "nothing should have been chowned"
        );
    }

    #[test]
    fn a_create_cannot_reach_the_agents_own_tree_or_name_the_share_root() {
        let h = Harness::with_share("alice");

        let staging = r#"{"op":"create_directory","share":"alice","path":[".depsis","staging","mine"],"owner_uid":300101,"owner_gid":302001}"#;
        assert!(matches!(call(&h, staging), Response::Refused { .. }));
        assert!(!h
            .share_path(&["alice", ".depsis", "staging", "mine"])
            .exists());

        let root = r#"{"op":"create_directory","share":"alice","path":[],"owner_uid":300101,"owner_gid":302001}"#;
        assert!(
            matches!(call(&h, root), Response::Refused { .. }),
            "an empty path names the share itself, which is a dataset and already exists"
        );
    }

    #[test]
    fn a_traversing_create_never_reaches_the_filesystem() {
        // Refused at parse time by `SafeComponent`, before authorization and before any path work.
        // The dispatcher half of the type test in `op.rs`: `..` has no inhabitant, so the mkdirat
        // below can never be reached with one.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"create_directory","share":"alice","path":["..","..","tmp","evil"],"owner_uid":300101,"owner_gid":302001}"#;
        match call(&h, raw) {
            Response::Refused { reason } => assert!(reason.contains("unparseable"), "{reason}"),
            other => panic!("expected a parse refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_create_is_refused_before_storage_is_set_up_and_still_requires_the_api_uid() {
        let raw = r#"{"op":"create_directory","share":"alice","path":["docs"],"owner_uid":300101,"owner_gid":302001}"#;

        let bare = Harness::bare();
        match call(&bare, raw) {
            Response::Refused { reason } => assert!(reason.contains("no share root"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }

        let r = MockCommandRunner::default();
        let s = MemorySink::default();
        let h = Harness::with_share("alice");
        assert!(matches!(
            h.agent(&r, &s).handle(raw, peer(1000), "c-deny", "probe"),
            Response::Refused { .. }
        ));
        assert!(
            !h.share_path(&["alice", "docs"]).exists(),
            "an unauthorized caller changed the filesystem"
        );
    }

    // ── ApplyFolderAcl ──
    //
    // The dispatcher half of `acl.rs`. What is worth pinning HERE, rather than there, is that the
    // arm reaches the applier at all and that each of its errors becomes the answer the API can act
    // on — a 503 and a 500 are different pages for an operator.
    //
    // The applier is handed in rather than built from the environment, because it decides whether
    // `setfacl` exists by asking the real filesystem: on a box without the `acl` package — every
    // developer machine here, and the Windows target CI cross-checks — an arm built the production
    // way would return `acl_unavailable` in every one of these and assert nothing.

    /// A box where the `acl` package is installed, whatever the box actually is.
    fn acl_present(_: &str) -> bool {
        true
    }

    /// And one where it is not, which is the state the 503 exists for.
    fn acl_absent(_: &str) -> bool {
        false
    }

    /// A plausible `getfacl -c` reply for a directory nobody has touched yet.
    const PLAIN_ACL: &str = "user::rwx\ngroup::r-x\nother::r-x\n";

    /// The five replies one application consumes: getfacl, -b, -m, -d -m, getfacl.
    fn acl_replies() -> Vec<String> {
        vec![
            PLAIN_ACL.to_string(),
            String::new(),
            String::new(),
            String::new(),
            PLAIN_ACL.to_string(),
        ]
    }

    fn grant(gid: u32, read: bool, write: bool, execute: bool) -> AclEntry {
        AclEntry {
            gid: PosixId::parse(gid).expect("test gids live in the reserved range"),
            read,
            write,
            execute,
        }
    }

    #[test]
    fn the_arm_writes_the_access_acl_and_the_default_acl_for_the_resolved_path() {
        // The default pass is the whole test. Without it the folder is granted and everything
        // created inside it afterwards is not — ADR-0004 is explicit that the default ACL is the
        // only inheritance mechanism Linux has, so a one-pass application is the failure that looks
        // like it worked.
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "faturalar"])).expect("mkdir");

        let runner = MockCommandRunner::with_responses(acl_replies());
        let sink = MemorySink::default();
        let applier =
            acl::Applier::new(&runner, h.root.path().to_path_buf()).with_probe(acl_present);

        let response = h
            .agent(&runner, &sink)
            .apply_folder_acl_with(
                &applier,
                "alice",
                &["faturalar"],
                &[grant(301200, true, true, true)],
            )
            .expect("the application must not fault");
        assert!(
            matches!(response, Response::AclApplied { entries: 1 }),
            "got {response:?}"
        );

        let target = h
            .share_path(&["alice", "faturalar"])
            .to_str()
            .expect("utf-8 tempdir")
            .to_string();
        let calls = runner.calls.borrow().clone();
        assert_eq!(calls.len(), 5, "getfacl, three setfacl passes, getfacl");
        assert_eq!(
            calls[1],
            vec![acl::SETFACL, "-b", "--", &target],
            "the clear comes first; a merge would leave a permission the caller just removed in \
             force"
        );
        assert_eq!(
            calls[2],
            vec![acl::SETFACL, "-m", "g:301200:rwx", "--", &target],
            "the access ACL"
        );
        assert_eq!(
            calls[3],
            vec![acl::SETFACL, "-d", "-m", "g:301200:rwx", "--", &target],
            "the DEFAULT ACL — without it nothing created in this folder later inherits the grant"
        );
    }

    /// The ACL argv must be aimed at the CONFINED DESCRIPTOR, and must never recurse.
    ///
    /// The regression this pins is a local privilege escalation, so it is asserted on the argv
    /// rather than on an outcome. `Applier` used to hand `setfacl` a re-joined absolute path, which
    /// an ordinary resolution walks a second time — and `setfacl 2.3.2` was measured following a
    /// symlink given as an argument. Anyone with create rights in the share tree could therefore
    /// `mv folder folder.bak && ln -s /etc folder` between the agent's `openat2` and the exec and
    /// have a root process write their own team's gid, rwx, plus a default ACL, onto `/etc`.
    ///
    /// `SafePath::command_path` is the fix and `MockSafePath` answers it with a real path under the
    /// temp root, so what this test can prove portably is the SHAPE: every pass is aimed at
    /// whatever `command_path` returned for the descriptor `open_dir` opened, and no pass carries
    /// `-R` or `-P`. That the real implementation answers `/proc/self/fd/N` is asserted against a
    /// kernel in `unix.rs`.
    #[test]
    fn every_acl_pass_is_aimed_at_the_confined_descriptor_and_never_recurses() {
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "faturalar"])).expect("mkdir");

        let runner = MockCommandRunner::with_responses(acl_replies());
        let sink = MemorySink::default();
        let applier =
            acl::Applier::new(&runner, h.root.path().to_path_buf()).with_probe(acl_present);

        h.agent(&runner, &sink)
            .apply_folder_acl_with(
                &applier,
                "alice",
                &["faturalar"],
                &[grant(301200, true, false, true)],
            )
            .expect("apply");

        let paths = h.paths.as_ref().expect("the harness has a share root");

        // The discriminating assertion. The mock answers `command_path` with the same string a
        // plain join produces, so comparing the argv alone cannot tell the descriptor form from the
        // re-joined path — measured: reverting `apply` to the joined path left every argv check
        // below passing. What a revert cannot fake is ASKING for the command path, so that is what
        // is counted. `unix.rs` proves the answer survives a rename of the directory.
        assert_eq!(
            paths.command_paths(),
            1,
            "`apply` must aim setfacl at the descriptor `SafePath` confined; it never asked for              the command path, which means it built a path of its own"
        );

        let confined = paths
            .open_dir(&["alice", "faturalar"])
            .expect("the folder resolves");
        let aimed = paths
            .command_path(&confined)
            .expect("a command path for the descriptor");

        let calls = runner.calls.borrow().clone();
        let mut passes = 0;
        for argv in &calls {
            let program = argv.first().map(String::as_str);
            if program != Some(acl::SETFACL) && program != Some(acl::GETFACL) {
                continue;
            }
            passes += 1;
            assert_eq!(
                argv.last().map(String::as_str),
                Some(aimed.as_str()),
                "every pass must name the object the kernel confined, not a re-joined path a                  symlink swap can redirect: {argv:?}"
            );
            assert!(
                !argv.iter().any(|a| a == "-R" || a == "--recursive"),
                "no pass may recurse: `-R -b` erases sub-folder grants and `-R` walks into                  .depsis/staging: {argv:?}"
            );
            assert!(
                !argv.iter().any(|a| a == "-P" || a == "--physical"),
                "-P would make setfacl skip the magic-link target and exit 0 having applied                  nothing: {argv:?}"
            );
        }
        assert_eq!(passes, 5, "getfacl, three setfacl passes, getfacl");
    }

    /// `.depsis/` must be refused, like it is for move, remove and mkdir.
    ///
    /// This was the one path-taking operation that did not close the door. An ACL is the worst of
    /// the four to let in there: a group entry on `staging` overrides the 0600 that keeps a
    /// half-uploaded file from being read by another tenant, and the write bit lets a group member
    /// rewrite a `.part` in flight — `PublishTransfer` checks only the byte count, so substituted
    /// content of equal length publishes under the uploader's name.
    ///
    /// Asserted through `handle`, so it covers the whole path a real caller takes, and asserted on
    /// the RUNNER being untouched, because a refusal that still spawned the clear would already
    /// have removed whatever the folder carried.
    #[test]
    fn an_acl_may_not_be_applied_to_the_agents_own_tree() {
        let h = Harness::with_share("alice");
        let runner = MockCommandRunner::with_responses(acl_replies());
        let sink = MemorySink::default();
        let applier =
            acl::Applier::new(&runner, h.root.path().to_path_buf()).with_probe(acl_present);

        for path in [
            &[".depsis"][..],
            &[".depsis", "staging"][..],
            &[".depsis", "staging", "deeper"][..],
        ] {
            let response = h
                .agent(&runner, &sink)
                .apply_folder_acl_with(&applier, "alice", path, &[grant(301200, true, true, true)])
                .expect("a refusal, not a fault");
            match response {
                Response::Refused { ref reason } => assert!(
                    reason.contains(".depsis"),
                    "the refusal must name the tree: {reason}"
                ),
                other => panic!("{path:?} must be refused, got {other:?}"),
            }
        }

        assert!(
            runner.calls.borrow().is_empty(),
            "nothing may be spawned: the first thing an application does is `setfacl -b`, so a              refusal that ran anyway would already have cleared the folder"
        );
    }

    #[test]
    fn an_empty_path_grants_on_the_share_root() {
        // The ordinary case for a share-wide grant, and the one an off-by-one in the path join
        // would break by aiming at the tree above the share.
        let h = Harness::with_share("alice");
        let runner = MockCommandRunner::with_responses(acl_replies());
        let sink = MemorySink::default();
        let applier =
            acl::Applier::new(&runner, h.root.path().to_path_buf()).with_probe(acl_present);

        h.agent(&runner, &sink)
            .apply_folder_acl_with(&applier, "alice", &[], &[grant(301200, true, true, true)])
            .expect("apply");

        let target = h
            .share_path(&["alice"])
            .to_str()
            .expect("utf-8 tempdir")
            .to_string();
        assert_eq!(
            runner.call(1),
            Some(vec![
                acl::SETFACL.to_string(),
                "-b".to_string(),
                "--".to_string(),
                target
            ])
        );
    }

    #[test]
    fn a_box_without_setfacl_answers_unavailable_and_spawns_nothing() {
        // 503 and a card naming the package, not a 500. DEPSIS does not ship `acl`, so its absence
        // is an ordinary state of a machine — reporting it as a fault sends an operator hunting a
        // broken agent instead of running `apt install acl`.
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "faturalar"])).expect("mkdir");

        let runner = MockCommandRunner::default();
        let sink = MemorySink::default();
        let applier =
            acl::Applier::new(&runner, h.root.path().to_path_buf()).with_probe(acl_absent);

        match h.agent(&runner, &sink).apply_folder_acl_with(
            &applier,
            "alice",
            &["faturalar"],
            &[grant(301200, true, true, true)],
        ) {
            Ok(Response::AclUnavailable { reason }) => assert!(
                reason.contains("setfacl"),
                "the message must name the missing program: {reason}"
            ),
            other => panic!("expected acl_unavailable, got {other:?}"),
        }
        assert!(
            runner.calls.borrow().is_empty(),
            "nothing may be spawned once the tools are known to be absent"
        );
    }

    #[test]
    fn a_system_or_root_gid_never_reaches_the_acl_arm() {
        // Root bypasses every ACL, so an entry for gid 0 grants nothing and reads as a grant; an
        // entry for gid 27 (`sudo`) or 42 (`shadow`) grants a great deal and reads the same way.
        // The agent used to refuse only 0, by comparison, and let every other system group through
        // — the reserved range migration 0015 introduced for exactly this was enforced nowhere on
        // the privileged side.
        //
        // Now the refusal is at PARSE time, which is strictly earlier than the check it replaces:
        // before authorization, before the environment is read, and before `setfacl -b` could
        // clear the permissions the folder already carries. That last point is what the second
        // assertion pins — a request the agent cannot write correctly must not destroy what is
        // there.
        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "faturalar"])).expect("mkdir");

        for gid in [0, 27, 42, 33, 1200, 65534, 400_000] {
            let raw = format!(
                r#"{{"op":"apply_folder_acl","share":"alice","path":["faturalar"],"entries":[{{"gid":{gid},"read":true,"write":true,"execute":true}}]}}"#
            );
            match call(&h, &raw) {
                Response::Refused { reason } => assert!(
                    reason.contains("unparseable"),
                    "gid {gid} must be refused at the boundary: {reason}"
                ),
                other => panic!("gid {gid} must not be applied; got {other:?}"),
            }
        }
    }

    #[test]
    fn a_dataset_with_no_working_acl_layer_is_a_fault_and_not_a_missing_package() {
        // ADR-0004's measurement, turned into an answer: `acltype=nfsv4` sets cleanly, reads back
        // as configured and enforces nothing. `setfacl` says `Operation not supported` and that is
        // the ONE thing an operator needs told — so it must not arrive as `acl_unavailable`, which
        // would send them to `apt`, nor as a bare refusal, which nobody pages on.
        struct Enotsup;
        impl CommandRunner for Enotsup {
            fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
                if program == acl::GETFACL {
                    return Ok(PLAIN_ACL.to_string());
                }
                Err(SeamError::Command {
                    program: program.to_string(),
                    status: 1,
                    stderr: format!(
                        "setfacl: {}: Operation not supported",
                        args.last().copied().unwrap_or_default()
                    ),
                })
            }
        }

        let h = Harness::with_share("alice");
        std::fs::create_dir(h.share_path(&["alice", "faturalar"])).expect("mkdir");

        let runner = Enotsup;
        let sink = MemorySink::default();
        let applier =
            acl::Applier::new(&runner, h.root.path().to_path_buf()).with_probe(acl_present);

        let err = h
            .agent(&runner, &sink)
            .apply_folder_acl_with(
                &applier,
                "alice",
                &["faturalar"],
                &[grant(301200, true, true, true)],
            )
            .expect_err("a dataset with no ACL layer is a fault the agent must report as one");
        let message = err.to_string();
        assert!(
            message.contains("acltype=posixacl"),
            "the message must send the operator to `zfs get acltype`: {message}"
        );
    }

    #[test]
    fn an_apply_folder_acl_request_reaches_the_arm() {
        // The wiring, end to end through `handle`: the JSON parses into the new variant, the policy
        // allows it, and the arm runs far enough to consult the environment. With the share root
        // unset — the state of a NAS before storage is configured — the honest answer is a refusal
        // that names the variable, not a fault.
        //
        // Nothing beyond this point can be asserted through `handle` portably: the applier probes
        // the real filesystem for `setfacl`, so the answer would differ between a developer box and
        // the Debian VM. That is what `apply_folder_acl_with` above is for.
        let h = Harness::with_share("alice");
        let raw = r#"{"op":"apply_folder_acl","share":"alice","path":["faturalar"],"entries":[{"gid":301200,"read":true,"write":false,"execute":true}]}"#;

        without_shares_root(|| match call(&h, raw) {
            Response::Refused { reason } => assert!(
                reason.contains(acl::SHARES_ROOT_ENV),
                "the refusal must name the variable an operator has to set: {reason}"
            ),
            other => panic!("expected a refusal naming the share root, got {other:?}"),
        });
    }

    #[test]
    fn a_traversing_or_user_named_grant_never_reaches_setfacl() {
        // The dispatcher half of the type test in `op.rs`. `..` has no inhabitant of
        // `SafeComponent` and `AclEntry` has no `uid`, so both refusals are at parse time — before
        // authorization, before the environment is read, and before anything is spawned.
        let h = Harness::with_share("alice");
        for raw in [
            r#"{"op":"apply_folder_acl","share":"alice","path":["..","..","srv"],"entries":[]}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[{"uid":1001,"read":true,"write":true,"execute":true}]}"#,
        ] {
            match call(&h, raw) {
                Response::Refused { reason } => {
                    assert!(reason.contains("unparseable"), "{reason}");
                }
                other => panic!("expected a parse refusal, got {other:?}"),
            }
        }
    }

    /// Run `f` with `DEPSIS_SHARES_ROOT` pointing at `root`, then restore it.
    ///
    /// The operations that read the environment rather than taking a path — `share_root_status`
    /// and `prepare_share_root` — cannot be driven through `handle` any other way, and that is the
    /// property being tested as much as the answers: a caller cannot name the directory.
    fn with_shares_root(root: &std::path::Path, f: impl FnOnce()) {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let saved = std::env::var(acl::SHARES_ROOT_ENV).ok();
        std::env::set_var(acl::SHARES_ROOT_ENV, root);
        f();
        match saved {
            Some(value) => std::env::set_var(acl::SHARES_ROOT_ENV, value),
            None => std::env::remove_var(acl::SHARES_ROOT_ENV),
        }
    }

    /// `std::env::set_var` is process-global and Rust runs tests in threads. Shared by both
    /// helpers below, so one cannot run while the other is halfway through restoring.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Run `f` with `DEPSIS_SHARES_ROOT` unset, then restore it.
    ///
    /// `std::env::set_var` is process-global and Rust runs tests in threads, so the mutex is not
    /// optional. The same shape as `unix.rs`'s `temp_env`, and here rather than shared because the
    /// two test modules are in different files and a helper that crossed them would have to be
    /// public in a crate whose whole point is a small surface.
    fn without_shares_root(f: impl FnOnce()) {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let saved = std::env::var(acl::SHARES_ROOT_ENV).ok();
        std::env::remove_var(acl::SHARES_ROOT_ENV);
        f();
        match saved {
            Some(value) => std::env::set_var(acl::SHARES_ROOT_ENV, value),
            None => std::env::remove_var(acl::SHARES_ROOT_ENV),
        }
    }
}
