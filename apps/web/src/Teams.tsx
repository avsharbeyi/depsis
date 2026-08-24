import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState } from 'react';

import { api, problemMessage } from './api.js';
import { ConfirmBox, Empty, PromptBox, Win } from './ui.js';

type Team = OpenApi.components['schemas']['Team'];
type TeamMember = OpenApi.components['schemas']['TeamMember'];
type User = OpenApi.components['schemas']['User'];
type Impact = OpenApi.components['schemas']['PermissionImpact'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

interface Props {
  notify: Notify;
  isAdmin: boolean;
  onUnauthenticated: () => void;
}

/**
 * Teams — §6.1's layer between the organisation and a person.
 *
 * WHY IT WAS MISSING AND WHY THAT MATTERED. Eight operations over four paths have been served for
 * some time, backed by a table, a device-wide POSIX gid allocator and a 535-line integration
 * suite; nothing in the web app called any of them. That is not a cosmetic gap: ADR-0004 gives
 * filesystem ACL entries to GROUPS rather than to people, because POSIX ACLs become unwieldy past
 * roughly thirty entries — so a team is how access scales past a handful of users, and without
 * this screen the only grantable principals were individuals.
 *
 * `posixGid` is shown when it is missing, not hidden. A team with no gid cannot be written into an
 * ACL at all: the permission is real in the database and invisible over SMB. The contract's own
 * words for that field are that the interface has to say so, because the alternative is the two
 * realities the whole permission model exists to prevent.
 */
export function Teams({ notify, isAdmin, onUnauthenticated }: Props): React.JSX.Element {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [naming, setNaming] = useState<{ mode: 'create' } | { mode: 'rename'; team: Team } | null>(
    null,
  );
  const [open, setOpen] = useState<Team | null>(null);
  const [removing, setRemoving] = useState<{ team: Team; impact: Impact | null } | null>(null);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      const { data, response } = await api.GET('/teams', {});
      if (!alive) return;
      if (response.status === 401) {
        onUnauthenticated();
        return;
      }
      if (data === undefined) {
        setFailed(true);
        return;
      }
      setTeams(data.items);
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, onUnauthenticated]);

  async function create(name: string): Promise<void> {
    const { data, error } = await api.POST('/teams', { body: { name } });
    setNaming(null);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Ekip açılamadı.'));
      return;
    }
    notify('ok', `${data.name} açıldı.`);
    reload();
  }

  async function rename(team: Team, name: string): Promise<void> {
    const { data, error } = await api.PATCH('/teams/{id}', {
      params: { path: { id: team.id } },
      body: { name },
    });
    setNaming(null);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Ad değiştirilemedi.'));
      return;
    }
    reload();
  }

  /**
   * Price the deletion before doing it.
   *
   * Deleting a team is a bulk revocation: `folder_grants.team_id` is `ON DELETE CASCADE`, so every
   * grant naming it disappears from every folder at once. The dry run is the only place a person
   * can see how many that is before it happens — and the API refuses outright if it would leave a
   * share with no rule at all, which is a refusal worth reading rather than a 500.
   */
  async function priceRemoval(team: Team): Promise<void> {
    const { data } = await api.DELETE('/teams/{id}', {
      params: { path: { id: team.id }, query: { dryRun: true } },
    });
    setRemoving({ team, impact: data ?? null });
  }

  async function remove(team: Team): Promise<void> {
    const { error, response } = await api.DELETE('/teams/{id}', {
      params: { path: { id: team.id } },
    });
    setRemoving(null);
    if (response.status >= 400) {
      notify('error', problemMessage(error, 'Ekip silinemedi.'));
      return;
    }
    notify('ok', `${team.name} silindi.`);
    reload();
  }

  if (failed) {
    return (
      <Empty
        glyph="⚠"
        text="Ekipler okunamadı."
        action={
          <button type="button" className="b" onClick={reload}>
            Yeniden dene
          </button>
        }
      />
    );
  }
  if (teams === null) return <p className="note">Yükleniyor…</p>;

  return (
    <>
      <div className="netrow">
        <span className="lbl">Ekipler</span>
        <span className="val">{teams.length}</span>
        {isAdmin && (
          <button type="button" className="b" onClick={() => setNaming({ mode: 'create' })}>
            Yeni ekip
          </button>
        )}
      </div>

      {teams.length === 0 ? (
        <Empty
          glyph="👥"
          text="Hiç ekip yok."
          action={
            isAdmin ? (
              <button type="button" className="b" onClick={() => setNaming({ mode: 'create' })}>
                Ekip aç
              </button>
            ) : undefined
          }
        />
      ) : (
        <div>
          {teams.map((team) => (
            <div className="urow" key={team.id}>
              <span
                className="av"
                style={{ background: 'rgba(143,166,255,.24)', color: 'var(--iris)' }}
                aria-hidden
              >
                👥
              </span>
              <span className="i">
                <b>{team.name}</b>
                <span>{team.memberCount} üye</span>
              </span>
              {/* A team with no gid cannot become an ACL entry, so a grant to it is real on the
                  web and absent over SMB. The contract asks the interface to say this out loud. */}
              {team.posixGid === null ? (
                <span
                  className="st2"
                  style={{ background: 'rgba(245,185,68,.16)', color: 'var(--warn)' }}
                >
                  dosya sistemine yansımadı
                </span>
              ) : (
                <span className="st2 dn" style={{ fontFamily: 'var(--mono)' }}>
                  gid {team.posixGid}
                </span>
              )}
              <button type="button" className="b" onClick={() => setOpen(team)}>
                Üyeler
              </button>
              {isAdmin && (
                <>
                  <button
                    type="button"
                    className="b"
                    onClick={() => setNaming({ mode: 'rename', team })}
                  >
                    Adını değiştir
                  </button>
                  <button type="button" className="b" onClick={() => void priceRemoval(team)}>
                    Sil
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {naming?.mode === 'create' && (
        <PromptBox
          title="Yeni ekip"
          label="Ekip adı"
          confirmLabel="Aç"
          onSubmit={(value) => void create(value)}
          onCancel={() => setNaming(null)}
        />
      )}
      {naming?.mode === 'rename' && (
        <PromptBox
          title="Ekibin adı"
          label="Yeni ad"
          initial={naming.team.name}
          confirmLabel="Değiştir"
          onSubmit={(value) => void rename(naming.team, value)}
          onCancel={() => setNaming(null)}
        />
      )}

      {removing !== null && (
        <ConfirmBox
          title="Ekibi sil"
          danger
          body={
            removing.impact === null
              ? `${removing.team.name} silinecek. Bu ekibe verilmiş her izin, her klasörde birden kalkar.`
              : `${removing.team.name} silinecek. Bu ekibe verilmiş izinler ${removing.impact.foldersAffected} klasörde birden kalkar` +
                (removing.impact.usersLosing.length > 0
                  ? `; erişimi kalkanlar: ${removing.impact.usersLosing.map((u) => u.username).join(', ')}.`
                  : '.')
          }
          yesLabel="Sil"
          onYes={() => void remove(removing.team)}
          onNo={() => setRemoving(null)}
        />
      )}

      {open !== null && (
        <Members
          team={open}
          isAdmin={isAdmin}
          notify={notify}
          onClose={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * One team's membership.
 *
 * A separate overlay rather than an expanding row: the member list is its own request and its own
 * mutations, and putting it inline would make the teams list re-render on every membership edit.
 */
function Members({
  team,
  isAdmin,
  notify,
  onClose,
}: {
  team: Team;
  isAdmin: boolean;
  notify: Notify;
  onClose: () => void;
}): React.JSX.Element {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, all] = await Promise.all([
      api.GET('/teams/{id}/members', { params: { path: { id: team.id } } }),
      api.GET('/users', {}),
    ]);
    setMembers(list.data?.items ?? []);
    setUsers(all.data?.items ?? []);
  }, [team.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(userId: string): Promise<void> {
    setBusy(true);
    const { error, response } = await api.PUT('/teams/{id}/members', {
      params: { path: { id: team.id } },
      body: { userId, teamAdmin: false },
    });
    setBusy(false);
    if (response.status >= 400) {
      notify('error', problemMessage(error, 'Üye eklenemedi.'));
      return;
    }
    await load();
  }

  async function drop(member: TeamMember): Promise<void> {
    setBusy(true);
    const { error, response } = await api.DELETE('/teams/{id}/members/{userId}', {
      params: { path: { id: team.id, userId: member.userId } },
    });
    setBusy(false);
    if (response.status >= 400) {
      notify('error', problemMessage(error, 'Üye çıkarılamadı.'));
      return;
    }
    // Removing somebody from a team withdraws every permission the team carried, everywhere in the
    // tree. Saying so is the only warning there is — there is no undo and no other screen reports
    // it.
    notify('ok', `${member.username} çıkarıldı; ekibin izinleri artık onu kapsamıyor.`);
    await load();
  }

  const inTeam = new Set((members ?? []).map((m) => m.userId));

  return (
    <Win title={`${team.name} — üyeler`} glyph="👥" tone="iris" onClose={onClose}>
      {members === null && <p className="note">Yükleniyor…</p>}
      {members !== null && members.length === 0 && (
        <p className="note">Bu ekipte kimse yok. Ekibe verilen izinler şu an kimseye ulaşmıyor.</p>
      )}
      {(members ?? []).map((member) => (
        <div className="urow" key={member.userId}>
          <span className="i">
            <b>{member.username}</b>
            <span>{member.teamAdmin ? 'ekip yöneticisi' : 'üye'}</span>
          </span>
          {isAdmin && (
            <button type="button" className="b" disabled={busy} onClick={() => void drop(member)}>
              Çıkar
            </button>
          )}
        </div>
      ))}

      {isAdmin && (
        <div className="netrow">
          <span className="lbl">Ekle</span>
          <select
            className="b"
            value=""
            aria-label="Ekibe eklenecek kişi"
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              event.target.value = '';
              if (id !== '') void add(id);
            }}
          >
            <option value="">Kişi seç…</option>
            {users
              .filter((user) => !inTeam.has(user.id))
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.username}
                </option>
              ))}
          </select>
        </div>
      )}
    </Win>
  );
}
