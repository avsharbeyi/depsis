//! Unix accounts and groups for DEPSIS principals — the last link between §6.2 and SMB.
//!
//! WHAT THIS CLOSES. `folder_grants` says who may reach a folder; `ApplyFolderAcl` writes that onto
//! the filesystem as POSIX ACL entries naming numeric gids; `SecureShareRoot` closes the top of the
//! share so nothing but those entries gets in. `tools/poc/p2-a-smb-identity.sh` measured that the
//! chain genuinely gates a real smbd session — and that it gates EVERYONE, because the numbers the
//! entries name belong to no account. Nothing in the product had ever created one.
//!
//! So this module makes the numbers real: a Unix group per team at its `posix_gid`, an account per
//! user at their `posix_uid`, membership matching `team_members`, and a Samba passdb entry so the
//! user can authenticate as themselves.
//!
//! ── WHAT THE AGENT REFUSES TO TRUST ──
//!
//! Creating system accounts is the most privileged thing in the operation set, so the operands are
//! narrowed until the dangerous shapes are unrepresentable rather than checked:
//!
//!   * Every id is a `PosixId`, which cannot hold 0 and cannot leave 300000-399999. The agent
//!     cannot be asked to touch root, `www-data`, `sudo` or `shadow`.
//!   * Group names are DERIVED from the gid, never supplied. Nobody types a group name, so there
//!     is no reason to accept one — and a derived name cannot collide with a system group, which
//!     is what stops `gpasswd -M` from being pointed at `sudo`.
//!   * A login name IS supplied, because the alternative is telling a person to type
//!     `depsis-u-300001` into Windows. It is validated to the same shape the database enforces,
//!     and then checked against the machine: if the name already belongs to an account OUTSIDE the
//!     reserved range, the whole operation is refused. That is the one check that cannot be a type,
//!     because it is a question about the box rather than about the value.
//!
//! ── PASSWORDS ──
//!
//! Only an NT hash arrives here, never a password. `tools/poc/p2-b-smb-password.sh` measured the
//! three things that makes possible: `MD4(UTF-16LE(pw))` is exactly what Samba stores, a
//! precomputed hash installs through `pdbedit -i smbpasswd:...`, and an account created that way
//! authenticates. Two details from that measurement are load-bearing here and are marked at their
//! call sites: the `LCT` field must be a real timestamp (a zero installs the hash and lets nobody
//! in, silently), and re-importing keeps the SID (so a password change does not turn the user into
//! a different person as far as a Windows client is concerned).
//!
//! `smbpasswd` is not used at all, and could not be: it reads the password from stdin and
//! `CommandRunner` has no stdin.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::op::{NtHash, PosixId, PosixName};
use crate::seams::CommandRunner;

/// Absolute, for the reason every other binary path in this crate is: `execvp` falls back to
/// searching `/bin:/usr/bin` when `PATH` is unset, so a bare program name is a supply-chain
/// question.
pub const GETENT: &str = "/usr/bin/getent";
pub const GROUPADD: &str = "/usr/sbin/groupadd";
pub const USERADD: &str = "/usr/sbin/useradd";
pub const GPASSWD: &str = "/usr/bin/gpasswd";
pub const PDBEDIT: &str = "/usr/bin/pdbedit";

/// Where the passdb import is staged.
///
/// It holds NT hashes, which are password-equivalent for one protocol, so it is written 0600 and
/// unlinked immediately. `/run` rather than `/tmp`: it is a tmpfs that does not survive a reboot,
/// and nothing else on the box has a reason to walk it.
const IMPORT_PATH: &str = "/run/depsis/passdb-import";

