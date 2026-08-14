# ADR-0001: API/BFF çalışma zamanı — NestJS/TypeScript

- **Durum:** Accepted
- **Tarih:** 2026-08-14
- **Faz:** 0 (karar), 1 (uygulama)
- **Etkilenen bileşenler:** `apps/api`, `packages/contracts`, `apps/web`

## Bağlam

Master prompt §2.1 seçimi bize bırakıp ADR ile gerekçelendirmemizi istiyor:

> "API/BFF: TypeScript/NestJS veya Rust/Axum seçeneklerinden biri. Seçimi ADR ile gerekçelendir."

Proje sahibi S3'te öneriyi sordu ve öneriyi kabul etti.

## Değerlendirilen seçenekler

### Seçenek A — NestJS + TypeScript

- **Artı:** Sözleşme tipleri `packages/contracts`'tan web, masaüstü ve mobil ile **aynı dilde**
  paylaşılır; OpenAPI 3.1'den üretilen istemci doğrudan tüketilir. Faz 1 kapsamı (auth, dosya CRUD,
  upload, arama, telemetri, SSE) geniş — geliştirme hızı burada belirleyici. Ekosistem: `@tus/server`,
  `pino`, Argon2 binding'i, OpenAPI üreticileri hazır. DI ve modül sınırları §2'nin "modüler monolit"
  hedefine doğrudan oturur.
- **Eksi:** Çalışma zamanı bellek ayak izi Rust'tan yüksek. Native binding'ler (Argon2) Debian ve
  Windows'ta derleme gerektirir. Tip güvenliği çalışma zamanına kadar inmez — sınırlarda runtime
  doğrulama (zod) zorunlu.

### Seçenek B — Rust + Axum

- **Artı:** Sistem aracısıyla tek dil. Düşük bellek, öngörülebilir gecikme. Derleme zamanında daha
  güçlü garantiler.
- **Eksi:** Faz 1'in geniş CRUD/oturum/SSE yüzeyi Rust'ta belirgin biçimde daha yavaş ilerler.
  Sözleşme tipleri frontend ile paylaşılamaz; bir üretim katmanı (schemars → TS) eklemek gerekir —
  yani "tek dil" avantajı sınırda zaten kayboluyor. NAS iş yükünde darboğaz CPU değil **disk ve ağ**;
  Rust'ın performans avantajı bu üründe ölçülebilir bir kullanıcı faydasına dönüşmüyor.

## Karar

**NestJS + TypeScript.**

Belirleyici gerekçe: **Rust bütçesi, gerçekten gerektiği yere harcanıyor.** Bu üründe Rust'ın
karşılığını verdiği yer ayrıcalık sınırıdır — `services/system-agent`, ZFS/Samba/Docker
operasyonlarını dar bir tiplenmiş op şemasıyla yürüten, kök yetkiye yakın çalışan küçük bileşen
(ADR-0006). Orada bellek güvenliği ve dar yüzey doğrudan bir güvenlik faydasıdır.

API katmanında aynı fayda yok: API zaten yetkisiz çalışıyor, ayrıcalıklı her işi aracıya
devrediyor, ve iş yükü G/Ç bağımlı. Buna karşılık TypeScript'in sözleşme paylaşımı faydası
somut — `packages/contracts` tek kaynak, web/desktop/mobil aynı tipleri tüketir.

### Sınırlar

- **Sözleşme tek kaynak:** OpenAPI 3.1 + zod `packages/contracts`'ta yaşar. `apps/web` istemcisi
  **üretilir**, elle yazılmaz.
- **Runtime doğrulama zorunlu:** TypeScript tipleri derleme zamanında silinir. API sınırındaki
  her girdi zod ile doğrulanır. "Tipi var, güvenli" argümanı kabul edilmez.
- **API asla ayrıcalıklı çalışmaz.** Disk, ZFS, Samba, Docker ve ağ işlemleri yalnız sistem
  aracısı üzerinden (§2.2). API'ye `sudo`, ham socket veya capability verilmez.
- **Modül sınırları gerçek olacak.** Modüler monolit, "her şeyin her şeyi import ettiği" bir
  monolit demek değil; modüller arası erişim açık arayüzlerden geçer.

## Kanıt

Sürüm bilgisi bu ADR'de **kasıtlı olarak yok** — §0.4 gereği NestJS majoru, minimum Node sürümü,
Express/Fastify varsayılanı ve Zod entegrasyonunun bugünkü durumu ADR-0000 §3'teki ikinci
araştırma turunda doğrulanacak ve oraya yazılacaktır. Bu ADR **dil ve çerçeve seçimidir**, sürüm
sabitlemesi değil.

## Sonuçlar

**Olumlu:** Tek dilde paylaşılan sözleşmeler; Faz 1'de daha hızlı ilerleme; olgun ekosistem.

**Olumsuz / kabul edilen bedel:** Node çalışma zamanı ayak izi. Native binding derleme
gereksinimi. Sınırlarda runtime doğrulama disiplini şart — unutulursa tip güvenliği yanıltıcı olur.

**Bu kararın yasakladığı şeyler:**

- API süreci ayrıcalıklı çalıştırılamaz veya `sudo` çağıramaz.
- `apps/web` içinde elle yazılmış API istemci tipi bulunamaz; `packages/contracts`'tan üretilir.
- API sınırında zod doğrulaması atlanamaz.
- Sistem aracısı NestJS'e taşınamaz — o Rust olarak kalır (ADR-0006).

## Geri alma maliyeti

**Yüksek.** Faz 1 tamamlandıktan sonra çalışma zamanını değiştirmek API katmanının tamamını
yeniden yazmak demektir. Bu yüzden karar Faz 0'da, kod yazılmadan alındı. Azaltıcı unsur:
sözleşmeler (`packages/contracts`) ve yetki mantığı (`packages/authz`, saf fonksiyonlar) çalışma
zamanından bağımsız tutulur — olası bir taşımada bunlar korunur.

## Güvenlik ve veri kaybı etkisi

Doğrudan etkisi yok; asıl güven sınırı API ile sistem aracısı arasındadır (ADR-0006) ve bu karar
o sınırı değiştirmiyor. Dolaylı etki: TypeScript'in tipleri çalışma zamanında yok olduğu için,
doğrulanmamış girdi hatası bu yığında **daha olasıdır**. Bunu karşılamak için sınırda zod
doğrulaması ve `packages/authz`'ın saf/property-test edilebilir tasarımı zorunlu kılındı.
