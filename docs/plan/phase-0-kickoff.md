# DEPSIS — Faz 0 Kickoff / İlk Yanıt

> Bu belge, `DEPSIS_Master_Engineering_Prompt.md` §22'de istenen ilk yanıtın kalıcı sürümüdür.
> Tarih: 2026-08-14 · Durum: **Faz 0 tamamlandı** (P0-E hariç). Kararlar için §8.
>
> ⚠️ **Bu belge tarihsel bir kayıttır, güncel tasarım değildir.** §2'deki varsayımların yedisi
> ölçümle çürütüldü. Yürürlükteki kararlar için her zaman
> [ADR dizinine](../adr/README.md) bakınız; çürütülen maddelerin en tehlikelisi burada
> işaretlendi, ama belgenin tamamı güncellenmedi.

---

## 1. Mevcut depo incelemesi

`C:\Users\HUAWEI\Desktop\xdepsisOS` **tamamen boştur**. Git deposu değildir. Yeniden kullanılabilecek
hiçbir kaynak kod, config, migration veya kilit dosyası yoktur. Bu nedenle §0.1 ("çalışan parçaları
gereksiz yere yeniden yazma") bu turda uygulanamaz; greenfield başlangıç yapılacaktır.

### 1.1 Tespit edilen çalışma ortamı

| Bileşen          | Durum                                    | Sonuç                                         |
| ---------------- | ---------------------------------------- | --------------------------------------------- |
| Node.js          | v22.23.2                                 | Yeterli (LTS hattı)                           |
| npm / corepack   | 10.9.8 / 0.34.6                          | pnpm corepack ile etkinleştirilecek           |
| Git              | 2.55.0                                   | Var, ancak bu klasör repo değil               |
| Python           | 3.14.7                                   | Yardımcı scriptler için yeterli               |
| **Rust / cargo** | **YOK**                                  | Sistem aracısı için `rustup` kurulumu gerekir |
| **Docker**       | **YOK**                                  | Host'ta yok — zaten Debian hedefine ait       |
| **PostgreSQL**   | **YOK**                                  | Dev için konteyner veya Linux hedefinde       |
| WSL2             | 2.7.3.0                                  | Mevcut                                        |
| Donanım          | i7-1360P, 15.7 GB RAM, C: 740 GB boş     | ZFS test havuzu + VM için yeterli             |
| Hyper-V          | Belirlenemedi (yükseltilmiş hak gerekti) | Soru #2'ye bağlı                              |
| VirtualBox       | YOK                                      | —                                             |

### 1.2 Kapsam dışı bırakılan önceki çalışma

WSL2 üzerinde `DepsisBuilder` adlı **durdurulmuş** bir dağıtım bulundu.
Kök yolu: `C:\Users\HUAWEI\Desktop\evraks\depos\.wsl-builder`

Bu, bu klasörün dışında, önceki bir DEPSIS denemesine ait bir ortamdır. Kullanıcının
"eskiden üretilmiş hiçbir dosyadan ve koddan yararlanma" talimatı gereği **başlatılmadı,
içeriği okunmadı ve kullanılmayacaktır.** Bkz. Soru #1.

### 1.3 Ortamdan doğan temel gerçek

Geliştirme makinesi bir Windows dizüstü bilgisayardır; hedef ise bir Debian NAS'tır. ZFS, Samba,
systemd, Docker ve fanotify Windows'ta doğrulanamaz. Bu nedenle §19'un zorunlu kıldığı çift hat
uygulanacaktır:

- **Geliştirme hattı (Windows):** mock storage/agent adapter'ları ile root ve disk gerektirmeden
  çalışan tam uygulama; birim ve sözleşme testleri burada koşar.
- **Doğrulama hattı (Debian):** gerçek ZFS/Samba/fanotify/PostgreSQL; entegrasyon, kurtarma ve
  performans testleri yalnızca burada geçerli sayılır.

Mock ile gerçek entegrasyon her raporda açıkça ayrılacaktır (§22).

---

## 2. Çelişkiler, belirsizlikler ve varsayılan karar önerileri

| #   | Konu                                  | Çelişki / belirsizlik                                                                                                                                     | Varsayılan öneri                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | API çalışma zamanı                    | §2.1 NestJS **veya** Rust/Axum diyor, seçimi bize bırakıyor                                                                                               | **NestJS + TypeScript.** Rust bütçesini asıl gerekli yere, ayrıcalık sınırındaki sistem aracısına harca. Sözleşme tipleri web/desktop/mobil ile paylaşılır. → ADR-0001                                                                                                                                                                                         |
| B2  | Kuyruk                                | §2.1 Redis/Valkey veya PG kuyruğu; §17 "queue kaybında kalıcı iş tanımı kaybolmaz"                                                                        | **PostgreSQL `FOR UPDATE SKIP LOCKED`.** İkinci bir stateful servis yok, yedekleme tek noktadan, §17 bedavaya sağlanır. Redis adapter arayüzü açık bırakılır. → ADR-0003                                                                                                                                                                                       |
| B3  | ACL otoritesi                         | §6.2 "iki ayrı gerçeklik üretme" diyor ama Samba/POSIX ile DEPSIS modeli birebir örtüşmez                                                                 | ⚠️ **BU ÖNERİ ÇÜRÜTÜLDÜ — UYGULAMAYIN.** Buradaki `acltype=nfsv4`, P0-B'de ölçüldüğü üzere ACL'leri **tamamen kapatıyor** ve bunu `nfsv4` raporlayarak gizliyor. Yürürlükteki karar `acltype=posixacl` + `xattr=sa`'dır; POSIX draft ACL **kullanılır** (Linux'ta çekirdeğin uyguladığı tek tür). → [ADR-0004](../adr/0004-authz-authority-and-smb-mapping.md) |
| B4  | Açık `deny`                           | §6.2 "varsa öncelik kuralları tek ve belgelenmiş olmalı" — koşullu bırakılmış                                                                             | **Faz 1'de açık deny YOK.** Yalnız allow + alt klasörde daha dar izinle override. Deny + miras + SMB eşlemesi "iki gerçeklik" hatalarının bir numaralı kaynağıdır. Faz 2'de ADR ile yeniden değerlendirilir. Bkz. Soru #5                                                                                                                                      |
| B5  | Dosya kimliği                         | §13 "path'i tek kimlik kabul etme" ama SMB ve fanotify path ile çalışır                                                                                   | **Üçlü kimlik:** kararlı `id` (UUIDv7) + `parent_id` + `(dataset_id, inode, ino_generation)`. Materyalize path yalnız gösterim ve reconciliation join anahtarı; asla yetki kararı girdisi değil. → ADR-0005                                                                                                                                                    |
| B6  | WebAuthn + IP erişimi                 | §6.3 WebAuthn/passkey istiyor; §3.1 IP ile erişimi normalleştiriyor. **WebAuthn RP ID çıplak IP olamaz.** Service Worker ve WebAuthn secure context ister | **Faz 1'de MFA = TOTP.** WebAuthn, gerçek bir hostname + güvenilen sertifika koşulu sağlandığında Faz 2'de açılır. UI bunu dürüstçe söyler, "yakında" diye gizlemez. → ADR-0009. Bkz. Soru #4                                                                                                                                                                  |
| B7  | ZeroTier bağımsızlık                  | §10.1 "en az iki sabit erişilebilir özel root/moon" — ev/KOBİ senaryosunda genelde iki statik public IP yoktur                                            | Faz 3'te **"Kolay mod" varsayılan.** "Bağımsızlığa yakın mod" bir kurulum ön koşulu listesiyle (2× statik IP, UDP 9993) sunulur; koşul yoksa UI özelliği kilitli ve **nedeni yazılı** gösterir                                                                                                                                                                 |
| B8  | Nextcloud/Immich veri dizini          | §11.2 kontrolsüz paylaşımı yasaklıyor ama kullanıcı dosyalarını da görmek isteyecek                                                                       | Her uygulama kendi dataset'ini alır. DEPSIS dosya yöneticisinde **salt-okunur mount node** olarak görünür; yazma yalnız uygulamanın kendi API'si veya "external storage" üzerinden                                                                                                                                                                             |
| B9  | `effective_permission_cache`          | §13 "varsa invalidation kuralları zorunlu"                                                                                                                | **Faz 1'de cache yok.** Önce §18.2'deki p95 < 400 ms hedefi ölçülür; ihtiyaç kanıtlanırsa Faz 2'de invalidation ADR'siyle eklenir                                                                                                                                                                                                                              |
| B10 | Sürüm sabitleme                       | §0.4 sürüm tahmin etmeyi yasaklıyor, uygulama anında resmî belgeden doğrulamayı şart koşuyor                                                              | Hiçbir sürüm bu belgede sabitlenmedi. Faz 0'ın ilk işi: Debian Stable kod adı/sürümü, OpenZFS, Samba, PostgreSQL, Docker sürümlerini **resmî kaynaktan doğrulama** ve `docs/adr/0000-version-baseline.md` + kilit dosyalarına yazma                                                                                                                            |
| B11 | "Yalnız bu klasör" vs Debian kurulumu | Kullanıcı bu klasörle sınırlandırdı; ürün Debian'a kurulacak                                                                                              | Tüm kaynak, script ve çıktı bu klasörde. Debian ortamı **bu klasördeki scriptlerle** oluşturulur, logları/raporları buraya geri yazar. Klasör dışına kalıcı yazma yok. Bkz. Soru #2                                                                                                                                                                            |
| B12 | Çöp kutusu ↔ Samba recycle            | §9 tek davranışa eşlenmeli ama iki ayrı mekanizma var                                                                                                     | Samba `recycle` VFS modülü **kapalı**. Silme, `vfs_full_audit` + fanotify ile yakalanır ve DEPSIS çöp kutusuna ZFS dataset içi `.depsis-trash` taşımasıyla yansıtılır. Tek mekanizma, tek saklama politikası                                                                                                                                                   |

