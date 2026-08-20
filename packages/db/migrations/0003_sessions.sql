-- 0003 — server-side sessions, and the throttling that protects the login path.
--
-- ADR-0009 rules out JWTs: §16 requires that a security incident can revoke every session, and a
-- stateless token cannot be revoked without building the very server-side store a JWT was supposed
-- to avoid. Sessions therefore live here, and revoking one is a DELETE.
--
-- Two decisions in this file need their reasoning attached, because both look like violations of
-- rules stated elsewhere in the project.

-- Up Migration

-- First statement of every migration after 0001. See the comment on the function in 0001.
SELECT public.assert_rls_roles_sane();

-- ─── sessions ─────────────────────────────────────────────────────────────────

CREATE TABLE public.sessions (
  id               uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.users (id)         ON DELETE CASCADE,

  -- The HASH of the session token, never the token. A database backup, a replica, or a stray
  -- `SELECT *` in a log then carries nothing that can be replayed as a session. SHA-256 is the
  -- right primitive here rather than Argon2: the input is 32 bytes of CSPRNG output, so there is
  -- no dictionary to slow down, and a login path that spends 100 ms hashing on every request is a
  -- denial-of-service surface of its own.
  token_hash       bytea       NOT NULL,

  -- Recorded for the device list ADR-0009 requires. Both are attacker-controlled strings from
  -- request headers, so both are bounded and neither is ever interpolated anywhere.
  user_agent       text,
  ip_address       inet,

  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  -- Set instead of deleting, so "this session was revoked" is distinguishable from "this session
  -- never existed" in an audit. Rows are removed by a retention job, not by logout.
  revoked_at       timestamptz,

  CONSTRAINT sessions_token_hash_len  CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expires_after   CHECK (expires_at > created_at),
  CONSTRAINT sessions_user_agent_len  CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);

-- DECISION 1: this UNIQUE deliberately omits organization_id, which ADR-0013 otherwise forbids.
--
-- The rule exists because a UNIQUE violation is visible ACROSS tenants — the check runs below row
-- level security — so a global constraint lets one tenant learn that another holds a value. That
-- reasoning does not transfer here, and the difference is not a matter of degree.
--
-- To provoke a violation on this constraint an attacker must present a value that already exists,
-- i.e. must already possess a valid session token. The information leaked by the collision — "this
-- 32-byte value is in use" — is information they necessarily had before they could ask.
--
-- Scoping it to the tenant would also make it useless: the lookup that matters happens BEFORE any
-- tenant is known, which is the whole reason `resolve_session` below exists.
--
-- This is the second and last entry on the allow-list the uniqueness audit carries. Any future
-- addition needs the same argument made explicitly, not by analogy to this one.
ALTER TABLE public.sessions ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

COMMENT ON CONSTRAINT sessions_token_hash_key ON public.sessions IS
  'Deliberately global, unlike every other UNIQUE in this schema. Provoking a collision requires '
  'already holding the token, so it leaks nothing the caller did not have. Scoping it by tenant '
  'would break the pre-context lookup this table exists for. See ADR-0013 and ADR-0015.';

