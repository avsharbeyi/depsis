-- 0012 — the things on the desk.
--
-- The v5 interface draft shows a working appliance rather than a file list: notes, a shared job
-- board, shortcuts arranged on the home screen, a chosen background, a record of backups. None of
-- those had anywhere to live, so the interface either had to fake them or drop them, and faking
-- them was never an option.
--
-- Four tables, and the reason they are one migration rather than four is that they are one
-- decision: DEPSIS keeps a small amount of per-tenant state that is not a file. Splitting them
-- would suggest they were argued separately.
--
-- What is deliberately NOT here:
--
--   * a terminal. ADR-0006 forbids shell execution from the application layer, and a table would
--     not change that.
--   * an application catalogue. There is no container runtime in this product, so a table of
--     installed apps would describe nothing.
--   * remote access. ZeroTier is Phase 3 and is a daemon, not a row.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── notes ────────────────────────────────────────────────────────────────────
--
-- Private to their author, and that is the conservative reading rather than an obvious one. A
-- household note board shared across the appliance would be more useful, but sharing needs a rule
-- about who may read whose notes, and this schema has no ACL model yet (§6.2 is Phase 2). Between
-- shipping a private notepad and shipping a shared one whose visibility rules were invented at the
-- controller, the private one is the change that cannot surprise anybody.
--
-- `ON DELETE CASCADE` on the author, unlike everything else in this schema, which uses RESTRICT.
-- The difference is what is lost: a file entry points at bytes that outlive the account, so its
-- deletion has to be refused; a note is only its own text, and keeping one belonging to a deleted
-- account would leave unreachable rows nothing can ever show.
CREATE TABLE public.notes (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  author_id       uuid        NOT NULL REFERENCES public.users (id)         ON DELETE CASCADE,

  title           text        NOT NULL,
  body            text        NOT NULL DEFAULT '',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- An empty title makes a list of notes unreadable, and the interface has nothing to show in the
  -- row. Length is capped so a paste accident cannot make one note fill the sidebar.
  CONSTRAINT notes_title_present CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT notes_body_bounded  CHECK (length(body) <= 65536)
);

-- The only read this table gets: one author's notes, newest edit first.
CREATE INDEX notes_by_author ON public.notes (organization_id, author_id, updated_at DESC);

CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE  ROW LEVEL SECURITY;

CREATE POLICY notes_owner_full ON public.notes
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY notes_tenant_isolation ON public.notes
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── tasks ────────────────────────────────────────────────────────────────────
--
-- Shared, unlike notes, and the difference is not inconsistency: the v5 draft groups jobs BY
-- PERSON with an avatar per group, which only means something if everyone can see the board. A
-- job assigned to someone who cannot see it has not been assigned.
--
-- `assignee_id` is nullable because "somebody should do this" is a real state and forcing a name
-- onto it at creation time is how shared lists stop being used.
CREATE TABLE public.tasks (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  assignee_id     uuid        REFERENCES public.users (id) ON DELETE SET NULL,
  created_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  body            text        NOT NULL,

  -- A timestamp, not a boolean. "Done" and "done at 14:02 yesterday" cost the same to store, and
  -- the second one can answer questions the first cannot.
  done_at         timestamptz,

  -- Manual ordering within an assignee's group. A float rather than an integer so a task dragged
  -- between two others is one UPDATE instead of renumbering the list.
  position        double precision NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tasks_body_present CHECK (btrim(body) <> '' AND length(body) <= 2000)
);

CREATE INDEX tasks_board ON public.tasks (organization_id, assignee_id, position, created_at);

CREATE TRIGGER tasks_set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks FORCE  ROW LEVEL SECURITY;

CREATE POLICY tasks_owner_full ON public.tasks
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY tasks_tenant_isolation ON public.tasks
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── per-user interface preferences ───────────────────────────────────────────
--
-- One row per person: which background they chose, whether the interface makes sounds, and where
-- they dragged their shortcuts.
--
-- `jsonb`, and a column per preference would be the wrong shape here for a specific reason: these
-- are presentation facts whose set changes every time the interface changes. A column per
-- preference means a migration per visual tweak, and migrations are the one thing in this project
-- that cannot be undone casually. The trade is that the database cannot check the contents, so the
-- API validates the document with zod before writing — an unvalidated jsonb column is a place
-- where malformed state accumulates until something reads it.
--
-- The size cap is not decoration. Shortcut layouts are written by a drag handler, and a bug in one
-- would otherwise grow this row without limit.
CREATE TABLE public.user_preferences (
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  user_id         uuid        NOT NULL REFERENCES public.users (id)         ON DELETE CASCADE,

  data            jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (organization_id, user_id),

  CONSTRAINT user_preferences_is_object CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT user_preferences_bounded   CHECK (pg_column_size(data) <= 65536)
);

CREATE TRIGGER user_preferences_set_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_preferences_owner_full ON public.user_preferences
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY user_preferences_tenant_isolation ON public.user_preferences
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── snapshots ────────────────────────────────────────────────────────────────
--
-- What DEPSIS has snapshotted, which is NOT the same as what the pool holds — and the distinction
-- is the whole reason this table exists rather than a listing endpoint.
--
-- The agent's operation set is closed (ADR-0006) and contains `CreateSnapshot` and
-- `DiffSnapshots` but no "list snapshots". Adding one is a change to the Rust contract, so until
-- somebody makes that change the honest thing an interface can show is a record of the snapshots
-- it took itself. A snapshot made from a shell on the box will not appear here, and the interface
-- must say so rather than imply this is the pool's inventory.
--
-- `full_name` is what the agent returned — `dataset@name`. Recorded verbatim rather than
-- reassembled, because the value the agent confirmed is the one a later diff has to be given.
CREATE TABLE public.snapshots (
  id              uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  created_by      uuid        REFERENCES public.users (id) ON DELETE SET NULL,

  dataset         text        NOT NULL,
  name            text        NOT NULL,
  full_name       text        NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- The same shape the agent's SafeComponent enforces. A name this table accepts and the agent
  -- refuses is a row describing a snapshot that was never taken.
  CONSTRAINT snapshots_name_format CHECK (name ~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$')
);

-- Taking the same snapshot name twice on one dataset fails at the agent; failing here first turns
-- a confusing ZFS error into a 409 the interface can explain.
CREATE UNIQUE INDEX snapshots_unique_per_dataset
  ON public.snapshots (organization_id, dataset, name);

CREATE INDEX snapshots_recent ON public.snapshots (organization_id, created_at DESC);

ALTER TABLE public.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshots FORCE  ROW LEVEL SECURITY;

CREATE POLICY snapshots_owner_full ON public.snapshots
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY snapshots_tenant_isolation ON public.snapshots
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- ─── grants ───────────────────────────────────────────────────────────────────
--
-- The application role gets DML and nothing else; DDL stays with the owner, which the migration
-- guard asserts on every push. `depsis_backup` gets SELECT on everything except what would let a
-- backup dump become a second copy of somebody's private notes — so notes are excluded and the
-- rest are not.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.notes, public.tasks, public.user_preferences, public.snapshots
  TO depsis_app;

GRANT SELECT ON public.tasks, public.snapshots TO depsis_backup;

-- Down Migration

DROP TABLE IF EXISTS public.snapshots;
DROP TABLE IF EXISTS public.user_preferences;
DROP TABLE IF EXISTS public.tasks;
DROP TABLE IF EXISTS public.notes;
