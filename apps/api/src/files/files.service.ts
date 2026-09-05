import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  canMove,
  isPermission,
  PERMISSIONS,
  resolveEffective,
  type AclNode,
  type Grant,
  type Permission,
  type Principal,
  type ResolveInput,
  type Subject,
} from '@depsis/authz';

import { AgentService, expectStatus } from '../agent/agent.service.js';
import { DbService, type TenantQuery } from '../db/db.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { APPLY_ACL_KIND, APPLY_ACL_MAX_ATTEMPTS } from '../permissions/permissions.service.js';
import { PosixIdentityService } from '../identity/posix.service.js';

/**
 * A row in `file_entries`, as the database returns it.
 *
 * `path` is display only. Authority is `parent_id` (ADR-0005): every check in this file resolves an
 * id, and no decision anywhere reads the path string.
 */
export interface FileEntryRow {
  /**
   * Only the trash listing sets this. Undefined everywhere else, which reads as "not applicable"
   * rather than as false — the distinction matters because a row from an ordinary listing is never
   * trashed at all.
   */
  parent_trashed?: boolean;
  /**
   * Klasörün doğrudan çocuk sayısı, en fazla 1000'e kadar sayılmış.
   *
   * Yalnız listelemede ve yalnız klasör satırlarında dolu; dosyada `null`, başka sorgularda hiç
   * yok. `string`, çünkü `count(*)` bigint döner ve sürücü onu metin olarak veriyor.
   */
  child_count?: string | null;
  /**
   * Klasörün altındaki bütün dosyaların toplam boyutu.
   *
   * ALT AĞAÇ, doğrudan çocuklar değil: kullanıcının "bu klasör ne kadar yer kaplıyor" sorusu
   * içindeki klasörleri de kapsıyor. `path` öneki üzerinden tek bir aralık sorgusu — eğik çizginin
   * bir sonraki karakteri `0` olduğu için `[p/, p0)` tam olarak o alt ağaç.
   */
  subtree_bytes?: string | null;
  id: string;
  share_id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  path: string;
  size_bytes: string;
  content_type: string | null;
  trashed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShareRow {
  id: string;
  name: string;
  dataset: string;
  read_only: boolean;
}

/**
 * Arşivin üretilebilmesi için havuzda yer yok.
 *
 * İki sayıyı da taşıyor çünkü ekranda söylenecek cümle ikisi olmadan kurulamıyor: "40 GB gerekiyor,
 * 12 GB boş" bir kullanıcının ne yapacağını bilebileceği bir cümle; "yer yok" değil.
 */
export class ArchiveTooLargeError extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(`arşiv için ${needed} bayt gerekiyor, havuzda ${available} bayt boş`);
    this.name = 'ArchiveTooLargeError';
  }
}

/**
 * Paylaşım salt okunur açılmış; içine yazılamaz.
 *
 * ANAHTAR BUGÜNE KADAR YALNIZ smb.conf'A GİDİYORDU. `shares.read_only` sütununun tek tüketicisi
 * ajanın Samba yapılandırması (`samba.rs`) idi: ağ sürücüsünden yazamayan kullanıcı aynı paylaşımı
 * web dosya yöneticisinde açıp klasör oluşturuyor, dosya yüklüyor, yeniden adlandırıyor, çöpe atıp
 * çöpü boşaltabiliyordu. Ekranda "salt okunur" yazan bir anahtarın yalnız bir istemcide gerçek
 * olması, çalışıyormuş gibi görünen bir kontrol demek — ki bu, hiç olmamasından daha kötü.
 *
 * ZFS'e `readonly=on` verilmiyor ve bu bilinçli: ajanın kendi ACL ve indeksleme yazmaları da o
 * veri kümesine düşüyor. Kapı API katmanında, yani yazan her yolun geçtiği yerde.
 */
export class ShareReadOnlyError extends Error {
  constructor(readonly shareName: string) {
    super(`'${shareName}' salt okunur bir paylaşım`);
    this.name = 'ShareReadOnlyError';
  }
}

/**
 * Salt okunur bir paylaşıma yazmayı reddeder.
 *
 * Tek kapı: yazan her uç ve kopyalama işi bunu çağırıyor, böylece "hangi rotalar denetliyor"
 * sorusunun cevabı bu fonksiyonun çağrı listesi oluyor.
 */
export function assertWritable(share: { name: string; read_only: boolean }): void {
  if (share.read_only) throw new ShareReadOnlyError(share.name);
}

/** A name the caller supplied that the filesystem or the schema will not accept. */
export class InvalidNameError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidNameError';
  }
}

/**
 * The DI token for the parent-dataset resolver, because the value is a FUNCTION: a class token
 * would make `CopyModule`'s plain class provider — which builds this service for the worker,
 * where no default share is ever created — unresolvable, and it did exactly that.
 */
export const PARENT_DATASET_RESOLVER = 'depsis:files:parent-dataset-resolver';

/** The entry does not exist, or belongs to another tenant — deliberately the same answer. */
export class EntryNotFoundError extends Error {
  constructor() {
    super('no such entry');
    this.name = 'EntryNotFoundError';
  }
}

/** A sibling already has this name. */
export class NameTakenError extends Error {
  constructor(readonly takenName: string) {
    super(`${takenName} already exists here`);
    this.name = 'NameTakenError';
  }
}

/**
 * A move whose destination is in another share.
 *
 * Refused rather than performed as a copy. Every DEPSIS share is its own ZFS dataset and
 * `rename(2)` across datasets returns `EXDEV` (ADR-0008), so the only way to honour this request
 * would be to copy the bytes and delete the original — a different operation with a different
 * cost and a different failure mode, which therefore deserves its own endpoint rather than a
 * surprise inside this one.
 */
export class CrossShareMoveError extends Error {
  constructor() {
    super('a move cannot cross shares; copy it instead');
    this.name = 'CrossShareMoveError';
  }
}

/**
 * A folder moved into its own subtree.
 *
 * The cycle this makes is not a cosmetic problem. `parent_id` is the authority for the whole tree,
 * so a folder that is its own ancestor turns every recursive walk — the path rebuild below, the
 * search scope, `componentsOf` — into a query that never terminates. The database has no
 * constraint that can see it, so this check is the only thing standing between a user's drag and a
 * statement timeout on every subsequent listing.
 */
export class MoveIntoDescendantError extends Error {
  constructor(readonly folderName: string) {
    super(`'${folderName}' cannot be moved inside itself`);
    this.name = 'MoveIntoDescendantError';
  }
}

/** Permanent deletion works on the trash, and only on the trash. */
export class NotTrashedError extends Error {
  constructor(readonly entryName: string) {
    super(`'${entryName}' is not in the trash; move it there first`);
    this.name = 'NotTrashedError';
  }
}

/**
 * The row is here and the file is not.
 *
 * Deliberately NOT `EntryNotFoundError`. A 404 would tell the caller its id is wrong, and it is
 * not — the entry exists, the tenant owns it, and the thing that is missing is on the other side
 * of a boundary the caller cannot see. The two stores disagree, which is a state to report rather
 * than an identity to deny.
 */
export class EntryMissingOnDiskError extends Error {
  constructor(readonly agentReason: string) {
    // The agent's own words stay on `agentReason` and out of the message. They are Rust error
    // prose written for whoever reads the journal — `SeamError::PathEscape("alice/docs/x:
    // Operation not permitted (os error 1)")`, or the classify_openat2 paragraph naming kernel
    // versions — and a person looking at a file listing can act on none of it. `shares.service.ts`
    // refuses to pass the same text through for exactly this reason; the controller logs the field
    // beside the correlation id so the detail is one grep away rather than in an HTTP body.
    super('the filesystem does not have this entry where the database says it is');
    this.name = 'EntryMissingOnDiskError';
  }
}

/**
 * The operation needs a directory that is not on disk, and creating it did not work either.
 *
 * The population this names has shrunk to one group and it is worth being precise about which.
 * Folders created before `CreateDirectory` existed are rows with no directory behind them, and
 * every operation that runs through one — a file moved in, a file moved out, the folder itself
 * moved or renamed, a file published into it — fails inside the agent's `open_dir`. Those are now
 * MATERIALISED on first use (see `ensureDirectories`), so the ordinary outcome is that the
 * directory appears and the operation proceeds.
 *
 * What is left is the case where materialising failed too: a read-only dataset, a share whose root
 * is gone, a name that exists on disk as a FILE. Still its own state rather than
 * `EntryMissingOnDiskError`, because the database is not the thing that is wrong.
 */
export class FolderNotOnDiskError extends Error {
  constructor(readonly agentReason: string) {
    super(
      'this folder has no directory on disk and one could not be created, so an entry cannot be ' +
        'moved into or out of it',
    );
    this.name = 'FolderNotOnDiskError';
  }
}

/**
 * The name is free in the database and taken on disk.
 *
 * Worth its own sentence rather than folding into `NameTakenError`, because the two send a user to
 * different places. A name taken in the database is visible in the listing the user is looking at;
 * a name taken only on disk is not, and the likeliest reason is that somebody created the folder
 * over SMB — where DEPSIS is not consulted and writes no row. Telling them "there is already
 * something with this name on disk" is what turns an inexplicable 409 into an explicable one, and
 * it is also the honest description of the state: the API cannot see what is there, only that the
 * kernel refused to make another.
 */
export class NameTakenOnDiskError extends Error {
  constructor(
    readonly takenName: string,
    readonly agentReason: string,
  ) {
    super(
      `'${takenName}' cannot be created: something with that name is already on disk, most ` +
        'likely made over SMB, and DEPSIS has no record of it',
    );
    this.name = 'NameTakenOnDiskError';
  }
}

/**
 * The name is free in the listing, taken on disk, and the thing holding it is in the BIN.
 *
 * Split out of `NameTakenOnDiskError` because that error's sentence — "most likely made over SMB,
 * and DEPSIS has no record of it" — is flatly untrue here: DEPSIS has a record, the user put it
 * there, and it is one click away in the trash. Sending them to look for a phantom SMB client for
 * something they deleted five seconds ago is the worst kind of wrong message.
 *
 * The state is reachable because trashing is a FLAG and nothing else. `trash()` writes
 * `trashed_at` and never touches the directory, while both unique indexes in
 * `0008_file_entries.sql` and `requireNameFree` below filter on `trashed_at IS NULL` — so the
 * database frees the name the moment something is binned and the disk does not. Create 'Belgeler',
 * bin it, create 'Belgeler' again: the database says yes and `mkdirat` says EEXIST.
 *
 * It is a regression, and worth naming as one so nobody "simplifies" it back. The old
 * `createFolder` wrote a row and never called the agent, so the flow worked precisely because the
 * folder was not on disk at all — which was the hole `CreateDirectory` was added to close.
 *
 * The remedy the message names is a real one the user can act on: empty the bin or restore. The
 * alternative fix — moving the directory aside under `.depsis/trash/<id>` when it is binned, so
 * the two name arbiters are freed together — is the better long-term shape, and it is a change to
 * trash, restore and empty-trash all three rather than to this error.
 */
/**
 * KNOWN GAP — "storage is not set up" is answered 409, not 503.
 *
 * `agentAvailable()` asks whether the SOCKET is configured, never whether a share root is
 * (`agent.service.ts`), and the agent starts deliberately without `DEPSIS_SHARES_ROOT`
 * (`main.rs`), answering `create_directory` with `refused: no share root is configured; storage is
 * not set up`. That lands in `createDirectory`'s default arm, becomes `AgentRefusedError` and is
 * translated to a 409 — so an appliance with no storage yet tells the user the same status class
 * as a name collision, and `createFolder`'s controller comment claims 503 covers it.
 *
 * Not fixed here, and the reason is worth recording because the obvious fix is the wrong one.
 * `refused` is not one condition: `create_directory` also answers it for `.depsis/` and for an
 * empty path, and `publish_transfer` for several more. Separating them means matching on the
 * agent's prose, which is the contract-nobody-declared this codebase refuses everywhere else —
 * `SeamError::NotFound` and `AlreadyExists` exist as typed variants for exactly that reason. The
 * honest fix is a distinct agent RESPONSE for "this daemon has no storage configured", which is a
 * protocol change rather than a mapping change, and it belongs with the yaml update that adds
 * 401/503 to `POST /files/folders`.
 */

export class NameTakenByTrashedEntryError extends Error {
  constructor(
    readonly takenName: string,
    readonly trashedEntryId: string,
    readonly agentReason: string,
  ) {
    super(
      `'${takenName}' is still taken on disk by a folder in the bin. Emptying the bin or ` +
        'restoring it frees the name; deleting it from the listing only hid it',
    );
    this.name = 'NameTakenByTrashedEntryError';
  }
}

/**
 * A directory the agent refused to remove because it still has entries in it.
 *
 * Reachable only when the disk holds something the database does not know about — a file written
 * over SMB, most likely — because the permanent delete walks the tree it stores from the leaves
 * up. Reported rather than forced: the alternative is a recursive delete in the agent, and §2.2
 * exists to keep that operation from existing at all.
 */
export class DirectoryNotEmptyError extends Error {
  constructor(readonly agentReason: string) {
    // Same as `EntryMissingOnDiskError` above: the reason travels on the field, not in the body.
    super('the folder still has entries the database does not know about');
    this.name = 'DirectoryNotEmptyError';
  }
}

/**
 * A restore that would produce an entry nothing can reach.
 *
 * The trash is a column, not a folder (0008), so restoring a child clears only that child's
 * `trashed_at`. Its parent stays trashed, and every listing filters on the PARENT's id — so the
 * restored row appears in no folder listing and in no trash listing either. It exists, it is
 * reachable by id, and no screen in the product can show it. Refusing beats manufacturing that.
 */
/**
 * The operation reaches descendants the caller does not hold the permission on.
 *
 * The COUNT and never the names. ADR-0021's only way to say "less here" is a narrower grant on a
 * descendant, so a refusal like this one is, by construction, about folders somebody deliberately
 * hid — and a refusal that listed them would hand over exactly what the narrowing was for.
 */
