-- Katalogdaki Chromium geri alınıyor — kiosk onun doğru cevabıydı.
--
-- 0039 tarayıcıyı bir konteyner olarak eklemişti: KasmVNC, tarayıcı içinde tarayıcı. Sahibi
-- kioskla yan yana görünce adını doğru koydu: "chromu açınca chrome içinde sanal bir chrome
-- açıyor." Cihazın ekranındaki kiosk (depsis-kiosk.service) gerçek Chromium'un ta kendisi;
-- sanal olanın kattığı tek şey kafa karışıklığıydı. Satır katalogdan düşüyor; kurulu bir
-- örneği varsa migration'dan önce olağan Kaldır akışıyla kaldırılmış olmalı — yine de burada
-- artakalan örnek kayıtları da temizleniyor ki tuttukları port geri dönsün.
--
-- `shm_bytes` kolonu KALIYOR: tarayıcıya gelmişti ama herhangi bir imaj için doğru bir olgu.

-- Up Migration

SELECT public.assert_rls_roles_sane();

DELETE FROM public.app_instances
 WHERE catalogue_id IN (SELECT id FROM public.app_catalogue WHERE slug = 'chromium');
DELETE FROM public.app_catalogue_containers
 WHERE catalogue_id IN (SELECT id FROM public.app_catalogue WHERE slug = 'chromium');
DELETE FROM public.app_catalogue WHERE slug = 'chromium';

-- Down Migration

INSERT INTO public.app_catalogue (slug, name, summary, icon, container_port)
VALUES ('chromium', 'Chrome (Chromium)',
        'Kutunun üstünde koşan, her cihazın tarayıcısından kullanılan bir Chromium.',
        '🌐', 3000);

INSERT INTO public.app_catalogue_containers
       (catalogue_id, role, ordinal, is_primary, image, tag, env, mounts, volumes, shm_bytes)
SELECT id, 'app', 0, true,
       'lscr.io/linuxserver/chromium', '6edd71b2-ls16',
       '{"TZ":"Europe/Istanbul"}'::jsonb, '[]'::jsonb,
       '[{"target":"/config","purpose":"Tarayıcı profili"}]'::jsonb, 1073741824
  FROM public.app_catalogue
 WHERE slug = 'chromium';
