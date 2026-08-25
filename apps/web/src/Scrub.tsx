import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes, percent } from './Dashboard.js';

type PoolRow = OpenApi.components['schemas']['PoolStatus'];
type Scrub = OpenApi.components['schemas']['ScrubStatus'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Bir havuz satırı, ve altında taramanın söylediği.
 *
 * ZFS her bloğun sağlama toplamını tutuyor ve bozulmuş bir bloğu OKUNDUĞUNDA fark ediyor. Sessiz
 * bit çürümesinin problemi tam da bu: bir yedek arşivi yıllarca okunmuyor, yani bozulma yıllarca
 * fark edilmiyor, ve fark edildiği gün — dosyanın gerçekten gerektiği gün — kopyası da bozulmuş
 * olabiliyor.
 *
 * DEPSIS TARAMA ZAMANLAMIYOR. Debian'ın `zfsutils-linux` paketi zaten aylık bir tarama koyuyor,
 * yani sıradan bir cihazda taramalar KOŞUYOR — eksik olan şey zamanlama değil GÖRÜNÜRLÜKTÜ. Bir
 * taramanın bulduğu hataları kimsenin görmediği bir cihaz, hiç taramayan bir cihazdan yalnızca
 * daha pahalı.
 *
 * SATIRLAR `zpool status`'ÜN KENDİ SÖZLERİ. Ayrıştırılmıyorlar: `scan:` satırındaki tarih yerel
 * biçimde, ve onu bir zaman damgasına çevirmeye çalışmak, yanlış çevirdiğinde "en son ne zaman
 * tarandı" sorusuna kendinden emin ve yanlış bir cevap vermek olurdu.
 */
export function Pool({ pool, notify }: { pool: PoolRow; notify: Notify }): ReactElement {
  const [scrub, setScrub] = useState<Scrub | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const { data } = await api.GET('/storage/pools/{pool}/scrub', {
      params: { path: { pool: pool.name } },
    });
    // Sessizce vazgeçiyor: bu satırın asıl işi havuzun doluluğunu göstermek, ve sıradan bir üye bu
    // ucu göremiyor. Her açılışta kırmızı bir kutu, ona yapabileceği bir şey olduğunu söylerdi.
    if (data === undefined) {
      setUnavailable(true);
      return;
    }
    setScrub(data);
  }, [pool.name]);

  useEffect(() => {
    void load();
  }, [load]);

  async function start(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/storage/pools/{pool}/scrub', {
      params: { path: { pool: pool.name } },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Tarama başlatılamadı.'));
      return;
    }
    setScrub(data);
    notify('ok', `${pool.name} taranıyor. Saatler sürebilir; disk daha yavaş olacak.`);
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="netrow">
        <span className="lbl">{pool.name}</span>
        <span className="val">
          {formatBytes(pool.used)} / {formatBytes(pool.used + pool.available)} ·{' '}
          {percent(pool.used, pool.used + pool.available)}
        </span>
        {!unavailable && (
          <button
            type="button"
            className="lnk"
            disabled={busy || scrub?.inProgress === true}
            onClick={() => void start()}
          >
            {scrub?.inProgress === true ? 'Taranıyor…' : 'Şimdi tara'}
          </button>
        )}
      </div>

      {scrub !== null && scrub.hasErrors && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          {/* TARAMANIN VAR OLMA SEBEBİ. Bulduğu hasarı "sorun yok" diye göstermek, hasarı
              kontrol edilmiş gibi göstermek olurdu — taramamaktan kötü. */}
          <span className="tx">
            <b>Bu havuzda veri hatası var.</b>
            {scrub.errors}
          </span>
        </div>
      )}

      {scrub !== null && (
        <div className="m" style={{ paddingLeft: 2 }}>
          {/* Boş bir `scan`, "sorun yok" DEĞİL: `zpool status` bir şey söylememiş. */}
          {scrub.scan === '' ? 'tarama durumu bilinmiyor' : scrub.scan}
        </div>
      )}
    </div>
  );
}