export class SubtreeForbiddenError extends Error {
  constructor(
    readonly permission: Permission,
    readonly count: number,
  ) {
    super(
      `this reaches ${count} folder${count === 1 ? '' : 's'} inside it that you do not have ` +
        `'${permission}' on`,
    );
    this.name = 'SubtreeForbiddenError';
  }
}

export class TrashedParentError extends Error {
  constructor(readonly parentName: string) {
    super(`'${parentName}' is still in the trash; restore it first`);
    this.name = 'TrashedParentError';
  }
}

/** A page of file entries, ordered by whatever the query that produced it decided. */
export interface FileEntryPage {
  items: FileEntryRow[];
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Bu klasördeki görünen öğe sayısı — sayfanın değil, klasörün.
   *
   * Yalnız `list` dolduruyor; arama ve çöp listeleri sayfa sayfa gezilen şeyler değil, ve orada
   * bir "toplam" sorusunun karşılığı yok.
   */
  total?: number;
  /**
   * Bu klasördeki klasör ve dosya sayısı, ayrı ayrı.
   *
   * `total` kaç şey olduğunu söylüyor, bu ikisi NE olduğunu. Ekrandaki fark küçük değil: "48 öğe"
   * bir kullanıcıya klasöre girmeden önce hiçbir şey anlatmıyor, "6 klasör · 42 dosya" ise neyle
   * karşılaşacağını anlatıyor.
   *
   * `total`la aynı sorgudan, aynı taramanın üstünde iki `FILTER` ile geliyorlar: ayrı sorgular
   * olsaydı üçü birbiriyle çelişebilirdi.
   */
  folders?: number;
  files?: number;
}

/**
 * The columns every list query selects, as one string.
 *
 * Written once because the four listing queries have to agree: a column that appears in one and
 * not another produces a `FileEntryRow` with an undefined field, which TypeScript cannot catch
 * because the row type is asserted rather than inferred from the database.
 */
const ENTRY_COLUMNS = `id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                       trashed_at, created_at, updated_at`;

/**
 * Aynı sütunlar, artı klasörlerin DOĞRUDAN çocuk sayısı.
 *
 * ── NEDEN SATIRDA, NEDEN AYRI BİR İSTEKTE DEĞİL ─────────────────────────────────────────────
 *
 * Ekran bir klasör satırında "boş mu, kaç öğe var" göstermek istiyor. Bunu satır başına ayrı bir
 * listeleme isteğiyle yapmak, iki yüz satırlık bir klasörde iki yüz istek demek — ve ekran bugün
 * bunu yalnız silme onayında, en fazla on klasör için yapıyor, tam da bu yüzden.
 *
 * ── SAYIM SINIRLI ───────────────────────────────────────────────────────────────────────────
 *
 * `LIMIT 1000` içeride: on bin dosyalı bir klasörün tam sayısını üretmek, kimsenin okumadığı bir
 * rakam için her listelemede on bin satır saymak demek. Bin ve üstü ekranda "1000+" olarak
 * görünüyor — insanın "çok" dediği yer zaten çok daha aşağıda.
 *
 * ── GİZLİLİK ────────────────────────────────────────────────────────────────────────────────
 *
 * Sayım, listelenen klasörün İÇİNDEKİLER'i sayıyor ve o klasörü listeleme izni zaten sorulmuş
 * oluyor. Sözleşmedeki "toplam yok" kuralı SÜZÜLMEMİŞ bir toplamla ilgili: görülemeyen satırların
 * varlığını sızdıran bir sayı. Burada sayılan şey, kullanıcının zaten görebildiği liste.
 *
 * ── ALT AĞAÇ ARALIĞI BAYT SIRASIYLA ─────────────────────────────────────────────────────────
 *
 * `COLLATE "C"`, harmanlamasız `>=` / `<` değil. Veritabanı ICU (`und-x-icu`) ile kurulu ve o
 * sırada `&`, `#`, `+`, `~`, `^`, `=` gibi karakterler `/` ile `0` ARASINDA geliyor — hepsi geçerli
 * dosya adı karakteri. `Proje` klasörünün aralığına kardeşi `Proje+notlar.zip` giriyordu: 10 MB'lık
 * klasör listede 2 GB görünüyor, arşiv tahmini o kadar yer istiyordu.
 *
 * HARMANLAMA SORGUDA DA YAZILMALI. 0062 indeksi `(share_id, path COLLATE "C")` anahtarıyla
 * kuruluyor; sorgu karşılaştırmayı aynı harmanlamayla yazmazsa planlayıcı o indeksi seçemez ve
 * her klasör satırı için paylaşımın tamamı taranır.
 *
 * `~>=~` / `~<~` de bayt sırası verirdi ama iki sebeple kullanılmıyor: 0062 `text_pattern_ops`
 * indeksini düşürüyor, ve o operatörler PostgreSQL'in "diğer operatörler" düzeyinde `||` ile aynı
 * önceliği paylaşıp soldan birleşiyor — `d.path ~>=~ f.path || '/'` ifadesi
 * `(d.path ~>=~ f.path) || '/'` diye ayrıştırılıp `AND`e bir metin veriyor ve sorgu 42804 ile
 * düşüyor. `>=` bir KARŞILAŞTIRMA operatörü, `||`den düşük öncelikli, yani parantez gerekmiyor.
 */
const ENTRY_COLUMNS_WITH_COUNT = `f.id, f.share_id, f.parent_id, f.kind, f.name, f.path,
                       f.size_bytes, f.content_type, f.trashed_at, f.created_at, f.updated_at,
                       CASE WHEN f.kind = 'folder' THEN (
                         SELECT count(*) FROM (
                           SELECT 1 FROM public.file_entries c
                            WHERE c.parent_id = f.id AND c.trashed_at IS NULL
                            LIMIT 1000
                         ) capped
                       ) ELSE NULL END AS child_count,
                       CASE WHEN f.kind = 'folder' THEN (
                         SELECT coalesce(sum(d.size_bytes), 0)
                           FROM public.file_entries d
                          WHERE d.share_id = f.share_id
                            AND d.kind = 'file'
                            AND d.trashed_at IS NULL
                            AND d.path COLLATE "C" >= f.path || '/'
                            AND d.path COLLATE "C" < f.path || '0'
                       ) ELSE NULL END AS subtree_bytes`;

/**
 * The same columns plus whether the row's PARENT is in the bin.
 *
 * Only the trash listing needs it, and only to decide whether to show an expiry date: a row whose
 * parent is also trashed dies on its ROOT's date, so its own would be a countdown the purge does
 * not honour.
 */
const TRASH_COLUMNS = `e.id, e.share_id, e.parent_id, e.kind, e.name, e.path, e.size_bytes,
                       e.content_type, e.trashed_at, e.created_at, e.updated_at,
                       (p.id IS NOT NULL AND p.trashed_at IS NOT NULL) AS parent_trashed`;

/** The orders `GET /files` offers. The contract's enum, and nothing outside it. */
export type SortOrder = 'name' | 'type' | 'modified' | 'size';

/**
 * How each sort is expressed, as two fragments that have to agree.
 *
 * ONE ENTRY RATHER THAN A `switch`, because `after` and `by` are one decision and splitting them is
 * how a cursor stops matching its own ORDER BY. `by` produces the order; `after` selects everything
 * strictly beyond the cursor row in that same order. Get them out of step and a page boundary
 * repeats or drops rows — the failure cursor pagination was chosen over offset pagination to avoid,
 * reintroduced through the back door.
 *
 * WHY `after` IS WRITTEN OUT INSTEAD OF BEING ONE ROW-VALUE COMPARISON. `(a, b) > (x, y)` is
 * lexicographic in ONE direction, and two of these orders run in two: `kind` ascends while
 * `updated_at` and `size_bytes` descend. Folding a mixed order into a single tuple comparison
 * compares `kind` descending as well, and the second page of a `modified` listing comes back short.
 * That is measured rather than reasoned about — `conditional.integration.test.ts` failed on it
 * before this was written out.
 *
 * The `c_` prefixes are what let the predicate stay unqualified: every column of the cursor row is
 * renamed, so a bare `kind` inside the EXISTS can only mean the outer table's.
 *
 * `kind` leads all three, so folders and files never interleave. It is text, so it sorts
 * alphabetically and files come before folders — the order this endpoint has always produced, kept
 * rather than quietly improved: it is the default listing order and changing it is a separate
 * decision from implementing `sort`.
 *
 * `id` closes all three. `name_fold` is unique per parent so the name sort did not need it, but two
 * files modified in the same millisecond or holding the same number of bytes are ordinary — and
 * without a tiebreak the cursor lands inside a group and the page after it is arbitrary.
 *
 * DESCENDING for `modified` and `size`, which the contract does not specify. Somebody who sorts by
 * date is asking what changed last, and somebody who sorts by size is looking for what is filling
 * the disk; ascending would answer both with the least interesting row in the folder.
 */
/**
 * Bir dosyanın UZANTISI, sıralanabilir bir değer olarak.
 *
 * ── NEDEN İFADE, NEDEN SÜTUN DEĞİL ──────────────────────────────────────────────────────────
 *
 * `content_type` sütunu var ama türü o söylemiyor: yüklemede tarayıcının verdiğine göre doluyor,
 * SMB üzerinden yazılan bir dosyada hiç dolmuyor, ve `application/octet-stream` bir tür değil bir
 * teslimiyet. Kullanıcının "tür" derken kastettiği şey adın sonundaki üç harf.
 *
 * ── `coalesce` ZORUNLU ──────────────────────────────────────────────────────────────────────
 *
 * Ve bu bir güzellik değil, imlecin doğruluğu. Uzantısı olmayan bir dosyada ifade NULL, ve
 * `(uzantı, ...) > (c_uzantı, ...)` karşılaştırması NULL üretiyor — yani satır ne doğru ne yanlış,
 * SÜZÜLÜYOR. İmleçten sonraki her sayfa o dosyaları sessizce düşürürdü.
 *
 * ── BAŞTAKİ NOKTA ───────────────────────────────────────────────────────────────────────────
 *
 * Desendeki ilk `.` "herhangi bir karakter" demek ve bilerek orada: `.gitignore` bir `gitignore`
 * dosyası değil, uzantısız gizli bir dosya. Nokta'dan önce en az bir karakter arayarak ikisi
 * ayrılıyor.
 *
 * Ters bölü YOK, ve bu da bilerek: bu metin bir JavaScript şablon dizesinin içinde yaşıyor, ve
 * orada `\.` yazmak SQL'e sade bir nokta olarak ulaşır — yani "herhangi bir karakter". `[.]`
 * kaçış gerektirmeden aynı şeyi söylüyor.
 */
const EXT = "coalesce(lower(substring(name from '.[.]([^.]+)$')), '')";
const CUR_EXT = 'c_ext';

const SORTS: Readonly<Record<SortOrder, { after: string; by: string }>> = {
  name: {
    // Every key ascends, so this one CAN be a single row-value comparison — and is, because it is
    // both the clearest way to say it and the shape the planner turns into an index scan.
    after: '(kind, name_fold, id) > (c_kind, c_name_fold, c_id)',
    by: 'kind, name_fold, id',
  },
  /**
   * Türe göre: aynı uzantılı dosyalar bir arada, her uzantının içinde alfabetik.
   *
   * Her anahtar ARTAN, o yüzden `name` gibi tek bir satır-değeri karşılaştırması olabiliyor. İkinci
   * anahtarın `name_fold` olması bir tercih: bir klasörde otuz `.jpg` varken onları rastgele bir
   * sırada göstermek, türe göre sıralamanın çözdüğü sorunu bir kat aşağıda yeniden yaratırdı.
   */
  type: {
    after: `(kind, ${EXT}, name_fold, id) > (c_kind, ${CUR_EXT}, c_name_fold, c_id)`,
    by: `kind, ${EXT}, name_fold, id`,
  },
  modified: {
    after: 'kind > c_kind OR (kind = c_kind AND (updated_at, id) < (c_updated_at, c_id))',
    by: 'kind, updated_at DESC, id DESC',
  },
  size: {
    after: 'kind > c_kind OR (kind = c_kind AND (size_bytes, id) < (c_size_bytes, c_id))',
    by: 'kind, size_bytes DESC, id DESC',
  },
};

/**
 * The share this entry lives in, as the caller resolved it from the session.
 *
 * Both halves are needed and neither is optional: the id is what proves the entry belongs to the
 * share the session is working in, and the name is what the agent resolves its root fd from. A
 * call site holding only the name could send a privileged operation against the right share for
 * the wrong entry.
 */
export interface ShareRef {
  id: string;
  name: string;
}

/**
 * Below this many characters a query is matched as a PREFIX rather than as a substring.
 *
 * pg_trgm indexes trigrams, so a one- or two-character pattern has no trigram to look up and
 * `LIKE '%ab%'` degrades to a sequential scan of every name in the share. 0008 anticipated this
 * and shipped a second index — `file_entries_name_norm_prefix`, a B-tree with `text_pattern_ops` —
 * for exactly this branch, and `LIKE 'ab%'` is the shape that can use it.
 */
const TRIGRAM_MIN_LENGTH = 3;

/**
 * "Exclude no row" for `requireNameFree`, which exists to answer "is this name free APART FROM the
 * entry I am about to move". A creation excludes nothing, and the all-zero UUID is a value no
 * `uuidv7` can produce — so the `id <> $5` clause is satisfied by every row rather than by all but
 * one, and the parameter stays a uuid the database can compare instead of a NULL that would make
 * the whole predicate NULL and silently match nothing.
 */
const NO_ENTRY = '00000000-0000-0000-0000-000000000000';

/**
 * Turn "limit + 1 rows" into a page.
 *
 * Every paged query here asks for one row more than the caller wanted, and that spare row is the
 * whole answer to `hasMore` — the contract has no total count, because an unfiltered total beside
 * a filtered list leaks the existence of rows the tenant may not see. The cursor is the last
 * RETURNED row's id, never the spare one's.
 */
function page(rows: FileEntryRow[], limit: number): FileEntryPage {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null, hasMore };
}

