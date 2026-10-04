#!/bin/sh
# IKEv2 with an EAP username/password — ZoogVPN, NordVPN, ProtonVPN and most providers
# that document "IKEv2 manual setup" with an account login rather than a certificate.
#
# strongSwan, not libreswan: libreswan has no EAP-MSCHAPv2 client, which is what these
# gateways ask for. The gateway's certificate is verified against the public CAs and
# must be issued to SERVER_ID (default SERVER).
#
# Expired gateway certificates: some providers let them lapse (ZoogVPN's *.webunlim.com
# ran on certificates that expired months ago). Those are accepted only when the chain
# still verifies apart from the dates and the name matches; the key is then pinned in
# /status/pins and a later, different key for the same name is refused.
#
# Env: SERVER (gateway name), SERVER_IP (optional; skips DNS), SERVER_ID (optional),
#      EAP_USER, EAP_PASS

SWAN=/usr/lib/strongswan/charon
PINS=/status/pins

driver_resolve() {
  : "${SERVER:?SERVER required for ikev2-eap}"
  : "${EAP_USER:?EAP_USER required for ikev2-eap}"
  TUNNEL_LABEL="$SERVER"
  # A restart keeps this netns, kill-switch included; open it again for the lookup.
  iptables -F PF_KS 2>/dev/null || true
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

# remote { } block: verify against the CAs, or trust the pinned key of an expired cert.
_swan_conf() {
  cat > /etc/swanctl/conf.d/vpn.conf <<EOC
connections {
  vpn {
    version = 2
    remote_addrs = $(cat /run/server_ip)
    vips = 0.0.0.0
    encap = yes
    fragmentation = yes
    dpd_delay = 30s
    keyingtries = 0
    local {
      auth = eap-mschapv2
      eap_id = $EAP_USER
    }
    remote {
      auth = pubkey
      id = $RID
      $1
    }
    children {
      vpn {
        remote_ts = 0.0.0.0/0
        start_action = start
        dpd_action = restart
        close_action = restart
      }
    }
  }
}
secrets {
  eap-vpn {
    id = $EAP_USER
    secret = "$(printf '%s' "$EAP_PASS" | sed 's/["\\]/\\&/g')"
  }
}
EOC
}

