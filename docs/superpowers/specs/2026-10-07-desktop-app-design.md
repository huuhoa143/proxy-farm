# Proxy Farm v2 — Desktop App (Windows + macOS, no Docker)

- **Status:** approved design (rev 2, after independent review + spike 2), 2026-10-07. ⚠️ items remain open and are listed in §12.
- **Supersedes:** the Docker-based v1 (tagged `v1-docker` before v2 work lands).
- **Evidence:**
  - Spike 1 and spike 2, 2026-10-07, **macOS arm64 only** (§11).
  - ✅ = run for real on macOS. ⚠️ = not verified yet.
  - Nothing has been tested on Windows. Windows behaviour is a design target until the Windows spike (§12) runs.

## 1. Goal

Ship Proxy Farm as a desktop app that a non-technical user downloads, installs, and uses:

- Windows and macOS in the **same release**.
- **No Docker, no VM, no Python, no scripts, no terminal.**
- One VPN subscription → many local SOCKS5/HTTP proxy ports, each port an independent tunnel with its own exit IP.
- UI in **English and Vietnamese**.

Success criteria:

1. A user with HMA on a Mac goes from "open the app" to a working proxy in under 2 minutes with no admin prompt.
2. On Windows, a user who opts in to HMA support sees **one UAC during install**. Normal use and auto-updates show none. The rare cases that need one more UAC are listed in §7.
3. 20 simultaneous ports run stable for 24 h on a laptop.

## 2. Key decisions (and why)

| Decision | Why |
|---|---|
| **One engine: sing-box 1.14.2 (pinned), userspace only** (`system: false`) | ✅ WireGuard and OpenVPN endpoints run on sing-box's internal gVisor stack: no TUN, no driver, no admin, no routing-table conflicts. This removes every Docker-era bug class: the port-500 stuck UDP flow, hairpin NAT, Docker Desktop wedges, the iptables kill-switch, MTU/MSS hacks. |
| **Only two protocols: OpenVPN + WireGuard. IKEv2 dropped.** | ✅ HMA accepts its *device* credentials over OpenVPN (§5.1). ZoogVPN offers OpenVPN. Surfshark uses WireGuard. |
| **One sing-box process per port** | sing-box has no runtime add/remove; a reload rebuilds every tunnel. Rotation is frequent, so isolation matters more than RAM. ✅ Measured physical footprint per process: ~15 MB for HMA OpenVPN, ~20 MB for WireGuard. 20 ports ≈ 300–400 MB. |
| **Electron (Forge + Vite), modelled on lingoreup** | Same toolchain, release pipeline and updater the team already runs. |
| **Controller in TypeScript in Electron main** | Replaces `farm.py`/`vendors.py`. No Python runtime is shipped. |
| **Windows HMA: privileged helper service installed at setup** | HMA's Windows credential file is admin-only and its password rotates. The app is installed per-user and the helper separately, so auto-updates need no UAC. |
| **sing-box shipped unmodified** (GPL-3, separate process) | Keeps the app MIT. Every release attaches the matching sing-box source tarball and license (GPLv3 §6). The product name must not contain "sing-box". |

## 3. Architecture

