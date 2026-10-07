# Proxy Farm v2 — desktop app

One VPN subscription (HMA, ZoogVPN or Surfshark), many local SOCKS5/HTTP proxy
ports, each an independent tunnel with its own exit IP. Windows and macOS, in
the same release. Full design: `docs/superpowers/specs/2026-10-07-desktop-app-design.md`.

v1 (Docker-based) is archived at the `v1-docker` tag. v2 replaces it: no
Docker, no VM, no Python, no scripts, no terminal for the end user.

## Install (end users)

Download the latest release for your OS from
<https://github.com/huuhoa143/proxy-farm/releases>:

- **macOS**: the `.dmg` (or `.zip`). The app is notarized by Apple — no
  Gatekeeper workaround needed. If you downloaded it via a browser and macOS
  still shows it as "from an unidentified developer" the first time, that's
  normal first-run quarantine; right-click → Open once.
- **Windows**: `*.Setup.<version>.exe`. It is **unsigned** in this v1 of the
  Windows release (see "Why no Docker, and why is Windows unsigned?" below) —
  Windows SmartScreen will show a warning; click "More info" → "Run anyway".
  HMA support (optional) asks for one Administrator prompt during install;
  everything else, including auto-updates, needs none.

The app auto-updates itself via GitHub Releases (electron-updater). You don't
need to manually download new versions.

### Why no Docker?

v1 ran its VPN endpoints through Docker containers with TUN devices and
iptables rules — it needed Docker Desktop, admin/sudo, and broke in several
ways documented in the v1 history (port-500 stuck UDP, hairpin NAT, MTU/MSS
hacks). v2 runs every endpoint through **sing-box** in pure userspace mode
(`system: false` — no TUN, no driver, no admin, no routing-table changes).
That removes that entire bug class and the Docker Desktop dependency outright.

## Bring your own subscription

Proxy Farm doesn't sell or provide VPN access. You supply your own HMA,
ZoogVPN or Surfshark subscription (or a raw `.ovpn`/WireGuard `.conf` file),
and the app turns it into one or more local proxy ports. Respect your
provider's terms of service for bulk/multi-exit use; this is a personal-use
tool, not a commercial proxy reseller.

## Third-party / GPL notice

Proxy Farm bundles **sing-box** (https://github.com/SagerNet/sing-box),
licensed GPLv3, to run every VPN endpoint. Per GPLv3 §6 ("Conveying
Non-Source Forms"), the complete corresponding source for the exact
sing-box version bundled in each release is attached to that GitHub release
as a `.tar.gz` (alongside the installer/DMG/ZIP) — look for
`sing-box-<version>-src.tar.gz` on the release page. The pinned version and
its hashes live in `app/scripts/singbox.pins.json`; nothing is fetched or
verified against anything other than those pins.

## Developing / building from source

```bash
pnpm --dir app install
node app/scripts/prebuild-singbox.mjs     # fetches the pinned sing-box binary + GPL source tarball
pnpm --dir app run start                  # electron-forge start (dev)
pnpm --dir app exec vitest run            # unit tests
pnpm --dir app exec tsc --noEmit          # typecheck
```

Repo layout (see spec §8 for the authoritative version):

```
proxy-farm/
  app/            Electron (Forge + Vite + TS) — the desktop app
  helper/         Go Windows service + installer (HMA-only, Windows track)
  catalog/        hma.json feed
  docs/           specs, this README
```

### Releasing (maintainer-only, no CI — local-runner pipeline)

This mirrors lingoreup's local-runner release pipeline (spec §9): releases
are built and signed on the maintainer's own machine, not in CI, because
Apple notarization and (eventually) Windows code-signing both need
long-lived credentials that don't belong in a CI runner.

**macOS** (arm64, the primary release):

```bash
bash app/scripts/local-release.sh <X.Y.Z>              # full release
bash app/scripts/local-release.sh <X.Y.Z> --resume     # resume after a failure
bash app/scripts/local-release.sh <X.Y.Z> --dry-run    # rehearse through `make`, no git/notarize/upload
```

Steps: bump `app/package.json` + commit + tag + push → `pnpm run make` →
inside-out codesign (`app/scripts/sign-proxyfarm-bundle.sh`, identity
`Developer ID Application: Chien Bui Minh (CCQUC3AGRH)`, hardened runtime,
every bundled `sing-box` binary signed with its own entitlements since it's
a spawned child process) → notarize (keychain profile `PROXYFARM_NOTARIZE`)
→ staple + `spctl` → smoke-launch → ZIP + DMG → `latest-mac.yml` → GitHub
release, with the sing-box GPL source tarball attached.

**macOS dual-arch** (arm64 + Intel x64 in one release):

```bash
bash app/scripts/release-with-x64.sh <X.Y.Z>
```

Runs the arm64 release unchanged, then builds/signs/notarizes the x64 app
and republishes a **dual-arch** `latest-mac.yml` (arm64 listed first, so
legacy electron-updater clients that ignore arch filtering still get the
arm64 build).

**Windows** (x64, run on a Windows machine):

```powershell
powershell -ExecutionPolicy Bypass -File app\scripts\local-release.ps1 <X.Y.Z>
```

Builds the Go helper (`helper/`) first if present, otherwise skips that
step with a clear message (the helper build lands on a later track).
`pnpm run make` → NSIS installer (**unsigned** for now — a signing hook is
already wired into `forge.config.ts` for when a certificate exists) →
uploads `Setup.exe` + `latest.yml` + `.blockmap` + the sing-box GPL source
tarball to the same GitHub release.

Minimum supported macOS version is **12** (the floor sing-box's Go 1.26
toolchain requires); the release script checks `Info.plist` and refuses to
ship otherwise.
