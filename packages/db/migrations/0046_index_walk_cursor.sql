-- Tarama yürüyüşünün nerede kaldığını hatırlaması için.
--
-- ── SONSUZ DÖNEN BİR YÜRÜYÜŞ ─────────────────────────────────────────────────────────────────
--
-- `IndexerService.reconcile` her turda kuyruğunu PAYLAŞIM KÖKÜYLE kuruyordu ve genişlik öncelikli
-- olarak 500 klasör tarayıp duruyordu. Kuyrukta iş kaldıysa "devam" deyip kendini yeniden sıraya
-- koyuyor — ve bir sonraki tur yine KÖKTEN başlıyordu.
--
-- 500 klasörden büyük bir ağaçta bunun iki sonucu var, ve ikisi de sahada ölçüldü:
--
--   * Yürüyüş hiç bitmiyor. Cihazda on beş dakikada bir kez koşması beklenen iş, saniyede bir
--     turla 600 kez koştu ve aynı ilk 500 klasörü tekrar tekrar okudu.
--   * İlk 500'ün ötesindeki klasörlerin İÇİ hiç listelenmiyor. Satırları var — üst klasörün
--     listesinden doğuyorlar — ama içlerindeki dosyalar hiç görünmüyor. Ağ sürücüsünden
--     gönderilen dosyaların Dosyalar ekranında çıkmamasının ikinci yarısı buydu.
--
-- ── NEDEN BİR SÜTUN, NEDEN AYRI BİR İMLEÇ TABLOSU DEĞİL ──────────────────────────────────────
--
-- İmleç "kaçıncı klasördeydim" değil, "bu klasör en son ne zaman okundu". Aradaki fark, ağacın
-- yürüyüş sırasında değişmesi: bir sıra numarası, araya giren yeni bir klasörle anlamını
-- kaybeder. Zaman damgası kaybetmiyor, ve yeni keşfedilen bir klasör `NULL` ile geldiği için
-- sıranın başına geçiyor — yani en yeni değişiklik en önce okunuyor.
--
-- Bu aynı zamanda yürüyüşü kendiliğinden dengeliyor: her tur en bayat 500 klasörü alıyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.file_entries
  ADD COLUMN IF NOT EXISTS scanned_at timestamptz;

-- Her turun sorduğu tek soru: en bayat klasörler hangileri. `NULLS FIRST` varsayılan sıralamanın
-- kendisi (artan sırada `NULL` en sonda değil, en başta değildir — bu yüzden sorgu bunu açıkça
-- yazıyor ve indeks de aynı şekli taşıyor).
--
-- KISMİ İNDEKS: yalnız klasörler ve yalnız çöpte olmayanlar. Dosya satırları bu sorunun konusu
-- değil ve tabloda onlar çoğunluk; indeksin onları taşıması, hiç sorulmayacak bir soru için
-- yazma maliyeti demek.
CREATE INDEX IF NOT EXISTS file_entries_folder_scan_order
  ON public.file_entries (share_id, scanned_at NULLS FIRST)
  WHERE kind = 'folder' AND trashed_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS public.file_entries_folder_scan_order;

ALTER TABLE public.file_entries
  DROP COLUMN IF EXISTS scanned_at;
