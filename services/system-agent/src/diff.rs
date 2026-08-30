//! `zfs diff` — iki anlık görüntü arasında ne değişti.
//!
//! ── bu modülün var olma nedeni ───────────────────────────────────────────────────────────────
//!
//! Altı saatte bir dönen yedekleme turu, "hangi dosyalar değişti" sorusunu ucuza cevaplamak
//! zorunda. Bir milyon dosyalı bir ağacı her turda yürümek, ritmin kendisini anlamsız kılar.
//! `zfs diff` bu soruyu tek çağrıda, hiçbir dizin yürünmeden cevaplıyor — eklenen, değişen,
//! silinen ve yeniden adlandırılan her yolu veriyor.
//!
//! İşlem ajanda zaten vardı ve hiç çağrılmamıştı. Çağrılsaydı üç şey olurdu, ve bu modül üçünü
//! de kapatıyor.
//!
//! ── BİR: TÜRKÇE DOSYA ADLARI BOZULUYORDU ─────────────────────────────────────────────────────
//!
//! `zfs diff` yolları OLDUĞU GİBİ yazmıyor. libzfs'in `stream_bytes()` işlevi, boşluktan büyük,
//! ters eğik çizgi olmayan ve 0x7F'ten küçük her baytı harfiyen basıyor; GERİ KALAN HER ŞEYİ
//! `\` + üç sekizlik hane olarak kaçırıyor. "Geri kalan her şey"in içinde boşluk, ters eğik
//! çizgi, ve — asıl önemlisi — 0x7F ve üstündeki her bayt var. Yani UTF-8'in çok baytlı her
//! karakteri, yani Türkçe alfabenin yarısı.
//!
//! ```text
//! "Vergi Raporu.pdf"  ->  Vergi\040Raporu.pdf
//! "cicek.jpg"         ->  \303\247i\303\247ek.jpg
//! ```
//!
//! Kaçışları çözmeden bu satırları yol olarak kullanmak, yedeğe `\303\247icek.jpg` adıyla bir
//! dosya yazmak demekti — ve kullanıcının o dosyayı geri getirmesinin hiçbir yolu olmazdı.
//!
//! ── İKİ: YANIT SINIRSIZDI ────────────────────────────────────────────────────────────────────
//!
//! Eski hâli `out.lines().map(str::to_string).collect()` idi: ne bir tavan, ne bir kesme işareti.
//! Sekiz yüz bin dosya kopyalandıktan sonraki tur, kök yetkiyle koşan ajanın belleğini bitirirdi.
//! Bu depodaki her listeleme zaten sınırlı (`MAX_LISTING`, `MAX_DISKS`) ve gerekçesi hep aynı:
//! bir yanıt, kontrol soketinde bir satır.
//!
//! KESİLMİŞ BİR DEĞİŞİKLİK LİSTESİ SESSİZCE KULLANILAMAZ, ve fark burada. Kesilmiş bir DİZİN
//! listesi eksik bir ekran demektir; kesilmiş bir DEĞİŞİKLİK listesi, yedeklenmeyen dosyalar
//! demektir. Bu yüzden `truncated` bir uyarı değil bir emirdir: çağıran tarafın onu gördüğünde
//! yapması gereken şey, o turda ağacı baştan yürümektir.
//!
//! ── ÜÇ: YENİDEN ADLANDIRMA ───────────────────────────────────────────────────────────────────
//!
//! `R` satırı İKİ yol taşıyor ve tipi ayrı bir sütunda. Bunu "eskisi silindi + yenisi eklendi"
//! diye okumak, kırk bin fotoğraflık bir klasörün adı değiştiğinde bütün klasörü silinenlere
//! taşıyıp baştan kopyalamak demekti — ZFS için tek bir nesnenin üst bağının değişmesi olan şey.
//! Tip ayrı bir alan olarak taşınıyor ki çağıran taraf dizini dosyadan ayırabilsin.

use serde::{Deserialize, Serialize};

use crate::seams::SeamError;

