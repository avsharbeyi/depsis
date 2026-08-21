-- 0006 — encrypt the one secret that has to be readable.
--
-- Migration 0004 left the TOTP secret in plaintext and said so, with an argument worth quoting
-- because this migration only partly overturns it: on a self-hosted NAS the application, the
-- database and any plausible key file live on one machine, so a local key buys nothing against host
-- compromise. That remains true. What 0004 offered instead was denying `depsis_backup` this table,
-- and it noted that "since the secrets are not encrypted at rest, this policy is doing the whole
-- job."
--
-- Two gaps in that, which is why this migration exists.
--
-- First, an RLS-filtered backup is not a backup. `depsis_backup` cannot see this table, so a dump
-- taken with that role cannot restore the system. A real disaster-recovery dump is taken as the
-- owner or as `postgres`, and that dump carries every second factor in plaintext.
--
-- Second, and the stronger one: `depsis_app` can read every secret in its tenant, because the API
-- genuinely needs to. So a leaked application database password, or one SQL injection, hands over
-- the entire MFA estate without touching the filesystem. Putting the key somewhere `depsis_app`'s
-- SQL access cannot reach means database access alone is no longer enough. That is the same split
-- the agent makes with SO_PEERCRED, applied to a different boundary — see ADR-0016.
--
-- What this migration deliberately does NOT do: encrypt anything. The key lives outside the
-- database by construction, so the database cannot perform the conversion. Existing rows are
-- labelled `key_version = 0`, meaning "plaintext", and the application re-seals them the first time
-- it reads them. A row that says what it is beats a column that might be either.

-- Up Migration

SELECT public.assert_rls_roles_sane();

ALTER TABLE public.user_totp_secrets
  ADD COLUMN key_version smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.user_totp_secrets.key_version IS
  '0 = the raw secret, as migration 0004 stored it. 1 = an AES-256-GCM envelope '
  '(version || nonce || ciphertext || tag) sealed with the key named by DEPSIS_SECRET_KEY_FILE, '
  'with the user and organization ids as associated data. Present so a stored value always says '
  'what it is, and so a future key rotation needs code rather than another migration.';

-- The old constraint described a raw 16..64 byte secret. An envelope is 1 + 12 + len + 16, so the
-- same secret is 45..93 bytes once sealed — outside the old range, which would have made the first
-- re-seal fail on a constraint rather than on anything meaningful.
--
-- Branching on key_version rather than widening to 16..93: a single wide range would accept a raw
-- 80-byte secret and an 20-byte envelope equally, and the point of the column is that the row
-- cannot lie about which it holds.
ALTER TABLE public.user_totp_secrets
  DROP CONSTRAINT user_totp_secret_len;

ALTER TABLE public.user_totp_secrets
  ADD CONSTRAINT user_totp_secret_len CHECK (
    CASE key_version
      WHEN 0 THEN octet_length(secret) BETWEEN 16 AND 64
      WHEN 1 THEN octet_length(secret) BETWEEN 45 AND 93
      ELSE false
    END
  );

-- An envelope must actually begin with its version byte. Without this a row could claim version 1
-- while holding something the application would then refuse to open at login time — a failure that
-- surfaces to a locked-out user rather than to whoever wrote the bad row.
ALTER TABLE public.user_totp_secrets
  ADD CONSTRAINT user_totp_secret_envelope_tagged CHECK (
    key_version = 0 OR get_byte(secret, 0) = key_version
  );

-- Operability: how much of the estate is still plaintext, answerable without reading any secret.
CREATE INDEX user_totp_secrets_key_version_idx
  ON public.user_totp_secrets (key_version)
  WHERE key_version = 0;

-- SECURITY DEFINER, and the reason is a bug this migration was written with and caught by a test.
--
-- The obvious implementation — have the API count the rows itself — returns 0 forever. The count
-- has to run at startup, before any tenant is known, so it runs with no tenant context; and this
-- table is tenant-scoped, so row level security hides every row from `depsis_app` when
-- `current_organization_id()` is null. The startup line would have said "0 still in the clear" on a
-- box where every secret was in the clear: reassuring, and blind.
--
-- A definer function owned by `depsis_owner` sees the whole table. What it hands back is a count and
-- nothing else — no secret, no user id, no organization id — so the only thing it discloses is
-- operational: how much of the estate has yet to be sealed. `search_path` is pinned because a
-- definer function that resolves names through the caller's path is a privilege-escalation
-- primitive.
CREATE OR REPLACE FUNCTION public.unsealed_totp_secret_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*) FROM public.user_totp_secrets WHERE key_version = 0
$$;

COMMENT ON FUNCTION public.unsealed_totp_secret_count() IS
  'How many TOTP secrets are still stored as migration 0004 stored them. SECURITY DEFINER because '
  'the API asks this at startup, before any tenant context exists, and row level security would '
  'otherwise answer 0 regardless of the truth. Returns a count and nothing else.';

REVOKE ALL     ON FUNCTION public.unsealed_totp_secret_count() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.unsealed_totp_secret_count() TO depsis_app;

-- Down Migration

DROP FUNCTION IF EXISTS public.unsealed_totp_secret_count();
DROP INDEX IF EXISTS public.user_totp_secrets_key_version_idx;

ALTER TABLE public.user_totp_secrets
  DROP CONSTRAINT IF EXISTS user_totp_secret_envelope_tagged;

ALTER TABLE public.user_totp_secrets
  DROP CONSTRAINT IF EXISTS user_totp_secret_len;

-- Rolling back does NOT decrypt. It cannot: the key is outside the database, which is the entire
-- point. Any row already sealed would be left as an envelope this constraint then rejects, so the
-- rollback refuses rather than corrupting the table or silently widening the check.
--
-- The recovery path is deliberate and manual: re-enrol the affected users. That is worse than a
-- clean rollback and better than a schema that quietly accepts values nothing can read.
DO $$
DECLARE sealed bigint;
BEGIN
  SELECT count(*) INTO sealed FROM public.user_totp_secrets WHERE key_version <> 0;
  IF sealed > 0 THEN
    RAISE EXCEPTION
      'refusing to roll back: % TOTP secret(s) are sealed and this migration cannot unseal them '
      '(the key is outside the database). Have those users re-enrol, or restore from a backup '
      'taken before 0006.', sealed;
  END IF;
END $$;

ALTER TABLE public.user_totp_secrets
  DROP COLUMN key_version;

ALTER TABLE public.user_totp_secrets
  ADD CONSTRAINT user_totp_secret_len CHECK (octet_length(secret) BETWEEN 16 AND 64);
