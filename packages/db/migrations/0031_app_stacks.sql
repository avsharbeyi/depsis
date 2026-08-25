-- Bir uygulama artık BİR konteyner değil.
--
-- 0013 kataloğu tek konteyner varsayarak yazdı ve içine Immich'i koydu. Immich tek konteynerle
-- ÇALIŞMIYOR: `immich-server` açılışta bir PostgreSQL ve bir Redis arıyor, bulamayınca çıkıyor, ve
-- `restart_policy: on-failure` onu üç kez daha deniyor. Yani katalogda, kurulduğunda kesinlikle
-- çalışmayacak bir satır duruyordu — kullanıcıya "kur" düğmesi gösteren, bastığında birkaç yüz
-- megabayt indiren, ve sonra sessizce ölen bir satır. Kapalı görünüp hiçbir şeyi tutmayan bir
-- kapının uygulama kataloğundaki karşılığı.
--
-- İki seçenek vardı: satırı silmek, ya da kataloğu gerçek uygulamaların şekline getirmek. Silmek
-- ucuzdu; ama bir NAS'a fotoğraf yedeklemek bu ürünün var oluş sebeplerinden biri, ve Immich onu
-- yapan şey. Bu migration ikincisini yapıyor.
--
-- SINIR AYNI KALIYOR (ADR-0019). Kullanıcı hâlâ imaj adı yazamıyor; yalnız katalogdan seçiyor, ve
-- katalog hâlâ yalnız migration ile yazılabiliyor. Değişen tek şey, bir katalog satırının BİR imaj
-- yerine SIRALI BİR İMAJ LİSTESİ tarif edebilmesi.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── bir uygulamanın konteynerleri ────────────────────────────────────────────
--
-- Kataloğun tek gerçek temsili. `app_catalogue` üzerindeki `image`/`tag`/`env`/`mounts` kolonları
-- bu migration'ın sonunda DÜŞÜYOR: aynı olguyu iki yerde tutmak, zamanla ikisinin ayrışması ve
-- hangisinin doğru olduğunu kimsenin bilmemesi demek. Tek konteynerli bir uygulama, bu tabloda tek
-- satırı olan bir uygulama.
CREATE TABLE public.app_catalogue_containers (
  id           uuid    PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  catalogue_id uuid    NOT NULL REFERENCES public.app_catalogue (id) ON DELETE CASCADE,

  -- Uygulamanın İÇİNDEKİ adı: `server`, `database`, `cache`. Konteyner adının son parçası oluyor,
  -- yani `podman ps` çıktısında hangi satırın ne olduğu okunabiliyor.
  role         text    NOT NULL,

  -- BAŞLATMA SIRASI. Veritabanı, sunucudan önce.
  --
  -- Ne söz verdiği ve ne söz vermediği önemli: konteynerler bu sırayla başlatılıyor, ama bir
  -- konteynerin başlaması onun HAZIR olması değil. PostgreSQL'in soketi açması bir saniye sürüyor
  -- ve sunucu o aralıkta bağlanmayı deneyebilir. Onu kurtaran şey bu kolon değil, imajların kendi
  -- yeniden deneme döngüleri ve `restart_policy: on-failure`. Sıra, o döngülerin kaç kez dönmesi
  -- gerektiğini azaltıyor; sıfırlamıyor.
  ordinal      integer NOT NULL,

  -- Portu yayımlanan, günlükleri gösterilen, kullanıcının "uygulama" dediği konteyner.
  --
  -- Sırayla aynı şey DEĞİL: Immich'te sunucu en son başlıyor (veritabanı ve önbellek önce) ama
  -- kullanıcının gördüğü şey o.
  is_primary   boolean NOT NULL DEFAULT false,

  image        text    NOT NULL,
  tag          text    NOT NULL,

  -- Sabit ortam değişkenleri, ARTI türetilmiş sırlar için tek bir yer tutucu biçimi:
  -- `${secret:ad}`. Kurulum anında, bu cihazın anahtarından ve (kiracı, uygulama, ad) üçlüsünden
  -- HKDF ile türetilen bir değerle değiştiriliyor.
  --
  -- Neden türetme, neden saklamak değil: veritabanı bir sunucu parolası TUTMUYOR, yani bir
  -- `pg_dump` onu sızdıramıyor; ve türetme deterministik olduğu için konteyner yeniden
  -- yaratıldığında aynı parola çıkıyor — kalıcı birimin içindeki veritabanı açılmaya devam ediyor.
  env          jsonb   NOT NULL DEFAULT '{}'::jsonb,

  -- Kullanıcının seçtiği paylaşımlar. Hedefler bir uygulamanın TAMAMINDA benzersiz (aşağıdaki
  -- indeks), böylece kurulum isteği hâlâ düz bir {target, shareId} listesi olabiliyor ve arayüzün
  -- hangi hedefin hangi konteynere ait olduğunu bilmesi gerekmiyor.
  mounts       jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- Uygulamanın KENDİ durumu: veritabanı dizini, önbellek, model dosyaları. Kullanıcı bunlar için
  -- paylaşım seçmiyor — bir insanın "Immich'in PostgreSQL'i nereye yazsın" sorusuna verebileceği
  -- iyi bir cevap yok. Adlandırılmış podman birimleri, ve kaldırmada SİLİNMİYORLAR.
  -- [{"target":"/var/lib/postgresql/data","purpose":"..."}]
  volumes      jsonb   NOT NULL DEFAULT '[]'::jsonb,

  CONSTRAINT app_catalogue_containers_role_format CHECK (role ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT app_catalogue_containers_tag_not_latest CHECK (tag <> 'latest'),
  CONSTRAINT app_catalogue_containers_ordinal CHECK (ordinal BETWEEN 0 AND 15),
  CONSTRAINT app_catalogue_containers_env_object CHECK (jsonb_typeof(env) = 'object'),
  CONSTRAINT app_catalogue_containers_mounts_array CHECK (jsonb_typeof(mounts) = 'array'),
  CONSTRAINT app_catalogue_containers_volumes_array CHECK (jsonb_typeof(volumes) = 'array')
);

CREATE UNIQUE INDEX app_catalogue_containers_role_unique
  ON public.app_catalogue_containers (catalogue_id, role);

CREATE UNIQUE INDEX app_catalogue_containers_ordinal_unique
  ON public.app_catalogue_containers (catalogue_id, ordinal);

-- TAM BİR TANE birincil. Sıfır olsaydı hangi konteynerin portunun yayımlanacağı belirsiz kalırdı;
-- ikisi olsaydı iki konteyner aynı portu dinlemeye çalışırdı — pod içinde ağ ad alanı ortak, yani
-- ikincisi "address already in use" ile ölürdü.
CREATE UNIQUE INDEX app_catalogue_containers_one_primary
  ON public.app_catalogue_containers (catalogue_id)
  WHERE is_primary;

ALTER TABLE public.app_catalogue_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_catalogue_containers FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_catalogue_containers_owner_full ON public.app_catalogue_containers
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- 0013'teki kardeşiyle aynı gerekçe: herkes okur, kimse yazmaz, ve yazmayı engelleyen şey politika
-- değil GRANT'in olmaması.
CREATE POLICY app_catalogue_containers_readable ON public.app_catalogue_containers
  FOR SELECT TO depsis_app USING (true);

GRANT SELECT ON public.app_catalogue_containers TO depsis_app, depsis_backup;

-- ─── var olanı taşı ───────────────────────────────────────────────────────────
--
-- Beş satırın dördü zaten tek konteyner ve olduğu gibi taşınıyor. Immich taşınmıyor: aşağıda
-- yeniden yazılıyor.
INSERT INTO public.app_catalogue_containers
       (catalogue_id, role, ordinal, is_primary, image, tag, env, mounts)
SELECT id, 'app', 0, true, image, tag, env, mounts
  FROM public.app_catalogue
 WHERE slug <> 'immich';

-- ─── uygulama örnekleri: pod ──────────────────────────────────────────────────
--
-- Bir yığın, bir podman POD'u: konteynerler ağ ad alanını paylaşıyor, yani birbirlerine 127.0.0.1
-- üzerinden ulaşıyorlar ve DEPSIS'in bir konteyner ağı, bir DNS adı ya da bir servis keşfi icat
-- etmesi gerekmiyor. Port eşlemesi pod'un altyapı konteynerinde duruyor — tek yerde, ve hâlâ
-- 127.0.0.1'e bağlı.
--
-- NULL OLABİLİR, ve bu geçmişe saygı: bu migration'dan önce kurulmuş bir uygulama pod'suz, tek bir
-- konteyner olarak duruyor ve öyle sürdürülüyor. Kolonun NULL olması "eski usul kurulum" demek, ve
-- kod iki yolu da biliyor. Alternatif, çalışan kurulumları migration anında yeniden yaratmaktı;
-- bir kullanıcının çalışan Jellyfin'ini bir şema değişikliği uğruna durdurmak.
ALTER TABLE public.app_instances ADD COLUMN pod_name text;

ALTER TABLE public.app_instances
  ADD CONSTRAINT app_instances_pod_name_format
  CHECK (pod_name IS NULL OR pod_name ~ '^depsis-app-[a-z0-9-]{1,80}$');

-- Pod adları da konteyner adları gibi CİHAZ ÇAPINDA benzersiz: podman'ın ad alanı öyle. 0014 aynı
-- kararı konteyner adları için verdi ve gerekçesi burada da aynı — iki kiracı aynı pod adını
-- istediğinde çakışmayı veritabanı reddetmeli, podman değil.
CREATE UNIQUE INDEX app_instances_pod_unique
  ON public.app_instances (pod_name)
  WHERE pod_name IS NOT NULL;

-- ─── Immich, çalışabilecek hâliyle ────────────────────────────────────────────
--
-- Dört konteyner, ve dördü de gerekli. `immich-server` açılışta DB_HOSTNAME'e bağlanıyor ve
-- REDIS_HOSTNAME'i arıyor; ikisi de pod içinde 127.0.0.1. Veritabanı sıradan bir PostgreSQL DEĞİL:
-- Immich benzerlik aramasını vektör indeksleriyle yapıyor ve `pgvecto.rs` uzantısını istiyor, o
-- yüzden imaj `tensorchord/pgvecto-rs`. Makine öğrenmesi konteyneri yüz ve nesne tanımayı yapıyor;
-- onsuz sunucu açılıyor ama arama ve yüz gruplama çalışmıyor.
--
-- DEPSIS'İN KENDİ POSTGRESQL'İ KULLANILMIYOR, bilerek. Bir uygulama konteynerine cihazın kendi
-- veritabanının kimlik bilgilerini vermek, kataloğun sınır olmaktan çıktığı an olurdu.
UPDATE public.app_catalogue
   SET summary = 'Telefonunuzdaki fotoğrafları cihaza yedekleyin. Dört konteyner: sunucu, ' ||
                 'makine öğrenmesi, veritabanı ve önbellek.',
       container_port = 2283
 WHERE slug = 'immich';

INSERT INTO public.app_catalogue_containers
       (catalogue_id, role, ordinal, is_primary, image, tag, env, mounts, volumes)
SELECT c.id, v.role, v.ordinal, v.is_primary, v.image, v.tag, v.env, v.mounts, v.volumes
  FROM public.app_catalogue c
  CROSS JOIN (VALUES
    ('database', 0, false,
     'docker.io/tensorchord/pgvecto-rs', 'pg14-v0.2.0',
     '{"POSTGRES_DB":"immich","POSTGRES_USER":"immich","POSTGRES_PASSWORD":"${secret:db}",
       "POSTGRES_INITDB_ARGS":"--data-checksums"}'::jsonb,
     '[]'::jsonb,
     '[{"target":"/var/lib/postgresql/data","purpose":"Immich veritabanı"}]'::jsonb),

    ('cache', 1, false,
     'docker.io/redis', '6.2-alpine',
     '{}'::jsonb, '[]'::jsonb, '[]'::jsonb),

    ('machine-learning', 2, false,
     'ghcr.io/immich-app/immich-machine-learning', 'v1.119.1',
     '{}'::jsonb, '[]'::jsonb,
     '[{"target":"/cache","purpose":"İndirilen tanıma modelleri"}]'::jsonb),

    ('server', 3, true,
     'ghcr.io/immich-app/immich-server', 'v1.119.1',
     '{"TZ":"Europe/Istanbul","DB_HOSTNAME":"127.0.0.1","DB_PORT":"5432",
       "DB_USERNAME":"immich","DB_DATABASE_NAME":"immich","DB_PASSWORD":"${secret:db}",
       "REDIS_HOSTNAME":"127.0.0.1",
       "IMMICH_MACHINE_LEARNING_URL":"http://127.0.0.1:3003"}'::jsonb,
     '[{"target":"/usr/src/app/upload","mode":"rw",
        "purpose":"Fotoğrafların yedekleneceği paylaşım"}]'::jsonb,
     '[]'::jsonb)
  ) AS v(role, ordinal, is_primary, image, tag, env, mounts, volumes)
 WHERE c.slug = 'immich';

