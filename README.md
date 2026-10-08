# Proxy Farm

**English** · [Tiếng Việt](README.vi.md)

[![License: MIT](https://img.shields.io/github/license/huuhoa143/proxy-farm)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/huuhoa143/proxy-farm?include_prereleases&sort=semver)](https://github.com/huuhoa143/proxy-farm/releases)
![Platforms: macOS | Windows](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-lightgrey)

Proxy Farm is a desktop app that turns your own VPN subscription into many local
SOCKS5/HTTP proxy ports. Each port is an independent tunnel pinned to one VPN server,
so each port has its own stable exit IP.

![Proxy Farm main screen](docs/screenshots/v2/main-server-pools-en.png)

- **Runs on your computer.** No Docker, no VM, no admin rights, no terminal. Proxies
  listen on `127.0.0.1` by default.
- **Bring your own subscription.** Proxy Farm does not sell or provide VPN access.
- **No telemetry.** See [PRIVACY.md](PRIVACY.md) for every network call the app makes.

## Contents

- [Features](#features)
- [Supported providers](#supported-providers)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Building from source](#building-from-source)
- [Support](#support)
- [Security](#security)
- [Privacy](#privacy)
- [Contributing](#contributing)
- [Legal notice](#legal-notice)
- [Disclaimer](#disclaimer)
- [License](#license)
- [v1 (Docker)](#v1-docker)

## Features

- One port = one VPN server = one exit IP. A location with several servers can hold
  several ports, each with a different IP.
- Every port serves **both SOCKS5 and HTTP** on the same port number, with a proxy
  username and password generated on first run.
- **Change IP** moves a port to another free server of the same location and confirms
  the exit IP changed. Optional auto-rotate every N minutes.
- **Sticky exit IPs.** A dropped port retries the same server first. It moves to another
  server only when that server is judged dead or refuses your account.
- Live status per port (queued, connecting, verifying, online, retrying with a countdown
  and reason, failed with guidance), exit IP and country, latency.
- Per-port test and optional speed test; per-port logs in the Details drawer, with
  secrets redacted.
- Multiple accounts per provider; ports are spread across them.
- Bulk actions, and export in 4 formats: `host:port:user:pass`,
  `socks5://user:pass@host:port`, `host:port`, `curl`.
- Optional rotate webhook (off by default): `POST /rotate/<port-key>` with a Bearer key.
- Tray icon, launch at login (opt-in), keep-awake while ports are on, stop on sleep and
  restart on wake.
- English and Vietnamese UI, light and dark theme, in-app updates from GitHub Releases.

## Supported providers

| Provider | Protocol | What you enter | Notes |
|---|---|---|---|
| **HMA** | OpenVPN | Nothing: the app reads the device credentials of the HMA app installed on the same computer | On Windows, click **Enable HMA support** once (one administrator prompt); see below. |
| **ZoogVPN** | OpenVPN | Account email and password | Your plan decides which servers accept you; refused servers are skipped. |
| **Surfshark** | WireGuard | Your WireGuard private key (Surfshark manual setup page) | The server list comes from Surfshark's public API. |
| **Config file** | OpenVPN or WireGuard | A `.ovpn` or WireGuard `.conf` file | Works with other providers or your own server. |

Port limits per provider can be set in the app. Many simultaneous tunnels on one account
can trigger a provider's abuse detection; see the [Disclaimer](DISCLAIMER.md).

## Install

Download the latest build from
[GitHub Releases](https://github.com/huuhoa143/proxy-farm/releases).

- **macOS 12 or later** (Apple silicon or Intel): open the `.dmg` and drag Proxy Farm to
  Applications. Run it from Applications, not from the disk image, or it cannot update
  itself.
- **Windows (x64)**: run `Setup.exe`. The Windows build is **unsigned**, so SmartScreen
  shows a warning: click *More info* → *Run anyway*. It installs for your user only and
  needs no administrator rights.

## Quick start

1. Open Proxy Farm and pick a provider on the first screen (HMA, ZoogVPN, Surfshark or
   Config file). For HMA, install the HMA app, sign in and connect once; Proxy Farm
   picks up its credentials.
   On Windows, HMA keeps those credentials in a file only administrators can read, so the
   HMA card first shows **Enable HMA support**. It asks for administrator approval once and
   sets up a small Windows task that keeps a copy only you and administrators can read;
   updates need no approval. The task removes itself when Proxy Farm is uninstalled.
2. Click **Add locations**, choose locations and how many ports each.
3. When a port shows **Online**, use it:

   ```bash
   curl -x socks5h://USER:PASS@127.0.0.1:29001 https://ipinfo.io
   curl -x http://USER:PASS@127.0.0.1:29001 https://ipinfo.io
   ```

   The username and password are shown under **Proxy login** on the main screen.

To use the proxies from other devices, turn on **Share on the local network** in
Settings. The ports then listen on `0.0.0.0`; this requires a proxy username and
password, and you should keep the ports behind a firewall.

## How it works

```
Proxy Farm (Electron)
  UI ── IPC only ──► main process: providers, server pools, health, store
                          │ spawns one process per port, config on stdin
                          ▼
  sing-box #1  127.0.0.1:29001 ──► VPN server A (exit IP A)
  sing-box #2  127.0.0.1:29002 ──► VPN server B (exit IP B)
```

- Each port runs its own unmodified [sing-box](https://github.com/SagerNet/sing-box)
  1.14.2 process in userspace mode: no TUN device, no driver, no routing-table changes.
- The only route out of a port is its tunnel. If the tunnel is down, the proxy fails
  instead of falling back to your real connection. DNS inside a port goes over DoH to
  `1.1.1.1` through the tunnel.
- Configs, keys and certificates are passed to sing-box on stdin and never written to
  disk.
- Health is checked through each tunnel: a connectivity probe every 30 s, and an exit-IP
  and country check after each start, on Change IP and when you test a port. Failed
  ports retry with back-off from 30 s up to 30 min.

The design document is
[docs/superpowers/specs/2026-10-07-desktop-app-design.md](docs/superpowers/specs/2026-10-07-desktop-app-design.md).

## Building from source

Requirements: Node.js 22 (≥ 22.22.2) or 24 (≥ 24.15.0), and pnpm. Everything runs in
`app/`:

```bash
cd app
pnpm install
pnpm start           # fetch sing-box, then run the app in development mode
pnpm test            # unit tests (vitest)
pnpm exec tsc --noEmit
pnpm make            # build installers for the current platform
```

`pnpm start`, `pnpm package` and `pnpm make` first download the pinned sing-box binary
and its source tarball, checking the sha256 values in `app/scripts/singbox.pins.json`.
After that, `pnpm dev` runs the app without the download step. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the project layout.

## Support

Ask questions in [GitHub Discussions](https://github.com/huuhoa143/proxy-farm/discussions)
and report bugs in [Issues](https://github.com/huuhoa143/proxy-farm/issues). See
[SUPPORT.md](SUPPORT.md) for what to include and what never to post.

## Security

Do not report vulnerabilities in public issues. Use
[private vulnerability reporting](https://github.com/huuhoa143/proxy-farm/security/advisories/new).
See [SECURITY.md](SECURITY.md).

## Privacy

Proxy Farm collects nothing and has no telemetry or analytics. Your settings stay on your
computer and secrets are encrypted with the operating system's key store. The app
contacts only your VPN provider's servers and a short list of services named in
[PRIVACY.md](PRIVACY.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Legal notice

This tool uses **your own VPN account** on **your own computer**. VPN providers usually
**forbid sharing or reselling** connections: do not expose the proxies to the internet or
share them with others. You are responsible for following your provider's terms of
service and the laws where you live. Aggressive reconnect attempts, many simultaneous
tunnels, or sharing can get your VPN account suspended by the provider.

This project is not affiliated with HMA, Gen Digital, Surfshark, ZoogVPN or any other VPN
provider.

## Disclaimer

The software is provided **"as is", without warranty of any kind**. You use it at your
own risk. The project does not guarantee availability, speed, number of IPs, or
compatibility with any provider, and providers may change their systems at any time.
Trademarks belong to their owners. Read the full text in [DISCLAIMER.md](DISCLAIMER.md).

## License

[MIT](LICENSE). Proxy Farm bundles sing-box (GPL-3.0-or-later) as a separate, unmodified
program, plus other third-party components; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## v1 (Docker)

The earlier Docker-based edition (manager, per-port containers, IKEv2 support) is
archived at the [`v1-docker`](https://github.com/huuhoa143/proxy-farm/tree/v1-docker)
tag. It is no longer developed.
