# ADR-0013: PostgreSQL majör sürüm seçimi, RLS ve kiracı yalıtımı

- **Durum:** **Accepted** — P0-C koştu ve geçti (2026-08-14), kanıt: [`evidence/p0-c.tsv`](evidence/p0-c.tsv)
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `deploy/migrations`, `apps/api`, `deploy/vm/bootstrap.sh`

## Bağlam

§13 tahmin edilemez ID (UUIDv7/ULID benzeri) ve her kiracı tablosunda RLS istiyor. §18.2:
_"Kullanıcı A, Kullanıcı B'nin dosya adı, arama sonucu, thumbnail veya hata ayrıntısını
göremez."_

## 1. Majör sürüm: PG 18 (PGDG) — Debian stock PG 17 değil

|                        | Sürüm                                       | Kaynak                                |
| ---------------------- | ------------------------------------------- | ------------------------------------- |
| Güncel stable          | **18.6** (2026-08-13)                       | postgresql.org/docs/release           |
| Debian 13 trixie stock | `postgresql` **17+278** → PG **17** (17.11) | packages.debian.org/trixie/postgresql |
| PGDG trixie            | `postgresql-18`, suite `trixie-pgdg`        | postgresql.org/download/linux/debian  |
| PG 19                  | Beta 3 — **kullanılmayacak**                | postgresql.org/docs/release           |

Stock PG 17'nin iki somut eksiği var:

1. **`uuidv7()` yok.** Yerleşik `uuidv7()` yalnız PG 18'den itibaren var.
2. **Non-deterministic collation'da `LIKE` desteklenmiyor.** PG 17 belgesi birebir: _"The pattern
   matching operators of all three kinds do not support nondeterministic collations."_ PG 18 bunu
   destekliyor.

**Karar: PGDG'den PostgreSQL 18.**

Karşı argüman dürüstçe kaydediliyor: üçüncü taraf apt deposu eklemek §1'in _"mümkün olduğunca
Debian Stable temeli"_ hedefinden bir sapmadır ve **ek bir güven kökü** demektir. Kabul ediliyor
çünkü PGDG resmî PostgreSQL projesi deposudur, trixie'yi desteklediği doğrulandı, ve bir
appliance'ın 5+ yıllık ömründe PG 18 belirgin biçimde daha uzun soluk verir.

> İki eksik de aşılabilirdi (UUIDv7 uygulama kodunda üretilebilir; `LIKE` sorunu zaten normalize
> kolon yaklaşımıyla ortadan kalkıyor — bkz. ADR-0010). Yani bu bir **zorunluluk değil, tercih**.
> Proje sahibi ek depo istemezse PG 17'ye dönülebilir; maliyet, uygulama tarafında UUIDv7 üretimi
> ve bu ADR'nin superseded edilmesidir.

Kurulum: `apt install postgresql-common && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh`
veya deb822 `.sources` ile `Suites: trixie-pgdg`,
`Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc`.

## 2. RLS — iki belgelenmiş baypas

### 2.1 Tablo sahibi RLS'i atlar

PostgreSQL belgesi: _"Superusers and roles with the BYPASSRLS attribute always bypass the row
security system... Table owners normally bypass row security as well."_

**Sonuç:** NestJS uygulaması tablo sahibi rolüyle bağlanırsa — ki tek bir rol hem migration
koşup hem trafik sunduğunda ezici çoğunlukla olan budur — **RLS sessizce hiçbir şey yapmaz** ve
yazılan her politika ölüdür. `ENABLE ROW LEVEL SECURITY` bunu **engellemez**.

**Karar — iki katmanlı:**

| Rol             | Yetki                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| `depsis_owner`  | Şema sahibi. Yalnız migration çalıştırır. Uygulama **asla** bu rolle bağlanmaz |
| `depsis_app`    | Uygulama rolü. Tablo sahibi **değil**. RLS ona uygulanır                       |
| `depsis_backup` | Yalnız yedekleme                                                               |

Ayrıca her kiracı tablosunda `ALTER TABLE … FORCE ROW LEVEL SECURITY` — kemer **ve** askı.
Migration'lar bunu unutamaz: bir test, `pg_class`'ta RLS'i açık ama `FORCE` olmayan tablo
bulursa **başarısız olur**.

### 2.2 Referans bütünlüğü kontrolleri RLS'i HER ZAMAN atlar

Belge: _"Referential integrity checks, such as unique or primary key constraints and foreign key
references, always bypass row security"_ — ve açıkça **"covert channel"** sızıntısı uyarısı var.

