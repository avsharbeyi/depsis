-- 0013 — konsol, uygulamalar, uzak erişim.
--
-- Üç özellik, üç ADR: 0018 (yönetici konsolu), 0019 (uygulama kataloğu), 0020 (ZeroTier). Tek
-- migration'da olmalarının sebebi, üçünün de aynı cümlenin sonucu olması: cihazın sahibi
-- arayüzde görünüp çalışmayan şeylerin çalışmasını istedi.
--
-- Bu üçünde ortak olan bir tehlike var ve tabloların şekli ona göre: hepsi cihazın DIŞINDAKİ bir
-- şeyi kontrol ediyor — bir kabuk, bir konteyner çalışma zamanı, bir ağ. Veritabanı bunların
-- hiçbirinin gerçeğin kaynağı değil; kaydı, sınırı ve denetimi.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── konsol oturumları ────────────────────────────────────────────────────────
--
-- ADR-0018. Konsol ayrı bir servis ve baytları veritabanından geçmiyor; buradaki satırlar
-- DENETİM kaydı: kim, ne zaman, ne kadar süreyle bir kabuk açtı.
--
-- Bir yönetici konsolunun kaydı tutulmuyorsa, cihazda olan bir şeyin kim tarafından yapıldığı
-- sorusunun cevabı yoktur. Kabuğu olan her sistemin bu soruyu cevaplayabilmesi gerekir.
CREATE TABLE public.console_sessions (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  -- SET NULL değil RESTRICT: bir denetim kaydının kime ait olduğu, hesap silindi diye
  -- kaybolmamalı. Hesabı silmek isteyen önce kaydı arşivlemek zorunda kalır, ki doğru sıra bu.
  user_id         uuid        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,

  -- Ayrıcalıklı kipte mi açıldı. ADR-0018'de varsayılan kapalı ve birim dosyasından açılıyor;
  -- hangi oturumların root olduğunu sonradan bilmek, denetimin yarısı.
  privileged      boolean     NOT NULL DEFAULT false,

  opened_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  -- 'user' kullanıcı kapattı, 'idle' boşta kalma süresi doldu, 'max_age' üst sınır,
  -- 'shutdown' servis durdu, 'error' beklenmedik son.
  close_reason    text,

  CONSTRAINT console_sessions_close_pair
    CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CONSTRAINT console_sessions_close_reason
    CHECK (close_reason IS NULL OR close_reason IN ('user', 'idle', 'max_age', 'shutdown', 'error'))
);

-- Açık oturumları bulmak: konsol servisi yeniden başladığında hepsini kapatmak için, ve bir
-- yöneticinin "şu an kimin kabuğu açık" sorusu için.
CREATE INDEX console_sessions_open
  ON public.console_sessions (organization_id, opened_at DESC)
  WHERE closed_at IS NULL;

ALTER TABLE public.console_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.console_sessions FORCE  ROW LEVEL SECURITY;

CREATE POLICY console_sessions_owner_full ON public.console_sessions
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY console_sessions_tenant_isolation ON public.console_sessions
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- Girilen her satır. ÇIKTI YOK, ve bu bilinçli: bir `cat /etc/shadow`'un çıktısını denetim
-- günlüğüne kopyalamak, sırrı bir yerden alıp başka bir yere koymaktır. Ne çalıştırıldığını
-- bilmek, çıktısını saklamadan da yeterli.
CREATE TABLE public.console_commands (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  session_id      uuid        NOT NULL REFERENCES public.console_sessions (id) ON DELETE CASCADE,

  at              timestamptz NOT NULL DEFAULT now(),
  line            text        NOT NULL,

  -- Bir yapıştırma kazası ya da bozuk bir istemci, bu tabloyu sınırsız büyütmesin.
  CONSTRAINT console_commands_bounded CHECK (length(line) <= 8192)
);

CREATE INDEX console_commands_by_session ON public.console_commands (session_id, at);

