#!/usr/bin/env bash
# Minimal release helper library — ported from lingoreup's
# scripts/lib/state-helpers.sh, trimmed of nothing (it was already
# product-agnostic: no Python/venv/cythonize references lived here).
#
#   1. JSON .release-state*.json for --resume across script invocations
#   2. ensure_gh_token: derive a gh token for the release repo's owner
#   3. notarize_resilient: polling loop that survives transient network drops
#   4. Colored log helpers
#
# DO NOT execute this file directly. `source` it from a release script.
# Callers set ROOT and STATE_FILE (defaults to "$ROOT/.release-state.json")
# before sourcing, or just before calling state_* the first time.

# ─── Colored output ─────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  bold()  { printf '\033[1m▶ %s\033[0m\n' "$*"; }
  green() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
  red()   { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; }
  warn()  { printf '\033[33m⚠ %s\033[0m\n' "$*" >&2; }
else
  bold()  { printf '▶ %s\n' "$*"; }
  green() { printf '✔ %s\n' "$*"; }
  red()   { printf '✘ %s\n' "$*" >&2; }
  warn()  { printf '⚠ %s\n' "$*" >&2; }
fi

# ─── State file (resume support) ────────────────────────────────────────
# A small JSON document tracking which steps completed and the IDs of
# in-flight notarytool submissions. Lets --resume skip ahead instead of
# re-running expensive steps (codesign, notarize) after a transient failure.
#
# STATE_FILE_NAME lets two scripts in the same ROOT (local-release.sh and
# release-with-x64.sh) keep independent state files when needed.

state_path() {
  printf '%s/%s' "${ROOT:-$(pwd)}" "${STATE_FILE_NAME:-.release-state.json}"
}

state_init() {
  jq -n \
    --arg v "$1" \
    --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{ version:$v, started_at:$t, steps_done:[],
       notarize_app_id:null, notarize_dmg_id:null,
       notarize_app_id_x64:null, notarize_dmg_id_x64:null,
       app_path:null, app_path_x64:null,
       zip_path:null, dmg_path:null, zip_path_x64:null, dmg_path_x64:null,
       yml_path:null }' \
    > "$(state_path)"
}

state_get() {
  local path; path="$(state_path)"
  [[ -f "$path" ]] || { echo ""; return; }
  jq -r --arg k "$1" '.[$k] // empty' "$path"
}

state_set() {
  local tmp; tmp="$(mktemp)"
  jq --arg k "$1" --arg v "$2" '.[$k] = $v' "$(state_path)" > "$tmp"
  mv "$tmp" "$(state_path)"
}

state_mark_done() {
  local tmp; tmp="$(mktemp)"
  jq --arg s "$1" '.steps_done += [$s] | .steps_done |= unique' \
    "$(state_path)" > "$tmp"
  mv "$tmp" "$(state_path)"
}

state_is_done() {
  local path; path="$(state_path)"
  [[ -f "$path" ]] || return 1
  jq -e --arg s "$1" '.steps_done | contains([$s])' "$path" >/dev/null
}

state_cleanup() { rm -f "$(state_path)"; }

# ─── GH token auto-derive ──────────────────────────────────────────────
# The release repo (huuhoa143/proxy-farm) is owned by huuhoa143 while the
# shell env sometimes carries a GITHUB_TOKEN for a different account.
# Pull the correct token from the gh CLI keyring.

ensure_gh_token() {
  if [[ -n "${GH_TOKEN:-}" ]]; then
    unset GITHUB_TOKEN
    return 0
  fi
  command -v gh >/dev/null || return 1
  local user="${GH_USER:-huuhoa143}"
  local token
  token="$(gh auth token -u "$user" 2>/dev/null || true)"
  [[ -n "$token" ]] || { warn "Could not derive GH_TOKEN for '$user'"; return 1; }
  export GH_TOKEN="$token"
  unset GITHUB_TOKEN
}

# ─── Resilient notarytool submit + poll ─────────────────────────────────
# Local machine, consumer Wi-Fi: a flat `notarytool submit --wait` loses all
# progress on one dropped packet. Submit with --no-wait, remember the
# submission id in the state file, and poll ourselves so --resume can
# re-attach to an in-flight Apple scan instead of submitting a fresh one.
#
# Exit codes: 0=Accepted, 1=Invalid/Rejected, 2=Timeout/network.

NOTARIZE_POLL_MAX="${NOTARIZE_POLL_MAX:-360}"   # 360 × 10s = 1h
NOTARIZE_POLL_INTERVAL="${NOTARIZE_POLL_INTERVAL:-10}"

notarize_status() {
  xcrun notarytool info "$1" --keychain-profile "$2" --output-format json 2>/dev/null \
    | jq -r '.status // "Unknown"'
}

notarize_resilient() {
  local artifact="$1"
  local state_key="$2"          # e.g. notarize_app_id, notarize_dmg_id_x64
  local profile="${3:?notarize_resilient: keychain profile required}"

  local prior_id
  prior_id="$(state_get "$state_key")"
  if [[ -n "$prior_id" ]]; then
    local prior_status
    prior_status="$(notarize_status "$prior_id" "$profile" 2>/dev/null || echo "")"
    if [[ "$prior_status" == "Accepted" ]]; then
      green "Notarize ($state_key) already Accepted ($prior_id) — skipping resubmit"
      return 0
    fi
  fi

  bold "Submit: $(basename "$artifact")"
  local submit_json sub_id
  submit_json="$(xcrun notarytool submit "$artifact" \
    --keychain-profile "$profile" \
    --no-wait --output-format json 2>&1)" || {
      red "notarytool submit failed:"
      printf '%s\n' "$submit_json" >&2
      return 1
    }

  sub_id="$(printf '%s\n' "$submit_json" | jq -r '.id // empty')"
  [[ -n "$sub_id" ]] || {
    red "Could not parse submission id from notarytool response:"
    printf '%s\n' "$submit_json" >&2
    return 1
  }
  state_set "$state_key" "$sub_id"
  echo "  id: $sub_id"

  bold "Polling Apple (max $((NOTARIZE_POLL_MAX * NOTARIZE_POLL_INTERVAL / 60)) min)"
  local attempts=0 network_failures=0 status
  while (( attempts < NOTARIZE_POLL_MAX )); do
    sleep "$NOTARIZE_POLL_INTERVAL"
    attempts=$((attempts + 1))
    status="$(notarize_status "$sub_id" "$profile" 2>/dev/null || echo "NetworkError")"
    case "$status" in
      Accepted)
        echo
        green "Notarization Accepted (poll #$attempts)"
        return 0
        ;;
      Invalid|Rejected)
        echo
        red "Notarization $status. Fetching detailed log…"
        xcrun notarytool log "$sub_id" --keychain-profile "$profile" 2>&1 | head -50 >&2
        return 1
        ;;
      "In Progress")
        if (( attempts % 6 == 0 )); then
          printf '\r  In Progress (elapsed %d min)...' $((attempts * NOTARIZE_POLL_INTERVAL / 60)) >&2
        fi
        network_failures=0
        ;;
      *)
        network_failures=$((network_failures + 1))
        if (( network_failures > 30 )); then  # ~5 min of network errors
          echo
          red "Persistent network errors. Submission id saved: $sub_id"
          red "Re-run with --resume to continue when network recovers."
          return 2
        fi
        ;;
    esac
  done

  echo
  red "Notarization timed out after $((NOTARIZE_POLL_MAX * NOTARIZE_POLL_INTERVAL / 60)) min"
  red "Submission id: $sub_id"
  red "Manual check: xcrun notarytool info $sub_id --keychain-profile $profile"
  return 2
}
