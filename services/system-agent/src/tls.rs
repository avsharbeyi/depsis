//! Cihazın sunduğu TLS sertifikası: ne olduğu, ve sahibinin kendi sertifikasını koyabilmesi.
//!
//! NEDEN VAR. Kurulum kendinden imzalı bir sertifika üretiyor ve tarayıcı haklı olarak uyarıyor —
//! bir NAS'a ilk kez bağlanan tarayıcının o sertifikayı doğrulamasının yolu yok. Sahibinin kendi
//! alan adı varsa, o alan adı için aldığı sertifikayı kutuya koyabilmeli, ve bunun yolu bir kabuk
//! olmamalı: `scp` ile iki dosya kopyalayıp nginx'i yeniden yüklemek, ürünün kabul ölçütünün
//! dışında.
//!
//! ÖZEL ANAHTAR BİR İSTEK ALANINDA, ve bu, işlem kümesi hakkında söylenen bir şeyi değiştiriyor:
//! `audit` modülü "yüzey, sır taşıyabilecek bir alana sahip değil" diyordu. Artık sahip. Değişmeyen
//! şey, denetim kaydına ne yazıldığı: kayıt YALNIZ işlem adını taşıyor, isteğin kendisini değil —
//! yani anahtar journal'a hiç girmiyor. Alternatif tasarımlar tartıldı ve daha kötüydüler:
//! ajanın anahtarı kendisi üretip CSR döndürmesi (kullanıcıların elinde CSR değil, hazır bir
//! sertifika-anahtar çifti oluyor), ya da API'nin dosyayı bir kuyruğa yazması (API'nin
//! `/etc/depsis/tls` içine yazma yetkisi yok, ve olmamalı).
//!
//! DOĞRULAMA ÜÇ ŞEY, ve zincir doğrulaması bunlardan biri DEĞİL: sertifika ayrıştırılabilmeli,
//! özel anahtar o sertifikaya ait olmalı, ve sertifikanın süresi dolmamış olmalı. Hangi CA'nın
//! güvenilir olduğu tarayıcının kararı — kendi CA'sını kuran bir ev ağı da meşru, ve burada zincir
//! doğrulamak o kurulumu reddetmek olurdu.

use std::path::PathBuf;

/// nginx'in okuduğu yollar. `install.sh` bunları yazıyor ve nginx yapılandırmasına gömüyor.
pub const DEFAULT_CERT_PATH: &str = "/etc/depsis/tls/depsis.crt";
pub const DEFAULT_KEY_PATH: &str = "/etc/depsis/tls/depsis.key";

/// Yolların ortamdan değiştirilebilmesi `samba::CONFIG_PATH_ENV` ile aynı gerekçeyle: ORTAM, asla
/// İSTEK. "Ayrıcalıklı daemon hangi dosyanın üstüne yazıyor" sorusunu yetkisiz bir çağıran
/// cevaplayamaz — istek enum'ında bir yol operandı yok ve olmamalı.
pub const CERT_PATH_ENV: &str = "DEPSIS_TLS_CERT";
pub const KEY_PATH_ENV: &str = "DEPSIS_TLS_KEY";

/// Sertifika zinciri için üst sınır. Ara sertifikalarla birlikte bir zincir birkaç kilobayt;
/// 64 KiB, en abartılı zinciri bile taşır ve bir istek alanının sınırsız olmamasını sağlar.
pub const MAX_CERTIFICATE_BYTES: usize = 64 * 1024;
/// Özel anahtar için üst sınır. RSA-4096 bile 4 KiB'nin altında.
pub const MAX_KEY_BYTES: usize = 16 * 1024;

pub const OPENSSL: &str = "/usr/bin/openssl";
pub const NGINX: &str = "/usr/sbin/nginx";

fn path_from(env: &str, default: &str) -> PathBuf {
    match std::env::var(env) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(default),
    }
}

pub fn cert_path() -> PathBuf {
    path_from(CERT_PATH_ENV, DEFAULT_CERT_PATH)
}

pub fn key_path() -> PathBuf {
    path_from(KEY_PATH_ENV, DEFAULT_KEY_PATH)
}