ALTER TABLE public.console_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.console_commands FORCE  ROW LEVEL SECURITY;

CREATE POLICY console_commands_owner_full ON public.console_commands
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY console_commands_tenant_isolation ON public.console_commands
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── uygulama kataloğu ────────────────────────────────────────────────────────
--
-- ADR-0019. Bu tablo bir SINIR: kullanıcı imaj adı yazamaz, yalnız buradan seçer. Serbest imaj
-- adı, kullanıcının internetten indirilen keyfi kodu çalıştırabilmesi ve ona istediği host
-- yolunu bağlayabilmesi demektir.
--
-- Kiracıya ait DEĞİL — ürün verisi. Bir uygulamanın var olduğu bilgisi kiracılar arası bir sır
-- değil, ve her kiracı için satırı kopyalamak aynı listeyi n kez tutmak olurdu.
--
-- Migration ile tohumlanır ve `depsis_app` üzerinde YALNIZCA SELECT yetkisi vardır. Yönetici bu
-- tabloyu düzenleyemez; düzenleyebilseydi sınır olmazdı. Yeni uygulama eklemek bir migration.
CREATE TABLE public.app_catalogue (
  id          uuid    PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  slug        text    NOT NULL,
  name        text    NOT NULL,
  summary     text    NOT NULL,
  -- Sabitlenmiş imaj ve etiket. `latest` KULLANILMAZ: bir gün çalışan bir uygulamanın ertesi
  -- gün sessizce başka bir sürüme geçmesi, bir NAS'ta veri kaybının ucuz yollarından biri.
  image       text    NOT NULL,
  tag         text    NOT NULL,
  icon        text    NOT NULL DEFAULT '🧩',

  -- Konteynerin içinde dinlediği port. Host tarafı çalışma anında seçilir ve 127.0.0.1'e
  -- bağlanır (ADR-0019).
  container_port integer NOT NULL,

  -- Hangi paylaşım yollarının bağlanabileceği. Katalogda tarif edilmeyen bir yol bağlanamaz.
  -- [{"target":"/media","mode":"ro","purpose":"..."}]
  mounts      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  -- Sabit ortam değişkenleri. Kullanıcıdan gelen değer buraya karışmaz.
  env         jsonb   NOT NULL DEFAULT '{}'::jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_catalogue_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT app_catalogue_tag_not_latest CHECK (tag <> 'latest'),
  CONSTRAINT app_catalogue_port_range CHECK (container_port BETWEEN 1 AND 65535),
  CONSTRAINT app_catalogue_mounts_array CHECK (jsonb_typeof(mounts) = 'array'),
  CONSTRAINT app_catalogue_env_object   CHECK (jsonb_typeof(env) = 'object')
);

-- Kiracı kapsamı olmayan bilinçli bir benzersizlik. `tools/ci/migration-check.sh` içindeki
-- denetimin izin listesine eklendi ve gerekçesi şu: bu tablo kiracı verisi değil, ürün verisi.
-- Buradaki bir 23505, bir kiracıya diğeri hakkında hiçbir şey söylemez — yalnızca kataloğa aynı
-- uygulamayı iki kez koymaya çalışan migration'a hata verir.
CREATE UNIQUE INDEX app_catalogue_slug_unique ON public.app_catalogue (slug);

ALTER TABLE public.app_catalogue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_catalogue FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_catalogue_owner_full ON public.app_catalogue
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

-- Herkes okur, kimse yazmaz. Yazmayı engelleyen şey bu politika değil, GRANT'in olmaması —
-- ikisi birden, çünkü tek başına politika bir gün gevşetilirse yetki hâlâ yok.
CREATE POLICY app_catalogue_readable ON public.app_catalogue
  FOR SELECT TO depsis_app USING (true);

