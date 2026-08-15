# ADR-0005: Dosya kimliği ve path reconciliation modeli

- **Durum:** **Accepted** — P0-D koştu ve geçti 38/38 (2026-08-15), kanıt:
  [`evidence/p0-d.tsv`](evidence/p0-d.tsv). Açık soru kapandı, bkz. "Ölçüldü".
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `deploy/migrations`, `apps/api/src/files`, `apps/worker/src/jobs/indexer.ts`

## Bağlam

§13 net: _"Path'i tek kimlik kabul etme; dosyanın kararlı ID'si ve parent ID'si olsun."_

Ama gerçek dünya buna direniyor: SMB yollarla çalışır, `vfs_full_audit` yol raporlar (ADR-0011),
`zfs diff` yol raporlar, ve kullanıcı arayüzü yol gösterir. Kimlik ile yol arasında bir köprü
kurulmak zorunda.

## Karar

### Üç kimlik katmanı, her birinin tek bir işi var

| Katman               | Alan                                  | Ne için                                                                 | Ne için **değil**                      |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| **Mantıksal kimlik** | `id` (UUIDv7), `parent_id`            | Kalıcı referans: görev bağlantısı, ACL, paylaşım, audit, API            | Dosya sisteminde bir şey bulmak        |
| **Fiziksel kimlik**  | `(dataset_id, inode, ino_generation)` | Reconciliation join anahtarı — dış değişikliği DB satırıyla eşleştirmek | Dış API'de görünmek                    |
| **Sunum**            | `name`, materyalize `path`            | Gösterim, SMB eşlemesi, arama                                           | **Yetki kararı**, kimlik, benzersizlik |

`id` PostgreSQL 18'in yerleşik `uuidv7()`'siyle üretilir (ADR-0013) — zamana göre sıralı, bu yüzden
B-tree indeksi rastgele UUID gibi parçalanmaz, ama tahmin edilemez (§13).

### Yol asla yetki girdisi değildir

Bu kuralın gerekçesi ADR-0006'daki TOCTOU riskiyle aynı: yetki bir yol dizesine bakarak verilirse,
karar ile erişim arasındaki pencerede yol başka bir nesneyi gösterebilir. Yetki **her zaman**
`id` → ACL üzerinden çözülür; dosya sistemi erişimi ise `openat2(BENEATH|NO_SYMLINKS|NO_XDEV)`
ile kök fd'den yapılır (ADR-0006). İkisi arasında string yol taşınmaz.

### `ino_generation` neden gerekli

Inode numaraları **yeniden kullanılır.** Bir dosya silinip yenisi oluşturulduğunda aynı inode
numarası düşebilir; yalnız `(dataset_id, inode)` ile eşleştiren bir reconciliation, silinmiş bir
dosyanın metadata'sını yeni ve alakasız bir dosyaya bağlar — yani **yanlış ACL, yanlış sahip,
yanlış görev bağlantısı**.