-- ─── tek temsil ───────────────────────────────────────────────────────────────
--
-- Artık her uygulamanın konteynerleri yalnız `app_catalogue_containers` içinde. `container_port`
-- kalıyor: o, POD'un yayımladığı port, yani uygulamanın kendisine ait bir olgu.
ALTER TABLE public.app_catalogue DROP COLUMN image;
ALTER TABLE public.app_catalogue DROP COLUMN tag;
ALTER TABLE public.app_catalogue DROP COLUMN env;
ALTER TABLE public.app_catalogue DROP COLUMN mounts;

-- ─── Nextcloud ────────────────────────────────────────────────────────────────
--
-- Katalogda eksik olan ve en çok istenen şey: dosyalar, takvim, kişiler ve paylaşım bağlantıları.
-- Jellyfin medyayı, Navidrome müziği, Immich fotoğrafı sunuyor; Nextcloud geri kalan her şeyi.
--
-- SQLITE İLE DEĞİL. `nextcloud` imajı SQLite ile tek başına açılıyor ve bu satırı tek konteyner
-- yapmak mümkündü; ama Nextcloud'un kendi belgeleri SQLite'ı yalnız deneme kurulumları için
-- öneriyor, ve birkaç kullanıcıdan sonra kilitlenmeler başlıyor. Bir NAS'ta "deneme kurulumu" diye
-- bir şey yok: insanlar oraya asıl kopyayı koyuyor.
--
-- Veri paylaşımda, gerisi birimde. Nextcloud'un belgelediği ayrıntılı bağlama düzeni bu:
-- `/var/www/html` imajdan geliyor ve sürüm yükseltmesinde yenileniyor, `config` ile `custom_apps`
-- kalıcı, `data` ise kullanıcının seçtiği paylaşımda — yani SMB üzerinden de görünen yerde.
INSERT INTO public.app_catalogue (slug, name, summary, icon, container_port)
VALUES ('nextcloud', 'Nextcloud',
        'Dosyalar, takvim, kişiler ve paylaşım bağlantıları. İki konteyner: sunucu ve veritabanı.',
        '☁', 80);

