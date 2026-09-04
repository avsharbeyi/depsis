import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { formatBytes } from './Dashboard.js';

type Target = OpenApi.components['schemas']['BackupTarget'];
type Status = OpenApi.components['schemas']['BackupTargetStatus'];
type Listing = OpenApi.components['schemas']['BackupListing'];
type Importable = OpenApi.components['schemas']['ImportableBackupPools']['pools'][number];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Yedek diskinin kurulabileceği havuzlar — paylaşımların durduğu havuz ÇIKARILMIŞ hâlde.
 *
 * Bir yedek, kopyanın ASIL VERİDEN BAŞKA BİR DİSKTE durmasıdır. Paylaşımların bulunduğu havuzu
 * seçtiren bir liste, aynı disklere ikinci bir kopya yazdırırdı: havuz iki katı hızla dolar, ZFS
 * yazmayı keser ve bütün paylaşımlar "disk dolu" vermeye başlar; disk arızasında ise "yedek" de
 * asıl veriyle birlikte gider — yani ekranın verdiği söz ("cihazın dışında bir kopya") baştan boş
 * çıkar.
 *
 * Karşılaştırma METİN ÖNEKİYLE değil BİLEŞENLE yapılıyor: `tank2`, `tank`'ın parçası değildir ve
 * onu da elemek, sahibinin elindeki tek geçerli yedek havuzunu listeden silerdi.
 *
 * `parentDataset` bilinmiyorsa (paylaşım ağacı henüz kurulmamış) eleyecek bir şey yok — liste
 * olduğu gibi kalıyor. Bu zaten frenin nazik yarısı; reddeden yarısı ajanda.
 */
export function backupCandidatePools(pools: string[], parentDataset?: string): string[] {
  if (parentDataset === undefined || parentDataset === '') return pools;
  const sharePool = parentDataset.split('/')[0];
  return pools.filter((name) => name !== sharePool);
}

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
  const [mode, setMode] = useState<'yok' | 'kur' | 'ac' | 'kurtar'>('yok');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [pool, setPool] = useState('');
  const [label, setLabel] = useState('Ev');
  /** Kurulum için seçilebilecek havuzlar — kullanıcı ZFS adı YAZMIYOR, listeden seçiyor. */
  const [pools, setPools] = useState<string[]>([]);
  /** Paylaşımların açıldığı veri kümesi; havuzu aday listesinden düşmek için tutuluyor. */
  const [parentDataset, setParentDataset] = useState<string | undefined>(undefined);

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
      if (alive && setup.data !== undefined) {
        setPools(setup.data.pools);
        setParentDataset(setup.data.parentDataset);
      }
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

  async function runNow(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/backups/target/run', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Yedek turu başlatılamadı.'));
      return;
    }
    // "BAŞLADI" DEĞİL "KUYRUĞA ALINDI". Tur saatler sürebilir ve bu istek onu beklemiyor;
    // "yedeğiniz alındı" demek, henüz olmamış bir şeyi olmuş gibi göstermek olurdu.
    notify('ok', 'Yedek turu kuyruğa alındı. Büyük değişikliklerde uzun sürebilir.');
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

  async function release(): Promise<void> {
    setBusy(true);
    const { response, error } = await api.POST('/backups/target/recovery/release', {});
    setBusy(false);
    if (!response.ok) {
      notify('error', problemMessage(error, 'Disk bırakılamadı.'));
      return;
    }
    notify('ok', 'Kurtarma diski bırakıldı. Fişini çekebilirsiniz.');
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
          pools={backupCandidatePools(pools, parentDataset)}
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
          recovering={mode === 'kurtar'}
          onRecover={() => setMode(mode === 'kurtar' ? 'yok' : 'kurtar')}
          notify={notify}
          onAdopted={reload}
        />
      ) : target.unlocked ? (
        <Acik
          target={target}
          busy={busy}
          notify={notify}
          onRunNow={() => void runNow()}
          onLock={() => void lock()}
          onRelease={() => void release()}
          onSave={save}
        />
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
          onRelease={() => void release()}
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
  /** ADAY havuzlar — paylaşımların durduğu havuz `backupCandidatePools` ile çıkarılmış olarak. */
  pools: string[];
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
  recovering: boolean;
  onRecover: () => void;
  notify: Notify;
  onAdopted: () => void;
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
          {/* YANMIŞ CİHAZ YOLU, ve burada duruyor çünkü onu arayan kişi tam olarak burada
              oluyor: elinde bir yedek diski var, cihazında hiçbir şey yok. Kurulum düğmesinin
              yanına konması, "kur" diyerek diski silmesini önlüyor. */}
          <button type="button" className="b" onClick={props.onRecover}>
            Elimde bir yedek diski var
          </button>
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
            {/* Artık bir uyarı değil bir AÇIKLAMA: ana depolamanın havuzu listeye hiç girmiyor,
                çünkü aynı diske yazılan bir kopya yedek değildir. Kullanıcıya uyulması gereken
                bir kural bırakmak yerine, kuralı listenin kendisi uyguluyor. */}
            <span className="note">
              Yedeğin duracağı havuz. Ana depolamanızın havuzu listede yok — yedek başka bir diskte
              durmalı.
            </span>
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
            <button type="button" className="b" onClick={props.onCancel}>
              Vazgeç
            </button>
          </div>
        </>
      )}

      {props.recovering && <Kurtarma notify={props.notify} onAdopted={props.onAdopted} />}
    </>
  );
}

