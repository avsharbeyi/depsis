-- 0019 — SMB kimlik bilgisi: NT hash, mühürlü.
--
-- Samba kendi deposuna karşı doğruluyor ve orada bir NT hash istiyor. DEPSIS'in argon2 hash'inden
-- türetilemiyor, yani bir yerde tutulmak zorunda ya da hiç var olmayacak.
--
-- `tools/poc/p2-b-smb-password.sh` düz parolayı ayrıcalıklı tarafa geçirmeden bunun mümkün
-- olduğunu ölçtü: API `MD4(UTF-16LE(parola))` hesaplıyor, telde yalnız hash gidiyor. Ama hash'in
-- parola BELİRLEME anında hesaplanması gerekiyor — sonrasında düz metin yok — ve ajan o anda
-- ulaşılamaz olabilir. O yüzden saklanıyor.
--
-- ── Neden mühürlü ─────────────────────────────────────────────────────────────
--
-- Bir NT hash, tek bir protokol için parola-EŞDEĞERİ: onu ele geçiren biri pass-the-hash ile
-- kullanıcı olarak SMB'ye girer. Argon2 hash'i gibi tek yönlü değil — doğrulama için değil,
-- KULLANIM için saklanıyor.
--
-- Bu yüzden TOTP sırlarıyla aynı muameleyi görüyor (ADR-0016): `SecretBox` ile AES-256-GCM,
-- anahtar `DEPSIS_SECRET_KEY_FILE`'dan, ve AAD satıra bağlı — bir kullanıcının zarfını başka bir
-- satıra taşımak çözülmüyor. Veritabanı yedeği tek başına kimseye SMB erişimi vermiyor.
--
-- `key_version`, 0006'nın TOTP sırlarında yaptığı gibi: anahtar yoksa satır hiç yazılmıyor, yani
-- düz metin bir sürüm YOK. 0006 mevcut düz sırları taşımak zorundaydı; burada taşınacak bir şey
-- olmadığı için sütun baştan yalnızca mühürlü değer kabul ediyor.
--
-- ── Neden `users`'ta, ayrı bir tabloda değil ──────────────────────────────────
--
-- Kullanıcı başına en fazla bir tane, ve kullanıcı silinince gitmesi gerekiyor. Ayrı bir tablo
-- bunu bir foreign key'e havale etmek olurdu; sütun bunu yapısal olarak garanti ediyor.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.users
  ADD COLUMN nt_hash bytea,
  ADD COLUMN nt_hash_key_version smallint;

-- İkisi birlikte var ya da ikisi birlikte yok. Sürümsüz bir zarf açılamaz, ve zarfsız bir sürüm
-- hiçbir şey söylemez — ikisini ayrı ayrı yazılabilir bırakmak, açılamayan bir satırı sessizce
-- mümkün kılardı.
ALTER TABLE public.users
  ADD CONSTRAINT users_nt_hash_pair
  CHECK ((nt_hash IS NULL) = (nt_hash_key_version IS NULL));

-- Düz metin sürüm yok. 0006 TOTP sırları için `0` (düz) değerine izin vermek zorundaydı çünkü
-- taşınacak veri vardı; burada yok, ve bir zarfın "aslında mühürsüz" olabilmesi ileride birinin
-- güveneceği bir belirsizlik olurdu.
ALTER TABLE public.users
  ADD CONSTRAINT users_nt_hash_sealed
  CHECK (nt_hash_key_version IS NULL OR nt_hash_key_version = 1);

COMMENT ON COLUMN public.users.nt_hash IS
  'SMB parolasının NT hash''i (MD4/UTF-16LE), SecretBox ile mühürlü. Parola-EŞDEĞERİ: doğrulama '
  'için değil KULLANIM için saklanıyor, o yüzden argon2 hash''i gibi değil TOTP sırrı gibi ele '
  'alınıyor (ADR-0016). NULL, kullanıcının bu özellik var olduğundan beri parolasını hiç '
  'değiştirmediği anlamına gelir; SMB''ye erişemez ve bu dürüst durum.';

-- `depsis_backup` bunu OKUYAMAZ. Yedek rolü şemanın çoğunu okuyabiliyor ama bir yedek dosyasının
-- tek başına SMB erişimi vermesi, mühürlemenin bütün amacını ortadan kaldırırdı — anahtar ayrı
-- bir dosyada ve yedeğe girmiyor, ama kolonu hiç vermemek daha ucuz bir garanti.
REVOKE SELECT (nt_hash, nt_hash_key_version) ON public.users FROM depsis_backup;

-- Down Migration

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_nt_hash_sealed;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_nt_hash_pair;
ALTER TABLE public.users DROP COLUMN IF EXISTS nt_hash_key_version;
ALTER TABLE public.users DROP COLUMN IF EXISTS nt_hash;
