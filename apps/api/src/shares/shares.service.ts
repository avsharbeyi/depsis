import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { PERMISSIONS as ALL_PERMISSIONS } from '@depsis/authz';

import {
  AgentRefusedError,
  AgentService,
  AgentUnavailableError,
  expectStatus,
  type AgentRequest,
  type SmbPrincipal,
} from '../agent/agent.service.js';
import { DbService, type TenantQuery } from '../db/db.service.js';
import { RECONCILE_KIND } from '../files/indexer.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import {
  APPLY_ACL_KIND,
  APPLY_ACL_MAX_ATTEMPTS,
  type GrantInput,
} from '../permissions/permissions.service.js';

/** One row of `public.shares`. */
export interface ShareRow {
  id: string;
  name: string;
  dataset: string;
  read_only: boolean;
}

/** A share, as this module reports it: the row plus the two things only the agent can settle. */
export interface ShareView extends ShareRow {
  unc_path: string;
  published: boolean;
}

export interface ShareListing {
  items: ShareView[];
  smbAvailable: boolean;
}

/** Samba is not installed on this box. Not a fault — DEPSIS does not package it (ADR-0020). */
export class SmbUnavailableError extends Error {
  constructor(readonly agentReason: string) {
    super('samba is not installed on this appliance');
    this.name = 'SmbUnavailableError';
  }
}

/**
 * The publish failed and nobody may claim the previous configuration survived.
 *
 * Distinct from `AgentRefusedError` because the agent's two answers are distinct facts. A refusal
 * is `SambaError::RejectedRolledBack` — Samba said no and the old file is back, shares keep
 * working, retry after fixing what the message names. This is everything else, and the case it
 * exists for is `SambaError::RollbackFailed`: rejected AND the restore failed, which the agent
 * itself describes as the box being worse than it was found. Both arrive as `failed` because the
 * wire has one status for them, so this errs toward the serious reading and says the state is
 * unknown rather than asserting a rollback that may not have happened.
 *
 * What would sharpen it: a machine-readable answer for the unrecoverable case — `Response::
 * SmbBroken { reason }`, or a discriminator on `Failed`. That is a change to the Rust-side
 * operation set and its schema version, so it is noted rather than made here.
 */
export class SmbPublishFailedError extends Error {
  constructor(readonly agentReason: string) {
    super('the samba configuration was not published and its previous state is unknown');
    this.name = 'SmbPublishFailedError';
  }
}

/** No pool has been configured, so there is nowhere to put a new share's dataset. */
export class ShareStorageUnconfiguredError extends Error {
  constructor() {
    super('DEPSIS_SHARE_PARENT_DATASET is not set, so this appliance cannot create a share');
    this.name = 'ShareStorageUnconfiguredError';
  }
}

/** The name is taken — in the database, or on the pool by a dataset DEPSIS did not record. */
export class ShareNameTakenError extends Error {
  constructor(
    readonly shareName: string,
    readonly where: 'database' | 'pool',
  ) {
    super(`a share named '${shareName}' already exists`);
    this.name = 'ShareNameTakenError';
  }
}

/** A share must be created with at least one root grant. See `create`. */
export class ShareWithoutGrantsError extends Error {
  constructor() {
    super('a share cannot be created with an empty grant list');
    this.name = 'ShareWithoutGrantsError';
  }
}

/** A grant named a user or team that is not in this organisation. */
export class UnknownGrantPrincipalError extends Error {
  constructor(readonly ids: readonly string[]) {
    super(`no such user or team in this organisation: ${ids.join(', ')}`);
    this.name = 'UnknownGrantPrincipalError';
  }
}

/**
 * The device holds more than one organisation, so a tenant-scoped publish would be wrong.
 *
 * See `publish`. This is a refusal to do damage, not a missing feature.
 */
export class ShareListNotDeviceWideError extends Error {
  constructor() {
    super('the share list this publish would send is not the whole device');
    this.name = 'ShareListNotDeviceWideError';
  }
}

/** A share cannot be expressed as an `smb.conf` section, so nothing was sent to the agent. */
export class UnpublishableShareError extends Error {
  constructor(
    readonly shareName: string,
    readonly why: string,
  ) {
    super(`share '${shareName}' cannot be published: ${why}`);
    this.name = 'UnpublishableShareError';
  }
}

/**
 * Section names that would take over the operator's own configuration rather than add to it.
 *
 * The same four `samba.rs` refuses, checked here as well, and NOT as belt-and-braces: migration
 * 0008's `shares_name_format` accepts `global`, so a tenant can create a share the database is
 * happy with and the agent will refuse — and it refuses the WHOLE publish, which means one badly
 * named share stops every other share on the box from being served. Catching it here names the
 * offending share instead of failing the publish with the agent's prose.
 */
const RESERVED_SECTIONS: readonly string[] = ['global', 'homes', 'printers', 'print$'];

