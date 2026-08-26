//! DEPSIS'in kendi ZeroTier ağını yönetmesi — self-hosted controller.
//!
//! ## Ayrı bir servis yok
//!
//! `zerotier-one`'ın kendisi controller. Aynı daemon, aynı `127.0.0.1:9993`, aynı token, aynı elle
//! yazılmış HTTP — `zerotier.rs`'in beş işlemi ne kullanıyorsa bu da onu kullanıyor. `ztncui` gibi
//! araçlar yalnızca bu API'nin web arayüzü; DEPSIS'in kendi arayüzü var.
//!
//! ## Ağ kimliği kimliğe kaynaklı
//!
//! Bir ağ kimliğinin üst 40 biti, o ağı yöneten düğümün adresinin ta kendisi
//! (`Address(_id >> 24)`). Bunun iki sonucu var ve ikisi de bu dosyanın şeklini belirliyor:
//! ağ kimliği bu NAS'a KAYNAKLI ve taşınamaz, ve `identity.secret` kaybedilirse ağ kalıcı olarak
//! kurtarılamaz (bkz. `ztstate.rs`, ve o yüzden yedeği bundan ÖNCE yazıldı).
//!
//! ## Yazılan her şey geri OKUNUYOR
//!
//! Controller, tanımadığı alanları SESSİZCE ATIYOR. Yanlış yazılmış bir `ipAssignmentPools` ya da
//! unutulmuş bir `v4AssignMode` 200 döndürüyor, hiçbir yere hata yazmıyor, ve sonuç hiçbir cihazın
//! adres alamadığı bir ağ oluyor — kurulum ekranı yeşil, ağ ölü. O yüzden buradaki hiçbir yazma
//! HTTP durum koduyla değerlendirilmiyor: her POST'un DÖNDÜRDÜĞÜ nesne ayrıştırılıyor ve istenen
//! değerler orada mı diye bakılıyor.
//!
//! ## Gövdeler `serde_json` ile kuruluyor
//!
//! `format!` ile değil. Ağ adı kullanıcıdan geliyor ve içinde `"` olabilir; elle birleştirilmiş bir
//! gövdede `x","private":false,"z":"` yazan bir ad, ağı HERKESE AÇIK hâle getirirdi — ve o durumda
//! controller her isteyeni kendiliğinden yetkilendirdiği için arayüzdeki "Yetkilendir" düğmesi
//! tiyatroya dönerdi.

use crate::op::{Ipv4Prefix, NetworkId, NodeAddress};
use serde::{Deserialize, Serialize};

/// `GET /controller` cevabı.
///
/// Gövde bir nesne serileştirilerek değil, `ztsnprintf` ile ELLE biçimlendirilerek üretiliyor, ve
/// tam dört alanı var. `databaseReady` dosya tabanlı (self-hosted) controller'da her zaman `true`:
/// `FileDB::isReady()` koşulsuz `true` dönüyor.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ControllerStatus {
    #[serde(default)]
    pub controller: bool,
    #[serde(default, rename = "apiVersion")]
    pub api_version: i64,
    #[serde(default, rename = "databaseReady")]
    pub database_ready: bool,
}

/// Controller'ın döndürdüğü ağ nesnesinden OKUNAN kadarı.
///
/// Tam alan kümesi yirmiden fazla; buradaki alt küme, bir yazmanın gerçekten uygulandığını
/// doğrulamak için gerekenler. Okunmayan bir alanı yapıya koymak, doğrulanmayan bir şeyi
/// doğrulanmış gibi göstermek olurdu.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NetworkRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub private: bool,
    #[serde(default, rename = "v4AssignMode")]
    pub v4_assign_mode: V4AssignMode,
    #[serde(default, rename = "ipAssignmentPools")]
    pub pools: Vec<Pool>,
    #[serde(default)]
    pub routes: Vec<Route>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct V4AssignMode {
    #[serde(default)]
    pub zt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pool {
    #[serde(rename = "ipRangeStart")]
    pub start: String,
    #[serde(rename = "ipRangeEnd")]
    pub end: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    pub target: String,
    /// Her zaman var, ve yokluğu JSON `null`. Bir LAN'a köprülenmeyen ağda hep `null`.
    #[serde(default)]
    pub via: Option<String>,
}

/// Controller'ın döndürdüğü üye nesnesinden OKUNAN kadarı.
///
/// `online` ve `lastSeen` BURADA YOK, ve olmadıkları için de eklenmiyor: dosya tabanlı controller
/// bu bilgiyi hiç yazmıyor — yalnız Central'ın PostgreSQL controller'ı yüzeye çıkarıyor. Bir
/// "çevrimdışı" rozeti göstermek, bilinmeyen bir şeyi bilinen gibi sunmak olurdu.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MemberRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub authorized: bool,
    /// Kullanıcının verdiği ad. Cihaz hiç adlandırılmadıysa boş.
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "ipAssignments")]
    pub ip_assignments: Vec<String>,
    /// Controller ilk temasta öğrenip SABİTLİYOR. Boşsa cihaz henüz hiç bağlanmamış —
    /// yani bu bir ÖN yetkilendirme, ve o adresi ilk kim kullanırsa kimliği o sabitliyor.
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub revision: i64,
}

