# Mimari Karar Kayıtları (ADR)

Bu dizin, DEPSIS'te geri dönüşü pahalı olan kararları ve **neden** öyle karar verildiğini kaydeder.
Master prompt §0.2 gereği her büyük değişiklikten önce bir ADR yazılır.

## Kurallar

1. **Bir ADR bir karardır.** Birden fazla karar varsa birden fazla ADR yazılır.
2. **ADR'ler değiştirilmez, üzerine yazılır.** Bir karar değişirse eski ADR `Superseded by ADR-XXXX`
   olarak işaretlenir; içeriği düzeltilmez. Yanlış çıkmış bir kararın izi projede kalmalıdır.
3. **Kanıtsız sürüm yazılmaz.** Master prompt §0.4 gereği hiçbir sürüm numarası hafızadan
   yazılamaz. Her sürümün resmî bir kaynak URL'si olmalıdır. Doğrulanamayan bir şey
   `unverified` olarak işaretlenir ve `ADR-0000`'ın "ampirik olarak kanıtlanacaklar"
   listesine düşer.
4. **Belge kanıt değildir.** Bir davranış mimariyi bağlıyorsa (ör. ACL'in gerçekten
   uygulanıp uygulanmadığı), belgeye değil Debian VM'de koşan bir PoC'ye dayanılır.
   Kanıt dosyası `docs/adr/evidence/` altına, koşum çıktısıyla birlikte konur.
5. **Geri alma maliyeti yazılır.** Kararın yanlış çıkması hâlinde ne kadar iş kaybedileceği
   açıkça belirtilir. Bu, hangi kararların önce kanıtlanması gerektiğini belirler.

## Durumlar

| Durum                    | Anlamı                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| `Proposed`               | Yazıldı, henüz onaylanmadı                                                     |
| `Accepted`               | Yürürlükte                                                                     |
| `Accepted (provisional)` | Yürürlükte, ancak bir PoC ile doğrulanması bekleniyor — PoC kimliği belirtilir |
| `Superseded`             | Başka bir ADR tarafından değiştirildi (bağlantı zorunlu)                       |
| `Rejected`               | Değerlendirildi, seçilmedi (neden kaydedilir — aynı tartışma tekrar açılmasın) |

## Dizin

| ADR                                             | Başlık                                                    | Durum                                                                   |
| ----------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| [0000](0000-version-baseline.md)                | Sürüm temel çizgisi ve doğrulama yöntemi                  | **Accepted** (kısmi — 6 konu 2. turda)                                  |
| [0001](0001-api-runtime.md)                     | API/BFF çalışma zamanı: NestJS/TypeScript                 | **Accepted**                                                            |
| [0002](0002-monorepo-toolchain.md)              | Monorepo araç zinciri ve sürüm sabitlemesi                | **Accepted**                                                            |
| [0003](0003-job-queue.md)                       | İş kuyruğu (PostgreSQL `SKIP LOCKED`)                     | **Accepted**                                                            |
| [0004](0004-authz-authority-and-smb-mapping.md) | Yetki otoritesi ve SMB eşlemesi                           | **Accepted (provisional, P0-B)** ⚠️ ilk varsayım çürütüldü              |
| [0005](0005-file-identity.md)                   | Dosya kimliği ve path reconciliation                      | **Accepted (provisional, P0-D)**                                        |
| [0006](0006-system-agent-ipc.md)                | Sistem aracısı ayrıcalık sınırı ve IPC                    | **Accepted (provisional, P0-E)**                                        |
| [0007](0007-storage-abstraction.md)             | Depolama soyutlaması (ZFS/Mock; Btrfs'in gerçek maliyeti) | **Accepted**                                                            |
| [0008](0008-resumable-upload.md)                | Devam ettirilebilir yükleme, atomik yayınlama, kota       | **Accepted (provisional, P0-G)** ⚠️ staging dataset varsayımı çürütüldü |
| [0009](0009-auth-session-mfa.md)                | Oturum ve MFA modeli; WebAuthn RP ID kısıtı               | **Accepted**                                                            |
| [0010](0010-search-architecture.md)             | Arama mimarisi ve Türkçe normalizasyon                    | **Accepted (provisional, P0-H)** ⚠️ ICU collation varsayımı çürütüldü   |
| [0011](0011-filesystem-events.md)               | Dosya sistemi olay yakalama                               | **Accepted (provisional, P0-D)** ⚠️ ilk varsayım tersine çevrildi       |
| [0012](0012-dev-test-environment.md)            | Geliştirme/test ortamı topolojisi                         | **Accepted**                                                            |
| [0013](0013-postgres-version-and-tenancy.md)    | PostgreSQL majör sürümü, RLS ve kiracı yalıtımı           | **Accepted (provisional, P0-C)** ⚠️ iki sessiz RLS baypası bulundu      |

⚠️ = Faz 0 kickoff belgesindeki varsayım araştırmayla çürütüldü. Ayrıntı ADR'nin "Bulunan gerçek"
bölümünde; özet [ADR-0000 §5](0000-version-baseline.md)'te.

## Yeni ADR yazmak

`_template.md` dosyasını kopyala, numarayı sıradaki boş numara yap, bu dizindeki tabloya ekle.
