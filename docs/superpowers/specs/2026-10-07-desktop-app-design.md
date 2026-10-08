# Proxy Farm v2 — Desktop App (Windows + macOS, no Docker)

- **Status:** rev 3 draft, 2026-10-08, **pending owner review**. Rev 2 (2026-10-07) was approved after an independent review and spike 2. Rev 3 replaces "one port per location" with **server pools**: every provider exposes a location as a pool of servers, each server is one fixed exit IP, and a port pins one server (§6.8). Evidence: §11, 2026-10-08 rows. ⚠️ items remain open and are listed in §12.
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
  - A location with N usable servers gives up to N ports with N different, stable exit IPs (§6.8).
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
| **Location → server pool → one fixed exit IP per server; a port pins one server** (rev 3) | ✅ Measured on all three providers: the exit IP belongs to the server (HMA: = server IP, for OpenVPN, IPSec and Mimic alike; Surfshark: = server IP + 1; ZoogVPN: = server IP), reconnecting to the same server never changes it, and a location is many servers (HMA: several clusters; Surfshark: a DNS pool of 20+; ZoogVPN: numbered hosts). So "rotate" is really "change server", and pinning servers turns one location into many stable IPs. |
| **sing-box shipped unmodified** (GPL-3, separate process) | Keeps the app MIT. Every release attaches the matching sing-box source tarball and license (GPLv3 §6). The product name must not contain "sing-box". |

## 3. Architecture

