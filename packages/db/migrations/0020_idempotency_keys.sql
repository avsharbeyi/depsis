-- 0020 — Idempotency-Key: dört uçta ilan edilmiş, hiçbir yerde okunmuyordu.
--
-- Sözleşme `Idempotency-Key` başlığını `POST /files/folders`, `POST /file-operations`,
-- `POST /uploads` ve `POST /backups/snapshots` üzerinde tanımlıyor ve semantiğini kendi yazıyor
-- (ADR-0008; IETF taslağı Expired and archived durumunda): "kullanıcı ve uç kapsamında benzersiz,
-- aynı anahtar farklı bir istek parmak iziyle gelirse 409".
--
-- Sunucu başlığı hiç okumuyordu. Yani bir istemci gönderiyor, yanıtı alamıyor, yeniden deniyor —
-- ve ikinci klasör açılıyor, ikinci anlık görüntü alınıyor. Başlığı taşıyıp yok saymak, hiç
-- ilan etmemekten kötü: istemci koruma altında olduğunu sanıyor.
--
-- ── Anahtarın kapsamı ─────────────────────────────────────────────────────────
--
-- (organizasyon, kullanıcı, uç, anahtar). Kullanıcıyı kapsama katmak zorunlu: istemciler
-- anahtarı kendileri üretiyor ve iki kullanıcının aynı UUID'yi seçmesi imkânsız olmasa da nadir
-- olurdu — ama kapsam dışı bırakmak, bir kullanıcının başka bir kullanıcının yanıtını
-- OKUYABİLMESİ demek olurdu. Uç da kapsamda: aynı anahtarla klasör açıp anlık görüntü almak
-- ayrı iki iştir ve birinin yanıtı diğerinin yanıtı değildir.
--
-- ── Parmak izi ────────────────────────────────────────────────────────────────
--
-- İsteğin kanonik hâlinin SHA-256'sı. Saklanan gövde değil, özeti: gövde parola içerebilir
-- (bu dört uçta içermiyor ama tablo bir kural koyuyor) ve karşılaştırma için özet yeterli.
--
-- ── Yarış ─────────────────────────────────────────────────────────────────────
--
-- İki eşzamanlı istek aynı anahtarla gelir. Birincil anahtar üzerinde `ON CONFLICT DO NOTHING`
-- ile yer kapılıyor: kapan çalışır, kapamayan satırı okur. Satır tamamlanmışsa yanıt
-- tekrarlanır, hâlâ uçuşsa 409 `operation-in-progress` döner. Uygulama katmanında bir kilit
-- yerine tablonun kendi benzersizliği, çünkü tek kayıt yeri o.
--
-- ── Neden `status` ve `body` NULL olabiliyor ─────────────────────────────────
--
-- Satır İSTEK başlarken yazılıyor, bitince değil. Bitince yazsaydı iki eşzamanlı isteğin
-- ikisi de çalışır, tabloya ikinci yazan çakışırdı — yani tam da önlenmek istenen şey olurdu.
-- NULL `status`, "bu anahtarla bir iş şu an sürüyor" demek.

-- Up Migration

SELECT public.assert_rls_roles_sane();

CREATE TABLE public.idempotency_keys (
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  user_id         uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- Metot ve yol, örn. `POST /files/folders`. Rota kalıbı değil gerçek yol: bir yol parametresi
  -- isteğin parçası ve iki farklı klasörün altına açılan iki klasör iki ayrı iş.
  endpoint        text        NOT NULL,
  idempotency_key text        NOT NULL,
  -- SHA-256, 32 bayt. Sözleşme anahtar için 255 karakter sınırı koyuyor; parmak izinin uzunluğu
  -- sabit olduğu için burada bir CHECK yeterli.
  fingerprint     bytea       NOT NULL,
  -- Yanıtın durumu, gövdesi ve taşıdığı başlıklar. `status` NULL ise iş hâlâ sürüyor.
  status          smallint,
  body            jsonb,
  -- `POST /uploads` 201 ve BOŞ gövde ile yanıtlıyor; cevabın tamamı `Location` başlığında.
  -- Yalnız gövdeyi saklamak, o isteğin tekrarını istemciye hiçbir şey söylemeyen bir 201 yapardı.
  -- Küçük bir izin listesi saklanıyor, tüm başlıklar değil: `Set-Cookie` tekrarlanmamalı ve
  -- `Date` tekrarlanamaz.
  headers         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,

  PRIMARY KEY (organization_id, user_id, endpoint, idempotency_key),

  CONSTRAINT idempotency_keys_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  CONSTRAINT idempotency_keys_fingerprint_is_sha256 CHECK (octet_length(fingerprint) = 32),
  -- Tamamlanmış bir satır durumunu ve zamanını birlikte taşır. Gövde NULL kalabilir: 204 yanıtı
  -- olan bir uç eklenirse gövdesi yoktur ve bu "tamamlanmadı" ile karıştırılmamalı.
  CONSTRAINT idempotency_keys_completion_is_whole
    CHECK ((status IS NULL) = (completed_at IS NULL)),
  CONSTRAINT idempotency_keys_status_is_http
    CHECK (status IS NULL OR status BETWEEN 100 AND 599)
);

COMMENT ON TABLE public.idempotency_keys IS
  'ADR-0008 Idempotency-Key. Satır isteğin BAŞINDA yazılır; NULL status "sürüyor" demektir. '
  'Başarısız biten istek satırını siler — başarısız bir deneme anahtarı tüketmemeli.';

-- Aynı anahtarı farklı bir istekle kullanmak 409. Sorgu her zaman birincil anahtarla geldiği
-- için ek bir indeks yok; süpürme için tarih üzerinde bir tane var.
CREATE INDEX idempotency_keys_created_at ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_owner_full ON public.idempotency_keys
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY idempotency_keys_tenant_isolation ON public.idempotency_keys
  FOR ALL TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys TO depsis_app;

-- Yedek rolü saklanan yanıt gövdelerini okumaz. Bu gövdeler kullanıcıya dönen yanıtlar; bir
-- yedek dosyasının onları taşıması için bir neden yok.
REVOKE ALL ON public.idempotency_keys FROM depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.idempotency_keys;
