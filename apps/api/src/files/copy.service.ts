import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import { AgentService } from '../agent/agent.service.js';
import { DbService } from '../db/db.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';
import {
  assertWritable,
  FilesService,
  permissionsOf,
  type Caller,
  type ShareRef,
} from './files.service.js';

/** What one `files.copy` job was asked to do. */
export interface CopyPayload {
  shareId: string;
  sourceIds: string[];
  destinationId: string | null;
  /**
   * Who asked. NOT a uid pair, and NOT a role.
   *
   * `FilesService.createFolder` resolves the uid itself, allocating on first need; carrying numbers
   * would be a second answer to "who owns this", written at enqueue time and used minutes later.
   * The role is deliberately absent too — it is re-read from `users` when the job runs, so an
   * administrator demoted between the click and the copy does not keep their reach.
   */
  actorId: string;
}

/** What one `files.restore-snapshot` job was asked to do. */
export interface RestorePayload {
  shareId: string;
  /** The snapshot's own name — the part after `@`. */
  snapshot: string;
  /** The file to read, relative to the SNAPSHOT's root. The last element is its name. */
  from: string[];
  /** The live folder it lands in, or null for the share root. */
  destinationId: string | null;
  /** The name it lands under. Chosen at enqueue time and shown to the user before they agree. */
  name: string;
  /** Who asked. Re-read when the job runs, for the reason `CopyPayload.actorId` gives. */
  actorId: string;
}

/** What the job accomplished. */
export interface CopyProgress {
  copied: number;
  skipped: number;
  refused: number;
  total: number;
}

interface Node {
  id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  size_bytes: string;
  content_type: string | null;
}

/** Tells the caller how far along the operation is, and answers whether it still holds the job. */
export type CopyReport = (fraction: number) => Promise<boolean>;

/** The dataset is full. Permanent — a retry would only park more bytes against the same quota. */
export class CopyOutOfSpaceError extends Error {
  constructor(reason: string) {
    super(`no space for the copy: ${reason}`);
    this.name = 'CopyOutOfSpaceError';
  }
}