```
┌──────────────────────────── Proxy Farm.app (Electron) ────────────────────────────┐
│  Renderer (UI, vi/en)  ◄── contextBridge IPC only (no HTTP) ──►  Main process      │
│                                                                                    │
│  Main: Controller (TypeScript)                                                     │
│   ├─ Providers      hma · zoogvpn · surfshark · file  (setup/check/targets/bind)   │
│   ├─ Catalogs       hma (bundled + feed) · surfshark API · zoogvpn (bundled)       │
│   ├─ ServerPools    per location: servers, health, which port holds which (§6.8)  │
│   ├─ Accounts       multi-account pools per provider (pick / rebalance / pin)      │
│   ├─ PortManager    add/start/stop/change-server → render config → Supervisor      │
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
   - **ZoogVPN** — email + password → "Check" (one test connection to a free-tier host, §5.2).
   - **Surfshark** — paste the WireGuard private key. An illustrated guide points to my.surfshark.com → Manual setup.
   - **File** — drag & drop `.ovpn` / `.conf`. Country is guessed from the file name and editable.
3. **Main screen** (rev 3) — ports grouped by location:
   ```
   ▼ 🇯🇵 Tokyo · Surfshark     2 ports · 26 servers              [+ Add port]
       :29001  146.70.205.100  ● Online 40 ms   [Change IP] [Stop] [Remove] [Details]
       :29002  82.26.195.7     ● Online 52 ms   [Change IP] [Stop] [Remove] [Details]
   ▼ 🇻🇳 Hanoi · HMA           1 port · 3 servers                [+ Add port]
       :29003  156.59.140.19   ● Online 31 ms   …
   ```
   - **Add location** picker: choose a location, then **how many ports** (stepper, default 1, max = the location's free usable servers, capped by the provider's port limit). The picker shows each location's server count.
   - **+ Add port** on a group adds one port on a free server of that location; disabled, with a tooltip, when no free server is left or the limit is reached.
   - Each port row shows status, `127.0.0.1:port`, exit IP + country, latency, **Copy**, **Change IP**, Stop, Remove, Details.
   - **Change IP** moves that port to another free server of the same location (§6.5). Its menu also lists the location's servers (IP, health, "in use by :2900x") so the user can pick one.
   - A group header shows how many of its ports are online; collapsing remembers state. Bulk select and bulk actions work across groups.

### 4.2 v1 feature parity

| v1 feature | v2 |
|---|---|
| Location picker, start/stop, multi-select + bulk actions | Keep |
| Rotate, auto-rotate every N min (`/api/autorotate`) | Keep as **Change IP** = move the port to another free server of its location; auto-rotate cycles servers (§6.5) |
| One port per location | **Changed (rev 3):** several ports per location, each pinned to a different server (§6.8) |
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
  - The Surfshark server-list API, and DNS lookups of Surfshark cluster hostnames (system resolver + DoH `dns.google`) to build their server pools (§5.3).
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
- **Concurrency** ✅: 12 separate processes on one device, all with correct exits, stable for 17 min, one handshake each (no kicks). Default port limit: **12**. ✅ 2026-10-08: 20 concurrent tunnels on one device all established, one handshake each, no auth failures or kicks over a 60 s hold; 12 stays the default for headroom against abuse detection. The user can raise it.
- **Auth refused** — sing-box logs `authentication failed: terminal`, then neither retries nor exits; the Supervisor kills the process. Rev 3, ✅ 2026-10-08:
  - Device credentials belong to the device, not to a server, but a location's cluster can contain servers that refuse them. The `gen-vpn.com` infrastructure is shared across Gen Digital brands, and a server serving another brand's tenant answers `AUTH_FAILED` (VN: `156.59.140.149` refuses; `156.59.140.19`, `128.1.126.101`, `128.1.126.118` accept the same device).
  - So an HMA auth failure marks **that server** as refused for this device (§6.8, 7 days) and the port moves to the next free server of its location, shown as `retrying("server refused the device — switching")`.
  - Only when every server of the location has refused does the port enter `failed(auth)`. If the same device is online elsewhere, the message reads "This location refused your device — try another location"; otherwise "HMA rejected the device credentials — open the HMA app and check you're signed in". Retries continue on the long back-off (§6.4).
- **Not usable** ✅:
  - Account email/password: OpenVPN `AUTH_FAILED`, IKEv2 silent.
  - `<CC>.ult.surfeasy.mobi`: no OpenVPN.
  - IKE REDIRECT gateway IPs: no OpenVPN answer.
  - HMA discovery API: `Invalid API Key` with the in-binary key.
  - The old gluetun CA: expired 2026-09-12.
- **Catalog** — the location's server pool:
  - Schema: `{key, country, city, ips: [{ip, firstSeen, lastOk}]}`.
  - Seed: originally PR #2's `hma-ovpn-seed.json` (115 locations, one IP each). Rev 3: the seed file may carry `ips: [...]` per location (verified servers, best first); the legacy single `ip` still loads.
  - ✅ 2026-10-08: 74/74 seed countries reach at least one server with device credentials (VN after replacing its refusing seed IP).
  - **A location spans several /24 clusters** ✅. VN-51-HANOI: `156.59.140.0/24` (Hanoi) and `128.1.126.0/24` (Ho Chi Minh City).
  - **Discovery is a maintainer job, not done on users' machines** (it probes networks). `pnpm scan:hma-servers` (`app/scripts/hma-scan-servers.ts`):
    1. Collect candidate /24s: every seed IP's /24. Gen Digital servers have per-server certificates named `<kind>-prod-<infra>-<cc>-<city>-<id>.gen-vpn.com` (kinds seen: `ipsec`, `mimic`, `wireguard`); OpenVPN servers share `openvpn.gen-vpn.com` but sit in the same clusters ✅ (VN). Certificate Transparency was evaluated as a second source of /24s and **not adopted**: certspotter gives 679 names (26 countries) before HTTP 429 (10 requests / 5 min), but only 2 of 60 sampled names resolve and none fall in a seed /24 (§11).
    2. Probe each /24 with one 14-byte OpenVPN hello (`P_CONTROL_HARD_RESET_CLIENT_V2`) on udp/1194; hosts answering opcode 8 are OpenVPN servers.
    3. Verify each with a real device-credential handshake through the app's own provider and renderer (config over stdin). Keep only servers that establish; a new server must geolocate to the location's country.
    4. `--write` updates the seed; the result also feeds the catalog feed below.
  - Feed: a JSON file in this repo with a sha256 sidecar. The app fetches it daily and merges by `key`.
    - The catalog shows its age.
    - Stale (> 30 days): an info note only; nothing is blocked.
  - Server health (refused / dead / last OK) and failover across a location's servers: §6.8.

### 5.2 ZoogVPN — OpenVPN ✅

- Credentials: username/password = the account login.
- Config ✅: AES-256-GCM, auth SHA256, `tls-auth` key-direction 1, `remote-cert-tls server`. UDP 1194 / TCP 443.
- One shared CA ("Easy-RSA CA", valid to 2032) and one shared tls-auth key; both bundled and inlined.
- Server list bundled (source: `haugene/vpn-configs-contrib`).
- **Server pool** (rev 3): hosts are numbered per country, `<cc><n>.webunlim.com` (some `.zoogvpn.com`), one A record each, and the bundled list holds only a fraction of them.
  - ✅ 2026-10-08, DNS: JP 2 listed vs ≥10 resolvable; DE 4 vs 9; NL 3 vs 8; SG 1 vs 5; VN 1 vs 3.
  - ✅ Exit IP = server IP (`sg2.webunlim.com`, not in the bundled list, worked).
  - A maintainer script (`pnpm scan:zoog-servers`) enumerates `<cc>1…<cc>N` per country until several consecutive misses and writes the bundled list. Hosts stay hostnames; the controller resolves them before bind (§6.1.4).
  - Which servers an account may use depends on its plan: `jp4`, `vn2`, `de5` answered `AUTH_FAILED` to the test account while `sg2` worked. That is the plan-refusal case below, recorded per (account, server) in §6.8.
- **Plan refusal vs wrong password** ✅ 2026-10-09. Over OpenVPN both arrive as the same `AUTH_FAILED`; v1 told them apart with IKE signals that no longer exist, and 0.1.0 guessed from counts ("refused on ≥ 3 servers, none working → bad login"), which told a fresh account on a restrictive plan that its password was wrong. The free-tier hosts settle it instead:
  - Evidence (live, one account, 2026-10-09): the free hosts `nl.zgfree.info`, `uk.zgfree.info`, `us.zgfree.info` (in the bundled list) take any valid login whatever the plan. With the real credentials `nl.zgfree.info` connected (exit 185.107.80.250); with a wrong password it failed auth. On that account's plan jp1–jp10, tw1–tw3, de1, de2, de7 and fr4 refused while nl1, nl2, nl3.zoogvpn.com, nl4, de3 and fr1 worked. So a free-host handshake is a deterministic credential check, and a refusal elsewhere by a working login is the plan.
  - **Credential probe** (`controller/credential-probe.ts`): one short tunnel to a free host, through the same engine and `bind` as a port (config on stdin, nothing on disk, loopback only, under a key no port can have), waiting at most 40 s for "established" or an auth failure, then stopped. The nearest free host first (judged from the system time zone), the next one on a network error, at most 2 hosts. Every handshake takes from the account's attempt budget (§6.4).
  - **Adding an account, or new credentials ("Check")**: one probe before anything is stored. Established → stored, credentials *verified* (timestamp persisted). Auth failure → not stored: "wrong email or password". Network error or timeout → stored, *unverified*, with a note.
  - **A port's `AUTH_FAILED`**: credentials *verified* (or another port of the account online) → a plan refusal: the server is marked refused for 7 days (per machine, §6.8) and the port fails over; with nothing left, `failed(not in plan)`, and when every server of the location refused it, "Your ZoogVPN plan doesn't include this location — pick another location or upgrade your plan." *Unverified* → the probe runs first (at most once per 10 min per account; the port waits with its engine stopped): auth failure → `failed(auth)` "wrong email or password" for every port of the account that is not up, and the refusals marked since the login was last verified are dropped (they rested on a false assumption); established → as verified. A port going online also marks the credentials verified. A verified login whose location runs out with nothing of the account online is probed again (throttled), in case the password changed since.
  - **Last resort** only when no free host can be reached: the refusing server is marked dead (2 h, not refused) and the port moves on; after refusals on 3 distinct servers with none working, the port stops with "sign-in couldn't be verified" — never "wrong password".

### 5.3 Surfshark — WireGuard ✅

- Credential: the WireGuard private key, plus the key's interface address. Each key pair has its own: the `Address` line of the config Surfshark's dashboard downloads with the key (`10.14.0.2/16` for some keys, `10.64.x.y/16` for others). The user types it (optional, default `10.14.0.2/16`, validated as an IPv4 CIDR) or pastes/imports that `.conf`, from which `PrivateKey` and the first IPv4 `Address` are read and the rest ignored. The address is account metadata, not a secret.
- Peer settings: inner address = the account's address, peer = the cluster pubKey, port 51820, `mtu: 1280`, keepalive 25.
- Generic + `static` clusters from the public API, cached 12 h.
- **Server pool** (rev 3) ✅ 2026-10-08:
  - A cluster hostname (`jp-tok.prod.surfshark.com`) is DNS round-robin over a large pool: 20–26 distinct IPs in 16 lookups for JP/US/DE/SG; 8 for VN.
  - The cluster's single pubKey works for **every** pool IP, so a port can pin one server: 3/3 JP and 3/3 VN pinned IPs connected.
  - Exit IP = server IP + 1 (`193.148.16.53` → `193.148.16.54`), stable for that server.
  - Discovery runs **in the app** (DNS only, no probing): resolve the hostname repeatedly (`dns.resolve4` against the system's DNS server, not the cached `dns.lookup`, plus DoH to `dns.google` through the host) when the location is first used and at most every 12 h, and accumulate into a persisted pool with `lastSeen`. An IP not seen for 7 days and not OK in that time is dropped.
  - A pinned server that dies (`/delay` 504, no handshake) is marked dead for 2 h and the port moves to another free pool server (§6.8). This replaces rev 2's "re-resolve the host on probe failure" (✅ pool IPs went stale within minutes in spike 1).
  - ⚠️ How long a pinned Surfshark server stays usable is unmeasured; the 24 h soak (§10) checks it.
- Exit country = the geo-IP result, not the label (virtual locations).
- A wrong key produces no log line at all. It shows up only as `/delay` 504 (§6.4), exactly like an unreachable server. Retrying it is what got an account suspended (§6.4 "Provider safety").

### 5.4 Config file

- `.ovpn` → openvpn-client endpoint: parse remote, proto, cipher, auth, ca, tls-auth/tls-crypt, and auth-user-pass (prompts for credentials).
  - Rev 3: **every `remote` line** becomes a server of the file's pool (hostnames resolved before bind), so a multi-remote file can hold several ports. Today's parser keeps only the first.
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
- **Persistence**: each port keeps its proxy port number (and its pinned server, while that server stays usable) across restarts. Auxiliary ports (clash_api) are reallocated on every start.
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
- `failed(reason)` — `auth`, `not in plan`, `port in use`, `no server`, `key rejected` (see "Provider safety" below). Shown in red with guidance.
- `stopped`

`failed` is not "given up": with `give_up_after = 0` (the default), retries continue on the long back-off.

**Probes**:
- `/delay` every 30 s.
- **Exit IP + country** after each (re)start and every 30 min.
  - Use https IP-echo services with fallback: `api.ipify.org` → `ifconfig.co/json` → `ipinfo.io/json`.
  - Cache geo per IP.

**Back-off**: 30 s, 1, 2, 4 … capped at 30 min, plus random jitter.
- A port's exit IP is sticky: a drop of an online port retries the **same** server on the back-off and marks nothing.
- A server is judged dead (remembered for 2 h, fail over to another server of the same location) only when it fails a **fresh reconnect**: at once for a server the port never got online on, after 2 failed reconnects in a row for the server it was online on.
- Correlated drops are not dead servers: when another port of the same provider failed within the last 15 s, that provider has an incident; when ports of two providers did, the host has one. During an incident (2 min, extended by every further failure) nothing is marked and no port moves; every port retries its own server. (2026-10-08: every few minutes all HMA tunnels stalled together for 30–60 s while direct traffic was fine.)
- Starts are queued at ≤ 3 concurrent, 2–5 s apart (also on resume and app start).
- The back-off belongs to the **port**, not to one engine process: it carries across engine restarts (each retry spawns a fresh process) and resets only when the port reaches `online` or on a user Start, Stop, Remove or Change IP.
- While a port waits out its back-off its sing-box process is **stopped**. sing-box never exits on a 504 or a handshake timeout, and a running WireGuard endpoint keeps sending handshake initiations (keepalive and the `/delay` poll give it traffic), so a "30 min back-off" with the process alive is hundreds of handshakes.

**Provider safety** (2026-10-08 incident). The app hammered Surfshark with WireGuard handshakes that never completed: the back-off restarted at 30 s on every engine restart, and dead-server failover walked the pool. Surfshark suspended the account's VPN access; afterwards the official app failed on every protocol with "The VPN credentials are invalid". Same failure mode as gluetun issue #2595. WireGuard is silent: a rejected key looks exactly like an unreachable server, so the app must assume the worst. Rules:

- **Per-account attempt cap.** Every engine start of a port (start, due retry, failover, Change IP) takes a token from a per-account bucket: at most 6, refilling one every 10 s (≤ 6 handshake attempts per minute per account, across all its ports). With no token the port shows `retrying(rate-limited)` until the next one is due; the back-off does not grow. Applies to every provider.
- **Unproven WireGuard key.** For a WireGuard account (Surfshark, or an imported WireGuard `.conf`) that has **never** been confirmed online (no persisted `lastOk` for the account): 3 attempts in a row that end without a handshake (`/delay` 504 or the connecting deadline, before the first 200) stop the account. Every port of it goes to `failed(key-rejected)`: its engine is stopped, nothing retries automatically, and the UI shows it as action-needed (no countdown) with the provider's guidance (Surfshark: check the key is under Manual setup → WireGuard, the address matches the key's config, the subscription is active; retrying too often can get an account suspended). The lock is persisted (`AppState.wgLockouts`) so an app restart does not start over. A user Start or Change IP re-arms it for **one** attempt (a further failure locks it again at once); app start, resume, due retries, auto-rotate and the webhook never re-arm. A handshake or new credentials (a re-added key, a changed address) clear it. Failures during a host-wide incident are not counted.
- **Proven WireGuard key** (has worked before): never locked, but its ports do not jump to the next server the moment one times out. The server is marked dead and the next attempt waits for the back-off (with jitter), which then moves the port. Attempts never come faster than the back-off.
- OpenVPN auth failures (HMA, ZoogVPN) keep their refusal/failover rules (§6.8) and are bounded by the persistent back-off and the per-account cap.

### 6.5 Change IP (was "Rotate")

- A port's exit IP is its server's (§6.8), so changing the IP means moving the port to another server. Choose, in order:
  1. A **free** usable server of the **same location**: not held by another port, not refused for this account, not dead; best first (most recent OK, then catalog order). Or the server the user picked from the Change-IP menu.
  2. Otherwise another location in the **same country** (the UI says so, and the row moves to that location's group).
  3. Otherwise report "no other server available".
- Restart only that port, then **confirm the exit IP changed** before reporting success.
- Auto-rotate every N minutes applies Change IP on that schedule, cycling through the location's free servers.
- ✅ Exit IP = server identity on every provider, and reconnecting to the same server always gives the same IP (2026-10-08: 3/3 reconnects on HMA VN and DE; HMA app toggled 5× on IPSec kept gateway and exit `128.1.126.104`).

### 6.6 Optional rotate webhook (off by default)

- A separate listener on `127.0.0.1:<port>`; `0.0.0.0` only together with LAN sharing.
- `POST /rotate/<port-key>` only (rev 3: a port key is `<location-key>#<n>`). A bare `<location-key>` keeps working and means that location's first port, so existing scripts don't break.
- Key in an `Authorization: Bearer` header, compared in constant time.
- `Host` header must be in an allowlist (anti DNS-rebinding).
- No CORS headers. No other endpoints.

