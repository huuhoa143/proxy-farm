#!/bin/sh
# One VPN tunnel + a gost SOCKS5/HTTP proxy, confined to this container's netns.
#
# Everything protocol-specific lives in drivers/$PROTOCOL.sh, which must define:
#   driver_resolve   -> echo the outer endpoint IP(s) to pin (one per line); sets TUNNEL_LABEL
#   driver_outer     -> (optional) add extra `ip rule` entries for the tunnel's own packets
#   driver_up        -> bring the tunnel up in the background; return once it is starting
# Shared here: outer routing + kill-switch, DNS, gost (auth + DoH), watchdog, status file.
#
# Env: PROTOCOL (ikev2-cert|ikev2-eap|wireguard|openvpn), STATUS_KEY,
#      PROXY_USER/PROXY_PASS, TUNNEL_DNS (default "1.1.1.1 8.8.8.8"),
#      WATCHDOG_INTERVAL (15), WATCHDOG_FAILS (3), MTU (1400)
# Protocol-specific env is documented in each driver.
set -e
PROTOCOL="${PROTOCOL:-ikev2-cert}"
DRIVER="/drivers/${PROTOCOL}.sh"
[ -f "$DRIVER" ] || { echo "FATAL: unknown PROTOCOL '$PROTOCOL'"; exit 1; }
# shellcheck disable=SC1090
. "$DRIVER"

MTU="${MTU:-1400}"
TUNNEL_LABEL="$PROTOCOL"
WF="/status/${STATUS_KEY:-node}.wait.json"
PF="/status/${STATUS_KEY:-node}.phase.json"
GOST=""

# ---------------------------------------------------------------- progress
# The UI shows which step an attempt is in, its number, and how long we have been trying.
# /run survives the container restarting between attempts, so the counters carry over
# until a tunnel comes up.
TRY=$(( $(cat /run/try 2>/dev/null || echo 0) + 1 )); echo "$TRY" > /run/try
[ -s /run/try_since ] || date +%s > /run/try_since
phase() {
  [ -d /status ] || return 0
  printf '{"phase":"%s","attempt":%d,"since":%s,"at":%d}\n' \
    "$1" "$TRY" "$(cat /run/try_since)" "$(date +%s)" > "$PF.tmp" 2>/dev/null &&
    mv "$PF.tmp" "$PF" 2>/dev/null || true
}

# ---------------------------------------------------------------- shutdown
# sh as PID 1 ignores SIGTERM unless trapped, so `docker stop` used to wait its 10 s and
# SIGKILL us, and no IKE DELETE ever reached the gateway. Close the tunnel properly.
shutdown() {
  echo "shutdown: đóng tunnel"
  command -v driver_down >/dev/null 2>&1 && driver_down || true
  [ -n "$GOST" ] && kill "$GOST" 2>/dev/null
  rm -f "$WF" "$PF" "${SF:-/nonexistent}" 2>/dev/null
  exit 0
}
trap shutdown TERM INT

# ---------------------------------------------------------------- pacing
# A failed attempt backs off exponentially (30 s, 1, 2, 4 … capped at 30 min), and a fresh
# start waits a few random seconds. HMA sometimes hands out a session that carries no data
# (the official app does it too); a later attempt usually lands on one that works.
# Spacing starts out did not reduce it (measured: 15/27 first-try with 6 s slots, same as
# all at once), so retrying is the fix.
FAILS=$(cat /run/fails 2>/dev/null || echo 0)
case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
NOW=0
if [ -f "/status/${STATUS_KEY:-node}.now" ]; then     # the user pressed retry
  NOW=1; FAILS=0; rm -f "/status/${STATUS_KEY:-node}.now" /run/fails
fi
if [ "$NOW" = 1 ]; then
  WAIT=0
elif [ -f /run/quick ]; then      # last IP failed, but this location has another to try
  rm -f /run/quick; WAIT=3
