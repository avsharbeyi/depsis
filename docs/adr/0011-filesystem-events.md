# ADR-0011: Dosya sistemi olay yakalama ve indeks tutarlılığı

- **Durum:** **Accepted** — P0-D koştu (2026-08-15), kanıt: [`evidence/p0-d.tsv`](evidence/p0-d.tsv).
  Ölçüm iki iddiayı düzeltti; bkz. "Ölçüldü — P0-D".
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `apps/worker/src/jobs/indexer.ts`, `services/system-agent`, `deploy/systemd`, Samba share şablonu

## Bağlam

Master prompt §5.3 ve §18.2 sert bir kabul kriteri koyuyor:

> "SMB üzerinden oluşturulan dosya belirlenen SLA içinde web aramasına girer."

Faz 0 kickoff'ta (B-varsayımı) şunu planlamıştık:

> fanotify (filesystem-wide mark) ZFS dataset'leri üzerinde birincil olay kaynağı; periyodik
> reconciliation destek.

Bu varsayım hem **gerekçesi** hem **mimarisi** bakımından yanlış — ama beklenenin **tersi**
nedenlerle.

## Bulunan gerçek

### 1. fanotify ZFS'te kategorik olarak bozuk DEĞİL (yaygın kanının aksine)

Çekirdek tarafında FID raporlaması için yalnız iki filesystem kapısı var
(`fs/notify/fanotify/fanotify_user.c`):

- `fanotify_test_fid()` → `exportfs_can_encode_fid()` başarısızsa `-EOPNOTSUPP`
- `fanotify_test_fsid()` → sıfır fsid'de `-ENODEV`, dentry ile sb-root fsid farklıysa `-EXDEV`

ZFS **kâğıt üzerinde ikisini de geçiyor**: `module/os/linux/zfs/zpl_export.c` tam bir
`zpl_export_operations` tanımlıyor (`.encode_fh`, `.fh_to_dentry`, `.fh_to_parent`, `.get_name`,
`.get_parent`, `.commit_metadata`) — NFS export böyle çalıştığı için zorunlu. `zfs_vfsops.c`
`dmu_objset_fsid_guid()`'den sıfır olmayan bir `f_fsid` set ediyor. Bir ZFS dataset'i tek
superblock/tek objset olduğu için btrfs subvolume'ünün `-EXDEV` tuzağı geçerli değil.

Ayrıca `FAN_CREATE`/`FAN_DELETE`/`FAN_MOVE` VFS seviyesinde (`fs/namei.c` içindeki
`fsnotify_create`/`fsnotify_unlink`/`fsnotify_move`) üretiliyor — ZFS bunları "uygulamamazlık"
edemez.

openzfs#6079'daki uzun ömürlü "fanotify ZFS'te bozuk" anlatısı büyük ölçüde bir **fatrace
hatasıydı** (2020-08-21 tarihli yorum bir `/dev/` varlık kontrolünü tespit ediyor); 2024
Haziran'ında üç bağımsız kişi ZFS 2.2.0/2.2.4'te çalıştığını doğruladı.

### 2. Ama "filesystem-wide mark" bir kategori hatası

`FAN_MARK_FILESYSTEM` **tek bir superblock'u** işaretler. Her ZFS dataset'i kendi superblock'u ve
kendi mount'udur. Kullanıcı başına dataset kullanan bir NAS'ta (ki kota, snapshot ve şifreleme
için normal tasarım budur) tek bir `FAN_MARK_FILESYSTEM` tam olarak bir kullanıcıyı kapsar ve alt
dataset'lerde **hiçbir şey görmez**. Dataset başına bir mark ve yeni dataset'leri işaretleyen bir
kontrol döngüsü gerekir — `zfs create` ile mark'ın yerleşmesi arasında bir yarış penceresiyle.

### 3. Ayrıcalık modeli açısından en kötü seçenek

- `fanotify_mark(2)`: `FAN_MARK_FILESYSTEM` **CAP_SYS_ADMIN** ister. Çekirdek bunu
  `if (mark_type != FAN_MARK_INODE && !ns_capable(group->user_ns, CAP_SYS_ADMIN)) return -EPERM;`
  ile uyguluyor.
- FID modu yol değil **opak bir file handle** verir. Yola çevirmek `open_by_handle_at(2)` gerektirir
  ve o man page açıkça der: _"The caller must have the CAP_DAC_READ_SEARCH capability"_ — yani DAC'ı
  atlayarak makinedeki her dosyayı okuyabilme yetkisi.