-- ─── kurulu uygulamalar ───────────────────────────────────────────────────────
--
-- Gerçeğin kaynağı podman'dır, bu tablo değil. Burada duran şey, DEPSIS'in hangi konteyneri
-- hangi katalog satırı için oluşturduğu — yani bir konteyner adını bir uygulamaya bağlayan
-- eşleme. Durum (çalışıyor/durdu) her sorguda podman'dan okunur; bir kolona yazılsaydı, cihaz
-- yeniden başladığında yalan söylerdi.
CREATE TABLE public.app_instances (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  catalogue_id    uuid        NOT NULL REFERENCES public.app_catalogue (id) ON DELETE RESTRICT,
  installed_by    uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  -- Podman'daki konteyner adı. DEPSIS üretir ve tahmin edilebilir olmasını ister: bir operatör
  -- `podman ps` çıktısında hangi satırın neye ait olduğunu görebilmeli.
  container_name  text        NOT NULL,
  -- 127.0.0.1 üzerinde bağlanılan port.
  host_port       integer     NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT app_instances_container_name CHECK (container_name ~ '^depsis-app-[a-z0-9-]{1,80}$'),
  CONSTRAINT app_instances_port_range CHECK (host_port BETWEEN 1024 AND 65535)
);

-- Bir uygulama bir kiracıda bir kez kurulur. İki Jellyfin, iki kez aynı porta bağlanmaya çalışan
-- iki konteyner demek.
CREATE UNIQUE INDEX app_instances_one_per_app
  ON public.app_instances (organization_id, catalogue_id);

-- Aynı port iki uygulamaya verilemez.
CREATE UNIQUE INDEX app_instances_port_unique
  ON public.app_instances (organization_id, host_port);

CREATE UNIQUE INDEX app_instances_container_unique
  ON public.app_instances (organization_id, container_name);

CREATE TRIGGER app_instances_set_updated_at
  BEFORE UPDATE ON public.app_instances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.app_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_instances FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_instances_owner_full ON public.app_instances
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY app_instances_tenant_isolation ON public.app_instances
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── uzak erişim ağları ───────────────────────────────────────────────────────
--
-- ADR-0020. Gerçeğin kaynağı yine dışarıda — `zerotier-one` daemon'u. Bu tablo, hangi ağa kimin
-- ne zaman katıldığının kaydı: bir cihazı bir ağa sokmak, onu o ağdaki herkese görünür kılmaktır
-- ve bunun kim tarafından yapıldığı sorulabilmeli.
CREATE TABLE public.remote_networks (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  joined_by       uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  -- ZeroTier ağ kimliği: tam 16 onaltılık hane. Ajan tarafında da kendi tipiyle doğrulanıyor;
  -- burada da kısıt var çünkü bir yol parçası olarak birleştirilecek bir değerin iki yerde
  -- doğrulanması, bir yerde unutulmasından ucuz.
  network_id      text        NOT NULL,
  -- Kullanıcının verdiği ad. ZeroTier'in kendi ad alanı ağ yöneticisine ait ve boş olabilir.
  label           text,

  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,

  CONSTRAINT remote_networks_id_format CHECK (network_id ~ '^[0-9a-f]{16}$')
);

-- Aynı ağa iki kez katılmış görünmemek için, ama AYRILMIŞ kayıtlar duruyor: tekrar katılmak
-- yeni bir satır ve denetim geçmişi korunuyor.
CREATE UNIQUE INDEX remote_networks_active_unique
  ON public.remote_networks (organization_id, network_id)
  WHERE left_at IS NULL;

ALTER TABLE public.remote_networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_networks FORCE  ROW LEVEL SECURITY;

