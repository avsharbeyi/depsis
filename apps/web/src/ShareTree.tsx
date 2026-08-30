import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';

type Storage = OpenApi.components['schemas']['StorageSetup'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Havuz var, paylaşım ağacı yok — ve çıkış yolu.
 *
 * ── NEDEN ORTAK BİR PARÇA ────────────────────────────────────────────────────
 *
 * Bu uyarı Diskler ekranında zaten vardı, düğmesiyle birlikte. Sahadaki ilk kurulumda işe
 * yaramadı: havuzu kuran kişi paylaşım açmak için Paylaşımlar ekranına gitti, "Yeni paylaşım"
 * dedi, ve tek gördüğü şey bir bildirim oldu — "Depolama havuzu ayarlı değil ya da ajana
 * ulaşılamıyor". Cümle doğruydu ve hiçbir işe yaramıyordu: ne hangisi olduğunu söylüyor, ne de
 * ne yapılacağını.
 *
 * Çare bir başka ekranda duruyordu, ve orayı açmak için oraya gitmesi gerektiğini bilmesi
 * gerekiyordu. Cihazın sahibinin ürünün iç bölümlenmesini bilmesi beklenemez; eksik olan şeyin
 * çaresi, eksikliğin GÖRÜLDÜĞÜ yerde durmalı.
 *
 * ── NEDEN BİR DÜĞME, BİR TALİMAT DEĞİL ───────────────────────────────────────
 *
 * Bu uyarının ilk hâli `zfs create -o mountpoint=…` diye bir kabuk komutu veriyordu. DEPSIS bir
 * tüketici cihazı: sahibi olağan hiçbir iş için terminale girmemeli, ve "havuz kurdum ama dosya
 * koyamıyorum" olağan bir durumun ta kendisi.
 *
 * YIKICI DEĞİL. `prepare_share_root` bir veri kümesi OLUŞTURUR ve ajan dolu bir kökü reddeder,
 * o yüzden §8.1'in yıkıcı işlem töreni (parola, adı yazarak onay) burada yok.
 */
export function ShareTreeNotice({
  storage,
  notify,
  onPrepared,
}: {
  /** Kutunun depolama durumu; `null` iken hiçbir iddiada bulunulmaz. */
  storage: Storage | null;
  notify: Notify;
  onPrepared: () => void;
}): React.JSX.Element | null {
  const [preparing, setPreparing] = useState(false);

  const pools = storage?.pools ?? [];
  const pool = pools[0];

  async function prepare(): Promise<void> {
    if (pool === undefined) return;
    setPreparing(true);
    const { data, error } = await api.POST('/storage/share-tree', { body: { pool } });
    setPreparing(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Paylaşım ağacı kurulamadı.'));
      return;
    }
    notify('ok', `Paylaşım ağacı kuruldu: ${data.dataset}. Artık paylaşım açabilirsiniz.`);
    onPrepared();
  }

  // ÜÇÜNCÜ DURUM DA VAR: havuz yok. O zaman söylenecek şey bu değil — kullanıcının önce bir havuz
  // kurması gerekiyor, ve onu söyleyen ekran Diskler.
  if (storage === null || pool === undefined || storage.parentDataset !== undefined) return null;

  return (
    <div className="warn">
      <span className="ic" aria-hidden>
        ⚠
      </span>
      <span className="tx">
        <b>Havuz var, paylaşım ağacı yok.</b> DEPSIS paylaşımları hangi veri kümesinin altında
        açacağını bilmiyor, o yüzden yeni paylaşım açılamıyor. Aşağıdaki düğme onu {pool} havuzunda
        kurar; hiçbir şey silmez.{' '}
        <button type="button" className="b" disabled={preparing} onClick={() => void prepare()}>
          {preparing ? 'Kuruluyor…' : 'Paylaşım ağacını kur'}
        </button>
      </span>
    </div>
  );
}

/**
 * Kutunun depolama durumu, ekranlara okunur hâliyle.
 *
 * Hata durumunda `null` KALIR ve bu bilinçli: "bu kutuda havuz yok" ile "soramadık" aynı şey
 * değil, ve ikisini boş bir nesnede birleştirmek, ulaşılamayan bir ajanı "havuz kurun" diyen bir
 * uyarıya çevirirdi.
 */
export function useStorageSetup(reloadKey: number): Storage | null {
  const [storage, setStorage] = useState<Storage | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await api.GET('/system/storage', {});
      if (!alive) return;
      setStorage(data ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return storage;
}