- Linux 5.13'ün "unprivileged fanotify"ı kurtarmıyor: FID grubu **oluşturulabilir** ama mark
  `FAN_MARK_INODE` dışındaki her şey için `EPERM` verir.

§16'nın en küçük yetki ilkesiyle bu doğrudan çelişiyor.

### 4. Ve zaten yanlış olay kaynağı

Kabul kriteri **SMB hakkında** bir ifadedir, dosya sistemi hakkında değil. Samba'nın
`vfs_full_audit`'i bu olayı **eşzamanlı, süreç içi**, SMB kullanıcı adı ve istemci IP'si iliştirilmiş
biçimde, **sıfır çekirdek yetkisiyle** ve sıfır ZFS bağımlılığıyla verir. Samba'nın zaten elinde
olan bilgiyi geri kazanmak için iki soyutlama katmanı aşağı inip `CAP_SYS_ADMIN` istemek tersine
mühendisliktir.

### 5. Kanıtlanmamış kalan tek şey — tam da bağımlı olduğumuz şey

#6079'da FID modunun özellikle bozuk olduğunu söyleyen tek somut rapor var (mocukie, 2020-12-02:
`fanotify_event_info_fid` doğru set edilmiyor). Bu ZFS 0.8/2.0 dönemine ait ve 2.2.x düzeltmelerinden
sonra **kimse FID modunu yeniden test etmedi**. 2024'teki "artık çalışıyor" doğrulamalarının hepsi
fatrace ile, yani legacy path/mount mark ile — FID ile değil.

## Karar

**Varsayımı tersine çevir.** Samba `vfs_full_audit` **birincil**, fanotify **ikincil**,
`zfs diff` **mutabakat**, tam tarama **son çare**.

### Katman 1 (BİRİNCİL) — Samba `vfs_full_audit` → syslog → indexer. Yetki: **YOK**

```ini
vfs objects = acl_xattr full_audit
full_audit:prefix  = %u|%I|%S
full_audit:success = create_file renameat unlinkat mkdirat close ftruncate linkat symlinkat
full_audit:failure = none
full_audit:facility = local5
full_audit:priority = notice
```

> `write`/`pwrite`/`read`/`pread`/`open`/`getattr`/`lstat` **listelenmez** — syscall başına tetiklenir
> ve makineyi boğar. İçerik-değişti tetikleyicisi olarak doğru olan `close`'dur: dosya başına tek
> olay, veri yazıldıktan sonra.

### ⚠ Geçersiz bir opname paylaşımı tamamen erişilemez yapar (P0-B'de ölçüldü)

Bu ADR'nin ilk hâlinde listede **`rmdir`** vardı. Samba 4.22'de böyle bir opname **yok** —
`*at()` VFS işlemlerine geçildiği için dizin silme `unlinkat` üzerinden gider. Sonucu şu:

```
init_bitmap: Could not find opname rmdir
smb_full_audit_connect: Invalid success operations list. Failing connect
```

**Modül yalnız "denetim çalışmaz" demiyor — bağlantıyı tamamen reddediyor.** Yani o listedeki
tek bir yazım hatası paylaşımı çevrimdışı bırakır.

Daha kötüsü: **`testparm` bunu yakalamaz.** Liste yalnız bağlantı anında doğrulanır. Config
sözdizimsel olarak geçerli görünür, `testparm -s` temiz geçer, servis sorunsuz başlar, ve
sorun ancak ilk istemci bağlanmaya çalıştığında ortaya çıkar.

Bu doğrudan ADR-0004/§9'un "tiplenmiş model → doğrulama → geçici config → `testparm` → atomik
publish" akışını bağlar: **`testparm` bu sınıf hata için yeterli bir kapı değildir.** Sistem
aracısının Samba config publish operasyonu, `testparm`'dan sonra ayrıca **canlı bir bağlantı
denemesi (smoke test)** yapmalı ve başarısızsa önceki config'e geri dönmelidir (§17'nin
"Samba reload başarısızsa önceki geçerli config geri gelir" gereksinimi).

Bu ortamda ampirik olarak doğrulanan opname'ler (Samba 4.22.10, Debian 13):

| Kabul edilen                                                                           | Reddedilen  |
| -------------------------------------------------------------------------------------- | ----------- |
| `create_file` `renameat` `unlinkat` `mkdirat` `close` `ftruncate` `linkat` `symlinkat` | **`rmdir`** |