/// The shell an account gets. A DEPSIS principal is a file-sharing identity and nothing else; a
/// login shell would make every user of the NAS a user of the machine.
const NOLOGIN: &str = "/usr/sbin/nologin";

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("{0}")]
    Io(String),

    /// The login already belongs to somebody the appliance did not create.
    ///
    /// The one refusal that cannot be a type: whether `postgres` or `root` is taken is a fact about
    /// the machine, not about the string. Refusing the WHOLE operation rather than skipping the one
    /// user is deliberate — a partially applied identity sync leaves some grants enforceable and
    /// others not, with nothing recording which.
    #[error(
        "the account '{login}' already exists with uid {found}, which is outside the reserved \
         range; DEPSIS will not take over an account it did not create"
    )]
    NotOurs { login: String, found: u32 },

    /// The uid is taken by a different name.
    #[error("uid {uid} already belongs to '{found}', not to '{login}'")]
    UidTaken {
        uid: u32,
        login: String,
        found: String,
    },

    #[error("samba is not installed: {0} is not present")]
    SambaMissing(String),
}

impl IdentityError {
    /// Absent tooling is an ordinary state of a box, not a fault — the same split `samba.rs` draws.
    pub fn is_unavailable(&self) -> bool {
        matches!(self, IdentityError::SambaMissing(_))
    }
}

/// One account the appliance must have.
#[derive(Debug, Clone)]
pub struct UserSpec {
    pub uid: PosixId,
    pub login: PosixName,
    /// `None` leaves whatever password the account already had. A user who has not set one since
    /// this feature existed has no passdb entry, and that is the honest state: they cannot reach
    /// SMB until they next change their password.
    pub nt_hash: Option<NtHash>,
}

/// One group, with the membership it must end up with.
#[derive(Debug, Clone)]
pub struct GroupSpec {
    pub gid: PosixId,
    /// The uids that belong to it. EXACT — `gpasswd -M` replaces the whole list, which is what
    /// makes this idempotent and what makes a removed member actually leave.
    pub members: Vec<PosixId>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub users_created: usize,
    pub groups_created: usize,
    pub passwords_set: usize,
}

/// The group a team's ACL entries name. Derived, never supplied — see the module note.
pub fn team_group_name(gid: PosixId) -> String {
    format!("depsis-t-{}", gid.get())
}

/// A user's private primary group.
///
/// At the same number as their uid, which is not a coincidence: `create_dir` passes the owner's uid
/// as BOTH uid and gid, so a user's own group has to be theirs alone. One device-wide counter issues
/// both, so the number cannot already belong to a team.
pub fn private_group_name(uid: PosixId) -> String {
    format!("depsis-p-{}", uid.get())
}

/// Make the machine match the request, or change nothing that matters.
///
/// ORDER. Groups for users first (an account needs its primary group to exist), then accounts, then
/// team groups and their membership — `gpasswd -M` refuses a member that does not exist, measured,
/// so every account has to be there before any list is set. Passwords last, in ONE import: the
/// passdb is a database and rewriting it once per user would be a write amplification for no gain.
pub fn sync<R: CommandRunner>(
    runner: &R,
    users: &[UserSpec],
    groups: &[GroupSpec],
) -> Result<SyncOutcome, IdentityError> {
    let mut outcome = SyncOutcome::default();

    // EVERY name is checked against the machine BEFORE anything is created. A refusal halfway
    // through would leave some accounts made and some not, and the caller has no way to find out
    // which — so the expensive check happens first and the whole operation is atomic in the only
    // sense that matters here.
    for user in users {
        if let Some(found) = uid_of(runner, user.login.as_str()) {
            if found != user.uid.get() {
                if !is_reserved(found) {
                    return Err(IdentityError::NotOurs {
                        login: user.login.as_str().to_string(),
                        found,
                    });
                }
                // Ours, but at a different number. That is a uid the appliance issued and then
                // reissued, which should be impossible — refusing beats silently renumbering an
                // account whose files are already owned by the old uid.
                return Err(IdentityError::UidTaken {
                    uid: user.uid.get(),
                    login: user.login.as_str().to_string(),
                    found: format!("uid {found}"),
                });
            }
        }
        if let Some(existing) = login_of(runner, user.uid.get()) {
            if existing != user.login.as_str() {
                return Err(IdentityError::UidTaken {
                    uid: user.uid.get(),
                    login: user.login.as_str().to_string(),
                    found: existing,
                });
            }
        }
    }

    for user in users {
        let group = private_group_name(user.uid);
        if ensure_group(runner, user.uid.get(), &group)? {
            outcome.groups_created += 1;
        }
        if ensure_user(runner, user.uid.get(), user.login.as_str(), &group)? {
            outcome.users_created += 1;
        }
    }

    for group in groups {
        let name = team_group_name(group.gid);
        if ensure_group(runner, group.gid.get(), &name)? {
            outcome.groups_created += 1;
        }

        // The members, by LOGIN, because `gpasswd` takes names. A member whose account is not in
        // this request is dropped from the list rather than guessed at: the caller sends the whole
        // desired state, so a uid it did not describe is a uid it does not want in the group.
        let logins: Vec<&str> = group
            .members
            .iter()
            .filter_map(|uid| {
                users
                    .iter()
                    .find(|u| u.uid.get() == uid.get())
                    .map(|u| u.login.as_str())
            })
            .collect();
        set_members(runner, &name, &logins)?;
    }

    outcome.passwords_set = set_passwords(runner, users)?;
    Ok(outcome)
}

