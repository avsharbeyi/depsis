//! Tarama (scrub): ZFS'in sağlama toplamlarının işe yaradığı tek an.
//!
//! ZFS her bloğun sağlama toplamını tutuyor ve bozulmuş bir bloğu OKUNDUĞUNDA fark ediyor. Sessiz
//! bit çürümesinin problemi tam da bu: bir yedek arşivi yıllarca okunmuyor, yani bozulma yıllarca
//! fark edilmiyor, ve fark edildiği gün — dosyanın gerçekten gerektiği gün — kopyası da bozulmuş
//! olabiliyor. `zpool scrub` her bloğu okuyup sağlamasını doğrulayan şey; ayna ya da RAIDZ varsa
//! bozuk olanı sağlam kopyadan onarıyor.
//!
//! BU MODÜL TARAMA ZAMANLAMIYOR, ve gerekçesi yazılmalı: Debian'ın `zfsutils-linux` paketi zaten
//! `/etc/cron.d/zfsutils-linux` ile aylık bir tarama koyuyor. Eksik olan şey zamanlama değil
//! GÖRÜNÜRLÜK — bir taramanın koşup koşmadığını, ne bulduğunu ve devam edip etmediğini DEPSIS'in
//! hiçbir ekranı söylemiyordu. Bulduğu hataları kimsenin görmediği bir tarama, hiç koşmamış bir
//! taramadan yalnızca daha pahalı.
//!
//! ÇIKTI OLDUĞU GİBİ TAŞINIYOR, AYRIŞTIRILMIYOR. `zpool status` insan için yazılmış bir metin ve
//! `scan:` satırındaki tarih yerel biçimde, yani ayrıştırması kırılgan. Onu bir zaman damgasına
//! çevirmeye çalışmak, yanlış çevirdiğinde "en son ne zaman tarandı" sorusuna kendinden emin ve
//! yanlış bir cevap vermek olurdu. Satırın kendisi geçiyor; kullanıcı `zpool status`'ün söylediğini
//! okuyor, DEPSIS'in ondan çıkardığını değil.

/// `zpool status <pool>` — insan için yazılmış çıktı, olduğu gibi.
pub fn status_argv(pool: &str) -> Vec<&str> {
    vec!["status", pool]
}

/// `zpool scrub <pool>` — her bloğu oku, sağlamasını doğrula, onarabildiğini onar.
///
/// `-s` (durdur) ve `-p` (duraklat) YOK. Bir taramayı durdurmak, onu hiç başlatmamış olmakla aynı
/// sonucu veriyor ve kapalı işlem kümesine ikinci bir varyant eklemeyi gerektiriyor; ihtiyaç
/// duyulduğunda eklenir, o zamana kadar burada bulunmayan bir düğme daha az yüzey.
pub fn scrub_argv(pool: &str) -> Vec<&str> {
    vec!["scrub", pool]
}

/// Bir havuzun tarama durumu, `zpool status` çıktısından okunduğu kadarıyla.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScrubInfo {
    /// `scan:` satırının tamamı, olduğu gibi. Boş, satır hiç yoksa.
    pub scan: String,
    /// `errors:` satırının tamamı, olduğu gibi.
    pub errors: String,
    /// Şu anda bir tarama sürüyor mu.
    pub in_progress: bool,
    /// Bilinen bir veri hatası var mı.
    ///
    /// TEK ÇIKARIM, ve tek olması bilinçli. `zpool status` bilinen hata yokken tam olarak
    /// "No known data errors" yazıyor; başka her şey bir insanın bakması gereken hâl. Bunu tersten
    /// kurmak — "şu kalıplar hatadır" — yeni bir ZFS sürümünün yeni bir cümlesini sessizce
    /// "sorun yok" saymak olurdu.
    pub has_errors: bool,
}

