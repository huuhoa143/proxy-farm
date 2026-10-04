FROM gogost/gost:latest AS gost

# strongSwan and libreswan both ship /usr/sbin/ipsec, so apk refuses to install them side
# by side. Each driver needs its own: libreswan for HMA's certificate login (it can skip
# the IDr check those gateways need), strongSwan for EAP user/password logins (libreswan
# has no EAP-MSCHAPv2 client). Take strongSwan from its own stage, minus that one script;
# the drivers call charon and swanctl directly.
FROM alpine:3.22 AS swan
RUN apk add --no-cache strongswan && rm /usr/sbin/ipsec

FROM alpine:3.22
RUN apk add --no-cache \
      libreswan nss-tools openssl \
      wireguard-tools-wg \
      openvpn \
      curl ca-certificates iproute2 bind-tools iptables \
      libcap2 libcurl gmp sqlite-libs
COPY --from=swan /etc/strongswan.conf /etc/strongswan.conf
COPY --from=swan /etc/strongswan.d /etc/strongswan.d
COPY --from=swan /etc/swanctl /etc/swanctl
COPY --from=swan /usr/lib/ipsec /usr/lib/ipsec
COPY --from=swan /usr/lib/strongswan /usr/lib/strongswan
COPY --from=swan /usr/sbin/swanctl /usr/sbin/swanctl
# charon drops to this user; apk's install script would have created it.
RUN addgroup -S ipsec 2>/dev/null; adduser -S -D -H -G ipsec ipsec 2>/dev/null; true
COPY --from=gost /bin/gost /usr/local/bin/gost
COPY ca /ca
COPY drivers /drivers
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /drivers/*.sh
LABEL proxy-farm=node
ENTRYPOINT ["/entrypoint.sh"]
