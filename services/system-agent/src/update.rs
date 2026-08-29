//! Cihazın kendini güncellemesi — bu işin ajana düşen yarısı.
//!
//! NEDEN BU KADAR AZI BURADA. Ajanın birimi `IPAddressDeny=any` taşıyor ve tek deliği localhost:
//! kök yetkili bir daemon'ın internete çıkmaması bilinçli bir karar (bkz. `depsis-agent.service`).
//! Güncelleme ise tanımı gereği ağdan bir şey indirmek. İkisini uzlaştırmanın doğru yolu ajanın
//! kapısını açmak değil, indirmeyi BAŞKA bir birime vermek: `depsis-update-check.service` ve
//! `depsis-update.service`. Ajana kalan üç şey: birimi başlat, birimin durumunu sor, güncelleyicinin
//! yazdığı durum dosyasını oku.
//!
//! ÇAĞIRANIN SEÇTİĞİ HİÇBİR OPERAND YOK, ve bu ADR-0006 §2.2'nin burada aldığı biçim. "Hangi
//! sürüme geçilecek" sorusunu istek değil, bir önceki DENETİM cevaplıyor: denetim ne bulduysa
//! `state.json`'a yazıyor, uygulama tam onu kuruyor. Ekranda gördüğü sürümü onaylayan operatör
//! kurulacak sürümü onaylamış oluyor, ve arada gelen yeni bir commit onaylanmamış kod olarak
//! kalıyor.
//!
//! DURUM DOSYASI BİR SÖZLEŞME: güncelleyici betik yazar, burası yalnız okur, ve okuma HOŞGÖRÜLÜ —
//! eksik alan, tanınmayan faz, bozuk JSON, hiçbiri işlemi düşürmez. Bir güncelleme ekranının en
//! kötü hâli, güncellemenin ne durumda olduğunu söyleyememesidir.

use std::path::PathBuf;

use serde::Deserialize;

/// Güncelleyicinin durumunu yazdığı yer. Dizin ajanın değil, kurulumun eseri.
pub const DEFAULT_STATE_FILE: &str = "/var/lib/depsis/update/state.json";

/// Üç yolun da ortamdan değiştirilebilmesinin sebebi `samba::CONFIG_PATH_ENV` ile aynı: ORTAM,
/// asla İSTEK. Ajanın ortamı systemd'nin `EnvironmentFile`'ından gelir, yani bu operatör
/// yapılandırmasıdır; istek enum'ında bir yol operandı yoktur ve olmamalıdır, çünkü "ayrıcalıklı
/// daemon hangi dosyayı okuyor" sorusunu yetkisiz bir çağıran cevaplayamaz. Testlerin bu üç
/// dosyayı geçici bir dizine alabilmesi ise ikincil bir kazanç — ama küçük değil: onlar olmadan
/// her iddia, testi koşturan makinede o dosyaların BULUNMAMASINA bel bağlardı.
pub const STATE_FILE_ENV: &str = "DEPSIS_UPDATE_STATE";
pub const LOG_FILE_ENV: &str = "DEPSIS_UPDATE_LOG";
pub const INSTALLED_VERSION_ENV: &str = "DEPSIS_INSTALLED_VERSION";

fn path_from(env: &str, default: &str) -> PathBuf {
    match std::env::var(env) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(default),
    }
}

pub fn state_file() -> PathBuf {
    path_from(STATE_FILE_ENV, DEFAULT_STATE_FILE)
}

pub fn log_file() -> PathBuf {
    path_from(LOG_FILE_ENV, DEFAULT_LOG_FILE)
}

pub fn installed_version_file() -> PathBuf {
    path_from(INSTALLED_VERSION_ENV, DEFAULT_INSTALLED_VERSION_FILE)
}

/// Güncelleyicinin çıktısı. Son satırları ekranda gösteriliyor; bir kurulum on dakika sürebilir ve
/// o süre boyunca yalnız "bekleyin" yazan bir ekran, çalışan bir kutuyu donmuş gösterir.
pub const DEFAULT_LOG_FILE: &str = "/var/lib/depsis/update/log";

/// Kurulu sürüm. `install.sh` yazar, ve tek satırdır: kurulan kaynağın commit'i.
pub const DEFAULT_INSTALLED_VERSION_FILE: &str = "/etc/depsis/version";

pub const CHECK_UNIT: &str = "depsis-update-check.service";
pub const APPLY_UNIT: &str = "depsis-update.service";