// ── gövdeler ──

/// Yeni bir ağın yapılandırması.
///
/// Dört alan, ve dördü de gerekli. Yalnız ağ yaratıp bırakmak, hiçbir üyenin adres ALAMADIĞI bir
/// ağ üretiyor: varsayılan `v4AssignMode.zt` `false`, varsayılan havuz boş, varsayılan rota yok.
/// Kurulum o hâlde "başarılı" derdi ve ev hiçbir cihazın bağlanamadığı bir ağla kalırdı.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetworkConfig {
    pub name: String,
    /// HER ZAMAN `true`. Açık bir ağ, isteyen herkesi kendiliğinden yetkilendiriyor — ve o durumda
    /// arayüzdeki "Yetkilendir" düğmesi hiçbir şey yapmayan bir düğme olurdu. Bu alan operand
    /// DEĞİL: kapalı işlem kümesi, "ağı herkese aç" diye bir yetenek sunmuyor.
    pub private: bool,
    #[serde(rename = "v4AssignMode")]
    pub v4_assign_mode: V4AssignMode,
    #[serde(rename = "ipAssignmentPools")]
    pub ip_assignment_pools: Vec<Pool>,
    pub routes: Vec<Route>,
}

impl NetworkConfig {
    pub fn new(name: &str, subnet: &Ipv4Prefix) -> Self {
        Self {
            name: name.to_string(),
            private: true,
            v4_assign_mode: V4AssignMode { zt: true },
            ip_assignment_pools: vec![Pool {
                start: subnet.first_host(),
                end: subnet.last_host(),
            }],
            // Rota, üyelere "bu blok bu ağın üzerinden" diyen şey. Havuz olup rota olmazsa
            // cihazlar adres alıyor ve birbirlerine ULAŞAMIYOR.
            routes: vec![Route {
                target: subnet.as_str().to_string(),
                via: None,
            }],
        }
    }

