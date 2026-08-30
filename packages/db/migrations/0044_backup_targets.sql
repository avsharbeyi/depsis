-- Yedek diski: hedefin kendisi, turların geçmişi, ve altı saatlik zincir.
--
-- ── BU TABLOLARIN VAR OLMA NEDENİ ────────────────────────────────────────────────────────────
--
-- Cihazın sahibi yedeklemeyi şöyle tarif etti: *"dosya depolamaya düşer 6 saatte bir yedek
-- döngüsü döner yeni dosya varsa yedekleme atar. depolamadan silinen dosya yedekten 30 gün sonra
-- silinir. ... yedek diski tıpkı ana depolama gibi olmalı ama dosyalara yedekleme kısmından
-- erişilmeli. sistem diski ve depolama diski yansa bile yedek diski eğer şifre biliniyorsa
-- kullanılabilir olmalı."*
--
-- Son cümle bu dosyanın şeklini belirliyor.
--
-- ── BU TABLOLAR OTORİTE DEĞİL, ÖNBELLEK ──────────────────────────────────────────────────────
--
-- "Bu dosya ne zaman silindi" sorusunun cevabı BURADA DEĞİL. O bilgi yedek diskinin üstünde,
-- klasör adlarında duruyor:
--
--     /yedek/DEPSIS-YEDEK/silinenler/2026-08-30/Belgeler/vergi.pdf
--
-- Dizinin ADI silinme tarihi. Temizlik turu süresi dolanı o addan okuyor, bu tablodan değil.
--
-- Sebep doğrudan sahibinin son cümlesinden geliyor: PostgreSQL sistem diskinde. Defteri buraya
-- koymak, "sistem diski yansa bile kullanılabilir" cümlesini yazdığı anda yalanlamak olurdu —
-- disk açılır, dosyalar görünür, ama hangisinin silinmiş olduğu ve ne zaman silindiği kaybolur.
--
-- İkinci bir sebep var ve ürünün bugünkü hâlinden geliyor: SMB'den silinen bir dosyanın tarihi
-- hiçbir yerde kaydedilmiyor. Uzlaştırma satırı diskte bulamayınca siliyor, geriye mezar taşı
-- kalmıyor. Yani var olan deftere dayanmak, OLMAYAN bir bilgiye dayanmak olurdu.
--
-- Buradaki satırlar HIZLIDIR, doğru değil: ekran "1 Ağustos'ta silinen 14 dosya, 2 gün sonra
-- kalıcı silinecek" derken buradan okuyor, ama silme kararını diskteki dizin adı veriyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── yedek hedefi ─────────────────────────────────────────────────────────────
--
-- CİHAZ BAŞINA BİR TANE, ve tekliği veritabanı zorluyor. İki yedek diski desteklemek, "yedeğim
-- var mı" sorusunun cevabını ikiye bölerdi; bir ev cihazında o soru tek cümlelik olmalı.
CREATE TABLE public.backup_targets (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  -- Yedek havuzunun adı. Altındaki iki veri kümesinin adları ajanda sabit (`aciklama`, `veri`),
  -- yani burada tutulmuyor: onları buraya yazmak, ajanın bildiği bir şeyi ikinci kez ve
  -- eskiyebilecek biçimde söylemek olurdu.
  pool            text        NOT NULL,

  -- Kullanıcının verdiği ad — "Ev", "Ofis yedeği". Ekranda bu görünüyor, havuz adı değil.
  -- Diskin şifresiz yarısındaki `disk.json` da bunu taşıyor, çünkü yanmış cihaz senaryosunda
  -- ekranda görünecek tek insan sözcüğü bu.
  label           text        NOT NULL,

  -- Kaç saatte bir tur dönüyor. Sahibinin verdiği sayı 6 ve varsayılan o.
  --
  -- Alt sınır bir saat: yarım saatte bir dönen bir tur, bir öncekinin bitmediği bir kutuda
  -- kuyruğu kendi kendine dolduruyor. Üst sınır bir hafta; ondan seyrek bir yedek, "yedeğim var"
  -- cümlesini kuran birini yanıltacak kadar eski olabilir.
  cadence_hours   smallint    NOT NULL DEFAULT 6
                  CHECK (cadence_hours BETWEEN 1 AND 168),

  -- SİLİNEN BİR DOSYA YEDEKTE KAÇ GÜN DURUYOR. Sahibinin sözü: "30 gün sistem önerisi, süre
  -- kullanıcı tarafından seçilebilir olmalı."
  --
  -- Alt sınır bir gün, ve sıfır KABUL EDİLMİYOR: sıfır, silinen dosyanın aynı turda yedekten de
  -- gitmesi demek — yani yanlışlıkla silmeye karşı hiçbir koruma bırakmayan bir ayna. Bunu bir
  -- ayar olarak sunmak, kullanıcıya kendi korumasını kapatmanın kolay yolunu vermek olurdu.
  retain_days     smallint    NOT NULL DEFAULT 30
                  CHECK (retain_days BETWEEN 1 AND 3650),

  -- KURTARMA KİPİ. Bu hedef yalnız OKUNUYOR mu?
  --
  -- Ev yandı, disk yeni bir cihaza takıldı. Kullanıcı dosyalarını görüyor ve — en doğal şey —
  -- eskisiyle aynı adla bir paylaşım açıyor. Bir sonraki tur, o paylaşımda henüz olmayan HER ŞEYİ
  -- "silinmiş" sayıp otuz günlük sayaca koyardı: yedeğin tamamı bir fitile bağlanmış olurdu.
  --
  -- Bu yüzden yeni bir cihaza takılan disk kurtarma kipinde açılıyor — kopyalama ve silme YOK,
  -- yalnız okuma ve geri getirme — ve kullanıcı açıkça "bu cihaz artık bu diski yedekliyor"
  -- diyene kadar öyle kalıyor.
  recovery_only   boolean     NOT NULL DEFAULT false,

  -- Diskin şifresiz yarısındaki `disk.json`da yazan cihaz kimliği. Farklıysa disk BAŞKA bir
  -- cihazın yedeği ve kurtarma kipi devreye giriyor.
  device_id       text,

  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- CİHAZ BAŞINA TEK HEDEF.
CREATE UNIQUE INDEX backup_targets_one_per_org
  ON public.backup_targets (organization_id);

ALTER TABLE public.backup_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_targets FORCE  ROW LEVEL SECURITY;

CREATE POLICY backup_targets_owner_full ON public.backup_targets
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY backup_targets_tenant ON public.backup_targets
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_targets TO depsis_app;
GRANT SELECT ON public.backup_targets TO depsis_backup;

-- ─── paylaşım başına artımlı taban ────────────────────────────────────────────
--
-- Tur, "neyin değiştiğini" bir önceki turun anlık görüntüsüyle karşılaştırarak buluyor. O
-- görüntünün adı burada duruyor, paylaşım başına.
--
-- AYRI BİR TABLO, `backup_targets`ta bir sütun değil: paylaşımlar geliyor gidiyor, ve her biri
-- kendi tabanını kendi ritminde ilerletiyor. Yeni açılan bir paylaşımın tabanı yok, o yüzden ilk
-- turunda ağacı baştan yürüyor — ötekiler yürümüyor.
CREATE TABLE public.backup_bases (
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  share_id        uuid        NOT NULL REFERENCES public.shares (id) ON DELETE CASCADE,

  -- Bir önceki turun anlık görüntüsünün adı. NULL ise bu paylaşım hiç yedeklenmedi ve sıradaki
  -- tur tam yürüyüş yapacak.
  --
  -- BAŞARISIZLIKTA DÜŞÜRÜLMÜYOR. Eski çoğaltma kodu tam bunu yapıyordu: bir tur düştüğünde tabanı
  -- NULL'a çekiyor, ertesi tur her şeyi baştan gönderiyor, o da düşüyor, ve döngü hiçbir zaman
  -- yedek üretmiyordu. Düşen bir tur, bir önceki turun bıraktığı sağlam tabanı bozmuyor.
  base_snapshot   text,

  -- Bu paylaşımın en son ne zaman başarıyla yedeklendiği. Ekrandaki "son yedek" cümlesi.
  last_success_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organization_id, share_id)
);

