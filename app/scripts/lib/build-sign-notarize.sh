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
#   ROOT                 repo app/ root (absolute)
#   SIGN_IDENTITY         "Developer ID Application: …"
#   NOTARIZE_PROFILE      notarytool keychain profile name
#   ENTITLEMENTS          path to entitlements.plist (Proxy Farm + Electron helpers)
#   SINGBOX_ENTITLEMENTS  path to entitlements.singbox.plist (sing-box binary only)
#   PRODUCT_SLUG          filename-safe product name, e.g. "ProxyFarm"
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

# verify_singbox_bundled <app-path> <arch: arm64|x64>
#
# Hard gate (spec §9/§6, §2): confirms the packaged app actually contains
# the sing-box binary for THIS build's architecture, at the exact sha256
# pinned in scripts/singbox.pins.json — and that it's the RIGHT arch (an
# x64 Mac build must get the amd64 binary, never arm64, since Rosetta-under-
# notarized-hardened-runtime is not a thing worth relying on here).
#
# Runs BEFORE signing, not after: codesign rewrites the binary's bytes (it
# embeds a signature), so this is the last point at which the bundled file
# is still byte-identical to what prebuild-singbox.mjs fetched and verified.
# forge.config.ts's packageAfterCopy hook performs the actual per-arch copy
# and already hard-fails if the source is missing — this re-verifies the
# RESULT independently, so a stale/tampered Resources/ tree (e.g. a leftover
# arm64 binary under a darwin-amd64 directory from a bad manual copy) is
# still caught here rather than shipped.
verify_singbox_bundled() {
  local APP="$1" ARCH="$2"
  local platform_key
  case "$ARCH" in
    arm64) platform_key="darwin-arm64" ;;
    x64)   platform_key="darwin-amd64" ;;
    *) red "verify_singbox_bundled: unknown arch '$ARCH'"; return 1 ;;
  esac

  local pins_path="$ROOT/scripts/singbox.pins.json"
  local binary_name expected_sha
  binary_name="$(jq -r --arg k "$platform_key" '.assets[$k].binaryName' "$pins_path")"
  expected_sha="$(jq -r --arg k "$platform_key" '.assets[$k].binarySha256' "$pins_path")"
  if [[ -z "$binary_name" || "$binary_name" == "null" || -z "$expected_sha" || "$expected_sha" == "null" ]]; then
    red "No sing-box pin for platform \"$platform_key\" in $pins_path"
    return 1
  fi

  local bundled="$APP/Contents/Resources/sing-box/$platform_key/$binary_name"
  if [[ ! -f "$bundled" ]]; then
    red "No sing-box binary bundled at $bundled"
    red "forge.config.ts's packageAfterCopy hook should have put it there during 'make' — packaging is broken."
    return 1
  fi

  local actual_sha
  actual_sha="$(shasum -a 256 "$bundled" | awk '{print $1}')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    red "Bundled sing-box sha256 mismatch for $platform_key:"
    red "  expected: $expected_sha"
    red "  actual:   $actual_sha"
    red "  at:       $bundled"
    return 1
  fi
  green "  sing-box ($platform_key) bundled + sha256 verified: $bundled"
}

# _verify_zip_spctl <zip-path>
#
# Extracts via `ditto -x -k` (matches Squirrel.Mac/electron-updater's own
# extract — plain `unzip` strips resource forks and gives false "sealed
# resource missing" errors on a perfectly valid ZIP) into a scratch dir and
# spctl-verifies the .app inside. `trap … RETURN` guarantees the scratch dir
# is removed even if spctl rejects it (under `set -e`, a failing command
# inside this function still "returns" from it — triggering the RETURN
# trap — before the failure propagates to the caller; same pattern as
# smoke_launch_app's _smoke_cleanup above).
_verify_zip_spctl() {
  local zip_path="$1"
  local zip_tmp
  zip_tmp="$(mktemp -d -t proxyfarm-verify-zip)"
  # shellcheck disable=SC2329 # invoked indirectly via `trap ... RETURN` below
  _zip_tmp_cleanup() { rm -rf "$zip_tmp"; }
  trap _zip_tmp_cleanup RETURN

  ditto -x -k "$zip_path" "$zip_tmp"
  local extracted_app
  extracted_app="$(find "$zip_tmp" -name "*.app" -maxdepth 1 | head -1)"
  spctl -a -vv --type execute "$extracted_app"
}

