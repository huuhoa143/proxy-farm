# Privacy policy

Last updated: 2026-10-24. Applies to the Proxy Farm desktop app (macOS and Windows).

## Summary

- Proxy Farm **collects nothing**. There is no telemetry, no analytics, no crash
  reporting and no account with us.
- Everything the app stores stays on your computer. Passwords and keys are encrypted with
  your operating system's key store.
- The app talks only to your VPN provider and to the services listed below, for the
  reasons given.

## What stays on your computer

All files live in the app's data folder (Electron's `userData` folder):

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/Proxy Farm/` |
| Windows | `%APPDATA%\Proxy Farm\` |

| File | Contents |
|---|---|
| `state.json` | Settings, ports (location, port number, pinned server), account metadata such as the label you see in the app (for example a ZoogVPN email address or the HMA device id), server health notes. For HMA it also keeps the non-secret parts of the device the app registered (a fingerprint derived from this machine, the tenant and container ids, the device id and the OpenVPN CA certificate), plus a masked hint of the license key — never the key itself. **Not encrypted, but holds no passwords or keys.** |
| `secrets/*.bin` | One encrypted file per secret: provider passwords, the Surfshark and NordLynx private keys, imported config files, the HMA device credentials and **HMA license key**, the proxy password and the webhook key. |
| `cache/surfshark-clusters.json`, `cache/surfshark-pools.json` | Surfshark's public server list and the server IPs found through DNS. |
| `cache/nordvpn-servers.json` | NordVPN's public server list (server IPs, load and WireGuard public keys). |
| `cache/expressvpn-pools.json` | The server IPs found through DNS for ExpressVPN's location names. |
| `cache/hma-geos.json`, `cache/hma-se-catalog.json` | HMA's public location list and the gateway IPs discovered for each location. |
| `pids.json` | Process ids of running sing-box processes, so a crash does not leave them behind. |
| `state.json.v1.bak`, `state.json.corrupt-*` | Backups made only when an old or unreadable state file is replaced. |

Electron also keeps its usual browser-engine files there (for example local storage for
the theme choice).

**Secrets.** Secrets are encrypted with Electron `safeStorage`: the macOS Keychain on
macOS, DPAPI on Windows. If encryption is not available, secrets are kept in memory for
that session only and are never written to disk in plain text; the app shows a warning.

**HMA.** You add HMA by entering your HMA license (activation) key. Proxy Farm registers
its **own** device with HMA's backend (the Avast/NLOK SecureLine "se-platform" service
the HMA app itself uses) — it does not read or change the HMA app's files or device. From
the license key it looks up your subscription, registers a device identified by a
fingerprint derived from this machine, and fetches that device's OpenVPN credentials and
CA certificate. It then asks the backend which gateways serve a location (the same
"discover" call the HMA app makes on connect), so locations and exit IPs stay fresh and
rotate like the real app. The device's username and password **and your license key** are
kept in the encrypted secret store; only the non-secret device identity (fingerprint,
tenant/container/device ids, CA) and a masked hint of the license key are in `state.json`
(see the table above), so the app can renew the device and its short-lived token without
asking you again. These requests go directly from your computer, so HMA/Avast sees your
real IP and your license key, exactly as its own app does.

**Tunnel configs.** sing-box configs, keys and certificates are passed to sing-box on
standard input and never written to disk.

**Logs.** Per-port logs are kept in memory only (a fixed-size buffer per port) and are
gone when the app quits. Usernames, passwords, keys, the HMA device id and long hex
tokens are redacted before a line is stored.

## Network connections

The app makes these connections. Nothing else is contacted.

| Destination | When | Why | What it sees |
|---|---|---|---|
| Your VPN provider's servers | When a port starts | To build the tunnel | Your real IP and your credentials, as with the provider's own app |
| `https://my-win.avast.com/v1/query/get-exact-application-licenses` | Once, when you add an HMA license key | Look up the subscription behind your HMA license key | Your real IP and the license key |
| `https://api.se-platform.com/…` (`aladdin`, `passage`, `discovery/geos`, `discovery/discover`, `elysium`) | When HMA is used: registering the device, renewing its token (~12 h), listing locations (at most every 12 h), and discovering gateways on add / Change IP / a 2-minute refresh for active locations | Register Proxy Farm's HMA device, fetch its connection credentials, and get fresh gateway IPs — the same backend the HMA app uses | Your real IP, the license key, and the device identity |
| `https://api.surfshark.com/v4/server/clusters/all` | When Surfshark is used; at most every 12 hours | Surfshark's public server list | Your real IP |
| Your system DNS resolver and `https://dns.google/resolve` | When Surfshark is used; at most every 12 hours | Find the servers behind each Surfshark location name | Your real IP (Google, for DoH) and the Surfshark hostnames you use |
| `https://api.nordvpn.com/v1/servers` | When NordVPN is used; at most every 12 hours; no account or token is sent | NordVPN's public server list | Your real IP |
| `https://api.nordvpn.com/v1/users/services/credentials` | Once, when you add a NordVPN account with an access token | Exchange the token for your NordLynx private key; the token is then discarded, never stored | Your real IP and the access token |
| Your system DNS resolver and `https://dns.google/resolve` | When ExpressVPN is used; at most every 12 hours. ExpressVPN itself gets no request: its server list is bundled with the app | Find the servers behind each ExpressVPN location name (`*.expressnetw.com`) | Your real IP (Google, for DoH) and the ExpressVPN hostnames |
| Your system DNS resolver | Before a port connects to a server given by hostname (ZoogVPN, config files) | Resolve the server address | The VPN server hostnames |
| `1.1.1.1` (Cloudflare DNS over HTTPS) | While a port is used | DNS for traffic you send through the proxy | The tunnel's exit IP, not yours |
| `https://www.gstatic.com/generate_204` | Every 30 s per running port | Check the tunnel works | The tunnel's exit IP, not yours |
| `https://api.ipify.org`, `https://ifconfig.co/json`, `https://ipinfo.io/json` | After each port start, on Change IP and when you test a port; tried in that order until one answers with a country | Learn the exit IP and its country | The tunnel's exit IP, not yours |
| `https://speed.cloudflare.com/__down` | Only when you run a speed test | Measure download speed | The tunnel's exit IP, not yours |
| GitHub Releases of `huuhoa143/proxy-farm` | On start and once a day if "Check for updates automatically" is on (default), or when you click "Check for updates" | Check for and download updates | Your real IP and the app version |

The connectivity, exit-IP and speed checks go **through the tunnel**, so those services
see the VPN exit IP, not your own. The Surfshark list and DNS lookups go directly from
your computer, so they reveal that you use Surfshark and which locations. Likewise the
NordVPN server list and the token exchange go directly from your computer, so NordVPN
sees your real IP when you use them. The ExpressVPN DNS lookups go directly too, so your
DNS resolver and Google see which ExpressVPN locations the app looks up (all of them,
not only the ones you use). The HMA (Avast/NLOK se-platform) calls go directly from your
computer too, so HMA/Avast sees your real IP and your license key when you use HMA.

The optional rotate webhook is a local listener you turn on yourself. It does not
contact anything.

## Updates

Update checks use electron-updater against this repository's GitHub Releases. Turning
off "Check for updates automatically" in Settings stops the automatic checks. Updates are
installed only when you choose.

## Deleting your data

1. Quit Proxy Farm (from the tray icon: *Quit Proxy Farm*).
2. Delete the data folder:
   - macOS: `~/Library/Application Support/Proxy Farm/`
   - Windows: `%APPDATA%\Proxy Farm\`
3. Uninstall the app: on macOS, move Proxy Farm from Applications to the Trash; on
   Windows, use *Settings → Apps*. Deleting the data folder in step 2 removes the HMA
   license key, device identity and discovered gateways with it. The HMA device Proxy Farm
   registered stays on your HMA account's device list until you remove it there.

On macOS, `safeStorage` also keeps one encryption key in your login keychain (an entry
named after the app, such as "Proxy Farm Safe Storage"). You can delete it in Keychain
Access.

## Third parties

Your VPN provider, HMA/Avast (NLOK), GitHub, Google, Cloudflare, ipify, ifconfig.co and
ipinfo.io have their own privacy policies, which apply to the connections above. Proxy Farm
does not share any data with them beyond what those connections carry.

## Changes and contact

Changes to this policy are recorded in this file's git history. Questions:
[GitHub Discussions](https://github.com/huuhoa143/proxy-farm/discussions).
