# Sürüm imzalama

Cihaz kendini güncelleyebiliyor. Bu dizin, o güncellemenin **kime güvendiğini** belirliyor.

## Neden

Güncelleme, kök yetkiyle kurulacak bir kod indiriyor. İmza olmadan güvenilen tek şey HTTPS ve
kaynağın adresinin güncelleyici betikte sabit olması — bu, aradaki ağı dışarıda tutar, **kaynağın
kendisini dışarıda tutmaz**. İmzalı bir sürümde ise anahtarı olmayan bir saldırgan, deponun
tamamını ele geçirse bile kutuya kod kuramaz.

## Anahtar kimde

Özel anahtarı **bu depo üretmez ve taşımaz**. Bir üretim imza anahtarını üreten ve saklayan taraf
cihazın sahibidir; burada duran şey yalnızca açık anahtar (`release-key.pub`) ve onu kullanan iş
akışı.

`release-key.pub` yoksa cihazlar imzasız yolu kullanmaya devam eder ve arayüz bunu **söyler**
("imzasız kaynak"). Dosya konduğu andan itibaren cihaz yalnızca imzalı sürümleri kabul eder.

## Tek seferlik kurulum

Anahtarı **cihazın olmadığı**, sizin güvendiğiniz bir makinede üretin. Ed25519: küçük, hızlı, ve
`openssl`'in her güncel sürümünde var.

```bash
openssl genpkey -algorithm ed25519 -out depsis-release.key
```

Bu dosyayı bir daha üretemezsiniz. Kaybederseniz sahadaki hiçbir cihaz yeni sürüm kuramaz; sızarsa
sahadaki her cihaza kod kurulabilir. Bir parola yöneticisinde ya da çevrimdışı bir yedekte
saklayın.

Açık anahtarı bu dizine koyun ve depoya işleyin:

```bash
openssl pkey -in depsis-release.key -pubout -out deploy/release/release-key.pub
```

Özel anahtarı GitHub'a **sır olarak** ekleyin — adı `DEPSIS_RELEASE_KEY` olmalı:

```bash
gh secret set DEPSIS_RELEASE_KEY < depsis-release.key
```

## Sürüm çıkarmak

```bash
git tag v0.1.0 && git push origin v0.1.0
```

İmza `openssl pkeyutl -rawin` ile üretiliyor, `dgst -sha256` ile değil: Ed25519 saf bir imza
algoritması, özeti kendi alıyor, ve ona dışarıdan bir özet dayatmak openssl tarafından
reddediliyor. İndirdiğiniz bir arşivi elle doğrulamak isterseniz cihaz da aynı komutu
kullanıyor:

```bash
sudo /usr/local/lib/depsis/update.sh verify \
  /usr/local/lib/depsis/release-key.pub depsis-v0.1.0.tar.gz depsis-v0.1.0.tar.gz.sig
```

`release.yml` şunları üretir: kaynak arşivi, `sha256` dosyası ve **imza**. İş akışı imzayı
ürettiği yerde doğrular ve depodaki açık anahtarla karşılaştırır — uyuşmazsa sürümü yayınlamaz,
çünkü o sürümü hiçbir cihaz kuramazdı.

Sır yoksa iş akışı **düşer**. İmzasız bir sürüm yayınlamak, imzalı sürümün var olma sebebini
ortadan kaldırır: "imzasız da olur" diyen bir yedek yol, tam olarak saldırganın kullanacağı yoldur.