### 6.7 Power

- Keep-awake (`powerSaveBlocker`, prevent-app-suspension) while any port is on, if enabled.
- `suspend` → stop all ports (exit-notify is pointless once the network is gone). `resume` → staggered restart.

### 6.8 Server pools and the port model (rev 3)

**Why.** On every provider a location is many servers and each server is one fixed exit IP (§2, §11). One port per location wasted that: one IP per city, and "rotate" could only jump cities. Rev 3 makes the server the unit.

**Model.**

- **Location** (`Target`): `{key, providerId, country, city, label, servers}`. `servers` is the location's pool of server tokens: an IP for HMA and Surfshark, a hostname for ZoogVPN and files (resolved before bind).
- **Port**: `{key: "<location-key>#<n>", locationKey, n, accountId, proxyPort, server, enabled, state, autoRotateMin}`.
  - `n` is the smallest free number in that location, starting at 1.
  - `server` is the pinned server token; empty until the first start.
- **Server health**, per (account, server):
  - `lastOk` — last confirmed online.
  - `refused until` — auth refused: an HMA server of another tenant, or a ZoogVPN `not in plan`. 7 days. Persisted.
  - `dead until` — a fresh reconnect failed (handshake timeout, `/delay` 503/504; see §6.4 for when a drop counts), or the host vanished from DNS. 2 h. In memory.

