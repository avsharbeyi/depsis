import type { OpenApi } from '@depsis/contracts';
import { useEffect, useRef, useState } from 'react';

import { api, isTransportFailure } from './api.js';

type Telemetry = OpenApi.components['schemas']['Telemetry'];
type Person = OpenApi.components['schemas']['DirectoryEntry'];

/**
 * Everything the desktop knows about the appliance at one instant.
 *
 * One object, fetched once, rather than each card polling for itself. Six cards each running their
 * own ten-second timer means the storage ring and the temperature pill can disagree about the same
 * disk, and the operator has no way to tell which of the two is the stale one.
 */
export interface Snapshot {
  telemetry: Telemetry | null;
  /** Why telemetry is absent, when it is. Distinct causes, not one undifferentiated "failed". */
  telemetryNote: string | null;
  /**
   * The tenant's account names — a name and an id, nothing else.
   *
   * `null` means NOT YET KNOWN, and now only that. It used to also mean "the caller is a member",
   * because this polled the administrators-only `/users`; the board consequently offered a member
   * no way to assign work to anybody, and the column for a colleague appeared only once that
   * colleague already had a task on it.
   */
  users: Person[] | null;
  /** Load average, most recent last, capped at 40 samples — a little over six minutes. */
  cpuHistory: number[];
}

const REFRESH_MS = 10_000;
const HISTORY_LENGTH = 40;

/**
 * Telemetri okunamadığında masanın altında yazan cümle.
 *
 * SUNUCUYA ULAŞILAMAMASI AYRI BİR ŞEY. `api.ts` düşen bir bağlantıyı fırlatmıyor, taşıma
 * işaretli bir cevaba çeviriyor — yani aşağıdaki `catch` hiç çalışmıyor ve "son bilinen durum
 * gösteriliyor" sözü hiçbir zaman tutulmuyordu. API beş saniye yeniden başlarken Depolama ve
 * Sistem kartları "Sistem durumu okunamadı." uyarısına dönüyor, halka, sıcaklık ve havuz
 * satırları siliniyordu; oysa on saniye önceki gerçek rakamlar elde duruyor.
 *
 * ELDE ESKİ BİR CEVAP YOKSA O SÖZ VERİLMİYOR: ilk yoklamada "son bilinen durum gösteriliyor"
 * demek, ekranda gösterilmeyen bir şeyi gösteriyorum demek olurdu.
 */
export function telemetryNoteFor(state: {
  status: number;
  transportFailure: boolean;
  /** Cevap okunabildi mi — okunduysa söylenecek bir şey yok. */
  read: boolean;
  hadPrevious: boolean;
}): string | null {
  if (state.read) return null;
  if (state.status === 403) {
    // Not an error to report loudly, and worded for what the endpoint actually checks.
    // `SystemController.telemetry` asks `isSystemAdministrator` — the ONE account recorded in
    // `system_setup` — rather than `role = 'admin'` like `/backups` next door. Saying
    // "yalnızca yöneticilere" would tell a second promoted administrator, who is shown every
    // other admin pane, that they are not one.
    return 'Sistem ayrıntıları yalnız cihazı kuran hesaba açık.';
  }
  if (state.status === 503) {
    // The pool figures can only come from the privileged agent. No agent is the expected state of
    // an appliance whose pool has not been created yet, so this is not a fault.
    return 'Depolama ajanı yanıt vermiyor. Havuz henüz kurulmadıysa bu beklenen.';
  }
  if (state.transportFailure) {
    return state.hadPrevious
      ? 'Sunucuya ulaşılamıyor; son bilinen durum gösteriliyor.'
      : 'Sunucuya ulaşılamıyor.';
  }
  return 'Sistem durumu okunamadı.';
}

/**
 * Polls `/system/telemetry` and `/directory/users` together and keeps a short load history.
 *
 * Returns `null` until the first answer arrives, so a caller can tell "nothing known yet" from
 * "known to be empty" — the two look identical once they are both rendered as zeroes.
 */
export function useSnapshot({
  onUnauthenticated,
}: {
  onUnauthenticated: () => void;
}): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // The history lives in a ref because it is an input to the next poll as well as an output of the
  // last one. Held in state it would have to be a dependency of the effect below, and the polling
  // loop would then tear itself down and restart on every single sample.
  const history = useRef<number[]>([]);

  // The callback is re-created by the parent on some renders; capturing it in a ref keeps the
  // timer from being cancelled and restarted for a reason that has nothing to do with polling.
  const signalUnauthenticated = useRef(onUnauthenticated);
  useEffect(() => {
    signalUnauthenticated.current = onUnauthenticated;
  }, [onUnauthenticated]);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    /** Returns false when the session has ended, which is the one case that must not reschedule. */
    const poll = async (): Promise<boolean> => {
      try {
        const [telemetry, users] = await Promise.all([
          api.GET('/system/telemetry', {}),
          api.GET('/directory/users', {}),
        ]);
        if (!alive) return false;

        if (telemetry.response.status === 401 || users.response.status === 401) {
          signalUnauthenticated.current();
          return false;
        }

        const dropped = isTransportFailure(telemetry.response);

        const load = telemetry.data?.cpu.loadAverage?.[0];
        if (typeof load === 'number' && Number.isFinite(load)) {
          history.current = [...history.current, load].slice(-HISTORY_LENGTH);
        }

        setSnapshot((previous) => ({
          // Düşen bir bağlantı, bir dakika önce gerçek rakamlar gösteren masayı boşaltmamalı;
          // cevap gelmiş bir ret (403/503) ise eski rakamları geçersiz kılar ve ekranda
          // bırakılmamalıdır.
          telemetry: telemetry.data ?? (dropped ? (previous?.telemetry ?? null) : null),
          telemetryNote: telemetryNoteFor({
            status: telemetry.response.status,
            transportFailure: dropped,
            read: telemetry.data !== undefined,
            hadPrevious: (previous?.telemetry ?? null) !== null,
          }),
          // A failed name list keeps the PREVIOUS one rather than blanking to null: this poll runs
          // every ten seconds, and one miss would otherwise take every column off the job board
          // and put it back a moment later.
          users: users.data?.items ?? previous?.users ?? null,
          cpuHistory: history.current,
        }));
        return true;
      } catch {
        if (!alive) return false;
        // BURASI BUGÜN ÇALIŞMIYOR ve bilerek duruyor: `api.ts`'in `onError`'ı düşen bağlantıyı
        // fırlatmadan taşıma işaretli bir cevaba çeviriyor, o yüzden asıl iş yukarıda
        // `telemetryNoteFor` ile yapılıyor. Sözleşme bir gün değişip fırlatmaya dönerse masayı
        // boşaltmayan tek koruma bu dal olur.
        setSnapshot((previous) => ({
          telemetry: previous?.telemetry ?? null,
          telemetryNote: telemetryNoteFor({
            status: 0,
            transportFailure: true,
            read: false,
            hadPrevious: (previous?.telemetry ?? null) !== null,
          }),
          users: previous?.users ?? null,
          cpuHistory: history.current,
        }));
        return true;
      }
    };

    const tick = async (): Promise<void> => {
      const again = await poll();
      if (alive && again) timer = window.setTimeout(() => void tick(), REFRESH_MS);
    };

    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  return snapshot;
}