---

## 3. İlk 12 ADR başlığı

| ADR  | Başlık                                                                                     | Faz |
| ---- | ------------------------------------------------------------------------------------------ | --- |
| 0000 | Sürüm temel çizgisi ve doğrulama yöntemi (Debian Stable, ZFS, Samba, PG, Docker)           | 0   |
| 0001 | API/BFF çalışma zamanı seçimi: NestJS/TypeScript vs Rust/Axum                              | 0   |
| 0002 | Monorepo araç zinciri: pnpm workspaces + Turborepo, TS proje referansları                  | 0   |
| 0003 | İş kuyruğu: PostgreSQL `SKIP LOCKED` vs Redis/Valkey                                       | 0   |
| 0004 | Yetki otoritesi ve SMB eşlemesi: DEPSIS ACL kaynak, ZFS NFSv4 ACL uygulama katmanı         | 0   |
| 0005 | Dosya kimliği ve path reconciliation modeli (id + parent_id + inode)                       | 0   |
| 0006 | Sistem aracısı ayrıcalık sınırı ve IPC sözleşmesi (Unix socket, SO_PEERCRED, tiplenmiş op) | 0   |
| 0007 | Depolama soyutlaması: ZFS / Btrfs / Mock adapter arayüzü                                   | 0   |
| 0008 | Devam ettirilebilir yükleme protokolü: tus 1.0 vs özel parçalı protokol                    | 0   |
| 0009 | Oturum ve MFA modeli; WebAuthn'ın ad alanı (RP ID) kısıtı ve faz planı                     | 0   |
| 0010 | Arama mimarisi: `pg_trgm` + FTS, Unicode/Türkçe normalizasyon, içerik indeksleme opsiyonu  | 0   |
| 0011 | Dosya sistemi olay yakalama: fanotify vs inotify + periyodik reconciliation                | 0   |
| 0012 | Geliştirme/test ortamı topolojisi ve ZFS test havuzu stratejisi                            | 0   |

