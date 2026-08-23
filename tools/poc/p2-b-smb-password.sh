#!/usr/bin/env bash
#
# Can DEPSIS give a user an SMB password WITHOUT handing the privileged side a plaintext password?
#
# p2-a measured that the ACL chain reaches smbd, and that the only thing missing is Unix accounts.
# But an account nobody can authenticate as is not an account, and Samba authenticates against its
# OWN store: an NT hash, which cannot be derived from the argon2 hash DEPSIS keeps. So one of three
# things has to happen when a user sets their password, and they are not equally good:
#
#   a) the user sets a SEPARATE SMB password — honest, and a second secret to forget;
#   b) the plaintext crosses the privilege boundary to `smbpasswd` — one operand, and it is the
#      user's actual password, which they may well have reused somewhere that matters more;
#   c) DEPSIS computes the NT hash itself and only the HASH crosses.
#
# (c) is the one worth having and it was not obviously possible, so this measures it. Three
# questions, and every one of them turned out to have a surprising answer.
#
#   sudo bash tools/poc/p2-b-smb-password.sh
#
set -uo pipefail

GOOD=depsis-nth-good
SUBJ=depsis-nth-subject
PW='parola-42-uzun'
PW2='ikinci-parola-99'
IMPORT=/tmp/depsis-nth-import.txt

passed=0
failed=0
say() { printf '  %-62s %s\n' "$1" "$2"; }
ok() { say "$1" "${2:-ok}"; passed=$((passed + 1)); }
bad() { say "$1" "${2:-}"; failed=$((failed + 1)); }

cleanup() {
  for u in "$GOOD" "$SUBJ"; do
    pdbedit -x -u "$u" >/dev/null 2>&1
    userdel "$u" >/dev/null 2>&1
    groupdel "$u" >/dev/null 2>&1
  done
  rm -f "$IMPORT"
}
trap cleanup EXIT

[ "$(id -u)" = 0 ] || { echo "must run as root"; exit 2; }
cleanup

echo "════ p2-b — an SMB password without a plaintext password"
echo

i=399910
for u in "$GOOD" "$SUBJ"; do
  groupadd -g "$i" "$u" 2>/dev/null
  useradd -u "$i" -g "$i" -M -s /usr/sbin/nologin "$u" 2>/dev/null
  i=$((i + 1))
done

# ─── 1. the formula ───────────────────────────────────────────────────────────
#
# MD4 of the password in UTF-16LE. Written down everywhere and worth CONFIRMING against Samba
# rather than trusting, because getting the encoding wrong produces a hash that installs cleanly
# and authenticates nobody.
echo "── 1. is MD4(UTF-16LE(password)) really what Samba stores?"
NT=$(printf '%s' "$PW" | iconv -f UTF-8 -t UTF-16LE \
  | openssl dgst -md4 -provider legacy -provider default -r 2>/dev/null | cut -d' ' -f1 | tr 'a-f' 'A-F')
printf '%s\n%s\n' "$PW" "$PW" | smbpasswd -a -s "$GOOD" >/dev/null 2>&1
REAL=$(pdbedit -Lw -u "$GOOD" 2>/dev/null | awk -F: '{print $4}')

[ -n "$NT" ] && [ "$NT" = "$REAL" ] \
  && ok "the formula matches what smbpasswd stored" "$NT" \
  || bad "FORMULA MISMATCH" "computed=${NT:-<none>} stored=$REAL"

# WORTH KNOWING BEFORE DESIGNING AROUND IT: OpenSSL 3 moved MD4 into the legacy provider, and
# Node's crypto cannot reach it — `crypto.createHash('md4')` throws. So the API cannot borrow MD4
# from its runtime; it needs its own implementation. That is ~80 lines of RFC 1320 with published
# test vectors, which is a smaller price than putting a plaintext password on the wire.
if node -e 'require("node:crypto").createHash("md4")' >/dev/null 2>&1; then
  say "node can compute md4" "yes"
else
  say "node can compute md4" "NO — the API must carry its own MD4 (RFC 1320)"
fi

# ─── 2. installing a hash nobody typed ────────────────────────────────────────
echo
echo "── 2. can a PRECOMPUTED hash be installed?"
NT2=$(printf '%s' "$PW2" | iconv -f UTF-8 -t UTF-16LE \
  | openssl dgst -md4 -provider legacy -provider default -r 2>/dev/null | cut -d' ' -f1 | tr 'a-f' 'A-F')

# The account is created by Samba FIRST, with a throwaway password, so that the SID and everything
# else Samba invents already exist. The import then only has to carry the hash. Importing a user
# Samba has never seen also works, but it mints a fresh SID — and a SID that changes under a user
# is a Windows client's idea of a different person.
printf '%s\n%s\n' 'gecici-parola' 'gecici-parola' | smbpasswd -a -s "$SUBJ" >/dev/null 2>&1

# THE FIELD THAT COST AN HOUR: `LCT-00000000`. The smbpasswd format's last-change-time is not
# decoration — a zero there installs the hash and authenticates NOBODY, silently. With a real
# timestamp the same import works. Measured both ways; this line is the difference.
printf '%s:%s:%s:%s:[U          ]:LCT-%X:\n' \
  "$SUBJ" 399911 'NO PASSWORDXXXXXXXXXXXXXXXXXXXXX' "$NT2" "$(date +%s)" > "$IMPORT"

pdbedit -i "smbpasswd:$IMPORT" -e tdbsam >/dev/null 2>&1 \
  && ok "the import was accepted" || bad "IMPORT REFUSED"

STORED=$(pdbedit -Lw -u "$SUBJ" 2>/dev/null | awk -F: '{print $4}')
[ "$STORED" = "$NT2" ] \
  && ok "the stored hash is the one we computed" "$STORED" \
  || bad "STORED HASH DIFFERS" "$STORED"

# ─── 3. the only question that matters ────────────────────────────────────────
echo
echo "── 3. does a hash that arrived that way actually log in?"
systemctl restart smbd >/dev/null 2>&1
for _ in $(seq 1 20); do smbclient -L localhost -N >/dev/null 2>&1 && break; sleep 0.5; done

smbclient -L localhost -U "$SUBJ%$PW2" >/dev/null 2>&1 \
  && ok "the new password logs in — and Samba never saw it as text" \
  || bad "THE IMPORTED HASH DOES NOT AUTHENTICATE"

smbclient -L localhost -U "$SUBJ%gecici-parola" >/dev/null 2>&1 \
  && bad "THE OLD PASSWORD STILL WORKS — the import did not replace it" \
  || ok "the throwaway password no longer works"

# A test that cannot fail proves nothing: if the server let anybody in, the two checks above would
# both pass for the wrong reason.
smbclient -L localhost -U "$SUBJ%yanlis-parola" >/dev/null 2>&1 \
  && bad "A WRONG PASSWORD ALSO LOGGED IN — this whole file measures nothing" \
  || ok "a wrong password is still refused"

echo
echo "════ $passed passed, $failed failed"
[ "$failed" -eq 0 ]
