#!/usr/bin/env bash
# P0-H — prove ADR-0010: Turkish-aware filename search.
#
# Turkish is the reason this PoC exists. PostgreSQL's lower() does not implement the Turkish
# dotted/dotless i rule, and 'İ' (U+0130) can lower to 'i' plus a COMBINING DOT ABOVE rather
# than a plain 'i'. A search index built on lower() alone therefore puts 'İstanbul' and
# 'istanbul' in different buckets, and a user searching their own filenames gets nothing.
#
# ADR-0010 also rejects the obvious fix. A non-deterministic ICU collation cannot be used with
# ILIKE, SIMILAR TO or POSIX regex in ANY PostgreSQL version, LIKE only works on PG 18+, and
# whether pg_trgm can index such a column is undocumented. So normalization is applied to the
# DATA, in a GENERATED STORED column, not to the collation.

POC_ID=p0-h
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

DB=depsis_p0h
PSQL=(psql -v ON_ERROR_STOP=1 -X -q -A -t)

cleanup() {
  section 'Cleanup'
  sudo -u postgres dropdb --if-exists "$DB" 2>/dev/null || true
}
trap cleanup EXIT

q() { sudo -u postgres "${PSQL[@]}" -d "$DB" -c "$1" 2>&1; }
qs() { sudo -u postgres "${PSQL[@]}" -d "$DB" -f "$1" 2>&1; }

# ─── 0. environment ───────────────────────────────────────────────────────────
section 'Environment'
command -v psql >/dev/null 2>&1 || { fail 'psql not installed'; poc_summary; exit 1; }

sudo -u postgres dropdb --if-exists "$DB" 2>/dev/null || true
sudo -u postgres createdb "$DB"

server_version=$(sudo -u postgres "${PSQL[@]}" -d "$DB" -c 'SHOW server_version;')
note "PostgreSQL server_version: $server_version"
pg_major=${server_version%%.*}

# ADR-0013 chose PG 18 from PGDG because trixie stock is 17. Record which one we actually got;
# uuidv7() and LIKE-on-nondeterministic-collation both depend on it.
if [ "${pg_major:-0}" -ge 18 ]; then
  note "PG >= 18: uuidv7() and LIKE-on-nondeterministic-collation are expected to exist"
else
  warn "PG $pg_major is below 18 — ADR-0013 expects 18 from PGDG. Stock Debian gives 17."
  note "Running on PG $pg_major; uuidv7() will be absent"
fi

has_uuidv7=$(q "SELECT count(*) FROM pg_proc WHERE proname='uuidv7';")
note "uuidv7() present: $has_uuidv7 (0 = absent, generate in app code instead)"

for ext in pg_trgm unaccent; do
  if q "CREATE EXTENSION IF NOT EXISTS $ext;" >/dev/null 2>&1; then
    pass "extension $ext available"
  else
    fail "extension $ext NOT available" "$(q "CREATE EXTENSION $ext;")"
  fi
done

tr_cfg=$(q "SELECT count(*) FROM pg_ts_config WHERE cfgname='turkish';")
if [ "$tr_cfg" -ge 1 ]; then
  pass 'pg_catalog.turkish text search configuration exists'
else
  fail 'no turkish text search config' 'ADR-0010 expects it to ship with the Debian package'
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '1. depsis_norm — translate() MUST run before lower()'
# ═══════════════════════════════════════════════════════════════════════════════
# The target string is all-lowercase ASCII on purpose. An earlier draft of ADR-0010 mapped
# lowercase Turkish letters to UPPERCASE ASCII ('ş'->'S'), which still produced the right answer
# only because lower() happened to run afterwards. That is an accident, not a design: anyone
# reordering the pipeline would silently break every search. Keep both sides lowercase so the
# function is correct independently of the surrounding calls.

