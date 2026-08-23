-- 0016 — grant'ı olmayan paylaşım kalmasın.
--
-- `apps/api/src/permissions/legacy-open-share.ts` §6.2 ile birlikte geldi ve şunu söylüyordu:
-- bir paylaşımın HİÇ grant satırı yokken, kiracının her üyesi §6.2 öncesi yedi izni alır.
-- Gerekçesi sağlamdı — ADR-0021'i bugünkü veriye uygulamak her cihazı bomboş bırakırdı, ve
-- kendi dosyalarını listeleyemeyen bir NAS daha sıkı değil, bozuk bir üründür.
--
-- Ama o istisna bir GÜVENLİK AÇIĞIYDI ve denetim bunu kritik olarak işaretledi: geri dönüşü
-- `folder_grants` üzerinde bir VARLIK SORUSU, her istekte yeniden soruluyor. Yani bir
-- paylaşımın son grant'ını silmek, paylaşımı kiracının HERKESİNE yeniden açıyordu. `manage`
-- iznine sahip, yönetici olmayan biri bunu yapabiliyordu. `LastGrantError` o tek yolu kapattı,
-- ama kapı hâlâ oradaydı: sıfır grant'lı bir paylaşım üretebilen her yeni kod yolu onu tekrar
-- açardı.
--
-- Kalıcı çözüm, istisnanın kendi belgesinin yazdığı koşul: **sıfır grant'lı bir paylaşım
-- mümkün olmasın.** Bu dosya o koşulun bugünkü veriye düşen yarısı. Diğer yarısı, paylaşım
-- yaratan İKİ yol — ve ikinci olduğunu fark etmek bu turun asıl bulgusuydu:
--
--   * `POST /shares` — yönetici açar, kök grant onu açana yazılır, paylaşım KAPALI doğar.
--   * `FilesService.defaultShare` — kimse açmaz, ilk istekte kendiliğinden oluşur. Kök grant'ı
--     `everyone_team()`'e yazılır, çünkü kimin erişeceğini kimse seçmedi.
--
-- İkincisi grep'e `INSERT INTO public.shares` diye yazıldığı için ilk aramada görünmedi. Onu
-- düzeltmeden bu migration hiçbir şey garanti etmezdi: taze bir cihazda İLK istek, grant'sız bir
-- paylaşım yaratıp değişmezi aynı saniyede bozardı.
--
-- ── Erişim NEDEN kaybolmuyor ──────────────────────────────────────────────────
--
-- Backfill bugünkü davranışı BİREBİR yeniden üretiyor: grant'sız her paylaşımın köküne, o
-- kiracının bütün üyelerini içeren bir ekip için yedi izin yazılıyor. Yani bu migration'dan
-- önce neyi görebiliyorsan, sonra da onu görüyorsun. Bir migration'ın kimsenin erişimini
-- sessizce KALDIRMAMASI, buradaki tek pazarlıksız kural.
--
-- ── Neden bir EKİP, kullanıcı başına satır değil ──────────────────────────────
--
-- ADR-0004: ACL girdileri kullanıcıya değil GRUBA verilir, çünkü POSIX ACL ~30 girdiden sonra
-- hantallaşıyor ve mask semantiği ısırıyor. İki yüz kullanıcılı bir cihazda kullanıcı başına
-- bir kök grant, paylaşım kökünde iki yüz ACL girdisi demek — yani `AclApplyService` ilk
-- koşuşunda dosya sistemi tarafında çöker. Ekip, o kuralın veritabanı tarafındaki karşılığı.
--
-- ── Ekip SIRADAN bir ekip ─────────────────────────────────────────────────────
--
-- 'Herkes' özel bir tür değil, bayrağı yok, kod onu isimle aramıyor. Yönetici onu yeniden
-- adlandırabilir, içinden kullanıcı çıkarabilir, grant'ını daraltabilir ya da ekibi tamamen
-- silebilir — hepsi arayüzden. Amaç bir "sistem grubu" icat etmek değil, bugünkü örtük kuralı
-- GÖRÜNÜR bir satıra çevirmek. Örtük kural denetlenemez; bir grant satırı denetlenebilir.
--
-- Bundan SONRA açılan kullanıcılar bu ekibe otomatik girmez, ve bu bilinçli. Yeni bir üyeyi
-- otomatik olarak her eski paylaşıma sokmak, erişimi GENİŞLETEN bir otomatizmdir — ADR-0021'in
-- tam olarak engellemek için var olduğu yön. Yeni kullanıcı, her principal gibi, açıkça
-- yetkilendirilir.
--
-- ── Hangi paylaşım bu ekibi alır ──────────────────────────────────────────────
--
-- Ayrım niyette: paylaşımı kim açtıysa erişimi de o seçer.
--
-- `POST /shares` bu ekibi ALMAZ. Bir yönetici oturup paylaşım açıyorsa kime açtığını da
-- söyleyebilir; söylemezse kök grant kendisine yazılır ve paylaşım kapalı doğar. Model değişimi
-- ileriye dönük uygulanır.
--
-- `defaultShare` ALIR. Onu kimse açmadı — ilk `GET /files` isteğinde kendiliğinden oluştu — ve
-- kimsenin seçmediği bir erişimin cevabı, cihazdaki herkestir. Aynı şey bu migration'ın
-- backfill'i için de geçerli: o satırlar da kimsenin izin sorusunu cevaplamadığı bir dönemden
-- kaldı.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── "herkes" ekibi, TEK bir tanımla ──────────────────────────────────────────
--
-- Aynı kural iki yerde lazım: aşağıdaki backfill (bir kez, eski satırlar için) ve API'nin
-- `FilesService.defaultShare`'i (her seferinde, örtük açılan varsayılan paylaşım için). İkisini
-- ayrı ayrı yazmak, ekibin adının iki dilde iki sabit olması demekti — ve birbirinden kaymaları
-- hâlinde ortaya çıkacak şey, grant'ı olmayan bir paylaşım, yani kapatmaya çalıştığımız durumun
-- ta kendisi. O yüzden tanım burada, bir fonksiyonda.
--
-- SECURITY DEFINER DEĞİL. Çağıran neyse o olarak koşuyor, yani RLS aynen geçerli: `depsis_app`
-- bu fonksiyonla ancak kendi kiracısında ekip açabilir. Ayrıcalık yükseltmeye gerek yok, çünkü
-- yapılan iş çağıranın zaten yapabildiği bir INSERT.
--
-- `search_path` yine de sabitlenmiş: fonksiyon gövdesindeki niteliksiz bir ad, çağıranın
-- search_path'indeki bir tabloya düşebilir.
CREATE FUNCTION public.everyone_team(p_organization_id uuid)
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

