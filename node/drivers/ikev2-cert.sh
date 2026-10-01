#!/bin/sh
# IKE source ports; entrypoint rewrites them to a fresh pair on every attempt.
OUTER_UDP_PORTS="500 4500"
# IKEv2 with a client certificate — HMA / SurfEasy / Gen Digital.
#
# libreswan rather than strongSwan: these gateways answer with an IDr
# (ipsec.surfeasy.mobi / ipsec.gen-vpn.com) that is NOT in their own certificate's SAN.
# strongSwan rejects that ("no trusted RSA public key found"); only libreswan can skip
# the check with require-id-on-certificate=no, the same way Apple's IKEv2 client does.
# Their server certs chain to public CAs, so the Mozilla bundle is loaded too.
#
# Env: SERVER (fqdn, e.g. US.ult.surfeasy.mobi), SERVER_IP (optional pin)
# Secrets (/secrets): client.pem client.key ca-*.pem
# The public CA intermediates HMA's gateways omit from their chain ship in /ca.

driver_resolve() {
  : "${SERVER:?SERVER required for ikev2-cert}"
  TUNNEL_LABEL="$SERVER"
  # Every candidate; the entrypoint picks one, skipping any that recently ignored us.
  if [ -n "$SERVER_IP" ]; then echo "$SERVER_IP"
  else dig +short "$SERVER" A | grep -E '^[0-9.]+$'
  fi
}

driver_outer() {
  # IKE/NAT-T/ESP may go to a *different* gateway than the one we resolved: these
  # clusters send IKEv2 REDIRECTs for load balancing, so route by protocol, not by dst.
  for r in "udp dport 500" "udp dport 4500"; do
    ip rule show | grep -q "ipproto $r" || ip rule add ipproto $r lookup 100
  done
  ip rule show | grep -q "ipproto esp" || ip rule add ipproto 50 lookup 100
}

driver_up() {
  IP=$(cat /run/server_ip)
  UDID=$(openssl x509 -in /secrets/client.pem -noout -subject -nameopt multiline \
         | sed -n 's/ *commonName *= //p')

  NSS=/var/lib/ipsec/nss
  rm -rf $NSS && mkdir -p $NSS
  certutil -N -d sql:$NSS --empty-password
  openssl pkcs12 -export -name vpnclient -in /secrets/client.pem -inkey /secrets/client.key \
    -certfile /secrets/ca-int.pem -passout pass:x -out /run/client.p12
  pk12util -i /run/client.p12 -d sql:$NSS -W x >/dev/null
  rm -f /run/client.p12
  for f in /ca/*.pem /secrets/ca-*.pem /usr/share/ca-certificates/mozilla/*.crt; do
    certutil -A -d sql:$NSS -n "$(basename "$f")" -t "CT,," -i "$f" 2>/dev/null || true
  done

  cat > /etc/ipsec.conf <<EOC
config setup
    logfile=/dev/stderr
    plutodebug=none

conn vpn
    keyexchange=ikev2
    authby=rsasig
    left=$LOCAL
    leftnexthop=$GW
    leftid=@$UDID
    leftcert=vpnclient
    leftsendcert=always
    leftmodecfgclient=yes
    narrowing=yes
    right=$IP
    rightid=%any
    rightca=%any
    rightsubnet=0.0.0.0/0
    require-id-on-certificate=no
    accept-redirect=yes
    ike=aes_gcm256-sha2_256-dh31,aes_gcm256-sha2_256-modp2048
    esp=aes_gcm256
    fragmentation=yes
    # ESP+NAT-T overhead (~62B) on a 1500 path; consumer PPPoE upstream is often 1492.
    # Without this the TCP handshake succeeds but the first full-size packet (a TLS
    # ClientHello) is silently dropped: connections hang instead of failing.
    mtu=$MTU
    dpddelay=30
    keyingtries=%forever
    leftupdown=/usr/local/bin/vpn-updown
    auto=start
EOC

  # Their pushed DNS (10.255.0.0) frequently black-holes; keep our resolv.conf.
  cat > /usr/local/bin/vpn-updown <<'EOU'
#!/bin/sh
unset PLUTO_PEER_DNS_INFO PLUTO_PEER_DOMAIN_INFO
exec /usr/libexec/ipsec/_updown "$@"
EOU
  chmod +x /usr/local/bin/vpn-updown
  : > /etc/ipsec.secrets

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
