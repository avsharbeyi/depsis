-- İşin gövdesi tek satır; YÖNERGESİ değil.
--
-- Sahibi ilk gerçek kullanımda söyledi: "her işin altında açıklaması da olmalı" — bir iş satırı
-- ne yapılacağını adlandırıyor, ama nasıl yapılacağı, nelere dikkat edileceği, hangi dosyanın
-- nerede olduğu bir yorumun içinde kaybolacak bilgiler değil. Yorum bir KONUŞMA, açıklama işin
-- KENDİSİNİN parçası: atanan kişi işi açtığında önce onu okur.
--
-- `body`'den ayrı bir sütun, `body`'yi büyütmek değil: satır panoda tek satır kalmalı (sıralama,
-- sürükleme, hızlı okuma hepsi ona yaslanıyor), açıklama ise ancak iş açıldığında görünen uzun
-- metin. 10000 karakter — bir yönerge sayfası, bir roman değil.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.tasks ADD COLUMN description text;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_description_sane
  CHECK (description IS NULL OR (btrim(description) <> '' AND length(description) <= 10000));

-- Down Migration

ALTER TABLE public.tasks DROP CONSTRAINT tasks_description_sane;
ALTER TABLE public.tasks DROP COLUMN description;