```
┌──────────────────────────── Proxy Farm.app (Electron) ────────────────────────────┐
│  Renderer (UI, vi/en)  ◄── contextBridge IPC only (no HTTP) ──►  Main process      │
│                                                                                    │
│  Main: Controller (TypeScript)                                                     │
│   ├─ Providers      hma · zoogvpn · surfshark · file  (setup/check/targets/bind)   │
│   ├─ Catalogs       hma (bundled + feed) · surfshark API · zoogvpn (bundled)       │
│   ├─ Accounts       multi-account pools per provider (pick / rebalance / pin)      │
│   ├─ PortManager    start/stop/rotate/auto-rotate → render config → Supervisor     │
│   ├─ Supervisor     1 sing-box child per port, config via stdin, pid registry       │
│   ├─ Health         log events + /delay + exit-IP probe → state machine            │
│   ├─ Backoff        30 s → 30 min + jitter, bad-IP memory, staggered starts        │
│   ├─ Power          keep-awake · suspend → stop · resume → staggered restart       │
│   ├─ Store          JSON state (schema-versioned, atomic writes) + safeStorage     │
│   └─ Webhook        OPTIONAL separate listener (off by default) for /rotate        │
└────────────────────────────────────────────────────────────────────┬──────────────┘
                                                                     │ spawn, stdin=config
   sing-box #1  mixed 127.0.0.1:29001 → openvpn-client (HMA Tokyo)   ◄┤
   sing-box #2  mixed 127.0.0.1:29002 → wireguard (Surfshark US)     ◄┤
   sing-box #N  …                                                    ◄┘

   Windows only:  ProxyFarm Helper (Go, LocalSystem service) ──named pipe──► Controller
                  reads %ProgramData%\Privax\HMA VPN\HmaProVpn\{auth,ca.crt.pem}
```

Each unit is independently testable:

- **Provider plugins** — pure. Input: account data + catalog. Output: the targets, and an endpoint spec per target.
- **ConfigRenderer** — pure. Target + settings → sing-box JSON. Enforces §6.
- **Supervisor** — process lifecycle (§6.3).
- **Health + Backoff** — consume engine events and probes; emit per-port state (§6.4).
- **Store** — `userData/state.json` with `schemaVersion`. Writes go to a temp file followed by `rename`. Secrets are stored separately, encrypted with `safeStorage`.
- **HelperClient** (Windows) — pipe client with server-identity verification (§7).

**No local HTTP API for the UI.**
- v1 served `/api/*` with no auth and returned `rotate_key` from `/api/status`. Any website could read or CSRF it.
- v2's renderer talks to main only through a typed IPC surface exposed via contextBridge. `contextIsolation` is on and `nodeIntegration` is off.

## 4. User experience

### 4.1 First run

1. **Language.** Defaults to the OS language. A switch sits in the header and in Settings.
2. **"Add a provider" screen** with four large cards: HMA · ZoogVPN · Surfshark · Config file.
   - **HMA** — the app auto-detects the local HMA install.
     - Found → "✅ HMA found — Connect".
     - Not found / no credentials → steps: "Install HMA, sign in, connect once, then come back". The app watches for the file and continues by itself.
     - Windows without the helper → "Enable HMA support" button. This runs the elevated helper installer: one UAC.
   - **ZoogVPN** — email + password → "Check" (one test connection).
   - **Surfshark** — paste the WireGuard private key. An illustrated guide points to my.surfshark.com → Manual setup.
   - **File** — drag & drop `.ovpn` / `.conf`. Country is guessed from the file name and editable.
3. **Main screen** — pick countries/cities → **Start**. Each row shows status, `127.0.0.1:port`, exit IP + country, latency, **Copy**, **Rotate IP**.

### 4.2 v1 feature parity

| v1 feature | v2 |
|---|---|
| Location picker, start/stop, multi-select + bulk actions | Keep |
| Rotate, auto-rotate every N min (`/api/autorotate`) | Keep (rotate semantics: §6.5) |
| Export in 4 formats (`host:port:user:pass`, `socks5://…`, `host:port`, curl) | Keep |
| Rotate webhook (`/api/rotate?key=`) | Keep as an **opt-in** separate listener (§6.6) |
| Proxy username/password, auto-generated on first run | Keep (on by default, as in v1) |
| Per-provider port limits (`/api/limit`) | Keep |
| Multi-account pools: `pick_account`, `rebalance`, move a port on refusal, pin to an account | Keep |
| Test + speed test (`/api/test`, speed.cloudflare.com) | Keep |
| Logs per port (`/api/logs`) | Keep, as an in-app "Details" drawer |
| Settings: proxy user/pass, `base_port`, `mtu`, `dns`, watchdog interval/fails, `give_up_after` (0 = never) | Keep, except `bind`, which becomes the LAN toggle (§6.2) |
| Live phases + retry countdown + reason | Keep (states: §6.4) |
| ZoogVPN plan refusals, Surfshark generic + `static` clusters | Keep |
| Light/dark theme | Keep |
| `/api/provider/hma` (p12), `hma-code` (activation), `eap` (IKEv2), `hma-sync` (scripts), `/api/discover` + inbox (Docker mounts), `/api/upload` over HTTP | **Drop.** IKEv2/Docker-only, or replaced by native drag & drop and IPC |

