# ADR-0004: Yetki otoritesi ve SMB eşlemesi

- **Durum:** **Accepted** — P0-B koştu ve geçti 17/17 (2026-08-15), kanıt:
  [`evidence/p0-b.tsv`](evidence/p0-b.tsv). **Bir yarısı hâlâ kanıtlanmadı**, aşağıya bakınız.
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `packages/authz`, `apps/api/src/files`, `services/system-agent/src/ops/samba.rs`, `deploy/migrations`

## Bağlam

Master prompt §6.2 tek bir emir veriyor: **"Samba ACL ve DEPSIS ACL arasında iki ayrı gerçeklik
üretme."** Faz 0 kickoff belgesinde (B3) şu varsayımla yola çıkmıştık:

> ZFS `acltype=nfsv4` + `xattr=sa`, Samba `vfs objects = acl_xattr` → web UI ile SMB arasında
> tek tutarlı ACL gerçekliği.

Bu varsayımın yükü taşıyan yarısı **yanlış çıktı** ve yanlışlık **sessizce** başarısız oluyor.

## Bulunan gerçek

### 1. `acltype=nfsv4` Linux'ta ACL'leri tamamen kapatır

`zfsprops(7)` iki cümleyi yan yana söylüyor:

> "The nfsv4 ZFS ACL type is not yet supported on Linux."

> "When this property is set to a type of ACL not supported by the current platform, the behavior
> is the same as if it were set to `off`."

Zincirleme sonuç: Debian'da `acltype=nfsv4` ayarlamak, "saklanan ama uygulanmayan NFSv4 ACL"
vermez — **hiç ACL vermez.** POSIX ACL yeteneği de kaybedilir. Dataset düz mod bit'lerine
(owner/group/other) düşer ve `setfacl` tabanlı yetkilendirme çalışmayı bırakır.

Bu, tahmin edilen hata modundan **daha kötüdür**: "saklanır ama uygulanmaz" değil, "ACL alt
sistemi kapalı". Ve hiçbir hata mesajı vermez.

Ayrıca Linux'ta `acltype` varsayılanı **`off`**'tur. DEPSIS bunu açıkça ayarlamak zorundadır.

### 2. Bu yakın gelecekte değişmiyor

- OpenZFS PR #13186 (Linux için NFSv4 ACL) 2025-01-21'de kapatıldı, #16967 ile değiştirildi.
- PR #16967 **hâlâ açık**, son hareket Mart 2026, hiçbir OpenZFS sürümüne girmedi.
- Bakımcı tartışması: stok Linux çekirdeği bu ACL'leri out-of-tree yamalar olmadan uygulayamaz.
  TrueNAS SCALE bu yüzden kendi yamalı çekirdeğini taşıyor.
- Debian 13 trixie OpenZFS **2.3.2** taşıyor; bu çalışma içinde yok.

**DEPSIS bunun geleceğine bel bağlamayacak.**

### 3. `vfs_zfsacl` Linux'ta işe yaramaz

Modül gerçek ve Samba 4.23.0'da belgeli, ancak ZFS-on-Linux'un uygulamadığı bir filesystem NFSv4
ACL katmanına passthrough. Debian'da anlamsız.

### 4. `acl_xattr` doğru modül ama "tek gerçeklik" vermez

`vfs_acl_xattr` kendi belgesinde şöyle tanımlanıyor: standartlaştırılmış NFSv4 ACL'leri
desteklemeyen, yalnız kullanımdan kalkmış POSIX ACL taslağı olan sistemler için yapılmıştır.
Tam NT ACL'i (SID'ler, DENY ACE'ler, miras bayrakları) `security.NTACL` xattr'ında **opak bir
blob** olarak saklar. Linux çekirdeği bu blob'u ne ayrıştırır ne uygular. SMB dışı her şey için
ayrıca POSIX ACL katmanına **kayıplı bir "best effort" eşleme** yapar.