INSERT INTO public.app_catalogue_containers
       (catalogue_id, role, ordinal, is_primary, image, tag, env, mounts, volumes)
SELECT c.id, v.role, v.ordinal, v.is_primary, v.image, v.tag, v.env, v.mounts, v.volumes
  FROM public.app_catalogue c
  CROSS JOIN (VALUES
    ('database', 0, false,
     'docker.io/postgres', '16.9-alpine',
     '{"POSTGRES_DB":"nextcloud","POSTGRES_USER":"nextcloud",
       "POSTGRES_PASSWORD":"${secret:db}","POSTGRES_INITDB_ARGS":"--data-checksums"}'::jsonb,
     '[]'::jsonb,
     '[{"target":"/var/lib/postgresql/data","purpose":"Nextcloud veritabanı"}]'::jsonb),

    ('server', 1, true,
     'docker.io/nextcloud', '31.0.5-apache',
     '{"POSTGRES_HOST":"127.0.0.1","POSTGRES_DB":"nextcloud","POSTGRES_USER":"nextcloud",
       "POSTGRES_PASSWORD":"${secret:db}"}'::jsonb,
     '[{"target":"/var/www/html/data","mode":"rw",
        "purpose":"Dosyaların duracağı paylaşım"}]'::jsonb,
     '[{"target":"/var/www/html/config","purpose":"Nextcloud ayarları"},
       {"target":"/var/www/html/custom_apps","purpose":"Kurulan Nextcloud uygulamaları"},
       {"target":"/var/www/html/themes","purpose":"Temalar"}]'::jsonb)
  ) AS v(role, ordinal, is_primary, image, tag, env, mounts, volumes)
 WHERE c.slug = 'nextcloud';