    pub fn to_body(&self) -> String {
        // `serde_json`, `format!` değil: ağ adı kullanıcıdan geliyor. Bkz. modül notu.
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Bir üyenin yetkisini açan ya da kapatan gövde.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemberConfig {
    pub authorized: bool,
    /// Cihazın adı. `None` ise gönderilmiyor — boş bir ad göndermek, kullanıcının verdiği adı
    /// yetkilendirme sırasında SİLMEK olurdu.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl MemberConfig {
    pub fn to_body(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

// ── yollar ──

/// `GET /controller`
pub const STATUS_PATH: &str = "/controller";

/// `GET /controller/network`
pub const NETWORKS_PATH: &str = "/controller/network";

/// Yeni ağ yaratma yolu: `<kendi 10 haneli adresi>` + TAM ALTI alt çizgi.
///
/// Eski biçim bilerek seçildi. Modern biçim (`POST /controller/network`, yolda kimlik yok) yalnız
/// 1.12'den beri var; bu biçim 1.10 dahil her sürümde çalışıyor, ve bir ev NAS'ının hangi ZeroTier
/// sürümünü çalıştırdığı DEPSIS'in seçtiği bir şey değil.
pub fn create_path(node: &NodeAddress) -> String {
    format!("/controller/network/{}______", node.as_str())
}

pub fn network_path(network_id: &NetworkId) -> String {
    format!("/controller/network/{}", network_id.as_str())
}

pub fn members_path(network_id: &NetworkId) -> String {
    format!("/controller/network/{}/member", network_id.as_str())
}

pub fn member_path(network_id: &NetworkId, member: &NodeAddress) -> String {
    format!(
        "/controller/network/{}/member/{}",
        network_id.as_str(),
        member.as_str()
    )
}

// ── ayrıştırma ──

/// `GET /controller/network` — çıplak bir dizi, sarmalayıcı yok.
///
/// KAPSAYICI ŞEKLİ SIKI ayrıştırılıyor. Dizi olmayan bir gövde boş listeye DÜŞMÜYOR, hata oluyor:
/// yolu yanlış yazılmış bir uç ya da değişmiş bir API, aksi hâlde "hiç ağınız yok" diyen bir ekran
/// üretirdi — ve o ekran, ağı olan biri için sessiz bir yalan.
pub fn parse_network_ids(body: &[u8]) -> Result<Vec<NetworkId>, String> {
    let raw: Vec<String> = serde_json::from_slice(body)
        .map_err(|e| format!("/controller/network bir dizi değil: {e}"))?;
    raw.into_iter()
        .map(|id| NetworkId::parse(id).map_err(|e| format!("ağ kimliği okunamadı: {e}")))
        .collect()
}

/// `GET /controller/network/<id>/member` — kimlikten sürüme bir NESNE, dizi değil.
///
/// Aynı sıkılık, aynı sebeple: nesne olmayan bir gövde boş listeye düşseydi, altı cihazı olan bir
/// ağın üye ekranı sıfır gösterirdi ve hiçbir yerde hata olmazdı.
pub fn parse_member_ids(body: &[u8]) -> Result<Vec<NodeAddress>, String> {
    let raw: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(body).map_err(|e| format!("üye listesi bir nesne değil: {e}"))?;
    let mut found: Vec<NodeAddress> = raw
        .into_iter()
        .map(|(id, _revision)| {
            NodeAddress::parse(id).map_err(|e| format!("üye adresi okunamadı: {e}"))
        })
        .collect::<Result<_, _>>()?;
    // Sıralı, çünkü nesnenin anahtar sırası garanti değil ve her yenilemede satırları yer
    // değiştiren bir liste okunabilir değil.
    found.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    Ok(found)
}

pub fn parse_status(body: &[u8]) -> Result<ControllerStatus, String> {
    serde_json::from_slice(body).map_err(|e| format!("/controller okunamadı: {e}"))
}

pub fn parse_network(body: &[u8]) -> Result<NetworkRecord, String> {
    serde_json::from_slice(body).map_err(|e| format!("ağ nesnesi okunamadı: {e}"))
}

pub fn parse_member(body: &[u8]) -> Result<MemberRecord, String> {
    serde_json::from_slice(body).map_err(|e| format!("üye nesnesi okunamadı: {e}"))
}

// ── doğrulama ──

/// Yazılan yapılandırma GERÇEKTEN uygulandı mı.
///
/// BU FONKSİYON BU DOSYANIN VAR OLMA SEBEBİ. Controller tanımadığı alanı sessizce atıyor ve yine
/// de 200 dönüyor: yanlış yazılmış bir anahtar, unutulmuş bir `v4AssignMode`, yanlış biçimli bir
/// havuz — hepsi "başarılı" görünüyor ve sonuç hiçbir cihazın adres alamadığı bir ağ. Kurulum
/// ekranı yeşil, ağ ölü, ve hata hiçbir yerde yok.
///
/// Dönen nesneyi okuyup istenen değerleri arıyor. Eksik olanı CÜMLESİYLE söylüyor.
pub fn config_shortfall(wanted: &NetworkConfig, got: &NetworkRecord) -> Vec<String> {
    let mut missing = Vec::new();
    if !got.private {
        missing.push("ağ herkese açık kaldı (private uygulanmadı)".to_string());
    }
    if !got.v4_assign_mode.zt {
        missing.push("IPv4 otomatik atama açılmadı (v4AssignMode.zt)".to_string());
    }
    let wanted_pool = wanted.ip_assignment_pools.first();
    if let Some(pool) = wanted_pool {
        if !got.pools.contains(pool) {
            missing.push(format!(
                "adres havuzu uygulanmadı ({} – {})",
                pool.start, pool.end
            ));
        }
    }
    if let Some(route) = wanted.routes.first() {
        if !got.routes.iter().any(|r| r.target == route.target) {
            missing.push(format!("rota uygulanmadı ({})", route.target));
        }
    }
    missing
}

// ── the calls ──
//
// Each one is a thin orchestration over `zerotier::call`: the same socket, the same token, the
// same hand-written HTTP the five existing operations use. No new trust surface — and no
// caller-supplied path, method or body reaches any of them, because every operand is a validated
// newtype and every body is built by `serde_json` from a typed struct.

use crate::zerotier::{call, Method, ZeroTierError};

/// Is this node a controller, and is its store ready?
pub fn status() -> Result<ControllerStatus, ZeroTierError> {
    let body = call(Method::Get, STATUS_PATH, "")?;
    parse_status(&body).map_err(ZeroTierError::Protocol)
}

/// The networks this node controls.
pub fn networks() -> Result<Vec<NetworkId>, ZeroTierError> {
    let body = call(Method::Get, NETWORKS_PATH, "")?;
    parse_network_ids(&body).map_err(ZeroTierError::Protocol)
}

/// One network's stored record.
pub fn network(network_id: &NetworkId) -> Result<NetworkRecord, ZeroTierError> {
    let body = call(Method::Get, &network_path(network_id), "")?;
    parse_network(&body).map_err(ZeroTierError::Protocol)
}

/// Create a network and configure it in one go, verifying that the configuration STUCK.
///
/// Two calls, and the second is the one that matters. Creation alone produces a network no device
/// can use: `v4AssignMode.zt` defaults false, the pool is empty, there is no route. And the
/// configuring POST answers 200 whether or not it understood the body — the controller drops
/// fields it does not recognise in silence — so the applied record is read back and compared.
///
/// The shortfall, when there is one, is returned rather than thrown: the network EXISTS by then,
/// and a caller that was told "failed" would create a second one on the next attempt.
pub fn create_network(
    node: &NodeAddress,
    name: &str,
    subnet: &Ipv4Prefix,
) -> Result<(NetworkRecord, Vec<String>), ZeroTierError> {
    let created = call(Method::Post, &create_path(node), "{}")?;
    let created = parse_network(&created).map_err(ZeroTierError::Protocol)?;
    let network_id = NetworkId::parse(created.id.clone()).map_err(|e| {
        // The controller answered 200 with something that is not a network id. Reported rather
        // than retried: a second create would leave two networks and the caller would know about
        // neither.
        ZeroTierError::Protocol(format!(
            "controller yeni ağa geçersiz bir kimlik verdi: {e}"
        ))
    })?;

    let wanted = NetworkConfig::new(name, subnet);
    let applied = call(Method::Post, &network_path(&network_id), &wanted.to_body())?;
    let applied = parse_network(&applied).map_err(ZeroTierError::Protocol)?;

    Ok((applied.clone(), config_shortfall(&wanted, &applied)))
}

/// Every member of one network, each fetched in full.
///
/// N+1 BY CONSTRUCTION, and there is no batch endpoint: the list call answers a map of id to
/// revision and nothing else — no name, no authorization, no address. The per-member fetch is the
/// only way to learn any of it.
///
/// A MEMBER THAT FAILS TO FETCH ABORTS THE WHOLE LIST. Skipping it would produce a members screen
/// that is quietly one row short, and that screen's entire job is to let somebody spot the row
/// that should not be there. `bound` caps the work; going over it is a refusal naming the count,
/// never a truncated list shown as complete.
pub fn members(network_id: &NetworkId, bound: usize) -> Result<Vec<MemberRecord>, ZeroTierError> {
    let listed = call(Method::Get, &members_path(network_id), "")?;
    let ids = parse_member_ids(&listed).map_err(ZeroTierError::Protocol)?;
    if ids.len() > bound {
        return Err(ZeroTierError::Protocol(format!(
            "bu ağda {} üye var; en fazla {bound} tanesi okunabiliyor",
            ids.len()
        )));
    }

    let mut found = Vec::with_capacity(ids.len());
    for id in &ids {
        let body = call(Method::Get, &member_path(network_id, id), "")?;
        found.push(parse_member(&body).map_err(ZeroTierError::Protocol)?);
    }
    Ok(found)
}

/// One member, as stored.
pub fn member(
    network_id: &NetworkId,
    member_id: &NodeAddress,
) -> Result<MemberRecord, ZeroTierError> {
    let body = call(Method::Get, &member_path(network_id, member_id), "")?;
    parse_member(&body).map_err(ZeroTierError::Protocol)
}

/// Authorize or de-authorize a member, and VERIFY the flag came back the way it was sent.
///
/// The status code is not the answer. A body the controller does not understand is discarded and
/// still answers 200, so `authorized` is read out of the returned record; a mismatch is reported
/// rather than announced as success. On this operation in particular that matters in the direction
/// that costs access: a de-authorization reported as done but not applied leaves somebody
/// believing a stolen laptop was cut off.
pub fn set_authorized(
    network_id: &NetworkId,
    member_id: &NodeAddress,
    authorized: bool,
    label: Option<&str>,
) -> Result<MemberRecord, ZeroTierError> {
    let wanted = MemberConfig {
        authorized,
        name: label.map(str::to_string),
    };
    let body = call(
        Method::Post,
        &member_path(network_id, member_id),
        &wanted.to_body(),
    )?;
    let applied = parse_member(&body).map_err(ZeroTierError::Protocol)?;

    if applied.authorized != authorized {
        return Err(ZeroTierError::Protocol(format!(
            "controller {} için yetkiyi {} yapmadı; hâlâ {}",
            member_id.as_str(),
            authorized,
            applied.authorized
        )));
    }
    Ok(applied)
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

    fn prefix(s: &str) -> Ipv4Prefix {
        Ipv4Prefix::parse(s).expect("a usable prefix")
    }

    fn node(s: &str) -> NodeAddress {
        NodeAddress::parse(s).expect("a usable address")
    }

    fn network(s: &str) -> NetworkId {
        NetworkId::parse(s).expect("a usable network id")
    }

    #[test]
    fn a_name_cannot_break_out_of_the_json_body() {
        // THE ONE THAT TURNS THE NETWORK PUBLIC. Assembled with format!, a name of
        // `x","private":false,"z":"` would flip `private` and the controller would then
        // auto-authorize every node that asked — making the Authorize button in the UI theatre.
        let evil = r#"x","private":false,"z":"#;
        let body = NetworkConfig::new(evil, &prefix("10.147.20.0/24")).to_body();

        let back: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
        assert_eq!(back["private"], serde_json::json!(true));
        assert_eq!(back["name"], serde_json::json!(evil));
    }

    #[test]
    fn a_new_network_carries_everything_a_device_needs_to_get_an_address() {
        // Creating a network and stopping there yields one where nothing can get an address:
        // v4AssignMode.zt defaults false, the pool defaults empty, there is no route. Setup would
        // report success and the household would have a network no device can join usefully.
        let config = NetworkConfig::new("Ev", &prefix("10.147.20.0/24"));
        assert!(config.private);
        assert!(config.v4_assign_mode.zt);
        assert_eq!(
            config.ip_assignment_pools,
            vec![Pool {
                start: "10.147.20.1".to_string(),
                end: "10.147.20.254".to_string(),
            }]
        );
        // A pool without a route hands out addresses to devices that then cannot reach each other.
        assert_eq!(config.routes[0].target, "10.147.20.0/24");
        assert_eq!(config.routes[0].via, None);
    }

    #[test]
    fn a_write_that_silently_did_nothing_is_reported() {
        // The controller drops fields it does not recognise and still answers 200. This is the
        // check that turns "green screen, dead network" into a sentence.
        let wanted = NetworkConfig::new("Ev", &prefix("10.147.20.0/24"));

        let applied = NetworkRecord {
            id: "a1b2c3d4e5000001".to_string(),
            name: "Ev".to_string(),
            private: true,
            v4_assign_mode: V4AssignMode { zt: true },
            pools: wanted.ip_assignment_pools.clone(),
            routes: wanted.routes.clone(),
        };
        assert_eq!(config_shortfall(&wanted, &applied), Vec::<String>::new());

        // Everything the controller could quietly ignore, one at a time.
        let ignored = NetworkRecord {
            private: false,
            v4_assign_mode: V4AssignMode { zt: false },
            pools: Vec::new(),
            routes: Vec::new(),
            ..applied.clone()
        };
        let missing = config_shortfall(&wanted, &ignored);
        assert_eq!(missing.len(), 4, "{missing:?}");
        assert!(missing.iter().any(|m| m.contains("private")));
        assert!(missing.iter().any(|m| m.contains("v4AssignMode")));
        assert!(missing.iter().any(|m| m.contains("havuz")));
        assert!(missing.iter().any(|m| m.contains("rota")));
    }

    #[test]
    fn the_create_path_is_the_form_that_works_on_every_version() {
        // Exactly six underscores; the regex in EmbeddedNetworkController is
        // "/controller/network/([0-9a-fA-F]{10})______". Five or seven does not match, and a
        // non-matching path is a 404 that reads as "this build has no controller".
        let path = create_path(&node("a1b2c3d4e5"));
        assert_eq!(path, "/controller/network/a1b2c3d4e5______");
        assert_eq!(path.matches('_').count(), 6);
    }

    #[test]
    fn a_container_of_the_wrong_shape_is_an_error_and_never_an_empty_list() {
        // THE SILENT-NOTHING FAILURE. A mistyped path or a changed API would otherwise produce a
        // screen saying "you have no networks" to somebody who has one, with no error anywhere.
        assert!(parse_network_ids(br#"{"networks":[]}"#).is_err());
        assert!(parse_network_ids(br#"not json"#).is_err());
        assert!(parse_member_ids(br#"["1122334455"]"#).is_err());

        // And the legitimate empty cases still parse, because a fresh controller really has none.
        assert_eq!(parse_network_ids(b"[]").expect("empty"), Vec::new());
        assert_eq!(parse_member_ids(b"{}").expect("empty"), Vec::new());
    }

    #[test]
    fn ids_are_validated_on_the_way_in_rather_than_trusted() {
        assert!(parse_network_ids(br#"["nothexdigits!!"]"#).is_err());
        assert!(parse_member_ids(br#"{"TOOSHORT":1}"#).is_err());

        let ids = parse_network_ids(br#"["a1b2c3d4e5000001","a1b2c3d4e5000002"]"#).expect("parses");
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0].as_str(), "a1b2c3d4e5000001");
    }

    #[test]
    fn members_come_back_in_a_stable_order() {
        // A JSON object has no guaranteed key order, and a member list that reshuffles on every
        // refresh is a list nobody can read — least of all to spot the row that should not be there.
        let body = br#"{"cc33445566":3,"aa11223344":1,"bb22334455":2}"#;
        let ids = parse_member_ids(body).expect("parses");
        assert_eq!(
            ids.iter().map(NodeAddress::as_str).collect::<Vec<_>>(),
            vec!["aa11223344", "bb22334455", "cc33445566"]
        );
    }

    #[test]
    fn a_member_body_omits_the_name_rather_than_blanking_it() {
        // Sending "name": "" while authorizing would erase the label the household gave the
        // device, on the one action most likely to be repeated.
        let plain = MemberConfig {
            authorized: true,
            name: None,
        };
        assert_eq!(plain.to_body(), r#"{"authorized":true}"#);

        let named = MemberConfig {
            authorized: true,
            name: Some("Ayşe'nin dizüstü".to_string()),
        };
        let back: serde_json::Value = serde_json::from_str(&named.to_body()).expect("valid");
        assert_eq!(back["name"], serde_json::json!("Ayşe'nin dizüstü"));
    }

    #[test]
    fn the_member_path_carries_both_ids_and_nothing_else() {
        let path = member_path(&network("a1b2c3d4e5000001"), &node("1122334455"));
        assert_eq!(
            path,
            "/controller/network/a1b2c3d4e5000001/member/1122334455"
        );
        // Neither operand can contribute anything but hex — both are validated newtypes — so no
        // amount of caller input can add a path segment or a query.
        assert!(!path.contains("..") && !path.contains('?') && !path.contains('&'));
    }

    #[test]
    fn a_status_body_that_says_nothing_does_not_read_as_a_working_controller() {
        // `controller: false` and a body with the field missing must both be "no", because the
        // field defaults to false — the safe direction. Claiming controller support that is not
        // there would offer a Create button that 404s.
        assert!(!parse_status(b"{}").expect("parses").controller);
        assert!(
            !parse_status(br#"{"controller":false,"apiVersion":4}"#)
                .expect("parses")
                .controller
        );

        let ready = parse_status(br#"{"controller":true,"apiVersion":4,"databaseReady":true}"#)
            .expect("parses");
        assert!(ready.controller && ready.database_ready);
        assert_eq!(ready.api_version, 4);
    }

    #[test]
    fn a_member_with_no_pinned_identity_is_visible_as_such() {
        // A pre-authorized member — the admin typed the address before the device ever appeared —
        // has an empty `identity`. That distinction is the difference between "my friend's laptop
        // is authorized" and "whoever turns up at this address first will be let in", and the
        // screen has to be able to tell them apart.
        let pending = parse_member(br#"{"id":"1122334455","authorized":true}"#).expect("parses");
        assert!(pending.identity.is_empty());

        let seen = parse_member(
            br#"{"id":"1122334455","authorized":true,"identity":"1122334455:0:abc","ipAssignments":["10.147.20.5"]}"#,
        )
        .expect("parses");
        assert!(!seen.identity.is_empty());
        assert_eq!(seen.ip_assignments, vec!["10.147.20.5"]);
    }
}
