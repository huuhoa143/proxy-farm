# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
desktop app follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- ZoogVPN: a refused sign-in is now told apart from a server outside your plan by a
  live check on a ZoogVPN free server, instead of being guessed from how many servers
  refused it (0.1.0 could tell a new account on a restrictive plan that its password was
  wrong). "Check" makes one short test connection before the account is saved: a wrong
  email or password is rejected with that message, and if no free server answers the
  account is added as unverified. A port refused by a server checks the login the same
  way (at most once per 10 minutes per account) and then either moves on as a plan
  refusal or stops with "wrong email or password". A location where every server
  refuses a working login says so: "Your ZoogVPN plan doesn't include this location".
- The location picker marks a location whose every server refused every account of its
  provider as "Not in your plan", with the reason as a tooltip and its quantity stepper
  disabled; its "+ Add port" says the same. The Change IP menu tags free-tier servers.
- A location that covers a whole country (most ZoogVPN locations) is named after the
  country in the UI language: "Đức", not "Germany" or "Germany Đức", in the picker, the
  group header, the port labels and the Change IP menu heading.
- With no free server left, the Change IP menu no longer promises to try "another city
  in the same country" when the provider has no other location there (ZoogVPN Japan);
  it says the port keeps its server.

### Fixed

- Two engines starting at the same moment (a sign-in check while ports start, or
  several ports at once) could be given the same control port, or the same proxy port,
  and the second sing-box then exited at once on its bind. Ports picked by a start in
  progress now count as taken for every other start, and a start on a port another
  engine is starting on fails as "port in use" before anything is spawned.
- The Change IP menu could list a server as free and untried when it was only another
  hostname of a machine that had already refused the account (`fr4` next to a refused
  `de7`), because that hostname had not been looked up yet. Opening the menu now looks
  up the location's hostnames first (in parallel, each once, for at most 2 s), so such a
  server shows as refused or taken before you pick it. Picking it never cost a
  connection attempt; it only looked available until then.
- The location picker showed a location that had just turned out not to be in the plan
  as "No free server" until the app was restarted: it re-read the locations only when a
  port changed servers. The app now tells the window whenever a server is marked
  refused, dead or working, and the picker and the group headers update within a
  moment. A location group outside the plan now says "Not in your plan" in its header
  instead of a free-server count.
- A Change IP to a server outside the plan left the port failed on that server ("not in
  your plan, not retrying") and gave up the server it had been working on, although
  other servers of the location were free. The refused server is still remembered, but
  the port now goes back to the server it was on before, or, if that one is no longer
  usable, to the next free usable server of the location. The row says which server
  refused and where the port went. It fails for good only when no usable server is
  left. Any other refusal of a port that was online follows the same rule, during a
  Change IP too, and a login that a server accepted moments ago is no longer re-checked
  with an extra connection.
- A port that failed for good (sign-in rejected, location not in the plan, WireGuard key
  not answered) kept starting a new engine about every 41 s against a server that had
  just refused it, while the row said it would not retry. Such a port now stops its
  engine and stays failed until you start it, change its IP or enter new credentials;
  app start, wake from sleep, auto-rotate and the webhook leave it alone.
- The retry back-off restarted at 30 s on every attempt instead of growing to 30 min.
- Server marks (refused, dead, last OK) now belong to the machine, keyed by its resolved
  IP, so they apply to every hostname that points at it: after `de7.webunlim.com` refused
  an account, `fr4.webunlim.com` (the same server) is skipped without another handshake.
  Marks saved by 0.1.0 under hostnames move onto the IP the first time each host
  resolves, and the hostname-to-IP map is saved with them.

## [0.1.0] — 2026-10-08

First release of the desktop app. It replaces the Docker edition (v1, archived at the
`v1-docker` tag) and does not import v1 data.

### Added

- Desktop app for macOS 12+ (Apple silicon and Intel), built with Electron. The
  Windows x64 build is code-complete but not released yet. No Docker, VM, Python,
  admin rights or terminal needed.
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

[Unreleased]: https://github.com/huuhoa143/proxy-farm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/huuhoa143/proxy-farm/releases/tag/v0.1.0
