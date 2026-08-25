-- Zamanlanmış çoğaltma her gece bir terabayt taşımasın.
--
-- 0032 zamanlamayı getirdi ve bilerek eksik bıraktığı bir şey vardı: her tur TAM gönderim
-- yapıyordu. Küçük bir paylaşımda fark edilmez; bir terabaytta gecenin tamamı, her gece, sonsuza
-- kadar. Artımlı gönderim yalnız DEĞİŞENİ taşıyor, ve bunun için tek bir şey gerekiyor — iki
-- tarafın da sahip olduğu ortak bir nokta.
--
-- O nokta, en son BAŞARIYLA gönderilmiş görüntü. Kolonda duruyor çünkü başka nerede durabileceği
-- yok: hedef başka bir makinede olabilir, ve ona "sende ne var" diye sormak her tur için fazladan
-- bir bağlantı demek.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.backup_schedules ADD COLUMN last_replicated_snapshot text;

COMMENT ON COLUMN public.backup_schedules.last_replicated_snapshot IS
  'Artımlı gönderimin tabanı: en son BAŞARIYLA çoğaltılmış görüntünün adı. '
  'Başarısız bir çoğaltmadan sonra NULL''a çekiliyor — bir sonraki tur tam gönderim yapsın diye, '
  'çünkü kopmuş bir gönderimden sonra hedefin ne tuttuğu bu taraftan bilinmiyor, ve olmayan bir '
  'tabana dayanan artımlı bir akış reddedilir. Bir fazladan tam gönderim, sessizce hiç '
  'çoğaltmayan bir zamanlamadan ucuz.';

-- Down Migration

ALTER TABLE public.backup_schedules DROP COLUMN last_replicated_snapshot;
