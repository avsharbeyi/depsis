import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes, formatWhen } from './Dashboard.js';

type Page = OpenApi.components['schemas']['DatabaseBackupPage'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Cihazın KENDİ verisi — ve bu panelin en çok gözden kaçan satırı.
 *
 * ZFS anlık görüntüleri kullanıcının DOSYALARINI koruyor. Korumadığı şey o dosyaların kime ait
 * olduğu: hesaplar, paylaşımlar, klasör izinleri, iş panosu ve dosya dizini PostgreSQL'de, ve
 * PostgreSQL sistem diskinde. Sistem diski ölürse havuzdaki her bayt duruyor ve onlara kimin
 * erişebileceğini söyleyen hiçbir şey kalmıyor.
 *
 * HİÇ DÖKÜM YOKKEN YÜKSEK SESLE SÖYLÜYOR. Bu ekranın sessizce boş durması, yedeği olduğunu sanan
 * birini o hâlde bırakmak olurdu — ve burada eksik olan şey, kaybedildiğinde en pahalı olan.
 *
 * DİZİN GÖSTERİLİYOR çünkü dökümleri cihazdan ÇIKARMAK yöneticinin işi: o dizinin veri kümesine
 * bir yedekleme zamanlaması kurulur, ya da dosyalar elle kopyalanır. Nerede olduğunu söylemeyen
 * bir yedek, bulunamayan bir yedek.
 */
export function DatabaseBackups({ notify }: { notify: Notify }): ReactElement {
  const [page, setPage] = useState<Page | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const { data, error, response } = await api.GET('/storage/database-backups', {});
    if (data === undefined) {
      if (response.status === 403) {
        setForbidden(true);
        return;
      }
      // 503 burada BİR DURUM: ajan döküm alamıyor, neredeyse her zaman bağlantı dizesi
      // yapılandırılmadığı için. Cümlesi taşınıyor çünkü yöneticinin yapacağı şeyi söylüyor.
      setProblem(problemMessage(error, 'Veritabanı dökümleri okunamadı.'));
      return;
    }
    setProblem(null);
    setPage(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function dump(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/storage/database-backups', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Döküm alınamadı.'));
      return;
    }
    setPage(data);
    notify('ok', 'Veritabanı dökümü alındı.');
  }

  if (forbidden) return <></>;

  const items = page?.items ?? [];
  const newest = items[0];

  return (
    <div className="repl">
      <div className="thead">
        <span className="lbl">Cihazın kendi veritabanı</span>
        <button type="button" className="lnk" disabled={busy} onClick={() => void dump()}>
          {busy ? 'Alınıyor…' : 'Şimdi döküm al'}
        </button>
      </div>

      {problem !== null && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Veritabanı dökümü alınamıyor.</b>
            {problem}
          </span>
        </div>
      )}

      {problem === null && items.length === 0 && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          {/* Bu ekranın var olma sebebi. Sessizce boş durması, yedeği olduğunu sanan birini o
              hâlde bırakmak olurdu — ve burada eksik olan şey, kaybedildiğinde en pahalı olan. */}
          <span className="tx">
            <b>Hiç veritabanı dökümü yok.</b>
            Anlık görüntüler dosyalarınızı koruyor; hesapları, paylaşımları ve izinleri koruyan
            hiçbir şey yok. Sistem diski ölürse dosyalar durur ve onlara kimin erişebileceği
            kaybolur.
          </span>
        </div>
      )}

      {newest !== undefined && (
        <p className="note">
          En son: <b>{formatWhen(newest.createdAt)}</b> · {formatBytes(newest.sizeBytes)} ·{' '}
          {items.length} döküm saklanıyor
        </p>
      )}

      {page !== null && (
        <p className="note m">
          {page.directory}
          {' — '}
          <span>
            bu dizin bir paylaşımda DEĞİL: döküm parola hash&apos;lerini ve mühürlenmiş sırları
            taşıyor. Cihaz dışına çıkarmak için bu dizinin veri kümesine bir yedekleme zamanlaması
            kurun.
          </span>
        </p>
      )}
    </div>
  );
}