fn is_reserved(id: u32) -> bool {
    (PosixId::MIN..=PosixId::MAX).contains(&id)
}

/// The uid `getent passwd <name>` reports, or None.
///
/// Presence is decided by the OUTPUT rather than the exit status, and the difference matters in
/// both directions. `getent` exits 2 for "not found", which the runner turns into an error — but
/// an error is also what a broken nsswitch produces, and reading that as "the account does not
/// exist" would send the agent off to create one. An empty answer means the same thing in either
/// case, and the create that follows fails loudly if the truth was something else.
fn uid_of<R: CommandRunner>(runner: &R, login: &str) -> Option<u32> {
    let out = runner.run(GETENT, &["passwd", login]).unwrap_or_default();
    out.lines().next()?.split(':').nth(2)?.trim().parse().ok()
}

/// The name `getent passwd <uid>` reports, or None.
fn login_of<R: CommandRunner>(runner: &R, uid: u32) -> Option<String> {
    let uid = uid.to_string();
    let out = runner.run(GETENT, &["passwd", &uid]).unwrap_or_default();
    let name = out.lines().next()?.split(':').next()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

/// True when it had to be created.
fn ensure_group<R: CommandRunner>(runner: &R, gid: u32, name: &str) -> Result<bool, IdentityError> {
    let id = gid.to_string();
    if !runner
        .run(GETENT, &["group", &id])
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        return Ok(false);
    }
    runner
        .run(GROUPADD, &["-g", &id, "--", name])
        .map_err(|e| IdentityError::Io(format!("groupadd {name} ({gid}): {e}")))?;
    Ok(true)
}

fn ensure_user<R: CommandRunner>(
    runner: &R,
    uid: u32,
    login: &str,
    group: &str,
) -> Result<bool, IdentityError> {
    let id = uid.to_string();
    if !runner
        .run(GETENT, &["passwd", &id])
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        return Ok(false);
    }
    // `-M` no home directory and `-s nologin`: a DEPSIS principal is a file-sharing identity, not
    // a user of the machine. `--` before the name so a login that somehow began with a dash could
    // not become a flag — `PosixName` already refuses that, and this is the second door.
    runner
        .run(
            USERADD,
            &["-u", &id, "-g", group, "-M", "-s", NOLOGIN, "--", login],
        )
        .map_err(|e| IdentityError::Io(format!("useradd {login} ({uid}): {e}")))?;
    Ok(true)
}

/// Replace a group's membership with exactly this list.
///
/// `-M` and not `-a`, because the caller sends desired state: adding is not enough, a member who
/// left the team has to actually leave the group or their ACL access outlives the grant. Measured:
/// `-M` replaces the list wholesale and `-M ''` empties it.
fn set_members<R: CommandRunner>(
    runner: &R,
    group: &str,
    logins: &[&str],
) -> Result<(), IdentityError> {
    let list = logins.join(",");
    runner
        .run(GPASSWD, &["-M", &list, "--", group])
        .map_err(|e| IdentityError::Io(format!("gpasswd -M on {group}: {e}")))?;
    Ok(())
}

