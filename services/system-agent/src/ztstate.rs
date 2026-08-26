//! ZeroTier'in kimliği ve controller durumu — yedeklenmeyen dördüncü şey.
//!
//! `docs/operations/03-yedekleme.md` "üç ayrı şey" diyor: kullanıcı dosyaları, PostgreSQL, ve mühür
//! anahtarı. DÖRDÜNCÜSÜ VAR ve hiçbir yerde yazmıyordu: `/var/lib/zerotier-one`.
//!
//! ## Neden bu, ötekilerden farklı
//!
//! `identity.secret` KAYBEDİLİRSE GERİ GELMEZ, ve sonucu ötekilerden ağır. Bir ZeroTier ağ
//! kimliğinin üst 40 biti, o ağı yöneten düğümün adresinin ta kendisi
//! (`Address(_id >> 24)`, `node/Network.hpp`). Yani kimlik değişince eski ağ kimliği artık bu
//! düğümü göstermiyor: üyeler config isteğini ARTIK BU MAKİNE OLMAYAN bir adrese göndermeye devam
//! ediyor, `controller.d` içindeki dosyalar diskte duruyor ama daemon onlara hiç sorulmuyor, ve
//! ağı yeniden yönlendirmenin bir yolu yok. Ev, kendi NAS'ına uzaktan erişimini kalıcı olarak
//! kaybediyor.
//!
//! `controller.d` kaybedilirse durum daha hafif ama sessiz: kimlik sağsa AYNI ağ kimliği yeniden
//! yaratılabiliyor, ama her üye `authorized: false` olarak geri geliyor — cihazlar yeniden
//! katılmıyor, tek tek yeniden yetkilendirilmeleri gerekiyor, ve o ana kadar hiçbiri erişemiyor.
//!
//! ## Geri yüklemenin sırası, ve ZeroTier'in söylemediği
//!
//! `FileDB` `controller.d`'yi YALNIZCA AÇILIŞTA okuyor — inotify yok, periyodik tarama yok. Çalışan
//! bir daemon'un altına dosya bırakmak hiçbir şey yapmıyor, ve daha kötüsü, bellekteki kopya bir
//! sonraki kayıtta bıraktığınız dosyaların üzerine yazıyor. Doğru sıra: **durdur, değiştir,
//! başlat.** ZeroTier'in belgeleri bunu hiçbir yerde söylemiyor; yazması DEPSIS'e kalıyor.
//!
//! ESKİ BİR YEDEĞİ GERİ YÜKLEMEK BİR GÜVENLİK OLAYI. İstemci tarafı gelen config'in sürümünü
//! önbellektekiyle karşılaştırmıyor (`Network::setConfiguration` yalnız birebir aynılığa bakıyor),
//! yani yedekten beri YETKİSİ ALINMIŞ bir cihaz sessizce yetkisini geri kazanıyor. Geri yükleme
//! ekranının bunu söylemesi gerekiyor.
//!
//! ## Neden her dosya ayrıştırılıyor
//!
//! `FileDB::save()` düz bir `writeFile` — geçici dosya yok, `rename` yok, `fsync` yok. Elektriği
//! ortasında kesilen bir NAS, yarım yazılmış bir JSON bırakabiliyor. Yarım bir dosyayı sessizce
//! yedeklemek, yedeği olduğunu sanan birini o hâlde bırakmak; o yüzden ayrıştırılamayan dosyalar
//! yedeğin DIŞINDA bırakılmıyor — yedeğe giriyor ve ADLARIYLA bildiriliyor.

/// ZeroTier'in Linux'taki çalışma dizini.
pub const DEFAULT_HOME: &str = "/var/lib/zerotier-one";

/// `DEFAULT_HOME`'u geçersiz kılar. Ortamdan, istekten değil — `samba::CONFIG_PATH_ENV`'in kuralı.
pub const HOME_ENV: &str = "DEPSIS_ZEROTIER_HOME";

/// Yedeğin adının ön eki. Budama YALNIZ bunu taşıyanlara dokunuyor.
pub const BACKUP_PREFIX: &str = "zerotier-";
pub const BACKUP_SUFFIX: &str = ".tar";

