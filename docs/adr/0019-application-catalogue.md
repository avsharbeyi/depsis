# ADR-0019: Uygulamalar — köksüz Podman ve küratörlü katalog

- **Durum:** Accepted
- **Tarih:** 2026-08-22
- **Faz:** 1
- **Etkilenen bileşenler:** `apps/api`, `packages/db`, `deploy/systemd`, `apps/web`

## Bağlam

Cihazın sahibi arayüzdeki "Uygulamalar" bölümünün çalışmasını istedi: _"uygulamalar için container
motoru da eklemen gerek."_ Bir NAS'ta bu, ürünün en çok istenen ikinci özelliği — Jellyfin,
Nextcloud, bir torrent istemcisi.

Üç soru vardı: hangi motor, hangi ayrıcalıkla, ve kim konuşacak.

## Karar

> **REVİZE (saha), iki maddede.** (1) Podman artık cihazla GELİYOR: kurulumu ISO'nun ilk açılışı
> yapıyor (`deploy/iso/firstboot.sh`), çünkü "apt ile kurun" bir tüketici cihazında kurulum adımı
> değil ürünün eksiği. Köksüzlük şartı aynen duruyor. (2) Katalog artık YALNIZ migration ile
> yazılmıyor: yönetici kendi imajını ekleyebiliyor (`app_custom`, 0039), ama yalnız bilinen kayıt
> defterlerinden (docker.io, ghcr.io, lscr.io, quay.io) ve DEPSIS'in içeriğe kefil olmadığı arayüzde
> yazılı olarak. Aşağıdaki iki başlığı bu iki cümleyle okuyun.

### Motor: Podman, ve DEPSIS onu paketlemez

`podman`, dağıtımın kendi paketinden. DEPSIS bir konteyner çalışma zamanı **taşımaz**; kuruluysa
kullanır, değilse uygulamalar bölümü "kurulu değil" der ve kurulum komutunu gösterir.

Docker yerine Podman, tek bir sebeple: Docker'ın mimarisinde root çalışan bir daemon var ve o
daemon'un soketine erişim root'a eşdeğerdir. Podman daemonsuz ve **köksüz** çalışabiliyor;
aşağıdaki ayrıcalık kararı buna dayanıyor. (Docker API'siyle uyumlu olduğu için, birinin
Docker'a geçirmesi gerekirse taşınacak yüzey küçük.)

### Ayrıcalık: kendi kullanıcısı, köksüz

Konteynerler `depsis-apps` adlı özel bir kullanıcının altında, **köksüz** çalışır. Soket
`/run/user/<uid>/podman/podman.sock`.

Alternatif, root podman soketini ayrıcalıklı ajanın arkasına koymaktı. Reddedildi: root bir
konteyner çalışma zamanının soketine erişim, pratikte root'tur — `-v /:/host` ile bir konteyner
başlatmak dosya sisteminin tamamını verir. Ajanın arkasına koymak bunu gizler, kaldırmaz.

Köksüz podman ile en kötü durum, `depsis-apps` kullanıcısının yetkisidir. Paylaşımlara erişim o
kullanıcının POSIX izinleri kadardır ve bir uygulamaya paylaşım bağlanması açık bir karardır.

### Kim konuşacak: API, ajan değil

Podman soketiyle **API** konuşur, `node:http`'nin `socketPath` seçeneğiyle. Bu ADR-0006'yı
delmez: ADR-0006 uygulama katmanının **kabuk çalıştırmasını** yasaklıyor, bir soketle
konuşmasını değil. Ajanın arkasına koymak, Rust'a asgari bir HTTP istemcisi yazmak ve kapalı
işlem kümesine on yeni varyant eklemek pahasına, ayrıcalığı azaltmadan karmaşıklığı artırırdı —
çünkü soket zaten ayrıcalıksız.

### Katalog küratörlüdür, keyfi `docker run` değil

> Revize: aşağıdaki kural kataloğun KENDİSİ için hâlâ geçerli. Yanına eklenen şey kapılı bir
> genişleme — bkz. yukarıdaki not.

Kullanıcı bir imaj adı yazamaz. `public.app_catalogue` tablosunda DEPSIS'in tanıdığı uygulamalar
durur; her satır imajı, açtığı portu, istediği bağlama noktalarını ve ortam değişkenlerini
tarif eder.

Bu bir kolaylık değil, bir sınır. Serbest imaj adı şu demektir: kullanıcı, `depsis-apps`
kullanıcısı olarak internetten indirilen keyfi kodu çalıştırabilir ve ona istediği host yolunu
bağlayabilir. Katalog, bağlanabilecek yolları paylaşımlarla sınırlar ve imajı sabitler.

Katalog **veritabanında**, kodda değil: yeni bir uygulama eklemek bir sürüm çıkarmayı
gerektirmemeli. Satırlar migration ile tohumlanır ve yönetici düzenleyemez — düzenleyebilseydi
sınır olmazdı.

### Portlar

Her uygulama `127.0.0.1` üzerinde bir porta bağlanır, `0.0.0.0`'a değil. Dışarıya açılması
gerekiyorsa bunu DEPSIS'in kendi ters vekili yapar; bir konteynerin doğrudan LAN'a açılması,
kullanıcının kurduğunu sandığından fazlasını kurmasıdır.

## Sonuçlar

**Kazanılan:** çalışan bir uygulama kataloğu — kur, başlat, durdur, kaldır, günlüğü gör.

**Kabul edilen sınır:** yalnızca katalogdaki uygulamalar. "Kendi imajımı çalıştırayım" isteyen
kullanıcı bunu SSH ile yapar; ürünün içinden yapılamaması bilinçli.

**Kabul edilen sınır 2:** köksüz podman bazı şeyleri yapamaz — 1024 altı porta bağlanamaz,
bazı ağ kipleri yoktur. Katalog buna göre yazılır.

**Bağımlılık:** çalışma zamanı kuruluysa çalışır. `tools/dev/provision-vm.sh` geliştirme
kutusuna kurar; üretimde kurulum belgesinin işi.

## Doğrulama

`tools/poc/p1-f-apps.sh`, gerçek podman ile:

- podman yokken uygulamalar listesi 503 döner, 500 değil
- katalog dışı bir imaj adı reddedilir
- kurulan uygulama gerçekten çalışır ve `127.0.0.1:<port>` cevap verir
- durdurulan uygulama gerçekten durur (`podman ps` ile doğrulanır, API'nin kendi kaydıyla değil)
- konteyner `depsis-apps` kullanıcısında çalışır, root'ta değil (`podman inspect`)
- katalogda tarif edilmeyen bir yol bağlanamaz
