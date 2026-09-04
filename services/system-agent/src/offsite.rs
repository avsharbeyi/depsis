//! Off-site replication: `zfs send` into a `zfs recv` running on ANOTHER machine.
//!
//! WHY THIS EXISTS AND `replicate.rs` IS NOT ENOUGH. A second pool in the same box survives a disk
//! dying. It does not survive the box being stolen, the flat burning, or ransomware reaching every
//! mounted dataset — which is most of what people actually mean when they say "backup". The
//! limitations document listed the missing half by name: a transport, a credential store, host-key
//! verification, and a failure model for a link that goes away mid-send. This module is those four.
//!
//! THE KEY NEVER LEAVES THIS SIDE. `ssh-keygen` runs here, the private key is written under a
//! directory only the agent can read, and the API is only ever told the PUBLIC half — which is the
//! thing the user pastes into the far end's `authorized_keys`. There is no operation that reads the
//! private key back, and there must not be: ADR-0006 splits the appliance so that database access
//! alone is not enough, and a private key readable through an HTTP endpoint would undo that split
//! for the one credential that reaches another machine.
//!
//! NO TRUST ON FIRST USE. `StrictHostKeyChecking=yes` against a `known_hosts` this module writes,
//! and nothing writes into it except a host key the user was SHOWN and confirmed. The usual
//! alternative — `accept-new`, or `StrictHostKeyChecking=no` — means the first connection accepts
//! whatever answers, which on a replication is an attacker receiving a copy of every file the
//! appliance holds. A backup that goes to the wrong machine is worse than no backup.
//!
//! THE REMOTE COMMAND IS BUILT, NOT COMPOSED. `ssh` hands its command to a shell on the far side,
//! so a dataset name containing a space or a semicolon would be remote code execution as whoever
//! the far end runs as. `DatasetName` permits only `[A-Za-z0-9/_.:-]` and refuses a leading dash;
//! that is what makes the interpolation below safe, and it is why nothing here accepts a bare
//! `&str` for a dataset.

use crate::op::{SshHostName, SshUserName};
use crate::seams::SeamError;

/// Where the agent keeps the off-site identity and the hosts it has been told to trust.
///
/// Under `/var/lib`, not under a share and not in the database. A share is user-writable over SMB;
/// the database is the thing ADR-0016 assumes an attacker may have.
pub const DEFAULT_STATE_DIR: &str = "/var/lib/depsis/offsite";

/// Overrides `DEFAULT_STATE_DIR`.
///
/// The environment, never the request — the same rule and the same wording as
/// `samba::CONFIG_PATH_ENV`. "Which directory does the privileged daemon keep its private key in"
/// is not a question an unprivileged caller may answer, so the request enum has no operand for it
/// and must never gain one. The agent's environment comes from systemd's `EnvironmentFile`; the
/// tests set it to a temporary directory.
pub const STATE_DIR_ENV: &str = "DEPSIS_OFFSITE_DIR";

pub fn state_dir() -> std::path::PathBuf {
    std::env::var_os(STATE_DIR_ENV)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(DEFAULT_STATE_DIR))
}

pub fn key_path() -> std::path::PathBuf {
    state_dir().join("id_ed25519")
}

pub fn public_key_path() -> std::path::PathBuf {
    state_dir().join("id_ed25519.pub")
}

pub fn known_hosts_path() -> std::path::PathBuf {
    state_dir().join("known_hosts")
}

/// Why an off-site replication was refused before anything ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// No key has been generated yet, so there is nothing to authenticate with.
    NoIdentity,
    /// The far end's host key has never been confirmed.
    ///
    /// The refusal that makes "no trust on first use" real. Without it `ssh` would either prompt
    /// — hanging the agent's single-connection socket forever — or accept whatever answered.
    HostNotTrusted,
    /// A key already exists and this operation would have replaced it.
    ///
    /// Overwriting is never the right answer: the far end's `authorized_keys` holds the public half
    /// of the OLD key, so a silent regeneration turns every future replication into a permission
    /// error at the far end, hours later, with nothing on this side saying why.
    IdentityExists,
}

