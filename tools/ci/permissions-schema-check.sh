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
# The repository, wherever it is checked out. It used to be an absolute path into one developer's
# WSL filesystem, so on CI the `cd` failed, `|| exit 1` fired, and the step passed by not running.
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

DB=depsis_grantcheck
export PGPASSWORD=ci-postgres

# THIS SCRIPT USED TO EXIT 0 WHATEVER HAPPENED, which is the very failure it was written to catch.
#
# `say` only printed. A failing assertion put "TABLES SURVIVED 3" on the screen, the script carried
# on, and the exit code was zero — so the CI step whose whole job is to prove that the permission
# schema's constraints bite reported success while they did not.
#
# What exposed it: after migration 0016 the one-step rollback below stopped being 0015, three
# assertions printed SURVIVED, and the script still finished happily.
failed=0
pass() { printf '%-58s %s\n' "$1" "${2:-ok}"; }
fail() { printf '%-58s %s\n' "$1" "${2:-}"; failed=1; }
q() { psql -X -q -At -U postgres -h 127.0.0.1 -d "$DB" -c "$1" 2>&1; }

psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null
psql -X -q -U postgres -h 127.0.0.1 -d postgres -v db_name="$DB" -f packages/db/bootstrap.sql >/dev/null 2>&1
psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "ALTER ROLE depsis_owner PASSWORD 'ci-owner'" >/dev/null
psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "ALTER ROLE depsis_app PASSWORD 'ci-app'" >/dev/null

