-- Açılışta "bu kutuda hangi kiracılar var" sorulabilsin.
--
-- ── SAHADAN GELEN ARIZA ──────────────────────────────────────────────────────────────────────
--
-- Cihazın sahibi ağ sürücüsünden yazdığı dosyaların arayüzde görünmediğini bildirdi. Cihaza
-- bakıldığında iş kuyruğu TAMAMEN BOŞTU ve dizin turu en son iki buçuk saat önce koşmuştu.
-- Açılışta zinciri tohumlaması gereken kod çalışmış, hiçbir hata vermemiş, ve hiçbir şey
-- eklememişti.
--
-- Sebebi şuydu:
--
--   `IndexerService.onModuleInit` kiracıları `withoutTenant` ile sayıyor —
--   `SELECT id FROM public.organizations` — yani KİRACI BAĞLAMI OLMADAN.
--   `organizations` üzerindeki `depsis_app` politikası `id = current_organization_id()`.
--   Bağlam yokken bu NULL, yani sorgu SIFIR SATIR döndürüyor.
--
-- Döngü hiç dönmüyor, hiçbir iş kuyruğa girmiyor, ve hata da yok — çünkü boş bir liste bir hata
-- değil. RLS tam olarak tasarlandığı gibi davranıyor (bağlamsız sorgu kapalı düşüyor); yanlış
-- olan, kiracıya ait bir tabloya kiracı olmadan sormak.
--
-- ── VE BU TEK BİR YERDE DEĞİLDİ ──────────────────────────────────────────────────────────────
--
-- Aynı kalıp altı yerde vardı, ve her biri kendini yeniden zamanlayan bir ZİNCİRİN başlangıcı:
--
--   files.reconcile / files.index-drain   `organizations`
--   storage.backup.run                    `backup_targets`
--   storage.backup-tick                   `backup_schedules`
--   tasks.overdue-sweep                   `tasks`
--   files.trash.purge                     `organization_settings`
--   remote.authorize (kurucu kimliği)     `organizations`
--
-- Yani ürünün kendini zamanlayan HER zinciri, gerçek bir cihazda açılışta hiç başlamıyordu.
-- Bugüne kadar çalışıyor görünmelerinin sebebi, zincirlerin bir kez başladıktan sonra kendilerini
-- sürdürmesiydi: ilk halka bir yerden geldiğinde (bir paylaşım oluşturma, elle bir tetikleme)
-- zincir aylarca yaşıyor, ve bir kez koptuğunda bir daha hiç başlamıyor.
--
-- ── NEDEN BİR FONKSİYON, NEDEN POLİTİKA GEVŞETİLMİYOR ────────────────────────────────────────
--
-- `organizations` üzerindeki kiracı politikası DOĞRU ve gevşetilmemeli: bir kiracının başka bir
-- kiracının varlığını öğrenmesi, P0-C'nin ölçtüğü varlık sızıntısının ta kendisi.
--
-- Sorulan soru ise kiracının sorusu değil KUTUNUN sorusu: "açılışta hangi kiracılar için zincir
-- kurmalıyım". Bunun için `resolve_organization_by_slug`un kalıbı zaten var — kiracı bağlamı
-- HENÜZ YOKKEN cevaplanması gereken bir soruyu, sahibin ayrıcalığını tek bir sütun için ödünç
-- alarak cevaplayan bir SECURITY DEFINER fonksiyonu.
--
-- Bu da öyle: yalnız kimlikleri veriyor, başka hiçbir sütunu, ve tek çağıranı açılış.
--
-- ── NE SIZDIRMIYOR ───────────────────────────────────────────────────────────────────────────
--
-- Kimliği ELDE TUTMAK satırı okunabilir yapmıyor: `organizations` politikası yerinde duruyor ve
-- `resolve_organization_by_slug`un kendi kapısında ölçülen şey de buydu. Bir kiracının bu
-- fonksiyonu çağırıp öğrenebileceği tek şey, kutuda kaç kiracı olduğu — ve iki kiracılı bir
-- kutuda o sayı zaten yönetim ekranının konusu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE OR REPLACE FUNCTION public.all_organization_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT id FROM public.organizations ORDER BY created_at;
$$;

REVOKE ALL ON FUNCTION public.all_organization_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.all_organization_ids() TO depsis_app;

COMMENT ON FUNCTION public.all_organization_ids() IS
  'Açılışta "hangi kiracılar var" sorusunun cevabı. Kiracı bağlamı HENÜZ YOKKEN sorulması '
  'gerekiyor: kendini zamanlayan her zincir (dizin turu, yedek turu, gecikme taraması, çöp '
  'budama) ilk halkasını burada kuruyor, ve bağlamsız bir `SELECT ... FROM organizations` RLS '
  'altında sıfır satır döndüğü için o zincirler gerçek bir cihazda hiç başlamıyordu. Yalnız '
  'kimlikler dönüyor; satırın kendisi hâlâ kiracı politikasının arkasında.';

-- Down Migration

DROP FUNCTION IF EXISTS public.all_organization_ids();