Her ADR: Bağlam → Seçenekler → Karar → Sonuçlar → Geri alma maliyeti bölümlerini içerir.

---

## 4. Faz 0 ve Faz 1 dosya bazlı uygulama planı

### 4.1 Faz 0 — Keşif ve risk azaltma

**Amaç:** Faz 1'de yeniden yazmaya yol açacak her belirsizliği kod yazmadan önce kanıtla.
Faz 0'da ürün özelliği yoktur; iskelet, sözleşme ve PoC vardır.

#### 4.1.1 Depo iskeleti ve araç zinciri

```
package.json                      pnpm workspace kökü, engines, script'ler
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
eslint.config.js  .prettierrc  .editorconfig  .gitignore  .nvmrc
.github/workflows/ci.yml          format→lint→typecheck→unit→integration→e2e→security→build
```

#### 4.1.2 Belgeler

```
docs/plan/phase-0-kickoff.md      (bu dosya)
docs/adr/0000..0012-*.md          13 ADR
docs/threat-model/README.md       STRIDE, varlıklar, saldırgan profilleri
docs/threat-model/trust-boundaries.md
docs/api/README.md
```

#### 4.1.3 Paylaşılan paketler

```
packages/contracts/openapi/depsis.yaml     OpenAPI 3.1 (yalnız Faz 1 uçları)
packages/contracts/src/agent-ipc.ts        Sistem aracısı op şeması (zod), tek kaynak
packages/contracts/src/errors.ts           RFC 9457 Problem Details tipleri
packages/config/src/index.ts               Şema doğrulamalı env yükleyici, secret redaction
packages/observability/src/logger.ts       pino + correlation ID + otomatik secret maskeleme
packages/observability/src/metrics.ts      Prometheus registry
packages/authz/src/resolve.ts              Saf permission resolver (I/O yok → property test edilebilir)
packages/authz/src/nfsv4-map.ts            DEPSIS izni → NFSv4 ACE eşlemesi
packages/ui/src/tokens.ts                  Tasarım token'ları (renk, tipografi, 8px grid, motion)
```

