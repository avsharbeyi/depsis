//! Samba: generate the share configuration, write it atomically, and prove smbd still works.
//!
//! A NAS exists to appear in Windows Explorer as a drive. Until this module runs, a share in the
//! database is a row and nothing else — which is precisely the gap `Share.published` in the HTTP
//! contract exists to expose, and the gap this module closes.
//!
//! Three properties are load-bearing here, in order of how expensive they are to get wrong:
//!
//!   1. **The main `smb.conf` is never rewritten.** DEPSIS owns ONE file (`depsis.conf` by
//!      default) and the operator's `smb.conf` includes it. Rewriting the operator's file would
//!      silently delete settings DEPSIS knows nothing about — a domain join, a printer, an
//!      `interfaces` line that is the only reason the box is reachable. The installation
//!      requirement is therefore one line in `smb.conf`:
//!      `include = /etc/samba/depsis.conf`.
//!
//!      Its absence is not silent: the live check below asks smbd which shares it actually
//!      offers, so a missing `include` fails the publish with a reason that names it.
//!
//!   2. **The write is atomic and reversible.** A half-written `smb.conf` fragment is not a
//!      degraded share list, it is smbd refusing every connection — so the new text lands by
//!      `rename(2)` over the old one, after `fsync`, with the previous version kept beside it.
//!      Any rejection renames the previous version back.
//!
//!   3. **`testparm` is necessary and NOT sufficient.** P0-B measured an invalid
//!      `full_audit:success` opname passing `testparm -s` cleanly and then making smbd refuse
//!      every connection. Validation is therefore followed by a live connection attempt, and the
//!      publish is only reported as `verified` when a real client saw the real shares.
//!
//! What this module deliberately does NOT express: per-user access control. Every generated
//! section inherits whatever authentication the operator configured globally, because `ShareSpec`
//! carries no user list. §20's access control lives in the database and at the HTTP layer; SMB
//! sees only "this share exists, read-only or not".

use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::dispatch::bin::{TESTPARM, ZFS};
use crate::op::{ShareSpec, SmbPrincipal};
use crate::seams::CommandRunner;

/// The live half of the gate. `testparm` lives in `dispatch::bin` with the other binaries; this
/// one belongs to the only module that runs it.
///
/// Absolute, for the reason `dispatch::bin` gives: `execvp` falls back to searching
/// `/bin:/usr/bin` when `PATH` is unset, so a bare program name is a supply-chain question.
pub const SMBCLIENT: &str = "/usr/bin/smbclient";

/// The file DEPSIS owns. NOT `smb.conf` — see the module note.
pub const DEFAULT_CONFIG_PATH: &str = "/etc/samba/depsis.conf";

/// Overrides `DEFAULT_CONFIG_PATH`.
///
/// The environment, never the request. The agent's environment comes from systemd's
/// `EnvironmentFile`, so this is operator configuration on the same footing as
/// `DEPSIS_SHARES_ROOT`; the request enum has no operand for a path and must never gain one,
/// because "which file does the privileged daemon overwrite" is not a question an unprivileged
/// caller may answer.
pub const CONFIG_PATH_ENV: &str = "DEPSIS_SAMBA_CONFIG";

/// Longest share name Samba will serve. Names are already `SafeComponent` (≤255), so this is the
/// tighter of the two limits and the one that matters.
const MAX_SHARE_NAME: usize = 80;

/// Section names that would take over the operator's own configuration rather than add to it.
/// `[global]` is the dangerous one: a share called `global` would rewrite every global setting
/// in the included file's scope.
const RESERVED_SECTIONS: [&str; 4] = ["global", "homes", "printers", "print$"];

#[derive(Debug, thiserror::Error)]
pub enum SambaError {
    /// Samba is not installed on this box. NOT a fault of the agent.
    ///
    /// The device SHIPS with Samba — the installer and the ISO's firstboot both install it, the
    /// same reversal ZeroTier went through when ADR-0020's "we don't package it" met the first
    /// real owner. So "absent" is no longer an ordinary state; it is a broken installation. It is
    /// still its own variant, because the API's 503 with "install the samba package" sends
    /// whoever reads it to the actual repair instead of to a healthy agent's logs.
    #[error("samba is not installed: {0} is not present")]
    NotInstalled(String),

    /// A share could not be expressed in `smb.conf` at all, so nothing was written.
    ///
    /// Reached before the first byte hits the disk: a name or a mount point that cannot be
    /// rendered safely must not get as far as a file the daemon reads.
    #[error("{0}")]
    Unrepresentable(String),

    /// The new configuration was rejected and THE PREVIOUS ONE IS BACK. Shares keep working.
    #[error("samba rejected the new configuration and it was rolled back: {0}")]
    RejectedRolledBack(String),

    /// The new configuration was rejected AND the rollback failed.
    ///
    /// Its own variant because it is the only outcome here that leaves the box worse than it was
    /// found, and the one thing that must never be reported as an ordinary refusal. Whoever reads
    /// this has to go and look at the file by hand.
    #[error(
        "SAMBA IS BROKEN AND COULD NOT BE RESTORED. {path} now holds a configuration that was \
         rejected ({rejection}), and putting the previous one back also failed ({restore_failure}). \
         SMB shares are down until an operator repairs this file by hand"
    )]
    RollbackFailed {
        path: String,
        rejection: String,
        restore_failure: String,
    },

    #[error("io: {0}")]
    Io(String),
}

impl SambaError {
    /// Is this "Samba is not here" rather than "Samba said no"?
    ///
    /// The same split ADR-0020 draws for ZeroTier, and for the same reason: a component the
    /// product does not ship being absent is a configuration state with a card in the UI, while a
    /// component that is present and refusing is a fault someone must read.
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::NotInstalled(_))
    }
}

/// What a publish accomplished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublishOutcome {
    pub shares: usize,
    /// A real client connected and saw every share. Only ever `true` — a publish that could not
    /// prove this rolls back and returns an error instead, because a `verified: false` success
    /// would be the product claiming a share works while nobody checked.
    pub verified: bool,
}

/// Where the generated file goes.
pub fn config_path() -> PathBuf {
    match std::env::var(CONFIG_PATH_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(DEFAULT_CONFIG_PATH),
    }
}

/// One share, already checked and ready to render.
///
/// Separate from `ShareSpec` because the two carry different things: a `ShareSpec` names a
/// dataset, and a section needs the directory that dataset is mounted at — which only ZFS can
/// answer, and which is the one field here that did not come from a validated type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub name: String,
    pub path: String,
    pub read_only: bool,
    /// Already rendered — `ayse`, `@depsis-t-300010` — because `SmbPrincipal::render` is the one
    /// place that knows Samba's sigil, and a second spelling of it here is a second thing to get
    /// wrong.
    pub valid_users: Vec<String>,
}