**Somut DEPSIS sonucu:** `file_entries` üzerinde global bir `UNIQUE(path)` veya `UNIQUE(name)`
kısıtı, kiracı A'ya kiracı B'nin o değere sahip olduğunu **söyler**. Bu, §18.2'nin "A, B'nin dosya
adını göremez" kriterinin doğrudan ihlalidir — hem de politikalar doğru yazılmış olsa bile.

**Karar:** kiracılar arası benzersizlik kısıtı **kurulmaz**. Her benzersizlik kısıtı
`organization_id`'yi (ve gerektiğinde `parent_id`'yi) **içerir**:

```sql
UNIQUE (organization_id, parent_id, name_normalized)   -- kiracı içi
-- ASLA: UNIQUE (path)  veya  UNIQUE (name)
```

Bir migration testi, `organization_id` içermeyen her UNIQUE/EXCLUDE kısıtını **reddeder**.

### 2.3 Kiracı bağlamı ve connection pooling

Bağlam `SET LOCAL` + `current_setting()` ile taşınır — transaction kapsamlı olduğu için pooler'ın
bağlantıyı geri vermesi bağlamı sızdırmaz. **Kritik koşul:** her istek bir transaction içinde
çalışmalı; transaction dışı bir sorgu bağlamsız kalır ve politika onu **reddetmelidir** (fail-closed,
`current_setting(..., true)` `NULL` dönerse hiçbir satır görünmez).

PgBouncer transaction pooling ile uyumlu; **session pooling veya `SET` (LOCAL'siz) kullanılamaz**.

## Kanıt

| İddia                                                                   | Güven    |
| ----------------------------------------------------------------------- | -------- |
| PG 18.6 güncel stable; 17.11 trixie hattı; 19 Beta 3                    | verified |
| Debian trixie `postgresql` = 17+278                                     | verified |
| PGDG trixie'yi destekliyor (amd64, arm64, ppc64el)                      | verified |
| `uuidv7()` yalnız PG 18+                                                | verified |
| Tablo sahibi RLS'i atlar; `FORCE` gerekir                               | verified |
| UNIQUE/FK kontrolleri RLS'i her zaman atlar (covert channel uyarısıyla) | verified |
| `SKIP LOCKED` kuyruk için resmî olarak uygun                            | verified |

## P0-C — bu ADR'yi doğrulayacak PoC

1. `depsis_app` rolüyle, ham SQL ile, kiracı A kiracı B'nin satırlarını **göremiyor** mu?
2. `FORCE` olmadan, sahip rolüyle bağlanınca RLS gerçekten **atlanıyor** mu? (baypası gözle gör)
3. Global `UNIQUE(name)` kısıtı gerçekten çapraz kiracı varlık sızdırıyor mu? (covert channel'ı
   üret, sonra `organization_id`'li kısıtla kapandığını göster)
4. Transaction dışı sorgu **sıfır satır** mı döndürüyor? (fail-closed doğrulaması)
5. PgBouncer transaction pooling altında bağlam sızıyor mu?

## Sonuçlar

**Olumlu:** `uuidv7()` yerleşik. İki sessiz sızıntı yolu Faz 0'da kapatıldı ve migration testiyle
kalıcı hâle getirildi.

**Olumsuz / kabul edilen bedel:** Ek apt deposu = ek güven kökü ve ek güncelleme yolu. Rol ayrımı
migration ve deployment akışını karmaşıklaştırır. Her sorgunun transaction içinde olma zorunluluğu
bir disiplin gerektirir.

**Bu kararın yasakladığı şeyler:**

- Uygulama tablo sahibi rolüyle bağlanamaz.
- `ENABLE ROW LEVEL SECURITY` tek başına yeterli sayılamaz; `FORCE` zorunlu.
- `organization_id` içermeyen UNIQUE/EXCLUDE kısıtı kurulamaz.
- Kiracı bağlamı `SET LOCAL` dışında bir yolla taşınamaz.
- PgBouncer session pooling kullanılamaz.
- PG 19 (beta) kullanılamaz.

## Geri alma maliyeti

PG 18 → 17 dönüşü Faz 0'da düşük (UUIDv7'yi uygulamaya taşımak). Faz 1'den sonra `uuidv7()`
kullanan migration'lar yazıldıysa orta. RLS rol ayrımını sonradan eklemek **yüksek** — bu yüzden
ilk migration'da kuruluyor.

## Güvenlik ve veri kaybı etkisi

Doğrudan §18.2'nin kiracı yalıtım kriterine hizmet ediyor. Buradaki iki bulgu — sahip baypası ve
kısıt covert channel'ı — **sessiz** açıklardır: politikalar doğru yazılmış görünürken sızıntı
devam eder. Bu yüzden ikisi de otomatik teste bağlandı; belge okumakla yetinilmedi.