elif [ "$FAILS" -gt 0 ]; then
  if [ "$FAILS" -gt 7 ]; then WAIT=1800
  else WAIT=$(( 30 * (1 << (FAILS - 1)) )); [ "$WAIT" -gt 1800 ] && WAIT=1800
  fi
else
  WAIT=$(( $(od -An -N1 -tu1 /dev/urandom | tr -d ' ') % 20 ))
fi
if [ "$WAIT" -gt 0 ]; then
  [ -d /status ] && [ "$FAILS" -gt 0 ] && \
    printf '{"until":%d,"attempt":%d,"why":"%s"}\n' $(( $(date +%s) + WAIT )) $(( FAILS + 1 )) \
      "$(cat /run/why 2>/dev/null)" > "$WF"
  if [ "$FAILS" -gt 0 ]; then phase wait; else phase queue; fi
  echo "pacing: chờ ${WAIT}s trước lần thử $(( FAILS + 1 ))"
  sleep "$WAIT" & wait $!
fi
rm -f "$WF" /run/why 2>/dev/null || true   # why = reason the previous attempt failed

# ---------------------------------------------------------------- outer endpoint
# Some redirector IPs drop a share of packets (measured: the AWS Frankfurt pool answers
# 30–60 % of the time), so steer away from an IP that just failed for 10 minutes and
# pick among the rest.
CANDIDATES=""
for i in 1 2 3 4 5; do            # DNS hiccups are not a reason to burn a restart
  CANDIDATES=$(driver_resolve 2>/dev/null) && [ -n "$CANDIDATES" ] && break
  sleep 3
done
[ -n "$CANDIDATES" ] || { echo "FATAL: driver could not resolve an endpoint"; exit 1; }
# Kept in the shared status dir so it survives the container being recreated; otherwise
# every `up` would go straight back to poking the IPs that are ignoring us.
BADIPS=/run/badips
[ -d /status ] && [ -w /status ] && BADIPS="/status/${STATUS_KEY:-node}.badips"
touch "$BADIPS"
awk -v n="$(date +%s)" '$2 > n - 600' "$BADIPS" > "$BADIPS.tmp" && mv "$BADIPS.tmp" "$BADIPS"
cut -d' ' -f1 "$BADIPS" > /run/badlist
GOOD=$(echo "$CANDIDATES" | grep -vxF -f /run/badlist || true)
[ -n "$GOOD" ] || GOOD="$CANDIDATES"      # all silent lately: fall back, back-off paces it
ENDPOINTS=$(echo "$GOOD" | shuf -n1)
echo "$ENDPOINTS" > /run/server_ip
echo "$CANDIDATES" > /run/candidates
echo "tunnel: $TUNNEL_LABEL -> $(echo "$ENDPOINTS" | tr '\n' ' ')"

# ---------------------------------------------------------------- kill-switch
# Only the tunnel's own outer packets and private ranges may use the real uplink.
# The default route is removed, so if the tunnel dies the proxy fails closed instead
# of leaking the host's real IP.
GW=$(ip -4 route show default | awk '{print $3; exit}')
DEV=$(ip -4 route show default | awk '{print $5; exit}')
LOCAL=$(ip -4 -o addr show dev "${DEV:-eth0}" | awk '{split($4,a,"/"); print a[1]; exit}')
if [ -n "$GW" ]; then
  echo "$GW $DEV $LOCAL" > /run/netinfo
else
  read -r GW DEV LOCAL < /run/netinfo   # restart: default route already gone
fi
export GW DEV LOCAL MTU

ip route replace default via "$GW" dev "$DEV" table 100
# Pin the endpoint to the real uplink. An endpoint that is already on-link (a VPN
# server on the same L2, e.g. self-hosted) must stay on-link: forcing it via the
# gateway would shadow the kernel's link route and black-hole the handshake.
for ep in $ENDPOINTS; do
  if ip route get "$ep" 2>/dev/null | head -1 | grep -q " via "; then
    ip route replace "$ep/32" via "$GW" dev "$DEV"
  else
    ip route replace "$ep/32" dev "$DEV"
  fi
