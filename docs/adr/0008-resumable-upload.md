# ADR-0008: Devam ettirilebilir yükleme, atomik yayınlama ve kota modeli

- **Durum:** **Accepted** — P0-G koştu (2026-08-15), kanıt: [`evidence/p0-g.tsv`](evidence/p0-g.tsv).
  Bir iddia düzeltildi; bkz. "Ölçüldü — P0-G".
- **Tarih:** 2026-08-14
- **Faz:** 0 (karar), 1–2 (uygulama)
- **Etkilenen bileşenler:** `apps/api/src/uploads`, `apps/api/src/download`, `services/system-agent`, dataset düzeni, Samba share şablonu

## Bağlam

Master prompt §5.4: yükleme staging dataset'inde başlar, antivirüs/policy kontrolünden sonra
**atomik publish**. §18.2: 10 GB'lık bir yükleme ağ kesintisinden sonra son doğrulanmış parçadan
devam eder.

Faz 0 kickoff'taki varsayım:

> Yükleme ayrı bir staging ZFS dataset'ine iner, taranır, sonra hedef dataset'e `rename` ile
> atomik olarak yayınlanır.

**Bu varsayımın depolama düzeni kısmı yanlış.**

## Bulunan gerçek

### 1. Dataset'ler arası `rename()` EXDEV verir — ve sessizce kopyalamaz

`rename(2)` man sayfası, EXDEV maddesi, birebir:

> "oldpath and newpath are not on the same mounted filesystem. (Linux permits a filesystem to be
> mounted at multiple points, but rename() does not work across different mount points, even if
> the same filesystem is mounted on both.)"

Parantez içi belirleyici: çekirdeğin kontrolü **mount point / superblock kimliği**, cihaz kimliği
değil. Aynı dosya sistemi iki yere mount edilmişse bile başarısız olur. Yani "aynı havuz içinde"
olmak DEPSIS'e **hiçbir şey kazandırmıyor**.

Her ZFS dataset'i kendi superblock'una sahip ayrı bir mounted filesystem'dır. OpenZFS tartışma
#15447 sonucu doğrudan doğruluyor: _"The 'mv' command between different datasets behaves like
'cp'. That's the reason why it is slow."_

Kritik ayrıntı: `rename(2)` **kopyalamaz**, `EXDEV` döndürür. Kopyalama davranışı coreutils `mv`'nin
userspace fallback'idir. NestJS'te çıplak bir `fs.rename()` çağrısı **doğrudan fırlatır** ve
yayınlama tamamen başarısız olur.

### 2. Kaçış yolu da yok — reflink dataset'ler arasında çalışmıyor

