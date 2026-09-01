import { Injectable } from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { DbService } from '../db/db.service.js';
import { EntryNotFoundError, FilesService } from '../files/files.service.js';

type Schemas = OpenApi.components['schemas'];

/** The document the contract describes, and the only shape this column ever holds. */
export type Preferences = Schemas['Preferences'];

/**
 * The document was refused, and the caller can fix it.
 *
 * One error class for the whole of validation rather than one per rule, because the answer is the
 * same in every case — 422 with a sentence saying which field is wrong. The distinctions that
 * matter to a client are in the message, not in the type.
 */
export class PreferencesRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PreferencesRejectedError';
  }
}

/**
 * `.strict()` at every level.
 *
 * Migration 0012 chose `jsonb` so that a visual tweak is not a migration, and the price of that
 * choice is that the database cannot check the contents. This schema is what pays it: without a
 * closed object here, `jsonb` is a place where a renamed field quietly accumulates alongside its
 * replacement until something reads the column and finds two answers.
 *
 * WHERE THIS SITS AGAINST THE PUBLISHED SCHEMA. `depsis.yaml` now closes all three objects —
 * `additionalProperties: false` on `Preferences`, on `background` and on the `shortcuts` item — and
 * marks `kind` required on a background and `id`/`cell` required on a shortcut. Every bound below
 * is the document's: 32 for `preset`, 128 for a shortcut id, 64 for its label, 0–999 for its cell,
 * 60 items. An earlier version of this comment listed those as divergences the document owed; it
 * has since paid them, and the list is gone rather than left standing as a warning about a gap that
 * no longer exists.
 *
 * What is left is the ONE rule JSON Schema is not asked to carry: `preset` is required when `kind`
 * is `solid` and `fileId` when `kind` is `file`. Expressible as a `oneOf`, and deliberately not
 * written that way — a `oneOf` over three variants turns the generated client's `background` into a
 * union nobody wants to hold — so the document states it in the field's description and points at
 * the 422, and `assertBackgroundIsUsable` below is where it is actually enforced. The description
 * also carries the two rules about what a `fileId` may name; those are lookups, and no schema of
 * any kind could check them.
 */
const backgroundSchema = z
  .object({
    kind: z.enum(['sky', 'solid', 'file']),
    preset: z.string().max(32).optional(),
    fileId: z.string().uuid().optional(),
  })
  .strict();

const shortcutSchema = z
  .object({
    id: z.string().max(128),
    label: z.string().max(64).optional(),
    cell: z.number().int().min(0).max(999),
  })
  .strict();

/**
 * Hizli erisim seridindeki klasorler.
 *
 * KLASORUN VARLIGI DOGRULANMIYOR, ve bu bilerek. Duvar kagidi alani tam bunu yapiyordu: silinen
 * bir dosyayi adlandiran bir belge, KISAYOL DUZENI DAHIL her tercih yazmasini kalici olarak
 * reddettiriyordu. Silinmis bir favori en fazla seritte bir kez tiklanip "bulunamadi" der.
 */
const favoriteSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(255),
    trail: z
      .array(z.object({ id: z.string().uuid(), name: z.string().max(255) }).strict())
      .max(24),
  })
  .strict();

export const preferencesSchema = z
  .object({
    background: backgroundSchema.optional(),
    sound: z.boolean().optional(),
    favorites: z.array(favoriteSchema).max(40).optional(),
    // 60 is the contract's cap and also roughly a screenful. The reason there is a cap at all is
    // that this array is written by a drag handler: a loop in one would otherwise grow the row
    // until it hit the 64 KiB CHECK, which reports as a constraint violation rather than as the
    // bug it is.
    shortcuts: z.array(shortcutSchema).max(60).optional(),
  })
  .strict();

type BackgroundInput = z.infer<typeof backgroundSchema>;

/**
 * One person's view of the appliance: their background, whether it makes a sound, and where they
 * dragged their shortcuts.
 *
 * Kept on the server rather than in `localStorage` because `localStorage` belongs to a browser —
 * the same person signing in from a phone has to find the desk they arranged, and a preference
 * that does not travel is a preference most people only set once and then stop trusting.
 */
@Injectable()
export class PreferencesService {
  constructor(
    private readonly db: DbService,
    private readonly files: FilesService,
  ) {}

