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
 * Kaydet düğmesinin ne yapacağı — ve NE ZAMAN HİÇBİR ŞEY YAPMAYACAĞI.
 *
 * ÖNİZLEME KAYDETMENİN FRENİ, ve fren yalnız EKRANDAKİ SEÇİMİN fiyatı elde varken tutuyor.
 * Düğme eskiden seçim değişir değişmez etkinleşiyordu; fiyat ise 200 ms sonra, bir ağ
 * gidiş-dönüşünün ardından geliyordu. Aradaki boşlukta "Süresiz"in sıfırı ekranda duruyor,
 * `willDelete` false çıkıyor ve onay kutusu HİÇ ÇIKMADAN kayıt gidiyordu — sunucu da kaydı alır
 * almaz süpürücüyü çalıştırıyor. Klavyeyle seçip Tab+Enter yapan biri, çöpteki her şeyi
 * geri getirilemez biçimde silmiş oluyordu.
 *
 * `priced` yalnız EKRANDAKİ gün sayısı için fiyat varken dolu; başka bir günün fiyatı ile
 * karşılaştırmak, fiyatın hiç olmamasıyla aynı şey.
 */
export type SaveAction = 'blocked' | 'save' | 'confirm';

export function trashSaveAction(input: {
  busy: boolean;
  changed: boolean;
  considering: number | null;
  priced: { days: number | null; entries: number } | null;
}): SaveAction {
  if (input.busy || !input.changed) return 'blocked';
  if (input.priced === null || input.priced.days !== input.considering) return 'blocked';
  return input.considering !== null && input.priced.entries > 0 ? 'confirm' : 'save';
}

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
  /** Fiyat, HANGİ GÜN İÇİN hesaplandığıyla birlikte: ayrı tutulan iki değer birbirinden kayar. */
  const [priced, setPriced] = useState<{ days: number | null; impact: Policy['impact'] } | null>(
    null,
  );
  const [priceFailed, setPriceFailed] = useState(false);
  /** Fiyat isteğini aynı gün için yeniden başlatan sayaç — seçimi değiştirmek tek yol olmamalı. */
  const [priceKey, setPriceKey] = useState(0);
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
      setPriced({ days: data.retentionDays ?? null, impact: data.impact });
    })();
    return () => {
      alive = false;
    };
  }, [isAdmin, reloadKey]);

  // Re-priced on every choice, before anything is saved. Debounced only lightly: this is a click,
  // not a keystroke, and the number has to be on screen before a hand reaches the save button.
  useEffect(() => {
    if (!isAdmin) return undefined;
    setPriceFailed(false);
    if (considering === null) {
      // "Süresiz"in fiyatı ağa sorulmadan bilinir: hiçbir şey silinmez.
      setPriced({ days: null, impact: { entries: 0, files: 0, bytes: 0, oldestTrashedAt: null } });
      return undefined;
    }
    // ÖNCE ESKİ RAKAM DÜŞÜYOR. Ekranda duran sayı bir önceki seçimin fiyatıdır, ve onu yeni
    // seçimin yanında bırakmak yalnız yanlış bir sayı göstermek değil, Kaydet'e o sayıya göre
    // karar verdirmekti.
    setPriced(null);
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const { data } = await api.GET('/system/trash-policy', {
          params: { query: { days: considering } },
        });
        if (!alive) return;
        if (data === undefined) {
          setPriceFailed(true);
          return;
        }
        setPriced({ days: considering, impact: data.impact });
      })();
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [considering, isAdmin, priceKey]);

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
    setPriced({ days: data.retentionDays ?? null, impact: data.impact });
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
  // Yalnız EKRANDAKİ seçimin fiyatı; başka bir günün fiyatı burada `null` sayılıyor.
  const impact = priced !== null && priced.days === considering ? priced.impact : null;
  const action = trashSaveAction({
    busy,
    changed,
    considering,
    priced: priced === null ? null : { days: priced.days, entries: priced.impact.entries },
  });

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
            : impact === null
              ? priceFailed
                ? 'hesaplanamadı'
                : 'hesaplanıyor…'
              : `${impact.entries} öğe · ${formatBytes(impact.bytes)}`}
        </span>
        <button
          type="button"
          className="b"
          disabled={action === 'blocked'}
          onClick={() => (action === 'confirm' ? setConfirming(true) : void save())}
        >
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>

      {priceFailed && (
        <p className="note warn">
          Bu sürenin kaç öğeyi sileceği hesaplanamadı. Kaç şeyin gideceğini görmeden bu politikayı
          açmak, çöp kutusunu görmeden boşaltmaktır.{' '}
          <button type="button" className="lnk" onClick={() => setPriceKey((key) => key + 1)}>
            Yeniden dene
          </button>
        </p>
      )}

      {considering !== null && (
        <p className="note">
          Bu süre dolduğunda çöpteki öğeler kalıcı olarak, geri alınamaz biçimde silinir. Silme
          saatte bir çalışır; kaydettiğinizde ilki hemen başlar.
        </p>
      )}

      {/* `impact` OLMADAN ÇİZİLMİYOR: rakamsız bir onay kutusu, onayladığı şeyi söylemiyor
          demektir — ve bu kutunun tek işi o rakamı göstermek. */}
      {confirming && impact !== null && (
        <ConfirmBox
          title="Kalıcı silmeyi aç"
          danger
          // The count and the bytes together, because those are the two facts a person needs and
          // neither is recoverable. The oldest date is there so a policy can be judged against what
          // is actually in the bin rather than against an abstraction.
          body={
            `${impact.entries} öğe (${impact.files} dosya, ` +
            `${formatBytes(impact.bytes)}) ${considering} günden eski. ` +
            `Kaydettiğiniz anda kalıcı olarak silinecekler; geri getirmenin yolu yok.` +
            (impact.oldestTrashedAt == null
              ? ''
              : ` En eskisi ${new Date(impact.oldestTrashedAt).toLocaleDateString('tr')} tarihinde atılmış.`)
          }
          yesLabel="Sil ve politikayı aç"
          onYes={() => void save()}
          onNo={() => setConfirming(false)}
        />
      )}
    </>
  );
}