-- Bir uygulamanın EN AZ bir, ve TAM BİR birincil konteyneri olmalı. CHECK bunu ifade edemiyor
-- (başka bir tabloya bakıyor), o yüzden bir trigger: kataloğa konteynersiz bir satır ekleyen bir
-- migration, o satırı arayüzde "kur" düğmesiyle ama hiçbir imajla göstermiş olurdu.
CREATE OR REPLACE FUNCTION public.app_catalogue_needs_a_container() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_catalogue_containers
                  WHERE catalogue_id = NEW.id AND is_primary) THEN
    RAISE EXCEPTION 'app_catalogue row % (%) has no primary container', NEW.id, NEW.slug
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$fn$;

-- ERTELENMİŞ, ve bu şart: katalog satırı önce ekleniyor, konteynerleri ona atıfla sonra.
-- Ertelenmemiş bir trigger her INSERT'i reddederdi.
CREATE CONSTRAINT TRIGGER app_catalogue_has_containers
  AFTER INSERT ON public.app_catalogue
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.app_catalogue_needs_a_container();

-- Down Migration

DROP TRIGGER app_catalogue_has_containers ON public.app_catalogue;
DROP FUNCTION public.app_catalogue_needs_a_container();

ALTER TABLE public.app_catalogue ADD COLUMN image text NOT NULL DEFAULT '';
ALTER TABLE public.app_catalogue ADD COLUMN tag   text NOT NULL DEFAULT '';
ALTER TABLE public.app_catalogue ADD COLUMN env    jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.app_catalogue ADD COLUMN mounts jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.app_catalogue a
   SET image = c.image, tag = c.tag, env = c.env, mounts = c.mounts
  FROM public.app_catalogue_containers c
 WHERE c.catalogue_id = a.id AND c.is_primary;

