import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';

type Target = OpenApi.components['schemas']['BackupTarget'];
type Status = OpenApi.components['schemas']['BackupTargetStatus'];
type Disk = OpenApi.components['schemas']['DiskInventoryEntry'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Yedek diski — cihazın dışında duran kopyanın kendisi.
 *
 * ── BU EKRANIN CEVAPLADIĞI SORU ──────────────────────────────────────────────────────────────
 *
 * Cihazın sahibinin tek sorusu var: *verim güvende mi.* Bu panel o soruya bir cümleyle cevap
 * veriyor ve cümlenin üç hâli var — disk yok, disk kilitli, disk açık. Üçünün de yapılacak farklı
 * bir şeyi var, ve bu yüzden üçü ayrı ayrı yazılıyor: birleştirilmiş bir "hazır değil", kullanıcıya
 * yapacağı şeyin tersini söyletirdi.
 *
 * ── KİLİTLİ BİR DİSK ARIZA DEĞİL ─────────────────────────────────────────────────────────────
 *
 * Parola hiçbir yere yazılmıyor. Cihaz her açıldığında disk kilitli oluyor ve sahibinin bir kez
 * parola girmesi gerekiyor — bu, "sistem diski ve depolama diski yansa bile şifre biliniyorsa
 * kullanılabilir olmalı" şartının doğrudan sonucu. Parolayı cihazda saklasaydık, çalınan bir
 * cihazın içindeki yedek diski de çalınmış olurdu.
 *
 * Bu yüzden kilitli hâl SARI, kırmızı değil: bir şey bozulmadı, bir şey yapılması gerekiyor.
 *
 * ── PAROLA ALANI SAYFADA KALMIYOR ────────────────────────────────────────────────────────────
 *
 * Gönderildiği anda temizleniyor. Bir yedek diski parolası, tarayıcının bellek dökümünde ya da
 * omzunuzun üstünden bakan birinin ekranında beklemek zorunda değil.
 */
export function BackupDisk({ notify }: { notify: Notify }): React.JSX.Element | null {
  const [status, setStatus] = useState<Status | null>(null);
  /** Yönetici değilse bu bölüm hiç çizilmez — 403 bir hata değil, bir cevaptır. */
  const [allowed, setAllowed] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'yok' | 'kur' | 'ac'>('yok');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [pool, setPool] = useState('');
  const [label, setLabel] = useState('Ev');
  /** Kurulum için seçilebilecek havuzlar — kullanıcı ZFS adı YAZMIYOR, listeden seçiyor. */
  const [pools, setPools] = useState<string[]>([]);
  const [disks, setDisks] = useState<Disk[]>([]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, response } = await api.GET('/backups/target', {});
      if (!alive) return;
      if (response.status === 403) {
        setAllowed(false);
        return;
      }
      if (data !== undefined) setStatus(data);

      // Havuz listesi: kullanıcı `depsisyedek` yazmıyor, VAR OLAN havuzlardan seçiyor. Sahada
      // ödenen bir bedel bu — yedek almak için ham ZFS adı yazdıran bir form, adı bilmeyen
      // sahibi terminale iter.
      const setup = await api.GET('/system/storage', {});
      if (alive && setup.data !== undefined) setPools(setup.data.pools);
      const inventory = await api.GET('/system/disks', {});
      if (alive && inventory.data !== undefined) setDisks(inventory.data.disks);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  if (!allowed) return null;

  const target: Target | null | undefined = status?.target;
  const configured = status?.configured === true && target != null;

  async function prepare(): Promise<void> {
    if (passphrase !== confirmPass) {
      // İKİ KEZ SORULUYOR ve karşılaştırma BURADA. Yanlış yazılmış bir parolayı ancak diskin
      // açılamadığı gün fark etmek, o diskteki her şeyi kaybetmek demek.
      notify('error', 'İki parola aynı değil.');
      return;
    }
    setBusy(true);
    const { data, error } = await api.POST('/backups/target', {
      body: { pool, label: label.trim(), passphrase },
    });
    setBusy(false);
    setPassphrase('');
    setConfirmPass('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Yedek diski kurulamadı.'));
      return;
    }
    setMode('yok');
    notify('ok', `Yedek diski kuruldu: ${data.label}. Parolanızı bir yere yazın.`);
    reload();
  }

  async function unlock(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/backups/target/unlock', { body: { passphrase } });
    setBusy(false);
    setPassphrase('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Yedek diski açılamadı.'));
      return;
    }
    setMode('yok');
    notify('ok', 'Yedek diski açıldı.');
    reload();
  }

  async function lock(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/backups/target/lock', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Yedek diski kilitlenemedi.'));
      return;
    }
    notify('ok', 'Yedek diski kilitlendi.');
    reload();
  }

  async function save(patch: { cadenceHours?: number; retainDays?: number }): Promise<void> {
    setBusy(true);
    const { data, error } = await api.PATCH('/backups/target', { body: patch });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Ayar kaydedilemedi.'));
      return;
    }
    notify('ok', 'Kaydedildi.');
    reload();
  }

  return (
    <>
      <div className="syshead">Yedek diski</div>

      {status === null ? (
        <p className="note">Yükleniyor…</p>
      ) : !configured ? (
        <Kurulmamis
          pools={pools}
          disks={disks}
          open={mode === 'kur'}
          busy={busy}
          pool={pool}
          label={label}
          passphrase={passphrase}
          confirmPass={confirmPass}
          onOpen={() => setMode('kur')}
          onCancel={() => {
            setMode('yok');
            setPassphrase('');
            setConfirmPass('');
          }}
          onPool={setPool}
          onLabel={setLabel}
          onPassphrase={setPassphrase}
          onConfirm={setConfirmPass}
          onSubmit={() => void prepare()}
        />
      ) : target.unlocked ? (
        <Acik target={target} busy={busy} onLock={() => void lock()} onSave={save} />
      ) : (
        <Kilitli
          target={target}
          open={mode === 'ac'}
          busy={busy}
          passphrase={passphrase}
          onOpen={() => setMode('ac')}
          onCancel={() => {
            setMode('yok');
            setPassphrase('');
          }}
          onPassphrase={setPassphrase}
          onSubmit={() => void unlock()}
        />
      )}
    </>
  );
}