/// Install every NT hash in one import.
///
/// Returns how many were set. Zero is an ordinary answer: a user who has not changed their password
/// since this existed has no hash to install, and an account with no passdb entry simply cannot
/// reach SMB yet.
fn set_passwords<R: CommandRunner>(runner: &R, users: &[UserSpec]) -> Result<usize, IdentityError> {
    let with_hash: Vec<&UserSpec> = users.iter().filter(|u| u.nt_hash.is_some()).collect();
    if with_hash.is_empty() {
        return Ok(0);
    }
    if !Path::new(PDBEDIT).exists() {
        return Err(IdentityError::SambaMissing(PDBEDIT.to_string()));
    }

    // The `smbpasswd` text format: `login:uid:LM:NT:flags:LCT:`.
    //
    // `NO PASSWORD...` in the LM field says there is no LM hash, which is what a modern deployment
    // wants — LM is broken and Samba refuses it by default anyway.
    //
    // THE LCT FIELD IS NOT DECORATION. `LCT-00000000` installs the hash, `pdbedit -Lw` reads it
    // back correctly, and NOBODY CAN LOG IN — silently. Measured both ways in
    // `tools/poc/p2-b-smb-password.sh`; a real timestamp is the difference between an import that
    // works and one that looks like it did.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut body = String::new();
    for user in &with_hash {
        let hash = user
            .nt_hash
            .as_ref()
            .map(NtHash::as_str)
            .unwrap_or_default();
        body.push_str(&format!(
            "{}:{}:{}:{}:[U          ]:LCT-{:X}:\n",
            user.login.as_str(),
            user.uid.get(),
            "NO PASSWORDXXXXXXXXXXXXXXXXXXXXX",
            hash,
            now
        ));
    }

    let path = PathBuf::from(IMPORT_PATH);
    write_private(&path, &body)?;
    let spec = format!("smbpasswd:{}", path.display());
    let result = runner.run(PDBEDIT, &["-i", &spec, "-e", "tdbsam"]);
    // Removed whatever happened. The file holds password-equivalent material and there is no
    // outcome in which leaving it behind is better than losing the ability to debug from it.
    let _ = std::fs::remove_file(&path);
    result.map_err(|e| IdentityError::Io(format!("pdbedit import: {e}")))?;

    Ok(with_hash.len())
}