#### 4.1.4 Sistem aracısı iskeleti (Rust)

```
services/system-agent/Cargo.toml
services/system-agent/src/main.rs          Unix socket, SO_PEERCRED, tek eşzamanlı ayrıcalıklı iş
services/system-agent/src/ipc/mod.rs       Tiplenmiş op dispatch; serbest shell KABUL ETMEZ
services/system-agent/src/ops/zfs.rs
services/system-agent/src/ops/samba.rs
services/system-agent/src/ops/smart.rs
services/system-agent/src/audit.rs         Her op: kimlik, sebep, correlation ID, sonuç
services/system-agent/src/backend/mock.rs  Windows/dev için
services/system-agent/src/backend/linux.rs
```

#### 4.1.5 Dağıtım ve ortam

```
deploy/vm/provision-debian.ps1     Debian hedefini bu klasörden oluşturur (Soru #2'ye göre)
deploy/vm/bootstrap.sh             ZFS, Samba, PostgreSQL, Docker kurulumu (sürümler ADR-0000'dan)
deploy/docker/compose.dev.yml      Yalnız dev PostgreSQL
deploy/migrations/0001_init.sql    organizations, users, RLS iskeleti
```

#### 4.1.6 PoC'ler ve Faz 0 çıkış kriterleri

```
tools/poc/zfs-pool.sh          P0-A
tools/poc/samba-acl.sh         P0-B
tools/poc/pg-rls.sql           P0-C
tools/poc/fs-events.rs         P0-D
tools/poc/agent-smoke.ts       P0-E
tools/poc/zt-controller.sh     P0-F
```

