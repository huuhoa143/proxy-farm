#!/usr/bin/env bash
# Local end-to-end release for Proxy Farm v2, macOS arm64 leg.
#
# Ported from lingoreup's scripts/local-release.sh (spec §9). Dropped
# entirely: portable api/.venv, cythonize/bytecode-strip, the Python
# sidecar smoke imports, the in-app announcement step and the parent
# VideoCaptionerSystem submodule bump — none of that exists in Proxy Farm.
# What's added: the sing-box GPL source tarball attached to the GitHub
# release (GPLv3 §6 — app/resources/sing-box-src/, fetched and pinned by
# scripts/prebuild-singbox.mjs), a min-macOS-12 promise check, and a
# (currently soft) gate for the app-translocation guard.
#
# The actual per-arch build→sign→notarize→dist sequence lives in
# scripts/lib/build-sign-notarize.sh, shared with release-with-x64.sh so
# the two scripts can't drift apart the way lingoreup's local-release.sh /
# build-x64-local.sh pair did.
#
# Pipeline (~10-18 min; mostly Apple notarize wait):
#   1.  Prereqs check (tools, identity, notarize profile, clean git tree)
#   1b. App-translocation guard gate (soft — see §9 note below)
#   2.  Bump app/package.json version + commit + tag + push
#   3.  pnpm run make (electron-forge make, darwin arm64)
#   3b. Min-macOS-12 promise check
#   4.  Inside-out codesign (sign-proxyfarm-bundle.sh)
#   5.  Notarize .app (ditto transport zip → notarytool poll)
#   6.  Staple .app + spctl
#   7.  Smoke-launch
#   8.  ZIP + DMG
#   9.  Notarize DMG (separate submission)
#   10. Staple DMG + verify
#   11. latest-mac.yml for electron-updater
#   12. gh release create + upload: ZIP, DMG, latest-mac.yml, sing-box
#       source tarball
#
# Usage:
#   bash scripts/local-release.sh 0.1.0               # full release
#   bash scripts/local-release.sh 0.1.0 --resume      # resume after failure
#   bash scripts/local-release.sh 0.1.0 --dry-run     # rehearse, no upload
#
# --dry-run runs the real `pnpm run make` and the real tool/signing-identity
# checks, then stops — it does NOT bump/commit/tag/push, and does NOT
# codesign, notarize, build ZIP/DMG, or touch GitHub (those all need
# credentials this environment may not have, and a real signature/
# notarization submission is not something a rehearsal should spend).
#
# Credentials (Keychain, one-time setup per machine):
#   PROXYFARM_NOTARIZE   notarytool keychain profile (override the name with
#                        PROXYFARM_NOTARIZE_PROFILE, e.g. a profile shared
#                        with another app of the same team)
#
# GH_TOKEN auto-derived from `gh auth token -u huuhoa143` when unset.

set -euo pipefail

# ─── Args ───────────────────────────────────────────────────────────────
VERSION=""
RESUME=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)  RESUME=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      grep -E '^# ' "$0" | head -45 | sed 's/^# //'
      exit 0
      ;;
    -*) echo "ERROR: unknown flag: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$1"; shift
      else
        echo "ERROR: unexpected arg: $1" >&2; exit 2
      fi
      ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "Usage: $0 <VERSION> [--resume] [--dry-run]" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "ERROR: VERSION must be X.Y.Z (got: $VERSION)" >&2; exit 2; }

cd "$(dirname "$0")/.."
ROOT="$(pwd)"   # app/

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

# ─── Cleanup trap ───────────────────────────────────────────────────────
cleanup_release() {
  local rc=$?
  rm -f /tmp/proxyfarm-notary-*.zip 2>/dev/null || true
  if (( rc == 0 )); then
    state_cleanup
  fi
  return $rc
}
trap cleanup_release EXIT

# ════════════════════════════════════════════════════════════════════════
# Step 1 — Prereqs
# ════════════════════════════════════════════════════════════════════════
bold "1/12  Checking prerequisites"

REQUIRED=(pnpm gh jq shasum xxd base64 ditto create-dmg xcrun codesign hdiutil node)
MISSING=()
for bin in "${REQUIRED[@]}"; do
  command -v "$bin" >/dev/null || MISSING+=("$bin")
