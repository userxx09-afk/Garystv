#!/usr/bin/env bash
# Adds a family IPTV account to the home server's secrets file (/etc/garystv/secrets.env), and
# sets or changes the family code, without the login ever being typed on a command line, shown
# on screen or kept on this computer. Family members then add it from the hidden page in GarysTV
# (Settings > Status, tapped 12 times) with the code. See src/core/family.js.
#
# Run it in a terminal, from this computer (Git Bash on Windows):
#   bash install/family-account.sh            (the server is "tapper", the ssh alias)
#   bash install/family-account.sh otherhost
# Each run adds one account. Several logins to the same service: run it once for each (they
# work together: when one is in use, GarysTV uses the other).
set -euo pipefail
HOST="${1:-tapper}"

echo "Family IPTV account for $HOST. The password and code aren't shown as you type."
echo "Leave a line empty to skip it. Ctrl+C stops without changing anything."
echo
read -r -p "Name family members will see (e.g. Prime West): " NAME
read -r -p "Server addresses, separated by spaces: " SERVERS
read -r -p "Username: " USER_
read -r -s -p "Password: " PASS; echo
read -r -p "Number channels from (Enter = picked for them; 2000 for a second login, ...): " FIRST
read -r -s -p "Family code, 6 or more characters (Enter = keep the current one): " CODE; echo
echo

if [ -n "$CODE" ] && [ "${#CODE}" -lt 6 ]; then echo "The code needs 6 or more characters. Nothing changed."; exit 1; fi
if [ -z "$NAME$SERVERS$USER_$PASS" ] && [ -z "$CODE" ]; then echo "Nothing to do."; exit 0; fi
if [ -n "$NAME$SERVERS$USER_$PASS" ] && { [ -z "$SERVERS" ] || [ -z "$USER_" ] || [ -z "$PASS" ]; }; then
  echo "An account needs the servers, username and password. Nothing changed."; exit 1
fi
for v in "$NAME" "$SERVERS" "$USER_" "$PASS" "$FIRST" "$CODE"; do
  case "$v" in *$'\t'*|*$'\n'*) echo "Tabs can't be used. Nothing changed."; exit 1 ;; esac
done

# What runs on the server (as root). The values come in on its input, one "KEY<tab>value" a line,
# never on a command line. Writes them in systemd's format and says only what it did.
REMOTE=$(cat <<'R'
set -euo pipefail
F=/etc/garystv/secrets.env
[ -f "$F" ] || { echo "No $F here: is GarysTV installed?"; exit 1; }
declare -A V=()
while IFS=$'\t' read -r k v; do V["$k"]="$v"; done
q() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }
cp -p "$F" "$F.bak"
if [ -n "${V[CODE]:-}" ]; then
  sed -i '/^FAMILY_CODE=/d' "$F"
  printf '\n# Family code for adding accounts from GarysTV (Settings > Status, 12 taps)\nFAMILY_CODE=%s\n' "$(q "${V[CODE]}")" >> "$F"
  echo "Family code set."
fi
if [ -n "${V[USERNAME]:-}" ]; then
  n=1; while grep -q "^FAMILY${n}_" "$F"; do n=$((n+1)); done
  {
    printf '\n# Family account %s (offered with the family code; this server does not use it itself)\n' "$n"
    if [ -n "${V[NAME]:-}" ]; then printf 'FAMILY%s_NAME=%s\n' "$n" "$(q "${V[NAME]}")"; fi
    printf 'FAMILY%s_SERVERS=%s\n' "$n" "$(q "${V[SERVERS]}")"
    printf 'FAMILY%s_USERNAME=%s\n' "$n" "$(q "${V[USERNAME]}")"
    printf 'FAMILY%s_PASSWORD=%s\n' "$n" "$(q "${V[PASSWORD]}")"
    if [ -n "${V[FIRST]:-}" ]; then printf 'FAMILY%s_FIRST_NUMBER=%s\n' "$n" "$(q "${V[FIRST]}")"; fi
  } >> "$F"
  echo "Added family account $n${V[NAME]:+ (${V[NAME]})}."
fi
rm -f "$F.bak"
grep -q '^FAMILY_CODE=' "$F" || echo "No family code is set yet: run this again and give one, or family members can't add anything."
R
)

printf 'NAME\t%s\nSERVERS\t%s\nUSERNAME\t%s\nPASSWORD\t%s\nFIRST\t%s\nCODE\t%s\n' "$NAME" "$SERVERS" "$USER_" "$PASS" "$FIRST" "$CODE" \
  | ssh "$HOST" "sudo bash -c $(printf '%q' "$REMOTE")"
unset PASS CODE
echo "Done. No restart needed: family members can add it now (on TapperVPN)."