| ID   | Kanıtlanacak                        | Geçme ölçütü                                                                                       |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| P0-A | ZFS temel işlemleri                 | Dosya vdev'lerle mirror havuz; dataset, snapshot, send/receive, scrub tamam                        |
| P0-B | **Web–SMB ortak ACL** (§20 zorunlu) | DEPSIS'te verilen izin `smbcacls` çıktısında görünür; Windows istemci aynı sonucu yaşar            |
| P0-C | PostgreSQL RLS                      | A kullanıcısı, ham SQL ile bile B'nin satırlarını göremez                                          |
| P0-D | **Filesystem olayı** (§20 zorunlu)  | SMB üzerinden yazılan dosya, hedef SLA içinde indekse girer                                        |
| P0-E | Ayrıcalık sınırı                    | Aracı serbest komutu reddeder; her op audit kaydı üretir; SO_PEERCRED doğrular                     |
| P0-F | ZeroTier controller                 | Self-hosted controller ağ oluşturur; enrollment token akışı çalışır; **secret hiçbir yanıtta yok** |

> P0-B ve P0-D geçmeden Faz 1'e başlanmaz — bu ikisi mimariyi geri dönülmez biçimde belirler.

### 4.2 Faz 1 — Güvenli çekirdek / MVP

```
apps/api/src/main.ts                      Helmet, CSP, CSRF, rate limit, correlation ID
apps/api/src/auth/                        Argon2id, oturum, TOTP, kurtarma kodu, cihaz listesi
apps/api/src/setup/                       İlk kurulum sihirbazı (tek seferlik, kilitli)
apps/api/src/users/  teams/  rbac/
apps/api/src/files/                       list, folder, rename, move, delete, trash, restore
apps/api/src/uploads/                     Devam ettirilebilir yükleme (ADR-0008)
apps/api/src/download/                    Range + streaming; belleğe tam dosya alma YASAK
apps/api/src/search/                      Debounce dostu, cursor'lu, ACL kapsamlı
apps/api/src/storage/                     Disk keşfi, plan üret, önizle, uygula
apps/api/src/telemetry/                   CPU/RAM/ağ/SMART/ZFS
apps/api/src/audit/                       Append-only
apps/api/src/realtime/                    SSE; job/transfer/telemetry/notification

apps/worker/src/jobs/indexer.ts           fanotify + periyodik reconciliation
apps/worker/src/jobs/file-op.ts           Kopyala/taşı/sil — idempotent, lease'li
apps/worker/src/jobs/trash-gc.ts
apps/worker/src/jobs/upload-gc.ts         Yetim parça temizliği

apps/web/src/routes/setup/                Kurulum sihirbazı
apps/web/src/routes/login/                Giriş + TOTP
apps/web/src/routes/home/                 Widget'lı dashboard
apps/web/src/routes/files/                Liste/ayrıntı/ızgara, çoklu seçim, sürükle-bırak
apps/web/src/routes/system/               Telemetri, diskler, depolama planı
apps/web/src/routes/users/
apps/web/src/lib/api/                     contracts'tan ÜRETİLİR, elle yazılmaz

deploy/migrations/0002_auth.sql .. 0006_audit.sql
```

Her ekran için §0.10 gereği beş durum: happy path, hata, boş, yükleniyor, erişim reddi.

---

## 5. Güvenlik ve veri kaybı açısından ilk 10 risk