`ino_generation`, ZFS'in NFS export'u için zaten ürettiği generation sayacıdır
(`zpl_export_operations`, ADR-0011'de doğrulandı). `name_to_handle_at`/`statx` üzerinden alınır.

> **P0-D'ye bağlıydı, artık ölçüldü — bkz. aşağıdaki "Ölçüldü" bölümü. Kimlik kararlı çıktı;
> dataset GUID'ine dönme yedek planı gerekmiyor.**

## Ölçüldü — P0-D (2026-08-15, ZFS 2.3.2 / kernel 6.12.101)

Bu ADR'nin tek açık sorusu "ZFS'te dosya kimliği restart'a dayanıklı mı" idi. Cevap: **evet**,
her katmanda.

| Ölçüm                                                                | Sonuç |
| -------------------------------------------------------------------- | ----- |
| `FS_IOC_GETVERSION` ZFS'te generation döndürüyor                     | ✅    |
| `zpool export/import` sonrası **inode** aynı                         | ✅    |
| `zpool export/import` sonrası **generation** aynı                    | ✅    |
| `zpool export/import` sonrası **file handle byte'ları birebir aynı** | ✅    |
| `zpool export/import` sonrası **fsid** aynı                          | ✅    |
| **Export öncesi handle, import sonrası aynı inode'a çözülüyor**      | ✅    |
| Silinen dosyanın handle'ı `ESTALE(116)` veriyor                      | ✅    |
| **SMB rename sonrası inode, generation ve handle korunuyor**         | ✅    |

Sonuçlar:

1. **`(fsid, handle)` önbelleği restart'ta geçersizleşmiyor.** ADR'nin "kararsızsa dataset
   GUID'ine dön" yedek planı **gerekmiyor**; yine de `dataset_id` DEPSIS'in kendi anahtarı
   olarak kalır, çünkü ZFS `fsid`'ine bağımlılık gereksiz bir kırılganlıktır.
2. **Reconciliation adım 2 çalışıyor.** SMB üzerinden yeniden adlandırılan bir dosya
   `(dataset_id, inode, generation)` ile bulunuyor, dolayısıyla `id` korunuyor ve ona bağlı
   görev/paylaşım/audit kayıtları kopmuyor. Bu, ADR'nin varlık sebebiydi.
3. `ESTALE` gerçekten dönüyor — indexer'ın "ESTALE = indeksten sil" kuralı geçerli.

**Kanıtlanamayan:** inode yeniden kullanımı. 20.000 dosya yaratıldı ve hedef inode
kullanılmadı; ZFS nesne kimliklerini monoton artırdığı için pratikte yeniden kullanım nadir.
Bu, `generation` alanını gereksiz **kılmaz** — "20 binde olmadı" bir kanıt değildir ve
`generation` alanı zaten bedavaya geliyor. Ama tehdit modelindeki 5.4 maddesinin pratik
olasılığı düşünüldüğünden düşük.

### Materyalize path — türetilmiş, otoriter değil

`path` kolonu `parent_id` zincirinden **türetilir** ve gösterim/SMB eşlemesi/arama için tutulur.
Otorite `parent_id`'dir.

Bir klasör yeniden adlandırıldığında alt ağacın `path` değerleri güncellenmelidir. Bu:

- Tek transaction'da yapılır (kısmi güncellenmiş ağaç görünmez),
- Büyük ağaçlarda bir **job**'a devredilir (§5.1 "uzun işlemler server-side job olarak yürür"),
- Ve job sürerken `parent_id` zaten doğru olduğu için **yetki kararları etkilenmez** — yalnız
  gösterim geçici olarak bayat olabilir.

`ltree` veya materialized-path-only yaklaşımları değerlendirildi ve **reddedildi**: ikisi de yolu
otorite hâline getirir, ki §13 bunu yasaklıyor.

### Reconciliation — dış değişikliği DB'ye bağlamak

ADR-0011'in dört katmanı yol tabanlı olaylar üretir. Eşleştirme sırası:

1. **Yol ile ara.** Çoğu olay burada çözülür (ucuz).
2. Bulunamazsa **`(dataset_id, inode, generation)` ile ara** → bulunursa bu bir **taşıma/yeniden
   adlandırma**dır, silme+oluşturma değil. Satır güncellenir, `id` **korunur** — görev bağlantıları,
   paylaşımlar ve audit geçmişi hayatta kalır.
3. Yine bulunamazsa **yeni dosya** → yeni `id`.
4. DB'de olup diskte olmayan → **silme** (çöp kutusu politikasına göre).

Adım 2 bu ADR'nin varlık sebebidir. Onsuz, SMB üzerinden yapılan her yeniden adlandırma dosyanın
kimliğini yok eder ve ona bağlı her şey kopar.

### `.depsis` ağacı indekslenmez

ADR-0008'in `<dataset>/.depsis/staging/` ve `.depsis/quarantine/` ağacı indeksleme dışıdır.
Reconciliation bu öneki **kaynakta** filtreler — yarım yüklenmiş dosyalar arama sonucunda
görünmemeli, ve karantinaya alınmış zararlı içerik **hiçbir koşulda** listelenmemeli.

### Kimlik ve isim çakışması

Benzersizlik kısıtı ADR-0013 §2.2 gereği kiracıyı içerir:

```sql
UNIQUE (organization_id, parent_id, name_normalized)
```

`name_normalized` burada **çakışma tespiti** içindir (Windows case-insensitive davranışıyla
uyum). ADR-0010'daki `name_norm` **arama** içindir ve aksanları da düşürür. **İkisi aynı kolon
değildir** — arama normalizasyonu kayıplıdır (`Çağrı` = `Cagri`) ve benzersizlik için kullanılırsa
meşru dosyaları reddeder.

## Kanıt

| İddia                                                          | Güven                      |
| -------------------------------------------------------------- | -------------------------- |
| PG 18 yerleşik `uuidv7()`                                      | verified (ADR-0013)        |
| ZFS `zpl_export_operations` generation üretir                  | verified (ADR-0011)        |
| **Handle/fsid'in reboot ve export/import sonrası kararlılığı** | **unverified → P0-D**      |
| Inode yeniden kullanımı                                        | verified (POSIX davranışı) |

## P0-D eki — bu ADR'yi doğrulayacak testler

1. SMB üzerinden yeniden adlandırılan bir dosya, reconciliation sonrası **aynı `id`'yi** koruyor mu?
2. Bir dosya silinip inode yeniden kullanıldığında, `generation` farkı yanlış eşleşmeyi
   engelliyor mu?
3. `zpool export/import` ve reboot sonrası `(dataset_id, inode, generation)` hâlâ eşleşiyor mu?
4. Büyük klasör yeniden adlandırmasında, path güncelleme job'ı sürerken yetki kararları doğru mu?
5. `.depsis` altındaki dosyalar arama sonucunda **hiç** görünmüyor mu?

## Sonuçlar

**Olumlu:** SMB üzerinden yapılan yeniden adlandırmalar dosya kimliğini korur — görev bağlantıları
ve audit geçmişi kopmaz. Yetki hiçbir zaman string yola bakmaz.

**Olumsuz / kabul edilen bedel:** Üç katman, üç senkronizasyon sorumluluğu. Materyalize path
güncelleme büyük ağaçlarda maliyetli bir job. `generation` alanı ZFS'e özgü bir bağımlılık getirir
(ADR-0007'nin soyutlamasında ele alınıyor).

**Bu kararın yasakladığı şeyler:**

- Yol, yetki kararında girdi olamaz.
- Yol, dış API'de kimlik olarak kullanılamaz.
- Reconciliation yalnız `(dataset_id, inode)` ile eşleştiremez; `generation` zorunlu.
- Arama normalizasyonu benzersizlik kısıtında kullanılamaz.
- `.depsis` ağacı indekslenemez.
- Sıralı numerik ID dış API'de görünemez.

## Geri alma maliyeti

**Yüksek.** Kimlik modeli her tabloya ve her API ucuna dokunur. Faz 0'da karara bağlanmasının
sebebi budur.

## Güvenlik ve veri kaybı etkisi

"Yol yetki girdisi değildir" kuralı, risk R3'ün (path traversal / symlink TOCTOU) veri modeli
tarafındaki karşılığıdır. `generation` olmadan inode yeniden kullanımı **sessiz yetki devri**
yaratır: silinmiş bir dosyanın ACL'i yeni ve alakasız bir dosyaya uygulanabilir. `.depsis`
filtresi, karantinadaki zararlı içeriğin arama üzerinden erişilebilir hâle gelmesini engeller.
