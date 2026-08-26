//! Cihazın KENDİ verisi: kullanıcılar, paylaşımlar, izinler, dosya dizini.
//!
//! ZFS anlık görüntüleri kullanıcının DOSYALARINI koruyor. Korumadığı şey, o dosyaların kime ait
//! olduğu — hesaplar, paylaşım tanımları, klasör izinleri, iş panosu ve dosya dizini PostgreSQL'de
//! ve PostgreSQL sistem diskinde. Sistem diski ölürse havuzdaki her bayt duruyor ve onlara kimin
//! erişebileceğini söyleyen hiçbir şey kalmıyor.
//!
//! `docs/operations/03-yedekleme.md` bunun için elle bir `pg_dump` tarif ediyordu, ve elle
//! başlatılan bir yedek alınmayan bir yedektir.
//!
//! DÖKÜM PAYLAŞIM AĞACINA YAZILMIYOR, ve bu bir konum tercihi değil bir güvenlik kararı. Döküm
//! parola hash'lerini, mühürlenmiş TOTP sırlarını ve SMB NT hash'lerini taşıyor; bir paylaşıma
//! yazılsaydı o paylaşımda `download` yetkisi olan herkes hepsini alırdı. Ajanın kendi dizinine,
//! 0600 ile yazılıyor. Yedeklenmesi için o dizinin veri kümesine bir zamanlama kurulur —
//! yönetici bunu bilerek yapar.
//!
//! BAĞLANTI DİZESİ ORTAMDAN, İSTEKTEN DEĞİL. `samba::CONFIG_PATH_ENV` ile aynı kural: ayrıcalıklı
//! daemon'un hangi veritabanına bağlanacağı, ayrıcalıksız bir çağıranın cevaplayabileceği bir soru
//! değil, ve istek enum'ında bunun için bir operand yok ve olmamalı.

use crate::seams::SeamError;

/// Dökümlerin yazıldığı dizin.
pub const DEFAULT_DUMP_DIR: &str = "/var/lib/depsis/db-backups";

/// `DEFAULT_DUMP_DIR`'i geçersiz kılar. Ortamdan, istekten değil.
pub const DUMP_DIR_ENV: &str = "DEPSIS_DB_BACKUP_DIR";

/// Dökümün alınacağı veritabanı.
///
/// Yoksa işlem REDDEDİLİYOR. Varsayılan bir bağlantı dizesi uydurmak — `postgres://localhost/depsis`
/// gibi — yanlış veritabanının dökümünü alıp "yedek var" demek olurdu, ki yedeği olmamaktan kötü.
pub const DATABASE_URL_ENV: &str = "DEPSIS_BACKUP_DATABASE_URL";

/// Dosya adının uzantısı. Budama YALNIZ bunu taşıyan dosyalara dokunuyor.
pub const DUMP_SUFFIX: &str = ".dump";

pub fn dump_dir() -> std::path::PathBuf {
    std::env::var_os(DUMP_DIR_ENV)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(DEFAULT_DUMP_DIR))
}

/// `pg_dump`'ın argv'si.
///
/// `-Fc` — özel biçim: sıkıştırılmış, ve `pg_restore` ile tek tablo seçilerek geri yüklenebiliyor.
/// Düz SQL, bir felaket kurtarmada tek parça hâlinde yutulmak zorunda olan bir dosya olurdu.
///
/// `--no-owner --no-privileges` — geri yükleme, dökümün alındığı kutudaki rol adlarına BAĞLI
/// OLMASIN. Yeni bir kutuda `depsis_owner` henüz yokken bir `ALTER TABLE ... OWNER TO` her satırda
/// hata verir, ve felaket kurtarma tam olarak rollerin henüz olmadığı andır.
///
/// `-d <url>` EN SONA konmuyor, ve konum önemli değil ama SAYISI önemli: tek bir bağlantı dizesi,
/// ve o da ortamdan. Çağıran hiçbir argüman katmıyor.
pub fn dump_argv<'a>(url: &'a str, out: &'a str) -> Vec<&'a str> {
    vec![
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        out,
        "--dbname",
        url,
    ]
}