Satır biçimi `smbd_audit: %u|%I|%S|OPERATION|RESULT|FILE`; parser `|` ile böler, `RESULT == "ok"`
alır. Taşıma: `local5` üzerinde bir rsyslog kuralı → `depsis` kullanıcısı olarak çalışan küçük bir
daemon → PostgreSQL `index_queue` tablosuna INSERT + `NOTIFY`.

Kodlanacak tuzaklar:

- `full_audit` **Samba-göreli yol** raporlar → share kökü saklanıp normalize edilir.
- `renameat` FILE alanında **her iki adı** verir → delete+create değil, **move** olarak işlenir.
- Transferi yarıda kesilen istemci yine `create_file` yayar → indeksleme tetikleyicisi `close`,
  `create_file` yalnız yer tutucu.

### Katman 2 (İKİNCİL) — fanotify, dataset başına, izole daemon. Yetki: `CAP_SYS_ADMIN` + `CAP_DAC_READ_SEARCH`

Yalnız Samba'dan **geçmeyen** yazmalar için: SSH/rsync, DEPSIS'in kendi bant dışı işleri, NFS
re-export, konteyner mount'ları. **Sadece** Katman 1+3 gerçek bir boşluk bırakırsa ve **sadece**
P0-D FID modunu kanıtladıktan sonra yazılır.

```c
fanotify_init(FAN_CLASS_NOTIF | FAN_REPORT_DFID_NAME | FAN_NONBLOCK, O_RDONLY | O_LARGEFILE)
fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
              FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO |
              FAN_RENAME | FAN_CLOSE_WRITE | FAN_ATTRIB | FAN_ONDIR,
              AT_FDCWD, "<dataset mountpoint>")
```

- `FAN_RENAME` (5.17+) kullanılır, `MOVED_FROM`/`MOVED_TO` eşleştirmesi **kullanılmaz** — tek olayda
  iki uç gelir, cookie eşleştirme problemi ortadan kalkar. Debian trixie çekirdeği 5.17'nin çok ötesinde.
- **Dataset başına bir mark.** `zfs list -H -o name,mountpoint -t filesystem` sonucunu izleyen bir
  kontrol döngüsü yeniden işaretler. Yarış kabul edilir, Katman 3 kapatır.
- FID→yol: `(fsid, file_handle) → path` eşlemesi PostgreSQL'de tutulur. `FAN_REPORT_DFID_NAME` zaten
  üst dizin handle'ı + dosya adı verdiği için önbellekli bir dizin haritası olayların çoğunu **sıfır
  syscall** ile çözer. `open_by_handle_at` yalnız cache miss'te. `ESTALE` rutindir, hata değil →
  "indeksten sil" anlamına gelir.
- Yalıtım: ~300 satırlık ayrı bir daemon; `AmbientCapabilities=CAP_SYS_ADMIN CAP_DAC_READ_SEARCH`,
  `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateNetwork=yes`,
  `SystemCallFilter=@system-service`. Tek çıktısı bir Unix socket / kuyruk tablosudur.
  **Bu yetkiler web uygulamasına veya güvenilmeyen girdi ayrıştıran hiçbir şeye verilmez.**
- `FAN_Q_OVERFLOW` → "senkronum" numarası yapılmaz, **"tam mutabakat gerekli"** bayrağı kaldırılır.

### Katman 3 (MUTABAKAT) — `zfs diff`, root timer. Yetki: root (kaçınılmaz)

Dataset başına her N dakikada (başlangıç 15):

```bash
zfs snapshot pool/ds@depsis-<ts>
zfs diff -H -F -t pool/ds@depsis-PREV pool/ds@depsis-NEW
zfs destroy pool/ds@depsis-PREV
```

`-H` çıktısı sekmeyle ayrılmış: ctime, değişim türü, dosya türü, yol(lar). **`R` satırları hem eski
hem yeni yolu taşır** — yeniden adlandırmalar doğru mutabık kılınır; inotify'ın temelde yapamadığı
şey budur.