/// Sertifikanın anlatısı, tek `openssl` çağrısında.
///
/// `-noout` şart: onsuz PEM'in kendisi de çıktıya giriyor ve yanıtı gereksizce şişiriyor.
///
/// SEÇENEK SONU İŞARETİ (`--`) YOK, ve bu dosyanın geri kalanındaki disipline aykırı değil:
/// `openssl` onu ANLAMIYOR — `x509 -in -- /yol` çağrısı "Use -help for summary" ile düşüyor
/// (ölçüldü, appliance kapısında). Yolun çağırandan gelmemesi de zaten burada; yollar
/// sabitlerden ya da ortamdan geliyor, istekten değil.
pub fn describe_argv(path: &str) -> [&str; 11] {
    [
        "x509",
        "-noout",
        "-subject",
        "-issuer",
        "-dates",
        "-fingerprint",
        "-sha256",
        "-ext",
        "subjectAltName",
        "-in",
        path,
    ]
}

/// Sertifikanın taşıdığı açık anahtar.
pub fn cert_pubkey_argv(path: &str) -> [&str; 5] {
    ["x509", "-noout", "-pubkey", "-in", path]
}

/// Özel anahtardan türetilen açık anahtar. İkisinin AYNI olması, çiftin gerçekten çift olduğunun
/// kanıtı — ve bu kontrol olmadan, kutuya birbirine ait olmayan iki dosya konabilir ve nginx
/// yeniden yüklenene kadar hiçbir şey yanlış görünmez.
pub fn key_pubkey_argv(path: &str) -> [&str; 4] {
    ["pkey", "-pubout", "-in", path]
}

/// Süresi dolmuş mu. `-checkend 0`: şu an geçerli değilse sıfırdan farklı çıkış.
pub fn checkend_argv(path: &str) -> [&str; 6] {
    ["x509", "-noout", "-checkend", "0", "-in", path]
}

/// nginx yapılandırması hâlâ geçerli mi. YENİDEN YÜKLEMEDEN ÖNCE, çünkü bozuk bir yapılandırmayla
/// `reload` çalışan nginx'i olduğu gibi bırakıp sessizce başarısız oluyor — yani "sertifika
/// kuruldu" derken tarayıcıya hâlâ eskisi sunulurdu.
pub fn nginx_test_argv() -> [&'static str; 1] {
    ["-t"]
}

/// Sertifikanın ekranda gösterilen hâli.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub subject: String,
    pub issuer: String,
    pub not_before: String,
    pub not_after: String,
    pub fingerprint: String,
    /// SAN listesi, `openssl`'in yazdığı gibi bölünmüş: `DNS:depsis`, `IP Address:127.0.0.1`.
    pub names: Vec<String>,
    /// Konu ile veren aynıysa. Tarayıcı uyarısının sebebi bu, ve ekranda söylenmesi gereken şey.
    pub self_signed: bool,
}

/// `openssl x509 -noout -subject -issuer -dates -fingerprint -sha256 -ext subjectAltName` çıktısı.
///
/// SATIR SATIR, ve tanınmayan satırlar atlanıyor: openssl sürümleri arasında başlıkların biçimi
/// değişiyor (`sha256 Fingerprint=` ile `SHA256 Fingerprint=` gibi), ve bir alanı okuyamamak
/// ekranın tamamını kaybetmenin sebebi olmamalı.
pub fn parse_facts(output: &str) -> Facts {
    let mut facts = Facts::default();
    let mut expecting_names = false;

    for line in output.lines() {
        let trimmed = line.trim();
        if expecting_names && !trimmed.is_empty() && !trimmed.contains('=') {
            facts.names = trimmed
                .split(',')
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect();
            expecting_names = false;
            continue;
        }
        if trimmed.starts_with("X509v3 Subject Alternative Name") {
            expecting_names = true;
            continue;
        }
        let Some((head, value)) = trimmed.split_once('=') else {
            continue;
        };
        let value = value.trim().to_string();
        match head.trim().to_ascii_lowercase().as_str() {
            "subject" => facts.subject = value,
            "issuer" => facts.issuer = value,
            "notbefore" => facts.not_before = value,
            "notafter" => facts.not_after = value,
            head if head.ends_with("fingerprint") => facts.fingerprint = value,
            _ => {}
        }
    }

    // Konu ile veren aynıysa kendinden imzalı. Boş iki dizgeyi "aynı" saymamak önemli: hiçbir şey
    // okunamamışken "kendinden imzalı" demek, ekranda bir olgu gibi duran bir tahmin olurdu.
    facts.self_signed = !facts.subject.is_empty() && facts.subject == facts.issuer;
    facts
}