/// Bir döküm dosyası: adı, boyutu, ne zaman yazıldığı.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dump {
    pub name: String,
    pub size_bytes: u64,
    pub created_unix: i64,
}

/// Dizindeki yedekler, YENİSİ ÖNCE: veritabanı dökümleri VE ZeroTier arşivleri.
///
/// İkisi de "cihazın kendi durumu" ve ikisi de aynı dizinde; ekranın ikisini birden göstermesi
/// gerekiyor, çünkü birini gösterip ötekini gizlemek yarısı yedeklenmiş bir cihazı tam yedeklenmiş
/// gibi göstermek olurdu.
///
/// Başka HİÇBİR ŞEY. Dizin ajanın kendi dizini ama bir operatör oraya bir not ya da bir kopya
/// bırakabilir, ve budamanın onu silmesi veri kaybı olurdu — aynı kural anlık görüntü budamasında
/// da geçerli ve aynı sebeple yazılıyor.
pub fn read_dumps(dir: &std::path::Path) -> Result<Vec<Dump>, SeamError> {
    let reader = match std::fs::read_dir(dir) {
        Ok(reader) => reader,
        // Dizin YOKSA henüz hiç döküm alınmamış demek, ve bu bir arıza değil bir durum: kurulumun
        // ilk günü de böyle. Boş liste, hata değil.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(SeamError::Io(format!("{}: {error}", dir.display()))),
    };

    let mut found = Vec::new();
    for entry in reader {
        let entry = entry.map_err(|e| SeamError::Io(format!("readdir: {e}")))?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // Veritabanı dökümleri VE ZeroTier arşivleri: ikisi de "cihazın kendi durumu", ikisi de
        // aynı dizinde, ve ekranın ikisini birden göstermesi gerekiyor — birini gösterip ötekini
        // gizlemek, yarısı yedeklenmiş bir cihazı tam yedeklenmiş gibi göstermek olurdu.
        //
        // Operatörün oraya bıraktığı bir not ya da kopya hâlâ dışarıda kalıyor.
        if !name.ends_with(DUMP_SUFFIX) && !crate::ztstate::is_backup(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let created = meta
            .modified()
            .ok()
            .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_secs() as i64);
        found.push(Dump {
            name,
            size_bytes: meta.len(),
            created_unix: created,
        });
    }

    found.sort_by(|a, b| {
        b.created_unix
            .cmp(&a.created_unix)
            .then_with(|| b.name.cmp(&a.name))
    });
    Ok(found)
}

