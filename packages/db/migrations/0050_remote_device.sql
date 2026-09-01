-- Uzak erişim listesinde cihazın NE OLDUĞU.
--
-- ── NE İSTENDİ ───────────────────────────────────────────────────────────────────────────────
--
-- Cihazın sahibinin cümlesi: *"uzak erişimde cihazların markaları ve türleri mesela s26+ android,
-- windows pc gibi görünsün."* Listede yalnız on onaltılık hanelik ZeroTier adresi ve elle
-- yazılabilen bir takma ad vardı: `8a4f2c9b01` bir insanın "bu benim telefonum" diyebileceği bir
-- şey değil.
--
-- ── ZEROTIER BUNU BİLMİYOR ───────────────────────────────────────────────────────────────────
--
-- Ve bunu baştan söylemek gerekiyor, çünkü asıl tasarım kararı burada. Controller'ın üye kaydında
-- işletim sistemi ya da model diye bir alan YOK: taşıdığı şey adres, yetki, atanmış IP'ler ve
-- istemci sürümü. Sürümden platform çıkarmak da mümkün değil — aynı sürüm numarası her yerde aynı.
--
-- ── AMA TARAYICI BİLİYOR ─────────────────────────────────────────────────────────────────────
--
-- O cihaz uzak ağ üzerinden DEPSIS'e girdiğinde, oturumunun yanına `user_agent` ve `ip_address`
-- zaten yazılıyor (göç 0003). ZeroTier'ın o üyeye verdiği IP ile oturumun geldiği IP aynı: ikisini
-- eşleştirmek, üyeyi tarayıcının kendi söylediği şeyle tanıştırıyor. "Windows PC", "iPhone",
-- "Android · SM-S926B" — sonuncusundaki model kodu Android'in kendi kullanıcı aracısından geliyor.
--
-- ── NEDEN SÜTUN, NEDEN HER SEFERİNDE HESAPLANMIYOR ───────────────────────────────────────────
--
-- Oturumlar süresi dolunca siliniyor. Cihaz tanımı yalnız oturumdan okunsaydı, bir hafta girmeyen
-- telefon listede yeniden "bilinmiyor" olurdu — ve kullanıcı için bu, bilginin KAYBOLMASI gibi
-- görünürdü. Öğrenilen şey satıra yazılıyor ve orada kalıyor; her okumada tazeleniyor.
--
-- ── TAKMA ADIN YERİNİ ALMIYOR ────────────────────────────────────────────────────────────────
--
-- `label` insanın verdiği ad ("Ayşe'nin telefonu"), `device` makinenin söylediği tür. İkisi farklı
-- sorulara cevap veriyor ve ekranda yan yana duruyorlar: biri kimin olduğunu, öteki ne olduğunu
-- söylüyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.remote_members
  ADD COLUMN IF NOT EXISTS device text CHECK (device IS NULL OR length(device) <= 80);

ALTER TABLE public.remote_members
  ADD COLUMN IF NOT EXISTS device_seen_at timestamptz;

COMMENT ON COLUMN public.remote_members.device IS
  'Cihazın türü, tarayıcısının kullanıcı aracısından öğrenilmiş: "Windows PC", "Android · SM-S926B". '
  'ZeroTier bunu bilmiyor; eşleştiren şey üyeye atanmış IP ile oturumun geldiği IP. Elle verilen '
  'takma adın (label) yerini ALMIYOR: biri cihazın kimin olduğunu, öteki ne olduğunu söylüyor.';

-- Down Migration

ALTER TABLE public.remote_members DROP COLUMN IF EXISTS device_seen_at;
ALTER TABLE public.remote_members DROP COLUMN IF EXISTS device;
