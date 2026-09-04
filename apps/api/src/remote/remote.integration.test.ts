import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  type AgentRequest,
  type AgentResponse,
} from '../agent/agent.service.js';
import { ServiceUnavailableException } from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { AuditService } from '../audit/audit.service.js';
import { DbService } from '../db/db.service.js';
import { RemoteController } from './remote.controller.js';
import {
  NETWORK_ID,
  NetworkAlreadyJoinedError,
  NetworkNotJoinedError,
  RemoteService,
  RemoteUnavailableError,
  type RemoteStatus,
} from './remote.service.js';

/**
 * Remote access against a real PostgreSQL, with a fake agent — and one block against a real one.
 *
 * The split follows what each half can actually settle. Whether `zerotier_join` reaches a daemon is
 * measured on the Rust side and by `tools/poc/p1-g-remote.sh`; a fake cannot add anything to it.
 * What only a real database can settle is everything this suite is about: that the partial index
 * turns a repeated join into a 409 rather than a second row, that a refused join leaves NOTHING
 * behind, that leaving closes a row instead of deleting it, and that RLS keeps one organisation's
 * networks — and its labels — out of another's answer.
 *
 * The JOIN path is deliberately never exercised against the real daemon. Joining a network is the
 * device owner's decision and a test has no business making it (ADR-0020). The READ path is, when
 * a live agent socket is there to read through.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` and `DEPSIS_TEST_OWNER_DATABASE_URL` point at a
 * migrated database; the real-daemon block additionally requires `DEPSIS_AGENT_SOCKET`.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const OWNER_URL = process.env['DEPSIS_TEST_OWNER_DATABASE_URL'];
const AGENT_SOCKET = process.env['DEPSIS_AGENT_SOCKET'];

const runnable =
  APP_URL !== undefined && APP_URL !== '' && OWNER_URL !== undefined && OWNER_URL !== '';
const describeDb = runnable ? describe : describe.skip;

/**
 * The read path needs BOTH a database and a live agent. Stated as one condition rather than nested
 * skips so that the reason a block did not run is one line in the file.
 */
const describeDaemon =
  runnable && AGENT_SOCKET !== undefined && AGENT_SOCKET !== '' ? describe : describe.skip;

/** Two real-shaped ids. Sixteen lowercase hex digits, which is the only shape that gets past zod. */
const NET_OK = '8056c2e21c000001';
const NET_PENDING = '8056c2e21c000002';
const NET_OTHER = '8056c2e21c000003';

type AgentNetwork = Extract<AgentResponse, { status: 'zerotier_networks' }>['networks'][number];

function network(id: string, status: AgentNetwork['status'], addresses: string[]): AgentNetwork {
  return { network_id: id, name: null, status, addresses };
}

type AgentMember = Extract<
  AgentResponse,
  { status: 'zerotier_controller_members' }
>['members'][number];

/** Controller'ın gördüğü bir üye: adressiz, çünkü buradaki soru yetki, cihazın adı değil. */
function controllerMember(memberId: string, authorized: boolean): AgentMember {
  return {
    member_id: memberId,
    authorized,
    label: '',
    addresses: [],
    seen: true,
    is_this_appliance: false,
  };
}

interface RecordedCall {
  request: AgentRequest;
  reason: string;
  correlationId: string;
}

/**
 * An agent that answers whatever the test tells it to.
 *
 * Not a socket. `agent.service.test.ts` measures the wire and `agent.integration.test.ts` measures
 * the two halves of the trust boundary against each other; what is left here is what this service
 * DECIDES with the answers, and a socket adds nothing to that.
 */
function stubAgent(respond: (request: AgentRequest) => Promise<AgentResponse>): {
  agent: AgentService;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const agent = {
    call: (request: AgentRequest, reason: string, correlationId: string) => {
      calls.push({ request, reason, correlationId });
      return respond(request);
    },
  } as unknown as AgentService;
  return { agent, calls };
}

