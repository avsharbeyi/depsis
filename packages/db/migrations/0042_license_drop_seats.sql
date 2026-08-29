-- `seats` kolonu düşüyor: hiçbir şey ifade etmiyordu.
--
-- 0041 lisans tablosunu bir `seats` kolonuyla kurdu, jeton onu taşıdı, ekran onu gösterdi — ve
-- HİÇBİR KOD onu okuyup bir karar vermedi. Yani "5 yuva" yazan bir kutuda altıncı kullanıcı
-- açılıyordu ve hiçbir şey olmuyordu.
--
-- Bu, bu projenin en sık tekrarladığı kuralın ihlaliydi: çalışıyormuş gibi duran bir kontrol,
-- hiç olmayan bir kontrolden kötüdür. İki çıkışı vardı — sayıya bir anlam vermek (yuva dolduysa
-- yeni hesap açılmaması) ya da kaldırmak — ve cihazın sahibi per-seat satmayacağını söyledi.
--
-- Var olan lisans jetonları etkilenmiyor: `seats` alanını taşıyan eski bir jeton hâlâ doğrulanıyor,
-- alan yalnızca okunmuyor. İmza, jetonun İÇERİĞİNİN üzerinde — bir alanı görmezden gelmek imzayı
-- bozmaz.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.license DROP COLUMN IF EXISTS seats;

-- Down Migration

ALTER TABLE public.license ADD COLUMN IF NOT EXISTS seats integer;
