import type { OpenApi } from '@depsis/contracts';
import { useEffect, useState } from 'react';

import { api, API_BASE_URL } from './api.js';
import type { Prefs } from './prefs.js';
import { BACKGROUND_PRESETS } from './sky.js';
import { Empty, Glyph, Win } from './ui.js';

type FileEntry = OpenApi.components['schemas']['FileEntry'];

/** The `background` half of `Preferences`, which the contract marks optional on the whole. */
type BackgroundPref = NonNullable<Prefs['background']>;

type Notify = (kind: 'ok' | 'error', text: string) => void;

/** The galaxy's own swatch. The canvas cannot be shrunk into a 120px tile, so the tile shows the same colours the drawing is made of. */
const SKY_SWATCH = 'radial-gradient(circle at 50% 45%,#3A2E1E,#0A1020 60%,#02040A)';

/**
 * Which files can stand in as a wallpaper.
 *
 * `mimeType` is optional in the contract, so a file that was uploaded before the server learned
 * to sniff types has nothing but its name to go on. Falling back to the extension is a guess, but
 * the alternative — hiding the file — leaves the user staring at a folder they know has pictures
 * in it, and `Sky` steps down to the galaxy if the guess turns out wrong.
 */
const MEDIA_NAME = /\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v)$/i;

function isMedia(entry: FileEntry): boolean {
  const mime = entry.mimeType;
  if (mime !== undefined && mime !== '') {
    return mime.startsWith('image/') || mime.startsWith('video/');
  }
  return MEDIA_NAME.test(entry.name);
}

/** Enter and Space on a `div` that behaves like a button; a row drawn as `.frow` is not one. */
function activate(run: () => void) {
  return (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    run();
  };
}

/* ─── the picker ────────────────────────────────────────────────────────────── */

interface Crumb {
  id: string;
  name: string;
}

/**
 * Choose a wallpaper from the files already on the appliance.
 *
 * Deliberately not an upload field. A NAS whose wallpaper picker has its own private way of
 * putting bytes on the disk has two upload paths to keep working, and the second one always
 * bit-rots: no resumability, no transfer list, no quota check. The file goes in through the file
 * manager like everything else and is chosen here by id.
 */