# The gateway sent a certificate whose only fault is its dates: check that, then pin it.
_pin_expired() {
  swanctl --list-certs --pem 2>/dev/null > /run/certs.pem
  rm -f /run/c*.crt
  awk '/BEGIN CERT/{f=1;c++} f{print > ("/run/c" c ".crt")} /END CERT/{f=0}' /run/certs.pem
  leaf=""
  for f in /run/c*.crt; do
    openssl x509 -in "$f" -noout -subject 2>/dev/null | grep -q "CN *= *$RID\$" && { leaf=$f; break; }
  done
  [ -n "$leaf" ] || { echo "pin: không thấy chứng chỉ của $RID" >&2; return 1; }
  cat /ca/*.pem > /run/untrusted.pem
  openssl verify -no_check_time -CAfile /etc/ssl/certs/ca-certificates.crt \
    -untrusted /run/untrusted.pem "$leaf" >/dev/null 2>&1 ||
    { echo "pin: chứng chỉ $RID không do CA hợp lệ cấp — từ chối" >&2; return 1; }
  openssl x509 -in "$leaf" -noout -pubkey > /run/pin.pem
  mkdir -p "$PINS" 2>/dev/null
  if [ -s "$PINS/$RID.pem" ]; then
    cmp -s "$PINS/$RID.pem" /run/pin.pem ||
      { echo "pin: khoá máy chủ $RID đã đổi so với lần trước — từ chối" >&2
        echo keychanged > /run/why; return 1; }
  else
    cp /run/pin.pem "$PINS/$RID.pem" 2>/dev/null || true
    echo "pin: chứng chỉ $RID đã hết hạn nhưng hợp lệ — ghim khoá công khai" >&2
  fi
  cp /run/pin.pem /etc/swanctl/pubkey/pin.pem
  _swan_conf "pubkeys = pin.pem"
  swanctl --load-all >/dev/null 2>&1
}

driver_up() {
  IP=$(cat /run/server_ip)
  RID="${SERVER_ID:-$SERVER}"

  mkdir -p /etc/swanctl/conf.d /etc/swanctl/x509ca /etc/swanctl/pubkey
  rm -f /etc/swanctl/conf.d/* /etc/swanctl/pubkey/*
  cp /usr/share/ca-certificates/mozilla/*.crt /etc/swanctl/x509ca/ 2>/dev/null || true
  # A random local port each attempt (same reason as OUTER_UDP_PORTS elsewhere); no
  # online revocation checks, the tunnel is not up yet to reach the responders; and keep
  # our own resolv.conf instead of the pushed DNS.
  # mtu/mss on the routes charon installs: the tunnelled traffic leaves through eth0, so
  # without them the kernel sizes our segments for 1500 bytes and every full one goes out
  # as a fragmented ESP packet. Many gateways (ZoogVPN HK, DE, ES, US-west...) drop the
  # fragments: the handshake works, small requests work, and any upload or TLS hello
  # hangs. The SYN clamp below only covers the other direction.
  cat > /etc/strongswan.d/zz-farm.conf <<EOC
charon {
  port = 0
  port_nat_t = 0
  filelog { stderr { default = 1 } }
  plugins {
    revocation { enable_ocsp = no
                 enable_crl = no }
    resolve { load = no }
    kernel-netlink { mtu = $MTU
                     mss = $((MTU - 160)) }
  }
}
EOC
  # Always start from CA verification, pinned or not: a renewed certificate takes over
  # again by itself, and the pin is only consulted when the dates are the sole problem.
  _swan_conf ""

  # Policy-based IPsec: the kernel never sees a smaller MTU, so the first full-size
  # packet (a TLS ClientHello) would vanish. Clamp TCP to what fits inside ESP.
  iptables -t mangle -F POSTROUTING 2>/dev/null
  iptables -t mangle -A POSTROUTING -o "$DEV" -p tcp --tcp-flags SYN,RST SYN \
    -m policy --pol ipsec --dir out -j TCPMSS --set-mss $((MTU - 160))
  # Kill-switch: strongSwan routes through the real uplink and lets the IPsec policy
  # capture the traffic. Should the policy go away, nothing else may leave that way.
  iptables -N PF_KS 2>/dev/null; iptables -F PF_KS
  iptables -C OUTPUT -j PF_KS 2>/dev/null || iptables -A OUTPUT -j PF_KS
  iptables -A PF_KS -o "$DEV" -d "$IP" -j RETURN
  iptables -A PF_KS -o "$DEV" -m policy --pol ipsec --dir out -j RETURN
  for n in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
    iptables -A PF_KS -o "$DEV" -d "$n" -j RETURN
  done
  iptables -A PF_KS -o "$DEV" -j DROP

  rm -f /var/run/charon.vici /var/run/charon.pid
  $SWAN > /run/charon.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do [ -S /var/run/charon.vici ] && break; sleep 1; done
  swanctl --load-all >/dev/null 2>&1
  # Mirror charon's log to ours and watch it for an expired certificate.
  ( tail -n +1 -f /run/charon.log &
    pinned=0
    while sleep 1; do
      if [ $pinned = 0 ] && grep -q "subject certificate invalid" /run/charon.log; then
        pinned=1; _pin_expired || true
      fi
      # Wrong password: the MS-CHAPv2 exchange itself fails.
      if grep -q "EAP method EAP_MSCHAPV2 failed" /run/charon.log; then
        echo "eap: sai email hoặc mật khẩu" >&2; echo badlogin > /run/why; break
      fi
      # Password accepted, access refused anyway. That is NOT proof of a connection cap:
      # the server also does it while it still holds sessions from earlier attempts, or
      # while it rate-limits the account. Say what happened, guess nothing.
      if grep -q "received EAP_FAILURE" /run/charon.log; then
        echo "eap: đăng nhập đúng nhưng máy chủ từ chối phiên này" >&2
        echo refused > /run/why; break
      fi
      # Refused before EAP even starts. ZoogVPN answers this way, every time, on servers
      # the account's plan does not cover (the other half answer with EAP_FAILURE). A
      # wrong password never gets here: it fails inside MS-CHAPv2 above.
      if grep -q "received AUTHENTICATION_FAILED notify" /run/charon.log &&
         ! grep -q "EAP method EAP_MSCHAPV2" /run/charon.log; then
        echo "eap: máy chủ từ chối tài khoản này trước khi đăng nhập" >&2
        echo refused > /run/why; break
      fi
    done ) | awk '!/loaded|loading|plugin/ { print; fflush() }' &
}

driver_down() { swanctl --terminate --ike vpn --force --timeout 3 >/dev/null 2>&1 || true; }

driver_established() { swanctl --list-sas 2>/dev/null | grep -q INSTALLED; }

driver_stuck() {
  [ -s /run/why ] && grep -qE "badlogin|keychanged|refused" /run/why && return 0
  sas=$(swanctl --list-sas 2>/dev/null)
  if ! echo "$sas" | grep -q ESTABLISHED; then
    # Not a word back after ~20 s: give up. A gateway that answers but is still checking
    # the password is not stuck — its RADIUS can take longer than that under load.
    grep -q "received packet: from $(cat /run/server_ip)" /run/charon.log && return 1
    return 0
  fi
  in=$(echo "$sas" | sed -n 's/^ *in .*, *\([0-9]*\) bytes.*/\1/p' | head -1)
  [ "$in" = 0 ] && { echo "watchdog: máy chủ không gửi dữ liệu về" >&2; echo nodata > /run/why; return 0; }
  return 1
}