  /**
   * Read the document, or an empty one.
   *
   * No row is created here. A read that writes turns opening the home screen into a write on every
   * cold start, and it would also mean the absence of a row — the honest signal that this person
   * has never chosen anything — could not survive being looked at.
   */
  async read(organizationId: string, userId: string): Promise<Preferences> {
    const rows = await this.db.withTenant(organizationId, (db) =>
      db.query<{ data: Preferences }>(
        `SELECT data
           FROM public.user_preferences
          WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, userId],
      ),
    );
    // `{}` and 200, not 404. "This person has not chosen a background" is the default state of
    // every new account, and an error code would make every client treat the normal case as a
    // failure it has to special-case.
    const stored = rows[0]?.data ?? {};

    // ── ARTIK VAR OLMAYAN BİR DUVAR KÂĞIDI OKUMADA DÜŞÜYOR ────────────────────────────────
    //
    // SAHADA OLAN. Kullanıcı duvar kâğıdı olarak bir dosya seçmişti; o dosya sonradan yok oldu.
    // Belge ölü kimliği taşımaya devam etti, ve yazma yolu haklı olarak "böyle bir dosya yok"
    // diye reddetti (422). Ama bu belge BÜTÜN olarak yazılıyor: kullanıcı bir kısayolu
    // sürüklediğinde de aynı ölü kimlik yeniden gönderiliyor ve aynı reddi alıyor. Sonuç,
    // duvar kâğıdıyla hiç ilgisi olmayan bir işlemin — kısayol düzeni — kalıcı olarak
    // çalışmaması, ve ekranın bunun sebebini söyleyememesi.
    //
    // Çıkış yolu okuma tarafında: ölü kimlik istemciye HİÇ VERİLMİYOR, yani bir sonraki yazma
    // onu taşımıyor ve kilit kendiliğinden açılıyor. Kullanıcının gördüğü şey duvar kâğıdının
    // varsayılana dönmesi — ki dosya gerçekten yok olduğu için ekranda zaten olan buydu.
    //
    // KAYIT DEĞİŞTİRİLMİYOR. Okuma bir yazma yoluna dönmemeli; satır bir sonraki gerçek yazmada
    // zaten temiz hâliyle üstüne yazılıyor.
    if (stored.background?.kind === 'file') {
      const fileId = stored.background.fileId;
      const usable =
        fileId !== undefined &&
        // Yazma tarafının üç kuralının aynısı: dosya var, klasör değil, ve çöpte değil.
        (await this.files
          .find(organizationId, fileId)
          .then((entry) => entry.kind === 'file' && entry.trashed_at === null)
          .catch(() => false));
      if (!usable) {
        const { background: _dead, ...rest } = stored;
        return rest;
      }
    }
    return stored;
  }

  /**
   * Replace the document wholesale.
   *
   * Whole-document replacement, not a merge, and that is the contract's decision rather than a
   * simplification: a merge would let two open tabs each write half a shortcut layout and produce
   * a third layout neither person arranged.
   *
   * One statement, because the alternative — read, decide, write — loses one of two simultaneous
   * writers. `ON CONFLICT` makes the insert and the update the same statement, so the second
   * writer overwrites rather than failing on the primary key.
   */
  async write(organizationId: string, userId: string, body: unknown): Promise<Preferences> {
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success) throw new PreferencesRejectedError(explain(parsed.error));

    await this.assertBackgroundIsUsable(organizationId, parsed.data.background);

    try {
      const rows = await this.db.withTenant(organizationId, (db) =>
        db.query<{ data: Preferences }>(
          `INSERT INTO public.user_preferences (organization_id, user_id, data)
                VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (organization_id, user_id)
           DO UPDATE SET data = EXCLUDED.data
             RETURNING data`,
          [organizationId, userId, JSON.stringify(parsed.data)],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error('the preferences row was not returned');
      // What the database now holds, rather than what was sent. The two are the same document
      // here, and returning the stored one is what lets a client see that the round trip agreed
      // with it instead of assuming so.
      return row.data;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * A background the interface can actually draw.
   *
   * The check exists because an unvalidated `fileId` is a background that 404s on every single
   * load: the person picks a wallpaper, deletes the file a week later, and from then on their home
   * screen asks for bytes that are not there — with nothing in the failure pointing at the
   * preference that caused it.
   *
   * Only the fileId LOOKUP is checked when the background IS a file. A stale `fileId` left behind
   * by someone who switched back to the drawn sky is unused, and refusing to save their sound
   * setting because of a wallpaper they are no longer using would be the same bug from the other
   * side.
   *
   * The two requiredness rules below, and the two lookups after them, are what the contract states
   * in `Preferences.background`'s description rather than in its schema — see the schema comment at
   * the top of this file for why they are prose there and code here.
   */
  private async assertBackgroundIsUsable(
    organizationId: string,
    background: BackgroundInput | undefined,
  ): Promise<void> {
    if (background === undefined) return;

    if (background.kind === 'solid' && background.preset === undefined) {
      throw new PreferencesRejectedError(
        "background.preset is required when background.kind is 'solid'",
      );
    }
    if (background.kind !== 'file') return;

    const fileId = background.fileId;
    if (fileId === undefined) {
      throw new PreferencesRejectedError(
        "background.fileId is required when background.kind is 'file'",
      );
    }

    // Through `FilesService`, so the lookup runs under the caller's tenant and RLS answers the
    // question. Another tenant's file and a file that never existed come back as one outcome, and
    // that is the same refusal to build an existence oracle the file endpoints make.
    const entry = await this.files.find(organizationId, fileId).catch((error: unknown) => {
      if (error instanceof EntryNotFoundError) {
        throw new PreferencesRejectedError('background.fileId names no file you can read');
      }
      throw error;
    });

    if (entry.kind !== 'file') {
      throw new PreferencesRejectedError('background.fileId names a folder, not a file');
    }
    // A trashed entry still has a row and still has an id, so `find` returns it. It has no bytes
    // to serve once the trash is emptied, which makes it exactly as unusable as a missing one.
    if (entry.trashed_at !== null) {
      throw new PreferencesRejectedError('background.fileId names a file that is in the trash');
    }
  }
}

/**
 * The first thing wrong with the document, in a sentence.
 *
 * A field name and a reason, because "invalid preferences" tells a client nothing it can act on
 * and the person who has to act on it is a developer reading a 422 body.
 */
function explain(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'the preferences document was refused';
  const where =
    issue.path.length === 0 ? 'the preferences document' : issue.path.map(String).join('.');
  return `${where}: ${issue.message}`;
}

/**
 * PostgreSQL's SQLSTATE, not its message.
 *
 * The text carries the constraint name and is localised by the server's `lc_messages`, so a box
 * installed in Turkish would stop producing 422s and start producing 500s with nothing in this
 * repository noticing.
 */
function translateDbError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    // `user_preferences_bounded` (64 KiB) or `user_preferences_is_object`. The zod bounds above
    // should keep every accepted document well under the size cap, so reaching this means a bound
    // here and a bound in the schema have drifted apart — which is a refusal the caller can still
    // understand, not a server fault.
    if ((error as { code?: string }).code === '23514') {
      return new PreferencesRejectedError('the preferences document is too large to store');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