/**
 * Başka bir cihazın yedek diskini tanıma.
 *
 * ── SAHİBİNİN ALTINCI ŞARTI ──────────────────────────────────────────────────────────────────
 *
 * *"Sistem diski ve depolama diski yansa bile yedek diski eğer şifre biliniyorsa kullanılabilir
 * olmalı."* Diskin şifresiz yarısında bunun terminalli yolu zaten yazılı (`zpool import -f`);
 * burası aynı şeyin dört tıkla yapılan hâli, ve ürünün ölçütü bu — bu cihaz Linux meraklıları
 * için değil.
 *
 * ── İKİ AYRI ADIM, VE SIRASI ÖNEMLİ ──────────────────────────────────────────────────────────
 *
 * Önce TANIMA: disk takılıyor, DEPSIS yedek diski olduğu doğrulanıyor, etiketi ve son yedek
 * tarihi okunuyor. Dosyalar hâlâ kilitli. Ancak bundan sonra parola soruluyor.
 *
 * Ters sırada olsaydı, yanlış diski taktığını parolasını yazdıktan sonra öğrenirdi — ve kurtarma
 * yapan biri, elindeki her diski sırayla deniyor olabilir.
 *
 * ── DEVRALMA BİR ONAY ────────────────────────────────────────────────────────────────────────
 *
 * Ölen bir cihazdan çıkan disk hiçbir zaman düzgün bırakılmamış olur, yani devralma neredeyse
 * her zaman gerekiyor. Yine de sessizce yapılmıyor: aynı disk hâlâ çalışan başka bir cihazda
 * takılıysa devralmak havuzu bozar, ve bunu kullanıcıdan başka kimse bilemez.
 */
