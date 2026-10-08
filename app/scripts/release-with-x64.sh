#!/usr/bin/env bash
# Dual-arch (arm64 + Intel x64) GitHub release for Proxy Farm macOS.
#
# Ported from lingoreup's scripts/release-with-x64.sh. WHY a wrapper (not a
# flag on local-release.sh): the arm64 release pipeline must stay
# unchanged and independently runnable; this wrapper runs it verbatim via
# subprocess, then ADDS the x64 artifacts + a dual-arch latest-mac.yml.
#
# electron-updater 6.8.3 MacUpdater arch selection (same as lingoreup,
# verified from source, out/MacUpdater.js:70-76):
#   isArm64(file) = file url contains the substring "arm64"
#   arm64/Rosetta Mac + an arm64 file present → picks the "arm64" file
#   Intel Mac                                  → picks the non-"arm64" file
# Filenames encode arch explicitly (…-arm64-… vs …-x64-…). arm64 MUST be
# listed first in latest-mac.yml (legacy pre-6 clients ignore the arch
# filter and take files[0]).
#
# Flow:
#   1. scripts/local-release.sh <VERSION> [flags]   (arm64, full release:
#      bump/tag/push/sign/notarize/gh release — run as a subprocess so its
#      own state file is independent and gets wiped on its own success)
#   2. build_sign_notarize_dist x64  (sign+notarize+dist only; no bump/tag/push)
#   3. Regenerate latest-mac.yml as dual-arch (arm64 + x64) from the two zips
#   4. gh release upload --clobber  x64.zip x64.dmg latest-mac.yml
#
# Usage:
#   bash scripts/release-with-x64.sh 0.1.0
#   bash scripts/release-with-x64.sh 0.1.0 --resume     # forwarded to arm64 step
#   bash scripts/release-with-x64.sh 0.1.0 --dry-run     # arm64 rehearsal only; x64 skipped

set -euo pipefail

VERSION="${1:-}"; shift || true
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "Usage: $0 <X.Y.Z> [--resume|--dry-run]" >&2; exit 2; }

cd "$(dirname "$0")/.."
ROOT="$(pwd)"   # app/

STATE_FILE_NAME=".release-state-x64.json"
# shellcheck source=lib/state-helpers.sh
source "$ROOT/scripts/lib/state-helpers.sh"
# shellcheck source=lib/build-sign-notarize.sh
source "$ROOT/scripts/lib/build-sign-notarize.sh"

SIGN_IDENTITY="Developer ID Application: Chien Bui Minh (CCQUC3AGRH)"
NOTARIZE_PROFILE="${PROXYFARM_NOTARIZE_PROFILE:-PROXYFARM_NOTARIZE}"
ENTITLEMENTS="$ROOT/entitlements.plist"
SINGBOX_ENTITLEMENTS="$ROOT/entitlements.singbox.plist"
PRODUCT_SLUG="ProxyFarm"
GH_REPO="huuhoa143/proxy-farm"

DRY_RUN=0
RESUME=0
for a in "$@"; do
  [[ "$a" == "--dry-run" ]] && DRY_RUN=1
  [[ "$a" == "--resume" ]] && RESUME=1
done

# ── 1. arm64 release (unchanged main flow, own process + own state file) ──
bold "[dual] 1/4  arm64 release — scripts/local-release.sh $VERSION $*"
bash "$ROOT/scripts/local-release.sh" "$VERSION" "$@"

if (( DRY_RUN == 1 )); then
  warn "[dual] --dry-run: skipping x64 build + dual-arch yml (arm64 rehearsal only)"
  exit 0
fi

# `electron-forge make` for x64 cleans out/, taking the arm64 artifacts with
# it, but step 3 still needs the arm64 zip. Keep a copy outside out/ (and, on a
# resume where even that is gone, fetch the one already on the release).
A_ZIP_NAME="ProxyFarm-darwin-arm64-$VERSION.zip"
A_ZIP_KEEP="$ROOT/.release-keep/$A_ZIP_NAME"
mkdir -p "$ROOT/.release-keep"
if [[ -f "$ROOT/out/make/zip/darwin/arm64/$A_ZIP_NAME" ]]; then
  cp -f "$ROOT/out/make/zip/darwin/arm64/$A_ZIP_NAME" "$A_ZIP_KEEP"
fi

# ── 2. x64 build + sign + notarize + dist (own state file: .release-state-x64.json) ──
if (( RESUME == 1 )) && [[ -f "$(state_path)" ]]; then
  PREV_VERSION="$(state_get version)"
  [[ "$PREV_VERSION" == "$VERSION" ]] || { red "[dual] x64 state is for v$PREV_VERSION but you asked v$VERSION"; exit 1; }
  green "[dual] Resuming x64 v$VERSION"
else
  state_init "$VERSION"
fi

bold "[dual] 2/4  x64 build — sign-proxyfarm-bundle.sh + notarize + dist"
build_sign_notarize_dist x64 "$VERSION" 0
X_ZIP="$BSN_ZIP"
X_DMG="$BSN_DMG"

# ── 3. dual-arch latest-mac.yml ──────────────────────────────────────────
bold "[dual] 3/4  dual-arch latest-mac.yml"
A_ZIP="$A_ZIP_KEEP"
if [[ ! -f "$A_ZIP" ]]; then
  ensure_gh_token || true
  gh release download "v$VERSION" --repo "$GH_REPO" --pattern "$A_ZIP_NAME" --dir "$ROOT/.release-keep" --clobber \
    || { red "[dual] arm64 zip neither kept nor on the v$VERSION release"; exit 1; }
fi
for f in "$A_ZIP" "$X_ZIP" "$X_DMG"; do
  [[ -f "$f" ]] || { red "[dual] missing artifact: $f"; exit 1; }
done

_sha512_b64() { shasum -a 512 "$1" | awk '{print $1}' | xxd -r -p | base64; }
_size()       { stat -f%z "$1"; }

A_SHA="$(_sha512_b64 "$A_ZIP")"; A_SZ="$(_size "$A_ZIP")"
X_SHA="$(_sha512_b64 "$X_ZIP")"; X_SZ="$(_size "$X_ZIP")"

YML_DIR="$(mktemp -d)"; YML="$YML_DIR/latest-mac.yml"
cat > "$YML" <<EOF
version: $VERSION
files:
  - url: $(basename "$A_ZIP")
    sha512: $A_SHA
    size: $A_SZ
  - url: $(basename "$X_ZIP")
    sha512: $X_SHA
    size: $X_SZ
path: $(basename "$A_ZIP")
sha512: $A_SHA
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
EOF
echo "  arm64 zip: $(basename "$A_ZIP") ($A_SZ B)"
echo "  x64   zip: $(basename "$X_ZIP") ($X_SZ B)"

# ── 4. upload x64 artifacts + clobber the dual-arch yml ──────────────────
bold "[dual] 4/4  gh release upload (x64 zip + dmg + dual-arch yml)"
ensure_gh_token || true
gh release upload "v$VERSION" --repo "$GH_REPO" --clobber "$X_ZIP" "$X_DMG" "$YML"

state_cleanup
rm -rf "$ROOT/.release-keep"
green "[dual] Dual-arch release v$VERSION complete (arm64 + x64)"
echo "    https://github.com/$GH_REPO/releases/tag/v$VERSION"
