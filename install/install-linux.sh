#!/usr/bin/env bash
# Install the GarysTV engine as an always-on service on an Ubuntu/Debian home server.
# TVs (Fire TV, Samsung) and the Windows app then use it over the home network.
#
#   sudo ./install/install-linux.sh                 # install or update
#   sudo ./install/install-linux.sh --uninstall     # remove the service (keeps settings and recordings)
#
# Options: --recordings DIR (default /var/lib/garystv/recordings), --port N (default 5480).
set -euo pipefail

APP_DIR=/opt/garystv
DATA_DIR=/var/lib/garystv
RECORDINGS="$DATA_DIR/recordings"
PORT=5480
UNINSTALL=0
SERVICE_USER=garystv
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --recordings) RECORDINGS="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo: sudo $0 $*" >&2
    exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
    systemctl disable --now garystv.service 2>/dev/null || true
    rm -f /etc/systemd/system/garystv.service
    systemctl daemon-reload
    rm -rf "$APP_DIR"
    echo "Removed the GarysTV service. Settings and recordings are still in $DATA_DIR."
    exit 0
fi

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq nodejs npm ffmpeg
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ]; then
    echo "GarysTV needs Node.js 18 or newer (found $(node -v))." >&2
    exit 1
fi

echo "==> Creating the '$SERVICE_USER' service account"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "==> Copying GarysTV to $APP_DIR"
install -d -m 755 "$APP_DIR"
rm -rf "$APP_DIR/src"
cp -r "$REPO_DIR/src" "$REPO_DIR/headless.js" "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$APP_DIR/"
# Only the engine's own libraries; Electron is for the Windows app.
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 775 -o "$SERVICE_USER" -g "$SERVICE_USER" "$RECORDINGS"

echo "==> Setting up the GarysTV service"
cat > /etc/systemd/system/garystv.service <<EOF
[Unit]
Description=GarysTV engine (live TV, guide, recordings) for the TVs on the home network
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/headless.js --data=$DATA_DIR/data --recordings=$RECORDINGS --port=$PORT
# Stopping lets recordings finish writing first.
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    echo "==> Opening firewall port $PORT"
    ufw allow "$PORT/tcp" comment "GarysTV" >/dev/null
fi

systemctl daemon-reload
systemctl enable garystv.service
systemctl restart garystv.service

ip_addr="$(hostname -I | awk '{print $1}')"
up=0
for _ in $(seq 1 30); do
    if node -e "require('http').get('http://127.0.0.1:$PORT/api/ping', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
        up=1
        break
    fi
    sleep 1
done
if [ "$up" -eq 1 ]; then
    echo
    echo "GarysTV is running and starts automatically on boot."
    echo "  TVs:        the GarysTV app finds it, or enter $ip_addr"
    echo "  Browser:    http://$ip_addr:$PORT/"
    echo "  Logs:       journalctl -u garystv -f"
    echo "  Recordings: $RECORDINGS"
else
    echo
    echo "GarysTV didn't stay up. Recent log:"
    journalctl -u garystv -n 20 --no-pager || true
    exit 1
fi