### 4.3 New in v2

- Tray icon with the online count and quick actions.
- Launch at login (opt-in).
- **Keep-awake on by default while any port is on**; toggle in Settings.
- Suspend → stop; resume → staggered restart.
- Auto-update.
- **Single instance.** A second launch focuses the existing window.
- **Other VPN on this computer (info only).** When the host default route goes through a tunnel interface, show a small grey note: "Another VPN is active on this computer — Proxy Farm keeps working normally."
  - ✅ Spike 2: with the HMA app VPN on, all 12 HMA ports and a WireGuard port kept working with correct exits. Turning it off caused no drops.
  - ✅ macOS detection: HMA adds `ipsec0` and moves the default route to it; it doesn't appear in `scutil --nc`.
  - ⚠️ Windows detection (a default route via a VPN/TAP/Wintun adapter) is not verified.
- **No telemetry** (product decision). The app contacts only:
  - VPN servers.
  - The Surfshark server-list API.
  - The GitHub releases and catalog feed.
  - `www.gstatic.com` (sing-box `/delay`, https only).
  - The exit-IP/geo services in §6.4.
  - speed.cloudflare.com, only when the user runs a speed test.

### 4.4 UI work

- Redesign v1 `manager/ui.html` for the new flow: onboarding, provider cards, tray, info notes. Remove all Docker/script wording.
- **All strings come from `i18n/{en,vi}.json`**; no hard-coded copy. A unit test enforces key parity between the two files.
- The redesign uses the impeccable skill. Screenshots are approved by the owner before merge.

## 5. Providers

### 5.1 HMA — OpenVPN with device credentials

