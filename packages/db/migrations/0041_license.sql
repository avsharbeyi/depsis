-- Cihazın lisansı.
--
-- TEK SATIR, ve tekliği veritabanı zorluyor: `id boolean PRIMARY KEY CHECK (id)` ile ikinci bir
-- satır yazılamıyor. Alternatif — "en son eklenen geçerlidir" — iki lisansın aynı anda durduğu ve
-- hangisinin geçerli olduğunu okuyan tarafın karar verdiği bir tablo demek olurdu; o karar iki
-- ayrı yerde iki farklı biçimde yazılır.
--
-- KİRACIYA BAĞLI DEĞİL. Lisans CİHAZI kapsıyor, bir organizasyonu değil: kutuyu satın alan taraf
-- kutunun sahibi, ve içindeki organizasyonlar onun kendi düzeni. Bu yüzden tabloda org kolonu yok.
--
-- JETONUN KENDİSİ DE SAKLANIYOR (`token`), yalnız ayrıştırılmış alanlar değil. Sebebi: imzayı
-- yeniden doğrulayabilmek. Alanlar bir kolona yazılıp jeton atılsaydı, "bu satır gerçekten
-- imzalanmış bir lisanstan mı geldi" sorusunun cevabı kalmazdı — ve o soru, veritabanına yazma
-- yetkisi olan birinin kendine lisans uydurup uyduramayacağı sorusudur.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.license (
  -- Tek satır kilidi.
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  -- İmzalı jetonun tamamı, geldiği gibi.
  token        text        NOT NULL,
  -- Jetonun içinden okunan alanlar. Burada duruyorlar ki bir sorgu için jetonu her seferinde
  -- ayrıştırmak gerekmesin; DOĞRUNUN KAYNAĞI yine de `token`.
  license_id   text        NOT NULL,
  licensed_to  text        NOT NULL,
  plan         text,
  seats        integer,
  issued_at    timestamptz NOT NULL,
  -- NULL = süresiz. Bir "hiç dolmayacak" tarihi yazmak, o tarihe gelindiğinde açıklanamayan bir
  -- arıza üretir.
  expires_at   timestamptz,
  installed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.license IS
  'Cihazın lisansı. Tek satır; doğrunun kaynağı imzalı `token`, diğer kolonlar ondan okundu.';

ALTER TABLE public.license ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.license FORCE  ROW LEVEL SECURITY;

CREATE POLICY license_owner_full ON public.license
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- Uygulama rolü okur ve yazar: lisansı kuran uç, kurucu yöneticinin isteğiyle bu rolden geçiyor.
-- Yazma yetkisinin kendisi bir güvenlik sınırı DEĞİL — imza öyle. Bu tabloya satır yazabilen biri
-- geçersiz bir jeton yazabilir, ve okuyan taraf onu her açılışta yeniden doğruladığı için o satır
-- "geçersiz lisans" olarak görünür.
CREATE POLICY license_app_full ON public.license
  FOR ALL TO depsis_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.license TO depsis_app;
GRANT SELECT ON public.license TO depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.license;