/** The healthy daemon: one authorized network, one still waiting for a tick-box, one unrelated. */
function healthyDaemon(): (request: AgentRequest) => Promise<AgentResponse> {
  return (request) => {
    switch (request.op) {
      case 'zerotier_status':
        return Promise.resolve<AgentResponse>({
          status: 'zerotier_status',
          node_id: 'ef780bec87',
          online: true,
          version: '1.16.2',
        });
      case 'zerotier_networks':
        return Promise.resolve<AgentResponse>({
          status: 'zerotier_networks',
          networks: [
            network(NET_OK, 'OK', ['10.147.17.42/24']),
            network(NET_PENDING, 'ACCESS_DENIED', []),
            network(NET_OTHER, 'REQUESTING_CONFIGURATION', []),
          ],
        });
      case 'zerotier_join':
        return Promise.resolve<AgentResponse>({
          status: 'zerotier_joined',
          // The state right after a join, which is the one that matters: joined, not authorized.
          network: network(
            'network_id' in request ? request.network_id : '?',
            'REQUESTING_CONFIGURATION',
            [],
          ),
        });
      case 'zerotier_leave':
        return Promise.resolve<AgentResponse>({
          status: 'zerotier_left',
          network_id: 'network_id' in request ? request.network_id : '?',
        });
      default:
        return Promise.resolve<AgentResponse>({
          status: 'failed',
          reason: `the stub was not asked about ${request.op}`,
        });
    }
  };
}