CREATE POLICY remote_networks_owner_full ON public.remote_networks
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY remote_networks_tenant_isolation ON public.remote_networks
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── katalog tohumu ───────────────────────────────────────────────────────────
--
-- Beş uygulama, hepsi bir NAS'ta gerçekten çalıştırılan şeyler. Etiketler sabitlenmiş; `latest`
-- kısıt tarafından reddediliyor.
--
-- Bağlama noktaları paylaşım göreli: `target` konteynerin içindeki yol, host tarafı kullanıcının
-- seçtiği paylaşım. Katalogda olmayan bir hedef bağlanamaz.
INSERT INTO public.app_catalogue (slug, name, summary, image, tag, icon, container_port, mounts, env) VALUES
  ('jellyfin', 'Jellyfin', 'Film ve dizi kitaplığınızı her cihazda oynatın.',
   'docker.io/jellyfin/jellyfin', '10.10.7', '🎬', 8096,
   '[{"target":"/media","mode":"ro","purpose":"İzlenecek dosyaların bulunduğu paylaşım"},
     {"target":"/config","mode":"rw","purpose":"Jellyfin''in kendi ayarları"}]'::jsonb,
   '{"TZ":"Europe/Istanbul"}'::jsonb),

  ('navidrome', 'Navidrome', 'Müzik arşivinizi tarayıcıdan ve telefondan dinleyin.',
   'docker.io/deluan/navidrome', '0.55.2', '🎵', 4533,
   '[{"target":"/music","mode":"ro","purpose":"Müzik paylaşımı"},
     {"target":"/data","mode":"rw","purpose":"Dizin ve oynatma geçmişi"}]'::jsonb,
   '{"ND_LOGLEVEL":"info"}'::jsonb),

  ('immich', 'Immich', 'Telefonunuzdaki fotoğrafları cihaza yedekleyin.',
   'ghcr.io/immich-app/immich-server', 'v1.119.1', '📷', 2283,
   '[{"target":"/usr/src/app/upload","mode":"rw","purpose":"Fotoğrafların yedekleneceği paylaşım"}]'::jsonb,
   '{"TZ":"Europe/Istanbul"}'::jsonb),

  ('syncthing', 'Syncthing', 'Klasörleri cihazlar arasında sürekli eşitleyin.',
   'docker.io/syncthing/syncthing', '1.29.2', '🔄', 8384,
   '[{"target":"/var/syncthing","mode":"rw","purpose":"Eşitlenecek paylaşım"}]'::jsonb,
   '{}'::jsonb),

  ('qbittorrent', 'qBittorrent', 'Torrent indirmelerini cihaz üzerinden yönetin.',
   'docker.io/linuxserver/qbittorrent', '5.0.3', '⬇', 8080,
   '[{"target":"/downloads","mode":"rw","purpose":"İndirilenler paylaşımı"},
     {"target":"/config","mode":"rw","purpose":"qBittorrent ayarları"}]'::jsonb,
   '{"TZ":"Europe/Istanbul","WEBUI_PORT":"8080"}'::jsonb);

-- ─── grants ───────────────────────────────────────────────────────────────────
--
-- `app_catalogue` üzerinde SELECT ve YALNIZCA SELECT. Bu satır, kataloğun bir sınır olmasını
-- sağlayan şeyin ta kendisi: uygulama rolü katalog satırı ekleyemediği için, kullanıcı da
-- keyfi bir imaj çalıştıramaz.
GRANT SELECT ON public.app_catalogue TO depsis_app, depsis_backup;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.console_sessions, public.console_commands, public.app_instances, public.remote_networks
  TO depsis_app;

-- Kimlik kolonu bir dizi kullanıyor ve INSERT onu ilerletebilmeli.
GRANT USAGE, SELECT ON SEQUENCE public.console_commands_id_seq TO depsis_app;

-- Yedek rolü konsol geçmişini görebilir (denetim kaydı, sır değil) ama komut satırlarını
-- görmemeli: bir komut satırında parola geçmiş olabilir ve yedek dökümü onu taşımamalı.
GRANT SELECT ON public.console_sessions, public.app_instances, public.remote_networks TO depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.remote_networks;
DROP TABLE IF EXISTS public.app_instances;
DROP TABLE IF EXISTS public.app_catalogue;
DROP TABLE IF EXISTS public.console_commands;
DROP TABLE IF EXISTS public.console_sessions;
