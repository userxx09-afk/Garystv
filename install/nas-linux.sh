#!/usr/bin/env bash
# The node -e snippets below are meant to stay in single quotes.
# shellcheck disable=SC2016
# Connects this home server to network storage for recordings (Settings > Recording), as root.
# systemd runs this (garystv-nas.service) when GarysTV leaves request.json in its nas folder.
#
# GarysTV runs as a limited user and can't mount a share itself. This checks every value it was
# given before using any of it, takes the password out of GarysTV's folder at once and keeps it
# where only root can read it, and mounts the share at /mnt/garystvnas for the garystv user
# (a systemd mount unit, so it comes back after a restart). What happened goes in status.json.
set -euo pipefail

NAS=/var/lib/garystv/nas
REQ="$NAS/request.json"
MNT=/mnt/garystvnas
UNIT_NAME=mnt-garystvnas.mount
UNIT="/etc/systemd/system/$UNIT_NAME"
CRED=/etc/garystv/nas-credentials
SERVICE_USER=garystv

[ -f "$REQ" ] || exit 0

field() {
    node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; process.stdout.write(v == null ? "" : String(v))' "$REQ" "$1"
}
type="$(field type)"
server="$(field server)"
share="$(field share)"
user="$(field username)"
pass="$(field password)"
at="$(field at)"
rm -f "$REQ" # the password doesn't stay where GarysTV can read it

[[ "$at" =~ ^[0-9]+$ ]] || at=0
status() { # ok error
    node -e 'const [ok, error, at, file] = process.argv.slice(1); require("fs").writeFileSync(file, JSON.stringify({ ok: ok === "1", error, at: +at, done: Date.now() }))' \
        "$1" "$2" "$at" "$NAS/status.json"
    chown "$SERVICE_USER:$SERVICE_USER" "$NAS/status.json" 2>/dev/null || true
}
fail() { status 0 "$1"; exit 1; }

re_server='^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$'
re_smb_share='^[A-Za-z0-9][A-Za-z0-9._$-]{0,79}$'
re_nfs_share='^/[A-Za-z0-9._/-]{0,200}$'
re_user='^[A-Za-z0-9._@\\-]{0,64}$'
case "$type" in
    smb | nfs | none) ;;
    *) fail "unknown storage type" ;;
esac
if [ "$type" != none ]; then
    [[ "$server" =~ $re_server ]] || fail "That server name isn't valid."
    if [ "$type" = smb ]; then
        [[ "$share" =~ $re_smb_share ]] || fail "That share name isn't valid."
    else
        [[ "$share" =~ $re_nfs_share && "$share" != *..* ]] || fail "That NFS path isn't valid."
    fi
    [[ "$user" =~ $re_user ]] || fail "That username isn't valid."
    [[ "$pass" != *$'\n'* ]] || fail "That password can't be used."
fi

# Whatever was connected before goes first.
systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
if [ "$type" = none ]; then
    rm -f "$UNIT" "$CRED"
    systemctl daemon-reload
    status 1 ""
    exit 0
fi

if [ "$type" = smb ] && ! command -v mount.cifs >/dev/null; then apt-get install -y -qq cifs-utils >/dev/null || fail "Couldn't install cifs-utils (needed for shared folders)."; fi
if [ "$type" = nfs ] && ! command -v mount.nfs >/dev/null; then apt-get install -y -qq nfs-common >/dev/null || fail "Couldn't install nfs-common (needed for NFS)."; fi

install -d -m 755 "$MNT"
uid="$(id -u "$SERVICE_USER")"
gid="$(id -g "$SERVICE_USER")"
if [ "$type" = smb ]; then
    what="//$server/$share"
    fstype=cifs
    if [ -n "$user" ]; then
        install -d -m 750 -o root -g "$SERVICE_USER" /etc/garystv
        (umask 077 && printf 'username=%s\npassword=%s\n' "$user" "$pass" >"$CRED")
        chmod 600 "$CRED"
        chown root:root "$CRED"
        auth="credentials=$CRED"
    else
        rm -f "$CRED"
        auth="guest"
    fi
    opts="$auth,uid=$uid,gid=$gid,file_mode=0664,dir_mode=0775,iocharset=utf8,_netdev,nofail"
else
    what="$server:$share"
    fstype=nfs
    rm -f "$CRED"
    # soft: if the NAS goes away mid-recording, writing fails (and GarysTV says so) instead of hanging.
    opts="soft,timeo=150,retrans=3,_netdev,nofail"
fi

cat >"$UNIT" <<EOF
[Unit]
Description=Network storage for GarysTV recordings (Settings > Recording)
After=network-online.target
Wants=network-online.target

[Mount]
What=$what
Where=$MNT
Type=$fstype
Options=$opts
TimeoutSec=30

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
if ! systemctl enable --now "$UNIT_NAME" >/dev/null 2>&1; then
    why="$(journalctl -u "$UNIT_NAME" -n 6 --no-pager -o cat 2>/dev/null | grep -iE 'error|denied|refused|resolve|down|timed' | tail -n 2 | tr '\n' ' ')"
    systemctl disable "$UNIT_NAME" >/dev/null 2>&1 || true
    fail "Couldn't connect to $what. ${why:-Check the server, share name, username and password.}"
fi
if ! runuser -u "$SERVICE_USER" -- sh -c 'touch "$1/.garystv-test" && rm -f "$1/.garystv-test"' _ "$MNT"; then
    fail "Connected to $what, but GarysTV can't save files there. Check that user may write to the share (for NFS, the export must allow this server)."
fi
status 1 ""
echo "Network storage connected: $what at $MNT"