impl Refusal {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NoIdentity => {
                "this appliance has no off-site key yet; generate one and add its public half to \
                 the destination's authorized_keys"
            }
            Self::HostNotTrusted => {
                "the destination's host key has not been confirmed; scan it, check the \
                 fingerprint, and confirm it before replicating"
            }
            Self::IdentityExists => {
                "an off-site key already exists; replacing it would break every destination that \
                 holds the old public half"
            }
        }
    }
}

/// One host key `ssh-keyscan` reported, and the fingerprint a person compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    /// `ssh-ed25519`, `ecdsa-sha2-nistp256`, …
    pub kind: String,
    /// The full `known_hosts` line, exactly as it will be stored.
    pub line: String,
}

/// `ssh-keygen`, generating the identity.
///
/// ed25519 and not RSA: a fixed 32-byte key with no size parameter to get wrong, supported by every
/// OpenSSH since 6.5. `-N ''` because a passphrase on a key an unattended daemon must use is a
/// passphrase written down somewhere else — the protection is the file's mode and the fact that the
/// process holding it is the privileged side.
pub fn keygen_argv(key: &std::path::Path) -> Vec<String> {
    vec![
        "-t".to_string(),
        "ed25519".to_string(),
        "-N".to_string(),
        String::new(),
        "-C".to_string(),
        "depsis-offsite".to_string(),
        "-f".to_string(),
        key.display().to_string(),
    ]
}

/// `ssh-keygen -lf`, reading a fingerprint back out of a public key file.
pub fn fingerprint_argv(public_key: &std::path::Path) -> Vec<String> {
    vec![
        "-l".to_string(),
        "-f".to_string(),
        public_key.display().to_string(),
    ]
}

/// `ssh-keyscan`, asking the far end what its host key is.
///
/// `-T 5` so a host that accepts the connection and then says nothing cannot hold the agent's
/// single-connection control socket. `-t` names the algorithms rather than taking the default,
/// because the default has changed between OpenSSH releases and a scan that returned a type the
/// later `ssh` will not offer produces a `known_hosts` entry that never matches.
pub fn keyscan_argv(host: &SshHostName, port: u16) -> Vec<String> {
    vec![
        "-T".to_string(),
        "5".to_string(),
        "-p".to_string(),
        port.to_string(),
        "-t".to_string(),
        "ed25519,ecdsa,rsa".to_string(),
        host.as_str().to_string(),
    ]
}

/// Turn `ssh-keyscan` output into the lines that would go into `known_hosts`.
///
/// Comment lines are dropped — `ssh-keyscan` writes the server's version banner as `# host:22
/// SSH-2.0-OpenSSH_9.2`, and storing that would put a line in `known_hosts` that matches nothing.
/// Anything with FEWER than three whitespace-separated fields is dropped for the same reason. More
/// than three is kept, and the line is stored exactly as `ssh-keyscan` printed it: `known_hosts`
/// carries longer forms too — a `@cert-authority` marker, a comma-separated name list — and
/// rebuilding the line from its first three parts would silently drop them.
///
/// An EMPTY RESULT IS NOT AN ERROR HERE and the caller must not treat it as "no keys": a host that
/// refused the connection produces the same empty output as one that answered with nothing, and
/// the difference belongs to the caller, which knows whether the command failed.
pub fn parse_keyscan(output: &str) -> Vec<HostKey> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let _host = fields.next()?;
            let kind = fields.next()?;
            // ÜÇÜNCÜ ALANIN VARLIĞI, ve süzgeç bundan ibaret: anahtarın kendisi yoksa satır bir
            // `known_hosts` satırı değil. Bir `?` ile düşmesi yeter.
            //
            // SATIR HAM SAKLANIYOR — parçalardan yeniden kurulmuyor. Buradaki eski yorum tersini
            // iddia ediyordu ve `line: line.to_string()` ile çelişiyordu. Hamı saklamak doğrusu:
            // `known_hosts` biçimi üç alandan fazlasını da taşıyabiliyor (`@cert-authority`
            // markörü, virgüllü ad listeleri), ve satırı üç parçadan yeniden kurmak onları
            // sessizce düşürürdü.
            let _blob = fields.next()?;
            Some(HostKey {
                kind: kind.to_string(),
                line: line.to_string(),
            })
        })
        .collect()
}