- **Credentials**: `username = udid`, `password = credentials.password` (64 hex).
  - **macOS** ✅: `/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json`.
    - It is world-readable; the device data is base64 JSON under `DeviceManager.device`. No admin needed.
    - ✅ Session renewal rewrites the file, but only the token changes; `udid` and `password` stay identical.
    - The app watches the file. When `udid` or `password` really changes, new credentials are applied **lazily**, on each port's next (re)connect. Ports are not mass-restarted.
  - **Windows** ⚠️: `%ProgramData%\Privax\HMA VPN\HmaProVpn\auth` (line 1 user, line 2 pass; per PR #2 `sync-hma.ps1`).
    - Admin-only and rotated periodically. Read by the Helper (§7).
    - Whether it holds the same udid/password form is **unverified**; the Windows spike checks it first.
- **Server**:
  - UDP 1194 to a per-location IP from the catalog.
  - ✅ macOS: TLS server cert `CN=openvpn.gen-vpn.com`, chain Sectigo OV R36 → **Sectigo Public Server Authentication Root R46**.
  - Config: inline CA (`tls.certificate`), `server_name: openvpn.gen-vpn.com`, `remote_certificate_tls: server`.
  - Bundle R46 **and**, on Windows, also accept the app's own `ca.crt.pem` (PR #2 used it), read via the Helper.
- **Pushed by server** ✅: AES-256-GCM, `compress migrate`, `ping 10`, `ping-restart 60`.
- **Endpoint settings**: `data_ciphers: ["AES-256-GCM"]`, `route_no_pull: true`, `explicit_exit_notify: 2`, `mtu: 1400`.
- **Concurrency** ✅: 12 separate processes on one device, all with correct exits, stable for 17 min, one handshake each (no kicks). Default port limit: none.
- **Auth refused**: sing-box logs `authentication failed: terminal`, then neither retries nor exits.
  - The Supervisor kills the process.
  - The port enters `failed(auth)` with the message "HMA rejected the device credentials — open the HMA app and check you're signed in".
  - Retries continue on the long back-off (§6.4).
- **Not usable** ✅:
  - Account email/password: OpenVPN `AUTH_FAILED`, IKEv2 silent.
  - `<CC>.ult.surfeasy.mobi`: no OpenVPN.
  - IKE REDIRECT gateway IPs: no OpenVPN answer.
  - HMA discovery API: `Invalid API Key` with the in-binary key.
  - The old gluetun CA: expired 2026-09-12.
- **Catalog**:
  - Schema: `{key, country, city, ips: [{ip, firstSeen, lastOk}]}`. A location may have several IPs, accumulated across enumerations.
  - Seed: PR #2's `hma-ovpn-seed.json` (115 locations, one IP each). ✅ 8/8 sampled seed IPs worked on 2026-10-07.
  - Feed: a JSON file in this repo with a sha256 sidecar. The app fetches it daily and merges by `key`.
    - The catalog shows its age.
    - Stale (> 30 days): an info note only; nothing is blocked.
    - **Who refreshes it and how is decided in the Windows track (§12).**
  - Bad-IP failover across a location's `ips`.

### 5.2 ZoogVPN — OpenVPN ✅

- Credentials: username/password = the account login.
- Config ✅: AES-256-GCM, auth SHA256, `tls-auth` key-direction 1, `remote-cert-tls server`. UDP 1194 / TCP 443.
- One shared CA ("Easy-RSA CA", valid to 2032) and one shared tls-auth key; both bundled and inlined.
- Server list bundled (source: `haugene/vpn-configs-contrib`).
- **Plan refusal vs wrong password** ⚠️. Over OpenVPN both arrive as an auth failure. v1 told them apart with IKE signals that no longer exist. Rule:
  - Auth failure on a server while another server on the same account works → `not in plan` for that (account, server), cached for 7 days.
  - Auth failure on ≥ 3 different servers and none working → `failed(auth)` for the account.

### 5.3 Surfshark — WireGuard ✅

- Credential: the WireGuard private key.
- Peer settings: inner address `10.14.0.2/16`, peer = the cluster pubKey, port 51820, `mtu: 1280`, keepalive 25.
- Generic + `static` clusters from the public API, cached 12 h.
- **Re-resolve the host and switch the peer IP when a probe fails.** ✅ IPs went stale within minutes.
- Exit country = the geo-IP result, not the label (virtual locations).
- A wrong key produces no log line at all. It shows up only as `/delay` 504 (§6.4).

### 5.4 Config file

- `.ovpn` → openvpn-client endpoint: parse remote, proto, cipher, auth, ca, tls-auth/tls-crypt, and auth-user-pass (prompts for credentials).
- `.conf` (WireGuard) → wireguard endpoint.
- Unsupported directives are rejected with a clear message rather than ignored.
- Imported files are kept in the encrypted secrets store, not as plain files.

## 6. Engine

### 6.1 Config invariants (ConfigRenderer; a unit test runs on every provider's output)

1. **Config via stdin**: `sing-box run -c stdin`. Not `-c -`, which fails. ✅
   - CA and keys are inline (`tls.certificate` as a PEM string or an array of lines). ✅
   - **No rendered config, credential or CA is ever written to disk.**
2. `route.final = "block"`. The only outbounds are the port's endpoint and `block`, so **no direct path to the internet exists**.
   - ✅ Endpoints accept unsolicited inbound traffic, which would otherwise reach localhost.
   - ✅ No IPv6 leak on a host with real IPv6: IPv6-only sites and literals are refused.
3. One `mixed` inbound per process.
   - `listen: 127.0.0.1`, or `0.0.0.0` only when LAN sharing is on.
   - Proxy username/password **mandatory** when LAN sharing is on.
4. **DNS** ✅: `dns.servers = [{type: "https", server: "1.1.1.1", detour: <endpoint>}]`, `final` = that server, `strategy: ipv4_only`.
   - Spike 2: DoH was fastest (avg 55 ms) with 0/20 failures; UDP and TCP also worked. This keeps v1's lesson that some gateways drop plain UDP 53.
   - Don't add a null resolver: it breaks `/delay`.
   - Server hostnames are resolved by the controller beforehand, so configs contain IPs only.
5. `system: false` on every endpoint. No TUN ever.
6. `experimental.clash_api` on a free loopback port with a random `secret`. No gRPC `api` service (one less listener and no GPL `.proto` in the app).
7. Log level `info` into a per-port ring buffer. Usernames and passwords are redacted before buffering.

### 6.2 Ports

- **Allocation**: test-bind the candidate port on **both** `127.0.0.1` and `0.0.0.0` before use.
  - ✅ Trap: a foreign listener on `0.0.0.0:P` lets sing-box bind `127.0.0.1:P` silently.
- **Persistence**: each location keeps its proxy port across restarts. Auxiliary ports (clash_api) are reallocated on every start.
- **Bind failure** (✅ `FATAL … address already in use`, exit code 1 within ~0.1 s): pick new auxiliary ports and retry. If the proxy port itself is taken, mark the port `failed(port in use)` and offer "Move to another port".
- **LAN sharing** — a single toggle. It is the only setting that may trigger an OS firewall prompt (Windows admin).

### 6.3 Process lifecycle (Supervisor)

- `app.requestSingleInstanceLock()`.
- **pid registry** in `userData` (`pid`, exe path, start time). At startup, stale `sing-box` processes left by a crash are killed. A process is killed only when pid, exe path and start time all match, so a reused pid is never touched.
- **Stop**:
  - macOS: SIGINT. ✅ Exit code 0 in ~35 ms.
  - Windows: hard terminate (Node can't deliver CTRL_BREAK to a non-console child without breaking job-object cleanup).
  - Neither platform relies on OpenVPN exit-notify: ✅ no evidence it is delivered.
- **Quit / update**: on `before-quit` and before `quitAndInstall`, stop all engines and wait. That lets the updater replace the bundled binaries (NSIS cannot overwrite a running `sing-box.exe`).
- sing-box **never exits by itself** on auth failure or an unreachable server, so the Supervisor makes those decisions from the signals in §6.4.

### 6.4 Health, states and back-off

**Signals** (✅ spike 2):

| Signal | Meaning |
|---|---|
| Log `INFO … tunnel established to <ip>:<port>` (OpenVPN) | Tunnel up |
| Log `authentication failed: terminal` | Credentials rejected (terminal for this process) |
| `/proxies/<tag>/delay?url=https://www.gstatic.com/generate_204&timeout=5000` → 200 | Healthy |
| … → 503 (in ms) | Endpoint dead or not ready |
| … → 504 (after the timeout) | Silent black hole: wrong WireGuard key, unreachable server. sing-box retries forever internally; for OpenVPN the handshake timeout is 60 s, then back-off |
| Process exit | Crash or bind error |

**States**:
- `queued`
- `connecting` (spawned, waiting for "established" or the first 200)
- `verifying` (exit-IP probe)
- `online`
- `retrying(countdown, reason)`
- `failed(reason)` — `auth`, `not in plan`, `port in use`, `no server`. Shown in red with guidance.
- `stopped`

`failed` is not "given up": with `give_up_after = 0` (the default), retries continue on the long back-off.

**Probes**:
- `/delay` every 30 s.
- **Exit IP + country** after each (re)start and every 30 min.
  - Use https IP-echo services with fallback: `api.ipify.org` → `ifconfig.co/json` → `ipinfo.io/json`.
  - Cache geo per IP.

**Back-off**: 30 s, 1, 2, 4 … capped at 30 min, plus random jitter.
- Bad server IP remembered for 2 h; fail over to another IP of the same location.
- Starts are queued at ≤ 3 concurrent, 2–5 s apart (also on resume and app start).

### 6.5 Rotate

- Choose, in order:
  1. Another IP of the **same location**.
  2. Otherwise another location in the **same country** (the UI says so).
  3. Otherwise report "no other server available".
- Restart only that port, then **confirm the exit IP changed** before reporting success.
- ✅ HMA exit IP = server IP (8/8), and reconnecting to the same server always gave the same IP, so only a different server rotates.

### 6.6 Optional rotate webhook (off by default)

- A separate listener on `127.0.0.1:<port>`; `0.0.0.0` only together with LAN sharing.
- `POST /rotate/<location-key>` only.
- Key in an `Authorization: Bearer` header, compared in constant time.
- `Host` header must be in an allowlist (anti DNS-rebinding).
- No CORS headers. No other endpoints.

### 6.7 Power

- Keep-awake (`powerSaveBlocker`, prevent-app-suspension) while any port is on, if enabled.
- `suspend` → stop all ports (exit-notify is pointless once the network is gone). `resume` → staggered restart.

## 7. Windows helper (HMA only) ⚠️ whole section unverified on Windows

- **Install**:
  - The NSIS installer is **per-user**, so updates need no UAC.
  - The "HMA support" option is pre-ticked when an HMA install is detected. This needs `oneClick: false` and a custom NSIS include — **a deviation from lingoreup's default NSIS maker config**.
  - If ticked, it runs `ProxyFarmHelper-install.exe` elevated (one UAC). The installer exe is extracted to a temp directory created with an admin-only ACL, not to user-writable `%LOCALAPPDATA%`.
  - It copies the helper to `%ProgramFiles%\ProxyFarm\helper\` (ACL: SYSTEM + Administrators) and registers a LocalSystem service (own process, per-service SID).
  - It records the **unelevated** user's SID: the token of the user who launched the installer, not the elevated admin.
  - Silent update runs skip this step (`${isUpdated}`).
- **Additional UAC prompts (the full list)**:
  1. Enabling HMA support later from the app.
  2. A helper protocol or security update — prompted in-app with an explanation.
  3. Uninstalling the helper. A per-user uninstall can't remove a LocalSystem service, so it launches the elevated helper uninstaller.
  4. The LAN-sharing firewall rule.
- **Pipe protocol** (message mode, versioned):
  - `GetVersion`
  - `GetHmaCredentials` → `{user, pass, ca, mtime}`
  - `Subscribe` → the server pushes `CredentialsChanged` when the file changes.
  - Nothing else: no paths, no commands.
- **Pipe security**:
  - `PIPE_REJECT_REMOTE_CLIENTS`.
  - DACL: SYSTEM full; read/write only for the recorded user SID; deny `FILE_CREATE_PIPE_INSTANCE` to others; deny Anonymous.
  - The server impersonates the client and checks the token user against the recorded SID.
  - The client checks that the pipe server PID equals the registered service's PID (via SCM) and that the service runs as LocalSystem. This defeats pipe-name squatting.
  - **No shared secret in code.** Models: WireGuard-windows, OpenVPN interactive service, `clash-verge-service-ipc`. Anti-model: the archived `clash-verge-service`.
  - Once Windows builds are signed, also verify the client's Authenticode signature. (HMA's own `api.xpc` does the macOS equivalent ✅.)
- **Accepted risk**: any process running as that user can read HMA's credentials through the pipe. That is the point of the helper, and it is equivalent to macOS, where the file is world-readable.
- macOS needs no helper.

## 8. Repo layout (branch `feat/desktop-v2` → v2)

```
proxy-farm/
  app/                    Electron (Forge + Vite + TS)
    src/main/             controller: providers/, catalogs/, accounts/, engine/ (renderer, supervisor),
                          health/, power/, store/, ipc/, webhook/, helper-client/
    src/preload/          contextBridge IPC surface
    src/renderer/         UI (redesigned from v1 ui.html), i18n/{en,vi}.json
    resources/            sing-box/<platform-arch>/ (fetched by prebuild), ca/, catalogs/
    scripts/              prebuild-singbox.mjs (pinned version + sha256 + source tarball),
                          local-release.sh, release-with-x64.sh, local-release.ps1,
                          sign-proxyfarm-bundle.sh
  helper/                 Go Windows service + installer/uninstaller exe
  catalog/                hma.json + hma.json.sha256 (feed)
  docs/                   specs, user guides (en/vi)
  (v1 docker files stay on tag v1-docker; removed from main when v2 ships)
```

## 9. Build & release (lingoreup's local-runner pipeline; no CI)

- **macOS** — `app/scripts/local-release.sh X.Y.Z [--resume|--dry-run]` on the maintainer's Mac. Steps:
  1. Bump, commit, tag, push.
  2. `electron-forge make`.
  3. Inside-out codesign via `sign-proxyfarm-bundle.sh`: *Developer ID Application: Chien Bui Minh (CCQUC3AGRH)*, hardened runtime, every bundled `sing-box` binary included.
  4. notarytool (keychain profile `PROXYFARM_NOTARIZE`), staple, `spctl`.
  5. Smoke-launch.
  6. ZIP + DMG (notarized and stapled).
  7. `latest-mac.yml`.
  8. `gh release` on `huuhoa143/proxy-farm`, with the sing-box source tarball attached.
- **x64 Mac** — via the `release-with-x64.sh` wrapper, which writes a dual-arch `latest-mac.yml` (arm64 first).
- **Minimum macOS 12** (Go 1.26 floor for sing-box).
- **App translocation**: if launched from the DMG or a translocated path, prompt the user to move the app to Applications (updates fail otherwise).
- **Windows** — `app/scripts/local-release.ps1` on the maintainer's Windows machine:
  1. Build the helper.
  2. `electron-forge make` → NSIS, **unsigned** like lingoreup, with a signing hook kept in the maker config.
  3. Upload `Setup.exe` + `latest.yml` + `.blockmap` + the sing-box source tarball.
- **Updates**: electron-updater against GitHub Releases.
- **sing-box**: version, per-platform sha256 and source-tarball sha256 are pinned in `prebuild-singbox.mjs`. Upgrade only after the live smoke (§10) passes.

## 10. Testing

- **Unit (vitest)**:
  - ConfigRenderer invariants (§6.1) on every provider's output, including "no direct outbound" and "no secret written to disk" (renderer returns a string; the supervisor writes only to stdin).
  - Parsers: tokenCoreSE blob, Windows `auth`, `.ovpn`, `.conf`, Surfshark API, catalog feed (sha256 mismatch rejected).
  - Back-off, failover and rotate selection with fake timers.
  - Health state machine fed with recorded log lines and `/delay` codes (fixtures from spike 2).
  - Port allocator (wildcard-listener trap).
  - Account pools.
  - i18n key parity (en ⇔ vi).
- **Integration**: real sing-box against local test servers (WireGuard userspace peer; OpenVPN test server in a dev-only container). Covers:
  - spawn via stdin;
  - health transitions;
  - rotate;
  - stop;
  - orphan reaping after a simulated crash;
  - bind-failure retry;
  - per-port DNS through the right tunnel;
  - an IPv6 literal does not leave via the host.
- **Live smoke** (opt-in flag, real accounts, ≤ 1 attempt per location per 10 min): HMA ×3, ZoogVPN ×2, Surfshark ×5. Asserts the exit IP differs from the host IP and the country matches.
- **E2E**: Playwright against the packaged app (onboarding → start → copy → rotate → stop), as in lingoreup.
- **Helper**:
  - Go unit tests for the pipe ACL and identity checks.
  - Manual Windows checklist:
    - install with exactly one UAC;
    - update shows no UAC;
    - an HMA password rotation is picked up automatically;
    - a squatted pipe name is refused;
    - the uninstaller removes the service.
- **Release gate**: signatures, notarization, smoke-launch, live smoke on the pinned sing-box.

## 11. Spike evidence (2026-10-07, macOS arm64, no sudo, no Docker)

| Test | Result |
|---|---|
| Surfshark WG, 1 port (socks5/socks5h/HTTP) | ✅ NL exit, first curl ~1.4 s |
| Surfshark WG, 50 endpoints in one process | ✅ 50/50 distinct exits after a retry round (round 1 had 6 failures) |
| Surfshark WG, 10 **separate processes** | ✅ 10/10; footprint avg 19.9 MB (max 21.4 after traffic) |
| ZoogVPN OpenVPN UDP + TCP | ✅ NL / VN exits, 4.8 MB/s down |
| HMA OpenVPN with Mac device creds | ✅ NL exit, 2.7 MB/s |
| HMA, 12 **separate processes**, one device | ✅ 12/12 correct exits, stable 17 min, one handshake each; footprint avg 14.4 → 15.2 MB after 10 min |
| Config via `-c stdin` + inline CA | ✅ (`-c -` fails) |
| DNS through tunnel: DoH / TCP / UDP | ✅ 20/20 each; DoH fastest (avg 55 ms) |
| HMA wrong password | sing-box: `authentication failed: terminal`, no retry, no exit |
| Unreachable server | silent at info; 60 s handshake timeout then back-off forever; `/delay` 503 |
| WG wrong key | silent; `/delay` 504 |
| Port already in use | ✅ rc=1 in ~0.1 s; wildcard-listener trap found |
| HMA app VPN on/off with 12 HMA + WG ports running | ✅ no disruption either way |
| HMA account email/password | ❌ OpenVPN AUTH_FAILED, IKEv2 silent (account valid) |
| `<CC>.ult.surfeasy.mobi` / IKE REDIRECT IPs as OpenVPN server | ❌ not served |
| HMA discovery API with in-binary key | ❌ `Invalid API Key` |
| hma-anywhere claims (IKEv2-EAP with account login) | ❌ disproven |
| No IPv6 leak (host has real IPv6) | ✅ |
| HMA session renewal keeps `udid`/`password` | ✅ |
| sing-box runtime add/remove | ❌ none; SIGHUP rebuilds everything |
| OpenVPN exit-notify on stop | ⚠️ no evidence it is sent |

## 12. Risks & open items

| Item | Plan |
|---|---|
| **Windows untested** (auth format, CA, process stop, helper, detection, UAC flows) | **Windows spike before planning the Windows tasks** |
| HMA server list: one IP per location; IPs change; no Mac-side discovery | Accumulating catalog + feed + bad-IP failover now; **find a durable server-discovery method in the Windows track** |
| HMA rotate within a city usually impossible | Rotate falls back to another city in the same country (§6.5) |
| ZoogVPN plan vs password ambiguity ⚠️ | Heuristic in §5.2; refine with real data |
| sing-box OpenVPN client is young (Aug 2026) | Pinned; live smoke gates upgrades |
| Unsigned Windows build → SmartScreen, Defender may flag `sing-box.exe` as a hacktool | Illustrated "Run anyway" guide; submit false positives; signing hook ready |
| RAM at high port counts (~15–20 MB/port) | Acceptable for 5–20 ports; sharded mode later |
| Provider ToS (bulk / multi-exit use) | "Bring your own subscription, personal use" notice in the app and README |

## 13. Out of scope (desktop v1)

IKEv2 of any kind, Mimic, Linux build, sharded engine, activation-code onboarding, importing v1 Docker data, signed Windows builds.
