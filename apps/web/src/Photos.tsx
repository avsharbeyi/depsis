import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, API_BASE_URL } from './api.js';
import { previewAs } from './Files.js';
import { Empty, Win } from './ui.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];
type Share = OpenApi.components['schemas']['Share'];

/**
 * Bir sayfada kaç girdi istendiği — sözleşmenin tavanı, dosya yöneticisiyle aynı. Burada okunan
 * şey bir AĞAÇ ve her sayfa bir gidiş-dönüş: en büyük sayfa, aynı fotoğrafları en az istekle
 * getiriyor.
 */
const PAGE = 200;

/** Tarama bütçesi: kaç klasör okunur, kaç fotoğraf toplanır. */
export const BUDGET = { folders: 120, photos: 1200 };

export interface Page {
  items: FileEntry[];
  hasMore: boolean;
  nextCursor?: string;
}

/** Bir klasörün bir sayfasını okuyan şey. Okunamadıysa `null`. */
export type ReadFolder = (
  parentId: string | undefined,
  cursor: string | undefined,
) => Promise<Page | null>;

/**
 * Paylaşımın ağacını gezip fotoğrafları toplar.
 *
 * ── NEDEN İSTEMCİDE ─────────────────────────────────────────────────────────────────────────
 *
 * `GET /files` bir SÜZGEÇ bilmiyor: ne `kind=image`, ne de "alt ağacın tamamı". Sunucuya böyle bir
 * süzgeç eklenene kadar zaman çizelgesini kurmanın tek yolu ağacı gezmek, ve gezinti bedava
 * değil — o yüzden BÜTÇELİ. Sınıra dayanıldığında ekran bunu söylüyor; sessizce kesilmiş bir
 * zaman çizelgesi, eksik olduğunu bilmediğiniz bir albüm demek.
 *
 * ENİNE (breadth-first), derinlemesine değil: fotoğraflar tipik olarak köke yakın birkaç klasörde
 * duruyor ("Fotoğraflar/2026/03"), ve derinlemesine bir gezinti bütçesini tek bir yedek klasörünün
 * dibinde harcayabilirdi.
 *
 * İMLEÇ TAKİP EDİLİYOR. Sunucu sayfa başına en çok 200 satır veriyor; `hasMore` okunmadan yapılan
 * bir gezinti, 400 fotoğraflı bir klasörün ilk 200'ünü görüp gerisini yok sayardı.
 */
export async function walkPhotos(
  read: ReadFolder,
  budget: { folders: number; photos: number } = BUDGET,
): Promise<{ photos: FileEntry[]; truncated: boolean }> {
  const photos: FileEntry[] = [];
  const queue: Array<string | undefined> = [undefined];
  let reads = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (reads >= budget.folders || photos.length >= budget.photos) {
      truncated = true;
      break;
    }
    const parentId = queue.shift();
    let cursor: string | undefined;
    do {
      const page = await read(parentId, cursor);
      reads += 1;
      if (page === null) {
        // Okunamayan bir klasör bütün taramayı düşürmüyor: elde olan fotoğraflar hâlâ doğru, ve
        // eksik olduğu söyleniyor.
        truncated = true;
        break;
      }
      for (const entry of page.items) {
        if (entry.kind === 'folder') queue.push(entry.id);
        else if (previewAs(entry) === 'image') photos.push(entry);
      }
      cursor = page.hasMore ? page.nextCursor : undefined;
      if (page.hasMore && page.nextCursor === undefined) truncated = true;
    } while (cursor !== undefined && reads < budget.folders && photos.length < budget.photos);
  }

  photos.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { photos: photos.slice(0, budget.photos), truncated };
}

/**
 * Zaman çizelgesinin başlıkları: yeniden eskiye, ay ay.
 *
 * §4'ün istediği şey buydu — dosya listesi fotoğrafları ada göre diziyor, oysa bir fotoğraf
 * albümünün sırası zamandır. Ay sınırı yerel takvimden okunuyor; UTC'ye göre gruplamak, ayın ilk
 * gecesi çekilmiş bir fotoğrafı bir önceki aya yazardı.
 */