Bu tasarımı gereği **iki gerçekliktir**: yalnız `smbd`'nin okuduğu yüksek sadakatli NT ACL, ve
çekirdeğin (dolayısıyla DEPSIS web UI'ının) gerçekten uyguladığı düşük sadakatli POSIX ACL.

## Karar

### Dataset özellikleri

```
zfs create -o acltype=posixacl -o xattr=sa -o dnodesize=auto tank/depsis/<share>
```

| Özellik                 | Değer           | Gerekçe                                                                                                                                |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `acltype`               | **`posixacl`**  | Linux'ta çekirdeğin gerçekten uyguladığı tek ACL türü. `nfsv4` **YASAK** — sessizce `off`'a düşer                                      |
| `xattr`                 | `sa`            | Doğru; `smbd`'nin her lookup'ta yaptığı `security.NTACL` okumaları için belirgin biçimde hızlı. 64K/dosya sınırı var                   |
| `dnodesize`             | `auto`          | `xattr=sa` ile eşlenir, büyük SA blob'ları satır içi kalır                                                                             |
| `aclinherit`, `aclmode` | **kullanılmaz** | Bunlar NFSv4 ACL özellikleridir; Linux'ta POSIX ACL mirasını şekillendirmezler. Miras için POSIX default ACL (`setfacl -d`) kullanılır |

### Samba yapılandırması

```ini
[global]
    vfs objects = acl_xattr
    map acl inherit = yes
    store dos attributes = yes

[<share>]
    path = /tank/depsis/<share>
    read only = no
    inherit acls = yes
```

**`acl_xattr:ignore system acls = yes` KASITLI OLARAK KULLANILMIYOR.** Açılırsa alttaki dosyalar
0666/0777 olur ve `smbd` tek uygulama noktası hâline gelir. Aynı dosyaları SMB dışı bir süreç
(DEPSIS web UI) okuduğu için bu bir özellik değil, bir deliktir. Varsayılan `no` bırakmak,
Samba'nın NT ACL düzenlemelerini POSIX ACL'e **aşağı doğru yansıtmasını** sağlar — iki gerçeklik
arasındaki tek köprü budur.

**`acl_xattr:security_acl_name` ayarlanmaz** — xattr root-only `security.*` ad alanında kalır.

### Otorite modeli

|                                                     | Karar                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) DEPSIS POSIX ACL yazar**                      | **EVET — tek uygulanan substrat.** Çekirdeğin ZFS üzerinde gerçekten uyguladığı tek şey budur. Web UI dosya G/Ç'si, yerel kabuk, rsync, yedekleme işleri ve Samba dâhil her erişim yolunu tek biçimde bağlar                                                                                                                     |
| **(b) DEPSIS `security.NTACL`'i doğrudan yazar**    | **HAYIR.** Blob, SID'ler içeren NDR-marshalled bir Windows security descriptor'dır; düzeni bir Samba iç detayıdır, kararlı bir public yazma API'si veya CLI'ı yoktur, ve bozuk bir blob `smbd`'nin itaat edeceği şeydir. Gerçek bir NT ACL gerekirse **localhost üzerinden `smbcacls`** ile Samba'nın kendi araçlarından geçilir |
| **(c) DEPSIS uygulama katmanında da yetki uygular** | **EVET — üstüne katmanlanır.** POSIX'in ifade edemediği şeyler burada: nesne bazlı paylaşım, süreli bağlantı, politika                                                                                                                                                                                                           |

**Değişmez kural:** _uygulama yetkisi, dosya sistemi yetkisinin her zaman bir **alt kümesidir**,
asla üst kümesi değil._ Web katmanındaki bir hata, çekirdeğin uyguladığı izinleri aşamaz.

### Grant modeli

DEPSIS paylaşım-rolü başına **bir POSIX grubu**; kullanıcılar gruplara; ACL girdileri kullanıcıya
değil **gruba** verilir. POSIX ACL'ler ~30 girdiden sonra hantallaşır ve mask semantiği ısırır.

Miras default ACL ile:

```
setfacl -d -m g:depsis_<share>_rw:rwx /tank/depsis/<share>
```

### Duruş A — DEPSIS otoritedir (v1 için seçildi)

