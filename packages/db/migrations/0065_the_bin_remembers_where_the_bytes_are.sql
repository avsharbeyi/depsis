-- 0065 — Çöp kutusundaki satır, baytlarının NEREDE olduğunu da biliyor.
--
-- ── İKİ FARKLI "ÇÖPTE" ──────────────────────────────────────────────────────────────────────
--
-- DEPSIS'te bir dosyayı çöpe atmak diskte hiçbir şeyi taşımıyor: satıra bir damga yazılıyor,
-- dosya yerinde kalıyor. Ağ sürücüsünden silmek ise gerçekten taşıyor — Samba'nın `recycle`
-- modülü onu paylaşımın kökündeki çöp kutusu klasörüne alıyor.
--
-- İkisi ekranda aynı görünüyor ve öyle de görünmeli. Ama uzlaştırma turu için AYNI ŞEY DEĞİLLER:
--
--   * Web'den çöpe atılmış bir satırın dosyası KENDİ YERİNDE duruyor. Bu olağan hâl.
--   * Ağdan silinmiş bir satırın dosyası çöp kutusunda. Kendi yerinde görünüyorsa, kullanıcı onu
--     Dosya Gezgini'nden elle geri koymuş demektir — ve o zaman satırın çöpten çıkması gerekiyor,
--     yoksa aynı dosya hem klasörde hem çöpte görünür.
--   * Ağdan silinmiş bir satırın dosyası İKİSİNDE DE yoksa, kullanıcı çöp kutusunu Gezgin'den
--     boşaltmış demektir: geri getirilecek bir şey kalmadı, satır gitmeli.
--
-- Bu üç ayrımın hiçbiri, satırın nasıl çöpe girdiğini bilmeden yapılamıyor. Bayrak onu söylüyor.
--
-- ── NEDEN BİR YOL DEĞİL DE BAYRAK ───────────────────────────────────────────────────────────
--
-- Dosyanın çöp kutusundaki yeri kendi yolundan türetilebiliyor: `recycle:keeptree = yes` ağacı
-- birebir kopyalıyor ve `versions = no` ada dokunmuyor. İkinci bir sütunda saklamak, satırın yolu
-- her değiştiğinde ayrışabilecek ikinci bir gerçek yaratmak olurdu.
-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.file_entries
  ADD COLUMN recycled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.file_entries.recycled IS
  'Bu satır ağ sürücüsünden silindiği için mi çöpte: baytları paylaşımın çöp kutusu klasöründe. '
  'false ise dosya kendi yerinde duruyor (DEPSIS''ten çöpe atılmış).';

-- Uzlaştırma turu yalnız ÇÖPTEKİ ve AĞDAN silinmiş satırları soruyor; ikisi birden dar bir küme.
CREATE INDEX file_entries_recycled_idx
    ON public.file_entries (organization_id, share_id)
 WHERE recycled AND trashed_at IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS public.file_entries_recycled_idx;
ALTER TABLE public.file_entries DROP COLUMN IF EXISTS recycled;
