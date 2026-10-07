#!/usr/bin/env bash
# Shared per-architecture macOS pipeline: make → min-macOS check → sign →
# notarize .app → staple+spctl → smoke-launch → ZIP+DMG → notarize DMG →
# staple+verify DMG.
#
# Both scripts/local-release.sh (arm64, the main release) and
# scripts/release-with-x64.sh (x64, the dual-arch wrapper) source this and
# call build_sign_notarize_dist for their architecture, instead of each
# carrying its own copy (lingoreup's local-release.sh / build-x64-local.sh
# pair drifted into two copies of this exact sequence; factoring it once
# here is the fix for that class of bug, not a feature of this product).
#
# Requires, set by the caller before sourcing/calling:
#   ROOT               repo app/ root (absolute)
#   SIGN_IDENTITY       "Developer ID Application: …"
#   NOTARIZE_PROFILE    notarytool keychain profile name
#   ENTITLEMENTS        path to entitlements.plist
#   PRODUCT_SLUG        filename-safe product name, e.g. "ProxyFarm"
# and sources scripts/lib/state-helpers.sh itself (state_*, notarize_resilient,
# bold/green/red/warn) and calls scripts/sign-proxyfarm-bundle.sh +
# scripts/smoke-launch (a function, not a file — see below).
#
# DO NOT execute this file directly. `source` it.

# smoke_launch_app <app-path>
#
# Boots the signed .app under LaunchServices and verifies the main process
# AND the Renderer Helper both survive a short stable window. Ported and
# trimmed from lingoreup's scripts/smoke-launch-app.sh: no Python sidecar
# import check (Proxy Farm has none), no crash-report sweep comment essay —
# same spawn/detect/verify shape, inlined here as one function rather than a
# separate file since nothing else calls it.
smoke_launch_app() {
  local APP="$1"
  [[ -d "$APP/Contents" ]] || { red "smoke: not an .app bundle: $APP"; return 1; }

  local STARTUP_TIMEOUT="${PF_SMOKE_STARTUP_TIMEOUT:-15}"
  local STABLE_SECONDS="${PF_SMOKE_STABLE_SECONDS:-5}"

  local PLIST="$APP/Contents/Info.plist"
  local BUNDLE_ID EXE_NAME EXE_PATH
  BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")"
  EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")"
  EXE_PATH="$APP/Contents/MacOS/$EXE_NAME"
  [[ -x "$EXE_PATH" ]] || { red "smoke: executable not found: $EXE_PATH"; return 1; }

  # Single-instance lock means a second launch while a dev/installed copy of
  # the SAME bundle id is already running just quits immediately — that would
  # read as "crashed on launch" here. Skip rather than false-fail.
  if pgrep -f "node_modules/electron/dist/Electron.app" >/dev/null 2>&1; then
    warn "smoke: dev Electron is running — skipping (would conflict on bundle id: $BUNDLE_ID)"
    return 0
  fi
  if pgrep -f "/Applications/${EXE_NAME}.app/Contents/MacOS/${EXE_NAME}" >/dev/null 2>&1; then
    warn "smoke: an installed ${EXE_NAME}.app is running — skipping (would conflict on bundle id)"
    return 0
  fi

  local PRE_PIDS NEW_PID=""
  PRE_PIDS="$(pgrep -f "$EXE_PATH" 2>/dev/null || true)"

  # shellcheck disable=SC2329 # invoked indirectly via `trap ... RETURN` below
  _smoke_cleanup() {
    if [[ -n "$NEW_PID" ]] && kill -0 "$NEW_PID" 2>/dev/null; then
      kill "$NEW_PID" 2>/dev/null || true
      for child in $(pgrep -P "$NEW_PID" 2>/dev/null || true); do
        kill "$child" 2>/dev/null || true
      done
    fi
  }
  trap _smoke_cleanup RETURN

  echo "▶ Launching $(basename "$APP")  (bundle: $BUNDLE_ID)"
  /usr/bin/open -n -g "$APP" --args -ApplePersistenceIgnoreState YES

  local deadline=$((SECONDS + STARTUP_TIMEOUT))
  while (( SECONDS < deadline )); do
    for pid in $(pgrep -f "$EXE_PATH" 2>/dev/null || true); do
      if ! printf '%s\n' "$PRE_PIDS" | grep -Fxq "$pid"; then
        NEW_PID="$pid"
        break 2
      fi
    done
    sleep 0.5
  done
  if [[ -z "$NEW_PID" ]]; then
    red "smoke: app did not register a new process within ${STARTUP_TIMEOUT}s (Gatekeeper kill? bad bundle structure?)"
    return 1
  fi
  echo "  → PID $NEW_PID spawned, watching for ${STABLE_SECONDS}s…"

  local i
  for (( i = 0; i < STABLE_SECONDS; i++ )); do
    sleep 1
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
      red "smoke: main process died ${i}s into the stable window"
      return 1
    fi
  done

  local RENDERER_PID
  RENDERER_PID="$(pgrep -f "${EXE_NAME} Helper.*--type=renderer" 2>/dev/null | head -1 || true)"
  if [[ -z "$RENDERER_PID" ]]; then
    red "smoke: Renderer Helper never spawned (or already exited) — UI would be a white screen"
    return 1
  fi
  sleep "$STABLE_SECONDS"
  if ! kill -0 "$RENDERER_PID" 2>/dev/null; then
    red "smoke: Renderer Helper died after ${STABLE_SECONDS}s (missing allow-jit entitlement? sign mismatch?)"
    return 1
  fi

  green "  $EXE_NAME + Renderer Helper alive ($(( STABLE_SECONDS * 2 ))s) — smoke test passed"
}

