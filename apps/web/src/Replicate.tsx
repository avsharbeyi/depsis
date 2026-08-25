import type { OpenApi } from '@depsis/contracts';
import { useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';

type Backup = OpenApi.components['schemas']['Snapshot'];

/**
 * Çoğaltma formu — bu arayüzün veri yok eden ikinci yolu.
 *
 * §8.1'in dizisi ekranda görünür olmak zorunda, ve bu bileşenin şekli o dizinin kendisi: hangi
 * anlık görüntü (analiz, listeden seçiliyor), nereye (plan), hedefin adı elle yazılıyor (yazılı
 * onay), parola (yeniden kimlik doğrulama), sonra iş.
 *
 * ONAY KUTUSUNA HEDEFİN ADI YAZILIYOR, kaynağınki değil. Yok edilen şey hedef, ve bir onay kutusu
 * kaybedilecek olanın adını istemeli — havuz oluşturmada da silinecek havuzun adı isteniyor.
 *
 * VARSAYILAN OLARAK KAPALI. Panelin açılışında yalnız bir bağlantı var; form ancak istenirse
 * çiziliyor. Bir yedek listesine bakan kişinin çoğu zaman yapacağı şey bakmak, ve yıkıcı bir formu
 * her açılışta önüne koymak onu tıklanacak bir şeye çeviriyor.
 */
export function Replicate({
  backups,
  notify,
  onQueued,
}: {
  /** Havuzda GERÇEKTEN duran görüntüler; kaynak yalnız bunlardan seçilebiliyor. */
  backups: Backup[];
  notify: (kind: 'ok' | 'error', text: string) => void;
  onQueued: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // KAYNAK YALNIZ HAVUZDA OLANLARDAN. Kayıtta olup havuzda olmayan bir görüntüyü göndermek
  // mümkün değil, ve onu listede sunmak sunucunun reddedeceği bir seçim teklif etmek olurdu.
  const sendable = backups.filter((item) => item.state === 'present' || item.state === 'unmanaged');
  const chosen = sendable.find((item) => item.fullName === source);
  // Taban yalnız AYNI veri kümesinden olabilir: artımlı gönderim iki tarafın da sahip olduğu bir
  // noktadan yapılıyor, ve başka bir kümenin görüntüsü öyle bir nokta değil.
  const bases =
    chosen === undefined
      ? []
      : sendable.filter((item) => item.dataset === chosen.dataset && item.fullName !== source);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (chosen === undefined || busy) return;
    setBusy(true);
    const { data, error } = await api.POST('/storage/replication', {
      body: {
        source: chosen.dataset,
        snapshot: chosen.name,
        target: target.trim(),
        base: base === '' ? null : (bases.find((b) => b.fullName === base)?.name ?? null),
        confirm: confirm.trim(),
        password,
      },
    });
    setBusy(false);
    // PAROLA HER DURUMDA TEMİZLENİYOR, başarıda da hatada da. Ekranda duran bir parola, formu
    // kapatmayı unutan biri için açık kalmış bir kapı.
    setPassword('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Çoğaltma başlatılamadı.'));
      return;
    }
    notify('ok', 'Çoğaltma işi kuyruğa alındı.');
    setConfirm('');
    setOpen(false);
    onQueued();
  }

  if (!open) {
    return (
      <button type="button" className="lnk" onClick={() => setOpen(true)}>
        İkinci bir veri kümesine çoğalt
      </button>
    );
  }

  return (
    <form className="repl" onSubmit={(event) => void submit(event)}>
      <div className="warn">
        <span className="ic" aria-hidden>
          ⚠
        </span>
        <span className="tx">
          <b>Hedefteki veri yok edilir.</b>
          Çoğaltma hedefi olduğu gibi bırakmıyor: hedefteki her şey ve ortak tabandan yeni her anlık
          görüntü siliniyor. Paylaşımların bulunduğu veri kümesi hedef olarak seçilemez.
        </span>
      </div>

      <label className="fld">
        <span className="lbl">Gönderilecek anlık görüntü</span>
        <select value={source} onChange={(event) => setSource(event.target.value)} required>
          <option value="">Seçin…</option>
          {sendable.map((item) => (
            <option key={item.fullName} value={item.fullName}>
              {item.fullName}
            </option>
          ))}
        </select>
      </label>

      <label className="fld">
        <span className="lbl">Hedef veri kümesi</span>
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="yedek/depsis"
          maxLength={255}
          required
        />
      </label>

      {bases.length > 0 && (
        <label className="fld">
          <span className="lbl">Artımlı taban (isteğe bağlı)</span>
          <select value={base} onChange={(event) => setBase(event.target.value)}>
            {/* Boş = TAM gönderim, ve bu varsayılan. Hedefin neyi tuttuğunu bu ekran bilmiyor, ve
                yanlış bir taban seçmek reddedilen bir işten başka bir şey üretmiyor. */}
            <option value="">Tam gönderim</option>
            {bases.map((item) => (
              <option key={item.fullName} value={item.fullName}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="fld">
        <span className="lbl">
          Onaylamak için hedefin adını yazın{target.trim() === '' ? '' : `: ${target.trim()}`}
        </span>
        <input
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="off"
          required
        />
      </label>

      <label className="fld">
        <span className="lbl">Parolanız</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>

      <div className="row">
        {/* Onay hedefle EŞLEŞENE kadar kapalı. Sunucu da kontrol ediyor — bu, yanlış yazmış birine
            parolasını verdirmeden söylemek için. */}
        <button
          type="submit"
          className="b danger"
          disabled={
            busy || chosen === undefined || confirm.trim() !== target.trim() || target.trim() === ''
          }
        >
          Çoğalt
        </button>
        <button type="button" className="b" onClick={() => setOpen(false)}>
          Vazgeç
        </button>
      </div>
    </form>
  );
}