**Pool source per provider.**

| Provider | Pool | Built by | Exit IP |
|---|---|---|---|
| HMA | catalog `ips` of the location | maintainer scan (§5.1), shipped in the seed + feed | = server IP |
| Surfshark | IPs behind the cluster hostname | the app, DNS sampling (§5.3) | = server IP + 1 |
| ZoogVPN | numbered hosts of the location | maintainer enumeration (§5.2), bundled | = server IP |
| File | the file's `remote` lines | parser (§5.4) | = server IP |

**Allocation invariant.** Two enabled ports of the same provider never hold the same server, because the same server means the same exit IP. "Same" is compared on the **resolved IP**, not the token: different hostnames can point at one machine (✅ `de7.webunlim.com` and `fr4.webunlim.com` both resolve to `185.177.229.121`). The exit-IP probe is the final check: a port whose exit IP equals another port's is moved to another server.

- **Add k ports** to a location: take the k best free usable servers (usable = not refused for that account, not dead; best = most recent `lastOk`, then pool order). If fewer are free, add that many and say how many were added.
- The provider's port limit (§4.2) caps the provider's enabled ports. Defaults: HMA 12 (✅ 20 processes verified), Surfshark 20 (⚠️ 10 separate processes ✅, 50 endpoints in one process ✅; 20 processes and the 24 h soak wait on a live test key), ZoogVPN 5 (✅ 8 concurrent tunnels on one account, no kicks; plan refusals are per server, not a connection count), file 1 per file.
- Ports are spread across the provider's accounts by the existing account pool. A server refused for one account may still be used by another.

