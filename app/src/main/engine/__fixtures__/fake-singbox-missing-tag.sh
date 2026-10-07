#!/bin/sh
# Stub binary for unit tests: correct version but missing the with_wireguard tag.
cat <<'EOF'
sing-box version 1.14.2

Environment: go1.26.8 darwin/arm64
Tags: with_gvisor,with_openvpn,with_quic
Revision: deadbeef
CGO: enabled
EOF
