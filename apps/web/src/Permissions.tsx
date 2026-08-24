import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { Win } from './ui.js';

type FolderPermissions = OpenApi.components['schemas']['FolderPermissions'];
type Grant = OpenApi.components['schemas']['Grant'];
type Permission = OpenApi.components['schemas']['FolderPermission'];
type Impact = OpenApi.components['schemas']['PermissionImpact'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/** What a node is: a folder inside a share, or the share's own root. */
export type PermissionTarget =
  { kind: 'entry'; id: string; name: string } | { kind: 'share'; id: string; name: string };

/**
 * §6.2's eleven, in the order the specification lists them, with the words a person uses.
 *
 * Grouped rather than a flat list of eleven checkboxes: the first seven are what somebody DOES
 * with files and the last four are authority over the folder itself. `manage` in particular is
 * the one that delegates — a person who has it can hand out everything else — so it reads
 * differently from `modify` and is placed where that is visible.
 */
const GROUPS: ReadonlyArray<{
  title: string;
  note?: string;
  items: ReadonlyArray<[Permission, string]>;
}> = [
  {
    title: 'Dosyalar',
    items: [
      ['list', 'Listele'],
      ['read', 'Oku'],
      ['download', 'İndir'],
      ['create', 'Yükle ve klasör aç'],
      ['modify', 'Değiştir'],
      ['move', 'Taşı'],
      ['delete', 'Sil'],
    ],
  },
  {
    title: 'Klasörün kendisi',
    note: '`İzin yönet`, sahibine bu listedeki her şeyi başkasına verme hakkı tanır.',
    items: [
      ['share', 'Paylaş'],
      ['manage', 'İzin yönet'],
      ['versions', 'Sürümleri gör'],
      ['audit', 'Denetim kaydını gör'],
    ],
  },
];

interface Principal {
  id: string;
  label: string;
  kind: 'user' | 'team';
}

interface Props {
  target: PermissionTarget;
  notify: Notify;
  onClose: () => void;
  onUnauthenticated: () => void;
}

/**
 * The permissions panel — who may reach this folder, and what a change would cost.
 *
 * WHY IT MATTERS THAT THIS EXISTS AT ALL. Four endpoints have served §6.2 for some time, backed by
 * a grant resolver, a POSIX ACL writer and a privileged agent that puts the answer on disk; an
 * audit found that nothing in the web app ever called any of them. The consequence was not a
 * missing screen, it was a missing product: there was no way to give a second person access to
 * anything. `Shares.tsx` even told the reader to use "the permissions panel", which did not exist.
 *
 * THE DRY RUN IS NOT OPTIONAL DECORATION. §6.2 requires that a permission change show how many
 * folders and people it affects before it is made, and the reason is that inheritance makes the
 * radius impossible to guess: a grant removed here can close folders several levels down for
 * people this screen never named. The preview is fetched on every edit and the save button says
 * what it is about to do.
 */
export function Permissions({
  target,
  notify,
  onClose,
  onUnauthenticated,
}: Props): React.JSX.Element {
  const [view, setView] = useState<FolderPermissions | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Grant[]>([]);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [pricing, setPricing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [people, setPeople] = useState<Principal[]>([]);

  const path = target.kind === 'entry' ? '/files/{id}/permissions' : '/shares/{id}/permissions';

  /* ── who can be named ──
     Users and teams together, because a grant names exactly one of the two and the person writing
     it thinks in terms of "who", not "which table". */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [users, teams] = await Promise.all([api.GET('/users', {}), api.GET('/teams', {})]);
      if (!alive) return;
      const list: Principal[] = [];
      for (const team of teams.data?.items ?? []) {
        list.push({ id: team.id, label: `${team.name} (ekip)`, kind: 'team' });
      }
      for (const user of users.data?.items ?? []) {
        list.push({ id: user.id, label: user.username, kind: 'user' });
      }
      setPeople(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    const { data, response } = await api.GET(path, { params: { path: { id: target.id } } });
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (data === undefined) {
      setFailed(true);
      return;
    }
    setView(data);
    setDraft(data.grants.map((g) => ({ ...g, permissions: [...g.permissions] })));
    setImpact(null);
  }, [path, target.id, onUnauthenticated]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ── the preview ──
     Debounced, because every checkbox is an edit and the dry run walks the subtree. 400ms is long
     enough that ticking four boxes costs one request and short enough that the number is on screen
     before a hand reaches the save button. */
  useEffect(() => {
    if (view === null || !view.canManage) return undefined;
    const timer = setTimeout(() => {
      void (async () => {
        setPricing(true);
        const { data } = await api.PUT(path, {
          params: { path: { id: target.id }, query: { dryRun: true } },
          body: { grants: draft },
        });
        setPricing(false);
        setImpact(data?.impact ?? null);
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, path, target.id, view]);

  function toggle(index: number, permission: Permission): void {
    setDraft((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        const has = row.permissions.includes(permission);
        return {
          ...row,
          permissions: has
            ? row.permissions.filter((p) => p !== permission)
            : [...row.permissions, permission],
        };
      }),
    );
  }

  function addPrincipal(id: string): void {
    const who = people.find((p) => p.id === id);
    if (who === undefined) return;
    setDraft((rows) => [
      ...rows,
      {
        userId: who.kind === 'user' ? who.id : null,
        teamId: who.kind === 'team' ? who.id : null,
        displayName: who.label,
        // `list` alone, deliberately: a new row that granted everything would make the safe
        // default the widest one, and the person adding it has to choose what to open.
        permissions: ['list'],
      },
    ]);
  }

  async function save(): Promise<void> {
    setSaving(true);
    const { data, error, response } = await api.PUT(path, {
      params: { path: { id: target.id } },
      body: { grants: draft },
    });
    setSaving(false);
    if (response.status === 401) {
      onUnauthenticated();
      return;
    }
    if (data === undefined) {
      notify('error', problemMessage(error, 'İzinler kaydedilemedi.'));
      return;
    }
    // `applyingJobId` null means the grants are stored and the filesystem has NOT been told. Saying
    // only "kaydedildi" would let somebody believe a folder is closed over SMB when it is not —
    // the two-realities failure §6.2 forbids by name.
    notify(
      'ok',
      data.applyingJobId === null
        ? 'İzinler kaydedildi. Dosya sistemine henüz yazılamadı — ajana ulaşılamıyor.'
        : 'İzinler kaydedildi ve dosya sistemine uygulanıyor.',
    );
    await load();
  }

  const labelFor = (grant: Grant): string => {
    if (grant.displayName !== undefined && grant.displayName !== '') return grant.displayName;
    const id = grant.userId ?? grant.teamId ?? '';
    return people.find((p) => p.id === id)?.label ?? id.slice(0, 8);
  };

  const taken = new Set(draft.map((g) => g.userId ?? g.teamId ?? ''));
  const dirty = JSON.stringify(draft) !== JSON.stringify(view?.grants ?? []);

  return (
    <Win title={`İzinler — ${target.name}`} glyph="🔑" tone="iris" wide onClose={onClose}>
      {failed && <p className="note">İzinler okunamadı.</p>}
      {view === null && !failed && <p className="note">Yükleniyor…</p>}

      {view !== null && (
        <>
          <div className="netrow">
            <span className="lbl">Sizin izniniz</span>
            <span className="val">
              {view.effective.length > 0 ? view.effective.join(', ') : 'yok'}
            </span>
            {view.inheritedFrom !== null && view.inheritedFrom !== undefined && (
              <span className="st2 dn">üst klasörden</span>
            )}
          </div>

          {!view.canManage ? (
            // Empty rather than read-only rows: the API returns no grants without `manage`, because
            // who else can reach a folder is itself information. Showing an empty table would read
            // as "nobody has access".
            <p className="note">
              Bu klasörün izinlerini yönetme yetkiniz yok, o yüzden kimlerin eriştiği de
              gösterilmiyor — kimin nereye erişebildiği kendi başına bir bilgi.
            </p>
          ) : (
            <>
              {draft.length === 0 && (
                <p className="note">
                  Bu düğümde açık izin yok. Üst klasörden miras alınıyorsa orada duruyor; buraya bir
                  satır eklemek mirası bu klasör için değiştirir.
                </p>
              )}

              {draft.map((grant, index) => (
                <div className="urow" key={`${grant.userId ?? ''}${grant.teamId ?? ''}`}>
                  <span className="i">
                    <b>{labelFor(grant)}</b>
                    <span>
                      {grant.teamId !== null && grant.teamId !== undefined ? 'ekip' : 'kişi'}
                    </span>
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', flex: 1 }}>
                    {GROUPS.flatMap((group) => group.items).map(([permission, label]) => (
                      <label key={permission} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        <input
                          type="checkbox"
                          checked={grant.permissions.includes(permission)}
                          onChange={() => toggle(index, permission)}
                        />{' '}
                        {label}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="b"
                    onClick={() => setDraft((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Kaldır
                  </button>
                </div>
              ))}

              <div className="netrow">
                <span className="lbl">Ekle</span>
                <select
                  className="b"
                  value=""
                  aria-label="Kime izin verilecek"
                  onChange={(event) => {
                    addPrincipal(event.target.value);
                    event.target.value = '';
                  }}
                >
                  <option value="">Kişi ya da ekip seç…</option>
                  {people
                    .filter((p) => !taken.has(p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </div>

              {/* §6.2: "Her izin değişimi dry-run ile etkilenecek kullanıcı/klasör sayısını
                  göstermeli." The radius is impossible to guess — inheritance means a row removed
                  here can close folders several levels down for people this screen never named. */}
              <div className="notice" role="status">
                <span className="ic" aria-hidden>
                  ⤳
                </span>
                <span className="tx">
                  <b>Bu değişiklik ne yapar</b>
                  {pricing && 'hesaplanıyor…'}
                  {!pricing && impact === null && 'Bir şey değiştirin, önizleme burada çıkar.'}
                  {!pricing && impact !== null && (
                    <>
                      {impact.foldersAffected} klasör etkilenir.{' '}
                      {impact.usersGaining.length > 0 && (
                        <>
                          Erişim kazanan: {impact.usersGaining.map((u) => u.username).join(', ')}
                          .{' '}
                        </>
                      )}
                      {impact.usersLosing.length > 0 && (
                        <>Erişimi kalkan: {impact.usersLosing.map((u) => u.username).join(', ')}.</>
                      )}
                      {impact.usersGaining.length === 0 && impact.usersLosing.length === 0 && (
                        <>Kimsenin erişimi değişmiyor.</>
                      )}
                    </>
                  )}
                </span>
              </div>

              <div className="row">
                <button type="button" className="no" onClick={onClose}>
                  Kapat
                </button>
                <button
                  type="submit"
                  className="yes"
                  disabled={!dirty || saving}
                  onClick={() => void save()}
                >
                  {saving ? 'Kaydediliyor…' : 'Kaydet'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Win>
  );
}