/// Is this `known_hosts` file already carrying an entry for `host` on `port`?
///
/// The lookup key is what `ssh` itself uses: a bare hostname for port 22, and `[host]:port`
/// otherwise. Getting that wrong in the permissive direction would make the trust check pass for a
/// host nothing had confirmed, which is exactly the refusal this module exists for.
pub fn trusts(known_hosts: &str, host: &SshHostName, port: u16) -> bool {
    let wanted = host_key_pattern(host, port);
    known_hosts
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .any(|line| {
            line.split_whitespace()
                .next()
                .is_some_and(|names| names.split(',').any(|name| name == wanted))
        })
}

pub fn host_key_pattern(host: &SshHostName, port: u16) -> String {
    if port == 22 {
        host.as_str().to_string()
    } else {
        format!("[{}]:{port}", host.as_str())
    }
}

/// The `ssh` argv that runs `zfs recv` on the far end.
///
/// Every option here is load-bearing and each one is a decision:
///
///   - `BatchMode=yes` — never prompt. A prompt on a daemon's stdin is a replication that hangs
///     forever holding the control socket, and the agent serves one connection at a time.
///   - `StrictHostKeyChecking=yes` — refuse an unknown host outright. Not `accept-new`: the first
///     connection is exactly the one an attacker would answer.
///   - `UserKnownHostsFile` — the file this module writes, and `GlobalKnownHostsFile=/dev/null` so
///     a system-wide entry somebody else added cannot substitute for a confirmed one.
///   - `IdentitiesOnly=yes` — offer THIS key and no other. Without it `ssh` also offers whatever
///     an agent socket or the invoking user's `~/.ssh` holds, which makes "which credential
///     authenticated" unanswerable.
///   - `ConnectTimeout` — a link that goes away mid-handshake must fail, not wait.
///   - `ServerAliveInterval` / `ServerAliveCountMax` / `TCPKeepAlive` — a link that goes away
///     MID-TRANSFER must fail too, and `ConnectTimeout` says nothing about that. Measured cost of
///     not having them: when the VPN tunnel drops without an RST — the ordinary way a ZeroTier or
///     WireGuard tunnel dies — `ssh` waits on the kernel's TCP retransmit ceiling (`tcp_retries2`,
///     roughly fifteen minutes) while `zfs send` blocks on the pipe. The agent serves ONE control
///     connection at a time, so for those fifteen minutes the owner cannot read pool status, list
///     shares or add a user: every request fails with "the agent is not answering". Thirty seconds
///     times three bounds it at about ninety, and an honest transfer is untouched because the
///     probes travel on the same connection the data does.
///
/// NO TOTAL TIME LIMIT, deliberately. An honest terabyte-scale `zfs send | zfs recv` runs for
/// hours; a ceiling on the whole run would cut exactly the replication that needs it most. The
/// bound here is on SILENCE, not on duration.
///
/// `zfs recv -F -u` on the far end, and the flags mean what they mean in `replicate.rs`: `-F`
/// rolls the target back to the common snapshot, which is what makes this destructive AT THE
/// DESTINATION and why the API puts §8.1's confirmation in front of it.
pub fn ssh_recv_argv(
    user: &SshUserName,
    host: &SshHostName,
    port: u16,
    target: &str,
    key: &std::path::Path,
    known_hosts: &std::path::Path,
) -> Vec<String> {
    vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".to_string(),
        "GlobalKnownHostsFile=/dev/null".to_string(),
        "-o".to_string(),
        "IdentitiesOnly=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=15".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
        "-o".to_string(),
        "TCPKeepAlive=yes".to_string(),
        "-i".to_string(),
        key.display().to_string(),
        "-p".to_string(),
        port.to_string(),
        format!("{}@{}", user.as_str(), host.as_str()),
        // Interpolated, and safe to interpolate ONLY because `DatasetName` refuses whitespace,
        // quotes, semicolons and a leading dash. See the module comment.
        format!("zfs recv -F -u {target}"),
    ]
}

