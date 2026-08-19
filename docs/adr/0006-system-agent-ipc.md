# ADR-0006: Sistem aracısı ayrıcalık sınırı ve IPC sözleşmesi

- **Durum:** Accepted
- **Provizyon kalktı:** 2026-08-19, [P0-E](evidence/p0-e.tsv) ile — 82 assertion, sıfır hata
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `services/system-agent`, `packages/contracts`, `deploy/systemd`

## Bağlam

§2.2 bağlayıcı: _"Aracı hiçbir zaman serbest biçimli shell komutu kabul etmemeli."_ §16 en küçük
yetki ilkesini şart koşuyor. Aracı Rust'ta yazılacak (ADR-0001) ama Windows'ta da derlenip test
edilebilmeli (ADR-0012'nin çift hattı).

## Karar

### Mimari: tek "mock backend" değil, dört dikiş

Aracı çekirdeği **platformdan bağımsız ve saf**: tiplenmiş op enum'u, dispatch, yetkilendirme,
audit. Çekirdekte **sıfır `cfg` niteliği** var ve her yerde derlenir. Platforma bağlı her şey dört
trait'in arkasında:

| Trait           | Gerçek (`#[cfg(unix)]`)             | Mock (taşınabilir)               |
| --------------- | ----------------------------------- | -------------------------------- |
| `Transport`     | tokio `UnixListener`                | `tokio::io::duplex` — bellek içi |
| `PeerIdentity`  | `UnixStream::peer_cred()` → `UCred` | düz `struct { uid, gid }`        |
| `SafePath`      | `rustix::fs::openat2`               | tempdir'e köklenmiş `std::fs`    |
| `CommandRunner` | `tokio::process::Command`           | argv vektörlerini kaydeder       |

`cfg` niteliği **dosya içinde değil, modül bildiriminde** (`#[cfg(unix)] mod unix;`). CI'da
`cargo check --target x86_64-pc-windows-msvc` gating regresyonlarını anında yakalar.

**Transport için TCP-loopback yerine bellek içi duplex.** Windows'ta TCP loopback zaten peer
credential taşımaz, yani `PeerIdentity`'yi nasılsa stub'lamak gerekir — karşılığında port tahsisi,
kararsız paralel testler ve gerçek bir dinleyen soket bedeli ödenir. Değmez.

### Güvenli yol çözümleme: doğrudan `rustix`

Debian trixie çekirdeği 6.12.101'de sabit. Üst seviye crate'lerin kattığı tek değer — 5.6 öncesi
çekirdekler için zarif fallback — hiç çalıştırılmayacak ölü ağırlık.

| Crate              | Karar                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **`rustix` 1.1.4** | **Seçildi.** İhtiyaç duyulan bayrakları ince ve denetlenebilir bir yüzeyle veriyor; zaten geçişli bağımlılıkta                           |
| `pathrs` 0.2.5     | İkinci sıra. Konteyner güvenliği yazarından, tam bu iş için. 1.0 öncesi. `SafePath` trait'inin arkasında olduğu için sonradan geçiş ucuz |
| `cap-std`          | Mükemmel ama tüm `std`'yi değiştiren bir yetenek modeli — "tek yolu güvenli çöz" için fazla yüzey                                        |
| `openat`           | **Elendi** — 2021'den beri hareketsiz                                                                                                    |

Her kullanıcı yolu için:

```rust
let flags = ResolveFlags::BENEATH
          | ResolveFlags::NO_SYMLINKS
          | ResolveFlags::NO_MAGICLINKS
          | ResolveFlags::NO_XDEV;
let fd = rustix::fs::openat2(&share_root_fd, rel_path,
                             OFlags::RDONLY | OFlags::CLOEXEC, Mode::empty(), flags)?;
```

- `share_root_fd` **süreç ömrü boyunca açık tutulur**, başlangıçta bir kez açılır. Kök asla
  string'den yeniden çözülmez.
- `NO_XDEV` bu ürün için özellikle değerli: kullanıcının iç içe bir mountpoint üzerinden bir
  dataset'ten diğerine kaçmasını engeller — ZFS kutusunda gerçek bir senaryo.
- **`BENEATH` (sert ret), `IN_ROOT` (sessiz kırpma) değil** — böylece traversal denemesi sessizce
  düzeltilmek yerine **gürültülü bir audit olayı** olur.

### Süreç çalıştırma: tek boğaz noktası, üç kural

1. **Yalnız mutlak yol:** `/usr/sbin/zpool`, `/usr/sbin/zfs`, `/usr/sbin/smartctl`,
   `/usr/bin/smbcacls`. `execvp`'nin `/bin:/usr/bin`'e düşme tuzağı tamamen atlanır.
2. **`env_clear()`**, sonra açık allowlist: sabit mutlak `PATH`, `LC_ALL=C` (çıktı ayrıştırması
   kararlı olsun), `TZ=UTC`. Hiçbir şey miras alınmaz.
3. **Argüman enjeksiyonu:** asıl tehlike `-` ile başlayan dosya adı — `zfs`/`zpool`/`smartctl`/
   `smbcacls` kendi argv'lerini ayrıştırır. Kullanıcı kaynaklı her operanddan önce literal `--`
   konur, **ve bağımsız olarak** tiplenmiş op doğrulama katmanında baştaki `-` reddedilir veya
   `./` ile normalize edilir. **Yalnız `--`'ye güvenilmez** — bu araçların hepsi tutarlı biçimde
   onurlandırmıyor. `NUL` ve `.`/`..` bileşenleri `openat2`'ye ulaşmadan reddedilir.

### IPC şeması: Rust sahiplenir

`schemars` 1.2.2 Rust istek/yanıt enum'larından JSON Schema türetir; bir build adımı
`json-schema-to-typescript` 15.0.4 ile `.d.ts` üretir; **üretilen dosya depoya commit'lenir** ve
CI yeniden üretip diff'te başarısız olur.

**Gerekçe:** şemayı, güven sınırını _uygulayan_ taraf sahiplenmelidir. Aracı, doğrulamaya
güvenilebilecek tek bileşendir; dolayısıyla aracının tipleri **tanımı gereği** sözleşmedir.
Şemayı TS/zod sahiplenseydi, ayrıcalıklı taraf yetkisiz tarafın yazdığı bir tanıma uyuyor olurdu —
bir güvenlik sınırı için tam tersi. Ve şu hata modunu davet ederdi: API'nin zod şeması gevşetilir,
aracı sessizce uyar.

Nötr IDL (protobuf/Cap'n Proto) de reddedildi: tek bir derive makrosuyla çözülen iki dilli bir
problem için her iki tarafa üçüncü bir araç zinciri ve codegen adımı ekler.

zod TS tarafında kalır ama **üretilen JSON Schema'dan** üretilir ve yalnız yanıtların runtime
doğrulaması için kullanılır — asla doğruluk kaynağı olarak değil.

### systemd: root, ve bunu dürüstçe söyle

`zpool` operasyonları ve dataset `mount` delege edilemez. Seçenek root ya da `CAP_SYS_ADMIN`'dir
ve **`CAP_SYS_ADMIN` root-eşdeğeridir**. Ambient capability'lerin burada güvenlik satın aldığını
iddia etmek kendini kandırmaktır. Root seçilir ve tehdit modelinde **açıkça** böyle yazılır.

Güvenlik şuradan gelir: (i) operasyon yüzeyi kapalı bir tiplenmiş enum — shell yok, pass-through
argüman yok; (ii) her çağrıda `peer_cred` ile uid/gid yetkilendirmesi; (iii) her yolun `openat2`
ile hapsedilmesi; (iv) systemd sertleştirmesi **derinlemesine savunma olarak**.

```ini
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/depsis /run/depsis
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER CAP_SYS_RAWIO
RestrictAddressFamilies=AF_UNIX
SystemCallFilter=@system-service
LoadCredential=db_password:/etc/depsis/db.cred
```

Kritik ayrıntılar:

- **`AmbientCapabilities=` kullanılmıyor**, `CapabilityBoundingSet=` kullanılıyor. Ambient
  capability'ler miras kümesine eklenir ve spawn edilen **her** `zfs`/`smartctl` çocuğuna sızar.
- **`SystemCallFilter=~@privileged` EKLENMEZ** — `mount()` o kümede ve ZFS dataset mount'u ona
  ihtiyaç duyuyor.
- `RestrictAddressFamilies=AF_UNIX` — aracı asla ağ soketi açmamalı. Bu tek satır, sömürü sonrası
  veri sızdırma yollarının çoğunu öldürür.
- `CAP_SYS_RAWIO` yalnız `smartctl` cihaz erişimi için; SMART `smartd` üzerinden alınırsa düşürülür.
- **Socket activation** (`.socket` unit'i, `SocketMode=`, `SocketUser=`/`SocketGroup=`): soket
  yaşam döngüsünü çekirdek yönetir ve soket dosyasındaki DAC, `peer_cred` daha danışılmadan
  **ilk yetkilendirme kapısı** olur.
- Her secret `LoadCredential=` ile teslim edilir — `$CREDENTIALS_DIRECTORY` altında mode 0400,
  servis kullanıcısına ait, ve `NoNewPrivileges=yes` altında çalışıyor.

## Kanıt

| İddia                                                                                                    | Güven                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Rust stable 1.97.1; `rustix` 1.1.4; `schemars` 1.2.2; `json-schema-to-typescript` 15.0.4; `pathrs` 0.2.5 | verified                                        |
| Debian trixie çekirdeği 6.12.101                                                                         | verified                                        |
| `openat` crate 2021'den beri hareketsiz                                                                  | verified                                        |
| `execvp` PATH yokken `/bin:/usr/bin`'e düşer                                                             | verified                                        |
| `LoadCredential=` mode-0400 servis-kullanıcısı dosyası üretir, `NoNewPrivileges` altında çalışır         | verified — ama **kullanılmıyor**: ajanın sırrı yok (P0-E §8c) |
| Windows Build Tools'un tam bileşen listesi                                                               | **unverified** → temiz makinede doğrulanacak    |
| `cap-std`'nin Linux çözümleme stratejisi                                                                 | **unverified** (seçilmediği için bloke etmiyor) |

### P0-E'nin ölçtükleri (2026-08-19, Debian 13 / systemd 257 / rustc 1.97.1)

| İddia                                                                    | Sonuç                                       |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| Serbest biçimli komut yolu yok — 8 deneme parse aşamasında reddedildi     | ✅ ölçüldü                                  |
| Kimlik `SO_PEERCRED`'den; `{"uid":0}` iddiası sonucu değiştirmiyor        | ✅ ölçüldü                                  |
| root reddediliyor ve ret audit'e düşüyor                                 | ✅ ölçüldü                                  |
| `openat2(BENEATH\|NO_SYMLINKS)` kaçışı **hata** olarak reddediyor         | ✅ ölçüldü (crate testleri, gerçek çekirdek) |
| `NO_XDEV` iç içe dataset'e geçişi engelliyor                             | ✅ ölçüldü (gerçek ZFS mount sınırı)        |
| `-` ile başlayan operand `zfs`'e ulaşmıyor                               | ✅ ölçüldü                                  |
| `cargo check --target x86_64-pc-windows-msvc` yeşil                      | ✅ ölçüldü                                  |
| Soket 0660 root:depsis-api; grup dışı kullanıcı **connect edemiyor**     | ✅ ölçüldü (EACCES, çekirdekten)            |
| Audit satırı enjekte edilemiyor (`reason`'da kontrol karakteri reddi)     | ✅ ölçüldü                                  |
| Bilinmeyen alan **sessizce yutulmuyor** (`deny_unknown_fields`)           | ✅ ölçüldü — bu ADR'nin öngörmediği bir açıktı |

**P0-E'nin bulduğu ve bu ADR'yi değiştiren üç şey:**

1. **`ProtectKernelModules=` ve `ProtectKernelLogs=` özel mount ad-alanı yaratıyor.** Unit dosyası
   bunun tersini iddia ediyordu. Sonuç sessizdi: ajan üzerinden oluşturulan dataset yalnızca
   ajanın göremediği yerde mount oluyor, `zfs list` host'ta onu gösteriyor, ajan `created`
   dönüyor, Samba boş dizin sunuyordu. Hiçbir katmanda hata yok. İkisi de çıkarıldı; aynı
   kısıtlama `CapabilityBoundingSet=~…` + `SystemCallFilter=~@module` ile ad-alanı olmadan
   sağlanıyor. `MountFlags=shared` reddedildi: ters yönde de yayılır ve erişilemez-yol bind
   mount'larını host'a taşır.
2. **Serde varsayılanı bilinmeyen alanı yok sayıyordu.** API `refquota` yazsa `refquota_bytes`
   yerine, kotasız bir dataset başarıyla oluşurdu. `deny_unknown_fields` eklendi. Bu, içten
   etiketli enum'ların **birim** varyantlarında çalışmadığı için `Ping` yapı varyantına çevrildi.
3. **Çerçeveleme hatası.** Newline olmadan istek gönderip yazma yönünü kapatan — yani sıradan
   bir istek/yanıt istemcisi — "request exceeds 262144 bytes" cevabı alıyordu. Boyut sınırı artık
   bayt sayısıyla ölçülüyor, newline'ın varlığıyla değil.

## P0-E — koşuldu

Yedi maddenin altısı doğrudan ölçüldü ([kanıt](evidence/p0-e.tsv), `tools/poc/p0-e-agent-boundary.sh`).

Madde 3'ün ikinci yarısı ve madde 7 olduğu gibi geçerli değil, ve bunu gizlemek yerine yazıyoruz:

- **Madde 3 — "audit olayı üreterek".** `openat2` reddi bir **hata** olarak dönüyor ve bu ölçüldü;
  ancak henüz hiçbir operasyon çağırandan paylaşım-içi yol almadığı için ortada audit'e düşecek
  bir çağrı yok. `SafePath` uygulanmış ve gerçek çekirdeğe karşı test edilmiş durumda; dispatch'e
  Faz 1'in ilk yol alan operasyonuyla (upload publish, move) bağlanacak. `lib.rs`'in başlığı da
  buna göre düzeltildi — "her yol hapsedilir" ifadesi bugün için doğru değildi.
- **Madde 7 — `LoadCredential`.** Aracının sırrı yok: tek yapılandırması API'nin uid'i, ki gizli
  değil. Unit dosyası `LoadCredential=` içermiyor, dolayısıyla sızma sorusu yazıldığı biçimiyle
  konusuz. P0-E bunun yerine kalıcı olanı ölçüyor: ajanın `/proc/<pid>/environ`'unda parola/token
  deseni bulunmadığını ve unit'in `LoadCredential=` beyan etmediğini. Birisi o `EnvironmentFile`'a
  bir veritabanı parolası eklediği gün assertion patlar.

## Sonuçlar

**Olumlu:** Güven sınırı tek yönlü ve şema onu uygulayan taraf tarafından sahipleniliyor. Windows'ta
tam test edilebilirlik, soket veya port olmadan. `RestrictAddressFamilies=AF_UNIX` sızdırma
yollarını kapatıyor.

**Olumsuz / kabul edilen bedel:** Aracı **root çalışıyor** ve bu gizlenmiyor. `CAP_SYS_ADMIN`
bounding set'te olmak zorunda çünkü ZFS mount onu istiyor. Güvenlik, capability daraltmasından
değil **yüzey daraltmasından** geliyor — bu yüzden op enum'unun kapalı kalması pazarlık konusu değil.

**Bu kararın yasakladığı şeyler:**

- Aracıya serbest biçimli komut, shell, veya pass-through argüman geçirilemez.
- `AmbientCapabilities=` kullanılamaz.
- `IN_ROOT` kullanılamaz; `BENEATH` zorunlu.
- Çalıştırılabilirler PATH'ten aranamaz; mutlak yol zorunlu.
- Ortam miras alınamaz; `env_clear()` zorunlu.
- IPC şeması TypeScript tarafında tanımlanamaz.
- Aracı ağ soketi açamaz.
- Üretilen `.d.ts` elle düzenlenemez.

## Geri alma maliyeti

Orta. Dört trait sayesinde `rustix` → `pathrs` geçişi veya transport değişimi izole. Şema
sahipliğini değiştirmek ise codegen hattını ve her iki taraftaki tipleri etkiler — bu yüzden
Faz 0'da karara bağlandı.

## Güvenlik ve veri kaybı etkisi

Bu, DEPSIS'in **en kritik güven sınırıdır** (§2.2). Root çalışan bir bileşenin varlığı tehdit
modelinde açıkça kaydedilir; azaltma capability daraltması değil, **kapalı tiplenmiş op yüzeyi +
peer_cred yetkilendirmesi + openat2 hapsi + ağ erişiminin tamamen kaldırılması** kombinasyonudur.
Risk R2 (ayrıcalık yükseltme) ve R3 (path traversal/TOCTOU) doğrudan bu ADR ile azaltılır.
`BENEATH`'in sessiz kırpma yerine sert ret seçmesi, saldırı denemelerinin **görünür** olmasını
sağlar — sessizce düzeltilen bir traversal, tespit edilemeyen bir traversaldır.
