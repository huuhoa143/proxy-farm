FROM gogost/gost:latest AS gost
FROM alpine:3.22
RUN apk add --no-cache \
      libreswan nss-tools openssl \
      wireguard-tools-wg \
      openvpn \
      curl ca-certificates iproute2 bind-tools iptables
COPY --from=gost /bin/gost /usr/local/bin/gost
COPY ca /ca
COPY drivers /drivers
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /drivers/*.sh
LABEL proxy-farm=node
ENTRYPOINT ["/entrypoint.sh"]