/// The things this module needs from the machine it runs on.
///
/// A trait for the same reason the four seams in `seams` are traits: every method below either
/// runs a program or depends on a daemon being up, and the interesting tests here are the ones
/// where those say NO. `MockCommandRunner` cannot fail, so a fake host is the only way to reach
/// the rollback path at all — and the rollback path is the one that decides whether a bad
/// configuration takes the shares down.
pub trait SambaHost {
    /// Refuse early if Samba is not installed. Checked BEFORE anything is written, so an absent
    /// Samba never leaves a file behind.
    fn ensure_installed(&self) -> Result<(), SambaError>;

    /// Where a dataset is mounted, as ZFS reports it.
    fn mountpoint(&self, dataset: &str) -> Result<String, SambaError>;

    /// `testparm`: is the configuration syntactically acceptable?
    fn validate(&self) -> Result<(), SambaError>;

    /// The share names smbd is ACTUALLY offering, from a live connection.
    fn offered_shares(&self) -> Result<Vec<String>, SambaError>;
}

/// The real machine.
pub struct Host<'a, R: CommandRunner> {
    runner: &'a R,
}

impl<'a, R: CommandRunner> Host<'a, R> {
    pub fn new(runner: &'a R) -> Self {
        Self { runner }
    }
}

impl<R: CommandRunner> SambaHost for Host<'_, R> {
    fn ensure_installed(&self) -> Result<(), SambaError> {
        for program in [TESTPARM, SMBCLIENT] {
            if !Path::new(program).exists() {
                return Err(SambaError::NotInstalled(program.to_string()));
            }
        }
        Ok(())
    }

    fn mountpoint(&self, dataset: &str) -> Result<String, SambaError> {
        // -H -o value: one bare value, no header and no column padding to parse around.
        let out = self
            .runner
            .run(ZFS, &["get", "-H", "-o", "value", "mountpoint", dataset])
            .map_err(|e| SambaError::Io(format!("zfs get mountpoint {dataset}: {e}")))?;
        Ok(out.lines().next().unwrap_or_default().trim().to_string())
    }

    fn validate(&self) -> Result<(), SambaError> {
        // No file argument: this must check the configuration smbd will actually load, which is
        // the operator's smb.conf WITH our include in it, not our fragment in isolation.
        self.runner
            .run(TESTPARM, &["-s", "--suppress-prompt"])
            .map(|_| ())
            .map_err(|e| SambaError::RejectedRolledBack(format!("testparm: {e}")))
    }

    fn offered_shares(&self) -> Result<Vec<String>, SambaError> {
        // -g is the machine-readable form: `Disk|name|comment`, one per line. Parsing the human
        // table would make this break on a Samba release that changes its column widths.
        // -N because this asks the daemon what it serves, not for access to any of it.
        let out = self
            .runner
            .run(SMBCLIENT, &["-L", "localhost", "-N", "-g"])
            .map_err(|e| {
                SambaError::RejectedRolledBack(format!(
                    "smbd would not answer a local connection ({e}); \
                     if smbd is not running, start it and publish again"
                ))
            })?;

        let mut names = Vec::new();
        for line in out.lines() {
            let mut fields = line.split('|');
            let kind = fields.next().unwrap_or_default().trim();
            let name = fields.next().unwrap_or_default().trim();
            if kind.eq_ignore_ascii_case("disk") && !name.is_empty() {
                names.push(name.to_string());
            }
        }
        Ok(names)
    }
}

/// Turn the request's share list into sections, refusing anything that cannot be rendered.
///
/// The refusals here are NOT belt-and-braces over `SafeComponent`. `SafeComponent` rejects NUL,
/// path separators, `..` and a leading dash — it says nothing about newlines or `[`, so a share
/// named `"docs\n[global]\npath = /"` parses cleanly today and would append a section to the
/// operator's global scope. The type system does not close this; this function does.
pub fn plan<H: SambaHost>(shares: &[ShareSpec], host: &H) -> Result<Vec<Section>, SambaError> {
    let mut sections = Vec::with_capacity(shares.len());
    for spec in shares {
        let name = spec.name.as_str();
        check_share_name(name)?;
        let path = host.mountpoint(spec.dataset.as_str())?;
        check_mountpoint(spec.dataset.as_str(), &path)?;
        sections.push(Section {
            name: name.to_string(),
            path,
            read_only: spec.read_only,
            // No check here, on purpose. `SmbPrincipal` holds a `PosixName`, so a token that could
            // break out of its line cannot have been deserialised in the first place. The share
            // NAME is checked above because `SafeComponent` admits newlines; a principal is a
            // different type with a different guarantee.
            valid_users: spec.valid_users.iter().map(SmbPrincipal::render).collect(),
        });
    }
    Ok(sections)
}

fn check_share_name(name: &str) -> Result<(), SambaError> {
    let unrepresentable = |why: &str| {
        Err(SambaError::Unrepresentable(format!(
            "share name {name:?} cannot be written to smb.conf: {why}"
        )))
    };

    if name.is_empty() {
        return unrepresentable("it is empty");
    }
    if name.len() > MAX_SHARE_NAME {
        return unrepresentable("samba will not serve a name longer than 80 bytes");
    }
    if RESERVED_SECTIONS
        .iter()
        .any(|r| r.eq_ignore_ascii_case(name))
    {
        // A share called `global` does not add a share, it rewrites the operator's globals.
        return unrepresentable("it is a reserved smb.conf section name");
    }
    if name.starts_with(' ') || name.ends_with(' ') || name.starts_with('.') {
        return unrepresentable("leading or trailing space, or a leading dot");
    }
    if let Some(bad) = name
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' ')))
    {
        // This is where a newline, a `[`, a `%` substitution or a comment character stops.
        return unrepresentable(&format!("character {bad:?} is not allowed in a share name"));
    }
    Ok(())
}

