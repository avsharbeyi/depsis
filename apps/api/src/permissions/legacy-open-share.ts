import type { Permission } from '@depsis/authz';

/**
 * WHAT A MEMBER GETS IN A SHARE THAT NOBODY HAS WRITTEN A SINGLE GRANT FOR — AND WHY.
 *
 * ADR-0021's rule applied to today's data would leave every existing appliance with nothing: there
 * are no `folder_grants` rows anywhere yet, the walk therefore finds nothing for anybody, and a
 * NAS whose owner can no longer list their own files is not a stricter product, it is a broken one.
 * A migration writing a default grant per share would be the tidier answer and the round that
 * introduced §6.2 could not write migrations, so the fallback lives here, in code, where it can be
 * read.
 *
 * The rule: **while a share has NO grant rows at all, every member of the tenant gets exactly the
 * seven permissions this API served before §6.2 existed.** The moment ANY grant is written
 * anywhere in that share, the fallback is gone for the whole share and ADR-0021 decides every
 * question — including for the folders nobody named, which then grant nothing and disappear from
 * listings.
 *
 * Share-wide rather than per-chain, and that is the load-bearing half. A per-chain fallback ("no
 * grant above this folder, so open it") would mean the first grant somebody writes can only ever
 * WIDEN access: the rest of the tree would stay open, the person would believe they had restricted
 * something, and nothing in the product would tell them otherwise. Share-wide makes switching the
 * model on a single observable event.
 *
 * It is observably NOT the same thing as a root grant that happens to name everyone. A root grant
 * names principals: a user outside them sees nothing. The fallback names nobody and applies to
 * every member, so removing a person from a team changes what they can see under a root grant and
 * changes nothing at all under the fallback. `files.integration.test.ts` pins that difference.
 *
 * Note what the fallback does NOT include: `manage`. Nobody can write the first grant of a share
 * by inheriting the right to from this constant — the first grant is an administrator's to write
 * (ADR-0021 §5), which is the only bootstrap that does not let the model open itself.
 *
 * IT LIVES IN `permissions/` RATHER THAN IN `files/`, and that placement is the fix for a real
 * divergence rather than a filing preference. It began as a private constant inside
 * `FilesService`, which meant `GET /files` reported these seven on an ungranted appliance while
 * `GET /files/{id}/permissions` — resolving the same node through `PermissionsService` — reported
 * an empty set for the same caller in the same second. Two endpoints answering one question two
 * ways is the pair of realities §6.2 exists to prevent, and the version of it that is hardest to
 * argue with, because the endpoint that lies is the one whose whole job is to explain access. One
 * module owns the exception now, and both readers of it import from here.
 *
 * HOW IT IS REMOVED. When share administration lands and a new share is created with a root grant
 * of its own — or a migration backfills one for every share that predates §6.2 — delete this file,
 * delete the two call sites `shareIsGoverned` has, and delete the tests that name it. The
 * condition for removal is simply "no share can exist with zero grants".
 */
export const LEGACY_OPEN_SHARE: readonly Permission[] = [
  'list',
  'read',
  'download',
  'create',
  'modify',
  'move',
  'delete',
];
