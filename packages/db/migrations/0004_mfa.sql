-- 0004 — TOTP enrolment, recovery codes, and the half-finished login they belong to.
--
-- ADR-0009 §"Faz 1 MFA = yalnız TOTP": password plus TOTP, plus single-use hashed recovery codes.
-- WebAuthn is out of scope until there is a hostname and a trusted certificate, and nothing here
-- forecloses it.

-- Up Migration

SELECT public.assert_rls_roles_sane();

-- ─── TOTP secrets ─────────────────────────────────────────────────────────────

CREATE TABLE public.user_totp_secrets (
  -- One per user. A second factor a user can enrol twice is a second factor whose revocation is
  -- ambiguous, so the primary key IS the user.
  user_id          uuid        PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

  -- 20 bytes, the size RFC 4226 §4 recommends for HMAC-SHA1.
  --
  -- Stored as issued, NOT encrypted, and that is a gap rather than a decision — recorded here
  -- instead of hidden. Encryption at rest needs a key, and a key needs somewhere to live that is
  -- not the same host as the database; on a self-hosted NAS the application, the database and any
  -- plausible key file are all on one machine, so encrypting with a local key would buy protection
  -- against a leaked BACKUP and almost nothing against host compromise. The backup case is
  -- addressed directly below, by denying the backup role this table. Real encryption at rest waits
  -- on a key-management decision, which is its own ADR and not this migration's to invent.
  secret           bytea       NOT NULL,

  -- NULL until the user has proved they can produce a code. An unconfirmed enrolment must never
  -- gate a login: a user who scans a QR code and then loses the phone before confirming would
  -- otherwise be locked out by a secret they never successfully used.
  confirmed_at     timestamptz,

  -- The last TOTP counter accepted for this user, so the same code cannot be replayed inside its
  -- own validity window. Without it a code observed over a shoulder — or captured by a phishing
  -- proxy and relayed — stays usable for up to ninety seconds.
  last_used_step   bigint,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_totp_secret_len CHECK (octet_length(secret) BETWEEN 16 AND 64)
);

CREATE INDEX user_totp_secrets_org_idx ON public.user_totp_secrets (organization_id);

ALTER TABLE public.user_totp_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_totp_secrets FORCE ROW LEVEL SECURITY;

CREATE POLICY user_totp_secrets_owner_full ON public.user_totp_secrets
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY user_totp_secrets_tenant_isolation ON public.user_totp_secrets
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

-- Denied to the backup role, for the same reason sessions are (migration 0003): a restored backup
-- carrying TOTP secrets carries the second factor itself, which makes the backup as good as the
-- phone. Since the secrets are not encrypted at rest, this policy is doing the whole job.
CREATE POLICY user_totp_secrets_backup_denied ON public.user_totp_secrets
  FOR SELECT TO depsis_backup USING (false);

-- ─── recovery codes ───────────────────────────────────────────────────────────

CREATE TABLE public.user_recovery_codes (
  id               uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,

  -- SHA-256 of the code, never the code.
  --
  -- SHA-256 rather than Argon2, and the reasoning is the same as for session tokens plus one more:
  -- the codes are 100 bits of CSPRNG output, so there is no dictionary to slow down, AND verifying
  -- a submitted code means comparing against every unused code a user holds — ten Argon2
  -- verifications per attempt would be 200 ms of CPU handed to anyone who can POST.
  code_hash        bytea       NOT NULL,

  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_recovery_code_hash_len CHECK (octet_length(code_hash) = 32)
);

-- Scoped by organization, as ADR-0013 requires. Unlike a session token this one CAN be scoped:
-- recovery codes are only ever looked up for a user whose tenant is already known, because they
-- are submitted during a login that has already passed the password step.
ALTER TABLE public.user_recovery_codes
  ADD CONSTRAINT user_recovery_codes_unique UNIQUE (organization_id, code_hash);

CREATE INDEX user_recovery_codes_unused_idx
  ON public.user_recovery_codes (organization_id, user_id)
  WHERE used_at IS NULL;