Windows tarafından ACL düzenlemesi **kapalıdır**: istemcilere `SeSecurityPrivilege` delege
edilmez, security descriptor set etmelerine izin verilmez. Tüm izin değişiklikleri DEPSIS UI →
POSIX ACL → Samba'nın türettiği NT ACL yolundan gider. Tek gerçeklik, daha düşük sadakat,
sürpriz yok.

Duruş B (belirli paylaşımlarda Windows otoritedir, DEPSIS UI onları `smbcacls --sddl` ile
**salt-okunur** gösterir) Faz 2'de değerlendirilebilir. **İki tarafın da yazdığı bir mod asla
gönderilmeyecek** — kaçınmaya çalıştığımız yeniden yazım tam olarak odur.

## Ölçüldü — P0-B (2026-08-15, Samba 4.22.10 / OpenZFS 2.3.2 / Debian 13)

### Çekirdek iddia doğrulandı — ve yazdığımdan daha kötü

Bu ADR "`acltype=nfsv4` sessizce `off`'a düşer" diyordu. Gerçek daha sinsi:

```
requested acltype=nfsv4 → zfs set rc=0, zfs get acltype → 'nfsv4'
setfacl → BAŞARISIZ
```

`zfs set` **başarılı oluyor** ve `zfs get` **`nfsv4` raporluyor**. Özellik `off`'a düşmüyor
bile; yapılandırılmış görünüyor. Yani bir operatör — ya da bir doğrulama kontrolü —
`zfs get acltype` okuyup "posixacl değil ama bir ACL türü var" diye geçebilir. **Hiçbir sinyal
yok.** Doğrulama bu yüzden `nfsv4`'ü **açıkça reddetmek** zorundadır; "boş değilse tamam"
mantığı bu tuzağa düşer.

### Uygulama ve eşleme kanıtlandı

| İddia                                                                              | Sonuç                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `acltype=posixacl` ile `setfacl` çalışıyor                                         | ✅                                                 |
| ACL'i **çekirdek uyguluyor** — yetkili kullanıcı okuyor, yetkisiz **reddediliyor** | ✅                                                 |
| `setfacl -d` mirası yeni dosya ve dizinlere geçiyor                                | ✅                                                 |
| **DEPSIS'in verdiği POSIX ACL, SMB security descriptor'ında görünüyor**            | ✅ `ACL:DEPSIS-POC\depsis_poc_alice:ALLOWED/0x0/R` |
| `veto files = /.depsis/` gerçekten **engelliyor**, yalnız gizlemiyor               | ✅                                                 |

### Kanıtlanmayan yarı — dürüstlük notu

**SMB → POSIX aşağı yönlü eşleme hâlâ kanıtlanmadı.** `smbcacls` ile SMB üzerinden ACL
_yazma_ denemesi başarısız oldu, dolayısıyla `ignore system acls = no`'nun gerçekten iki
gerçekliği köprülediği gösterilemedi.

Bu, seçilen **Duruş A** ile çelişmiyor — orada Windows tarafından ACL düzenlemesi zaten
kapalı. Hatta yazma denemesinin reddedilmesi Duruş A'nın istediği davranıştır. Ama ADR
"aşağı eşleme tek köprüdür" diye yazdığı için, o cümle şu an **ölçülmemiş bir iddiadır**.

Faz 2'de Duruş B (Windows otorite) değerlendirilirse bu boşluk **önce kapatılmalıdır**.
Duruş A'da kaldığımız sürece bloke edici değil.

## Ölçüldü — P0-A (2026-08-15, OpenZFS 2.3.2 / Debian 13)

### 1. `xattr=sa` geri okunduğunda `on` görünüyor

| Yazılan            | `zfs get` çıktısı                          |
| ------------------ | ------------------------------------------ |
| `acltype=posixacl` | `posix` — belgelenmiş alias                |
| `xattr=sa`         | **`on`** — belgelenmiş bir alias **değil** |