pub fn home() -> std::path::PathBuf {
    std::env::var_os(HOME_ENV)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(DEFAULT_HOME))
}

/// Yedeğe girecek şeyler, VAR OLANLAR.
///
/// Üçü de olmayabilir ve üçünün yokluğu farklı şeyler söylüyor: `identity.secret` yoksa ZeroTier
/// hiç çalışmamış; `controller.d` yoksa bu düğüm henüz kimseye controller değil — ki bu sıradan
/// bir durum, arıza değil. O yüzden liste taranarak kuruluyor, sabit değil: olmayan bir yolu
/// `tar`'a vermek, yedeğin tamamını bir hata koduna çevirirdi.
pub fn present_parts(home: &std::path::Path) -> Vec<String> {
    ["identity.secret", "identity.public", "controller.d"]
        .into_iter()
        .filter(|name| home.join(name).exists())
        .map(str::to_string)
        .collect()
}

/// `tar` argv'si: dizinin İÇİNDEN, göreli adlarla.
///
/// `-C <home>` ve sonra çıplak adlar, çünkü mutlak yolla yazılmış bir arşiv geri yüklerken kök
/// dizine açılmayı deniyor ve arşivin nereye gideceğine arşiv karar vermiş oluyor. Göreli adlar,
/// geri yükleyen kişinin `-C` ile hedefi seçebilmesi demek.
///
/// Sıkıştırma YOK. İçerik birkaç kilobayt JSON ve bir kimlik dosyası; `gzip` eklemek, felaket
/// kurtarma anında bozulmuş bir arşivin kısmen kurtarılabilir olmaktan çıkması demek.
pub fn tar_argv<'a>(out: &'a str, home: &'a str, parts: &'a [String]) -> Vec<&'a str> {
    let mut argv = vec!["--create", "--file", out, "--directory", home];
    argv.extend(parts.iter().map(String::as_str));
    argv
}

/// `controller.d` altındaki ayrıştırılamayan JSON dosyalarının adları.
///
/// `FileDB` atomik olmayan bir `writeFile` kullanıyor — geçici dosya yok, `fsync` yok — ve bir NAS
/// elektriği ortasında kesilen cihazın ta kendisi. Yarım bir kayıt sessizce yedeklenirse, geri
/// yüklendiği gün o ağ ya da o üye yok demektir.
///
/// Dosyalar yedeğin dışında BIRAKILMIYOR: yarım bir dosya bile, olmayan bir dosyadan fazla bilgi
/// taşıyor. Yapılan şey onları saymak ve adlarıyla bildirmek.
pub fn unreadable_records(home: &std::path::Path) -> Vec<String> {
    let networks = home.join("controller.d").join("network");
    let mut bad = Vec::new();
    walk_json(&networks, &networks, &mut bad);
    bad.sort();
    bad
}

fn walk_json(root: &std::path::Path, dir: &std::path::Path, bad: &mut Vec<String>) {
    let Ok(reader) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in reader.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_json(root, &path, bad);
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let readable = std::fs::read(&path)
            .ok()
            .is_some_and(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
        if !readable {
            let shown = path.strip_prefix(root).unwrap_or(&path);
            bad.push(shown.display().to_string().replace('\\', "/"));
        }
    }
}

