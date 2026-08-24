-- 0022 — Bir kopyanın nereden geldiği: `files.copy`'yi gerçekten idempotent yapan bağ.
--
-- Kuyruk en-az-bir-kez teslim ediyor (ADR-0003, §17), yani bir parça yeniden gelebilir. Kopyalama
-- işi bunu soğurmak zorunda ve soğuramıyordu — ölçüldü:
--
--   1. Parça çalışıyor: `docs/a.txt` → `target/a.txt`, satır yazılıyor.
--   2. İşçi ölüyor, iş yeniden teslim ediliyor.
--   3. `keep_both` çakışmayı çözüyor: `target/a.txt` dolu, yani ad `target/a (2).txt` oluyor.
--   4. Ajan itiraz etmiyor — bu ad boş — ve dosya İKİNCİ KEZ kopyalanıyor.
--
-- Kullanıcı bir kopya istedi, iki tane aldı. Ve bu, sistemin doğru çalıştığı hâli: her adım tek
-- başına kusursuz.
--
-- ── Neden ada bakmak yetmiyor ─────────────────────────────────────────────────
--
-- "Bu dosyayı buraya zaten kopyaladım mı?" sorusunun ADLA cevaplanabilir bir hâli yok, çünkü
-- `keep_both`'un ürettiği ad, hedefte o an ne olduğuna bağlı — ve o, ilk denemeyle ikinci deneme
-- arasında değişmiş oluyor. Tam olarak bu yüzden. Soru ancak KAYNAĞA bir bağla cevaplanabilir.
--
-- ── Neden bir sütun, ayrı bir tablo değil ─────────────────────────────────────
--
-- Girdi başına en fazla bir tane, ve girdi silinince gitmesi gerekiyor. Ayrı bir tablo bunu bir
-- foreign key'e havale etmek olurdu; sütun yapısal olarak garanti ediyor.
--
-- `ON DELETE SET NULL`: kaynağı silmek kopyayı bozmamalı. Bağ bir köken kaydı, bir bağımlılık
-- değil — kopya kendi başına duran bir dosya.
--
-- ── Yan fayda, ama asıl gerekçe değil ─────────────────────────────────────────
--
-- Sütun "bu dosya nereden geldi" sorusunu da cevaplıyor. Hoş, ama tek başına bir sütun eklemeye
-- değmezdi; eklenme sebebi yukarıdaki çift kopya.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.file_entries
  ADD COLUMN copied_from_entry_id uuid REFERENCES public.file_entries (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.file_entries.copied_from_entry_id IS
  'Bu satır bir kopyaysa, kaynağının id''si. `files.copy`''nin yeniden teslim edilen bir parçayı '
  'tanımasını sağlayan tek şey: `keep_both`''un ürettiği ad ilk denemeyle ikincisi arasında '
  'değiştiği için soru adla cevaplanamıyor. NULL, satırın bir kopya olmadığı ya da kaynağının '
  'silindiği anlamına gelir.';

-- Sorgu her zaman "bu ebeveynin altında, bu kaynaktan gelen bir satır var mı" biçiminde geliyor.
-- Kısmi indeks, çünkü satırların ezici çoğunluğu kopya değil ve NULL'lar indekste yer kaplamamalı.
CREATE INDEX file_entries_copied_from
  ON public.file_entries (organization_id, parent_id, copied_from_entry_id)
  WHERE copied_from_entry_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS public.file_entries_copied_from;
ALTER TABLE public.file_entries DROP COLUMN IF EXISTS copied_from_entry_id;