/// Bir turda bildirilecek en fazla değişiklik.
///
/// `MAX_LISTING` ile aynı sayı ve aynı gerekçe: bir yanıt kontrol soketinde bir satır. Bunu aşan
/// bir delta, tek tek dosya kopyalamakla değil tam yürüyüşle karşılanır — sekiz bin değişikliği
/// olan bir ağaçta zaten yürüyüşün maliyeti listeyi taşımanın maliyetinin altında.
pub const MAX_DIFF: usize = 5_000;

/// Bir nesneye ne olduğu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiffChange {
    Added,
    Modified,
    Removed,
    Renamed,
}

/// Nesnenin ne olduğu.
///
/// `zfs diff -F`'in tip sütunu dokuz değer üretebiliyor; yedekleme yalnız ikisini taşıyabiliyor
/// (dosya ve dizin) ve geri kalan her şey `Other`. Soket, fifo ve aygıt düğümü için DEPSIS'in bir
/// satır biçimi yok — `entries_of` da onları aynı gerekçeyle atıyor — ama burada ATILMIYORLAR:
/// silinmiş bir fifo'nun yedekten kaldırılması gereken bir karşılığı olabilir, ve çağıran tarafın
/// "bu neydi" sorusuna cevap verebilmesi gerekiyor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiffKind {
    File,
    Directory,
    Other,
}

/// Tek bir değişiklik.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DiffEntry {
    pub change: DiffChange,
    pub kind: DiffKind,
    /// Veri kümesinin bağlama noktasına göre MUTLAK yol, kaçışları çözülmüş hâlde.
    pub path: String,
    /// Yalnız `Renamed` için dolu: eski yol. Diğerlerinde `None`.
    pub old_path: Option<String>,
}

/// `zfs diff` argümanları.
///
/// `-H` sekmeyle ayırıyor (başlık ve hizalama yok), `-F` tip sütununu ekliyor. İkisi de bu
/// modülün ayrıştırmasının dayandığı biçim, ve bu yüzden burada — çağıran tarafın bayrak
/// seçebilmesi, biçimi değiştirebilmesi demek olurdu.
pub fn argv<'a>(from: &'a str, to: &'a str) -> [&'a str; 5] {
    ["diff", "-H", "-F", from, to]
}

/// `\nnn` sekizlik kaçışlarını çözer ve sonucu UTF-8 olarak okur.
///
/// Kaçış TAM ÜÇ HANE, ve gevşetilmiyor: libzfs `%03hho` ile basıyor, yani her zaman üç hane
/// üretiyor. İki haneyi de kabul eden bir çözücü, `\12` ile başlayan meşru bir adı yanlış
/// okurdu. Üç sekizlik hane bulamadığımızda ters eğik çizgi HARFİYEN alınıyor — bu durum
/// `zfs diff` çıktısında oluşamaz (ters eğik çizgi kendisi de kaçırılıyor), ama çözücünün
/// beklenmedik bir girdide veri UYDURMAMASI gerekiyor.
///
/// `None` yalnız sonuç geçerli UTF-8 değilse. Bir dosya adı UTF-8 değilse DEPSIS onu zaten
/// adlandıramıyor (`SafeComponent` UTF-8 istiyor), ve o adı taşıyamayacağını söylemek, taşıdığını
/// sanıp yanlış bir ad yazmaktan iyi.
pub fn decode_path(escaped: &str) -> Option<String> {
    let raw = escaped.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut index = 0usize;

    while index < raw.len() {
        let byte = *raw.get(index)?;
        if byte != b'\\' {
            out.push(byte);
            index = index.checked_add(1)?;
            continue;
        }
        let digits = raw.get(index.checked_add(1)?..index.checked_add(4)?);
        match digits {
            Some(three) if three.iter().all(|d| (b'0'..=b'7').contains(d)) => {
                let mut value: u32 = 0;
                for digit in three {
                    value = value
                        .checked_mul(8)?
                        .checked_add(u32::from(digit.wrapping_sub(b'0')))?;
                }
                out.push(u8::try_from(value).ok()?);
                index = index.checked_add(4)?;
            }
            _ => {
                out.push(b'\\');
                index = index.checked_add(1)?;
            }
        }
    }

    String::from_utf8(out).ok()
}

