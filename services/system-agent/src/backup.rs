//! Yedek diskinin düzeni: iki veri kümesi, biri şifresiz biri şifreli.
//!
//! ── DİSKİN İKİYE BÖLÜNMESİ ───────────────────────────────────────────────────────────────────
//!
//! Cihaz sahibinin şartı şuydu: *"sistem diski ve depolama diski yansa bile yedek diski eğer
//! şifre biliniyorsa kullanılabilir olmalı."* Bu, diskin kendi kendini anlatmasını gerektiriyor —
//! ve kendini anlatan yarının PAROLA OLMADAN okunabilmesi gerekiyor.
//!
//! Havuzun kökü şifresiz kalıyor (`zpool create` şifreleme bayrağı almıyor) ve altına iki veri
//! kümesi konuyor:
//!
//! ```text
//! <havuz>/aciklama   ŞİFRESİZ  → /yedek-bilgi   birkaç yüz KB: OKUBENI.txt, disk.json
//! <havuz>/veri       ŞİFRELİ   → /yedek         dosyalar, silinenler, günlükler
//! ```
//!
//! Böylece disk yeni bir cihaza takıldığında sihirbaz PAROLA SORMADAN "bu bir DEPSIS yedek
//! diskidir, etiketi 'Ev', son yedek 30 Ağustos" diyebiliyor. Şifresiz tarafta kullanıcı adı,
//! kuruluş adı ya da paylaşım adı YOK; yalnız bir etiket ve bir tarih var, çünkü o uç kimlik
//! doğrulaması olmadan okunuyor.
//!
//! Sızan meta veri dürüstçe yazılmalı: havuz adı, veri kümesi adları ve doluluk şifresiz. Şifreli
//! olan, dosya adları ve içerik.
//!
//! ── NEDEN ZFS'İN KENDİ ŞİFRELEMESİ, LUKS DEĞİL ───────────────────────────────────────────────
//!
//! Üç sebep. Ajan zaten yalnız `zfs`/`zpool` konuşuyor; `cryptsetup`, ADR-0006'nın kapalı ikili
//! kümesine yeni bir ayrıcalıklı ikili eklemek demek. Şifreli bir ZFS veri kümesi, üstünde
//! gezinen taraf için SIRADAN bir veri kümesi — LUKS ise altına bir blok katmanı daha koyar ve
//! kurtarmayı iki aşamalı yapar. Ve zayıf donanımda AES-NI yoksa dm-crypt katmanı bütün
//! yedekleme döngüsünü işlemciye bağlar.
//!
//! ── NEDEN PAROLA, HAM ANAHTAR + ZARF DEĞİL ───────────────────────────────────────────────────
//!
//! `keyformat=passphrase`: parolanın kendisi ZFS'in anahtarı. O zaman disk ile sahibi arasında
//! hiçbir DEPSIS kodu yok — ZFS kurulu herhangi bir Linux `zfs load-key` ile parolayı sorar ve
//! açar. Ham bir anahtarı DEPSIS'in kendi zarf biçimiyle sarmalamak, tam da bu şartın kaldırmaya
//! çalıştığı bağımlılığı geri koyardı: "diski açmak için DEPSIS'in kripto kodunun doğru
//! çalışması".

use crate::seams::SeamError;

/// Şifresiz yarının veri kümesi adı ve bağlama noktası.
pub const META_CHILD: &str = "aciklama";
pub const META_MOUNTPOINT: &str = "/yedek-bilgi";

/// Şifreli yarının veri kümesi adı ve bağlama noktası.
pub const DATA_CHILD: &str = "veri";
pub const DATA_MOUNTPOINT: &str = "/yedek";

/// `<havuz>/aciklama`
pub fn meta_dataset(pool: &str) -> String {
    format!("{pool}/{META_CHILD}")
}

/// `<havuz>/veri`
pub fn data_dataset(pool: &str) -> String {
    format!("{pool}/{DATA_CHILD}")
}

/// Şifresiz yarıyı kuran argv.
///
/// `canmount=on` açıkça yazılıyor: bu yarının HER AÇILIŞTA bağlı olması gerekiyor, çünkü onu
/// okuyan şey kurulum sihirbazı ve o an henüz kimse parola girmemiş oluyor.
pub fn create_meta_argv(dataset: &str) -> Vec<String> {
    vec![
        "create".to_string(),
        "-o".to_string(),
        format!("mountpoint={META_MOUNTPOINT}"),
        "-o".to_string(),
        "canmount=on".to_string(),
        dataset.to_string(),
    ]
}

