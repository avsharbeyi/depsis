-- Hiç geri yüklenmemiş bir yedek, yedek değildir.
--
-- 0032 zamanlamayı getirdi ve her turun sonucunu `last_result`'a yazıyor. O kolon bir tek şeyi
-- söylüyor: `zfs snapshot` komutunun hata vermediğini. Söylemediği şey, o görüntünün AÇILABİLİR
-- olduğu — ve bir yedeğin sessizce işe yaramaz olmasının yolları tam olarak orada:
--
--   * görüntü kabuktan silinmiş, ama zamanlamanın kaydı hâlâ "başarılı" diyor;
--   * görüntü duruyor ama mount edilemiyor;
--   * görüntü duruyor ve BOŞ — paylaşım o gün yanlış veri kümesindeydi, ya da hiç veri yoktu.
--
-- Üçü de "yedeğim var" diyen birini, olmadığını ihtiyaç duyduğu gün öğrenen birine çeviriyor. Bu
-- iki kolon o günü öne çekiyor.
--
-- NE KANITLADIĞI, VE NE KANITLAMADIĞI. Doğrulama görüntünün havuzda durduğunu, açılıp
-- listelenebildiğini ve boş olmadığını gösteriyor. BAYTLARIN SAĞLAM OLDUĞUNU GÖSTERMİYOR — onu
-- ZFS'in kendi sağlama toplamları ve `zpool scrub` yapıyor, ve bu ürün henüz scrub'ı ne
-- zamanlıyor ne de raporluyor. `last_verify_result` bu ayrımı cümlesiyle taşıyor; "doğrulandı"
-- diyen ama yalnız satır sayan bir alan, kapalı görünüp hiçbir şey tutmayan bir kapı olurdu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.backup_schedules ADD COLUMN last_verified_at timestamptz;
ALTER TABLE public.backup_schedules ADD COLUMN last_verify_result text;

COMMENT ON COLUMN public.backup_schedules.last_verify_result IS
  'Son doğrulamanın cümlesi. Görüntünün havuzda durduğunu, açılabildiğini ve boş olmadığını '
  'söylüyor; baytların sağlam olduğunu SÖYLEMİYOR — onu ZFS''in sağlama toplamları ve zpool scrub '
  'yapıyor.';

-- Down Migration

ALTER TABLE public.backup_schedules DROP COLUMN last_verify_result;
ALTER TABLE public.backup_schedules DROP COLUMN last_verified_at;