fn check_mountpoint(dataset: &str, path: &str) -> Result<(), SambaError> {
    let unrepresentable = |why: &str| {
        Err(SambaError::Unrepresentable(format!(
            "dataset {dataset} cannot be shared: {why} (mountpoint {path:?})"
        )))
    };

    // The one value here that is not a validated type: it came out of `zfs get`. Everything below
    // treats it as untrusted text, because a mountpoint is settable by anyone who can run `zfs
    // set` on the box.
    match path {
        "" | "-" => return unrepresentable("it has no mountpoint"),
        "none" => return unrepresentable("its mountpoint is `none`"),
        "legacy" => {
            return unrepresentable("its mountpoint is `legacy`, so ZFS does not know where it is")
        }
        "/" => return unrepresentable("it is mounted at the filesystem root"),
        _ => {}
    }
    if !path.starts_with('/') {
        return unrepresentable("its mountpoint is not an absolute path");
    }
    if let Some(bad) = path.chars().find(|c| c.is_control()) {
        return unrepresentable(&format!("its mountpoint contains {bad:?}"));
    }
    if path.contains('%') {
        // smb.conf expands `%U`, `%m` and friends inside a value, so a mountpoint containing one
        // would make smbd serve a directory nobody chose.
        return unrepresentable("its mountpoint contains `%`, which smb.conf would expand");
    }
    Ok(())
}

/// Render the configuration file. Pure: no I/O, so the text can be asserted on directly.
pub fn render(sections: &[Section]) -> String {
    let mut out = String::new();
    out.push_str(
        "# Managed by DEPSIS. Generated file — every edit here is lost on the next publish.\n\
         #\n\
         # DEPSIS never writes smb.conf itself: that file is the operator's, and rewriting it\n\
         # would delete settings DEPSIS knows nothing about. For these shares to be served,\n\
         # smb.conf must contain one line:\n\
         #\n\
         #     include = /etc/samba/depsis.conf\n\
         #\n\
         # Without it smbd serves none of the sections below, and DEPSIS refuses the publish\n\
         # rather than reporting shares that do not exist.\n",
    );

    for section in sections {
        // `read only` rather than `writeable`: the two are inverses of each other and mixing them
        // in one file is how a share ends up writable because someone read the wrong key.
        let read_only = if section.read_only { "yes" } else { "no" };
        out.push('\n');
        out.push('[');
        out.push_str(&section.name);
        out.push_str("]\n");
        out.push_str("\tcomment = DEPSIS share\n");
        out.push_str(&format!("\tpath = {}\n", section.path));
        out.push_str("\tbrowseable = yes\n");
        out.push_str(&format!("\tread only = {read_only}\n"));
        // Explicit because the default is not ours to rely on. `guest ok` inherits from the
        // operator's `[global]`, and DEPSIS deliberately does not write smb.conf — so a box whose
        // globals carry `guest ok = yes` (or a `map to guest` that turns a bad password into the
        // guest account) would serve every DEPSIS share to anyone who can reach port 445, with
        // none of the access control §20 enforces on /files. One line per section closes that,
        // and it closes it in the file DEPSIS actually controls.
        out.push_str("\tguest ok = no\n");
        // ── MASKELER AÇIK, KARARI ACL VERİYOR ───────────────────────────────────────────
        //
        // Samba'nın varsayılanı `create mask = 0744`, `directory mask = 0755` — ve bir maske
        // yalnız bit KALDIRIYOR. Miras alınan ACL'de gruba verilmiş yazma hakkı bu maskeden
        // geçemiyor, yani izinler ekranında verilen hak diskte hiç oluşmuyor.
        //
        // Debian'ın kendi `smb.conf`unda bu değerler daha da dar (`0700`) ve DEPSIS o dosyayı
        // yazmıyor — operatörün dosyası. Bu yüzden değer BURADA, DEPSIS'in kendi bölümünde,
        // açıkça yazılıyor: bölüm ayarı global ayarı geçersiz kılıyor.
        //
        // 0770, 0777 değil: "diğer" için hiçbir bit açılmıyor. Erişimi belirleyen şey kiracı ve
        // klasör grupları; paylaşım ağacına o gruplardan birine ait olmayan bir hesabın erişimi
        // hiçbir yoldan açılmamalı.
        out.push_str("\tcreate mask = 0770\n");
        out.push_str("\tdirectory mask = 0770\n");
        // Yeni dosya ve klasörler üst klasörün ACL'ini devralıyor. `create mask` ile birlikte
        // çalışıyor: maske neyin geçebileceğini, bu da neyin miras alınacağını söylüyor.
        out.push_str("\tinherit acls = yes\n");
        // §6.2's grant walk, arriving at the front door.
        //
        // WHAT THIS DOES AND DOES NOT DO. Who may read which folder is enforced by the POSIX ACL
        // (ADR-0004) and stays there; `valid users` is a coarser gate in front of it. Samba's own
        // semantics are why adding it is safe: the parameter can only NARROW. A principal named
        // here is still refused by the ACL if the ACL refuses them, so this line cannot widen
        // access even if the API computes it wrongly.
        //
        // The failure it CAN cause is the opposite one — a principal the ACL would admit, left off
        // this line, is shut out of the whole share. That is why the API sends the union of every
        // principal named in any grant anywhere in the share rather than only those at its root:
        // it is exactly the set the ACL writer turns into entries, read from the same table, so
        // the two cannot come to disagree about who exists.
        //
        // An unmatched name is harmless. `tools/poc/p2-a-smb-identity.sh` measured a `valid users`
        // naming an account that does not exist: smbd serves the share and the name matches
        // nobody. Unlike P0-B's `full_audit`, a stale entry here does not take the file down.
        //
        // Empty means no line at all rather than `valid users =`, which Samba reads as no
        // restriction. Two spellings of one meaning, one of which looks like a closed door, is
        // exactly the ambiguity this file exists to avoid.
        if !section.valid_users.is_empty() {
            out.push_str(&format!(
                "\tvalid users = {}\n",
                section.valid_users.join(" ")
            ));
        }
        // ── ADR-0011 Layer 1: tell somebody when a client changes something ──
        //
        // WHY THIS IS HERE AT ALL. `file_entries` only learns about a file DEPSIS itself created,
        // so a file written from Windows is invisible until the reconciliation walk finds it —
        // fifteen minutes later. §5.3 asks for an SLA, and a quarter of an hour is not one. Samba
        // already knows the moment it happens, along with the user and the client address, in its
        // own process, with zero kernel privilege and zero ZFS dependency. Going two abstraction
        // layers down to fanotify and asking for CAP_SYS_ADMIN to recover what Samba is holding
        // out is reverse engineering (ADR-0011 §4).
        //
        // ⚠ ONE BAD OPNAME TAKES THE SHARE OFFLINE. Not "auditing stops" — smbd refuses the
        // CONNECT: `init_bitmap: Could not find opname rmdir` / `Invalid success operations list.
        // Failing connect`. And `testparm` does NOT catch it: the list is validated at connection
        // time, so the config parses cleanly, `testparm -s` is silent, the service starts, and the
        // share is dead from the first client onwards. P0-B measured exactly this with `rmdir`,
        // which Samba 4.22 does not have — directory removal goes through `unlinkat` since the
        // move to `*at()` VFS operations.
        //
        // The list below is the one P0-B measured ACCEPTED on Samba 4.22.10 / Debian 13, and
        // nothing may be added to it without measuring first. What makes shipping it safe at all
        // is that `publish` proves the configuration with a real client connection after
        // `testparm` and rolls back when it cannot — the gate ADR-0011 says this class of error
        // requires, because `testparm` is not one.
        //
        // `close` and not `write`/`pwrite`/`open`. Those fire per syscall and would drown the box;
        // `close` is the correct content-changed trigger — one event per file, after the data is
        // written. `create_file` is a placeholder: a client whose transfer is interrupted still
        // emits it.
        //
        // `acl_xattr` is deliberately NOT in `vfs objects`. ADR-0011's sketch includes it, but
        // ADR-0004 makes the POSIX ACL the one enforced substrate, and `acl_xattr` would have
        // Samba store NT ACLs in xattrs beside it — a second answer to who may read a file. That
        // is an ADR-0004 decision, not something to acquire as a side effect of adding auditing.
        out.push_str("\tvfs objects = full_audit\n");
        out.push_str("\tfull_audit:prefix = %u|%I|%S\n");
        out.push_str("\tfull_audit:success = create_file renameat unlinkat mkdirat close ftruncate linkat symlinkat\n");
        // `failure = none`: a refused operation changed nothing, so indexing it would be work with
        // no result — and a share somebody is probing would generate one line per attempt.
        out.push_str("\tfull_audit:failure = none\n");
        out.push_str("\tfull_audit:facility = local5\n");
        out.push_str("\tfull_audit:priority = notice\n");
        // `.depsis/staging` holds half-finished uploads. A user who can see it can see other
        // people's in-flight files and can delete a transfer the API still believes in, so it is
        // vetoed rather than merely hidden — `hide files` would still let a client open it by
        // name.
        out.push_str("\tveto files = /.depsis/\n");
        // Explicit, though it is also the default: with `yes`, deleting a directory would delete
        // the vetoed staging tree inside it, which is the API's data and not the client's.
        out.push_str("\tdelete veto files = no\n");
    }
    out
}

