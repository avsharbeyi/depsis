# ADR-0003: İş kuyruğu — PostgreSQL `SKIP LOCKED`

- **Durum:** Accepted
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `apps/worker`, `apps/api`, `deploy/migrations`

## Bağlam

§2.1 seçimi bize bırakıyor: _"Redis/Valkey veya PostgreSQL tabanlı kalıcı kuyruk. İlk sürüm için
operasyonel yükü düşük olanı ADR ile seç."_

§17 ise bir kısıt koyuyor: _"Redis/queue kaybında kalıcı iş tanımı kaybolmaz."_

## Karar

**PostgreSQL, `SELECT … FOR UPDATE SKIP LOCKED`.**

Bu, ilk turda önerilen varsayımdı ve araştırma onu **doğruladı** — PostgreSQL belgeleri bu kullanımı
açıkça onaylıyor: _"can be used to avoid lock contention with multiple consumers accessing a
queue-like table."_

### Neden Redis değil

| Kriter                                    | PostgreSQL                                                                            | Redis/Valkey                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| §17 "kuyruk kaybında iş tanımı kaybolmaz" | **Bedava** — iş tanımı zaten dayanıklı depoda                                         | Ayrı kalıcılık yapılandırması + ayrı yedekleme gerekir |
| Yedekleme                                 | Tek PITR akışı (ADR-0013)                                                             | İkinci bir yedekleme hattı                             |
| Transaction bütünlüğü                     | İş kaydı ile veri değişikliği **aynı transaction'da** — outbox deseni doğal           | İki fazlı taahhüt problemi veya kayıp mesaj            |
| Operasyonel yük (self-hosted appliance)   | Sıfır ek servis                                                                       | Ek daemon, ek bellek, ek izleme, ek arıza modu         |
| Throughput                                | NAS iş yükü için fazlasıyla yeterli — işler saniyede binlerce değil, dakikada onlarca | Daha yüksek, ama gereksiz                              |

Bir NAS appliance'ında darboğaz disk ve ağdır; kuyruk throughput'u değil. İkinci bir stateful
servisin operasyonel maliyeti, kazanılmayan performansa değmez.

### Belgelenmiş uyarı, kabul ediliyor

PostgreSQL belgesi: `SKIP LOCKED` _"provides an inconsistent view of the data, so this is not
suitable for general purpose work."_

Bu tam olarak istediğimiz şey — kuyruk tüketimi zaten tutarlı bir görünüm istemez. Ama sonuç net:
`SKIP LOCKED` **yalnız kuyruk tüketiminde** kullanılır, genel amaçlı sorgularda **asla**.

### Kiralama (lease) — çöken worker'lar için

`FOR UPDATE` kilidi transaction bittiğinde düşer. Uzun süren bir işi transaction açık tutarak
işlemek **yasaktır** (bloat, vacuum engeli, bağlantı tüketimi). Bunun yerine:

```sql
-- Talep: kısa transaction, işi "running" işaretle ve lease ver
UPDATE job_queue SET
    status      = 'running',
    lease_until = now() + make_interval(secs => lease_seconds),
    attempt     = attempt + 1,
    worker_id   = $1
WHERE id = (
    SELECT id FROM job_queue
    WHERE status = 'queued'
       OR (status = 'running' AND lease_until < now())   -- çökmüş worker'ı geri al
    ORDER BY priority DESC, run_after, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *;
```

- Worker iş sürerken **periyodik olarak `lease_until`'i uzatır** (heartbeat).
- Lease dolarsa iş otomatik yeniden talep edilebilir hâle gelir → §17'nin _"yeniden başlatmada
  'running' işlerin lease'i değerlendirilir"_ gereksinimi karşılanır.
- `attempt` sayacı ve `max_attempts`; aşılırsa `dead` durumuna geçer ve **sessizce kaybolmaz**,
  sistem alarmı üretir.

### İdempotentlik zorunlu

Lease modeli **en az bir kez** teslim garantisi verir, tam olarak bir kez değil. Bir worker
lease'i uzatmayı kaçırıp iş yeniden atanabilir ve **iki worker aynı işi yapabilir**. Bu yüzden
§17'nin "işler idempotent" kuralı pazarlık konusu değildir:

- Dosya işlemleri `.depsis/staging/<upload-id>` gibi **belirlenimci** hedeflere yazar (ADR-0008).
- Yayınlama `linkat` + `unlink` ile atomik-no-clobber (ADR-0008).
- Yıkıcı sistem işleri ayrıca **advisory lock** ile korunur (aşağıda).

