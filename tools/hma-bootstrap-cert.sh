#!/bin/bash
# One-time HMA device-certificate bootstrap (macOS, where the HMA app is installed).
#
# WHY this step exists: HMA issues the device certificate (the PKCS#12 the IKEv2
# tunnels authenticate with) only through Avast's proprietary "connect token" flow,
# which cannot be reproduced from the activation code alone off-device (see README →
# "The activation-code wall"). So the cert is exported ONCE here; afterwards the farm
# runs the subscription on ANY platform, no HMA app, driven by the activation code.
#
# It reads the app's device token (root-owned), copies it somewhere you can read, and
# optionally extracts a portable .p12 — then prints the exact `onboard-code` command.
#
# Usage:
#   sudo bash tools/hma-bootstrap-cert.sh <ACTIVATION-CODE> [outdir]
#
# Output (default outdir = ./hma-bootstrap):
#   tokenCoreSE.json   the app's device token (PKCS#12 + password + udid inside)
#   device.p12         the raw PKCS#12 (portable; password printed + saved)
#   device.p12.pass    the PKCS#12 password
#   onboard.txt        the ready-to-run farm command

set -euo pipefail
CODE="${1:-}"
OUT="${2:-./hma-bootstrap}"
TOKEN="/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json"

[ -n "$CODE" ] || { echo "usage: sudo bash $0 <ACTIVATION-CODE> [outdir]"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Cần sudo để đọc device token:  sudo bash $0 $CODE $OUT"; exit 1; }
[ -f "$TOKEN" ] || { echo "!! Không thấy $TOKEN — HMA app đã cài & đăng nhập chưa?"; exit 1; }

mkdir -p "$OUT"
REAL_USER="${SUDO_USER:-$(id -un)}"
cp "$TOKEN" "$OUT/tokenCoreSE.json"
chown "$REAL_USER" "$OUT/tokenCoreSE.json" 2>/dev/null || true
chmod 600 "$OUT/tokenCoreSE.json"

# Extract a portable .p12 so the farm never needs the JSON (or macOS) again.
python3 - "$OUT/tokenCoreSE.json" "$OUT" <<'PY'
import json, base64, sys
tok, out = sys.argv[1], sys.argv[2]
dev = json.loads(base64.b64decode(json.load(open(tok))["DeviceManager.device"]))
cred = dev["credentials"]
open(out + "/device.p12", "wb").write(base64.b64decode(cred["certificate"]))
open(out + "/device.p12.pass", "w").write(cred["certificatePassword"])
print("udid:", dev["udid"])
print("p12 password:", cred["certificatePassword"])
PY
chown "$REAL_USER" "$OUT"/device.p12* 2>/dev/null || true
chmod 600 "$OUT"/device.p12*

cat > "$OUT/onboard.txt" <<EOF
# Nạp vào farm (chạy được trên mọi máy có repo proxy-farm):
python3 manager/farm.py onboard-code $CODE "$OUT/tokenCoreSE.json"
# hoặc dùng .p12 portable:
python3 manager/farm.py onboard-code $CODE "$OUT/device.p12" "$(cat "$OUT/device.p12.pass")"
EOF
chown "$REAL_USER" "$OUT/onboard.txt" 2>/dev/null || true

echo
echo ">> Xong. Thư mục: $OUT"
echo ">> Bước tiếp theo:"
cat "$OUT/onboard.txt"