Ayarın sessizce düşüp düşmediğini okumayla anlamak mümkün olmadığı için **davranışsal**
ölçüldü: beş dosya, her birinde bir user xattr.

| Ayar        | `userobjused@root` |
| ----------- | ------------------ |
| `xattr=dir` | **16**             |
| `xattr=sa`  | **6**              |

`zfsprops(7)`'nin tarif ettiği "dosya başına ek nesne" farkı bu. Yani `sa` gerçekten yürürlükte;
yalnız raporlanan dize farklı.

**Sonuç — bu ADR'nin doğrulama kuralını değiştiriyor.** ADR, aracının dataset oluştururken
`acltype`/`xattr` doğrulamasını şart koşuyordu. `xattr == "sa"` diye karşılaştıran bir kontrol
**doğru yapılandırılmış bir dataset'i reddeder**. Doğru kontrol:

- `acltype` ∈ {`posixacl`, `posix`} kabul, diğer her şey **ret**
- `xattr` ∈ {`sa`, `on`} kabul, `dir` ve `off` **ret**

### 2. Düz `zfs send | zfs receive` `acltype`'ı taşımıyor — replika ACL'siz geliyor

P0-A'da ölçüldü: kaynak dataset `acltype=posix` iken, düz `zfs send | zfs receive` ile üretilen
replikada **`acltype=off`**.

Bu, bu ADR'nin baştaki bulgusunun yedekleme katmanındaki tekrarıdır: `acltype=off` bir dataset
**hiç ACL uygulamaz**, ve bunu hiçbir yerde söylemez. Yani bir replikadan geri yükleme,
kullanıcı dosyalarını erişim kontrolü olmadan geri getirir.

**Kural:** DEPSIS'in replikasyonu **`zfs send -p`** (veya `-R`) kullanmak zorundadır; düz
`send` yasaktır. Ayrıca geri yükleme işi, hedef dataset'i kullanıma açmadan önce §1'deki
doğrulamayı **tekrar** çalıştırmalıdır — replikasyon yolunun özelliği taşıdığına güvenilmez,
ölçülür.

Bu, Faz 2'nin yedekleme/replikasyon tasarımını bağlar ve oraya taşınacaktır.

## S5 kararıyla ilişki — allow-only artık bir tercih değil, zorunluluk

Faz 0 kickoff'ta açık `deny`'yi Faz 1'den çıkarmıştık; gerekçe "SMB eşlemesindeki hata kaynağını
kapatmak" idi. Araştırma bunu daha güçlü bir zemine oturtuyor: **POSIX ACL'lerde deny ACE diye
bir şey yoktur.** Uygulanan substrat deny'yi ifade edemiyor. Yani allow-only bir sadeleştirme
değil, substratın dayattığı bir kısıttır. Faz 2'de deny istenirse bu ADR'nin tamamı yeniden
açılmalıdır.

## Kanıt