**Failover.** It runs on every (re)start and every due retry; the start path re-selects instead of reusing a stale choice.

- Server refused → mark refused for (account, server) and move the port to the next free usable server.
  - If none is left, the port enters `failed(auth)` or `failed(not in plan)` with the provider's message (§5.1, §5.2).
- Server dead (by the §6.4 rule: a failed fresh reconnect, never a drop of an online port or a correlated drop) → mark dead for 2 h and move to the next free usable server.
  - If none is left, `retrying` on the normal back-off; dead marks expire, so the pool recovers.
- Change IP (§6.5) uses the same selection, excluding the current server.

**IPC changes** (`contracts.ts`):

- `PortRow` gains `locationKey`, `server`, `serverIp`. `key` is the port key.
- `addPorts(locationKey, count)` → `{added: PortRow[], noteKey?}`. Replaces starting a location key.
- `listServers(locationKey)` → `[{server, ip?, health: 'ok'|'unknown'|'refused'|'dead', lastOk?, heldBy?}]`. Feeds the Change-IP menu and the group header.
- `rotatePort(portKey, toServer?)` takes an optional explicit server.
- `listTargets()` reports each location's pool size and usable count.
- `startPorts`, `stopPorts`, `removePorts`, `exportPorts`, `testPort`, `setAutoRotate` and `getLogs` keep taking port keys.