/// Generate, write, validate and prove — or put back what was there before.
///
/// The order is the contract. Nothing is written until Samba is known to be installed and every
/// share is known to be renderable; nothing is reported as published until a real client has seen
/// it; and every failure after the first byte is written ends with the previous file back in
/// place.
pub fn publish<H: SambaHost>(
    config: &Path,
    shares: &[ShareSpec],
    host: &H,
) -> Result<PublishOutcome, SambaError> {
    host.ensure_installed()?;

    let sections = plan(shares, host)?;
    let text = render(&sections);

    let previous = Previous::take(config)?;

    if let Err(e) = write_atomically(config, &text) {
        // The rename may or may not have happened. Restoring covers both.
        return Err(rolled_back(previous, config, e.to_string()));
    }

    if let Err(e) = host.validate() {
        return Err(rolled_back(previous, config, e.to_string()));
    }

    // The live attempt. P0-B: testparm passing proves the file parses, not that smbd will accept
    // a connection — an invalid `full_audit` opname passes the first and fails the second.
    let offered = match host.offered_shares() {
        Ok(names) => names,
        Err(e) => return Err(rolled_back(previous, config, e.to_string())),
    };

    let missing: Vec<&str> = sections
        .iter()
        .map(|s| s.name.as_str())
        .filter(|name| !offered.iter().any(|o| o.eq_ignore_ascii_case(name)))
        .collect();
    if !missing.is_empty() {
        // Almost always the missing `include` line: the file is valid, smbd is up, and it has
        // never read what we wrote. Reporting these as published would send a user to an address
        // that does not answer.
        return Err(rolled_back(
            previous,
            config,
            format!(
                "smbd does not offer {}; check that smb.conf contains `include = {}`",
                missing.join(", "),
                config.display()
            ),
        ));
    }

    // The publish stuck, so the backup has done its job and must not outlive it. Left behind it is
    // a full, plausible-looking Samba configuration sitting next to the live one, and the first
    // person debugging a share outage reads whichever file they open — an out-of-date `.prev` is a
    // trap laid for exactly the reader who most needs the truth. Nothing includes it, so this is
    // housekeeping and not a fix; the failure to tidy is logged rather than propagated, because
    // turning a proven publish into an error over a leftover file would be the worse answer.
    previous.discard();

    Ok(PublishOutcome {
        shares: sections.len(),
        verified: true,
    })
}

/// Put the previous configuration back, and say so loudly if that fails too.
fn rolled_back(previous: Previous, config: &Path, rejection: String) -> SambaError {
    match previous.restore(config) {
        Ok(()) => SambaError::RejectedRolledBack(rejection),
        Err(restore_failure) => SambaError::RollbackFailed {
            path: config.display().to_string(),
            rejection,
            restore_failure: restore_failure.to_string(),
        },
    }
}

/// The configuration that was in place before this publish.
#[derive(Debug)]
enum Previous {
    /// There was no file. Rolling back means removing the one we wrote — leaving it would mean an
    /// unverified configuration surviving a failed publish.
    Absent,
    /// Kept beside the real file, so restoring is a rename and not a copy: a copy can be
    /// interrupted halfway and leave smbd reading a truncated file, which is the failure this
    /// whole module is arranged to avoid.
    Saved(PathBuf),
}

impl Previous {
    fn take(config: &Path) -> Result<Self, SambaError> {
        let backup = sibling(config, ".prev")?;
        match std::fs::copy(config, &backup) {
            Ok(_) => {
                // The backup is only worth having if it survives the power cut that makes it
                // necessary.
                let file = std::fs::File::open(&backup)
                    .map_err(|e| SambaError::Io(format!("reopen backup: {e}")))?;
                file.sync_all()
                    .map_err(|e| SambaError::Io(format!("fsync backup: {e}")))?;
                Ok(Self::Saved(backup))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::Absent),
            Err(e) => Err(SambaError::Io(format!(
                "copy {} aside: {e}",
                config.display()
            ))),
        }
    }

