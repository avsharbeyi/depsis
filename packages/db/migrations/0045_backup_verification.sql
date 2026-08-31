-- Yedeğin okunduğunun kaydı: son doğrulama ve son tarama.
--
-- ── "YEDEK ALINDI" ÖLÇÜLMEMİŞ BİR İDDİAYDI ───────────────────────────────────────────────────
--
-- `backup_runs` her turun kaç dosya kopyaladığını yazıyor. Ama saydığı şey turun KENDİ yaptığı
-- çağrılar; diskteki baytlara hiç bakılmıyordu. Kopyanın boş, yarım ya da başka bir dosya olduğu
-- bir kusur, sayıları hiç bozmadan aylarca sürebilir — ve yalnız kurtarma gününde, yani
-- düzeltmenin artık mümkün olmadığı gün, ortaya çıkar.
--
-- Bu göç o boşluğu kapatan iki ölçümün yerini açıyor:
--
--   * GÜNDE BİR, gerçekten bir dosya okunuyor ve aslıyla karşılaştırılıyor. Hangi dosya:
--     turun EN SON kopyaladığı dosya. Rastgele bir dosya seçmek yerine bu, çünkü yeni yazılmış
--     bir kopya, kopyalama yolunun bozulduğunu en çabuk gösteren şey.
--
--   * HAFTADA BİR, yedek havuzunda `scrub`. O, ZFS'in her bloğun sağlamasını okuyup doğrulaması
--     — yani diskin sessizce çürümesine karşı olan ölçüm. İkisi ayrı şeyleri ölçüyor ve biri
--     diğerinin yerine geçmiyor: scrub "disk doğru okuyor" diyor, karşılaştırma "yazdığımız şey
--     doğruydu" diyor.
--
-- ── YENİ TABLO YOK ───────────────────────────────────────────────────────────────────────────
--
-- Doğrulamanın geçmişi tutulmuyor, yalnız SONUCU. Kullanıcının sorduğu soru "yedeğim sağlam mı",
-- ve onun cevabı tek bir satır. Bir geçmiş tablosu, hiç kimsenin açmadığı bir ekran ve her gün
-- büyüyen bir tablo olurdu; başarısız bir doğrulama zaten denetim kaydına ve bildirime düşüyor.

ALTER TABLE public.backup_targets
  -- Turun en son kopyaladığı dosya. Doğrulama tam olarak bunu okuyor.
  --
  -- Paylaşım ve yol AYRI: yolun bileşenleri bir dizi ve birleştirilmiş bir metin değil, çünkü
  -- bileşenlerin içinde eğik çizgi olamaz ama başka her şey olabilir — ve birleştirip sonra
  -- ayırmak, adında eğik çizgi olan bir dosyayı bulunamaz kılardı. (Ajan zaten reddediyor; bu
  -- sütun onun kabul ettiği şeklin aynısını taşıyor.)
  ADD COLUMN IF NOT EXISTS last_copied_share text,
  ADD COLUMN IF NOT EXISTS last_copied_path text[],
  -- Son doğrulamanın zamanı ve sonucu. `null`, hiç doğrulanmadı demek — ve ekran bunu "sağlam"
  -- diye değil, "henüz bilinmiyor" diye söylemek zorunda.
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_verify_ok boolean,
  -- Ölçümün kendi cümlesi: hangi dosya, ne kadarı okundu. "Doğrulandı" tek başına bir şey
  -- söylemiyor; kullanıcının görmesi gereken şey neyin ölçüldüğü.
  ADD COLUMN IF NOT EXISTS last_verify_note text,
  ADD COLUMN IF NOT EXISTS last_scrub_at timestamptz;

-- Doğrulama işinin zinciri, turunkiyle aynı kalıpta: aynı anda yalnız bir tane kuyrukta
-- olabilir. Olmasaydı, uyanan her çalışan bir tane daha ekler ve kuyruk kendi kendine büyürdü.
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_one_scheduled_backup_verify
  ON public.job_queue (organization_id)
  WHERE kind = 'storage.backup.verify' AND status = 'queued';
