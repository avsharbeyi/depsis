# DEPSIS — Yedekleme

Bu belge neyi, neden ve nasıl yedekleyeceğinizi anlatır. Yedeği **kullanmak** ayrı bir belge:
[Felaket Kurtarma](04-felaket-kurtarma.md).

---

## 1. Dört ayrı şey, dört ayrı yöntem

DEPSIS'in durumu tek bir yerde değil. Dördünden birini kaçırırsanız yedeğiniz eksiktir, ve
eksikliğini ancak geri yüklerken öğrenirsiniz.

| Ne                      | Nerede                             | Nasıl                       |
| ----------------------- | ---------------------------------- | --------------------------- |
| **Kullanıcı dosyaları** | ZFS dataset'leri (`tank/depsis/*`) | `zfs snapshot` + `zfs send` |
| **Üstveri ve hesaplar** | PostgreSQL                         | Günlük `pg_dump` — otomatik |
| **Mühür anahtarı**      | `/etc/depsis/secret.key`           | Elle. Bir kez.              |
| **ZeroTier kimliği**    | `/var/lib/zerotier-one`            | Günlük `tar` — otomatik     |

Dördüncüsü bu belgede uzun süre YOKTU, ve eksikliği en pahalı olanıydı. `identity.secret`
kaybedilirse **geri gelmez**: bir ZeroTier ağ kimliğinin üst 40 biti, o ağı yöneten düğümün
adresinin ta kendisi. Kimlik değişince üyeler config isteğini artık bu makine olmayan bir adrese
göndermeye devam eder, `controller.d` içindeki kayıtlar diskte durur ama daemon'a hiç sorulmaz, ve
ağı yeniden yönlendirmenin bir yolu yoktur — ev, kendi NAS'ına uzaktan erişimini kalıcı olarak
kaybeder.

İkinci ve dördüncü satır artık Yedekleme panelinde günde bir kez kendiliğinden alınıyor ve on dört
tanesi saklanıyor. İkisi de `/var/lib/depsis/db-backups` altında, 0600 — bir paylaşımda **değil**,
çünkü ikisi de kimlik bilgisi taşıyor. **Cihazdan çıkarmak sizin adımınız:** o dizinin veri
kümesine bir yedekleme zamanlaması kurun. Cihazı terk etmeyen bir yedek, cihazı atlatmaz.

### ZeroTier durumunu geri yüklemenin SIRASI

`zerotier-one` `controller.d`'yi yalnızca **açılışta** okur — inotify yok, periyodik tarama yok.
Çalışan bir daemon'un altına dosya bırakmak hiçbir şey yapmaz, ve daha kötüsü bellekteki kopya bir
sonraki kayıtta bıraktıklarınızın üzerine yazar. Doğru sıra:

```bash
systemctl stop zerotier-one
tar -xf zerotier-<tarih>.tar -C /var/lib/zerotier-one
systemctl start zerotier-one
```

> **Eski bir arşivi geri yüklemek bir güvenlik olayıdır.** İstemci tarafı gelen yapılandırmanın
> sürümünü önbellektekiyle karşılaştırmaz, yani arşivden beri **yetkisini aldığınız** bir cihaz
> sessizce yetkisini geri kazanır. Geri yükledikten sonra üye listesini gözden geçirin.

Bunlara ek olarak **Samba parola veritabanı** (`tdbsam`) var; onu yedeklemeye gerek yok ve neden
gerekmediği aşağıda.

---

## 2. Mühür anahtarı — önce bu

`/etc/depsis/secret.key`, TOTP sırlarını ve SMB NT hash'lerini mühürleyen AES-256-GCM anahtarı
(ADR-0016).

**Bu anahtar olmadan veritabanı yedeği o iki şeyi geri getirmez.** Zarflar veritabanında duruyor
ama açılamaz: geri yüklenen sistemde kimsenin ikinci faktörü ve kimsenin SMB erişimi olmaz.

Anahtar **değişmez**. Bir kez üretilir, bir kez yedeklenir:

```bash
# Yazdırıp kasaya koyun, ya da parola yöneticinize.  32 bayt, base64.
cat /etc/depsis/secret.key
```

Onu veritabanı yedeğinin **yanına koymayın**. İkisi bir arada, tek bir çalıntı disk demektir; ayrı
tutuldukları sürece bir veritabanı yedeği tek başına kimseye SMB erişimi vermez — mühürlemenin
bütün amacı bu.

---

## 3. PostgreSQL

### 3.1 Hangi rolle — dikkat

**`depsis_backup` ile alınan bir dökümle sistemi geri yükleyemezsiniz.** Bu rol bilerek eksik:

| Okuyamadığı                            | Sonucu                                             |
| -------------------------------------- | -------------------------------------------------- |
| `user_totp_secrets`                    | Kimsenin iki adımlı doğrulaması geri gelmez        |
| `user_recovery_codes`                  | Kurtarma kodları geri gelmez                       |
| `users.password_hash`, `users.nt_hash` | Kimse giriş yapamaz, kimse SMB'ye giremez          |
| `sessions`, `pending_logins`           | Herkes yeniden giriş yapar (bu zararsız)           |
| `password_resets`                      | Açık sıfırlama biletleri kaybolur (bu da zararsız) |
| `license`                              | Lisans belgesi yeniden kurulmalı                   |

Bunların üstüne, bu role hiç SELECT verilmemiş yirmi dört tablo daha var ve dökümde **hiç yoklar**:
`notes`, `notifications`, görevlerin alt tabloları (yorum, alt görev, etiket, izleyici, etkinlik),
uygulama kataloğu, `job_queue`, `index_queue`, `login_attempts`, `idempotency_keys`,
`user_preferences` ve kurulum satırı.

`depsis_backup` **raporlama** rolüdür: kimlik bilgisi taşımayan bir kopya çıkarmak için. Kurtarma
için değil.

**Geri yüklenebilir bir döküm `depsis_owner` ile alınır.**

> Bu tablo 0061'e kadar yanlıştı, ve iki yönde birden. Bir: `users` üzerindeki tablo düzeyi
> `GRANT SELECT` duruyordu ve PostgreSQL'de kolon düzeyinde bir `REVOKE` onu daraltmıyor — yani
> `nt_hash` ve `password_hash` bu role AÇIKTI, kapalı sanıldıkları hâlde. İki: SELECT verilmiş
> yirmi tabloda bu rol için hiçbir satır seviyesi güvenlik politikası yoktu, yani `pg_dump`
> onları hatasız ama SIFIR SATIR olarak döküyordu. 0061 ilkini kolon listesine çevirdi, ikincisi
> için sırsız tablolara okuma politikası ekledi. Bir sürümü 0061 öncesinden alınmış "raporlama
> dökümü" varsa, içindeki `users` satırları parola özeti taşıyor: onu sır muamelesi görecek bir
> yerde tutun ya da silin.

### 3.2 Döküm

```bash
pg_dump \
  --dbname="postgresql://depsis_owner:PAROLA@127.0.0.1:5432/depsis" \
  --format=custom --compress=9 \
  --file="/yedek/depsis-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

`--format=custom`, çünkü geri yüklerken paralellik ve seçicilik istiyorsunuz — düz SQL bunu
vermiyor.

Rol **parolaları** dökümde yok (`pg_dump` küme nesnelerini almaz). Kaydedin:

```bash
pg_dumpall --globals-only --roles-only \
  --dbname="postgresql://postgres@127.0.0.1:5432/postgres" \
  > /yedek/roller.sql
```

### 3.3 Ne kadar sık

Üstveri, dosyaların kendisinden **daha hızlı** değişir: her izin değişikliği, her yükleme, her
yeniden adlandırma bir satır. Günde bir döküm makul bir taban; gündüz çalışan bir ofiste saatlik
de pahalı değil (döküm sıkıştırılmış birkaç yüz megabayttır).

`pg_dump` **tutarlı bir anlık görüntü** alır ve yazmaları engellemez. Servisi durdurmanız gerekmez.

> PITR (point-in-time recovery) bu üründe kurulu değil — Faz 4 kapsamında. Yani kurtarma
> çözünürlüğünüz son dökümünüz kadar.

---

## 4. Dosyalar — ZFS

### 4.1 Anlık görüntü

DEPSIS arayüzünden (**Yedekleme** ekranı) ya da elle:

```bash
zfs snapshot -r tank/depsis@$(date -u +%Y%m%dT%H%M%SZ)
```

Anlık görüntü bir **yedek değildir** — aynı havuzda duruyor. Havuz giderse o da gider. Yedek,
başka bir yere gönderilmiş olanıdır.

### 4.2 Başka bir diske / makineye

```bash
# İlk sefer: tam gönderim
zfs send -R tank/depsis@SNAP1 | zfs recv -F yedekhavuz/depsis