| İddia                                                                           | Kaynak                                                                                             | Güven                                              |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| "The nfsv4 ZFS ACL type is not yet supported on Linux."                         | [zfsprops(7), Debian trixie](https://manpages.debian.org/trixie/zfsutils-linux/zfsprops.7.en.html) | verified                                           |
| Desteklenmeyen ACL türü = `off` davranışı                                       | [zfsprops(7), OpenZFS master](https://openzfs.github.io/openzfs-docs/man/master/7/zfsprops.7.html) | verified                                           |
| Linux'ta `acltype` varsayılanı `off`                                            | [zfsprops(7), Debian trixie](https://manpages.debian.org/trixie/zfsutils-linux/zfsprops.7.en.html) | verified                                           |
| PR #13186 kapatıldı, #16967 ile değiştirildi                                    | [openzfs/zfs#13186](https://github.com/openzfs/zfs/pull/13186)                                     | verified                                           |
| PR #16967 hâlâ açık, hiçbir sürümde yok                                         | [openzfs/zfs#16967](https://github.com/openzfs/zfs/pull/16967)                                     | verified                                           |
| Debian trixie `zfsutils-linux` = 2.3.2-2                                        | [manpages.debian.org](https://manpages.debian.org/trixie/zfsutils-linux/zfsprops.7.en.html)        | verified                                           |
| `acl_xattr` "POSIX ACL taslağı olan sistemler için", POSIX'e best-effort eşleme | [vfs_acl_xattr(8)](https://www.samba.org/samba/docs/current/man-html/vfs_acl_xattr.8.html)         | verified                                           |
| `vfs_zfsacl` var ama NFSv4 ACL katmanına passthrough                            | [vfs_zfsacl(8)](https://www.samba.org/samba/docs/current/man-html/vfs_zfsacl.8.html)               | verified                                           |
| Debian trixie Samba sürüm dizesi                                                | —                                                                                                  | **unverified** → VM'de `dpkg -l samba` ile doğrula |

## P0-B — bu ADR'yi doğrulayacak PoC

`tools/poc/samba-acl.sh` şunları kanıtlamalıdır:

1. `zfs set acltype=nfsv4` sonrası `getfacl`/`setfacl` **başarısız olur** (bu ADR'nin temel iddiası —
   sessiz bozulmayı gözle görmek gerekir).
2. `acltype=posixacl` + `xattr=sa` ile `setfacl` çalışır ve izin çekirdek tarafından uygulanır
   (yetkisiz kullanıcı `cat` ile okuyamaz).
3. DEPSIS'in verdiği POSIX ACL, `smbcacls` çıktısında karşılık bulur.
4. Windows istemci aynı sonucu yaşar.
5. `setfacl -d` ile miras yeni dosyalara uygulanır.
6. `ignore system acls = no` iken Samba'dan yapılan bir NT ACL değişikliği POSIX ACL'e yansır.

**P0-B geçmeden Faz 1'in yetki katmanı yazılmaz.**

## Sonuçlar

**Olumlu:** Tek uygulanan substrat; her erişim yolu (web, SMB, rsync, yedek) aynı çekirdek
kontrolünden geçer. Uygulama katmanı hatası dosya sistemi iznini aşamaz.

**Olumsuz / kabul edilen bedel:** POSIX ACL'in sadakat sınırları kabul ediliyor — DENY ACE yok,
ACE bazlı miras bayrağı yok, SID granülerliği yok. ~30 girdi sonrası mask semantiği sorun çıkarır,
bu yüzden grup zorunlu. Windows tarafından ACL düzenleme kapatılıyor; bu bazı yöneticiler için
alışkanlık kaybıdır ve UI'da açıkça anlatılmalıdır.

**Bu kararın yasakladığı şeyler:**

- `acltype=nfsv4` **hiçbir yerde** kullanılamaz. CI'da bir kontrol bunu engellemelidir.
- `acl_xattr:ignore system acls = yes` kullanılamaz.
- DEPSIS `security.NTACL` xattr'ına doğrudan yazamaz.
- Hem Windows'un hem DEPSIS'in izin yazdığı bir mod gönderilemez.
- ACL girdileri tek tek kullanıcılara verilemez; grup üzerinden gidilir.

## Geri alma maliyeti

Faz 0'da fark edildiği için **düşük** — henüz yetki kodu yazılmadı. Faz 1'de fark edilseydi
`packages/authz`, migration'lar ve Samba op'ları yeniden yazılırdı. Faz 2'de fark edilseydi
üretimdeki izinler sessizce yanlış olurdu ve veri sızıntısı anlamına gelirdi.

## Güvenlik ve veri kaybı etkisi

Bu ADR bir **sessiz yetki açığını** kapatıyor. `acltype=nfsv4` ile kurulmuş bir sistem, hiç ACL
uygulamadan çalışır ve bunu hiçbir yerde bildirmez — yani her kullanıcı mod bit'lerinin izin
verdiği her şeye erişir. Kurulum sihirbazı ve sistem aracısı, bir dataset'in `acltype` değerini
**oluşturma anında doğrulamalı** ve `posixacl` değilse dataset'i kullanıma açmamalıdır. Bu kontrol
`tools/poc/samba-acl.sh` ve entegrasyon testine girer.
