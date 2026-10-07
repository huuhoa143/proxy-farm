# Proxy Farm v2 — Desktop App (Windows + macOS, no Docker)

- **Status:** approved design, 2026-10-07
- **Supersedes:** the Docker-based v1 (tagged `v1-docker` before v2 work lands)
- **Evidence:** feasibility spike 2026-10-07 (see §11). Every claim marked ✅ was run for real; ⚠️ = not yet verified.

## 1. Goal

Ship Proxy Farm as a desktop app that a non-technical user downloads, installs, and uses:

- Windows and macOS in the **same release**.
- **No Docker, no VM, no Python, no scripts, no terminal.**
- One VPN subscription → many local SOCKS5/HTTP proxy ports, each port an independent tunnel with its own exit IP.
- UI in **English and Vietnamese**.

Success criteria:

1. A user with HMA on a Mac goes from "open the app" to a working proxy in under 2 minutes with no admin prompt.
2. On Windows the only privilege prompt ever shown is one UAC during install, and only if they opt in to HMA support.
3. Auto-update never prompts for admin.
4. 20 simultaneous ports run stable for 24 h on a laptop.

## 2. Key decisions (and why)

| Decision | Why |
|---|---|
| **One engine: sing-box (≥ 1.14.2, pinned), userspace only** (`system: false`) | ✅ Its WireGuard and OpenVPN endpoints run on an internal gVisor stack. That means no TUN, no driver, no admin, and no routing-table conflicts. It removes every Docker-era bug class: the port-500 stuck UDP flow, hairpin NAT, Docker Desktop wedges, iptables kill-switch, MTU/MSS hacks. |
| **Only two protocols: OpenVPN + WireGuard. IKEv2 dropped.** | ✅ HMA accepts its *device* credentials over OpenVPN (§5.1), ZoogVPN offers OpenVPN, Surfshark uses WireGuard. IKEv2 would have needed a forked userspace stack (go-ipsec) for no remaining benefit. |
| **One sing-box process per port** | ✅ sing-box cannot add or remove an endpoint at runtime; reload rebuilds everything and drops all tunnels. Rotation is frequent, so isolation matters more than RAM. Measured ~20 MB per process; 20 ports ≈ 400 MB. Sharded mode is a later optimisation, not v1. |
| **Electron (Forge + Vite), modelled on lingoreup** | Same toolchain, release pipeline and updater the team already runs. |
| **Controller in TypeScript inside Electron main** | Replaces `farm.py`/`vendors.py`. Ships no Python runtime. |
| **Windows HMA: one UAC at install → tiny privileged helper service** | HMA's Windows credential file is admin-only and its password rotates. A per-user app plus a separate service means the app auto-updates without UAC. |
| **sing-box shipped unmodified** (GPL-3, separate process) | Keeps the app MIT. Ship the license and a source link. Don't use the "sing-box" name in the product name. |

## 3. Architecture

```
┌──────────────────────────── Proxy Farm.app (Electron) ─────────────────────────────┐
│  Renderer: UI (vi/en)  ◄──── HTTP 127.0.0.1:<ui-port> (same /api/* as v1) ────┐     │
│                                                                                │     │
│  Main process: Controller (TypeScript)                                         │     │
│   ├─ Providers   hma · zoogvpn · surfshark · file   (setup/check/targets/bind) │     │
│   ├─ Catalogs    hma (bundled + feed) · surfshark API · zoogvpn (bundled)      │     │
│   ├─ PortManager start/stop/rotate/auto-rotate → render config → spawn engine ─┼──┐  │
│   ├─ Health      /delay probe + exit-IP probe → state machine                  │  │  │
│   ├─ Backoff     30 s → 30 min + jitter, bad-IP memory, staggered starts       │  │  │
│   ├─ Power       powerSaveBlocker · suspend → graceful stop · resume → restart │  │  │
│   ├─ Secrets     safeStorage (Keychain / DPAPI)                                │  │  │
│   └─ LocalAPI    UI + webhook /api/rotate (key) + export ──────────────────────┘  │  │
└───────────────────────────────────────────────────────────────────────────────────┼──┘
                                                                                    │ spawn
   sing-box #1  mixed 127.0.0.1:29001 → openvpn-client (HMA Tokyo)        ◄─────────┤
   sing-box #2  mixed 127.0.0.1:29002 → wireguard (Surfshark US)          ◄─────────┤
   sing-box #N  …                                                         ◄─────────┘

   Windows only:  ProxyFarm Helper (Go, LocalSystem service) ──named pipe──► Controller
                  reads %ProgramData%\Privax\HMA VPN\HmaProVpn\auth
```

