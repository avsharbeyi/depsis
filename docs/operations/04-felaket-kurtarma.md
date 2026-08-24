# DEPSIS — Felaket Kurtarma

Bir şey gitti ve geri getirmeniz gerekiyor. Bu belge sırayı verir; neyin yedeklendiği
[Yedekleme](03-yedekleme.md)'de.

> **Önce durun ve okuyun.** Bu belgedeki en pahalı hata, kısmi bir kurtarmayı tam sanmaktır — ve
> onu fark etmenin yolu §6'daki kontrol listesi.

---

## 1. Ne kaybettiğinizi belirleyin

| Belirti                                   | Muhtemelen       | Nereye                          |
| ----------------------------------------- | ---------------- | ------------------------------- |
| Cihaz açılıyor, arayüz yok                | Yalnız servisler | [§2](#2-yalnız-servisler-gitti) |
| Arayüz var, "veritabanına bağlanılamıyor" | PostgreSQL       | [§3](#3-veritabanı-gitti)       |
| Her şey var, dosyalar yok                 | ZFS havuzu       | [§4](#4-havuz-gitti)            |
| Kutu yok                                  | Hepsi            | [§5](#5-cihaz-gitti)            |
| Arayüz var, kimse SMB'ye giremiyor        | Kimlik senkronu  | [§4.3](#43-samba-kimlikleri)    |

---

## 2. Yalnız servisler gitti

Veri yerinde, süreçler koşmuyor.

```bash
systemctl status depsis-agent depsis-api depsis-worker
journalctl -u depsis-api -n 100 --no-pager
```

Sık sebepler ve ne yapılacağı:

**Ajan başlamıyor, "openat2 unavailable".** Çekirdek 5.6'dan eski ya da bir seccomp filtresi
engelliyor. `depsis-agent.service` içinde `RestrictSUIDSGID=yes` **olmamalı** — o direktif tam
olarak bunu yapar, ve unit dosyası neden orada olmadığını uzun uzun anlatıyor. Birim dosyasını
yedekten geri koyun.

**Ajan başlamıyor, "DEPSIS_API_UID".** `/etc/depsis/agent.env` yok ya da uid 0 diyor. Ajan ikisini
de reddediyor, ve haklı.

**Ajan başlamıyor, tek soket.** İkisi de gerekli:

```bash
systemctl start depsis-agent.socket depsis-agent-data.socket
```

**API başlıyor ama "şema sürümü uyuşmuyor" diyor.** Ajan ile API farklı sürümlerden. İkisi kilitli
adım ilerler. Aynı sürüme getirin — hangisinin eski olduğu mesajda yazıyor.

**API başlamıyor, credential okunamıyor.** `/etc/depsis/db-url` ve `/etc/depsis/secret.key` var mı,
root'a mı ait, `0400` mü? systemd onları servise kopyalıyor; kaynak dosyaların servisin
kullanıcısına açık olması gerekmez, var olmaları gerekir.

---

## 3. Veritabanı gitti

Dosyalar duruyor, üstveri yok.

### 3.1 Sıra

```bash
# 1. Servisleri durdurun. Yarı geri yüklenmiş bir şemaya yazmasınlar.
systemctl stop depsis-api depsis-worker

# 2. Roller (yeni bir kümeyse).
psql -X -v ON_ERROR_STOP=1 -d postgres -f /yedek/roller.sql

# 3. Boş veritabanı ve uzantılar.
psql -X -v ON_ERROR_STOP=1 -v db_name=depsis -f packages/db/bootstrap.sql

# 4. Döküm.
pg_restore --dbname="postgresql://depsis_owner:PAROLA@127.0.0.1:5432/depsis" \
           --no-owner --clean --if-exists --jobs=4 \
           /yedek/depsis-20260824T030000Z.dump

# 5. Servisler.
systemctl start depsis-api depsis-worker
```

### 3.2 Sürüm eşleşmesi

Geri yükledikten sonra **hemen** kaç göç uygulandığına bakın:

```bash
psql -X -At -d depsis -c 'SELECT count(*) FROM depsis_migrations'
ls packages/db/migrations/*.sql | wc -l
```

İki sayı **aynı olmalı**. Döküm eskiyse:

- **Dökümdeki az** → koddan eski. Göçleri owner olarak koşun, şema yetişir.
- **Dökümdeki fazla** → koddan yeni. Göç koşmayın. O sürümün kodunu kurun; şemayı geriye almak
  veri siler.

### 3.3 Geri yükledikten sonra ne bozuk olur

Kurtarma bittiğinde bu üçü **beklenen** durumdur, arıza değil:

- **Herkes yeniden giriş yapar.** Oturumlar dökümde ya yoktur ya eskidir.
- **Yayımlanmış paylaşım listesi boş.** DEPSIS smbd'ye ne sunduğunu soramaz, o yüzden bilmediğini
  iddia etmiyor. **Paylaşımlar → Yayımla**.
- **İzinler diskte eski olabilir.** Aşağıda.

### 3.4 İzinleri diske yeniden yazdırın

`folder_grants` geri geldi; POSIX ACL'ler diskte **eski** olabilir — dökümden sonra değişmiş
olanlar. Her paylaşımın izin panelini açıp kaydetmek `permissions.apply` işini kuyruğa alır.

**Sistem işleri** panosundan takip edin. Ölü bir `permissions.apply`, veritabanında geçerli olan
ama diske hiç yazılmamış bir izin demek: web'de kapalı görünen klasör SMB'den açık kalmış olabilir.

---

## 4. Havuz gitti

Üstveri duruyor, dosyalar yok.

### 4.1 Dataset'leri geri alın

```bash
zpool import tank            # havuz sağlamsa
# ya da yedek havuzdan:
zfs send -R yedekhavuz/depsis@SNAP | zfs recv -F tank/depsis
```

Mountpoint'lerin `DEPSIS_SHARES_ROOT` altında olduğunu doğrulayın (`/srv/depsis` varsayılan).
Dataset var ama yanlış yerde mount'luysa Samba boş dizin sunar ve **hiçbir yerde hata çıkmaz**.

```bash
zfs list -o name,mountpoint -t filesystem | grep depsis
```

### 4.2 Üstveriyi diske uydurun

Şimdi veritabanı, diskte olmayan dosyaları adlandırıyor olabilir — ya da tersi. İndeksleme işi
bunu düzeltiyor ve **hiçbir bayt silmiyor**: diskte olmayan bir satır veritabanından kalkar, çünkü
dosya zaten yok.

İş paylaşım başına on beş dakikada bir kendiliğinden koşuyor. Beklemek istemiyorsanız API'yi
yeniden başlatın — açılışta her paylaşım için bir pas tohumlanıyor:

```bash
systemctl restart depsis-api
journalctl -u depsis-worker -f    # "N discovered, M removed" satırlarını izleyin
```

> Beş binden fazla girdisi olan bir klasörün listelemesi kırpılır ve o klasörün altında hiçbir şey
> silinmez — yarım bir dizini uzlaştırıp kalan satırları silmek, indeksi yok ederdi. Böyle bir
> durumda worker günlüğü uyarı yazar. Klasörü küçültene kadar orası eksik indekslenir.

### 4.3 Samba kimlikleri

Yeni bir kutuda `tdbsam` boştur: kimse SMB'ye giremez. Yedeklemeye gerek yoktu, çünkü DEPSIS onu
yeniden kurar — NT hash'ler PostgreSQL'de mühürlü.

`identity.sync` işi hesapları, grupları ve parolaları basar. Bir kullanıcı ekleyip çıkarmak ya da
bir ekip üyeliği değiştirmek onu tetikler; **Sistem işleri** panosundan tamamlandığını doğrulayın.

Sonra doğrulayın:

```bash
pdbedit -L                                   # hesaplar var mı
smbclient -L localhost -U KULLANICI          # bağlanabiliyor mu
```

Hâlâ giremeyen bir kullanıcı varsa: parolası bu özellik geldiğinden beri hiç değişmemiştir, yani
NT hash'i yok. **Hesabım**'dan bir kez parola değiştirmesi yeter — aynısını yazsa bile.

---

## 5. Cihaz gitti

Sıfırdan. Sıra **bu**:

1. **İşletim sistemi ve bağımlılıklar.** Debian 13, PostgreSQL 18+, ZFS 2.2+, Samba 4.22+,
   Node 24+, çekirdek 5.6+.
2. **DEPSIS'i kurun** — [Yönetici Kılavuzu §2](01-yonetici-kilavuzu.md#2-kurulum), ama
   **sahiplenme adımını atlayın.** İlk yöneticiyi yaratmayın; o veritabanından gelecek.
3. **Mühür anahtarını geri koyun.** `/etc/depsis/secret.key`, root, `0400`. **Bu adımı atlarsanız**
   geri yükleme "başarılı" görünür ve hiç kimsenin iki adımlı doğrulaması ya da SMB erişimi olmaz.
4. **Yapılandırmayı geri koyun.** `/etc/depsis/*.env`, `smb.conf`, birim dosyaları.
5. **Veritabanını geri yükleyin** — [§3](#3-veritabanı-gitti).
6. **Dataset'leri geri alın** — [§4.1](#41-datasetleri-geri-alın).
7. **Servisleri başlatın.**
8. **Paylaşımları yayımlayın.** Yayım `testparm`'dan sonra gerçek bir bağlantı denemesi yapar;
   kanıtlanamayan bir yayım geri alınır.
9. **Kimlikleri senkronlayın** — [§4.3](#43-samba-kimlikleri).
10. **İzinleri yeniden uygulayın** — [§3.4](#34-i̇zinleri-diske-yeniden-yazdırın).
11. **§6'yı yürütün.**

Sahiplenme adımını yanlışlıkla yaptıysanız: `system_setup` tekil bir satır ve ikinci bir talep
reddedilir, yani veritabanını geri yüklemeden önce o satırı silmeniz gerekir. Boş bir veritabanına
geri yüklüyorsanız (§3.1 sırası) sorun çıkmaz.

---

## 6. Kurtarma tamam mı — kontrol listesi

Her maddeyi **yaparak** doğrulayın. Ekranın açılması bir şeyin çalıştığını göstermez.

- [ ] Bir yönetici hesabıyla web'e girilebiliyor.
- [ ] İki adımlı doğrulaması olan bir hesap **doğrulayıcı koduyla** girebiliyor.
      _(Bu, mühür anahtarının doğru olduğunu kanıtlayan tek testtir.)_
- [ ] Dosya yöneticisi bir paylaşımın içeriğini gösteriyor.
- [ ] Bir dosya **indirilebiliyor** — bayt akıyor, yalnız satır görünmüyor.
- [ ] Bir dosya **yüklenebiliyor**.
- [ ] `\\SUNUCU\paylaşım` Windows'tan açılıyor, DEPSIS parolasıyla.
- [ ] Bir üyenin **erişemediği** bir klasör SMB'den de kapalı.
      _(İzinlerin gerçekten diske yazıldığını kanıtlayan tek test.)_
- [ ] **Sistem işleri** panosunda `dead` iş yok.
- [ ] `journalctl -u depsis-worker` son on beş dakikada bir indeksleme pası göstermiş.
- [ ] Çöp kutusu politikası beklediğiniz değerde (**yedekten yanlış bir değer gelmiş olabilir ve
      geri yüklemeden sonraki ilk saat içinde silmeye başlar**).

Son madde ciddi: geri yüklediğiniz veritabanı `trash_retention_days = 7` taşıyorsa ve çöpte eski
şeyler varsa, ilk temizleme kurtarmadan bir saat sonra çalışır. Emin değilseniz **önce kapatın**
(Çöp kutusu → Saklama süresi → Süresiz sakla), sonra bakın.

---

## 7. Bu üründe **olmayan** kurtarma yetenekleri

Dürüstlük, bir DR planının en kullanışlı kısmı:

- **PITR yok.** Son dökümden sonrası kayıp. Faz 4.
- **Otomatik restore testi yok.** Yedeğinizin çalıştığını yalnız elle deneyerek bilirsiniz
  ([Yedekleme §8](03-yedekleme.md#8-yedeğinizi-test-edin)).
- **Update/rollback prosedürü yok.** Bozuk bir sürümden dönüş, eski ikilileri geri koymak ve
  şemanın uyduğunu doğrulamak demek.
- **HA yok.** Tek kutu. Kurtarma süresi, birinin bu belgeyi izleme süresidir.
- **Off-site replikasyon ürünün içinde değil.** `zfs send` sizin kurduğunuz bir şey.
- **Dosya sürümleri yok.** Üzerine yazılmış bir dosyanın eski hâli, yalnız bir ZFS anlık
  görüntüsünde varsa vardır.