ALTER TABLE public.user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_recovery_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY user_recovery_codes_owner_full ON public.user_recovery_codes
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY user_recovery_codes_tenant_isolation ON public.user_recovery_codes
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

CREATE POLICY user_recovery_codes_backup_denied ON public.user_recovery_codes
  FOR SELECT TO depsis_backup USING (false);

-- ─── the half-finished login ──────────────────────────────────────────────────
--
-- Between "the password was right" and "the second factor was right" there is a state, and it has
-- to live somewhere. It is NOT a session: a session that exists before the second factor has been
-- proved is a session an attacker with the password already holds.
--
-- Short-lived, single-use, and its own attempt counter — because the code is six digits, and six
-- digits is guessable in a million tries unless the number of tries is bounded HERE rather than by
-- the login throttle, which counts password attempts and has already been satisfied.
CREATE TABLE public.pending_logins (
  id               uuid        PRIMARY KEY DEFAULT pg_catalog.uuidv7(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash       bytea       NOT NULL,

  attempts         integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,

  CONSTRAINT pending_logins_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT pending_logins_expires_after  CHECK (expires_at > created_at),
  CONSTRAINT pending_logins_attempts_sane  CHECK (attempts >= 0)
);

-- Global, for the same reason as `sessions_token_hash_key` and with the same argument: the lookup
-- happens before a tenant context exists, and provoking a collision requires already holding the
-- token. This is the THIRD and last entry on the uniqueness audit's allow-list.
ALTER TABLE public.pending_logins
  ADD CONSTRAINT pending_logins_token_hash_key UNIQUE (token_hash);

COMMENT ON CONSTRAINT pending_logins_token_hash_key ON public.pending_logins IS
  'Global by the same argument as sessions_token_hash_key: looked up before a tenant is known, and '
  'a collision is only reachable by someone who already holds the value.';

CREATE INDEX pending_logins_expires_at_idx ON public.pending_logins (expires_at);

ALTER TABLE public.pending_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_logins FORCE ROW LEVEL SECURITY;

CREATE POLICY pending_logins_owner_full ON public.pending_logins
  FOR ALL TO depsis_owner USING (true) WITH CHECK (true);

CREATE POLICY pending_logins_tenant_isolation ON public.pending_logins
  FOR ALL
  TO depsis_app
  USING      (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

CREATE POLICY pending_logins_backup_denied ON public.pending_logins
  FOR SELECT TO depsis_backup USING (false);

-- Resolved without a tenant context, exactly like a session. Returns nothing for a challenge that
-- is expired, already consumed, or out of attempts — so the caller cannot tell those apart, and in
-- particular cannot learn that a token WAS valid.
CREATE FUNCTION public.resolve_pending_login(token_hash bytea)
RETURNS TABLE (pending_id uuid, organization_id uuid, user_id uuid, attempts integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.id, p.organization_id, p.user_id, p.attempts
    FROM public.pending_logins p
    JOIN public.users u ON u.id = p.user_id
   WHERE p.token_hash = $1
     AND p.consumed_at IS NULL
     AND p.expires_at > now()
     AND p.attempts < 6
     AND u.disabled_at IS NULL
$$;

COMMENT ON FUNCTION public.resolve_pending_login(bytea) IS
  'ADR-0015 §1, sixth untenanted operation and the last one this design needs. Six attempts, '
  'because the code is six digits: bounding tries here is what stops the second factor from being '
  'brute-forced in a window the password throttle has already let through.';

REVOKE ALL ON FUNCTION public.resolve_pending_login(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_pending_login(bytea) TO depsis_app;

-- ─── privileges ───────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_totp_secrets   TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_recovery_codes TO depsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_logins      TO depsis_app;

-- Down Migration

DROP FUNCTION IF EXISTS public.resolve_pending_login(bytea);
DROP TABLE IF EXISTS public.pending_logins;
DROP TABLE IF EXISTS public.user_recovery_codes;
DROP TABLE IF EXISTS public.user_totp_secrets;
