import { useEffect, useRef } from 'react';

import { API_BASE_URL } from './api.js';

// `JobEvent` ve `TransferEvent` burada elle yazılmış birer kopya olarak duruyordu ve hiçbir yerde
// kullanılmıyordu: yük aşağıda `unknown` olarak taşınıyor, tipi gerekense sözleşmeden üretilen
// `OpenApi.components['schemas']['JobEvent']` var. Derleyicinin denetlemediği bir kopya, sözleşme
// değiştiği gün sessizce yanlış hâle gelir — ve "Mirrors the contract" yorumu bunu gizlerdi.

type Handler = (payload: unknown) => void;

/**
 * The appliance's one event stream.
 *
 * ONE `EventSource` FOR THE WHOLE APP, held here as a module-level singleton rather than by a
 * component. A browser allows a small number of connections per origin, and a stream per screen
 * would spend them on idle sockets — with the file manager, the jobs board and the transfers panel
 * open that is three of six. It is also what makes the server's poller cost one query per tick
 * instead of one per open screen.
 *
 * A MODULE SINGLETON AND NOT A CONTEXT, because React's development StrictMode mounts every
 * component twice: a connection owned by an effect is opened, closed and reopened on every mount,
 * which on this endpoint means a fresh watermark each time. Reference counting outside React means
 * the second mount finds the first one's connection.
 *
 * RECONNECTION IS THE BROWSER'S JOB — YALNIZ AĞ HATASINDA. `EventSource` düşen bir bağlantıyı
 * kendi kuruyor ve son olayın kimliğini `Last-Event-ID` ile geri gönderiyor, ki §14'ün istediği
 * budur. Ama 200 DIŞI bir yanıtta akışı KALICI olarak kapatıyor ve bir daha denemiyor: uç akış
 * sınırına ulaştığında 429, güncelleme sırasında nginx 502, oturum bittiğinde 401. O noktadan
 * sonra Sistem işleri panosu sessizce donuyor — ölen bir iş "çalışıyor" olarak kalıyor ve
 * kullanıcı elle "Yenile"ye basmadıkça hiçbir şey değişmiyordu. Aşağıdaki yeniden açma yalnız o
 * kalıcı kapanış içindir ve tarayıcının kendi geri çekilmesiyle yarışmaz.
 */
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let holders = 0;
/** Kaçıncı yeniden açma denemesindeyiz. Başarılı bir bağlantı sıfırlıyor. */
let attempts = 0;
let reopenTimer: number | null = null;

/**
 * Yeniden açmadan önceki bekleme.
 *
 * ARTAN, çünkü kapanışın sebebi çoğu zaman sürüyor: 429 ya da 401 varken sabit beş saniye,
 * sunucuya dakikada on iki gereksiz istek atmak ve sayacı canlı tutmak olurdu.
 */
export function reopenDelayMs(attempt: number): number {
  const steps = [5_000, 10_000, 30_000];
  return steps[Math.min(attempt, steps.length - 1)] ?? 30_000;
}

function open(): void {
  if (source !== null) return;
  const stream = new EventSource(`${API_BASE_URL}/events`);
  source = stream;

  stream.addEventListener('open', () => {
    attempts = 0;
  });

  stream.addEventListener('error', () => {
    // Tarayıcı hâlâ deniyorsa (CONNECTING) karışma: iki geri çekilme birbirini yer.
    if (stream.readyState !== EventSource.CLOSED) return;
    // Arada `close()` çağrılmış olabilir; o zaman bu akış artık kimsenin değil ve yerine yenisini
    // açmak, kapatılmış bir bağlantıyı diriltmek olurdu.
    if (source !== stream) return;
    source = null;
    if (holders <= 0) return;
    const wait = reopenDelayMs(attempts);
    attempts += 1;
    reopenTimer = window.setTimeout(() => {
      reopenTimer = null;
      if (holders > 0) open();
    }, wait);
  });

  for (const type of ['job', 'transfer'] as const) {
    stream.addEventListener(type, (event: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // A frame this client cannot read is a frame it ignores. Tearing the stream down over one
        // malformed event would take every other screen's updates with it.
        return;
      }
      for (const handler of handlers.get(type) ?? []) handler(payload);
    });
  }

  // `ping` is deliberately not dispatched anywhere: it exists so the connection carries traffic,
  // and a listener for it would be a listener with nothing to do.
}

function close(): void {
  if (reopenTimer !== null) {
    window.clearTimeout(reopenTimer);
    reopenTimer = null;
  }
  attempts = 0;
  source?.close();
  source = null;
}

/**
 * Hold the stream open for as long as this component is mounted, and receive one kind of event.
 *
 * The handler is kept in a ref rather than in the dependency list. A caller writes
 * `useEventStream('job', (e) => setJobs(...))` with a fresh closure on every render, and putting
 * that in the deps would close and reopen the connection sixty times a second.
 */
export function useEventStream(
  type: 'job' | 'transfer',
  onEvent: (payload: unknown) => void,
): void {
  const latest = useRef(onEvent);
  latest.current = onEvent;

  useEffect(() => {
    const handler: Handler = (payload) => latest.current(payload);
    const set = handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(type, set);

    holders += 1;
    open();

    return () => {
      set.delete(handler);
      holders -= 1;
      // Only when nothing is listening at all. A screen closing must not take the stream away
      // from the screen behind it.
      if (holders <= 0) {
        holders = 0;
        close();
      }
    };
  }, [type]);
}

/**
 * Reload when something moved, instead of on a timer.
 *
 * WHY A REFETCH AND NOT A PATCH. The screens that want these events show DERIVED state: a transfer
 * is `active`, `stalled` or `completed` by a rule the server owns, and the jobs board is filtered
 * by status, so a row moving from `running` to `dead` has to enter or leave a list rather than
 * change in place. Patching a row from the event body would mean re-deriving both of those on the
 * client, and two implementations of one rule is how a screen starts disagreeing with the API.
 *
 * So the event is used for its TIMING and not for its payload: it says "something you care about
 * changed", and the existing REST read stays the single source of what the state now is. The win
 * is still the whole win — a screen with nothing happening makes no requests at all, where the
 * two-second poll it replaces made thirty a minute forever.
 *
 * DEBOUNCED, because a fifty-file upload emits fifty events in a tick and fifty refetches would be
 * worse than the poll. 300 ms is under the threshold where a person reads the update as anything
 * other than immediate.
 */
export function useEventRefresh(type: 'job' | 'transfer', reload: () => void, delayMs = 300): void {
  const timer = useRef<number | null>(null);
  const latest = useRef(reload);
  latest.current = reload;

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  useEventStream(type, () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  });
}
