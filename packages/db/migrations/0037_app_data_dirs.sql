-- Uygulamanın verisi paylaşımın KÖKÜNDE değil, paylaşımın içinde KENDİ klasöründe durur.
--
-- 0031 Nextcloud'un veri dizinini "kullanıcının seçtiği paylaşım" yaptı ve niyet doğruydu:
-- dosyalar SMB'den de görünsün. İlk gerçek kutu bunun iki kırığını birden ölçtü:
--
--   1. Köksüz podman'da konteynerin servis hesabı (www-data, uid 33) motorun alt-kimliklerine
--      eşlenir, ve paylaşım köküne — root'a ait, aile hesaplarının ACL'leriyle — hiçbir hakkı
--      yoktur. Nextcloud'un girişi `chown data` dedi, `Operation not permitted` aldı, rsync 23
--      ile çıktı, konteyner öldü.
--
--   2. Nextcloud veri dizinini SAHİPLENİR: boş olmasını ister, içine kendi yapısını kurar. Aile
--      dosyalarıyla dolu bir paylaşım kökü ona veri dizini olarak verilemez — izinler çözülse
--      bile kurulum "dizin boş değil" der.
--
-- Çözüm: bağlama artık paylaşımın içinde bir ALT KLASÖRÜ gösterebilir (`subdir`), ve klasörü
-- ajan `prepare_app_data_dir` ile, konteyner-içi kimliğin eşlendiği motor kimliğine ait olarak
-- açar. Klasör SMB'de sıradan bir klasör olarak görünür ("Nextcloud", "Immich"), aile onu okur
-- (paylaşımın varsayılan ACL'leri yeni klasöre kalıtımla iner), uygulama ona yazar.
--
-- `containerUid`/`containerGid` İMAJIN gerçeği: nextcloud-apache'de servis www-data (33),
-- immich-server konteyner root'u olarak koşar (0). Kayıt katalogda — yani yalnız migration
-- yazabilir — çünkü "hangi kimliğe eşlenecek" sorusu imajın kimliğinden gelir, istekten değil.

-- Up Migration

SELECT public.assert_rls_roles_sane();

UPDATE public.app_catalogue_containers AS c
   SET mounts = '[{"target":"/var/www/html/data","mode":"rw",
                   "purpose":"Dosyaların duracağı paylaşım (içinde Nextcloud klasörü açılır)",
                   "subdir":"Nextcloud","containerUid":33,"containerGid":33}]'::jsonb
  FROM public.app_catalogue a
 WHERE c.catalogue_id = a.id AND a.slug = 'nextcloud' AND c.role = 'server';

UPDATE public.app_catalogue_containers AS c
   SET mounts = '[{"target":"/usr/src/app/upload","mode":"rw",
                   "purpose":"Fotoğrafların yedekleneceği paylaşım (içinde Immich klasörü açılır)",
                   "subdir":"Immich","containerUid":0,"containerGid":0}]'::jsonb
  FROM public.app_catalogue a
 WHERE c.catalogue_id = a.id AND a.slug = 'immich' AND c.role = 'server';

-- Down Migration

UPDATE public.app_catalogue_containers AS c
   SET mounts = '[{"target":"/var/www/html/data","mode":"rw",
                   "purpose":"Dosyaların duracağı paylaşım"}]'::jsonb
  FROM public.app_catalogue a
 WHERE c.catalogue_id = a.id AND a.slug = 'nextcloud' AND c.role = 'server';

UPDATE public.app_catalogue_containers AS c
   SET mounts = '[{"target":"/usr/src/app/upload","mode":"rw",
                   "purpose":"Fotoğrafların yedekleneceği paylaşım"}]'::jsonb
  FROM public.app_catalogue a
 WHERE c.catalogue_id = a.id AND a.slug = 'immich' AND c.role = 'server';