ZFS 2.2'de gelen block cloning (reflink) dataset sınırını geçmiyor. Aynı havuzdaki iki dataset
arasında `cp --reflink=always` _"Invalid cross-device link"_ veriyor; `--reflink=auto` sessizce tam
kopyaya düşüyor (openzfs #15345, #18005; ZFS 2.2 ve 2.3'te raporlanmış).

**Ayrı staging dataset'inden sıfır-kopya yayınlama yolu yok** — ne rename ile, ne reflink ile.

### 3. Sonuç, açıkça

Ayrı bir staging dataset'iyle her 10 GB'lık yayınlama 10 GB okuma + 10 GB yazmaya dönüşür:
havuz yazma amplifikasyonu iki katına çıkar, yayınlama süresi iki katına çıkar, ve — en kötüsü —
yayınlama **atomik olmaktan çıkar**: yarı kopyalanmış dosya gözlemlenebilir hâle gelir ve kopyalama
ortasında bir çökme çöp bırakır.

### 4. `RENAME_NOREPLACE` güvenilir değil

OpenZFS'in renameat2 bayrak çalışması (PR #12209) WIP'te kaldı; `rename_exchange` ve
`rename_whiteout` pool feature flag'leri güncel OpenZFS master `zpool-features(7)`'de **yok**.
`rename(2)`, dosya sistemi bayrağı desteklemiyorsa fallback yapmayıp `EINVAL` döndürür.

## Karar

### Depolama düzeni — yük taşıyan değişiklik

**Ayrı staging dataset'i kaldırıldı.** Staging her hedef dataset'in **içinde** yaşar:

```
pool/users/<uid>                        ← dataset, /srv/depsis/users/<uid>
  .depsis/staging/<upload-id>.part      ← AYNI dataset
  .depsis/quarantine/<upload-id>        ← tarama başarısızsa, AYNI dataset
  Documents/…                           ← kullanıcıya görünen ağaç
```

Yayınlama gerçek bir dataset içi `rename(2)` olur:

```c
renameat(dirfd_staging, "<id>.part", dirfd_dest, "final-name")
```

O(1), atomik, çökmeye tutarlı. 10 GB kopya yok, yazma amplifikasyonu yok.

### Dayanıklılık sırası (sistem aracısı sahiplenir, Node değil)

1. Parçaları `.depsis/staging/<id>.part`'a yaz
2. Dosya üzerinde `fsync(fd)`
3. Tarama + policy kontrolü (dosya hâlâ `.depsis/` içinde)
4. `rename(2)` ile yerine taşı
5. **Hedef DİZİN fd'si üzerinde `fsync`**

> Adım 5 atlanırsa, veri hayatta kalsa bile elektrik kesintisinde **rename kaybolabilir**.

### `.depsis` gizleme

- Samba: `veto files = /.depsis/` ve `delete veto files = no`. Yalnız `hide dot files`'a
  **güvenilmez** — veto erişimi gerçekten engeller, hide yalnız gizler.
- API listeleme `.depsis` önekini **sunucu tarafında** filtreler; istemciye güvenilmez.
- `.depsis` içeriği snapshot'lara girer ve yükleme sürerken kullanıcının `refquota`'sına sayılır.
  Bu doğrudur (kullanıcı staging'e park ederek kotayı aşamamalı) ama yükleme ortasında `EDQUOT`
  mümkündür → tus katmanı `ENOSPC`/`EDQUOT`'u temiz bir **507 Insufficient Storage**'a çevirmeli,
  500'e değil.

### Dataset'ler arası taşıma = iş, rename değil

Kullanıcı dosyayı iki paylaşım dataset'i arasında taşırsa bu **uzun süren bir job**'dır:
hedef dataset'in `.depsis/staging`'ine ilerleme raporlayarak kopyala → `fsync` → dataset içi
`rename` → kaynağı `unlink`. **Asla `fs.rename()` çağırıp umut edilmez.**

### `RENAME_NOREPLACE` yerine taşınabilir deyim

İlk açılışta runtime-probe edilir ve sonuç önbelleklenir. Her yerde çalışan fallback:

```c
linkat(AT_FDCWD, staged, destdirfd, name, 0)   /* link(2) EEXIST ile atomik başarısız olur */
unlink(staged)
```

### Protokol: tus 1.0.0 — IETF taslağı değil

IETF `draft-ietf-httpbis-resumable-upload` **-12**'de (2026-07-06), **RFC değil**, IESG durumu
"I-D Exists", sorumlu AD yok, telechat yok. Hareketli hedef ve istemci ekosistemi yok.

tus 1.0.0 (2016-03-25) hâlâ kararlı spec. Etkinleştirilecek uzantılar: `creation`,
`creation-with-upload`, `expiration`, `termination`, `checksum`. `concatenation` başlangıçta
**atlanır** (paralel parça birleştirme tek dosyalı staging ile çakışıyor). Terk edilmiş `.part`
dosyaları için `expiration` + systemd timer reaper.

Wire formatı bir arayüzün arkasına konur; taslak IESG Evaluation'a ulaşırsa yeniden değerlendirilir.

### `@tus/server` 2.4.4 + NestJS tuzakları

- Node **>= 20.19.0** gerektirir.
- tus route'unda **body parsing kapalı olmalı**: `NestFactory.create(AppModule, { bodyParser: false })`
  ve json/urlencoded yalnız tus dışı route'lara uygulanır. PATCH stream'ine dokunan herhangi bir
  body parser stream'i tüketir ve yükleme sessizce durur veya bozulur.
- 2.4.4 `srvx` (web-standard Request/Response) üzerine kurulu → `@Patch()` controller yerine ham
  Node middleware olarak mount edilir; Nest pipe/interceptor'ları body stream'ini görmemeli.
- Reverse proxy: `client_max_body_size 0;` ve `proxy_request_buffering off;`.

### Sağlama toplamları

| Katman                 | Algoritma                       | Gerekçe                                                                                                                                      |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Tarayıcı, parça başına | **SHA-256**                     | SubtleCrypto'da BLAKE3 **yok**; WASM göndermeye değmez. Web Worker'da 8–64 MiB dilimlerde, tus `Upload-Checksum: sha256 <base64>` başlığıyla |
| Sunucu, dosya bütünü   | BLAKE3 (yerel) **veya** SHA-256 | Aracı staged dosyayı bir kez akıtıp kanonik digest üretir                                                                                    |

Tarayıcıda **dosya bütünü digest denenmez** — SubtleCrypto tek atımlıdır ve 10 GB'ı belleğe alırdı.

> SHA-256 modern x86'da SHA-NI, ARMv8'de crypto extension ile donanım hızlandırmalı. Bu BLAKE3'ün
> farkını belirgin biçimde daraltır ve **ikinci hash'i gereksiz kılabilir**. Gerçek sayılar
> ölçülmedi → P0-G.

`xxHash`/CRC32 yalnız ucuz bozulma tespiti için; **asla** dedup kimliği veya güvenlik için değil.

### Idempotency

`Idempotency-Key` için **RFC yok**; `draft-ietf-httpapi-idempotency-key-header` durumu birebir
_"Expired & archived"_. Yalnız de-facto endüstri geleneği.

DEPSIS semantiği kendi API belgesinde **açıkça** tanımlanır: `(user, endpoint)` kapsamında,
PostgreSQL'de UNIQUE kısıtla, 24 saat saklama, tekrar eden anahtarda saklanan yanıt gövdesi+durumu
replay edilir, farklı istek parmak iziyle gelirse 409. **RFC'ye atıf yapılmaz.**

### İndirme

- Tek dosya: RFC 9110 §14 Range → `createReadStream(path, { start, end })` (Node'da `end`
  **dâhil**, `last-pos` ile eşleşir). 206 + `Content-Range` + `Accept-Ranges: bytes`.
  Karşılanamayan aralık → 416 + `Content-Range: bytes */<size>`. Güçlü ETag ile `If-Range`
  (inode + mtime-ns + size veya saklanan digest) — değişmiş dosyada bozuk splice yerine 200.
- Çoklu dosya ZIP: `archiver` 8.0.0. `yazl` 3.3.1 daha küçük ama registry metadata'sında zip64
  sinyali yok → >4 GiB için önce doğrulanmalı.
- **Kritik sonuç:** akıtılan bir ZIP geriye sarılıp local file header'ları yamanamaz, boyutlar data
  descriptor'a gider. Bu yüzden **ZIP indirmede Range/resume desteklenemez.** O uçta
  `Accept-Ranges` gönderilmez, `Content-Length` atlanır ve PWA'ya kopan indirmenin sıfırdan
  başlayacağı söylenir. Devam ettirilebilir çoklu indirme gerekirse ZIP önceden `.depsis` altına
  üretilip normal rangeable dosya olarak sunulur.

### Kota modeli

| Özellik          | Kullanım                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refquota`       | **Kullanıcının gördüğü limit.** Snapshot'ları **hariç** tutar → kullanıcı, kontrol edemediği yönetici snapshot politikası yüzünden asla bloke olmaz                 |
| `quota`          | `refquota × ~1.3–1.5`. Snapshot ve alt dataset'leri **dâhil** eder → snapshot birikiminin havuzu yemesini durdurur                                                  |
| `refreservation` | Yalnız kullanıcı başına taban garanti gerekiyorsa. **Varsayılan: yok** — snapshot oluşturmayı kısıtlar; neredeyse dolu havuzda snapshot'lar başarısız olmaya başlar |

UI'ya `zfs get -Hp -o value used,usedbysnapshots,available,refquota,quota` ile raporlanır —
`statvfs` ile **değil**; `statvfs` ZFS'te `refquota`'yı sürümler arasında tutarsız yansıtır.

> Ölçeklenme notu: kullanıcı başına dataset binlerce mount ve yavaş açılış demektir. Alternatif,
> paylaşılan bir dataset üzerinde `userquota@`/`userused@` — ama bu kullanıcı başına snapshot ve
> send/recv'i kaybettirir. Faz 1 kullanıcı başına dataset ile gider; ölçek sorunu ölçülürse
> yeniden değerlendirilir.

## Ölçüldü — P0-G (2026-08-15, ZFS 2.3.2 / kernel 6.12.101 / coreutils 9.7)

### Çekirdek iddia doğrulandı, üstelik daha güçlü biçimde

| Ölçüm                                                  | Sonuç                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Aynı havuzdaki iki dataset farklı `st_dev` bildiriyor  | ✅ 58 vs 59                                                 |
| Dataset'ler arası çıplak `rename(2)`                   | ✅ **EXDEV**                                                |
| **Aynı dataset'in bind mount'u üzerinden `rename(2)`** | ✅ **EXDEV** — `st_dev` aynı olmasına rağmen                |
| `mv` başarılı ama **inode değişiyor** (256 → 5)        | ✅ kopyaladı, taşımadı                                      |
| `cp --reflink=always` dataset'ler arası                | ✅ EXDEV                                                    |
| `cp --reflink=auto` dataset'ler arası                  | ✅ **sessizce tam kopya** (hedef 1.074.470.912 bayt büyüdü) |
| Dataset **içi** `cp --reflink=always`                  | ✅ çalışıyor (`block_cloning` etkin)                        |

Bind mount testi, ADR'nin dayandığı `rename(2)` cümlesini ampirik olarak kanıtlıyor: çekirdeğin
kontrolü **mount kimliği**, cihaz kimliği değil. Aynı dataset, aynı `st_dev`, farklı mount →
yine EXDEV.

### Dataset içi rename gerçekten O(1)

1024 MiB dosya: **rename 14 ms**, aynı boyutta tam kopya **570 ms**. Inode korunuyor, ölçülebilir
alan tüketilmiyor. Staging'i hedefin içine almanın kazancı tam olarak bu.

### ⚠ Düzeltme — `RENAME_NOREPLACE` ZFS'te **çalışıyor**

Bu ADR "güvenilir değil, `rename_exchange`/`rename_whiteout` feature flag'leri master'da yok"
diyip `linkat`+`unlink` yedeğini zorunlu kılıyordu. **Yanlış** — araştırma iki farklı şeyi
karıştırmış: `RENAME_EXCHANGE` ve `RENAME_WHITEOUT` pool feature flag'i ister,
`RENAME_NOREPLACE` istemez.

Ölçüm bayrağın **sessizce yok sayılmadığını** da gösteriyor, asıl önemli olan bu:

| Durum                            | Sonuç                              |
| -------------------------------- | ---------------------------------- |
| tmpfs kontrolü (probe sağlam mı) | ✅ çalışıyor, mevcut adda `EEXIST` |
| ZFS, hedef **yok**               | ✅ **OK**                          |
| ZFS, hedef **var**               | ✅ **`EEXIST`**                    |

Bayrak yok sayılsaydı ikinci satır başarılı olup üzerine yazardı. Yayınlama doğrudan
`renameat2(RENAME_NOREPLACE)` kullanabilir.

ADR'nin "runtime-probe et" kuralı **yine de geçerli** — bu bir sürüm ölçümüdür, evrensel garanti
değil. `linkat`+`unlink` yedek olarak kalır; P0-G onun da atomik `EEXIST` verdiğini doğruladı.

### Kota semantiği doğrulandı

`refquota` aşımı **`EDQUOT`** veriyor (tus katmanı 507'ye çevirmeli, 500'e değil). Altı
ADR-zorunlu özellik bayt tamsayısı olarak ayrıştırılıyor. Snapshot alanı `quota`'ya sayılıyor,
`refquota`'ya sayılmıyor; snapshot silinince kota boşluğu geri geliyor.

**`statvfs` ölçülerek elendi:** 33.292.288 bayt vaat etti, dataset gerçekte 33.423.360 bayt
kabul etti. "Kota UI'ı `statvfs`'ten beslenemez" kuralı artık ölçüme dayanıyor.

### Bu koşunun kanıtlamadığı

Dizin `fsync`'inin **güç kesintisi** dayanıklılığı. `fsync(dirfd)` ZFS tarafından kabul ediliyor
ve sıralama uçtan uca çalışıyor, ama gerçek kesinti testi kaos/kurtarma süitine ait. Script bunu
açıkça kapsam dışı ilan ediyor — "sıralama çalıştı" ile "dayanıklı" aynı şey değildir.

## Kanıt

| İddia                                                                  | Kaynak                                                                                         | Güven                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| EXDEV mount point kimliğine bakar, aynı fs iki mount'ta bile başarısız | [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html)                               | verified              |
| Dataset'ler arası `mv` = `cp`                                          | [openzfs#15447](https://github.com/openzfs/zfs/discussions/15447)                              | verified              |
| reflink dataset sınırını geçmiyor                                      | [openzfs#15345](https://github.com/openzfs/zfs/issues/15345)                                   | verified              |
| `rename_exchange`/`rename_whiteout` master'da yok                      | [zpool-features(7)](https://openzfs.github.io/openzfs-docs/man/master/7/zpool-features.7.html) | verified              |
| tus 1.0.0 kararlı spec                                                 | [tus.io](https://tus.io/protocols/resumable-upload)                                            | verified              |
| IETF resumable-upload = draft-12, RFC değil                            | [datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpbis-resumable-upload/)           | verified              |
| Idempotency-Key draft = "Expired & archived"                           | [datatracker](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)     | verified              |
| `@tus/server` 2.4.4, Node >= 20.19.0                                   | [npm](https://registry.npmjs.org/@tus/server/latest)                                           | verified              |
| `archiver` 8.0.0 / `zip-stream` 7.0.5 / `yazl` 3.3.1                   | npm registry                                                                                   | verified              |
| BLAKE3 vs SHA-256 gerçek throughput                                    | —                                                                                              | **unverified → P0-G** |
| `@tus/file-store` istek başına dinamik dizin alabiliyor mu             | —                                                                                              | **unverified → P0-G** |

## P0-G — bu ADR'yi doğrulayacak PoC

1. Dataset'ler arası `rename()` gerçekten `EXDEV` mi? (`pool/a` → `pool/b`, aynı havuz)
2. Dataset içi `rename()` 10 GB dosyada O(1) mi? (süre ölçülür)
3. `renameat2(RENAME_NOREPLACE)` ZFS'te `EINVAL` mi veriyor?
4. `linkat` + `unlink` fallback'i atomik no-clobber sağlıyor mu?
5. Dizin `fsync`'i atlanırsa güç kesintisi tatbikatında rename kayboluyor mu?
6. Samba `veto files = /.depsis/` Windows istemciden erişimi gerçekten engelliyor mu?
7. Hedef hâlâ tam doluyken `EDQUOT` 507'ye mi dönüşüyor?
8. BLAKE3 vs SHA-256 (SHA-NI ile) hedef donanımda ölçülür → ikinci hash gerekli mi?

## Sonuçlar

**Olumlu:** Yayınlama gerçekten atomik ve O(1). Yazma amplifikasyonu ortadan kalkıyor. Kota modeli
kullanıcıyı yönetici snapshot politikasından koruyor.

**Olumsuz / kabul edilen bedel:** Her dataset'te gizli bir `.depsis` ağacı var; Samba, API listeleme
ve yedekleme bunu bilmek zorunda. Dataset'ler arası taşıma birinci sınıf bir job'a dönüşüyor,
ucuz bir işlem değil. ZIP indirmede resume yok.

**Bu kararın yasakladığı şeyler:**

- Ayrı bir staging **dataset'i** oluşturulamaz.
- Dataset sınırını geçen çıplak `fs.rename()` çağrılamaz.
- `RENAME_NOREPLACE` probe edilmeden kullanılamaz.
- Yayınlamada dizin `fsync`'i atlanamaz.
- Tarayıcıda dosya bütünü SubtleCrypto digest denenmez.
- ZIP indirme ucunda `Accept-Ranges` gönderilemez.
- Kota UI'ı `statvfs`'ten beslenemez.
- Idempotency-Key bir RFC'ye atıfla belgelenemez.

## Geri alma maliyeti

Faz 0'da fark edildiği için **düşük**. Faz 2'de fark edilseydi dataset düzeni, Samba share
şablonları, yedekleme kapsamı ve upload yolu birlikte değişirdi — yani veri taşıma gerektiren
bir göç olurdu.

## Güvenlik ve veri kaybı etkisi

En büyük kazanç **veri kaybı** tarafında: dizin `fsync`'i ve gerçek atomik rename, elektrik
kesintisinde yarım dosyanın kullanıcıya görünmesini engeller (§17). Güvenlik tarafında `.depsis`
ağacı yeni bir yüzeydir — Samba veto ve sunucu tarafı filtreleme olmazsa kullanıcılar birbirinin
staging dosyalarını veya karantinaya alınmış zararlı içeriği görebilir. Karantina dizini
**asla** paylaşılabilir olmamalıdır.