function FilePicker({
  onPick,
  onClose,
  notify,
}: {
  onPick: (entry: FileEntry) => void;
  onClose: () => void;
  notify: Notify;
}): React.JSX.Element {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  /** How many rows the media filter removed, so an apparently empty folder can explain itself. */
  const [hidden, setHidden] = useState(0);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const parentId = trail.length === 0 ? undefined : trail[trail.length - 1]?.id;

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setFailed(false);
    void (async () => {
      const { data } = await api.GET('/files', {
        params: { query: parentId === undefined ? {} : { parentId } },
      });
      if (cancelled) return;
      if (data === undefined) {
        // Not `setEntries([])`: "Bu klasör boş" would be a statement about a folder that was
        // never read, and here it also implies the user has no pictures to choose from.
        notify('error', 'Klasör okunamadı.');
        setFailed(true);
        setHidden(0);
        return;
      }
      const shown = data.items.filter((item) => item.kind === 'folder' || isMedia(item));
      setHidden(data.items.length - shown.length);
      setEntries(
        [...shown].sort((a, b) => {
          const byKind = Number(a.kind === 'file') - Number(b.kind === 'file');
          return byKind !== 0 ? byKind : a.name.localeCompare(b.name, 'tr');
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId, notify, reloadKey]);

  return (
    <Win title="Arka plan görseli seç" glyph="🖼" tone="cool" onClose={onClose}>
      <div className="addr">
        <div className="nav">
          <button
            type="button"
            onClick={() => setTrail((current) => current.slice(0, -1))}
            disabled={trail.length === 0}
            aria-label="Üst klasör"
          >
            ←
          </button>
        </div>
        <div className="path">
          <button type="button" onClick={() => setTrail([])}>
            Dosyalarım
          </button>
          {trail.map((crumb, index) => (
            <span key={crumb.id}>
              {' / '}
              <button type="button" onClick={() => setTrail((c) => c.slice(0, index + 1))}>
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      </div>

      {failed && (
        <Empty
          glyph="⚠"
          text="Klasör okunamadı."
          action={
            <button type="button" className="b" onClick={() => setReloadKey((key) => key + 1)}>
              Yeniden dene
            </button>
          }
        />
      )}

      {!failed && entries === null && <p className="note">Yükleniyor…</p>}

      {!failed && entries !== null && entries.length === 0 && (
        <Empty
          glyph="🖼"
          text={hidden > 0 ? 'Bu klasörde arka plan olabilecek bir dosya yok.' : 'Bu klasör boş.'}
        />
      )}

      {entries !== null && entries.length > 0 && (
        <div className="flist">
          {entries.map((entry) => {
            const open =
              entry.kind === 'folder'
                ? () => setTrail((current) => [...current, { id: entry.id, name: entry.name }])
                : () => onPick(entry);
            return (
              <div
                key={entry.id}
                className="frow"
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={open}
                onKeyDown={activate(open)}
              >
                <Glyph tone={entry.kind === 'folder' ? 'cool' : 'iris'} size={27}>
                  {entry.kind === 'folder' ? '📁' : '🖼'}
                </Glyph>
                <span className="n">{entry.name}</span>
                {entry.kind === 'folder' && <span className="sz">klasör</span>}
              </div>
            );
          })}
        </div>
      )}

      {hidden > 0 && (
        <div className="note">
          {hidden} dosya gizlendi: arka plan olarak yalnız görsel ve video kullanılabilir.
        </div>
      )}
    </Win>
  );
}

/* ─── the screen ────────────────────────────────────────────────────────────── */

/**
 * The wallpaper picker and the sound switch — everything `PUT /me/preferences` holds that is not
 * the shortcut layout.
 *
 * Nothing here keeps its own copy of the preference. The choice is only ever shown from `prefs`,
 * so a save the server refuses leaves the screen showing what is actually stored rather than what
 * the user clicked; a picker that highlights an option the appliance never accepted is worse than
 * one that appears not to have registered the click.
 */
export function Background({
  prefs,
  save,
  notify,
}: {
  prefs: Prefs;
  save: (next: Prefs) => Promise<boolean>;
  notify: Notify;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  const current = prefs.background;
  const kind = current?.kind ?? 'sky';
  const preset = current?.preset;
  const fileId = current?.fileId;
  const sound = prefs.sound === true;

  async function apply(background: BackgroundPref, label: string): Promise<void> {
    setSaving(true);
    const ok = await save({ ...prefs, background });
    setSaving(false);
    if (!ok) {
      // The endpoint validates the document and answers 422 rather than storing something it
      // cannot serve later — most often a file that has since been trashed, or a folder id.
      notify(
        'error',
        `${label} uygulanamadı: sunucu bu seçimi kabul etmedi. Dosya silinmiş ya da bir klasör olabilir.`,
      );
      return;
    }
    notify('ok', `Arka plan: ${label}`);
  }

  async function toggleSound(): Promise<void> {
    setSaving(true);
    const ok = await save({ ...prefs, sound: !sound });
    setSaving(false);
    if (!ok) {
      notify('error', 'Ses ayarı kaydedilemedi.');
      return;
    }
    notify('ok', sound ? 'Arayüz sesleri kapatıldı.' : 'Arayüz sesleri açıldı.');
  }

  return (
    <>
      <div className="note">
        Arka plan hesabınıza kaydedilir, cihaza değil: aynı DEPSIS'e başka bir kullanıcı girdiğinde
        kendi seçtiği arka planı görür.
      </div>

      <span className="lbl">Hazır arka planlar</span>
      <div className="bgrid">
        <button
          type="button"
          className={kind === 'sky' ? 'bopt on' : 'bopt'}
          disabled={saving}
          aria-pressed={kind === 'sky'}
          onClick={() => void apply({ kind: 'sky' }, 'Galaksi')}
        >
          <span className="pv" style={{ background: SKY_SWATCH }}>
            🌀
          </span>
          <span className="lb">Galaksi</span>
        </button>

        {BACKGROUND_PRESETS.map((option) => {
          const on = kind === 'solid' && preset === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className={on ? 'bopt on' : 'bopt'}
              disabled={saving}
              aria-pressed={on}
              onClick={() => void apply({ kind: 'solid', preset: option.id }, option.label)}
            >
              <span className="pv" style={{ background: option.css }} />
              <span className="lb">{option.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          className={kind === 'file' ? 'bopt on' : 'bopt'}
          disabled={saving}
          aria-pressed={kind === 'file'}
          onClick={() => setPicking(true)}
        >
          <span
            className="pv"
            style={
              // The bytes come from the same authenticated endpoint the file manager downloads
              // through, so the tile is a real preview of the chosen file rather than a stand-in.
              // A video has no still frame here and falls back to the glyph, which is honest:
              // there is no thumbnail service and inventing one for a 120px tile is not worth it.
              kind === 'file' && fileId !== undefined
                ? { backgroundImage: `url(${API_BASE_URL}/files/${fileId}/content)` }
                : { background: 'rgba(255,255,255,0.05)' }
            }
          >
            {kind === 'file' && fileId !== undefined ? '' : '🖼'}
          </span>
          <span className="lb">Kendi görselim…</span>
        </button>
      </div>

      <span className="lbl">Ses</span>
      <div className="netrow">
        <span className="lbl">Arayüz sesleri</span>
        <button
          type="button"
          className={sound ? 'admin on' : 'admin'}
          aria-pressed={sound}
          disabled={saving}
          onClick={() => void toggleSound()}
        >
          {sound ? 'Açık' : 'Kapalı'}
        </button>
      </div>

      {picking && (
        <FilePicker
          notify={notify}
          onClose={() => setPicking(false)}
          onPick={(entry) => {
            setPicking(false);
            void apply({ kind: 'file', fileId: entry.id }, entry.name);
          }}
        />
      )}
    </>
  );
}
