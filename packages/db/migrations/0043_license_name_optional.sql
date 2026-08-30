-- `licensed_to` artık NULL olabilir: adsız lisans meşru bir şey.
--
-- 0041 kolonu `NOT NULL` kurdu, çünkü o gün lisans veren araç müşteri adını ZORUNLU soruyordu.
-- Sonra ad, hiçbir şeyle karşılaştırılmadığı için isteğe bağlı oldu — jetondan, araçtan ve cihazın
-- doğrulamasından kalktı — ama BU KOLON öyle kaldı.
--
-- İki yarısı çelişen bir sürüm çıktı: aynı sürüm hem adsız lisans ÜRETEN bir araç hem de onu
-- REDDEDEN bir veritabanı taşıyordu. Sahadaki ilk kurulumda tam bu görüldü — imza doğrulandı,
-- kayıt satırı yazılamadı, ve kullanıcının gördüğü şey "Beklenmeyen bir hata oluştu" oldu; yani
-- 500. Bir doğrulama hatası kullanıcıya ne yapacağını söyler, 500 söylemez.
--
-- Ders kolonun kendisinden büyük: bir alanı isteğe bağlı yapmak, onu taşıyan HER katmanda
-- yapılmalı. Jeton, araç, doğrulama ve şema aynı cümleyi kurmuyorsa, aradaki fark bir sürüm
-- boyunca gizlenir ve ilk gerçek kullanımda ortaya çıkar.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.license ALTER COLUMN licensed_to DROP NOT NULL;

-- Down Migration

-- Geri alırken NULL taşıyan satır varsa kısıt konamaz; o satır zaten adsız bir lisanstır ve
-- silinmesi yanlış olurdu. Bu yüzden geri alma, kısıtı ancak konabiliyorsa koyuyor.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.license WHERE licensed_to IS NULL) THEN
    ALTER TABLE public.license ALTER COLUMN licensed_to SET NOT NULL;
  END IF;
END $$;