/// Hangileri silinecek: en yenisi hariç `keep` tanesi hariç, EN ESKİDEN başlayarak.
///
/// Saf, ve saf olması ölçülebilmesi için — silinen şey geri gelmiyor. Anlık görüntü budamasıyla
/// aynı kural ve aynı sıra: yarıda kalan bir budama, elde en YENİLERİ bıraksın.
pub fn prunable(dumps: &[Dump], keep: usize) -> Vec<String> {
    // YALNIZ veritabanı dökümleri. ZeroTier arşivleri aynı dizinde duruyor ve kendi budamasına
    // sahip; buradan sayılsalardı `keep: 14` yedi döküm ve yedi arşiv tutar, yani veritabanı
    // geçmişi sessizce yarıya inerdi.
    let mut doomed: Vec<String> = dumps
        .iter()
        .filter(|dump| dump.name.ends_with(DUMP_SUFFIX))
        .skip(keep)
        .map(|dump| dump.name.clone())
        .collect();
    // En eskiden başlayarak silinsin: yarıda kalan bir budama, elde en YENİLERİ bıraksın.
    doomed.reverse();
    doomed
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

    fn dump(name: &str, at: i64) -> Dump {
        Dump {
            name: name.to_string(),
            size_bytes: 1,
            created_unix: at,
        }
    }

    #[test]
    fn the_argv_carries_one_connection_string_and_no_caller_input() {
        let argv = dump_argv("postgres://u:p@localhost/depsis", "/var/lib/x/a.dump");
        assert_eq!(argv.iter().filter(|a| **a == "--dbname").count(), 1);
        // `--no-owner --no-privileges`, and both matter on the day they are used: a restore onto a
        // fresh box happens BEFORE the roles exist, and an `OWNER TO depsis_owner` on every table
        // would error on every line.
        assert!(argv.contains(&"--no-owner"));
        assert!(argv.contains(&"--no-privileges"));
        assert!(argv.contains(&"--format=custom"));
    }

    #[test]
    fn only_dump_files_are_prunable() {
        // THE RULE THAT KEEPS THIS FROM LOSING DATA. The directory belongs to the agent, but an
        // operator may well leave a note or a copy of something in it, and a pruning that removed
        // it would be data loss nobody attributes to DEPSIS. Same rule as snapshot pruning.
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("a.dump"), b"one").expect("write");
        std::fs::write(tmp.path().join("b.dump"), b"two").expect("write");
        std::fs::write(tmp.path().join("elle-aldigim-kopya.sql"), b"mine").expect("write");
        std::fs::write(tmp.path().join("README"), b"note").expect("write");

        let dumps = read_dumps(tmp.path()).expect("read");
        assert_eq!(dumps.len(), 2);
        assert!(dumps.iter().all(|d| d.name.ends_with(DUMP_SUFFIX)));
    }

    #[test]
    fn both_kinds_are_listed_but_each_prunes_only_its_own() {
        // The two backups of the appliance's own state share a directory. The SCREEN must show
        // both — showing one and hiding the other would present a half-backed-up appliance as a
        // fully backed-up one — but `keep` must count them separately, or `keep: 14` would hold
        // seven dumps and seven archives and the database history would quietly halve.
        let tmp = tempfile::tempdir().expect("tempdir");
        for name in ["a.dump", "b.dump", "c.dump"] {
            std::fs::write(tmp.path().join(name), b"x").expect("write");
        }
        for name in ["zerotier-1.tar", "zerotier-2.tar"] {
            std::fs::write(tmp.path().join(name), b"x").expect("write");
        }
        std::fs::write(tmp.path().join("elle-aldigim.tar"), b"mine").expect("write");

        let listed = read_dumps(tmp.path()).expect("read");
        assert_eq!(listed.len(), 5, "{listed:?}");
        // The operator's own file is in neither the listing nor the pruning.
        assert!(listed.iter().all(|d| d.name != "elle-aldigim.tar"));

        let doomed = prunable(&listed, 1);
        assert_eq!(doomed.len(), 2);
        assert!(
            doomed.iter().all(|name| name.ends_with(DUMP_SUFFIX)),
            "{doomed:?}"
        );
    }

    #[test]
    fn a_directory_that_does_not_exist_yet_is_an_empty_list() {
        // The first day of an installation looks exactly like this, and it is not a fault.
        let tmp = tempfile::tempdir().expect("tempdir");
        let never = tmp.path().join("not-there");
        assert_eq!(read_dumps(&never).expect("empty"), Vec::new());
    }

    #[test]
    fn dumps_come_back_newest_first() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("old.dump"), b"x").expect("write");
        std::fs::write(tmp.path().join("new.dump"), b"xx").expect("write");
        let dumps = read_dumps(tmp.path()).expect("read");
        // Both were written in the same second on a fast disk, so the tie-break by name is what
        // actually orders them — and an undefined order would leave "which one gets pruned" to
        // the filesystem.
        assert_eq!(dumps.len(), 2);
        assert!(dumps[0].created_unix >= dumps[1].created_unix);
    }

    #[test]
    fn pruning_keeps_the_newest_and_removes_oldest_first() {
        let dumps = vec![
            dump("d.dump", 400),
            dump("c.dump", 300),
            dump("b.dump", 200),
            dump("a.dump", 100),
        ];
        assert_eq!(prunable(&dumps, 2), vec!["a.dump", "b.dump"]);
        assert_eq!(prunable(&dumps, 4), Vec::<String>::new());
        assert_eq!(prunable(&dumps, 10), Vec::<String>::new());
        // `keep: 1` is legal and means "only the newest". Zero is not offered: a policy that
        // deletes the dump it just took is not a backup policy.
        assert_eq!(prunable(&dumps, 1).len(), 3);
    }
}
