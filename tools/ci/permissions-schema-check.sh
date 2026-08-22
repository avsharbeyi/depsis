#!/usr/bin/env bash
#
# İzin şemasının (migration 0015) kısıtları gerçekten ısırıyor mu.
#
# Ayrı bir dosya, çünkü sorduğu soru `migration-check.sh`inkinden farklı: o, şemanın kiracı
# yalıtımını ve geri alınabilirliğini ölçüyor; bu, TEK BİR migration'ın yazdığı kuralların
# uygulanıp uygulanmadığını.
#
# Var olma sebebi bir hata: `folder_grants_not_empty` kısıtı
# `array_length(permissions, 1) >= 1` diye yazılmıştı ve HİÇBİR ŞEYİ engellemiyordu —
# `array_length` boş bir dizide 0 değil NULL döner, NULL >= 1 de NULL'dur, ve bir CHECK kısıtı
# NULL sonucu GEÇİRİR. Kısıt yazılmış, gözden geçirilmiş ve çalışmıyordu; onu yakalayan tek şey
# gerçek bir veritabanına boş bir dizi yazmayı denemek oldu.
#
# Kendi geçici veritabanını kurar ve sonunda düşürür, yani başka bir paketle aynı anda
# çalıştırılabilir.
#
#   bash tools/ci/permissions-schema-check.sh
set -uo pipefail
cd /mnt/c/Users/HUAWEI/Desktop/xdepsisOS || exit 1

DB=depsis_grantcheck
export PGPASSWORD=ci-postgres
say() { printf '%-58s %s\n' "$1" "$2"; }
q() { psql -X -q -At -U postgres -h 127.0.0.1 -d "$DB" -c "$1" 2>&1; }

psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null
psql -X -q -U postgres -h 127.0.0.1 -d postgres -v db_name="$DB" -f packages/db/bootstrap.sql >/dev/null 2>&1
psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "ALTER ROLE depsis_owner PASSWORD 'ci-owner'" >/dev/null
psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "ALTER ROLE depsis_app PASSWORD 'ci-app'" >/dev/null

