-- Kendi ağını yöneten bir cihazın, DEPSIS'in kendi bilmesi gereken iki şeyi.
--
-- Controller'ın kendi durumu `/var/lib/zerotier-one/controller.d` altında ve gerçeğin kaynağı o:
-- hangi ağlar var, kim yetkili. Onu buraya kopyalamak, zamanla ayrışacak ikinci bir liste tutmak
-- olurdu — bu depoda üç kez aynı karar verildi (yedek listesi, döküm listesi, tarama durumu), ve
-- üçünde de kaynaktan okundu.
--
-- Ama controller'ın BİLMEDİĞİ iki şey var, ve ikisi de DEPSIS'in kendi bilgisi:
--
--   1. **Kim yetkilendirdi, ne zaman.** Controller yalnız `authorized: true` tutuyor. Altı ay
--      sonra ağda tanımadık bir cihaz görüldüğünde "bunu kim, ne zaman içeri aldı" sorusunun
--      cevabı hiçbir yerde olmazdı. Ajanın denetim kaydı işlem ADINI tutuyor, operandları
--      bilerek tutmuyor (§16), yani oradan da çıkmıyor.
--   2. **Hangi kiracıya ait.** Bu üründeki her veri yolu kiracı kapsamlı ve `FORCE ROW LEVEL
--      SECURITY` ile korunuyor. Kapsamsız bırakılsaydı, iki kuruluşlu bir cihazda B'nin yöneticisi
--      A'nın ev ağını listeleyebilir, ona cihaz yetkilendirebilir, A'nın cihazlarının yetkisini
--      alabilirdi.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── hangi ağı biz yönetiyoruz ────────────────────────────────────────────────
--
-- Ayrı bir tablo DEĞİL: DEPSIS kendi yarattığı ağa aynı zamanda KATILIYOR, yani `remote_networks`
-- satırı zaten oluşuyor. Bir bayrak, ikinci bir tablonun tutamayacağı bir şeyi tutuyor — ikisinin
-- aynı satır olduğunu.
ALTER TABLE public.remote_networks ADD COLUMN controlled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.remote_networks.controlled IS
  'Bu ağı bu cihaz mı yönetiyor? Ağ kimliğinin üst 40 biti düğümün adresi olduğu için bu, '
  'kimliğe kaynaklı bir olgu — ve `identity.secret` değişirse geri gelmiyor.';

-- ─── kim, kimi, ne zaman içeri aldı ───────────────────────────────────────────
CREATE TABLE public.remote_members (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  -- Ağ ve üye kimlikleri. Ajanda da kendi tipleriyle doğrulanıyor; burada da kısıt var, çünkü bir
  -- istek yolunun parçası olacak bir değerin iki yerde doğrulanması, bir yerde unutulmasından ucuz.
  network_id      text        NOT NULL,
  member_id       text        NOT NULL,

  -- Evin bu cihaza verdiği ad. Controller da tutuyor; burada tutulması, controller durumu
  -- kaybedildiğinde yeniden yetkilendirirken kimin kim olduğunu hatırlamak için.
  label           text,

  /* KİM BASTI. Bu tablonun var olma sebebi.
   *
   * `ON DELETE SET NULL`: hesabı silinen bir yöneticinin verdiği yetki, kaydıyla birlikte
   * kaybolmamalı — cihaz hâlâ ağda, ve "kim aldı" sorusu hâlâ sorulacak. Kalan şey tarih. */
  authorized_by   uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  authorized_at   timestamptz,
  deauthorized_by uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  deauthorized_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT remote_members_network_format CHECK (network_id ~ '^[0-9a-f]{16}$'),
  CONSTRAINT remote_members_member_format  CHECK (member_id  ~ '^[0-9a-f]{10}$'),
  CONSTRAINT remote_members_label_length   CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80)
);

-- Bir üye bir ağda bir kez. İkinci satır, aynı cihaz için iki farklı "kim aldı" cevabı demek.
CREATE UNIQUE INDEX remote_members_unique
  ON public.remote_members (organization_id, network_id, member_id);

ALTER TABLE public.remote_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY remote_members_owner_full ON public.remote_members
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY remote_members_tenant ON public.remote_members
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.remote_members TO depsis_app;
GRANT SELECT ON public.remote_members TO depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.remote_members;
ALTER TABLE public.remote_networks DROP COLUMN controlled;