/// Ekranda gösterilen günlük kuyruğu. Kırk satır, bir kurulum adımının tamamını taşıyacak kadar
/// uzun; yanıtı şişirecek kadar değil.
pub const LOG_TAIL_LINES: usize = 40;

/// `systemctl start --no-block <birim>`.
///
/// `--no-block` şart: kurulum dakikalarca sürüyor ve ajanın kontrol soketi SIRALI (ADR-0006).
/// Bloklayan bir başlatma, güncelleme boyunca bütün ayrıcalıklı işlemleri durdururdu — yani
/// güncelleme sırasında arayüzün hiçbir şey gösterememesi demek olurdu.
pub fn start_argv(unit: &str) -> [&str; 3] {
    ["start", "--no-block", unit]
}

/// `systemctl show -p ActiveState --value <birim>`.
///
/// `is-active` DEĞİL: o, birim çalışmıyorken 3 ile çıkar ve koşucu sıfırdan farklı her çıkışı hata
/// sayar. "Çalışmıyor" bir hata değil bir cevaptır, ve cevabı hata olarak taşımak onu hata
/// metninden geri ayrıştırmak zorunda bırakırdı.
pub fn active_state_argv(unit: &str) -> [&str; 5] {
    ["show", "-p", "ActiveState", "--value", unit]
}

/// Güncelleyicinin bulduğu sürüm.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Candidate {
    pub commit: String,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub committed_at: Option<String>,
}

/// `state.json`'un tamamı, ve her alanı isteğe bağlı.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct State {
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub checked_at: Option<String>,
    #[serde(default)]
    pub available: Option<Candidate>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Bitmiş fazlar. Listelenen ŞUNLAR, ve tanınmayan bir faz BİTMEMİŞ sayılır.
///
/// Yön bilerek bu taraf. Tersi ("şu adlar sürüyor demek") tanımadığı bir fazı bitmiş sayardı ve
/// arayüz koşan bir güncellemenin üstüne ikinci bir "Güncelle" düğmesi açardı. Bilinmeyen bir
/// durumda yapılacak doğru şey düğmeyi kapalı tutmaktır.
const TERMINAL_PHASES: [&str; 3] = ["idle", "done", "failed"];

pub fn phase_is_terminal(phase: &str) -> bool {
    TERMINAL_PHASES.contains(&phase.trim())
}

/// Durum dosyasını oku. BOZUK JSON DA BİR CEVAPTIR.
///
/// Ayrıştırılamayan bir dosya, `error` alanına düşen bir cümleye ve `failed` fazına dönüşür.
/// Alternatif — işlemi hataya düşürmek — güncelleme ekranını tamamen kapatırdı, oysa operatörün
/// tam o anda görmesi gereken şey bir şeylerin bozulduğudur.
pub fn parse_state(raw: &str) -> State {
    if raw.trim().is_empty() {
        return State::default();
    }
    match serde_json::from_str::<State>(raw) {
        Ok(state) => state,
        Err(error) => State {
            phase: Some("failed".to_string()),
            error: Some(format!("güncelleme durumu okunamadı: {error}")),
            ..State::default()
        },
    }
}

