# ADR-0020: Uzak erişim — ZeroTier, ajanın arkasından

- **Durum:** Accepted
- **Tarih:** 2026-08-22
- **Faz:** 1'e çekildi (planlanan: 3)
- **Etkilenen bileşenler:** `services/system-agent`, `apps/api`, `packages/db`, `deploy/systemd`

## Bağlam

Uzak erişim Faz 3 olarak planlanmıştı. Cihazın sahibi öne çekti: _"zerotierı da zaten
ekleyeceksin."_ Arayüzün sağ sütununda "Uzak erişim" kartı zaten duruyordu ve içi boştu — bir
kullanıcı için "sonraki fazda" ile "çalışmıyor" arasında fark yok.

ZeroTier bir arka plan süreci (`zerotier-one`) ve `127.0.0.1:9993` üzerinde yerel bir JSON
API'si var. O API'ye erişim `/var/lib/zerotier-one/authtoken.secret` dosyasındaki jetonla
oluyor; dosya `0600` ve root'a ait.

## Karar

> **REVİZE (saha).** Aşağıdaki başlığın ilk yarısı artık geçerli DEĞİL: cihaz ZeroTier ile
> birlikte geliyor. Sebep, kararın kendisinden güçlü çıktı: sahibi uzaktan erişimi açmak
> istediğinde karşısına terminal çıktı, ve bu ürünün kabul ölçütü "sahibi terminale girmesin".
> Kararın DEĞİŞMEYEN yarısı ikiye ayrılıyor ve ikisi de yürürlükte: bir ağa katılmak hâlâ
> arayüzden ve sahibinin kararıyla olur — DEPSIS kimseyi kendiliğinden bir ağa sokmaz — ve
> paket, `curl … | bash` ile değil imzalı apt deposundan kurulur.
>
> **KİM KURAR.** Kararı ISO veriyor: ilk açılış `/etc/depsis/zerotier.wanted` dosyasını yazıyor,
> `tools/install/install.sh` o dosyayı görünce paketi kuruyor. Kuran tarafın ilk açılış DEĞİL
> kurulum betiği olmasının sebebi ölçülebilir: ilk açılış bir kez koşup kendini devre dışı
> bırakıyor, yani o gün ağ ya da depo düşerse kutu bir daha hiç denemez ve uzaktan erişim
> sonsuza kadar 503 döner. `install.sh` her güncellemede yeniden koşuyor.

### DEPSIS ZeroTier'i kök kabuğa boşaltılan bir betikle kurmaz

Kuruluysa yönetir. Kurulu değilse ve kutu onu istiyorsa (`/etc/depsis/zerotier.wanted`), kurulum
imzalı apt deposunu ekleyip paketi apt ile kurar; imza anahtarı inmezse kaynak hiç yazılmaz ve
kart "kurulu değil" der.

Bu, `curl … | bash` yapmamak için verilmiş bir karar — ve bir süre boyunca ISO'nun ilk açılışı
tam olarak onu yapıyordu: her cihaz, ilk açılışında, internetten indirdiği doğrulanmamış bir
betiği root olarak koşturuyordu. `tools/dev/provision-vm.sh` doğru yolu zaten yazmıştı; kurulum
artık aynı yolu kullanıyor. Bir ürünün kurulum betiği, kök kabuğa uzaktan bir betik boşaltmamalı.

### Jeton ajanda kalır

Yerel API ile **ajan** konuşur, API değil. Sebep tek satırda: jeton root okunabilir ve ağ
kontrolü veriyor — hangi ağa katılınacağını, hangisinden çıkılacağını. API bunu okuyamaz ve
okuyabilmemeli; ayrıcalıklı sırları tutmak ajanın varlık sebebi.

Podman'da ters karar verildi (ADR-0019: API doğrudan sokete konuşuyor) ve bu tutarsızlık değil:
oradaki soket **ayrıcalıksız** bir kullanıcıya ait, buradaki jeton root'a. Kararı belirleyen
şey, arkasında ne olduğu.

