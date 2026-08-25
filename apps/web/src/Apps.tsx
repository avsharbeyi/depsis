import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { ConfirmBox, Empty, Glyph, Win } from './ui.js';
import type { Tone } from './ui.js';

type AppPage = OpenApi.components['schemas']['AppPage'];
type AppRow = OpenApi.components['schemas']['App'];
type Share = OpenApi.components['schemas']['Share'];
type Mount = OpenApi.components['schemas']['AppCatalogueEntry']['mounts'][number];

/**
 * `docker.io/nextcloud:31.0.5-apache` for a single container, `4 konteyner` for a stack.
 *
 * An application made of four images has no one image to print, and printing the primary's alone
 * would say "Immich is immich-server" — which is exactly the wrong thing to believe about it, and
 * the belief migration 0031 exists to correct. The count is the honest short answer; the list
 * below it is the long one.
 */
function imageLabel(cat: OpenApi.components['schemas']['AppCatalogueEntry']): string {
  const primary = cat.containers.find((container) => container.primary) ?? cat.containers[0];
  if (primary === undefined) return '';
  if (cat.containers.length === 1) return `${primary.image}:${primary.tag}`;
  return `${cat.containers.length} konteyner · ${primary.image}:${primary.tag}`;
}

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

/** `ro`/`rw` in words. The reader is handing over a folder and has to know which way it opens. */
function modeLabel(mode: Mount['mode']): string {
  return mode === 'ro' ? 'salt okunur' : 'okuma ve yazma';
}

/**
 * The install dialog — GET /shares to fill the pickers, POST /apps/{slug} to commit.
 *
 * Every catalogue mount target needs a share id, and the contract takes an ID rather than a path
 * on purpose: a path typed here would be a path the user chose to bind, which is the whole thing
 * the curated catalogue exists to prevent. So the picker is the only way in, and until every
 * target has one there is nothing to send.
 */
