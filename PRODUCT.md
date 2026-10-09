# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(This record covers the marketing site in `site/`. The product itself is a desktop app for macOS and Windows, built with Electron, in `app/`.)

## Stack

Site: static Astro, deployed to Cloudflare (Workers static assets) at proxyfarm.lingoreup.com. The user approved this on 2026-10-09.

## Users

- **People who already pay for a VPN** and want to reuse that subscription as proxies for their own apps and browsers.
- **MMO, marketing and multi-account operators.** They need many clean exit IPs, each fixed to one account or browser profile.
- **Data collection and research.** Scraping, price tracking and regional SEO checks from many locations.
- **Developers and QA** who test geo-dependent content, pricing and ads per country.

Most users are Vietnamese; English-speaking visitors are secondary. The site defaults to Vietnamese and has an English switch.

## Product Purpose

Proxy Farm turns the user's own VPN subscription into many local SOCKS5/HTTP proxy ports on their computer. Each port is an independent tunnel pinned to one VPN server, so each port keeps its own stable exit IP. Success means a user who already has a VPN gets dozens of reliable, separately addressable IPs in minutes, with no server, Docker or terminal.

## Positioning

- **Bring your own VPN.** Proxy Farm does not sell IPs or VPN access, so it is not a proxy reseller.
- **One port = one VPN server = one exit IP.** Server pools let a location hold several ports with different IPs. Change IP moves a port to another free server, and a dropped port sticks to its server.
- **Runs entirely on the user's computer, in userspace.** No admin rights, no system VPN, no routing changes. Each port runs its own unmodified sing-box engine.
- **Free and open source** (MIT) on GitHub, with no telemetry.

## Operating Context

- **Day-to-day use:** add a VPN account, pick locations, create ports, then copy or export proxies (host:port:user:pass, socks5 URL, curl, CSV, saved to a file) into browsers, anti-detect profiles, scrapers and test tools.
- **Health and upkeep:** monitor health, filter alive/dead ports, use Check all, Change IP, and auto-rotate.
- **Optional:** an HTTP rotate webhook; LAN sharing with a password.

## Capabilities and Constraints

- **Providers:**
  - HMA, using the device credentials of the locally installed HMA app (on Windows, after one administrator prompt to enable HMA support).
  - ZoogVPN, with email and password.
  - Surfshark, with a WireGuard private key.
  - NordVPN, with an access token or NordLynx key.
  - ExpressVPN, with its Manual-configuration OpenVPN username and password.
  - Imported OpenVPN `.ovpn` and WireGuard `.conf` files.
- **Platforms:** macOS 12+ (Apple silicon and Intel; signed and notarized by Apple) and Windows x64 (per-user installer, not code-signed, so SmartScreen warns).
- **Release state:**
  - Current public release: v0.2.0 (2026-10-09), with every provider, filters, Check all and CSV export.
  - Download buttons link to the GitHub release assets; the version lives in `site/src/data/site.ts`.
- **Constraints:**
  - Users must follow their VPN provider's terms of service.
  - Proxy Farm is not affiliated with any provider.
  - Provider names are trademarks of their owners.
- **Support:** GitHub Discussions and Issues only. There is no email and no paid support. Security reports go through SECURITY.md.

## Brand Commitments

- **Name and attribution:** "Proxy Farm by LingoReup". LingoReup is credited in the header or footer.
- **Assets:**
  - App icon: `app/icons/icon.png`, plus 256 and 512 px versions.
  - Real screenshots in `docs/screenshots/v2/`, in light and dark themes, vi and en.
- **Voice:** plain, precise and honest. No hype words or exaggerated claims; prefer facts the app actually does. The user wants a polished, executive-grade ("chuẩn CEO") presentation.

## Evidence on Hand

- **Real screenshots:** `docs/screenshots/v2/`.
- **Demo video:** recorded from the real app (feature list and evidence in CHANGELOG.md and the spec `docs/superpowers/specs/2026-10-07-desktop-app-design.md`).
- **Do not fabricate:** there are no testimonials, user counts, customer logos, press, benchmarks or pricing.

## Product Principles

1. **Honest about mechanism.** Say plainly that it is the user's own VPN, made into proxies on their machine.
2. **Stable identity per port.** Fixed IPs and predictable rotation are the core value.
3. **Zero setup friction.** Desktop app with no Docker, terminal or admin rights.
4. **Respect privacy and providers.** No telemetry, secrets encrypted locally, provider terms respected.

## Accessibility & Inclusion

WCAG 2.2 AA for the site. Vietnamese diacritics must render correctly in every font used.
