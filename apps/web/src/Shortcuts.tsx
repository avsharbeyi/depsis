import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api.js';
import { shortcutPanes, type PaneId } from './App.js';
import type { Prefs } from './prefs.js';
import { toneRgb, type Tone } from './ui.js';

/**
 * The shortcut field on the desktop.
 *
 * Grid-snapped rather than free-floating, exactly as the reference draws it. A desk where icons
 * land wherever the finger let go looks untidy inside a week, and — more to the point — a saved
 * layout of pixel coordinates is meaningless on the next screen the same account signs in from.
 * What is stored is a list of cells, and it is stored on the SERVER (`/me/preferences`), because
 * somebody who arranges their desk on the television must find that desk on their phone.
 */

interface PaneMeta {
  /**
   * Bir pencere kimliği (`files`) ya da kurulu bir uygulama (`app:immich`).
   *
   * `PaneId` DEĞİL, ve bunun sebebi ikinci tür: kurulu uygulamalar cihaza sonradan geliyor, yani
   * bir birleşim tipiyle sayılamıyorlar. Önek onları ayırmaya yetiyor ve tıklandığında ne
   * yapılacağını da o belirliyor — pencere açmak ile uygulamanın adresine gitmek farklı iki şey.
   */
  id: string;
  label: string;
  glyph: string;
  tone: Tone;
  /** Kurulu bir uygulamaysa açılacak adres; çalışmıyorsa `null`. */
  url?: string | null;
}

/** Kurulu uygulamaların kısayol kimliğindeki önek. */
const APP_PREFIX = 'app:';

/** `.sc` is 78px wide in the stylesheet and the gutter between tiles is 12px. */
const CELL = 78;
const GAP = 12;
const STEP = CELL + GAP;
/** Below this the pointer was resting, not dragging, and the press is a click on the icon. */
const DRAG_SLOP = 4;

type Stored = NonNullable<Prefs['shortcuts']>[number];

interface Placed {
  id: string;
  cell: number;
}

/** The tint `.sc .g` and `.pm .g` expect; the same 24%/100% pair `Glyph` uses. */
function tint(tone: Tone): React.CSSProperties {
  const [r, g, b] = toneRgb(tone);
  return { background: `rgba(${r},${g},${b},.24)`, color: `rgb(${r},${g},${b})` };
}

/**
 * Kaydedilmiş düzen okunuyor — ve TANINMAYAN KİMLİKLER DE KORUNUYOR.
 *
 * Eskiden bir kimlik katalogda yoksa atılıyordu, ve bu iki durumda sessizce yanlıştı: bir sonraki
 * sürümde eklenmiş bir pencere, ve kurulu uygulamalar. İkincisi asıl sorun — uygulama listesi
 * sunucudan GELİYOR, yani ilk çizimde katalogda henüz yok. Atsaydık, sayfayı her açtığında
 * kullanıcının uygulama kısayolları önce kaybolur, sonra ilk sürüklemede kalıcı olarak silinirdi.
 *
 * Çizilemeyen bir kimlik hiçbir şey göstermiyor ama hücresini tutuyor. Görünmez bir hücre biraz
 * kafa karıştırıcı; birinin masasından bir simgeyi sessizce silmek ise geri alınamaz.
 */
function readLayout(stored: readonly Stored[] | undefined): Placed[] {
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const entry of stored ?? []) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({ id: entry.id, cell: entry.cell });
  }
  return out;
}

/**
 * Tanınmayan kimlikler için ayrı bir taşıma YOK, çünkü `readLayout` onları zaten düzende tutuyor.
 *
 * Eskiden burada bir süzgeç vardı: kaydedilmiş ama katalogda olmayan girdiler ayrı toplanıp
 * yazının başına ekleniyordu. Okuma tarafı artık hiçbir şey atmadığı için o süzgeç bugün her
 * girdiyi İKİ KEZ yazardı.
 */
