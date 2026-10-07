#!/usr/bin/env bash
# Inside-out codesign a Proxy Farm .app for Developer ID + notarization.
#
# Ported from lingoreup's scripts/sign-lingoreup-bundle.sh. Same generic
# Mach-O scan (ask `file`/magic-number, not file-extension or directory
# rules) — that choice is what makes it automatically pick up every
# bundled sing-box binary under Contents/Resources/sing-box/<arch>/
# without this script needing to know where forge.config.ts's
# extraResource puts them.
#
# Usage:
#   scripts/sign-proxyfarm-bundle.sh <app-path> <entitlements> <identity> <singbox-entitlements>
#
# Two entitlements files, not one: <entitlements> (allow-jit,
# allow-unsigned-executable-memory, network.client) goes on Proxy Farm's own
# executable and its Electron helper .apps — all of which run V8 and need
# JIT. <singbox-entitlements> is deliberately narrower (hardened-runtime
# defaults + network.client only, no JIT/unsigned-exec-memory) and goes ONLY
# on the bundled sing-box binary, since it's Go, never JITs, and has no
# reason to carry entitlements an Electron process needs.
#
# Inside-out order (Apple-required):
#   1. Sign every Mach-O object file in the bundle (leaf nodes first).
#   2. Sign each framework (--deep is a cheap re-verify here, not load-bearing).
#   3. Sign each helper .app bundle.
#   4. Sign root .app WITHOUT --deep (a --deep on root would overwrite the
#      sealed helper/framework signatures and reintroduce mismatches that
#      macOS rejects with errno 163).
#   5. Verify via codesign --verify --deep --strict.
#   6. Sweep for anything --deep missed.
#
# All sign calls use --options runtime + --timestamp (Apple requires
# hardened runtime + RFC 3161 secure timestamp for notarization).

set -euo pipefail

[[ $# -eq 4 ]] || {
  echo "usage: $0 <app-path> <entitlements> <identity> <singbox-entitlements>" >&2
  exit 2
}
APP="$1"
ENT="$2"
IDENTITY="$3"
SINGBOX_ENT="$4"

[[ -d "$APP" ]] || { echo "error: app not found: $APP" >&2; exit 1; }
[[ -f "$ENT" ]] || { echo "error: entitlements not found: $ENT" >&2; exit 1; }
[[ -f "$SINGBOX_ENT" ]] || { echo "error: sing-box entitlements not found: $SINGBOX_ENT" >&2; exit 1; }

COMMON=(--force --options runtime --timestamp --sign "$IDENTITY")

# is_macho <path>  — true if first 4 bytes look like a Mach-O magic.
# Magic numbers:
#   cffaedfe  Mach-O 64-bit LE
#   feedfacf  Mach-O 64-bit BE
#   cefaedfe  Mach-O 32-bit LE
#   feedface  Mach-O 32-bit BE
#   cafebabe  fat / universal binary (multi-arch)
#   bebafeca  fat (byte-swapped)
is_macho() {
  local magic
  magic="$(head -c 4 "$1" 2>/dev/null | xxd -p)" || return 1
  case "$magic" in
    cffaedfe|feedfacf|cefaedfe|feedface|cafebabe|bebafeca) return 0 ;;
    *) return 1 ;;
  esac
}

# codesign_retry — codesign with bounded retries.
#
# Every sign uses --timestamp, a network round-trip to
# timestamp.apple.com. That server intermittently rate-limits one
# arbitrary file out of hundreds. Retry with escalating backoff before
# giving up (lingoreup pattern — ~1 min of retries total).
codesign_retry() {
  local attempt
  local backoff=(0 3 5 8 10 12 15 15)
  for attempt in 0 1 2 3 4 5 6 7; do
    (( attempt > 0 )) && sleep "${backoff[$attempt]}"
    if /usr/bin/codesign "$@" >/dev/null 2>&1; then
      return 0
    fi
  done
  # Final attempt with stderr visible so a real (non-transient) failure is
  # diagnosable instead of silently swallowed.
  /usr/bin/codesign "$@" && return 0
  return 1
}