done
if (( ${#MISSING[@]} > 0 )); then
  red "Missing required tools: ${MISSING[*]}"
  echo "  npm install -g create-dmg@8     # sindresorhus (NOT brew create-dmg)"
  echo "  brew install gh jq"
  exit 1
fi

CREATE_DMG_VERSION="$(create-dmg --version 2>/dev/null || echo 0)"
[[ "$CREATE_DMG_VERSION" =~ ^8\. ]] || {
  red "create-dmg version is '$CREATE_DMG_VERSION', expected 8.x.x (npm sindresorhus)."
  red "Homebrew create-dmg corrupts .app signatures inside the DMG via AppleScript."
  red "Fix: npm install -g create-dmg@8"
  exit 1
}

[[ -f "$ENTITLEMENTS" ]] || { red "Missing entitlements: $ENTITLEMENTS"; exit 1; }
[[ -f "$SINGBOX_ENTITLEMENTS" ]] || { red "Missing sing-box entitlements: $SINGBOX_ENTITLEMENTS"; exit 1; }

# Signing identity + notarize profile: hard requirement for a real release,
# but a --dry-run exists precisely to be runnable on a box that doesn't have
# the Apple account set up yet, so it only warns there.
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGN_IDENTITY"; then
  green "  Signing identity found: $SIGN_IDENTITY"
else
  if (( DRY_RUN == 1 )); then
    warn "  Signing identity NOT found in keychain: $SIGN_IDENTITY (OK for --dry-run)"
  else
    red "Signing identity not found in keychain: $SIGN_IDENTITY"
    exit 1
  fi
fi

if xcrun notarytool history --keychain-profile "$NOTARIZE_PROFILE" >/dev/null 2>&1; then
  green "  notarytool profile '$NOTARIZE_PROFILE' OK"
else
  if (( DRY_RUN == 1 )); then
    warn "  notarytool profile '$NOTARIZE_PROFILE' not set up (OK for --dry-run)"
  else
    red "notarytool profile '$NOTARIZE_PROFILE' not set up."
    red "Fix: xcrun notarytool store-credentials $NOTARIZE_PROFILE --apple-id … --team-id … --password …"
    exit 1
  fi
fi

ensure_gh_token || {
  if [[ "$DRY_RUN" -eq 0 ]] && ! gh auth status --hostname github.com >/dev/null 2>&1; then
    red "GH_TOKEN unset AND gh CLI not authenticated"
    exit 1
  fi
}

# Clean git state (untracked files allowed; tracked changes block).
if git status --porcelain | grep -vq '^??'; then
  red "Working tree has uncommitted tracked changes. Commit or stash first."
  git status --short | head
  exit 1
fi
git fetch origin --quiet 2>/dev/null || warn "git fetch origin failed (non-fatal)"
CURRENT_VERSION="$(jq -r .version package.json)"

if (( RESUME == 1 )); then
  [[ -f "$(state_path)" ]] || { red "No .release-state.json to resume from"; exit 1; }
  PREV_VERSION="$(state_get version)"
  [[ "$PREV_VERSION" == "$VERSION" ]] || {
    red "State is for v$PREV_VERSION but you asked v$VERSION"
    exit 1
  }
  green "Resuming v$VERSION (done: $(jq -r '.steps_done | join(",")' "$(state_path)"))"
else
  if (( DRY_RUN == 0 )); then
    [[ "$CURRENT_VERSION" != "$VERSION" ]] || {
      red "Already at v$VERSION. Bump to fresh version, or use --resume."
      exit 1
    }
  fi
  state_init "$VERSION"
fi

green "Prereqs OK ($CURRENT_VERSION → $VERSION; dry-run=$DRY_RUN; resume=$RESUME)"

# ════════════════════════════════════════════════════════════════════════
# Step 1b — App-translocation guard gate (spec §9)
# ════════════════════════════════════════════════════════════════════════
# "App translocation: if launched from the DMG or a translocated path,
# prompt the user to move the app to Applications (updates fail otherwise)."
# That guard is Electron main-process runtime code (src/main/), which is
# outside this release module's owned directory (app/scripts/) — another
# module owns src/main/. This step can only ever be a release GATE here:
# a grep for recognizable guard code, so a release can't ship silently
# without it once that module lands it.
#
# Soft by default (warns, doesn't fail the build) because as of this
# writing src/main/ is a bare scaffold with no such guard yet — hard-failing
# would permanently block every release until another module's unrelated
# work lands. Set PROXYFARM_REQUIRE_TRANSLOCATION_GUARD=1 to make this a
# hard gate (flip it on once the guard exists).
bold "1b/12 App-translocation guard gate"
if grep -rqiE 'translocat|AppTranslocation|isInApplicationsFolder' "$ROOT/src/main" 2>/dev/null; then
  green "  Translocation guard found in src/main"
else
  if [[ "${PROXYFARM_REQUIRE_TRANSLOCATION_GUARD:-1}" == "1" ]]; then
    red "No app-translocation guard found under src/main (spec §9). Set PROXYFARM_REQUIRE_TRANSLOCATION_GUARD=0 to downgrade to a warning."
    exit 1
  fi
  warn "  No app-translocation guard found under src/main yet (spec §9) — known gap, see release report"
fi

# ════════════════════════════════════════════════════════════════════════
# Step 2 — Bump + commit + tag + push
# ════════════════════════════════════════════════════════════════════════
if ! state_is_done "bump"; then
  bold "2/12  Version bump + commit + tag + push"
  if (( DRY_RUN == 1 )); then
    echo "  [dry-run] Would bump $CURRENT_VERSION → $VERSION + commit + tag + push"
  else
    TMPFILE="$(mktemp)"
    jq --arg v "$VERSION" '.version = $v' package.json > "$TMPFILE"
    mv "$TMPFILE" package.json
    git add package.json
    git commit -m "chore: bump version to $VERSION"
    git push origin "$(git branch --show-current)"
    git tag "v$VERSION"
    git push origin "v$VERSION"
    green "Tag v$VERSION pushed"
  fi
  state_mark_done "bump"
else
  green "2/12  Bump (skipped)"
fi

# ════════════════════════════════════════════════════════════════════════
# Steps 3–10 — make, sign, notarize, dist (scripts/lib/build-sign-notarize.sh)
# ════════════════════════════════════════════════════════════════════════
bold "3-10/12  Build + sign + notarize + dist (arm64)"
build_sign_notarize_dist arm64 "$VERSION" "$DRY_RUN"
APP="$BSN_APP"

if (( DRY_RUN == 1 )); then
  echo
  warn "[dry-run] complete — rehearsed prereqs + make + min-macOS check for arm64."
  warn "[dry-run] Skipped: codesign, notarize, ZIP/DMG, latest-mac.yml, gh release."
  exit 0
fi

ZIP_PATH="$BSN_ZIP"
DMG_PATH="$BSN_DMG"

# ════════════════════════════════════════════════════════════════════════
# Step 11 — latest-mac.yml for electron-updater
# ════════════════════════════════════════════════════════════════════════
if ! state_is_done "yml"; then
  bold "11/12 latest-mac.yml"
  ZIP_SIZE=$(stat -f%z "$ZIP_PATH")
  SHA512=$(shasum -a 512 "$ZIP_PATH" | awk '{print $1}' | xxd -r -p | base64)
  YML_DIR="$(mktemp -d)"
  YML_PATH="$YML_DIR/latest-mac.yml"
  cat > "$YML_PATH" <<EOF
version: $VERSION
files:
  - url: $(basename "$ZIP_PATH")
    sha512: $SHA512
    size: $ZIP_SIZE
path: $(basename "$ZIP_PATH")
sha512: $SHA512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
EOF
  state_set "yml_path" "$YML_PATH"
  state_mark_done "yml"
else
  YML_PATH="$(state_get yml_path)"
  green "11/12 latest-mac.yml (skipped — $YML_PATH)"
fi

# ════════════════════════════════════════════════════════════════════════
# Step 12 — gh release create + upload (ZIP + DMG + yml + GPL source tarball)
# ════════════════════════════════════════════════════════════════════════
SRC_FILE_NAME="$(jq -r '.sourceTarball.fileName' "$ROOT/scripts/singbox.pins.json")"
SRC_TARBALL="$ROOT/resources/sing-box-src/$SRC_FILE_NAME"
[[ -f "$SRC_TARBALL" ]] || {
  red "sing-box source tarball missing: $SRC_TARBALL"
  red "Run: node scripts/prebuild-singbox.mjs   (fetches it alongside the binaries)"
  exit 1
}

if ! state_is_done "gh_release"; then
  bold "12/12 gh release create + upload"
  GIT_LOG=$(git log --pretty='- %s' "v${CURRENT_VERSION}..v${VERSION}" 2>/dev/null \
            || git log --pretty='- %s' -10)
  NOTES="Proxy Farm desktop release v${VERSION}

## Changes since v${CURRENT_VERSION}

${GIT_LOG}

---
Bundles sing-box ${SRC_FILE_NAME%-src.tar.gz} (SagerNet/sing-box, GPLv3). Its
complete corresponding source is attached to this release as required by
GPLv3 §6: $SRC_FILE_NAME."
  # One release per version carries every platform: the Windows script
  # (local-release.ps1) may already have created it, so add to it instead.
  if gh release view "v$VERSION" --repo "$GH_REPO" >/dev/null 2>&1; then
    gh release upload "v$VERSION" \
      --repo "$GH_REPO" \
      --clobber "$ZIP_PATH" "$DMG_PATH" "$SRC_TARBALL" "$YML_PATH"
  else
    gh release create "v$VERSION" \
      --repo "$GH_REPO" \
      --title "v$VERSION" \
      --notes "$NOTES" \
      "$ZIP_PATH" "$DMG_PATH" "$SRC_TARBALL"
    gh release upload "v$VERSION" \
      --repo "$GH_REPO" \
      --clobber "$YML_PATH"
  fi
  state_mark_done "gh_release"
else
  green "12/12 gh release (skipped)"
fi

# Both platforms update from /releases/latest/download, i.e. from the newest
# release only: while it lacks latest.yml, Windows clients see no update at all.
if ! gh release view "v$VERSION" --repo "$GH_REPO" --json assets -q '.assets[].name' 2>/dev/null | grep -qx 'latest.yml'; then
  warn "v$VERSION has no latest.yml yet: Windows clients see no update until"
  warn "scripts/local-release.ps1 runs for v$VERSION (it adds its assets to this release)."
fi

echo
green "Release v$VERSION complete"
echo "    https://github.com/$GH_REPO/releases/tag/v$VERSION"
echo "    ZIP: $(du -h "$ZIP_PATH" 2>/dev/null | cut -f1 || echo '?')"
echo "    DMG: $(du -h "$DMG_PATH" 2>/dev/null | cut -f1 || echo '?')"