    /// Throw the backup away. Only ever called once the new configuration is proved.
    ///
    /// Consumes `self` so it cannot be discarded and then restored: the two are the two ends of
    /// this type's life and the compiler is the cheapest place to make that exclusive.
    fn discard(self) {
        if let Self::Saved(backup) = self {
            if let Err(e) = std::fs::remove_file(&backup) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "depsis-agent: published the samba configuration but could not remove \
                         the backup at {}: {e}. It is stale and nothing reads it, but delete it \
                         by hand so nobody mistakes it for the live file.",
                        backup.display()
                    );
                }
            }
        }
    }

    fn restore(self, config: &Path) -> Result<(), SambaError> {
        match self {
            Self::Absent => match std::fs::remove_file(config) {
                Ok(()) => sync_parent(config),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(SambaError::Io(format!("remove {}: {e}", config.display()))),
            },
            Self::Saved(backup) => {
                std::fs::rename(&backup, config).map_err(|e| {
                    SambaError::Io(format!(
                        "rename {} back to {}: {e}",
                        backup.display(),
                        config.display()
                    ))
                })?;
                sync_parent(config)
            }
        }
    }
}

/// Write `text` so that a reader sees either all of it or none of it.
///
/// Temp file, fsync, rename, fsync the directory. The last step is the one people skip: without
/// it a power cut can lose the rename even though the new file's contents are on disk, and what
/// comes back is the old configuration with a stray `.new` beside it — or, on some filesystems,
/// an empty file where smb.conf's include points.
fn write_atomically(config: &Path, text: &str) -> Result<(), SambaError> {
    let temp = sibling(config, ".new")?;

    // Scoped so the descriptor is closed before the rename.
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| SambaError::Io(format!("create {}: {e}", temp.display())))?;
        file.write_all(text.as_bytes())
            .map_err(|e| SambaError::Io(format!("write {}: {e}", temp.display())))?;
        file.sync_all()
            .map_err(|e| SambaError::Io(format!("fsync {}: {e}", temp.display())))?;
    }

    std::fs::rename(&temp, config).map_err(|e| {
        // Leave the temp file: it is the evidence of what was attempted, and removing it here
        // could fail too and mask this error.
        SambaError::Io(format!(
            "rename {} to {}: {e}",
            temp.display(),
            config.display()
        ))
    })?;

    sync_parent(config)
}

/// `<config><suffix>`, in the same directory — which is what makes the rename atomic. A temp file
/// in `/tmp` would be a cross-device copy with a window in the middle.
fn sibling(config: &Path, suffix: &str) -> Result<PathBuf, SambaError> {
    let name = config
        .file_name()
        .ok_or_else(|| SambaError::Io(format!("{} does not name a file", config.display())))?;
    let mut with_suffix = name.to_os_string();
    with_suffix.push(suffix);
    let dir = config
        .parent()
        .ok_or_else(|| SambaError::Io(format!("{} has no parent directory", config.display())))?;
    Ok(dir.join(with_suffix))
}

/// Make a rename durable.
///
/// Unix-only in effect — opening a directory as a file is how Linux exposes this, and the agent
/// is a Linux daemon. The crate still compiles for Windows (CI cross-checks that no `cfg` has
/// crept into the core); it is not expected to publish Samba configuration there.
fn sync_parent(config: &Path) -> Result<(), SambaError> {
    let dir = config
        .parent()
        .ok_or_else(|| SambaError::Io(format!("{} has no parent", config.display())))?;
    let handle = std::fs::File::open(dir)
        .map_err(|e| SambaError::Io(format!("open {} for fsync: {e}", dir.display())))?;
    handle
        .sync_all()
        .map_err(|e| SambaError::Io(format!("fsync {}: {e}", dir.display())))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "The crate-level denials exist because a panic in a root daemon is a denial of \
              service. In tests the opposite holds: a failed assertion SHOULD panic, and \
              indexing a fixture reads better than unwrapping an Option."
)]
mod tests {
    use super::*;
    use crate::op::{DatasetName, PosixName, SafeComponent};
    use std::cell::RefCell;

    fn spec(name: &str, dataset: &str, read_only: bool) -> ShareSpec {
        ShareSpec {
            name: SafeComponent::parse(name).expect("test share name"),
            dataset: DatasetName::parse(dataset).expect("test dataset"),
            read_only,
            valid_users: Vec::new(),
        }
    }

    /// A machine that answers however the test needs it to.
    ///
    /// `MockCommandRunner` cannot fail, so it cannot reach a single line of the rollback path —
    /// and the rollback path is the one that decides whether a bad configuration takes the shares
    /// down with it.
    struct FakeHost {
        installed: bool,
        mountpoint: String,
        validates: bool,
        offers: Option<Vec<String>>,
        /// Deleted when `validate` runs, to make the restore itself fail.
        sabotage: Option<PathBuf>,
        validated: RefCell<u32>,
    }

    impl FakeHost {
        fn healthy(mountpoint: &str, offers: &[&str]) -> Self {
            Self {
                installed: true,
                mountpoint: mountpoint.to_string(),
                validates: true,
                offers: Some(offers.iter().map(|s| (*s).to_string()).collect()),
                sabotage: None,
                validated: RefCell::new(0),
            }
        }
    }

    impl SambaHost for FakeHost {
        fn ensure_installed(&self) -> Result<(), SambaError> {
            if self.installed {
                Ok(())
            } else {
                Err(SambaError::NotInstalled(TESTPARM.to_string()))
            }
        }

        fn mountpoint(&self, dataset: &str) -> Result<String, SambaError> {
            Ok(self.mountpoint.replace("{dataset}", dataset))
        }

        fn validate(&self) -> Result<(), SambaError> {
            *self.validated.borrow_mut() += 1;
            if let Some(victim) = &self.sabotage {
                let _ = std::fs::remove_file(victim);
            }
            if self.validates {
                Ok(())
            } else {
                Err(SambaError::RejectedRolledBack(
                    "testparm: unknown parameter".to_string(),
                ))
            }
        }

        fn offered_shares(&self) -> Result<Vec<String>, SambaError> {
            match &self.offers {
                Some(names) => Ok(names.clone()),
                None => Err(SambaError::RejectedRolledBack(
                    "smbd would not answer a local connection".to_string(),
                )),
            }
        }
    }

    // ── generation ──

    #[test]
    fn every_share_becomes_a_section_with_a_path() {
        let sections = vec![
            Section {
                name: "belgeler".to_string(),
                path: "/srv/depsis/belgeler".to_string(),
                read_only: false,
                valid_users: Vec::new(),
            },
            Section {
                name: "arsiv".to_string(),
                path: "/srv/depsis/arsiv".to_string(),
                read_only: true,
                valid_users: Vec::new(),
            },
        ];
        let text = render(&sections);

        assert!(text.contains("\n[belgeler]\n"), "got: {text}");
        assert!(
            text.contains("\tpath = /srv/depsis/belgeler\n"),
            "got: {text}"
        );
        assert!(text.contains("\n[arsiv]\n"), "got: {text}");
        assert!(text.contains("\tpath = /srv/depsis/arsiv\n"), "got: {text}");
    }