/// `zfs diff -H -F` çıktısını okur.
///
/// İkinci dönüş değeri KESİLDİ mi: `true` ise liste eksiktir ve çağıran taraf onu değişiklik
/// listesi olarak KULLANMAMALIDIR (modül başlığındaki gerekçe).
///
/// Ayrıştırılamayan bir satır ATLANMIYOR, hata veriyor. Bir listeleme çıktısında tanınmayan bir
/// satırı atlamak makul; bir DEĞİŞİKLİK listesinde aynı şey, yedeklenmeyen bir dosyanın sessizce
/// yok sayılması demek — ve bunun izi hiçbir yerde kalmaz.
pub fn parse(out: &str) -> Result<(Vec<DiffEntry>, bool), SeamError> {
    let mut entries = Vec::new();
    let mut truncated = false;

    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        if entries.len() >= MAX_DIFF {
            truncated = true;
            break;
        }

        let mut fields = line.split('\t');
        let (Some(change), Some(kind), Some(first)) = (fields.next(), fields.next(), fields.next())
        else {
            return Err(SeamError::Io(format!(
                "zfs diff satırı üç alandan az: {line:?}"
            )));
        };
        let second = fields.next();

        let change = match change {
            "+" => DiffChange::Added,
            "-" => DiffChange::Removed,
            "M" => DiffChange::Modified,
            "R" => DiffChange::Renamed,
            other => {
                return Err(SeamError::Io(format!(
                    "zfs diff tanınmayan değişiklik işareti: {other:?}"
                )))
            }
        };

        // `-F`'in tip sütunu. `/` dizin, `F` sıradan dosya; geri kalan sekiz değerin hepsi
        // taşınamayan nesneler ve tek bir ada iniyor.
        let kind = match kind {
            "/" => DiffKind::Directory,
            "F" => DiffKind::File,
            _ => DiffKind::Other,
        };

        // `R` satırında ilk yol ESKİ, ikincisi YENİ. Diğer satırlarda tek yol var ve ikinci alan
        // hiç gelmiyor — geldiyse biçim beklediğimiz gibi değil ve bunu yutmuyoruz.
        let (path, old_path) = match (change, second) {
            (DiffChange::Renamed, Some(new_path)) => (new_path, Some(first)),
            (DiffChange::Renamed, None) => {
                return Err(SeamError::Io(format!(
                    "zfs diff yeniden adlandırma satırında ikinci yol yok: {line:?}"
                )))
            }
            (_, Some(_)) => {
                return Err(SeamError::Io(format!(
                    "zfs diff satırında beklenmeyen dördüncü alan: {line:?}"
                )))
            }
            (_, None) => (first, None),
        };

        let Some(path) = decode_path(path) else {
            return Err(SeamError::Io(format!(
                "zfs diff yolu UTF-8 değil: {path:?}"
            )));
        };
        let old_path = match old_path {
            None => None,
            Some(raw) => Some(decode_path(raw).ok_or_else(|| {
                SeamError::Io(format!("zfs diff eski yolu UTF-8 değil: {raw:?}"))
            })?),
        };

        entries.push(DiffEntry {
            change,
            kind,
            path,
            old_path,
        });
    }

    Ok((entries, truncated))
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

    /// Sahadaki asıl kayıp bu olurdu: bu cihazın dosyalarının çoğu Türkçe adlı.
    #[test]
    fn turkce_adlar_ve_bosluklar_geri_geliyor() {
        assert_eq!(
            decode_path(r"Vergi\040Raporu\0402025.pdf").unwrap(),
            "Vergi Raporu 2025.pdf"
        );
        assert_eq!(
            decode_path(r"\303\247i\303\247ek.jpg").unwrap(),
            "çiçek.jpg"
        );
        assert_eq!(
            decode_path(r"Belgeler/\304\260stanbul/\305\236irket.docx").unwrap(),
            "Belgeler/İstanbul/Şirket.docx"
        );
    }

    /// Ters eğik çizginin kendisi de kaçırılıyor — çözülmezse yol bir dizin sınırına dönüşürdü.
    #[test]
    fn ters_egik_cizgi_kendisi_de_kacirilmis_geliyor() {
        assert_eq!(decode_path(r"a\134b.txt").unwrap(), r"a\b.txt");
    }

    /// Kaçış içermeyen bir yol olduğu gibi kalıyor: çözücü hiçbir şey uydurmuyor.
    #[test]
    fn duz_bir_yol_degismeden_geciyor() {
        assert_eq!(
            decode_path("Belgeler/rapor.pdf").unwrap(),
            "Belgeler/rapor.pdf"
        );
    }

    /// Üç hane şart. `\12x` bir kaçış değil, ve iki haneyi kabul eden bir çözücü onu yanlış okur.
    #[test]
    fn eksik_haneli_bir_kacis_harfiyen_aliniyor() {
        assert_eq!(decode_path(r"a\12x").unwrap(), r"a\12x");
    }

    #[test]
    fn utf8_olmayan_bir_ad_reddediliyor() {
        // Tek başına 0xFF hiçbir UTF-8 dizisinin parçası olamaz.
        assert!(decode_path(r"\377.txt").is_none());
    }

    #[test]
    fn dort_degisiklik_isareti_de_taniniyor() {
        let out = "+\tF\t/tank/ev/yeni.txt\n\
                   -\tF\t/tank/ev/giden.txt\n\
                   M\tF\t/tank/ev/degisen.txt\n\
                   R\t/\t/tank/ev/Eski\t/tank/ev/Yeni\n";
        let (entries, truncated) = parse(out).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].change, DiffChange::Added);
        assert_eq!(entries[1].change, DiffChange::Removed);
        assert_eq!(entries[2].change, DiffChange::Modified);
        assert_eq!(entries[3].change, DiffChange::Renamed);
    }

    /// Kırk bin fotoğraflık klasörün adının değişmesi, TEK bir taşımadır.
    ///
    /// Bu satırı "eskisi silindi + yenisi eklendi" diye okumak, bütün klasörü silinenlere taşıyıp
    /// baştan kopyalamak demekti — ZFS için tek bir nesnenin üst bağının değişmesi olan şey.
    #[test]
    fn yeniden_adlandirma_iki_yolu_da_tasiyor_ve_dizin_oldugunu_soyluyor() {
        let (entries, _) = parse("R\t/\t/tank/ev/Fotograflar\t/tank/ev/Fotograflarim\n").unwrap();
        assert_eq!(entries[0].kind, DiffKind::Directory);
        assert_eq!(entries[0].path, "/tank/ev/Fotograflarim");
        assert_eq!(entries[0].old_path.as_deref(), Some("/tank/ev/Fotograflar"));
    }

    /// Kesilme bir uyarı değil bir emir: çağıran taraf tam yürüyüşe dönmeli.
    #[test]
    fn cok_uzun_bir_liste_kesildigini_soyluyor() {
        let mut out = String::new();
        for index in 0..(MAX_DIFF + 10) {
            out.push_str(&format!("+\tF\t/tank/ev/{index}.txt\n"));
        }
        let (entries, truncated) = parse(&out).unwrap();
        assert!(truncated, "kesilme bildirilmeli");
        assert_eq!(entries.len(), MAX_DIFF);
    }

    /// Tanınmayan bir satır ATLANMIYOR. Atlamak, yedeklenmeyen bir dosyanın izsiz kaybolmasıdır.
    #[test]
    fn taninmayan_satir_hata_veriyor() {
        assert!(parse("?\tF\t/tank/ev/a.txt\n").is_err());
        assert!(parse("+\tF\n").is_err());
        assert!(parse("R\tF\t/tank/ev/tek-yol\n").is_err());
        assert!(parse("+\tF\t/tank/ev/a.txt\t/tank/ev/fazladan\n").is_err());
    }

    /// Boş çıktı: hiçbir şey değişmemiş. Hata değil.
    #[test]
    fn hicbir_sey_degismediyse_liste_bos() {
        let (entries, truncated) = parse("").unwrap();
        assert!(entries.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn argumanlar_bicimi_sabitliyor() {
        assert_eq!(
            argv("tank/ev@a", "tank/ev@b"),
            ["diff", "-H", "-F", "tank/ev@a", "tank/ev@b"]
        );
    }
}
