# ADR-0018: Yönetici konsolu — ayrı bir servis, ajan değil

- **Durum:** Accepted
- **Tarih:** 2026-08-22
- **Faz:** 1
- **Etkilenen bileşenler:** `services/console` (yeni), `deploy/systemd`, `apps/api`, `apps/web`

## Bağlam

Cihazın sahibi arayüzde çalışan bir terminal istedi ve gereken kısıtı kendisi koydu: _"terminal
kısmını yalnızca admin accountunda erişilir kılman gerek."_

Bu istek §2.2 ile doğrudan çarpışıyor gibi görünüyor:

> Aracı hiçbir zaman serbest biçimli shell komutu kabul etmemeli.

ADR-0006 bu cümleyi ajanın bütün varlık sebebi hâline getirdi: kapalı, tiplenmiş bir işlem kümesi,
her biri kendi doğrulamasıyla. `RunCommand { line: String }` diye bir varyant eklemek o kümeyi
kapalı olmaktan çıkarır ve ADR-0006'nın geri kalanını dekoratif hâle getirir — çünkü serbest bir
komut, diğer bütün işlemleri de yapabilen bir işlemdir.

Ama §2.2 **ajanı** kısıtlıyor, DEPSIS'i değil. Bir konsol, ajana hiç dokunmadan yapılabilir; ve
yapılınca ortaya ajana eklemekten daha iyi bir tasarım çıkıyor.

## Karar

### Konsol kendi servisidir

`services/console`, kendi systemd birimi ve kendi Unix soketi olan ayrı bir süreç. Tek işi
sözde-terminal (pty) oturumları açmak ve baytları taşımak.

Ayrıcalıklı ajan bu işin hiçbir yerinde yok. `depsis-agent`'ın işlem kümesi kapalı kalır, §2.2
harfiyen geçerlidir, ve ADR-0006'nın hiçbir cümlesi değişmez.

Bunun ajana eklemekten daha iyi olmasının sebebi yalnızca uyum değil, **yarıçap**:

|                   | ajana eklenseydi                          | ayrı servis                                  |
| ----------------- | ----------------------------------------- | -------------------------------------------- |
| komutun yetkisi   | root, ajanın tamamıyla aynı               | kendi kullanıcısı, kendi birimi              |
| kapatma yolu      | yok — ajan olmadan cihaz çalışmaz         | `systemctl disable depsis-console`           |
| sertleştirme      | ajanın birimiyle ortak                    | kendi `ProtectSystem`, `NoNewPrivileges` vb. |
| bir açık ne verir | dosya sistemi + ZFS + Samba + veri kanalı | bir kabuk, o kullanıcının yetkisiyle         |

### Varsayılan olarak ayrıcalıksız

Birim `User=depsis-console` ile çalışır: kendi hesabı, hiçbir ilginç grupta değil, paylaşımlara
erişimi paylaşımların POSIX izinleri kadar.

Root kabuk isteyen bir kurulum için birim dosyasında tek satırlık, yorumlanmış bir anahtar var
(`DEPSIS_CONSOLE_PRIVILEGED=1`). **Varsayılan kapalı** ve açmak bir dosyayı elle düzenlemeyi
gerektirir — bir onay kutusuyla açılabilen root kabuk, kaza ile açılabilen root kabuktur.

### Erişim: yönetici + parola + süre

Üç kapı, ve üçü de ayrı şeyler için:

1. **`AdminGuard`.** Üye hesap 403 alır. Sunucuda, arayüzde değil.
2. **Parola yeniden doğrulaması.** Konsol açmak için oturum yetmez; mevcut parola istenir. Bir
   oturum, birinin açık bıraktığı bilgisayarı ödünç alanın sahip olduğu şeydir — parola
   sıfırlamada aynı gerekçeyle aynı şeyi yapıyoruz (`POST /me/password`).
3. **Süre.** Oturum 15 dakika boştan sonra kapanır ve en fazla 4 saat yaşar. Açık bırakılmış bir
   konsol sekmesi, süresiz bir kabuktur.

### Her şey denetlenir

Her oturum açılışı, kapanışı ve **girilen her satır** `audit` günlüğüne yazılır: kullanıcı
kimliği, oturum kimliği, korelasyon kimliği, zaman. Çıktı yazılmaz — bir `cat /etc/shadow`'un
çıktısını denetim günlüğüne kopyalamak, sırrı bir yerden alıp başka bir yere koymaktır.

Denetim kaydı `public.console_sessions` tablosunda; satırlar silinmez, oturum bitince kapanış
zamanı işlenir.

### Taşıma

Tarayıcı → API: `POST /console/{id}/input` (bayt dizisi).
API → tarayıcı: `GET /console/{id}/stream`, Server-Sent Events.

WebSocket değil, ve bunun sebebi tercih değil: Nest'te WS bir gateway ve ek bir bağımlılık
istiyor, SSE ise çerçevede zaten var. Bir terminalin gecikme bütçesi insan yazma hızıdır; SSE
bunun için fazlasıyla yeterli, ve tek yönlü olması bir eksiklik değil çünkü giriş zaten ayrı ve
küçük bir istek.

API → konsol servisi: kendi Unix soketi üzerinden, ADR-0017'nin veri kanalıyla aynı çerçeveleme
biçimini kullanarak. Aynı biçimi kullanmak yeni bir protokol icat etmemek demek.

### Tarayıcı tarafı

`xterm.js`. Kendi VT100 emülatörümüzü yazmak, ürünün geri kalanının bir haftasını alacak ve daha
kötü olacak bir iş; imleç konumlandırma ve renk kaçış dizileri, "az kod" diye kesilebilecek bir
yer değil. ADR-0001 üretilmiş API istemcisini şart koşuyor — bu bir API istemcisi değil, bir
görüntüleme bileşeni, ve pinlenmiş tek bir bağımlılık olarak eklenir.

## Sonuçlar

**Kazanılan:** cihazda gerçekten çalışan bir yönetici konsolu; `top`, `vim` ve satır düzenleme
dahil, çünkü arkasında gerçek bir pty var.

**Kabul edilen risk:** yönetici hesabını ele geçiren biri, o hesabın konsol yetkisini de ele
geçirir. Parola yeniden doğrulaması bunu pahalılaştırır ama kaldırmaz. Bu, kabuğu olan her NAS'ın
kabul ettiği risk; farkımız, kapatma anahtarının olması ve her satırın kaydedilmesi.

**Kabul edilen risk 2:** `xterm.js` yeni bir bağımlılık. Sürüm pinlenir ve `minimumReleaseAge`
kuralına tabidir.

**Reddedilen seçenek:** komut beyaz listesi. Beyaz listeli bir terminal terminal değildir; ve
kullanıcıyı, listede olmayan tek komut için SSH'a iter — yani denetlenmeyen bir yola.

**Reddedilen seçenek 2:** API'nin `child_process` ile kabuk açması. ADR-0006'nın uygulama katmanı
kuralını deler ve API birimi `ReadWritePaths=` boş olacak şekilde sertleştirilmiştir; oradan bir
kabuk açmak o sertleştirmenin anlamını bitirir.

## Doğrulama

`tools/poc/p1-e-console.sh`, gerçek systemd altında:

- üye hesap 403 alır
- doğru parola olmadan 403
- açılan oturumda `echo` çalışır ve çıktı SSE ile döner
- `stty size` pencere boyutunu doğru raporlar (pty gerçekten pty)
- boşta kalma süresi dolunca oturum kapanır ve sonraki giriş 404 alır
- her satır `console_sessions` denetimine düşer
- `systemctl stop depsis-console` sonrası uç nokta 503 döner, 500 değil