function InstallWin({
  app,
  notify,
  onClose,
  onInstalled,
}: {
  app: AppRow;
  notify: Notify;
  onClose: () => void;
  onInstalled: () => void;
}): React.JSX.Element {
  const cat = app.catalogue;
  const [shares, setShares] = useState<Share[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data } = await api.GET('/shares', {});
      if (!alive) return;
      if (data === undefined) {
        setFailed(true);
        return;
      }
      setShares(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  /**
   * The chosen share for every target, or null while one is still missing.
   *
   * Resolved against the freshly listed shares rather than trusting the stored id, so a selection
   * left over from before a refresh — a share deleted in another tab — falls back to unchosen
   * instead of being posted and coming back 404.
   */
  function resolve(): { mount: Mount; share: Share }[] | null {
    if (shares === null) return null;
    const pairs: { mount: Mount; share: Share }[] = [];
    for (const mount of cat.mounts) {
      const share = shares.find((item) => item.id === picked[mount.target]);
      if (share === undefined) return null;
      pairs.push({ mount, share });
    }
    return pairs;
  }

  const chosen = resolve();

  async function install(pairs: { mount: Mount; share: Share }[]): Promise<void> {
    setConfirming(false);
    setPulling(true);
    const { error, response } = await api.POST('/apps/{slug}', {
      params: { path: { slug: cat.slug } },
      body: {
        mounts: pairs.map(({ mount, share }) => ({ target: mount.target, shareId: share.id })),
      },
    });
    setPulling(false);
    if (response.ok) {
      notify('ok', `${cat.name} kuruldu.`);
      onInstalled();
      return;
    }
    if (response.status === 409) {
      // Usually installed by someone else while this window was open, so the grid behind is stale
      // and refreshing it beats leaving a form for a thing that already exists. Usually, not
      // always: podman's own 409 — a leftover container holding the name — arrives as this code
      // too, and "zaten kurulu" then contradicts the grid it just refreshed. The server's sentence
      // wins where there is one; the common case stays the fallback.
      notify('error', problemMessage(error, `${cat.name} zaten kurulu.`));
      onInstalled();
      return;
    }
    if (response.status === 404) {
      notify('error', 'Seçilen paylaşım artık yok. Liste tazelendi, yeniden seçin.');
      setPicked({});
      setReloadKey((key) => key + 1);
      return;
    }
    if (response.status === 422) {
      // The targets in the body are copied out of this very catalogue row, so a mismatch is a bug
      // on this screen — nothing the reader can fix by choosing differently, and the raw sentence
      // would only send them looking for a setting that does not exist.
      console.error('POST /apps/%s reddedildi (422):', cat.slug, error);
      notify('error', `${cat.name} kurulamıyor.`);
      return;
    }
    // 503 is two different deployments wearing one code: no container runtime at all, and a ROOT
    // podman socket that ADR-0019 refuses to run images through. Only the server's own sentence
    // separates them, so it is shown instead of a house message.
    notify('error', problemMessage(error, 'Uygulama kurulamadı.'));
  }

  const empty = shares !== null && shares.length === 0 && cat.mounts.length > 0;

  return (
    <>
      <Win
        title={`${cat.name} kur`}
        glyph={cat.icon}
        tone={toneFor(cat.slug)}
        // Closing mid-pull would leave the image downloading with nothing on screen saying so.
        onClose={() => {
          if (!pulling) onClose();
        }}
      >
        {failed ? (
          <Empty
            glyph="⚠"
            text="Paylaşımlar okunamadı."
            action={
              <button type="button" className="b" onClick={() => setReloadKey((key) => key + 1)}>
                Yeniden dene
              </button>
            }
          />
        ) : shares === null ? (
          <p className="note">Paylaşımlar okunuyor…</p>
        ) : empty ? (
          <>
            <Empty glyph="🗂" text="Henüz hiç paylaşım yok." />
            <div className="note">
              {cat.name} bir klasöre ihtiyaç duyuyor ve o klasörü bir paylaşımdan alıyor. Önce bir
              paylaşım oluşturulmalı; sonra bu pencereden hangi paylaşımın uygulamaya verileceğini
              seçebilirsiniz.
            </div>
          </>
        ) : (
          <>
            {pulling && (
              <div className="notice">
                <span className="ic" aria-hidden>
                  ⏳
                </span>
                <span className="tx">
                  <b>
                    {cat.containers.length > 1
                      ? `${cat.containers.length} imaj indiriliyor, bu birkaç dakika sürebilir.`
                      : 'İmaj indiriliyor, bu birkaç dakika sürebilir.'}
                  </b>
                  {cat.containers
                    .map((container) => `${container.image}:${container.tag}`)
                    .join(', ')}{' '}
                  indirilip konteyner oluşturuluyor. Pencereyi kapatmayın.
                </span>
              </div>
            )}

            {/* `.note` rather than the card's `.m`: that rule is scoped to `.app`, and a class the
                sheet does not draw here would be a class with nothing behind it. */}
            <div className="note">{cat.summary}</div>

            {cat.mounts.length === 0 ? (
              <div className="note">
                Bu uygulamanın bağlanacak bir klasörü yok; hiçbir paylaşımınıza erişmez.
              </div>
            ) : (
              <>
                <div className="lbl">Uygulamaya verilecek paylaşımlar</div>
                {cat.mounts.map((mount) => {
                  const share = shares.find((item) => item.id === picked[mount.target]);
                  return (
                    <label key={mount.target}>
                      {mount.purpose}
                      <small>
                        <span className="val">{mount.target}</span> · {modeLabel(mount.mode)}
                      </small>
                      <select
                        value={picked[mount.target] ?? ''}
                        disabled={pulling}
                        onChange={(event) => {
                          const value = event.target.value;
                          setPicked((prev) => ({ ...prev, [mount.target]: value }));
                        }}
                      >
                        <option value="">Paylaşım seçin…</option>
                        {shares.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      {/* A read-only share behind a target the image expects to write to does not
                          fail at install time — it fails later, inside the container, as an app
                          that cannot save anything. Said here, while it is still one click away
                          from being a different choice. */}
                      {mount.mode === 'rw' && share !== undefined && share.readOnly && (
                        <div className="note">
                          “{share.name}” salt okunur bir paylaşım; {cat.name} buraya yazamayacak.
                        </div>
                      )}
                    </label>
                  );
                })}
              </>
            )}

            <div className="note">
              Uygulama yalnız seçtiğiniz paylaşımların içeriğini görür; cihazın geri kalanına
              erişemez. Kaldırıldığında da bu paylaşımlara dokunulmaz.
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="b pri"
                style={{ flex: 1 }}
                disabled={chosen === null || pulling}
                onClick={() => setConfirming(true)}
              >
                {pulling ? 'Kuruluyor…' : 'Kur'}
              </button>
              <button type="button" className="b" disabled={pulling} onClick={onClose}>
                Vazgeç
              </button>
            </div>

            {chosen === null && !pulling && (
              <div className="note">Her hedef için bir paylaşım seçilmeden kurulum başlamaz.</div>
            )}
          </>
        )}
      </Win>

      {confirming && chosen !== null && (
        <ConfirmBox
          title={`${cat.name} kurulsun mu?`}
          body={
            cat.containers.length > 1
              ? `${cat.name} ${cat.containers.length} konteynerden oluşuyor (${cat.containers
                  .map((container) => container.role)
                  .join(
                    ', ',
                  )}); hepsi indirilecek. Bu uygulama, aşağıdaki paylaşımların içeriğini görecek:`
              : `${imageLabel(cat)} indirilecek ve bir konteyner oluşturulacak. Bu uygulama, aşağıdaki paylaşımların içeriğini görecek:`
          }
          list={chosen.map(
            ({ mount, share }) => `${share.name} → ${mount.target} (${modeLabel(mount.mode)})`,
          )}
          yesLabel="Kur"
          onYes={() => void install(chosen)}
          onNo={() => setConfirming(false)}
        />
      )}
    </>
  );
}

interface Props {
  notify: Notify;
  isAdmin: boolean;
  onUnauthenticated: () => void;
}

/**
 * The application catalogue — GET /apps, POST/PATCH/DELETE /apps/{slug}, GET /apps/{slug}/logs.
 *
 * `GET /apps` always answers 200, even with no container runtime on the box, because the catalogue
 * lives in the database and listing it needs nothing from podman. That is why this screen can draw
 * a full grid and merely disable it, instead of showing an error page where a product should be.
 */
export function Apps({ notify, isAdmin, onUnauthenticated }: Props): React.JSX.Element {
  const [page, setPage] = useState<AppPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppRow | null>(null);
  const [installing, setInstalling] = useState<AppRow | null>(null);
  const [logs, setLogs] = useState<{ name: string; lines: string[] } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data, response } = await api.GET('/apps', {});
      if (!alive) return;
      // An expired session is not a failed read. Without this the pane offered "Yeniden dene" for
      // a request that can only ever answer 401 again, on a desk that no longer has a session.
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
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
  }, [reloadKey, notify, onUnauthenticated]);

  async function setState(app: AppRow, state: 'running' | 'stopped'): Promise<void> {
    setBusySlug(app.catalogue.slug);
    const { error, response } = await api.PATCH('/apps/{slug}', {
      params: { path: { slug: app.catalogue.slug } },
      body: { state },
    });
    setBusySlug(null);
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (response.status === 503) {
      // Two different 503s wear the same code here. Starting a container through a ROOT podman
      // socket is refused on policy (ADR-0019) after podman answered perfectly well, so sending
      // the operator to look for a dead daemon sends them to look for something that is running.
      // Only for a start: the server deliberately leaves stopping allowed on a rootful socket, so
      // a 503 on the way down really is a runtime nobody can reach.
      notify(
        'error',
        state === 'running' && page?.runtime.rootless === false
          ? 'Podman köksüz çalışmadığı için DEPSIS bu konteyneri başlatmıyor.'
          : 'Konteyner çalışma zamanı yanıt vermiyor.',
      );
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
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    // Removal stays allowed on a rootful socket, so unlike a start, a 503 here is what it says.
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
  /**
   * Whether this box can run a container at all, gated the same way the server gates it.
   *
   * `rootless === false` used to be drawn as a warning and nothing else, so "Kur" stayed live: the
   * admin picked shares, confirmed, waited out the image pull, and got the server's untranslated
   * ADR-0019 sentence about environment variables in the middle of a Turkish screen. A button that
   * cannot succeed is worse than a disabled one, because it costs the pull to find out.
   *
   * `!== false` and not `=== true`: the field is optional in the contract, and an absent one means
   * podman was not asked, not that it is rootful.
   */
  const canRun = runtime.available && runtime.rootless !== false;
  /** Kurmak ve başlatmak. */
  const usable = canRun && isAdmin;
  /** Durdurmak, kaldırmak, günlüğe bakmak. Deliberately NOT gated on `canRun`: the server keeps
   *  stop and remove allowed through a rootful socket, and a box whose containers can only be
   *  started is a box nobody can get back out of. */
  const manageable = runtime.available && isAdmin;
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
            podman&apos;ı paketlemez; dağıtımın kendi paketinden, ADR-0019&apos;un istediği gibi
            KÖKSÜZ ve kendi kullanıcısıyla kurulur — sistem soketi (systemctl enable podman.socket)
            root podman&apos;ı açar, ki bu aşağıdaki uyarının reddettiği durumun ta kendisidir:
            <span
              className="val"
              style={{ display: 'block', marginTop: 4, whiteSpace: 'pre-line' }}
            >
              {'sudo apt install podman\n' +
                'sudo useradd -r -m depsis-apps\n' +
                'sudo loginctl enable-linger depsis-apps\n' +
                'sudo -u depsis-apps XDG_RUNTIME_DIR=/run/user/$(id -u depsis-apps) \\\n' +
                '  systemctl --user enable --now podman.socket'}
            </span>
            Ardından DEPSIS&apos;e o soketi gösterin —{' '}
            <b>DEPSIS_PODMAN_SOCKET=/run/user/&lt;uid&gt;/podman/podman.sock</b> — ve API servisini
            yeniden başlatın.
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
            uzanabilir. Bu yüzden kurma ve başlatma kapalı; durdurma, kaldırma ve günlük açık
            kalıyor. Açmak için <b>DEPSIS_PODMAN_SOCKET</b>&apos;i köksüz bir podman soketine
            yöneltin.
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
                <div className="val">{imageLabel(cat)}</div>

                {!app.installed && (
                  <>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* Visible even when it cannot be pressed: a missing button reads as "this
                          appliance cannot install apps", which is a different and wrong claim. */}
                      <button
                        type="button"
                        className="b pri"
                        style={{ flex: 1 }}
                        disabled={!usable || busy}
                        onClick={() => setInstalling(app)}
                      >
                        Kur
                      </button>
                    </div>
                    {/* Why it is disabled, in text on the card. It used to live in a `title`, which
                        is invisible on a touch screen — and a touch screen is most of how a NAS
                        actually gets administered. */}
                    {!usable && (
                      <div className="note">
                        {!runtime.available
                          ? 'Konteyner çalışma zamanı kurulu değil.'
                          : runtime.rootless === false
                            ? 'Podman köksüz çalışmadığı için DEPSIS uygulama kuramıyor.'
                            : 'Uygulama kurmak için yönetici olmanız gerekiyor.'}
                      </div>
                    )}
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
                    {manageable && (
                      <button
                        type="button"
                        className={running ? 'tg stop' : 'tg start'}
                        style={{ flex: 1 }}
                        // Starting is what ADR-0019 refuses on a rootful socket; stopping is not.
                        disabled={busy || (!running && !canRun)}
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
                    {manageable && (
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

      {/* Keyed by slug so switching cards cannot carry one app's picks into another's form. */}
      {installing !== null && (
        <InstallWin
          key={installing.catalogue.slug}
          app={installing}
          notify={notify}
          onClose={() => setInstalling(null)}
          onInstalled={() => {
            setInstalling(null);
            reload();
          }}
        />
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
