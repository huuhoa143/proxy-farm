#!/bin/sh
# Stub binary for unit tests: reports a version other than the pinned 1.14.2.
cat <<'EOF'
sing-box version 1.13.0

Environment: go1.26.8 darwin/arm64
Tags: with_gvisor,with_wireguard,with_openvpn
Revision: deadbeef
CGO: enabled
EOF