describeDb('remote access, against a real PostgreSQL', () => {
  let db: DbService;
  let owner: DbService;
  let orgA = '';
  let orgB = '';
  let adminA = '';
  let adminB = '';
  let seededSetup = false;

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    owner = new DbService(OWNER_URL as string);

    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(
        `INSERT INTO organizations (slug, name)
         VALUES ('remote-a','Remote A'), ('remote-b','Remote B')
         ON CONFLICT (slug) DO NOTHING`,
      );
      const orgs = await q.query<{ slug: string; id: string }>(
        `SELECT slug, id::text AS id FROM organizations WHERE slug IN ('remote-a','remote-b')`,
      );
      orgA = orgs.find((r) => r.slug === 'remote-a')?.id ?? '';
      orgB = orgs.find((r) => r.slug === 'remote-b')?.id ?? '';

      const seeded = await q.query<{ organization_id: string; id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'uzak-yonetici-a', 'admin', 'x'), ($2, 'uzak-yonetici-b', 'admin', 'x')
         RETURNING organization_id::text AS organization_id, id::text AS id`,
        [orgA, orgB],
      );
      adminA = seeded.find((r) => r.organization_id === orgA)?.id ?? '';
      adminB = seeded.find((r) => r.organization_id === orgB)?.id ?? '';

      // Kendiliğinden yetkilendirme denetim kaydına bir AKTÖR yazıyor ve o aktör `system_setup`
      // içindeki kurucu. Tablo tekil, o yüzden varsa olduğu gibi bırakılıyor; yalnız bu süitin
      // koyduğu satır sonunda geri alınıyor.
      const claimed = await q.query<{ id: string }>(
        `INSERT INTO system_setup (organization_id, admin_user_id) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING
         RETURNING id::text AS id`,
        [orgA, adminA],
      );
      seededSetup = claimed.length === 1;
    });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.withoutTenant('migration-status', async (q) => {
        await q.query(`DELETE FROM remote_networks WHERE organization_id = ANY($1)`, [
          [orgA, orgB],
        ]);
        // Üye kayıtları kuruluşu RESTRICT ile tutuyor — bilerek: "kim içeri aldı" kaydı kuruluş
        // silinirken sessizce yok olmamalı. Süitin temizliği bu yüzden onları önce kaldırıyor.
        await q.query(`DELETE FROM remote_members WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        if (seededSetup) await q.query(`DELETE FROM system_setup`);
        await q.query(`DELETE FROM users WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
        await q.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgA, orgB]]);
      });
      await owner.onModuleDestroy();
    }
    await db?.onModuleDestroy();
  });

  /** Every test starts from no networks, so no assertion depends on what an earlier one left. */
  beforeEach(async () => {
    await owner.withoutTenant('migration-status', async (q) => {
      await q.query(`DELETE FROM remote_networks WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
      await q.query(`DELETE FROM remote_members WHERE organization_id = ANY($1)`, [[orgA, orgB]]);
    });
  });

  /** Read as the OWNER, bypassing RLS: "the row is hidden" and "the row is absent" differ. */
  async function rowsFor(
    organizationId: string,
    networkId: string,
  ): Promise<{ label: string | null; joined_by: string | null; left_at: Date | null }[]> {
    return owner.withoutTenant('migration-status', (q) =>
      q.query<{ label: string | null; joined_by: string | null; left_at: Date | null }>(
        `SELECT label, joined_by::text AS joined_by, left_at
           FROM remote_networks
          WHERE organization_id = $1 AND network_id = $2
          ORDER BY joined_at`,
        [organizationId, networkId],
      ),
    );
  }

  // ── cihazın ne olduğu ──

  it('learns what a device IS from the session it signed in with', async () => {
    // ZeroTier bunu bilmiyor: üye kaydında işletim sistemi ya da model diye bir alan YOK. Bilen
    // tek taraf, o cihazın DEPSIS'e girerken kendini tanıttığı tarayıcı — ve iki tarafı
    // birleştiren şey adres: ağdaki IP'leri controller dağıtıyor, yani aynı anda iki cihazda
    // olamıyorlar.
    //
    // Bu testin asıl ölçtüğü şey EŞLEŞMENİN KENDİSİ. Kullanıcı aracısını okuyan kısım kendi birim
    // testlerinde; burada yanlış gidebilecek şey `inet` karşılaştırması, ve yanlış gittiğinde
    // sessizce hiçbir şey öğrenilmiyor — sahada sonsuza kadar "—" yazan bir sütun.
    // `members` yalnızca BU cihazın yönettiği bir ağa bakıyor, o yüzden satır `controlled` olmalı.
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO remote_networks (organization_id, network_id, label, joined_by, controlled)
              VALUES ($1, $2, 'Ev', $3, true)`,
        [orgA, NET_OK, adminA],
      ),
    );
    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO sessions (organization_id, user_id, token_hash, expires_at, ip_address, user_agent)
              VALUES ($1, $2, $3, now() + interval '1 hour', $4::inet, $5)`,
        [
          orgA,
          adminA,
          Buffer.from('c'.repeat(64), 'hex'),
          // Sıfır dolgulu, ve bilerek: metin karşılaştırması burada düşerdi, `inet` düşmüyor.
          '10.147.017.099',
          'Mozilla/5.0 (Linux; Android 14; SM-S926B) AppleWebKit/537.36 Mobile',
        ],
      ),
    );

    const { agent } = stubAgent((request) => {
      if (request.op === 'zerotier_controller_members') {
        return Promise.resolve<AgentResponse>({
          status: 'zerotier_controller_members',
          members: [
            {
              member_id: '1122334455',
              authorized: true,
              label: '',
              addresses: ['10.147.17.99'],
              seen: true,
              is_this_appliance: false,
            },
          ],
        });
      }
      return healthyDaemon()(request);
    });
    const remote = new RemoteService(agent, db);

    const members = await remote.members(orgA, NET_OK, 'corr-dev');
    expect(members[0]?.device).toBe('Android · SM-S926B');

    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM sessions WHERE organization_id = $1`, [orgA]),
    );
  });

  // ── çıkarılan cihaz ──

  it('keeps a device the owner removed out, while still letting a new one in', async () => {
    // Bu testin ölçtüğü şey bir GÜVENLİK davranışı: kendiliğinden yetkilendirme turu her yirmi
    // saniyede bir yetkisiz üyeleri içeri alıyor, ve ajan "Çıkar"da üyeyi SİLMİYOR — yalnız
    // `authorized:false` yazıyor. Yani çıkarılmış bir telefon, controller'ın listesinde yeni
    // katılmış bir telefondan ayırt edilemez halde duruyor; ayıran tek şey DEPSIS'in kendi
    // kaydındaki çıkarma damgası. O damga okunmazsa kaybolan telefon kendiliğinden geri geliyor.
    const LOST = '1111111111';
    const FRESH = '2222222222';
    const onController = new Map([
      [LOST, true],
      [FRESH, false],
    ]);
    let setCalls: { member: string; authorized: boolean }[] = [];

    const { agent } = stubAgent((request) => {
      switch (request.op) {
        case 'zerotier_controller_networks':
          return Promise.resolve<AgentResponse>({
            status: 'zerotier_controller_networks',
            networks: [
              {
                network_id: NET_OK,
                name: 'Ev',
                private: true,
                assigns_addresses: true,
                subnet: '10.147.17.0/24',
              },
            ],
          });
        case 'zerotier_controller_members':
          return Promise.resolve<AgentResponse>({
            status: 'zerotier_controller_members',
            members: [...onController].map(([id, authorized]) => controllerMember(id, authorized)),
          });
        case 'zerotier_set_member_authorized':
          setCalls.push({ member: request.member, authorized: request.authorized });
          onController.set(request.member, request.authorized);
          return Promise.resolve<AgentResponse>({
            status: 'zerotier_member_updated',
            member: controllerMember(request.member, request.authorized),
          });
        default:
          return healthyDaemon()(request);
      }
    });

    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO remote_networks (organization_id, network_id, label, joined_by, controlled)
              VALUES ($1, $2, 'Ev', $3, true)`,
        [orgA, NET_OK, adminA],
      ),
    );
    const remote = new RemoteService(agent, db);

    // Sahibi kaybolan telefonu için "Çıkar"a bastı.
    await remote.setMemberAuthorized(orgA, adminA, NET_OK, LOST, false, null, 'c-cikar');
    expect(onController.get(LOST)).toBe(false);

    // Yirmi saniye sonraki tur: yeni cihaz içeri alınıyor, çıkarılan alınmıyor.
    setCalls = [];
    expect(await remote.authorizeNewMembers(orgA, 'c-tur')).toBe(1);
    expect(setCalls).toEqual([{ member: FRESH, authorized: true }]);
    expect(onController.get(LOST)).toBe(false);

    // Ve çıkarmak kalıcı bir yasak DEĞİL: sahibi elle "Yetkilendir" derse son söz onun. Burada
    // cihaz, controller durumu kaybedildikten sonraki gibi yeniden yetkisiz düşüyor — o tur onu
    // geri alıyor, çünkü verilen en son karar "içeri al".
    await remote.setMemberAuthorized(orgA, adminA, NET_OK, LOST, true, null, 'c-geri');
    onController.set(LOST, false);
    setCalls = [];
    expect(await remote.authorizeNewMembers(orgA, 'c-tur-2')).toBe(1);
    expect(setCalls).toEqual([{ member: LOST, authorized: true }]);
  });

  // ── the id itself ──

  it('accepts only sixteen lowercase hex digits as a network id', () => {
    // ADR-0020's verification list. Every one of these would otherwise be concatenated into a
    // request path on the privileged side.
    expect(NETWORK_ID.test(NET_OK)).toBe(true);
    for (const bad of [
      '',
      '8056c2e21c00000', // fifteen
      '8056c2e21c0000011', // seventeen
      '8056C2E21C000001', // uppercase
      '8056c2e21c00000g', // not hex
      '../../../etc/pas', // exactly sixteen bytes, and a path fragment
      '0123456789abcd f',
      '0123456789ab\r\ncd',
      '0123456789abc de',
    ]) {
      expect(NETWORK_ID.test(bad), `${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });

  // ── reading ──

  it("reports the daemon's networks and attaches this tenant's label and join time", async () => {
    const { agent, calls } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, 'Ev ağı', 'corr-join');
    const status = await remote.status(orgA, 'corr-1');

    expect(status.available).toBe(true);
    expect(status.nodeId).toBe('ef780bec87');
    expect(status.online).toBe(true);
    expect(status.version).toBe('1.16.2');

    const mine = status.networks.find((n) => n.networkId === NET_OK);
    // The label and the timestamp come from DEPSIS; everything else comes from the daemon.
    expect(mine?.label).toBe('Ev ağı');
    expect(mine?.joinedAt).toEqual(expect.any(String));
    expect(mine?.addresses).toEqual(['10.147.17.42/24']);

    // §16: both privileged calls carry the request's correlation id.
    const statusCalls = calls.filter((c) => c.correlationId === 'corr-1');
    expect(statusCalls.map((c) => c.request.op)).toEqual(['zerotier_status', 'zerotier_networks']);
  });

  it('reports a joined-but-unapproved network as unauthorized, not as connecting', async () => {
    // The failure this prevents is a product failure rather than a security one: a user who sees
    // "connected" for an ACCESS_DENIED network concludes DEPSIS is broken, when what is missing is
    // a tick-box in ZeroTier Central (ADR-0020).
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    const status = await remote.status(orgA, 'corr-1');
    const byId = new Map(status.networks.map((n) => [n.networkId, n]));

    expect(byId.get(NET_OK)?.status).toBe('OK');
    expect(byId.get(NET_OK)?.authorized).toBe(true);

    expect(byId.get(NET_PENDING)?.status).toBe('ACCESS_DENIED');
    expect(byId.get(NET_PENDING)?.authorized).toBe(false);
    // Empty until the network authorizes the device, which is what makes an empty list meaningful.
    expect(byId.get(NET_PENDING)?.addresses).toEqual([]);

    // Not authorized either. `authorized` is `status === 'OK'` and nothing looser, so a state that
    // is merely "not ACCESS_DENIED" does not slip through as a green light.
    expect(byId.get(NET_OTHER)?.authorized).toBe(false);
  });

  it("never shows one organisation another's label", async () => {
    // The ZeroTier node is device-wide, so both tenants see the same network ids — that is a fact
    // about the appliance, not a leak. The label is DEPSIS's own data and RLS keeps it scoped.
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, 'A takımının ağı', 'c');

    const theirs = await remote.status(orgB, 'c');
    expect(theirs.networks.find((n) => n.networkId === NET_OK)?.label).toBeNull();
    expect(theirs.networks.find((n) => n.networkId === NET_OK)?.joinedAt).toBeNull();

    const mine = await remote.status(orgA, 'c');
    expect(mine.networks.find((n) => n.networkId === NET_OK)?.label).toBe('A takımının ağı');
  });

  it('answers "unavailable" rather than a fault when zerotier-one is not there', async () => {
    // 503, not 500. The distinction ADR-0020's verification checks for, and the one an operator
    // needs most: DEPSIS does not package ZeroTier, so absent is an ordinary state of the box.
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({
        status: 'zerotier_unavailable',
        reason: 'zerotier-one is not installed here: /var/lib/zerotier-one/authtoken.secret ...',
      }),
    );
    const remote = new RemoteService(agent, db);

    await expect(remote.status(orgA, 'c')).rejects.toBeInstanceOf(RemoteUnavailableError);
    // The reason is passed through, because "not installed" and "not running" send the operator to
    // two different places.
    await expect(remote.status(orgA, 'c')).rejects.toThrow(/not installed/u);
  });

  it('degrades the READ to 200 with available:false, but still refuses to join', async () => {
    // The contract used to publish both a 503 and an `available` flag on GET /remote and this
    // file's module reported that as a contradiction: a caller cannot read a field on a body it
    // never receives. The document picked 200, and this pins both halves of that decision so the
    // next refactor cannot quietly restore the 503.
    //
    // The asymmetry is the interesting part. Reading degrades because "ZeroTier is not installed"
    // is an ordinary state of a box that works fine without it, and the interface has to draw a
    // card saying so — a card cannot be drawn from an error. Joining does NOT degrade, because
    // there a real piece of work was asked for and genuinely cannot be done.
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({
        status: 'zerotier_unavailable',
        reason: 'zerotier-one is not installed here: /var/lib/zerotier-one/authtoken.secret ...',
      }),
    );
    const controller = new RemoteController(new RemoteService(agent, db), new AuditService(db));
    // `headers` is not decoration: `join` is a state change and runs the same-origin check, which
    // reads `origin`, `referer` and `host`. Without the object the guard throws a TypeError and
    // the join half of this test would fail for a reason that has nothing to do with ZeroTier.
    const request = {
      headers: {},
      depsis: { organizationId: orgA, userId: adminA },
    } as unknown as AuthenticatedRequest;

    const answer = await controller.status(request);
    expect(answer.available).toBe(false);
    expect(answer.networks).toEqual([]);
    expect(answer.online).toBe(false);

    // And nothing about the daemon's own error text leaks into the degraded body.
    expect(JSON.stringify(answer)).not.toMatch(/authtoken/u);

    await expect(
      controller.join(request, { networkId: 'a09acf0233' + '3f6b21' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("withholds the local API's own error text from a fault", async () => {
    // A `failed` reason is the local API's answer — a status line, a parse error, a fragment of a
    // response body. None of it is actionable by the caller and all of it describes the privileged
    // side. It goes to the journal, not into a Problem Details document.
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({
        status: 'failed',
        reason: 'the local API refused our token (HTTP 401)',
      }),
    );
    const remote = new RemoteService(agent, db);

    const failure = await remote.status(orgA, 'c').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RemoteUnavailableError);
    expect((failure as RemoteUnavailableError).message).not.toContain('401');
    expect((failure as RemoteUnavailableError).message).not.toContain('token');
  });

  it('does not list a stale row the daemon no longer reports', async () => {
    // Somebody ran `zerotier-cli leave` on the box. The daemon is the source of truth (ADR-0020),
    // so the row is not resurrected into the answer — listing it would show a working remote
    // connection that does not exist.
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await owner.withoutTenant('migration-status', (q) =>
      q.query(
        `INSERT INTO remote_networks (organization_id, joined_by, network_id, label)
         VALUES ($1, $2, 'aaaaaaaaaaaaaaaa', 'hayalet')`,
        [orgA, adminA],
      ),
    );

    const status = await remote.status(orgA, 'c');
    expect(status.networks.map((n) => n.networkId)).not.toContain('aaaaaaaaaaaaaaaa');
  });

  // ── joining ──

  it('joins, then records who did it', async () => {
    const { agent, calls } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    const joined = await remote.join(orgA, adminA, NET_OK, 'Ev ağı', 'corr-join');

    expect(joined.networkId).toBe(NET_OK);
    expect(joined.label).toBe('Ev ağı');
    // Joining is not authorization, and the response says so from the first moment.
    expect(joined.authorized).toBe(false);
    expect(joined.status).toBe('REQUESTING_CONFIGURATION');

    const rows = await rowsFor(orgA, NET_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.joined_by).toBe(adminA);
    expect(rows[0]?.left_at).toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.op).toBe('zerotier_join');
    expect(calls[0]?.correlationId).toBe('corr-join');
    expect(calls[0]?.reason).toContain(NET_OK);
  });

  it('writes no row when the agent refuses', async () => {
    // The ordering rule and the reason for it: a row written first would survive the refusal and
    // list a network this appliance is not on. `GET /remote` is consulted to answer "can I reach
    // the box from outside?", and a false yes there is worse than no answer.
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({ status: 'refused', reason: 'not today' }),
    );
    const remote = new RemoteService(agent, db);

    await expect(remote.join(orgA, adminA, NET_OK, null, 'c')).rejects.toBeInstanceOf(
      AgentRefusedError,
    );
    expect(await rowsFor(orgA, NET_OK)).toHaveLength(0);
  });

  it('writes no row when the daemon is not there', async () => {
    const { agent } = stubAgent(() =>
      Promise.resolve<AgentResponse>({
        status: 'zerotier_unavailable',
        reason: 'zerotier-one is not answering on 127.0.0.1:9993',
      }),
    );
    const remote = new RemoteService(agent, db);

    await expect(remote.join(orgA, adminA, NET_OK, null, 'c')).rejects.toBeInstanceOf(
      RemoteUnavailableError,
    );
    expect(await rowsFor(orgA, NET_OK)).toHaveLength(0);
  });

  it('writes no row when the agent itself cannot be reached', async () => {
    const { agent } = stubAgent(() =>
      Promise.reject(new AgentUnavailableError('socket is not there')),
    );
    const remote = new RemoteService(agent, db);

    await expect(remote.join(orgA, adminA, NET_OK, null, 'c')).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    expect(await rowsFor(orgA, NET_OK)).toHaveLength(0);
  });

  it('turns a second join of the same network into a conflict, not a second row', async () => {
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, 'ilk', 'c');
    await expect(remote.join(orgA, adminA, NET_OK, 'ikinci', 'c')).rejects.toBeInstanceOf(
      NetworkAlreadyJoinedError,
    );

    // The partial index settles it, so two administrators clicking at the same moment reach the
    // same outcome as one clicking twice — and the first label is not overwritten.
    const rows = await rowsFor(orgA, NET_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('ilk');
  });

  it('lets two organisations join the same network independently', async () => {
    // The index is per (organization, network). A global one would refuse B because A had joined,
    // which tells B something about A.
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, 'A', 'c');
    await expect(remote.join(orgB, adminB, NET_OK, 'B', 'c')).resolves.toBeTruthy();
    expect(await rowsFor(orgB, NET_OK)).toHaveLength(1);
  });

  // ── leaving ──

  it('leaves, and closes the row instead of deleting it', async () => {
    const { agent, calls } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, 'Ev ağı', 'c');
    await remote.leave(orgA, NET_OK, 'corr-leave');

    // The audit question "who put this appliance on that network, and for how long" stays
    // answerable, which a DELETE would end.
    const rows = await rowsFor(orgA, NET_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.left_at).not.toBeNull();

    expect(calls.map((c) => c.request.op)).toEqual(['zerotier_join', 'zerotier_leave']);
    expect(calls[1]?.correlationId).toBe('corr-leave');
  });

  it('refuses to leave a network this organisation has no record of, without calling the agent', async () => {
    // The authorisation hole this closes: without the row check, any administrator could remove
    // the appliance from ANY network the device happens to be in — another tenant's, or one an
    // operator joined by hand — on the strength of a sixteen-digit string.
    const { agent, calls } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await expect(remote.leave(orgA, NET_OK, 'c')).rejects.toBeInstanceOf(NetworkNotJoinedError);
    expect(calls).toHaveLength(0);
  });

  it("refuses to leave another tenant's network with the same answer", async () => {
    const { agent, calls } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgB, adminB, NET_OK, 'B', 'c');
    const before = calls.length;

    await expect(remote.leave(orgA, NET_OK, 'c')).rejects.toBeInstanceOf(NetworkNotJoinedError);
    expect(calls).toHaveLength(before);
    // And B is still on it.
    expect((await rowsFor(orgB, NET_OK))[0]?.left_at).toBeNull();
  });

  it('refuses to leave a network it has already left', async () => {
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, null, 'c');
    await remote.leave(orgA, NET_OK, 'c');
    await expect(remote.leave(orgA, NET_OK, 'c')).rejects.toBeInstanceOf(NetworkNotJoinedError);
  });

  it('leaves the row open when the agent could not carry out the leave', async () => {
    // The mirror of the join ordering. Marking `left_at` before the call would claim the appliance
    // is off a network it is still on, which is the direction of error that matters here.
    let leaveIsPossible = true;
    const { agent } = stubAgent((request) => {
      if (request.op === 'zerotier_leave' && !leaveIsPossible) {
        return Promise.resolve<AgentResponse>({
          status: 'zerotier_unavailable',
          reason: 'zerotier-one is not answering on 127.0.0.1:9993',
        });
      }
      return healthyDaemon()(request);
    });
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, null, 'c');
    leaveIsPossible = false;

    await expect(remote.leave(orgA, NET_OK, 'c')).rejects.toBeInstanceOf(RemoteUnavailableError);
    expect((await rowsFor(orgA, NET_OK))[0]?.left_at).toBeNull();
  });

  it('lets a network be rejoined after leaving, and keeps both rows', async () => {
    // What the partial index is for: `left_at IS NULL` scopes uniqueness to current membership, so
    // the history of a network joined twice is two rows rather than one overwritten one.
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    await remote.join(orgA, adminA, NET_OK, 'ilk kez', 'c');
    await remote.leave(orgA, NET_OK, 'c');
    await remote.join(orgA, adminA, NET_OK, 'ikinci kez', 'c');

    const rows = await rowsFor(orgA, NET_OK);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.left_at).not.toBeNull();
    expect(rows[1]?.left_at).toBeNull();
    expect(rows[1]?.label).toBe('ikinci kez');
  });

  it('keeps the row when the account that joined is deleted, with no joiner', async () => {
    // `joined_by` is ON DELETE SET NULL. The record of WHICH networks the appliance is on must
    // outlive the account that put it there — that is the fact an audit needs, and losing the row
    // with the user would lose it.
    const { agent } = stubAgent(healthyDaemon());
    const remote = new RemoteService(agent, db);

    const gone = await owner.withoutTenant('migration-status', async (q) => {
      const rows = await q.query<{ id: string }>(
        `INSERT INTO users (organization_id, username, role, password_hash)
         VALUES ($1, 'uzak-silinecek', 'member', 'x')
         RETURNING id::text AS id`,
        [orgA],
      );
      return rows[0]?.id ?? '';
    });

    await remote.join(orgA, gone, NET_OK, 'yetim', 'c');
    await owner.withoutTenant('migration-status', (q) =>
      q.query(`DELETE FROM users WHERE id = $1`, [gone]),
    );

    const rows = await rowsFor(orgA, NET_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.joined_by).toBeNull();
    expect(rows[0]?.label).toBe('yetim');
  });
});

/**
 * The read path against the real zerotier-one, through the real agent.
 *
 * Only reading. Joining a network is the device owner's decision and makes the appliance visible to
 * everyone on that network — a test suite does not get to make it (ADR-0020).
 *
 * What this adds over the stub is the one thing a stub cannot: that the daemon's actual answers
 * survive the agent's projection and this service's mapping. If `zerotier-one` is stopped the
 * service must raise `RemoteUnavailableError` — the 503 — rather than anything else, and that is
 * asserted here rather than assumed, because it is the branch ADR-0020's verification names.
 */
describeDaemon('remote access, against the real zerotier-one', () => {
  let db: DbService;
  let agent: AgentService;

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();
    agent = new AgentService(AGENT_SOCKET as string, 15_000);
    await agent.onModuleInit();
  });

  afterAll(async () => {
    await db?.onModuleDestroy();
  });

  it('reports the node, or says the daemon is off — and never a fault', async () => {
    const remote = new RemoteService(agent, db);

    // The organisation is only used to scope the label lookup, and a nil uuid matches nothing —
    // which is the point: this test is about the daemon's half of the answer, not the table's.
    let answer: RemoteStatus;
    try {
      answer = await remote.status('00000000-0000-0000-0000-000000000000', 'itest-remote');
    } catch (error) {
      // zerotier-one is installed but stopped. A legitimate outcome, and the one that must not be
      // a 500 — so it is asserted rather than swallowed.
      if (error instanceof RemoteUnavailableError) {
        expect(error.detail).toMatch(/zerotier-one/u);
        return;
      }
      throw error;
    }

    expect(answer.available).toBe(true);
    // ZeroTier addresses are ten hex digits. Checked as a shape rather than against the
    // development box's `ef780bec87`, so the suite still means something on another machine.
    expect(answer.nodeId).toMatch(/^[0-9a-f]{10}$/u);
    expect(answer.version).toMatch(/^\d+\.\d+\.\d+/u);
    for (const net of answer.networks) {
      expect(net.networkId).toMatch(NETWORK_ID);
      expect(net.authorized).toBe(net.status === 'OK');
      // Nothing DEPSIS did not record has a label, and the nil organisation recorded nothing.
      expect(net.label).toBeNull();
    }
  });
});
