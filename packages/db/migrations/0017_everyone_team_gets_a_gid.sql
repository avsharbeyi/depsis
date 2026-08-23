-- 0017 — `everyone_team()` bir gid ayırsın.
--
-- 0016'nın hatası, ve kendi kapattığı deliğin içinde açtığı yeni bir delik.
--
-- `everyone_team()` ekibi `INSERT INTO public.teams (organization_id, name)` ile açıyordu —
-- `posix_gid` kolonu yok, yani NULL. `TeamsService.create` bunu doğru yapıyor
-- (`allocate_posix_id('team')` ile), fonksiyon yapmıyordu.
--
-- Sonucu, uygulama katmanında hiç görünmeyen bir sessizlik. `AclApplyService.gidFor` NULL gid'i
-- görüp bir uyarı yazıyor ve girdiyi ATLIYOR. Taze bir cihazda varsayılan paylaşımın TEK kök
-- grant'ı bu ekibe yazılıyor, yani:
--
--   * veritabanı: "kiracının herkesi bu paylaşımı listeleyip okuyup yazabilir"
--   * dosya sistemi: o paylaşımın kökünde hiçbir ACL girdisi yok
--
-- Web çalışıyor gibi görünür, SMB hiç çalışmaz, ve ikisinin ayrıştığını söyleyen tek şey bir log
-- satırıdır. §6.2'nin ve ADR-0004'ün adıyla yasakladığı iki gerçeklik, tam olarak izin modelini
-- sağlamlaştırmak için yazılmış fonksiyonun içinde.
--
-- Bunu 46 ajanlık bir tarama buldu; elle yapılan gözden geçirme kaçırdı, çünkü fonksiyon "ekip
-- açıyor" diye okunuyor ve `TeamsService.create`'in yanında değil bir migration'ın içinde
-- duruyor.
--
-- ── gid'in NE ZAMAN ayrıldığı ─────────────────────────────────────────────────
--
-- Ekip satırı yazılırken, `TeamsService.create` ile aynı anda. `allocate_posix_id`'nin kendi
-- COMMENT'i bu sırayı istiyor: numara cihaz genelinde bir sayaçtan geliyor ve çağıran onu YAZMAK
-- zorunda, yoksa numara boşa harcanır.
--
-- Ayrılmış olması, dosya sistemine YANSIMIŞ olması demek değil. Grubu ayrıcalıklı taraf yaratana
-- kadar gid rezerve ama uygulanmamış durumda — 0015'in `teams.posix_gid` üzerindeki notu bunu
-- zaten söylüyor. Fark şu ki artık ifade edilebilir bir sayı var; NULL ifade edilemez.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE OR REPLACE FUNCTION public.everyone_team(p_organization_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_team_id uuid;
BEGIN
  SELECT id INTO v_team_id
    FROM public.teams
   WHERE organization_id = p_organization_id
     AND name_fold = public.fold_identity('Herkes');

  IF v_team_id IS NULL THEN
    -- `posix_gid` BURADA, satırla aynı anda. Sonradan doldurmayı bekleyen bir NULL, ACL'i
    -- sessizce atlanan bir ekiptir.
    INSERT INTO public.teams (organization_id, name, posix_gid)
         VALUES (p_organization_id, 'Herkes', public.allocate_posix_id('team'))
      RETURNING id INTO v_team_id;
  ELSIF (SELECT posix_gid FROM public.teams WHERE id = v_team_id) IS NULL THEN
    -- Zaten var ama gid'i yok: 0016'nın açtığı ekipler ve yöneticinin eliyle kurmuş olabileceği
    -- bir 'Herkes' ekibi bu durumda. Doldur.
    UPDATE public.teams
       SET posix_gid = public.allocate_posix_id('team')
     WHERE id = v_team_id;
  END IF;

  -- Kiracının bütün kullanıcıları üye. Zaten üye olanlara dokunulmuyor: yöneticinin eliyle
  -- kurduğu bir 'Herkes' ekibinin üyeliklerini bozmak, bu fonksiyonun işi değil.
  INSERT INTO public.team_members (organization_id, team_id, user_id)
  SELECT p_organization_id, v_team_id, u.id
    FROM public.users AS u
   WHERE u.organization_id = p_organization_id
  ON CONFLICT (organization_id, team_id, user_id) DO NOTHING;

  RETURN v_team_id;
END;
$$;

-- ─── `allocate_posix_id` gerçekten eşzamanlı olsun ────────────────────────────
--
-- 0015'teki hâli `MAX(...) + 1` ve HİÇBİR KİLİT ALMIYOR. İki eşzamanlı işlem aynı maksimumu
-- görüyor, aynı numarayı döndürüyor, ve ikincisi `teams_posix_gid_unique` ya da
-- `users_posix_uid_unique` ile 23505 alıyor. Fonksiyonun kendi COMMENT'i bunu neredeyse birebir
-- tarif ediyor — "uygulama katmanında hesaplanamaz: iki eşzamanlı hesap oluşturma aynı değeri
-- alır" — ama çözüm olarak yalnızca hesabı veritabanına taşımış, yarışı kaldırmamış.
--
-- Bugüne kadar patlamamasının sebebi, aynı anda numara ayıran tek bir yol olmasıydı: yönetici
-- eliyle ekip ya da kullanıcı açması. 0017 `everyone_team()`'e de ayırttırıyor ve o fonksiyon
-- SIRADAN BİR İSTEKTEN çağrılıyor (`FilesService.defaultShare`, ilk `GET /files`), yani artık
-- eşzamanlı ayırma olağan durum. Testler bunu ilk koşuşta yakaladı.
--
-- İşlem kapsamlı bir advisory lock: çağıranlar sıraya giriyor ve kilit COMMIT'te kendiliğinden
-- bırakılıyor. Bir tablo kilidi değil, çünkü kilitlenmesi gereken şey bir satır ya da tablo değil,
-- "bir sonraki numara" kararının kendisi — ve `users` ile `teams`'i birlikte kilitlemek, numarayla
-- hiç ilgisi olmayan her yazmayı da bekletirdi.
--
-- Sabit, `hashtext` değil: `hashtext`'in çıktısı PostgreSQL sürümleri arasında sabit olmak zorunda
-- değil, ve iki farklı sürüm çalıştıran iki bağlantı farklı kilitler alırsa kilit yokmuş gibi olur.
CREATE OR REPLACE FUNCTION public.allocate_posix_id(kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_id integer;
BEGIN
  IF kind NOT IN ('user', 'team') THEN
    RAISE EXCEPTION 'kind must be user or team' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Sıraya gir. İşlem bitene kadar başka hiçbir çağıran bu noktayı geçemez, ve çağıranın dönen
  -- değeri AYNI işlemde yazması zaten şart olduğu için (bu fonksiyonun COMMENT'i) kilit tam olarak
  -- yazma tamamlanana kadar duruyor.
  PERFORM pg_advisory_xact_lock(4919115);

  -- Tek bir sayaç, iki tablo için. uid ve gid uzaylarının ayrı olması gerekmiyor ve ortak
  -- olması, bir kullanıcının uid'i ile bir ekibin gid'inin asla karışmamasını sağlıyor —
  -- `ls -l` çıktısında ikisi yan yana duruyor.
  SELECT COALESCE(MAX(id_value), 299999) + 1 INTO next_id
    FROM (
      SELECT posix_uid AS id_value FROM public.users WHERE posix_uid IS NOT NULL
      UNION ALL
      SELECT posix_gid FROM public.teams WHERE posix_gid IS NOT NULL
    ) AS taken;

  IF next_id > 399999 THEN
    RAISE EXCEPTION 'the reserved POSIX id range is exhausted'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  RETURN next_id;
END
$$;

COMMENT ON FUNCTION public.allocate_posix_id(text) IS
  'Bir sonraki boş POSIX kimliği. Uygulama katmanında hesaplanamaz: iki eşzamanlı hesap '
  'oluşturma aynı değeri alır ve iki kişi birbirinin dosyalarına sahip olur. Çağıran, dönen '
  'değeri AYNI işlem içinde yazmalı. İşlem kapsamlı bir advisory lock ile serileştirilmiştir '
  '(migration 0017) — 0015''teki hâli MAX+1 idi ve hiçbir kilit almıyordu, yani tarif ettiği '
  'yarışın kendisi hâlâ açıktı.';

-- 0016 zaten koşmuş cihazlar. Orada açılan her 'Herkes' ekibinin gid'i NULL ve o paylaşımların
-- ACL'leri boş; bu döngü onları kapatıyor.
--
-- Kullanıcı tarafındaki eşi de burada: `users.posix_uid` NULL olan bir kullanıcıya verilmiş bir
-- grant da aynı şekilde atlanıyor. `PosixIdentityService.posixUidFor` bunu istek anında tembel
-- olarak dolduruyor, ama ACL uygulaması kullanıcının bir istek yapmasını bekleyemez — grant
-- başkası tarafından yazılmış olabilir ve o kullanıcı cihaza hiç bağlanmamış olabilir.
DO $$
DECLARE
  v_team RECORD;
  v_user RECORD;
BEGIN
  FOR v_team IN
    SELECT id FROM public.teams
     WHERE posix_gid IS NULL
       AND EXISTS (SELECT 1 FROM public.folder_grants g WHERE g.team_id = teams.id)
  LOOP
    UPDATE public.teams SET posix_gid = public.allocate_posix_id('team') WHERE id = v_team.id;
  END LOOP;

  FOR v_user IN
    SELECT id FROM public.users
     WHERE posix_uid IS NULL
       AND EXISTS (SELECT 1 FROM public.folder_grants g WHERE g.user_id = users.id)
  LOOP
    UPDATE public.users SET posix_uid = public.allocate_posix_id('user') WHERE id = v_user.id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.everyone_team(uuid) IS
  'Kiracının "Herkes" ekibi, yoksa açarak — ve gid''ini AYIRARAK. Örtük olarak açılan bir '
  'paylaşımın kök grant''ı buna yazılır. gid''siz bir ekip, AclApplyService''in sessizce atladığı '
  've dolayısıyla dosya sistemine hiç ulaşmayan bir izindir (migration 0017).';

-- Down Migration

-- `allocate_posix_id`, 0015'teki kilitsiz hâline. Geri almak yarışı geri getiriyor ve bu bilinçli:
-- bir migration'ın down'u şemayı BULDUĞU hâle döndürmeli, daha iyi bir hâle değil.
CREATE OR REPLACE FUNCTION public.allocate_posix_id(kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_id integer;
BEGIN
  IF kind NOT IN ('user', 'team') THEN
    RAISE EXCEPTION 'kind must be user or team' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(MAX(id_value), 299999) + 1 INTO next_id
    FROM (
      SELECT posix_uid AS id_value FROM public.users WHERE posix_uid IS NOT NULL
      UNION ALL
      SELECT posix_gid FROM public.teams WHERE posix_gid IS NOT NULL
    ) AS taken;

  IF next_id > 399999 THEN
    RAISE EXCEPTION 'the reserved POSIX id range is exhausted'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  RETURN next_id;
END
$$;

COMMENT ON FUNCTION public.allocate_posix_id(text) IS
  'Bir sonraki boş POSIX kimliği. Uygulama katmanında hesaplanamaz: iki eşzamanlı hesap '
  'oluşturma aynı değeri alır ve iki kişi birbirinin dosyalarına sahip olur. Çağıran, dönen '
  'değeri AYNI işlem içinde yazmalı.';

-- 0016'daki hâline, gid ayırmayan sürüme geri dön. Ayrılmış gid'ler GERİ ALINMIYOR: sayaç
-- monoton ve bir numarayı geri vermek, aynı numarayı iki ekibe verme riskidir. Kullanılmamış bir
-- rezervasyon zararsız; yeniden kullanılan bir gid, bir ekibin dosyalarını başka bir ekibe açar.
CREATE OR REPLACE FUNCTION public.everyone_team(p_organization_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_team_id uuid;
BEGIN
  SELECT id INTO v_team_id
    FROM public.teams
   WHERE organization_id = p_organization_id
     AND name_fold = public.fold_identity('Herkes');

  IF v_team_id IS NULL THEN
    INSERT INTO public.teams (organization_id, name)
         VALUES (p_organization_id, 'Herkes')
      RETURNING id INTO v_team_id;
  END IF;

  INSERT INTO public.team_members (organization_id, team_id, user_id)
  SELECT p_organization_id, v_team_id, u.id
    FROM public.users AS u
   WHERE u.organization_id = p_organization_id
  ON CONFLICT (organization_id, team_id, user_id) DO NOTHING;

  RETURN v_team_id;
END;
$$;

COMMENT ON FUNCTION public.everyone_team(uuid) IS
  'Kiracının "Herkes" ekibi, yoksa açarak. Örtük olarak açılan bir paylaşımın kök grant''ı buna '
  'yazılır — kimin erişeceğini kimse seçmediyse, cevap cihazdaki herkestir. ADR-0004 girdilerin '
  'kullanıcıya değil GRUBA verilmesini istiyor: POSIX ACL ~30 girdiden sonra hantallaşıyor, yani '
  'kullanıcı başına bir kök grant iki yüz kullanıcılı bir cihazda dosya sistemi tarafında çöker.';