/// Şifreli yarıyı kuran argv. Parola stdin'den geliyor, argv'de YOK.
///
/// `canmount=noauto`: açılışta kendiliğinden bağlanmaya ÇALIŞMAMALI. Anahtar yüklenmemişken
/// bağlanmayı denemek, her açılışta bir hata satırı üretir ve o satır gerçek bir arızadan
/// ayırt edilemez hâle gelir. Kilitli bir yedek diski bir arıza değil, olağan hâl.
///
/// `acltype=posixacl` ve `xattr=sa`: yedek de tıpkı ana depolama gibi bir depolama (M5), yani
/// kopyalanan dosyaların ACL'lerini taşıyabilmeli. ADR-0004'ün iki özelliği burada da açık.
pub fn create_data_argv(dataset: &str) -> Vec<String> {
    vec![
        "create".to_string(),
        "-o".to_string(),
        "encryption=aes-256-gcm".to_string(),
        "-o".to_string(),
        "keyformat=passphrase".to_string(),
        "-o".to_string(),
        "keylocation=prompt".to_string(),
        "-o".to_string(),
        format!("mountpoint={DATA_MOUNTPOINT}"),
        "-o".to_string(),
        "canmount=noauto".to_string(),
        "-o".to_string(),
        "acltype=posixacl".to_string(),
        "-o".to_string(),
        "xattr=sa".to_string(),
        dataset.to_string(),
    ]
}

/// Anahtarı yükler. Parola stdin'den.
pub fn load_key_argv(dataset: &str) -> Vec<String> {
    vec!["load-key".to_string(), dataset.to_string()]
}

/// Anahtarı düşürür.
///
/// `-u`: veri kümesi bağlıysa önce ayırır. Onsuz `zfs unload-key` "dataset is busy" der ve
/// kullanıcının elinde kilitleyemediği bir disk kalır — kilit düğmesinin var olma sebebi tam da
/// diski kilitleyebilmek.
pub fn unload_key_argv(dataset: &str) -> Vec<String> {
    vec![
        "unload-key".to_string(),
        "-u".to_string(),
        dataset.to_string(),
    ]
}

/// Şifreli yarıyı bağlar. Anahtar yüklendikten SONRA çağrılıyor.
pub fn mount_argv(dataset: &str) -> Vec<String> {
    vec!["mount".to_string(), dataset.to_string()]
}

/// Durum sorgusunun argv'si.
///
/// `-p` ham bayt istiyor (insan için kısaltılmış "1,2T" değil), `-H` başlıksız ve sekmeli.
/// Alanların SIRASI bu modülün ayrıştırmasının sözleşmesi ve bu yüzden burada duruyor.
pub fn status_argv(dataset: &str) -> Vec<String> {
    vec![
        "list".to_string(),
        "-H".to_string(),
        "-p".to_string(),
        "-o".to_string(),
        "name,mounted,keystatus,available,used".to_string(),
        dataset.to_string(),
    ]
}

/// Bir veri kümesinin yedekleme açısından durumu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetState {
    pub mounted: bool,
    /// `available` — bu veri kümesine daha ne kadar yazılabilir.
    pub available_bytes: u64,
    pub used_bytes: u64,
    /// Anahtar yüklü mü. Şifresiz bir veri kümesi için `keystatus` `-` döner ve bu `true`
    /// sayılır: şifresiz bir şeyin anahtarı hep yüklüdür, ve `false` demek çağıran tarafa
    /// "kilitli" dedirtirdi.
    pub key_loaded: bool,
}

/// Takılabilecek havuzları listeleyen argv. İşlenen YOK.
///
/// `zpool import`, operand olmadan, o an takılı OLMAYAN ama diskleri görünen havuzları anlatıyor.
/// Yanmış bir cihazın diskini yeni bir cihaza takan kişinin ilk sorusu bu: "bu diskte ne var?"
///
/// `-H` YOK, çünkü bu komutta yok. Çıktı düzyazı ve bu tasarımın bir zayıflığı, bir tercihi değil;
/// `parse_importable` bu yüzden tanımadığı her satırı SESSİZCE ATIYOR ve yalnız tanıdığı üç alanı
/// okuyor — düzyazının değişmesi, olmayan bir havuzun uydurulmasına değil, bir havuzun
/// görünmemesine yol açsın diye.
pub fn scan_argv() -> [&'static str; 1] {
    ["import"]
}

