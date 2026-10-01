#!/bin/sh
# IKE source ports; entrypoint rewrites them to a fresh pair on every attempt.
OUTER_UDP_PORTS="500 4500"
# IKEv2 with EAP username/password — NordVPN, ProtonVPN, and most providers that
# document "IKEv2 manual setup" with an account login rather than a certificate.
#
# Same libreswan base as ikev2-cert; only the authentication side differs: we present
# no client certificate and authenticate with EAP-MSCHAPv2, while still verifying the
# server certificate against the public CA bundle.
#
# Env: SERVER (fqdn of the gateway), SERVER_IP (optional pin),
#      EAP_USER, EAP_PASS, SERVER_ID (optional, defaults to SERVER)

driver_resolve() {
  : "${SERVER:?SERVER required for ikev2-eap}"
  : "${EAP_USER:?EAP_USER required for ikev2-eap}"
  TUNNEL_LABEL="$SERVER"
  if [ -n "$SERVER_IP" ]; then echo "$SERVER_IP"
  else dig +short "$SERVER" A | grep -E '^[0-9.]+$'
  fi
}

driver_outer() {
  for r in "udp dport 500" "udp dport 4500"; do
    ip rule show | grep -q "ipproto $r" || ip rule add ipproto $r lookup 100
  done
  ip rule show | grep -q "ipproto esp" || ip rule add ipproto 50 lookup 100
}

driver_up() {
  IP=$(cat /run/server_ip)
  RID="${SERVER_ID:-$SERVER}"

  NSS=/var/lib/ipsec/nss
  rm -rf $NSS && mkdir -p $NSS
  certutil -N -d sql:$NSS --empty-password
  # Trust the public roots so the gateway certificate is actually verified.
  for f in /ca/*.pem /usr/share/ca-certificates/mozilla/*.crt /secrets/ca-*.pem; do
    certutil -A -d sql:$NSS -n "$(basename "$f")" -t "CT,," -i "$f" 2>/dev/null || true
  done

  cat > /etc/ipsec.conf <<EOC
config setup
    logfile=/dev/stderr
    plutodebug=none

conn vpn
    keyexchange=ikev2
    left=$LOCAL
    leftnexthop=$GW
    leftid=@$EAP_USER
    leftauth=eap
    eap=mschapv2
    leftmodecfgclient=yes
    leftsendcert=never
    narrowing=yes
    right=$IP
    rightid=@$RID
    rightauth=pubkey
    rightsubnet=0.0.0.0/0
    accept-redirect=yes
    ike=aes256-sha2_256-modp2048,aes_gcm256-sha2_256-modp2048
    esp=aes256-sha2_256,aes_gcm256
    fragmentation=yes
    mtu=$MTU
    dpddelay=30
    keyingtries=%forever
    leftupdown=/usr/local/bin/vpn-updown
    auto=start
EOC

  cat > /usr/local/bin/vpn-updown <<'EOU'
#!/bin/sh
unset PLUTO_PEER_DNS_INFO PLUTO_PEER_DOMAIN_INFO
exec /usr/libexec/ipsec/_updown "$@"
EOU
  chmod +x /usr/local/bin/vpn-updown

  umask 077
  printf '@%s : EAP "%s"\n' "$EAP_USER" "$EAP_PASS" > /etc/ipsec.secrets

  rm -f /run/pluto/pluto.pid /run/pluto/pluto.ctl
  mkdir -p /run/pluto
  ipsec pluto --config /etc/ipsec.conf --nofork &
}

# Tell the gateway we are leaving (IKE DELETE) so it drops the session now instead of
# holding a ghost that makes our next connect look like abuse.
driver_down() { ipsec whack --shutdown >/dev/null 2>&1 || true; }

# Still waiting for the very first reply after ~20 s means the gateway is ignoring us —
# no amount of waiting fixes that, and each retransmission only prolongs it.
# IKE and the Child SA are up: the tunnel exists, data has yet to show.
driver_established() { ipsec showstates 2>/dev/null | grep -q ESTABLISHED_CHILD_SA; }

driver_stuck() {
  st=$(ipsec showstates 2>/dev/null)
  echo "$st" | grep -q "IKE_SA_INIT_I" && ! echo "$st" | grep -qE "ESTABLISHED|IKE_AUTH_I|PARENT_I2" && return 0
  # Handshake done but the gateway behind the redirector has not sent back a single ESP
  # packet while we keep sending: it will not start later, reconnect instead.
  in=$(ip -s xfrm state list dst "$LOCAL" 2>/dev/null | sed -n 's/^[[:space:]]*\([0-9]*\)(bytes).*/\1/p' | head -1)
  [ "$in" = 0 ] && { echo "watchdog: gateway sau điều phối không gửi dữ liệu về" >&2; echo nodata > /run/why; return 0; }
  return 1
}