# verify_min_macos <app-path>
#
# Proxy Farm has no Python payload to inspect (lingoreup's verify-min-macos.sh
# checked a wheel's platform tag against the promise) — sing-box's own floor
# is Go 1.26's, which the spec pins at macOS 12 (§9, §12). All this does is
# confirm the packaged Info.plist actually promises LSMinimumSystemVersion
# 12.0 or higher, so a forge.config.ts regression (or one that never set it)
# is caught before notarizing rather than discovered by a user on macOS 12.
verify_min_macos() {
  local APP="$1"
  local PLIST="$APP/Contents/Info.plist"
  local promised
  promised="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST" 2>/dev/null || echo "")"
  if [[ -z "$promised" ]]; then
    red "Info.plist has no LSMinimumSystemVersion — forge.config.ts packagerConfig needs one (spec §9: macOS 12 floor)"
    return 1
  fi
  # Version compare via sort -V; promised must be >= 12.0.
  if [[ "$(printf '%s\n%s\n' "12.0" "$promised" | sort -V | head -1)" != "12.0" ]]; then
    red "LSMinimumSystemVersion is $promised, below the spec's macOS 12 floor"
    return 1
  fi
  green "  LSMinimumSystemVersion = $promised (>= 12.0 OK)"
}

# build_sign_notarize_dist <arch: arm64|x64> <version> <dry_run: 0|1>
#
# On success sets (global) BSN_APP, BSN_ZIP, BSN_DMG to the final artifact
# paths. State keys are suffixed "_x64" for the x64 leg so arm64 and x64
# state never collide in the same state file.
build_sign_notarize_dist() {
  local ARCH="$1" VERSION="$2" DRY_RUN="$3"
  local SUFFIX=""; [[ "$ARCH" == "x64" ]] && SUFFIX="_x64"

  # ── make ──
  if ! state_is_done "make${SUFFIX}"; then
    bold "make ($ARCH)  — pnpm run make"
    rm -rf "$ROOT/out"
    ( cd "$ROOT" && pnpm run make -- --platform darwin --arch "$ARCH" )
    local app
    app="$(find "$ROOT/out" -name "*.app" -not -path "*/make/*" | head -1)"
    [[ -d "$app" ]] || { red "make ($ARCH) finished but no .app found"; return 1; }
    app="$(cd "$(dirname "$app")" && pwd)/$(basename "$app")"
    state_set "app_path${SUFFIX}" "$app"
    state_mark_done "make${SUFFIX}"
  else
    green "make ($ARCH) — skipped"
  fi
  BSN_APP="$(state_get "app_path${SUFFIX}")"

  bold "verify-min-macos ($ARCH)"
  verify_min_macos "$BSN_APP" || return 1

  if (( DRY_RUN == 1 )); then
    warn "[dry-run] stopping before codesign/notarize/dist for $ARCH (needs Apple identity + gh credentials)"
    return 0
  fi

  # ── sign ──
  if ! state_is_done "sign${SUFFIX}"; then
    bold "codesign ($ARCH) — inside-out, hardened runtime, RFC3161 timestamp"
    bash "$ROOT/scripts/sign-proxyfarm-bundle.sh" "$BSN_APP" "$ENTITLEMENTS" "$SIGN_IDENTITY"
    state_mark_done "sign${SUFFIX}"
  else
    green "codesign ($ARCH) — skipped"
  fi

  # ── notarize .app ──
  if ! state_is_done "notarize_app${SUFFIX}"; then
    bold "notarize .app ($ARCH) — ditto transport zip → notarytool poll"
    local transport_zip="/tmp/proxyfarm-notary-${ARCH}-${VERSION}.zip"
    rm -f "$transport_zip"
    ditto -c -k --sequesterRsrc --keepParent "$BSN_APP" "$transport_zip"
    echo "  Transport ZIP: $(du -h "$transport_zip" | cut -f1)"
    notarize_resilient "$transport_zip" "notarize_app_id${SUFFIX}" "$NOTARIZE_PROFILE" || {
      red "App notarization failed ($ARCH). Re-run with --resume."
      return 1
    }
    rm -f "$transport_zip"
    state_mark_done "notarize_app${SUFFIX}"
  else
    green "notarize .app ($ARCH) — skipped"
  fi

  # ── staple + verify .app ──
  if ! state_is_done "staple_app${SUFFIX}"; then
    bold "staple .app ($ARCH)"
    xcrun stapler staple "$BSN_APP"
    xcrun stapler validate "$BSN_APP"
    spctl -a -vv --type execute "$BSN_APP"
    state_mark_done "staple_app${SUFFIX}"
  else
    green "staple .app ($ARCH) — skipped"
  fi

  # ── smoke ──
  if ! state_is_done "smoke${SUFFIX}"; then
    bold "smoke-launch ($ARCH)"
    smoke_launch_app "$BSN_APP" || return 1
    state_mark_done "smoke${SUFFIX}"
  else
    green "smoke ($ARCH) — skipped"
  fi

  # ── dist: ZIP + DMG ──
  local zip_dir="$ROOT/out/make/zip/darwin/$ARCH"
  local zip_path="$zip_dir/${PRODUCT_SLUG}-darwin-${ARCH}-${VERSION}.zip"
  local dmg_dir="$ROOT/out/make/dmg/darwin/$ARCH"
  local dmg_path="$dmg_dir/${PRODUCT_SLUG}-darwin-${ARCH}-${VERSION}.dmg"
  if ! state_is_done "dist${SUFFIX}"; then
    bold "dist ($ARCH) — ZIP + DMG"
    mkdir -p "$zip_dir" "$dmg_dir"

    rm -f "$zip_path"
    ditto -c -k --keepParent "$BSN_APP" "$zip_path"
    echo "  ZIP: $(basename "$zip_path") ($(du -h "$zip_path" | cut -f1))"

    rm -f "$dmg_path"
    ( cd "$dmg_dir" && create-dmg "$BSN_APP" . )
    # create-dmg names its output "<AppName> <version>.dmg" — glob rather
    # than hardcode the product name's exact casing/spacing.
    mv "$dmg_dir"/*.dmg "$dmg_path"
    echo "  DMG: $(basename "$dmg_path") ($(du -h "$dmg_path" | cut -f1))"

    state_set "zip_path${SUFFIX}" "$zip_path"
    state_set "dmg_path${SUFFIX}" "$dmg_path"
    state_mark_done "dist${SUFFIX}"
  else
    zip_path="$(state_get "zip_path${SUFFIX}")"
    dmg_path="$(state_get "dmg_path${SUFFIX}")"
    green "dist ($ARCH) — skipped"
  fi

  # ── notarize DMG ──
  if ! state_is_done "notarize_dmg${SUFFIX}"; then
    bold "notarize DMG ($ARCH) — separate submission"
    notarize_resilient "$dmg_path" "notarize_dmg_id${SUFFIX}" "$NOTARIZE_PROFILE" || {
      red "DMG notarization failed ($ARCH). Re-run with --resume."
      return 1
    }
    state_mark_done "notarize_dmg${SUFFIX}"
  else
    green "notarize DMG ($ARCH) — skipped"
  fi

  # ── staple DMG ──
  if ! state_is_done "staple_dmg${SUFFIX}"; then
    bold "staple DMG ($ARCH)"
    xcrun stapler staple "$dmg_path"
    xcrun stapler validate "$dmg_path"
    state_mark_done "staple_dmg${SUFFIX}"
  else
    green "staple DMG ($ARCH) — skipped"
  fi

  # ── final verify (ZIP via ditto extract, DMG mounted) ──
  if ! state_is_done "verify${SUFFIX}"; then
    bold "final verify ($ARCH) — ZIP (ditto extract) + DMG (mounted)"
    local zip_tmp dmg_mnt
    zip_tmp="$(mktemp -d -t proxyfarm-verify-zip)"
    ditto -x -k "$zip_path" "$zip_tmp"
    local extracted_app
    extracted_app="$(find "$zip_tmp" -name "*.app" -maxdepth 1 | head -1)"
    spctl -a -vv --type execute "$extracted_app"
    rm -rf "$zip_tmp"

    dmg_mnt="$(mktemp -d -t proxyfarm-verify-mnt)"
    hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$dmg_mnt" >/dev/null
    local mounted_app
    mounted_app="$(find "$dmg_mnt" -name "*.app" -maxdepth 1 | head -1)"
    spctl -a -vv --type execute "$mounted_app"
    hdiutil detach "$dmg_mnt" -quiet || true
    rmdir "$dmg_mnt" 2>/dev/null || true
    state_mark_done "verify${SUFFIX}"
  else
    green "final verify ($ARCH) — skipped"
  fi

  # shellcheck disable=SC2034 # consumed by the caller (local-release.sh / release-with-x64.sh) after this function returns
  BSN_ZIP="$zip_path"
  # shellcheck disable=SC2034
  BSN_DMG="$dmg_path"
}