ALTER TABLE public.backup_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_bases FORCE  ROW LEVEL SECURITY;

CREATE POLICY backup_bases_owner_full ON public.backup_bases
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY backup_bases_tenant ON public.backup_bases
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_bases TO depsis_app;
GRANT SELECT ON public.backup_bases TO depsis_backup;

-- ─── tur geçmişi ──────────────────────────────────────────────────────────────
--
-- Ekranın "son tur ne yaptı" cümlesi ve "yedeğiniz bayatladı" uyarısı buradan besleniyor.
--
-- Bir turun SESSİZCE düşmesi, yedeği olduğunu sanan birinin olmadığını ancak ihtiyaç duyduğu gün
-- öğrenmesi demek. Bu tablo o günü öne çekiyor.
CREATE TABLE public.backup_runs (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  target_id       uuid        NOT NULL REFERENCES public.backup_targets (id) ON DELETE CASCADE,

  -- `zamanli` | `elle` — kullanıcının bastığı düğme mi, zincirin kendisi mi.
  trigger         text        NOT NULL CHECK (trigger IN ('zamanli', 'elle')),

  -- `calisiyor` | `bitti` | `dustu` | `kilitli` | `yer-yok`
  --
  -- `kilitli` BİR HATA DEĞİL ve ayrı bir durum olması bu yüzden: parola hiçbir yere yazılmıyor,
  -- yani cihaz her açıldığında disk kilitli oluyor. Bunu "düştü" saymak, olağan bir hâli her
  -- elektrik kesintisinden sonra bir arıza gibi göstermek olurdu.
  --
  -- `yer-yok` da ayrı: kullanıcının yapacağı şey farklı (disk değiştirmek ya da saklama süresini
  -- kısaltmak), ve yeniden denemek dolu diske yarım dosyalar park etmekten başka bir şey yapmaz.
  state           text        NOT NULL
                  CHECK (state IN ('calisiyor', 'bitti', 'dustu', 'kilitli', 'yer-yok')),

  copied_files    integer     NOT NULL DEFAULT 0,
  copied_bytes    bigint      NOT NULL DEFAULT 0,
  -- Silinenlere TAŞINAN dosya sayısı. Silinen değil: bu turda hiçbir şey kalıcı silinmiyor.
  moved_files     integer     NOT NULL DEFAULT 0,
  -- Temizlik turunun kalıcı sildiği dosya sayısı — süresi dolan gün klasörlerinden.
  purged_files    integer     NOT NULL DEFAULT 0,

  -- Ajanın kendi cümlesi. Kullanıcıya AYNEN gösteriliyor: "beklenmeyen hata" diyen bir ekran,
  -- sahada teşhisi ancak SSH ile mümkün kılıyordu.
  error           text,

  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX backup_runs_recent
  ON public.backup_runs (organization_id, started_at DESC);

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY backup_runs_owner_full ON public.backup_runs
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY backup_runs_tenant ON public.backup_runs
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_runs TO depsis_app;
GRANT SELECT ON public.backup_runs TO depsis_backup;

-- ─── zincir ───────────────────────────────────────────────────────────────────
--
-- İki iş türü, iki ayrı ritim, iki ayrı kısmi tekil indeks.
--
-- ELLE BAŞLATILAN TUR AYRI BİR TÜR, ve bu bir tasarım hatasının düzeltilmesi. Tek bir tür
-- olsaydı, zincirin tekilliğini koruyan indeks — aynı anda yalnız bir tur kuyrukta olabilir —
-- kullanıcının "Şimdi yedek al" düğmesini de engellerdi: zincir gereği her zaman tam olarak bir
-- `queued` satır var, yani düğme hiçbir zaman iş kuyruğa koyamazdı. Ayrı tür, hem zincirin
-- tekilliğini hem düğmeyi koruyor.
--
-- `queued` üzerinde KISMİ, `running`i kapsamıyor: kapsasaydı işleyicinin kendi ardılını kuyruğa
-- alması çakışır ve zincir hiç ilerlemezdi. 0027 ve 0032 aynı cümleyi yazıyor, çünkü aynı hatayı
-- iki kez yapmamanın yolu onu her yerde yazmak.
CREATE UNIQUE INDEX job_queue_one_scheduled_backup_run
  ON public.job_queue (organization_id)
  WHERE kind = 'storage.backup.run' AND status = 'queued';

CREATE UNIQUE INDEX job_queue_one_scheduled_backup_purge
  ON public.job_queue (organization_id)
  WHERE kind = 'storage.backup.purge' AND status = 'queued';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_backup_purge;
DROP INDEX IF EXISTS public.job_queue_one_scheduled_backup_run;
DELETE FROM public.job_queue
  WHERE kind IN ('storage.backup.run', 'storage.backup.run.now', 'storage.backup.purge');
DROP TABLE IF EXISTS public.backup_runs;
DROP TABLE IF EXISTS public.backup_bases;
DROP TABLE IF EXISTS public.backup_targets;