/**
 * Disk yok: cihazın olağan ilk hâli, ve KIRMIZI.
 *
 * Bir eksiklik olarak değil bir DURUM olarak yazılması yanlış olurdu: yedeği olmayan bir NAS,
 * tek bir disk arızasında her şeyi kaybeder. Bu cümlenin sakinleşmesi gereken bir yer yok.
 */
function Kurulmamis(props: {
  pools: string[];
  disks: Disk[];
  open: boolean;
  busy: boolean;
  pool: string;
  label: string;
  passphrase: string;
  confirmPass: string;
  onOpen: () => void;
  onCancel: () => void;
  onPool: (v: string) => void;
  onLabel: (v: string) => void;
  onPassphrase: (v: string) => void;
  onConfirm: (v: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const { pools, open, busy, pool, label, passphrase, confirmPass } = props;
  const ready = pool !== '' && label.trim() !== '' && passphrase.length >= 8;

  return (
    <>
      <div className="warn">
        <span className="ic" aria-hidden>
          ⚠
        </span>
        <span className="tx">
          <b>Yedek diski yok.</b>
          Dosyalarınızın bu cihazın dışında bir kopyası yok. Tek bir disk arızası, yangın ya da
          hırsızlık her şeyi götürür.
        </span>
      </div>

      {!open ? (
        <div className="netrow">
          <button type="button" className="b" onClick={props.onOpen} disabled={pools.length === 0}>
            Yedek diski kur
          </button>
          {pools.length === 0 && (
            <span className="note">
              Önce Diskler ekranından ikinci bir havuz kurun; yedek diski o havuzun üstüne kurulur.
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="netrow">
            <span className="lbl">Havuz</span>
            <select
              className="sb"
              aria-label="Havuz"
              value={pool}
              onChange={(event) => props.onPool(event.target.value)}
            >
              <option value="">— seçin —</option>
              {pools.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className="note">Yedeğin duracağı havuz. Ana depolamanızdan farklı olmalı.</span>
          </div>

          <div className="netrow">
            <span className="lbl">Ad</span>
            <input
              className="sb"
              aria-label="Ad"
              value={label}
              maxLength={64}
              onChange={(event) => props.onLabel(event.target.value)}
            />
            <span className="note">
              Diski başka bir cihaza taktığınızda ekranda görünecek ad. "Ev", "Ofis yedeği".
            </span>
          </div>

          <div className="netrow">
            <span className="lbl">Parola</span>
            <input
              type="password"
              className="sb"
              aria-label="Parola"
              value={passphrase}
              autoComplete="new-password"
              onChange={(event) => props.onPassphrase(event.target.value)}
            />
            <span className="note">En az 8 karakter.</span>
          </div>

          <div className="netrow">
            <span className="lbl">Tekrar</span>
            <input
              type="password"
              className="sb"
              aria-label="Parola tekrar"
              value={confirmPass}
              autoComplete="new-password"
              onChange={(event) => props.onConfirm(event.target.value)}
            />
          </div>

          {/* PAROLA KAYBOLURSA YEDEK DE KAYBOLUR, ve bunu formda söylemek zorundayız. Diski
              açacak tek şey bu parola; DEPSIS'in elinde bir kopyası yok ve olmaması bu tasarımın
              amacı. Bunu kurulumdan SONRA söylemek, söylememekle aynı şey. */}
          <div className="warn">
            <span className="ic" aria-hidden>
              ⚠
            </span>
            <span className="tx">
              <b>Bu parolayı bir yere yazın.</b>
              Diski açacak tek şey bu. DEPSIS onu hiçbir yerde saklamıyor — cihaz çalınsa bile
              yedeğiniz okunamasın diye. Unutulursa diskteki hiçbir dosya geri getirilemez.
            </span>
          </div>

          <div className="netrow">
            <button type="button" className="b" disabled={busy || !ready} onClick={props.onSubmit}>
              {busy ? 'Kuruluyor…' : 'Yedek diskini kur'}
            </button>
            <button type="button" className="b ghost" onClick={props.onCancel}>
              Vazgeç
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Disk kilitli: SARI, kırmızı değil.
 *
 * Bir şey bozulmadı — bir şey yapılması gerekiyor. Cihaz her açıldığında bu hâle geliyor, çünkü
 * parola hiçbir yere yazılmıyor. Kırmızı göstermek, olağan bir hâli her elektrik kesintisinden
 * sonra bir arıza gibi göstermek olurdu.
 */
function Kilitli(props: {
  target: Target;
  open: boolean;
  busy: boolean;
  passphrase: string;
  onOpen: () => void;
  onCancel: () => void;
  onPassphrase: (v: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const { target, open, busy, passphrase } = props;
  return (
    <>
      <div className="warn">
        <span className="ic" aria-hidden>
          🔒
        </span>
        <span className="tx">
          <b>Yedek diski kilitli.</b>
          {target.label} açılana kadar yedekleme duruyor. Cihaz her açıldığında kilitli gelir —
          parola hiçbir yerde saklanmıyor, çalınan bir cihazın yedeği de okunamasın diye.
        </span>
      </div>

      {!open ? (
        <div className="netrow">
          <button type="button" className="b" onClick={props.onOpen}>
            Kilidi aç
          </button>
        </div>
      ) : (
        <div className="netrow">
          <span className="lbl">Parola</span>
          <input
            type="password"
            className="sb"
            aria-label="Parola"
            value={passphrase}
            autoComplete="current-password"
            onChange={(event) => props.onPassphrase(event.target.value)}
          />
          <button
            type="button"
            className="b"
            disabled={busy || passphrase.length < 8}
            onClick={props.onSubmit}
          >
            {busy ? 'Açılıyor…' : 'Aç'}
          </button>
          <button type="button" className="b ghost" onClick={props.onCancel}>
            Vazgeç
          </button>
        </div>
      )}
    </>
  );
}

/** Disk açık: ritim ve saklama süresi buradan değişiyor. */
function Acik(props: {
  target: Target;
  busy: boolean;
  onLock: () => void;
  onSave: (patch: { cadenceHours?: number; retainDays?: number }) => Promise<void>;
}): React.JSX.Element {
  const { target, busy } = props;
  const [cadence, setCadence] = useState(String(target.cadenceHours));
  const [retain, setRetain] = useState(String(target.retainDays));

  return (
    <>
      <div className="netrow">
        <span className="lbl">{target.label}</span>
        <span className="pill">
          <i />
          Açık
        </span>
        <span className="note m">
          {formatBytes(target.usedBytes)} dolu · {formatBytes(target.availableBytes)} boş
        </span>
      </div>

      {target.recoveryOnly && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu disk başka bir cihazın yedeği.</b>
            Dosyaları okuyabilir ve geri getirebilirsiniz; bu cihaz diske hiçbir şey yazmıyor ve
            hiçbir şey silmiyor. Devretmek isterseniz aşağıdan söyleyin.
          </span>
        </div>
      )}

      <div className="netrow">
        <span className="lbl">Sıklık</span>
        <select
          className="sb"
          aria-label="Sıklık"
          value={cadence}
          onChange={(event) => {
            setCadence(event.target.value);
            void props.onSave({ cadenceHours: Number(event.target.value) });
          }}
        >
          <option value="1">Saatte bir</option>
          <option value="3">3 saatte bir</option>
          <option value="6">6 saatte bir</option>
          <option value="12">12 saatte bir</option>
          <option value="24">Günde bir</option>
        </select>
        <span className="note">Sistemin önerisi 6 saat.</span>
      </div>

      <div className="netrow">
        <span className="lbl">Silinenler</span>
        <select
          className="sb"
          aria-label="Silinen dosyaların saklanma süresi"
          value={retain}
          onChange={(event) => {
            setRetain(event.target.value);
            void props.onSave({ retainDays: Number(event.target.value) });
          }}
        >
          <option value="7">7 gün saklansın</option>
          <option value="30">30 gün saklansın</option>
          <option value="90">90 gün saklansın</option>
          <option value="365">1 yıl saklansın</option>
        </select>
        <span className="note">
          Depolamadan sildiğiniz bir dosya yedekte bu kadar daha durur. Sistemin önerisi 30 gün.
        </span>
      </div>

      <div className="netrow">
        <button type="button" className="b ghost" disabled={busy} onClick={props.onLock}>
          Kilitle
        </button>
        <span className="note">
          Kilitlemek dosyaları okunamaz yapar ve yedeklemeyi durdurur. Açmak için parola gerekir.
        </span>
      </div>
    </>
  );
}
