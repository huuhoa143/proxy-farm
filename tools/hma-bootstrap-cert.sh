#!/bin/bash
# Export the HMA device certificate from a machine that has the HMA app (macOS).
#
# WHY this step exists: HMA issues the device certificate (the PKCS#12 the IKEv2
# tunnels authenticate with) only through Avast's proprietary "connect token" flow,
# which cannot be reproduced from the activation code alone off-device (see README →
# "HMA: chạy local"). So the certificate is taken from the app once.
#
#   * Farm on THIS machine: the token goes straight into the farm's inbox and the
#     printed command onboards it through the running manager (tagged with the code).
#   * Farm on ANOTHER machine: copy device.p12 + device.p12.pass into that farm's
#     inbox folder and run the printed command there.
#
# Usage:
#   bash tools/hma-bootstrap-cert.sh <ACTIVATION-CODE> [outdir]
#   (sudo only if your HMA build keeps the token unreadable to your user)
#
# Output (default outdir = ./hma-bootstrap), all mode 600:
#   tokenCoreSE.json   the app's device token (PKCS#12 + password + udid inside)
#   device.p12         the raw PKCS#12 (portable)
#   device.p12.pass    its password (farm.py reads it from here; never on a command line)
#   onboard.txt        the commands to run

set -euo pipefail
umask 077
CODE="${1:-}"
OUT="${2:-./hma-bootstrap}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json"

[ -n "$CODE" ] || { echo "usage: bash $0 <ACTIVATION-CODE> [outdir]"; exit 1; }
[ -f "$TOKEN" ] || { echo "!! Không thấy $TOKEN — HMA app đã cài & đăng nhập chưa?"; exit 1; }
[ -r "$TOKEN" ] || { echo "Không đọc được device token, chạy lại với sudo:  sudo bash $0 $CODE $OUT"; exit 1; }

REAL_USER="${SUDO_USER:-$(id -un)}"
own() { chown "$REAL_USER" "$@" 2>/dev/null || true; chmod 600 "$@"; }

mkdir -p "$OUT"; chmod 700 "$OUT"; chown "$REAL_USER" "$OUT" 2>/dev/null || true
cp "$TOKEN" "$OUT/tokenCoreSE.json"; own "$OUT/tokenCoreSE.json"

# Extract a portable .p12 so another farm never needs the JSON (or macOS).
python3 - "$OUT/tokenCoreSE.json" "$OUT" <<'PY'
import json, base64, sys
tok, out = sys.argv[1], sys.argv[2]
dev = json.loads(base64.b64decode(json.load(open(tok))["DeviceManager.device"]))
cred = dev["credentials"]
open(out + "/device.p12", "wb").write(base64.b64decode(cred["certificate"]))
open(out + "/device.p12.pass", "w").write(cred["certificatePassword"])
print("udid:", dev["udid"])
PY
own "$OUT/device.p12" "$OUT/device.p12.pass"

# The farm on this machine, if run.sh has set one up: its inbox is mounted in the
# manager container as /inbox, which is the only place the manager can read files from.
FARM=""
[ -f "$REPO/.env" ] && FARM="$(grep -E '^FARM=' "$REPO/.env" | head -1 | cut -d= -f2- | tr -d '"')"
if [ -n "$FARM" ] && [ -d "$FARM/inbox" ]; then
  cp "$OUT/tokenCoreSE.json" "$FARM/inbox/tokenCoreSE.json"; own "$FARM/inbox/tokenCoreSE.json"
  LOCAL="docker exec pf-manager python3 farm.py onboard-code $CODE /inbox/tokenCoreSE.json"
fi

{
  if [ -n "${LOCAL:-}" ]; then
    echo "# Farm trên máy này (token đã nằm trong $FARM/inbox, farm cũng tự nạp trong 1 phút):"
    echo "$LOCAL"
    echo
  fi
  echo "# Farm ở máy khác: chép device.p12 và device.p12.pass vào thư mục inbox của farm đó"
  echo "# (\$FARM/inbox, mặc định ~/proxy-farm/inbox), rồi chạy trên máy đó:"
  echo "docker exec pf-manager python3 farm.py onboard-code $CODE /inbox/device.p12"
} > "$OUT/onboard.txt"
own "$OUT/onboard.txt"

echo
echo ">> Xong. Thư mục: $OUT"
echo ">> Bước tiếp theo:"
cat "$OUT/onboard.txt"