sudo -u postgres "${PSQL[@]}" -d "$DB" <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION depsis_norm(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT lower(
           unaccent('unaccent',
             translate(normalize(txt, NFKC),
                       'İIıŞşĞğÜüÖöÇç',
                       'iiissgguuoocc')
           )
         )
$$;
SQL
pass 'depsis_norm created'

# 1a. The dotted/dotless i family must all collapse to one bucket.
i_family=$(q "SELECT count(DISTINCT depsis_norm(v)) FROM (VALUES
  ('İstanbul'),('istanbul'),('ISTANBUL'),('Istanbul'),('ıstanbul')) AS t(v);")
if [ "$i_family" = "1" ]; then
  pass 'all five İ/I/ı spellings of "istanbul" normalize identically'
else
  variants=$(q "SELECT string_agg(DISTINCT depsis_norm(v), ' | ') FROM (VALUES
    ('İstanbul'),('istanbul'),('ISTANBUL'),('Istanbul'),('ıstanbul')) AS t(v);")
  fail "the i-family split into $i_family buckets" "$variants"
fi

# 1b. Show explicitly that plain lower() is NOT sufficient — this is the trap being avoided.
naive=$(q "SELECT count(DISTINCT lower(v)) FROM (VALUES
  ('İstanbul'),('istanbul'),('ISTANBUL'),('Istanbul'),('ıstanbul')) AS t(v);")
if [ "$naive" = "1" ]; then
  unexpected 'plain lower() already collapses the i-family' \
             "then this locale handles Turkish i natively; depsis_norm is still needed for accents"
else
  pass "plain lower() splits the i-family into $naive buckets (why depsis_norm exists)"
fi

# 1c. Accent pairs.
while IFS='|' read -r a b; do
  [ -z "$a" ] && continue
  same=$(q "SELECT depsis_norm('$a') = depsis_norm('$b');")
  if [ "$same" = "t" ]; then
    pass "normalizes to the same value: '$a' = '$b'"
  else
    got=$(q "SELECT depsis_norm('$a') || ' vs ' || depsis_norm('$b');")
    fail "'$a' and '$b' did NOT match" "$got"
  fi
done <<'PAIRS'
Şişli|sisli
Çağrı|cagri
Ürün|urun
Öğle|ogle
Güneş|gunes
PAIRS

# 1d. Unicode normalization: the same name encoded NFC vs NFD must agree. Windows and macOS
# clients disagree about this, so a NAS that ignores it shows duplicate-looking files.
nfc_nfd=$(q "SELECT depsis_norm(normalize('Güneş', NFC)) = depsis_norm(normalize('Güneş', NFD));")
if [ "$nfc_nfd" = "t" ]; then
  pass 'NFC and NFD encodings of the same name normalize identically'
else
  fail 'NFC vs NFD produced different results' \
       "$(q "SELECT depsis_norm(normalize('Güneş', NFC)) || ' vs ' || depsis_norm(normalize('Güneş', NFD));")"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '2. IMMUTABLE — the trap that blocks expression indexes'
# ═══════════════════════════════════════════════════════════════════════════════
# unaccent() is STABLE, not IMMUTABLE, unless the dictionary is named explicitly. Passing
# 'unaccent' as the first argument is what makes the whole function indexable. If this fails,
# the GENERATED STORED column below cannot exist and ADR-0010's design collapses.

volat=$(q "SELECT provolatile FROM pg_proc WHERE proname='depsis_norm';")
assert_eq 'depsis_norm is declared IMMUTABLE (provolatile=i)' 'i' "$volat"

q "CREATE TABLE immut_probe (name text);" >/dev/null
assert_cmd 'an expression index on depsis_norm() can be created' ok \
  -- sudo -u postgres psql -v ON_ERROR_STOP=1 -X -q -d "$DB" \
     -c "CREATE INDEX immut_probe_idx ON immut_probe (depsis_norm(name));"
q "DROP TABLE immut_probe;" >/dev/null

# ═══════════════════════════════════════════════════════════════════════════════
section '3. Schema — GENERATED STORED column plus both indexes'
# ═══════════════════════════════════════════════════════════════════════════════
# GENERATED ALWAYS ... STORED is what makes it impossible for application code to forget to
# normalize. A trigger or an application-side write could be bypassed; a generated column cannot.

sudo -u postgres "${PSQL[@]}" -d "$DB" <<'SQL' >/dev/null
CREATE TABLE file_entries (
  id              bigserial PRIMARY KEY,
  organization_id bigint NOT NULL,
  parent_id       bigint,
  name            text   NOT NULL,
  name_norm       text   GENERATED ALWAYS AS (depsis_norm(name)) STORED
);
SQL
pass 'file_entries created with a generated name_norm column'

# A corpus large enough for the planner to prefer indexes over a seq scan. One million rows
# belongs in the performance suite, not in a shell script — see the note at the end.
sudo -u postgres "${PSQL[@]}" -d "$DB" <<'SQL' >/dev/null
INSERT INTO file_entries (organization_id, parent_id, name)
SELECT 1, NULL,
       (ARRAY['İstanbul','Şişli','Çağrı Notları','Ürün Listesi','Öğle Raporu','Güneş Enerjisi',
              'savunma','dilekce','Sözleşme','Fatura','Ihracat','ısıtma'])[1 + (i % 12)]
       || '_' || i || '.pdf'
FROM generate_series(1, 20000) AS i;
SQL
rowcount=$(q "SELECT count(*) FROM file_entries;")
note "corpus rows: $rowcount"

sudo -u postgres "${PSQL[@]}" -d "$DB" <<'SQL' >/dev/null
CREATE INDEX fe_name_norm_trgm   ON file_entries USING gin (name_norm gin_trgm_ops);
CREATE INDEX fe_name_norm_prefix ON file_entries (organization_id, parent_id, name_norm text_pattern_ops);
ANALYZE file_entries;
SQL
pass 'GIN trgm and B-tree text_pattern_ops indexes created'

# The generated column must reflect normalization for rows inserted with mixed spellings.
mixed=$(q "SELECT count(*) FROM file_entries WHERE name_norm LIKE 'istanbul%';")
note "rows whose name_norm starts with 'istanbul': $mixed"
[ "${mixed:-0}" -gt 0 ] && pass 'İstanbul rows are findable via the ASCII spelling' \
                        || fail 'İstanbul rows not findable as istanbul' 'normalization did not apply'

# ═══════════════════════════════════════════════════════════════════════════════
section '4. Query-length branching — pg_trgm collapses under 3 characters'
# ═══════════════════════════════════════════════════════════════════════════════
# A trigram index has nothing to extract from a 1-2 character pattern, which is exactly the
# first two keystrokes in a search box. ADR-0010 routes short queries to a B-tree prefix scan
# instead. This section proves the planner actually does what the ADR claims.

plan_of() { # sql -> plan text
  sudo -u postgres "${PSQL[@]}" -d "$DB" -c "EXPLAIN (ANALYZE, BUFFERS) $1" 2>&1
}

# 4a. 1-2 characters: prefix path, must use the B-tree, must NOT be a seq scan.
for short in 'i' 'is'; do
  p=$(plan_of "SELECT id FROM file_entries
               WHERE organization_id = 1 AND parent_id IS NULL
                 AND name_norm LIKE '${short}%' LIMIT 50;")
  if grep -q 'fe_name_norm_prefix' <<<"$p"; then
    pass "prefix query '${short}%' uses the B-tree index"
  elif grep -qi 'Seq Scan' <<<"$p"; then
    fail "prefix query '${short}%' fell back to a Seq Scan" "$(head -3 <<<"$p")"
  else
    fail "prefix query '${short}%' used an unexpected plan" "$(head -3 <<<"$p")"
  fi
  ms=$(grep -oP 'Execution Time: \K[0-9.]+' <<<"$p" | tail -1)
  note "  '${short}%' execution time: ${ms:-?} ms"
done

# 4b. >= 3 characters: substring path, must use the GIN trigram index.
for long in 'ist' 'sisli' 'sozles'; do
  p=$(plan_of "SELECT id FROM file_entries WHERE name_norm LIKE '%${long}%' LIMIT 50;")
  if grep -q 'fe_name_norm_trgm' <<<"$p"; then
    pass "substring query '%${long}%' uses the GIN trigram index"
  elif grep -qi 'Seq Scan' <<<"$p"; then
    # On a small corpus the planner may legitimately prefer a seq scan. Report it as a
    # measurement rather than a failure, but say so plainly.
    warn "'%${long}%' chose a Seq Scan — corpus may be too small for the planner to prefer GIN"
    note "'%${long}%' seq scan on ${rowcount}-row corpus (not a failure at this size)"
  else
    fail "substring query '%${long}%' used an unexpected plan" "$(head -3 <<<"$p")"
  fi
  ms=$(grep -oP 'Execution Time: \K[0-9.]+' <<<"$p" | tail -1)
  note "  '%${long}%' execution time: ${ms:-?} ms"
done

# Deliberately NOT asserting the §18.2 p95 < 300 ms target. This corpus is 20k rows on a
# virtual disk with no tuning; it is not the acceptance environment and a pass here would be
# meaningless while a fail would be misleading. The numbers above are recorded for trend only.
note 'p95 < 300 ms target NOT asserted here — belongs in the performance suite on real hardware'

# ═══════════════════════════════════════════════════════════════════════════════
section '5. ILIKE is unnecessary and must not appear in the query path'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0010 forbids ILIKE: it cannot use a non-deterministic collation in any PG version, and
# against a normalized column it buys nothing while risking an index-less plan.

like_hits=$(q "SELECT count(*) FROM file_entries WHERE name_norm LIKE '%sisli%';")
ilike_hits=$(q "SELECT count(*) FROM file_entries WHERE name ILIKE '%şişli%';")
note "LIKE on name_norm: $like_hits hits    ILIKE on raw name: $ilike_hits hits"

if [ "${like_hits:-0}" -ge "${ilike_hits:-0}" ] && [ "${like_hits:-0}" -gt 0 ]; then
  pass 'normalized LIKE finds at least as much as ILIKE, without needing ILIKE'
else
  fail 'normalized LIKE found fewer rows than ILIKE' "LIKE=$like_hits ILIKE=$ilike_hits"
fi

# The stronger claim: the ASCII spelling finds the Turkish-spelled rows. ILIKE cannot do this
# at all, because it is case folding, not transliteration.
ascii_finds_turkish=$(q "SELECT count(*) FROM file_entries WHERE name_norm LIKE '%cagri%';")
ilike_finds_turkish=$(q "SELECT count(*) FROM file_entries WHERE name ILIKE '%cagri%';")
if [ "${ascii_finds_turkish:-0}" -gt 0 ] && [ "${ilike_finds_turkish:-0}" -eq 0 ]; then
  pass "typing 'cagri' finds 'Çağrı' rows ($ascii_finds_turkish) — ILIKE finds none, as expected"
else
  note "ascii->turkish: normalized=$ascii_finds_turkish ilike=$ilike_finds_turkish"
  [ "${ascii_finds_turkish:-0}" -gt 0 ] \
    && pass 'ASCII spelling reaches Turkish rows via name_norm' \
    || fail 'ASCII spelling did NOT reach Turkish rows' 'transliteration is not working'
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '6. name_norm is lossy — it must never be used for uniqueness (ADR-0005)'
# ═══════════════════════════════════════════════════════════════════════════════
# 'Çağrı.pdf' and 'Cagri.pdf' are different files a user may legitimately keep side by side.
# They share a name_norm. A uniqueness constraint on name_norm would reject the second one.

collision=$(q "SELECT depsis_norm('Çağrı.pdf') = depsis_norm('Cagri.pdf');")
if [ "$collision" = "t" ]; then
  pass "'Çağrı.pdf' and 'Cagri.pdf' collide in name_norm — correct for search, fatal for uniqueness"
  note 'ADR-0005: uniqueness uses a SEPARATE name_normalized column, not this one'
else
  unexpected 'the two spellings did not collide' 'then transliteration is weaker than ADR-0010 assumes'
fi

poc_summary
