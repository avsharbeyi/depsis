-- Disklere insan adı vermek.
--
-- ── NEDEN BİR TABLO GEREKİYOR ────────────────────────────────────────────────────────────────
--
-- Disk envanteri BUGÜNE KADAR TAMAMEN DURUMSUZDU: `GET /system/disks` ajanın anlattığını olduğu
-- gibi geri veriyor ve arada hiçbir veritabanı okuması yok. Taşıdığı her alan donanımın kendi
-- söyleyebildiği bir şey — model, seri, WWN, boyut. İnsanın verdiği hiçbir alan yok, çünkü öyle
-- bir alanın duracağı bir yer yok.
--
-- Cihazın sahibinin istediği şey tam olarak o eksik alan: *"depolama disklere takma ad
-- verilebilsin ve hubda takma ad görünsün."* `wwn-0x5001b448b6bf6163` bir insanın ayırt
-- edebileceği bir ad değil; "Sol yuva" ya da "Eski Seagate" öyle.
--
-- ── ANAHTAR NEDEN `by_id` ───────────────────────────────────────────────────────────────────
--
-- `/dev/sda` bir SLOT değil, bir SIRA: aynı disk yeniden başlatmadan sonra `sdb` olabilir, ve
-- takma ad o zaman yanlış diski adlandırır — risk R1'in ta kendisi. `/dev/disk/by-id` adı ise
-- CİHAZI adlandırıyor: WWN ya da seri numarasından türüyor ve disk hangi kabloya takılırsa
-- takılsın aynı kalıyor.
--
-- Diskin kendisi silinince satır kalıyor ve bu bilerek: aynı disk yeniden takıldığında adını
-- geri buluyor. Kullanılmayan bir satırın maliyeti bir metin; adını kaybeden bir diskinki, sahibin
-- ikinci kez oturup adlandırması.
--
-- ── KİRACI SINIRI ───────────────────────────────────────────────────────────────────────────
--
-- Diskler fiziksel olarak kutunun tamamına ait ama ADLAR bir kuruluşun: iki kiracılı bir kutuda
-- birinin verdiği ad ötekinin ekranında görünmemeli. RLS bu yüzden açık ve zorunlu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE IF NOT EXISTS public.disk_labels (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  -- `/dev/disk/by-id` adı. Uzun olabiliyor (WWN + model + seri), o yüzden 255.
  disk_by_id text NOT NULL CHECK (length(disk_by_id) BETWEEN 1 AND 255),
  -- Bir insanın yazdığı ad. Üst sınır ekranın sığdırabileceği kadar; boş bir ad "ad yok"
  -- demek ve o satır silinerek anlatılıyor, boş metinle değil.
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Bir diskin bir kuruluşta tek adı olur. `ON CONFLICT` bu indeksi hedefliyor: ad değiştirmek
-- ikinci bir satır değil, aynı satırın üstüne yazmak.
CREATE UNIQUE INDEX IF NOT EXISTS disk_labels_one_per_disk
  ON public.disk_labels (organization_id, disk_by_id);

ALTER TABLE public.disk_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disk_labels FORCE ROW LEVEL SECURITY;

CREATE POLICY disk_labels_tenant_isolation ON public.disk_labels
  TO depsis_app
  USING (organization_id = current_organization_id())
  WITH CHECK (organization_id = current_organization_id());

CREATE POLICY disk_labels_owner_full ON public.disk_labels
  TO depsis_owner
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.disk_labels TO depsis_app;
GRANT SELECT ON public.disk_labels TO depsis_backup;

CREATE TRIGGER disk_labels_set_updated_at
  BEFORE UPDATE ON public.disk_labels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS public.disk_labels;