Each unit, independently testable:

- **Provider plugins** — pure functions: input = account data + catalog, output = a list of targets and a per-target endpoint spec. No I/O beyond what's injected.
- **ConfigRenderer** — target + settings → sing-box JSON. Pure. Enforces the invariants in §6.
- **EngineSupervisor** — owns one child process per port: spawn, stdout/stderr log ring, exit detection, graceful stop (SIGINT / CTRL_BREAK, then kill after 6 s).
- **Health + Backoff** — consumes probes, emits per-port state for the UI. Same states as v1: queue / handshake / verify / online / wait(countdown, reason) / stopped.
- **HelperClient** (Windows) — pipe client with server-identity verification.

## 4. User experience

### 4.1 First run

1. **Language.** Defaults to the OS language; there is a switch in the header and in Settings.
2. **"Add a provider" screen** with four large cards: HMA · ZoogVPN · Surfshark · Config file.
   - **HMA**: the app auto-detects the local HMA install.
     - Found → "✅ HMA found — Connect".
     - Not found / no credentials yet → step-by-step: "Install HMA, sign in, connect once, then come back". The app watches the file and continues automatically.
   - **ZoogVPN**: email + password → "Check" (one test connection).
   - **Surfshark**: paste the WireGuard private key, with an illustrated guide to my.surfshark.com → Manual setup.
   - **File**: drag & drop `.ovpn` / `.conf`. Country is guessed from the file name and editable.
3. **Main screen**: pick countries/cities → **Start**. Each row shows status, `127.0.0.1:port`, exit IP and country, latency, **Copy** and **Rotate IP**.

### 4.2 Features carried over from v1

Multi-select + bulk actions, export in 4 formats, auto-rotate every N minutes, rotate webhook, proxy username/password, per-provider port limits, light/dark theme, live retry countdown with reason.

### 4.3 New in v2

- Tray icon with online count and quick actions.
- Launch at login (opt-in).
- Keep the computer awake while ports are on.
- Clean shutdown on sleep, staggered restart on wake.
- Auto-update.
- **No telemetry** (our own product decision). The app contacts only VPN servers, provider APIs (Surfshark list), the GitHub release/catalog feed, and an IP-echo service for exit-IP checks.
- Proxies listen on `127.0.0.1` only. Exposing to the LAN is an explicit Settings toggle with a warning.

### 4.4 UI work

- Start from v1 `manager/ui.html` and redesign it for the new flow: onboarding, provider cards, tray. Remove all Docker/script wording.
- **All strings come from `i18n/{en,vi}.json`**, with no hard-coded copy.
- The redesign goes through the impeccable skill. Screenshots are approved by the owner before merge.

## 5. Providers

### 5.1 HMA — OpenVPN with device credentials ✅

- **Credentials**: `username = udid`, `password = credentials.password` (64 hex). Both come from the HMA device blob:
  - **macOS**: `/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json`. It is world-readable; the value is base64 JSON under `DeviceManager.device`. No admin needed. The app watches the file and re-imports when it changes.
  - **Windows** ⚠️: `%ProgramData%\Privax\HMA VPN\HmaProVpn\auth` (line 1 user, line 2 pass), readable by admins only and rotated periodically. It is read by the Helper (§7). Expected to be the same udid/password form; **verify first** on a Windows machine.
- **Server**:
  - UDP 1194 to a per-location IP from the catalog.
  - TLS server cert is publicly issued: `CN=openvpn.gen-vpn.com`, chain Sectigo OV R36 → **Sectigo Public Server Authentication Root R46**.
  - Bundle that root PEM, set `tls.server_name: openvpn.gen-vpn.com`, `remote_certificate_tls: server`.
- **Pushed by server**: AES-256-GCM, `compress migrate`, `ping 10`, `ping-restart 60`. Set `data_ciphers: ["AES-256-GCM"]`, `route_no_pull: true`, `explicit_exit_notify: 2`, `mtu: 1400`.
- **Concurrency**: ✅ 8/8 simultaneous tunnels on one device, each exiting at its own server IP. v1 IKEv2 ran 48. Default limit: none.
- **Credential stability** ✅: when the HMA app renews its session it rewrites `tokenCoreSE.json`, but only the token changes. `udid` and `password` stayed identical. The file watcher re-reads the file and restarts ports only when `udid`/`password` actually change.
- **Coexistence with the HMA app (or any full-tunnel VPN)**: while the HMA app's own VPN is connected on the same machine it captures host traffic and farm tunnels drop (seen in v1).
  - Detection ✅ (macOS, HMA in IKEv2 mode): an `ipsec0` interface appears and the **default route moves to it**. HMA does *not* appear in `scutil --nc list`, so that can't be used.
  - Rule: warn when the host default route goes through a tunnel interface: macOS `ipsec*`/`utun*`, Windows a VPN/TAP/Wintun adapter. This also catches other VPN apps.
  - Banner: "A VPN on this computer (e.g. the HMA app) is connected — disconnect it; keep HMA installed and signed in." Re-checked every 10 s and after network changes.
  - ⚠️ Not yet observed: HMA's Mimic/WireGuard modes (expected `utun*` default route) and Windows.
