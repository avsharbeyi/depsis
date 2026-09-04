import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, isTransportFailure, problemMessage } from './api.js';

type UpdateStatus = OpenApi.components['schemas']['UpdateStatus'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Cevapsız kalan bir okumanın ne anlama geldiği.
 *
 * "CİHAZ YENİDEN BAŞLIYOR" BİR İDDİA, ve her başarısız okuma onu doğrulamıyor. Kurulum sırasında
 * API gerçekten kesiliyor — istek hiç ulaşmıyor, tarayıcı bağlantıyı düşürüyor (`isTransportFailure`)
 * ya da önündeki nginx 502 veriyor. Ama ajan çöktüğünde API AYAKTA ve 503 ile "depolama ajanına
 * ulaşılamıyor" diyor: cihaz yeniden başlamıyor, cevap veriyor. İkisini aynı kefeye koyan ekran,
 * ajanı ölmüş bir kutuda saatlerce "birazdan döner" diyerek sahibini bekletiyordu.
 *
 * 401 üçüncü bir şey: oturum bitmiş. Onu burada anlatmak yanlış olurdu — App'in kendi oturum yolu
 * zaten devrede, ve bu panelin söyleyeceği her cümle onun üstüne yanlış bir teşhis koyardı.
 */
export type ReadFailure = 'unreachable' | 'signed-out' | 'refused';

export function readFailure(status: number, transport: boolean): ReadFailure {
  if (status === 401) return 'signed-out';
  // 502: nginx ayakta, arkasındaki API kapalı — kurulumun tam ortası.
  if (transport || status === 502) return 'unreachable';
  return 'refused';
}

/** Commit kimliği kırk hanedir ve kırk hane hiç kimseye bir şey söylemez. */
function short(commit: string | null): string {
  return commit === null ? '—' : commit.slice(0, 7);
}

function when(value: string | null): string {
  if (value === null) return '';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
}

/**
 * Yazılım güncellemesi — cihazın kendini güncellemesinin arayüz yarısı.
 *
 * NEDEN VAR. Depoda düzelen bir şey, sahadaki kutuya ancak ISO yeniden üretilip yeniden kurularak
 * ya da kutuda bir kabuk açılarak gidiyordu. Cihazın sahibi olağan hiçbir iş için terminale
 * girmemeli, ve bir güvenlik düzeltmesinin kullanıcıya ulaşamaması düzeltmenin kendisinden büyük
 * bir kusurdur.
 *
 * İKİ AYRI DÜĞME, ve ayrı olmaları bilinçli. "Denetle" ağa çıkar ve hiçbir şey değiştirmez;
 * "Güncelle" DENETİMİN BULDUĞU sürümü kurar. Tek düğme olsaydı, yönetici ekranda gördüğü sürümü
 * değil, düğmeye bastığı andaki sürümü kurmuş olurdu.
 *
 * KURULUM SIRASINDA API KESİLİR. Bu ekran onu bir hata olarak göstermez: kurulum API'yi, worker'ı
 * ve nginx'i yeniden başlatıyor, yani yanıt vermeyen bir sunucu tam da beklenen şey. Yoklama
 * sürer ve bağlantı geri geldiğinde durum kendiliğinden güncellenir.
 */
export function UpdatePanel({ notify }: { notify: Notify }): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  /** Yönetici değilse bu bölüm hiç çizilmez — 403 bir hata değil, bir cevaptır. */
  const [allowed, setAllowed] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  /** Sunucunun AÇIKÇA reddettiği okuma — cümlesiyle birlikte, çünkü teşhis onun içinde. */
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const alive = useRef(true);

  const load = useCallback(async (): Promise<UpdateStatus | null> => {
    const { data, error, response } = await api.GET('/system/update', {});
    if (!alive.current) return null;
    if (response.status === 403) {
      setAllowed(false);
      return null;
    }
    if (data === undefined) {
      switch (readFailure(response.status, isTransportFailure(response))) {
        case 'unreachable':
          // Kurulum sırasında sunucu birkaç kez kesilir. Bunu "güncelleme bozuldu" diye
          // göstermek, olağan bir adımı bir felakete çevirirdi.
          setUnreachable(true);
          setProblem(null);
          return null;
        case 'signed-out':
          // Oturumu App yönetiyor; burada söylenecek bir şey yok, ve yoklamayı sürdürmek
          // kapanmış bir oturumu üç saniyede bir yeniden sormak olurdu.
          setUnreachable(false);
          setProblem(null);
          return null;
        case 'refused':
          setUnreachable(false);
          setProblem(problemMessage(error, 'Güncelleme durumu okunamadı.'));
          return null;
      }
    }
    setUnreachable(false);
    setProblem(null);
    setStatus(data);
    return data;
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // YOKLAMA YALNIZ BİR ŞEY KOŞARKEN. Boştaki bir kutuyu her üç saniyede bir sorgulamak, hiçbir
  // şey söylemeyen bir istek trafiğidir; kurulum sırasında ise ekranın tek canlılık kanıtı budur.
  const running = status?.inProgress === true || unreachable;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [running, load]);

  if (!allowed) return null;

  async function check(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/system/update/check', {});
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Sürüm denetimi başlatılamadı.'));
      return;
    }
    setStatus(data);
    notify('ok', 'Sürüm denetimi başladı.');
  }

  async function apply(): Promise<void> {
    setBusy(true);
    const { data, error } = await api.POST('/system/update/apply', { body: { password } });
    setBusy(false);
    setPassword('');
    if (data === undefined) {
      notify('error', problemMessage(error, 'Güncelleme başlatılamadı.'));
      return;
    }
    setAsking(false);
    setStatus(data);
    notify('ok', 'Güncelleme başladı. Cihaz bu sırada birkaç kez yanıt vermeyebilir.');
  }

  const installed = status?.installed ?? null;
  const available = status?.available ?? null;
  const canUpdate = status !== null && !status.inProgress && !status.upToDate && available !== null;

  return (
    <>
      <div className="syshead">Yazılım sürümü</div>

      <div className="netrow">
        <span className="lbl">Kurulu</span>
        <span className="val" style={{ fontFamily: 'var(--mono)' }}>
          {short(installed)}
        </span>
        <Pill status={status} unreachable={unreachable} problem={problem} />
        {status !== null &&
          (status.signed ? (
            <span className="pill">imzalı sürüm</span>
          ) : (
            // Kutunun neye güvendiği EKRANDA. İmzasız kipte güvenilen tek şey HTTPS ve kaynağın
            // adresinin güncelleyicide sabit olması: aradaki ağ dışarıda, kaynağın kendisi değil.
            <span
              className="pill dim"
              title="Bu cihaz imzalı sürüm anahtarı taşımıyor; güncelleme doğrudan kaynak deposundan geliyor."
            >
              imzasız kaynak
            </span>
          ))}
      </div>

      {installed === null && status !== null && (
        <p className="note">
          Bu kutu, sürümünü kaydeden bir kurulumdan önce kurulmuş: kurulu sürüm bilinmiyor. Bir
          güncelleme yapıldığında sürüm kaydedilmeye başlar.
        </p>
      )}

      {available !== null && (
        <div className="netrow">
          <span className="lbl">Bulunan</span>
          <span className="val" style={{ fontFamily: 'var(--mono)' }}>
            {short(available.commit)}
          </span>
          <span className="note">
            {available.subject ?? ''}
            {available.committedAt === null ? '' : ` · ${when(available.committedAt)}`}
          </span>
        </div>
      )}

      {status?.error != null && status.error !== '' && <p className="note warn">{status.error}</p>}

      {unreachable && (
        <p className="note">
          Cihaz şu an yanıt vermiyor. Kurulum sırasında olağan: API, worker ve web sunucusu yeniden
          başlatılıyor. Bu ekran bağlantı geri gelince kendiliğinden güncellenir.
        </p>
      )}

      {/* SUNUCU CEVAP VERDİ, AMA OLUMSUZ. Burada beklemenin bir anlamı yok — yoklama da durdu —
          bu yüzden ekran hem sebebi hem de tek yapılacak şeyi gösteriyor. */}
      {problem !== null && (
        <p className="note warn">
          {problem} Cihaz yeniden başlamıyor: sunucu yanıt verdi ama güncelleme durumunu okuyamadı.{' '}
          <button type="button" className="lnk" onClick={() => void load()}>
            Yeniden dene
          </button>
        </p>
      )}

      {/* GÜNCELLEME DÜŞTÜĞÜNDE DE GÖRÜNÜYOR, ve bu bir düzeltme: ilk hâli günlüğü yalnız
          `inProgress` iken çiziyordu, yani kurulum düşer düşmez ekrandan kayboluyordu. Günlüğe en
          çok ihtiyaç duyulan an tam olarak o an — sahada ilk başarısız güncellemede elde yalnız
          tek cümlelik hata kaldı ve neyin düştüğü görülemedi. */}
      {status !== null &&
        (status.inProgress || status.phase === 'failed') &&
        status.logTail.length > 0 && <Log lines={status.logTail} />}

      {asking ? (
        <div className="netrow">
          <span className="lbl">Parola</span>
          <input
            type="password"
            className="sb"
            aria-label="Parola"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="b"
            disabled={busy || password === ''}
            onClick={() => void apply()}
          >
            Güncellemeyi başlat
          </button>
          <button
            type="button"
            className="b"
            onClick={() => {
              setAsking(false);
              setPassword('');
            }}
          >
            Vazgeç
          </button>
        </div>
      ) : (
        <div className="netrow">
          <button
            type="button"
            className="b"
            disabled={busy || status === null || status.inProgress}
            onClick={() => void check()}
          >
            ⟳ Sürüm denetle
          </button>
          <button type="button" className="b" disabled={!canUpdate} onClick={() => setAsking(true)}>
            ⤓ Güncelle
          </button>
          {status?.checkedAt != null && (
            <span className="note">Son denetim: {when(status.checkedAt)}</span>
          )}
        </div>
      )}

      <p className="note">
        Güncelleme kaynaktan derlenir ve yavaş cihazlarda uzun sürebilir. Kurulum düşerse cihaz eski
        sürüme geri alınır ve çalışır durumda bırakılır.
      </p>
    </>
  );
}

