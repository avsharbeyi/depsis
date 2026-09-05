import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { useEventRefresh } from './events.js';
import { Empty } from './ui.js';

type Job = OpenApi.components['schemas']['Job'];
type Status = NonNullable<Job['status']>;

/** How a status reads, and how it looks. */
const STATE: Record<Status, { label: string; className: string }> = {
  queued: { label: 'sırada', className: 'st2 dn' },
  running: { label: 'çalışıyor', className: 'st2 up' },
  succeeded: { label: 'bitti', className: 'st2 up' },
  failed: { label: 'başarısız', className: 'st2 er' },
  dead: { label: 'vazgeçildi', className: 'st2 er' },
};

/**
 * What each kind actually does, in the words of somebody who did not write it.
 *
 * TABLODA KUYRUĞUN HER TÜRÜ VAR. Üç satırlık hâlinde on sekiz türün on beşi makine adıyla
 * görünüyordu: "200 dosya kopyalanıyor, ilerlemesi Sistem işleri panosunda" denen kullanıcı
 * panoda `files.copy · files.copy` okuyordu. Terminale hiç girmemesi beklenen bir cihazın iş
 * panosunda ham tür adı, panoyu okunmaz kılıyor.
 *
 * `apps/worker/src/handlers/registry.ts` bu türlerin kaynağı; oraya bir tür eklendiğinde buraya
 * da bir satır gerekiyor ve `Jobs.test.ts` o unutmayı yakalıyor.
 */
export const KIND: Record<string, string> = {
  'files.copy': 'Dosyaları kopyala',
  'files.index-drain': 'Dosya dizinini güncelle',
  'files.reconcile': 'Dosya kayıtlarını diskle karşılaştır',
  'files.restore-snapshot': 'Yedekten dosya geri getir',
  'files.trash.purge': 'Çöpü kalıcı olarak temizle',
  'identity.revoke-smb': 'SMB erişimini kapat',
  'identity.sync': 'Hesapları ve grupları eşitle',
  'jobs.prune': 'Eski iş kayıtlarını temizle',
  'permissions.apply': 'İzinleri dosya sistemine yaz',
  'remote.authorize': 'Uzak cihazı ağa yetkilendir',
  'storage.backup-tick': 'Zamanlanmış yedekleri denetle',
  'storage.backup.purge': 'Süresi dolan yedekleri sil',
  'storage.backup.run': 'Zamanlanmış yedeği al',
  'storage.backup.run.now': 'Yedeği şimdi al',
  'storage.backup.verify': 'Yedeği doğrula',
  'storage.pool.create': 'Depolama havuzunu kur',
  'storage.replicate': 'Yedeği ikinci havuza kopyala',
  'storage.replicate-offsite': 'Yedeği cihaz dışına kopyala',
  'storage.snapshot': 'Anlık görüntü al',
  'tasks.overdue-sweep': 'Geciken işleri bildir',
};

/** Yedek yoklama: akış kalıcı kapanırsa (429/401/502) pano donmasın diye. */
const FALLBACK_MS = 30_000;

/**
 * The work the appliance is doing, and the work it gave up on.
 *
 * WHY THE DEAD ONES ARE THE POINT. `GET /jobs/{jobId}` has always existed and answers only to
 * whoever still holds the id — and a job usually dies long after the page that held it was closed.
 * For `permissions.apply` a dead job means a permission that is applied in the database and never
 * on the filesystem: a folder the web reports as closed and SMB keeps serving. ADR-0003 says such
 * a row "lands in history where an alarm can find it"; until this screen, nothing could.
 *
 * `dead` is the default filter for that reason. A list that opened on "everything" would bury the
 * four rows that need a person under four hundred that do not.
 */