    // ── valid users ──

    #[test]
    fn a_group_gets_the_sigil_and_a_user_does_not() {
        // The whole reason the split is an enum: `@` decides whether Samba looks the name up in
        // the user database or the group database, and getting it backwards silently matches
        // nobody.
        let text = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: vec![
                SmbPrincipal::Group(PosixName::parse("depsis-t-300010").expect("group")).render(),
                SmbPrincipal::User(PosixName::parse("ayse").expect("user")).render(),
            ],
        }]);
        assert!(
            text.contains("\tvalid users = @depsis-t-300010 ayse\n"),
            "got: {text}"
        );
    }

    #[test]
    fn no_principals_means_no_line_at_all() {
        // NOT `valid users =`. Samba reads an empty value as no restriction, so the two spellings
        // mean the same thing and one of them looks like a closed door to whoever reads the file.
        let text = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        assert!(!text.contains("valid users"), "got: {text}");
    }

    #[test]
    fn a_principal_cannot_carry_a_line_break_into_the_file() {
        // The injection this type exists to prevent, attempted from the direction an attacker
        // would: a "username" that ends the `valid users` line and starts a directive of its own.
        // If `PosixName` ever admitted it, the share below would be served to guests.
        for attempt in [
            "ayse\n\tguest ok = yes",
            "ayse ok",
            "@everyone",
            "ayse;guest ok = yes",
        ] {
            assert!(
                PosixName::parse(attempt).is_err(),
                "{attempt:?} was accepted as a principal name"
            );
        }
    }

    #[test]
    fn a_principal_list_survives_a_round_trip_through_json() {
        // `plan` reads these off the wire, so the encoding is part of the contract rather than an
        // implementation detail: a rename of the tag would make every group arrive as a user.
        let encoded = serde_json::to_string(&SmbPrincipal::Group(
            PosixName::parse("depsis-t-300010").expect("group"),
        ))
        .expect("encode");
        assert_eq!(
            encoded, r#"{"kind":"group","name":"depsis-t-300010"}"#,
            "the wire shape changed"
        );
        let back: SmbPrincipal = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(back.render(), "@depsis-t-300010");
    }

    #[test]
    fn planning_carries_the_principals_through_to_the_section() {
        // The seam between the request and the file. `plan` is where a field is easiest to accept
        // and then forget to pass on, which would produce a share with no restriction and no error.
        let host = FakeHost::healthy("/srv/depsis/belgeler", &["belgeler"]);
        let mut spec = spec("belgeler", "tank/belgeler", false);
        spec.valid_users = vec![SmbPrincipal::User(PosixName::parse("ayse").expect("user"))];
        let sections = plan(&[spec], &host).expect("plan");
        let only = sections.first().expect("one section");
        assert_eq!(only.valid_users, vec!["ayse".to_string()]);
    }

    // ── full_audit (ADR-0011 Layer 1) ──

    #[test]
    fn every_section_carries_the_audit_module() {
        let text = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        assert!(text.contains("\tvfs objects = full_audit\n"), "got: {text}");
        assert!(
            text.contains("\tfull_audit:prefix = %u|%I|%S\n"),
            "got: {text}"
        );
        assert!(
            text.contains("\tfull_audit:failure = none\n"),
            "got: {text}"
        );
        assert!(
            text.contains("\tfull_audit:facility = local5\n"),
            "got: {text}"
        );
        assert!(
            text.contains("\tfull_audit:priority = notice\n"),
            "got: {text}"
        );
    }

    #[test]
    fn the_audited_operations_are_exactly_the_ones_p0_b_measured() {
        // THE SHARPEST EDGE IN THIS FILE. An opname Samba does not know makes smbd refuse the
        // CONNECT — not merely stop auditing — and `testparm` does not catch it, because the list
        // is validated when a client connects and not when the config is parsed. P0-B measured
        // that with `rmdir`, which Samba 4.22 does not have: directory removal goes through
        // `unlinkat` since the move to `*at()` VFS operations.
        //
        // Pinned as an exact string rather than a `contains` per name, so ADDING one is a test
        // failure. A name added here without being measured against a real smbd is a name that
        // takes every share offline the next time anybody connects.
        let text = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        const MEASURED: &str =
            "create_file renameat unlinkat mkdirat close ftruncate linkat symlinkat";
        assert!(
            text.contains(&format!("\tfull_audit:success = {MEASURED}\n")),
            "the audited operation list changed; measure it against a real smbd before shipping. \
             got: {text}"
        );
    }

    #[test]
    fn the_operation_list_never_contains_rmdir() {
        // Its own test because it is the one name that has already done the damage once. Samba
        // 4.22 has no `rmdir` opname; adding it back is a share that answers no client at all.
        let text = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        assert!(
            !text.contains("rmdir"),
            "`rmdir` is not an opname in Samba 4.22 and makes smbd refuse every connection"
        );
    }

    #[test]
    fn the_audit_module_does_not_bring_acl_xattr_with_it() {
        // ADR-0011's sketch lists `acl_xattr full_audit`. ADR-0004 makes the POSIX ACL the one
        // enforced substrate, and `acl_xattr` would have Samba keep NT ACLs in xattrs beside it —
        // a second answer to who may read a file, acquired as a side effect of adding auditing.
        let text = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        assert!(!text.contains("acl_xattr"), "got: {text}");
    }

    #[test]
    fn a_read_only_share_really_says_read_only() {
        // The inverse of the mistake worth catching: a share the user marked read-only being
        // served writable is silent data loss with no error anywhere.
        let text = render(&[Section {
            name: "arsiv".to_string(),
            path: "/srv/arsiv".to_string(),
            read_only: true,
            valid_users: Vec::new(),
        }]);
        assert!(text.contains("\tread only = yes\n"), "got: {text}");
        assert!(!text.contains("read only = no"), "got: {text}");

        let writable = render(&[Section {
            name: "belgeler".to_string(),
            path: "/srv/belgeler".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        assert!(writable.contains("\tread only = no\n"), "got: {writable}");
    }

    /// Maskeler AÇIK yazılıyor, ve bu bir tercih değil bir zorunluluk.
    ///
    /// Samba'nın varsayılanı `0744`/`0755` ve bir maske yalnız bit KALDIRIYOR: miras alınan
    /// ACL'de gruba verilmiş yazma hakkı o maskeden geçemiyor. Sahada bunun bedeli, ağ
    /// sürücüsünden yüklenen bir klasör dolusu dosyanın `-rw-------` inmesi ve sahibinden başka
    /// kimsenin — ikinci bir hesabın, arayüzün indirme düğmesinin — okuyamaması oldu.
    ///
    /// "Diğer" için hiçbir bit açılmıyor: erişimi kiracı ve klasör grupları belirliyor.
    #[test]
    fn maskeler_gruba_acik_digerine_kapali_yaziliyor() {
        let text = render(&[Section {
            name: "ev".to_string(),
            path: "/srv/depsis/ev".to_string(),
            read_only: false,
            valid_users: Vec::new(),
        }]);
        for line in [
            "create mask = 0770",
            "directory mask = 0770",
            "inherit acls = yes",
        ] {
            assert!(text.contains(line), "{line} eksik; got: {text}");
        }
        assert!(!text.contains("0777"), "got: {text}");
    }

    #[test]
    fn staging_is_vetoed_in_every_section() {
        let sections: Vec<Section> = ["a", "b", "c"]
            .iter()
            .map(|n| Section {
                name: (*n).to_string(),
                path: format!("/srv/{n}"),
                read_only: false,
                valid_users: Vec::new(),
            })
            .collect();
        let text = render(&sections);

        let vetoes = text.matches("veto files = /.depsis/").count();
        assert_eq!(
            vetoes, 3,
            "every section must veto the staging tree, got {vetoes}:\n{text}"
        );
    }

    #[test]
    fn no_section_can_be_opened_anonymously_by_a_permissive_global() {
        // DEPSIS never writes smb.conf, so `[global]` belongs to the operator — and `guest ok`
        // inherits from it. A box with `guest ok = yes` or a `map to guest` in its globals would
        // otherwise serve every share published here to anyone who can reach port 445, with none
        // of the access control the API enforces on the same bytes. The per-section line is the
        // only place DEPSIS can refuse that, because it is the only file DEPSIS owns.
        let sections: Vec<Section> = ["a", "b", "c"]
            .iter()
            .map(|n| Section {
                name: (*n).to_string(),
                path: format!("/srv/{n}"),
                read_only: false,
                valid_users: Vec::new(),
            })
            .collect();
        let text = render(&sections);

        assert_eq!(
            text.matches("\tguest ok = no\n").count(),
            3,
            "every section must refuse guest access explicitly:\n{text}"
        );
        assert!(
            !text.contains("guest ok = yes"),
            "a section opened guest access:\n{text}"
        );
    }

    // ── injection ──

    #[test]
    fn a_share_name_carrying_a_section_header_is_refused_before_anything_is_written() {
        // `SafeComponent` does NOT reject newlines or `[` — it guards path separators, NUL, `..`
        // and a leading dash. So this name is constructible today, and without the check in
        // `plan` it would append a `[global]` section to the operator's configuration.
        let hostile = SafeComponent::parse("docs\n[global]\nguest ok = yes")
            .expect("SafeComponent still permits newlines; that is exactly why plan() checks");
        let spec = ShareSpec {
            name: hostile,
            dataset: DatasetName::parse("tank/docs").unwrap(),
            read_only: false,
            valid_users: Vec::new(),
        };

        let host = FakeHost::healthy("/srv/docs", &["docs"]);
        let err = plan(&[spec], &host).expect_err("a newline in a share name must be refused");
        assert!(
            matches!(err, SambaError::Unrepresentable(_)),
            "got: {err:?}"
        );
    }

    #[test]
    fn a_share_named_global_cannot_hijack_the_operators_settings() {
        let host = FakeHost::healthy("/srv/x", &[]);
        let err =
            plan(&[spec("global", "tank/x", false)], &host).expect_err("`global` must be refused");
        assert!(err.to_string().contains("reserved"), "got: {err}");
    }

    #[test]
    fn the_rendered_text_has_no_bracket_outside_a_section_header() {
        // The property, asserted over the whole file rather than over one hostile input: every
        // `[` in the output opens a section whose name is one we put there. A future field that
        // interpolated an unchecked value would fail here.
        let names = ["belgeler", "arsiv-2024", "yedek.eski", "bir iki"];
        let sections: Vec<Section> = names
            .iter()
            .map(|n| Section {
                name: (*n).to_string(),
                path: format!("/srv/{n}"),
                read_only: false,
                valid_users: Vec::new(),
            })
            .collect();
        let text = render(&sections);

        let headers: Vec<&str> = text
            .lines()
            .filter(|line| line.contains('[') || line.contains(']'))
            .collect();
        assert_eq!(
            headers.len(),
            names.len(),
            "a bracket appeared outside a section header:\n{text}"
        );
        for (header, name) in headers.iter().zip(names.iter()) {
            assert_eq!(*header, format!("[{name}]"));
        }
    }

    #[test]
    fn a_mountpoint_that_is_not_a_directory_is_refused() {
        // `legacy` and `none` are the ones that bite in practice: the dataset exists, `zfs list`
        // shows it, and there is no directory to serve. `%` is the injection case — smb.conf
        // expands it inside a value.
        for mountpoint in ["legacy", "none", "-", "", "/", "/srv/%U", "srv/relative"] {
            let host = FakeHost::healthy(mountpoint, &[]);
            match plan(&[spec("belgeler", "tank/belgeler", false)], &host) {
                Err(SambaError::Unrepresentable(_)) => {}
                Err(other) => panic!("{mountpoint:?}: wrong error: {other:?}"),
                Ok(sections) => panic!("{mountpoint:?} was accepted as {sections:?}"),
            }
        }
    }

    // ── publishing ──

    fn temp_config() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("depsis.conf");
        (dir, path)
    }

    #[test]
    fn a_clean_publish_writes_the_file_and_reports_it_verified() {
        let (_dir, config) = temp_config();
        let host = FakeHost::healthy("/srv/{dataset}", &["belgeler"]);

        let outcome = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect("a healthy host must publish");

        assert_eq!(
            outcome,
            PublishOutcome {
                shares: 1,
                verified: true
            }
        );
        let written = std::fs::read_to_string(&config).expect("the file must exist");
        assert!(written.contains("[belgeler]"), "got: {written}");
        assert!(
            written.contains("path = /srv/tank/belgeler"),
            "the mountpoint must come from the host, got: {written}"
        );
    }

    #[test]
    fn a_successful_publish_leaves_no_backup_beside_the_live_file() {
        // The backup exists to be restored. Once the publish is proved it is a complete,
        // plausible-looking Samba configuration lying next to the real one, and the person who
        // opens it is by definition the person debugging a share outage — the reader who can
        // least afford to be shown a stale file.
        let (_dir, config) = temp_config();
        std::fs::write(&config, "[eski]\n\tpath = /srv/eski\n").expect("seed");
        let host = FakeHost::healthy("/srv/{dataset}", &["belgeler"]);

        publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host).expect("must publish");

        let backup = config.with_file_name("depsis.conf.prev");
        assert!(
            !backup.exists(),
            "the previous configuration was left at {}",
            backup.display()
        );
        assert!(
            std::fs::read_to_string(&config)
                .expect("the live file must exist")
                .contains("[belgeler]"),
            "the live file must be the new one"
        );
    }

    #[test]
    fn a_rejected_configuration_brings_the_old_file_back_byte_for_byte() {
        let (_dir, config) = temp_config();
        let original = "# the operator's working configuration\n[eski]\n\tpath = /srv/eski\n";
        std::fs::write(&config, original).expect("seed");

        let mut host = FakeHost::healthy("/srv/{dataset}", &["belgeler"]);
        host.validates = false;

        let err = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect_err("a failing testparm must not publish");
        assert!(
            matches!(err, SambaError::RejectedRolledBack(_)),
            "got: {err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&config).expect("the file must still be there"),
            original,
            "the previous configuration must be back, unchanged"
        );
    }

    #[test]
    fn a_rejected_first_publish_leaves_no_file_behind() {
        // There was nothing to restore, so rolling back means removing what we wrote. Leaving an
        // unverified file for smb.conf to include is how a box comes back after a reboot serving
        // a configuration nobody approved.
        let (_dir, config) = temp_config();
        let mut host = FakeHost::healthy("/srv/{dataset}", &[]);
        host.validates = false;

        let err = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect_err("must not publish");
        assert!(
            matches!(err, SambaError::RejectedRolledBack(_)),
            "got: {err:?}"
        );
        assert!(
            !config.exists(),
            "an unverified configuration was left at {}",
            config.display()
        );
    }

    #[test]
    fn testparm_passing_is_not_enough_to_call_it_published() {
        // P0-B in one test: validation succeeds and the live connection shows the share is not
        // being served. Reporting this as published sends a user to an address that does not
        // answer.
        let (_dir, config) = temp_config();
        let original = "[eski]\n";
        std::fs::write(&config, original).expect("seed");

        let host = FakeHost::healthy("/srv/{dataset}", &[]); // smbd offers nothing

        let err = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect_err("an unserved share must not count as published");
        assert!(
            err.to_string().contains("include"),
            "the reason must name the missing include line, got: {err}"
        );
        assert_eq!(*host.validated.borrow(), 1, "testparm must have run");
        assert_eq!(
            std::fs::read_to_string(&config).expect("restored"),
            original
        );
    }

    #[test]
    fn a_dead_smbd_rolls_back_rather_than_reporting_success() {
        let (_dir, config) = temp_config();
        std::fs::write(&config, "[eski]\n").expect("seed");

        let mut host = FakeHost::healthy("/srv/{dataset}", &[]);
        host.offers = None;

        let err = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect_err("must not publish");
        assert!(
            matches!(err, SambaError::RejectedRolledBack(_)),
            "got: {err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&config).expect("restored"),
            "[eski]\n"
        );
    }

    #[test]
    fn a_failed_rollback_is_its_own_very_loud_error() {
        // The worst outcome available: the new configuration was rejected AND the old one could
        // not be put back. Folding this into an ordinary refusal would tell an operator "your
        // shares still work" while they are down.
        let (_dir, config) = temp_config();
        std::fs::write(&config, "[eski]\n").expect("seed");

        let mut host = FakeHost::healthy("/srv/{dataset}", &[]);
        host.validates = false;
        host.sabotage = Some(sibling(&config, ".prev").expect("backup path"));

        let err = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect_err("must fail");
        match &err {
            SambaError::RollbackFailed { .. } => {}
            other => panic!("expected RollbackFailed, got: {other:?}"),
        }
        assert!(!err.is_unavailable(), "this is a fault, not an absence");
        let message = err.to_string();
        assert!(message.contains("COULD NOT BE RESTORED"), "got: {message}");
        assert!(
            message.contains(&config.display().to_string()),
            "the message must name the file an operator has to repair, got: {message}"
        );
    }

    #[test]
    fn an_absent_samba_is_told_apart_from_a_refusal_and_writes_nothing() {
        let (_dir, config) = temp_config();
        let mut host = FakeHost::healthy("/srv/{dataset}", &["belgeler"]);
        host.installed = false;

        let err = publish(&config, &[spec("belgeler", "tank/belgeler", false)], &host)
            .expect_err("must refuse");
        assert!(
            err.is_unavailable(),
            "an absent Samba is a 503, not a fault: {err:?}"
        );
        assert!(matches!(err, SambaError::NotInstalled(_)), "got: {err:?}");
        assert!(
            !config.exists(),
            "nothing may be written when Samba is not installed"
        );
    }

    // ── against the real thing, when it is here ──

    #[test]
    fn the_generated_text_is_accepted_by_a_real_testparm() {
        if !Path::new(TESTPARM).exists() {
            eprintln!(
                "SKIPPED the_generated_text_is_accepted_by_a_real_testparm: {TESTPARM} is not \
                 installed on this box, so the generated syntax is asserted only against the \
                 shape of the file. Run this on a machine with samba-common-bin."
            );
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let fragment = dir.path().join("depsis.conf");
        std::fs::write(
            &fragment,
            render(&[
                Section {
                    name: "belgeler".to_string(),
                    path: "/srv/depsis/belgeler".to_string(),
                    read_only: false,
                    valid_users: Vec::new(),
                },
                Section {
                    name: "arsiv".to_string(),
                    path: "/srv/depsis/arsiv".to_string(),
                    read_only: true,
                    valid_users: Vec::new(),
                },
            ]),
        )
        .expect("write fragment");

        // The fragment as smbd will see it: included from a minimal smb.conf, which is the
        // composition the deployment actually uses.
        let wrapper = dir.path().join("smb.conf");
        std::fs::write(
            &wrapper,
            format!(
                "[global]\n\tworkgroup = WORKGROUP\n\tinclude = {}\n",
                fragment.display()
            ),
        )
        .expect("write wrapper");

        let out = std::process::Command::new(TESTPARM)
            .args(["-s", "--suppress-prompt", &wrapper.display().to_string()])
            .output()
            .expect("run testparm");
        assert!(
            out.status.success(),
            "testparm rejected the generated configuration: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let dump = String::from_utf8_lossy(&out.stdout);
        assert!(dump.contains("[belgeler]"), "got: {dump}");
        assert!(dump.contains("[arsiv]"), "got: {dump}");
    }
}
