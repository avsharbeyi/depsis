-- 0061 — `depsis_backup` gerçekten okuduğu şeyi okusun, okumadığı sanılan şeyi okumasın.
--
-- Bu rolün iki ucu da yanlıştı, ve ikisi de aynı belgeye — `docs/operations/03-yedekleme.md` —
-- yanlış bir cümle yazdırıyordu.
--
-- ── BİR: KOLON DÜZEYİ `REVOKE` TABLO DÜZEYİ `GRANT`I DARALTMIYOR ─────────────────────────────
--
-- 0019 SMB kimlik bilgisini ekledikten sonra şunu yazdı:
--
--   REVOKE SELECT (nt_hash, nt_hash_key_version) ON public.users FROM depsis_backup;
--
-- Ama 0001:349'daki `GRANT SELECT ON public.users TO depsis_backup` TABLO düzeyinde duruyor.
-- PostgreSQL'de yetki, tablo ACL'i ile kolon ACL'inin BİRLEŞİMİ: tablo düzeyinde verilmiş bir
-- SELECT, kolon düzeyinde bir REVOKE ile daralmıyor — o REVOKE yalnız kolon düzeyinde verilmiş
-- bir yetkiyi geri alabilir, ve öyle bir yetki hiç verilmemişti. Yani ifade hiçbir şey yapmadı ve
-- `nt_hash` (ve hiç konuşulmamış olan `password_hash`) o günden beri bu role açık.
--
-- Düzeltmesi, tabloyu geri alıp kolonları TEK TEK vermek. Listede olmayan bir kolon eklendiğinde
-- otomatik açılmıyor — bu bilinçli: yeni bir sır ekleyen göç, onu kapatmayı unutmakla değil,
-- açmayı unutmakla hata yapsın.
--
-- ── İKİ: POLİTİKASI OLMAYAN `GRANT` SIFIR SATIR OKUYOR ───────────────────────────────────────
--
-- 0007, 0008, 0012, 0013, 0015, 0023, 0032, 0035, 0036, 0044, 0047 bu role yirmi tablo üzerinde
-- SELECT verdi. Hepsinde satır seviyesi güvenlik açık ve politikalar YALNIZ `depsis_owner` ile
-- `depsis_app` için yazılmış. `depsis_backup` NOBYPASSRLS (bootstrap.sql) ve tabloların sahibi
-- değil, yani kendisine uyan bir politika yoksa RLS varsayılan olarak kapalı düşüyor: sorgu hata
-- vermiyor, sıfır satır dönüyor. 0007'nin "yedek rolü history'yi görsün" ve 0012'nin "notlar
-- hariç her şeyi görsün" kararları bu yüzden hiç uygulanmamıştı.
--
-- Politikalar 0001'in `organizations_backup_read` kalıbında ve YALNIZ SELECT: bu rolün yazma
-- yetkisi hiçbir tabloda yok, ve politikanın `FOR ALL` olması olmayan bir yetkiyi genişletmez ama
-- okuyanı yanıltır.
--
-- ── NEYE POLİTİKA YAZILMIYOR, VE NEDEN ───────────────────────────────────────────────────────
--
-- İzin veren politikalar OR'lanıyor. Bu yüzden 0003, 0004 ve 0021'in bilinçli `USING (false)`
-- satırlarına dokunulmuyor: oturum jetonu özetleri, TOTP sırları, kurtarma kodları ve parola
-- sıfırlama biletleri bu rolde OKUNAMAZ kalmalı, ve oralara bir `USING (true)` eklemek tam da
-- 0003'ün "yedek, her giriş yapmış kullanıcı için tekrar saldırısı malzemesi taşımasın" kararını
-- geri alırdı.
--
-- `license` de aynı kefede, ve bu YENİ bir karar: `license.token` cihazın imzalı lisans belgesi,
-- yani taşıyıcı bir kimlik. Rapor dökümünde işi yok. Kolon düzeyinde bir politika olmadığı için
-- (RLS satır seviyesinde çalışıyor) tek dürüst hâli tabloyu bu role kapalı tutmak — ve kapalılık
-- şimdiden yazılı bir karar olsun diye, 0003'ün kalıbında açık bir `USING (false)` konuyor.
--
-- ── BU DÖKÜMÜ GERİ YÜKLENEBİLİR YAPMIYOR ─────────────────────────────────────────────────────
--
-- Yirmi dört tabloya bu role hiç SELECT verilmedi (`notes`, `notifications`, görevlerin alt
-- tabloları, uygulama kataloğu, `job_queue`, `index_queue`, kurulum satırı…). Bu göç onları
-- açmıyor: rolün işi rapor, ve geri yüklenebilir döküm `depsis_owner` ile alınıyor. Belgedeki
-- tablo buna göre düzeltildi.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── 1. users: tablo yerine kolonlar ─────────────────────────────────────────────────────────

REVOKE SELECT ON public.users FROM depsis_backup;

