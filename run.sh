#!/bin/sh
# One-time setup + start. Creates the data folders, writes .env for docker compose,
# copies the HMA device certificate in if the app is installed, then builds and starts.
# Afterwards `docker compose up -d` / `docker compose down` work on their own.
#
#   FARM=~/proxy-farm   where all data lives (nothing is written into the repo except .env)
#   PORT=8090           UI port on 127.0.0.1
#   BIND=127.0.0.1      host interface the proxy ports listen on
#   SCAN=~/Downloads    read-only folder the UI lists as import suggestions; SCAN= to turn off
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

# Keep earlier choices: values already in .env win over the defaults, the environment
# wins over both.
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in FARM|PORT|BIND|SCAN) eval "[ -n \"\${$k+x}\" ] || $k=\"\$v\"" ;; esac
  done < .env
fi
FARM="${FARM:-$HOME/proxy-farm}"
PORT="${PORT:-8090}"
BIND="${BIND:-127.0.0.1}"
SCAN="${SCAN-$HOME/Downloads}"

mkdir -p "$FARM/secrets" "$FARM/status" "$FARM/configs" "$FARM/data" "$FARM/inbox"
chmod 700 "$FARM/secrets"
# Compose cannot make a mount optional, so "no scan folder" is an empty one.
if [ -z "$SCAN" ] || [ ! -d "$SCAN" ]; then SCAN="$FARM/.noscan"; mkdir -p "$SCAN"; fi

cat > .env <<EOF
FARM=$FARM
PORT=$PORT
BIND=$BIND
SCAN=$SCAN
# Port containers are created by the manager, not by compose; don't warn about them.
COMPOSE_IGNORE_ORPHANS=true
EOF

# The HMA app keeps its device certificate outside anything Docker Desktop shares, so the
# copy has to happen here on the host. The manager picks it up from the inbox.
HMA_TOKEN="/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json"
if [ -r "$HMA_TOKEN" ]; then
  cp -p "$HMA_TOKEN" "$FARM/inbox/tokenCoreSE.json" && chmod 600 "$FARM/inbox/tokenCoreSE.json"
  echo "HMA: đã tìm thấy chứng chỉ thiết bị, sẽ tự nạp"
fi

# A manager started by an older run.sh (plain docker run) would hold the name.
if [ -n "$(docker ps -aq -f name=^pf-manager$)" ] && \
   [ -z "$(docker ps -aq -f name=^pf-manager$ -f label=com.docker.compose.project=proxy-farm)" ]; then
  docker rm -f pf-manager >/dev/null
fi

docker compose build -q node manager
docker compose up -d manager
# Each rebuild leaves the previous image untagged; drop the ones nothing uses any more.
docker image prune -f --filter label=proxy-farm >/dev/null 2>&1 || true

echo "Proxy Farm: http://127.0.0.1:$PORT   (data in $FARM)"