**Yetki — P0-D'de düzeltildi.** Bu paragraf başlangıçta "snapshot `mount` ister, `mount` delege
edilemez, bu yüzden root gerekir" diyordu. Ölçüm bunu çürüttü: `zfs allow -u depsis
diff,snapshot` ile yetkisiz kullanıcı **`mount` izni olmadan bile** snapshot alabiliyor.
Katman 3 bu yüzden **root çalışmaz**; `depsis` kullanıcısı olarak koşar ve yalnız kuyruğa yazar.
Ayrıntı ve kabul edilen `/dev/zfs` bedeli için "Ölçüldü — P0-D" bölümüne bakınız.

Maliyet: kısa aralık deltayı küçük tutar. HDD havuzlarda `secondarycache=metadata` ve/veya
special/L2ARC vdev ile ZAP metadata yerleşik kalır. Diff süresi ölçülür; aralığa yaklaşırsa alarm.

### Katman 4 (SON ÇARE) — tam tarama

Haftalık; ayrıca her `FAN_Q_OVERFLOW`, kaçırılmış timer, temiz olmayan kapanma veya `zfs receive`
sonrası. Walk + stat, `(path, ino, size, mtime, ctime)` karşılaştırması, **iki yönlü** mutabakat.
`zfs receive` ve `rollback` gibi VFS'i baypas eden mutasyonları yakalayan tek katman budur.

### Düşürülen: inotify

**Tamamen çıkarıldı.** fanotify'dan kesinlikle daha azını verir (filesystem mark yok, sınır ötesi
rename eşleştirilemez, dizin başına watch kurulum maliyeti) ve Samba'nın kendi `notifyd`'sinin
tükettiği aynı `max_user_watches` bütçesiyle yarışır. Katman 2 imkânsız çıkarsa cevap **daha sık
`zfs diff`**'tir, inotify değil.

## Ölçüldü — P0-D (2026-08-15, ZFS 2.3.2 / Samba 4.22.10 / kernel 6.12.101)

### fanotify FID modu ZFS'te **ÇALIŞIYOR** — 2020'den beri kimsenin yeniden test etmediği şey

Bu ADR'nin §5'i "kanıtlanmamış kalan tek şey, tam da bağımlı olduğumuz şey" diyordu. Ölçüldü:

```
fanotify_init(FAN_CLASS_NOTIF|FAN_REPORT_DFID_NAME) rc=3
fanotify_mark(FAN_MARK_FILESYSTEM, ...)              rc=0   ← KABUL EDİLDİ
4/4 handle gerçek yola çözüldü, empty_handles=0
FAN_RENAME tek olayda OLD_DFID_NAME + NEW_DFID_NAME verdi
```

mocukie'nin 2020 raporu ZFS 2.3.2'de **geçerli değil**. Katman 2 teknik olarak uygulanabilir.

**Ama bu kararı değiştirmiyor.** Katman 2 opsiyonel kalır: uygulanabilir olması,
`CAP_SYS_ADMIN` + `CAP_DAC_READ_SEARCH` vermek için bir gerekçe değildir. Katman 1 SLA'yı
zaten sıfır yetkiyle karşılıyor.

### Superblock kapsamı — tahmin doğrulandı

Üst ve alt dataset **farklı fsid** taşıyor (`48269c99…` vs `01834c68…`, `st_dev` 57 vs 58) ve
alt dataset olayları üst mark'a **hiç görünmüyor** (4 olay üstte, 0 altta). Dataset başına
işaretleme kontrol döngüsü zorunlu; `zfs create` ile mark arasındaki yarış gerçek.

### Katman 1 tam doğrulandı

| İddia                                                        | Sonuç                                        |
| ------------------------------------------------------------ | -------------------------------------------- |
| Syslog kimliği `smbd_audit`                                  | ✅                                           |
| `%u\|%I\|%S` öneki                                           | ✅ `depsis_poc_dana\|127.0.0.1\|p0dshare\|…` |
| `create_file`, `close`, `renameat`, `unlinkat` denetleniyor  | ✅                                           |
| **`close` dosya başına tam bir kez**                         | ✅ (dedup gerekmiyor)                        |
| **`renameat` tek satırda hem eski hem yeni ad**              | ✅                                           |
| Explorer atomik-kaydet deseni (`tmp.partial` → `final.txt`)  | ✅ `final.txt` için de `close` var           |
| SMB rename sonrası inode, generation ve handle **korunuyor** | ✅ ADR-0005 adım 2 çalışır                   |

**Taşıma notu:** olaylar ayrı bir rsyslog dosyasına değil **journald**'a düştü. Tüketici
tasarımı buna göre yapılacak (`journalctl -t smbd_audit -f` veya journal API), ayrı bir
rsyslog kuralı varsayılmayacak.

### ⚠ Düzeltme — `zfs snapshot` **delege edilebiliyor**

Bu ADR şöyle diyordu: _"snapshot adımı `mount` ister ve `mount` Linux'ta delege edilemez.
Bu yüzden snapshot+diff minimal bir root unit'te koşar."_

**Yanlış.** Ölçüm:

| Delege edilen                   | `zfs snapshot` sonucu |
| ------------------------------- | --------------------- |
| `diff,snapshot` (mount **yok**) | **BAŞARILI**          |
| `diff,snapshot,mount`           | BAŞARILI              |

Yani **Katman 3 tamamen yetkisiz çalışabilir**; root unit gerekmiyor. Bu bir güvenlik
iyileştirmesidir ve tasarım buna göre değişir: `zfs allow -u depsis diff,snapshot,destroy`
yeterli.

**Kabul edilen bedel:** delegasyonun yetkisiz kullanıcıya ulaşabilmesi `/dev/zfs`'in
`666 root:root` olmasına dayanıyor (OpenZFS'in udev kuralı). Yani her yerel kullanıcı ZFS
ioctl'i açabilir — yalnız delegasyon tablosuyla sınırlı olarak. Tehdit modeline kalıntı risk
olarak eklenmelidir; `/dev/zfs`'i 0660 + özel gruba almak delegasyonu da kırar.

### `zfs diff` R satırı üretiyor — ama testin doğru kurulması şartıyla

İlk koşu "R satırı yok" dedi. Testin hatasıydı: dosya base snapshot'tan **sonra** yaratılıp
yeniden adlandırılmıştı, dolayısıyla `+` doğru çıktıydı. Doğru kurulumda:

```
R	/srv/pd/ds/d/before.txt	/srv/pd/ds/d/after.txt
```

Katman 3'ün rename'i mutabık kılma yeteneği **doğrulandı**.

### ⚠ `zfs diff` performansı — 15 dakikalık aralık için endişe verici

| Delta                | Süre                  |
| -------------------- | --------------------- |
| Küçük (birkaç dosya) | **41 ms**             |
| ~20.000 nesne        | **21.332 ms (21 sn)** |

Bunlar **sıcak ARC** rakamları; `drop_caches` ARC'ı boşaltmıyor, yani gerçek soğuk maliyet
daha yüksek. 20 bin nesnede 21 saniye, 1 milyon dosyalık bir dataset'te 15 dakikalık aralığın
içine sığmayabilir. ADR'nin "diff süresi ölçülür; aralığa yaklaşırsa alarm" kuralı bu yüzden
**opsiyonel değil**. Ölçek testi Faz 4'ün performans süitine kalıyor.

## SLA matematiği

Katman 1, SMB kaynaklı create'leri saniyenin çok altında teslim eder (syslog yazımı `smbd` içinde
eşzamanlı, tüketici bir tail). §18.2'nin kabul kriterini **tek başına** karşılar. Katman 2–4 SLA
için değil, **sapmayı sınırlamak** için vardır. Varsayımı tersine çevirmenin güvenli olmasının
nedeni budur: sert gereksinim zaten hiçbir zaman fanotify'a bağlı değildi.

## Kanıt

| İddia                                                   | Kaynak                                                                                 | Güven                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `FAN_MARK_FILESYSTEM` `CAP_SYS_ADMIN` ister             | [fanotify_mark(2)](https://man7.org/linux/man-pages/man2/fanotify_mark.2.html)         | verified                                                                                     |
| `open_by_handle_at` `CAP_DAC_READ_SEARCH` ister         | [open_by_handle_at(2)](https://man7.org/linux/man-pages/man2/open_by_handle_at.2.html) | verified                                                                                     |
| ZFS tam `zpl_export_operations` tanımlıyor              | `module/os/linux/zfs/zpl_export.c`                                                     | verified                                                                                     |
| #6079'daki başarısızlık büyük ölçüde fatrace hatasıydı  | [openzfs/zfs#6079](https://github.com/openzfs/zfs/issues/6079)                         | verified                                                                                     |
| **FID modu ZFS 2.2+/2.3+'ta hiç yeniden test edilmedi** | [openzfs/zfs#6079](https://github.com/openzfs/zfs/issues/6079)                         | **unverified → P0-D**                                                                        |
| `full_audit:prefix` varsayılanı `%u                     | %I`                                                                                    | [vfs_full_audit(8)](https://www.samba.org/samba/docs/current/man-html/vfs_full_audit.8.html) | verified |
| `zfs diff` `R` satırlarında iki yol verir               | [zfs-diff(8)](https://openzfs.github.io/openzfs-docs/man/master/8/zfs-diff.8.html)     | verified                                                                                     |
| `zfs diff` performansı                                  | —                                                                                      | **unverified → P0-D**                                                                        |

## P0-D — bu ADR'yi doğrulayacak PoC

`tools/poc/fs-events.sh` sırasıyla:

1. **Belirleyici test:** `FAN_REPORT_DFID_NAME | FAN_MARK_FILESYSTEM` bir ZFS dataset'inde kabul
   ediliyor mu, ve dönen fid'ler doğru mu? `errno`'yu tam olarak yakala:
   `EOPNOTSUPP(95)` → `exportfs_can_encode_fid` ZFS'i reddetti · `ENODEV(19)` → sıfır fsid ·
   `EXDEV(18)` → tek superblock içinde çoklu fsid · `EPERM(1)` → yetki.
   **Mark başarılı olup handle'lar boş/çöp gelirse Katman 2 ÖLÜDÜR** → yalnız Katman 1+3.
2. Üst dataset'e konan mark alt dataset'te olay **görmüyor** mu? (beklenen: görmüyor) →
   işaretleme kontrol döngüsü zorunlu.
3. `open_by_handle_at` round-trip; `zpool export/import` ve reboot sonrası **fsid kararlı mı**?
   Değişiyorsa her `(fsid, handle)` satırı her restart'ta geçersizleşir → cache dataset GUID'ine
   anahtarlanmalı.
4. SMB üzerinden create/rename/delete: `full_audit` `close` dosya başına **tam bir kez** mi?
   Windows Explorer'ın atomik-kaydet deseni (`tmp.partial` → rename → `final.txt`) nasıl görünüyor?
5. Yığın yük (200k dosya) `FAN_Q_OVERFLOW` tetikliyor mu? → gerçek kuyruk payı ölçülür.
6. `zfs allow -u depsis diff,snapshot` sonrası yetkisiz `zfs diff` çalışıyor, `zfs snapshot`
   **başarısız** oluyor mu? (beklenen davranış) → Katman 3'ün root-only mu split mi olacağını belirler.
7. Soğuk önbellekte 1M dosyalık dataset'te `zfs diff` süresi < mutabakat aralığı mı?

## Sonuçlar

**Olumlu:** SLA'yı karşılayan yol **sıfır çekirdek yetkisi** ister. Ayrıcalıklı fanotify daemon'ı
opsiyonel bir katmana indirgendi ve tamamen atlanabilir. Kullanıcı adı ve istemci IP'si olay
kaynağından bedava geliyor — audit için değerli.

**Olumsuz / kabul edilen bedel:** syslog'a bağımlılık bir taşıma katmanı ekler (rsyslog kuralı,
log rotasyonu, geri basınç). `full_audit` SMB throughput'una ölçülmemiş bir maliyet bindirir →
P0-D bunu ölçer. Yol normalizasyonu ve rename eşleştirme parser karmaşıklığı getirir.

**Bu kararın yasakladığı şeyler:**

- inotify kullanılamaz.
- `full_audit:success` listesine `write`/`read`/`open`/`getattr` eklenemez.
- `CAP_SYS_ADMIN`/`CAP_DAC_READ_SEARCH` web uygulamasına veya worker'a verilemez; yalnız izole
  fanotify daemon'ına.
- `FAN_Q_OVERFLOW` sessizce yutulamaz.
- Tek bir `FAN_MARK_FILESYSTEM`'in tüm havuzu kapsadığı varsayılamaz.

## Geri alma maliyeti

Faz 0'da **düşük**. Faz 2'de fark edilseydi indexer, systemd unit'leri ve yetki modeli yeniden
yazılırdı; daha kötüsü, ayrıcalıklı bir daemon gereksiz yere üretime girmiş olurdu.

## Güvenlik ve veri kaybı etkisi

Bu ADR üretimden **iki tehlikeli yeteneği kaldırıyor**: `CAP_SYS_ADMIN` ve `CAP_DAC_READ_SEARCH`.
İkincisi özellikle ağır — DAC'ı baypas ederek her dosyayı okuyabilme demektir; ele geçirilmiş bir
indexer tüm kullanıcıların dosyalarını okuyabilirdi. Katman 1 bunu tamamen ortadan kaldırır.
Veri kaybı tarafında Katman 3 ve 4, indeksin gerçekle sapmasını sınırlar; sapma tespit edilirse
arama sonuçları eksik olabilir ama **yanlış yetki vermez** (yetki her zaman ADR-0004'teki POSIX
ACL'den okunur, indeksten değil).