/// Did `ssh` fail because the far end is not who `known_hosts` says?
///
/// Its own answer because the repair is completely different from every other failure and the
/// stakes are too: a changed host key is either a reinstalled server or somebody standing in the
/// middle, and DEPSIS must not guess which. Reported so the user re-confirms deliberately.
pub fn host_key_changed(error: &SeamError) -> bool {
    let said = error.to_string();
    said.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || said.contains("Host key verification failed")
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "a test that cannot index or unwrap is a test written around the lint"
)]
mod tests {
    use super::*;

    fn host(raw: &str) -> SshHostName {
        SshHostName::parse(raw).expect("a usable host")
    }

    #[test]
    fn ordinary_names_and_addresses_are_accepted() {
        // The refusals themselves belong to `op::SshHostName`, next to every other validated
        // operand type and tested there. What this file needs is that the happy path reaches the
        // argv builders below unchanged.
        assert_eq!(host("backup.example.org").as_str(), "backup.example.org");
        assert_eq!(host("192.0.2.10").as_str(), "192.0.2.10");
        assert_eq!(SshUserName::parse("depsis").expect("ok").as_str(), "depsis");
    }

    #[test]
    fn the_ssh_command_refuses_an_unknown_host_and_never_prompts() {
        let key = std::path::Path::new("/var/lib/depsis/offsite/id_ed25519");
        let known = std::path::Path::new("/var/lib/depsis/offsite/known_hosts");
        let argv = ssh_recv_argv(
            &SshUserName::parse("depsis").expect("ok"),
            &host("backup.example.org"),
            2222,
            "backup/depsis",
            key,
            known,
        );
        let joined = argv.join(" ");

        // The three that make this safe rather than convenient.
        assert!(joined.contains("StrictHostKeyChecking=yes"), "{joined}");
        assert!(joined.contains("BatchMode=yes"), "{joined}");
        assert!(
            joined.contains("UserKnownHostsFile=/var/lib/depsis/offsite/known_hosts"),
            "{joined}"
        );
        // And the key it offers is the one this module owns, not whatever an agent socket holds.
        assert!(
            joined.contains("-i /var/lib/depsis/offsite/id_ed25519"),
            "{joined}"
        );

        // KOPAN BİR TÜNEL BEKLENMİYOR. `ConnectTimeout` yalnız el sıkışmayı bağlıyor; aktarımın
        // ortasında düşen bir VPN tüneli RST göndermez ve `ssh` çekirdeğin yeniden iletim tavanına
        // (~15 dakika) kadar bekler. O süre boyunca kontrol soketi tek bağlantı işlediği için
        // cihazda başka hiçbir şey yapılamaz: havuz durumu, paylaşım listesi, kullanıcı ekleme.
        assert!(joined.contains("ServerAliveInterval=30"), "{joined}");
        assert!(joined.contains("ServerAliveCountMax=3"), "{joined}");
        assert!(joined.contains("TCPKeepAlive=yes"), "{joined}");

        // And the three that would each quietly undo one of them.
        assert!(!joined.contains("accept-new"), "{joined}");
        assert!(!joined.contains("StrictHostKeyChecking=no"), "{joined}");
        assert!(
            joined.contains("GlobalKnownHostsFile=/dev/null"),
            "{joined}"
        );

        assert_eq!(
            argv.last().map(String::as_str),
            Some("zfs recv -F -u backup/depsis")
        );
        assert!(argv.contains(&"depsis@backup.example.org".to_string()));
        assert!(argv.contains(&"2222".to_string()));
    }