# _verify_dmg_spctl <dmg-path>
#
# Mounts read-only, spctl-verifies the .app inside, then ALWAYS detaches
# and removes the mountpoint — even if spctl rejects it — via the same
# `trap … RETURN` pattern as _verify_zip_spctl. Before this fix, a failing
# `spctl` here would abort the function under `set -e` and skip straight
# past `hdiutil detach`, leaking a mounted DMG that would make every
# subsequent run's `hdiutil attach` to the same path fail ("already
# attached") or leave an orphaned Finder-visible volume.
_verify_dmg_spctl() {
  local dmg_path="$1"
  local dmg_mnt
  dmg_mnt="$(mktemp -d -t proxyfarm-verify-mnt)"
  # shellcheck disable=SC2329 # invoked indirectly via `trap ... RETURN` below
  _dmg_mnt_cleanup() {
    if hdiutil info 2>/dev/null | grep -qF "$dmg_mnt"; then
      hdiutil detach "$dmg_mnt" -quiet || true
    fi
    rmdir "$dmg_mnt" 2>/dev/null || true
  }
  trap _dmg_mnt_cleanup RETURN

  hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$dmg_mnt" >/dev/null
  local mounted_app
  mounted_app="$(find "$dmg_mnt" -name "*.app" -maxdepth 1 | head -1)"
  spctl -a -vv --type execute "$mounted_app"
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
    # NOTE: no literal `--` before the flags. Unlike npm, pnpm does not
    # strip a `--` separator from `pnpm run <script> -- <args>` — it passes
    # it straight through as a literal argument to the underlying command,
    # which silently breaks electron-forge's (Commander-based) flag parsing
    # and makes it fall back to the HOST architecture. Confirmed by testing:
    # `pnpm run package -- --arch x64 --platform darwin` built arm64 (wrong,
    # silently); `pnpm run package --arch x64 --platform darwin` (no `--`)
    # built x64 (right). This is exactly the bug that would have made the
    # x64 leg of release-with-x64.sh silently re-sign and upload an arm64
    # binary labeled x64.
    ( cd "$ROOT" && pnpm run make --platform darwin --arch "$ARCH" )
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

  bold "verify-singbox-bundled ($ARCH)"
  verify_singbox_bundled "$BSN_APP" "$ARCH" || return 1

  if (( DRY_RUN == 1 )); then
    warn "[dry-run] stopping before codesign/notarize/dist for $ARCH (needs Apple identity + gh credentials)"
    return 0
  fi

  # ── sign ──
  if ! state_is_done "sign${SUFFIX}"; then
    bold "codesign ($ARCH) — inside-out, hardened runtime, RFC3161 timestamp"
    bash "$ROOT/scripts/sign-proxyfarm-bundle.sh" "$BSN_APP" "$ENTITLEMENTS" "$SIGN_IDENTITY" "$SINGBOX_ENTITLEMENTS"
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
    # create-dmg names its output "<app bundle name> <version>.dmg". Glob
    # prefixed by the app bundle's own basename (lingoreup pattern: it
    # globbed "LingoReup*.dmg", not bare "*.dmg") rather than a bare
    # "*.dmg" — dmg_dir is normally freshly mkdir'd and empty, but a bare
    # glob would silently (mis)match any stray .dmg left behind by a prior
    # failed/partial run in the same dir, either clobbering the wrong file
    # into $dmg_path or grabbing it instead of the one just built.
    local app_base
    app_base="$(basename "$BSN_APP" .app)"
    mv "$dmg_dir/$app_base"*.dmg "$dmg_path"
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
    _verify_zip_spctl "$zip_path"
    _verify_dmg_spctl "$dmg_path"
    state_mark_done "verify${SUFFIX}"
  else
    green "final verify ($ARCH) — skipped"
  fi

  # shellcheck disable=SC2034 # consumed by the caller (local-release.sh / release-with-x64.sh) after this function returns
  BSN_ZIP="$zip_path"
  # shellcheck disable=SC2034
  BSN_DMG="$dmg_path"
}