COMMENT ON FUNCTION public.everyone_team(uuid) IS
  'Kiracının "Herkes" ekibi, yoksa açarak. Örtük olarak açılan bir paylaşımın kök grant''ı buna '
  'yazılır — kimin erişeceğini kimse seçmediyse, cevap cihazdaki herkestir. ADR-0004 girdilerin '
  'kullanıcıya değil GRUBA verilmesini istiyor: POSIX ACL ~30 girdiden sonra hantallaşıyor, yani '
  'kullanıcı başına bir kök grant iki yüz kullanıcılı bir cihazda dosya sistemi tarafında çöker.';

GRANT EXECUTE ON FUNCTION public.everyone_team(uuid) TO depsis_app;

-- ─── bugünkü veri ─────────────────────────────────────────────────────────────
--
-- Kök grant. `entry_id IS NULL` paylaşımın kökü demek; yedi izin, `LEGACY_OPEN_SHARE`'in
-- listesiyle birebir aynı içerikte.
--
-- `manage` YOK, ve bu listenin en önemli eksiği. Geri dönüş de onu vermiyordu: bir paylaşımın
-- ilk grant'ını yazma hakkı yöneticinindir (ADR-0021 §5), ve modelin kendi kendini açmasına
-- izin vermeyen tek bootstrap bu. Bu satır o hakkı devretseydi, kapattığımız açığı başka bir
-- kapıdan geri koymuş olurduk.
--
-- `granted_by` NULL: bunu bir insan yazmadı. Sahte bir yönetici kimliği koymak, denetim
-- kaydında olmamış bir eylem uydurmak olurdu.
INSERT INTO public.folder_grants (organization_id, share_id, entry_id, team_id, permissions)
SELECT s.organization_id,
       s.id,
       NULL,
       public.everyone_team(s.organization_id),
       ARRAY['list', 'read', 'download', 'create', 'modify', 'move', 'delete']
         ::public.folder_permission[]
FROM public.shares AS s
WHERE NOT EXISTS (
  SELECT 1 FROM public.folder_grants AS g WHERE g.share_id = s.id
);

COMMENT ON TABLE public.folder_grants IS
  'ADR-0021. Bir paylaşımın EN AZ BİR grant satırı olmak zorunda: sıfır grant, §6.2 öncesi '
  '"herkes her şeyi görür" davranışına geri düşen bir istisnayı canlı tutuyordu ve o istisna '
  'kritik bir açıktı (migration 0016). Son grant''ı silmeyi API reddeder (LastGrantError) ve '
  'paylaşım açan tek yol olan POST /shares kök grant''ı aynı işlemde yazar.';

-- Down Migration

DROP FUNCTION IF EXISTS public.everyone_team(uuid);

-- Yalnız bu migration'ın yazdığı şekle uyan satırlar: 'Herkes' ekibine ait KÖK grant'lar.
-- Yöneticinin sonradan yazdığı başka grant'lara dokunulmuyor.
DELETE FROM public.folder_grants AS g
USING public.teams AS t
WHERE g.team_id = t.id
  AND g.entry_id IS NULL
  AND t.name_fold = public.fold_identity('Herkes');

DELETE FROM public.team_members AS m
USING public.teams AS t
WHERE m.team_id = t.id
  AND t.name_fold = public.fold_identity('Herkes');

-- Ekibin kendisi, yalnız artık hiçbir grant'ı kalmadıysa. Yönetici bu ekibe başka bir klasörde
-- izin vermişse ekip onun ekibidir ve silmek veri kaybı olur.
DELETE FROM public.teams AS t
WHERE t.name_fold = public.fold_identity('Herkes')
  AND NOT EXISTS (SELECT 1 FROM public.folder_grants AS g WHERE g.team_id = t.id);

COMMENT ON TABLE public.folder_grants IS NULL;