/// Bir havuzu, HİÇBİR VERİ KÜMESİNİ BAĞLAMADAN takan argv.
///
/// ── `-N` NEDEN ZORUNLU ───────────────────────────────────────────────────────────────────────
///
/// Bir havuzun bağlama noktaları havuzun KENDİ içinde yazılı. Yani tanımadığımız bir havuzu
/// olağan şekilde takmak, o havuzun seçtiği yerlere — `/srv/depsis` dâhil — bağlanmasına izin
/// vermek demek. Bu cihazın kendi paylaşım ağacının üstüne başka bir cihazın verisinin
/// bağlanması, "kurtarma" adı altında yapılabilecek en kötü şey olurdu.
///
/// `-N` ile hiçbir şey bağlanmıyor. Havuzun DEPSIS yedek diski olduğu doğrulandıktan sonra,
/// yalnız beklenen iki veri kümesi, yalnız beklenen iki noktaya, tek tek bağlanıyor.
///
/// ── `-f` NEDEN AYRI BİR İŞLENEN ──────────────────────────────────────────────────────────────
///
/// Ölen bir cihazdan çıkan disk hiçbir zaman düzgün "export" edilmiş olmuyor, ve ZFS bunu
/// "başka bir sistem tarafından kullanılıyordu" diye reddediyor. Doğru cevap çoğu zaman devralmak
/// — ama HER ZAMAN değil: aynı disk hâlâ çalışan başka bir cihazda takılıysa, iki cihazın aynı
/// havuza yazması havuzu bozar. Bu yüzden devralma kullanıcının gördüğü ve onayladığı bir adım,
/// ajanın kendiliğinden verdiği bir karar değil.
pub fn import_argv(pool: &str, adopt: bool) -> Vec<String> {
    let mut argv = vec!["import".to_string(), "-N".to_string()];
    if adopt {
        argv.push("-f".to_string());
    }
    argv.push(pool.to_string());
    argv
}

/// Havuzu bırakan argv.
///
/// Takılan havuzun DEPSIS yedek diski OLMADIĞI anlaşıldığında geri alma adımı: takmak bir yan
/// etki ve yanlış havuzu takılı bırakmak, kullanıcının hiç istemediği bir şeyi yapmış olmak.
pub fn export_argv(pool: &str) -> Vec<String> {
    vec!["export".to_string(), pool.to_string()]
}

/// `zpool import` çıktısındaki bir havuz.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportablePool {
    pub name: String,
    pub id: String,
    /// `ONLINE`, `DEGRADED`, `FAULTED`, `UNAVAIL` — ZFS'in kendi kelimesi, çevrilmeden.
    pub state: String,
    /// Havuz düzgün bırakılmamış; takmak için devralmak gerekiyor.
    pub needs_adopt: bool,
}

