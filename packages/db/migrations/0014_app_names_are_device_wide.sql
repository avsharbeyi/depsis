-- 0014 — konteyner adları ve portlar cihaz genelinde.
--
-- 0013 uygulama örneklerine kiracı kapsamlı benzersizlik verdi:
--
--     app_instances_container_unique  (organization_id, container_name)
--     app_instances_port_unique       (organization_id, host_port)
--
-- Bu ikisi de yanlış kapsamda ve sebebi aynı: podman'ın isim alanı ve host'un port uzayı
-- CİHAZ GENELİNDE tek. İki kiracı aynı uygulamayı kurduğunda veritabanı ikisine de izin verir
-- ve ikinci `podman create` "name already in use" ile düşer; iki kiracı aynı portu aldığında
-- ikinci konteyner bağlanamaz. Her iki hata da veritabanının doğru dediği bir andan SONRA,
-- ayrıcalıklı tarafta ortaya çıkar — yani kullanıcıya 500 gibi görünür.
--
-- Bunu denetim buldu. Düzeltmenin iki yarısı var ve ikisi birden gerekiyor:
--
--   1. Ad kiracıyı taşısın (uygulama tarafı: `depsis-app-<slug>-<org'un ilk 8 hanesi>`), böylece
--      iki kiracı aynı uygulamayı ÇAKIŞMADAN kurabilsin.
--   2. Port indeksi kiracıyı BIRAKSIN, çünkü port gerçekten cihaz genelinde tek.
--
-- İkincisi bu dosyanın işi.
--
-- Not: `app_instances_port_unique` artık organization_id taşımıyor ve
-- `tools/ci/migration-check.sh`'in benzersizlik denetimi bunu işaretleyecek. İzin listesine
-- eklendi, gerekçesiyle: bu bir kimlik değil, cihazın donanım kaynağı. Buradaki bir 23505 bir
-- kiracıya diğerinin varlığını değil, portun dolu olduğunu söyler — ve zaten söylemek zorunda,
-- çünkü alternatifi ayrıcalıklı tarafta patlayan bir bağlama hatası.

-- Up Migration

SELECT public.assert_rls_roles_sane();

DROP INDEX IF EXISTS public.app_instances_port_unique;
CREATE UNIQUE INDEX app_instances_port_unique ON public.app_instances (host_port);

-- Konteyner adı da cihaz genelinde tek olmalı, aynı gerekçeyle. Ad artık kiracıyı içerdiği için
-- iki kiracının çakışması zaten mümkün değil; bu indeks onu veritabanı düzeyinde de garanti eder
-- ve uygulama tarafındaki adlandırmada bir gerileme olursa sessiz kalmaz.
DROP INDEX IF EXISTS public.app_instances_container_unique;
CREATE UNIQUE INDEX app_instances_container_unique ON public.app_instances (container_name);

-- Ad deseni sekiz haneli onaltılık son eki de kabul etmeli. 0013'ün deseni
-- `^depsis-app-[a-z0-9-]{1,80}$` zaten kabul ediyor — kısıt değişmiyor, ama niyetin okunabilir
-- olması için yazıya dökülüyor.
COMMENT ON COLUMN public.app_instances.container_name IS
  'Podman konteyner adı: depsis-app-<slug>-<organization_id''nin ilk 8 onaltılık hanesi>. '
  'Kiracı eki tesadüfi değil — podman''ın isim alanı cihaz genelinde tek, ve eksiz bir ad iki '
  'kiracının aynı uygulamayı kurmasını ayrıcalıklı tarafta çakıştırırdı (migration 0014).';

-- Down Migration

DROP INDEX IF EXISTS public.app_instances_container_unique;
CREATE UNIQUE INDEX app_instances_container_unique
  ON public.app_instances (organization_id, container_name);

DROP INDEX IF EXISTS public.app_instances_port_unique;
CREATE UNIQUE INDEX app_instances_port_unique
  ON public.app_instances (organization_id, host_port);

COMMENT ON COLUMN public.app_instances.container_name IS NULL;
