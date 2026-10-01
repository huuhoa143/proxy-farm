#!/bin/sh
# OpenVPN from a standard .ovpn — most legacy providers and self-hosted servers.
#
# Env: CONFIG (path to the .ovpn)
#      OVPN_USER / OVPN_PASS (only if the config uses auth-user-pass)

_ovpn_remote() { sed -n 's/^[[:space:]]*remote[[:space:]]\+//p' "$CONFIG" | head -1; }

driver_resolve() {
  : "${CONFIG:?CONFIG required for openvpn}"
  [ -f "$CONFIG" ] || { echo "config not found: $CONFIG" >&2; return 1; }
  TUNNEL_LABEL=$(basename "$CONFIG" | sed 's/\.[^.]*$//')
  host=$(_ovpn_remote | awk '{print $1}')
  [ -n "$host" ] || { echo "no 'remote' line in $CONFIG" >&2; return 1; }
  if echo "$host" | grep -qE '^[0-9.]+$'; then echo "$host"
  else dig +short "$host" A | grep -E '^[0-9.]+$'
  fi
}

driver_up() {
  EPIP=$(cat /run/server_ip)
  PORT=$(_ovpn_remote | awk '{print $2}')
  PROTO=$(sed -n 's/^[[:space:]]*proto[[:space:]]\+//p' "$CONFIG" | head -1)

  AUTH=""
  if [ -n "$OVPN_USER" ]; then
    printf '%s\n%s\n' "$OVPN_USER" "$OVPN_PASS" > /run/ovpn.auth
    chmod 600 /run/ovpn.auth
    AUTH="--auth-user-pass /run/ovpn.auth"
  fi

  # --remote on the command line overrides the file, pinning us to the IP we routed.
  # --route-nopull + our own redirect keeps the server from installing routes that
  # would bypass the kill-switch.
  # shellcheck disable=SC2086
  openvpn --config "$CONFIG" \
    --remote "$EPIP" ${PORT:-1194} ${PROTO:-udp} \
    --route-nopull \
    --tun-mtu "$MTU" --mssfix \
    --script-security 2 \
    --route-up '/bin/sh -c "ip route replace 0.0.0.0/1 dev $dev; ip route replace 128.0.0.0/1 dev $dev"' \
    --persist-tun --persist-key \
    --ping 10 --ping-restart 60 \
    $AUTH >&2 &
}