URL="postgresql://depsis_owner:ci-owner@127.0.0.1:5432/$DB"
( cd packages/db && DEPSIS_MIGRATION_DATABASE_URL="$URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction up >/dev/null 2>&1 ) \
  && pass 'all migrations apply' || { fail 'migrations FAILED' ''; exit 1; }

# ─── down / up, 0015'e kadar ──────────────────────────────────────────────────
#
# Adım sayısı SAYILIYOR, sabit değil. Eskiden burada çıplak bir `down` vardı — bir adım — ve o bir
# adım 0015'ti. 0016 eklendiğinde aynı komut 0016'yı geri aldı, aşağıdaki üç assertion "tablo hâlâ
# duruyor" diye bağırdı, ve betik yine 0 döndü. Sabit bir sayı yazmak aynı tuzağı bir sonraki
# migration'a kurmak olurdu: 0015'in geri alınabilirliği sessizce ölçülmez hâle gelirdi.
STEPS=$(ls packages/db/migrations/*.sql | xargs -n1 basename | sort |
          awk '$0 >= "0015" { n += 1 } END { print n + 0 }')
[ "$STEPS" -ge 1 ] || { fail 'COULD NOT COUNT MIGRATIONS AFTER 0015' "$STEPS"; exit 1; }

( cd packages/db && DEPSIS_MIGRATION_DATABASE_URL="$URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction down "$STEPS" >/dev/null 2>&1 ) \
  && pass "0015 rolls back (with the $((STEPS - 1)) above it)" || fail '0015 DOWN FAILED' ''

LEFT=$(q "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('teams','team_members','folder_grants')")
[ "$LEFT" = '0' ] && pass 'no table survives the rollback' || fail 'TABLES SURVIVED' "$LEFT"
COL=$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='posix_uid'")
[ "$COL" = '0' ] && pass 'users.posix_uid is gone too' || fail 'COLUMN SURVIVED' "$COL"
TYP=$(q "SELECT count(*) FROM pg_type WHERE typname='folder_permission'")
[ "$TYP" = '0' ] && pass 'the enum type is gone' || fail 'TYPE SURVIVED' "$TYP"

( cd packages/db && DEPSIS_MIGRATION_DATABASE_URL="$URL" \
  npx node-pg-migrate -d DEPSIS_MIGRATION_DATABASE_URL -m migrations -t depsis_migrations \
    --advisory-lock-mode wait --no-single-transaction up >/dev/null 2>&1 ) \
  && pass '0015 re-applies' || fail '0015 RE-APPLY FAILED' ''

# ─── 0016: grant'sız paylaşım kalmasın ────────────────────────────────────────
#
# `everyone_team()` iki yerden çağrılıyor — bu migration'ın backfill'i ve `FilesService`'in örtük
# varsayılan paylaşımı — ve ikisi de onun İDEMPOTENT olmasına güveniyor. İkinci çağrı yeni bir ekip
# açmaya kalksa `teams_name_unique` onu reddederdi, ve reddedeceği yer bir kullanıcının ilk
# `GET /files` isteğidir.
q "INSERT INTO organizations (slug,name) VALUES ('g3','G3')" >/dev/null
C=$(q "SELECT id FROM organizations WHERE slug='g3'")
q "INSERT INTO users (organization_id,username) VALUES ('$C','ayse'),('$C','fatma')" >/dev/null
T1=$(q "SELECT public.everyone_team('$C')")
T2=$(q "SELECT public.everyone_team('$C')")
{ [ -n "$T1" ] && [ "$T1" = "$T2" ]; } && pass 'everyone_team is idempotent' \
                                       || fail 'EVERYONE_TEAM IS NOT IDEMPOTENT' "$T1 vs $T2"

MEM=$(q "SELECT count(*) FROM team_members WHERE team_id='$T1'")
[ "$MEM" = '2' ] && pass 'everyone_team holds every user of the tenant' \
                 || fail 'EVERYONE_TEAM MEMBERSHIP IS WRONG' "$MEM"

# Ve kiracıyı aşmıyor: başka bir organizasyonun kullanıcısı bu ekibe girmemeli.
LEAK=$(q "SELECT count(*) FROM team_members m JOIN users u ON u.id = m.user_id
           WHERE m.team_id='$T1' AND u.organization_id <> '$C'")
[ "$LEAK" = '0' ] && pass 'everyone_team does not cross a tenant boundary' \
                  || fail 'EVERYONE_TEAM CROSSED A TENANT' "$LEAK"

# Backfill'in bıraktığı hâl: grant'sız paylaşım yok.
q "INSERT INTO shares (organization_id,name,dataset) VALUES ('$C','eski','tank/eski')" >/dev/null
q "INSERT INTO folder_grants (organization_id,share_id,entry_id,team_id,permissions)
   SELECT '$C', id, NULL, '$T1', '{list,read}'::public.folder_permission[]
     FROM shares WHERE organization_id = '$C'" >/dev/null
UNGOVERNED=$(q "SELECT count(*) FROM shares s
                 WHERE NOT EXISTS (SELECT 1 FROM folder_grants g WHERE g.share_id = s.id)")
[ "$UNGOVERNED" = '0' ] && pass 'no share is left without a grant' \
                        || fail 'A SHARE HAS NO GRANT' "$UNGOVERNED"

# Bir paylaşımı silmek, grant'ı dururken REDDEDİLİYOR — değişmezin veritabanı tarafındaki yarısı.
# Uygulama katmanı son grant'ı `LastGrantError` ile koruyor; bu satır, paylaşımın kendisini silerek
# aynı yere varmaya çalışan her yolun da kapalı olduğunu ölçüyor.
OUT=$(q "DELETE FROM shares WHERE organization_id = '$C'")
# PostgreSQL'in cümlesi "violates RESTRICT setting of foreign key constraint" — 'violates foreign
# key' diye aranınca eşleşmiyor, ve bu assertion ilk yazıldığında tam olarak öyle yazılmıştı. Kapı
# çalışır hâle gelir gelmez kendi hatasını yakaladı.
grep -qi 'violates RESTRICT setting' <<<"$OUT" \
  && pass 'a share carrying a grant cannot be deleted' \
  || fail 'A SHARE WITH A GRANT WAS DELETED' "$OUT"

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
grep -qi 'one_principal' <<<"$OUT" && pass 'a grant naming BOTH a user and a team is refused' \
                                   || fail 'BOTH-PRINCIPAL GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,permissions)
         VALUES ('$A','$S',ARRAY['read']::folder_permission[])")
grep -qi 'one_principal' <<<"$OUT" && pass 'a grant naming NEITHER is refused' \
                                   || fail 'PRINCIPAL-LESS GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
         VALUES ('$A','$S','$U',ARRAY[]::folder_permission[])")
grep -qi 'not_empty' <<<"$OUT" && pass 'an empty permission set is refused' \
                              || fail 'EMPTY GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
         VALUES ('$A','$S','$U',ARRAY[NULL]::folder_permission[])")
grep -qi 'no_null_permission' <<<"$OUT" && pass 'a NULL inside the permission array is refused' || fail 'NULL PERMISSION ACCEPTED' "$OUT"

q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
   VALUES ('$A','$S','$U',ARRAY['list','read']::folder_permission[])" >/dev/null
OUT=$(q "INSERT INTO folder_grants (organization_id,share_id,user_id,permissions)
         VALUES ('$A','$S','$U',ARRAY['delete']::folder_permission[])")
grep -qi 'duplicate key' <<<"$OUT" && pass 'a second grant for the same principal is refused' \
                                  || fail 'DUPLICATE GRANT ACCEPTED' "$OUT"

OUT=$(q "INSERT INTO teams (organization_id,name,posix_gid) VALUES ('$A','ik',1000)")
grep -qi 'posix_gid_range' <<<"$OUT" && pass 'a gid outside the reserved range is refused' \
                                     || fail 'SYSTEM GID ACCEPTED' "$OUT"

# uid/gid tahsisi cihaz genelinde tek olmalı — iki kiracı, aynı sayaç.
q "UPDATE users SET posix_uid = public.allocate_posix_id('user') WHERE username='ali'" >/dev/null
q "UPDATE users SET posix_uid = public.allocate_posix_id('user') WHERE username='veli'" >/dev/null
IDS=$(q "SELECT string_agg(posix_uid::text,',' ORDER BY posix_uid) FROM users WHERE posix_uid IS NOT NULL")
[ "$IDS" = '300000,300001' ] && pass 'two tenants draw from ONE device-wide counter' "$IDS" \
                             || fail 'ALLOCATION IS NOT DEVICE-WIDE' "$IDS"

q "UPDATE teams SET posix_gid = public.allocate_posix_id('team') WHERE name='muhasebe'" >/dev/null
G=$(q "SELECT posix_gid FROM teams WHERE name='muhasebe'")
[ "$G" = '300002' ] && pass 'gids continue the same sequence as uids' "$G" \
                    || fail 'GID COLLIDES WITH A UID SPACE' "$G"

OUT=$(q "SELECT public.allocate_posix_id('root')")
grep -qi 'user or team' <<<"$OUT" && pass 'allocate_posix_id refuses an unknown kind' \
                                  || fail 'UNKNOWN KIND ACCEPTED' "$OUT"

# RLS: uygulama rolü diğer kiracının ekibini görmemeli.
SEEN=$(PGPASSWORD=ci-app psql -X -q -At "postgresql://depsis_app@127.0.0.1:5432/$DB" \
  -c "BEGIN; SET LOCAL depsis.organization_id='$B'; SELECT count(*) FROM teams; COMMIT;" 2>&1)
[ "$SEEN" = '0' ] && pass 'tenant B cannot see tenant A team' || fail 'RLS LEAK ON teams' "$SEEN"

psql -X -q -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null

# A verdict, not a transcript. Everything above prints; only this decides.
if [ "$failed" -ne 0 ]; then
  echo
  echo '::error::the permission schema does not enforce what it claims to'
  exit 1
fi

echo 'every assertion held'