function Kurtarma(props: { notify: Notify; onAdopted: () => void }): React.JSX.Element {
  const [found, setFound] = useState<Importable[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adopt, setAdopt] = useState(false);

  async function scan(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.GET('/backups/target/recovery/scan', {});
    setBusy(false);
    if (data === undefined) {
      props.notify('error', problemMessage(error, 'Diskler taranamadı.'));
      return;
    }
    setFound(data.pools);
  }

  async function take(pool: string): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/backups/target/recovery/adopt', {
      body: { pool, adopt },
    });
    setBusy(false);
    if (data === undefined) {
      props.notify('error', problemMessage(error, 'Disk tanınamadı.'));
      return;
    }
    const when =
      data.lastBackupAt === null
        ? 'son yedek tarihi okunamadı'
        : `son yedek ${new Date(data.lastBackupAt).toLocaleString()}`;
    props.notify('ok', `${data.label} tanındı — ${when}. Şimdi parolasını girin.`);
    props.onAdopted();
  }

  return (
    <>
      <div className="netrow">
        <span className="lbl">Yedek diskinden geri dön</span>
        <button type="button" className="b" disabled={busy} onClick={() => void scan()}>
          {busy ? 'Taranıyor…' : 'Takılı diskleri tara'}
        </button>
      </div>
      <p className="note">
        Yanmış ya da değiştirilmiş bir cihazın yedek diskini bu cihaza takın. Bu adım diski yalnız
        tanır; dosyalar parolanızı girene kadar kilitli kalır.
      </p>

      {found !== null &&
        (found.length === 0 ? (
          <p className="note">
            Takılabilecek bir havuz görünmüyor. Diskin kabloları takılı mı, ve cihaz onu açılıştan
            sonra mı gördü?
          </p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Havuz</th>
                <th>Durum</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {found.map((pool) => (
                <tr key={pool.name}>
                  <td className="m">{pool.name}</td>
                  <td>{durum(pool.state)}</td>
                  <td>
                    <button
                      type="button"
                      className="b"
                      disabled={busy || (pool.needsAdopt && !adopt)}
                      onClick={() => void take(pool.name)}
                    >
                      Bu diski tanı
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {/* DEVRALMA UYARISI, ve yalnız gerektiğinde gösteriliyor. Her zaman görünen bir onay
          kutusu, insanların okumadan işaretlediği bir kutudur. */}
      {found?.some((pool) => pool.needsAdopt) === true && (
        <>
          <div className="warn">
            <span className="ic" aria-hidden>
              ⚠
            </span>
            <span className="tx">
              <b>Bu disk başka bir cihazda kullanılıyordu.</b>
              Düzgün çıkarılmamış — yanmış bir cihazdan çıkan diskin olağan hâli. Ama o cihaz hâlâ
              çalışıyorsa ve disk ona bağlıysa, devralmak yedeğin tamamını bozar.
            </span>
          </div>
          <label className="netrow">
            <input
              type="checkbox"
              checked={adopt}
              onChange={(event) => setAdopt(event.target.checked)}
            />
            <span className="tx">O cihaz artık çalışmıyor; diski bu cihaz devralsın.</span>
          </label>
        </>
      )}
    </>
  );
}

/**
 * Yedeğin gerçekten okunduğunun kaydı.
 *
 * ── "YEDEK ALINDI" BİR İDDİA ─────────────────────────────────────────────────────────────────
 *
 * Tur kaç dosya kopyaladığını sayıyor, ama saydığı şey kendi yaptığı çağrılar. Günde bir kez
 * gerçekten bir dosya okunup aslıyla karşılaştırılıyor, ve burada yazan şey o ölçümün sonucu.
 *
 * ── HİÇ ÖLÇÜLMEMİŞ, "SAĞLAM" DEĞİLDİR ────────────────────────────────────────────────────────
 *
 * `null` bir sonuç değil, sonucun yokluğu. Onu yeşil bir onay işaretiyle göstermek, doğrulamanın
 * tamamını süse çevirirdi — kullanıcı ekranda gördüğü işarete güvenip diskini hiç denemez.
 *
 * ── NE ÖLÇÜLDÜĞÜ DE YAZIYOR ──────────────────────────────────────────────────────────────────
 *
 * "Doğrulandı" tek başına bir şey söylemiyor: büyük bir dosyanın yalnız başı okunmuş olabilir, ve
 * hangi dosyanın okunduğu kullanıcının kendi bildiği bir şey. Cümle ajanın ölçtüğü şeyi anlatıyor.
 */
function Dogrulama({ target }: { target: Target }): React.JSX.Element {
  if (target.lastVerifiedAt === null || target.lastVerifiedAt === undefined) {
    return (
      <div className="netrow">
        <span className="lbl">Doğrulama</span>
        <span className="note">
          Henüz yapılmadı. İlk yedek turundan sonra, günde bir kez yedekten gerçekten bir dosya
          okunup aslıyla karşılaştırılacak.
        </span>
      </div>
    );
  }

  const when = new Date(target.lastVerifiedAt).toLocaleString();
  const note = target.lastVerifyNote ?? '';

  if (target.lastVerifyOk === false) {
    return (
      <div className="warn">
        <span className="ic" aria-hidden>
          ⚠
        </span>
        <span className="tx">
          <b>Yedek doğrulanamadı.</b>
          {note} ({when}) Bu, yedeğinizdeki bir dosyanın aslıyla aynı olmadığı anlamına geliyor;
          diski kontrol edin ve elle bir yedek turu başlatın.
        </span>
      </div>
    );
  }

  return (
    <div className="netrow">
      <span className="lbl">Doğrulama</span>
      <span className="pill">
        <i />
        {target.lastVerifyOk === true ? 'Okundu' : 'Ölçülemedi'}
      </span>
      <span className="note">
        {note} · {when}
      </span>
    </div>
  );
}

/** ZFS'in kelimesi ve karşılığı — ikisi de gösteriliyor. */
function durum(state: string): string {
  if (state === 'ONLINE') return 'Sağlam (ONLINE)';
  if (state === 'DEGRADED') return 'Bir diski arızalı ama okunabilir (DEGRADED)';
  if (state === 'FAULTED' || state === 'UNAVAIL') return `Okunamıyor (${state})`;
  return state;
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
  onRelease: () => void;
}): React.JSX.Element {
  const { target, open, busy, passphrase } = props;
  return (
    <>
      <div className="warn">
        <span className="ic" aria-hidden>
          🔒
        </span>
        <span className="tx">
          {target.recoveryOnly ? (
            <>
              <b>Kurtarma diski kilitli.</b>
              {target.label} — başka bir cihazın yedeği. Parolayı girince dosyalarını görebilecek ve
              tek tek geri getirebileceksiniz. Bu cihaz bu diske hiçbir şey yazmıyor.
            </>
          ) : (
            <>
              <b>Yedek diski kilitli.</b>
              {target.label} açılana kadar yedekleme duruyor. Cihaz her açıldığında kilitli gelir —
              parola hiçbir yerde saklanmıyor, çalınan bir cihazın yedeği de okunamasın diye.
            </>
          )}
        </span>
      </div>

      {!open ? (
        <div className="netrow">
          <button type="button" className="b" onClick={props.onOpen}>
            Kilidi aç
          </button>
          {/* ÇIKARMAK, YALNIZ KURTARMA DİSKLERİNDE. Cihazın kendi diskini "çıkarmak" ayarlarını
              da silmek olurdu; onun karşılığı kilitlemek. */}
          {target.recoveryOnly && (
            <button type="button" className="b" disabled={busy} onClick={props.onRelease}>
              Diski çıkar
            </button>
          )}
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
          <button type="button" className="b" onClick={props.onCancel}>
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
  notify: Notify;
  onRunNow: () => void;
  onLock: () => void;
  onRelease: () => void;
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

      <Dogrulama target={target} />

      {target.recoveryOnly && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu disk başka bir cihazın yedeği.</b>
            Dosyaları okuyabilir ve tek tek geri getirebilirsiniz; bu cihaz diske hiçbir şey
            yazmıyor ve hiçbir şey silmiyor. İşiniz bitince aşağıdan çıkarın.
          </span>
        </div>
      )}

      {/* AYARLAR YALNIZ CİHAZIN KENDİ DİSKİNDE. Kurtarma diskine hiçbir tur yazmıyor; sıklık
          ve saklama süresi orada hiçbir şeyi değiştirmeyen iki kutu olurdu — ve hiçbir şey
          yapmayan bir ayar, çalışıyormuş gibi duran bir denetimdir. */}
      {!target.recoveryOnly && (
        <>
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
        </>
      )}

      <Gezgin notify={props.notify} />

      {target.recoveryOnly ? (
        <div className="netrow">
          <button type="button" className="b" disabled={busy} onClick={props.onRelease}>
            Diski çıkar
          </button>
          <button type="button" className="b" disabled={busy} onClick={props.onLock}>
            Kilitle
          </button>
          <span className="note">
            Çıkarmak diski bu cihazdan bırakır; fişini güvenle çekebilirsiniz. Dosyalarınız diskte
            olduğu gibi kalır.
          </span>
        </div>
      ) : (
        <div className="netrow">
          <button type="button" className="b" disabled={busy} onClick={props.onRunNow}>
            Şimdi yedek al
          </button>
          <button type="button" className="b" disabled={busy} onClick={props.onLock}>
            Kilitle
          </button>
          <span className="note">
            Kilitlemek dosyaları okunamaz yapar ve yedeklemeyi durdurur. Açmak için parola gerekir.
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Yedek ağacında gezinme ve geri getirme.
 *
 * ── BU BİLEŞENİN VAR OLMA SEBEBİ ─────────────────────────────────────────────────────────────
 *
 * Bir yedeğin var olma sebebi geri getirmektir. Ürünün eski yedekleme ekranı yedek ALIYOR,
 * LİSTELİYOR ve ÇOĞALTIYOR ama hiçbir şey GERİ VERMİYORDU: geri alma başka bir ekranın köşesinde
 * duran küçük bir düğmenin arkasındaydı, ve "yedeğimi geri alacağım" diyen kişinin açacağı ekran
 * bunu yapamayan tek ekrandı.
 *
 * ── İKİ KLASÖR DE GÖRÜNÜYOR ──────────────────────────────────────────────────────────────────
 *
 * `Dosyalar/` gecikmeli ayna, `DEPSIS-YEDEK/silinenler/<tarih>/` ise sildikleriniz — gün gün.
 * İkincisini gizlemek, silinme tarihlerini yalnız ürünün okuyabildiği bir bilgiye çevirirdi;
 * oysa o klasör adlarının insan tarafından okunabilmesi bu tasarımın amacı: diski başka bir
 * bilgisayara takan biri aynı bilgiyi dosya gezgininde görüyor.
 */
function Gezgin({ notify }: { notify: Notify }): React.JSX.Element {
  const [path, setPath] = useState<string[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error } = await api.GET('/backups/target/entries', {
        params: { query: { path: path.join('/') } },
      });
      if (!alive) return;
      if (data === undefined) {
        notify('error', problemMessage(error, 'Yedek okunamadı.'));
        return;
      }
      setListing(data);
    })();
    return () => {
      alive = false;
    };
  }, [path, reloadKey, notify]);

  async function restore(name: string): Promise<void> {
    // GERİ GETİRME HEDEFİ: `Dosyalar/<paylaşım>/<yol>` biçimindeki bir yol, aynı paylaşımın aynı
    // yerine döner. `silinenler/<tarih>/<paylaşım>/<yol>` de öyle — tarih klasörü atlanıyor,
    // çünkü kullanıcının istediği şey dosyanın SİLİNMEDEN ÖNCEKİ yerine dönmesi.
    const full = [...path, name];
    let share: string | undefined;
    let to: string[] = [];
    if (full[0] === 'Dosyalar' && full.length >= 3) {
      share = full[1];
      to = full.slice(2);
    } else if (full[0] === 'DEPSIS-YEDEK' && full[1] === 'silinenler' && full.length >= 5) {
      share = full[3];
      to = full.slice(4);
    }
    if (share === undefined || to.length === 0) {
      notify('error', 'Bu dosyanın hangi paylaşıma döneceği anlaşılamadı.');
      return;
    }

    setBusy(true);
    const { data, error } = await api.POST('/backups/target/restore', {
      body: { from: full, share, to },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Geri getirilemedi.'));
      return;
    }
    notify('ok', `${name} geri getirildi: ${share}/${to.join('/')}`);
  }

  return (
    <>
      <div className="netrow">
        <span className="lbl">Yedekteki dosyalar</span>
        <span className="note m">
          {path.length === 0 ? '/' : `/${path.join('/')}`}
          {path.length > 0 && (
            <>
              {' · '}
              <button type="button" className="b" onClick={() => setPath((p) => p.slice(0, -1))}>
                ↑ yukarı
              </button>
            </>
          )}
        </span>
        <button type="button" className="b" onClick={() => setReloadKey((k) => k + 1)}>
          ⟳
        </button>
      </div>

      {listing === null ? (
        <p className="note">Okunuyor…</p>
      ) : listing.entries.length === 0 ? (
        <p className="note">Bu klasör boş.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad</th>
              <th>Boyut</th>
              <th>Değişme</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {listing.entries.map((entry) => (
              <tr key={entry.name}>
                <td>
                  {entry.directory ? (
                    <button
                      type="button"
                      className="b"
                      onClick={() => setPath((p) => [...p, entry.name])}
                    >
                      {entry.name}/
                    </button>
                  ) : (
                    entry.name
                  )}
                </td>
                <td className="m">{entry.directory ? '—' : formatBytes(entry.sizeBytes)}</td>
                <td className="m">{new Date(entry.modifiedAt).toLocaleString()}</td>
                <td>
                  {!entry.directory && (
                    <button
                      type="button"
                      className="b"
                      disabled={busy}
                      onClick={() => void restore(entry.name)}
                    >
                      Geri getir
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* KESİLMİŞ BİR LİSTE SÖYLENMEK ZORUNDA. Sessizce kısaltılmış bir liste, eksik olanın var
          olmadığı gibi okunur — ve burada "var olmayan" bir dosya, kullanıcının aradığı dosya. */}
      {listing?.truncated === true && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Bu klasör tam gösterilemiyor.</b>
            İçinde tek seferde listelenebileceğinden fazla dosya var. Aradığınız dosya burada
            görünmüyorsa, olmadığı anlamına gelmez.
          </span>
        </div>
      )}
    </>
  );
}