    #[test]
    fn a_scan_drops_the_banner_and_keeps_the_keys() {
        let out = "# backup.example.org:22 SSH-2.0-OpenSSH_9.2\n\
                   backup.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\n\
                   # backup.example.org:22 SSH-2.0-OpenSSH_9.2\n\
                   backup.example.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB\n";
        let keys = parse_keyscan(out);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].kind, "ssh-ed25519");
        assert_eq!(keys[1].kind, "ssh-rsa");
        // The banner would match no host and belongs in no `known_hosts`.
        assert!(keys.iter().all(|key| !key.line.starts_with('#')));
    }

    #[test]
    fn a_scan_that_returned_nothing_is_an_empty_list() {
        assert_eq!(parse_keyscan(""), Vec::new());
        assert_eq!(parse_keyscan("# only a banner\n"), Vec::new());
        // A truncated line is dropped rather than stored: a two-field `known_hosts` entry is a
        // file `ssh` refuses to read at all, which would break every destination at once.
        assert_eq!(parse_keyscan("host ssh-ed25519\n"), Vec::new());
    }

    #[test]
    fn a_line_with_more_than_three_fields_is_stored_whole() {
        // The stored value is the RAW line, not one rebuilt from its first three fields. A comment
        // after the key is a legal `known_hosts` line, and the doc above used to claim the line was
        // reassembled from the parts — which it never was, and should not be: the longer forms the
        // format allows carry meaning in the fields a three-field rebuild would drop.
        let out = "backup.example.org ssh-ed25519 AAAA depsis\n";
        let keys = parse_keyscan(out);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].kind, "ssh-ed25519");
        assert_eq!(keys[0].line, "backup.example.org ssh-ed25519 AAAA depsis");
    }

    #[test]
    fn trust_is_looked_up_the_way_ssh_looks_it_up() {
        let known = "backup.example.org ssh-ed25519 AAAA\n\
                     [other.example.org]:2222 ssh-ed25519 BBBB\n";

        assert!(trusts(known, &host("backup.example.org"), 22));
        // A non-default port is a DIFFERENT entry, and matching it against the bare name would
        // trust a key nobody confirmed for that port.
        assert!(!trusts(known, &host("backup.example.org"), 2222));
        assert!(trusts(known, &host("other.example.org"), 2222));
        assert!(!trusts(known, &host("other.example.org"), 22));
        assert!(!trusts(known, &host("evil.example.org"), 22));
    }

    #[test]
    fn a_comma_separated_entry_still_matches() {
        // `ssh-keyscan` and hand-edited files both produce `host,1.2.3.4 ssh-ed25519 …`. A lookup
        // that compared the whole first field would report the host as untrusted, and the user
        // would have no way to make the refusal stop.
        let known = "backup.example.org,192.0.2.10 ssh-ed25519 AAAA\n";
        assert!(trusts(known, &host("backup.example.org"), 22));
        assert!(trusts(known, &host("192.0.2.10"), 22));
        assert!(!trusts(known, &host("example.org"), 22));
    }

    #[test]
    fn a_commented_out_entry_does_not_count_as_trust() {
        // Somebody disabling a host by commenting it out must not still be trusted by it.
        let known = "# backup.example.org ssh-ed25519 AAAA\n";
        assert!(!trusts(known, &host("backup.example.org"), 22));
    }

    #[test]
    fn the_generated_key_has_no_passphrase_and_does_not_overwrite() {
        let argv = keygen_argv(std::path::Path::new("/tmp/k"));
        assert!(argv.iter().any(|a| a == "ed25519"));
        // `-N ""` — an empty passphrase, because a passphrase an unattended daemon must supply is
        // a passphrase stored somewhere else.
        let n = argv.iter().position(|a| a == "-N").expect("-N is present");
        assert_eq!(argv.get(n + 1).map(String::as_str), Some(""));
        // `ssh-keygen` prompts before overwriting, and a prompt on a daemon's stdin never returns.
        // The dispatcher checks for an existing key FIRST; this asserts there is no force flag
        // here that would make it overwrite regardless of that check.
        assert!(!argv.iter().any(|a| a == "-y"));
        assert_eq!(argv.last().map(String::as_str), Some("/tmp/k"));
    }

    #[test]
    fn a_changed_host_key_is_its_own_answer() {
        assert!(host_key_changed(&SeamError::Io(
            "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@".to_string()
        )));
        assert!(host_key_changed(&SeamError::Io(
            "Host key verification failed.".to_string()
        )));
        assert!(!host_key_changed(&SeamError::Io(
            "Permission denied (publickey).".to_string()
        )));
    }
}
