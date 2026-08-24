import type { OpenApi } from '@depsis/contracts';
import { useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';

type Disk = OpenApi.components['schemas']['DiskInventoryEntry'];
type Topology = OpenApi.components['schemas']['CreatePoolRequest']['topology'];
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
  notify,
  onCreated,
}: {
  disks: Disk[];
  notify: Notify;
  onCreated: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [topology, setTopology] = useState<Topology>('mirror');
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // A candidate is a disk with a stable id, a WWN, nothing on it, and no part of the appliance.
  // Every one of those is also checked by the agent against an inventory it reads itself; this is
  // the courteous half, not the enforcing one.
  const candidates = disks.filter(
    (disk) =>
      disk.byId !== undefined &&
      disk.wwn !== undefined &&
      !disk.holdsSystem &&
      disk.holds.length === 0 &&
      !disk.mounted,
  );
  const blocked = disks.filter((disk) => !candidates.includes(disk));

  const selected = candidates.filter((disk) => chosen.includes(disk.byId as string));
  const enough = selected.length >= MINIMUM[topology];
  const tooMany = topology === 'single' && selected.length > 1;
  // The smallest disk decides a mirror's or raidz's capacity, so a mismatched set is worth saying
  // out loud before somebody builds a 4 TB mirror out of a 4 TB and a 1 TB disk.
  const sizes = new Set(selected.map((disk) => disk.sizeBytes));

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
      },
    });
    setBusy(false);

    if (response.status === 401) {
      notify('error', 'Parola yanlış. Havuz oluşturulmadı.');
      setPassword('');
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'Havuz oluşturulamadı.'));
      return;
    }
    notify('ok', `"${name}" oluşturuluyor. İlerlemesi Sistem işleri panelinde.`);
    setName('');
    setConfirm('');
    setPassword('');
    setChosen([]);
    onCreated();
  }

  if (candidates.length === 0) {
    return (
      <div className="note">
        <b>Havuz kurulabilecek boş disk yok.</b> DEPSIS üstünde bir şey olan bir diski kullanamıyor
        — <code>zpool</code>&apos;a hiçbir zaman <code>-f</code> geçmiyor, ve bir diski temizlemek
        kabuktan bilerek yapılan bir iş.
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
  if (disk.holds.length > 0) return `üstünde ${disk.holds.join(', ')} var`;
  if (disk.byId === undefined) return 'kararlı bir adı yok';
  if (disk.wwn === undefined) return 'WWN bildirmiyor, doğrulanamaz';
  return 'kullanılamıyor';
}
