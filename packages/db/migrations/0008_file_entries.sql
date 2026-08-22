-- 0008 — the row that describes a file.
--
-- Until now nothing in this schema described a file. The agent could stage and publish bytes and
-- the API could talk to it, but there was no place to record that a file exists, so there was
-- nothing to list, nothing to search, nothing to put in a trash can and nothing to hang an ACL on.
-- Every remaining Phase 1 feature waits on this table.
--
-- ADR-0005 governs the identity model, ADR-0010 the search column.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- `pg_trgm` for substring name search, `unaccent` for the search normaliser below. Both are
-- contrib extensions present in the postgresql-contrib package the installer already requires.
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- ─── the search normaliser ────────────────────────────────────────────────────
--
-- ADR-0010, and every detail below was measured in P0-H rather than reasoned about:
--
--   * `translate()` runs BEFORE `lower()`. PostgreSQL's `lower()` does not apply Turkish dotted-I
--     rules and can turn 'İ' into 'i' plus a combining dot, so the Turkish letters are mapped to
--     ASCII first.
--   * The target string is entirely lower case. An earlier draft mapped the lower-case Turkish
--     letters to UPPER-case ASCII and still produced the right answer — but only because `lower()`
--     happened to run afterwards. This function has to be correct independently of its callers.
--   * Both the function AND the dictionary are schema-qualified. The unqualified form works in a
--     plain query, works in a GENERATED column, and even works when building an expression index
--     in the session that created the function — and fails only when an index is built in a
--     SEPARATE session, because PostgreSQL restricts `search_path` during index construction.
--     Migrations are exactly that separate session, so the unqualified form would have shipped and
--     broken here.
--   * IMMUTABLE is not optional: both overloads of `unaccent` are STABLE, so a generated column
--     cannot call them directly. This wrapper is the only way to get an indexable expression.
--
-- NOT to be used for uniqueness. It is lossy on purpose — it collides 'Çağrı' with 'Cagri', which
-- is right for a search box and would reject legitimate filenames if it decided collisions.
CREATE OR REPLACE FUNCTION public.depsis_norm(txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT lower(
           public.unaccent('public.unaccent'::regdictionary,
             translate(normalize(txt, NFKC),
                       'İIıŞşĞğÜüÖöÇç',
                       'iiissgguuoocc')
           )
         )
$$;

COMMENT ON FUNCTION public.depsis_norm(text) IS
  'Search normalisation only (ADR-0010). Accent-stripping and therefore lossy; use '
  'public.fold_identity for uniqueness keys.';

GRANT EXECUTE ON FUNCTION public.depsis_norm(text) TO depsis_app, depsis_backup;

-- ─── shares ───────────────────────────────────────────────────────────────────
--
-- A share is the root of a tree and the unit the agent confines to: its `name` is the first
-- component every `openat2(RESOLVE_BENEATH)` resolution starts from, which is why the format
-- constraint is as narrow as the agent's own `SafeComponent` type. A name that this table would
-- accept and the agent would refuse is a share that exists in the database and nowhere else.
CREATE TABLE public.shares (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,

  name            text        NOT NULL,
  -- The ZFS dataset behind it, e.g. 'tank/shares/alice'. Recorded rather than derived: the pool
  -- name is chosen at install time and a share created before a rename must keep pointing at the
  -- dataset it was actually created on.
  dataset         text        NOT NULL,
  read_only       boolean     NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Matches op::SafeComponent in the agent: no slash, no leading dot, no dash-leading name that
  -- could be read as a flag.
  CONSTRAINT shares_name_format CHECK (name ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$')
);

-- Tenant-scoped, per ADR-0013 §2.2. Case-folded so 'Belgeler' and 'belgeler' cannot both exist —
-- SMB clients are case-insensitive and two such shares would be indistinguishable to them.
CREATE UNIQUE INDEX shares_name_unique
  ON public.shares (organization_id, public.fold_identity(name));

CREATE TRIGGER shares_set_updated_at
  BEFORE UPDATE ON public.shares
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.shares ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.shares FORCE   ROW LEVEL SECURITY;

CREATE POLICY shares_owner_full ON public.shares
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY shares_tenant_isolation ON public.shares
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── file entries ─────────────────────────────────────────────────────────────
--
-- One row per folder or file. ADR-0005's three identity layers, kept apart:
--
--   logical   `id`, `parent_id`          — what an ACL, a task link or an API URL refers to
--   physical  `(inode, ino_generation)`  — the join key reconciliation uses to recognise a file
--                                          that was renamed outside DEPSIS, so its id survives
--   presentation `name`, `path`          — display, SMB mapping, search. NEVER an authorisation
--                                          input: authority resolves through `id`, and the
--                                          filesystem is reached with openat2 from a root fd.
CREATE TABLE public.file_entries (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  share_id        uuid        NOT NULL REFERENCES public.shares (id)        ON DELETE RESTRICT,

  -- NULL means "directly under the share root". RESTRICT rather than CASCADE: deleting a folder
  -- has to go through the trash and then through the agent, because the bytes live on a
  -- filesystem this database cannot reach. A cascade here would drop the metadata and leave the
  -- files, which is the one outcome from which nothing can recover them.
  parent_id       uuid        REFERENCES public.file_entries (id) ON DELETE RESTRICT,

  kind            text        NOT NULL,
  name            text        NOT NULL,

  -- Two normalisations, deliberately different columns (ADR-0005 §"Kimlik ve isim çakışması").
  -- `fold_identity` decides COLLISIONS: case and the Turkish i-family, accents preserved.
  -- `depsis_norm` feeds SEARCH: additionally accent-stripping, and therefore unusable for
  -- uniqueness — it would refuse 'Çağrı.txt' beside an existing 'Cagri.txt'.
  name_fold       text        GENERATED ALWAYS AS (public.fold_identity(name)) STORED,
  name_norm       text        GENERATED ALWAYS AS (public.depsis_norm(name))   STORED,

  -- Derived from the parent chain and kept for display, SMB mapping and search. `parent_id` is the
  -- authority; a rename updates this subtree in one transaction, or hands it to a job when the
  -- subtree is large. Authorisation is unaffected while that job runs, because it never reads this.
  path            text        NOT NULL,

  size_bytes      bigint      NOT NULL DEFAULT 0,
  content_type    text,

  -- Physical identity. Nullable because a folder created through the API exists as a row before
  -- anything has stat'ed it, and because reconciliation (ADR-0011) is not built yet. When it is,
  -- these are what stop an SMB rename from destroying a file's id and everything linked to it.
  inode           bigint,
  ino_generation  bigint,

  -- The trash. A row, not a separate table: moving between two tables loses the id on the way
  -- back, and the id is the thing tasks, shares and audit entries point at.
  trashed_at      timestamptz,
  trashed_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_entries_kind CHECK (kind IN ('folder', 'file')),
  -- One component, never a path. A name containing a slash would make `path` ambiguous and would
  -- be refused by the agent anyway; catching it here means the row never exists.
  CONSTRAINT file_entries_name_component CHECK (name !~ '/' AND name <> '' AND name <> '.' AND name <> '..'),
  CONSTRAINT file_entries_size_nonnegative CHECK (size_bytes >= 0),
  -- A folder has no bytes of its own. Without this a listing could report a directory's size as
  -- whatever a caller last wrote there.
  CONSTRAINT file_entries_folder_has_no_size CHECK (kind = 'file' OR size_bytes = 0),
  CONSTRAINT file_entries_trash_pair CHECK ((trashed_at IS NULL) = (trashed_by IS NULL))
);

-- Uniqueness, in two partial indexes rather than one.
--
-- `UNIQUE (organization_id, parent_id, name_fold)` alone does NOT constrain the top level of a
-- share: `parent_id` is NULL there and NULL is distinct from NULL, so every root would accept
-- unlimited duplicates. Splitting on the null gives both levels a real constraint.
--
-- Both are partial on `trashed_at IS NULL`, so a trashed file does not hold its name hostage —
-- otherwise a user who deleted `report.pdf` could not upload a new `report.pdf` until the trash
-- was emptied. Both carry `organization_id` as ADR-0013 §2.2 requires.
CREATE UNIQUE INDEX file_entries_name_unique_in_folder
  ON public.file_entries (organization_id, parent_id, name_fold)
  WHERE parent_id IS NOT NULL AND trashed_at IS NULL;

CREATE UNIQUE INDEX file_entries_name_unique_at_share_root
  ON public.file_entries (organization_id, share_id, name_fold)
  WHERE parent_id IS NULL AND trashed_at IS NULL;

-- Listing a folder: the ordinary read, so it gets its own covering order.
CREATE INDEX file_entries_listing
  ON public.file_entries (organization_id, share_id, parent_id, kind, name_fold)
  WHERE trashed_at IS NULL;

-- Search. Two indexes because ADR-0010 branches on query length: a prefix query of one or two
-- characters is below pg_trgm's useful threshold and takes the B-tree instead.
CREATE INDEX file_entries_name_norm_trgm
  ON public.file_entries USING gin (name_norm public.gin_trgm_ops)
  WHERE trashed_at IS NULL;

CREATE INDEX file_entries_name_norm_prefix
  ON public.file_entries (organization_id, name_norm text_pattern_ops)
  WHERE trashed_at IS NULL;

-- The trash view, and the sweep that will eventually expire it.
CREATE INDEX file_entries_trashed
  ON public.file_entries (organization_id, trashed_at)
  WHERE trashed_at IS NOT NULL;

-- Reconciliation's join key (ADR-0005 step 2). Partial because the columns are null until
-- something has stat'ed the file.
CREATE INDEX file_entries_physical_identity
  ON public.file_entries (share_id, inode, ino_generation)
  WHERE inode IS NOT NULL;

CREATE TRIGGER file_entries_set_updated_at
  BEFORE UPDATE ON public.file_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.file_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_entries FORCE  ROW LEVEL SECURITY;

CREATE POLICY file_entries_owner_full ON public.file_entries
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY file_entries_tenant_isolation ON public.file_entries
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── upload sessions ──────────────────────────────────────────────────────────
--
-- A tus upload is many HTTP requests, so its state has to outlive any one of them AND outlive an
-- API restart — §21 requires a feature to survive a restart, and "resumable" means nothing if a
-- deploy makes every in-flight upload restart from zero.
--
-- `offset_bytes` is a CACHE, not the authority. The agent seeks the staging file itself on every
-- OpenTransfer and refuses a mismatched offset, so a stale value here produces a refusal the
-- client can correct with a HEAD — never a duplicated or missing region.
CREATE TABLE public.upload_sessions (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  share_id        uuid        NOT NULL REFERENCES public.shares (id)        ON DELETE RESTRICT,
  parent_id       uuid        REFERENCES public.file_entries (id) ON DELETE RESTRICT,
  created_by      uuid        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,

  -- The name the finished file will take. Checked against the same component rules as an entry,
  -- so an upload cannot be created that could never be published.
  filename        text        NOT NULL,
  -- The name of the staging file inside `<share>/.depsis/staging/`. Derived from `id` rather than
  -- from `filename`: two users uploading `report.pdf` into different folders must not collide on
  -- one staging name, and a staging name is a SafeComponent the agent will accept.
  staging_name    text        NOT NULL,

  length_bytes    bigint      NOT NULL,
  offset_bytes    bigint      NOT NULL DEFAULT 0,

  -- Set when the staging file has been published into the tree. A completed session is kept so a
  -- client retrying its last PATCH gets a coherent answer instead of a 404.
  file_id         uuid        REFERENCES public.file_entries (id) ON DELETE SET NULL,
  completed_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT upload_sessions_filename_component
    CHECK (filename !~ '/' AND filename <> '' AND filename <> '.' AND filename <> '..'),
  CONSTRAINT upload_sessions_length_nonnegative CHECK (length_bytes >= 0),
  CONSTRAINT upload_sessions_offset_within_length
    CHECK (offset_bytes >= 0 AND offset_bytes <= length_bytes),
  CONSTRAINT upload_sessions_completion_pair CHECK ((completed_at IS NULL) = (file_id IS NULL))
);

CREATE UNIQUE INDEX upload_sessions_staging_unique
  ON public.upload_sessions (organization_id, share_id, staging_name);

CREATE INDEX upload_sessions_incomplete
  ON public.upload_sessions (organization_id, created_at)
  WHERE completed_at IS NULL;

CREATE TRIGGER upload_sessions_set_updated_at
  BEFORE UPDATE ON public.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_sessions FORCE  ROW LEVEL SECURITY;

CREATE POLICY upload_sessions_owner_full ON public.upload_sessions
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY upload_sessions_tenant_isolation ON public.upload_sessions
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── grants ───────────────────────────────────────────────────────────────────
-- Forgotten once already in 0007, which failed twelve tests with "permission denied": RLS decides
-- WHICH ROWS a role may touch and says nothing about whether it may touch the table at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shares       TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_entries TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.upload_sessions TO depsis_app;
GRANT SELECT ON public.shares       TO depsis_backup;
GRANT SELECT ON public.file_entries TO depsis_backup;
GRANT SELECT ON public.upload_sessions TO depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.upload_sessions;
DROP TABLE IF EXISTS public.file_entries;
DROP TABLE IF EXISTS public.shares;
DROP FUNCTION IF EXISTS public.depsis_norm(text);
