import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';
import { ConfirmBox } from './ui.js';

type Policy = OpenApi.components['schemas']['TrashPolicy'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The offers, in the order somebody thinks about them. `null` is off. */
const CHOICES: ReadonlyArray<{ days: number | null; label: string }> = [
  { days: null, label: 'Süresiz sakla' },
  { days: 7, label: '7 gün' },
  { days: 30, label: '30 gün' },
  { days: 90, label: '90 gün' },
  { days: 365, label: '1 yıl' },
];

/**
 * §7's retention policy, on the screen where its effect is visible.
 *
 * IN THE BIN AND NOT IN A SETTINGS PANE. This control starts deleting user data permanently, on a
 * schedule, with nobody watching — so it belongs where the data it will delete is on screen. An
 * administrator changing it here can see what they are arming.
 *
 * THE PREVIEW IS THE SAFETY ARGUMENT, not a nicety. Choosing a period re-prices it before anything
 * is saved: how many entries, how many files inside them, and how many bytes would go on the first
 * run. A policy set without that number is a policy set blind, and the number is the one thing that
 * can change an administrator's mind.
 *
 * The byte figure is the server's, summed over the files INSIDE each trashed folder. A client
 * adding up the rows it happens to have on screen would report a trashed 10 GB folder as zero,
 * because a folder's own size is always zero.
 */
export function TrashPolicyBar({
  isAdmin,
  notify,
  onChanged,
}: {
  isAdmin: boolean;
  notify: Notify;
  onChanged: () => void;
}): React.JSX.Element | null {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [considering, setConsidering] = useState<number | null>(null);
  const [preview, setPreview] = useState<Policy['impact'] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let alive = true;
    void (async () => {
      const { data } = await api.GET('/system/trash-policy', {});
      if (!alive || data === undefined) return;
      setPolicy(data);
      setConsidering(data.retentionDays ?? null);
      setPreview(data.impact);
    })();
    return () => {
      alive = false;
    };
  }, [isAdmin, reloadKey]);

  // Re-priced on every choice, before anything is saved. Debounced only lightly: this is a click,
  // not a keystroke, and the number has to be on screen before a hand reaches the save button.
  useEffect(() => {
    if (!isAdmin || considering === null) {
      setPreview({ entries: 0, files: 0, bytes: 0, oldestTrashedAt: null });
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        const { data } = await api.GET('/system/trash-policy', {
          params: { query: { days: considering } },
        });
        if (data !== undefined) setPreview(data.impact);
      })();
    }, 200);
    return () => clearTimeout(timer);
  }, [considering, isAdmin]);

  if (!isAdmin) return null;

  async function save(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.PUT('/system/trash-policy', {
      body: { retentionDays: considering },
    });
    setBusy(false);
    setConfirming(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Politika kaydedilemedi.'));
      return;
    }
    setPolicy(data);
    setPreview(data.impact);
    notify(
      'ok',
      data.retentionDays === null
        ? 'Çöp kutusu süresiz saklanacak.'
        : `Çöpe atılanlar ${data.retentionDays} gün sonra kalıcı olarak silinecek.`,
    );
    reload();
    onChanged();
  }

  const changed = (policy?.retentionDays ?? null) !== considering;
  const willDelete = considering !== null && (preview?.entries ?? 0) > 0;

  return (
    <>
      <div className="netrow">
        <span className="lbl">Saklama süresi</span>
        <select
          className="b"
          aria-label="Çöp kutusu saklama süresi"
          value={considering === null ? '' : String(considering)}
          disabled={busy}
          onChange={(event) =>
            setConsidering(event.target.value === '' ? null : Number(event.target.value))
          }
        >
          {CHOICES.map((choice) => (
            <option key={choice.label} value={choice.days === null ? '' : String(choice.days)}>
              {choice.label}
            </option>
          ))}
        </select>
        {/* What the FIRST run would take, for the value on screen — not for the saved one. */}
        <span className="val">
          {considering === null
            ? 'hiçbir şey silinmez'
            : `${preview?.entries ?? 0} öğe · ${formatBytes(preview?.bytes ?? 0)}`}
        </span>
        <button
          type="button"
          className="b"
          disabled={busy || !changed}
          onClick={() => (willDelete ? setConfirming(true) : void save())}
        >
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>

      {considering !== null && (
        <p className="note">
          Bu süre dolduğunda çöpteki öğeler kalıcı olarak, geri alınamaz biçimde silinir. Silme
          saatte bir çalışır; kaydettiğinizde ilki hemen başlar.
        </p>
      )}

      {confirming && (
        <ConfirmBox
          title="Kalıcı silmeyi aç"
          danger
          // The count and the bytes together, because those are the two facts a person needs and
          // neither is recoverable. The oldest date is there so a policy can be judged against what
          // is actually in the bin rather than against an abstraction.
          body={
            `${preview?.entries ?? 0} öğe (${preview?.files ?? 0} dosya, ` +
            `${formatBytes(preview?.bytes ?? 0)}) ${considering} günden eski. ` +
            `Kaydettiğiniz anda kalıcı olarak silinecekler; geri getirmenin yolu yok.` +
            (preview?.oldestTrashedAt == null
              ? ''
              : ` En eskisi ${new Date(preview.oldestTrashedAt).toLocaleDateString('tr')} tarihinde atılmış.`)
          }
          yesLabel="Sil ve politikayı aç"
          onYes={() => void save()}
          onNo={() => setConfirming(false)}
        />
      )}
    </>
  );
}