/**
 * Recompute `path` for everything under `rootId`, in the caller's transaction.
 *
 * ONE implementation, shared by `move` and `rename`, because they are two spellings of the same
 * user-visible change and a cache the two disagreed about would be worse than no cache. Rebuilt
 * from `parent_id` rather than by splicing a new prefix onto the old strings: same cost, and it
 * REPAIRS a stale descendant instead of carrying it forward — a prefix splice on a row whose cache
 * was already wrong produces a second wrong value that looks freshly computed.
 *
 * The root row itself is excluded because its caller has just written it and holds the returned
 * copy; touching it again here would make that copy stale in the same statement.
 */
async function rebuildSubtreePaths(
  db: TenantQuery,
  organizationId: string,
  rootId: string,
): Promise<void> {
  await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, path
         FROM public.file_entries
        WHERE organization_id = $1 AND id = $2
       UNION ALL
       SELECT child.id, subtree.path || '/' || child.name
         FROM public.file_entries child
         JOIN subtree ON child.parent_id = subtree.id
        WHERE child.organization_id = $1
     )
     UPDATE public.file_entries entry
        SET path = subtree.path
       FROM subtree
      WHERE entry.organization_id = $1
        AND entry.id = subtree.id
        AND entry.id <> $2
        AND entry.path IS DISTINCT FROM subtree.path`,
    [organizationId, rootId],
  );
}

/**
 * The same component rules the agent enforces in `op::SafeComponent`.
 *
 * Checked here as well as there, and not because the agent might forget: a name the database would
 * store and the agent would refuse produces a row describing a file that cannot exist, which is the
 * "two realities" the project forbids. Rejecting at the edge keeps the two stores in step.
 */
const MAX_NAME_BYTES = 255;

export function assertValidName(name: string): void {
  if (name.length === 0) throw new InvalidNameError('a name may not be empty');
  if (name === '.' || name === '..') throw new InvalidNameError(`'${name}' is not a name`);
  if (name.includes('/') || name.includes('\\')) {
    throw new InvalidNameError('a name is one component and may not contain a separator');
  }
  // NUL terminates a C string, so a name containing one is stored whole in PostgreSQL and
  // truncated by every syscall that later receives it — two different names for one file.
  if (name.includes('\0')) throw new InvalidNameError('a name may not contain a NUL');
  // Baştaki tire ARTIK bir güvenlik kuralı değil. Ajanın yol ve girdi adı konumları `EntryName`e
  // geçti (şema 43): `-notlar.txt` bir bayrak gibi okunabileceği hiçbir argüman listesine
  // girmiyor, ve ağ sürücüsünden böyle bir dosya yazıldığında artık dizine giriyor, listeleniyor,
  // yedekleniyor — eskiden sessizce düşüyor ve artımlı yedek turunu kalıcı olarak kırıyordu.
  // Burada duruyor olmasının sebebi başka: DEPSIS'in KENDİ açtığı bir adın, kullanıcının bir gün
  // bir kabuğa yapıştıracağı yerde bayrak gibi görünmesini istemiyoruz. Yani bu bir görgü kuralı,
  // ve yalnız yeni adlara uygulanıyor — diskte zaten var olan bir ada değil.
  if (name.startsWith('-')) {
    throw new InvalidNameError('a name may not begin with a dash, which reads as a flag');
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new InvalidNameError(`a name may not exceed ${MAX_NAME_BYTES} bytes`);
  }
  // `.depsis` is the staging and quarantine tree. A user-visible entry with that name would put
  // half-written uploads and quarantined content into listings and search results.
  if (name === '.depsis') throw new InvalidNameError("'.depsis' is reserved");
}

/* ─── §6.2 access control ──────────────────────────────────────────────────────────────────── */

/**
 * Who is asking, as far as the grant walk is concerned.
 *
 * `isOrganizationAdmin` is a fact about the SESSION and not about the tree, which is why
 * `@depsis/authz` deliberately has no room for it in `Subject` and this layer carries it instead.
 * ADR-0021 §5: an organisation administrator reaches everything, and nobody else has an exception.
 */
export interface Caller {
  readonly organizationId: string;
  readonly userId: string;
  readonly isOrganizationAdmin: boolean;
}

/**
 * One resolvable chain per node asked about. `null` is the share root; an absent key means the
 * node could not be placed in this share's tree at all.
 */
export type AccessMap = ReadonlyMap<string | null, ResolveInput>;

/**
 * The key the share root's grants are filed under inside `accessFor`.
 *
 * A `Map<string, …>` cannot hold the `null` that `folder_grants.entry_id` uses for the root, and
 * every other key in that map comes from `entry_id::text` — a UUID. This is not one, so it cannot
 * collide with an entry however the ids fall.
 */
const ROOT = 'share-root';

interface GrantRow {
  entry_id: string | null;
  user_id: string | null;
  team_id: string | null;
  permissions: string[];
}

/** A grant row's target. `folder_grants_one_principal` makes exactly one of the two columns set. */
function principalOf(row: GrantRow): Principal | null {
  if (row.user_id !== null) return { kind: 'user', id: row.user_id };
  if (row.team_id !== null) return { kind: 'team', id: row.team_id };
  return null;
}

/**
 * The grants this caller carries at a node over and above the rows in the database.
 *
 * Both exceptions are expressed as grants rather than as short circuits so that ADR-0021's rule
 * stays the only rule: one resolver decides every question, and `canMove` keeps working for an
 * administrator without a second code path that could disagree with the first.
 *
 * ONE exception is left, and it used to be two. The administrator's synthetic grant is attached to
 * the TARGET node, not to the root. Nearest ancestor wins per principal, so a root grant would lose
 * to any narrower row written for that same account further down — and an administrator who had
 * also been given a narrow grant on a subfolder would find §6.1's hierarchy quietly cancelled by
 * it. It is also placed BEFORE the real rows in the node's list, because two grants for one
 * principal on one node cannot both apply and `resolve` takes the first: the database's uniqueness
 * makes that impossible for real rows, and this is the one place a second one is manufactured.
 *
 * THE ONE THAT WENT was `LEGACY_OPEN_SHARE`: while a share had no grant rows at all, every member
 * of the tenant was handed the seven permissions this API served before §6.2. It was a bridge for
 * data that predated the model, and it was also a hole — the condition was an existence test over
 * `folder_grants`, asked afresh on every request, so anything that emptied a share reopened it to
 * everybody. It is gone because its own removal condition is now met: migration 0016 wrote a root
 * grant for every share that had none, and `POST /shares` — the only thing in the product that
 * creates one — writes the row and its first grant in a single transaction. A share with zero
 * grants is no longer a state this system can be in, so the code for it is no longer a bridge, it
 * is a second answer waiting to disagree with the first.
 */
function syntheticGrants(caller: Caller, isTarget: boolean): Grant[] {
  if (!caller.isOrganizationAdmin) return [];
  const principal: Principal = { kind: 'user', id: caller.userId };
  return isTarget ? [{ principal, permissions: PERMISSIONS }] : [];
}

/**
 * The chain from the share root down to `target`, root first, as `resolve` requires it.
 *
 * Built from `parent_id` alone. The share root is synthesised — it has no `file_entries` row — and
 * every top-level entry is re-pointed at it, which is what makes a grant with `entry_id IS NULL`
 * an ordinary ancestor instead of a second inheritance rule.
 *
 * `null` when a link is missing: the target is in another share, or a row disappeared between the
 * two statements. Not an empty chain and not a chain starting halfway down — `resolve` would
 * happily answer a question about a different tree, and answering the wrong permission question
 * confidently is the failure this whole file exists to avoid.
 */
function chainTo(
  target: string | null,
  shareId: string,
  parentOf: ReadonlyMap<string, string | null>,
  granted: ReadonlyMap<string, Grant[]>,
  caller: Caller,
): AclNode[] | null {
  const root: AclNode = {
    id: shareId,
    parentId: null,
    grants: [...syntheticGrants(caller, target === null), ...(granted.get(ROOT) ?? [])],
  };
  if (target === null) return [root];

  const descending: AclNode[] = [];
  let cursor: string | null = target;
  // Bounded by the number of nodes the walk returned. `file_entries` cannot hold a cycle —
  // `MoveIntoDescendantError` is what stops one being made — but a loop that trusts that would
  // hang the request rather than fail it if the guarantee ever slipped.
  for (let step = 0; cursor !== null && step <= parentOf.size; step += 1) {
    const parentId: string | null | undefined = parentOf.get(cursor);
    if (parentId === undefined) return null;
    descending.push({
      id: cursor,
      parentId: parentId ?? shareId,
      grants: [...syntheticGrants(caller, cursor === target), ...(granted.get(cursor) ?? [])],
    });
    cursor = parentId;
  }
  if (cursor !== null) return null;

  return [root, ...descending.reverse()];
}

/** One node's effective set, with an absent chain reading as "nothing". */
export function permissionsOf(access: AccessMap, node: string | null): ReadonlySet<Permission> {
  const input = access.get(node);
  return input === undefined ? new Set<Permission>() : resolveEffective(input);
}

/**
 * Everything the file tree does, apart from moving bytes.
 *
 * Bytes are the agent's business (`UploadsController` drives that); this class owns the metadata
 * and the one invariant that ties them together — a row exists only for a file the agent has
 * actually published.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly db: DbService,
    private readonly agent: AgentService,
    private readonly posix: PosixIdentityService,
    /**
     * For the ONE thing in this service that changes who can reach a folder: `move`.
     *
     * A move re-parents a subtree, and ADR-0021 resolves permissions from the ancestor chain — so
     * the same folder answers differently the moment it lands, while its directory on disk still
     * carries the ACL the old parent produced. Only an explicit `ApplyFolderAcl` per folder can
     * close that, and only the queue can deliver it.
     */
    private readonly jobs: JobsService,
    /**
     * Resolves the dataset new shares are created under — `SystemService.parentDataset`, handed
     * in as a function by `files.module` the same way `shares.module` wires `SharesService`.
     * Optional: null in tests constructed without storage plumbing and in `CopyModule`'s worker
     * wiring, where nothing creates a default share; the null path keeps the historical
     * row-only default share and must never be the API's production wiring.
     */
    @Optional()
    @Inject(PARENT_DATASET_RESOLVER)
    parentDataset: ((correlationId: string) => Promise<string | null>) | null = null,
  ) {
    this.parentDataset = parentDataset ?? null;
  }

  private readonly parentDataset: ((correlationId: string) => Promise<string | null>) | null;

  /**
   * The organisation's default share, created on first use.
   *
   * Share administration exists now; what this keeps is the freshly claimed box, where the file
   * manager is opened before anyone has made a share. It creates a REAL one — dataset on disk
   * first, row second — because its row-only ancestor left a ghost: `dataset = slug`, nothing
   * behind it, every Samba publish on the box failing on a share that could hold no file.
   */
  async defaultShare(organizationId: string, slug: string): Promise<ShareRow> {
    return this.db.withTenant(organizationId, async (db) => {
      const existing = await db.query<ShareRow>(
        `SELECT id, name, dataset, read_only FROM public.shares
          WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
        [organizationId],
      );
      if (existing[0]) return existing[0];

      // The share name has to satisfy the agent's component rules, and an organisation slug is
      // already constrained to `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` — a superset-safe source.
      const name = slug;

      // THE DATASET FIRST, AND FOR REAL — ama YALNIZ bir üst veri kümesi varken.
      //
      // Sahada ölçülen hata: bu metot `dataset = slug` yazıp diske hiçbir şey koymuyordu, ve o
      // hayalet — veri kümesi olmayan bir paylaşım — kutudaki her Samba yayınını düşürüyordu
      // (yayın hepsi-ya-da-hiçbiri) ve tek bayt tutamıyordu. Satır artık ancak ajanın az önce
      // yarattığı ya da doğruladığı bir veri kümesini iddia edebiliyor.
      //
      // ZFS OLMAYAN KUTUDA ESKİ DAVRANIŞ SÜRÜYOR, ve bunu geri koymak bir gerileme değil: e2e
      // yığını ve geliştirme kurulumu paylaşımları düz dizin olarak tutuyor, ve orada reddetmek
      // dosya yöneticisini tamamen öldürüyordu (CI bunu "Klasör okunamadı" + 503 diye ölçtü).
      // O kutularda zaten `zfs` yok, yani hayaletin bozacağı bir yayın da yok.
      //
      // Kalan pencere dürüstçe söylenmeli: HAVUZU OLMAYAN bir cihazda birisi havuz kurmadan
      // dosya yöneticisini açarsa yine hayalet bir satır doğar. Sihirbaz havuzla birlikte
      // paylaşım ağacını da kurduğu için (`prepareShareRoot`, artık sunucunun kararı) bu pencere
      // kurulumun ilk dakikalarıyla sınırlı.
      let dataset = name;
      const parent = this.parentDataset === null ? null : await this.parentDataset(randomUUID());
      if (parent !== null) {
        const correlationId = randomUUID();
        dataset = `${parent}/${name}`;
        const made = await this.agent.call(
          { op: 'create_dataset', dataset, acltype: 'posixacl', refquota_bytes: null },
          `create the default share '${name}'`,
          correlationId,
        );
        // `conflict` is the dataset already existing — a re-run after a first attempt that made
        // the dataset and lost the transaction. The dataset is exactly what we were about to
        // create, and the ROW is what is missing, so the honest move is to proceed to it.
        if (made.status !== 'conflict') expectStatus(made, 'created');
      }

      const created = await db.query<ShareRow>(
        `INSERT INTO public.shares (organization_id, name, dataset)
         VALUES ($1, $2, $3)
         RETURNING id, name, dataset, read_only`,
        [organizationId, name, dataset],
      );
      const share = created[0];
      if (!share) throw new Error('the default share was not created');

      // THE ROOT GRANT, in the same transaction as the row, and this is the second half of an
      // invariant the rest of the permission model now rests on: every share has at least one
      // grant. Without it this method would break that invariant on the FIRST request a fresh
      // appliance ever serves — it is reached from `GET /files` and `GET /search` by any signed-in
      // user, before an administrator has done anything at all.
      //
      // It was very nearly missed. The audit for the removal of `LEGACY_OPEN_SHARE` searched for
      // `INSERT INTO shares` and found only tests; this statement says `INSERT INTO public.shares`
      // and did not match. What found it was the search suite going red, because its member could
      // suddenly see none of the fifty-one folders it had seeded.
      //
      // `everyone_team()` and not the caller, unlike `SharesService.create`. The difference is who
      // decided: an administrator opening a share can say who it is for, and if they decline the
      // share is theirs alone. Nobody opened THIS one — it appeared because somebody opened the
      // file manager — so there is no intent to honour, and the historical answer, the one this
      // appliance has always given, is everyone. Migration 0016 defines the team, so the two paths
      // cannot drift into disagreeing about what "everyone" means.
      const team = await db.query<{ id: string }>(`SELECT public.everyone_team($1)::text AS id`, [
        organizationId,
      ]);
      const teamId = team[0]?.id;
      if (teamId === undefined) throw new Error('the everyone team was not returned');
      await db.query(
        `INSERT INTO public.folder_grants
           (organization_id, share_id, entry_id, team_id, permissions)
         VALUES ($1, $2, NULL, $3, $4::public.folder_permission[])`,
        // The same seven `LEGACY_OPEN_SHARE` served, and `manage` is still not among them: the
        // first person to be given authority over a share's permissions is an administrator, by
        // an administrator's decision (ADR-0021 §5), never by appearing on an implicit grant.
        [
          organizationId,
          share.id,
          teamId,
          ['list', 'read', 'download', 'create', 'modify', 'move', 'delete'],
        ],
      );

      this.logger.log(`created the default share '${name}' for ${organizationId}`);
      return share;
    });
  }

  /**
   * The share this caller's tenant works in, resolved from the session's organisation alone.
   *
   * Lives here rather than in a controller because two controllers now need it — the tree and
   * search — and a second copy of "which share am I in" is the kind of duplication that survives
   * long enough to disagree with itself once share administration lands.
   */
  /**
   * The share a request names, or the tenant's default when it names none.
   *
   * WHY THIS EXISTS. Every file endpoint used to resolve its share through `shareOf`, which is
   * `ORDER BY created_at LIMIT 1` — the FIRST share, always. So `POST /shares` could open a share,
   * Samba could publish it, and the web file manager could not see it: there was no way to say
   * which share a listing was about. A share you can create and cannot open is worse than no
   * share administration at all, because the product tells you it worked.
   *
   * A share id belonging to another tenant is `EntryNotFoundError`, the same answer as one that
   * does not exist — RLS already makes them the same query result, and they should be the same
   * ANSWER too or the parameter becomes an oracle for which share ids exist elsewhere.
   */
  async shareFor(organizationId: string, shareId: string | undefined): Promise<ShareRow> {
    if (shareId === undefined) return this.shareOf(organizationId);
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<ShareRow>(
        `SELECT id, name, dataset, read_only
           FROM public.shares
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, shareId],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new EntryNotFoundError();
    return row;
  }

  async shareOf(organizationId: string): Promise<ShareRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ slug: string }>(`SELECT slug FROM public.organizations WHERE id = $1`, [
        organizationId,
      ]),
    );
    const slug = rows[0]?.slug;
    // An organisation the session names and RLS cannot see is not a fault to report in detail:
    // the same 404 the rest of this file gives for a row belonging to somebody else.
    if (slug === undefined) throw new EntryNotFoundError();
    return this.defaultShare(organizationId, slug);
  }

  /** One page of a folder's contents. Cursor pagination, because offset silently skips rows. */
  async list(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    cursor: string | null,
    limit: number,
    sort: SortOrder = 'name',
  ): Promise<FileEntryPage> {
    const order = SORTS[sort];
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `WITH cur AS (
           SELECT kind AS c_kind, name_fold AS c_name_fold, updated_at AS c_updated_at,
                  size_bytes AS c_size_bytes, ${EXT} AS ${CUR_EXT}, id AS c_id
             FROM public.file_entries
            WHERE id = $4::uuid
         )
         SELECT ${ENTRY_COLUMNS_WITH_COUNT}
           FROM public.file_entries f
          WHERE f.organization_id = $1
            AND f.share_id = $2
            AND f.parent_id IS NOT DISTINCT FROM $3
            AND f.trashed_at IS NULL
            AND ($4::text IS NULL
                 OR EXISTS (SELECT 1 FROM cur WHERE ${order.after}))
          ORDER BY ${order.by}
          LIMIT $5`,
        [organizationId, shareId, parentId, cursor, limit + 1],
      ),
    );

    // ── KLASÖRÜN GERÇEK ÖĞE SAYISI ──────────────────────────────────────────────────────────
    //
    // Ekranın altındaki sayaç "200+ öğe" diyordu ve o "+" bir tahmin değil, bilginin yokluğuydu:
    // sayfa iki yüz satır getiriyor ve arkasında ne olduğu sorulmuyordu. Kullanıcının sorduğu
    // soru — "bu klasörde kaç dosya var" — bir sayfa sorusu değil.
    //
    // Ayrı bir COUNT, ve aynı süzgeç: listelenen klasörün görünen içeriği. Sözleşmedeki "toplam
    // yok" kuralı SÜZÜLMEMİŞ bir toplamla ilgiliydi; bu, kullanıcının zaten sayfa sayfa
    // gezebileceği listenin uzunluğu.
    //
    // ── VE İKİYE AYRILMIŞ HÂLİ ──────────────────────────────────────────────────────────────
    //
    // "48 öğe" bir klasörün kaç şey taşıdığını söylüyor ama ne taşıdığını söylemiyor, ve sahibinin
    // istediği ikincisi: *"ne kadar klasör ve dosya olduğu yazsın."* İki `FILTER`, aynı taramanın
    // üstünde — ayrı sorgular olsaydı üç kez okunurdu ve üçü birbiriyle çelişebilirdi.
    const totals = await this.db.withTenant(organizationId, (db) =>
      db.query<{ n: string; folders: string; files: string }>(
        `SELECT count(*)::text AS n,
                count(*) FILTER (WHERE kind = 'folder')::text AS folders,
                count(*) FILTER (WHERE kind = 'file')::text AS files
           FROM public.file_entries
          WHERE organization_id = $1
            AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND trashed_at IS NULL`,
        [organizationId, shareId, parentId],
      ),
    );

    return {
      ...page(rows, limit),
      total: Number(totals[0]?.n ?? '0'),
      folders: Number(totals[0]?.folders ?? '0'),
      files: Number(totals[0]?.files ?? '0'),
    };
  }

  async find(organizationId: string, id: string): Promise<FileEntryRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT ${ENTRY_COLUMNS}
           FROM public.file_entries
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      ),
    );
    const row = rows[0];
    if (!row) throw new EntryNotFoundError();
    return row;
  }

  /**
   * What `caller` may do at each of `nodes`, as resolvable inputs rather than as answers.
   *
   * ONE ancestor walk for the whole call, which is what the contract promises for `FileEntry.
   * permissions`: the rows of a page share their ancestors, so the recursive term below dedupes
   * (`UNION`, not `UNION ALL`) and a hundred siblings cost one walk plus one grant lookup. A
   * per-row query here would be the N+1 the contract names and refuses.
   *
   * `null` names the SHARE ROOT — the node `folder_grants.entry_id IS NULL` attaches to, and the
   * node a top-level entry inherits from. It is a real node in ADR-0021's tree and not a special
   * case, which is why it is a key here like any other.
   *
   * Returns `ResolveInput`s and not sets, because a move has to be judged with `canMove` over both
   * sides at once, and because the resolver in `@depsis/authz` is the ONLY place ADR-0021's rule is
   * written down. A node with no chain — another share's entry, or one that vanished between two
   * queries — is ABSENT from the map rather than present with an empty set: "I could not place this
   * node in the tree" and "the tree grants you nothing here" are different facts, and `access()`
   * turns both into the same refusal at the point where refusing is the right answer.
   */
  async accessFor(
    caller: Caller,
    shareId: string,
    nodes: readonly (string | null)[],
  ): Promise<AccessMap> {
    const targets = [...new Set(nodes.filter((node): node is string => node !== null))];
    const wantsRoot = nodes.some((node) => node === null);

    return this.db.withTenant(caller.organizationId, async (db) => {
      const subject: Subject = {
        userId: caller.userId,
        teamIds: (
          await db.query<{ team_id: string }>(
            `SELECT team_id::text AS team_id
               FROM public.team_members
              WHERE organization_id = $1 AND user_id = $2`,
            [caller.organizationId, caller.userId],
          )
        ).map((row) => row.team_id),
      };

      // Every ancestor of every target, in one statement, from `parent_id` and never from `path`
      // (ADR-0005). Bounded to the share so that a target in another one produces no chain at all
      // rather than a chain rooted at the wrong share.
      const rows =
        targets.length === 0
          ? []
          : await db.query<{ id: string; parent_id: string | null }>(
              `WITH RECURSIVE ancestry AS (
                 SELECT id, parent_id
                   FROM public.file_entries
                  WHERE organization_id = $1 AND share_id = $2 AND id = ANY($3::uuid[])
                 UNION
                 SELECT parent.id, parent.parent_id
                   FROM public.file_entries parent
                   JOIN ancestry ON parent.id = ancestry.parent_id
                  WHERE parent.organization_id = $1 AND parent.share_id = $2
               )
               SELECT id::text AS id, parent_id::text AS parent_id FROM ancestry`,
              [caller.organizationId, shareId, targets],
            );

      const parentOf = new Map<string, string | null>(rows.map((row) => [row.id, row.parent_id]));

      // Only the caller's OWN grants. Reading every principal's rows would be a bigger result for
      // no gain here — who else can reach a folder is a separate question, behind `manage`.
      //
      // Unconditional now. It used to be skipped entirely while the share had no grant rows, which
      // was the fast path for `LEGACY_OPEN_SHARE`; with that gone there is no such share, and a
      // query that returns nothing costs less than the existence test that used to guard it.
      const grantRows = await db.query<GrantRow>(
        // `permissions::text[]`: node-postgres has no parser for a custom enum's array type and
        // hands back the raw `{list,read}` literal, which every consumer would then have to
        // unpick. The cast makes it an ordinary text array the driver already knows.
        `SELECT entry_id::text AS entry_id,
                user_id::text  AS user_id,
                team_id::text  AS team_id,
                permissions::text[] AS permissions
           FROM public.folder_grants
          WHERE organization_id = $1
            AND share_id = $2
            AND (entry_id IS NULL OR entry_id = ANY($3::uuid[]))
            AND (user_id = $4 OR team_id = ANY($5::uuid[]))`,
        [caller.organizationId, shareId, [...parentOf.keys()], caller.userId, subject.teamIds],
      );

      const granted = new Map<string, Grant[]>();
      for (const row of grantRows) {
        const principal = principalOf(row);
        if (principal === null) continue;
        const permissions = row.permissions.filter(isPermission);
        if (permissions.length === 0) continue;
        const key = row.entry_id ?? ROOT;
        const existing = granted.get(key);
        if (existing === undefined) granted.set(key, [{ principal, permissions }]);
        else existing.push({ principal, permissions });
      }

      const access = new Map<string | null, ResolveInput>();
      const build = (target: string | null): void => {
        const chain = chainTo(target, shareId, parentOf, granted, caller);
        if (chain !== null) access.set(target, { chain, subject });
      };
      if (wantsRoot) build(null);
      for (const target of targets) build(target);
      return access;
    });
  }

  /** One node, as an answer. The set is empty when the node has no chain in this share. */
  async effectiveAt(
    caller: Caller,
    shareId: string,
    node: string | null,
  ): Promise<ReadonlySet<Permission>> {
    return permissionsOf(await this.accessFor(caller, shareId, [node]), node);
  }

  /**
   * Both ends of a move, in ONE call.
   *
   * §6.2 requires rights on the source AND the destination, and `canMove` exists so that no call
   * site can express half of it. Resolving both here — rather than handing the caller two sets to
   * combine — keeps the two ends inside the same ancestor walk and the same transaction, so a
   * grant written between them cannot make the pair agree on a tree that never existed.
   *
   * The two sets come back as well as the verdict, because the CALLER decides between 404 and 403
   * and needs `list` on each end to do it.
   */
  async accessForMove(
    caller: Caller,
    shareId: string,
    entryId: string,
    destination: string | null,
  ): Promise<{
    allowed: boolean;
    source: ReadonlySet<Permission>;
    destination: ReadonlySet<Permission>;
  }> {
    const access = await this.accessFor(caller, shareId, [entryId, destination]);
    const from = access.get(entryId);
    const to = access.get(destination);
    return {
      allowed: from !== undefined && to !== undefined && canMove(from, to),
      source: permissionsOf(access, entryId),
      destination: permissionsOf(access, destination),
    };
  }

  /**
   * Refuse unless the caller holds `permission` on `rootId` AND on everything under it.
   *
   * WHY THIS EXISTS: trashing and permanently deleting a folder act on a whole subtree after one
   * authorization call on the named entry. Under ADR-0021 a descendant can carry a NARROWER grant —
   * that is the only way the model can say "less here", since there is no deny — so a caller with
   * `delete` at the top could reach folders whose own row says they may not delete them. For the
   * permanent delete that is irreversible: the agent unlinks the bytes and the rows go.
   *
   * WHY IT DOES NOT RESOLVE EVERY DESCENDANT, and why that is exact rather than a shortcut: under
   * nearest-ancestor-per-principal, a node's effective set is decided by the nearest node at or
   * above it that carries a grant for one of the caller's principals. Every descendant with no
   * grant-carrying node between it and `rootId` therefore resolves to exactly what `rootId`
   * resolves to. So the distinct answers in the subtree are `rootId`'s plus one per descendant that
   * carries a grant row — and those are the only nodes worth asking about. A share with ten grant
   * rows costs eleven, not ten thousand.
   *
   * Grant rows for OTHER principals are included too. They cost nothing to resolve and filtering
   * them out here would mean re-implementing the matching rule that `packages/authz` owns.
   */
  async assertSubtreeAccess(
    caller: Caller,
    shareId: string,
    rootId: string,
    permission: Permission,
  ): Promise<void> {
    const carriers = await this.db.withTenant(caller.organizationId, (db) =>
      db.query<{ id: string }>(
        // Trashed rows are NOT filtered: a permanent delete acts on the bin, and a trashed folder
        // still carries whatever grant narrowed it.
        `WITH RECURSIVE tree AS (
           SELECT id FROM public.file_entries
            WHERE organization_id = $1 AND share_id = $2 AND id = $3
           UNION ALL
           SELECT child.id
             FROM public.file_entries child
             JOIN tree ON child.parent_id = tree.id
            WHERE child.organization_id = $1
         )
         SELECT DISTINCT g.entry_id::text AS id
           FROM public.folder_grants g
           JOIN tree ON tree.id = g.entry_id
          WHERE g.organization_id = $1 AND g.share_id = $2 AND g.entry_id <> $3`,
        [caller.organizationId, shareId, rootId],
      ),
    );
    if (carriers.length === 0) return;

    const ids = carriers.map((row) => row.id);
    const access = await this.accessFor(caller, shareId, ids);
    const refused = ids.filter((id) => !permissionsOf(access, id).has(permission)).length;
    if (refused > 0) throw new SubtreeForbiddenError(permission, refused);
  }

  /** A page of rows, each with its own set, from one walk. Keyed by entry id. */
  async effectiveForRows(
    caller: Caller,
    shareId: string,
    // `{ id }` ve `FileEntryRow` DEĞİL: bu fonksiyon satırın yalnız kimliğini okuyor, ve tam satır
    // istemek onu yalnız tam satırı olan çağıranlara açık tutuyordu. `TaskFilesService` bağ
    // tablosundan gelen kimliklerle soruyor ve bir `as never` uydurması, tipin taşımadığı bir
    // iddiayı derleyiciye zorla kabul ettirmek olurdu.
    rows: readonly { readonly id: string }[],
  ): Promise<ReadonlyMap<string, ReadonlySet<Permission>>> {
    const ids = rows.map((row) => row.id);
    const access = await this.accessFor(caller, shareId, ids);
    return new Map(ids.map((id) => [id, permissionsOf(access, id)]));
  }

  /**
   * Create a folder — ON DISK FIRST, in the database SECOND.
   *
   * The order is the project's rule and it was inverted here for as long as the agent had no
   * `mkdir`: the row was written and nothing else, so a folder existed in Postgres and did not
   * exist on the filesystem. Everything downstream inherited it. A move through such a folder
   * could only ever fail, an upload into one had no destination directory, and anybody browsing
   * the share over SMB — the entire reason a NAS exists — saw no folders at all.
   *
   * With `CreateDirectory` in the operation set the order goes the right way round, and the trade
   * that used to justify the other one is worth naming rather than hiding. The database's unique
   * index arbitrates a name collision case-INSENSITIVELY (`name_fold`, Turkish-i aware); the
   * kernel's `mkdirat` arbitrates it byte-wise. So the sibling check below runs BEFORE the agent
   * to catch the case-folded collision the filesystem cannot see, and the `INSERT` afterwards is
   * still the authority — if it loses a race, the directory the agent just made is removed again.
   * A directory with no row is invisible to every listing and unreachable by every id, which is
   * the same orphan the old ordering produced with the stores swapped.
   *
   * The owner is the CREATOR's POSIX uid. The gid is the same number, deliberately: migration 0015
   * allocates user uids and team gids from ONE counter, so a uid can be used as a group id with no
   * risk of naming a team's group by accident — the user's own private group, in the ordinary Unix
   * sense. It is not the team's gid because a folder is created before anyone has said which team
   * may see it, and guessing would put a directory under a group the creator never chose. ADR-0004
   * gives access to groups through the POSIX ACL (`ApplyFolderAcl`), not through the owning gid, so
   * nothing is lost: the owning group is a placeholder that the ACL then makes irrelevant.
   */
  async createFolder(
    organizationId: string,
    share: ShareRef,
    parentId: string | null,
    name: string,
    actorId: string,
    correlationId: string,
    reason: string,
    /**
     * The folder this one is a copy of, when it is one.
     *
     * Folders need the link for the same reason files do, and an adversarial review found out what
     * happens without it: `files.copy` identified a folder's copy by NAME, so a folder the user
     * ALREADY had in the destination was indistinguishable from one this job had created. The copy
     * silently merged into it — `docs (2)` was unreachable code — and the children landed in the
     * user's own folder.
     */
    copiedFromEntryId: string | null = null,
  ): Promise<FileEntryRow> {
    assertValidName(name);
    let parentPath = '';
    let parentComponents: string[] = [];
    if (parentId !== null) {
      const parent = await this.find(organizationId, parentId);
      if (parent.kind !== 'folder') throw new InvalidNameError('the parent is not a folder');
      // A trashed folder reads as absent rather than as a rejected parent: telling the caller the
      // folder exists but is in the bin is a distinction it cannot act on and did not earn.
      if (parent.trashed_at !== null) throw new EntryNotFoundError();
      if (parent.share_id !== share.id) throw new EntryNotFoundError();
      parentPath = parent.path;
      parentComponents = await this.componentsOf(organizationId, parentId);
    }

    // Before the agent, and before a uid is spent. The `INSERT` below would catch this too, but
    // only after a directory had been created on disk and had to be taken off again — and the
    // common case for this branch is a user clicking "new folder" twice, not a race.
    await this.requireNameFree(organizationId, share.id, parentId, name, NO_ENTRY);

    const ownerUid = await this.posix.posixUidFor(organizationId, actorId);
    const path = [...parentComponents, name];
    // The disk-conflict answer is refined here rather than inside `createDirectory`, because this
    // is the only caller that has the (share, parent) the name is scoped to. See
    // `NameTakenByTrashedEntryError`: the name can be free in the database and held on disk by
    // something the USER binned, and the generic message blames a phantom SMB client for it.
    await this.createDirectory(share.name, path, ownerUid, name, correlationId, reason).catch(
      async (error: unknown) => {
        if (!(error instanceof NameTakenOnDiskError)) throw error;
        const trashed = await this.trashedEntryHolding(organizationId, share.id, parentId, name);
        if (trashed === undefined) throw error;
        throw new NameTakenByTrashedEntryError(name, trashed, error.agentReason);
      },
    );

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `INSERT INTO public.file_entries
             (organization_id, share_id, parent_id, kind, name, path, copied_from_entry_id)
           VALUES ($1, $2, $3, 'folder', $4, $5, $6)
           RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, share.id, parentId, name, `${parentPath}/${name}`, copiedFromEntryId],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the folder row was not returned');
      return row;
    } catch (error) {
      // The directory is there and the row is not — the one window in which that can still be
      // closed from here, and the mirror of the compensating move in `move` below. Removed rather
      // than left: an empty directory nothing in the database names is not merely untidy, it is a
      // name the user cannot take again through DEPSIS and cannot see in order to understand why.
      const response = await this.agent
        .call(
          { op: 'remove_entry', share: share.name, path, directory: true },
          `undo: ${reason}`,
          correlationId,
        )
        .catch((undoError: unknown) => {
          this.logger.error(
            `created the directory ${share.name}/${path.join('/')}, then failed to record it, ` +
              `and could not remove it again: ${messageOf(undoError)}. An empty directory is on ` +
              'disk with no row naming it.',
          );
          return null;
        });
      if (response !== null && response.status !== 'removed' && response.status !== 'not_found') {
        this.logger.error(
          `created the directory ${share.name}/${path.join('/')}, then failed to record it, and ` +
            `the agent answered '${response.status}' to the removal. An empty directory is on ` +
            'disk with no row naming it.',
        );
      }
      throw this.asNameConflict(error, name);
    }
  }

  /**
   * Queue the POSIX re-application for a subtree, or say in the journal that it did not happen.
   *
   * Unconditional — there is deliberately no `agent.isAvailable()` check, for the reason
   * `PermissionsService.enqueueApply` sets out: this writes a queue row, the WORKER is what needs
   * the agent, and `available` is a startup latch that never recovers. Guarding here would mean a
   * move performed during an agent restart never reached the filesystem at all.
   *
   * A failure to enqueue is logged rather than thrown. The move itself has already happened on
   * both sides and is correct; refusing it after the fact would be worse than a stale ACL, and
   * undoing it would move a user's folder back under them without being asked.
   */
  private async enqueueAclApply(
    organizationId: string,
    shareId: string,
    entryId: string,
  ): Promise<void> {
    try {
      await this.jobs.enqueue(
        organizationId,
        APPLY_ACL_KIND,
        { shareId, entryId },
        { maxAttempts: APPLY_ACL_MAX_ATTEMPTS },
      );
    } catch (error) {
      this.logger.error(
        `moved ${entryId} in share ${shareId} but could not queue the ACL re-application: ` +
          `${messageOf(error)}. The subtree still carries the ACL of its previous parent.`,
      );
    }
  }

  /**
   * Ask the agent for ONE directory, and turn its answer into this file's errors.
   *
   * `directory_created`, `conflict` and `not_found` are all ordinary answers on this wire, so each
   * is mapped here rather than left to `expectStatus` — which would collapse the last two into one
   * refusal that says neither "the name is taken" nor "the parent is missing".
   *
   * A missing parent is retried ONCE, after materialising the ancestor chain: a folder created
   * before this operation existed is a row with no directory, and its child's `mkdirat` is exactly
   * where that shows up. Once, not in a loop — `ensureDirectories` creates every component it was
   * given, so a second failure is a condition repeating the call cannot fix.
   */
  private async createDirectory(
    shareName: string,
    path: string[],
    ownerUid: number,
    name: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const ancestors = path.slice(0, -1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.agent.call(
        {
          op: 'create_directory',
          share: shareName,
          path,
          owner_uid: ownerUid,
          // See `createFolder`: one counter allocates uids and gids, so the creator's own id is a
          // group nothing else can be holding.
          owner_gid: ownerUid,
        },
        reason,
        correlationId,
      );
      switch (response.status) {
        case 'directory_created':
          return;
        case 'conflict':
          throw new NameTakenOnDiskError(name, response.reason);
        case 'not_found': {
          if (attempt > 0 || ancestors.length === 0) {
            throw new FolderNotOnDiskError(response.reason);
          }
          const materialised = await this.ensureDirectories(
            shareName,
            [ancestors],
            ownerUid,
            correlationId,
            `${reason} (materialising an older folder)`,
          );
          if (!materialised) throw new FolderNotOnDiskError(response.reason);
          break;
        }
        default:
          expectStatus(response, 'directory_created');
      }
    }
  }

  /**
   * Give every named chain a real directory, creating whatever is missing along it.
   *
   * The answer to "what happens to folders that were created before the agent could make one".
   * They are NOT backfilled by a migration and they are not refused: a migration would have to
   * reach the filesystem from the database, which nothing in this product can do, and a refusal
   * would tell a user their folder is unusable and offer them no way to fix it. Instead the
   * directory appears the first time something actually needs it — a move through the folder, an
   * upload into it, a subfolder created under it.
   *
   * `conflict` counts as success and is the expected answer for every component but the last few:
   * the chain is walked from the share root down, so the parts that already exist say so. That
   * also makes this safe to call concurrently — two uploads into the same old folder race to
   * create the same directory and exactly one of them loses harmlessly.
   *
   * What `conflict` actually means is "SOMETHING holds that name", not "a directory does".
   * `mkdirat` returns EEXIST without distinguishing the two and the agent's own answer says so
   * outright — by this user's earlier folder, by a FILE, or by a directory made over SMB. So if a
   * component in the middle of a chain is a file, this reports the chain materialised and the
   * retried move or publish then fails further along with a less explanatory error. Treated as
   * success anyway, because the alternative is an extra probe on the common path to improve a
   * message on a path that is already an error; the cost is written down here so the next person
   * debugging "my upload fails and the folder looks fine" knows where to look.
   *
   * OWNERSHIP: a directory materialised here belongs to whoever first touched it, which is not
   * necessarily whoever created the row. The owner is `posixUidFor(organizationId, actorId)` — the
   * person MOVING through the folder or UPLOADING into it — because `file_entries` has no
   * `created_by` column (0008 gives it only `trashed_by`), so the real creator is not recoverable.
   * Combined with 0750 and the owner's private group, the consequence is concrete: when
   * administrator B moves user A's pre-`CreateDirectory` folder, the directory becomes B's and A
   * can no longer enter it over SMB. The permanent answer is the POSIX ACL (`ApplyFolderAcl`),
   * which grants by group and makes the owning uid largely irrelevant; until an API caller writes
   * those grants, this paragraph is the only place the two realities are reconciled.
   *
   * Returns whether the whole chain is now there. FALSE rather than throwing, because the caller
   * arrived here holding an error it was about to report and this is an attempt to avoid reporting
   * it — a failure means "carry on with the error you had", not "replace it with mine".
   */
  private async ensureDirectories(
    shareName: string,
    chains: readonly string[][],
    ownerUid: number,
    correlationId: string,
    reason: string,
  ): Promise<boolean> {
    let attempted = false;
    for (const chain of chains) {
      for (let depth = 1; depth <= chain.length; depth += 1) {
        attempted = true;
        const response = await this.agent.call(
          {
            op: 'create_directory',
            share: shareName,
            path: chain.slice(0, depth),
            owner_uid: ownerUid,
            owner_gid: ownerUid,
          },
          reason,
          correlationId,
        );
        // `conflict` is the component that was already there. Anything else — refused, failed,
        // not_found on a path whose parent this loop has just made — is a condition this cannot
        // work around, and the caller's original error is the better thing to report.
        if (response.status !== 'directory_created' && response.status !== 'conflict') {
          this.logger.warn(
            `could not materialise ${shareName}/${chain.slice(0, depth).join('/')}: the agent ` +
              `answered '${response.status}'`,
          );
          return false;
        }
      }
    }
    return attempted;
  }

  /** Record a file the agent has already published. */
  async recordPublishedFile(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
    sizeBytes: number,
    contentType: string | null,
    /**
     * The entry this row is a copy of, when it is one.
     *
     * Written in the SAME statement as the row, which is what makes `files.copy` idempotent: a
     * redelivered chunk asks "is there a row here whose source is this one" and gets an exact
     * answer. Asking by NAME cannot work — `keep_both` derives the name from what the destination
     * holds at that moment, and that is precisely what the first attempt changed.
     */
    copiedFromEntryId: string | null = null,
  ): Promise<FileEntryRow> {
    const parentPath = parentId === null ? '' : (await this.find(organizationId, parentId)).path;
    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `INSERT INTO public.file_entries
             (organization_id, share_id, parent_id, kind, name, path, size_bytes, content_type,
              copied_from_entry_id)
           VALUES ($1, $2, $3, 'file', $4, $5, $6, $7, $8)
           RETURNING ${ENTRY_COLUMNS}`,
          [
            organizationId,
            shareId,
            parentId,
            name,
            `${parentPath}/${name}`,
            sizeBytes,
            contentType,
            copiedFromEntryId,
          ],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the file row was not returned');
      return row;
    } catch (error) {
      throw this.asNameConflict(error, name);
    }
  }

  /**
   * Change an entry's name, keeping the bytes and the row in step.
   *
   * Delegated to `move` — same parent, new name — for FILES and FOLDERS alike, and that is not
   * tidiness. It is the fix for a divergence this method used to create on its own: it changed
   * `name` and `path` and never told the agent, so the row said `b.txt` while the disk still held
   * `a.txt`. Nothing noticed until the file was permanently deleted, when `purge` asked the agent
   * to remove `b.txt`, the agent answered `not_found`, the row went, and `a.txt` stayed on disk —
   * readable over SMB, counting against the dataset's refquota, unreachable through DEPSIS forever.
   * The user had been told it was permanently deleted.
   *
   * The FOLDER half of that exception is gone with this change. It was justified by a folder having
   * no directory to rename, which stopped being true the moment `CreateDirectory` landed: a folder
   * created from now on has one, and an older folder gets one materialised on the way through. A
   * folder rename that skipped the agent would leave the directory under its old name — the same
   * split as above, and a worse one, because everything inside the folder inherits it.
   */
  async rename(
    organizationId: string,
    id: string,
    name: string,
    share: ShareRef,
    actorId: string,
    correlationId: string,
    reason: string,
  ): Promise<FileEntryRow> {
    assertValidName(name);
    const entry = await this.find(organizationId, id);
    if (entry.trashed_at !== null) throw new EntryNotFoundError();

    return this.move(
      organizationId,
      id,
      share,
      { parentId: entry.parent_id, name },
      actorId,
      correlationId,
      reason,
    );
  }

  /**
   * Move an entry into another folder — ON DISK FIRST, in the database SECOND.
   *
   * The order is the whole design and it is not reversible. If the row moved first and the agent
   * then refused, the row would name a place the bytes are not: every download would resolve
   * `componentsOf` to the new path, find nothing, and answer 404, while an SMB client kept showing
   * the file in the old folder. That is the two-realities split this product does not accept, and
   * it is unrecoverable without a reconciliation pass that does not exist yet. The other order
   * fails safely: a successful rename followed by a failed `UPDATE` is a file the database still
   * describes correctly enough to find, and the compensating move below closes even that.
   *
   * A rename is expressible here too — `name` alongside `parentId` — because on the filesystem the
   * two are one `renameat2`. Splitting them into two agent calls would put a window between them in
   * which the entry sits in the destination under its old name.
   */
  async move(
    organizationId: string,
    id: string,
    share: ShareRef,
    target: { parentId: string | null; name?: string | undefined },
    actorId: string,
    correlationId: string,
    reason: string,
  ): Promise<FileEntryRow> {
    const entry = await this.find(organizationId, id);
    // A trashed entry has no place in the tree to move within, and the same 404 a rename gives is
    // the honest answer: as far as every listing is concerned it is not there.
    if (entry.trashed_at !== null || entry.share_id !== share.id) throw new EntryNotFoundError();

    const name = target.name ?? entry.name;
    assertValidName(name);

    let parentPath = '';
    if (target.parentId !== null) {
      const parent = await this.find(organizationId, target.parentId);
      if (parent.trashed_at !== null) throw new EntryNotFoundError();
      if (parent.share_id !== entry.share_id) throw new CrossShareMoveError();
      if (parent.kind !== 'folder') throw new InvalidNameError('the destination is not a folder');
      // Only a folder can contain itself, and only a folder has descendants to be swallowed by
      // the cycle — a file's move is always acyclic.
      if (
        entry.kind === 'folder' &&
        (await this.isSelfOrDescendant(organizationId, parent.id, id))
      ) {
        throw new MoveIntoDescendantError(entry.name);
      }
      parentPath = parent.path;
    }

    if (entry.parent_id === target.parentId && name === entry.name) return entry;

    // Asked of the database BEFORE the agent, even though the agent's `RENAME_NOREPLACE` refuses a
    // taken destination anyway. Two reasons: the database folds case and the Turkish i and the
    // kernel does not, so a collision the index will refuse can be invisible to `renameat2`; and a
    // row whose bytes are missing would let the rename succeed and the `UPDATE` then fail on the
    // unique index — the one ordering that leaves the file moved and the row behind.
    await this.requireNameFree(organizationId, entry.share_id, target.parentId, name, id);

    // Same upgrade `createFolder` performs, and reachable by the same route: a rename onto the name
    // of a BINNED sibling passes `requireNameFree` and is then refused by `renameat2`, because
    // trashing never took the directory off the disk. Without this the user is told to "rename one
    // of them" about something the listing does not show.
    const upgradeTrashedConflict = async (error: unknown): Promise<never> => {
      if (!(error instanceof NameTakenError)) throw error;
      const trashed = await this.trashedEntryHolding(
        organizationId,
        entry.share_id,
        target.parentId,
        name,
      );
      if (trashed === undefined) throw error;
      throw new NameTakenByTrashedEntryError(name, trashed, error.message);
    };

    const from = await this.componentsOf(organizationId, id);
    const to =
      target.parentId === null
        ? [name]
        : [...(await this.componentsOf(organizationId, target.parentId)), name];

    await this.moveOnDisk(share.name, from, to, name, correlationId, reason).catch(
      async (error: unknown) => {
        if (error instanceof NameTakenError) return upgradeTrashedConflict(error);
        if (!(error instanceof EntryMissingOnDiskError)) throw error;

        // `EntryMissingOnDiskError` says "the two stores disagree", which is the right thing to
        // say when they do and a slander on the database when they do not. Before saying it, try
        // the one benign explanation there is: a folder somewhere in this move predates
        // `CreateDirectory`, so it is a row with no directory and the agent's `open_dir` hit
        // ENOENT on a path that is otherwise perfectly correct.
        //
        // Three ways a folder gets into it: the entry being moved IS one (there is nothing to
        // rename), the source sits inside one, or the destination is one. The last two are what
        // the component counts test — a path of length 1 is at the share root. A file moved from
        // one root name to another touches no folder at all, and for it the original error stands.
        const chains: string[][] = [];
        if (from.length > 1) chains.push(from.slice(0, -1));
        if (to.length > 1) chains.push(to.slice(0, -1));
        // The folder itself, at its OLD location. Created empty and then renamed, which is exactly
        // what the move was asking for: its children are rows that will materialise on their own
        // first use, and there is nothing on disk under the old name to lose.
        if (entry.kind === 'folder') chains.push(from);
        if (chains.length === 0) throw error;

        const ownerUid = await this.posix.posixUidFor(organizationId, actorId);
        const materialised = await this.ensureDirectories(
          share.name,
          chains,
          ownerUid,
          correlationId,
          `${reason} (materialising an older folder)`,
        );
        if (!materialised) throw new FolderNotOnDiskError(error.agentReason);

        // Once, not in a loop. Everything the first attempt could have been missing has now been
        // created, so a second `not_found` is a state a third call cannot change.
        await this.moveOnDisk(share.name, from, to, name, correlationId, reason).catch(
          async (retryError: unknown) => {
            if (retryError instanceof EntryMissingOnDiskError) {
              throw new FolderNotOnDiskError(retryError.agentReason);
            }
            if (retryError instanceof NameTakenError) {
              return upgradeTrashedConflict(retryError);
            }
            throw retryError;
          },
        );
      },
    );

    const newPath = `${parentPath}/${name}`;
    try {
      const moved = await this.db.withTenant(organizationId, async (db) => {
        const rows = await db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET parent_id = $3, name = $4, path = $5
            WHERE organization_id = $1 AND id = $2
            RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, id, target.parentId, name, newPath],
        );
        const row = rows[0];
        if (!row) throw new EntryNotFoundError();

        await rebuildSubtreePaths(db, organizationId, id);
        return row;
      });

      // THE MOVE CHANGED WHICH GRANTS THIS SUBTREE INHERITS, so the kernel has to be told.
      //
      // ADR-0021 resolves from the ancestor chain, and the chain is exactly what a move replaces:
      // a folder taken out of an open parent and dropped into a locked-down one is closed in the
      // application layer on the very next request. On disk nothing happened — `renameat2`
      // preserves a directory's access and default ACLs, and POSIX default-ACL inheritance only
      // ever runs at CREATE time, so the subtree arrives still carrying the entries the OLD
      // parent's grants produced and stays reachable over SMB.
      //
      // Only for a FOLDER. A file has no ACL of DEPSIS's making — permissions are set on folders
      // and a file inherits from the one it sits in (`NotAFolderError` says so) — so moving a file
      // changes nothing an apply could write.
      //
      // After the transaction and never inside it, the ordering every other enqueue here uses:
      // `JobsService.enqueue` opens its own tenant transaction.
      if (moved.kind === 'folder') await this.enqueueAclApply(organizationId, share.id, id);
      return moved;
    } catch (error) {
      // The file is at its new name and the row is not. Put it back, because the alternative is
      // exactly the divergence the ordering above exists to prevent — and this is the one window
      // in which it can still be closed from here.
      await this.moveOnDisk(
        share.name,
        to,
        from,
        entry.name,
        correlationId,
        `undo: ${reason}`,
      ).catch((undoError: unknown) => {
        this.logger.error(
          `moved ${share.name}/${from.join('/')} to ${to.join('/')} on disk, then failed to ` +
            `record it, and could not move it back: ${messageOf(undoError)}. The database still ` +
            `describes the OLD location; the file is at the new one.`,
        );
      });
      throw this.asNameConflict(error, name);
    }
  }

  /**
   * Delete an entry and everything under it, permanently: from the leaves up.
   *
   * One `RemoveEntry` per node, deepest first, and the row goes only after the agent says its
   * entry is gone. The agent has no recursive delete and will not get one (ADR-0006, §2.2): an
   * operation whose blast radius the caller chooses is `rm -rf` behind a typed name, and the API
   * is the side that knows the tree because the API is the side that stores it.
   *
   * NOT atomic, and it cannot be — there is no transaction spanning a filesystem and a database.
   * Each node is committed as it is removed, so an interruption leaves the removed ones removed
   * and the rest still in the trash, and calling again continues from there. That is what the
   * contract promises, and it is also why an agent answer of `not_found` counts as success below:
   * a retry after a crash between the unlink and the `DELETE` must not deadlock on the row it is
   * there to clean up.
   *
   * The whole subtree goes, including children whose own `trashed_at` is null. Trashing a folder
   * sets one flag on one row, so its children are unreachable rather than trashed — and
   * `parent_id`'s `ON DELETE RESTRICT` would refuse to leave them behind in any case.
   */
  /**
   * Bir dizinde veritabanının bilmediği ne varsa siler, ve kaç şey sildiğini söyler.
   *
   * ── NEDEN VAR ───────────────────────────────────────────────────────────────────────────────
   *
   * `purge` yalnız satırı olan şeyleri siliyor, ajan ise boş olmayan bir dizini silmiyor. Aradaki
   * boşlukta kalan bir dosya, çöpteki klasörü kalıcı olarak silinemez yapıyordu — ve kullanıcının
   * arayüzde ne onu görmesinin ne de temizlemesinin bir yolu vardı.
   *
   * ── SINIRLAR ────────────────────────────────────────────────────────────────────────────────
   *
   * DERİNLİK SINIRI VAR. Ajanın listelemesi bir yanıt sınırıyla kırpılabiliyor ve bir bağ döngüsü
   * teorik olarak mümkün; sekiz seviye, bir çöp klasörünün altında beklenenden fazlası, ve
   * aşıldığında sessizce durmak yerine sayı eksik dönüyor — çağıran o zaman `rmdir`ın yine
   * çakışmasıyla dürüst bir 409 alıyor.
   *
   * `.depsis` BURAYA GELMİYOR: ajan onu kendi ağacı sayıp reddediyor, ve bu doğru — ara alan
   * kullanıcının çöpünün konusu değil.
   */
  private async sweepUnknown(
    share: ShareRef,
    parts: readonly string[],
    correlationId: string,
    reason: string,
    depth: number,
  ): Promise<number> {
    if (depth >= 8) return 0;
    const listing = await this.agent.call(
      { op: 'list_directory', share: share.name, path: [...parts] },
      reason,
      correlationId,
    );
    if (listing.status !== 'listing') return 0;

    let removed = 0;
    for (const entry of listing.entries) {
      const child = [...parts, entry.name];
      if (entry.directory) {
        removed += await this.sweepUnknown(share, child, correlationId, reason, depth + 1);
      }
      const response = await this.agent.call(
        {
          op: 'remove_entry',
          share: share.name,
          path: child,
          directory: entry.directory,
        },
        reason,
        correlationId,
      );
      if (response.status === 'removed' || response.status === 'not_found') {
        removed += 1;
        this.logger.warn(
          `${share.name}/${child.join('/')}: veritabanının bilmediği bir öğe, kalıcı silme ` +
            'sırasında diskten kaldırıldı',
        );
      }
    }
    return removed;
  }

  /** Bir düğümün satırını ve ona bağlı yükleme oturumlarını siler. */
  private async dropRows(organizationId: string, id: string): Promise<void> {
    await this.db.withTenant(organizationId, async (db) => {
      await db.query(
        `DELETE FROM public.upload_sessions
          WHERE organization_id = $1 AND (parent_id = $2 OR file_id = $2)`,
        [organizationId, id],
      );
      await db.query(`DELETE FROM public.file_entries WHERE organization_id = $1 AND id = $2`, [
        organizationId,
        id,
      ]);
    });
  }

  async purge(
    organizationId: string,
    id: string,
    share: ShareRef,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const entry = await this.find(organizationId, id);
    if (entry.share_id !== share.id) throw new EntryNotFoundError();
    // 409 rather than a silent deletion. The trash is the click between a user and permanent data
    // loss; an endpoint that skipped it on request would make the trash optional, which is the
    // same as not having one.
    if (entry.trashed_at === null) throw new NotTrashedError(entry.name);

    const root = await this.componentsOf(organizationId, id);
    const nodes = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string; kind: 'file' | 'folder'; parts: string[] }>(
        `WITH RECURSIVE tree AS (
           SELECT id, kind, 0 AS depth, $3::text[] AS parts
             FROM public.file_entries
            WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT child.id, child.kind, tree.depth + 1, tree.parts || child.name
             FROM public.file_entries child
             JOIN tree ON child.parent_id = tree.id
            WHERE child.organization_id = $1
         )
         SELECT id, kind, parts FROM tree ORDER BY depth DESC, id`,
        [organizationId, id, root],
      ),
    );

    for (const node of nodes) {
      const response = await this.agent.call(
        {
          op: 'remove_entry',
          share: share.name,
          path: node.parts,
          directory: node.kind === 'folder',
        },
        reason,
        correlationId,
      );
      // ── DOLU BİR KLASÖR ARTIK ÇIKMAZ SOKAK DEĞİL ────────────────────────────────────────
      //
      // Ajan boş olmayan bir dizini silmiyor (`rmdir`, özyinelemeli değil ve öyle kalmalı), ve bu
      // döngü yalnız VERİTABANININ BİLDİĞİ satırları siliyor. İkisi bir araya gelince sahada bir
      // kilit oluştu: çöpteki bir klasörün içinde DEPSIS'in hiç indekslemediği bir dosya vardı,
      // kalıcı silme her seferinde 409 dönüyordu, ve kullanıcının arayüzde ne o dosyayı görmesinin
      // ne de klasörü temizlemesinin bir yolu vardı. Tek çıkış ağ sürücüsünden elle silmekti —
      // yani bu ürünün kabul etmediği türden bir çıkış.
      //
      // Dosyanın neden bilinmediği ayrı bir hikâye ve aynı köke çıkıyor: uzlaştırma yürüyüşü
      // ÇÖPTEKİ klasörlerin içine bakmıyor (`trashed_at IS NULL`), ve zaten uzun süre hiç
      // koşmamıştı.
      //
      // İNDEKSLEMİYORUZ, SİLİYORUZ. Satır yaratıp sonra silmek `IndexerService`e bağımlılık
      // isterdi (ve o zaten `FilesService`e bağlı — döngü), üstelik saniyeler ömürlü satırlar
      // üretirdi. Ajana "bu dizinde ne var" diye sorup her birini silmek aynı sonucu veriyor:
      // kullanıcı zaten "bu klasörü ve içindekileri kalıcı olarak sil" dedi.
      //
      // SESSİZ DEĞİL: silinen her ad günlüğe yazılıyor, çünkü bunlar veritabanının hiç bilmediği
      // ve kullanıcının hiç görmediği dosyalar.
      if (response.status === 'conflict' && node.kind === 'folder') {
        const swept = await this.sweepUnknown(share, node.parts, correlationId, reason, 0);
        if (swept > 0) {
          const retry = await this.agent.call(
            { op: 'remove_entry', share: share.name, path: node.parts, directory: true },
            reason,
            correlationId,
          );
          if (retry.status === 'removed' || retry.status === 'not_found') {
            await this.dropRows(organizationId, node.id);
            continue;
          }
        }
      }
      if (response.status === 'conflict') throw new DirectoryNotEmptyError(response.reason);
      // `not_found` beside `removed`, and it is the line that makes a retry work: an entry that is
      // already gone is the end state this call exists to produce, so the row goes too. Refusing
      // here instead would leave a crash between the unlink and the DELETE as a row nothing can
      // ever clean up.
      if (response.status !== 'removed' && response.status !== 'not_found') {
        expectStatus(response, 'removed');
      }
      if (response.status === 'not_found' && node.kind === 'file') {
        // The one direction this endpoint can be wrong in that nobody would ever find out about.
        // A folder may have no directory on disk — every folder created before `CreateDirectory`
        // existed is a row alone, and one that was never used has never been materialised — so
        // `not_found` for one is unremarkable; a FILE the agent cannot find means either a retry
        // after a crash — the
        // case the acceptance above exists for — or bytes sitting somewhere the database does not
        // name, which this call is about to make unreachable by deleting the only row that knew
        // about them. They stay readable over SMB and keep counting against the dataset's
        // refquota. It is still accepted, because refusing would make a crashed purge permanently
        // unretryable, but it is written down with enough to find the file by hand.
        this.logger.error(
          `permanently deleting ${share.name}/${node.parts.join('/')}: the agent reports no such ` +
            `entry (${response.reason}). If this is not a retry of an interrupted delete, the ` +
            'bytes are still on disk with no row left to reach them.',
        );
      }

      // One transaction per node, deliberately. A single transaction around the loop would roll
      // the rows back while leaving every unlink done — the database would then describe files
      // that no longer exist, which is the divergence this endpoint is most able to cause.
      await this.db.withTenant(organizationId, async (db) => {
        // BEFORE the entry, in the same transaction. `upload_sessions` is bound to `file_entries`
        // twice, and the two halves no longer stand in the same place:
        //
        //   `file_id`   ON DELETE SET NULL. Bu yarı eskiden engelliyordu, çünkü
        //               `upload_sessions_completion_pair` NULL bir `file_id`i dolu bir
        //               `completed_at` yanında reddediyordu; göç 0054 kuralı gerçeğe uydurdu ve
        //               artık kendi kendine çözülüyor.
        //   `parent_id` ON DELETE RESTRICT, ve BU hâlâ engelliyor — bilerek: bir klasörü silmek,
        //               ona yapılmakta olan yüklemeleri sessizce koparmamalı. Silen taraf
        //               temizlemek zorunda, ve burası silen taraf.
        //
        // Bedeli ölçülmüştü: web'den yüklenmiş bir dosya ya da hiç yükleme hedefi olmuş bir klasör
        // kalıcı olarak silinemiyordu — ajan baytları kaldırıyor, sonra DELETE kısıta çarpıyor ve
        // çöpte hiçbir yeniden denemenin temizleyemeyeceği, verisi çoktan gitmiş bir satır
        // kalıyordu.
        //
        // Oturum SİLİNİYOR, koparılmıyor: bir oturum bir dosyaya YAPILAN transferin kaydı, ve
        // dosya kalıcı olarak gittiyse oturum hiçbir şeyi tarif etmiyor. Aktarım listesinden
        // kayboluyor — çöpü boşaltan kullanıcının istediği şeyin ta kendisi.
        // `IndexerService.forget` aynı kararı aynı gerekçeyle veriyor.
        await db.query(
          `DELETE FROM public.upload_sessions
            WHERE organization_id = $1 AND (parent_id = $2 OR file_id = $2)`,
          [organizationId, node.id],
        );
        await db.query(`DELETE FROM public.file_entries WHERE organization_id = $1 AND id = $2`, [
          organizationId,
          node.id,
        ]);
      });
    }
  }

  /** Is the privileged agent reachable? Endpoints that need it answer 503 when it is not. */
  agentAvailable(): boolean {
    return this.agent.isAvailable();
  }

  /**
   * Ask the agent to rename one entry, and turn its answer into this file's errors.
   *
   * `moved`, `not_found` and `conflict` are all ORDINARY answers on this wire — the agent reports
   * them as outcomes, not faults — so each is mapped here rather than left to `expectStatus`,
   * which would collapse the last two into a single unhelpful refusal.
   */
  private async moveOnDisk(
    share: string,
    from: string[],
    to: string[],
    name: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    const response = await this.agent.call(
      { op: 'move_entry', share, from, to },
      reason,
      correlationId,
    );
    switch (response.status) {
      case 'moved':
        return;
      case 'not_found':
        throw new EntryMissingOnDiskError(response.reason);
      // `RENAME_NOREPLACE` refused: something is already at the destination and the source has not
      // moved. The name is what the user has to change, which is what `NameTakenError` says.
      //
      // `requireNameFree` has already passed at this point, so the thing holding the destination is
      // NOT a visible sibling — it is on disk only. Most often that is an SMB-made entry, but the
      // routine case is a folder the user binned: trashing writes `trashed_at` and leaves the
      // directory, while the unique index and `requireNameFree` both exclude trashed rows, so the
      // database frees the name and the disk does not. `move` upgrades this error when it can
      // identify that row; see `NameTakenByTrashedEntryError`.
      case 'conflict':
        throw new NameTakenError(name);
      default:
        expectStatus(response, 'moved');
    }
  }

  /**
   * Is `candidateId` the folder itself, or somewhere underneath it?
   *
   * Walked UP from the candidate rather than down from the folder: an upward walk visits one row
   * per level and stops at the share root, while a downward one visits the whole subtree to prove
   * a negative.
   */
  private async isSelfOrDescendant(
    organizationId: string,
    candidateId: string,
    folderId: string,
  ): Promise<boolean> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ hit: number }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id
             FROM public.file_entries
            WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT parent.id, parent.parent_id
             FROM public.file_entries parent
             JOIN up ON parent.id = up.parent_id
            WHERE parent.organization_id = $1
         )
         SELECT 1 AS hit FROM up WHERE id = $3 LIMIT 1`,
        [organizationId, candidateId, folderId],
      ),
    );
    return rows.length > 0;
  }

  /** The destination sibling set, checked for the name before anything privileged happens. */
  private async requireNameFree(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
    exceptId: string,
  ): Promise<void> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        // `name_fold`, not `name`: uniqueness is case- and Turkish-i-folded, so a check on the raw
        // name would pass here and then hit the unique index after the file had already moved.
        `SELECT id FROM public.file_entries
          WHERE organization_id = $1
            AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND name_fold = public.fold_identity($4)
            AND trashed_at IS NULL
            AND id <> $5
          LIMIT 1`,
        [organizationId, shareId, parentId, name, exceptId],
      ),
    );
    if (rows.length > 0) throw new NameTakenError(name);
  }

  /**
   * The id of the TRASHED entry holding `name` here, if there is one.
   *
   * The exact inverse of `requireNameFree`: same scope, same folding, `trashed_at IS NOT NULL`
   * instead of `IS NULL`. Called only after the agent has already refused the name on disk, so it
   * runs on a path that has failed rather than on every create.
   *
   * `name_fold` for the same reason `requireNameFree` uses it — uniqueness is case- and
   * Turkish-i-folded, so a raw-name comparison would miss the 'İSTANBUL'/'istanbul' pair that the
   * index treats as one name and that the disk, which is byte-exact, may or may not.
   */
  private async trashedEntryHolding(
    organizationId: string,
    shareId: string,
    parentId: string | null,
    name: string,
  ): Promise<string | undefined> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ id: string }>(
        `SELECT id FROM public.file_entries
          WHERE organization_id = $1
            AND share_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
            AND name_fold = public.fold_identity($4)
            AND trashed_at IS NOT NULL
          ORDER BY trashed_at DESC
          LIMIT 1`,
        [organizationId, shareId, parentId, name],
      ),
    );
    return rows[0]?.id;
  }

  /**
   * Move to the trash.
   *
   * A flag on the row, not a move to another table: a second table would mean a new id on the way
   * back, and the id is what tasks, shares and audit entries point at. The bytes are not touched —
   * emptying the trash is what asks the agent to unlink, and that is a separate decision a user
   * has to make.
   */
  async trash(organizationId: string, id: string, userId: string): Promise<FileEntryRow> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `UPDATE public.file_entries
            SET trashed_at = now(), trashed_by = $3
          WHERE organization_id = $1 AND id = $2 AND trashed_at IS NULL
          RETURNING id, share_id, parent_id, kind, name, path, size_bytes, content_type,
                    trashed_at, created_at, updated_at`,
        [organizationId, id, userId],
      ),
    );
    const row = rows[0];
    if (!row) throw new EntryNotFoundError();
    return row;
  }

  /**
   * Take it back out of the trash.
   *
   * Can fail with a name conflict, and that is correct rather than unfortunate: the partial unique
   * index deliberately excludes trashed rows so the name is free again the moment something is
   * deleted. If somebody has since taken it, restoring silently under a suffixed name would hide
   * which file is which.
   *
   * Restoring something already out of the trash is a no-op rather than an error, so a client that
   * retries a request whose response it never saw gets the same answer the first attempt gave.
   */
  async restore(organizationId: string, id: string): Promise<FileEntryRow> {
    const entry = await this.find(organizationId, id);
    if (entry.trashed_at === null) return entry;

    // The parent has to be out of the trash first — see `TrashedParentError`. Checked before the
    // UPDATE and not after, because the alternative is restoring the row and then rolling back a
    // change the caller may already have been told about.
    if (entry.parent_id !== null) {
      const parent = await this.find(organizationId, entry.parent_id);
      if (parent.trashed_at !== null) throw new TrashedParentError(parent.name);
    }

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<FileEntryRow>(
          `UPDATE public.file_entries
              SET trashed_at = NULL, trashed_by = NULL
            WHERE organization_id = $1 AND id = $2
            RETURNING ${ENTRY_COLUMNS}`,
          [organizationId, id],
        ),
      );
      const row = rows[0];
      if (!row) throw new EntryNotFoundError();
      return row;
    } catch (error) {
      throw this.asNameConflict(error, entry.name);
    }
  }

  /**
   * The trash, most recently discarded first, one page at a time.
   *
   * Flat and not a tree, because the trash is a column rather than a folder: trashing a directory
   * sets the flag on that one row and leaves its children pointing at a parent that is no longer
   * in any listing. Nesting the view would therefore show the children twice or not at all
   * depending on which row the user happened to delete, so it shows every trashed row at one level.
   *
   * The keyset is `(trashed_at, id)` and not `trashed_at` alone. Emptying a folder trashes many
   * rows inside one statement, and `now()` is fixed for a whole transaction — so a page boundary
   * that lands in the middle of such a batch would, with a `trashed_at`-only cursor, either repeat
   * the whole batch or skip the rest of it. The id breaks the tie and is unique by definition.
   */
  async listTrash(
    organizationId: string,
    shareId: string,
    cursor: string | null,
    limit: number,
  ): Promise<FileEntryPage> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        `SELECT ${TRASH_COLUMNS}
           FROM public.file_entries e
           LEFT JOIN public.file_entries p ON p.id = e.parent_id
          WHERE e.organization_id = $1
            AND e.share_id = $2
            AND e.trashed_at IS NOT NULL
            AND ($3::uuid IS NULL
                 OR (e.trashed_at, e.id) < (SELECT trashed_at, id
                                              FROM public.file_entries
                                             WHERE id = $3::uuid))
          ORDER BY e.trashed_at DESC, e.id DESC
          LIMIT $4`,
        [organizationId, shareId, cursor, limit + 1],
      ),
    );

    return page(rows, limit);
  }

  /**
   * Name search across the caller's share.
   *
   * Both sides go through `depsis_norm`. Normalising only the stored side is the bug ADR-0010 was
   * written against: `name_norm` holds `istanbul` for a file called `İstanbul`, so a user who types
   * the file's own name back gets nothing. The function is the same one the generated column uses,
   * which is what makes the two comparable at all.
   *
   * Ordering is prefix-first and similarity-second, and the pair is deliberate. Trigram similarity
   * alone ranks a short name containing the query above a long name STARTING with it, so typing
   * `rapor` puts `x-rapor-y.txt` above `Rapor 2026 Q1.pdf` — the opposite of what someone who is
   * navigating rather than exploring wants. Prefix is the strong signal; similarity only breaks
   * the ties inside each of the two groups.
   *
   * Matching itself is a plain substring, not the `%` similarity operator. `%` is governed by
   * `pg_trgm.similarity_threshold`, a session GUC nothing in this codebase sets, so the set of
   * results would depend on a value an operator can change out from under the API. A substring the
   * user typed is a result the user can explain.
   */
  async search(
    organizationId: string,
    shareId: string,
    scopeId: string | null,
    query: string,
    cursor: string | null,
    limit: number,
  ): Promise<FileEntryPage> {
    // `%` and `_` are LIKE wildcards, and a user typing either into a search box means the
    // character, not "match anything". Escaped here rather than stripped, so searching for a file
    // whose name genuinely contains one still finds it. The backslash is LIKE's default escape.
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
    const pattern =
      query.length < TRIGRAM_MIN_LENGTH
        ? `public.depsis_norm($7::text) || '%'`
        : `'%' || public.depsis_norm($7::text) || '%'`;

    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<FileEntryRow>(
        // The ranking keys are stored NEGATED — `NOT is_prefix`, `-similarity` — so that all four
        // sort ascending. That is what lets the cursor be a single row-value comparison; with
        // mixed directions the keyset predicate has to be expanded into nested ORs, which is the
        // form that quietly drops or repeats rows when somebody edits it later.
        `WITH RECURSIVE scope_tree AS (
           SELECT id
             FROM public.file_entries
            WHERE organization_id = $1 AND parent_id = $4::uuid
           UNION ALL
           SELECT child.id
             FROM public.file_entries child
             JOIN scope_tree ON child.parent_id = scope_tree.id
            WHERE child.organization_id = $1
         ),
         matched AS (
           SELECT ${ENTRY_COLUMNS}, name_fold,
                  NOT (name_norm LIKE public.depsis_norm($7::text) || '%') AS rank_prefix,
                  -public.similarity(name_norm, public.depsis_norm($3::text)) AS rank_score
             FROM public.file_entries
            WHERE organization_id = $1
              AND share_id = $2
              AND trashed_at IS NULL
              AND ($4::uuid IS NULL OR id IN (SELECT id FROM scope_tree))
              AND name_norm LIKE ${pattern}
         )
         SELECT ${ENTRY_COLUMNS}
           FROM matched
          WHERE ($5::uuid IS NULL
                 OR (rank_prefix, rank_score, name_fold, id)
                    > (SELECT rank_prefix, rank_score, name_fold, id
                         FROM matched WHERE id = $5::uuid))
          ORDER BY rank_prefix, rank_score, name_fold, id
          LIMIT $6`,
        [organizationId, shareId, query, scopeId, cursor, limit + 1, escaped],
      ),
    );

    return page(rows, limit);
  }

  /**
   * Turn PostgreSQL's unique violation into something the HTTP layer can answer 409 with.
   *
   * Matching on SQLSTATE `23505` rather than on the message: the message contains the index name
   * and is localised by the server's `lc_messages`, so a box installed in Turkish would stop
   * producing 409s and start producing 500s.
   */
  private asNameConflict(error: unknown, name: string): Error {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if ((error as { code?: string }).code === '23505') return new NameTakenError(name);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * The entry's location inside its share, as validated components.
   *
   * Walked up `parent_id` rather than split out of the `path` column, and the difference is not
   * cosmetic. ADR-0005 makes `parent_id` the authority and `path` a derived cache that a rename
   * updates afterwards — for a large subtree, in a job. Splitting the cache would mean that during
   * that job a download resolves to where the file USED to be: a 404 at best, and at worst a read
   * of whatever now occupies the old name.
   *
   * One recursive query rather than a loop of them, so the answer is a single consistent snapshot.
   */
  async componentsOf(organizationId: string, id: string): Promise<string[]> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ name: string; depth: number }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id, name, 0 AS depth
             FROM public.file_entries
            WHERE organization_id = $1 AND id = $2
           UNION ALL
           SELECT parent.id, parent.parent_id, parent.name, up.depth + 1
             FROM public.file_entries parent
             JOIN up ON parent.id = up.parent_id
            WHERE parent.organization_id = $1
         )
         SELECT name, depth FROM up ORDER BY depth DESC`,
        [organizationId, id],
      ),
    );
    if (rows.length === 0) throw new EntryNotFoundError();
    return rows.map((r) => r.name);
  }

  /**
   * Open a published file for reading and get a one-time token for the data socket.
   *
   * `size` comes back from the agent's own descriptor. The caller should prefer it over the
   * `size_bytes` column when validating a Range: the column is what DEPSIS last recorded, and a
   * file changed over SMB is precisely the case where the two differ.
   */
  async openDownload(
    share: string,
    components: string[],
    correlationId: string,
    reason: string,
  ): Promise<{ token: string; size: number }> {
    const response = await this.agent.call(
      { op: 'open_download', share, path: components },
      reason,
      correlationId,
    );
    const opened = expectStatus(response, 'download');
    return { token: opened.token, size: opened.size };
  }

  /**
   * Bir klasörün altındaki dosyaların toplam boyutu.
   *
   * Listeleme sorgusu bu sayıyı zaten sütun olarak üretiyor ama `find` üretmiyor — tek bir satırı
   * okuyan her yol için alt ağaç toplamak, satırı okuyan çoğu yolun istemediği bir iş. Arşiv
   * yolunun ona ihtiyacı var, o yüzden ayrıca soruyor.
   *
   * `LIKE` değil ARALIK, ve sebebi 0048 numaralı göçte yazılı: önek satırın kendi yolundan
   * geliyor, ve içinde `%` ya da `_` olan bir klasör adı deseni jokere çevirip komşu klasörleri de
   * toplardı.
   *
   * KARŞILAŞTIRMA `COLLATE "C"` ile. Veritabanının harmanlaması ICU (`und-x-icu`), ve o sırada
   * `&`, `#`, `+`, `~`, `^`, `=` gibi karakterler `/` ile `0` ARASINDA geliyor: `Proje`
   * klasörünün aralığına kardeşi `Proje+notlar.zip` giriyor, yani bir klasörün boyutu yanındaki
   * dosyanın baytlarını da sayıyordu. `C` harmanlaması metni BAYT sırasıyla karşılaştırıyor —
   * aralığın "tam olarak bu alt ağaç" demesinin tek yolu bu — ve 0062'nin
   * `(share_id, path COLLATE "C")` indeksi de yalnız aynı harmanlamayla yazılmış bir
   * karşılaştırmaya hizmet ediyor.
   */
  async subtreeBytes(organizationId: string, id: string): Promise<number> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ bytes: string }>(
        `SELECT coalesce(sum(d.size_bytes), 0)::text AS bytes
           FROM public.file_entries f
           JOIN public.file_entries d
             ON d.share_id = f.share_id
            AND d.kind = 'file'
            AND d.trashed_at IS NULL
            AND d.path COLLATE "C" >= f.path || '/'
            AND d.path COLLATE "C" < f.path || '0'
          WHERE f.organization_id = $1 AND f.id = $2`,
        [organizationId, id],
      ),
    );
    return Number(rows[0]?.bytes ?? 0);
  }

  /**
   * Bir klasörü arşivleyip indirmeye açar.
   *
   * Dönen şey `openDownload`un döndürdüğünün AYNISI — bir jeton ve bir boy — çünkü ajan arşivi
   * yazdıktan sonra bağını siliyor ve geriye yalnızca o indirmenin okuyabildiği adsız bir düğüm
   * kalıyor. Çağıran için ikisi arasında hiçbir fark yok: aynı veri yuvası, aynı `receive`.
   *
   * ── ÖNCE YER VAR MI ──────────────────────────────────────────────────────────────────────
   *
   * Arşiv üretilirken havuza YAZILIYOR, yani 1,5 TB'lık bir klasörü indirmek geçici olarak 1,5
   * TB yer istiyor. Kontrol bir garanti değil ve olamaz — aradaki saniyede başka bir yükleme yeri
   * alabilir, ajan `ENOSPC`i kendi başına da sınıflandırıyor — ama sık olan durumu çeviriyor:
   * havuzu doldurup her yazmayı bozmadan önce, iki sayıyı ekranda söylüyor.
   *
   * Sıkıştırmayı HESABA KATMIYOR, yani ölçüt gerçekte olacaktan yüksek. Bu bilerek: fazla
   * temkinli bir ret, dolmuş bir havuzdan ucuz.
   */
  async openArchive(
    share: { name: string; dataset: string },
    components: string[],
    estimatedBytes: number,
    correlationId: string,
    reason: string,
  ): Promise<{ token: string; size: number }> {
    const pool = share.dataset.split('/')[0] ?? share.dataset;
    const status = await this.agent
      .call({ op: 'pool_status', pool }, reason, correlationId)
      .catch(() => null);
    // Ajan cevap veremediyse geçiyoruz: bu bir nezaket kontrolü, ve onu bir kapıya çevirmek
    // havuz durumunu okuyamayan bir cihazda indirmeyi tamamen kapatırdı.
    if (status?.status === 'pool_status' && estimatedBytes > status.available_bytes) {
      throw new ArchiveTooLargeError(estimatedBytes, status.available_bytes);
    }

    const response = await this.agent.call(
      {
        op: 'archive_folder',
        share: share.name,
        path: components,
        // Ad yalnızca `tar` yazarken var oluyor, ve iki eşzamanlı indirmenin çakışmaması için
        // rastgele. Uzantısı yok: dosya adına dönüşen şey istemciye giden başlık, bu değil.
        staging_name: `archive-${randomUUID()}`,
      },
      reason,
      correlationId,
    );
    const opened = expectStatus(response, 'download');
    return { token: opened.token, size: opened.size };
  }

  /**
   * Ask the agent to publish a staged file into the tree.
   *
   * `ownerUid` and `ownerGid` are the UPLOADER's, resolved by the caller from
   * `PosixIdentityService`. The agent refuses 0 for both, and its own comment explains why that
   * refusal is deliberate rather than defensive: a publish that skipped the mapping produces a
   * file inside a tenant's share that the tenant does not own, which is not visible as a fault
   * until they try to change it over SMB.
   *
   * A `not_found` on the way in is retried ONCE after materialising the destination's parent
   * chain. Uploading into a folder created before `CreateDirectory` existed is the whole of that
   * case: the staged bytes are fine, the row is fine, and the only thing missing is the directory
   * the file is meant to land in. Refusing there would make every pre-existing folder permanently
   * unusable as an upload target.
   */
  async publish(
    share: string,
    stagingName: string,
    destination: string[],
    expectedBytes: number,
    ownerUid: number,
    ownerGid: number,
    correlationId: string,
    reason: string,
  ): Promise<number> {
    const request = {
      op: 'publish_transfer',
      share,
      staging_name: stagingName,
      destination,
      expected_bytes: expectedBytes,
      owner_uid: ownerUid,
      owner_gid: ownerGid,
    } as const;

    const response = await this.agent.call(request, reason, correlationId);
    if (response.status !== 'not_found' || destination.length < 2) {
      return expectStatus(response, 'publish').bytes;
    }

    const materialised = await this.ensureDirectories(
      share,
      [destination.slice(0, -1)],
      ownerUid,
      correlationId,
      `${reason} (materialising an older folder)`,
    );
    if (!materialised) throw new FolderNotOnDiskError(response.reason);

    const retried = await this.agent.call(request, reason, correlationId);
    if (retried.status === 'not_found') throw new FolderNotOnDiskError(retried.reason);
    return expectStatus(retried, 'publish').bytes;
  }
}

/** An unknown thrown value, as something a log line can carry. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
