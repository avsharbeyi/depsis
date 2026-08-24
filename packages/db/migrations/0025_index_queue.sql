-- 0025 — SMB'nin söylediklerinin biriktiği yer.
--
-- 0024 mutabakatı getirdi: paylaşım başına on beş dakikada bir, diski veritabanıyla karşılaştıran
-- bir yürüyüş. Doğru ama GEÇ, ve §5.3 bir SLA istiyor — çeyrek saat bir SLA değil.
--
-- ADR-0011'in birinci katmanı Samba'nın kendi `full_audit` modülü: bir istemci bir şeyi
-- değiştirdiği anda, kendi sürecinde, kullanıcı adı ve istemci adresiyle, sıfır çekirdek
-- yetkisiyle söylüyor. Bu tablo o satırların indirdiği yer.
--
-- ── Neden bir tablo, doğrudan indeksleme değil ────────────────────────────────
--
-- Okuyucu ile indeksleyici ayrı süreçler ve ayrı hızlarda. Bir dosya kopyalama on bin `close`
-- olayı üretebilir; her birini anında bir ajan çağrısına çevirmek, kontrol soketini boğar ve
-- kullanıcı arayüzünü durdurur. Kuyruk, patlamayı düzleştirdiği gibi süreç yeniden başlatmasına
-- da dayanıyor: rsyslog satırı yazdıysa olay kaybolmaz.
--
-- ── Neden DİZİN, dosya değil ──────────────────────────────────────────────────
--
-- Kayıt edilen şey olayın adlandırdığı dosyanın ÜST DİZİNİ. Uzlaştırma zaten bir dizini bir kerede
-- karşılaştırıyor, ve bir dizindeki elli değişiklik tek bir satıra çöküyor. Dosya bazlı bir kuyruk
-- aynı işi elli kez yapardı.
--
-- `renameat` iki ucu birden veriyor; okuyucu ikisinin de üst dizinini yazıyor. Silme+yaratma
-- olarak değil — ama uzlaştırma açısından ikisi de "şu dizine tekrar bak" demek.
--
-- ── Neden benzersiz ───────────────────────────────────────────────────────────
--
-- (organizasyon, paylaşım, yol) üzerinde birincil anahtar. Bir dizine yüz kez yazılırsa tek satır
-- kalıyor ve `seen_at` ilerliyor — kuyruk, olay sayısıyla değil DEĞİŞEN DİZİN sayısıyla büyüyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.index_queue (
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  share_id        uuid        NOT NULL REFERENCES public.shares (id) ON DELETE CASCADE,

  -- Paylaşım köküne göre, '/' ile birleştirilmiş. Boş dize paylaşımın kökü demek.
  --
  -- Metin, `text[]` değil: birincil anahtarın parçası ve bir dizi anahtarda karşılaştırma
  -- semantiğini gereksiz yere incelikli yapardı. Okuyucu bileşenlere bölmeyi zaten yapıyor.
  path            text        NOT NULL,

  -- En son ne zaman haber geldi. Sıralama buna göre: en eski değişiklik önce indekslenir, yoksa
  -- sürekli yazılan bir dizin sırayı sonsuza kadar tutabilirdi.
  seen_at         timestamptz NOT NULL DEFAULT now(),

  -- Kim ve nereden. §16 denetim izine parola ya da içerik koymuyor; kullanıcı adı ve istemci
  -- adresi ikisi de ad, içerik değil — ve "bu dosyayı kim değiştirdi" sorusunun tek cevabı.
  actor           text,
  client          text,

  PRIMARY KEY (organization_id, share_id, path),

  CONSTRAINT index_queue_path_length CHECK (length(path) <= 4096)
);

COMMENT ON TABLE public.index_queue IS
  'ADR-0011 Katman 1: Samba full_audit''in bildirdiği DEĞİŞEN DİZİNLER. Dosya değil dizin, ve '
  '(org, share, path) benzersiz — kuyruk olay sayısıyla değil değişen dizin sayısıyla büyür.';

CREATE INDEX index_queue_seen_at ON public.index_queue (organization_id, seen_at);

ALTER TABLE public.index_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.index_queue FORCE  ROW LEVEL SECURITY;

CREATE POLICY index_queue_owner_full ON public.index_queue
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY index_queue_tenant_isolation ON public.index_queue
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.index_queue TO depsis_app;

-- Yedek rolü bunu okumaz: geçici bir çalışma kuyruğu, kurtarılacak bir durum değil.
REVOKE ALL ON public.index_queue FROM depsis_backup;

-- ─── kuyruğu boşaltan iş ──────────────────────────────────────────────────────
--
-- 0023 ve 0024'ün aynı deseni ve aynı gerekçesi: kendi ardılını kuyruğa alan bir iş, ve
-- `ON CONFLICT DO NOTHING`'in çakışacağı bir indeks. Yalnız `queued` — `running` de kapsansaydı
-- işleyicinin kendi ardılı çakışır ve zincir hiç ilerlemezdi.
CREATE UNIQUE INDEX job_queue_one_scheduled_drain
  ON public.job_queue (organization_id, kind)
  WHERE kind = 'files.index-drain' AND status = 'queued';

-- Down Migration

DROP INDEX IF EXISTS public.job_queue_one_scheduled_drain;
DROP TABLE IF EXISTS public.index_queue;
