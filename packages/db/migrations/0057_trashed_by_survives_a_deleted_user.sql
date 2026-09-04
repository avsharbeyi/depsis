-- 0057 — çöpüne bir dosya atmış bir hesap silinebilsin.
--
-- ── NE OLUYORDU ──────────────────────────────────────────────────────────────────────────────
--
-- 0008 iki şeyi birden söylüyordu ve ikisi birbiriyle çelişiyordu:
--
--   trashed_by uuid REFERENCES public.users (id) ON DELETE SET NULL          (0008:156)
--   CONSTRAINT file_entries_trash_pair CHECK ((trashed_at IS NULL) = (trashed_by IS NULL))
--
-- Yani "hesap silinince bu sütun NULL'a düşsün" ile "ikisi ya birlikte dolu ya birlikte boş"
-- aynı satırda. Bir hesabın çöpünde tek bir dosya varsa `DELETE FROM users` referans eylemi
-- olarak `trashed_by = NULL` yazıyor, `trashed_at` yerinde duruyor, ve kısıt 23514 ile patlıyor.
--
-- 0049 silmeyi açtı (`GRANT DELETE ON public.users TO depsis_app`) ve üç RESTRICT bağını çözdü,
-- ama bu çifte dokunmadı — çünkü RESTRICT değil, SET NULL'dı; aranan kalıba uymuyordu.
--
-- SAHADAKİ SONUCU BİR HATA MESAJINDAN KÖTÜ. `UsersService.remove` önce POSIX kimliğini ajana
-- kaldırtıyor, sonra satırı siliyor. Kısıt ikinci adımda patlayınca işlem geri alınıyor:
-- kullanıcı ekranda kalıyor, ama Unix/Samba hesabı çoktan gitmiş oluyor. Arayüzde beliren şey
-- açıklanamaz bir 500, ve bir sonraki kimlik eşitlemesi hesabı sessizce geri kuruyor.
--
-- ── DÜZELTME: 0028'İN KALIBI ─────────────────────────────────────────────────────────────────
--
-- Aynı çelişki `task_comments` için bulunmuş ve orada çözülmüştü
-- (`task_comments_deleted_by_needs_deletion`): otorite ZAMAN DAMGASINDA, kimlikte değil.
--
--   "kim attı" bilgisi kaybolabilir, "atıldı" bilgisi kaybolamaz.
--
-- Doğru öncelik bu: bir kaydın ilk cevaplaması gereken soru, bir şeyin var olup olmadığı. Ve
-- çöpün kendisi zaten yalnız `trashed_at`e bakıyor — `listTrash` `trashed_by`ı hiç okumuyor,
-- iki kısmi tekil ad indeksi de (`file_entries_name_unique_*`) `trashed_at IS NULL` üzerinde.
-- Yani NULL'a düşen sütun hiçbir ekranı ve hiçbir kısıtı bozmuyor.
--
-- Ters yön korunuyor: `trashed_by` dolu ama `trashed_at` boş olan bir satır hâlâ reddediliyor.
-- O şekil gerçek bir tutarsızlık olurdu — çöpte olmayan bir dosyayı çöpe atmış bir kullanıcı.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.file_entries
  DROP CONSTRAINT IF EXISTS file_entries_trash_pair;

ALTER TABLE public.file_entries
  ADD CONSTRAINT file_entries_trash_pair
  CHECK (trashed_by IS NULL OR trashed_at IS NOT NULL);

COMMENT ON COLUMN public.file_entries.trashed_by IS
  'Dosyayı çöpe atan hesap, VARSA. Hesap silinince NULL''a düşüyor ve satır kalıyor: çöpte '
  'duran bir dosya, onu atan kişinin hesabının bir eklentisi değil. Çöpün otoritesi '
  '`trashed_at`; bu sütun yalnız denetim bilgisi.';

-- Down Migration
--
-- Eski kısıt `NOT VALID` ile geri geliyor. Bu göç yürürlükteyken silinmiş bir hesabın bıraktığı
-- (trashed_at dolu, trashed_by NULL) satırlar olabilir, ve eski kısıt onları doğrulamaya
-- kalkarsa geri alma işlemin ortasında patlar — geri alınamayan bir geri alma, geri almamaktan
-- kötü. `NOT VALID` var olan satırlara dokunmuyor, yeni yazmaların hepsini yine de kontrol
-- ediyor.

ALTER TABLE public.file_entries
  DROP CONSTRAINT IF EXISTS file_entries_trash_pair;

ALTER TABLE public.file_entries
  ADD CONSTRAINT file_entries_trash_pair
  CHECK ((trashed_at IS NULL) = (trashed_by IS NULL)) NOT VALID;