/// PEM gerçekten PEM mi, ve beklenen türden mi.
///
/// AJANIN KENDİSİ BAKAR, çünkü aksi hâlde çağıranın gönderdiği her bayt `openssl`'e bir dosya
/// olarak sunulmuş olurdu. Buradaki kontrol bir güvenlik sınırı değil (openssl zaten reddederdi);
/// operatöre "bu bir sertifika değil, anahtar dosyasını mı yükledin" diyebilmenin yolu.
pub fn looks_like(pem: &str, label: &str) -> bool {
    let begin = format!("-----BEGIN {label}");
    pem.lines()
        .any(|line| line.trim_start().starts_with(&begin))
}

/// Özel anahtar PEM'i, üç yaygın başlıktan biriyle.
pub fn looks_like_private_key(pem: &str) -> bool {
    looks_like(pem, "PRIVATE KEY")
        || looks_like(pem, "RSA PRIVATE KEY")
        || looks_like(pem, "EC PRIVATE KEY")
}

/// Bir dosyayı, AÇILIŞ ANINDA doğru kipiyle yazar.
///
/// Kip `create` ile birlikte veriliyor, sonradan `chmod` ile değil: iki adım arasında dosya bir
/// an için okunabilir olur, ve o dosya bir TLS özel anahtarı.
///
/// Yalnız Unix. Windows dalı ADR-0006 için var — dağıtıcı platformdan bağımsız DERLENEBİLMELİ —
/// ve orada bir kip kavramı yok, o yüzden yazmayı hiç denemiyor.
#[cfg(unix)]
pub fn write_file(path: &std::path::Path, contents: &str, mode: u32) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .map_err(|error| format!("{} yazilamadi: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("{} yazilamadi: {error}", path.display()))?;
    // `sync_all`: sertifika ve anahtar diskte OLMALI, cunku bir sonraki adim nginx i yeniden
    // yukluyor ve bir guc kesintisi ikisini yarim birakirsa kutu HTTPS sunamaz hale gelir.
    file.sync_all()
        .map_err(|error| format!("{} diske yazilamadi: {error}", path.display()))
}

#[cfg(not(unix))]
pub fn write_file(_path: &std::path::Path, _contents: &str, _mode: u32) -> Result<(), String> {
    Err("sertifika yazma yalniz Unix te".to_string())
}

/// Yerine koyar. Ayni dizinde rename, yani ATOMIK: nginx in okudugu yol her an ya eski ya yeni
/// dosyayi gosterir, hicbir an yarim bir dosyayi gostermez.
pub fn replace(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|error| format!("{} yerine konamadi: {error}", to.display()))
}

/// Yeni dosyanin YANINA yazilacagi yol: `<yol>.new`.
///
/// `with_extension` DEGIL, ve bu ayrim olculdu: `depsis.crt` ile `depsis.key` in ikisi de
/// `with_extension("new")` ile `depsis.new` oluyor — yani sertifika ve anahtar AYNI gecici
/// dosyaya yaziliyor. Ilki 0444 ile olusturuldugu icin ikincisi "Permission denied" veriyor,
/// ve bu yalniz kok OLMAYAN bir kullanicida gorunuyor: yerelde kok olarak kosan testler
/// gecti, CI dustu.
pub fn staged(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".new");
    std::path::PathBuf::from(name)
}