# Sonrası: yalnız aradaki fark
zfs send -RI tank/depsis@SNAP1 tank/depsis@SNAP2 | zfs recv yedekhavuz/depsis
```

Uzak bir makineye giderken `ssh` ile boruya sokun. Off-site replikasyon ürünün içinde **yok**
(Faz 2/4); bu, elle kurulacak bir şey.

### 4.3 `.depsis/staging` yedeklenmez

Her paylaşımın içinde `.depsis/staging` var: yarım kalmış yüklemeler. Ajanın süpürücüsü onları
zaten temizliyor. Yedeğe girmeleri zararsız ama gereksiz; `zfs send` dataset bazlı çalıştığı için
ayıklamak da kolay değil. Boyut sorun olursa, yedekten önce süpürücünün geçmesini bekleyin.

---

## 5. Samba parola veritabanı

`tdbsam` (`/var/lib/samba/private/passdb.tdb`) yedeklenmez, ve gerekmez: DEPSIS onu **kendi
yeniden kurar**. NT hash'ler PostgreSQL'de mühürlü duruyor ve `identity.sync` işi onları
`pdbedit` ile tdbsam'e basıyor.

Geri yüklemeden sonra kimse SMB'ye giremiyorsa, çözüm o işi çalıştırmak — tdbsam'i yedekten
çıkarmak değil. [Felaket Kurtarma](04-felaket-kurtarma.md) §4'te.

`/etc/samba/depsis.conf` de yedeklenmez: DEPSIS onu her yayımda baştan yazıyor. `smb.conf`
**operatörün** dosyası ve DEPSIS ona dokunmuyor — onu yedekleyin.

---

## 6. Yedeklenecek yapılandırma

Küçük ama kaybı can sıkıcı:

```
/etc/depsis/api.env
/etc/depsis/agent.env
/etc/depsis/db-url          # parola içerir — anahtar gibi davranın
/etc/depsis/secret.key      # §2
/etc/samba/smb.conf         # operatörün dosyası
/etc/systemd/system/depsis-*.service
/etc/systemd/system/depsis-*.socket
```

---

## 7. Bir araya getirince

Günlük bir betiğin iskeleti. Sizin ortamınıza uyarlanmalı — özellikle nereye gönderdiği.

```bash
#!/usr/bin/env bash
set -euo pipefail

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/yedek

# 1. Veritabanı — OWNER olarak. depsis_backup ile alınan döküm geri yüklenemez (§3.1).
pg_dump --dbname="$DEPSIS_OWNER_URL" --format=custom --compress=9 \
        --file="$DEST/depsis-$STAMP.dump"

# 2. Dosyalar. Anlık görüntü ÖNCE, ki döküm ile aralarındaki pencere küçük olsun.
zfs snapshot -r "tank/depsis@$STAMP"
zfs send -RI "tank/depsis@$PREV" "tank/depsis@$STAMP" | ssh yedek@baska-makine \
  'zfs recv yedekhavuz/depsis'

# 3. Yapılandırma.
tar czf "$DEST/config-$STAMP.tar.gz" /etc/depsis /etc/samba/smb.conf \
        /etc/systemd/system/depsis-*.{service,socket}

# 4. Eskiyi at.
find "$DEST" -name 'depsis-*.dump' -mtime +30 -delete
```

**Sıra önemli:** anlık görüntü dökümden önce alınırsa, dosyalar üstveriden biraz **eski** olur.
Ters sırada üstveri, var olmayan dosyaları adlandırır. İlki onarılabilir (indeksleme işi diskte
olmayan satırları temizler); ikincisi kullanıcıya açılmayan dosyalar gösterir.

---

## 8. Yedeğinizi test edin

Test edilmemiş bir yedek, yedek değil bir umuttur.

Ayda bir, yedek makinede:

1. Boş bir veritabanına geri yükleyin ([Felaket Kurtarma](04-felaket-kurtarma.md) §3).
2. `zfs recv` ile gelen dataset'in mount olduğunu ve içinde dosya olduğunu doğrulayın.
3. Kaç göç uygulanmış, sayın:

```bash
psql -X -At -d depsis_test -c 'SELECT count(*) FROM depsis_migrations'
```

Bu sayı, üretimdeki `packages/db/migrations/` dosya sayısıyla aynı olmalı. Değilse dökümünüz
başka bir sürümden ve geri yükleme **o sürümün** kodunu gerektirir.

> Otomatik restore testi ürünün içinde yok (Faz 4). Bu adımı elle yapmanız gerekiyor, ve
> yapmazsanız felaket anında öğrenirsiniz.

---

## 9. Ne yedeklemek yetmez

Dürüst olmak gerekirse, bu ürünün yedekleme hikâyesindeki boşluklar:

- **PITR yok.** Son dökümden sonraki her şey kayıp.
- **Otomatik doğrulama yok.** §8'i kimse hatırlatmıyor.
- **Off-site replikasyon ürünün içinde değil.** `zfs send` elle kurulur.
- **Anlık görüntü listesi havuzun envanteri değil.** DEPSIS yalnız kendi aldığı anlık görüntüleri
  gösterir ve yanıtta `complete: false` ile bunu söyler; elle alınmış bir snapshot arayüzde
  görünmez. Kaybolmaz — yalnız DEPSIS onu bilmez.
