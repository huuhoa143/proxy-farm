#!/bin/sh
# WireGuard from a standard .conf — Mullvad, ProtonVPN, Surfshark, PIA, IVPN,
# Windscribe, or your own server.
#
# wg-quick is deliberately not used: it installs its own policy routing and fwmark rules
# that fight the shared kill-switch. We set the interface up by hand instead, which also
# lets us keep the endpoint pinned to the real uplink.
#
# Env: CONFIG (path to the .conf, e.g. /config/mullvad-se.conf)

_wg_field() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONFIG" | head -1; }

driver_resolve() {
  : "${CONFIG:?CONFIG required for wireguard}"
  [ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; return 1; }
  TUNNEL_LABEL=$(basename "$CONFIG" .conf)
  ep=$(_wg_field Endpoint)
  host=${ep%:*}
  case "$host" in
    \[*\]) host=$(echo "$host" | tr -d '[]') ;;   # bracketed IPv6
  esac
  if echo "$host" | grep -qE '^[0-9.]+$'; then echo "$host"
  else dig +short "$host" A | grep -E '^[0-9.]+$'
  fi
}

driver_up() {
  ADDR=$(_wg_field Address)
  DNS=$(_wg_field DNS)
  EP=$(_wg_field Endpoint)
  EPIP=$(cat /run/server_ip)
  EPPORT=${EP##*:}

  # wg setconf rejects anything outside [Interface]/[Peer] keys, so hand it a clean file
  # with the endpoint already resolved to the IP we pinned a route for.
  # Strip only wg-quick-only keys. Match them exactly: a loose "Pre" prefix would also
  # eat PresharedKey, and a silently dropped PSK makes every handshake fail.
  awk -v ip="$EPIP" -v port="$EPPORT" '
    /^[[:space:]]*(Address|DNS|MTU|Table|PreUp|PreDown|PostUp|PostDown|SaveConfig)[[:space:]]*=/ { next }
    /^[[:space:]]*Endpoint[[:space:]]*=/ { print "Endpoint = " ip ":" port; next }
    { print }
  ' "$CONFIG" > /run/wg0.conf

  ip link del wg0 2>/dev/null || true
  ip link add wg0 type wireguard
  wg setconf wg0 /run/wg0.conf
  # Address may be a comma-separated list (v4 + v6); take the IPv4 ones.
  echo "$ADDR" | tr ',' '\n' | while read -r a; do
    a=$(echo "$a" | tr -d ' '); [ -z "$a" ] && continue
    case "$a" in *:*) continue ;; esac          # skip IPv6
    ip addr add "$a" dev wg0 2>/dev/null || true
  done
  ip link set mtu "$MTU" up dev wg0
  # Split default so it beats any leftover default without needing to delete it.
  ip route replace 0.0.0.0/1 dev wg0
  ip route replace 128.0.0.0/1 dev wg0

  [ -n "$DNS" ] && [ -z "$TUNNEL_DNS" ] && \
    echo "$DNS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v ':' | \
    sed 's/^/nameserver /' > /etc/resolv.conf

  # WireGuard is stateless: nothing to supervise, the shared watchdog owns liveness.
  ( while true; do sleep 3600; done ) &
}

driver_established() { [ "$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}')" != 0 ]; }

# No handshake at all after ~20 s: the peer is not answering this endpoint.
driver_stuck() {
  [ "$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}')" = 0 ] || return 1
  echo "watchdog: WireGuard không bắt tay được (key sai, hết hạn, hoặc tài khoản hết gói?)" >&2
  echo nohandshake > /run/why
}
