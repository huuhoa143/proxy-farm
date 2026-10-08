# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
desktop app follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.1.0

First release of the desktop app. It replaces the Docker edition (v1, archived at the
`v1-docker` tag) and does not import v1 data.

### Added

- Desktop app for macOS 12+ (Apple silicon and Intel) and Windows x64, built with
  Electron. No Docker, VM, Python, admin rights or terminal needed.
- One unmodified sing-box 1.14.2 process per proxy port, in userspace mode (no TUN, no
  driver, no routing changes). Configs are passed on stdin and never written to disk.
  Each port's only route out is its tunnel; DNS goes over DoH through the tunnel.
- Providers: HMA (OpenVPN with the device credentials of the locally installed HMA app;
  macOS only for now), ZoogVPN (OpenVPN, email and password), Surfshark (WireGuard
  private key) and imported OpenVPN `.ovpn` / WireGuard `.conf` files.
- Server pools: each location is a pool of servers and each port pins one server, so
  every port has its own fixed exit IP and a location can hold several ports.
- **Change IP** moves a port to another free server of its location (or, if none is
  left, a location in the same country, with a note on the row) and confirms the exit IP
  changed. A server can be picked by hand from the Change IP menu. Auto-rotate every N
  minutes.
- Per-server failover with sticky IPs: a dropped port retries its own server; it moves
  only when the server refuses the account (remembered 7 days) or fails a fresh
  reconnect (remembered 2 hours). Drops shared by several ports of a provider are treated
  as an outage, not as dead servers.
- Surfshark server pools discovered in the app by sampling cluster DNS (system resolver
  and `dns.google`), refreshed at most every 12 hours.
- Health checks through each tunnel, exit-IP and country checks, back-off from 30 s to
  30 min, staggered starts.
- Multiple accounts per provider, per-provider port limits, bulk actions, export in four
  formats, per-port test and speed test, per-port logs with secrets redacted.
- Optional rotate webhook (off by default) with a Bearer key and Host allowlist.
- Proxies listen on `127.0.0.1`; LAN sharing (`0.0.0.0`) requires a proxy username and
  password.
- Secrets encrypted with Electron `safeStorage` (macOS Keychain, Windows DPAPI).
- Tray icon, launch at login, keep-awake while ports are on, stop on sleep and restart on
  wake, single instance.
- In-app updates from GitHub Releases (electron-updater), with automatic checks that can
  be turned off.
- English and Vietnamese UI, light and dark theme.
- Project documentation: English and Vietnamese README, privacy policy, security and
  support policies, contributing guide, code of conduct, third-party notices.

### Removed

- Docker, the web UI on port 8090, the CLI and IKEv2 support. They remain available on
  the `v1-docker` tag.

## v1 — Docker edition (archived)

The Docker-based edition is archived at the
[`v1-docker`](https://github.com/huuhoa143/proxy-farm/tree/v1-docker) tag and is no
longer developed.

[Unreleased]: https://github.com/huuhoa143/proxy-farm/compare/v1-docker...HEAD