export function byMonth(
  photos: FileEntry[],
): Array<{ key: string; label: string; items: FileEntry[] }> {
  const groups = new Map<string, { key: string; label: string; items: FileEntry[] }>();
  for (const photo of photos) {
    const at = new Date(photo.modifiedAt);
    const key = Number.isNaN(at.getTime())
      ? 'bilinmiyor'
      : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
    const label = Number.isNaN(at.getTime())
      ? 'Tarihi bilinmeyenler'
      : at.toLocaleDateString('tr-TR', { year: 'numeric', month: 'long' });
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(photo);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Fotoğraflar — §4'ün ana gezinme listesindeki üçüncü modül.
 *
 * BU MODÜL YOKTU, ve eksikliği ürünün kendi hedefini boşa çıkarıyordu: telefondan yüklenmiş
 * dört bin fotoğrafı olan biri onları yalnız dosya listesi içinde, AD sırasına göre görebiliyordu.
 * Zaman çizelgesi, ay başlıkları ve tam ekran gezinme yoktu.
 *
 * Yeni bir uç GEREKMİYOR: kareler `GET /files/{id}/thumbnail` ile (JPEG'in EXIF'ine gömülü küçük
 * resim — dosya başına ~128 kB okunuyor, hiçbir şeyin kodu çözülmüyor), tam ekran ise
 * `GET /files/{id}/content` ile geliyor.
 */
export function Photos({
  onUnauthenticated,
}: {
  onUnauthenticated: () => void;
}): React.JSX.Element {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [shareId, setShareId] = useState<string | undefined>(undefined);
  const [photos, setPhotos] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, response } = await api.GET('/shares', {});
      if (!alive) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) return;
      setShares(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [onUnauthenticated]);

  useEffect(() => {
    let alive = true;
    setPhotos(null);
    setFailed(false);
    setTruncated(false);
    void (async () => {
      const read: ReadFolder = async (parentId, cursor) => {
        const { data, response } = await api.GET('/files', {
          params: {
            query: {
              ...(parentId === undefined ? {} : { parentId }),
              ...(parentId === undefined && shareId !== undefined ? { shareId } : {}),
              limit: PAGE,
              ...(cursor === undefined ? {} : { cursor }),
            },
          },
        });
        if (response.status === 401) {
          onUnauthenticated();
          return null;
        }
        if (data === undefined) return null;
        return {
          items: data.items,
          hasMore: data.hasMore,
          ...(data.nextCursor === undefined ? {} : { nextCursor: data.nextCursor }),
        };
      };
      const found = await walkPhotos(read);
      if (!alive) return;
      // Hiç fotoğraf YOK ile OKUNAMADI ayrı iki şey: boş bir albüm bir olgu, cevapsız kalan bir
      // okuma değil.
      if (found.photos.length === 0 && found.truncated) {
        setFailed(true);
        return;
      }
      setPhotos(found.photos);
      setTruncated(found.truncated);
    })();
    return () => {
      alive = false;
    };
  }, [shareId, reloadKey, onUnauthenticated]);

  const months = useMemo(() => byMonth(photos ?? []), [photos]);

  /**
   * Tam ekranda ok tuşları: bir albümde gezinmenin doğal yolu, tek tek kapatıp açmak değil.
   *
   * SINIRDA DURUYOR. Sıfırın altına ya da sonun ötesine geçen bir dizin, pencereyi çizilecek
   * fotoğrafı olmadan açık bırakırdı — ekranda hiçbir şey yok ama Esc'e basılana kadar da
   * kapanmıyor.
   */
  useEffect(() => {
    if (at === null || photos === null) return undefined;
    const last = photos.length - 1;
    function step(delta: number): void {
      setAt((index) => (index === null ? null : Math.min(Math.max(index + delta, 0), last)));
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'ArrowRight') step(1);
      if (event.key === 'ArrowLeft') step(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, photos]);

  const showing = at === null ? undefined : (photos ?? [])[at];

  return (
    <>
      {shares !== null && shares.length > 1 && (
        <div className="netrow">
          <span className="lbl">Paylaşım</span>
          <select
            className="b"
            aria-label="Hangi paylaşım"
            value={shareId ?? ''}
            onChange={(event) =>
              setShareId(event.target.value === '' ? undefined : event.target.value)
            }
          >
            <option value="">Varsayılan</option>
            {shares.map((share) => (
              <option value={share.id} key={share.id}>
                {share.name}
              </option>
            ))}
          </select>
          <button type="button" className="b" onClick={reload}>
            Yenile
          </button>
        </div>
      )}

      {failed && (
        <Empty
          glyph="⚠"
          text="Fotoğraflar okunamadı."
          action={
            <button type="button" className="b" onClick={reload}>
              Yeniden dene
            </button>
          }
        />
      )}
      {!failed && photos === null && <p className="note">Fotoğraflar taranıyor…</p>}
      {!failed && photos !== null && photos.length === 0 && (
        <Empty glyph="📷" text="Bu paylaşımda fotoğraf yok." />
      )}

      {truncated && photos !== null && photos.length > 0 && (
        <p className="note">
          Tarama sınıra ulaştı: en yeni {photos.length} fotoğraf gösteriliyor. Daha eskileri
          <b> Dosyalar</b> ekranından klasörüyle birlikte açabilirsiniz.
        </p>
      )}

      {months.map((month) => (
        <section key={month.key}>
          <div className="phhd">
            {month.label}
            <span className="s">{month.items.length}</span>
          </div>
          <div className="phgrid">
            {month.items.map((photo) => (
              <button
                type="button"
                className="phcell"
                key={photo.id}
                title={photo.name}
                aria-label={photo.name}
                onClick={() => setAt((photos ?? []).indexOf(photo))}
              >
                <Tile entry={photo} />
              </button>
            ))}
          </div>
        </section>
      ))}

      {showing !== undefined && (
        <Win title={showing.name} glyph="🖼" tone="cool" wide onClose={() => setAt(null)}>
          <div className="phbig">
            <img src={`${API_BASE_URL}/files/${showing.id}/content`} alt={showing.name} />
          </div>
          <div className="row">
            <button
              type="button"
              className="b"
              disabled={at === null || at === 0}
              onClick={() => setAt((index) => (index === null ? null : index - 1))}
            >
              ‹ Önceki
            </button>
            <span className="val">
              {(at ?? 0) + 1} / {(photos ?? []).length}
            </span>
            <button
              type="button"
              className="b"
              disabled={at === null || at >= (photos ?? []).length - 1}
              onClick={() => setAt((index) => (index === null ? null : index + 1))}
            >
              Sonraki ›
            </button>
          </div>
        </Win>
      )}
    </>
  );
}

/** Karesi olan tek tür JPEG: uç, EXIF'e gömülü küçük resmi çıkarıyor, kod çözmüyor. */
const EMBEDDED = new Set(['jpg', 'jpeg']);

/** Küçük resmi olmayan bir fotoğrafın karesi için okunacak en büyük dosya. */
const INLINE_LIMIT = 1_500_000;

/**
 * Izgaranın bir karesi.
 *
 * `fetch`, `<img src>` DEĞİL: uç küçük resmi olmayan dosyaya 204 dönüyor ve bir `<img>` bunu
 * "çözülemedi" diye ele alıp konsola satır yazardı — dosya yöneticisindeki `Thumb`ın aynı
 * gerekçesi. PNG/HEIC gibi gömülü küçük resmi olmayan türlerde kare, dosya YETERİNCE KÜÇÜKSE tam
 * dosyaya düşüyor; büyükse simge kalıyor, çünkü bir ızgarayı kırk megapiksellik dosyalarla
 * doldurmak bu sekmenin belleğini tüketir.
 */
function Tile({ entry }: { entry: FileEntry }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const embedded = EMBEDDED.has(entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase());
  const inline = !embedded && entry.size <= INLINE_LIMIT;

  useEffect(() => {
    if (!embedded) {
      if (inline) setUrl(`${API_BASE_URL}/files/${entry.id}/content`);
      return undefined;
    }
    const stop = new AbortController();
    let object: string | null = null;
    void (async () => {
      try {
        const answer = await fetch(`${API_BASE_URL}/files/${entry.id}/thumbnail`, {
          credentials: 'same-origin',
          signal: stop.signal,
        });
        if (answer.status !== 200) return;
        const blob = await answer.blob();
        if (stop.signal.aborted) return;
        object = URL.createObjectURL(blob);
        setUrl(object);
      } catch {
        // Ağ hatası ya da iptal. Bir karenin gelmemesi albümün sorunu değil.
      }
    })();
    return () => {
      stop.abort();
      // Nesne URL'i açıkça bırakılıyor: tarayıcı onu belge ömrü boyunca tutar, ve bin fotoğraflık
      // bir ızgarada gezinmek onları sızdırmanın en kolay yolu.
      if (object !== null) URL.revokeObjectURL(object);
      setUrl(null);
    };
  }, [entry.id, embedded, inline]);

  if (url === null) {
    return (
      <span className="phnone" aria-hidden>
        🖼
      </span>
    );
  }
  return <img src={url} alt="" loading="lazy" />;
}