export function Jobs({ onUnauthenticated }: { onUnauthenticated: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<Status | 'all'>('dead');
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // §14. The board was a snapshot with a Yenile button: a job that died while somebody was looking
  // at the screen stayed "çalışıyor" until they pressed it. Now the row moving is what refreshes
  // the list, and a board with nothing happening makes no requests at all.
  useEventRefresh('job', reload);

  // YEDEK YOKLAMA, akışın kalıcı kapandığı hâller için. `EventSource` yalnız ağ hatasında kendi
  // yeniden bağlanıyor; 429, 401 ya da güncelleme sırasındaki 502'de bir daha denemiyor. Otuz
  // saniyede bir okumak, ölen bir işin "çalışıyor" olarak asılı kalmasından ucuz — Transfers
  // ekranı aynı gerekçeyle aynı şeyi yapıyor.
  useEffect(() => {
    const timer = window.setInterval(reload, FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  // Liste yalnız SÜZGEÇ değiştiğinde boşalıyor. Her yenilemede boşaltmak, otuz saniyede bir
  // satırları silip "Yükleniyor…" yazan — yani okunmaya çalışılırken yanıp sönen — bir pano
  // demekti.
  useEffect(() => {
    setJobs(null);
  }, [status]);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data, response } = await api.GET('/jobs', {
        params: { query: status === 'all' ? { limit: 100 } : { status, limit: 100 } },
      });
      if (!alive) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        setFailed(true);
        return;
      }
      setJobs(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [status, reloadKey, onUnauthenticated]);

  return (
    <>
      <div className="netrow">
        <span className="lbl">Sistem işleri</span>
        <select
          className="b"
          aria-label="Hangi durumdakiler"
          value={status}
          onChange={(event) => setStatus(event.target.value as Status | 'all')}
        >
          <option value="dead">Vazgeçilenler</option>
          <option value="queued">Sırada</option>
          <option value="running">Çalışıyor</option>
          <option value="failed">Başarısız</option>
          <option value="succeeded">Bitenler</option>
          <option value="all">Hepsi</option>
        </select>
        <span className="val">{jobs?.length ?? '—'}</span>
        <button type="button" className="b" onClick={reload}>
          Yenile
        </button>
      </div>

      {status === 'dead' && (
        <p className="note">
          Vazgeçilen bir iş, kuyruğun deneme bütçesini tüketmiş demektir. İzin uygulaması için bu,
          veritabanında geçerli olan ama dosya sistemine hiç ulaşmamış bir izin anlamına gelir —
          web'de kapalı görünen bir klasör SMB'den açık kalmış olabilir.
        </p>
      )}

      {failed && <Empty glyph="⚠" text="Sistem işleri okunamadı." />}
      {!failed && jobs === null && <p className="note">Yükleniyor…</p>}
      {!failed && jobs !== null && jobs.length === 0 && (
        <Empty glyph="✓" text={status === 'dead' ? 'Vazgeçilen iş yok.' : 'Bu durumda iş yok.'} />
      )}

      {(jobs ?? []).map((job) => (
        <div className="urow" key={job.id}>
          <span className="i">
            <b>{KIND[job.kind] ?? job.kind}</b>
            {/* Ham tür adı yalnız bir Türkçe karşılığı VARKEN altta duruyor: eşleşme yoksa iki
                satır da aynı dizgeyi yazıyordu. */}
            {KIND[job.kind] !== undefined && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{job.kind}</span>
            )}
          </span>
          <span className="val" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
            {new Date(job.createdAt).toLocaleString('tr')}
          </span>
          {job.progress !== undefined && job.status === 'running' && (
            <span className="val">%{Math.round(job.progress * 100)}</span>
          )}
          <span className={STATE[job.status ?? 'queued'].className}>
            {STATE[job.status ?? 'queued'].label}
          </span>
          {/* The reason, when there is one. It is the whole value of the dead list: without it a
              row says something went wrong and nothing about what. */}
          {job.error !== undefined && (
            <span className="val" style={{ flexBasis: '100%', fontSize: 12 }}>
              {job.error.title}
            </span>
          )}
        </div>
      ))}
    </>
  );
}
