import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
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

/** What each kind actually does, in the words of somebody who did not write it. */
const KIND: Record<string, string> = {
  'permissions.apply': 'İzinleri dosya sistemine yaz',
  'identity.sync': 'Hesapları ve grupları eşitle',
  'storage.snapshot': 'Anlık görüntü al',
};

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

  useEffect(() => {
    let alive = true;
    setJobs(null);
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
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{job.kind}</span>
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