done
for n in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  ip route replace "$n" via "$GW" dev "$DEV"
done
command -v driver_outer >/dev/null 2>&1 && driver_outer || true
ip route del default 2>/dev/null || true

for d in ${TUNNEL_DNS:-1.1.1.1 8.8.8.8}; do echo "nameserver $d"; done > /etc/resolv.conf

# ---------------------------------------------------------------- outer port
# A fresh outer source port on every attempt. IKE always sends from 500/4500, so every
# reconnect reused the exact same flow. Once that flow went quiet it stayed quiet for
# hours (our retries kept it alive), while the very same packet from the host, or from
# the container on any other port, was answered at once. Whether the stuck state lives
# in Docker Desktop's UDP proxy or at the provider is unknown; a new port per attempt
# sidesteps both.
if [ -n "$OUTER_UDP_PORTS" ]; then
  if iptables -t nat -F POSTROUTING 2>/dev/null; then
    p=$(( 20000 + $(od -An -N2 -tu2 /dev/urandom) % 40000 ))
    for sp in $OUTER_UDP_PORTS; do
      iptables -t nat -A POSTROUTING -p udp --sport "$sp" -j SNAT --to-source ":$p"
      echo "outer port: $sp -> $p"; p=$((p + 1))
    done
  else
    echo "warn: iptables unavailable, outer ports stay fixed"
  fi
fi

# ---------------------------------------------------------------- tunnel
phase handshake
driver_up

# ---------------------------------------------------------------- proxy
# Resolve names via DoH over the tunnel (port 443): some gateways drop UDP 53 to public
# resolvers, so plain DNS fails even though the tunnel is up. DoH sidesteps that.
# Block YAML only — an inline flow map with an optional section silently produces invalid
# YAML when that section is empty, and gost then exits leaving no proxy at all.
{
  # 2 s per server (some gateways — HMA — silently drop 1.1.1.1:443, and gost waited its full
  # default timeout on every lookup: 4–6 s per new connection), plain DNS as the last resort,
  # answers cached 5 min.
  echo "resolvers:"
  echo "- name: doh"
  echo "  nameservers:"
  echo "  - addr: https://1.1.1.1/dns-query"
  echo "    timeout: 2s"
  echo "    ttl: 300s"
  echo "  - addr: https://8.8.8.8/dns-query"
  echo "    timeout: 2s"
  echo "    ttl: 300s"
  echo "  - addr: https://9.9.9.9/dns-query"
  echo "    timeout: 2s"
  echo "    ttl: 300s"
  echo "  - addr: udp://8.8.8.8:53"
  echo "    timeout: 2s"
  echo "    ttl: 300s"
  echo "  - addr: tcp://1.1.1.1:53"
  echo "    timeout: 2s"
  echo "    ttl: 300s"
  echo "services:"
  echo "- name: socks"
  echo "  addr: \":1080\""
  echo "  handler:"
  echo "    type: auto"
  if [ -n "$PROXY_USER" ]; then
    echo "    auth:"
    echo "      username: $PROXY_USER"
    echo "      password: $PROXY_PASS"
  fi
  echo "  listener:"
  echo "    type: tcp"
  echo "  resolver: doh"
} > /run/gost.yaml
gost -C /run/gost.yaml &
GOST=$!
sleep 2
kill -0 $GOST 2>/dev/null || { echo "FATAL: gost failed to start"; cat /run/gost.yaml; exit 1; }

