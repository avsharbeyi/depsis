import type { OpenApi } from '@depsis/contracts';
import { useState } from 'react';

import { api, isTransportFailure, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';

type Disk = OpenApi.components['schemas']['DiskInventoryEntry'];
type Topology = OpenApi.components['schemas']['CreatePoolRequest']['topology'];
type Storage = OpenApi.components['schemas']['StorageSetup'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The fewest disks each arrangement means anything with. Mirrors `PoolTopology::minimum_disks`. */
const MINIMUM: Record<Topology, number> = { single: 1, mirror: 2, raidz1: 3, raidz2: 4 };

const DESCRIBED: Record<Topology, string> = {
  single: 'Tek disk. Yedeklilik yok — disk giderse veri gider.',
  mirror: 'Her disk her baytı tutuyor. Biri hariç hepsi gidebilir.',
  raidz1: 'Bir disklik parite. Herhangi bir disk gidebilir.',
  raidz2: 'İki disklik parite. Aynı anda iki disk gidebilir.',
};

/**
 * The pool wizard — the one screen in this product that erases disks.
 *
 * §8.1's sequence: analysis, plan, the serial/WWN list, written confirmation, re-authentication,
 * job. The analysis is the Disks screen this renders inside; the list below is the plan; the two
 * fields at the bottom are the last two steps.
 *
 * WHAT THIS SCREEN CANNOT OFFER, and says so rather than hiding: a disk with anything on it. The
 * agent never passes `-f`, so `zpool create` refuses such a device — and clearing one stays
 * something an operator does themselves, deliberately, from a shell. Showing them as disabled with
 * the reason attached is more use than filtering them out, which would leave somebody hunting for
 * a disk they can see in the table above.
 */
export function CreatePool({
  disks,
  storage,
  notify,
  onCreated,
}: {
  disks: Disk[];
  /**
   * What the box already has. `null` while it is being read.
   *
   * The wizard needs it to decide whether to offer the second half — creating the dataset shares
   * are served from. Offering that on a box where it already exists would be an operation the
   * agent refuses, presented as a checkbox somebody ticked.
   */
  storage: Storage | null;
  notify: Notify;
  onCreated: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [topology, setTopology] = useState<Topology>('mirror');
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [prepare, setPrepare] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * What was just asked for, if anything.
   *
   * The screen used to reload the inventory the moment the job was enqueued and go straight back to
   * offering the same disks as empty — which they still are, for the few seconds before the worker
   * picks the job up. Two clicks in that window are two `zpool create` requests for one intent, and
   * the second one's refusal ("a pool called tank already exists") reads as a bug rather than as a
   * rescue.
   */
  const [queued, setQueued] = useState<{ name: string; jobId: string; disks: number } | null>(null);

  // A candidate is a disk with a stable id, a WWN, nothing on it, not mounted, not removable, and
  // no part of the appliance. Every one of those is also checked by the agent against an inventory
  // it reads itself; this is the courteous half, not the enforcing one.
  //
  // `removable` was in this list nowhere until a review pointed out that it was described as a
  // refusal in `op.rs`, described as a refusal in the OpenAPI document, and enforced by nothing —
  // so a USB stick was on offer as a mirror member.
  const candidates = disks.filter(
    (disk) =>
      disk.byId !== undefined &&
      disk.wwn !== undefined &&
      !disk.holdsSystem &&
      disk.holds.length === 0 &&
      !disk.mounted &&
      !disk.removable,
  );
  const blocked = disks.filter((disk) => !candidates.includes(disk));

  const selected = candidates.filter((disk) => chosen.includes(disk.byId as string));
  const enough = selected.length >= MINIMUM[topology];
  const tooMany = topology === 'single' && selected.length > 1;
  // The smallest disk decides a mirror's or raidz's capacity, so a mismatched set is worth saying
  // out loud before somebody builds a 4 TB mirror out of a 4 TB and a 1 TB disk.
  const sizes = new Set(selected.map((disk) => disk.sizeBytes));
  // The second half is on offer only when the box genuinely lacks it: a shares root that is
  // configured, has no dataset mounted on it, and is empty. All three are also checked by the
  // agent, which refuses rather than mounting over somebody's files.
  const root = storage?.shareRoot;
  const offerPrepare =
    root !== undefined && root.path !== undefined && root.dataset === undefined && root.empty;
  const rootBlocked =
    root !== undefined && root.path !== undefined && root.dataset === undefined && !root.empty;

  function toggle(byId: string): void {
    setChosen((current) =>
      current.includes(byId) ? current.filter((id) => id !== byId) : [...current, byId],
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const { data, error, response } = await api.POST('/storage/pools', {
      body: {
        name,
        topology,
        // `byId` and `wwn` are both present by construction — `candidates` filtered on it.
        disks: selected.map((disk) => ({ byId: disk.byId as string, wwn: disk.wwn as string })),
        confirm,
        password,
        // Only when there is something to prepare. Sending it on a box that already has a share
        // tree would make the job fail on a step the operator did not ask for.
        prepareShareRoot: offerPrepare && prepare,
      },
    });
    setBusy(false);

    // THE ONLY HONEST ANSWER WHEN THE REPLY IS LOST. The request may have been received, the job
    // may be committed, and the disks may be being erased right now — "could not create the pool"
    // is a claim this screen has no basis for. Every other screen can say "it failed" about a
    // dropped connection; this one cannot.
    if (isTransportFailure(response)) {
      notify(
        'error',
        'Sunucudan yanıt gelmedi. Havuz oluşturma işi BAŞLATILMIŞ OLABİLİR — tekrar denemeden ' +
          'önce Sistem işleri panelinden bakın.',
      );
      return;
    }
    if (response.status === 401) {
      // 401 is also what an expired session produces, and this is an admin-only pane: a
      // wrong-password message on a screen the operator is no longer signed in to sends them
      // looking for the wrong thing. The API distinguishes the two in its problem body.
      notify('error', problemMessage(error, 'Parola doğrulanamadı. Havuz oluşturulmadı.'));
      setPassword('');
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'Havuz oluşturulamadı.'));
      return;
    }
    notify('ok', `"${name}" oluşturuluyor. İlerlemesi Sistem işleri panelinde.`);
    setQueued({ name, jobId: data.jobId, disks: selected.length });
    setName('');
    setConfirm('');
    setPassword('');
    setChosen([]);
    // NOT `onCreated()` here. Reloading now re-reads an inventory the job has not touched yet, so
    // the disks come back blank and immediately on offer again. The operator reloads when they
    // have seen the job finish.
  }

  if (queued !== null) {
    return (
      <div className="note">
        <b>&quot;{queued.name}&quot; kuyruğa alındı.</b> {queued.disks} disk üzerinde çalışacak.
        İlerlemesini <b>Sistem işleri</b> panelinden izleyin (iş {queued.jobId.slice(0, 8)}).
        <p>
          Bu ekran diskleri yeniden okumadı: iş bitene kadar aynı diskler hâlâ boş görünür, ve
          ikinci bir istek göndermenin bir faydası olmaz.
        </p>
        <button
          type="button"
          className="b"
          onClick={() => {
            setQueued(null);
            onCreated();
          }}
        >
          Diskleri yeniden oku
        </button>
      </div>
    );
  }

  if (candidates.length === 0) {
    // The per-disk reasons, NOT a sentence asserting one. This branch used to hard-code "the disks
    // have something on them" and return above the `blocked` list, so in the one case where those
    // reasons are the only diagnosis the operator gets, none of them was shown — and the asserted
    // reason was wrong for a disk that is perfectly blank and merely reports no WWN.
    return (
      <div className="note">
        <b>Havuz kurulabilecek disk yok.</b>
        {blocked.length === 0 ? (
          ' Ajan bu kutuda hiç disk bulamadı.'
        ) : (
          <>
            {' '}
            Aşağıdaki diskler kullanılamıyor:
            <div style={{ marginTop: 6 }}>
              {blocked.map((disk) => (
                <div className="netrow" key={disk.byId ?? disk.kname}>
                  <span className="lbl">{disk.model ?? disk.kname}</span>
                  <span className="val m">{why(disk)}</span>
                </div>
              ))}
            </div>
            <p>
              Üstünde bir şey olan bir diski DEPSIS kullanamıyor: <code>zpool</code>&apos;a hiçbir
              zaman <code>-f</code> geçmiyor, ve bir diski temizlemek kabuktan bilerek yapılan bir
              iş.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div className="lbl">Havuz oluştur</div>

      <div className="warn">
        <span className="ic" aria-hidden>
          ⚠
        </span>
        <span className="tx">
          <b>Bu işlem seçtiğiniz diskleri siler ve geri alınamaz.</b>
          Havuzu oluşturmadan hemen önce ajan kutuyu yeniden okuyup her diskin WWN&apos;ini
          karşılaştırıyor; bu ekranı açtığınızdan beri bir disk değiştiyse işlem reddediliyor.
        </span>
      </div>

      <label>
        Ad
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          pattern="[A-Za-z][A-Za-z0-9_.:\-]{0,62}"
          maxLength={63}
          autoComplete="off"
          spellCheck={false}
          placeholder="ör. tank"
        />
        <small>Harfle başlamalı ve içinde `/` olamaz.</small>
      </label>

      <label>
        Düzen
        <select value={topology} onChange={(event) => setTopology(event.target.value as Topology)}>
          {(['single', 'mirror', 'raidz1', 'raidz2'] as const).map((option) => (
            <option key={option} value={option}>
              {option} — en az {MINIMUM[option]} disk
            </option>
          ))}
        </select>
        <small>{DESCRIBED[topology]}</small>
      </label>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          Diskler ({selected.length} seçili, en az {MINIMUM[topology]})
        </div>
        {candidates.map((disk) => (
          <label key={disk.byId} className="netrow" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={chosen.includes(disk.byId as string)}
              onChange={() => toggle(disk.byId as string)}
            />
            <span className="lbl">{disk.model ?? disk.kname}</span>
            <span className="val">
              {formatBytes(disk.sizeBytes)} · <span className="m">{disk.byId}</span>
            </span>
          </label>
        ))}
      </div>

      {blocked.length > 0 && (
        <details>
          <summary className="note">
            Kullanılamayan {blocked.length} disk — neden olmadığıyla birlikte
          </summary>
          {blocked.map((disk) => (
            <div className="netrow" key={disk.byId ?? disk.kname}>
              <span className="lbl">{disk.model ?? disk.kname}</span>
              <span className="val m">{why(disk)}</span>
            </div>
          ))}
        </details>
      )}

      {sizes.size > 1 && (
        <div className="note">
          Seçilen diskler farklı boyutlarda. Havuzun kapasitesini <b>en küçük disk</b> belirler;
          fazlası kullanılmaz.
        </div>
      )}
      {tooMany && (
        <div className="note">
          <code>single</code> tam olarak bir disk alıyor. Birden fazla diski yedeklilik olmadan
          birleştirmek — bir stripe — bu üründe bilerek yok: herhangi bir diski kaybetmek her şeyi
          kaybettirir.
        </div>
      )}

      {offerPrepare && (
        <label className="netrow" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={prepare}
            onChange={(event) => setPrepare(event.target.checked)}
          />
          <span className="lbl">Paylaşım ağacını da kur</span>
          <span className="val m">
            {root?.path} → <b>{name === '' ? '<havuz>' : name}/depsis</b>
          </span>
        </label>
      )}
      {offerPrepare && !prepare && (
        <div className="note">
          Bunu atlarsanız havuz kurulur ama <b>paylaşım açılamaz</b>: DEPSIS paylaşımları hangi veri
          kümesinin altında açacağını bilmez ve <code>POST /shares</code> 503 verir. Sonradan
          kabuktan kurmanız gerekir.
        </div>
      )}
      {rootBlocked && (
        <div className="note">
          <b>{root?.path}</b> boş değil, o yüzden paylaşım ağacı buradan kurulamıyor. Bir veri
          kümesini dolu bir dizinin üstüne bağlamak, altındakini silmeden görünmez yapar — ajan bunu
          reddediyor. Dizini kabuktan boşaltın ya da taşıyın.
        </div>
      )}

      <label>
        Onay
        <input
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={name === '' ? 'önce bir ad yazın' : name}
        />
        <small>
          Onaylamak için havuz adını (<b>{name === '' ? '…' : name}</b>) yazın.
        </small>
      </label>

      <label>
        Parolanız
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
        />
        <small>
          Oturumunuz açık olsa da isteniyor: bu kadar riskli bir işlem bir çereze güvenmez.
        </small>
      </label>

      <button
        type="submit"
        className="b danger"
        disabled={busy || !enough || tooMany || name === '' || confirm !== name || password === ''}
      >
        {busy ? 'Oluşturuluyor…' : `${selected.length} diski sil ve havuzu kur`}
      </button>
    </form>
  );
}

/** Why a disk is not on offer. The reason, not just the exclusion. */
function why(disk: Disk): string {
  if (disk.holdsSystem) return 'bu makinenin sistem diski';
  if (disk.mounted) return 'bir bölümü bağlı';
  if (disk.removable) return 'çıkarılabilir — giden bir disk vdev’i de götürür';
  if (disk.holds.length > 0) return `üstünde ${disk.holds.join(', ')} var`;
  if (disk.byId === undefined) return 'kararlı bir adı yok';
  if (disk.wwn === undefined) return 'WWN bildirmiyor, doğrulanamaz';
  return 'kullanılamıyor';
}