-- `password_hash`, `nt_hash` ve `nt_hash_key_version` LİSTEDE YOK. Zarf mühürlü (0019) ama mühür
-- ikinci savunma katmanı; argon2 özeti ise çevrimdışı kırılabilir ve mührü yok.
GRANT SELECT (
  id,
  organization_id,
  email,
  email_normalized,
  username,
  username_folded,
  role,
  posix_uid,
  disabled_at,
  created_at,
  updated_at
) ON public.users TO depsis_backup;

-- 0019'un etkisiz kalan ifadesi artık gerçekten bir şey ifade ediyor: kolon düzeyinde verilmiş
-- bir yetki olmadığı için bu satır yeniden bir no-op, ama yukarıdaki listeyle birlikte okununca
-- niyeti belgeliyor. Bilerek TEKRARLANMIYOR — yanlış olan ifade değil, dayandığı varsayımdı.

-- ─── 2. sırsız tablolara okuma politikası ────────────────────────────────────────────────────

CREATE POLICY job_history_backup_read ON public.job_history
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY shares_backup_read ON public.shares
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY file_entries_backup_read ON public.file_entries
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY upload_sessions_backup_read ON public.upload_sessions
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY tasks_backup_read ON public.tasks
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY snapshots_backup_read ON public.snapshots
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY console_sessions_backup_read ON public.console_sessions
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY app_instances_backup_read ON public.app_instances
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY remote_networks_backup_read ON public.remote_networks
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY teams_backup_read ON public.teams
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY team_members_backup_read ON public.team_members
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY folder_grants_backup_read ON public.folder_grants
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY organization_settings_backup_read ON public.organization_settings
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY backup_schedules_backup_read ON public.backup_schedules
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY remote_members_backup_read ON public.remote_members
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY audit_events_backup_read ON public.audit_events
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY backup_targets_backup_read ON public.backup_targets
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY backup_bases_backup_read ON public.backup_bases
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY backup_runs_backup_read ON public.backup_runs
  FOR SELECT TO depsis_backup USING (true);

CREATE POLICY disk_labels_backup_read ON public.disk_labels
  FOR SELECT TO depsis_backup USING (true);

-- ─── 3. lisans: açıkça kapalı ────────────────────────────────────────────────────────────────

CREATE POLICY license_backup_denied ON public.license
  FOR SELECT TO depsis_backup USING (false);

COMMENT ON POLICY license_backup_denied ON public.license IS
  '`license.token` cihazın imzalı lisans belgesi, yani taşıyıcı bir kimlik: rapor dökümünde işi '
  'yok. 0041 tablo üzerinde SELECT verdi ama politika yazmadı, yani sonuç bugün de sıfır satır — '
  'bu politika o sonucu KARAR hâline getiriyor, tesadüf olmaktan çıkarıyor.';

-- Down Migration

DROP POLICY IF EXISTS license_backup_denied ON public.license;

DROP POLICY IF EXISTS disk_labels_backup_read ON public.disk_labels;
DROP POLICY IF EXISTS backup_runs_backup_read ON public.backup_runs;
DROP POLICY IF EXISTS backup_bases_backup_read ON public.backup_bases;
DROP POLICY IF EXISTS backup_targets_backup_read ON public.backup_targets;
DROP POLICY IF EXISTS audit_events_backup_read ON public.audit_events;
DROP POLICY IF EXISTS remote_members_backup_read ON public.remote_members;
DROP POLICY IF EXISTS backup_schedules_backup_read ON public.backup_schedules;
DROP POLICY IF EXISTS organization_settings_backup_read ON public.organization_settings;
DROP POLICY IF EXISTS folder_grants_backup_read ON public.folder_grants;
DROP POLICY IF EXISTS team_members_backup_read ON public.team_members;
DROP POLICY IF EXISTS teams_backup_read ON public.teams;
DROP POLICY IF EXISTS remote_networks_backup_read ON public.remote_networks;
DROP POLICY IF EXISTS app_instances_backup_read ON public.app_instances;
DROP POLICY IF EXISTS console_sessions_backup_read ON public.console_sessions;
DROP POLICY IF EXISTS snapshots_backup_read ON public.snapshots;
DROP POLICY IF EXISTS tasks_backup_read ON public.tasks;
DROP POLICY IF EXISTS upload_sessions_backup_read ON public.upload_sessions;
DROP POLICY IF EXISTS file_entries_backup_read ON public.file_entries;
DROP POLICY IF EXISTS shares_backup_read ON public.shares;
DROP POLICY IF EXISTS job_history_backup_read ON public.job_history;

REVOKE SELECT (
  id,
  organization_id,
  email,
  email_normalized,
  username,
  username_folded,
  role,
  posix_uid,
  disabled_at,
  created_at,
  updated_at
) ON public.users FROM depsis_backup;

GRANT SELECT ON public.users TO depsis_backup;