/// `/etc/depsis/version`'ın içeriği: tek satır, boşlukları atılmış, boşsa yok.
pub fn installed_version(raw: &str) -> Option<String> {
    let line = raw.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

/// Günlüğün son satırları.
pub fn tail(raw: &str, lines: usize) -> Vec<String> {
    let all: Vec<&str> = raw.lines().collect();
    let start = all.len().saturating_sub(lines);
    all.get(start..)
        .unwrap_or(&[])
        .iter()
        .map(|line| (*line).to_string())
        .collect()
}

/// `systemctl show` bir birimin çalıştığını söylüyor mu.
///
/// `activating` de çalışıyor sayılır: `--no-block` ile başlatılan bir birim bir süre o durumda
/// kalır, ve tam o aralıkta "çalışmıyor" demek ikinci bir başlatmaya izin vermektir.
pub fn state_is_running(value: &str) -> bool {
    matches!(value.trim(), "active" | "activating" | "reloading")
}

/// Kurulu sürüm ile bulunan sürüm aynı mı.
///
/// İkisinden biri bilinmiyorsa cevap HAYIR. "Bilmiyorum"u "güncel" diye raporlamak, güncellemeyi
/// hiç yapmamanın en sessiz yolu olurdu.
pub fn up_to_date(installed: Option<&str>, available: Option<&str>) -> bool {
    match (installed, available) {
        (Some(a), Some(b)) => !a.is_empty() && a == b,
        _ => false,
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test kodu; başarısızlık zaten testin kendisidir"
)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_state_file_is_an_idle_box_and_not_an_error() {
        // Hiç güncelleme denenmemiş bir kutunun olağan hâli. Burada hata üretmek, kurulumdan
        // hemen sonra açılan ekranı bozuk gösterirdi.
        let state = parse_state("");
        assert!(state.phase.is_none());
        assert!(state.available.is_none());
        assert!(state.error.is_none());
    }

    #[test]
    fn a_corrupt_state_file_reports_failed_and_says_why() {
        // Güç kesintisi güncelleyicinin yazma anına denk gelirse dosya yarım kalır. Ekranın o
        // durumda söylemesi gereken şey "bir şey bozuldu", "her şey yolunda" değil.
        let state = parse_state("{\"phase\": \"appl");
        assert_eq!(state.phase.as_deref(), Some("failed"));
        assert!(state.error.expect("sebep").contains("okunamadı"));
    }

    #[test]
    fn an_unknown_phase_counts_as_still_running() {
        assert!(phase_is_terminal("idle"));
        assert!(phase_is_terminal("done"));
        assert!(phase_is_terminal("failed"));
        assert!(!phase_is_terminal("installing"));
        assert!(!phase_is_terminal("gelecekte-eklenmis-bir-faz"));
    }

    #[test]
    fn the_full_state_is_read_including_what_was_found() {
        let state = parse_state(
            r#"{"phase":"done","checked_at":"2026-08-29T10:00:00Z",
                "available":{"commit":"0123456789abcdef","subject":"bir sey",
                             "committed_at":"2026-08-28T09:00:00Z"},
                "started_at":"2026-08-29T10:01:00Z","finished_at":"2026-08-29T10:20:00Z"}"#,
        );
        assert_eq!(state.phase.as_deref(), Some("done"));
        let found = state.available.expect("available");
        assert_eq!(found.commit, "0123456789abcdef");
        assert_eq!(found.subject.as_deref(), Some("bir sey"));
        assert!(state.finished_at.is_some());
    }

    #[test]
    fn a_state_file_with_fields_this_agent_does_not_know_still_reads() {
        // Güncelleyici betik ajandan AYRI güncellenebilir (ikisi de aynı ISO'dan gelse de, bir
        // gün biri diğerinden önce değişir). Tanınmayan bir alan yüzünden durumun tamamını
        // kaybetmek, ileri uyumluluğu olmayan bir sözleşme demek olurdu.
        let state = parse_state(r#"{"phase":"installing","gelecek_alan":{"x":1}}"#);
        assert_eq!(state.phase.as_deref(), Some("installing"));
        assert!(!phase_is_terminal(state.phase.as_deref().unwrap_or("")));
    }

    #[test]
    fn an_unknown_version_is_never_reported_as_up_to_date() {
        assert!(!up_to_date(None, Some("abc")));
        assert!(!up_to_date(Some("abc"), None));
        assert!(!up_to_date(Some(""), Some("")));
        assert!(up_to_date(Some("abc"), Some("abc")));
        assert!(!up_to_date(Some("abc"), Some("abd")));
    }

    #[test]
    fn the_installed_version_is_one_trimmed_line() {
        assert_eq!(
            installed_version("  abc123  \nsonraki\n"),
            Some("abc123".to_string())
        );
        assert_eq!(installed_version("\n"), None);
        assert_eq!(installed_version(""), None);
    }

    #[test]
    fn the_log_tail_is_the_last_lines_and_never_panics_on_a_short_log() {
        let log = "bir\niki\nuc\ndort\n";
        assert_eq!(tail(log, 2), vec!["uc".to_string(), "dort".to_string()]);
        assert_eq!(tail(log, 99).len(), 4);
        assert!(tail("", 10).is_empty());
    }

    #[test]
    fn a_unit_that_is_starting_counts_as_running() {
        assert!(state_is_running("active"));
        assert!(state_is_running("activating\n"));
        assert!(!state_is_running("inactive"));
        assert!(!state_is_running("failed"));
    }

    #[test]
    fn the_argv_carries_no_operand_the_caller_chose() {
        // Birim adları sabit ve isteklerde hiçbir alan yok. Bu testin varlık sebebi, ileride bir
        // "hangi birim" parametresi eklenmesinin sessizce olmaması.
        assert_eq!(start_argv(APPLY_UNIT), ["start", "--no-block", APPLY_UNIT]);
        assert_eq!(
            active_state_argv(CHECK_UNIT),
            ["show", "-p", "ActiveState", "--value", CHECK_UNIT]
        );
    }
}
