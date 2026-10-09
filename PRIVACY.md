# Privacy policy

Last updated: 2026-10-08. Applies to the Proxy Farm desktop app (macOS and Windows).

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
| `state.json` | Settings, ports (location, port number, pinned server), account metadata such as the label you see in the app (for example a ZoogVPN email address or the HMA device id), port limits, server health notes. **Not encrypted, but holds no passwords or keys.** |
| `secrets/*.bin` | One encrypted file per secret: provider passwords, the Surfshark and NordLynx private keys, imported config files, the HMA device credentials, the proxy password and the webhook key. |
| `cache/surfshark-clusters.json`, `cache/surfshark-pools.json` | Surfshark's public server list and the server IPs found through DNS. |
| `cache/nordvpn-servers.json` | NordVPN's public server list (server IPs, load and WireGuard public keys). |
| `pids.json` | Process ids of running sing-box processes, so a crash does not leave them behind. |
| `state.json.v1.bak`, `state.json.corrupt-*` | Backups made only when an old or unreadable state file is replaced. |

Electron also keeps its usual browser-engine files there (for example local storage for
the theme choice).

**Secrets.** Secrets are encrypted with Electron `safeStorage`: the macOS Keychain on
macOS, DPAPI on Windows. If encryption is not available, secrets are kept in memory for
that session only and are never written to disk in plain text; the app shows a warning.

**HMA.** On macOS the app reads HMA's own credentials file
(`/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json`) to get the device
id and password. It does not change that file. The credentials are saved in the
encrypted secret store.

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
| `https://api.surfshark.com/v4/server/clusters/all` | When Surfshark is used; at most every 12 hours | Surfshark's public server list | Your real IP |
| Your system DNS resolver and `https://dns.google/resolve` | When Surfshark is used; at most every 12 hours | Find the servers behind each Surfshark location name | Your real IP (Google, for DoH) and the Surfshark hostnames you use |
| `https://api.nordvpn.com/v1/servers` | When NordVPN is used; at most every 12 hours; no account or token is sent | NordVPN's public server list | Your real IP |
| `https://api.nordvpn.com/v1/users/services/credentials` | Once, when you add a NordVPN account with an access token | Exchange the token for your NordLynx private key; the token is then discarded, never stored | Your real IP and the access token |
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
sees your real IP when you use them.

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
   Windows, use *Settings → Apps*.

On macOS, `safeStorage` also keeps one encryption key in your login keychain (an entry
named after the app, such as "Proxy Farm Safe Storage"). You can delete it in Keychain
Access.

## Third parties

Your VPN provider, GitHub, Google, Cloudflare, ipify, ifconfig.co and ipinfo.io have their
own privacy policies, which apply to the connections above. Proxy Farm does not share any
data with them beyond what those connections carry.

## Changes and contact

Changes to this policy are recorded in this file's git history. Questions:
[GitHub Discussions](https://github.com/huuhoa143/proxy-farm/discussions).
