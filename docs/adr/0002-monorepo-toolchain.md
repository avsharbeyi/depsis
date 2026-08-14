# ADR-0002: Monorepo araç zinciri ve sürüm sabitlemesi

- **Durum:** Accepted
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** depo kökü, tüm `apps/*` ve `packages/*`

## Bağlam

§19 bir monorepo düzeni ve `format → lint → typecheck → unit → integration → e2e → security →
reproducible build → signed artifacts` CI hattı istiyor. §0.4 sürüm tahminini yasaklıyor.

Tüm sürümler 2026-08-14'te npm registry ve `nodejs/Release/schedule.json`'dan **getirilerek**
doğrulandı.

## Karar

### Çalışma zamanı: Node 24 (Active LTS) — 22 değil

| Hat                   | Durum                                 | EOL        | Karar                    |
| --------------------- | ------------------------------------- | ---------- | ------------------------ |
| Node 22 "Jod"         | **Maintenance** (2025-10-21'den beri) | 2027-04-30 | Hedef **değil**          |
| **Node 24 "Krypton"** | **Active LTS**                        | 2028-04-30 | **Hedef**                |
| Node 26               | Current; ~10 hafta içinde Active LTS  | 2029-04-30 | Faz 4'te değerlendirilir |

> **Bu makinede Node v22.23.2 kurulu ve o hat Maintenance'ta** — yalnız güvenlik/kritik düzeltme
> alıyor. `nodejs.org/en/about/previous-releases` tablosu 22 ve 24'ün ikisini de sadece "LTS"
> etiketliyor; faz ayrımı yalnız `schedule.json`'da görünüyor. Bu yüzden karıştırılması kolay bir
> tuzak. CI ve Debian çalışma zamanı **24**'e sabitlenecek; geliştirme makinesinin 24'e alınması
> önerilir.
>
> Node 20 (son 20.20.2) ve 25 (son 25.9.0) **EOL**.

### Sabitlenen sürümler

| Paket                       | Sürüm                   | Not                                                                           |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| Node.js                     | **24.19.0**             | `.nvmrc` + CI matrix                                                          |
| pnpm                        | **11.21.0**             | `packageManager` alanı; `engines: node >=22.13` — Node 20 yetmez              |
| turbo                       | **2.10.9**              | 2.x hattı aktif                                                               |
| TypeScript                  | **6.0.3**               | ⚠️ 7.0.2 `latest` ama **kullanılamadı** — aşağıdaki bölüme bakınız            |
| @nestjs/core                | **11.1.29**             | `engines: node >= 20`; varsayılan adapter **Express** (Fastify opt-in)        |
| Vite                        | **8.2.1**               | `engines: ^20.19.0 \|\| >=22.12.0`                                            |
| React / react-dom           | **19.2.8**              | İkisi de aynı dizeye sabitlenir                                               |
| babel-plugin-react-compiler | **1.0.0**               | Artık stabil, rc/experimental değil                                           |
| Vitest                      | **4.1.10**              |                                                                               |
| @playwright/test            | **1.62.1**              |                                                                               |
| zod                         | **4.4.3**               | Yeni proje **v4** kullanır                                                    |
| @node-rs/argon2             | **2.1.0**               | **Seçilen** — platform başına prebuilt binding, node-gyp/python3/g++ gerekmez |
| otplib                      | **13.4.1**              | Son yayın 2026-05-30                                                          |
| pino / pino-http            | **10.3.1** / **11.0.0** |                                                                               |
| openapi-typescript          | **7.13.0**              | **Seçilen** üretici — OpenAPI 3.1, tip-only, sıfır runtime                    |
| openapi-fetch               | **0.17.0**              | ~6 kB tipli fetch sarmalayıcı                                                 |

### TypeScript 7 geri alındı — ampirik bulgu (2026-08-14)

Bu ADR'nin ilk hâli TypeScript **7.0.2**'yi sabitliyordu ve davranışsal etkilerini
`unverified` bırakmıştı. İskelet kurulurken risk gerçekleşti:

```
typescript-eslint does not support TS 7.0.
```

`typescript-eslint@8.67.0` peer aralığı: **`typescript >=4.8.4 <6.1.0`**. TS 7 ile eklenti
import anında ölüyor — yani tip-farkında lint kurallarının **tamamı** kayboluyor.

Kaybedilecekler DEPSIS için dekoratif değil:

| Kural                        | Neyi yakalıyor                                                              |
| ---------------------------- | --------------------------------------------------------------------------- |
| `no-floating-promises`       | Dosya işlemi veya job yolunda düşen promise = **sessizce kaybolan yazma**   |
| `no-unsafe-*`                | ADR-0001'in "sınırda runtime doğrulama zorunlu" kuralının otomatik denetimi |
| `strict-boolean-expressions` | ADR-0004/0005'te yetki ve kimlik kodunun nullability'yi gizlememesi         |

**Karar: TypeScript 6.0.3** (son 6.x). Veri kaybetmemeyi hedefleyen bir üründe, düşen
promise'i yakalayan kuralı en yeni derleyici uğruna feda etmek kötü bir takastır.

Doğrulandı: TS 6.0.3 ile `tsconfig.base.json`'daki tüm strict bayrakları derleniyor,
`pnpm check` yeşil, ve enjekte edilen bir floating promise gerçekten yakalanıyor.

typescript-eslint TS 7 desteği [#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
ile izleniyor; kapandığında bu ADR superseded edilip 7'ye çıkılır.

**Yan bulgu — tsconfig ikiye ayrıldı.** Tip-farkında lint test dosyalarını da görmek zorunda,
ama testler `dist/`e girmemeli. Bu yüzden `tsconfig.json` (editör + ESLint, testler dâhil,
`noEmit`) ve `tsconfig.build.json` (yalnız derleme, testler hariç) ayrıldı. Tek tsconfig ile
ESLint "was not found by the project service" hatası veriyordu.

### Çürütülen yaygın inanışlar

- **otplib terk edilmiş değil.** 12.0.1 / 2021'de kaldığı yaygın kanısının aksine, 13.4.1 ile
  "TypeScript-first, multi-runtime" olarak canlandırılmış. TOTP için üçüncü taraf aramaya gerek yok.
- **Argon2 için node-gyp şart değil.** `@node-rs/argon2` prebuilt binding dağıtıyor; hem Debian
  hem Windows'ta derleme zinciri gerektirmiyor. Klasik `argon2` (0.45.1) da sağlıklı — seçim
  sağlık değil, **derleme mekaniği** meselesi. Windows'ta dev kurulumunu basitleştirdiği için
  `@node-rs/argon2` seçildi.

### OpenAPI istemci üretimi

**`openapi-typescript` + `openapi-fetch`** seçildi.

- `orval` (8.24.0) çalışıyor ama react-query hook'ları ve MSW mock'ları üretiyor — DEPSIS'in
  ihtiyacından fazla yüzey.
- `@hey-api/openapi-ts` (0.99.0) **yıllardır 1.0 öncesi**. 0.x semver, minor sürümlerin üretilen
  çıktıyı bozabileceği anlamına gelir; uzun ömürlü bir platform için seçilmez.

### NestJS + zod köprüsü

`nestjs-zod` **5.5.0** mevcut ve sağlıklı (son yayın 2026-07-25, ~4.5M indirme/ay), ama
**`@nestjs/*` resmî paketi değil**. ADR-0001'in "sınırda runtime doğrulama zorunlu" kuralı
`nestjs-zod`'a bağımlı kılınmayacak: doğrulama `packages/contracts`'taki düz zod şemalarıyla,
ince bir Nest pipe üzerinden yapılır. `nestjs-zod` yalnız Swagger entegrasyonu için
değerlendirilir; kaybı bir bağımlılığın kaybı olur, mimarinin değil.

### Sabitleme mekanizmaları

`pnpm-lock.yaml` (commit'lenir, CI `--frozen-lockfile`) · `packageManager: pnpm@11.21.0` ·
`.nvmrc: 24.19.0` · `engines` alanı ile yanlış Node'da kurulum reddi · Rust için
`rust-toolchain.toml` (ADR-0006) · Docker image **digest** (`latest` yasak).

## Kanıt

Tüm sürümler npm registry `/latest` uçlarından ve
[`nodejs/Release/schedule.json`](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)'dan
bu oturumda getirildi — `verified`.

**Doğrulanmayan:**

| Konu                                                                            | Durum                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debian 13 trixie `nodejs` paket sürümü                                          | **unverified** — archive'daki Node'un pnpm 11'in `>=22.13` şartını karşıladığı **varsayılmayacak**. Appliance'ta NodeSource / resmî tarball planlanır |
| TypeScript 7'nin project references ve derleme performansına davranışsal etkisi | **unverified** — iskelet kurulurken ampirik görülecek                                                                                                 |
| `@nestjs/platform-fastify`'ın paketlediği Fastify majoru                        | unverified (Express varsayılan kullanılacağı için bloke etmiyor)                                                                                      |

## Sonuçlar

**Olumlu:** Her sürüm doğrulandı; hiçbiri tahmin değil. Native derleme zinciri gereksinimi
`@node-rs/argon2` ile ortadan kalktı — Windows'ta dev kurulumu sürtünmesiz.

**Olumsuz / kabul edilen bedel:** TypeScript 7 yeni ve davranışsal etkileri bu projede henüz
ölçülmedi; iskelet kurulumunda sorun çıkarsa 6.x'e düşmek gerekebilir ve bu ADR güncellenir.
Geliştirme makinesindeki Node 22 ile hedef Node 24 arasında fark var — CI ikisini de koşmaz,
yalnız 24'ü doğrular.

**Bu kararın yasakladığı şeyler:**

- Node 22 veya 20 hedeflenemez.
- `latest` etiketiyle bağımlılık çekilemez; lockfile commit'lenir ve CI `--frozen-lockfile` kullanır.
- Debian archive'ındaki `nodejs`'in yeterli olduğu varsayılamaz.
- `@hey-api/openapi-ts` 1.0 öncesiyken üretim istemci üretimi için kullanılamaz.
- Runtime doğrulama `nestjs-zod`'a bağımlı kılınamaz.

## Geri alma maliyeti

Düşük–orta. Sürüm değişimi lockfile yenilemesidir. TypeScript major düşürmek daha maliyetli ama
Faz 0'da yapılırsa ucuz.

## Güvenlik ve veri kaybı etkisi

Node 24'e sabitlemek doğrudan bir güvenlik kararıdır: Maintenance LTS yalnız kritik düzeltme alır.
Lockfile + `--frozen-lockfile` tedarik zinciri yüzeyini daraltır. `@node-rs/argon2`'nin prebuilt
binding'leri derleme zinciri gereksinimini kaldırır ama **prebuilt ikili indirmek de bir tedarik
zinciri yüzeyidir** — CI'da bağımlılık ve imza taraması (§16) bu yüzden zorunlu.