/**
 * Shares, their SMB addresses, and the republish that makes them real.
 *
 * The one thing to understand before changing anything here: a row in `public.shares` and a share
 * smbd is serving are DIFFERENT FACTS, and this service exists mostly to keep them apart. The
 * contract's `Share.published` says so too. Reporting a row as published because it is in the
 * database would send a user to type `\\depsis\belgeler` into Explorer and get nothing back, with
 * no way to tell whether they mistyped it or the appliance never configured it.
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  /**
   * The share ids the agent confirmed it was serving, at the last successful publish.
   *
   * THIS IS A CACHE, and its limits are the reason it is written down rather than presented as
   * knowledge:
   *
   *   * It lives in this process. A restart empties it, so a box whose shares are being served
   *     perfectly well reports every one of them as `published: false` until somebody republishes.
   *     That is the direction to be wrong in — the alternative is telling a user an address works
   *     when nothing checked, and the recovery from a false `false` is one click on republish
   *     while the recovery from a false `true` is a support call.
   *   * It goes stale. `smb.conf` is the operator's file and a shell on the box can edit it, stop
   *     smbd, or remove the `include` line, and none of that reaches this set.
   *
   * What would replace it: an agent operation that asks smbd what it is offering right now. The
   * agent already does exactly that inside `samba::publish` (`offered_shares`, the live connection
   * P0-B showed `testparm` cannot substitute for), so the capability exists — it is simply not
   * reachable as an operation of its own, and adding one is a change to the closed Rust-side
   * operation set (§2.2, ADR-0006) rather than something the API can decide. Until then this set
   * is the honest half of the answer, and `false` is what unknown means.
   *
   * Keyed by share id rather than by name because the id is the identity the contract exposes and
   * the thing a name change survives.
   */
  private publishedShareIds: ReadonlySet<string> = new Set();

  /**
   * What the last publish attempt learned about Samba being installed here.
   *
   * `unknown` reports as available, unlike `publishedShareIds` reporting unknown as false, and the
   * asymmetry is deliberate rather than an oversight. The contract says `smbAvailable: false` means
   * "Samba is not installed" — a positive claim about the machine. Making that claim because
   * nobody has published since boot would tell an administrator to install a package that is
   * already there. `published: false` claims nothing; it withholds. So the field that withholds
   * defaults to withholding and the field that asserts defaults to not asserting.
   */
  private smbInstalled: 'unknown' | 'yes' | 'no' = 'unknown';

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    /**
     * Only for `resolveSoleId`. See `publish` — the device-wide question this service has to ask
     * has exactly one answer available to it today, and this is where that answer comes from.
     */
    private readonly organizations: OrganizationsService,
    /**
     * The name that goes in `\\host\share`.
     *
     * Configuration (`DEPSIS_SMB_HOST`), not the box's own hostname, and not derived from the
     * request's Host header either. Which name resolves to this appliance from a Windows client is
     * a fact about the network — a NetBIOS name, a DNS name, or the name behind a ZeroTier
     * address — and the appliance cannot see it. Guessing produces an address that looks
     * authoritative and does not answer, which is the one failure this endpoint exists to prevent.
     */
    private readonly smbHost: string,
    /**
     * The dataset new shares are created under (`DEPSIS_SHARE_PARENT_DATASET`), or null.
     *
     * Null is a real state and not a misconfiguration: a box whose operator has not made a pool
     * yet has nowhere to put a share, and `create` says so with a 503 rather than assembling a
     * dataset name against a pool that may not exist and letting the agent discover it.
     */
    /**
     * Where new datasets go, ASKED rather than fixed.
     *
     * It was a string handed in at construction, read from `DEPSIS_SHARE_PARENT_DATASET` — so the
     * only way to change it was to edit `api.env` and restart the API. That was the last shell step
     * in the flow the pool wizard exists to remove: an operator finished the wizard and still could
     * not create a share. The resolver answers with the configured value when there is one and
     * otherwise with whatever the box reports as mounted at the shares root.
     *
     * Still nullable, and still for the same reason: there is no sensible name to guess, and a
     * wrong one produces datasets nothing serves.
     */
    private readonly parentDataset: (correlationId: string) => Promise<string | null>,
    /** Queues the POSIX re-application after a share's first grant lands. See `create`. */
    private readonly jobs: JobsService,
  ) {}

  /**
   * Open a share: a dataset, a row, and the grant that governs it — in that order.
   *
   * §9 has had `GET /shares` since the beginning and no way to make one. Until now the only thing
   * that ever inserted into `public.shares` was a test, which is a peculiar fact to discover about
   * a NAS: the appliance could list, publish and serve shares that nothing in the product could
   * create.
   *
   * ── THE ORDER, AND WHAT IT COSTS WHEN EACH STEP IS THE ONE THAT FAILS ──
   *
   * **Dataset first.** A row written before the dataset exists is a share that appears in the file
   * manager, accepts a click and answers 503 on everything — and the person looking at it cannot
   * tell a broken share from a broken appliance. A dataset with no row is invisible instead, which
   * is the direction to be wrong in: `zfs list` still shows it to the operator, and creating the
   * share again by the same name reports the collision below rather than silently adopting it.
   *
   * There is no compensating undo for step one, and that is a property of the operation set rather
   * than an omission here: `Request` carries `CreateDataset` and no destroy, because ADR-0007 keeps
   * destructive pool operations out of the product — an API that can create a dataset and an API
   * that can destroy one are very different things to put behind a web session. So the name is
   * checked free BEFORE the agent is called, which turns the overwhelmingly common failure (a
   * double click, or a name already in use) into a refusal that costs nothing.
   *
   * **Row and grant in ONE transaction**, and this is the half that closes a hole rather than
   * tidying a sequence. `LEGACY_OPEN_SHARE` used to give every member of the tenant seven
   * permissions on any share with no grant rows at all, so a share that existed for even a moment
   * with none was a share briefly open to everybody. Two transactions would leave exactly that
   * window on a crash between them. One makes "a share with zero grants" a state this path cannot
   * produce — the condition the fallback's own removal notice named, and the same condition
   * migration 0016 applied to the rows that already existed.
   *
   * **The ACL apply last, and allowed to fail.** Queued after the commit, exactly as
   * `PermissionsService.write` does it: the grant is already durable, and refusing to create the
   * share because a daemon is down would be worse than creating it with the filesystem a step
   * behind. `applyingJobId: null` is how the interface is told the kernel has not been informed,
   * and the contract makes showing that mandatory.
   */
  async create(
    organizationId: string,
    actorId: string,
    input: {
      name: string;
      readOnly: boolean;
      quotaBytes: number | null;
      grants: readonly GrantInput[] | null;
    },
    correlationId: string,
  ): Promise<{ share: ShareView; applyingJobId: string | null }> {
    const parent = await this.parentDataset(correlationId);
    if (parent === null) throw new ShareStorageUnconfiguredError();

    // Before anything else, because the agent refuses these too — and it refuses the WHOLE publish,
    // so one badly named share would stop every other share on the box from being served. `publish`
    // makes the same check for the same reason; making it here as well means the name never
    // becomes a row.
    if (RESERVED_SECTIONS.some((reserved) => reserved === input.name.toLowerCase())) {
      throw new UnpublishableShareError(
        input.name,
        "it is a reserved smb.conf section name and would rewrite the server's own settings",
      );
    }

    // An explicit empty list is refused rather than defaulted, and the distinction is the point:
    // `grants: null` means "the caller did not say", which becomes the creating administrator;
    // `grants: []` means "the caller said nobody", which is a request for exactly the ungoverned
    // share this method exists to make impossible.
    if (input.grants !== null && input.grants.length === 0) throw new ShareWithoutGrantsError();
    // Varsayilan, sahibin ilk gercek kullanimda koydugu kural: YENI BIR PAYLASIMI HERKES GORUR,
    // KIMSE BOZAMAZ. Ilk hali yalniz kurucuya izin veriyordu ve ikinci hesap actigi paylasimi
    // bombos gordu — dogru davranan bir izin modeli, aciklanana kadar bozuk bir urun gibi
    // gorunuyor. Herkes takimina list/read/download; yazma, silme ve yonetim kurucuda kalir,
    // ve daraltmak istenirse Izinler paneli tam da bunun icin var.
    const grants: readonly GrantInput[] | null = input.grants;

    const dataset = `${parent}/${input.name}`;

    // The pre-check RACES — two requests can both pass it — and it is worth having anyway, because
    // the race is rare and the case it catches is not: the same name submitted twice. What makes
    // the race safe is `shares_name_unique`, which folds case the way SMB clients do and turns the
    // loser into a 409 rather than a second share nobody can address.
    await this.db.withTenant(organizationId, (q) => assertShareNameFree(q, input.name));

    const created = await this.agent.call(
      {
        op: 'create_dataset',
        dataset,
        // The only variant the operation set can express. P0-B measured `nfsv4` reporting itself
        // as configured while enforcing nothing, which is why this is a constant here rather than
        // a field on the request body.
        acltype: 'posixacl',
        // `refquota`, not `quota`: it excludes snapshots, so an administrator's snapshot policy
        // cannot lock a user out of their own space (ADR-0008).
        refquota_bytes: input.quotaBytes,
      },
      `create share '${input.name}' on ${dataset}`,
      correlationId,
    );
    // A dataset already at that path. Reported as the name being taken rather than as an agent
    // refusal, because that is what it means to the person who typed it — and it is reachable
    // without a race: a share deleted from the database leaves its dataset behind, since nothing
    // in the product can destroy one.
    if (created.status === 'conflict') throw new ShareNameTakenError(input.name, 'pool');
    expectStatus(created, 'created');

    const row = await this.db.withTenant(organizationId, async (q) => {
      const applied: readonly GrantInput[] =
        grants ??
        (await (async () => {
          const everyone = await q.query<{ id: string }>(
            `SELECT public.everyone_team($1)::text AS id`,
            [organizationId],
          );
          const everyoneId = everyone[0]?.id;
          if (everyoneId === undefined) throw new Error('everyone_team() returned no row');
          return [
            { userId: actorId, teamId: null, permissions: [...ALL_PERMISSIONS] },
            {
              userId: null,
              teamId: everyoneId,
              permissions: ['list', 'read', 'download'] as GrantInput['permissions'],
            },
          ];
        })());
      await assertPrincipalsInOrganization(q, organizationId, applied);

      const inserted = await q.query<ShareRow>(
        `INSERT INTO public.shares (organization_id, name, dataset, read_only)
              VALUES ($1, $2, $3, $4)
           RETURNING id::text AS id, name, dataset, read_only`,
        [organizationId, input.name, dataset, input.readOnly],
      );
      const share = inserted[0];
      if (share === undefined) throw new Error('the share row was not returned');

      // `entry_id` NULL is the share root: the convention `folder_grants` uses everywhere, and the
      // node `AclApplyService` walks down from.
      for (const grant of applied) {
        await q.query(
          `INSERT INTO public.folder_grants
             (organization_id, share_id, entry_id, user_id, team_id, permissions, granted_by)
           VALUES ($1, $2, NULL, $3, $4, $5::public.folder_permission[], $6)`,
          [organizationId, share.id, grant.userId, grant.teamId, [...grant.permissions], actorId],
        );
      }

      return share;
    });

    // ── YENİ PAYLAŞIMIN DİZİN ZİNCİRİ, ŞİMDİ ────────────────────────────────────────────────
    //
    // Uzlaştırma yürüyüşü yalnız API AÇILIŞINDA tohumlanıyordu — o an var olan paylaşımlar için.
    // Sonradan açılan bir paylaşımın hiç zinciri olmuyordu, yani o paylaşıma ağ sürücüsünden
    // yazılan dosyalar API yeniden başlayana kadar hiç indekslenmiyordu.
    //
    // Yedek zincirlerinde aynı hata vardı ve aynı şekilde onarıldı: kuran uç, kurduğu anda
    // tohumluyor.
    //
    // HATA YUTULUYOR: paylaşım oluşturuldu ve satırı yazıldı; kuyruğa yazamamak onu geri almak
    // için sebep değil, ve bir sonraki açılış zaten tohumluyor.
    try {
      await this.jobs.enqueue(organizationId, RECONCILE_KIND, { shareId: row.id });
    } catch (error) {
      this.logger.error(
        `'${row.name}' için dizin yürüyüşü tohumlanamadı: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      share: {
        ...row,
        unc_path: uncPath(this.smbHost, row.name),
        // Creating a share does not publish it — `POST /system/smb` does — so nothing is being
        // served yet and saying otherwise would send someone to type an address that does not
        // answer. False here for the same reason it is false after a restart.
        published: false,
      },
      applyingJobId: await this.enqueueApply(organizationId, row.id),
    };
  }

  /**
   * Queue the POSIX apply for a new share's root, or report honestly that it did not happen.
   *
   * The same shape as `PermissionsService.enqueueApply` and `TeamsService.applyToShares`, and the
   * same reasoning: the grant is already committed, so an unreachable agent is a divergence to
   * REPORT rather than an error to fail the request with. A null here means the row and the grant
   * are real and the kernel has not been told — for a brand-new share, a directory sitting there
   * with whatever ACL ZFS gave it and nobody reaching it over SMB.
   */
  private async enqueueApply(organizationId: string, shareId: string): Promise<string | null> {
    // Unconditionally, for the reason `PermissionsService.enqueueApply` sets out at length: this
    // writes a queue row and nothing else, the worker is what needs the agent, and
    // `agent.isAvailable()` is a startup latch that never recovers. Guarding here meant a share
    // created during an agent restart never had an ACL written for it at all.
    try {
      return await this.jobs.enqueue(
        organizationId,
        APPLY_ACL_KIND,
        { shareId, entryId: null },
        { maxAttempts: APPLY_ACL_MAX_ATTEMPTS },
      );
    } catch (error) {
      this.logger.error(
        `share ${shareId} and its root grant were written but the apply job could not be queued: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * The tenant's shares.
   *
   * `withTenant`, so RLS decides what is visible rather than a WHERE clause anyone could forget.
   */
  async list(organizationId: string): Promise<ShareListing> {
    let rows = await this.rows(organizationId);

    // ── ASKIDA KALMIŞ PAYLAŞIMLAR BURADA DA SAHİPLENİLİYOR ─────────────────────────────────
    //
    // Sahiplenmenin tek kancası "yayımla" düğmesiydi, ve sahada bunun bedeli şu oldu: depolama
    // hazır olmadan kurulan bir paylaşımın satırı yazıldı, veri kümesi hiç oluşmadı, ve ürün
    // bunu ancak kullanıcı kendiliğinden "yeniden yayımla" deyene kadar fark etmedi. Arada
    // dosya yüklemeyi deneyen kullanıcı "beklenmeyen bir hata" gördü — ajan `no such file`
    // diyordu, çünkü paylaşım diskte gerçekten yoktu.
    //
    // BU EKRAN, KUSURUN GÖRÜLDÜĞÜ EKRAN. Paylaşımlar listesi hem sorunun belirtisinin çıktığı
    // hem de kullanıcının çözüm arayacağı yer; onarımı buraya bağlamak, kullanıcıdan gizli bir
    // adım bilmesini istememek demek.
    //
    // KOŞULLU, ve koşul bir veritabanı sorgusu değil: satırlar zaten elde. Askıda bir satır
    // yoksa — olağan hâl — fazladan tek bir çağrı bile yapılmıyor, yani liste okuması bir
    // yazma yoluna dönüşmüyor.
    if (rows.some((row) => !row.dataset.includes('/'))) {
      try {
        if ((await this.adoptPendingShares(organizationId, randomUUID())) > 0) {
          rows = await this.rows(organizationId);
        }
      } catch (error) {
        // SAHİPLENME DÜŞERSE LİSTE YİNE GELİYOR. Depolama hâlâ hazır değilse — havuz yok, ZFS
        // yüklenemiyor — onarım yapılamaz; ama o durumda paylaşımları hiç gösterememek,
        // kullanıcıyı bir kusurun üstüne ikinci bir kusurla oturtmak olurdu.
        this.logger.warn(
          `askıda paylaşımlar sahiplenilemedi: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // `isAvailable()` is the startup handshake's verdict and is not refreshed per request, so an
    // agent that died an hour ago still reads as reachable. It is still the right input: the
    // alternative is a `ping` on every list, which puts an agent round trip in front of a page
    // that is mostly database, and the failure it would catch is already visible the moment
    // anybody publishes.
    const smbAvailable = this.agent.isAvailable() && this.smbInstalled !== 'no';

    return {
      smbAvailable,
      items: rows.map((row) => ({
        ...row,
        unc_path: uncPath(this.smbHost, row.name),
        // The contract's invariant, enforced rather than assumed: `smbAvailable: false` means every
        // `published` is false. When the agent is unreachable the cache may well still describe
        // shares smbd is serving — smbd does not depend on the agent — but a page that says
        // "Samba is not available" beside a share marked "published" is a page nobody can act on.
        published: smbAvailable && this.publishedShareIds.has(row.id),
      })),
    };
  }

  /**
   * Write the Samba configuration for THIS DEVICE, and prove it.
   *
   * The hazard this method spends most of its length on: `PublishSambaConfig` replaces the whole
   * generated file. The agent renders exactly the shares it is given and nothing else, so a list
   * filtered to one tenant does not add that tenant's shares — it DELETES every other tenant's.
   * One organisation clicking republish would take another organisation's drives offline, and the
   * two would not even be able to see each other in order to understand what happened.
   *
   * The correct list is therefore every share on the box, which needs an untenanted read. That is
   * not available: `UntenantedJustification` is a closed union and ADR-0015 §1 requires a new
   * member to be a decision written into the ADR, not a string added in passing.
   *
   * So this refuses instead. `resolve_sole_organization()` returns an id only when the box holds
   * exactly one organisation — the state `OrganizationsService` documents as the one a claimed
   * appliance is always in, because `system_setup` is a singleton — and in that state the tenant's
   * shares ARE the device's shares and the publish is safe. Anything else is refused with the
   * reason, which is the behaviour to want on the day the assumption stops holding: a loud refusal
   * rather than a tenant discovering their shares vanished when somebody else pressed a button.
   *
   * A consequence worth stating: because there is exactly one organisation, the device-wide
   * uniqueness of `smb.conf` section names is already guaranteed by `shares_name_unique`, which
   * folds case per organisation exactly as SMB clients do. There is no collision check below
   * because in the only state this method proceeds in, a collision cannot exist — and in the
   * states where it could, the method has already refused.
   */
  async publish(
    organizationId: string,
    correlationId: string,
  ): Promise<{ shares: number; verified: boolean }> {
    const soleId = await this.organizations.resolveSoleId();
    if (soleId === null || soleId !== organizationId) {
      this.logger.warn(
        'refusing to publish the Samba configuration: the device does not hold exactly one ' +
          "organisation, so this tenant's share list is not the whole device and publishing it " +
          'would unpublish everyone else',
      );
      throw new ShareListNotDeviceWideError();
    }

    // ÖNCE BEKLEYEN SATIRLARI SAHİPLEN. Havuzdan önce açılmış bir paylaşım satırı çıplak bir ad
    // taşıyor, ve ajan onu `zfs get mountpoint <ad>` ile sorduğunda yayının TAMAMI düşüyor — tek
    // bozuk satır yüzünden kutudaki hiçbir paylaşım sunulmuyor. Sahada görülen buydu, ve
    // kullanıcının elindeki tek düğme zaten bu: "Yeniden yayımla".
    await this.adoptPendingShares(organizationId, correlationId);

    const rows = await this.rows(organizationId);
    for (const row of rows) {
      if (RESERVED_SECTIONS.some((reserved) => reserved.toLowerCase() === row.name.toLowerCase())) {
        // Before the agent is called, so a name the database accepted and Samba cannot express
        // never becomes a failed publish for every other share on the box.
        throw new UnpublishableShareError(
          row.name,
          "it is a reserved smb.conf section name and would rewrite the server's own settings",
        );
      }
    }

    const principals = await this.validUsers(organizationId);
    const request: AgentRequest = {
      op: 'publish_samba_config',
      shares: rows.map((row) => ({
        name: row.name,
        dataset: row.dataset,
        read_only: row.read_only,
        valid_users: principals.get(row.id) ?? [],
      })),
    };

    const response = await this.agent.call(
      request,
      `publish ${rows.length} samba share(s) for organization ${organizationId}`,
      correlationId,
    );

    if (response.status === 'smb_unavailable') {
      // Nothing is being served, so nothing may be reported as published. Clearing here is what
      // keeps the list honest after Samba is uninstalled under a running appliance.
      this.smbInstalled = 'no';
      this.publishedShareIds = new Set();
      // Logged rather than shown: the agent names the missing binary, which is the detail an
      // operator needs and a user cannot act on. `agentReason` rides along on the error for the
      // same reason `AgentRefusedError` carries one — so a caller that wants it has it.
      this.logger.warn(`samba is not available on this box: ${response.reason}`);
      throw new SmbUnavailableError(response.reason);
    }

    if (response.status === 'refused') {
      // The agent rolled back, so whatever was being served still is: the cache is left ALONE
      // rather than cleared. Clearing it would report every working share as unpublished because
      // an unrelated new share had a bad mountpoint.
      this.logger.warn(`samba publish refused by the agent: ${response.reason}`);
      throw new AgentRefusedError(response.reason);
    }

    if (response.status === 'failed') {
      // NOT the branch above, and the difference is the whole point of separating them. `refused`
      // is the agent's word for "Samba said no and the previous configuration is back" — it maps
      // to `SambaError::RejectedRolledBack`, and every sentence `describeRefusal` returns ends by
      // promising exactly that. `failed` is everything else, and the outcome it exists to carry is
      // `SambaError::RollbackFailed`: the new configuration was rejected AND putting the old one
      // back also failed, which the agent describes as SMB being down until somebody repairs the
      // file by hand. Answering that with "the previous one has been put back, so shares that were
      // working still are" is the one lie this endpoint must never tell, because it is told at the
      // exact moment an operator needs to go and look.
      //
      // The cache is cleared here where the refusal leaves it alone. After a `failed` nothing on
      // this box may be claimed as served: `published: false` withholds, and the recovery from a
      // false `false` is one click on republish while the recovery from a false `true` is an
      // administrator being told their shares are fine while Explorer shows nothing.
      this.publishedShareIds = new Set();
      this.logger.error(
        `samba publish FAILED and the previous configuration may not have been restored: ` +
          `${response.reason}`,
      );
      throw new SmbPublishFailedError(response.reason);
    }

    if (response.status !== 'published') {
      throw new AgentUnavailableError(
        `expected a 'published' answer, the agent answered '${response.status}'`,
      );
    }

    // Only now, and only from a response that carries `verified`. The agent never returns
    // `verified: false` — a publish it cannot prove rolls back and comes back as a refusal — but
    // the field is in the contract precisely so a client can tell "a file was written" from
    // "a client connected and saw the shares", and treating it as decoration here would be the
    // API deciding that distinction does not matter.
    this.smbInstalled = 'yes';
    this.publishedShareIds = response.verified ? new Set(rows.map((row) => row.id)) : new Set();

    return { shares: response.shares, verified: response.verified };
  }

  /**
   * Who may connect to each share at all, as `smb.conf` spells it.
   *
   * §6.2 asks for SMB access to follow the same grants as the API, and until now it did not: the
   * generated file had no `valid users`, so every principal the operator's `[global]`
   * authenticated could connect to every DEPSIS share. The POSIX ACL still decided what they could
   * read once inside, but the share list itself, and every folder whose ACL had not been applied
   * yet, was open.
   *
   * WHY THE UNION AND NOT THE ROOT. A grant can sit on any folder in the tree, and somebody granted
   * three levels down has no grant at the root — narrowing to root grants would shut them out of a
   * share the ACL admits them to. The set below is every principal named in any grant anywhere in
   * the share, which is precisely the set `AclApplyService` turns into ACL entries: same table,
   * same filter, so the two cannot come to disagree about who exists. `valid users` can only
   * narrow, never widen, so being a superset of what the ACL permits is the safe direction and
   * this is exactly that superset.
   *
   * Two deliberate exclusions:
   *
   *   * A DISABLED account. `IdentitySyncService` already leaves them out of the POSIX user list,
   *     and their NT hash stays in tdbsam until Samba is told otherwise — so leaving the name off
   *     this line is the only thing standing between a disabled account and its files. It narrows,
   *     which is the safe direction.
   *   * A team with no `posix_gid`. There is no group name to write. `AclApplyService.gidFor`
   *     skips the same rows for the same reason, and `Teams.tsx` shows the team as not reaching
   *     the filesystem, so the state is visible rather than silent.
   *
   * A user with no `posix_uid` IS included. The Unix account may not exist yet — identity sync
   * allocates on first need — and an unmatched name in `valid users` matches nobody and takes
   * nothing down (measured in `tools/poc/p2-a-smb-identity.sh`). Omitting them would instead
   * create an ordering trap where a publish before a sync silently locks out a real user.
   */
  private async validUsers(organizationId: string): Promise<Map<string, SmbPrincipal[]>> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ share_id: string; username: string | null; posix_gid: number | null }>(
        `SELECT DISTINCT g.share_id::text AS share_id, u.username, t.posix_gid
           FROM public.folder_grants g
           LEFT JOIN public.users u
             ON u.id = g.user_id AND u.disabled_at IS NULL
           LEFT JOIN public.teams t
             ON t.id = g.team_id AND t.posix_gid IS NOT NULL
          WHERE g.organization_id = $1
          ORDER BY g.share_id::text, u.username NULLS LAST, t.posix_gid`,
        [organizationId],
      ),
    );

    const byShare = new Map<string, SmbPrincipal[]>();
    for (const row of rows) {
      const principal: SmbPrincipal | null =
        row.username !== null
          ? { kind: 'user', name: row.username }
          : row.posix_gid !== null
            ? { kind: 'group', name: `depsis-t-${row.posix_gid}` }
            : null;
      // Null on both sides is a grant to a disabled user or a gidless team — the LEFT JOINs above
      // turn each of those into a row with nothing to write, which is the filter, not a bug.
      if (principal === null) continue;
      const list = byShare.get(row.share_id);
      if (list === undefined) byShare.set(row.share_id, [principal]);
      else list.push(principal);
    }
    return byShare;
  }

  /**
   * Veri kümesi olmayan paylaşım satırlarını, depolama gerçek olur olmaz SAHİPLENİR.
   *
   * ── HAYALET SATIR NEREDEN ÇIKIYOR ────────────────────────────────────────────────────────
   *
   * `FilesService`, bir kuruluşun ilk paylaşımını dosya yöneticisi ilk açıldığında TEMBEL olarak
   * yaratıyor. O an cihazda havuz yoksa yazacak bir veri kümesi adı da yok, ve satır çıplak adla
   * (`ev`) yazılıyor. Bu, ZFS'siz kutularda (geliştirme, e2e) doğru davranış — orada paylaşımlar
   * düz dizin ve satır böyle çalışıyor.
   *
   * Ama gerçek bir cihazda o satır KALICI OLARAK BOZUK kalıyordu, ve sahadaki ilk kurulumda tam
   * bu oldu: sahibi sihirbazı bitirmeden dosya yöneticisini açtı (06:12), havuzu yedi dakika
   * sonra kurdu (06:19), ve aradaki satır cihazı şu hâle getirdi —
   *
   *   yükleme  → ajan reddediyor: `no such file: ev`
   *   yayımlama → `zfs get mountpoint ev` → `dataset does not exist`, ve YAYININ TAMAMI düşüyor,
   *               yani tek bozuk satır yüzünden kutudaki hiçbir paylaşım sunulmuyor.
   *
   * Arayüzden çıkış yolu yoktu: paylaşımı silmek de, veri kümesini sonradan kurmak da mümkün
   * değildi. Kodun kendi yorumu bu pencereyi "kurulumun ilk dakikalarıyla sınırlı" diye kabul
   * ediyordu; sınırlı olması, içine düşen cihazın kurtulabildiği anlamına gelmiyor.
   *
   * ── ÇÖZÜM: BEKLEYEN SATIR, BOZUK SATIR DEĞİL ─────────────────────────────────────────────
   *
   * Depolama gerçek olduğu anda o satırlar gerçek oluyor. Veri kümesi kuruluyor, satır
   * güncelleniyor, ve paylaşım hiçbir şey kaybetmeden — adı, izinleri ve kimliği aynı kalarak —
   * çalışır hâle geliyor.
   *
   * ZFS'SİZ KUTUYU BOZMUYOR, ve koruma tek satır: `parentDataset` orada `null` döner (paylaşım
   * kökünde bağlı bir veri kümesi yok), ve bu işlev hiçbir şey yapmadan çıkar. Yani çıplak adı
   * doğru olan kutularda hiç çalışmıyor.
   *
   * ── NEDEN KANCASI `publish` ──────────────────────────────────────────────────────────────
   *
   * Doğal an paylaşım ağacının kurulduğu an gibi görünüyor, ama `ShareTreeController` bunu
   * çağıramaz: `SharesModule` zaten `SystemModule`'ü içeri alıyor (yeni veri kümelerinin nereye
   * gideceğini ona soruyor), ve ters yön bir çevrim olurdu. `publish` hem çevrim yaratmıyor hem
   * de kullanıcının o an bastığı düğme: bozuk satırın belirtisi zaten "yayımlanmadı".
   */
  async adoptPendingShares(organizationId: string, correlationId: string): Promise<number> {
    const parent = await this.parentDataset(correlationId);
    if (parent === null) return 0;

    const rows = await this.rows(organizationId);
    // Bir veri kümesi adı her zaman `havuz/…/ad` — eğik çizgisi olmayan bir değer bir veri kümesi
    // adı değil, yazıldığı gün ebeveyn bilinmediği için kalan çıplak paylaşım adıdır.
    const pending = rows.filter((row) => !row.dataset.includes('/'));
    if (pending.length === 0) return 0;

    for (const row of pending) {
      const dataset = `${parent}/${row.name}`;
      const made = await this.agent.call(
        { op: 'create_dataset', dataset, acltype: 'posixacl', refquota_bytes: null },
        `adopt the pending share '${row.name}' onto ${dataset}`,
        correlationId,
      );
      // `conflict` — veri kümesi zaten var. Satırın işaret etmesi gereken yer tam orası, yani
      // bu bir hata değil sahiplenmenin yarısının önceden yapılmış olması.
      if (made.status !== 'conflict') expectStatus(made, 'created');

      await this.db.withTenant(organizationId, (q) =>
        q.query(`UPDATE public.shares SET dataset = $1, updated_at = now() WHERE id = $2::uuid`, [
          dataset,
          row.id,
        ]),
      );
      this.logger.log(`adopted the pending share '${row.name}' onto ${dataset}`);
    }
    return pending.length;
  }

  private async rows(organizationId: string): Promise<ShareRow[]> {
    return this.db.withTenant(organizationId, (q) =>
      q.query<ShareRow>(
        `SELECT id::text AS id, name, dataset, read_only
           FROM public.shares
          ORDER BY public.fold_identity(name), id`,
      ),
    );
  }
}

/**
 * Refuse a share name the tenant is already using.
 *
 * Case-folded through `fold_identity`, which is what `shares_name_unique` indexes on — so this
 * asks the same question the constraint will. A plain `name = $1` would pass `Belgeler` beside an
 * existing `belgeler` and let the INSERT fail instead, which is the same outcome by a worse route:
 * the dataset would already have been created by then, and nothing in the product can remove it.
 *
 * The Turkish i-family folds here too, and that is not incidental — `İSTANBUL` and `istanbul` are
 * one name to an SMB client, and two shares a Windows user cannot tell apart is precisely what the
 * fold exists to prevent.
 */
async function assertShareNameFree(q: TenantQuery, name: string): Promise<void> {
  const taken = await q.query<{ id: string }>(
    `SELECT id::text AS id FROM public.shares WHERE public.fold_identity(name) = public.fold_identity($1)`,
    [name],
  );
  if (taken.length > 0) throw new ShareNameTakenError(name, 'database');
}

/**
 * Every principal in the grant list must belong to THIS organisation.
 *
 * The same check `PermissionsService.write` makes, for a reason worth stating rather than
 * inheriting: a foreign key does NOT enforce it. `folder_grants.user_id` references
 * `public.users(id)` and referential integrity is checked by the system, below row level security
 * — so a grant naming a user in another tenant inserts cleanly, and the row would then be a
 * cross-tenant permission that RLS hides from everyone who could notice it.
 *
 * Missing and foreign are deliberately the same answer. Telling a caller "that id exists but not
 * here" confirms the existence of another tenant's user, which is the leak the whole model is
 * built to prevent.
 */
async function assertPrincipalsInOrganization(
  q: TenantQuery,
  organizationId: string,
  grants: readonly GrantInput[],
): Promise<void> {
  const userIds = grants.map((g) => g.userId).filter((id): id is string => id !== null);
  const teamIds = grants.map((g) => g.teamId).filter((id): id is string => id !== null);

  const missing: string[] = [];
  if (userIds.length > 0) {
    const found = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM public.users WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, userIds],
    );
    const seen = new Set(found.map((row) => row.id));
    missing.push(...userIds.filter((id) => !seen.has(id)));
  }
  if (teamIds.length > 0) {
    const found = await q.query<{ id: string }>(
      `SELECT id::text AS id FROM public.teams WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, teamIds],
    );
    const seen = new Set(found.map((row) => row.id));
    missing.push(...teamIds.filter((id) => !seen.has(id)));
  }

  if (missing.length > 0) throw new UnknownGrantPrincipalError(missing);
}

/**
 * `\\host\share`, the string a person types into Explorer.
 *
 * Assembled from two values that are both already constrained — `DEPSIS_SMB_HOST` by the config
 * schema, `name` by `shares_name_format` — so this does no escaping. There is no escaping to do: a
 * UNC path has no quoting rules, and a name that needed some would be a name neither the database
 * nor the agent would have accepted in the first place.
 */
export function uncPath(host: string, shareName: string): string {
  return `\\\\${host}\\${shareName}`;
}

/**
 * The agent's refusal, as a sentence for a person.
 *
 * Reached ONLY for `Response::Refused`, which the agent returns for `RejectedRolledBack` and
 * `Unrepresentable` — the two outcomes in which the previous configuration is provably still in
 * place. `Response::Failed` does not come here, because the promise every branch below makes is
 * the one thing that is false when a rollback fails.
 *
 * This reads the agent's prose, which everywhere else in this codebase is the thing not to do —
 * `Response::NotFound` and `Response::Conflict` exist as separate variants specifically so the API
 * does not match on text. The exception is deliberate and narrow: nothing here BRANCHES on the
 * prose. The HTTP status comes from the response's `status` alone; this function only chooses
 * which sentence to show, and every branch says the same operationally important thing — the
 * previous configuration is back and the shares that worked still work.
 *
 * The one cause worth naming is the missing `include` line, because it is both the most likely
 * refusal on a fresh install and the only one the reader can fix in ten seconds. Without it they
 * are told "Samba said no" and given a journal to go and read.
 *
 * What would remove this function: a machine-readable reason on `Response::Refused` for this
 * operation. That is a change to the Rust-side contract, so it is noted rather than made.
 */
export function describeRefusal(agentReason: string): string {
  if (agentReason.includes('include =')) {
    return (
      'Samba is running but has never read the configuration DEPSIS writes. Add the line ' +
      '`include = /etc/samba/depsis.conf` to /etc/samba/smb.conf and reload smbd, then try again. ' +
      'The previous configuration has been put back, so shares that were working still are.'
    );
  }
  if (agentReason.includes('cannot be shared') || agentReason.includes('cannot be written')) {
    return (
      'One of the shares cannot be expressed as a Samba share — usually a dataset with no ' +
      'mountpoint, or one mounted somewhere Samba will not serve. Nothing was changed and the ' +
      'previous configuration is still in place.'
    );
  }
  return (
    'Samba did not accept the new configuration. The previous one has been put back, so shares ' +
    'that were working still are. The agent recorded the reason in the system journal.'
  );
}