| #   | Risk                                                                         | Etki                                           | İlk turdan itibaren uygulanacak azaltma                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Disk rol atama / havuz oluşturma yanlış diski siler**                      | Kalıcı toplam veri kaybı                       | Sadece WWN/serial ile kimlik; asla `/dev/sdX`. Analiz → plan → etkilenen diskleri yaz → seri no'yu elle onayla → yeniden kimlik doğrula → job. Dry-run zorunlu. Onaysız gerçek diskte çalıştırma yok (§22)                   |
| R2  | **Sistem aracısında ayrıcalık yükseltme**                                    | Host tamamen ele geçirilir                     | Serbest shell yok; sadece tiplenmiş op. `execve` + argv dizisi, `sh -c` yok. SO_PEERCRED + allowlist. Aracı ayrı Unix kullanıcısı + systemd hardening                                                                        |
| R3  | **Path traversal / symlink TOCTOU / zip-slip**                               | Rastgele dosya okuma-yazma                     | `openat2(RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS)`, dirfd tabanlı erişim, kullanıcı path'i asla kabuğa gitmez. Property/fuzz testi Faz 0'dan itibaren                                                                           |
| R4  | **Web ACL ile SMB ACL'in ayrışması**                                         | Sessiz yetkisiz erişim                         | Tek otorite (ADR-0004). Her izin değişiminde reconciliation job + drift alarmı. P0-B bunu Faz 0'da kanıtlar                                                                                                                  |
| R5  | **RLS eksikliği / arama üzerinden isim sızıntısı**                           | Kiracılar arası veri sızıntısı                 | Her tenant tablosunda RLS varsayılan DENY. Arama sonucu, sayaç, öneri ve hata metni ACL kapsamından üretilir. §18.2'deki "A, B'nin dosya adını göremez" testi CI'da                                                          |
| R6  | **Upload staging → publish arasında çökme**                                  | Yarım/yetim dosya, kota kayması, korupt içerik | Staging dataset + parça hash + toplam hash + idempotency key. Atomik `renameat2` ile publish. Yetim GC job'ı. Elektrik kesintisi tatbikatı §18.1                                                                             |
| R7  | **PostgreSQL metadata ile ZFS gerçeğinin ayrışması**                         | Görünen dosya yok, var olan dosya görünmez     | Outbox + saga; DB commit'i filesystem işinden önce değil, sonrasında doğrulanır. Periyodik reconciliation her iki yönü de düzeltir ve fark sayısını raporlar                                                                 |
| R8  | **Snapshot'ın yedek sanılması / tek havuz kaybı**                            | Toplam kayıp                                   | UI'da snapshot asla "yedek" demez. Ayrı hedefe replikasyon kurulmadan yedekleme "tamam" gösterilmez. Yedek yaşı widget'ı ve bayat yedek alarmı                                                                               |
| R9  | **Secret sızıntısı** (ZT controller secret, DB parolası, ilk admin parolası) | Ağ ve sistem ele geçirilir                     | Secret'lar root-readable store; loglarda otomatik redaction; frontend bundle'da secret taraması CI aşaması. QR yalnız kısa ömürlü tek kullanımlık token + fingerprint taşır. İlk admin parolası asla loga/config'e düz metin |
| R10 | **Docker socket / privileged container ile host kaçışı**                     | Host ele geçirilir                             | Aracı/policy katmanı; `privileged`, host network, socket mount, geniş capability varsayılan RED. Manifest doğrulama + image digest pinleme + `latest` yasak                                                                  |

Ek olarak izlenecek ama ilk 10'a girmeyenler: decompression bomb (önizleme sandbox'ı), disk %100
dolunca PostgreSQL/ZFS yazma kilidi (rezerv alan), zaman sapması ve sertifika süresi alarmları.

---

## 6. Çalıştırılacak doğrulama ve test komutları

### 6.1 Windows host (her turda)

```bash
corepack enable && corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run build
```

