//! The application engine's identity: who `depsis-apps` is on THIS box.
//!
//! Catalogue applications run under rootless podman as the `depsis-apps` account, and the kernel
//! maps their in-container ids onto the host deterministically: container 0 is the account
//! itself, container N (N ≥ 1) is the account's subordinate range at offset N − 1. When the API
//! asks for an application data folder, it names the id INSIDE the container — a fact of the
//! image, recorded in the catalogue — and this module answers which host id that becomes.
//!
//! Read from `/etc/passwd` and `/etc/subuid`/`/etc/subgid` directly rather than by exec'ing
//! `id`/`getsubids`: the files are the authority those tools read, the parse is three lines, and
//! a parse function takes a test without a process boundary.
//!
//! The security shape this preserves: `PosixId` keeps every system account unrepresentable in a
//! request, and this module does not weaken that — the caller still cannot name a host id. The
//! reachable owners are exactly {the engine account} ∪ {its subordinate ranges}, all of them
//! unprivileged, none of them a person's.

/// The account rootless podman runs under. Created by the installer/firstboot; a name, not a
/// number, because the uid differs per install and the box is the only authority on it.
pub const ENGINE_ACCOUNT: &str = "depsis-apps";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineIdentity {
    pub uid: u32,
    pub gid: u32,
    pub subuid_base: u32,
    pub subuid_count: u32,
    pub subgid_base: u32,
    pub subgid_count: u32,
}

impl EngineIdentity {
    /// The host uid a process running as `container_uid` inside the engine's user namespace
    /// actually is. `Err` carries the sentence for a refusal.
    pub fn host_uid(&self, container_uid: u32) -> Result<u32, String> {
        map(container_uid, self.uid, self.subuid_base, self.subuid_count)
    }

    pub fn host_gid(&self, container_gid: u32) -> Result<u32, String> {
        map(container_gid, self.gid, self.subgid_base, self.subgid_count)
    }
}

fn map(container_id: u32, own: u32, base: u32, count: u32) -> Result<u32, String> {
    if container_id == 0 {
        return Ok(own);
    }
    let offset = container_id - 1;
    if offset >= count {
        return Err(format!(
            "container id {container_id} is outside the engine's subordinate range of {count}"
        ));
    }
    base.checked_add(offset)
        .ok_or_else(|| format!("subordinate id overflows: {base} + {offset}"))
}

/// Read the identity from the live system files.
pub fn load() -> Result<EngineIdentity, String> {
    let passwd = std::fs::read_to_string("/etc/passwd")
        .map_err(|e| format!("cannot read /etc/passwd: {e}"))?;
    let subuid = std::fs::read_to_string("/etc/subuid")
        .map_err(|e| format!("cannot read /etc/subuid: {e}"))?;
    let subgid = std::fs::read_to_string("/etc/subgid")
        .map_err(|e| format!("cannot read /etc/subgid: {e}"))?;
    from_files(&passwd, &subuid, &subgid)
}

/// The pure half of `load`, for tests.
pub fn from_files(passwd: &str, subuid: &str, subgid: &str) -> Result<EngineIdentity, String> {
    let (uid, gid) = account(passwd)
        .ok_or_else(|| format!("{ENGINE_ACCOUNT} is not in /etc/passwd; is podman set up?"))?;
    let (subuid_base, subuid_count) = range(subuid)
        .ok_or_else(|| format!("{ENGINE_ACCOUNT} has no /etc/subuid range; is podman set up?"))?;
    let (subgid_base, subgid_count) = range(subgid)
        .ok_or_else(|| format!("{ENGINE_ACCOUNT} has no /etc/subgid range; is podman set up?"))?;
    Ok(EngineIdentity {
        uid,
        gid,
        subuid_base,
        subuid_count,
        subgid_base,
        subgid_count,
    })
}

/// `login:x:uid:gid:...` — the first matching line wins, as it does for glibc.
fn account(passwd: &str) -> Option<(u32, u32)> {
    for line in passwd.lines() {
        let mut fields = line.split(':');
        if fields.next() != Some(ENGINE_ACCOUNT) {
            continue;
        }
        let _password = fields.next();
        let uid = fields.next().and_then(|f| f.parse::<u32>().ok())?;
        let gid = fields.next().and_then(|f| f.parse::<u32>().ok())?;
        return Some((uid, gid));
    }
    None
}

/// `login:base:count` — subuid(5). The first matching line wins; podman uses only the first too.
fn range(subid: &str) -> Option<(u32, u32)> {
    for line in subid.lines() {
        let mut fields = line.split(':');
        if fields.next() != Some(ENGINE_ACCOUNT) {
            continue;
        }
        let base = fields.next().and_then(|f| f.parse::<u32>().ok())?;
        let count = fields.next().and_then(|f| f.parse::<u32>().ok())?;
        return Some((base, count));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/bash\n\
                          depsis-apps:x:1001:1001::/home/depsis-apps:/usr/sbin/nologin\n";
    const SUBUID: &str = "someone:100000:65536\ndepsis-apps:165536:65536\n";
    const SUBGID: &str = "depsis-apps:165536:65536\n";

    fn identity() -> EngineIdentity {
        match from_files(PASSWD, SUBUID, SUBGID) {
            Ok(id) => id,
            Err(why) => unreachable!("fixture identity must parse: {why}"),
        }
    }

    #[test]
    fn container_root_is_the_engine_account_itself() {
        assert_eq!(identity().host_uid(0), Ok(1001));
        assert_eq!(identity().host_gid(0), Ok(1001));
    }

    /// The mapping the kernel applies: container 33 (`www-data` in Debian-family images) is the
    /// 33rd subordinate id, i.e. base + 32. Off-by-one here silently owns the folder to the
    /// neighbouring identity, which no test of "does it error" would catch.
    #[test]
    fn a_service_uid_lands_at_base_plus_id_minus_one() {
        assert_eq!(identity().host_uid(33), Ok(165_568));
    }

    #[test]
    fn an_id_past_the_subordinate_range_is_an_error_not_a_wrap() {
        assert!(identity().host_uid(65_537).is_err());
        assert_eq!(identity().host_uid(65_536), Ok(165_536 + 65_535));
    }

    #[test]
    fn a_missing_account_names_the_repair() {
        let err = match from_files("root:x:0:0::/root:/bin/bash\n", SUBUID, SUBGID) {
            Err(why) => why,
            Ok(_) => unreachable!("an absent account must not parse"),
        };
        assert!(err.contains("depsis-apps"), "{err}");
    }

    /// `deps` is not `depsis-apps`: the parse must match the whole login, not a prefix — a
    /// prefix match against /etc/passwd is how another account's uid gets used.
    #[test]
    fn a_prefix_of_the_login_does_not_match() {
        let passwd = "depsis-apps-old:x:1500:1500::/home/x:/usr/sbin/nologin\n\
                      depsis-apps:x:1001:1001::/home/depsis-apps:/usr/sbin/nologin\n";
        let Ok(id) = from_files(passwd, SUBUID, SUBGID) else {
            unreachable!("fixture must parse");
        };
        assert_eq!(id.uid, 1001);
    }
}