/// Var olan dosyanin bir kopyasi. Yoksa HATA DEGIL: ilk kurulumda sertifika olmayabilir, ve
/// olmayan bir seyi yedekleyememek bir arıza degil.
pub fn backup(path: &std::path::Path, suffix: &str) -> Option<std::path::PathBuf> {
    let target = path.with_extension(suffix);
    match std::fs::copy(path, &target) {
        Ok(_) => Some(target),
        Err(_) => None,
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

    const OPENSSL_OUTPUT: &str = "subject=CN=nas.example.com, O=DEPSIS\n\
issuer=C=US, O=Let's Encrypt, CN=R11\n\
notBefore=Aug 29 08:00:00 2026 GMT\n\
notAfter=Nov 27 08:00:00 2026 GMT\n\
sha256 Fingerprint=AB:CD:EF:01\n\
X509v3 Subject Alternative Name: \n\
    DNS:nas.example.com, DNS:www.nas.example.com\n";

    #[test]
    fn the_facts_are_read_including_the_names_on_the_next_line() {
        let facts = parse_facts(OPENSSL_OUTPUT);
        assert_eq!(facts.subject, "CN=nas.example.com, O=DEPSIS");
        assert_eq!(facts.not_after, "Nov 27 08:00:00 2026 GMT");
        assert_eq!(facts.fingerprint, "AB:CD:EF:01");
        assert_eq!(
            facts.names,
            ["DNS:nas.example.com", "DNS:www.nas.example.com"]
        );
        assert!(!facts.self_signed, "veren Let's Encrypt, konu değil");
    }

    #[test]
    fn a_certificate_the_box_signed_itself_says_so() {
        // Tarayıcı uyarısının sebebi bu, ve ekranın söylemesi gereken tek şey.
        let output = "subject=CN=depsis, O=DEPSIS\nissuer=CN=depsis, O=DEPSIS\n";
        assert!(parse_facts(output).self_signed);
    }

    #[test]
    fn nothing_readable_is_never_reported_as_self_signed() {
        // İki boş dizge "aynı"dır, ve o eşitliği kabul etmek ekranda bir olgu gibi duran bir
        // tahmin üretirdi.
        assert!(!parse_facts("").self_signed);
        assert!(!parse_facts("bambaska bir cikti\n").self_signed);
    }

    #[test]
    fn an_unfamiliar_fingerprint_heading_is_still_read() {
        // openssl sürümleri arasında bu başlığın büyük/küçük harfi değişiyor.
        let facts = parse_facts("SHA256 Fingerprint=11:22\n");
        assert_eq!(facts.fingerprint, "11:22");
    }

    #[test]
    fn a_certificate_with_no_san_block_still_parses() {
        let facts = parse_facts("subject=CN=eski\nissuer=CN=eski\n");
        assert!(facts.names.is_empty());
        assert!(facts.self_signed);
    }

    #[test]
    fn the_pem_headers_are_recognised_for_what_they_are() {
        // Operatörün en olası hatası iki dosyayı ters yüklemek, ve ona "bu bir sertifika değil"
        // diyebilmek openssl'in "unable to load certificate"ından çok daha iyi.
        assert!(looks_like(
            "-----BEGIN CERTIFICATE-----\nAAAA\n",
            "CERTIFICATE"
        ));
        assert!(!looks_like("-----BEGIN PRIVATE KEY-----\n", "CERTIFICATE"));
        assert!(looks_like_private_key("-----BEGIN PRIVATE KEY-----\n"));
        assert!(looks_like_private_key("-----BEGIN EC PRIVATE KEY-----\n"));
        assert!(looks_like_private_key("-----BEGIN RSA PRIVATE KEY-----\n"));
        assert!(!looks_like_private_key("-----BEGIN CERTIFICATE-----\n"));
    }

    #[test]
    fn the_path_is_the_last_argument_and_openssl_gets_no_end_of_options_marker() {
        // `--` BİLEREK YOK: openssl onu anlamıyor ve `x509 -in -- /yol` "Use -help for
        // summary" ile düşüyor. Bu test o kararı yazılı tutuyor, çünkü dosyanın geri kalanı
        // (ve projedeki her argv) tersini yapıyor — biri "burada eksik" diye ekleyecek olursa
        // sertifika okuması sessizce değil, burada düşsün.
        for argv in [
            describe_argv("/x").to_vec(),
            cert_pubkey_argv("/x").to_vec(),
            key_pubkey_argv("/x").to_vec(),
        ] {
            assert_eq!(
                argv.last().copied(),
                Some("/x"),
                "yol son argüman olmalı: {argv:?}"
            );
            assert!(!argv.contains(&"--"), "openssl `--` anlamıyor: {argv:?}");
        }
    }

    #[test]
    fn the_two_staged_paths_are_two_different_files() {
        // `with_extension` ikisini de `depsis.new` yapıyordu: sertifika ve anahtar aynı
        // geçici dosyaya yazılıyor, ve ilki 0444 olduğu için ikincisi düşüyordu.
        let cert = staged(std::path::Path::new("/etc/depsis/tls/depsis.crt"));
        let key = staged(std::path::Path::new("/etc/depsis/tls/depsis.key"));
        assert_ne!(cert, key);
        assert!(cert.to_string_lossy().ends_with("depsis.crt.new"));
    }
}