CREATE INDEX sessions_user_active_idx
  ON public.sessions (organization_id, user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

-- The retention job scans by expiry; without this it scans the table.
CREATE INDEX sessions_expires_at_idx ON public.sessions (expires_at);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_owner_full ON public.sessions
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY sessions_tenant_isolation ON public.sessions
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- Deliberately NOT readable by the backup role. A backup that carries session token hashes carries
-- the material for a replay attack against every logged-in user, and nothing about a backup needs
-- them: sessions are ephemeral by construction and a restore should log everyone out.
CREATE POLICY sessions_backup_denied ON public.sessions
  FOR SELECT TO depsis_backup USING (false);

-- ─── DECISION 2: resolving a session before a tenant is known ─────────────────
--
-- The same chicken-and-egg as `resolve_organization_by_slug` (ADR-0015 §5), one step further in.
-- A request arrives with a cookie. The cookie yields a token; the token yields a session; the
-- session yields the organization. But the policy above needs the organization to read the session.
--
-- So: a SECURITY DEFINER function, as narrow as the last one. It takes a token HASH — the caller
-- computes the digest, so a raw token never reaches the database or its logs — and returns only
-- what is needed to establish a context. It returns nothing at all for a session that is expired
-- or revoked, so the caller cannot distinguish those two cases from "no such session", and cannot
-- act on a dead session by accident.
CREATE FUNCTION public.resolve_session(token_hash bytea)
RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Not optional on a SECURITY DEFINER function: without it a caller can shadow `public.sessions`
-- with a table of their own and have this run against it with the owner's privileges.
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.organization_id, s.user_id, s.expires_at
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
   WHERE s.token_hash = $1
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     -- A disabled user's existing sessions stop working immediately, rather than at expiry. ADR-0009
     -- requires revocation to be effective; leaving a disabled account with a live session for the
     -- rest of the day is the same hole with a shorter clock.
     AND u.disabled_at IS NULL
$$;

COMMENT ON FUNCTION public.resolve_session(bytea) IS
  'ADR-0015 §1: the fourth and final untenanted operation. Returns only what establishes a tenant '
  'context, and returns nothing for a session that is expired, revoked, or belongs to a disabled '
  'user — so a caller cannot tell those apart and cannot act on a dead session.';

REVOKE ALL ON FUNCTION public.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_session(bytea) TO depsis_app;

-- ─── login throttling ─────────────────────────────────────────────────────────
--
-- ADR-0009 is specific about the shape: NOT account lockout, because an attacker who knows an
-- address can then lock its owner out at will — turning a brute-force defence into a denial of
-- service against the victim. Increasing delay, counted on the combination of account and source.
--
-- Untenanted by design. A login attempt is recorded BEFORE the tenant is known — that is the point
-- at which throttling has to bite — and an attempt against a slug that does not exist has no
-- tenant to attribute it to at all. Attributing failures to a tenant would also let an attacker
-- fill another tenant's audit trail.
CREATE TABLE public.login_attempts (
  id               uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  -- The folded address, not the raw one, so that case and Unicode spelling cannot be used to get a
  -- fresh throttling bucket for the same account (migration 0001's fold_identity).
  email_normalized text        NOT NULL,
  ip_address       inet        NOT NULL,
  succeeded        boolean     NOT NULL,
  attempted_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT login_attempts_email_len CHECK (length(email_normalized) <= 320)
);

-- The throttling query asks "how many failures for this pair recently", so both halves of the key
-- and the time are in the index.
CREATE INDEX login_attempts_pair_idx
  ON public.login_attempts (email_normalized, ip_address, attempted_at DESC)
  WHERE NOT succeeded;

CREATE INDEX login_attempts_attempted_at_idx ON public.login_attempts (attempted_at);

-- No RLS, and that is deliberate rather than an omission: the table has no organization_id to
-- filter on, by the reasoning above. What protects it is privilege — the application may INSERT and
-- may read aggregates, and nothing else. It is stated here so a future reader does not "fix" the
-- missing policy by inventing a tenant column that would break the throttle.
COMMENT ON TABLE public.login_attempts IS
  'Untenanted on purpose: an attempt is recorded before the tenant is known, and an attempt against '
  'a nonexistent tenant has none. No RLS policy exists because there is no tenant key to filter on; '
  'privilege is the control. Do not add organization_id — it would let an attacker choose which '
  'throttling bucket to fill. See ADR-0009.';

-- ─── privileges ───────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions       TO depsis_app;
GRANT SELECT, INSERT                 ON public.login_attempts TO depsis_app;
-- DELETE for the retention job only; the API never removes attempt rows, so a bug cannot erase the
-- evidence of an attack in progress.
GRANT DELETE                         ON public.login_attempts TO depsis_owner;

-- Down Migration

DROP FUNCTION IF EXISTS public.resolve_session(bytea);
DROP TABLE IF EXISTS public.login_attempts;
DROP TABLE IF EXISTS public.sessions;
