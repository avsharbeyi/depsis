-- Bir işin AÇIKLAMASI değiştiğinde de aktivite yazılabilsin.
--
-- ── NE OLUYORDU ──────────────────────────────────────────────────────────────────────────────
--
-- `TasksService.diff()` değişen her alan için bir satır üretiyor ve `description` de bunlardan
-- biri (`tasks.service.ts:189`). Ama bu kısıtın tanıdığı adlar arasında `description` yoktu:
-- son hâlini 0030 yazdı ve listeye status, priority, due_at, assignee_id, body, file_link,
-- comment, parent_id, checklist, tag'i koydu — açıklamayı değil.
--
-- ── VE NEDEN YALNIZ AÇIKLAMA KAYBOLMUYORDU ───────────────────────────────────────────────────
--
-- Asıl zararı burada. Kayıt TEK BİR ÇOK SATIRLI INSERT (`unnest` üzerinden, tasks.service.ts:530),
-- yani kısıtı çiğneyen tek bir alan bütün ifadeyi düşürüyor. Bir işin açıklamasını durumuyla
-- birlikte değiştirdiğinizde, o düzenlemenin AKTİVİTE İZİ TAMAMEN yok oluyordu: durum değişikliği
-- de, öncelik de, atanan da.
--
-- Üstüne `record()` hatayı yutup yalnız günlüğe yazıyor (tasks.service.ts:544). Yani düzenleme
-- başarılı görünüyor, iş güncelleniyor, ve aktivite akışında hiçbir şey çıkmıyor. Kullanıcı için
-- bu, kaydın keyfî biçimde bazen tutulup bazen tutulmaması demek.
--
-- ── YUTMA NEDEN DURUYOR ──────────────────────────────────────────────────────────────────────
--
-- Kaldırmak cazip ama yanlış olurdu: aktivite kaydı işin KENDİSİNİN yanında bir defter, ve
-- defterin yazılamaması işi geri almak için bir sebep değil. Düzeltilecek olan yutma değil,
-- yutulacak bir hatanın var olmasıydı.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.task_activity DROP CONSTRAINT IF EXISTS task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment',
                   'parent_id', 'checklist', 'tag', 'description'));

-- Down Migration

-- Geri alırken var olan satırları TEMİZLEMEK gerekiyor: kısıt eski hâline dönerse `description`
-- taşıyan satırlar onu çiğner ve `ALTER TABLE` reddedilir. Silinen şey bir denetim kaydı, ve bunu
-- söylemek gerekiyor — ama bu göçü geri almanın anlamı zaten "açıklama değişikliği kaydedilmesin".
DELETE FROM public.task_activity WHERE field = 'description';

ALTER TABLE public.task_activity DROP CONSTRAINT IF EXISTS task_activity_field_known;
ALTER TABLE public.task_activity ADD CONSTRAINT task_activity_field_known
  CHECK (field IN ('status', 'priority', 'due_at', 'assignee_id', 'body', 'file_link', 'comment',
                   'parent_id', 'checklist', 'tag'));