/// Write 0600, creating the parent if it is missing.
///
/// Mode BEFORE content: creating the file world-readable and chmodding afterwards leaves a window
/// in which the hashes are readable, and a window is all an attacker on the box needs.
fn write_private(path: &Path, body: &str) -> Result<(), IdentityError> {
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| IdentityError::Io(format!("{}: {e}", parent.display())))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| IdentityError::Io(format!("{}: {e}", path.display())))?;
    file.write_all(body.as_bytes())
        .map_err(|e| IdentityError::Io(format!("{}: {e}", path.display())))?;
    Ok(())
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
    use crate::seams::SeamError;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A runner that answers by PROGRAM AND FIRST ARGUMENTS rather than by call order.
    ///
    /// `MockCommandRunner` answers a queue, which makes an assertion about `getent` depend on how
    /// many times something else was called first — so a test would break for reasons that have
    /// nothing to do with what it measures. This one is keyed, and it records argv the same way.
    struct Scripted {
        answers: HashMap<String, String>,
        calls: RefCell<Vec<Vec<String>>>,
    }

    impl Scripted {
        fn new(answers: &[(&str, &str)]) -> Self {
            Self {
                answers: answers
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                    .collect(),
                calls: RefCell::new(Vec::new()),
            }
        }

        fn argv(&self) -> Vec<Vec<String>> {
            self.calls.borrow().clone()
        }

        fn ran(&self, program: &str) -> Vec<Vec<String>> {
            self.argv()
                .into_iter()
                .filter(|c| c.first().map(String::as_str) == Some(program))
                .collect()
        }
    }

    impl CommandRunner for Scripted {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, SeamError> {
            let mut argv = vec![program.to_string()];
            argv.extend(args.iter().map(|a| (*a).to_string()));
            self.calls.borrow_mut().push(argv.clone());
            let key = argv.join(" ");
            Ok(self.answers.get(&key).cloned().unwrap_or_default())
        }
    }

    fn uid(n: u32) -> PosixId {
        PosixId::parse(n).expect("reserved range")
    }

    fn user(n: u32, login: &str) -> UserSpec {
        UserSpec {
            uid: uid(n),
            login: PosixName::parse(login).expect("valid login"),
            nt_hash: None,
        }
    }

    #[test]
    fn a_login_that_belongs_to_a_system_account_refuses_the_whole_sync() {
        // THE CHECK THAT CANNOT BE A TYPE. `root` and `postgres` both match `PosixName`, because
        // the shape of a string says nothing about who already owns it on this machine. Refusing
        // the WHOLE operation rather than skipping the one user is deliberate: a half-applied
        // identity sync leaves some grants enforceable and others not, with nothing recording
        // which.
        let runner = Scripted::new(&[(
            "/usr/bin/getent passwd postgres",
            "postgres:x:114:120::/var/lib/postgresql:/bin/bash",
        )]);
        let err = sync(&runner, &[user(300001, "postgres")], &[]).expect_err("must refuse");
        assert!(
            matches!(err, IdentityError::NotOurs { found: 114, .. }),
            "{err:?}"
        );

        // And nothing was created. The check runs before the first `useradd` precisely so that a
        // refusal costs nothing.
        assert!(runner.ran(USERADD).is_empty(), "{:?}", runner.argv());
        assert!(runner.ran(GROUPADD).is_empty());
    }

    #[test]
    fn a_uid_already_held_by_a_different_login_refuses() {
        // The appliance issues uids from one monotonic counter, so this should be impossible —
        // which is exactly why it must not be papered over. Renumbering an account whose files are
        // already owned by the old uid would orphan every one of them.
        let runner = Scripted::new(&[(
            "/usr/bin/getent passwd 300001",
            "baskabiri:x:300001:300001::/nonexistent:/usr/sbin/nologin",
        )]);
        let err = sync(&runner, &[user(300001, "ali")], &[]).expect_err("must refuse");
        assert!(matches!(err, IdentityError::UidTaken { .. }), "{err:?}");
        assert!(runner.ran(USERADD).is_empty());
    }

    #[test]
    fn a_new_user_gets_a_private_group_a_nologin_shell_and_no_home() {
        let runner = Scripted::new(&[]);
        let outcome = sync(&runner, &[user(300001, "ali")], &[]).expect("sync");
        assert_eq!(outcome.users_created, 1);
        assert_eq!(outcome.groups_created, 1);

        let groupadd = runner.ran(GROUPADD);
        assert_eq!(groupadd.len(), 1, "{groupadd:?}");
        assert_eq!(
            groupadd[0],
            vec![
                "/usr/sbin/groupadd",
                "-g",
                "300001",
                "--",
                "depsis-p-300001"
            ]
        );

        let useradd = runner.ran(USERADD);
        assert_eq!(
            useradd[0],
            vec![
                "/usr/sbin/useradd",
                "-u",
                "300001",
                "-g",
                "depsis-p-300001",
                "-M",
                "-s",
                "/usr/sbin/nologin",
                "--",
                "ali"
            ],
            "a DEPSIS principal is a file-sharing identity, not a user of the machine"
        );
    }

    #[test]
    fn an_account_that_already_exists_is_left_alone() {
        // Idempotence is not a nicety here: the API re-syncs on every membership change, so a
        // second run has to be a no-op rather than a pile of failed `useradd` calls.
        let runner = Scripted::new(&[
            (
                "/usr/bin/getent passwd 300001",
                "ali:x:300001:300001::/nonexistent:/usr/sbin/nologin",
            ),
            (
                "/usr/bin/getent passwd ali",
                "ali:x:300001:300001::/nonexistent:/usr/sbin/nologin",
            ),
            ("/usr/bin/getent group 300001", "depsis-p-300001:x:300001:"),
        ]);
        let outcome = sync(&runner, &[user(300001, "ali")], &[]).expect("sync");
        assert_eq!(outcome, SyncOutcome::default());
        assert!(runner.ran(USERADD).is_empty());
        assert!(runner.ran(GROUPADD).is_empty());
    }

    #[test]
    fn a_team_group_is_named_from_its_gid_and_never_from_the_request() {
        // What stops `gpasswd -M` being pointed at `sudo`. Nobody types a group name, so there is
        // no reason to accept one — and a derived name cannot collide with a system group.
        let runner = Scripted::new(&[]);
        sync(
            &runner,
            &[user(300001, "ali"), user(300002, "veli")],
            &[GroupSpec {
                gid: uid(300010),
                members: vec![uid(300001), uid(300002)],
            }],
        )
        .expect("sync");

        let gpasswd = runner.ran(GPASSWD);
        assert_eq!(
            gpasswd[0],
            vec![
                "/usr/bin/gpasswd",
                "-M",
                "ali,veli",
                "--",
                "depsis-t-300010"
            ]
        );
    }

    #[test]
    fn membership_is_replaced_and_not_added_to() {
        // `-M`, never `-a`. A member who left the team has to actually leave the Unix group, or
        // their ACL access outlives the grant that justified it — which is the divergence the
        // whole permission model exists to prevent.
        let runner = Scripted::new(&[]);
        sync(
            &runner,
            &[user(300001, "ali")],
            &[GroupSpec {
                gid: uid(300010),
                members: vec![uid(300001)],
            }],
        )
        .expect("sync");
        let gpasswd = runner.ran(GPASSWD);
        assert!(gpasswd[0].contains(&"-M".to_string()));
        assert!(!gpasswd[0].contains(&"-a".to_string()));
    }

    #[test]
    fn a_group_whose_only_member_left_is_emptied_rather_than_left_alone() {
        let runner = Scripted::new(&[]);
        sync(
            &runner,
            &[user(300001, "ali")],
            &[GroupSpec {
                gid: uid(300010),
                members: vec![],
            }],
        )
        .expect("sync");
        let gpasswd = runner.ran(GPASSWD);
        assert_eq!(
            gpasswd[0],
            vec!["/usr/bin/gpasswd", "-M", "", "--", "depsis-t-300010"],
            "an empty list is how the group is emptied; skipping the call would leave the old one"
        );
    }

    #[test]
    fn a_member_the_request_does_not_describe_is_dropped_rather_than_guessed_at() {
        // The caller sends the whole desired state, so a uid it did not describe is a uid it does
        // not want in the group. Inventing a login for it would be the agent deciding something
        // only the API knows.
        let runner = Scripted::new(&[]);
        sync(
            &runner,
            &[user(300001, "ali")],
            &[GroupSpec {
                gid: uid(300010),
                members: vec![uid(300001), uid(300099)],
            }],
        )
        .expect("sync");
        assert_eq!(runner.ran(GPASSWD)[0][2], "ali");
    }

    #[test]
    fn no_password_means_no_import_at_all() {
        // Zero is an ordinary answer, not a failure: a user who has not changed their password
        // since this existed has no hash to install. Running `pdbedit` with an empty file would
        // need Samba installed for no reason.
        let runner = Scripted::new(&[]);
        let outcome = sync(&runner, &[user(300001, "ali")], &[]).expect("sync");
        assert_eq!(outcome.passwords_set, 0);
        assert!(runner.ran(PDBEDIT).is_empty());
    }
}