### Outbox — DB olayı ile worker teslimi arasında tutarlılık

§13 outbox tablosu istiyor. Aynı veritabanı kullanıldığı için bu doğal olarak çalışır: iş kaydı,
onu doğuran veri değişikliğiyle **aynı transaction'da** yazılır. Redis'te bu iki fazlı bir problem
olurdu.

Uyandırma için `LISTEN`/`NOTIFY` + kısa aralıklı polling fallback. Yalnız `NOTIFY`'a güvenilmez —
bağlantı kopmasında bildirim kaybolur; polling kaybı telafi eder.

### Yıkıcı yönetim işlerinde advisory lock

§17: _"Split-brain yaratacak çoklu yönetici işlemleri advisory/distributed lock ile engellenir."_

Havuz oluşturma, disk rol değişimi, resilver başlatma, Samba config publish gibi işlerde
`pg_try_advisory_xact_lock(<namespace>, <resource_id>)`. **`pg_advisory_lock` (bloklayan) değil,
`try` varyantı** — bekleyip sıraya girmek yerine "bu kaynak üzerinde başka bir işlem sürüyor"
hatası kullanıcıya net biçimde döner.

### Bloat kontrolü

Kuyruk tablosu yüksek UPDATE oranlıdır. Karşı önlemler:

- Tamamlanan işler `job_queue`'dan **taşınır** (`job_history`'ye), tabloda bırakılmaz.
- Tablo başına agresif autovacuum ayarı (`autovacuum_vacuum_scale_factor` düşük).
- Kısmi indeks: `WHERE status IN ('queued','running')` — sıcak küme küçük kalır.
- Uzun transaction yasağı yukarıda zaten kuruldu.

## Redis'in geri gelebileceği yer

Bu ADR Redis'i **kalıcı iş kuyruğu** için reddediyor. Reddetmediği: geçici önbellek, oturum
depolama, rate-limit sayaçları. Bunlar kaybedilebilir veriler olduğu için farklı bir karardır ve
ihtiyaç ölçülürse ayrı bir ADR ile ele alınır.

## Kanıt

| İddia                                                         | Kaynak                                                                             | Güven                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `SKIP LOCKED` kuyruk deseni için resmî olarak uygun           | [SELECT — Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) | verified                                               |
| _"inconsistent view … not suitable for general purpose work"_ | aynı                                                                               | verified                                               |
| Kuyruk throughput'unun NAS iş yükünde yeterliliği             | —                                                                                  | **unverified** → performans testinde ölçülecek (§18.1) |

## Sonuçlar

**Olumlu:** Tek stateful servis. §17'nin dayanıklılık gereksinimi bedavaya geliyor. Outbox doğal.
Yedekleme tek hat.

**Olumsuz / kabul edilen bedel:** Yüksek UPDATE oranı vacuum baskısı yaratır ve aktif olarak
yönetilmesi gerekir. Çok yüksek throughput'ta PostgreSQL Redis kadar hızlı değildir — bu iş yükünde
sorun beklenmiyor ama **ölçülecek**.

**Bu kararın yasakladığı şeyler:**

- İş süresince transaction açık tutulamaz.
- `SKIP LOCKED` kuyruk dışı sorgularda kullanılamaz.
- İşler idempotent olmayacak biçimde yazılamaz.
- `NOTIFY` tek uyandırma mekanizması olamaz.
- Tamamlanan işler `job_queue`'da bırakılamaz.
- Yıkıcı yönetim işleri advisory lock olmadan çalıştırılamaz.

## Geri alma maliyeti

Düşük–orta. Kuyruk erişimi bir arayüzün arkasında tutulur; Redis'e geçmek worker'ların talep/teslim
katmanını değiştirir ama iş mantığını değiştirmez. Asıl kayıp outbox'ın transaction bütünlüğü olur.

## Güvenlik ve veri kaybı etkisi

Doğrudan §17'ye hizmet ediyor: elektrik kesintisinde yarım kalan işler lease süresi dolunca geri
alınır ve **kaybolmaz**. `max_attempts` aşımında iş sessizce düşmez, alarm üretir — sessiz kayıp
bu üründe kabul edilemez. Advisory lock'lar aynı diski iki yerden değiştirmeye çalışan yönetici
işlemlerini engelleyerek risk R1'e katkı sağlar.