URL="postgresql://depsis_owner:ci-owner@127.0.0.1:5432/$DB"
( cd packages/db && DEPSIS_MIGRATION_DATABASE_URL="$URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction up >/dev/null 2>&1 ) \
  && say 'all migrations apply' 'ok' || { say 'migrations FAILED' ''; exit 1; }

# ─── down / up, yalnız 0015 ───────────────────────────────────────────────────
( cd packages/db && DEPSIS_MIGRATION_DATABASE_URL="$URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction down >/dev/null 2>&1 ) \
  && say '0015 rolls back' 'ok' || say '0015 DOWN FAILED' ''

LEFT=$(q "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('teams','team_members','folder_grants')")
[ "$LEFT" = '0' ] && say 'no table survives the rollback' 'ok' || say 'TABLES SURVIVED' "$LEFT"
COL=$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='posix_uid'")
[ "$COL" = '0' ] && say 'users.posix_uid is gone too' 'ok' || say 'COLUMN SURVIVED' "$COL"
TYP=$(q "SELECT count(*) FROM pg_type WHERE typname='folder_permission'")
[ "$TYP" = '0' ] && say 'the enum type is gone' 'ok' || say 'TYPE SURVIVED' "$TYP"

( cd packages/db && DEPSIS_MIGRATION_DATABASE_URL="$URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction up >/dev/null 2>&1 ) \
  && say '0015 re-applies' 'ok' || say '0015 RE-APPLY FAILED' ''

# ─── kısıtlar gerçekten ısırıyor mu ───────────────────────────────────────────
q "INSERT INTO organizations (slug,name) VALUES ('g1','G1'),('g2','G2')" >/dev/null
A=$(q "SELECT id FROM organizations WHERE slug='g1'")
B=$(q "SELECT id FROM organizations WHERE slug='g2'")
q "INSERT INTO users (organization_id,username) VALUES ('$A','ali'),('$B','veli')" >/dev/null
U=$(q "SELECT id FROM users WHERE username='ali'")
q "INSERT INTO shares (organization_id,name,dataset) VALUES ('$A','ortak','tank/g1/ortak')" >/dev/null
S=$(q "SELECT id FROM shares WHERE name='ortak'")
q "INSERT INTO teams (organization_id,name) VALUES ('$A','muhasebe')" >/dev/null
T=$(q "SELECT id FROM teams WHERE name='muhasebe'")

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,team_id,permissions)
         VALUES ('$A','$S','$U','$T',ARRAY['read']::folder_permission[])")
grep -qi 'one_principal' <<<"$OUT" && say 'a grant naming BOTH a user and a team is refused' 'ok' \
                                   || say 'BOTH-PRINCIPAL GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,permissions)
         VALUES ('$A','$S',ARRAY['read']::folder_permission[])")
grep -qi 'one_principal' <<<"$OUT" && say 'a grant naming NEITHER is refused' 'ok' \
                                   || say 'PRINCIPAL-LESS GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
         VALUES ('$A','$S','$U',ARRAY[]::folder_permission[])")
grep -qi 'not_empty' <<<"$OUT" && say 'an empty permission set is refused' 'ok' \
                              || say 'EMPTY GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
         VALUES ('$A','$S','$U',ARRAY[NULL]::folder_permission[])")
grep -qi 'no_null_permission' <<<"$OUT" && say 'a NULL inside the permission array is refused' 'ok' || say 'NULL PERMISSION ACCEPTED' "$OUT"

q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
   VALUES ('$A','$S','$U',ARRAY['list','read']::folder_permission[])" >/dev/null
OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
         VALUES ('$A','$S','$U',ARRAY['delete']::folder_permission[])")
grep -qi 'duplicate key' <<<"$OUT" && say 'a second grant for the same principal is refused' 'ok' \
                                  || say 'DUPLICATE GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO teams (organization_id,name,posix_gid) VALUES ('$A','ik',1000)")
grep -qi 'posix_gid_range' <<<"$OUT" && say 'a gid outside the reserved range is refused' 'ok' \
                                     || say 'SYSTEM GID ACCEPTED' "$OUT"

# uid/gid tahsisi cihaz genelinde tek olmalı — iki kiracı, aynı sayaç.
q "UPDATE users SET posix_uid = public.allocate_posix_id('user') WHERE username='ali'" >/dev/null
q "UPDATE users SET posix_uid = public.allocate_posix_id('user') WHERE username='veli'" >/dev/null
IDS=$(q "SELECT string_agg(posix_uid::text,',' ORDER BY posix_uid) FROM users WHERE posix_uid IS NOT NULL")
[ "$IDS" = '300000,300001' ] && say 'two tenants draw from ONE device-wide counter' "$IDS" \
                             || say 'ALLOCATION IS NOT DEVICE-WIDE' "$IDS"

q "UPDATE teams SET posix_gid = public.allocate_posix_id('team') WHERE name='muhasebe'" >/dev/null
G=$(q "SELECT posix_gid FROM teams WHERE name='muhasebe'")
[ "$G" = '300002' ] && say 'gids continue the same sequence as uids' "$G" \
                    || say 'GID COLLIDES WITH A UID SPACE' "$G"

OUT=$(q "SELECT public.allocate_posix_id('root')")
grep -qi 'user or team' <<<"$OUT" && say 'allocate_posix_id refuses an unknown kind' 'ok' \
                                  || say 'UNKNOWN KIND ACCEPTED' "$OUT"

# RLS: uygulama rolü diğer kiracının ekibini görmemeli.
SEEN=$(PGPASSWORD=ci-app psql -X -q -At "postgresql://depsis_app@127.0.0.1:5432/$DB" \
  -c "BEGIN; SET LOCAL depsis.organization_id='$B'; SELECT count(*) FROM teams; COMMIT;" 2>&1)
[ "$SEEN" = '0' ] && say 'tenant B cannot see tenant A team' 'ok' || say 'RLS LEAK ON teams' "$SEEN"

psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null