/// Bu yedek dosyası bu modülün ürettiklerinden mi?
pub fn is_backup(name: &str) -> bool {
    name.starts_with(BACKUP_PREFIX) && name.ends_with(BACKUP_SUFFIX)
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

    #[test]
    fn only_what_is_there_goes_into_the_archive() {
        // Üçünün de olmaması sıradan: ZeroTier kurulu değilse dizin bile yok, ve controller
        // olmayan bir düğümde `controller.d` yok. Olmayan bir yolu `tar`'a vermek, yedeğin
        // tamamını bir hata koduna çevirirdi.
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(present_parts(tmp.path()), Vec::<String>::new());

        std::fs::write(tmp.path().join("identity.secret"), b"secret").expect("write");
        assert_eq!(present_parts(tmp.path()), vec!["identity.secret"]);

        std::fs::create_dir_all(tmp.path().join("controller.d")).expect("mkdir");
        std::fs::write(tmp.path().join("identity.public"), b"public").expect("write");
        assert_eq!(
            present_parts(tmp.path()),
            vec!["identity.secret", "identity.public", "controller.d"]
        );
    }

    #[test]
    fn the_archive_is_relative_and_uncompressed() {
        let parts = vec!["identity.secret".to_string(), "controller.d".to_string()];
        let argv = tar_argv(
            "/var/lib/depsis/db-backups/zerotier-x.tar",
            "/var/lib/zerotier-one",
            &parts,
        );

        // `-C` ve göreli adlar: mutlak yolla yazılmış bir arşiv, geri yüklerken hedefi kendisi
        // seçer. Göreli adlar, geri yükleyen kişinin seçmesi demek.
        assert!(argv.contains(&"--directory"));
        assert!(argv.contains(&"/var/lib/zerotier-one"));
        assert!(argv.contains(&"identity.secret"));
        assert!(!argv.iter().any(|a| a.starts_with("/var/lib/zerotier-one/")));

        // Sıkıştırma yok: bozulmuş bir `tar` kısmen okunabilir, bozulmuş bir `tar.gz` okunamaz —
        // ve bu arşivin açılacağı tek an, işlerin zaten kötü gittiği an.
        for flag in ["-z", "--gzip", "-j", "--bzip2", "-J", "--xz"] {
            assert!(!argv.contains(&flag), "{flag} must not be in {argv:?}");
        }
    }

    #[test]
    fn a_truncated_controller_record_is_named_rather_than_swallowed() {
        // THE FAILURE THIS EXISTS FOR. `FileDB::save()` is a plain `writeFile` — no temp file, no
        // rename, no fsync — and a NAS is exactly the device that loses power mid-write. A half
        // written record backed up silently is a network or a member that is simply gone on the
        // day the archive is opened.
        let tmp = tempfile::tempdir().expect("tempdir");
        let networks = tmp.path().join("controller.d").join("network");
        std::fs::create_dir_all(networks.join("a1b2c3d4e5000001").join("member")).expect("mkdir");

        std::fs::write(
            networks.join("a1b2c3d4e5000001.json"),
            br#"{"id":"a1b2c3d4e5000001"}"#,
        )
        .expect("write");
        std::fs::write(
            networks
                .join("a1b2c3d4e5000001")
                .join("member")
                .join("1122334455.json"),
            br#"{"id":"1122334455","autho"#,
        )
        .expect("write");

        let bad = unreadable_records(tmp.path());
        assert_eq!(bad, vec!["a1b2c3d4e5000001/member/1122334455.json"]);
    }

    #[test]
    fn a_healthy_controller_directory_reports_nothing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let networks = tmp.path().join("controller.d").join("network");
        std::fs::create_dir_all(&networks).expect("mkdir");
        std::fs::write(networks.join("a1b2c3d4e5000001.json"), br#"{"id":"x"}"#).expect("write");
        // Anything that is not a .json is not a record and is not judged: the daemon also keeps a
        // `trace/` directory, and a non-record file failing to parse would be a false alarm on a
        // screen whose whole value is that it only speaks when something is wrong.
        std::fs::write(networks.join("notes.txt"), b"not a record").expect("write");
        assert_eq!(unreadable_records(tmp.path()), Vec::<String>::new());
    }

    #[test]
    fn a_node_that_was_never_a_controller_is_not_an_error() {
        // The ordinary state of a NAS that joined somebody else's network: no controller.d at all.
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(unreadable_records(tmp.path()), Vec::<String>::new());
    }

    #[test]
    fn pruning_recognises_only_this_modules_own_archives() {
        assert!(is_backup("zerotier-20260826T030000Z.tar"));
        // The database dumps live in the same directory and must survive this pruning, and so must
        // anything an operator left there.
        assert!(!is_backup("depsis-20260826T030000Z.dump"));
        assert!(!is_backup("elle-aldigim-kopya.tar"));
        assert!(!is_backup("zerotier-notlarim.txt"));
    }
}
