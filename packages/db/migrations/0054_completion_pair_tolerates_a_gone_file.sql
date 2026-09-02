-- `upload_sessions_completion_pair`, dosyası GİTMİŞ bir oturumu da kabul etsin.
--
-- ── SAHADAN GELEN ARIZA ──────────────────────────────────────────────────────────────────────
--
-- Cihazın sahibi ağ sürücüsünden yüklediği dosyaların arayüzde hiç görünmediğini bildirdi.
-- Cihaza bakıldığında dizinde 1702, diskte 2044 öğe vardı: 342 öğe görünmüyordu. Uzlaştırma
-- turu birkaç kez koşup ölmüştü, ve ölüm sebebi şuydu:
--
--   "upload_sessions" tablosuna girilen yeni satır "upload_sessions_completion_pair"
--   check kısıtlamasını ihlal ediyor
--
-- ── İKİ KURAL BİRBİRİYLE ÇELİŞİYOR ───────────────────────────────────────────────────────────
--
-- 0008 iki şeyi birden söylüyor, ve ikisi bir arada tutulamıyor:
--
--   `file_id uuid REFERENCES public.file_entries (id) ON DELETE SET NULL`
--   `CHECK ((completed_at IS NULL) = (file_id IS NULL))`
--
-- Bir `file_entries` satırı silinince yabancı anahtar `file_id`yi NULL yapıyor, ama `completed_at`
-- dolu kalıyor — ve CHECK tam bu bileşimi yasaklıyor. Sonuç: yabancı anahtarın yapmak zorunda
-- olduğu şey kısıt tarafından reddediliyor, ve SİLME BAŞARISIZ OLUYOR.
--
-- Yani web arayüzünden yüklenmiş HER dosya, o dosyanın satırını silmeye çalışan her yolu
-- bloke ediyor.
--
-- ── BU TUZAK BİR KEZ DAHA KURULDU, VE NOTU DURUYOR ───────────────────────────────────────────
--
-- Kalıcı silme yolu (`FilesService`, "permanently delete") aynı duvara çarpmış ve etrafından
-- dolaşmış: silmeden önce ilgili `upload_sessions` satırlarını kendisi siliyor. O yorumun kendi
-- cümlesi bu göçü tarif ediyor: *"Deleted rather than detached because there is no third option
-- WITHOUT A MIGRATION."*
--
-- Göç işte bu. Uzlaştırma turunun `forget()`i aynı çözümü almamıştı, ve alması da yetmezdi:
-- `file_entries` satırı silen her yol — bugün yazılmış olsun ya da olmasın — aynı duvara çarpar.
-- Kuralı düzeltmek, her yolu birden düzeltiyor.
--
-- ── KURALIN ANLAMLI YARISI KALIYOR ───────────────────────────────────────────────────────────
--
-- Eski kural iki şey söylüyordu ve yalnız biri doğruydu:
--
--   1. "Tamamlanmamış bir oturum bir dosyayı ADLAYAMAZ." DOĞRU ve kalıyor: `file_id` dolu ama
--      `completed_at` boşsa, bu yarıda kalmış bir yüklemenin var olmayan bir sonucu göstermesi.
--
--   2. "Tamamlanmış bir oturumun dosyası HER ZAMAN vardır." YANLIŞ. Dosya sonradan silinebilir —
--      çöpten kalıcı silinerek, ağ sürücüsünden silinerek, ya da hiç var olmadığı anlaşılarak.
--      Oturum bir TRANSFERİN kaydı; o transferin ürettiği satırın hâlâ durması, oturumun
--      geçerliliğinin şartı değil.
--
-- Yeni kural yalnız birincisini söylüyor: `completed_at IS NOT NULL OR file_id IS NULL`.
--
-- Geriye kalan `parent_id` bağı (ON DELETE RESTRICT) bu göçün konusu DEĞİL ve bilerek öyle:
-- bir klasörü silmek, ona yapılmakta olan yüklemeleri sessizce koparmamalı. Onu çağıran taraf
-- kendi işlemi içinde temizliyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_completion_pair;

ALTER TABLE public.upload_sessions ADD CONSTRAINT upload_sessions_completion_pair
  CHECK (completed_at IS NOT NULL OR file_id IS NULL);

COMMENT ON CONSTRAINT upload_sessions_completion_pair ON public.upload_sessions IS
  'Tamamlanmamış bir oturum bir dosyayı adlayamaz. Tersi SERBEST: tamamlanmış bir oturumun '
  'dosyası sonradan silinmiş olabilir, ve `file_id` ON DELETE SET NULL tam da bunu yapıyor. '
  'Eski hâli iki yönü birden şart koşuyordu ve yabancı anahtarın yapmak zorunda olduğu şeyi '
  'reddediyordu: web''den yüklenmiş her dosya, satırını silmeye çalışan her yolu bloke etti.';

-- Down Migration

-- Eski kurala dönmeden ÖNCE onu çiğneyen satırlar temizlenmeli, yoksa `ALTER TABLE` reddedilir.
-- Silinen şey, dosyası artık var olmayan tamamlanmış bir transferin kaydı.
DELETE FROM public.upload_sessions WHERE completed_at IS NOT NULL AND file_id IS NULL;

ALTER TABLE public.upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_completion_pair;

ALTER TABLE public.upload_sessions ADD CONSTRAINT upload_sessions_completion_pair
  CHECK ((completed_at IS NULL) = (file_id IS NULL));