**Migration** (`schemaVersion` bump):

- Every existing row `K` becomes `K#1` with `locationKey = K`.
- `portServers[K]` becomes that row's `server`.
- Auto-rotate settings carry over.
- The webhook keeps accepting bare location keys (§6.6).

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
  - Server pools (rev 3): allocation never gives two ports the same server; refused/dead failover and its terminal cases; Change IP selection incl. an explicit server; Surfshark DNS-pool accumulation and expiry; multi-remote `.ovpn`; the `K` → `K#1` state migration; webhook bare-key alias.
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
- **Live smoke** (opt-in flag, real accounts, ≤ 1 attempt per location per 10 min): HMA ×3, ZoogVPN ×2, Surfshark ×5. Asserts the exit IP differs from the host IP and the country matches. Rev 3 adds: 3 ports on one Surfshark location and 2 on one HMA location, all with distinct exit IPs.
- **Soak** (rev 3): 20 Surfshark ports pinned to pool servers + 12 HMA ports for 24 h; records how long pinned servers stay usable and how often failover moves a port.
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

## 11. Spike evidence (2026-10-07 and 2026-10-08, macOS arm64, no sudo, no Docker)

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
| **2026-10-08 (rev 3)** | |
| HMA device creds, all 115 seed locations / 74 countries | ✅ 73/74 at first; VN refused because its seed IP was another tenant's server; 74/74 after the fix |
| HMA VN cluster scan (`156.59.140.0/24`, one OpenVPN hello per host) | ✅ 2 OpenVPN servers answered: `.149` refuses the device, `.19` accepts it; exit = `.19` (Hanoi) |
| HMA second VN cluster (`128.1.126.0/24`, found via the app's IPSec/Mimic gateways) | ✅ `.101` and `.118` accept the device; exits = themselves (Ho Chi Minh City) |
| HMA reconnect to the same server ×3 (VN, DE) | ✅ same exit IP every time |
| HMA app (IPSec), toggled 5× on VN | ✅ same gateway `128.1.126.104` and exit `128.1.126.104` each time; the morning's gateway was `156.59.140.24` |
| HMA seed-/24 mining (first 62 locations) | ✅ 33 with 1 server, 16 with 2, 2 with 3, 11 with ≥ 4 (capped) |
| Certificate Transparency, `*.gen-vpn.com` | ✅ per-server names `<kind>-prod-<infra>-<cc>-<city>-<id>` (ipsec, mimic, wireguard); certspotter: 10 pages then HTTP 429 (`x-ratelimit-limit: 10`, `Retry-After: 286`), 679 names / 26 countries; ❌ as a server source: 2/60 names resolve, 0 in seed /24s |
| Surfshark cluster DNS (16 lookups × 5 clusters) | ✅ 20–26 distinct IPs for JP/US/DE/SG, 8 for VN (resolvers combined) |
| Surfshark DNS by resolver (node, 16 and 64 lookups) | ✅ `dns.resolve4` 11–14 per 16 (VN 6); at 64: us-nyc 101, jp-tok 47. `dns.lookup` ~4 (getaddrinfo cache). DoH `cloudflare-dns.com` no better than the system resolver; `dns.google` adds IPs |
| Surfshark 20 separate processes | ⚠️ 20/20 processes started, 0/20 handshakes: the test key no longer authenticates (pubKeys match the live API; fails through another tunnel too). Rerun with a live key |
| Surfshark pinned pool IPs with the cluster pubKey | ✅ 3/3 JP and 3/3 VN connected; exit = server IP + 1 |
| ZoogVPN numbered hosts via DNS | ✅ many unlisted hosts (JP ≥ 10, DE 9, NL 8, SG 5, VN 3) |
| ZoogVPN concurrent tunnels, one account, distinct servers, 12 s ramp | ✅ 8 alive together, 0 kicks; `AUTH_FAILED` on tw1, id1, uk2, se1, th1 is per server (plan) |
| ZoogVPN DNS enumeration (`scan:zoog-servers`) | ✅ 93 → 231 hosts in 68 locations; no wildcard DNS; `de7` and `fr4` share an IP |
| HMA concurrent tunnels, one device, ramp 12→14→16→20 | ✅ 20/20 established, one handshake each, no auth failures; sampled exits = server IP, distinct |
| HMA full scan (`scan:hma-servers --write --max 4`) | ✅ 115/115 locations verified; 192 servers; 68 with 1, 27 with 2, 7 with 3, 13 with 4 |
| ZoogVPN unlisted hosts with the test account | `sg2` ✅ exit = server IP; `jp4`, `vn2`, `de5` `AUTH_FAILED` (plan); `jp1`, `jp2` timed out |

## 12. Risks & open items

| Item | Plan |
|---|---|
| **Windows untested** (auth format, CA, process stop, helper, detection, UAC flows) | **Windows spike before planning the Windows tasks** |
| HMA server discovery | Rev 3: maintainer scan (seed /24s + CT clusters + OpenVPN hello + device-cred verify) → seed + feed (§5.1). Some servers refuse the device (other tenants); refusal failover handles them (§6.8) |
| Many concurrent tunnels per account may trip provider abuse detection | Conservative default limits (§6.8), user-adjustable; soak (§10) before raising them |
| **Failed WireGuard handshakes get an account suspended** ✅ happened 2026-10-08: a Surfshark account's VPN access was suspended after mass failed WireGuard handshakes; the official app then failed on all protocols with "The VPN credentials are invalid" (cf. gluetun #2595) | §6.4 "Provider safety": per-port back-off persists across restarts, engines are stopped during back-off, ≤ 6 attempts/min per account, an unproven WireGuard key is stopped after 3 silent attempts until the user acts. Live experiments are rate-limited (CONTRIBUTING) |
| Pinned Surfshark servers may rotate out of the pool ⚠️ | Dead-server failover to another pool IP; pool refreshed by DNS sampling; soak measures lifetime |
| ZoogVPN plan limits per server ⚠️ | Per-(account, server) refusal memory. Connection count: ✅ ≥ 8 on one account, default 5 |
| HMA WireGuard servers exist (CT) | Not used: registering a device key is unexplored. Out of scope for rev 3 |
| ZoogVPN plan vs password ambiguity ✅ | Free-host credential probe (§5.2), 2026-10-09; the count heuristic is only a labelled last resort |
| sing-box OpenVPN client is young (Aug 2026) | Pinned; live smoke gates upgrades |
| Unsigned Windows build → SmartScreen, Defender may flag `sing-box.exe` as a hacktool | Illustrated "Run anyway" guide; submit false positives; signing hook ready |
| RAM at high port counts (~15–20 MB/port) | Acceptable for 5–20 ports; sharded mode later |
| Provider ToS (bulk / multi-exit use) | "Bring your own subscription, personal use" notice in the app and README |

## 13. Out of scope (desktop v1)

IKEv2 of any kind, Mimic, Linux build, sharded engine, activation-code onboarding, importing v1 Docker data, signed Windows builds.
