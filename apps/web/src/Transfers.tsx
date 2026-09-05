import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, API_BASE_URL } from './api.js';
import { problemCode } from './Files.js';
import { useEventRefresh } from './events.js';
import { formatBytes, formatWhen, percent } from './Dashboard.js';
import { Empty } from './ui.js';

type Transfer = OpenApi.components['schemas']['Transfer'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * The fallback interval, no longer the primary one.
 *
 * §14's event stream is what refreshes this list now: a chunk landing moves `updated_at`, the
 * stream says so, and the panel re-reads. This timer stays as a much slower backstop for the case
 * the stream itself is down — a proxy that closes SSE, a reconnect that has not completed — where
 * a transfers panel frozen at its last value is worse than a slow one. Thirty seconds rather than
 * two: it is insurance, not the mechanism.
 */
const POLL_MS = 30_000;

/**
 * The three states, and what each one is allowed to look like.
 *
 * `stalled` gets amber rather than a quieter grey on purpose: a transfer list earns its place at
 * exactly the moment a transfer has STOPPED, and a stopped upload that looks like a slow one is
 * the same as no list at all.
 */
const STATES: Record<Transfer['state'], { label: string; pill: string; fill: string }> = {
  active: { label: 'sürüyor', pill: 'st2 dn', fill: 'var(--cool)' },
  stalled: { label: 'durdu', pill: 'st2 er', fill: 'var(--warn)' },
  completed: { label: 'bitti', pill: 'st2 up', fill: 'var(--live)' },
};

/**
 * Baytları TAM gelmiş ama yayımlanmamış bir yükleme: kararı bekliyor.
 *
 * `state` `completed_at`ten geliyor, ofsetten değil — ve aradaki fark tam olarak bu durum.
 * Bütün baytlar sunucuda duruyor, hedefte aynı adda bir şey var, ve dosyanın yayımlanması için
 * kullanıcının "değiştir mi, ikisini de tut mu" sorusuna cevap vermesi gerekiyor.
 */
export function awaitingAnswer(item: Transfer): boolean {
  return item.state !== 'completed' && item.lengthBytes > 0 && item.offsetBytes >= item.lengthBytes;
}

export function Transfers({ notify }: { notify: Notify }): React.JSX.Element {
  const [items, setItems] = useState<Transfer[] | null>(null);
  /** Set only while the list has never been read. Once real rows have arrived, a dropped poll
   *  leaves the last known ones on screen rather than replacing them with a failure. */
  const [failed, setFailed] = useState(false);
  /** Kararı gönderilmekte olan yükleme — düğmeler iki kez basılmasın diye. */
  const [deciding, setDeciding] = useState<string | null>(null);
  /**
   * Toplu kararın nerede olduğu.
   *
   * İki yüz dosya sırayla yayımlanıyor ve bu yarım dakika sürebiliyor. Sayaç olmadan ekranda
   * hiçbir şey kıpırdamıyor: kullanıcı düğmeye bir daha basıyor, sonra sayfayı yeniliyor, ve
   * yenilemek yarıda kalan bir işi geride bırakıyor.
   */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * Sunucunun bildirdiği TOPLAM bekleyen sayısı — listedeki değil.
   *
   * Liste bir tavana takılabiliyor; bu sayı takılmıyor. Cihazda 235 bekleyen yüklemenin yalnız
   * 75'i listeye giriyordu, ve şerit "75 dosya bekliyor" diyordu: doğru olmayan bir cümle, ve geri
   * kalan 160 dosyaya arayüzden ulaşmanın hiçbir yolu yoktu.
   */
  const [awaitingTotal, setAwaitingTotal] = useState(0);

  /**
   * Bekleyen bir yüklemeyi buradan yayımla.
   *
   * ── NEDEN BU EKRANDA DA VAR ─────────────────────────────────────────────────────────────
   *
   * Soru normalde yükleme sırasında Dosyalar ekranında soruluyor. Ama o soru bir tarayıcı
   * durumunda yaşıyor: sekme kapanırsa, sayfa yenilenirse ya da telefon uygulamayı arka planda
   * öldürürse soru kayboluyor — baytlar sunucuda kalıyor ve onları yayımlatacak hiçbir yol
   * kalmıyordu. Sahada bir turda 20 dosya bu hâlde asılı kaldı.
   *
   * Bu liste zaten o oturumları gösteriyordu; eksik olan tek şey karar düğmeleriydi. Baytlar
   * yeniden GÖNDERİLMİYOR — uç yalnız ara alandaki dosyayı yayımlıyor.
   */
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  /** Cevap bekleyenler: toplu karar bunlara uygulanıyor. */
  const waiting = (items ?? []).filter(awaitingAnswer);

  async function decide(batch: Transfer[], policy: 'keep-both' | 'replace'): Promise<void> {
    if (batch.length === 0) return;
    setDeciding(batch.length === 1 ? (batch[0]?.id ?? 'toplu') : 'toplu');
    if (batch.length > 1) setProgress({ done: 0, total: batch.length });
    let done = 0;
    const failedNames: string[] = [];
    /** Baytları ara alanda kalmamış olanlar. Satırları sunucu kapatıyor, yani bir sonraki
     *  yoklamada listeden düşüyorlar; kullanıcının bilmesi gereken tek şey yeniden yüklemek. */
    const goneNames: string[] = [];
    for (const item of batch) {
      const sent = await fetch(`${API_BASE_URL}/uploads/${item.id}/resolve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy }),
      }).catch(() => null);
      if (sent === null || !sent.ok) {
        if (sent !== null && (await problemCode(sent)) === 'staged-bytes-gone') {
          goneNames.push(item.filename);
        } else {
          failedNames.push(item.filename);
        }
        if (batch.length > 1)
          setProgress({ done: done + failedNames.length + goneNames.length, total: batch.length });
        continue;
      }
      done += 1;
      if (batch.length > 1) {
        setProgress({
          done: done + failedNames.length + goneNames.length,
          total: batch.length,
        });
      }
    }
    setDeciding(null);
    setProgress(null);

    const what =
      policy === 'replace' ? 'değiştirildi; eskisi çöp kutusunda' : 'ikinci bir adla kaydedildi';
    const first = batch[0];
    if (done === 1 && first !== undefined) notify('ok', `"${first.filename}" ${what}.`);
    else if (done > 1) notify('ok', `${done} dosya ${what}.`);
    if (goneNames.length > 0) {
      notify(
        'error',
        goneNames.length === 1
          ? `"${goneNames[0] ?? ''}" için gönderilen baytlar sunucuda kalmamış; yeniden yükleyin.`
          : `${goneNames.length} dosyanın baytları sunucuda kalmamış; yeniden yükleyin.`,
      );
    }
    if (failedNames.length > 0) {
      notify(
        'error',
        failedNames.length === 1
          ? `"${failedNames[0] ?? ''}" yayımlanamadı.`
          : `${failedNames.length} dosya yayımlanamadı.`,
      );
    }
    reload();
  }

  // The stream replaces the poll. `reload` is stable, so subscribing here does not tear the
  // connection down on every render.
  useEventRefresh('transfer', reload);

  useEffect(() => {
    let alive = true;
    // A failure is reported once and then the poll keeps going quietly. Two seconds of toasts for
    // an appliance that is briefly unreachable would bury every other message on the desktop.
    let complained = false;
    /** Whether the list has ever been read successfully in this window's lifetime. */
    let everLoaded = false;

    const load = async (): Promise<void> => {
      const { data } = await api.GET('/transfers', {});
      if (!alive) return;
      if (data === undefined) {
        if (!complained) {
          complained = true;
          notify('error', 'Aktarımlar okunamadı.');
        }
        // Not `current ?? []`. On the FIRST poll that turned into "Süren aktarım yok." — which is
        // exactly the wrong thing to tell somebody whose upload may still be running. Once real
        // rows have been seen, a dropped poll leaves them alone instead: they were true a moment
        // ago, which is closer than either an empty list or an error panel.
        if (!everLoaded) setFailed(true);
        return;
      }
      complained = false;
      everLoaded = true;
      setFailed(false);
      setItems(data.items);
      setAwaitingTotal(data.awaitingTotal);
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [notify, reloadKey]);

  return (
    <>
      {failed ? (
        <Empty glyph="⚠" text="Aktarımlar okunamadı." />
      ) : items === null ? (
        <p className="note">Yükleniyor…</p>
      ) : items.length === 0 ? (
        <Empty glyph="⇅" text="Süren aktarım yok." />
      ) : (
        <div>
          {/* ── HEPSİ İÇİN TEK KARAR ────────────────────────────────────────────────────
              Bir fotoğraf grubunu yeniden yükleyen biri iki yüz satırın her birine ayrı ayrı
              basmaz. Sahada tam olarak bu oldu: 200 dosya cevap bekler hâlde durdu ve ekran
              her biri için ayrı bir düğme gösteriyordu.

              Şerit yalnız BİRDEN FAZLA bekleyen varken çiziliyor: tek dosyada satırın kendi
              düğmeleri zaten oradadır ve ikinci bir kopyası kalabalıktan başka bir şey değil. */}
          {waiting.length > 1 && (
            <div className="trbulk">
              <span>
                <b>{Math.max(awaitingTotal, waiting.length)} dosya</b> cevabınızı bekliyor —
                baytların hepsi sunucuda.
                {/* KESİLDİYSE SÖYLENİYOR. Listenin bir tavanı var ve sessizce uygulanan bir tavan,
                    kullanıcıya olmayan bir "hepsi bu kadar" gösteriyordu. Düğmeler yalnız burada
                    listelenenlere basıyor; kalanı bir sonraki turda çıkıyor. */}
                {awaitingTotal > waiting.length && ` Şu an ${waiting.length} tanesi listede.`}
                {progress !== null && ` Yayımlanıyor: ${progress.done} / ${progress.total}…`}
              </span>
              <button
                type="button"
                className="b"
                disabled={deciding !== null}
                onClick={() => void decide(waiting, 'keep-both')}
              >
                Hepsini ikisini de tut
              </button>
              <button
                type="button"
                className="b"
                disabled={deciding !== null}
                onClick={() => void decide(waiting, 'replace')}
              >
                Hepsini değiştir
              </button>
            </div>
          )}
          {items.map((item) => {
            const state = STATES[item.state];
            const ratio =
              item.lengthBytes > 0 ? Math.min(1, item.offsetBytes / item.lengthBytes) : 0;
            return (
              <div className="trrow" key={item.id}>
                <div className="l">
                  <span title={item.filename}>{item.filename}</span>
                  <em>{percent(item.offsetBytes, item.lengthBytes)}</em>
                  <em style={{ color: 'var(--mut)' }}>
                    {formatBytes(item.offsetBytes)} / {formatBytes(item.lengthBytes)}
                  </em>
                  <span className={state.pill} style={{ flex: 'none' }}>
                    {state.label}
                  </span>
                </div>
                {/* Written out rather than reusing <Bar/>: the fill colour IS the reading here, and
                    the shared bar has one tint for every caller by design. */}
                <div
                  className="bar2"
                  role="progressbar"
                  aria-label={`${item.filename} aktarımı`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(ratio * 100)}
                >
                  <span style={{ width: `${ratio * 100}%`, background: state.fill }} />
                </div>
                {awaitingAnswer(item) ? (
                  <div className="l">
                    <span style={{ color: 'var(--warn)' }}>
                      Dosyanın tamamı geldi ama hedefte aynı adda bir şey var. Listede
                      göremiyorsanız ad çöp kutusundaki bir dosyada duruyor olabilir.
                    </span>
                    <button
                      type="button"
                      className="b"
                      disabled={deciding === item.id}
                      onClick={() => void decide([item], 'keep-both')}
                    >
                      İkisini de tut
                    </button>
                    <button
                      type="button"
                      className="b"
                      disabled={deciding === item.id}
                      onClick={() => void decide([item], 'replace')}
                    >
                      Değiştir (eskisi çöpe)
                    </button>
                  </div>
                ) : (
                  item.state === 'stalled' && (
                    <div className="l">
                      <span style={{ color: 'var(--warn)' }}>
                        Bir dakikadan uzun süredir ilerlemiyor — son yazma{' '}
                        {formatWhen(item.updatedAt)}. Yükleyen sekme kapanmış olabilir. Yüklemeyi
                        başlatan TARAYICIDA aynı dosya yeniden seçilirse kaldığı yerden devam eder;
                        başka bir tarayıcıda ya da temizlenmiş bir profilde baştan başlar.
                      </span>
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="note">
        Bu liste SUNUCUNUN bildiği yüklemeleri gösterir; başka bir sekmede başlatılan bir yükleme de
        burada görünür. İndirmeler yok: bir indirme tek bir HTTP isteği ve sunucu tarafında bir
        durumu yok.
      </div>
    </>
  );
}