function writeLayout(prefs: Prefs, layout: readonly Placed[]): Prefs {
  return { ...prefs, shortcuts: layout.map(({ id, cell }) => ({ id, cell })) };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Kaydedilmiş hücreleri EKRANDAKİ ızgaraya katlar — ve katlanmış hâli asla kaydetmez.
 *
 * Düzen sunucuda hücre indeksi olarak duruyor ve ızgara ekrana göre ölçülüyor: televizyonda on
 * sütunlu bir masada 25. hücreye konan bir kısayol, telefonda üç sütunla 8. satıra düşüyordu —
 * alanın yüzlerce piksel altına, kaydırılınca Depolama ve Sistem kartlarının üstüne. Alanı
 * `overflow: hidden` ile kırpmak daha kötüsü olurdu: `.sc` mutlak konumlu, yani simge tamamen
 * kaybolur ve geri getirilemezdi.
 *
 * Katlama yalnız ÇİZİM: ızgaranın içine düşen hücreler yerinde kalıyor (televizyonda hiçbir şey
 * değişmiyor), yalnız dışarı taşanlar boş hücrelere sırayla yerleşiyor. Telefonda açmak, kimsenin
 * dokunmadığı bir masayı yeniden yazmamalı — kaydedilen tek şey kullanıcının kendi sürüklediği
 * simgedir.
 *
 * Aynı hücreye düşmüş iki kayıt da buradan çıkıyor: üst üste binmiş, biri erişilemez iki simge
 * yerine ikincisi ilk boş hücreye gidiyor.
 */
export function visiblePlacement(
  layout: readonly Placed[],
  grid: { cols: number; rows: number },
): Map<string, number> {
  const capacity = Math.max(1, grid.cols * grid.rows);
  const shown = new Map<string, number>();
  const taken = new Set<number>();
  const spill: Placed[] = [];

  for (const item of layout) {
    if (item.cell >= 0 && item.cell < capacity && !taken.has(item.cell)) {
      taken.add(item.cell);
      shown.set(item.id, item.cell);
    } else {
      spill.push(item);
    }
  }

  // Kaydedilmiş sıraya göre: katlanan simgeler birbirine göre yerlerini koruyor.
  spill.sort((a, b) => a.cell - b.cell);
  let next = 0;
  for (const item of spill) {
    while (taken.has(next)) next += 1;
    taken.add(next);
    shown.set(item.id, next);
  }
  return shown;
}

/**
 * Yeni bir kısayolun gideceği hücre.
 *
 * İleri doğru yürümek, tıklanan hücre menü açıkken dolduğunda hiçbir şey yapmamaktan iyi; ama
 * sınırsız yürümek ızgaranın dışına bir hücre YAZIYORDU, ve yazılan şey kalıcı. Arama ızgaranın
 * kapasitesinde başa dönüyor: kullanıcı hangi ızgaraya bakıyorsa kaydedilen hücre onun içinde.
 */
export function nextFreeCell(taken: ReadonlySet<number>, wanted: number, capacity: number): number {
  for (let step = 0; step < capacity; step += 1) {
    const cell = (wanted + step) % capacity;
    if (!taken.has(cell)) return cell;
  }
  // Izgara gerçekten dolu. Alan `flex: 1` ile büyüdüğü için bir sonraki satır bir sonraki
  // ölçümde ızgaranın içine giriyor; simgeyi hiç eklememek ise sessizce hiçbir şey yapmaktı.
  let cell = capacity;
  while (taken.has(cell)) cell += 1;
  return cell;
}

export function Shortcuts({
  prefs,
  save,
  onOpen,
  notify,
  isAdmin,
}: {
  prefs: Prefs;
  save: (p: Prefs) => Promise<boolean>;
  onOpen: (pane: PaneId) => void;
  /** Yöneticiye özel pencereler kataloğa yalnız yönetici için giriyor. */
  isAdmin: boolean;
  /**
   * Optional, so the shared signature — `{ prefs, save, onOpen }` — still satisfies this
   * component. Without it a refused arrangement still snaps back to where it was, which is the
   * part that must not be skipped; with it the snap-back can also say why it happened.
   */
  notify?: (kind: 'ok' | 'error', text: string) => void;
}): React.JSX.Element {
  const fieldRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<{ cols: number; rows: number }>({ cols: 1, rows: 1 });
  const [layout, setLayout] = useState<Placed[]>(() => readLayout(prefs.shortcuts));
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; cell: number } | null>(null);
  const [picker, setPicker] = useState<{ cell: number; x: number; y: number } | null>(null);

  /**
   * Kurulu uygulamalar da kısayol olabiliyor.
   *
   * ── NEDEN SUNUCUDAN ─────────────────────────────────────────────────────────────────────
   *
   * Immich gibi uygulamalar cihaza sonradan kuruluyor; hangilerinin kurulu olduğu ve hangi kapı
   * numarasından açıldıkları yalnız cihazın bildiği şeyler. Bu yüzden katalog sabit olamıyor.
   *
   * ── ADRES BURADA KURULUYOR ──────────────────────────────────────────────────────────────
   *
   * Sunucunun `url` alanı 127.0.0.1'i gösteriyor — cihazın kendi üstünden bakınca doğru, telefondan
   * bakınca telefonun kendisi. Doğru ana makine adı bu sayfaya hangi adla gelindiyse odur, ve onu
   * yalnız tarayıcı bilir. `Apps` ekranı da aynısını yapıyor.
   *
   * ── SESSİZCE BAŞARISIZ ──────────────────────────────────────────────────────────────────
   *
   * Uygulama listesi okunamazsa hiçbir uyarı çıkmıyor ve masa pencerelerle çalışmaya devam
   * ediyor: masaüstünün her açılışında bir hata bildirimi, kullanıcının hiç istemediği bir şey
   * için özür dilemek olurdu.
   */
  const [apps, setApps] = useState<PaneMeta[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await api.GET('/apps', {});
      if (!alive || data === undefined) return;
      setApps(
        data.items
          .filter((item) => item.installed)
          .map((item) => ({
            id: `${APP_PREFIX}${item.catalogue.slug}`,
            label: item.catalogue.name,
            glyph: '🧩',
            tone: 'iris',
            url:
              item.state === 'running' && item.hostPort !== null && item.hostPort !== undefined
                ? `http://${window.location.hostname}:${item.hostPort}`
                : null,
          })),
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Eklenebilecek her şey: alt bardaki pencereler ve kurulu uygulamalar.
   *
   * Pencereler alt barın kendisinden türetiliyor, elle yazılmış ikinci bir listeden değil — o
   * liste geride kalmıştı ve on sekiz pencerenin yalnız on biri eklenebiliyordu.
   */
  const catalogue = useMemo<PaneMeta[]>(
    () => [...shortcutPanes(isAdmin), ...apps],
    [isAdmin, apps],
  );
  const metaFor = useCallback(
    (id: string): PaneMeta | undefined => catalogue.find((pane) => pane.id === id),
    [catalogue],
  );

  /** Bir kısayola tıklandığında: pencere açılır, ya da uygulamanın adresine gidilir. */
  const activate = useCallback(
    (pane: PaneMeta): void => {
      if (!pane.id.startsWith(APP_PREFIX)) {
        onOpen(pane.id as PaneId);
        return;
      }
      if (pane.url === null || pane.url === undefined) {
        // ÇALIŞMAYAN BİR UYGULAMA SESSİZCE AÇILMIYOR. Boş bir sekme, kullanıcıya uygulamanın
        // bozuk olduğunu değil tarayıcının bozuk olduğunu düşündürürdü.
        notify?.('error', `${pane.label} çalışmıyor; Uygulamalar ekranından başlatın.`);
        return;
      }
      window.open(pane.url, '_blank', 'noopener,noreferrer');
    },
    [notify, onOpen],
  );

  /**
   * The saved layout is adopted by value, not by identity.
   *
   * `usePrefs` hands back a fresh object after every PUT, so an effect keyed on the array itself
   * would re-seed the state on every save — including the save this component just started — and
   * an icon mid-drag would jump back to where it came from. The signature only changes when the
   * cells actually do.
   */
  const signature = JSON.stringify(prefs.shortcuts ?? []);
  const storedRef = useRef<readonly Stored[] | undefined>(prefs.shortcuts);
  useEffect(() => {
    storedRef.current = prefs.shortcuts;
  });
  useEffect(() => {
    setLayout(readLayout(storedRef.current));
  }, [signature]);

  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    const measure = (): void => {
      setGrid({
        cols: Math.max(1, Math.floor((field.clientWidth + GAP) / STEP)),
        rows: Math.max(1, Math.floor((field.clientHeight + GAP) / STEP)),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    measure();
    return () => observer.disconnect();
  }, []);

  const positionOf = useCallback(
    (cell: number): { left: number; top: number } => ({
      left: (cell % grid.cols) * STEP,
      top: Math.floor(cell / grid.cols) * STEP,
    }),
    [grid.cols],
  );

  /**
   * Hangi simgenin EKRANDA hangi hücrede durduğu.
   *
   * Sürükleme ve ekleme de bu haritayı okuyor, kaydedilmiş hücreleri değil: kullanıcı ekranda
   * gördüğü hücreye bırakıyor, ve takas kararını kaydedilmiş hücrelere göre vermek katlanmış bir
   * ızgarada yanlış simgeyi yerinden oynatırdı.
   */
  const shown = useMemo(() => visiblePlacement(layout, grid), [layout, grid]);

  /** Where an icon whose top-left corner sits at (x, y) would land. Nearest cell, so a half-step
   *  nudge still commits to a move rather than snapping back. */
  const cellUnderCorner = useCallback(
    (x: number, y: number): number => {
      const col = clamp(Math.round(x / STEP), 0, grid.cols - 1);
      const row = clamp(Math.round(y / STEP), 0, grid.rows - 1);
      return row * grid.cols + col;
    },
    [grid.cols, grid.rows],
  );

  /** Which cell a bare click on the field belongs to. Floor, not round: a click 50px into an
   *  80px-wide cell is a click on that cell, not on the one next door. */
  const cellUnderPoint = useCallback(
    (x: number, y: number): number => {
      const col = clamp(Math.floor(x / STEP), 0, grid.cols - 1);
      const row = clamp(Math.floor(y / STEP), 0, grid.rows - 1);
      return row * grid.cols + col;
    },
    [grid.cols, grid.rows],
  );

  /**
   * Move the icons, then keep them there only if the server agreed.
   *
   * The optimistic half is deliberate — an icon that waits for a round trip before following the
   * finger feels broken. The rollback is the half that was missing: `PUT /me/preferences` answers
   * 422 on a document it refuses, `usePrefs.save` correctly leaves `prefs` untouched, and the
   * re-seed effect below is keyed on the STORED cells, which a refusal does not change. So without
   * this the icon sat happily in its new cell, nothing was written, and the desk quietly reverted
   * on the next reload.
   */
  const persist = useCallback(
    (next: Placed[]): void => {
      const previous = layout;
      setLayout(next);
      void (async () => {
        const ok = await save(writeLayout(prefs, next));
        if (ok) return;
        setLayout(previous);
        notify?.('error', 'Kısayol düzeni kaydedilemedi.');
      })();
    },
    [layout, notify, prefs, save],
  );

  /* ─── dragging ────────────────────────────────────────────────────────────── */

  const grabRef = useRef<{
    id: string;
    /** Where inside the icon the finger went down, so it does not jump under the cursor. */
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  /** Set when a drag ends, so the click that follows the release does not also open the pane. */
  const draggedRef = useRef(false);

  /* ─── kısayol ekleme jesti ────────────────────────────────────────────────── */

  /**
   * Boş alana BİR kez tıklamak menüyü açmıyordu — açıyordu, ve sorun da buydu.
   *
   * Kısayol alanı masaüstünün zeminidir: bir pencereyi kapatmak, bir sürüklemeyi bırakmak, bir
   * menüyü kapatmak için yapılan her ıskalanmış tıklama oraya düşüyor. Tek tıklamayla açılan bir
   * menü, cihazın sahibinin sözleriyle "sürekli o çıkıyor" demek — yani kullanıcının hiç
   * istemediği bir pencere, en sık yaptığı hareketin karşılığı oluyordu.
   *
   * ÇİFT TIKLAMA ya da BASILI TUTMA. İkisi de kasıtlı olduğu belli olan, kazayla yapılmayan
   * hareketler; ve ikisi birden var çünkü biri fare, diğeri dokunmatik ekran için. Cihazın
   * kendi ekranı dokunmatik olabildiği için ikincisi bir incelik değil, gereklilik: dokunmatikte
   * çift dokunma çoğu tarayıcıda yakınlaştırma demek.
   */
  const LONG_PRESS_MS = 500;
  /** Parmağın bu kadar kaymasi, basılı tutmayı bir sürükleme sayıyor ve iptal ediyor. */
  const LONG_PRESS_SLOP = 10;
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null);

  const cancelLongPress = useCallback((): void => {
    if (pressRef.current === null) return;
    window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);

  // Bileşen giderken zamanlayıcı da gitmeli: ekran değişince açılan bir menü, artık var olmayan
  // bir zemine ait olurdu.
  useEffect(() => cancelLongPress, [cancelLongPress]);

  const openPicker = useCallback((field: HTMLDivElement, x: number, y: number): void => {
    const rect = field.getBoundingClientRect();
    setPicker({ cell: cellUnderPoint(x - rect.left, y - rect.top), x, y });
  }, []);

  const onPointerDown = (id: string, event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    grabRef.current = {
      id,
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    // Capture, so a fast drag that outruns the pointer keeps sending moves to this element rather
    // than to whatever is underneath it.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const grab = grabRef.current;
    const field = fieldRef.current;
    if (grab === null || field === null) return;
    if (!grab.moved) {
      const travelled = Math.hypot(event.clientX - grab.startX, event.clientY - grab.startY);
      if (travelled < DRAG_SLOP) return;
      grab.moved = true;
    }
    const rect = field.getBoundingClientRect();
    const x = event.clientX - rect.left - grab.dx;
    const y = event.clientY - rect.top - grab.dy;
    setDrag({ id: grab.id, x, y, cell: cellUnderCorner(x, y) });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const grab = grabRef.current;
    grabRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    const field = fieldRef.current;
    if (grab === null || field === null) return;
    if (!grab.moved) return;
    draggedRef.current = true;

    // Recomputed from the release point rather than read off the drag state: the last pointermove
    // may not have been rendered yet, and committing a stale cell moves the icon somewhere the
    // user never saw the ghost.
    const rect = field.getBoundingClientRect();
    const target = cellUnderCorner(
      event.clientX - rect.left - grab.dx,
      event.clientY - rect.top - grab.dy,
    );

    // EKRANDAKİ hücreden ekrandaki hücreye. Kaydedilmiş indeks katlanmış bir ızgarada başka bir
    // yeri gösteriyor, ve ona göre karar vermek kullanıcının hiç dokunmadığı simgeyi taşırdı.
    const from = shown.get(grab.id);
    if (from === undefined || from === target) return;
    const occupantId = [...shown.entries()].find(
      ([id, cell]) => cell === target && id !== grab.id,
    )?.[0];
    // Occupied cells swap rather than refuse. Refusing looks like the drag failed; stacking would
    // hide one icon behind another with no way to get it back.
    const next = layout.map((item) => {
      if (item.id === grab.id) return { ...item, cell: target };
      if (occupantId !== undefined && item.id === occupantId) return { ...item, cell: from };
      return item;
    });
    // One write, on release. Saving per pointermove would spend fifty PUTs on a single drag.
    persist(next);
  };

  /* ─── adding and removing ─────────────────────────────────────────────────── */

  const add = (id: string, cell: number): void => {
    // The click may land on a cell that filled up while the menu was open, or the menu may have
    // been opened over an icon's shadow. Walking forward is less surprising than doing nothing.
    const taken = new Set(shown.values());
    const free = nextFreeCell(taken, cell, Math.max(1, grid.cols * grid.rows));
    persist([...layout, { id, cell: free }]);
  };

  const remove = (id: string): void => {
    persist(layout.filter((item) => item.id !== id));
  };

  /* ─── the add menu ────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (picker === null) return;
    const close = (): void => setPicker(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    // `mousedown` rather than `click`: the menu must be gone before the press lands on whatever is
    // behind it, otherwise closing it also opens a window.
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [picker]);

  const placed = new Set(layout.map((item) => item.id));
  const available = catalogue.filter((pane) => !placed.has(pane.id));

  return (
    <div
      className="shorts"
      ref={fieldRef}
      onDoubleClick={(event) => {
        // Only a press on the bare field opens the menu; a press that started on an icon has
        // already been handled by the icon itself.
        if (event.target !== event.currentTarget) return;
        openPicker(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerDownCapture={(event) => {
        // BASILI TUTMA, yalnız çıplak zeminde ve yalnız birincil düğmeyle. Bir simgenin üstünde
        // başlayan basış bir sürüklemedir ve onu bu jest bölmemeli.
        cancelLongPress();
        if (event.target !== event.currentTarget) return;
        if (event.button !== 0) return;
        const field = event.currentTarget;
        const { clientX: x, clientY: y } = event;
        pressRef.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            pressRef.current = null;
            openPicker(field, x, y);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMoveCapture={(event) => {
        // Kayan bir parmak basılı tutma değildir. Eşik olmadan, dokunmatik ekranın kaçınılmaz
        // birkaç piksellik titremesi jesti her seferinde iptal ederdi.
        const press = pressRef.current;
        if (press === null) return;
        if (
          Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP ||
          Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP
        ) {
          cancelLongPress();
        }
      }}
      onPointerUpCapture={cancelLongPress}
      onPointerCancelCapture={cancelLongPress}
      onContextMenu={(event) => {
        // Dokunmatikte uzun basış, tarayıcının kendi bağlam menüsünü de açıyor. İkisi üst üste
        // binince kullanıcı iki menü görüyor ve hangisinin ürüne ait olduğunu bilemiyor.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      {layout.length === 0 && (
        <span
          className="thint"
          style={{ position: 'absolute', left: 2, top: 4, pointerEvents: 'none' }}
        >
          Boş bir yere çift tıklayarak (ya da basılı tutarak) kısayol ekleyin.
        </span>
      )}

      <div
        className={drag === null ? 'ghost' : 'ghost on'}
        style={drag === null ? undefined : positionOf(drag.cell)}
      />

      {layout.map((item) => {
        const pane = metaFor(item.id);
        if (pane === undefined) return null;
        const dragging = drag !== null && drag.id === item.id;
        const place = dragging
          ? { left: drag.x, top: drag.y }
          : positionOf(shown.get(item.id) ?? item.cell);

        return (
          <div
            key={item.id}
            className={dragging ? 'sc dragging' : 'sc'}
            style={place}
            role="button"
            tabIndex={0}
            aria-label={pane.label}
            onPointerDown={(event) => onPointerDown(item.id, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              activate(pane);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              activate(pane);
            }}
          >
            <span className="g" style={tint(pane.tone)} aria-hidden>
              {pane.glyph}
            </span>
            <span className="l">{pane.label}</span>
            <button
              type="button"
              className="x"
              aria-label={`${pane.label} kısayolunu kaldır`}
              // The press must not become a drag of the icon it sits on.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                remove(item.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      {picker !== null && (
        <div
          className="pmenu on"
          role="menu"
          aria-label="Kısayol ekle"
          // `.pmenu` is fixed and anchored to the dock in the stylesheet; here it belongs to the
          // cell that was clicked, so the anchoring is overridden rather than a class invented.
          style={{
            left: Math.min(picker.x, window.innerWidth - 248),
            top: Math.min(picker.y, window.innerHeight - 260),
            bottom: 'auto',
            transform: 'none',
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="pmh">Kısayol ekle</div>
          {available.length === 0 ? (
            <div className="pm dis">Eklenecek başka bir şey kalmadı</div>
          ) : (
            available.map((pane) => (
              <button
                key={pane.id}
                type="button"
                className="pm"
                role="menuitem"
                onClick={() => {
                  add(pane.id, picker.cell);
                  setPicker(null);
                }}
              >
                <span className="g" style={tint(pane.tone)} aria-hidden>
                  {pane.glyph}
                </span>
                {pane.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