/** Something holds the destination name on disk that DEPSIS has no row for. */
export class CopyDestinationOccupiedError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} exists on the filesystem but not in DEPSIS; remove it over SMB and run the copy again`,
    );
    this.name = 'CopyDestinationOccupiedError';
  }
}

/** The selection is larger than this operation will attempt. */
export class CopyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`a copy of more than ${limit} entries is refused`);
    this.name = 'CopyTooLargeError';
  }
}

/** A thousand files called `rapor (n).pdf` already sit in the destination. */
export class CopyNameExhaustedError extends Error {
  constructor(readonly wanted: string) {
    super(`could not find a free name for ${wanted}`);
    this.name = 'CopyNameExhaustedError';
  }
}

/**
 * `POST /file-operations`, the copy half.
 *
 * WHY THE WALK IS HERE AND NOT IN THE WORKER. The same argument `worker-surface.ts` makes for
 * `AclApplyService`: the tree lives in `file_entries` and the rules for reading it are written
 * once, in the API package, and the worker imports them. A second walk in the worker would be a
 * second answer to "what is in this folder", and the two would drift with neither looking wrong.
 *
 * ONE `CopyFile` PER SLICE, ONE `CreateDirectory` PER FOLDER. The agent has no recursive copy and
 * must not get one (§2.2, ADR-0006: no single call may have a blast radius the caller chooses) —
 * and no single call may be made LONG either, because the control socket is served one connection
 * at a time, so a large file travels as a sequence of bounded slices. The loop is here, which is
 * also what makes progress reportable.
 *
 * ONE JOB, NOT A CHAIN. An earlier version queued a successor per chunk and was wrong twice over:
 * the caller holds the FIRST job's id, so that job reported `succeeded` while most of the work had
 * not happened and a later chunk's death was invisible; and the list of finished ids travelled in
 * the payload, which for a hundred thousand entries is gigabytes of jsonb rewritten per chunk.
 * This runs the whole operation in one job and calls `report` between nodes, which is also what
 * extends the lease.
 *
 * IDENTITY IS THE LINK, NEVER THE NAME. `copied_from_entry_id` (migration 0022) is written in the
 * same statement as every row this creates, for folders as well as files. Asking "have I already
 * copied this here?" by name cannot work: `keep_both` derives the name from what the destination
 * holds, and the first attempt is exactly what changed that. An adversarial review found the
 * folder half still on names — a folder the user ALREADY had in the destination was
 * indistinguishable from one this job created, so the copy merged into it and `docs (2)` was
 * unreachable code.
 */
@Injectable()
export class CopyService {
  /**
   * The largest tree this will copy.
   *
   * Not a performance bound — a refusal. A copy is one of two operations in the product that can
   * multiply stored bytes without a single upload, and a user who selects the share root should be
   * told the number rather than discovering it as a full dataset an hour later. Checked at the
   * ENDPOINT as well, because a deterministic refusal discovered in the worker is one the queue
   * retries and then reports `dead` to nobody.
   */
  static readonly MAX_ENTRIES = 100_000;

  /**
   * How much of a file to ask for per agent call.
   *
   * The agent clamps this to its own `MAX_COPY_SLICE`; the number here is the API's view of how
   * long it is willing to hold the appliance's single control connection.
   */
  static readonly SLICE_BYTES = 64 * 1024 * 1024;

  private readonly logger = new Logger(CopyService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly files: FilesService,
    private readonly posix: PosixIdentityService,
  ) {}

  /**
   * How many entries a request would copy, before the caller is told it started.
   *
   * The endpoint calls this; the worker does not. A refusal the user sees as a 422 on the click is
   * worth an extra query, where the same refusal thrown in the worker is a job that retries a
   * deterministic failure and then reports `dead` to nobody.
   */
  async size(
    organizationId: string,
    shareId: string,
    sourceIds: readonly string[],
  ): Promise<{ entries: number; bytes: number }> {
    const plan = await this.plan(organizationId, shareId, sourceIds);
    return {
      entries: plan.length,
      bytes: plan.reduce((total, node) => total + Number(node.size_bytes), 0),
    };
  }

  /**
   * What the pool has left, or `null` when the agent cannot say.
   *
   * `null` and not a throw, because this is a courtesy check and not a guarantee. It cannot be a
   * guarantee under concurrency — another upload can take the space between the answer and the
   * copy, which is exactly why the agent classifies `ENOSPC`/`EDQUOT` into its own response as
   * well. What it converts is the common case: a user duplicating 400 GB onto a pool with 200 GB
   * free is told the two numbers immediately instead of watching a job fail an hour later with
   * half a tree copied.
   */
  async availableBytes(dataset: string, reason: string): Promise<number | null> {
    // The POOL, not the dataset: `zfs get available` on a dataset already accounts for its
    // refquota, and the pool name is its first component.
    const pool = dataset.split('/')[0] ?? dataset;
    try {
      const response = await this.agent.call({ op: 'pool_status', pool }, reason);
      return response.status === 'pool_status' ? response.available_bytes : null;
    } catch {
      // An unreachable agent must not block a copy from being QUEUED. The job itself will refuse
      // for the same reason a moment later, and with a better message.
      return null;
    }
  }

  /** Copy everything the payload names. Runs to completion; `report` keeps the lease alive. */
  async copy(
    organizationId: string,
    payload: CopyPayload,
    report: CopyReport,
    reason: string,
  ): Promise<CopyProgress> {
    const share = await this.files.shareFor(organizationId, payload.shareId);
    // İş kuyruğa girdikten SONRA paylaşım salt okunura çevrilmiş olabilir. Uç zaten reddediyor;
    // burası o pencereyi kapatıyor ve iş sessizce yarım bir ağaç bırakmak yerine açıklamalı
    // düşüyor.
    assertWritable(share);
    const ref: ShareRef = { id: share.id, name: share.name };
    const caller = await this.caller(organizationId, payload.actorId);
    const ownerUid = await this.posix.posixUidFor(organizationId, payload.actorId);

    const plan = await this.plan(organizationId, payload.shareId, payload.sourceIds);
    if (plan.length > CopyService.MAX_ENTRIES) throw new CopyTooLargeError(CopyService.MAX_ENTRIES);

    // §6.2 for EVERY node, not only the ones the caller named. ADR-0021 lets a subfolder NARROW
    // what its parent grants, so a caller with `download` on a folder may have none on something
    // inside it — and a walk that checked only the roots would copy it into a folder they control,
    // which is exfiltration with the product's own hands. Re-checked here rather than trusted from
    // the endpoint, because the job runs later and a grant may have been revoked meanwhile.
    const allowed = await this.readable(caller, payload.shareId, plan);

    /** Where each copied folder ended up, keyed by SOURCE id. Per run: the service is a singleton. */
    const placed = new Map<string, string | null>();

    let copied = 0;
    let skipped = 0;
    let refused = 0;

    for (const [index, node] of plan.entries()) {
      if (!(await report(index / Math.max(1, plan.length)))) {
        this.logger.warn(`lost the lease part-way through ${reason}; stopping`);
        break;
      }

      // REDDEDİLEN BİR KLASÖRÜN ALTI DA REDDEDİLİR, ve bunu söyleyen şey `placed`: plan
      // genişlik-öncelikli olduğu için bir düğüme sıra geldiğinde ebeveyninin kopyası ya
      // yapılmıştır ya da ebeveyn reddedilip hiç yapılmamıştır. İkinci durumda `destinationParent`
      // "klasörün kopyası çocuğundan önce yapılmadı" diye hata fırlatıyordu: hata işi ORTASINDA
      // öldürüyor, beş deneme de aynı yerde düşüyor ve kullanıcı yarım bir kopyayla açıklamasız
      // bir `dead` iş görüyordu.
      //
      // Ulaşılabilir bir durum: ADR-0021 daraltmasıyla bir klasörde `list`i olmayan birinin
      // içindeki dosyada `download`u olabiliyor — o zaman klasör reddedilir, dosya izinlidir.
      // Doğru cevap alt ağacı hedef köküne taşımak değil, onu da reddedilenlere saymak.
      const parentRefused =
        !payload.sourceIds.includes(node.id) &&
        node.parent_id !== null &&
        !placed.has(node.parent_id);
      if (!allowed.has(node.id) || parentRefused) {
        // Skipped, not fatal. A tree with one unreadable file in it should still copy the rest, and
        // the count comes back so the job's log says how many were left behind.
        refused += 1;
        continue;
      }

      const outcome = await this.one(organizationId, ref, node, payload, ownerUid, placed, reason);
      if (outcome === 'copied') copied += 1;
      else skipped += 1;
    }

    await report(1);
    if (refused > 0) {
      this.logger.warn(`${refused} of ${plan.length} entries were not readable by the requester`);
    }
    return { copied, skipped, refused, total: plan.length };
  }

  /**
   * Everything to create, parents before children, each node once.
   *
   * Breadth-first from the sources. The order is the whole correctness of the operation:
   * `CreateDirectory` refuses to `mkdir -p`, so a file whose parent has not been made yet comes
   * back `not_found`.
   *
   * DEDUPED BY ID. Selecting a folder AND something inside it is an ordinary thing to do with a
   * mouse, and without this the inner node appears twice — once as a root and once as a
   * descendant. Worse, its membership of `sourceIds` made it resolve to the destination root both
   * times, lifting it out of the tree it was copied with, and the plan never shrank so the job
   * re-enqueued itself forever.
   */
  private async plan(
    organizationId: string,
    shareId: string,
    sourceIds: readonly string[],
  ): Promise<Node[]> {
    const seen = new Set<string>();
    const steps: Node[] = [];
    let frontier = await this.nodes(organizationId, shareId, sourceIds);

    while (frontier.length > 0) {
      const fresh = frontier.filter((node) => !seen.has(node.id));
      for (const node of fresh) {
        seen.add(node.id);
        steps.push(node);
      }
      if (steps.length > CopyService.MAX_ENTRIES) {
        throw new CopyTooLargeError(CopyService.MAX_ENTRIES);
      }
      const folders = fresh.filter((node) => node.kind === 'folder');
      if (folders.length === 0) break;
      frontier = await this.childrenOf(
        organizationId,
        folders.map((node) => node.id),
      );
    }

    return steps;
  }

  /** One node: a directory to create, or a file to copy. */
  private async one(
    organizationId: string,
    share: ShareRef,
    node: Node,
    payload: CopyPayload,
    ownerUid: number,
    placed: Map<string, string | null>,
    reason: string,
  ): Promise<'copied' | 'skipped'> {
    const parentId = this.destinationParent(node, payload, placed);

    // FIRST, and before a name is chosen. The queue is at-least-once, so this may have run before;
    // if it did, the row it wrote names this source. Resolving a name first and asking afterwards
    // is what produced a second `a (2).txt` on every redelivery.
    const already = await this.copyOf(organizationId, parentId, node.id);
    if (already !== null) {
      if (node.kind === 'folder') placed.set(node.id, already.id);
      return 'skipped';
    }

    const name = await this.freeName(organizationId, share.id, parentId, node.name);

    if (node.kind === 'folder') {
      const made = await this.files.createFolder(
        organizationId,
        share,
        parentId,
        name,
        payload.actorId,
        randomUUID(),
        reason,
        node.id,
      );
      placed.set(node.id, made.id);
      return 'copied';
    }

    const parentComponents =
      parentId === null ? [] : await this.files.componentsOf(organizationId, parentId);
    const destination = [...parentComponents, name];
    const source = await this.files.componentsOf(organizationId, node.id);

    const bytes = await this.stream(share.name, source, destination, ownerUid, reason);
    await this.files.recordPublishedFile(
      organizationId,
      share.id,
      parentId,
      name,
      bytes,
      node.content_type,
      node.id,
    );
    return 'copied';
  }

  /**
   * Bring one file out of a snapshot and back into the live share.
   *
   * THE OPERATION A NAS IS BOUGHT FOR, and until now DEPSIS could not do it. Snapshots existed and
   * were listed; the only thing that could be done with one was roll a whole dataset back to it,
   * which also discards every file written since. "I deleted a report yesterday" had no answer.
   *
   * It reuses `stream` — the same sliced staging, the same out-of-space handling, the same
   * `RENAME_NOREPLACE` publish — because a restore IS a copy whose source happens to be immutable.
   * The only difference reaches the agent as one extra operand.
   *
   * A `conflict` from the publish is not adopted as success here either, and the reason is sharper
   * than it is for a copy: the name was checked as free when the job was enqueued, so something
   * took it in between. Recording a row would attach that stranger's file to the tree as though it
   * were the restored one — the user would open a file they did not restore, believing they had.
   */
  async restore(
    organizationId: string,
    payload: RestorePayload,
    reason: string,
  ): Promise<{ bytes: number }> {
    const share = await this.files.shareFor(organizationId, payload.shareId);
    // Aynı pencere geri yükleme için de var: anlık görüntüden canlı veri kümesine yazılıyor.
    assertWritable(share);
    const ownerUid = await this.posix.posixUidFor(organizationId, payload.actorId);

    const parentComponents =
      payload.destinationId === null
        ? []
        : await this.files.componentsOf(organizationId, payload.destinationId);

    const bytes = await this.stream(
      share.name,
      payload.from,
      [...parentComponents, payload.name],
      ownerUid,
      reason,
      payload.snapshot,
    );

    await this.files.recordPublishedFile(
      organizationId,
      share.id,
      payload.destinationId,
      payload.name,
      bytes,
      null,
      // No `copied_from_entry_id`: the source is a file in a snapshot, which has no row and by
      // definition may have none — being deleted is the usual reason to restore it. The
      // idempotence a redelivery needs comes from the agent instead, which refuses to publish
      // over a name that is taken.
      null,
    );
    return { bytes };
  }

  /**
   * Move one file's bytes, a slice at a time.
   *
   * The loop is here because the agent refuses to be held: the control socket is served one
   * connection at a time, so an unbounded copy inside it is an outage for every other operation on
   * the appliance. Each call says how much is staged and whether the source is exhausted.
   *
   * A `conflict` on the final publish is NOT adopted as "already done". The name is held on disk by
   * something `file_entries` has no row for — a file written over SMB, or this job's own bytes from
   * an attempt that died before the row was written — and the two are indistinguishable from here.
   * Recording a row for it would attach a foreign file into the tree as though DEPSIS had made it,
   * which is a lie the user cannot see. It fails with the path instead, which an operator can act
   * on.
   */
  private async stream(
    shareName: string,
    from: readonly string[],
    to: readonly string[],
    ownerUid: number,
    reason: string,
    /** Read from this snapshot instead of the live tree. See `restore`. */
    snapshot?: string,
  ): Promise<number> {
    const stagingName = `${randomUUID()}.copy`;
    let offset = 0;

    for (let slice = 0; slice < 1_000_000; slice += 1) {
      const common = {
        share: shareName,
        from: [...from],
        to: [...to],
        staging_name: stagingName,
        offset,
        max_bytes: CopyService.SLICE_BYTES,
        owner_uid: ownerUid,
        // The user's own private group, which is their uid. ADR-0004 allocates user uids and team
        // gids from ONE counter precisely so a uid can serve as a group id without colliding.
        owner_gid: ownerUid,
      };
      const response = await this.agent.call(
        snapshot === undefined
          ? { op: 'copy_file', ...common }
          : { op: 'restore_from_snapshot', snapshot, ...common },
        reason,
      );

      if (response.status === 'out_of_space') throw new CopyOutOfSpaceError(response.reason);
      if (response.status === 'conflict') {
        throw new CopyDestinationOccupiedError(`${shareName}/${to.join('/')}`);
      }
      if (response.status !== 'copied') {
        throw new Error(`the agent answered '${response.status}' to a copy of ${from.join('/')}`);
      }

      if (response.done) return response.offset;
      if (response.offset <= offset) {
        // No progress and not finished. Something is wrong on the other side, and looping would
        // spin forever holding the worker.
        throw new Error(`the copy of ${from.join('/')} stopped making progress at ${offset}`);
      }
      offset = response.offset;
    }
    throw new Error(`the copy of ${from.join('/')} did not finish in a million slices`);
  }

  /**
   * Where a node's copy goes.
   *
   * A node the caller NAMED goes at the destination, whatever its own parent is — that is what
   * selecting it means. A descendant goes under the copy of its parent, read from `placed`.
   *
   * A descendant whose parent is not in `placed` cannot happen: the plan is breadth-first, so by
   * the time a child is reached its parent has either been created or been found by `copyOf` — ve
   * ebeveyni reddedilmiş olan düğümler buraya hiç gelmiyor, `copy()` onları da reddedilenlere
   * sayıyor. Throwing rather than falling back to the destination root, because that fallback
   * silently lifted subtrees out of the tree they belonged to.
   */
  private destinationParent(
    node: Node,
    payload: CopyPayload,
    placed: Map<string, string | null>,
  ): string | null {
    if (payload.sourceIds.includes(node.id)) return payload.destinationId;
    if (node.parent_id === null) return payload.destinationId;

    if (!placed.has(node.parent_id)) {
      throw new Error(
        `the copy of folder ${node.parent_id} was not made before its child ${node.id}`,
      );
    }
    return placed.get(node.parent_id) ?? null;
  }

  /** Who the requester is NOW, not who they were when they clicked. */
  private async caller(organizationId: string, actorId: string): Promise<Caller> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ role: string }>(
        `SELECT role FROM public.users
          WHERE organization_id = $1 AND id = $2 AND disabled_at IS NULL`,
        [organizationId, actorId],
      ),
    );
    const role = rows[0]?.role;
    if (role === undefined) {
      // Disabled or deleted between the click and the copy. Refusing the whole job is the only safe
      // answer: every file it would create would be owned by, and reachable through, an account an
      // administrator has switched off.
      throw new Error('the account that asked for this copy is no longer active');
    }
    return { organizationId, userId: actorId, isOrganizationAdmin: role === 'admin' };
  }

  /** The subset of the plan whose contents the requester may actually take. */
  private async readable(
    caller: Caller,
    shareId: string,
    plan: readonly Node[],
  ): Promise<Set<string>> {
    const access = await this.files.accessFor(
      caller,
      shareId,
      plan.map((node) => node.id),
    );
    const allowed = new Set<string>();
    for (const node of plan) {
      const permissions = permissionsOf(access, node.id);
      // `download` on a file, `list` on a folder: a folder has no contents to take, and demanding
      // `download` on it would refuse to copy a folder whose files the caller may read perfectly
      // well.
      const needed = node.kind === 'file' ? 'download' : 'list';
      if (permissions.has(needed)) allowed.add(node.id);
    }
    return allowed;
  }

  private async nodes(
    organizationId: string,
    shareId: string,
    ids: readonly string[],
  ): Promise<Node[]> {
    if (ids.length === 0) return [];
    return this.db.withTenant(organizationId, (q) =>
      q.query<Node>(
        `SELECT id::text AS id, parent_id::text AS parent_id, kind, name,
                size_bytes::text AS size_bytes, content_type
           FROM public.file_entries
          WHERE organization_id = $1 AND share_id = $2 AND id = ANY($3::uuid[])
            AND trashed_at IS NULL
          ORDER BY kind, name`,
        [organizationId, shareId, [...ids]],
      ),
    );
  }

  private async childrenOf(organizationId: string, parentIds: readonly string[]): Promise<Node[]> {
    if (parentIds.length === 0) return [];
    return this.db.withTenant(organizationId, (q) =>
      q.query<Node>(
        `SELECT id::text AS id, parent_id::text AS parent_id, kind, name,
                size_bytes::text AS size_bytes, content_type
           FROM public.file_entries
          WHERE organization_id = $1 AND parent_id = ANY($2::uuid[]) AND trashed_at IS NULL
          ORDER BY kind, name`,
        [organizationId, [...parentIds]],
      ),
    );
  }

  /**
   * The row under `parentId` that is a copy of `sourceId`, if one was already made.
   *
   * The exact question, answered by the link rather than by the name. A copy renamed by hand
   * afterwards still matches; a folder the user already had, under the same name, does not.
   */
  private async copyOf(
    organizationId: string,
    parentId: string | null,
    sourceId: string,
  ): Promise<{ id: string } | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string }>(
        `SELECT id::text AS id FROM public.file_entries
          WHERE organization_id = $1 AND parent_id IS NOT DISTINCT FROM $2
            AND copied_from_entry_id = $3 AND trashed_at IS NULL`,
        [organizationId, parentId, sourceId],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * Bu klasörde bu adı taşıyan satır — yükleme çakışmasını çözen yolun "eskisi hangisi" sorusu.
   *
   * `rowAt`in dışa açık yüzü. Ayrı bir sorgu yazmak, "aynı ad" tanımının ikinci bir kopyası
   * demek olurdu: burada kat kıvrımı (`name_fold`) ve çöp süzgeci tek bir yerde duruyor.
   */
  /**
   * Bu klasörde bu adı tutan satır — ÇÖPTEKİLER DAHİL.
   *
   * ── ÇÖP ADI BIRAKMIYOR, VE BU SAHADA ÖLÇÜLDÜ ────────────────────────────────────────────
   *
   * Bir satırı çöpe atmak ona bir bayrak yazıyor ama dosyayı diskte KENDİ ADIYLA bırakıyor.
   * Tekil indeks çöptekileri dışladığı için liste adı boş gösteriyor, ve kullanıcı haklı olarak
   * "böyle bir dosya yok" diyor — ama ajan yayımı reddediyor, çünkü disk öyle demiyor.
   *
   * Cihazda cevap bekleyen 235 yüklemenin 143'ü tam olarak buydu. Daha kötüsü, iki çıkış yolu da
   * kapalıydı: `replace` adı tutan satırı bulamıyor (çöptekini görmüyor) ve hiçbir şey yapmadan
   * yayımı yeniden deniyor; `keep-both` ise "boş" bir ad ararken yine çöptekileri görmediği için
   * DOLU bir adı boş sanıp aynı reddi alıyordu. Sahibi aynı fotoğrafları sekiz kez yükledi.
   *
   * `trashed` alanı çağıranın kararı için: canlı bir dosyanın adını almak onu çöpe atmak demek,
   * çöptekinin adını almak ise yalnız onu park etmek — zaten silinmiş bir şeyi ikinci kez silmek
   * anlamsız olurdu.
   */
  async entryNamed(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
  ): Promise<{ id: string; trashed: boolean } | null> {
    return this.rowAt(organizationId, shareId, parentId, name);
  }

  private async rowAt(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
  ): Promise<{ id: string; trashed: boolean } | null> {
    const rows = await this.db.withTenant(organizationId, (q) =>
      q.query<{ id: string; trashed: boolean }>(
        `SELECT id::text AS id, trashed_at IS NOT NULL AS trashed
           FROM public.file_entries
          WHERE organization_id = $1 AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND public.fold_identity(name) = public.fold_identity($4)
          -- CANLI OLAN ÖNCE: iki satır aynı adı taşıyabiliyor (biri çöpte), ve çağıranın
          -- ilgilendiği şey öncelikle görünen dosya.
          ORDER BY trashed_at NULLS FIRST
          LIMIT 1`,
        [organizationId, shareId, parentId, name],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * `keep_both`, which is the contract's default and the only policy this implements.
   *
   * The other three are refused at the endpoint. `replace` would destroy a file the user did not
   * name — the one thing `RENAME_NOREPLACE` exists to prevent, all the way down to the syscall —
   * and implementing it would mean giving the agent an overwrite it does not have. `version` needs
   * a version store that does not exist. `skip` is defensible and simply not built.
   *
   * PUBLIC because the restore endpoint calls it before enqueuing, not after: a restore has to
   * tell the user which name the file will land under BEFORE they agree to it, and a name chosen
   * inside the job would only be discoverable once the job had finished.
   */
  async freeName(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    wanted: string,
  ): Promise<string> {
    if ((await this.rowAt(organizationId, shareId, parentId, wanted)) === null) return wanted;

    const dot = wanted.lastIndexOf('.');
    const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
    const extension = dot > 0 ? wanted.slice(dot) : '';

    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${stem} (${n})${extension}`;
      if ((await this.rowAt(organizationId, shareId, parentId, candidate)) === null) {
        return candidate;
      }
    }
    throw new CopyNameExhaustedError(wanted);
  }
}

export const COPY_KIND = 'files.copy';

/**
 * Its own kind, not a flavour of `files.copy`.
 *
 * The two payloads name their sources differently and cannot be one shape: a copy names entry ids
 * in `file_entries`, and a restore names a PATH inside a snapshot — where there is no row, and
 * usually never will be, because the file being restored is one that was deleted.
 */
export const RESTORE_KIND = 'files.restore-snapshot';

/**
 * Five, the queue's own default, and deliberately NOT twenty.
 *
 * The chunked version needed twenty because a successor written with the default would have a
 * thirty-second life while its predecessor had an hour. There is no successor now — one job runs
 * the whole operation — and what is worth retrying here is transient. The two failures that are
 * NOT transient are kept away from the retry budget entirely: `CopyTooLargeError` is checked at the
 * endpoint, and a full pool comes back as the agent's own `out_of_space` status rather than as a
 * generic failure, because retrying into a full pool parks more part-files against the quota that
 * is already exhausted.
 */
export const COPY_MAX_ATTEMPTS = 5;
