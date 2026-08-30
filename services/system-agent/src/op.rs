//! The operation surface. This file IS the trust boundary's contract.
//!
//! ADR-0006: the schema is owned by Rust, not by TypeScript. The side that *enforces* a
//! boundary must define it — otherwise the privileged side conforms to a definition written
//! by the unprivileged side, and a relaxed zod schema on the API silently widens what the
//! agent accepts.
//!
//! Two properties matter more than anything else here:
//!
//!   1. The enum is CLOSED. There is no `Raw(String)`, no `Passthrough`, no escape hatch that
//!      accepts a command line. Adding an operation is a deliberate act visible in a diff.
//!   2. Every operand is TYPED. A dataset name is not a string the caller can fill with
//!      `--force`; it is a `DatasetName` that rejects anything a ZFS command could misread as
//!      a flag. Validation happens here, before any of it reaches a process.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Why an operand was rejected. Kept separate from execution errors: these are refusals at the
/// boundary, and they are the ones worth alerting on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("empty value")]
    Empty,
    #[error("too long: {len} > {max}")]
    TooLong { len: usize, max: usize },
    #[error("too short: {len} < {min}")]
    TooShort { len: usize, min: usize },
    #[error("starts with '-', which a command-line tool would read as a flag")]
    LeadingDash,
    #[error("contains a NUL byte")]
    ContainsNul,
    #[error("contains a path separator")]
    ContainsSeparator,
    #[error("contains '..'")]
    ContainsDotDot,
    #[error("character {0:?} is not allowed here")]
    IllegalChar(char),
}

/// A ZFS dataset name, e.g. `tank/depsis/users/1001`.
///
/// The leading-dash check is not paranoia: P0-E's whole point is that `zfs`, `zpool`,
/// `smbcacls` and `smartctl` parse their own argv, so an operand that begins with `-` becomes a
/// flag even when it arrives as a separate argument. Inserting `--` helps but is not sufficient
/// because these tools do not all honour it consistently, so the value is rejected outright.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct DatasetName(String);

impl DatasetName {
    const MAX: usize = 255;

    pub fn parse(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(ValidationError::Empty);
        }
        if s.len() > Self::MAX {
            return Err(ValidationError::TooLong {
                len: s.len(),
                max: Self::MAX,
            });
        }
        if s.starts_with('-') {
            return Err(ValidationError::LeadingDash);
        }
        if s.contains('\0') {
            return Err(ValidationError::ContainsNul);
        }
        for component in s.split('/') {
            if component.is_empty() || component == "." || component == ".." {
                return Err(ValidationError::ContainsDotDot);
            }
        }
        // ZFS permits a restricted set; anything outside it cannot name a real dataset, so
        // accepting it would only widen the surface.
        if let Some(bad) = s
            .chars()
            .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | ':')))
        {
            return Err(ValidationError::IllegalChar(bad));
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for DatasetName {
    type Error = ValidationError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<DatasetName> for String {
    fn from(v: DatasetName) -> Self {
        v.0
    }
}

/// A single path component under a share root — never a path, never absolute.
///
/// ADR-0005 forbids treating a path as identity, and ADR-0006 confines every filesystem access
/// to `openat2(RESOLVE_BENEATH)` from a long-lived root fd. Both break if a caller can smuggle
/// `/` or `..` through, so this type refuses them rather than sanitising.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct SafeComponent(String);

impl SafeComponent {
    const MAX: usize = 255;

    pub fn parse(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(ValidationError::Empty);
        }
        if s.len() > Self::MAX {
            return Err(ValidationError::TooLong {
                len: s.len(),
                max: Self::MAX,
            });
        }
        if s.starts_with('-') {
            return Err(ValidationError::LeadingDash);
        }
        if s.contains('\0') {
            return Err(ValidationError::ContainsNul);
        }
        if s.contains('/') || s.contains('\\') {
            return Err(ValidationError::ContainsSeparator);
        }
        if s == "." || s == ".." {
            return Err(ValidationError::ContainsDotDot);
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SafeComponent {
    type Error = ValidationError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<SafeComponent> for String {
    fn from(v: SafeComponent) -> Self {
        v.0
    }
}

/// Yedek diskinin parolası — ZFS'in kendi anahtarı olarak.
///
/// ── NEDEN AYRI BİR TİP ───────────────────────────────────────────────────────────────────────
///
/// Bu, ajanın gördüğü tek KULLANICI SIRRIDIR ve `String` olarak taşınamaz. Üç sebep, üçü de bir
/// `String`in kendiliğinden yaptığı şeyler:
///
/// BİR — `Debug`. Bu depoda hemen her tip `#[derive(Debug)]` taşıyor ve istekler hata
/// mesajlarında, `unexpected request` dallarında ve panik yollarında basılıyor. Bir `String`
/// parola, ilk beklenmedik istekte journald'a düz metin olarak düşerdi. Buradaki `Debug`
/// elle yazılmış ve içeriği ASLA basmıyor.
///
/// İKİ — SATIR SONU. Parola `zfs load-key`e stdin'den, bir satır olarak veriliyor. İçinde satır
/// sonu olan bir parola, ZFS'e parolanın yalnız ilk parçasını verirdi: disk kurulurken kabul
/// edilen değerle sonra açarken verilen değer birbirini tutmazdı, ve kullanıcı "parolam doğru
/// ama açılmıyor" derdi. Reddetmek, sessizce kesmekten iyi.
///
/// ÜÇ — UZUNLUK. Alt sınır ZFS'in kendi kuralı (`keyformat=passphrase` en az sekiz bayt ister);
/// üst sınır kontrol soketinin istek satırına sığmak için. İkisi de burada reddediliyor ki
/// kullanıcı hatayı diski kurarken görsün, kurduktan sonra değil.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct Passphrase(String);

impl Passphrase {
    /// ZFS'in `keyformat=passphrase` için alt sınırı.
    pub const MIN: usize = 8;
    /// İstek satırı sınırının (`MAX_REQUEST_BYTES`) çok altında bir tavan.
    pub const MAX: usize = 512;

    pub fn parse(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let s: String = raw.into();
        if s.len() < Self::MIN {
            return Err(ValidationError::TooShort {
                len: s.len(),
                min: Self::MIN,
            });
        }
        if s.len() > Self::MAX {
            return Err(ValidationError::TooLong {
                len: s.len(),
                max: Self::MAX,
            });
        }
        if s.contains('\0') {
            return Err(ValidationError::ContainsNul);
        }
        // Satır sonu, stdin'e bir satır olarak yazılan bir değerde bir sonlandırıcıdır.
        if let Some(bad) = s.chars().find(|c| *c == '\n' || *c == '\r') {
            return Err(ValidationError::IllegalChar(bad));
        }
        Ok(Self(s))
    }

    /// Yalnız `zfs`in stdin'ine yazan yer okur.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

/// İçeriği ASLA basmıyor — bu tipin var olma sebeplerinden biri.
impl std::fmt::Debug for Passphrase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Uzunluk bile yazılmıyor: kısa bir parolanın kısa olduğunu söylemek, kaba kuvvet
        // denemesini daraltan bir bilgidir.
        f.write_str("Passphrase(<gizli>)")
    }
}

impl TryFrom<String> for Passphrase {
    type Error = ValidationError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<Passphrase> for String {
    fn from(v: Passphrase) -> Self {
        v.0
    }
}

/// Why a POSIX id was rejected.
///
/// Two variants rather than one, because 0 is the common mistake and deserves the sentence that
/// names it. Everything else is the same fault seen from further away — a number the API mapped
/// wrongly — but "root" points at a specific missing step.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PosixIdError {
    #[error(
        "0 is root; supply the user's mapped uid and gid. A directory owned by root at 0750 is          one the tenant cannot enter, and an entry for the root group grants nothing while          READING as a grant"
    )]
    Root,
    #[error(
        "{got} is outside the reserved DEPSIS range {min}-{max}: it belongs to the host's own          accounts, and handing a tenant's data to one of them (33 is www-data, 27 is sudo, 42 is          shadow) is what the reserved range exists to prevent"
    )]
    OutOfRange { got: u32, min: u32, max: u32 },
}

/// A numeric POSIX uid or gid, inside the range migration 0015 reserved for DEPSIS.
///
/// A type rather than a comparison, for the reason `AclType` is a type: the agent exists not to
/// trust the API, and a rule the API is asked to follow is not a rule the agent enforces. Before
/// this, the privileged side refused the value 0 and nothing else — so uid 33 (`www-data`), gid 27
/// (`sudo`), gid 42 (`shadow`) and the appliance's own service accounts were all accepted operands
/// of `PublishTransfer`, `CreateDirectory` and `AclEntry`. The 300000-399999 range that 0015
/// introduced *precisely* so that "sistem gruplarıyla çakışan bir gid, cihazdaki bir servis
/// hesabına kullanıcının dosyalarını açmaktır" was enforced in exactly two places, both
/// unprivileged: the `CHECK` constraints and `assertUsable` in `posix.service.ts`.
///
/// The agent's own stated reason for refusing 0 — an API that skipped the uid mapping must fail
/// loudly here — applies with the same force to an API that mapped it to the WRONG number, and
/// that was the case being waved through. Now a system id cannot be expressed in a request at all,
/// the same way `nfsv4` cannot be expressed at dataset creation.
///
/// The bounds are duplicated from `0015_teams_and_grants.sql` rather than read from anywhere. That
/// is deliberate and it is the point: the agent must not depend on the database to know what it
/// will accept, because the database is on the unprivileged side of the boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "u32", into = "u32")]
pub struct PosixId(u32);

/// Why a login name was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PosixNameError {
    #[error("empty login")]
    Empty,
    #[error("login is {len} characters; the limit is {max}")]
    TooLong { len: usize, max: usize },
    #[error("login must start with a letter or digit, not {0:?}")]
    BadStart(char),
    #[error("character {0:?} is not allowed in a login")]
    IllegalChar(char),
}

/// A Unix login name the agent is willing to create.
///
/// THE ONE CALLER-SUPPLIED STRING IN THE IDENTITY OPERATION, and it is supplied for a reason worth
/// stating: the alternative is deriving the account name from the uid, which works perfectly and
/// tells a person to type `depsis-u-300001` into Windows. Group names ARE derived, because nobody
/// types one.
///
/// The shape is exactly migration 0010's `users_username_format` — `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
/// — re-stated here rather than inherited, because §2.2 is that the agent does not trust the API.
/// Debian's `useradd` was measured accepting every string this admits, leading digits, uppercase
/// and 64 characters included, so a name the database allows is a name the agent can create.
///
/// What it CANNOT express is the shape that would matter: no NUL, no slash, no leading dash, no
/// space. A name beginning with a dash would become a flag to `useradd` — and unlike `zfs`, which
/// at least fails, `useradd -M` would be read as a valid option.
///
/// It does NOT prevent naming a system account: `root` and `postgres` both match. That check
/// cannot be a type because it is a question about the machine, and `identity::sync` asks it
/// against `getent` before creating anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct PosixName(String);

impl PosixName {
    const MAX: usize = 64;