/**
 * Kurulumun kendi çıktısı — güncelleme koşarken canlı, düştüğünde ekranda kalan.
 *
 * KENDİ KUTUSU, konsolunki değil. Önce `.term`i ödünç alıyordu; o sınıf xterm.js'in çizdiği
 * konsol için yazılmış ve yüksekliğini bir esnek kutunun içinde alıyor. Sistem ekranının
 * akışında `flex: 1` hiçbir şeye tutunmuyor, ve satır içi bir `maxHeight` ile birlikte geriye
 * ince bir şerit kalıyordu: güncellemenin neden düştüğünü okuyacağınız tek yer, okunamayacak
 * kadar dar.
 *
 * SON SATIRA YAPIŞIYOR. Kurulum üç dakika sürüyor ve ekran her üç saniyede bir yenileniyor;
 * okunacak yer daima en alt. Ama yalnız kullanıcı zaten aşağıdayken: yukarı kaydırıp bir hata
 * satırını okuyan birini üç saniye sonra en alta fırlatmak, günlüğü okunamaz kılardı.
 */
function Log({ lines }: { lines: readonly string[] }): React.JSX.Element {
  const box = useRef<HTMLPreElement>(null);
  const text = lines.join('\n');

  useEffect(() => {
    const node = box.current;
    if (node === null) return;
    // 24px'lik pay, "en altta sayılır" eşiği: bir satırın kesri kadar yukarıda duran biri hâlâ
    // takip ediyordur, ve kesin eşitlik arayan bir kontrol alt uca hiç yapışmazdı.
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    if (atBottom) node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <pre className="updlog" ref={box} aria-label="Kurulum günlüğü" tabIndex={0}>
      {text}
    </pre>
  );
}

/**
 * Durumun tek bakışta okunan hâli.
 *
 * "Bilinmiyor" ile "güncel" AYRI: hiç denetim yapılmamış bir kutuya yeşil bir "güncel" rozeti
 * takmak, güncellemeyi hiç yapmamanın en sessiz yolu olurdu.
 */
function Pill({
  status,
  unreachable,
  problem,
}: {
  status: UpdateStatus | null;
  unreachable: boolean;
  problem: string | null;
}): React.JSX.Element {
  if (unreachable) return <span className="pill warn">Cihaz yeniden başlıyor…</span>;
  if (problem !== null) return <span className="pill bad">Durum okunamadı</span>;
  if (status === null) return <span className="pill dim">okunuyor…</span>;
  if (status.inProgress) {
    return (
      <span className="pill">
        <i />
        {status.phase === 'checking' ? 'Denetleniyor…' : 'Güncelleniyor…'}
      </span>
    );
  }
  if (status.phase === 'failed') return <span className="pill bad">Son deneme düştü</span>;
  if (status.upToDate) return <span className="pill">Güncel</span>;
  if (status.available !== null) return <span className="pill warn">Yeni sürüm var</span>;
  return <span className="pill dim">Denetlenmedi</span>;
}