Rust tarafı (rustup kurulumundan sonra):

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all
```

### 6.2 Debian hedefi (Faz 0 PoC kabulü)

```bash
# Gerçek dosya adları ve durumları (bu blok ilk taslakta tahminî isimler taşıyordu):
sudo bash tools/poc/p0-a-zfs-pool.sh          # 57/57 — disk kimliği, havuz, scrub, degraded
sudo bash tools/poc/p0-b-samba-acl.sh         # 17/17 — acltype=posixacl + ACL'in SMB'ye yansıması
sudo bash tools/poc/p0-c-pg-rls.sh            # 45/45 — RLS baypasları ve covert channel
sudo bash tools/poc/p0-d-fs-events.sh         # 38/38 — fanotify FID, full_audit, kimlik kararlılığı
sudo bash tools/poc/p0-g-upload-publish.sh    # 41/41 — EXDEV, atomik publish, kota
sudo bash tools/poc/p0-h-turkish-search.sh    # 22/22 — Türkçe normalizasyon ve indeks seçimi
# P0-E henüz YOK: sistem aracısı Rust kodu yazılmadı, ADR-0006 provisional kalıyor.
```

### 6.3 Entegrasyon, E2E ve güvenlik (CI)

```bash
pnpm run test:integration                          # PG RLS, agent IPC sözleşmesi
pnpm exec playwright test --project=desktop --project=mobile-360
pnpm exec axe-playwright                           # WCAG 2.2 AA
pnpm audit --audit-level=high
pnpm exec gitleaks detect --no-git -s .            # secret taraması (bundle dahil)
cargo deny check
```

Kural: başarısız test gizlenmez, çıktı olduğu gibi raporlanır (§22).

---

## 7. Karar gerektiren sorular (en fazla 5)

**S1 — `DepsisBuilder` WSL dağıtımı.**
`C:\Users\HUAWEI\Desktop\evraks\depos\.wsl-builder` altındaki durdurulmuş dağıtım önceki bir
denemeye ait. Talimatın gereği olarak dokunmadım. Sıfırdan yeni bir Debian ortamı mı kurayım
(önerim: evet), yoksa bu dağıtım temiz sayılıp yeniden mi kullanılsın?

**S2 — Linux doğrulama ortamı.**
Hangisi? (a) WSL2 Debian — hızlı, ama ZFS için özel kernel derlemesi gerekir ve systemd desteği
kısıtlıdır; (b) Hyper-V Debian VM — gerçekçi, snapshot alınabilir, yönetici hakkı ve tek seferlik
kurulum ister (**önerim**); (c) şimdilik yalnız mock, gerçek doğrulama fiziksel NAS donanımına
bırakılsın. Seçim, P0-A/B/D'nin ne zaman kanıtlanabileceğini belirler.

**S3 — API çalışma zamanı (ADR-0001, geri dönüşü pahalı).**
NestJS/TypeScript mi (önerim: sözleşme paylaşımı ve Faz 1 hızı), yoksa Rust/Axum mı
(tek dil, daha düşük kaynak, daha yavaş ilerleme)? Sistem aracısı her iki durumda da Rust.

**S4 — Alan adı ve sertifika.**
DEPSIS için gerçek bir hostname (ör. `nas.ornek.com` veya iç DNS adı) ve güvenilen sertifika
sağlanabilecek mi? Sağlanamazsa WebAuthn/passkey teknik olarak mümkün değildir ve Faz 1'de
MFA yalnız TOTP olur.

**S5 — Açık `deny` izni.**
Faz 1 yalnız "allow + daha dar override" ile mi ilerlesin (önerim: evet, SMB eşlemesindeki
en büyük hata kaynağını kapatır), yoksa açık `deny` baştan gerekli bir iş kuralı mı?

---

---

## 8. Alınan kararlar (2026-08-14, proje sahibi onayı)

| Soru | Karar                                   | Bağlayıcı sonuç                                                                                                                                             |
| ---- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `DepsisBuilder` **kullanılmayacak**     | Sıfırdan temiz bir Debian ortamı kurulur. Önceki denemeye ait hiçbir dosya okunmaz veya kopyalanmaz                                                         |
| S2   | **Hyper-V Debian VM**                   | Gerçek ZFS/Samba/fanotify doğrulaması yapılabilir. WSL2 ZFS kernel sorunu tamamen ortadan kalkar → ADR-0012                                                 |
| S3   | **NestJS + TypeScript**                 | API/BFF TypeScript; sözleşme tipleri web/desktop/mobil ile paylaşılır. Sistem aracısı yine Rust → ADR-0001                                                  |
| S4   | Hostname ve güvenilen sertifika **yok** | **WebAuthn/passkey Faz 1'de teknik olarak imkânsız** (RP ID çıplak IP olamaz). Faz 1 MFA = TOTP. UI bunu "yakında" diye gizlemez, nedenini yazar → ADR-0009 |
| S5   | **Allow-only** yetki modeli             | Faz 1'de açık `deny` yok. Yalnız allow + alt klasörde daha dar izinle override. Faz 2'de yeniden değerlendirilir → ADR-0004                                 |

### 8.1 S4'ün yayılan sonuçları

Hostname/sertifika olmaması yalnız WebAuthn'ı etkilemez. Faz 1 tasarımı şunları da kabul eder:

- **Secure context:** Service Worker ve PWA kurulumu güvenli bağlam ister. Yerel olarak
  güvenilen bir CA ile üretilen sertifika bunu sağlar; kurulum sihirbazı kök sertifikayı
  indirtir ve istemciye kurma adımını **açıkça** anlatır. Sertifika kurulmadıysa UI hangi
  özelliklerin kapalı olduğunu listeler.
- **HSTS:** Alan adı olmadığı için Faz 1'de HSTS gönderilmez (§16 bunu "uygun alan adı
  senaryosunda" diye zaten koşullamış).
- **Cookie:** `Secure` + `HttpOnly` + `SameSite=Lax`; IP tabanlı erişimde çerez kapsamının
  host'a bağlı olduğu ve IP değişiminin oturumu düşüreceği belgelenir.
- **Faz 2 kapısı:** Alan adı sağlandığı anda WebAuthn, HSTS ve otomatik sertifika yenileme
  tek bir yapılandırma değişikliğiyle açılabilecek biçimde kodlanır; sonradan yeniden
  yazım gerekmez.

### 8.2 Ortam doğrulaması (S2 sonrası, ölçüldü)

| Kontrol                                           | Sonuç                                     |
| ------------------------------------------------- | ----------------------------------------- |
| `HypervisorPresent`                               | **True** — Hyper-V etkin ve çalışıyor     |
| `vmms` servisi                                    | **Running / Automatic**                   |
| Hyper-V PowerShell modülü, `vmconnect.exe`        | **Mevcut**                                |
| `HUAWEI` kullanıcısı `Administrators` üyesi mi    | **Evet**                                  |
| Ajanın oturumu yükseltilmiş mi                    | **Hayır** → `Get-VM` erişim reddi veriyor |
| `Hyper-V Yöneticileri` grubu (SID `S-1-5-32-578`) | Var, **boş**                              |

Hyper-V özelliğini **etkinleştirmek gerekmiyor**; yeniden başlatma da gerekmiyor. Tek engel,
ajan oturumunun yükseltilmemiş olması. Bkz. §8.3.

### 8.3 Açık engel — Hyper-V yetkisi

Sanal makine oluşturma ve yönetme yükseltilmiş yetki ister. İki yol var; seçim proje sahibinindir:

**Yol A — kalıcı çözüm (önerilir).** Kullanıcıyı `Hyper-V Yöneticileri` grubuna ekle. Sonrasında
Hyper-V cmdlet'leri yükseltme olmadan çalışır ve tüm proje boyunca otomasyon akıcı olur.
Bu bir **yetki değişikliğidir** ve ajan tarafından yapılmaz; yükseltilmiş bir PowerShell'de
proje sahibi çalıştırır, ardından oturum kapatıp açar:

```powershell
Add-LocalGroupMember -SID 'S-1-5-32-578' -Member $env:USERNAME
```

**Yol B — tek seferlik.** Grup üyeliği değiştirilmez; `deploy/vm/provision-debian.ps1`
yükseltilmiş bir PowerShell'de bir kez elle çalıştırılır. Sonraki tüm etkileşim VM'e SSH
üzerinden olur ve yükseltme gerektirmez.

Yol B ile de tam Faz 0 mümkündür; Yol A yalnız tekrarlayan VM işlemlerini (checkpoint,
disk ekleme/çıkarma, disk-pull tatbikatı) kolaylaştırır.

---

## 9. Faz 0 ilk turu — teslim edilecekler

1. `docs/adr/0000-version-baseline.md` — resmî kaynaklardan doğrulanmış sürüm tablosu
2. Depo iskeleti + araç zinciri + yeşil CI
3. ADR-0001 … ADR-0012
4. `docs/threat-model/`
5. `packages/contracts` — OpenAPI 3.1 iskeleti + agent IPC şeması
6. `deploy/vm/` — Hyper-V Debian VM sağlama script'leri
7. P0-A … P0-F PoC script'leri ve ilk koşu raporları