    pub fn parse(raw: impl Into<String>) -> Result<Self, PosixNameError> {
        let s: String = raw.into();
        let mut chars = s.chars();
        let Some(first) = chars.next() else {
            return Err(PosixNameError::Empty);
        };
        if s.chars().count() > Self::MAX {
            return Err(PosixNameError::TooLong {
                len: s.chars().count(),
                max: Self::MAX,
            });
        }
        if !first.is_ascii_alphanumeric() {
            return Err(PosixNameError::BadStart(first));
        }
        for ch in s.chars() {
            if !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-') {
                return Err(PosixNameError::IllegalChar(ch));
            }
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for PosixName {
    type Error = PosixNameError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<PosixName> for String {
    fn from(value: PosixName) -> Self {
        value.0
    }
}

/// Why an NT hash was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NtHashError {
    #[error("an NT hash is 32 hex characters; got {0}")]
    WrongLength(usize),
    #[error("character {0:?} is not uppercase hex")]
    NotHex(char),
}

/// An NTLM password hash — `MD4(UTF-16LE(password))`, uppercase hex.
///
/// A TYPE rather than a `String`, because the failure it prevents is silent. The smbpasswd import
/// format is fixed-width: a lowercase or short field produces a line `pdbedit` accepts and a user
/// who cannot log in, with no error anywhere. `tools/poc/p2-b-smb-password.sh` measured that shape
/// of failure from the other direction with the `LCT` field.
///
/// The agent never computes this and never sees a password. The API computes it — see
/// `apps/api/src/auth/nt-hash.ts`, which carries its own MD4 because OpenSSL 3 moved MD4 to the
/// legacy provider and Node cannot reach it. What crosses the boundary is password-EQUIVALENT for
/// one protocol, which is worse than nothing and much better than the user's actual password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct NtHash(String);

impl NtHash {
    pub fn parse(raw: impl Into<String>) -> Result<Self, NtHashError> {
        let s: String = raw.into();
        if s.len() != 32 {
            return Err(NtHashError::WrongLength(s.len()));
        }
        for ch in s.chars() {
            if !(ch.is_ascii_digit() || ('A'..='F').contains(&ch)) {
                return Err(NtHashError::NotHex(ch));
            }
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for NtHash {
    type Error = NtHashError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<NtHash> for String {
    fn from(value: NtHash) -> Self {
        value.0
    }
}

/// One account the appliance must have, as the wire carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PosixUserSpec {
    pub uid: PosixId,
    pub login: PosixName,
    /// Absent leaves the existing password alone. A user who has not set one since this feature
    /// existed has no passdb entry at all, which is the honest state rather than a broken one:
    /// they cannot reach SMB until they next change their password.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nt_hash: Option<NtHash>,
}

/// One group and the membership it must END UP with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PosixGroupSpec {
    pub gid: PosixId,
    /// EXACT, not additive. `gpasswd -M` replaces the whole list, which is what makes a member who
    /// left the team actually leave the group — an additive sync would let their ACL access
    /// outlive the grant that justified it.
    pub members: Vec<PosixId>,
}

impl PosixId {
    pub const MIN: u32 = 300_000;
    pub const MAX: u32 = 399_999;

    pub fn parse(value: u32) -> Result<Self, PosixIdError> {
        if value == 0 {
            return Err(PosixIdError::Root);
        }
        if !(Self::MIN..=Self::MAX).contains(&value) {
            return Err(PosixIdError::OutOfRange {
                got: value,
                min: Self::MIN,
                max: Self::MAX,
            });
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl TryFrom<u32> for PosixId {
    type Error = PosixIdError;
    fn try_from(v: u32) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<PosixId> for u32 {
    fn from(v: PosixId) -> Self {
        v.0
    }
}

/// Why a network id was rejected.
///
/// Its own enum rather than a reuse of `ValidationError`, because the two describe different
/// kinds of value. A dataset name is a name with forbidden characters; a network id is a
/// fixed-width number. Folding them together would make a fifteen-digit id report "character is
/// not allowed here", which points the operator at the wrong half of their input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NetworkIdError {
    #[error("empty value")]
    Empty,
    #[error("a network id is exactly {expected} hex digits; this one is {len} bytes")]
    WrongLength { len: usize, expected: usize },
    #[error("uppercase hex digit {ch:?} at byte {at}; a network id is written in lowercase")]
    Uppercase { at: usize, ch: char },
    #[error("byte {at} is {ch:?}, which is not a hex digit")]
    NotHex { at: usize, ch: char },
}

/// A host name or address that may be handed to `ssh` and to `ssh-keyscan`.
///
/// Its own type for the reason `NetworkId` has one, with the stakes a level higher: the value
/// becomes an argv element for a program that takes `-o` options, so a "hostname" of
/// `-oProxyCommand=id` is arbitrary command execution ON THIS BOX. It also becomes half of a
/// `known_hosts` lookup key, where a stray `[`, `]` or `:` silently matches the wrong entry — and
/// the whole point of that file is that it matches the right one.
///
/// IPv6 LITERALS ARE REFUSED rather than half-supported. `known_hosts` brackets them and so does
/// the non-default-port syntax; accepting a bare literal here would produce a key that matches
/// nothing, which reads to the user as "this host is not trusted" forever with no way to fix it.
/// An IPv6 destination therefore needs a name, and that is written down rather than discovered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct SshHostName(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SshNameError {
    #[error("empty value")]
    Empty,
    #[error("{len} bytes is longer than the {max} a name may be")]
    TooLong { len: usize, max: usize },
    #[error("a leading '-' would be read as an option by ssh")]
    LeadingDash,
    #[error("byte {at} is {ch:?}, which is not allowed in a host or user name")]
    IllegalChar { at: usize, ch: char },
}

impl SshHostName {
    const MAX: usize = 253;

    pub fn parse(raw: impl Into<String>) -> Result<Self, SshNameError> {
        let s: String = raw.into();
        check(&s, Self::MAX, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-')
        })?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SshHostName {
    type Error = SshNameError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<SshHostName> for String {
    fn from(v: SshHostName) -> Self {
        v.0
    }
}

/// The account on the far end. Same argument as `SshHostName`, one character narrower.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct SshUserName(String);

impl SshUserName {
    const MAX: usize = 32;

    pub fn parse(raw: impl Into<String>) -> Result<Self, SshNameError> {
        let s: String = raw.into();
        check(&s, Self::MAX, |c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')
        })?;
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SshUserName {
    type Error = SshNameError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<SshUserName> for String {
    fn from(v: SshUserName) -> Self {
        v.0
    }
}

/// The three refusals both names share, in one place so they cannot drift apart.
fn check(s: &str, max: usize, allowed: impl Fn(char) -> bool) -> Result<(), SshNameError> {
    if s.is_empty() {
        return Err(SshNameError::Empty);
    }
    if s.len() > max {
        return Err(SshNameError::TooLong { len: s.len(), max });
    }
    if s.starts_with('-') {
        return Err(SshNameError::LeadingDash);
    }
    if let Some((at, ch)) = s.char_indices().find(|(_, c)| !allowed(*c)) {
        return Err(SshNameError::IllegalChar { at, ch });
    }
    Ok(())
}

/// A `known_hosts` line, as `ssh-keyscan` printed it and as it will be stored.
///
/// Validated as a WHOLE LINE rather than trusted, because it is written into a file `ssh` reads
/// with the authority to decide which machine a copy of every file on this appliance goes to. A
/// newline in it would let one confirmation write two entries — the second for a host nobody was
/// shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct KnownHostsLine(String);

impl KnownHostsLine {
    const MAX: usize = 2048;

    pub fn parse(raw: impl Into<String>) -> Result<Self, SshNameError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(SshNameError::Empty);
        }
        if s.len() > Self::MAX {
            return Err(SshNameError::TooLong {
                len: s.len(),
                max: Self::MAX,
            });
        }
        // Three fields at least — a truncated entry makes `ssh` refuse to read the whole file,
        // which would break every destination at once rather than just this one.
        if s.split_whitespace().count() < 3 {
            return Err(SshNameError::IllegalChar { at: 0, ch: ' ' });
        }
        if let Some((at, ch)) = s
            .char_indices()
            .find(|(_, c)| *c == '\n' || *c == '\r' || *c == '\0')
        {
            return Err(SshNameError::IllegalChar { at, ch });
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for KnownHostsLine {
    type Error = SshNameError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<KnownHostsLine> for String {
    fn from(v: KnownHostsLine) -> Self {
        v.0
    }
}

/// A ZeroTier node address: exactly ten lowercase hexadecimal digits.
///
/// Its own type next to `NetworkId`, for the same reason and with one extra. It is CONCATENATED
/// INTO A REQUEST PATH (`/controller/network/<nwid>/member/<address>`), so a `String` here would
/// have to be remembered at every call site. And it is the value an administrator TYPES from a
/// friend's screen — the one operand in this whole surface that arrives by human transcription —
/// so the shape check is also the typo check.
///
/// NOT A CREDENTIAL. The address is the low 40 bits of a node's public identity; the controller
/// authenticates with the full identity and pins it on first contact, refusing any later node that
/// presents the same address with a different identity. So it is safe to display, copy and put in
/// a QR code. What it is NOT is safe to get wrong: authorizing one wrong digit admits a real
/// stranger's node, and until that node first appears there is nothing on screen to say so.
///
/// Uppercase is REFUSED rather than folded, exactly as `NetworkId` refuses it: the controller
/// emits lowercase everywhere, and accepting two spellings means the audit trail and the member
/// list can hold both and "is this the device we authorized?" stops being a string comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct NodeAddress(String);

impl NodeAddress {
    /// A node address is a 40-bit number written as 10 hex digits. Not a maximum — the exact
    /// width, which is why the check is `!=` rather than `>`.
    pub const LEN: usize = 10;

    pub fn parse(raw: impl Into<String>) -> Result<Self, NetworkIdError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(NetworkIdError::Empty);
        }
        if s.len() != Self::LEN {
            return Err(NetworkIdError::WrongLength {
                len: s.len(),
                expected: Self::LEN,
            });
        }
        for (at, ch) in s.char_indices() {
            if ch.is_ascii_uppercase() {
                return Err(NetworkIdError::Uppercase { at, ch });
            }
            if !ch.is_ascii_hexdigit() {
                return Err(NetworkIdError::NotHex { at, ch });
            }
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for NodeAddress {
    type Error = NetworkIdError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<NodeAddress> for String {
    fn from(v: NodeAddress) -> Self {
        v.0
    }
}

/// The IPv4 range a controller-hosted network hands out: `a.b.c.0/24`, and nothing else.
///
/// ONLY /24, and only RFC1918. Both narrowings are deliberate.
///
/// A /24 because the alternative is arithmetic: a pool and a route have to be derived from the
/// prefix, and deriving them for an arbitrary length means computing broadcast addresses and
/// usable ranges in a root daemon for no gain a household will ever notice. 254 addresses is more
/// devices than a house has.
///
/// RFC1918 because the value becomes a ROUTE pushed to every member. A public range here would
/// silently blackhole part of the real internet on every device that joins — and the person who
/// typed it would experience that as "the internet broke after I set up remote access", with
/// nothing connecting the two.
///
/// What this type CANNOT check is the one collision that actually happens: the household's own
/// LAN. `192.168.1.0/24` is a legal RFC1918 /24 and it is also the most common home network in
/// the world, and a member sitting at home would get a route that fights their own router. The
/// interface defaults away from the common ranges and says so; the type cannot know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct Ipv4Prefix(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Ipv4PrefixError {
    #[error("empty value")]
    Empty,
    #[error("expected a.b.c.0/24")]
    Malformed,
    #[error("only /24 is supported; got /{got}")]
    NotSlash24 { got: u32 },
    #[error("{octet} is not an octet")]
    BadOctet { octet: String },
    #[error("the last octet of a /24 must be 0; got {got}")]
    NonZeroHost { got: u8 },
    #[error("{addr} is not a private range (RFC1918)")]
    NotPrivate { addr: String },
}

impl Ipv4Prefix {
    pub fn parse(raw: impl Into<String>) -> Result<Self, Ipv4PrefixError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(Ipv4PrefixError::Empty);
        }
        let (addr, len) = s.split_once('/').ok_or(Ipv4PrefixError::Malformed)?;
        let len: u32 = len.parse().map_err(|_| Ipv4PrefixError::Malformed)?;
        if len != 24 {
            return Err(Ipv4PrefixError::NotSlash24 { got: len });
        }

        let parts: Vec<&str> = addr.split('.').collect();
        if parts.len() != 4 {
            return Err(Ipv4PrefixError::Malformed);
        }
        let mut octets = [0u8; 4];
        for (slot, part) in octets.iter_mut().zip(parts.iter()) {
            // Leading zeros REFUSED: `010` is decimal ten here and octal eight to some parsers,
            // and a value that means two things is a value nobody can check by reading.
            if part.is_empty() || (part.len() > 1 && part.starts_with('0')) {
                return Err(Ipv4PrefixError::BadOctet {
                    octet: (*part).to_string(),
                });
            }
            *slot = part.parse().map_err(|_| Ipv4PrefixError::BadOctet {
                octet: (*part).to_string(),
            })?;
        }
        if octets[3] != 0 {
            return Err(Ipv4PrefixError::NonZeroHost { got: octets[3] });
        }

        let private = octets[0] == 10
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))
            || (octets[0] == 192 && octets[1] == 168);
        if !private {
            return Err(Ipv4PrefixError::NotPrivate {
                addr: addr.to_string(),
            });
        }

        Ok(Self(format!(
            "{}.{}.{}.0/24",
            octets[0], octets[1], octets[2]
        )))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `a.b.c.` — the first three octets with the trailing dot, for building host addresses.
    fn base(&self) -> String {
        let dropped = self.0.trim_end_matches("0/24");
        dropped.to_string()
    }

    /// The first usable host. `.1` is conventional and is what the appliance itself tends to get.
    pub fn first_host(&self) -> String {
        format!("{}1", self.base())
    }

    /// The last usable host. `.254`, leaving `.255` as broadcast.
    pub fn last_host(&self) -> String {
        format!("{}254", self.base())
    }
}

impl TryFrom<String> for Ipv4Prefix {
    type Error = Ipv4PrefixError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<Ipv4Prefix> for String {
    fn from(v: Ipv4Prefix) -> Self {
        v.0
    }
}

/// A ZeroTier network id: exactly sixteen lowercase hexadecimal digits.
///
/// Its own type, next to `SafeComponent`, for the same reason and one more. The value is
/// CONCATENATED INTO A REQUEST PATH (`/network/<id>`) and into an HTTP request line, so a
/// `String` here would have to be remembered at every call site — and the site that forgot
/// would be the one that let `../` reach the local API's router, or a `\r\n` split one request
/// into two. A type is a validation nobody can skip.
///
/// Uppercase is REFUSED rather than folded to lowercase. ZeroTier prints ids in lowercase and
/// the same value is a key in `public.remote_networks`, so accepting two spellings for one
/// network means the audit trail and the table can end up holding both, and "is this the
/// network we joined?" stops being a string comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct NetworkId(String);

impl NetworkId {
    /// A ZeroTier network id is a 64-bit number written as 16 hex digits. Not a maximum — the
    /// exact width, which is why the check is `!=` rather than `>`.
    pub const LEN: usize = 16;

    pub fn parse(raw: impl Into<String>) -> Result<Self, NetworkIdError> {
        let s: String = raw.into();
        if s.is_empty() {
            return Err(NetworkIdError::Empty);
        }
        // Bytes, deliberately. A multi-byte string that happens to be 16 bytes long passes this
        // check and is then caught digit by digit below, so nothing gets in on a technicality.
        if s.len() != Self::LEN {
            return Err(NetworkIdError::WrongLength {
                len: s.len(),
                expected: Self::LEN,
            });
        }
        for (at, ch) in s.char_indices() {
            if matches!(ch, '0'..='9' | 'a'..='f') {
                continue;
            }
            if matches!(ch, 'A'..='F') {
                return Err(NetworkIdError::Uppercase { at, ch });
            }
            return Err(NetworkIdError::NotHex { at, ch });
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for NetworkId {
    type Error = NetworkIdError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(v)
    }
}

impl From<NetworkId> for String {
    fn from(v: NetworkId) -> Self {
        v.0
    }
}

/// The ACL type a dataset may be created with.
///
/// `Nfsv4` is deliberately ABSENT and unrepresentable. P0-B measured what happens on
/// ZFS-on-Linux: `zfs set acltype=nfsv4` succeeds, `zfs get` reports `nfsv4`, and ACLs do not
/// work at all — with no error anywhere. A validation that merely checks "acltype is not empty"
/// or "is not off" walks straight into it. Making the value impossible to express is stronger
/// than checking for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AclType {
    /// The only type the Linux kernel actually enforces on ZFS (ADR-0004).
    Posixacl,
}

/// The closed operation set.
///
/// Every variant is something the API cannot do for itself because it needs root. Nothing here
/// takes a command, a shell fragment, or a free-form argument list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
// `deny_unknown_fields` is not pedantry here. Serde's default is to ignore a field it does not
// recognise, so an API that sends `refquota` instead of `refquota_bytes` would get a dataset with
// no quota at all, successfully, with no error anywhere — the exact silent-failure shape Phase 0
// kept measuring. Refusing the request turns a typo into a startup-time integration failure
// instead of an unbounded share discovered when the pool fills.
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Liveness plus a schema-version handshake, so a mismatched API build fails loudly at
    /// startup instead of on the first privileged call.
    /// An empty struct variant, not a unit variant, and the braces are load-bearing.
    /// `deny_unknown_fields` has no effect on a unit variant of an internally tagged enum —
    /// serde deserializes it by ignoring the rest of the map — so `{"op":"ping","x":1}` would
    /// parse. Every other variant refuses unknown fields; a rule with one silent exception is
    /// the kind of thing that is forgotten the day a second unit variant is added.
    Ping {},

    /// Report pool health and capacity. Reads `zfs get`, never `statvfs` — P0-G measured
    /// statvfs disagreeing with the dataset by ~131 kB on a 32 MB dataset (ADR-0008).
    PoolStatus { pool: DatasetName },

    CreateDataset {
        dataset: DatasetName,
        /// Only `posixacl` is expressible. See `AclType`.
        acltype: AclType,
        /// Per-user visible limit. `refquota` excludes snapshots, so admin snapshot policy
        /// cannot block a user out of their own space (ADR-0008).
        refquota_bytes: Option<u64>,
    },

    CreateSnapshot {
        dataset: DatasetName,
        name: SafeComponent,
    },

    /// Who this node can see, and how it is reaching them.
    ///
    /// The diagnostic `ZerotierStatus` and `ZerotierNetworks` cannot give: both report "online"
    /// and "joined" for a link whose every byte is being relayed through a ZeroTier root, which is
    /// correct and an order of magnitude slower. No operands.
    #[serde(rename = "zerotier_peers")]
    ZeroTierPeers {},

    /// Copy one dataset's snapshot onto another dataset, on THIS appliance.
    ///
    /// `zfs send | zfs recv`, and the most destructive operation in the set after `CreatePool`:
    /// `recv -F` destroys whatever is at the target and any snapshot newer than the base. Pointed
    /// at the share dataset it erases every tenant's files.
    ///
    /// Four refusals sit in front of it in `replicate::check` — same dataset, nested either way,
    /// the share root, inside the share tree — and §8.1's written confirmation and
    /// re-authentication sit in front of THOSE in the API. Neither is redundant: the API's
    /// sequence protects against a person in a hurry, and these refuse a request that reached the
    /// agent by any other route at all.
    ///
    /// NOT REPLICATION TO ANOTHER MACHINE. That needs a transport, a credential store and
    /// host-key verification, and none of it can be exercised here. This is the target a two-pool
    /// NAS has: a second set of disks.
    ReplicateDataset {
        /// The snapshot to send, as a name on `source`.
        source: DatasetName,
        snapshot: SafeComponent,
        /// Where it lands. `recv -F` DESTROYS what is here.
        target: DatasetName,
        /// A snapshot both sides already have, for an incremental send.
        ///
        /// Absent means a FULL send. The caller decides rather than the agent guessing: a full
        /// send of a terabyte is not something to start on the agent's own initiative, and the
        /// caller is the only side that knows what the target already holds.
        base: Option<SafeComponent>,
    },

    /// What snapshots this dataset ACTUALLY has.
    ///
    /// The read that was missing beside `CreateSnapshot`. DEPSIS could take a snapshot and record
    /// it, but never ask — so its backups list was a table, not an inventory, and the screen said
    /// so in a warning box. The failure direction is the one that costs data: a snapshot destroyed
    /// from a shell keeps its row, and the screen goes on offering a restore point that is gone.
    ///
    /// ONE OPERAND, and it is a validated `DatasetName`. `zfs list -t snapshot` with no operand
    /// walks every dataset on the box; on an appliance holding several tenants' shares that is one
    /// tenant being told what another has. The depth limit in the argv (`-d 1`) is the other half
    /// of the same fence.
    ListSnapshots { dataset: DatasetName },

    /// Diff two snapshots for reconciliation (ADR-0011 layer 3). Runs unprivileged via
    /// `zfs allow` — P0-D disproved the earlier belief that this needed root.
    DiffSnapshots {
        dataset: DatasetName,
        from: SafeComponent,
        to: SafeComponent,
    },

    ReadSmartSummary {
        /// Stable device identity only. `/dev/sdX` is rejected by construction because a
        /// by-id name is a `SafeComponent` under `/dev/disk/by-id` (risk R1).
        disk_by_id: SafeComponent,
    },

    /// What disks are in this box.
    ///
    /// NO OPERANDS, and that is the whole security argument for it: the caller cannot name a
    /// device, a path or a flag, so there is nothing here through which a `--force` or a second
    /// device could be smuggled. The agent runs one fixed argv and reports what it said.
    ///
    /// It exists because the closed set had no way to answer "what is in this box", and two
    /// things depended on the answer. `DEPSIS_SMART_DISKS` is a comma-separated list of
    /// `/dev/disk/by-id` names an operator types into a file by hand — a mistyped one graphs the
    /// temperature of nothing, and there was no way to offer a list to choose from. And §8.1
    /// requires every destructive storage operation to be preceded by an analysis naming the
    /// affected disks BY SERIAL/WWN; without an inventory that analysis cannot be produced, which
    /// is why pool creation has no wizard.
    ///
    /// READ ONLY, and structurally so rather than by intention: `lsblk` has no destructive mode
    /// and the argv is a constant in this crate.
    ListDisks {},

    /// Arka planda ne koşuyor — görev yöneticisinin okuma yarısı.
    ///
    /// SALT OKUR ve yapısal olarak öyle: /proc'tan okur, hiçbir argv yok. Her satır `protected`
    /// taşır — o bayrak, `KillProcess`'in aynı kuraldan reddedeceğinin önceden söylenmesi, ki
    /// arayüz kapatılamayacak bir sürece düğme çizmesin.
    #[serde(rename = "list_processes")]
    ListProcesses {},

    /// What pools this machine has.
    ///
    /// NO OPERANDS, for the same reason `ListDisks` has none. It exists because
    /// `DEPSIS_ZFS_POOLS` was a comma-separated list an operator typed into `api.env` — defensible
    /// while the pool was made at install time from a shell, and indefensible the moment the
    /// product could create one: the wizard finished and the pool it had just built appeared
    /// nowhere until somebody edited a file and restarted the API.
    ListPools {},

    /// Where DEPSIS serves shares from, and whether anything is there yet.
    ///
    /// NO OPERANDS. The path is the agent's OWN `DEPSIS_SHARES_ROOT` — a caller cannot ask about a
    /// directory of its choosing, which is what keeps this from being a filesystem probe.
    ///
    /// It answers the question `DEPSIS_SHARE_PARENT_DATASET` was configuration for. That variable
    /// had to name the dataset MOUNTED AT the shares root, and getting the pairing wrong produces
    /// an appliance that creates datasets nothing serves: the row exists, `zfs list` shows it, and
    /// the share is empty in the file manager. Asking the box removes the chance to get it wrong.
    ShareRootStatus {},

    /// Create the dataset DEPSIS serves shares from, on a pool, and mount it at the shares root.
    ///
    /// THE MOUNTPOINT IS NOT AN OPERAND. It is the agent's own `DEPSIS_SHARES_ROOT`, and the
    /// dataset name is derived as `<pool>/depsis`. That is the whole reason this exists as its own
    /// operation rather than as a flag on `CreateDataset`: ADR-0007 and `CreateDataset`'s own
    /// documentation refuse a mountpoint operand, because a caller that could choose one could
    /// mount a tenant's data anywhere on the box. Here the caller chooses the POOL and nothing
    /// else.
    ///
    /// Refused when the shares root already has a dataset mounted on it, and refused when the
    /// directory is not empty. The second is the one that matters: `zfs create -o mountpoint=X`
    /// happily mounts over a directory with files in it, and everything underneath disappears from
    /// view while still occupying the disk it is on.
    PrepareShareRoot { pool: SafeComponent },

    /// Create (or verify) the folder a catalogue application keeps its data in, inside a share,
    /// owned by the APP ENGINE's identity rather than a tenant's.
    ///
    /// Why `CreateDirectory` cannot do this: its owner operands are `PosixId`, and `PosixId`
    /// makes every system account unrepresentable ON PURPOSE. The application engine
    /// (`depsis-apps`, a rootless podman user) is exactly such an account — so this operation
    /// exists, and the caller does not name a host uid at all. It names the uid INSIDE THE
    /// CONTAINER (from the catalogue row: 33 for an image whose service is `www-data`, 0 for one
    /// that runs as container root), and the agent maps it the same way the kernel's user
    /// namespace will: 0 becomes the engine account itself, anything else becomes the engine's
    /// subuid range at the same offset. The worst a compromised API gets from this is a folder
    /// owned by some unprivileged app-engine id — never root, never a person.
    ///
    /// Idempotent: an existing folder with the right owner answers `ready` and touches nothing;
    /// an existing folder with the WRONG owner is refused with the repair in the sentence,
    /// because silently rechowning a folder that Samba users may have filled would move their
    /// files out from under their own permissions.
    PrepareAppDataDir {
        share: SafeComponent,
        directory: SafeComponent,
        container_uid: u32,
        container_gid: u32,
    },

    /// Create a ZFS pool. THE ONE DESTRUCTIVE STORAGE OPERATION IN THE SET.
    ///
    /// ADR-0007 does not forbid this — it keeps destructive operations out of a GENERIC storage
    /// interface and requires them to be written explicitly per backend, which is what this is —
    /// and §8.1 prescribes the sequence around it: analysis, plan, the serial/WWN list of the
    /// affected disks, written confirmation, re-authentication, job. `ListDisks` is the analysis;
    /// the API owns the middle; this is the end.
    ///
    /// THREE REFUSALS LIVE HERE AND NOT IN A DIALOGUE, because a dialogue is a thing somebody
    /// gets past:
    ///
    /// 1. A disk carrying `/`, `/boot` or `/boot/efi` is never a member. There is no confirmation
    ///    that makes overwriting the appliance's own disk a thing the operator meant.
    ///
    /// 2. The WWN named for each disk must match what the box reports at the moment the pool is
    ///    created. This closes the gap that risk R1 is really about: between the screen that
    ///    listed the disks and the button that creates the pool, a disk can be pulled and another
    ///    put in its place, and `/dev/disk/by-id` names identify a DEVICE rather than a slot — so
    ///    the same name can be a different disk. Checking the name alone would confirm nothing.
    ///
    /// 3. `-f` is never passed. `zpool create` refuses a device that already holds a filesystem
    ///    unless forced, and this operation does not force. Clearing a disk stays something an
    ///    operator does themselves, deliberately, with a shell — the product does not offer a
    ///    button for it, and an operation that could be talked into one would make the other two
    ///    refusals decorative.
    ///
    /// The pool is created with ADR-0004's properties as POOL-LEVEL defaults, so every dataset
    /// made in it inherits them. `CreateDataset` sets `acltype` per dataset; a pool whose default
    /// is `off` makes every dataset that forgets to say so a dataset with no ACLs, which is the
    /// failure ADR-0004 was rewritten about.
    CreatePool {
        /// The pool name. A `SafeComponent`, so it cannot contain `/` — a name with a slash in it
        /// would be a DATASET path, and `zpool create tank/x` is a different and confusing error.
        pool: SafeComponent,
        topology: PoolTopology,
        /// The members, each named twice.
        disks: Vec<DiskRef>,
    },

    /// Validate and atomically publish a Samba configuration.
    ///
    /// P0-B measured why `testparm` alone is not a sufficient gate: an invalid
    /// `full_audit:success` opname passes `testparm` cleanly and then makes smbd refuse every
    /// connection. The implementation must follow validation with a live connection smoke test
    /// and roll back on failure (ADR-0011, §17).
    PublishSambaConfig { shares: Vec<ShareSpec> },

    /// Open a staging file and hand back a one-time token for the bulk data channel.
    ///
    /// The API cannot write into a share itself. ADR-0008 says the durability sequence belongs
    /// to the agent, and the cleanest way to honour that — the agent opens with `openat2` and
    /// passes the descriptor over — is unreachable, because Node's `net` module has no
    /// ancillary-data support and therefore cannot receive an `SCM_RIGHTS` descriptor from a
    /// non-Node peer (checked against the Node documentation, not assumed).
    ///
    /// So the bytes travel instead. This operation resolves and opens the staging file under
    /// `openat2(RESOLVE_BENEATH)`, keeps the descriptor, and returns a token. The API then
    /// connects to the data socket, presents the token, and streams. The token names an
    /// ALREADY-RESOLVED file: nothing the API sends on the data socket can change which file it
    /// is writing to, which is what keeps the confinement meaningful across two connections.
    OpenTransfer {
        /// The share root this transfer is confined to.
        share: SafeComponent,
        /// The staging file, under `.depsis/staging/` inside that share.
        staging_name: SafeComponent,
    },

    /// Move a completed staging file into its place, durably.
    ///
    /// ADR-0008's sequence, steps 4 and 5: rename, then `fsync` the DESTINATION DIRECTORY. The
    /// second one is not optional — without it a power cut can lose the rename even though the
    /// file's own contents survived, which is the worst outcome available: the data is on disk
    /// and nothing points at it.
    ///
    /// Refuses if the destination exists. `RENAME_NOREPLACE` was measured working on ZFS 2.3.2
    /// in P0-G; the `linkat` + `unlink` form is the portable fallback. Either way a publish
    /// never silently overwrites a file the user already has.
    PublishTransfer {
        share: SafeComponent,
        staging_name: SafeComponent,
        /// Where it lands, relative to the share root. Components are validated individually.
        destination: Vec<SafeComponent>,
        /// How many bytes the caller believes are staged.
        ///
        /// Checked, not trusted. The agent must not rest on the API's belief that an upload
        /// finished (ADR-0006): a client that dies at 90% plus a buggy API would otherwise rename a
        /// short file to the user's chosen name, and RENAME_NOREPLACE then makes that name
        /// permanently unavailable to the good copy.
        expected_bytes: u64,
        /// Who owns the file once it lands.
        ///
        /// On PUBLISH rather than on `OpenTransfer`, deliberately. Staging happens inside the share
        /// — `.depsis/staging/` — so a staging file owned by the tenant is a file the tenant can
        /// reach over SMB and rewrite while the agent is still appending to it. Root-owned until
        /// the moment it becomes visible under its real name is the only window that closes.
        ///
        /// `PosixId` refuses 0 and refuses anything outside the reserved range. Not because a
        /// root-owned file in a share is a privilege escalation — it is not, the mode is 0600 and
        /// nothing is setuid — but because it is precisely the broken state these two fields exist
        /// to fix, and an API that omits or mis-maps the identity should fail loudly rather than
        /// hand a tenant's file to one of the host's own accounts.
        owner_uid: PosixId,
        owner_gid: PosixId,
    },

    /// Open a published file for reading, and hand back a one-time token for the data socket.
    ///
    /// The mirror of `OpenTransfer`, and it exists for the same reason: the unprivileged API cannot
    /// open a file inside a share. It has no descriptor and the file is not readable by its uid in
    /// the general case — a tenant's file belongs to the tenant — so the bytes have to come back
    /// through the agent, on the same socket they went out on.
    ///
    /// The token names an ALREADY-RESOLVED descriptor. Nothing on the data wire names a path, so a
    /// caller cannot widen a download into a file the control call did not confine, and the range
    /// it asks for is checked against the file the agent itself opened.
    OpenDownload {
        share: SafeComponent,
        /// Where the file is, relative to the share root. Components are validated individually,
        /// so no element can be `..`, a separator or an absolute-looking string.
        path: Vec<SafeComponent>,
    },

    /// Throw a staging file away.
    ///
    /// The missing half of the upload path, and its absence was a dead end rather than a gap:
    /// `.depsis/staging` counts against the user's `refquota`, Samba vetoes `/.depsis/` and the API
    /// filters the prefix server-side, so abandoned chunks are invisible to the user, undeletable
    /// by the user, undeletable by the API — which cannot write inside a share at all — and, until
    /// now, undeletable by the agent. Every failed checksum, every cancelled upload and every
    /// `EDQUOT` was permanent.
    ///
    /// Refused while a data connection is streaming. Unlinking a file a worker is still appending
    /// to leaves the worker writing to an unlinked inode and reporting success.
    DiscardTransfer {
        share: SafeComponent,
        staging_name: SafeComponent,
    },

    /// Move one entry to another name, inside one share.
    ///
    /// The same `renameat2(RENAME_NOREPLACE)` plus destination-directory `fsync` that
    /// `PublishTransfer` uses, aimed at a file the user already owns rather than at a staged one.
    /// Refusing to overwrite is not a convenience: a move that silently replaces the file already
    /// sitting at the destination destroys data the user never named, and there is no undo in this
    /// product.
    ///
    /// ONE share, not two, and the single `share` field is what enforces it. A rename across
    /// datasets returns `EXDEV` (ADR-0008) because every DEPSIS share is its own ZFS dataset, so a
    /// cross-share `MoveEntry` could only ever be a copy-then-delete — a different operation, with
    /// a different failure mode and a different cost, which therefore deserves its own name rather
    /// than a surprise inside this one.
    MoveEntry {
        share: SafeComponent,
        /// Where it is now, relative to the share root. The last element is the entry's own name.
        from: Vec<SafeComponent>,
        /// Where it goes, relative to the same share root. The last element is the new name; the
        /// elements before it must already exist and be directories.
        to: Vec<SafeComponent>,
    },

    /// Copy ONE file to ONE new name, inside one share.
    ///
    /// WHY THE AGENT DOES THE WHOLE COPY. The obvious shape is for the API to read the source over
    /// the data channel and write the destination back over it — the two halves already exist as
    /// `OpenTransfer`/`PublishTransfer`. That shape has a measured hazard: `unix.rs` hands data
    /// connections to `MAX_DATA_CONNECTIONS` worker threads over a rendezvous `sync_channel(0)`, so
    /// a connection is only accepted once a thread is free. Every operation that exists today holds
    /// exactly ONE connection. A copy done that way holds two at once, and that many concurrent
    /// copies each holding their read connection while waiting for a write connection no thread is
    /// free to accept is a hard deadlock of the entire data socket — every upload and every
    /// download on the appliance, not just the copies.
    ///
    /// Both ends are on the same machine and under the same root, so there is no reason for the
    /// bytes to cross the process boundary at all. The agent opens both descriptors under
    /// `RESOLVE_BENEATH` and copies between them; on Linux `std::io::copy` between two `File`s
    /// uses `copy_file_range(2)`, which on a copy-on-write filesystem can be near-instant and
    /// never leaves the kernel.
    ///
    /// ONE FILE, NEVER A TREE. The same rule as `RemoveEntry` and for the same reason (§2.2,
    /// ADR-0006): no single call the agent accepts may have a blast radius the caller chooses.
    /// "Copy this subtree" is a recursive walk behind a typed name. The API knows the tree because
    /// the API stores the tree; it issues one `CreateDirectory` per folder and one `CopyFile` per
    /// file, and the progress a user watches is that loop.
    ///
    /// IT GOES THROUGH STAGING, exactly as an upload does. The bytes land in `.depsis/staging/`
    /// under a caller-chosen name and are renamed into place with `RENAME_NOREPLACE` plus a
    /// destination-directory fsync — one `SafePath::publish`, the same call `PublishTransfer` and
    /// `MoveEntry` make. Writing directly at the destination would leave a half-written file under
    /// the user's chosen name if anything failed, and `RENAME_NOREPLACE` would then make the good
    /// copy's name permanently unusable.
    CopyFile {
        share: SafeComponent,
        /// The file to read, relative to the share root. The last element is its name.
        from: Vec<SafeComponent>,
        /// Where the copy goes, relative to the same share root. The last element is the new name;
        /// every element before it must already exist and be a directory.
        to: Vec<SafeComponent>,
        /// The name to stage under, inside `.depsis/staging/`.
        staging_name: SafeComponent,
        /// How many bytes of the source are already staged.
        ///
        /// Checked against the staging file's actual length and refused on a mismatch, exactly as
        /// `OpenTransfer` does: a number kept beside the data can disagree with it, and the file is
        /// the authority.
        offset: u64,
        /// The most this call will copy before returning.
        ///
        /// THE SLICE IS WHY THIS FIELD EXISTS. The control socket is served strictly one connection
        /// at a time (`unix.rs`), so whatever this call does, nothing else on the appliance can ask
        /// the agent anything — no listing, no upload, no folder creation. Copying a whole file
        /// here would make a 50 GB copy a total control-plane outage, and the API's own 60-second
        /// call budget would make such a file impossible to copy at all: every attempt would time
        /// out, and each of the twenty retries would leave another full-size staging file behind.
        ///
        /// So the caller asks for a slice and calls again. The agent bounds it too — see
        /// `MAX_COPY_SLICE` — because a caller that asks for the whole file must not get it.
        max_bytes: u64,
        /// Who owns the copy. NOT inherited from the source: a copy made by one person into their
        /// own folder that arrived owned by somebody else is a file the maker cannot delete.
        owner_uid: PosixId,
        owner_gid: PosixId,
    },

    /// List ONE directory inside a share: names, kinds and sizes.
    ///
    /// THE OPERATION THAT MAKES SMB WRITES VISIBLE. Until now `file_entries` only learned about a
    /// file if DEPSIS itself created it, so anything written over SMB — which is what a NAS is for
    /// — was invisible to the web interface, to search and to the permission walk. ADR-0011 lays
    /// out four layers for closing that; this is the primitive the reconciliation layer needs, and
    /// reconciliation is what every other layer degrades to when it misses an event.
    ///
    /// READS NAMES, NEVER CONTENT. A directory listing is metadata: the agent opens the directory
    /// under `RESOLVE_BENEATH`, reads its entries and `fstatat`s each one with `SYMLINK_NOFOLLOW`.
    /// Nothing here can be pointed at a file's bytes.
    ///
    /// ONE LEVEL, never a tree — the same rule as `RemoveEntry` and `CopyFile`, and the same reason
    /// (§2.2, ADR-0006). A recursive listing is a call whose cost the caller chooses, and the API
    /// walks the tree itself because the API is the side that stores it.
    ///
    /// Symlinks, sockets, fifos and device nodes are not reported. DEPSIS has no row shape for any
    /// of them, and a row that claimed otherwise would name something the agent itself refuses to
    /// open — a file the interface offers and cannot deliver.
    ListDirectory {
        share: SafeComponent,
        /// Relative to the share root. Empty means the share root itself.
        path: Vec<SafeComponent>,
    },

    /// List ONE directory inside ONE snapshot of a share.
    ///
    /// The read half of per-file restore, and the answer to the question a NAS is bought for: "I
    /// deleted it yesterday — where is it?" Until now the only thing DEPSIS could do with a
    /// snapshot was report that it existed. Rolling a whole dataset back to it is not an answer:
    /// it also discards every file written since.
    ///
    /// SAME SHAPE AS `ListDirectory`, deliberately — same operands plus a snapshot name, same
    /// one-level rule, same refusal for the agent's own tree. The API walks the tree itself.
    ///
    /// READ-ONLY, and it could not be otherwise: a ZFS snapshot is immutable. There is no
    /// operation that writes into one, and the restore below reads here and writes through the
    /// ordinary confined path.
    #[serde(rename = "snapshot_entries")]
    SnapshotEntries {
        share: SafeComponent,
        /// The snapshot's own name — the part after `@`, not `dataset@name`.
        ///
        /// The dataset is derived from the share, not supplied: a caller that could name the
        /// dataset could name somebody else's.
        snapshot: SafeComponent,
        /// Relative to the snapshot's root. Empty means the snapshot of the share root itself.
        path: Vec<SafeComponent>,
    },

    /// Copy one file OUT of a snapshot and back into the live share.
    ///
    /// Every operand `CopyFile` has, plus the snapshot to read from — and that is not a
    /// coincidence, it is the design. A restore IS a copy whose source happens to be immutable, so
    /// it goes through the same sliced staging, the same out-of-space answer, the same ownership
    /// fix-up and the same `RENAME_NOREPLACE` publish. One implementation of the steps people skip
    /// (fsync before publish, refuse rather than overwrite), not two.
    ///
    /// IT NEVER OVERWRITES. `to` names a destination that must not exist; a restore onto a live
    /// file would be the one operation in this set that destroys data the user still has, and the
    /// entire point of restoring is that the user is not sure which copy they want.
    #[serde(rename = "restore_from_snapshot")]
    RestoreFromSnapshot {
        share: SafeComponent,
        snapshot: SafeComponent,
        /// The file to read, relative to the SNAPSHOT's root. The last element is its name.
        from: Vec<SafeComponent>,
        /// Where the restored copy goes, relative to the LIVE share root. The last element is the
        /// new name and must not already exist; every element before it must.
        to: Vec<SafeComponent>,
        /// The name to stage under, inside `.depsis/staging/`.
        staging_name: SafeComponent,
        /// How many bytes are already staged. The file is the authority; see `CopyFile`.
        offset: u64,
        /// The most this call will copy before returning. Bounded by `MAX_COPY_SLICE`.
        max_bytes: u64,
        /// Who owns the restored copy. NOT the snapshot's owner: the file may predate the account
        /// that is restoring it, and a restore that arrived owned by somebody else is a file the
        /// person who asked for it cannot delete.
        owner_uid: PosixId,
        owner_gid: PosixId,
    },

    /// What this appliance's off-site identity is, and which destinations it trusts.
    ///
    /// Reads only, and reads only the PUBLIC half. There is no operation that returns the private
    /// key and there must not be: ADR-0016 splits the appliance so that database access alone is
    /// not enough, and a key readable through an HTTP endpoint would undo that split for the one
    /// credential that reaches another machine.
    #[serde(rename = "offsite_status")]
    OffsiteStatus {},

    /// Generate the off-site key, once.
    ///
    /// REFUSES if one already exists. Replacing it would leave the far end's `authorized_keys`
    /// holding the public half of a key this box no longer has — every future replication failing
    /// at the far end, hours later, with nothing on this side saying why.
    #[serde(rename = "offsite_create_identity")]
    OffsiteCreateIdentity {},

    /// Ask a destination what its host key is, WITHOUT trusting it.
    ///
    /// The read half of "no trust on first use": the fingerprints come back, a person compares
    /// them against what the far end reports, and only then does `OffsiteTrustHost` write one down.
    /// Nothing here changes what the appliance will connect to.
    #[serde(rename = "offsite_scan_host")]
    OffsiteScanHost {
        host: SshHostName,
        /// 1..=65535. Part of the `known_hosts` lookup key, so it is an operand rather than an
        /// assumption — a key confirmed for port 22 must not authorise port 2222.
        port: u16,
    },

    /// Write one confirmed host key into the agent's `known_hosts`.
    ///
    /// The line comes from a `OffsiteScanHost` the user was SHOWN. It is re-validated here as a
    /// whole line — see `KnownHostsLine` — because it is going into a file that decides which
    /// machine a copy of every file on this appliance may go to.
    #[serde(rename = "offsite_trust_host")]
    OffsiteTrustHost {
        host: SshHostName,
        port: u16,
        line: KnownHostsLine,
    },

    /// Copy one dataset's snapshot onto a dataset on ANOTHER machine, over SSH.
    ///
    /// The half `ReplicateDataset` deliberately did not do. A second pool in the same box survives
    /// a disk dying; it does not survive theft, fire, or ransomware reaching every mounted dataset.
    ///
    /// DESTRUCTIVE AT THE DESTINATION, exactly as the local one is: the far end runs
    /// `zfs recv -F`, which rolls its target back to the common snapshot. §8.1's confirmation
    /// sequence sits in front of it in the API, and the two refusals below sit in front of that —
    /// no identity, and a host whose key was never confirmed.
    ///
    /// The local refusals of `ReplicateDataset` do NOT apply and cannot: the target is on another
    /// machine, so this appliance has no way to know whether it is that machine's share root. What
    /// protects the far end is that reaching it at all requires a key its owner installed.
    #[serde(rename = "replicate_offsite")]
    ReplicateOffsite {
        source: DatasetName,
        snapshot: SafeComponent,
        /// The common snapshot to send FROM, when there is one. Absent means a full send.
        base: Option<SafeComponent>,
        host: SshHostName,
        port: u16,
        user: SshUserName,
        /// The dataset to receive onto, ON THE FAR END.
        target: DatasetName,
    },

    /// Destroy exactly ONE snapshot. Never a dataset, never recursively.
    ///
    /// The operation scheduled backups need and nothing else does. A schedule that takes an hourly
    /// snapshot and never removes one is a schedule that fills the pool — and a full pool is worse
    /// than an unbacked-up one, because writes stop too.
    ///
    /// WHY THIS SHAPE IS SAFE. The two operands are a `DatasetName` and a `SafeComponent`, and the
    /// agent joins them with `@`. `DatasetName`'s character set has no `@`, so the left half cannot
    /// smuggle one; the dispatcher refuses a right half that contains one. The argument `zfs
    /// destroy` receives therefore ALWAYS names a snapshot and never a dataset — which is the
    /// difference between removing one hour of history and removing everything.
    ///
    /// NO `-r`, NO `-R`, NO `-d`. Recursive destroy walks children; deferred destroy hides the
    /// outcome. §2.2's rule is that no single call the agent accepts may have a blast radius the
    /// caller chooses, and every one of those flags hands the radius to the caller.
    #[serde(rename = "destroy_snapshot")]
    DestroySnapshot {
        dataset: DatasetName,
        /// The snapshot's own name — the part after `@`.
        snapshot: SafeComponent,
    },

    /// Start a scrub: read every block and verify its checksum.
    ///
    /// ZFS notices a rotted block WHEN IT IS READ, which for a backup archive can be years after
    /// the rot — and by then the other copy may have gone too. A scrub is the read that happens on
    /// purpose, and on a mirror or RAIDZ it repairs what it finds from the good copy.
    ///
    /// NOT DESTRUCTIVE, so no §8.1 sequence in front of it: a scrub reads and, where it can,
    /// repairs. What it does cost is disk bandwidth for hours, which is why it is a button
    /// somebody presses rather than something DEPSIS starts on its own initiative.
    #[serde(rename = "start_scrub")]
    StartScrub { pool: SafeComponent },

    /// Bir havuzu YEDEK DİSKİ hâline getirir: iki veri kümesi, biri şifresiz biri şifreli.
    ///
    /// Havuzun kendisini bu işlem KURMUYOR — onu `CreatePool` kuruyor, ve diskleri silen tören
    /// (§8.1: analiz, adı yazarak onay, yeniden kimlik doğrulama) orada zaten var. Bu işlem
    /// yalnız kurulmuş bir havuzun üstüne düzeni koyuyor, yani yıkıcı değil: var olan bir veri
    /// kümesinin üstüne yazmıyor, `zfs create` çakışmayı kendisi reddediyor.
    ///
    /// PAROLA ARGV'DE DEĞİL, stdin'de. `/proc/<pid>/cmdline` bu kutudaki her kullanıcıya
    /// okunabilir; argv'den geçen bir parola, komut koştuğu sürece `ps` çıktısında durur.
    #[serde(rename = "prepare_backup_root")]
    PrepareBackupRoot {
        pool: SafeComponent,
        passphrase: Passphrase,
    },

    /// Yedek diski hazır mı, kilitli mi, ne kadar yeri var.
    ///
    /// Yedekleme turunun İLK sorusu. Anahtar yüklü değilse tur koşmuyor — ve bu bir hata değil,
    /// yeniden başlatmadan sonraki olağan hâl: parola hiçbir yere yazılmıyor, yani cihaz her
    /// açıldığında disk kilitli oluyor.
    #[serde(rename = "backup_root_status")]
    BackupRootStatus { pool: SafeComponent },

    /// Şifreli yarının anahtarını yükler ve bağlar.
    #[serde(rename = "load_backup_key")]
    LoadBackupKey {
        pool: SafeComponent,
        passphrase: Passphrase,
    },

    /// Anahtarı düşürür: disk kilitlenir, dosyalar okunamaz hâle gelir.
    #[serde(rename = "unload_backup_key")]
    UnloadBackupKey { pool: SafeComponent },

    /// Bir dosyayı CANLI ağaçtan YEDEK ağacına kopyalar, dilim dilim.
    ///
    /// Kaynak canlı kökten, hedef yedek kökünden çözülüyor, ve ikisini de ÇAĞIRAN SEÇMİYOR:
    /// hangi tarafın hangisi olduğu işlemin ADINDA sabit. `CopyFile` ile aynı iş gibi görünüyor
    /// ama değil — o, tek bir kökün içinde kalıyor.
    ///
    /// DİLİM DİLİM, çünkü kontrol soketi SIRALI. Elli gigabaytlık bir dosyayı tek çağrıda
    /// kopyalamak, o süre boyunca cihazdaki başka her şeyin durması demek.
    ///
    /// `offset` ÇAĞIRANIN İDDİASI, otorite değil: ajan ara dosyanın gerçek boyutuna bakıyor ve
    /// uyuşmazsa reddediyor. Devam etmek ya bir bölgeyi iki kez yazar ya bir delik bırakır —
    /// ikisi de tam görünen ve olmayan bir dosya üretir.
    #[serde(rename = "copy_file_to_backup")]
    CopyFileToBackup {
        share: SafeComponent,
        from: Vec<SafeComponent>,
        to: Vec<SafeComponent>,
        staging_name: SafeComponent,
        offset: u64,
        max_bytes: u64,
    },

    /// Yedek ağacında bir dizini listeler.
    ///
    /// ── KÖK, ÇAĞIRANIN SEÇTİĞİ BİR ŞEY DEĞİL ─────────────────────────────────────────────
    ///
    /// `ListDirectory` canlı paylaşımları, bu ise yedek diskini okuyor. İki AYRI işlem
    /// olmalarının sebebi ADR-0006: çağıran taraf bir yol adlandıramadığı gibi bir KÖK de
    /// adlandıramamalı. Tek bir işleme `realm: Live | Backup` diye bir alan koymak, tek bir
    /// alan değeriyle canlı ağacı hedefleyen bir yedek çağrısı yaratırdı — ve o alanın doğru
    /// dolduğunu ajan değil çağıran taraf garanti ederdi.
    ///
    /// Yedek ağacının kendi düzeni var ve ilk bileşen onu söylüyor: `Dosyalar/` gecikmeli
    /// ayna, `DEPSIS-YEDEK/` defter ve günlükler.
    #[serde(rename = "backup_list_directory")]
    BackupListDirectory { path: Vec<SafeComponent> },

    /// Yedek ağacında bir dizin açar.
    ///
    /// ÖZYİNELEME YOK — bir çağrı bir dizin. `mkdir -p` yok, çünkü ağacın hangi kısmının
    /// oluşturulacağını bilen taraf ağacı yürüyen taraftır, ve o taraf API. Eksik bir ara
    /// bileşen `NotFound` ile geri geliyor, yani çağıran hangi adımda olduğunu biliyor.
    #[serde(rename = "backup_create_directory")]
    BackupCreateDirectory { path: Vec<SafeComponent> },

    /// Yedek ağacının İÇİNDE bir düğümü taşır.
    ///
    /// İKİ İŞİN DE TEK ARACI, ve ikisi de sıfır bayt kopyalıyor:
    ///
    /// SİLİNENLERE TAŞIMA. Ana depolamadan silinen bir dosya yedekten hemen silinmiyor;
    /// bugünün tarihini taşıyan bir klasöre taşınıyor. Gecikmeli silmenin defteri budur — bir
    /// veritabanı değil, dizinin ADI. Sistem diski yandığında o bilgi diskle birlikte duruyor.
    ///
    /// YENİDEN ADLANDIRMA. Kırk bin fotoğraflı bir klasörün adı değiştiğinde ZFS için olan şey
    /// tek bir nesnenin üst bağının değişmesi. Yedek tarafında da tek bir taşıma olmalı;
    /// "eskisi silindi + yenisi eklendi" diye işlemek bütün klasörü silinenlere atıp baştan
    /// kopyalamak demekti.
    #[serde(rename = "backup_move_entry")]
    BackupMoveEntry {
        from: Vec<SafeComponent>,
        to: Vec<SafeComponent>,
    },

    /// Yedek ağacından bir düğümü siler — süresi dolan gün klasörlerinin temizliği.
    ///
    /// ÖZYİNELEME YOK, ve bu bir emniyet: dolu bir dizin `NotEmpty` ile geri geliyor, ağacı
    /// çağıran taraf yürüyor. Kök yetkiyle koşan bir süreçte `rm -r`nin karşılığı olan bir
    /// işlem, tek bir yanlış operandla bütün yedeği silerdi.
    #[serde(rename = "backup_remove_entry")]
    BackupRemoveEntry {
        path: Vec<SafeComponent>,
        directory: bool,
    },

    /// Erase everything on ONE disk so the pool wizard can accept it. DESTRUCTIVE.
    ///
    /// The owner's principle forced this into the product: "a disk with something on it cannot
    /// join a pool" is the right refusal, but when the only way to empty that disk was a shell,
    /// the refusal pointed the owner at a terminal — and this appliance's owner does not use one.
    /// So the cleaning is an operation with the same ceremony as pool creation (§8.1: analysis,
    /// written confirmation, re-authentication) and the same TOCTOU defence: the operand is a
    /// `DiskRef`, and the WWN the caller confirmed is re-checked against a fresh inventory taken
    /// immediately before the wipe — a disk swapped mid-dialog is refused, not erased.
    ///
    /// TWO REFUSALS NO CONFIRMATION CAN PASS, the same two that guard pool creation: a disk
    /// carrying `/`, `/boot` or the ESP, and a disk with anything MOUNTED. What it deliberately
    /// does NOT refuse is content — content is the reason it exists — and removability: wiping a
    /// USB stick is an ordinary wish, it is JOINING one to a pool that stays forbidden.
    ///
    /// The erase is `wipefs --all` on the whole device: partition table (GPT primary AND backup,
    /// protective MBR) and every filesystem signature wipefs can see at the device level. Inner
    /// superblocks of former partitions may survive as unreachable bytes; with no table naming
    /// them, nothing enumerates or mounts them, and `zpool create` labels over them.
    #[serde(rename = "wipe_disk")]
    WipeDisk { disk: DiskRef },

    /// Tek bir arka plan sürecini kapat. Sistem süreçleri hiçbir şekilde değil.
    ///
    /// `pid` YALNIZ BAŞINA YETMEZ ve `comm` süs değil: bir pid, süreç öldükten sonra başka bir
    /// sürece verilebilir, ve bayat bir listeden gelen kapatma yanlış şeyi vurur. Ajan sinyalden
    /// hemen önce `/proc/<pid>/comm`'u yeniden okur, bu adla karşılaştırır ve tutmuyorsa reddeder
    /// — havuz sihirbazının WWN yeniden doğrulamasıyla aynı kalıp. `SIGTERM`, `SIGKILL` değil:
    /// süreç kendini toplasın; ısrar eden kullanıcı yeniden basar.
    #[serde(rename = "kill_process")]
    KillProcess { pid: u32, comm: String },

    /// Kutu hangi sürümde, ve bir güncelleme koşuyor mu.
    ///
    /// Üç kaynağı birleştiriyor: `/etc/depsis/version` (kurulumun yazdığı commit), güncelleyicinin
    /// `state.json`'u, ve `systemctl`'in iki birim hakkında söylediği. Üçüncüsü olmadan olmazdı —
    /// durum dosyası, güncelleyici onu yazmaya fırsat bulamadan öldüyse (OOM, güç kesintisi)
    /// sonsuza kadar "installing" der; birimin gerçekten çalışıp çalışmadığını yalnız systemd
    /// bilir.
    #[serde(rename = "update_status")]
    UpdateStatus {},

    /// Yeni bir sürüm var mı diye BAK. Kurmaz.
    ///
    /// Ajan ağa çıkmaz (`IPAddressDeny=any`); bu işlem yalnızca `depsis-update-check.service`'i
    /// başlatır ve o birim indirmeyi kendi sanal alanında yapar. Cevap hemen dönmez — denetim
    /// birkaç saniye sürer ve sonucu `update_status` gösterir. Bunu senkron yapmak, ağı bekleyen
    /// bir çağrının SIRALI kontrol soketini kilitlemesi demek olurdu.
    #[serde(rename = "check_update")]
    CheckUpdate {},

    /// DENETİMİN BULDUĞU sürümü kur.
    ///
    /// OPERANDI YOK, ve bu bir eksiklik değil tasarımın kendisi. Hangi kodun kök yetkiyle kurulacağı
    /// sorusunu çağıran cevaplayamaz; cevabı bir önceki denetim `state.json`'a yazmıştır. Böylece
    /// ekranda bir commit görüp onaylayan operatör tam onu kurmuş olur, ve o an ile düğmeye basma
    /// anı arasında depoya giren bir commit onaylanmamış kod olarak kalır — havuz sihirbazının WWN
    /// yeniden doğrulamasıyla aynı kalıp, aynı gerekçe.
    ///
    /// Kurulum dakikalarca sürer ve bu işlem onu BEKLEMEZ: `systemctl start --no-block` ile birimi
    /// başlatıp döner. Süreci `update_status` izler.
    #[serde(rename = "apply_update")]
    ApplyUpdate {},
    /// Kutunun sunduğu sertifika ne.
    ///
    /// Kurulum kendinden imzalı bir sertifika üretiyor ve tarayıcı haklı olarak uyarıyor. O uyarı
    /// ekranında karşılaştırılacak tek şey PARMAK İZİ, ve bugüne kadar onu görmenin tek yolu
    /// kurulum çıktısına bakmaktı — yani cihazı kuran kişinin o anki terminaliydi.
    #[serde(rename = "tls_status")]
    TlsStatus {},

    /// Sahibinin kendi sertifikasını kur.
    ///
    /// ÖZEL ANAHTAR BU İSTEKTE, ve bu, işlem kümesi hakkında söylenen bir şeyi değiştiriyor —
    /// `audit` modülünün notu buna göre düzeltildi. Denetim kaydına giren şey değişmiyor: kayıt
    /// yalnız işlem adını taşıyor, isteğin kendisini değil.
    ///
    /// DOĞRULAMA ÜÇ ŞEY: sertifika ayrıştırılabilmeli, anahtar O sertifikaya ait olmalı, ve süresi
    /// dolmamış olmalı. Zincir doğrulaması YOK ve olmamalı — hangi CA nın güvenilir olduğu
    /// tarayıcının kararı, ve kendi CA sını kuran bir ev ağı da meşru.
    ///
    /// nginx ÖNCE SINANIR sonra yeniden yüklenir: bozuk bir yapılandırmayla `reload`, çalışan
    /// nginx i olduğu gibi bırakıp sessizce başarısız oluyor. Herhangi bir adım düşerse eski
    /// sertifika geri konuyor — kutunun HTTPS sunamaz hâle gelmesi, kabul edilebilir bir sonuç
    /// değil.
    #[serde(rename = "install_certificate")]
    InstallCertificate {
        /// PEM. Zincir de olabilir: ara sertifikalar sunucu tarafından sunulmazsa bazı istemciler
        /// bağlanamaz, ve operatörün elindeki dosya çoğunlukla zaten zincirdir.
        certificate: String,
        /// PEM. Şifreli bir anahtar KABUL EDİLMİYOR: parolayı da istemek, o parolanın kutuda bir
        /// yerde durması demek olurdu, ve dosyanın kendisi zaten 0400 kök.
        private_key: String,
    },

    /// What `zpool status` says about scrubbing this pool.
    ///
    /// The visibility half, and the half that was missing. Debian's `zfsutils-linux` already puts
    /// a monthly scrub in `/etc/cron.d`, so on an ordinary appliance scrubs ARE happening — and
    /// nothing in DEPSIS said whether they had run, what they found, or whether one is running
    /// now. A scrub whose findings nobody sees is only more expensive than no scrub at all.
    #[serde(rename = "scrub_status")]
    ScrubStatus { pool: SafeComponent },

    /// Dump the appliance's own database, and keep the newest few.
    ///
    /// ZFS snapshots protect the user's FILES. What they do not protect is who those files belong
    /// to: accounts, share definitions, folder grants, the task board and the file index all live
    /// in PostgreSQL, and PostgreSQL lives on the system disk. Lose that disk and every byte on
    /// the pool survives with nothing left to say who may read it.
    ///
    /// NOT WRITTEN INTO A SHARE, and that is a security decision rather than a choice of
    /// location: the dump carries password hashes, sealed TOTP secrets and SMB NT hashes, so a
    /// share would hand all of them to anybody with `download` on it. It goes to the agent's own
    /// directory at 0600. Backing THAT up is a schedule an administrator creates deliberately.
    ///
    /// The connection string comes from the agent's environment and never from this request —
    /// `samba::CONFIG_PATH_ENV`'s rule: which database the privileged daemon connects to is not a
    /// question an unprivileged caller may answer.
    #[serde(rename = "dump_database")]
    DumpDatabase {
        /// The file's own name, without a directory and without the `.dump` suffix.
        name: SafeComponent,
        /// How many dumps to keep. Pruning only ever touches files ending in `.dump`.
        keep: u32,
    },

    /// Back up ZeroTier's identity and controller state — the fourth thing nobody was backing up.
    ///
    /// `docs/operations/03-yedekleme.md` named three: the user's files, PostgreSQL, and the seal
    /// key. This is the fourth, and losing it is worse than losing the other three in one specific
    /// way: `identity.secret` CANNOT BE RECREATED. The top 40 bits of a ZeroTier network id are
    /// the controlling node's address, so a new identity means every member keeps asking a machine
    /// that no longer exists for its configuration, the records in `controller.d` sit on disk and
    /// are never consulted, and there is no way to re-point the network. The household
    /// permanently loses remote access to its own NAS.
    ///
    /// Losing only `controller.d` is milder and quieter: with the identity intact the same network
    /// id can be recreated, but every member comes back `authorized: false` and has to be
    /// re-authorized one at a time.
    ///
    /// Written into the same directory as the database dump, 0600, for the same reason: it is the
    /// appliance's own state rather than the user's files, and `identity.secret` is a credential.
    #[serde(rename = "backup_node_identity")]
    BackupNodeIdentity {
        /// The file's own name, without a directory and without the `.tar` suffix.
        name: SafeComponent,
        /// How many archives to keep. Pruning only touches `zerotier-*.tar`.
        keep: u32,
    },

    /// What dumps are on disk, newest first. No operands.
    #[serde(rename = "list_database_dumps")]
    ListDatabaseDumps {},

    /// Is this node a ZeroTier controller, and is its store ready?
    ///
    /// `zerotier-one` IS the controller — there is no second daemon. Every build compiles the
    /// embedded controller in and instantiates it unconditionally, so this is a liveness probe
    /// rather than a feature check; what it really answers is whether the daemon is up.
    #[serde(rename = "zerotier_controller_status")]
    ZerotierControllerStatus {},

    /// The networks this appliance controls.
    #[serde(rename = "zerotier_controller_networks")]
    ZerotierControllerNetworks {},

    /// Create the household's own network, configure it, and check the configuration STUCK.
    ///
    /// Creation alone yields a network no device can use: `v4AssignMode.zt` defaults false, the
    /// address pool is empty and there is no route. So this configures in the same operation and
    /// reads the applied record back — the controller answers 200 whether or not it understood the
    /// body, discarding fields it does not recognise in silence, and a green setup screen over a
    /// dead network is the exact failure this whole surface is written to avoid.
    ///
    /// THE NETWORK ID IS WELDED TO THIS APPLIANCE. Its top 40 bits are the node's own address, so
    /// the network cannot be moved to another machine and cannot survive a new `identity.secret`.
    /// That is why `BackupNodeIdentity` was written before this operation existed.
    #[serde(rename = "zerotier_create_network")]
    ZerotierCreateNetwork {
        /// Shown in the interface and in every member's ZeroTier client.
        name: SafeComponent,
        /// The IPv4 range members are given. `/24`, RFC1918 — see `Ipv4Prefix`.
        subnet: Ipv4Prefix,
    },

    /// Every member of one controlled network, each read in full.
    #[serde(rename = "zerotier_controller_members")]
    ZerotierControllerMembers { network_id: NetworkId },

    /// Authorize or de-authorize one device.
    ///
    /// THE OPERATION THAT GRANTS ACCESS. Authorizing a member gives that device network-level
    /// reach to a NAS holding a household's files, so it is administrator-only above and audited
    /// below, and the API records who pressed it.
    ///
    /// REFUSES TO ACT ON THIS APPLIANCE'S OWN ADDRESS. De-authorizing the NAS drops it off the
    /// network it is serving, and the control that would undo it is on the far side of the link
    /// that just went away — the controller keeps running for every other device, so nothing looks
    /// broken from anywhere except the one place that matters. The refusal is in the agent rather
    /// than only in the interface, because the interface is the thing that gets rewritten.
    #[serde(rename = "zerotier_set_member_authorized")]
    ZerotierSetMemberAuthorized {
        network_id: NetworkId,
        member: NodeAddress,
        authorized: bool,
        /// A name for the device. Absent leaves whatever name it already had — sending an empty
        /// one would erase the household's own label on the action most likely to be repeated.
        label: Option<SafeComponent>,
    },

    /// Delete exactly ONE entry inside a share. Never a tree.
    ///
    /// `directory` is a required operand rather than something the agent works out by stat-ing the
    /// path, and that is deliberate twice over. `unlinkat` needs `AT_REMOVEDIR` or not, so the
    /// distinction has to be made somewhere; making the CALLER state it means a caller that
    /// believes it is deleting a file and finds a directory gets a refusal instead of a surprise.
    /// Deciding it from a stat would also be check-then-use on the one operation that cannot be
    /// undone.
    ///
    /// There is no recursive variant and there will not be one. A non-empty directory comes back
    /// as an error (`ENOTEMPTY`) and the API walks the tree itself. The reason is §2.2 and
    /// ADR-0006: the closed operation set exists so that no single call the agent accepts has a
    /// blast radius the caller chooses. "Delete this subtree" is `rm -rf` behind a typed name — one
    /// bug in the unprivileged side, or one confused-deputy request, and it is the whole share.
    /// The API knows the tree because the API stores the tree; the agent only needs to be able to
    /// remove a leaf.
    RemoveEntry {
        share: SafeComponent,
        path: Vec<SafeComponent>,
        /// Is the entry a directory? The caller knows and has to say.
        directory: bool,
    },

    /// Create ONE directory inside a share.
    ///
    /// Its absence was not a gap in the operation set, it was a hole under the product. The API
    /// could write a `folders` row and nothing else, because the closed set had no operation that
    /// makes a directory — so a folder existed in Postgres and did not exist on disk. Everything
    /// downstream inherited that: `MoveEntry` on a folder could only ever return 409 because there
    /// was no directory to rename, a publish into a folder failed because the destination parent
    /// was not there, and somebody browsing the share over SMB — which is the entire reason a NAS
    /// exists — saw no folders at all.
    ///
    /// ONE node, never `mkdir -p`. The intermediate components must already exist and a missing
    /// one comes back as `NotFound`, for the same reason `MoveEntry` refuses to create its
    /// destination parent: an implicit mkdir turns a typo into a directory the user never asked
    /// for, holding a file they can no longer find. It is also what keeps the disk and the
    /// database one-to-one — each directory is one call and one row, so a partially-created tree
    /// cannot leave rows with no parent behind.
    CreateDirectory {
        share: SafeComponent,
        /// Relative to the share root; the LAST element is the name of the directory to create.
        /// Every element before it must already exist and be a directory.
        path: Vec<SafeComponent>,
        /// Who owns the directory. The same pair as `PublishTransfer` and the same type, for the
        /// same reason: a directory owned by root at 0750 is one the user cannot enter, and one
        /// owned by a host service account is one the wrong process can, so an API that skipped or
        /// botched the uid mapping must fail loudly here rather than produce a folder that appears
        /// in the listing and cannot be opened.
        owner_uid: PosixId,
        owner_gid: PosixId,
    },

    /// Make the machine's accounts and groups match DEPSIS's principals.
    ///
    /// THE LAST LINK. `folder_grants` decides access, `ApplyFolderAcl` writes it as POSIX entries
    /// naming numeric gids, and `SecureShareRoot` closes the top of the share so nothing else gets
    /// in. `tools/poc/p2-a-smb-identity.sh` measured that this genuinely gates a real smbd session
    /// — and that it gated EVERYONE, because the numbers belonged to no account. Nothing in the
    /// product had ever created one.
    ///
    /// DESIRED STATE, not a delta. The caller sends every user and every group it wants to exist,
    /// and membership is replaced rather than added to. A delta would mean the agent had to be told
    /// about removals separately, and the removal is the half that matters: a member who left a
    /// team but stayed in the Unix group keeps reaching folders their grant no longer covers.
    ///
    /// Creating system accounts is the most privileged thing in this set, so the operands are
    /// narrowed until the dangerous shapes cannot be expressed. Every id is a `PosixId`, which
    /// refuses 0 and anything outside 300000-399999 — the agent cannot be asked to touch `root`,
    /// `www-data` or `shadow`. Group names are DERIVED from the gid rather than supplied, so
    /// `gpasswd -M` can never be pointed at `sudo`. The login IS supplied, because the alternative
    /// is a person typing `depsis-u-300001` into Windows, and `identity::sync` checks it against
    /// `getent` before creating anything: a name that already belongs to an account outside the
    /// reserved range refuses the whole operation.
    ///
    /// Passwords arrive as NT hashes and never as passwords. See `NtHash`.
    SyncPosixIdentity {
        users: Vec<PosixUserSpec>,
        groups: Vec<PosixGroupSpec>,
    },

    /// Close a share root to everybody the ACL does not name.
    ///
    /// WHAT WAS WRONG. `zfs create` leaves a dataset's mountpoint at ZFS's default, which is
    /// `0755 root:root` — `other::r-x`. `ApplyFolderAcl` cannot fix it and must not try: that
    /// operation deliberately never touches the `user::`/`group::`/`other::` triple, and refuses
    /// outright if it changes underneath, because a "permissions applied" reply that had quietly
    /// rewritten the three entries every access falls back to would be the worst kind of lie.
    ///
    /// So nothing in the product had ever set the mode of a share root, and every share on every
    /// appliance was traversable by anyone: an authenticated SMB principal could list the
    /// top-level names and enter the root however narrow `folder_grants` was. Descent past it was
    /// still gated, because agent-created folders are 0750 with an ACL of their own — so the leak
    /// is enumeration and traversal of ONE directory, not the contents below it. That is a smaller
    /// hole than it first reads as, and still one that makes a "private" share list its folder
    /// names to the whole appliance.
    ///
    /// AN OPERATION OF ITS OWN, not a field on `CreateDataset`. Shares that already exist are open
    /// too, and an operand at creation time would only ever fix the next one. This can be aimed at
    /// any share, is idempotent, and the API runs it immediately before writing the root's ACL.
    ///
    /// THE ORDER IS LOAD-BEARING AND IT IS A POSIX RULE, not a local convention: `chmod` on a file
    /// that already carries an ACL sets the MASK from the group bits rather than the `group::`
    /// entry. Running this AFTER an ACL would silently clamp every named entry to `r-x`. Run
    /// before, the `setfacl` that follows recomputes the mask correctly — and the gap between them
    /// narrows rather than widens, which is the direction to be wrong in.
    ///
    /// No owner operand. The root stays `root:root` and that is the right answer rather than a
    /// missing one: root bypasses every ACL anyway, no DEPSIS principal should own the top of a
    /// share, and giving it to the administrator who happened to create it would bake one person's
    /// account into the filesystem. With `0750` and root ownership, `user::` and `group::` reach
    /// nobody the appliance maps, `other::` reaches nobody at all, and every real grant arrives as
    /// a named ACL entry — which is exactly the model ADR-0004 describes.
    SecureShareRoot { share: SafeComponent },

    /// Rewrite the POSIX ACL of ONE folder inside a share — access ACL and default ACL both.
    ///
    /// The operation the access-control model rests on. `folder_grants` in the database says who
    /// may read a folder; until this runs, the kernel has never been told, and SMB — which does not
    /// go through the API at all — enforces the mode bits and nothing else. A grant that exists
    /// only in Postgres is not a permission, it is a note about one.
    ///
    /// The entry list is COMPLETE, never a delta. The agent clears the extended entries before it
    /// writes, because a merge leaves a group the caller has just removed still holding its old
    /// permission: `setfacl -m` only ever adds and overwrites, so an entry that is no longer
    /// mentioned survives. "Here is who may reach this folder" is a statement the caller can make
    /// correctly; "here is what changed" is one it would have to reconstruct from a disk it cannot
    /// read.
    /// ONE folder, never a subtree. There was a `recursive: bool` here and it is gone.
    ///
    /// It was the shape §2.2/ADR-0006 rejects everywhere else in this enum — `RemoveEntry` and
    /// `SafePath::remove_dir` both say it outright about `rm -rf`: one call whose blast radius the
    /// caller chooses, in the one process that can reach every tenant's data. The ACL variant was
    /// the same primitive with a different verb, and it was destructive in a way its own comment
    /// did not admit, because the recursive pass began with `setfacl -R -b`. Measured: a sub-folder
    /// carrying §6.2's documented narrower grant (`İstisna: daha dar izin` — the entire reason
    /// `folder_grants` has per-folder rows) lost it and inherited the parent's wider one, while the
    /// `folder_grants` row went on saying the narrow thing. Two realities, widening.
    ///
    /// It also could not survive the fix to the TOCTOU above it: `setfacl -R` does not descend
    /// through `/proc/self/fd/N`, so keeping recursion meant keeping the joined path that let a
    /// symlink swap redirect a root-owned `setfacl` onto `/etc`. See the `acl` module note.
    ///
    /// A mass re-apply is therefore a loop on the API's side, which is where it belongs: the API
    /// stores the tree and holds a grant row per folder, so one call per folder writes each row's
    /// own grant instead of stamping one answer over descendants that disagree with it.
    ApplyFolderAcl {
        share: SafeComponent,
        /// Relative to the share root. EMPTY names the share root itself, which is the ordinary
        /// case for a share-wide grant. Unlike `CreateDirectory` — where an empty path would mean
        /// creating the share — there is nothing to lose here: the caller already named the share,
        /// and granting on the root of the tree it named is the point.
        ///
        /// `.depsis/` is refused, like everywhere else a caller-supplied path is accepted.
        path: Vec<SafeComponent>,
        entries: Vec<AclEntry>,
    },

    // ── ZeroTier (ADR-0020) ──
    //
    // Four operations, and the set is closed for the same reason the enum as a whole is. A
    // `ZeroTierRequest { method, path, body }` pass-through would be one variant instead of
    // four and would cover every future endpoint — which is exactly the argument §2.2 rejects
    // for shell commands. The agent holds the local API token precisely because that token
    // grants network control; handing the caller a general way to spend it puts the API back in
    // charge of what the privileged side does.
    //
    // The explicit `rename`s exist because serde's snake_case of `ZeroTierStatus` is
    // `zero_tier_status`, which reads as a typo in every consumer that has to type it.
    /// The local node's own identity and reachability: node id, online, daemon version.
    ///
    /// Readable by any signed-in user (ADR-0020): a device knowing its own id is not a secret.
    #[serde(rename = "zerotier_status")]
    ZeroTierStatus {},

    /// The networks this node has joined, with the authorization status of each.
    ///
    /// `ACCESS_DENIED` is the interesting one and it is not an error: it means the device has
    /// joined and the network's administrator has not ticked the box yet. Reporting that as
    /// "connecting" is how a user concludes the product is broken.
    #[serde(rename = "zerotier_networks")]
    ZeroTierNetworks {},

    /// Join a network. Admin-only at the API (ADR-0020): joining makes the device visible to
    /// everyone on that network.
    #[serde(rename = "zerotier_join")]
    ZeroTierJoin { network_id: NetworkId },

    #[serde(rename = "zerotier_leave")]
    ZeroTierLeave { network_id: NetworkId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ShareSpec {
    pub name: SafeComponent,
    pub dataset: DatasetName,
    pub read_only: bool,
    /// Who smbd will let connect to this share at all.
    ///
    /// Empty means the line is not written and every principal the operator's `[global]`
    /// authenticates may connect — which is what this file did before the field existed, and is
    /// still the honest rendering of "the API named nobody". It is NOT rendered as an empty
    /// `valid users =`: Samba reads that as no restriction, so the two cases would produce
    /// different text with the same meaning and one of them would look like a closed door.
    #[serde(default)]
    pub valid_users: Vec<SmbPrincipal>,
}

/// A name that may appear in `valid users`.
///
/// A TYPE rather than a `Vec<String>`, and the reason is the file this ends up in. `smb.conf` is
/// line-oriented and has no escaping: a principal containing a newline would not be a malformed
/// name, it would be a new DIRECTIVE: a line break followed by `guest ok = yes`, appended by
/// whatever the API believed was a username. `PosixName` already forbids every character that could do it, so reusing it
/// here means the injection is unrepresentable rather than filtered.
///
/// The user/group split is an enum rather than a leading `@` in the string for the same reason.
/// `@` is not a legal `PosixName` character, so a caller wanting a group cannot smuggle one
/// through the user variant; the sigil is added by the renderer, which is the only place that
/// knows Samba's syntax.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum SmbPrincipal {
    /// A Unix login. Rendered bare.
    User(PosixName),
    /// A Unix group. Rendered with Samba's `@` sigil.
    Group(PosixName),
}

impl SmbPrincipal {
    /// The token as `smb.conf` spells it.
    pub fn render(&self) -> String {
        match self {
            Self::User(name) => name.as_str().to_owned(),
            Self::Group(name) => format!("@{}", name.as_str()),
        }
    }
}

/// One thing in a directory, as the agent found it.
///
/// `size` is 0 for a directory, matching `file_entries_folder_has_no_size`. The database
/// constraint and the filesystem answer have to agree, or every reconciliation would report a
/// difference that is not one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DirEntry {
    /// A `SafeComponent`, not a `String`: a name the agent cannot address is a name the API must
    /// not be handed, because a row written for it would be permanently unreachable.
    pub name: SafeComponent,
    pub directory: bool,
    pub size: u64,
    /// Seconds since the epoch, from the kernel. Fills `updated_at` for a row DEPSIS is learning
    /// about, so a file that arrived over SMB last week does not appear as modified just now.
    pub modified_unix: i64,
}

/// The most one listing will report.
///
/// A directory with more than this comes back `truncated`. The number is bounded by the control
/// socket's line limit rather than by taste: one response has to fit in one line.
pub const MAX_LISTING: usize = 5_000;

/// One whole disk, as `ListDisks` found it.
///
/// Partitions are not reported as disks. They appear only through `holds`, `mounted` and
/// `holds_system` — which is what a caller about to overwrite the device needs to know, and a
/// per-partition inventory is not.
/// Kurulabilecek bir sürüm — DENETİMİN bulduğu, isteğin seçtiği değil.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateCandidate {
    /// Commit kimliği. DEPSIS'in sürüm kavramı bu: kutuya kurulan şey deponun bir anıdır, ve
    /// etiketlenmiş bir sürüm akışı henüz yok (§21'in 13. teslimatı).
    pub commit: String,
    /// Commit başlığının ilk satırı. Operatörün "bu ne getiriyor" sorusuna verilebilecek tek
    /// dürüst cevap, ve yorumlanmadan taşınıyor.
    pub subject: Option<String>,
    pub committed_at: Option<String>,
}

/// One database dump on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatabaseDump {
    pub name: String,
    pub size_bytes: u64,
    pub created_unix: i64,
}

/// One host key a destination offered, and the fingerprint a person compares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OffsiteHostKey {
    /// `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`.
    pub kind: String,
    /// The whole `known_hosts` line, which is what gets confirmed and stored.
    pub line: String,
    /// `256 SHA256:… (ED25519)`, computed by `ssh-keygen -l`.
    ///
    /// BY OPENSSH ITSELF, not by DEPSIS. The user compares this against what
    /// `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the far end, and two
    /// implementations of a fingerprint format are two chances for the comparison to fail for a
    /// reason that has nothing to do with the key.
    pub fingerprint: String,
}

/// A network this appliance controls, as the interface reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ZeroTierControlledNetwork {
    pub network_id: String,
    pub name: String,
    /// Always true for a network DEPSIS made; carried so a network made elsewhere and restored
    /// into this controller cannot look private when it is not.
    pub private: bool,
    /// Is IPv4 auto-assignment actually on? False means no device will ever get an address.
    pub assigns_addresses: bool,
    /// The route pushed to members, when there is one.
    pub subnet: Option<String>,
}

/// One member of a controlled network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ZeroTierMember {
    /// The device's 10-hex node address. Not a credential — see `NodeAddress`.
    pub member_id: String,
    pub authorized: bool,
    /// The household's own name for the device. Empty when never named.
    pub label: String,
    pub addresses: Vec<String>,
    /// Has this device ever actually contacted the controller?
    ///
    /// FALSE MEANS PRE-AUTHORIZED AND NOT YET SEEN, and the distinction is the one that catches a
    /// mistyped address: until a device turns up, an authorized row looks exactly the same whether
    /// it names a friend's laptop or a stranger's. The controller pins the full identity on first
    /// contact and refuses any later node claiming the same address, so once this is true the row
    /// means what it says.
    pub seen: bool,
    /// Is this the appliance itself? The interface must not offer to de-authorize this row.
    pub is_this_appliance: bool,
}

/// One ZeroTier peer, as the diagnostics screen reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ZeroTierPeer {
    /// The 10-hex-digit node address.
    pub address: String,
    /// `LEAF`, `PLANET` or `MOON`, as the daemon words it.
    pub role: String,
    pub version: String,
    /// Round trip in milliseconds, or absent when it has not been measured.
    ///
    /// Absent rather than -1, which is what ZeroTier writes: a screen printing "-1 ms" would be
    /// showing a measurement that was never taken as though it were a bad one.
    pub latency_ms: Option<i64>,
    /// Is there an active path to this peer, or is every byte going through a root?
    ///
    /// DERIVED here, not reported by ZeroTier: a peer with an active path is reached over it, one
    /// with none is relayed. The derivation lives in the agent so the API and the browser cannot
    /// each grow their own copy of it.
    pub direct: bool,
}

/// One snapshot on the wire.
///
/// Its own type rather than `snapshots::SnapshotInfo` for the reason every other wire type here is
/// separate: the protocol is a contract with another process, and a parser's internal shape
/// changing must not silently change what the API receives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SnapshotEntry {
    pub name: String,
    /// What destroying it would free — not what it "contains". See `snapshots::SnapshotInfo`.
    pub used_bytes: u64,
    /// Seconds since the epoch.
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DiskInfo {
    /// The `/dev/disk/by-id` name, when the kernel gave the device a stable link.
    ///
    /// THE ONLY IDENTITY WORTH STORING, and the one `ReadSmartSummary` takes. `kname` is reported
    /// beside it because an operator reads `sdb` on a chassis label, but a `/dev/sdX` name can
    /// belong to a different physical disk after a reboot — risk R1, and the reason
    /// `ReadSmartSummary` refuses to take one.
    ///
    /// Optional because a device can genuinely have no stable link: a loopback device, or a
    /// virtual disk whose backend supplies no identity page.
    pub by_id: Option<String>,

    /// The kernel name — `sda`, `nvme0n1`. For display beside the stable id, never as identity.
    pub kname: String,

    pub size_bytes: u64,

    pub model: Option<String>,

    /// The device serial, which is NULLABLE ON PURPOSE and not because it is uninteresting.
    ///
    /// ADR-0000 recorded the measurement: SCSI VPD page 0x80 is broken under Hyper-V — the
    /// `storvsc_drv.c` workaround exists for it — so a serial read there is absent or wrong. The
    /// identity chain the baseline settled on is page 0x83 (the WWN below) first, then partuuid,
    /// then the ZFS label GUID. A confirmation dialogue that keyed on the serial alone would show
    /// an empty field on exactly the hypervisor the project develops against.
    pub serial: Option<String>,

    /// The World Wide Name — SCSI VPD page 0x83. The first link in that chain.
    pub wwn: Option<String>,

    /// Spinning rust, as the kernel reports it (`queue/rotational`).
    pub rotational: bool,

    /// A device that can be unplugged. Never a pool candidate without the operator saying so
    /// twice: a USB stick that goes away takes a vdev with it.
    pub removable: bool,

    /// `sata`, `nvme`, `usb`, … as the kernel names the transport.
    pub transport: Option<String>,

    /// What is already on the disk: partition table type and filesystem signatures found on it or
    /// on its partitions, deduplicated.
    ///
    /// EMPTY IS THE ONLY SAFE STATE. Anything in this list means creating a pool on this device
    /// destroys something, and §8.1's written confirmation exists for exactly that sentence.
    pub holds: Vec<String>,

    /// Any partition of this disk is mounted, anywhere.
    pub mounted: bool,

    /// A filesystem of this disk is mounted at `/`, `/boot` or `/boot/efi`.
    ///
    /// Its own flag rather than something a caller derives from `holds`, because it is the one
    /// answer that must never be a judgement call: overwriting this disk destroys the appliance
    /// itself, and the API refuses it outright rather than asking for a confirmation somebody
    /// could type.
    pub holds_system: bool,
}

/// How the members are arranged.
///
/// A multi-disk STRIPE is deliberately not expressible. It is the arrangement in which losing any
/// one disk loses the whole pool, and on an appliance whose purpose is keeping files it is the one
/// configuration nobody should be able to reach by picking the wrong item in a list. `Single` says
/// what a one-disk pool actually is, and says it in its own word rather than as "a stripe of one".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PoolTopology {
    /// Exactly one disk, and no redundancy. Honest rather than hidden: some appliances have one
    /// disk, and refusing to serve them would push the operator to a shell where nothing is
    /// checked at all.
    Single,
    /// Every disk holds every byte. Two or more.
    Mirror,
    /// One disk of parity. Three or more.
    Raidz1,
    /// Two disks of parity. Four or more.
    Raidz2,
}

impl PoolTopology {
    /// The `zpool create` keyword, or none for a single disk.
    pub fn keyword(self) -> Option<&'static str> {
        match self {
            Self::Single => None,
            Self::Mirror => Some("mirror"),
            Self::Raidz1 => Some("raidz1"),
            Self::Raidz2 => Some("raidz2"),
        }
    }

    /// The fewest disks this arrangement means anything with.
    ///
    /// `raidz1` with two disks parses and creates a pool with the storage of one disk and the
    /// redundancy of a mirror, described by a word that promises something else. Refusing is
    /// clearer than serving a pool whose name misleads whoever reads it next year.
    pub fn minimum_disks(self) -> usize {
        match self {
            Self::Single => 1,
            Self::Mirror => 2,
            Self::Raidz1 => 3,
            Self::Raidz2 => 4,
        }
    }

    /// `Single` means one disk and only one.
    pub fn maximum_disks(self) -> Option<usize> {
        match self {
            Self::Single => Some(1),
            _ => None,
        }
    }
}

/// A disk named twice: the stable link to use, and the WWN it must still be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProcessSummary {
    pub pid: u32,
    pub uid: u32,
    pub user: String,
    pub comm: String,
    pub args: String,
    pub rss_bytes: u64,
    /// Sistem süreci mi — `KillProcess` bunu reddeder. Kural `procs::is_protected`'ta tek yerde.
    pub protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DiskRef {
    /// The `/dev/disk/by-id` name. A `SafeComponent`, so a path or a flag cannot be smuggled in —
    /// the same construction `ReadSmartSummary` uses, and for the same reason.
    pub by_id: SafeComponent,
    /// The WWN the caller believes this disk has, from a `ListDisks` answer.
    ///
    /// NOT decoration and not a second name for the same thing. `by_id` identifies a DEVICE, and a
    /// device can be unplugged and a different one put in its place between the inventory and the
    /// confirmation. The agent re-reads the inventory and refuses if this does not match, which is
    /// the only check in the sequence that survives somebody swapping a disk mid-wizard.
    ///
    /// A `String` rather than a validated type because it is COMPARED, never passed to a command:
    /// it never reaches an argv, so there is no flag to smuggle and nothing to escape.
    pub wwn: String,
}

/// The most disks one pool creation will accept.
///
/// Not a ZFS limit — it has none worth naming here — but a bound on the blast radius of one
/// request. An appliance building a vdev out of more disks than this is doing something the
/// product should not be arranging in a single call.
pub const MAX_POOL_DISKS: usize = 24;

/// The most `ListDisks` will report.
///
/// Bounded for the same reason `MAX_LISTING` is — one response is one line on the control socket —
/// and set far above any real appliance. A box presenting more block devices than this is
/// presenting something other than disks.
pub const MAX_DISKS: usize = 256;

/// One POSIX ACL entry: a GROUP and the three permission bits.
///
/// There is no `uid` field and there must not be one. ADR-0004 chose the grant model, and this
/// struct is where the choice is enforced rather than remembered: POSIX ACLs become unwieldy past
/// roughly thirty entries and the mask semantics start biting, so a share-role is a POSIX group and
/// users join groups. A per-user entry is expressible in the syscall and wrong in the design — so
/// it is not expressible here, the same way `AclType` makes `nfsv4` unrepresentable rather than
/// checking for it.
///
/// The bits are three booleans rather than a mode number for the same reason every other operand in
/// this file is typed: `0o755` reaching the wrong field is a silent widening, while a missing
/// `execute` is a parse error. On a directory `execute` is the bit that permits *entering* it, so a
/// read-only grant is `r-x` and not `r--`; the API decides that, because the agent does not know
/// whether the target is a directory and must not guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AclEntry {
    /// The POSIX group id. Numeric, and no identity database is consulted — `setfacl` takes a
    /// number and `/etc/passwd` is a separate decision about the appliance's identity store.
    ///
    /// `PosixId`, so 0 and the host's own groups are unrepresentable rather than checked. Root
    /// bypasses every ACL already, so an entry for the root group grants nothing and *reads* as a
    /// grant; an entry for gid 27 or 42 grants a great deal and reads the same way. Both are an API
    /// that got the group mapping wrong, and the agent must not be the side that trusts it.
    pub gid: PosixId,
    pub read: bool,
    pub write: bool,
    /// On a directory this is the bit that permits entering it, not executing anything.
    pub execute: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok {
        schema_version: u32,
    },
    PoolStatus {
        health: String,
        used_bytes: u64,
        available_bytes: u64,
    },
    Created {
        dataset: String,
    },
    Snapshot {
        full_name: String,
    },
    /// İki anlık görüntü arasında ne değişti — AYRIŞTIRILMIŞ hâlde.
    ///
    /// Eskiden `lines: Vec<String>` idi, yani `zfs diff` çıktısı ham hâliyle. İki şey yanlıştı ve
    /// ikisi de yalnız bu işlem gerçekten çağrıldığında görülecekti (bugüne kadar hiç
    /// çağrılmamış). BİR: yollar sekizlik kaçışlarla geliyor, yani Türkçe adlı her dosya ve
    /// içinde boşluk olan her ad bozuk. İKİ: liste sınırsızdı; sekiz yüz bin dosyalık bir delta
    /// kök yetkiyle koşan ajanın belleğini bitirirdi.
    ///
    /// `truncated` BİR UYARI DEĞİL BİR EMİR. Kesilmiş bir dizin listesi eksik bir ekrandır;
    /// kesilmiş bir değişiklik listesi, yedeklenmeyen dosyalardır. Çağıran taraf bunu gördüğünde
    /// ağacı baştan yürümek zorunda.
    Diff {
        entries: Vec<crate::diff::DiffEntry>,
        truncated: bool,
    },
    /// Whether this node can act as a controller.
    #[serde(rename = "zerotier_controller")]
    ZeroTierController {
        controller: bool,
        api_version: i64,
        database_ready: bool,
        /// This node's own 10-hex address — the prefix of every network it can control, and the
        /// address the interface must never offer to de-authorize.
        node_id: String,
    },

    /// The networks this appliance controls.
    #[serde(rename = "zerotier_controller_networks")]
    ZeroTierControllerNetworks {
        networks: Vec<ZeroTierControlledNetwork>,
    },

    /// A network was created. `shortfall` is EMPTY when the configuration fully applied.
    #[serde(rename = "zerotier_network_created")]
    ZeroTierNetworkCreated {
        network: ZeroTierControlledNetwork,
        /// What the controller silently did not apply, in sentences.
        ///
        /// NOT AN ERROR, because the network exists by then and calling it a failure would make
        /// the next attempt create a second one. It is the difference between "your network is
        /// ready" and "your network exists but hands out no addresses", and the interface has to
        /// be able to say the second one.
        shortfall: Vec<String>,
    },

    /// The members of one controlled network.
    #[serde(rename = "zerotier_controller_members")]
    ZeroTierControllerMembers {
        members: Vec<ZeroTierMember>,
    },

    /// One member's authorization was changed, and the change was READ BACK.
    #[serde(rename = "zerotier_member_updated")]
    ZeroTierMemberUpdated {
        member: ZeroTierMember,
    },

    /// The ZeroTier identity and controller state were archived.
    #[serde(rename = "node_identity_backed_up")]
    NodeIdentityBackedUp {
        name: String,
        size_bytes: u64,
        /// What went in: some subset of identity.secret, identity.public, controller.d.
        ///
        /// EMPTY IS AN ANSWER, not a failure: a box with no ZeroTier installed has none of them.
        /// The caller reports it as "nothing to back up" rather than as a backup that happened.
        included: Vec<String>,
        /// `controller.d` records that would not parse, by relative path.
        ///
        /// They are IN the archive — a half-written record carries more than a missing one — and
        /// they are named here because `FileDB` writes without a temp file or an fsync, and a NAS
        /// is exactly the device that loses power mid-write. A truncated record backed up in
        /// silence is a network or a member that is simply gone on the day the archive is opened.
        unreadable: Vec<String>,
    },

    /// The dumps on disk, newest first.
    #[serde(rename = "database_dumps")]
    DatabaseDumps {
        dumps: Vec<DatabaseDump>,
        /// Where they are, so an operator reading the screen knows what to copy off the box.
        directory: String,
    },

    /// What `zpool status` said about scrubbing, carried rather than interpreted.
    #[serde(rename = "scrub")]
    Scrub {
        /// The `scan:` line, verbatim, continuation lines included. Empty when there is none.
        ///
        /// NOT PARSED INTO A DATE. `zpool status` is written for a person and the timestamp is in
        /// the local format; turning it into an instant would mean answering "when was it last
        /// scrubbed" confidently and wrongly whenever the parse missed. The reader sees what
        /// `zpool status` said.
        scan: String,
        /// The `errors:` line, verbatim.
        errors: String,
        in_progress: bool,
        /// The ONE inference: `zpool status` writes exactly "No known data errors" when there are
        /// none, and anything else is a person's problem. Built this way round on purpose — the
        /// opposite ("these patterns mean trouble") would silently pass a wording it had not seen.
        has_errors: bool,
    },

    /// The snapshot is gone. Carries the full name so the audit trail says what was destroyed.
    #[serde(rename = "snapshot_destroyed")]
    SnapshotDestroyed {
        full_name: String,
    },

    /// Kutunun sunduğu sertifika.
    #[serde(rename = "tls")]
    Tls {
        /// Sertifikanın konusu, `openssl`in yazdığı gibi.
        subject: String,
        issuer: String,
        not_before: String,
        not_after: String,
        /// SHA-256, iki nokta ile ayrılmış. Tarayıcının uyarı ekranında karşılaştırılan şey.
        fingerprint: String,
        /// SAN listesi: `DNS:nas.example.com`, `IP Address:192.168.1.10`.
        names: Vec<String>,
        /// Konu ile veren aynı. Tarayıcı uyarısının sebebi, ve ekranda söylenmesi gereken şey.
        self_signed: bool,
    },

    /// Güncellemenin bütün durumu, tek yanıtta.
    #[serde(rename = "update")]
    Update {
        /// Kurulu commit. `install.sh` yazmadıysa YOK — ve yokluk "güncel" diye okunmaz.
        installed: Option<String>,
        /// Son denetimin bulduğu sürüm. Hiç denetim yapılmadıysa yok.
        available: Option<UpdateCandidate>,
        /// Güncelleyicinin kendi yazdığı faz, yorumlanmadan. Bilinen değerler `idle`, `checking`,
        /// `downloading`, `building`, `installing`, `verifying`, `rolling_back`, `done`, `failed`.
        phase: String,
        /// Şu anda bir şey koşuyor mu. `phase` ile systemd'nin cevabının BİRLEŞİMİ, ve tanınmayan
        /// bir faz koşuyor sayılır: bilinmezlikte doğru davranış, ikinci bir güncellemeye izin
        /// vermemektir.
        in_progress: bool,
        /// Kurulu sürüm ile bulunan sürüm aynı mı. İkisinden biri bilinmiyorsa `false`.
        up_to_date: bool,
        checked_at: Option<String>,
        started_at: Option<String>,
        finished_at: Option<String>,
        /// Son başarısızlığın cümlesi. Faz `failed` değilken de dolu olabilir: geri alınmış bir
        /// güncellemenin sebebi, kutu yeniden çalışır hâle geldikten sonra da okunmalıdır.
        error: Option<String>,
        /// Güncelleyicinin günlüğünün son satırları. Uzun bir kurulumun "hâlâ yaşıyor" kanıtı.
        log_tail: Vec<String>,
        /// Kutu İMZALI kipte mi: yalnız yayınlanmış ve imzalanmış sürümleri mi kuruyor.
        ///
        /// Kipi belirleyen şey kutudaki açık anahtarın varlığı. Bilinmiyorsa `false` — güvenin
        /// kaynağı hakkında ekranda duran bir yalan, hiç bilgi vermemekten kötüdür.
        signed: bool,
    },

    /// The off-site identity and the destinations this appliance trusts.
    #[serde(rename = "offsite")]
    Offsite {
        /// Has a key been generated? Everything else is meaningless while this is false.
        has_identity: bool,
        /// The PUBLIC half, to paste into the destination's `authorized_keys`.
        public_key: Option<String>,
        /// `256 SHA256:… depsis-offsite (ED25519)`, as `ssh-keygen -l` prints it.
        fingerprint: Option<String>,
        /// The `known_hosts` patterns this appliance will connect to — `host` or `[host]:port`.
        trusted: Vec<String>,
    },

    /// What a destination answered when asked for its host key. Trusted by nothing yet.
    #[serde(rename = "offsite_host_keys")]
    OffsiteHostKeys {
        keys: Vec<OffsiteHostKey>,
    },

    #[serde(rename = "zerotier_peers")]
    ZeroTierPeers {
        peers: Vec<ZeroTierPeer>,
    },
    Replicated {
        /// What `zfs recv` printed, kept so an operator can read the real words on a bad day.
        detail: String,
        /// The send was incremental from this snapshot, or absent for a full send.
        ///
        /// Echoed back because the caller's request is not proof of what happened: an incremental
        /// that the target refused is retried as a full send, and a job history that recorded the
        /// REQUEST would say "incremental" about a transfer that moved the whole dataset.
        base: Option<String>,
    },
    Snapshots {
        snapshots: Vec<SnapshotEntry>,
        /// The dataset is not there at all.
        ///
        /// Reported rather than collapsed into an empty list because the two mean different things
        /// to the screen: "no snapshots yet" invites taking one, "no dataset" means the box has not
        /// been set up. An empty list for both would offer an action that cannot work.
        missing: bool,
    },
    Smart {
        healthy: bool,
        temperature_celsius: Option<i32>,
        raw: String,
    },
    Pools {
        pools: Vec<String>,
    },
    ShareRoot {
        /// The agent's configured shares root, or absent when it has none.
        path: Option<String>,
        /// The dataset mounted EXACTLY there, or absent.
        ///
        /// Exactly, not "containing": a dataset mounted at `/srv` is not the one holding
        /// `/srv/depsis`, and reporting it as such would make the API believe the share tree was
        /// prepared when nothing had been created for it.
        dataset: Option<String>,
        /// Does the directory have any entries?
        ///
        /// Reported so that `PrepareShareRoot`'s refusal can be explained BEFORE it is attempted.
        /// A caller that cannot tell "not set up" from "set up with files in it" would offer to
        /// mount over somebody's data.
        empty: bool,
    },
    ShareRootPrepared {
        dataset: String,
    },
    /// The disk is empty. `detail` is wipefs's own account of what it erased, for the audit.
    DiskWiped {
        detail: String,
    },
    /// The pool exists.
    PoolCreated {
        /// What `zpool` printed, kept so an operator can see the real words on a bad day.
        detail: String,
    },
    Processes {
        processes: Vec<ProcessSummary>,
        truncated: bool,
    },
    ProcessKilled {},
    Disks {
        disks: Vec<DiskInfo>,
        /// More devices than `MAX_DISKS`, so the list is a prefix.
        ///
        /// Reported rather than silently cut for the same reason `Listing` reports it: a caller
        /// about to write a confirmation dialogue from a truncated inventory would be naming a
        /// subset of the disks it is about to affect.
        truncated: bool,
    },
    /// The Samba configuration was written AND proved.
    ///
    /// `verified` is not decoration. `testparm` passing means the file parses; P0-B measured an
    /// invalid `full_audit` opname passing it cleanly and then making smbd refuse every
    /// connection, so this flag reports the live connection attempt that followed. The agent only
    /// ever returns it `true` — a publish that cannot be proved rolls back and comes back as
    /// `refused` — but the contract carries the field because a client must be able to tell
    /// "shares are served" from "a file was written".
    Published {
        shares: usize,
        verified: bool,
    },
    /// A transfer is open. `offset` is how many bytes the staging file already holds, so a
    /// resumed upload knows where to continue without asking the filesystem itself.
    Transfer {
        token: String,
        offset: u64,
    },
    /// The staged file is in place and the destination directory has been fsynced.
    Publish {
        bytes: u64,
    },
    /// A file is open for reading. `size` is the file's own length, read from the descriptor the
    /// agent holds rather than from anything the caller supplied — so a Range can be validated
    /// against the object that will actually be read.
    Download {
        token: String,
        size: u64,
    },
    /// A staging file was thrown away. `existed` is false when there was nothing there, which is a
    /// success: a caller retrying a discard must not have to tell "already clean" apart from a
    /// fault.
    Discarded {
        existed: bool,
    },
    /// One slice of a copy is staged, and possibly the whole thing is in place.
    ///
    /// `offset` is how many bytes of the source are now staged, read from the staging file's own
    /// length rather than from anything the caller believed. The caller passes it back on the next
    /// call.
    ///
    /// `done` means the source was exhausted, the staging file was chowned and fsynced, and the
    /// rename into place plus the destination-directory fsync have happened. Only then is there a
    /// file at the destination; until then there is a `.part` in staging and nothing else.
    Copied {
        offset: u64,
        done: bool,
    },
    /// The dataset is full, or the tenant is over quota.
    ///
    /// Its own variant rather than `Failed`, for the reason ADR-0008 gives about uploads: a full
    /// dataset is a PERMANENT condition the caller must not retry, and `Failed` is exactly what a
    /// caller retries. Twenty attempts at a copy into a full pool would park twenty more
    /// full-size staging files against the same refquota that is already exhausted.
    #[serde(rename = "out_of_space")]
    OutOfSpace {
        reason: String,
    },
    /// One directory's contents.
    ///
    /// `truncated` is not decoration. A directory with a million entries would make one response
    /// larger than the socket's line limit, so the list is capped — and a caller that could not
    /// tell a complete listing from a clipped one would reconcile the first `MAX_LISTING` names
    /// and conclude that everything else had been deleted. With the flag, the API knows to leave
    /// the rest alone and say so.
    Listing {
        entries: Vec<DirEntry>,
        truncated: bool,
    },
    /// The entry is at its new name and the destination directory has been fsynced.
    ///
    /// No payload. The caller named both ends of the move and nothing about them changed, so
    /// echoing them back would only invite a consumer to believe the agent had normalised
    /// something.
    Moved {},
    /// The entry is gone.
    ///
    /// No `existed` flag, unlike `Discarded`. Discarding a staging file races the sweeper, so
    /// "already clean" is a success there. Removing an entry the user asked to remove is different:
    /// if it is not there, the caller's view of the tree disagrees with the disk, and answering
    /// "done" would hide that. That case is `NotFound`.
    Removed {},

    /// Yedek diskinin durumu.
    ///
    /// `prepared` ile `key_loaded` AYRI, ve ayrı olmaları ekranın söyleyeceği cümleyi belirliyor:
    /// hazırlanmamış bir disk "yedek diski kurun" der, kilitli bir disk "parolanızı girin" der.
    /// İkisini tek bir bayrakta birleştirmek, kullanıcıya yapacağı şeyin tersini söyletirdi.
    #[serde(rename = "backup_root")]
    BackupRoot {
        /// İki veri kümesi de yerinde mi.
        prepared: bool,
        /// Şifreli yarının anahtarı yüklü mü.
        key_loaded: bool,
        /// Şifreli yarı bağlı mı — yani dosyalar okunabiliyor mu.
        mounted: bool,
        /// Şifreli yarıya daha ne kadar yazılabilir. Kilitliyken 0 dönebilir.
        available_bytes: u64,
        used_bytes: u64,
    },
    /// The directory is on disk, owned by the uid and gid the caller named, and the entry has been
    /// made durable by an `fsync` of its parent.
    ///
    /// No payload, like `Moved`. The caller named the path and the agent normalised nothing, so
    /// echoing it back would only invite a consumer to believe otherwise. What the caller needs to
    /// know is that the next call — the database row, or a publish into this directory — may now
    /// proceed, and the status alone says that.
    DirectoryCreated {},
    /// The application's data folder exists inside the share and is owned by the app engine
    /// identity the container uid maps to.
    ///
    /// `created` says whether this call made it or found it — the API treats both as ready, and
    /// the flag exists for the audit line, where "found" on an install that was expected to be
    /// fresh is worth a look.
    #[serde(rename = "app_data_dir_ready")]
    AppDataDirReady {
        created: bool,
    },
    /// The machine's accounts and groups now match what was asked for.
    ///
    /// Counts rather than a bare acknowledgement, and only the ones the agent CHANGED: a sync that
    /// creates nothing is the ordinary steady state, and an operator watching zeros turn into a
    /// number is watching the appliance take on a new user. `passwords_set` is separate because it
    /// is the one that can be zero while the others are not — a user with no NT hash yet is a real
    /// account that simply cannot reach SMB.
    #[serde(rename = "posix_identity_synced")]
    PosixIdentitySynced {
        users_created: usize,
        groups_created: usize,
        passwords_set: usize,
    },

    /// The share root is closed to everyone the ACL does not name.
    ///
    /// `mode` is echoed rather than omitted, unlike `DirectoryCreated`, and for the same reason
    /// `AclApplied` echoes its count: the caller did not choose it. The number is the agent's,
    /// fixed in `SHARE_ROOT_MODE`, so sending it back is the only way an operator reading an audit
    /// line can see what was actually applied without going to read the source.
    #[serde(rename = "share_root_secured")]
    ShareRootSecured {
        mode: u32,
    },

    /// The folder's POSIX ACL is what the caller asked for, access ACL and DEFAULT ACL both.
    ///
    /// `entries` is how many group entries the folder now carries, and it is here rather than
    /// omitted — unlike `Moved` and `DirectoryCreated`, which echo nothing — because the number the
    /// agent wrote is the one thing about this operation the caller cannot derive from its own
    /// request. It sent a list; a list containing a duplicate or a root group is refused rather
    /// than trimmed, so the count coming back equal to the count sent is the caller's confirmation
    /// that nothing was quietly dropped.
    #[serde(rename = "acl_applied")]
    AclApplied {
        entries: usize,
    },
    /// The `acl` package is not installed on this box.
    ///
    /// The same shape as `SmbUnavailable` and `ZeroTierUnavailable`, and for the same reason: DEPSIS
    /// packages none of the three, so "absent" is an ordinary configuration state the API turns
    /// into 503 with a card that names the package. Folding it into `Failed` would send an operator
    /// hunting a broken agent instead of running `apt install acl`.
    ///
    /// A dataset with no working ACL layer is deliberately NOT this. That one is a `Failed` whose
    /// message names `acltype` — the tools are present and working, and what they are reporting is
    /// that the kernel enforces no access control on that dataset at all (ADR-0004).
    #[serde(rename = "acl_unavailable")]
    AclUnavailable {
        reason: String,
    },
    /// The path the operation named is not there.
    ///
    /// Its own variant rather than `Refused`, because the API turns exactly this into 404 and
    /// everything else in `Refused` into something else entirely. Collapsing them would put the
    /// API back to matching on prose.
    NotFound {
        reason: String,
    },
    /// The operation would have collided with something that is already there: a destination name
    /// that is taken, or a directory that still has children. 409, not 404 and not 500 — the caller
    /// can fix both by doing something different.
    Conflict {
        reason: String,
    },
    /// The local node. `node_id` is ZeroTier's own address for this machine.
    #[serde(rename = "zerotier_status")]
    ZeroTierStatus {
        node_id: String,
        online: bool,
        version: String,
    },
    #[serde(rename = "zerotier_networks")]
    ZeroTierNetworks {
        networks: Vec<ZeroTierNetwork>,
    },
    /// Joined. The network comes back with it because the state right after a join is the one
    /// the user most needs to see: usually `REQUESTING_CONFIGURATION`, then `ACCESS_DENIED`
    /// until somebody authorizes the device.
    #[serde(rename = "zerotier_joined")]
    ZeroTierJoined {
        network: ZeroTierNetwork,
    },
    #[serde(rename = "zerotier_left")]
    ZeroTierLeft {
        network_id: String,
    },
    /// zerotier-one is not installed here, or is not running.
    ///
    /// Its own variant rather than `Failed`, and the distinction is the whole point of the
    /// operation set: DEPSIS does not package ZeroTier (ADR-0020), so "absent" is an ordinary
    /// configuration state the UI must be able to name — and the API turns this into 503, not
    /// 500. A fault the operator caused and a fault the operator must fix look nothing alike.
    #[serde(rename = "zerotier_unavailable")]
    ZeroTierUnavailable {
        reason: String,
    },
    /// Samba is not installed on this box.
    ///
    /// The same shape as `ZeroTierUnavailable` and for the same reason: DEPSIS packages neither,
    /// so "absent" is an ordinary state of a machine that the API turns into 503 and the UI names
    /// in a card. Collapsing it into `Failed` would send an operator hunting a broken agent
    /// instead of installing a package, and it is what `SharePage.smbAvailable` reports.
    #[serde(rename = "smb_unavailable")]
    SmbUnavailable {
        reason: String,
    },
    Refused {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

/// One joined network, as the agent reports it.
///
/// A typed projection, not the daemon's JSON. Passing the raw object through would make every
/// field ZeroTier ever adds part of the DEPSIS contract, and would put the agent in the position
/// of forwarding something it has not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ZeroTierNetwork {
    pub network_id: String,
    pub name: Option<String>,
    pub status: ZeroTierNetworkStatus,
    /// The addresses this network assigned to the node, in CIDR form. Empty until the network
    /// authorizes the device, which is what makes an empty list here meaningful rather than a
    /// missing value.
    pub addresses: Vec<String>,
}

/// A joined network's membership state, as ZeroTier reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ZeroTierNetworkStatus {
    Ok,
    /// Joined, NOT authorized. No traffic flows. The user has to tick a box in ZeroTier
    /// Central; until then this is the honest state and it is not a failure.
    AccessDenied,
    NotFound,
    RequestingConfiguration,
    PortError,
    AuthenticationRequired,
    /// A status this build does not know. Present so that a newer daemon cannot be mapped onto
    /// `Ok` — showing an operator a false green is the shortest route to a device that is
    /// reported connected and is not.
    Unknown,
}

/// Bumped whenever `Request` or `Response` changes shape. The API checks it on connect.
///
/// 4 as of `CreateDirectory`/`ApplyFolderAcl`: `Request` gained two variants, `Response` three, and
/// `AclEntry` is a new operand type. The point of the check is that a NEW API against an OLD agent
/// fails at the handshake, while someone is watching a deployment. Without the bump the pair shakes
/// hands cleanly and the mismatch surfaces on the first call as a generic refusal — a message from
/// which nobody concludes "the agent binary is stale". Here that would be worse than a puzzling
/// error: an `ApplyFolderAcl` an old agent does not understand leaves the folder carrying whatever
/// ACL it had before, so the API would record a grant in `folder_grants` that the kernel is not
/// enforcing, and a share would look restricted while SMB let everyone in.
/// `EXPECTED_SCHEMA_VERSION` in `packages/agent-protocol` moves with it; they are one number in two
/// languages.
///
/// 33, `copy_file_to_backup` ile: canlı ağaçtan yedek ağacına dilimli kopyalama. İki kökü de
/// işlemin gövdesi seçiyor, çağıran değil.
///
/// 32, yedek AĞACININ işlemleriyle: `backup_list_directory`, `backup_create_directory`,
/// `backup_move_entry`, `backup_remove_entry`. Yedek ağacı ikinci bir mühürlü kök; hangi köke
/// dokunulacağı işlemin ADINDA sabit, çağıranın seçtiği bir alanda değil.
///
/// 31, yedek diski işlemleriyle: `prepare_backup_root`, `backup_root_status`, `load_backup_key`,
/// `unload_backup_key` ve `Response::BackupRoot`. Eski bir ajanla konuşan yeni bir API, yedek
/// diskinin durumunu hiç soramaz ve ekran "yedek diski yok" der — oysa disk takılı ve doludur.
///
/// 30, `Response::Diff` ayrıştırılmış hâle geçtiğiyle: ham `lines: Vec<String>` yerine tipli
/// `entries` ve bir `truncated`. Buradaki uyuşmazlığın bedeli sessiz olurdu — eski bir ajanla
/// konuşan yeni bir API, yedeklenecek dosyaların listesini boş okur ve HİÇBİR ŞEY DEĞİŞMEMİŞ
/// gibi davranırdı; yani yedekleme sessizce hiçbir dosya almaz.
///
/// 29, `Response::Update`in `signed` alanıyla: kutu imzalı sürüm kipinde mi.
///
/// 28, TLS işlemleriyle: `tls_status`, `install_certificate` ve `Response::Tls`.
///
/// 27, güncelleme işlemleriyle: `update_status`, `check_update`, `apply_update` ve `Response::Update`.
/// Buradaki uyuşmazlığın bedeli özellikle sinsi olurdu — güncelleme ekranını taşıyan yeni bir API,
/// eski bir ajanla el sıkışıp "güncelleme desteklenmiyor" yerine "durum okunamadı" derdi, yani
/// güncellenmesi gereken kutu, güncelleme yolunun bozuk olduğunu söyleyemezdi.
pub const SCHEMA_VERSION: u32 = 33;

/// The most one `CopyFile` call will move, whatever the caller asks for.
///
/// 64 MiB. The control socket is serialised, so this is the length of time every other agent
/// operation on the appliance can be blocked behind one copy — a few hundred milliseconds on a
/// spinning disk, comfortably inside the API's 60-second call budget with room for a pool that is
/// busy. The agent clamps rather than trusting the caller, because the whole point is that no
/// single call can be made long.
pub const MAX_COPY_SLICE: u64 = 64 * 1024 * 1024;

/// The mode `SecureShareRoot` writes: `rwx` for the owner, `r-x` for the group, nothing for other.
///
/// `0o750` and not `0o700`. The owner and group are both root, which the appliance maps to nobody,
/// so neither triple reaches a DEPSIS principal either way — but `0o750` is what every directory
/// the agent creates already uses (`create_dir`), and one mode across the tree is one fewer thing
/// for an operator comparing `ls -l` output to wonder about.
///
/// What closes the share is the last digit. `other::---` is the difference between a share whose
/// top-level names every authenticated SMB principal can read and one where only a named ACL entry
/// gets in.
pub const SHARE_ROOT_MODE: u32 = 0o750;

#[cfg(test)]
mod deny_unknown_tests {
    use super::*;

    #[test]
    fn an_unrecognised_field_is_refused_rather_than_ignored() {
        // The failure this prevents: `refquota` for `refquota_bytes` producing a quota-less
        // dataset that reports success.
        let typo =
            r#"{"op":"create_dataset","dataset":"tank/a","acltype":"posixacl","refquota":100}"#;
        assert!(
            serde_json::from_str::<Request>(typo).is_err(),
            "a misspelled field was silently ignored"
        );

        let correct = r#"{"op":"create_dataset","dataset":"tank/a","acltype":"posixacl","refquota_bytes":100}"#;
        assert!(serde_json::from_str::<Request>(correct).is_ok());
    }

    #[test]
    fn a_smuggled_extra_field_is_refused() {
        assert!(serde_json::from_str::<Request>(r#"{"op":"ping","extra":"; id"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"op":"ping"}"#).is_ok());
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

    #[test]
    fn dataset_name_accepts_a_realistic_name() {
        assert!(DatasetName::parse("tank/depsis/users/1001").is_ok());
    }

    #[test]
    fn dataset_name_rejects_a_leading_dash() {
        // The whole point: `zfs` would read this as a flag even as a separate argv entry.
        assert_eq!(DatasetName::parse("-o"), Err(ValidationError::LeadingDash));
        assert_eq!(
            DatasetName::parse("--force"),
            Err(ValidationError::LeadingDash)
        );
    }

    #[test]
    fn dataset_name_rejects_traversal_and_nul() {
        assert_eq!(
            DatasetName::parse("tank/../etc"),
            Err(ValidationError::ContainsDotDot)
        );
        assert_eq!(
            DatasetName::parse("tank//users"),
            Err(ValidationError::ContainsDotDot)
        );
        assert_eq!(
            DatasetName::parse("tank\0evil"),
            Err(ValidationError::ContainsNul)
        );
    }

    #[test]
    fn dataset_name_rejects_shell_metacharacters() {
        // There is no shell in the execution path, but accepting these would widen the surface
        // for the tools that do their own parsing.
        for bad in ["tank;rm", "tank$(x)", "tank|y", "tank y", "tank&z"] {
            assert!(
                DatasetName::parse(bad).is_err(),
                "should have rejected {bad:?}"
            );
        }
    }

    #[test]
    fn safe_component_refuses_to_be_a_path() {
        assert_eq!(
            SafeComponent::parse("a/b"),
            Err(ValidationError::ContainsSeparator)
        );
        assert_eq!(
            SafeComponent::parse("..\\windows"),
            Err(ValidationError::ContainsSeparator)
        );
        assert_eq!(
            SafeComponent::parse(".."),
            Err(ValidationError::ContainsDotDot)
        );
    }

    // ── NetworkId ──
    //
    // Every rejection below has its own case, because this value is concatenated into a request
    // path and an HTTP request line. A single "invalid" test would pass just as happily with a
    // parser that only checked the length.

    #[test]
    fn network_id_accepts_a_real_id() {
        let id = NetworkId::parse("8056c2e21c000001").expect("a real ZeroTier network id");
        assert_eq!(id.as_str(), "8056c2e21c000001");
        assert!(NetworkId::parse("ffffffffffffffff").is_ok());
        assert!(NetworkId::parse("0000000000000000").is_ok());
    }

    #[test]
    fn network_id_rejects_empty() {
        assert_eq!(NetworkId::parse(""), Err(NetworkIdError::Empty));
    }

    #[test]
    fn network_id_rejects_fifteen_and_seventeen_digits() {
        assert_eq!(
            NetworkId::parse("8056c2e21c00000"),
            Err(NetworkIdError::WrongLength {
                len: 15,
                expected: 16
            })
        );
        assert_eq!(
            NetworkId::parse("8056c2e21c0000011"),
            Err(NetworkIdError::WrongLength {
                len: 17,
                expected: 16
            })
        );
    }

    #[test]
    fn network_id_rejects_uppercase_rather_than_folding_it() {
        // Not a style rule. Two spellings of one id mean two rows in `remote_networks` and an
        // audit trail where "did we join this?" is no longer a string comparison.
        assert_eq!(
            NetworkId::parse("8056C2E21C000001"),
            Err(NetworkIdError::Uppercase { at: 4, ch: 'C' })
        );
    }

    #[test]
    fn network_id_rejects_non_hex_digits() {
        assert_eq!(
            NetworkId::parse("8056c2e21c00000g"),
            Err(NetworkIdError::NotHex { at: 15, ch: 'g' })
        );
        // Sixteen bytes of multi-byte text: the length check passes and the digit check is what
        // catches it, which is the case a `len() == 16` parser gets wrong.
        assert!(matches!(
            NetworkId::parse("ααααααββββββγγγγ".get(..16).unwrap_or_default()),
            Err(NetworkIdError::NotHex { .. })
        ));
    }

    #[test]
    fn network_id_rejects_a_path_fragment_and_a_nul() {
        // Both are exactly sixteen bytes, so only the digit check stands between them and a
        // request path. `../` in an id would address a different endpoint of the local API;
        // a NUL would be truncated by whatever C string it eventually reached.
        assert_eq!(
            NetworkId::parse("../../../etc/pas"),
            Err(NetworkIdError::NotHex { at: 0, ch: '.' })
        );
        assert_eq!(
            NetworkId::parse("0123456789abcd\0f"),
            Err(NetworkIdError::NotHex { at: 14, ch: '\0' })
        );
        // And a header split, which is what a request line concatenation is really exposed to.
        assert!(NetworkId::parse("0123456789ab\r\ncd").is_err());
        assert!(NetworkId::parse("0123456789abc de").is_err());
    }

    #[test]
    fn a_request_carrying_a_bad_network_id_does_not_deserialize() {
        for json in [
            r#"{"op":"zerotier_join","network_id":"../../../etc/pas"}"#,
            r#"{"op":"zerotier_join","network_id":"8056C2E21C000001"}"#,
            r#"{"op":"zerotier_join","network_id":""}"#,
            r#"{"op":"zerotier_leave","network_id":"8056c2e21c00000"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"zerotier_join","network_id":"8056c2e21c000001"}"#
        )
        .is_ok());
    }

    #[test]
    fn there_is_no_general_zerotier_proxy_variant() {
        // The network-shaped version of `there_is_no_raw_command_variant`. If somebody adds a
        // pass-through to the local API, one of these starts parsing and this test fails.
        for json in [
            r#"{"op":"zerotier_request","path":"/controller/network"}"#,
            r#"{"op":"zerotier","method":"POST","path":"/moon","body":"{}"}"#,
            r#"{"op":"zerotier_status","path":"/status"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
        assert!(serde_json::from_str::<Request>(r#"{"op":"zerotier_status"}"#).is_ok());
    }

    #[test]
    fn an_unknown_network_status_stays_unknown_on_the_wire() {
        let json = serde_json::to_string(&ZeroTierNetworkStatus::AccessDenied).expect("serialize");
        assert_eq!(json, r#""ACCESS_DENIED""#);
        assert_eq!(
            serde_json::to_string(&ZeroTierNetworkStatus::Ok).expect("serialize"),
            r#""OK""#
        );
    }

    #[test]
    fn nfsv4_acltype_is_not_expressible() {
        // Not a runtime check — a parse failure. ADR-0004's most dangerous configuration
        // cannot be constructed, so no code path can accidentally request it.
        let json = r#"{"op":"create_dataset","dataset":"tank/x","acltype":"nfsv4"}"#;
        let parsed: Result<Request, _> = serde_json::from_str(json);
        assert!(parsed.is_err(), "acltype=nfsv4 must not deserialize");
    }

    #[test]
    fn a_request_carrying_a_flag_as_a_dataset_is_rejected_at_parse_time() {
        let json = r#"{"op":"create_snapshot","dataset":"-R","name":"s1"}"#;
        let parsed: Result<Request, _> = serde_json::from_str(json);
        assert!(parsed.is_err());
    }

    // ── MoveEntry / RemoveEntry ──

    #[test]
    fn a_traversing_component_cannot_be_expressed_in_a_move_or_a_remove() {
        // The type test the brief asks for, and it is a PARSE failure rather than a runtime check:
        // `Vec<SafeComponent>` has no inhabitant spelled `..`, so no dispatch code path can be
        // reached with one. Nothing downstream has to remember to look, which is the whole reason
        // the operand is a type instead of a string.
        assert_eq!(
            SafeComponent::parse(".."),
            Err(ValidationError::ContainsDotDot)
        );
        for json in [
            r#"{"op":"move_entry","share":"alice","from":["..","etc"],"to":["x"]}"#,
            r#"{"op":"move_entry","share":"alice","from":["a"],"to":["..","..","etc","passwd"]}"#,
            r#"{"op":"move_entry","share":"alice","from":["a/b"],"to":["c"]}"#,
            r#"{"op":"move_entry","share":"..","from":["a"],"to":["b"]}"#,
            r#"{"op":"remove_entry","share":"alice","path":["..","etc"],"directory":false}"#,
            r#"{"op":"remove_entry","share":"alice","path":["a\\b"],"directory":false}"#,
            r#"{"op":"remove_entry","share":"alice","path":["-rf"],"directory":false}"#,
            r#"{"op":"remove_entry","share":"alice","path":[""],"directory":false}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    #[test]
    fn a_well_formed_move_and_remove_do_parse() {
        // The negative test above is worth nothing without this one: a parser that rejected
        // everything would pass it.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"move_entry","share":"alice","from":["docs","a.txt"],"to":["archive","a.txt"]}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"remove_entry","share":"alice","path":["docs","a.txt"],"directory":false}"#
        )
        .is_ok());
    }

    #[test]
    fn remove_entry_will_not_default_its_directory_flag() {
        // Omitting `directory` must fail rather than mean `false`. A caller that forgot the field
        // and got "file" by default would hit EISDIR on every directory — recoverable — but the
        // reverse default would be worse, and neither belongs in an operation with no undo. The
        // caller states what it thinks it is deleting.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"remove_entry","share":"alice","path":["d"]}"#
        )
        .is_err());
    }

    #[test]
    fn there_is_no_recursive_delete_variant() {
        // The filesystem-shaped version of `there_is_no_raw_command_variant`. If someone adds an
        // operation whose blast radius the caller chooses, one of these starts parsing.
        for json in [
            r#"{"op":"remove_entry","share":"alice","path":["d"],"directory":true,"recursive":true}"#,
            r#"{"op":"remove_tree","share":"alice","path":["d"]}"#,
            r#"{"op":"remove_entry","share":"alice","path":[],"directory":true,"force":true}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    #[test]
    fn a_move_names_one_share_and_cannot_name_two() {
        // Cross-dataset rename is EXDEV (ADR-0008), so a two-share move would be a copy wearing a
        // move's name. The schema has one `share` field; a request carrying a second is refused.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"move_entry","share":"alice","to_share":"bob","from":["a"],"to":["a"]}"#
        )
        .is_err());
    }

    // ── CreateDirectory ──

    #[test]
    fn a_traversing_component_cannot_be_expressed_in_a_create_directory() {
        // The type test the brief asks for, and it is a PARSE failure rather than a runtime check.
        // `Vec<SafeComponent>` has no inhabitant spelled `..`, so no code path in `create_directory`
        // can be reached with one — the `mkdirat` below it never has to remember to look, which is
        // the whole reason the operand is a type instead of a string. The same holds for the
        // `share` field: a share named `..` would be the parent of the share root.
        assert_eq!(
            SafeComponent::parse(".."),
            Err(ValidationError::ContainsDotDot)
        );
        for json in [
            r#"{"op":"create_directory","share":"alice","path":["..","etc"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["docs","..",".."],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["a/b"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["a\\b"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["/etc"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"..","path":["docs"],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":[""],"owner_uid":1,"owner_gid":1}"#,
            r#"{"op":"create_directory","share":"alice","path":["-p"],"owner_uid":1,"owner_gid":1}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    #[test]
    fn a_well_formed_create_directory_does_parse() {
        // The negative test above is worth nothing without this one: a parser that rejected
        // everything would pass it.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"create_directory","share":"alice","path":["docs","2026"],"owner_uid":300101,"owner_gid":302001}"#
        )
        .is_ok());
    }

    #[test]
    fn create_directory_will_not_default_its_owner_or_grow_a_recursive_flag() {
        // Omitting the owner must fail rather than mean 0. Serde would not default a `u32` here
        // anyway, but that is a property of the field's type rather than a stated intent, and this
        // is the pair whose absence produced root-owned objects the tenant cannot use.
        //
        // The `parents`/`recursive` cases are the filesystem-shaped version of
        // `there_is_no_raw_command_variant`: if somebody turns this into `mkdir -p`, one of them
        // starts parsing. `mkdir -p` would create nodes the API has no rows for.
        for json in [
            r#"{"op":"create_directory","share":"alice","path":["d"]}"#,
            r#"{"op":"create_directory","share":"alice","path":["d"],"owner_uid":300101}"#,
            r#"{"op":"create_directory","share":"alice","path":["a","b"],"owner_uid":1,"owner_gid":1,"parents":true}"#,
            r#"{"op":"create_directory","share":"alice","path":["a","b"],"owner_uid":1,"owner_gid":1,"recursive":true}"#,
            r#"{"op":"create_directory","share":"alice","path":["d"],"owner_uid":1,"owner_gid":1,"mode":511}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    // ── ApplyFolderAcl ──

    #[test]
    fn an_acl_entry_cannot_name_a_user() {
        // ADR-0004's grant model, as a parse failure rather than a runtime check. If somebody adds
        // a `uid` to `AclEntry`, the first of these starts deserializing and this test fails —
        // which is the only way the decision survives the person who made it.
        for json in [
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"uid":1001,"read":true,"write":false,"execute":true}]}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"gid":301200,"uid":1001,"read":true,"write":false,"execute":true}]}"#,
            // A mode number instead of the three bits: silent widening if it were accepted.
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"gid":301200,"mode":511}]}"#,
            // Every bit is required. A missing `execute` on a directory is the difference between
            // a folder the group can enter and one it cannot, so it must not default.
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[{"gid":301200,"read":true,"write":false}]}"#,
            // And the path is components, not a path.
            r#"{"op":"apply_folder_acl","share":"alice","path":["..","etc"],"entries":[]}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":["a/b"],"entries":[]}"#,
            r#"{"op":"apply_folder_acl","share":"..","path":[],"entries":[]}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize"
            );
        }
    }

    /// A caller that still sends `recursive` must be REFUSED, not quietly obeyed for one folder.
    ///
    /// This is the compatibility half of removing the operand, and it is a security property
    /// rather than tidiness. An API that believes it asked for a subtree and is answered
    /// `acl_applied` for a single directory records every descendant as enforced when the kernel
    /// has been told nothing about them — a grant that exists only in Postgres, which is the exact
    /// failure `ApplyFolderAcl` was added to end. `deny_unknown_fields` turns it into a parse
    /// error instead; the test exists so nobody "fixes" that by adding `#[serde(default)]`.
    #[test]
    fn the_removed_recursive_operand_is_refused_rather_than_ignored() {
        for json in [
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[],"recursive":true}"#,
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[],"recursive":false}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(json).is_err(),
                "{json} must not deserialize: a caller asking for a subtree cannot be told yes for                  one folder"
            );
        }
    }

    #[test]
    fn a_well_formed_apply_folder_acl_does_parse() {
        // The negative test above is worth nothing without this one.
        let parsed: Request = serde_json::from_str(
            r#"{"op":"apply_folder_acl","share":"alice","path":["docs"],"entries":[{"gid":301200,"read":true,"write":false,"execute":true}]}"#,
        )
        .expect("a well-formed grant");
        assert_eq!(
            parsed,
            Request::ApplyFolderAcl {
                share: SafeComponent::parse("alice").expect("valid"),
                path: vec![SafeComponent::parse("docs").expect("valid")],
                entries: vec![AclEntry {
                    gid: PosixId::parse(301_200).expect("reserved range"),
                    read: true,
                    write: false,
                    execute: true,
                }],
            }
        );
        // An empty path names the share root — a share-wide grant, which is the ordinary case.
        assert!(serde_json::from_str::<Request>(
            r#"{"op":"apply_folder_acl","share":"alice","path":[],"entries":[]}"#
        )
        .is_ok());
    }

    #[test]
    fn there_is_no_raw_command_variant() {
        // A guard against the surface being widened by accident: if someone adds a variant that
        // takes a command line, the JSON below starts parsing and this test fails.
        for json in [
            r#"{"op":"raw","command":"rm -rf /"}"#,
            r#"{"op":"exec","argv":["sh","-c","x"]}"#,
            r#"{"op":"shell","line":"zpool destroy tank"}"#,
        ] {
            let parsed: Result<Request, _> = serde_json::from_str(json);
            assert!(parsed.is_err(), "{json} must not deserialize");
        }
    }

    #[test]
    fn round_trips_through_json() {
        let req = Request::CreateDataset {
            dataset: DatasetName::parse("tank/depsis/users/1001").expect("valid"),
            acltype: AclType::Posixacl,
            refquota_bytes: Some(64 * 1024 * 1024),
        };
        let s = serde_json::to_string(&req).expect("serialize");
        let back: Request = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(req, back);
    }
}