/// `zpool status` çıktısını, güvenle okunabilecek kadarıyla oku.
///
/// İKİ SATIR VE İKİ BOOLEAN. Tarih yok, yüzde yok, onarılan bayt yok — hepsi yerel biçimli metin
/// içinde ve hepsini ayrıştırmak, yanlış ayrıştırdığında kendinden emin ve yanlış bir cevap
/// üretmek demek. Satırlar olduğu gibi taşınıyor.
///
/// `scan:` satırı ÇOK SATIRLI olabiliyor (süren bir taramada ilerleme bir alt satırda). Devamı
/// alınıyor: yalnız ilk satır "scrub in progress since ..." der ve yüzdeyi düşürürdü, ki bekleyen
/// bir kullanıcının tam olarak bakmak istediği sayı odur.
pub fn parse_status(out: &str) -> ScrubInfo {
    let mut info = ScrubInfo::default();
    let mut collecting_scan = false;

    for line in out.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("scan:") {
            info.scan = rest.trim().to_string();
            collecting_scan = true;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("errors:") {
            info.errors = rest.trim().to_string();
            collecting_scan = false;
            continue;
        }
        // Yeni bir başlık, `scan:`in devamını bitiriyor. `zpool status` her başlığı satır başında
        // `<ad>:` olarak yazıyor, ve havuz ağacının satırları girintili — o yüzden ayırt eden şey
        // GİRİNTİ DEĞİL, iki nokta üst üstenin ilk kelimede olması.
        if collecting_scan {
            let is_heading = trimmed
                .split_whitespace()
                .next()
                .is_some_and(|word| word.ends_with(':'));
            if is_heading || trimmed.is_empty() {
                collecting_scan = false;
                continue;
            }
            info.scan.push(' ');
            info.scan.push_str(trimmed);
        }
    }

    info.in_progress = info.scan.contains("in progress");
    // Bilinen hata yokken ZFS tam olarak bunu yazıyor. Tersten kurmak — "şu kalıplar hatadır" —
    // yeni bir sürümün yeni bir cümlesini sessizce "sorun yok" saymak olurdu.
    info.has_errors = !info.errors.is_empty() && info.errors != "No known data errors";
    info
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

    const CLEAN: &str = "  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:12:31 with 0 errors on Sun Aug 24 03:12:31 2026
config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        ONLINE       0     0     0
\t  mirror-0  ONLINE       0     0     0

errors: No known data errors
";

    const RUNNING: &str = "  pool: tank
 state: ONLINE
  scan: scrub in progress since Mon Aug 25 03:00:00 2026
\t1.20T / 3.40T scanned at 480M/s, 900G / 3.40T issued at 350M/s
\t0B repaired, 26.47% done, 02:10:15 to go
config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        ONLINE       0     0     0

errors: No known data errors
";

    const DAMAGED: &str = "  pool: tank
 state: DEGRADED
  scan: scrub repaired 128K in 00:14:02 with 2 errors on Sun Aug 24 03:14:02 2026
config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        DEGRADED     0     0     2

errors: Permanent errors have been detected in the following files:

        /srv/depsis/shares/Belgeler/rapor.pdf
";

    #[test]
    fn a_finished_scrub_reports_its_own_sentence_and_no_errors() {
        let info = parse_status(CLEAN);
        assert!(info.scan.starts_with("scrub repaired 0B"), "{}", info.scan);
        assert_eq!(info.errors, "No known data errors");
        assert!(!info.in_progress);
        // THE ONE INFERENCE. Everything else on this screen is `zpool status`'s own words.
        assert!(!info.has_errors);
    }

    #[test]
    fn a_running_scrub_carries_its_progress_from_the_continuation_lines() {
        // The percentage is on the SECOND line of `scan:`. Taking only the first would leave a
        // waiting user with "in progress since Monday" and no answer to "how far".
        let info = parse_status(RUNNING);
        assert!(info.in_progress, "{}", info.scan);
        assert!(info.scan.contains("26.47% done"), "{}", info.scan);
        assert!(info.scan.contains("02:10:15 to go"), "{}", info.scan);
        // And the continuation stops at the next heading rather than swallowing the pool tree.
        assert!(!info.scan.contains("NAME"), "{}", info.scan);
        assert!(!info.scan.contains("mirror"), "{}", info.scan);
    }

    #[test]
    fn permanent_errors_are_reported_as_errors() {
        // THE WHOLE POINT OF SCRUBBING. A pool that found unrepairable damage and reported it as
        // "fine" would be worse than not scrubbing: it would make the damage look checked.
        let info = parse_status(DAMAGED);
        assert!(info.has_errors);
        assert!(
            info.errors.starts_with("Permanent errors"),
            "{}",
            info.errors
        );
        assert!(info.scan.contains("with 2 errors"), "{}", info.scan);
    }

    #[test]
    fn a_pool_that_has_never_been_scrubbed_says_so_rather_than_looking_clean() {
        let info = parse_status("  pool: tank\n state: ONLINE\n  scan: none requested\n\nerrors: No known data errors\n");
        assert_eq!(info.scan, "none requested");
        assert!(!info.in_progress);
        assert!(!info.has_errors);
    }

    #[test]
    fn output_with_no_scan_line_is_empty_rather_than_invented() {
        let info = parse_status("  pool: tank\n state: ONLINE\n");
        assert_eq!(info.scan, "");
        assert_eq!(info.errors, "");
        // No scan line and no errors line is "nothing was said", NOT "nothing is wrong". The API
        // shows the empty string as "bilinmiyor" rather than as a clean bill of health.
        assert!(!info.has_errors);
    }

    #[test]
    fn an_unfamiliar_errors_sentence_counts_as_errors() {
        // Built the safe way round. A future ZFS wording that this code has never seen must land
        // on "somebody should look", not on "fine" — the opposite construction ("these patterns
        // mean trouble") would silently pass anything new.
        let info =
            parse_status("  scan: none requested\nerrors: 3 data errors, use '-v' for a list\n");
        assert!(info.has_errors);
    }

    #[test]
    fn neither_argv_carries_anything_but_the_pool() {
        assert_eq!(status_argv("tank"), vec!["status", "tank"]);
        assert_eq!(scrub_argv("tank"), vec!["scrub", "tank"]);
        // No `-s`, no `-p`. Stopping or pausing a scrub is a second variant in a closed operation
        // set, and one that buys nothing a fresh start does not.
        for argv in [status_argv("tank"), scrub_argv("tank")] {
            assert!(!argv.contains(&"-s"));
            assert!(!argv.contains(&"-p"));
        }
    }
}