DELETE FROM public.app_instances
 WHERE catalogue_id IN (SELECT id FROM public.app_catalogue WHERE slug = 'nextcloud');
DELETE FROM public.app_catalogue WHERE slug = 'nextcloud';

UPDATE public.app_catalogue
   SET summary = 'Telefonunuzdaki fotoğrafları cihaza yedekleyin.',
       image = 'ghcr.io/immich-app/immich-server', tag = 'v1.119.1',
       env = '{"TZ":"Europe/Istanbul"}'::jsonb,
       mounts = '[{"target":"/usr/src/app/upload","mode":"rw",
                   "purpose":"Fotoğrafların yedekleneceği paylaşım"}]'::jsonb
 WHERE slug = 'immich';

ALTER TABLE public.app_catalogue ALTER COLUMN image DROP DEFAULT;
ALTER TABLE public.app_catalogue ALTER COLUMN tag   DROP DEFAULT;

ALTER TABLE public.app_catalogue ADD CONSTRAINT app_catalogue_tag_not_latest CHECK (tag <> 'latest');
ALTER TABLE public.app_catalogue ADD CONSTRAINT app_catalogue_mounts_array
  CHECK (jsonb_typeof(mounts) = 'array');
ALTER TABLE public.app_catalogue ADD CONSTRAINT app_catalogue_env_object
  CHECK (jsonb_typeof(env) = 'object');

DROP INDEX public.app_instances_pod_unique;
ALTER TABLE public.app_instances DROP CONSTRAINT app_instances_pod_name_format;
ALTER TABLE public.app_instances DROP COLUMN pod_name;

DROP TABLE public.app_catalogue_containers;