- **Device lifetime** ⚠️ (not tested, testing would sign out the owner's device): the credentials belong to an HMA device slot. If the user signs out, uninstalls HMA or removes the device from their account, tunnels fail with `AUTH_FAILED`. Surface that specific reason ("HMA device signed out — open the HMA app and sign in") rather than a generic retry.
- Obsolete: the old Privax "hidemyass.com" CA and shared client cert shipped by gluetun (expired 2026-09-12) are not used by current servers.
- **Account email/password does NOT work** for tunnels: ✅ OpenVPN `AUTH_FAILED`, IKEv2 silent. Don't offer it. Device credentials only.
- **Catalog**:
  - The seed is v1's `hma-ovpn-seed.json` (115 locations; from PR #2).
  - `<CC>.ult.surfeasy.mobi` does **not** serve OpenVPN (✅ tested), so IPs must come from the catalog.
  - Refresh:
    1. **Primary: a catalog feed** JSON published in this repo and fetched daily, regenerated by the maintainer with the Windows enumerator. ✅ The 2026-10-06 seed IPs still worked on 2026-10-07 (8/8).
    2. Always: bad-IP failover (§6).
    3. Not pursued in v1: HMA's own discovery API (`api.se-platform.com/discovery/v8/location`). It exists, but the static `SE-Client-API-KEY` found in `VPNEngine` returns `Invalid API Key` (✅ tested). It also needs a fresh elysium token, and renewing that from outside could break the user's HMA app session.

### 5.2 ZoogVPN — OpenVPN ✅

- Credentials: username/password = the account login.
- Config: AES-256-GCM, auth SHA256, `tls-auth` key-direction 1, `remote-cert-tls server`. UDP 1194 / TCP 443.
- One shared CA ("Easy-RSA CA", valid to 2032) and one shared tls-auth key, both bundled.
- Server list bundled (source: `haugene/vpn-configs-contrib`).
- Plan refusals (`AUTH_FAILED` on servers outside the plan) are cached per (account, server) for 7 days and shown as "not in your plan". Same idea as v1.

### 5.3 Surfshark — WireGuard ✅

- Credential: the WireGuard private key. Inner address `10.14.0.2/16`, peer = the cluster's pubKey, port 51820, `mtu: 1280`, keepalive 25.
- Clusters come from the public API, cached 12 h.
- **Re-resolve the host and rotate the peer IP when a probe fails.** ✅ Saw IPs go stale within minutes.
- Exit country = the geo-IP result, not the label (virtual locations).

### 5.4 Config file

- `.ovpn` → openvpn-client endpoint: parse remote, proto, cipher, auth, ca, tls-auth/tls-crypt, auth-user-pass (prompt for credentials).
- `.conf` (WireGuard) → wireguard endpoint.
- Unsupported directives are rejected with a clear message rather than ignored.

## 6. Engine config invariants (enforced in ConfigRenderer, unit-tested on every config)

1. `route.final = "block"`. ✅ Endpoints accept unsolicited inbound traffic, which would otherwise reach localhost services.
2. One `mixed` inbound per process, `listen: 127.0.0.1` unless LAN sharing is on, optional username/password.
3. DNS: a per-inbound DNS rule pointing at a DNS server detoured through that port's endpoint, `final` → a null resolver, `strategy: ipv4_only`.
   - ✅ Without the per-inbound rule, all DNS leaked through the first endpoint.
   - The endpoint's own server hostname is resolved by the controller beforehand. Configs contain IPs only.
4. `system: false` on every endpoint. No TUN ever.
5. An API for health on a random loopback port with a random secret: `experimental.clash_api` (`/proxies/<tag>/delay`), plus the gRPC `api` service for OpenVPN status.
6. **No direct path to the internet exists in any config**: the only outbounds are the port's endpoint and `block`. IPv6 destinations therefore go through the tunnel or are blocked, never out of the host. A unit test asserts this, and an integration test asserts an IPv6 literal does not leave via the host.
   - ✅ Verified on a host with real IPv6 (Viettel `2402:800:…`): through an HMA port, IPv4 and dual-stack sites exit via NL; an IPv6-only site and an IPv6 literal are refused (`missing IPv6 local address`); nothing leaves via the host's IPv6.
7. Log level `warn`. stdout/stderr go into a per-port ring buffer that the UI shows under "Details".

**Health and back-off** (lessons from v1 kept verbatim):

- Probe `/delay` every 30 s, and probe the exit IP via the port every 5 min and after each (re)start.
- Failures → back-off 30 s, 1, 2, 4 … capped at 30 min, plus random jitter. Retry forever.
- Remember a bad server IP for 2 h and fail over to another IP for the same location.
- Never restart many ports at once: queue starts at ≤ 3 concurrent with 2–5 s spacing.
- Always stop gracefully, so OpenVPN sends exit-notify.
- **Rotate = verified change**: pick a different server IP for the location, restart the port, and confirm the exit IP actually changed. If it didn't (single-server location), report "no other server available" instead of claiming success.
  - ✅ For HMA, the exit IP equals the OpenVPN server IP (8/8 locations), and three separate sessions to the NL server all exited at the same IP. Reconnecting never rotates by itself; only a different server IP does.

## 7. Windows helper (HMA only)

- **Install**:
  - The NSIS installer is **per-user** (so updates need no UAC).
  - The option "HMA support" is pre-ticked when an HMA install is detected.
  - If ticked, it ShellExecutes `ProxyFarmHelper-install.exe` elevated (**the one UAC**). That copies the helper to `%ProgramFiles%\ProxyFarm\helper\` (ACL: SYSTEM + Administrators only) and registers a LocalSystem service (own process, per-service SID).
- **Surface**: exactly two requests over a named pipe:
  - `GetVersion`
  - `GetHmaCredentials` — returns user/pass plus file mtime. The service watches the file and pushes on change.
  - Nothing else: no file paths or commands from the client.
- **Pipe security**:
  - `PIPE_REJECT_REMOTE_CLIENTS`, message mode.
  - DACL: SYSTEM full; read/write only for the SID of the user who installed; deny `FILE_CREATE_PIPE_INSTANCE` to everyone else; deny Anonymous.
  - Server impersonates the client and checks the token user.
  - Client verifies the pipe server PID equals the registered service's PID (via SCM) and that the service runs as LocalSystem. This defeats pipe-name squatting.
  - When Windows builds become signed, the server additionally verifies the client's Authenticode signature.
    - ✅ HMA's own `api.xpc` does the equivalent: it carries a `SignatureCache` and a code-signing requirement (`anchor apple generic … certificate leaf[subject.OU] = …`).
  - **No shared secret in code.** Models: WireGuard-windows, OpenVPN interactive service, `clash-verge-service-ipc`. Anti-model: the archived `clash-verge-service`.
- **Updates**: the helper is outside the auto-update payload. The app checks `GetVersion` at start and re-runs the elevated installer only when the helper protocol version changes.
- macOS needs no helper.

## 8. Repo layout (branch `feat/desktop-v2` → v2)

```
proxy-farm/
  app/                    Electron (Forge + Vite + TS)
    src/main/             controller: providers/, catalogs/, engine/, health/, power/, api/, secrets/
    src/renderer/         UI (redesigned from v1 ui.html), i18n/{en,vi}.json
    resources/            sing-box/<platform-arch>/ (fetched by prebuild), ca/, catalogs/
    scripts/              prebuild-singbox.mjs (pinned version + sha256), local-release.sh,
                          release-with-x64.sh, local-release.ps1, sign-bundle.sh
  helper/                 Go Windows service + installer exe
  docs/                   specs, user guides (en/vi)
  (v1 docker files remain on tag v1-docker; removed from main when v2 ships)
```

## 9. Build & release (identical to lingoreup; local runners, no CI)

- **macOS** — `app/scripts/local-release.sh X.Y.Z [--resume|--dry-run]`, run on the maintainer's Mac:
  1. Bump, commit, tag, push.
  2. `electron-forge make`.
  3. Inside-out codesign with *Developer ID Application: Chien Bui Minh (CCQUC3AGRH)*, hardened runtime, every `sing-box` binary included.
  4. Notarize via notarytool (keychain profile `PROXYFARM_NOTARIZE`), staple, `spctl` verify.
  5. Smoke-launch.
  6. ZIP + DMG (notarized and stapled).
  7. `latest-mac.yml`.
  8. `gh release` on `huuhoa143/proxy-farm`.

  The x64 build runs through a `release-with-x64.sh` wrapper that produces a dual-arch `latest-mac.yml` (arm64 listed first).
- **Windows** — `app/scripts/local-release.ps1`, run on the maintainer's Windows machine:
  1. Build the helper.
  2. `electron-forge make` → NSIS.
  3. **Unsigned v1**, like lingoreup, with a signing hook left in the maker config.
  4. Upload `Setup.exe` + `latest.yml` + `.blockmap`.
- **Updates**: electron-updater against GitHub Releases.
- **sing-box**: version and sha256 pinned in `prebuild-singbox.mjs`. Upgrade only after the live smoke (§10) passes.

## 10. Testing

- **Unit (vitest)**:
  - ConfigRenderer invariants (§6), checked on every provider's output.
  - Parsers: tokenCoreSE blob, Windows `auth`, `.ovpn`, `.conf`, Surfshark API.
  - Back-off and failover scheduler with fake timers.
  - Catalog merge.
  - i18n key parity (en ⇔ vi).
- **Integration**: real sing-box against local test servers (WireGuard userspace peer, OpenVPN test server in a dev-only container). Covers spawn, health, rotate, graceful stop, and that the per-port DNS goes through the right tunnel.
- **Live smoke** (opt-in flag, real accounts, rate-limited: ≤ 1 attempt per location per 10 min): HMA ×3 locations, ZoogVPN ×2, Surfshark ×5. Assert the exit IP differs from the host IP and the country matches.
- **E2E**: Playwright against the packaged app: onboarding → start → copy → rotate → stop. Same as lingoreup.
- **Helper**:
  - Go unit tests for the pipe ACL and identity checks.
  - Manual Windows checklist: install with exactly one UAC; update shows no UAC; an HMA password rotation is picked up automatically; a squatted pipe name is refused.
- **Release gate**: signatures, notarization, smoke-launch, and the live smoke on the pinned sing-box.

## 11. Spike evidence (2026-10-07, macOS arm64, no sudo, no Docker)

| Test | Result |
|---|---|
| Surfshark WG, 1 port (socks5/socks5h/HTTP) | ✅ NL exit, first curl ~1.4 s |
| Surfshark WG, 50 ports in one process | ✅ 50/50 distinct exits; ~8 MB/endpoint (vmmap); ~3 fds/endpoint |
| ZoogVPN OpenVPN UDP + TCP | ✅ NL / VN exits, 4.8 MB/s down |
| HMA OpenVPN, Mac device creds, sing-box | ✅ NL exit, 2.7 MB/s; 8/8 concurrent (DE, GB, NL, AU×3, CA×2) |
| HMA with account email/password | ❌ OpenVPN AUTH_FAILED, IKEv2 silent. Account valid (official login OK) |
| `<CC>.ult.surfeasy.mobi` as OpenVPN server | ❌ not served |
| HMA discovery API with in-binary API key | ❌ `Invalid API Key` |
| hma-anywhere claims (IKEv2-EAP with account login) | ❌ disproven; their own docs mark the tunnel plane "not yet implemented" |
| No IPv6 leak through an HMA port (host has real IPv6) | ✅ |
| HMA app VPN on → `ipsec0` + default route via it | ✅ (`scutil --nc` shows nothing) |
| HMA session renewal keeps `udid`/`password` | ✅ |
| Per-location P2P/streaming flags in HMA's location cache | ❌ absent (only for the currently selected location) → dropped |
| sing-box runtime add/remove | ❌ none; SIGHUP rebuilds everything (drops tunnels, grows memory) |
| Per-port health via clash_api `/delay` | ✅ 50 ports in 3.1 s |

## 12. Risks & open items

| Item | Plan |
|---|---|
| HMA server IPs change; Mac can't enumerate them like the Windows app | Daily catalog feed + bad-IP failover (§5.1); discovery API not usable (Invalid API Key) |
| HMA device signed out / slot removed | Specific error + guidance in UI (§5.1) |
| HMA app VPN connected on the same machine | Detect and warn (§5.1) |
| Windows HMA `auth` format unverified | First task of the Windows track, on a real machine |
| sing-box OpenVPN client is young (Aug 2026) | Pin the version; live smoke gates upgrades |
| Unsigned Windows build → SmartScreen/Defender | Same stance as lingoreup; illustrated "Run anyway" guide; submit false positives; signing hook ready |
| RAM at high port counts (~20 MB/port) | Acceptable for the 5–20-port target; sharded engine mode is a later optimisation |
| Provider ToS (bulk / multi-exit use) | "Bring your own subscription, personal use" notice in the app and README |

## 13. Out of scope (v1 of the desktop app)

IKEv2 of any kind, Mimic, Linux build, sharded engine, LAN sharing beyond a single toggle, activation-code onboarding, importing v1 Docker data, signed Windows builds.