### İşlem kümesi kapalı kalır

Ajana `ZeroTierRequest { method, path, body }` gibi genel bir vekil eklemek, kapalı işlem
kümesini açmak olurdu — §2.2'nin serbest komut yasağının ağ hâli. Bunun yerine dört tiplenmiş
işlem:

- `ZeroTierStatus {}` — düğüm kimliği, çevrimiçi mi, sürüm
- `ZeroTierNetworks {}` — katılınmış ağlar, atanmış adresler, yetki durumu
- `ZeroTierJoin { network_id }` — 16 haneli onaltılık, yapı gereği doğrulanmış
- `ZeroTierLeave { network_id }`

`network_id`, `SafeComponent` gibi kendi tipiyle doğrulanır: tam 16 onaltılık hane, başka hiçbir
şey. Bir yol parçası olarak birleştirilmeden önce doğrulanması, yol enjeksiyonunu tip düzeyinde
imkânsız kılıyor.

Ajanın HTTP konuşması için asgari bir HTTP/1.1 istemcisi gerekiyor (yeni bağımlılık yok:
`rustix::net` zaten var, `serde_json` zaten var). Yalnız `127.0.0.1:9993`'e bağlanır ve bu
adres derleme zamanında sabittir — yapılandırılabilir olsaydı, ajanı keyfi bir adrese istek
attırmanın yolu olurdu.

### Katılmak yetki vermez

Bir ağa katılmak, o ağın yöneticisi cihazı **onaylayana kadar** bağlantı sağlamaz. Arayüz bunu
söylemek zorunda: `ACCESS_DENIED` durumundaki bir ağ "bağlanıyor" değil, "onay bekliyor"dur.
Kullanıcının, ZeroTier Central'da bir kutu işaretlemesi gerektiğini bilmesi lazım; bilmezse
ürünü bozuk sanır.

### Kim katılabilir

`AdminGuard`. Bir ağa katılmak, cihazı o ağdaki herkese görünür kılar; bu bir yönetim kararı.
Ağ kimliği ve düğüm kimliği ise her kullanıcıya gösterilir — kendi cihazının kimliğini bilmek
bir sır değil.

`public.remote_networks` tablosu, DEPSIS'in katıldığı ağların kaydını ve kimin ne zaman
katıldığını tutar. Gerçeğin kaynağı ZeroTier'in kendisi; tablo denetim içindir.

## Sonuçlar

**Kazanılan:** cihaza evin dışından, port yönlendirmesi açmadan ve statik IP olmadan erişim.
Bir NAS'ın uzak erişimi tipik olarak yönlendiricide açılan bir porttur; bu ondan kesinlikle
daha güvenli.

**Kabul edilen bağımlılık:** ZeroTier'in kök sunucuları üçüncü taraf altyapısı. Trafik uçtan uca
şifreli ama meta veri onların. Kendi denetim düğümünü çalıştırmak mümkün ve belgede anılır.

**Kabul edilen sınır:** DEPSIS ağ yaratmaz, yalnız katılır. Ağ yaratmak ZeroTier Central hesabı
ister ve bir NAS'ın kullanıcı adına hesap açması gereken bir yer değil.

## Doğrulama

`tools/poc/p1-g-remote.sh`, gerçek `zerotier-one` ile:

- daemon durdurulduğunda uç nokta 503 döner, 500 değil
- düğüm kimliği `zerotier-cli info` ile aynı
- üye hesap katılamaz (403), ama durumu görebilir (200)
- geçersiz ağ kimliği (kısa, uzun, onaltılık olmayan, yol parçası içeren) reddedilir ve ajana
  hiç ulaşmaz
- katılınan ağ `zerotier-cli listnetworks` çıktısında görünür
- onaylanmamış ağ `ACCESS_DENIED` olarak raporlanır, "bağlı" olarak değil
- ayrılınan ağ gerçekten listeden düşer
