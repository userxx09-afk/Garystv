#!/usr/bin/env bash
# The node -e / -p snippets below are meant to stay in single quotes.
# shellcheck disable=SC2016
# Installs the newest GarysTV Release on this home server, as root. systemd runs this
# (garystv-update.service) when GarysTV leaves its cue in the update folder: at the time
# picked in Settings > Updates, when nothing is recording or being watched.
#
# It doesn't use anything GarysTV wrote except the cue: it downloads the Release from GitHub
# itself and checks it against the hash GitHub lists. If the new version doesn't start, the
# old one is put back. What happened goes in status.json, which GarysTV shows in Settings.
set -euo pipefail

RELEASES=https://github.com/userxx09-afk/Garystv/releases/latest/download
APP_DIR=/opt/garystv
UPD=/var/lib/garystv/update
UNIT=/etc/systemd/system/garystv.service
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

status() { # ok version error
    node -e 'const [ok, version, error] = process.argv.slice(1); require("fs").writeFileSync(process.argv[4], JSON.stringify({ ok: ok === "1", version, error, at: Date.now() }))' \
        "$1" "$2" "$3" "$UPD/status.json"
    chown garystv:garystv "$UPD/status.json" 2>/dev/null || true
}

rm -f "$UPD/ready"
curl -fsSL --retry 3 -o "$WORK/version.json" "$RELEASES/version.json" || { status 0 "" "couldn't reach GitHub"; exit 1; }
version="$(node -p 'require(process.argv[1]).version' "$WORK/version.json")"
file="$(node -p 'require(process.argv[1]).linux || ""' "$WORK/version.json")"
sum="$(node -p 'require(process.argv[1]).linuxSha256 || ""' "$WORK/version.json")"
current="$(node -p 'require(process.argv[1]).version' "$APP_DIR/package.json" 2>/dev/null || echo 0)"
if [ -z "$file" ] || [ -z "$sum" ]; then status 0 "$version" "the release has no home-server files"; exit 1; fi
if [ "$version" = "$current" ]; then status 1 "$version" ""; exit 0; fi

echo "Updating GarysTV $current -> $version"
curl -fsSL --retry 3 -o "$WORK/garystv.tar.gz" "$RELEASES/$file" || { status 0 "$version" "the download failed"; exit 1; }
echo "$sum  $WORK/garystv.tar.gz" | sha256sum -c --quiet - || { status 0 "$version" "the download was damaged (hash didn't match)"; exit 1; }
mkdir "$WORK/new"
tar -xzf "$WORK/garystv.tar.gz" -C "$WORK/new"

# Keep this server's port and recordings folder.
port="$(grep -o -- '--port=[0-9]*' "$UNIT" | cut -d= -f2 || true)"
recs="$(grep -o -- '--recordings=[^ ]*' "$UNIT" | cut -d= -f2- || true)"

rm -rf "$APP_DIR.prev"
cp -a "$APP_DIR" "$APP_DIR.prev"
if bash "$WORK/new/install/install-linux.sh" ${port:+--port "$port"} ${recs:+--recordings "$recs"}; then
    status 1 "$version" ""
    echo "GarysTV $version is running."
else
    echo "GarysTV $version didn't start; putting $current back."
    rm -rf "$APP_DIR"
    mv "$APP_DIR.prev" "$APP_DIR"
    systemctl restart garystv.service
    status 0 "$version" "it didn't start, so $current was put back"
    exit 1
fi
