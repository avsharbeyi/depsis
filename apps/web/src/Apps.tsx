import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { ConfirmBox, Empty, Glyph, Win } from './ui.js';
import type { Tone } from './ui.js';

type AppPage = OpenApi.components['schemas']['AppPage'];
type AppRow = OpenApi.components['schemas']['App'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** What each podman state is called on screen, and in which tone the pill is drawn. */
const STATES: Record<NonNullable<AppRow['state']>, { label: string; pill: string }> = {
  running: { label: 'çalışıyor', pill: 'st2 up' },
  stopped: { label: 'durdu', pill: 'st2 dn' },
  starting: { label: 'başlıyor', pill: 'st2 dn' },
  error: { label: 'hata', pill: 'st2 er' },
  unknown: { label: 'bilinmiyor', pill: 'st2 dn' },
};

/**
 * The catalogue icon is a single character from the database; the tone is this file's decision.
 * Cycling by slug keeps a grid of a dozen apps from being one colour without inventing a field.
 */
const TONES: Tone[] = ['cool', 'iris', 'live', 'warn', 'rose'];

/** The hosts from which a container's own 127.0.0.1 address is reachable. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function toneFor(slug: string): Tone {
  let sum = 0;
  for (const ch of slug) sum += ch.codePointAt(0) ?? 0;
  return TONES[sum % TONES.length] ?? 'cool';
}

interface Props {
  notify: Notify;
  isAdmin: boolean;
}

/**
 * The application catalogue — GET /apps, PATCH/DELETE /apps/{slug}, GET /apps/{slug}/logs.
 *
 * `GET /apps` always answers 200, even with no container runtime on the box, because the catalogue
 * lives in the database and listing it needs nothing from podman. That is why this screen can draw
 * a full grid and merely disable it, instead of showing an error page where a product should be.
 */
export function Apps({ notify, isAdmin }: Props): React.JSX.Element {
  const [page, setPage] = useState<AppPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppRow | null>(null);
  const [logs, setLogs] = useState<{ name: string; lines: string[] } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data } = await api.GET('/apps', {});
      if (!alive) return;
      if (data === undefined) {
        // The failure needs its own state. Leaving `page` at null meant the pane went on claiming
        // it was loading something it had already given up on, for the life of the window.
        notify('error', 'Uygulamalar okunamadı.');
        setFailed(true);
        return;
      }
      setPage(data);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, notify]);

  async function setState(app: AppRow, state: 'running' | 'stopped'): Promise<void> {
    setBusySlug(app.catalogue.slug);
    const { error, response } = await api.PATCH('/apps/{slug}', {
      params: { path: { slug: app.catalogue.slug } },
      body: { state },
    });
    setBusySlug(null);
    if (response.status === 503) {
      notify('error', 'Konteyner çalışma zamanı yanıt vermiyor.');
      return;
    }
    if (!response.ok) {
      notify('error', problemMessage(error, 'Uygulama durumu değiştirilemedi.'));
      return;
    }
    notify(
      'ok',
      state === 'running'
        ? `${app.catalogue.name} başlatıldı.`
        : `${app.catalogue.name} durduruldu.`,
    );
    reload();
  }

  async function remove(app: AppRow): Promise<void> {
    setRemoving(null);
    setBusySlug(app.catalogue.slug);
    const { error, response } = await api.DELETE('/apps/{slug}', {
      params: { path: { slug: app.catalogue.slug } },
    });
    setBusySlug(null);
    if (response.status === 503) {
      notify('error', 'Konteyner çalışma zamanı yanıt vermiyor.');
      return;
    }
    if (!response.ok) {
      notify('error', problemMessage(error, 'Uygulama kaldırılamadı.'));
      return;
    }
    notify('ok', `${app.catalogue.name} kaldırıldı. Bağlı paylaşımlara dokunulmadı.`);
    reload();
  }

  async function openLogs(app: AppRow): Promise<void> {
    setBusySlug(app.catalogue.slug);
    const { data, error, response } = await api.GET('/apps/{slug}/logs', {
      params: { path: { slug: app.catalogue.slug }, query: { lines: 200 } },
    });
    setBusySlug(null);
    if (data === undefined) {
      notify(
        'error',
        problemMessage(
          error,
          response.status === 503
            ? 'Konteyner çalışma zamanı yanıt vermiyor.'
            : 'Günlük okunamadı.',
        ),
      );
      return;
    }
    setLogs({ name: app.catalogue.name, lines: data.lines });
  }

  if (failed) {
    return (
      <Empty
        glyph="⚠"
        text="Uygulamalar okunamadı."
        action={
          <button type="button" className="b" onClick={reload}>
            Yeniden dene
          </button>
        }
      />
    );
  }
  if (page === null) return <p className="note">Yükleniyor…</p>;

  const runtime = page.runtime;
  const usable = runtime.available && isAdmin;
  /**
   * Whether the `Aç` links can possibly work from here.
   *
   * `App.url` is an address on 127.0.0.1 by design — containers are never published to the LAN —
   * so opened from any machine other than the appliance itself the link resolves to the VIEWER's
   * own loopback and fails. Which is the normal case: a NAS is administered from somewhere else.
   */
  const onDevice = LOOPBACK.has(window.location.hostname);

  return (
    <>
      {!runtime.available && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Konteyner çalışma zamanı kurulu değil.</b>
            Katalog burada duruyor ama hiçbir uygulama kurulamaz ya da başlatılamaz. DEPSIS
            podman&apos;ı paketlemez; dağıtımın kendi paketinden kurulur:
            <span className="val" style={{ display: 'block', marginTop: 4 }}>
              sudo apt install podman &amp;&amp; sudo systemctl enable --now podman.socket
            </span>
          </span>
        </div>
      )}

      {runtime.available && runtime.rootless === false && (
        <div className="warn">
          <span className="ic" aria-hidden>
            ⚠
          </span>
          <span className="tx">
            <b>Podman köksüz çalışmıyor.</b>
            Kurulum ADR-0019&apos;un ayrıcalık kararından sapmış: konteynerler kendi ayrıcalıksız
            kullanıcısı yerine root ile çalışıyor ve bir uygulamanın erişimi cihazın tamamına kadar
            uzanabilir.
          </span>
        </div>
      )}

      {page.items.length === 0 ? (
        <Empty glyph="🧩" text="Katalog boş." />
      ) : (
        <div className="apps">
          {page.items.map((app) => {
            const cat = app.catalogue;
            const state = app.installed ? STATES[app.state ?? 'unknown'] : null;
            const busy = busySlug === cat.slug;
            const running = app.state === 'running';
            return (
              <div className="app" key={cat.slug}>
                <div className="h">
                  <Glyph tone={toneFor(cat.slug)} size={32}>
                    {cat.icon}
                  </Glyph>
                  <b>{cat.name}</b>
                  <span className={state === null ? 'st2 dn' : state.pill}>
                    {state === null ? 'kurulu değil' : state.label}
                  </span>
                </div>
                <div className="m">{cat.summary}</div>
                <div className="val">
                  {cat.image}:{cat.tag}
                </div>

                {!app.installed && (
                  <>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* Disabled rather than absent. Installing needs one SHARE ID per catalogue
                          mount target, and the contract publishes no endpoint that lists shares —
                          so the picker cannot be built without asking a person to type a UUID. The
                          button stays visible because a missing button reads as "this appliance
                          cannot install apps". */}
                      <button type="button" className="b pri" style={{ flex: 1 }} disabled>
                        Kur
                      </button>
                    </div>
                    {/* Why it is disabled, in text on the card. It used to live in a `title`, which
                        is invisible on a touch screen — and a touch screen is most of how a NAS
                        actually gets administered. */}
                    <div className="note">
                      {runtime.available
                        ? 'Kurulum için bir paylaşım seçmek gerekiyor; API henüz paylaşımları listeleyen bir uç sunmuyor.'
                        : 'Konteyner çalışma zamanı kurulu değil.'}
                    </div>
                  </>
                )}

                {!app.installed && cat.mounts.length > 0 && (
                  <div className="note">
                    Kurulunca bağlanacak:{' '}
                    {cat.mounts
                      .map((mount) => `${mount.target} (${mount.purpose}, ${mount.mode})`)
                      .join(' · ')}
                  </div>
                )}

                {app.installed && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {usable && (
                      <button
                        type="button"
                        className={running ? 'tg stop' : 'tg start'}
                        style={{ flex: 1 }}
                        disabled={busy}
                        onClick={() => void setState(app, running ? 'stopped' : 'running')}
                      >
                        {running ? 'Durdur' : 'Başlat'}
                      </button>
                    )}
                    {/* Only offered from the appliance itself. `app.url` is on 127.0.0.1, so
                        from any other machine this button opens the VIEWER's loopback and fails —
                        a link that cannot work is worse than none, and the footer says where the
                        address points. */}
                    {running && onDevice && app.url !== null && app.url !== undefined && (
                      <a
                        className="b"
                        style={{ flex: 1, textAlign: 'center', textDecoration: 'none' }}
                        href={app.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Aç
                      </a>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        className="b"
                        disabled={busy}
                        onClick={() => void openLogs(app)}
                      >
                        Günlük
                      </button>
                    )}
                    {usable && (
                      <button
                        type="button"
                        className="revoke"
                        disabled={busy}
                        onClick={() => setRemoving(app)}
                      >
                        Kaldır
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="note">
        Uygulamalar yalnız 127.0.0.1 üzerinde açılır; konteynerler doğrudan yerel ağa açılmaz.
        {!onDevice &&
          ' Bu sayfayı başka bir makineden açtığınız için “Aç” bağlantıları gösterilmiyor:' +
            ' o adres cihazın kendisinde çalışır. Uygulamaya cihaz üzerinden ya da uzak' +
            ' erişimle bağlanın.'}
        {runtime.version !== undefined && ` Çalışma zamanı: podman ${runtime.version}.`}
        {!isAdmin && ' Uygulamaları yönetmek için yönetici olmanız gerekiyor.'}
      </div>

      {/* A second Win rather than a hand-rolled overlay: .ovl is fixed, so it layers above the
          window this screen is already inside, and the shared component brings the Escape stack
          that keeps one keypress from closing both. */}
      {logs !== null && (
        <Win
          title={`${logs.name} · günlük`}
          glyph="📜"
          tone="dim"
          wide
          onClose={() => setLogs(null)}
        >
          {logs.lines.length === 0 ? (
            <Empty glyph="📜" text="Günlük boş." />
          ) : (
            <pre
              className="tree"
              style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {logs.lines.join('\n')}
            </pre>
          )}
        </Win>
      )}

      {removing !== null && (
        <ConfirmBox
          title={`${removing.catalogue.name} kaldırılsın mı?`}
          body="Konteyner silinir. BAĞLANAN PAYLAŞIMLARA VE İÇERİKLERİNE DOKUNULMAZ — fotoğraflarınız, belgeleriniz ve uygulamanın kendi ayarları oldukları yerde kalır."
          yesLabel="Kaldır"
          danger
          onYes={() => void remove(removing)}
          onNo={() => setRemoving(null)}
        />
      )}
    </>
  );
}