# ─── 1. Sign every Mach-O object file in the bundle ────────────────────
# Depth-first (deepest paths first) so child binaries are signed before
# any container above them gets sealed.
#
# Entitlements decision per Mach-O:
#
#   (a) INNER dylibs loaded into Proxy Farm (Electron Framework, V8,
#       .dylib/.so under Frameworks/): NO --entitlements. They run in the
#       launching process and inherit ITS entitlements.
#
#   (b) CHILD-process LAUNCH binaries Electron spawns via
#       child_process.spawn(): MUST get --entitlements. They are the
#       execve target of their OWN process, so hardened runtime checks
#       THEIR OWN entitlements blob, not Proxy Farm's. The only such
#       binary here is the bundled sing-box (engine §6, spec §9) —
#       wherever forge.config.ts's extraResource lands it under
#       Contents/Resources. Matched by basename, not path, since the
#       exact Resources subpath is the packaging config's call, not
#       this script's.
echo "▶ Scanning bundle for Mach-O object files…"
mach_count=0
ent_count=0
sign_failed=0
# Deepest paths FIRST — children must be signed before any bundle MAIN
# EXECUTABLE above them. Depth is `NF` from splitting each path on "/"; the
# exact number doesn't matter, only that it sorts consistently (every path
# shares the $APP prefix). This used to shell out to /usr/bin/python3 for
# the same sort (NUL-safe, since sed/awk/grep can't carry an embedded NUL
# byte in a C string) — switched to newline-delimited `find` + awk/sort
# instead, on the documented assumption that no file in an Electron/Vite/
# node_modules build output ever has a literal newline in its name (unlike
# spaces, which ARE common — "Proxy Farm Helper (Renderer).app" — and are
# handled fine by `IFS= read -r`, since the whole line, not word-split, is
# the path). This drops python3 as a prerequisite entirely.
while IFS= read -r f; do
  [[ -L "$f" ]] && continue
  if is_macho "$f"; then
    case "$(basename "$f")" in
      sing-box|sing-box.exe)
        codesign_retry "${COMMON[@]}" --entitlements "$SINGBOX_ENT" "$f" || {
          echo "  WARN: ent sign failed: $f" >&2
          sign_failed=$((sign_failed + 1))
        }
        ent_count=$((ent_count + 1))
        ;;
      *)
        codesign_retry "${COMMON[@]}" "$f" || {
          echo "  WARN: sign failed: $f" >&2
          sign_failed=$((sign_failed + 1))
        }
        ;;
    esac
    mach_count=$((mach_count + 1))
  fi
done < <(find "$APP" -type f -print | awk -F'/' '{ printf "%d\t%s\n", NF, $0 }' | sort -t $'\t' -k1,1rn | cut -f2-)
echo "  Signed $mach_count Mach-O object files ($ent_count with entitlements, $sign_failed failures)"
(( sign_failed == 0 )) || { echo "error: $sign_failed Mach-O signs failed" >&2; exit 1; }
# Hard gate (spec §9/§6): a packaged app with zero sing-box binaries is a
# build that cannot run any VPN endpoint. forge.config.ts's packageAfterCopy
# hook is supposed to guarantee one is bundled per-arch (and itself hard-
# fails if the pinned binary is missing from app/resources/) — this is the
# second, independent check, in case this script is ever invoked against a
# bundle produced some other way (e.g. a manual `electron-packager` run).
if (( ent_count == 0 )); then
  echo "error: no sing-box binary found to sign with --entitlements." >&2
  echo "       Expected under $APP/Contents/Resources/sing-box/<platform>/." >&2
  echo "       forge.config.ts's packageAfterCopy hook should have bundled one —" >&2
  echo "       packaging is broken, or this .app was built without it." >&2
  exit 1
fi

# ─── 2. Sign nested frameworks ─────────────────────────────────────────
echo "▶ Signing nested frameworks"
if [[ -d "$APP/Contents/Frameworks" ]]; then
  find "$APP/Contents/Frameworks" -mindepth 1 -maxdepth 1 -type d -name "*.framework" \
    -exec /usr/bin/codesign "${COMMON[@]}" {} \; \
    >/dev/null
fi

# ─── 3. Sign nested helper .app bundles WITH --entitlements ────────────
# v8 in the Renderer Helper unconditionally uses MAP_JIT on arm64 and
# CHECK-fails without allow-jit.
echo "▶ Signing nested helper .app bundles (with entitlements)"
if [[ -d "$APP/Contents/Frameworks" ]]; then
  find "$APP/Contents/Frameworks" -mindepth 1 -maxdepth 1 -type d -name "*.app" \
    -exec /usr/bin/codesign "${COMMON[@]}" --entitlements "$ENT" {} \; \
    >/dev/null 2>&1 || true
fi

# ─── 4. Sign root .app WITH --entitlements (no --deep) ─────────────────
echo "▶ Signing root .app (with entitlements, no --deep)"
/usr/bin/codesign "${COMMON[@]}" --entitlements "$ENT" "$APP"

# ─── 5. Verify deep signature ──────────────────────────────────────────
echo "▶ Verifying deep signature"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"

# ─── 6. Sweep: ensure NO Mach-O is left unsigned ───────────────────────
echo "▶ Sweep for any remaining unsigned Mach-O"
unsigned=0
while IFS= read -r -d '' f; do
  [[ -L "$f" ]] && continue
  if is_macho "$f"; then
    if codesign -dv "$f" 2>&1 | grep -q "not signed"; then
      echo "  UNSIGNED: $f" >&2
      unsigned=$((unsigned + 1))
    fi
  fi
done < <(find "$APP" -depth -type f -print0)
if (( unsigned > 0 )); then
  echo "error: $unsigned Mach-O files still unsigned" >&2
  exit 1
fi
echo "  All Mach-O files signed"

echo "✔ Signed: $APP"