/// `zpool import` düzyazısını okur.
///
/// TANIMADIĞI HER SATIR ATILIYOR. Bu komutun betikler için bir biçimi yok ve çıktısı sürümler
/// arasında değişiyor; tanımadığı bir satırda hata vermek, ZFS'in bir gün fazladan bir satır
/// yazmasıyla kurtarma ekranının tamamen çalışmaz olması demekti. Tersi de doğru: eksik okunan bir
/// kayıt bir havuzun GÖRÜNMEMESİNE yol açar, ki kullanıcı bunu ekranda fark eder ve düzeltilebilir
/// — uydurulmuş bir havuz adı ise fark edilmez.
///
/// Boşluk içeren bir ad okunmuyor: havuz adları boşluk içeremiyor, ve `zpool` hiç havuz yokken
/// düzyazı yazıyor ("no pools available to import").
pub fn parse_importable(out: &str) -> Vec<ImportablePool> {
    let mut found: Vec<ImportablePool> = Vec::new();
    let mut name: Option<String> = None;
    let mut id = String::new();
    let mut state = String::new();
    let mut adopt = false;

    fn flush(
        found: &mut Vec<ImportablePool>,
        name: &mut Option<String>,
        id: &mut String,
        state: &mut String,
        adopt: &mut bool,
    ) {
        if let Some(name) = name.take() {
            found.push(ImportablePool {
                name,
                id: std::mem::take(id),
                state: std::mem::take(state),
                needs_adopt: *adopt,
            });
        }
        *adopt = false;
    }

    for line in out.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("pool:") {
            // Yeni kayıt: öncekini kapat.
            flush(&mut found, &mut name, &mut id, &mut state, &mut adopt);
            let value = value.trim();
            if !value.is_empty() && !value.contains(char::is_whitespace) {
                name = Some(value.to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("id:") {
            id = value.trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("state:") {
            state = value.trim().to_string();
        } else if trimmed.contains("another system") || trimmed.contains("'-f' flag") {
            // `status:` ve `action:` satırları; ikisi de aynı şeyi söylüyor ve hangisinin
            // yazılacağı ZFS sürümüne göre değişiyor.
            adopt = true;
        }
    }
    flush(&mut found, &mut name, &mut id, &mut state, &mut adopt);
    found
}

/// Takılan havuzun DEPSIS yedek diski olup olmadığı.
///
/// İMZA, İKİ VERİ KÜMESİNİN VARLIĞI. `<havuz>/veri` ve `<havuz>/aciklama` birlikte yalnız
/// `PrepareBackupRoot` tarafından kuruluyor; ikisi birden varsa bu disk bir DEPSIS yedek diski.
/// Dosya okuyarak karar vermek daha zayıf olurdu: şifresiz yarıdaki dosyaları herkes yazabilir,
/// veri kümelerinin adları ise havuzun kendi yapısı.
pub fn looks_like_backup_pool(datasets: &[String], pool: &str) -> bool {
    let data = data_dataset(pool);
    let meta = meta_dataset(pool);
    datasets.iter().any(|name| name == &data) && datasets.iter().any(|name| name == &meta)
}

/// `zfs list -H -p -o name,mounted,keystatus,available,used` çıktısının TEK satırını okur.
///
/// Tek satır bekleniyor ve fazlası HATA: `zfs list` bir veri kümesi adı verildiğinde tam olarak
/// bir satır basar. İkinci bir satır, argümanın beklediğimiz şey olmadığı anlamına gelir, ve
/// böyle bir durumda ilk satırı alıp devam etmek — yani hangi veri kümesine baktığımızı
/// bilmeden bir cevap üretmek — sessizce yanlış bir "yedek hazır" cümlesi kurardı.
pub fn parse_state(out: &str) -> Result<DatasetState, SeamError> {
    let mut lines = out.lines().filter(|l| !l.trim().is_empty());
    let Some(line) = lines.next() else {
        return Err(SeamError::NotFound("zfs list boş cevap verdi".to_string()));
    };
    if lines.next().is_some() {
        return Err(SeamError::Io(
            "zfs list birden fazla satır verdi; tek bir veri kümesi soruldu".to_string(),
        ));
    }

    let mut fields = line.split('\t');
    let (Some(_name), Some(mounted), Some(keystatus), Some(available), Some(used)) = (
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
    ) else {
        return Err(SeamError::Io(format!(
            "zfs list satırı beş alandan az: {line:?}"
        )));
    };

    // `-` ile `no` ARASINDAKİ FARK ÖNEMLİ. Şifresiz bir veri kümesinde `keystatus` `-` döner;
    // onu "kilitli" saymak, şifresiz `aciklama` yarısını sonsuza kadar kapalı göstermek olurdu —
    // yani diskin kendini anlatan yarısı hiç okunamazdı.
    let key_loaded = match keystatus {
        "available" | "-" => true,
        "unavailable" => false,
        other => return Err(SeamError::Io(format!("zfs keystatus tanınmadı: {other:?}"))),
    };

    Ok(DatasetState {
        mounted: mounted == "yes",
        // `available` bir veri kümesi kilitliyken de okunabiliyor ama `-` dönebiliyor; sayı
        // okunamıyorsa sıfır, çünkü "bilmiyorum" ile "yer yok" arasında güvenli yön ikincisi:
        // çağıran taraf yazmadan önce yer arıyor.
        available_bytes: available.parse().unwrap_or(0),
        used_bytes: used.parse().unwrap_or(0),
        key_loaded,
    })
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

    /// `zpool import`in düzyazısı okunuyor: ad, kimlik, durum, ve devralma gerekip gerekmediği.
    #[test]
    fn takilabilecek_havuzlar_okunuyor() {
        let out = "   pool: yedek
     id: 12345678901234567890
  state: ONLINE
 action: The pool can be imported using its name or numeric identifier.
 config:

\tyedek       ONLINE
\t  sdb       ONLINE
";
        let found = parse_importable(out);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "yedek");
        assert_eq!(found[0].id, "12345678901234567890");
        assert_eq!(found[0].state, "ONLINE");
        assert!(!found[0].needs_adopt);
    }

    /// Ölen bir cihazdan çıkan disk düzgün bırakılmamış olur, ve ZFS bunu söyler.
    ///
    /// Kurtarmanın olağan hâli tam olarak bu, ve ekranın devralma uyarısını gösterip
    /// göstermeyeceği buradan çıkıyor.
    #[test]
    fn duzgun_birakilmamis_havuz_devralma_istiyor() {
        let out = "   pool: yedek
     id: 9
  state: ONLINE
 status: The pool was last accessed by another system.
 action: The pool can be imported using its name or numeric identifier and
\tthe '-f' flag.
";
        let found = parse_importable(out);
        assert_eq!(found.len(), 1);
        assert!(found[0].needs_adopt);
    }

    /// İki havuz iki kayıt, ve devralma bayrağı ÖNCEKİ kayıttan taşmıyor.
    ///
    /// Taşsaydı, sağlıklı bir diskin yanına takılan bozuk bir disk yüzünden kullanıcıya gereksiz
    /// bir devralma uyarısı gösterilirdi — ve o uyarıya alışan kişi, gerçekten tehlikeli olan
    /// durumda da onu geçer.
    #[test]
    fn devralma_bayragi_kayitlar_arasinda_tasmiyor() {
        let out = "   pool: eski
     id: 1
  state: ONLINE
 status: The pool was last accessed by another system.

   pool: yeni
     id: 2
  state: ONLINE
";
        let found = parse_importable(out);
        assert_eq!(found.len(), 2);
        assert!(found[0].needs_adopt);
        assert!(!found[1].needs_adopt, "ikinci havuz devralma istemiyor");
    }

    /// `zpool`un kendi düzyazısı havuz adı olarak okunmuyor.
    #[test]
    fn hic_havuz_yoksa_liste_bos() {
        assert!(parse_importable("no pools available to import\n").is_empty());
        assert!(parse_importable("").is_empty());
    }

    /// `-N` HER ZAMAN var: bir havuzun bağlama noktaları havuzun kendi içinde yazılı, ve
    /// tanımadığımız bir havuzu olağan şekilde takmak onun `/srv/depsis`e bağlanmasına izin
    /// vermek demek.
    #[test]
    fn takma_hicbir_veri_kumesini_baglamiyor() {
        assert_eq!(import_argv("yedek", false), ["import", "-N", "yedek"]);
        assert_eq!(import_argv("yedek", true), ["import", "-N", "-f", "yedek"]);
    }

    /// İmza iki veri kümesinin birlikte var olması. Biri yetmiyor.
    #[test]
    fn imza_iki_veri_kumesinin_varligi() {
        let full = vec![
            "yedek".to_string(),
            "yedek/veri".to_string(),
            "yedek/aciklama".to_string(),
        ];
        assert!(looks_like_backup_pool(&full, "yedek"));

        let half = vec!["yedek".to_string(), "yedek/veri".to_string()];
        assert!(!looks_like_backup_pool(&half, "yedek"));

        // Başka bir havuzun aynı adlı veri kümeleri bu havuzu DEPSIS yedek diski yapmıyor.
        let other = vec!["baska/veri".to_string(), "baska/aciklama".to_string()];
        assert!(!looks_like_backup_pool(&other, "yedek"));
    }

    #[test]
    fn iki_veri_kumesi_havuzun_altinda() {
        assert_eq!(meta_dataset("depsisyedek"), "depsisyedek/aciklama");
        assert_eq!(data_dataset("depsisyedek"), "depsisyedek/veri");
    }

    /// Parola argv'de GÖRÜNMEMELİ. `/proc/<pid>/cmdline` bu kutudaki her kullanıcıya okunabilir.
    #[test]
    fn sifreli_kumenin_argvsinde_parola_yok() {
        let argv = create_data_argv("depsisyedek/veri");
        assert!(argv.iter().any(|a| a == "encryption=aes-256-gcm"));
        assert!(argv.iter().any(|a| a == "keyformat=passphrase"));
        assert!(argv.iter().any(|a| a == "keylocation=prompt"));
        assert!(
            !argv
                .iter()
                .any(|a| a.contains("parola") || a.contains("key=")),
            "parola argv'ye sızmamalı: {argv:?}"
        );
    }

    /// Kilitli bir disk olağan hâl; her açılışta bağlanmaya çalışan bir veri kümesi, her açılışta
    /// gerçek bir arızadan ayırt edilemeyen bir hata satırı üretirdi.
    #[test]
    fn sifreli_kume_acilista_kendiliginden_baglanmaya_calismiyor() {
        assert!(create_data_argv("p/veri")
            .iter()
            .any(|a| a == "canmount=noauto"));
    }

    /// Şifresiz yarı HER AÇILIŞTA bağlı olmalı: onu okuyan şey, kimsenin parola girmediği andaki
    /// kurulum sihirbazı.
    #[test]
    fn sifresiz_yari_her_acilista_bagli() {
        let argv = create_meta_argv("p/aciklama");
        assert!(argv.iter().any(|a| a == "canmount=on"));
        assert!(argv.iter().any(|a| a == "mountpoint=/yedek-bilgi"));
        assert!(
            !argv.iter().any(|a| a.starts_with("encryption")),
            "kendini anlatan yarı parola olmadan okunabilmeli"
        );
    }

    /// Kilitleme, bağlıyken de çalışmalı — yoksa kilit düğmesi hiçbir zaman iş görmez.
    #[test]
    fn kilitleme_once_ayiriyor() {
        assert_eq!(unload_key_argv("p/veri"), ["unload-key", "-u", "p/veri"]);
    }

    #[test]
    fn durum_satiri_okunuyor() {
        let state = parse_state("depsisyedek/veri\tyes\tavailable\t900000000000\t12345\n").unwrap();
        assert!(state.mounted);
        assert!(state.key_loaded);
        assert_eq!(state.available_bytes, 900_000_000_000);
        assert_eq!(state.used_bytes, 12_345);
    }

    #[test]
    fn kilitli_bir_kume_kilitli_okunuyor() {
        let state = parse_state("depsisyedek/veri\tno\tunavailable\t-\t0\n").unwrap();
        assert!(!state.mounted);
        assert!(!state.key_loaded);
        assert_eq!(state.available_bytes, 0);
    }

    /// Şifresiz veri kümesinde `keystatus` `-` döner. Onu "kilitli" saymak, diskin kendini
    /// anlatan yarısını sonsuza kadar kapalı göstermek olurdu.
    #[test]
    fn sifresiz_bir_kumenin_anahtari_hep_yuklu_sayiliyor() {
        let state = parse_state("depsisyedek/aciklama\tyes\t-\t900000000000\t131072\n").unwrap();
        assert!(state.key_loaded);
    }

    #[test]
    fn bos_ve_bozuk_cevaplar_hata_veriyor() {
        assert!(parse_state("").is_err());
        assert!(parse_state("p/veri\tyes\tavailable\n").is_err());
        assert!(parse_state("p/veri\tyes\tbilinmeyen\t0\t0\n").is_err());
        // İki satır: sorulan tek bir veri kümesiydi, gelen başka bir şey.
        assert!(parse_state("a\tyes\t-\t0\t0\nb\tyes\t-\t0\t0\n").is_err());
    }

    #[test]
    fn durum_sorgusu_ham_bayt_istiyor() {
        let argv = status_argv("p/veri");
        assert!(
            argv.iter().any(|a| a == "-p"),
            "insan için kısaltılmış sayı ayrıştırılamaz"
        );
        assert!(argv
            .iter()
            .any(|a| a == "name,mounted,keystatus,available,used"));
    }
}
