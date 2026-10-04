#!/bin/bash
# Sync HMA device certificate into Proxy Farm — macOS, double-clickable.
#
# The HMA app keeps its certificate outside anything Docker Desktop shares, so the
# container cannot read it. This copies it into the farm inbox; the farm imports it
# within a minute (or press "Sync" in the UI to import at once). Run it on a machine
# that has the HMA app installed and signed in.
#
# Double-click in Finder, or run: bash tools/sync-hma.command
cd "$(dirname "$0")/.." || exit 1

# Where the farm keeps its data (inbox). Prefer .env written by run.sh, else the default.
FARM="$HOME/proxy-farm"
[ -f .env ] && FARM="$(grep -E '^FARM=' .env | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$FARM" ] || FARM="$HOME/proxy-farm"
INBOX="$FARM/inbox"
mkdir -p "$INBOX" 2>/dev/null

# Candidate locations for the device token across HMA builds.
CANDIDATES=(
  "/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json"
  "$HOME/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json"
  "/Library/Application Support/HMA! Pro VPN/state/vpn/tokenCoreSE.json"
)
SRC=""
for c in "${CANDIDATES[@]}"; do [ -r "$c" ] && { SRC="$c"; break; }; done

if [ -z "$SRC" ]; then
  echo "✗ Không tìm thấy chứng chỉ HMA trên máy này."
  echo "  Hãy cài app HMA VPN và đăng nhập (bằng activation code) trước, rồi chạy lại."
  echo; read -n 1 -s -r -p "Nhấn phím bất kỳ để đóng…"; exit 1
fi

cp -p "$SRC" "$INBOX/tokenCoreSE.json" && chmod 600 "$INBOX/tokenCoreSE.json"
echo "✓ Đã sao chép chứng chỉ vào farm."
echo "  Nguồn: $SRC"
echo "  Farm:  $INBOX"

# Nudge the farm to import right away (best-effort; it also auto-scans every minute).
PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
curl -s -m 5 -X POST "http://127.0.0.1:${PORT:-8090}/api/provider/hma-sync" -d '{}' >/dev/null 2>&1 \
  && echo "✓ Đã báo farm nạp ngay." \
  || echo "• Farm sẽ tự nạp trong vòng 1 phút (hoặc bấm nút Sync trong giao diện)."
echo; read -n 1 -s -r -p "Xong. Nhấn phím bất kỳ để đóng…"