# ---------------------------------------------------------------- watchdog
# Fetch through our own proxy, so a tunnel that stops passing real traffic (or DNS)
# recycles the container onto a fresh endpoint. On success it records the exit IP and
# latency to /status/<key>.json, which the manager reads instead of probing across the
# docker network (hairpin NAT mangles TLS on the published-port path).
SF="/status/${STATUS_KEY:-$(cat /run/server_ip)}.json"
PXY="socks5h://127.0.0.1:1080"
[ -n "$PROXY_USER" ] && PXY="socks5h://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:1080"
check() {
  # Start from an empty body and trust curl's own verdict. A curl that fails at once
  # (dead tunnel -> "network unreachable") never truncates the output file, so the body
  # of the *previous* success used to survive, the grep matched, and a dead tunnel was
  # reported healthy at ~5 ms — and therefore never recycled.
  rm -f /run/probe.body
  out=$(curl -s -m 12 -o /run/probe.body -w '%{http_code} %{time_total}' \
        -x "$PXY" https://ipinfo.io/json 2>/dev/null) || return 1
  [ "${out%% *}" = 200 ] || return 1
  tt=${out#* }
  grep -q '"ip"' /run/probe.body 2>/dev/null || return 1
  [ -d /status ] && printf '{"latency":%d,"ts":%d,"info":%s}\n' \
    "$(awk "BEGIN{print int(${tt:-0}*1000)}")" "$(date +%s)" "$(cat /run/probe.body)" \
    > "$SF.tmp" 2>/dev/null && mv "$SF.tmp" "$SF" 2>/dev/null
  return 0
}
# Mark the current gateway IP as silent; back off only if the location has no other IP.
mark_bad() {
  echo "$(cat /run/server_ip) $(date +%s)" >> "$BADIPS"
  cut -d' ' -f1 "$BADIPS" > /run/badlist
  if [ -n "$(grep -vxF -f /run/badlist /run/candidates 2>/dev/null)" ]; then
    : > /run/quick; echo "failover: thử IP khác của vị trí này"
  else
    echo $(( FAILS + 1 )) > /run/fails
  fi
}
clear_status() { [ -d /status ] && rm -f "$SF" "$PF" 2>/dev/null; }
up=0
# Give up on a gateway that never answers well before the 90 s ceiling: every extra
# retransmission into an IP that is ignoring us is exactly the traffic that keeps it
# ignoring us. Drivers that can tell "no reply at all" apart report it via driver_stuck.
T0=$(date +%s)
VERIFY=0
for i in $(seq 1 45); do
  check && { up=1; break; }
  # Handshake done, now waiting for the first data to come back.
  if [ $VERIFY = 0 ] && command -v driver_established >/dev/null 2>&1 && driver_established; then
    VERIFY=1; phase verify
  fi
  # By time, not by loop count: a check against a tunnel with no data takes the full
  # curl timeout, so "10 loops" used to mean ~2.5 minutes instead of ~20 seconds.
  if [ $(( $(date +%s) - T0 )) -ge 20 ] && command -v driver_stuck >/dev/null 2>&1 && driver_stuck; then
    [ -s /run/why ] || echo silent > /run/why     # the driver names "nodata" itself
    echo "watchdog: gateway $(cat /run/server_ip) không dùng được, bỏ sớm"; break
  fi
  sleep 2
done
# Every give-up closes the session first (IKE DELETE) so the gateway is not left holding
# a session nobody uses.
[ $up = 1 ] || { echo "watchdog: tunnel never came up ($TUNNEL_LABEL), exiting"
                 [ -s /run/why ] || echo noconnect > /run/why
                 { command -v driver_down >/dev/null && driver_down || true; }; mark_bad; clear_status; exit 1; }
echo "watchdog: tunnel up"
rm -f /run/try /run/try_since "$PF" 2>/dev/null || true   # next outage counts from 1
echo 0 > /run/fails
fails=0
while kill -0 $GOST 2>/dev/null; do
  sleep "${WATCHDOG_INTERVAL:-15}" & wait $!
  if check; then fails=0; else
    fails=$((fails+1)); echo "watchdog: check failed ($fails)"
    # It did work, so start the back-off from the bottom rather than where we left it.
    [ $fails -ge "${WATCHDOG_FAILS:-3}" ] && { echo "watchdog: tunnel dead, exiting"
                                               echo dead > /run/why
                                               { command -v driver_down >/dev/null && driver_down || true; }
                                               FAILS=0; mark_bad; clear_status; exit 1; }
  fi
done
clear_status; exit 1
