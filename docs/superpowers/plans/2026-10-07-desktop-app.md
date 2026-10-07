# Proxy Farm v2 Desktop App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Docker-based proxy-farm into an Electron desktop app (Windows + macOS) whose engine is the stock sing-box binary running one userspace process per proxy port — no Docker, no admin to run tunnels.

**Architecture:** Electron main hosts a TypeScript controller (pure provider plugins → a pure ConfigRenderer → a Supervisor that spawns `sing-box run -c stdin`, one child per port). A React renderer talks to main only over a contextBridge IPC surface. A Go LocalSystem helper (Windows only) reads HMA's admin-only credential file. Release copies lingoreup's local-runner pipeline.

**Tech Stack:** Electron 42 + electron-forge (Vite plugin) + electron-updater, React 19 + react-i18next, TypeScript ~5.4, vitest, Playwright, Go (Windows helper), sing-box 1.14.2 (bundled binary).

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-app-design.md` — read it alongside this plan.

## Global Constraints

- sing-box pinned to **1.14.2**. Per-asset sha256: darwin-arm64 `925c5382eca8492b0150f868a6db20b18290a38700e621724b3703fd453e032d`, darwin-amd64 `b0bfb0dc70a5fc708710b9f5ea98b9ee76d40fa4169928d25d73edc4331df2fe`, windows-amd64 `c2d8bfff918755808781dfdeeb8581b6c91eb3a243d9a7b55483cfc0c0684d32`. Source tarball (v1.14.2) `67dd8f8c37ecaaadcfcafad1f0827eed4b034c963b86fd3aa5c0d7a36876845d`.
- Run sing-box as `sing-box run -c stdin` (literal `stdin`, **not** `-c -`). Config JSON is piped to stdin. **No rendered config, credential, or CA is ever written to disk.**
- Every rendered config MUST satisfy: `route.final: "block"`; only outbounds are the port endpoint + `block`; one `mixed` inbound; `system: false` on the endpoint; DNS `{type:"https", server:"1.1.1.1", detour:<endpoint>}` as `final`, `strategy:"ipv4_only"`; `experimental.clash_api` on a free loopback port with a random `secret`; **no** gRPC `api` service; `log.level:"info"`; credentials redacted from the log ring buffer.
- No Python shipped. No unauthenticated local HTTP API for the UI (contextBridge IPC only; `contextIsolation: true`, `nodeIntegration: false`).
- UI copy only from `i18n/{en,vi}.json`; product name must not contain "sing-box".
- Minimum macOS 12. GitHub repo `huuhoa143/proxy-farm`. Every release attaches the sing-box source tarball (GPLv3 §6).
- Node 24, pnpm 10 (`node-linker=hoisted`).

## Review Focus

- **Secret on disk / in logs** (§6.1, §2): a rendered config reaches a temp file, or a password/udid lands in the log ring buffer or an error message. Owner: Task 4 (renderer returns a string, asserts no fs write) and Task 11 (supervisor log-redaction test).
- **Direct-path / IPv6 leak** (§6.1): a config a provider produces has an outbound other than the endpoint+block, or lets an IPv6 literal exit via the host. Owner: Task 6 (invariant checker) run over every provider's output in Tasks 8–9, + Task 20 (integration: IPv6 literal refused).
- **Port-in-use wildcard trap** (§6.2): a foreign listener on `0.0.0.0:P` lets sing-box bind `127.0.0.1:P` silently and hijack loopback. Owner: Task 5 (allocator test binds both addresses).
- **sing-box never exits on failure** (§6.3–6.4): wrong password (`authentication failed: terminal`, no retry, no exit) or black hole (`/delay` 504) leaves a live process the supervisor must act on. Owner: Task 14 (state machine over recorded signals) + Task 15 (PortManager stops the process on `failed:auth` and reschedules).
- **Orphan engines after crash** (§6.3): the app dies and children keep ports, so the next launch hits address-in-use. Owner: Task 12 (pid-registry reaping, matching pid+exe+start-time).
- **Rotate false success** (§6.5): a one-server location reports a successful rotate without the exit IP changing. Owner: Task 15 (rotate selection + verified-change test).
- **ZoogVPN plan-vs-password ambiguity** (§5.2): a wrong password is shown as "not in plan" or vice-versa. Owner: Task 18 (heuristic test: fail-on-one-while-another-works vs fail-on-≥3).
- **i18n key drift** (§4.4): a string exists in one locale only. Owner: Task 19 (key-parity test).

---

## Phase A — Scaffold & engine core (macOS-first; no provider accounts needed)

### Task 1: App scaffold (electron-forge + Vite + React + TS)

**Files:**
- Create: `app/package.json`, `app/forge.config.ts`, `app/vite.main.config.ts`, `app/vite.preload.config.ts`, `app/vite.renderer.config.ts`, `app/tsconfig.json`, `app/.npmrc` (`node-linker=hoisted`)
- Create: `app/src/main/index.ts` (creates a BrowserWindow with `contextIsolation:true`, `nodeIntegration:false`, `sandbox:false`), `app/src/preload/index.ts` (empty bridge for now), `app/src/renderer/index.html`, `app/src/renderer/main.tsx` (renders "Proxy Farm")
- Create: `app/vitest.config.ts`

**Interfaces:**
- Produces: a runnable Electron app; `pnpm --dir app dev` opens a window; `pnpm --dir app test` runs vitest.

- [ ] **Step 1:** Copy lingoreup's forge/vite/tsconfig structure (`/Users/robin/Personal/reclip/VideoCaptionerSystem/lingoreup/{forge.config.ts,vite.*.config.ts,tsconfig.json}`) into `app/`, strip the Python/api/ and MCP/agent specifics, keep the VitePlugin main/preload/renderer three-build setup and the NSIS + MakerZIP makers + GitHub publisher with `owner/repo = huuhoa143/proxy-farm`.
- [ ] **Step 2:** Add a trivial vitest test `app/src/main/smoke.test.ts` asserting `1+1===2`. Run `pnpm --dir app test` → PASS.
- [ ] **Step 3:** Run `pnpm --dir app dev`, confirm a window shows "Proxy Farm". (Manual; note in commit.)
- [ ] **Step 4: Commit** `chore: scaffold electron-forge + vite + react app`

### Task 2: sing-box prebuild fetcher

**Files:**
- Create: `app/scripts/prebuild-singbox.mjs`, `app/resources/.gitignore` (ignore fetched binaries)
- Create: `app/scripts/singbox.pins.json` (versions + sha256 from Global Constraints)
- Test: `app/scripts/prebuild-singbox.test.mjs`

**Interfaces:**
- Produces: `app/resources/sing-box/<platform>-<arch>/sing-box[.exe]` for the host platform; a `verifySha256(file, hex)` helper.

- [ ] **Step 1:** Write a test that calls `verifySha256` on a fixture file with a known and a wrong hash → true / throws.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Implement `prebuild-singbox.mjs`: read pins, download each tarball/zip to a temp path, `verifySha256` against the pin, extract the `sing-box` binary into `resources/sing-box/<platform>-<arch>/`, skip when the binary already exists with the right hash (cache). Add `"prebuild": "node scripts/prebuild-singbox.mjs"` and wire it as a `pregenerate`/`prestart` script.
- [ ] **Step 4:** Run the test → PASS; run the fetcher for the host platform, confirm the binary runs (`sing-box version` shows `with_gvisor,with_wireguard,with_openvpn`).
- [ ] **Step 5: Commit** `feat: pinned sing-box prebuild fetcher`

### Task 3: Engine path resolver + version gate

**Files:**
- Create: `app/src/main/engine/singbox-path.ts`
- Test: `app/src/main/engine/singbox-path.test.ts`

**Interfaces:**
- Produces: `singboxPath(): string` (dev: `resources/…`; packaged: `process.resourcesPath/sing-box/…`), `assertSingboxVersion(exec?): Promise<void>` (runs `sing-box version`, throws unless `1.14.2` with the three build tags).

- [ ] **Step 1:** Test `singboxPath()` returns the resources path for the current platform/arch; test `assertSingboxVersion` resolves on a stub that prints the right version string and rejects on a wrong one.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement both. Platform/arch map: `darwin-arm64`, `darwin-x64`→`darwin-amd64`, `win32-x64`→`windows-amd64`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: sing-box path + version gate`

### Task 4: Types & the ConfigRenderer scaffolding

**Files:**
- Create: `app/src/main/engine/types.ts` (shared domain types), `app/src/main/engine/render-config.ts`
- Test: `app/src/main/engine/render-config.test.ts`

**Interfaces:**
- Produces:
  - `type EndpointSpec = OpenVpnEndpoint | WireguardEndpoint` (the sing-box `endpoints[0]` object minus DNS/inbound/route, tag fixed to `"ep"`).
  - `interface RenderInput { endpoint: EndpointSpec; listen: { host: string; port: number; proxyAuth?: {username:string;password:string} }; clashPort: number; clashSecret: string }`
  - `renderConfig(input: RenderInput): string` → the full sing-box JSON as a string.

- [ ] **Step 1:** Write tests asserting that for a minimal OpenVPN `EndpointSpec`, `JSON.parse(renderConfig(input))` has: `route.final==="block"`; `outbounds` tags are exactly `["block"]`; one `inbounds[0].type==="mixed"` on the given host/port; `endpoints[0].system===false`; `dns.final==="dns-ep"` and `dns.servers[0]` is `{type:"https",server:"1.1.1.1",tag:"dns-ep",detour:"ep",...}`, `dns.strategy==="ipv4_only"`; `experimental.clash_api.external_controller` ends with `:${clashPort}` and `.secret===clashSecret`; **no** `experimental.v2ray_api` and **no** `services` entry of type `api`; `log.level==="info"`. Add a test: the returned value is a string and calling renderConfig performs no `fs` write (spy on `fs`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `renderConfig`. CA/keys always inline. Mirror the verified structure in `/tmp/pf-spike2/gen.py` (dns=dohfinal branch).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: ConfigRenderer with enforced invariants`

### Task 5: Port allocator (wildcard-aware)

**Files:**
- Create: `app/src/main/engine/ports.ts`
- Test: `app/src/main/engine/ports.test.ts`

**Interfaces:**
- Produces: `isPortFree(port:number): Promise<boolean>` (free only if a bind succeeds on **both** `127.0.0.1` and `0.0.0.0`), `allocatePort(preferred?:number, taken?:Set<number>): Promise<number>`.

- [ ] **Step 1:** Test: with a listener on `0.0.0.0:P`, `isPortFree(P)` is false; with nothing, true; `allocatePort` skips a port in `taken`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement using `net.createServer().listen({host,port})` twice, closing between.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: wildcard-aware port allocator`

### Task 6: Invariant suite across all provider fixtures

**Files:**
- Create: `app/src/main/engine/invariants.ts` (`assertConfigInvariants(parsed:any):void`), `app/src/main/engine/__fixtures__/endpoints.ts` (hand-written OpenVPN + WireGuard EndpointSpec samples — no real secrets)
- Test: `app/src/main/engine/invariants.test.ts`

**Interfaces:**
- Produces: `assertConfigInvariants` reused by Task 20 integration and callable in dev.

- [ ] **Step 1:** Write `assertConfigInvariants` tests: passes on a good rendered config; throws when `route.final!=="block"`, when any outbound other than `block`/the endpoint exists, when a DNS server has no `detour`, when `system` is true, when a `services` api entry is present.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the assertion; run `renderConfig` over both fixtures through it.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: config invariant checker over provider fixtures`

---

## Phase B — Providers (pure, fixture-driven; no live accounts)

### Task 7: Provider plugin contract + registry

**Files:**
- Create: `app/src/main/providers/types.ts`, `app/src/main/providers/registry.ts`
- Test: `app/src/main/providers/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface Target { key:string; country:string; city:string; providerId:string }`
  - `interface Provider { id:string; check(account:AccountInput): Promise<CheckResult>; targets(account:Account, catalog:Catalog): Target[]; bind(target:Target, account:Account): EndpointSpec }`
  - `registerProvider(p)`, `getProvider(id)`.

- [ ] **Step 1:** Test registering a fake provider and retrieving it; unknown id throws.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: provider registry + contract`

### Task 8: HMA provider + tokenCoreSE parser (macOS)

**Files:**
- Create: `app/src/main/providers/hma/token.ts` (parse `tokenCoreSE.json`), `app/src/main/providers/hma/index.ts`, `app/src/main/providers/hma/catalog.ts`
- Create: `app/resources/catalogs/hma-ovpn-seed.json` (copied from `origin/feat/hma-windows-openvpn:manager/catalogs/hma-ovpn-seed.json`), `app/resources/ca/sectigo-r46.pem`
- Test: `app/src/main/providers/hma/token.test.ts`, `hma.test.ts`

**Interfaces:**
- Consumes: Task 4 `EndpointSpec`, Task 7 `Provider`.
- Produces: `parseDeviceCreds(fileText:string): {udid:string; password:string}`; the `hma` Provider whose `bind` returns an OpenVPN `EndpointSpec` with inline Sectigo R46 CA, `server_name:"openvpn.gen-vpn.com"`, `data_ciphers:["AES-256-GCM"]`, `route_no_pull:true`, `explicit_exit_notify:2`, `mtu:1400`, and `username/password` from the device creds; catalog schema `{key,country,city,ips:[{ip,firstSeen,lastOk}]}` with `mergeCatalog(seed, feed)`.

- [ ] **Step 1:** Test `parseDeviceCreds` on a committed **redacted-shaped** fixture (base64 of `{"DeviceManager.device": base64({"udid":"U1.x.hma201.y","credentials":{"password":"<64hex>"}})}`) → returns the udid and password. Test `hma.bind()` output passes `assertConfigInvariants` after `renderConfig`, and that the catalog merge accumulates a new IP under an existing location key.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: HMA provider (device creds + catalog)`

### Task 9: ZoogVPN + Surfshark + file providers

**Files:**
- Create: `app/src/main/providers/zoogvpn/index.ts` + bundled CA/tls-auth + server list (from `haugene/vpn-configs-contrib`), `app/src/main/providers/surfshark/index.ts` + `clusters.ts` (public API fetch, 12 h cache), `app/src/main/providers/file/index.ts` (`.ovpn`/`.conf` parser)
- Test: one test file each.

**Interfaces:**
- Consumes: Task 4, Task 7.
- Produces: three Providers. Surfshark `bind`: WireGuard `EndpointSpec`, address `10.14.0.2/16`, peer pubKey from cluster, port 51820, mtu 1280, keepalive 25. ZoogVPN `bind`: OpenVPN, AES-256-GCM, auth SHA256, inline shared CA + tls-auth key-direction 1, `remote-cert-tls server`. File: parse remote/proto/cipher/auth/ca/tls-auth/tls-crypt and WireGuard `.conf`; reject unsupported directives with a thrown message.

- [ ] **Step 1:** Per provider: a test that `bind()` → `renderConfig` → `assertConfigInvariants` passes; Surfshark cluster parse from a fixture JSON; file parser accepts a good `.ovpn` and rejects one with an unsupported directive.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: ZoogVPN, Surfshark, file providers`

---

## Phase C — Supervisor, health, controller

### Task 10: Secrets store + schema-versioned state

**Files:**
- Create: `app/src/main/store/secrets.ts` (safeStorage wrapper), `app/src/main/store/state.ts` (atomic JSON with `schemaVersion`)
- Test: both.

**Interfaces:**
- Produces: `saveSecret(id,plaintext)`, `loadSecret(id)`, `getState()`, `setState(mutator)` (temp-file + rename). State shape: `{schemaVersion:1, ports:[{key,providerId,accountId,proxyPort,enabled}], settings:{...}, accounts:[...]}`.

- [ ] **Step 1:** Test state write is atomic (reads back the mutation; the temp file is gone). Test secrets round-trip with a `safeStorage` stub.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: safeStorage secrets + atomic versioned state`

### Task 11: EngineSupervisor — spawn via stdin, log ring, redaction

**Files:**
- Create: `app/src/main/engine/supervisor.ts`, `app/src/main/engine/log-ring.ts`
- Test: both (spawn a fake `sing-box` stub script for the process path).

**Interfaces:**
- Consumes: Task 3 `singboxPath`, Task 4 `renderConfig`.
- Produces: `class EngineProcess { start(configJson:string): void; stop(): Promise<void>; onLog(cb); onExit(cb); readonly logs: RingBuffer }`. Writes config to `child.stdin` then end; `-c stdin`. Redacts `username`/`password` values before buffering.

- [ ] **Step 1:** Test: start with a stub that echoes stdin length and stays up — the ring buffer never contains the literal password string passed in the config; `stop()` resolves and the child is gone. Test a bind-error stub (exit 1) fires `onExit` with code 1.
- [ ] **Step 2–4:** Fail → implement → pass. Stop: macOS/Linux SIGINT; win32 `taskkill /pid /t /f` (documented hard kill).
- [ ] **Step 5: Commit** `feat: engine supervisor (stdin spawn, log redaction)`

### Task 12: pid registry + orphan reaping + single instance

**Files:**
- Create: `app/src/main/engine/pid-registry.ts`
- Modify: `app/src/main/index.ts` (call `app.requestSingleInstanceLock()`, reap on startup, stop-all on `before-quit`)
- Test: `pid-registry.test.ts`

**Interfaces:**
- Consumes: Task 10 state dir.
- Produces: `recordPid(key,{pid,exe,startedAt})`, `reapOrphans(): Promise<number>` (kills only when pid **and** exe path **and** start time all match a recorded entry).

- [ ] **Step 1:** Test: a recorded entry whose pid now belongs to a different exe (or different start time) is NOT killed; a matching live stub IS killed. Test single-instance: second `requestSingleInstanceLock()` returns false (mock).
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: pid registry, orphan reaping, single instance`

### Task 13: Health signals (log + clash /delay)

**Files:**
- Create: `app/src/main/health/signals.ts` (parse log lines), `app/src/main/health/delay.ts` (clash API client)
- Test: both, using recorded log fixtures from `/tmp/pf-spike2` (copy the relevant lines into `__fixtures__`, secrets already absent).

**Interfaces:**
- Produces: `classifyLog(line:string): 'established'|'auth-terminal'|null`; `delayProbe(clashPort,secret,tag): Promise<{code:200|503|504; ms?:number}>` hitting `/proxies/<tag>/delay?url=https://www.gstatic.com/generate_204&timeout=5000`.

- [ ] **Step 1:** Test `classifyLog` on the two real lines (`tunnel established to …`, `authentication failed: terminal`) and a noise line → null. Test `delayProbe` maps HTTP 200/503/504 to the union (mock server).
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: health signals from logs + clash delay`

### Task 14: Health state machine + back-off

**Files:**
- Create: `app/src/main/health/state-machine.ts`, `app/src/main/health/backoff.ts`
- Test: both (fake timers).

**Interfaces:**
- Consumes: Task 13.
- Produces: `type PortState = 'queued'|'connecting'|'verifying'|'online'|{retrying:{untilMs:number;reason:string}}|{failed:'auth'|'not-in-plan'|'port-in-use'|'no-server'}|'stopped'`; `class PortHealth { feedLog(ev); feedDelay(code); feedExitIp(ok); readonly state }`; `nextBackoffMs(attempt): number` (30 s,1,2,4…≤30 min + jitter).

- [ ] **Step 1:** Tests: `established`→`connecting`→(exit-IP ok)→`online`; `auth-terminal`→`failed:auth` and retries keep scheduling (give_up_after 0); `/delay` 504 holds `retrying` with back-off growth 30→60→120…capped 1800 s; back-off has jitter within a bound.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: port health state machine + backoff`

### Task 15: PortManager — start/stop/rotate + exit-IP verify

**Files:**
- Create: `app/src/main/engine/port-manager.ts`, `app/src/main/health/exit-ip.ts` (ipify→ifconfig.co→ipinfo fallback, geo cache)
- Test: both.

**Interfaces:**
- Consumes: Tasks 4,5,7,10,11,13,14.
- Produces: `startPort(key)`, `stopPort(key)`, `rotatePort(key): Promise<{changed:boolean; reason?:string}>`, `probeExitIp(clashPort,secret): Promise<{ip:string;country:string}>`.
- Rotate selection order: another IP of the same location → another location in the same country → `{changed:false, reason:'no-server'}`; restart only that port; confirm the exit IP changed before `changed:true`.

- [ ] **Step 1:** Tests (with a fake supervisor + fake exit-IP): on `failed:auth` the manager stops the live process and schedules a retry on the long back-off; rotate on a multi-IP location restarts and returns `changed:true` only when the IP differs; a single-IP/single-city-country location returns `changed:false, reason:'no-server'`; `startPort` allocates a free port and records the pid.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: port manager with verified rotation`

### Task 16: Accounts pool + auto-rotate + limits

**Files:**
- Create: `app/src/main/accounts/pool.ts`, `app/src/main/engine/autorotate.ts`
- Test: both.

**Interfaces:**
- Consumes: Task 15.
- Produces: `pickAccount(providerId, {prefer?,exclude?}): Account`, `rebalance(providerId)`, `moveOnRefusal(key)`; `autoRotateEvery(key, minutes)`; per-provider `limit`.

- [ ] **Step 1:** Tests mirroring v1 `pick_account`/`rebalance`: emptiest usable account chosen; a pinned account honored; a refused (account,server) excluded; limit caps running ports per provider.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: account pools, auto-rotate, limits`

---

## Phase D — IPC, UI, webhook, power

### Task 17: IPC surface (preload bridge + main handlers)

**Files:**
- Create: `app/src/preload/index.ts` (contextBridge `window.pf`), `app/src/main/ipc/index.ts` (typed handlers), `app/src/shared/ipc-types.ts`
- Test: `app/src/main/ipc/index.test.ts`

**Interfaces:**
- Produces: `window.pf` methods: `listProviders`, `addAccount`, `checkAccount`, `listTargets`, `startPort`, `stopPort`, `rotatePort`, `setLimit`, `setAutoRotate`, `getStatus` (streams port states), `getLogs(key)`, `export(format)`, `getSettings`, `setSettings`. All via `ipcRenderer.invoke`/`on`; no HTTP.

- [ ] **Step 1:** Test each handler routes to the right controller method (mock controller) and that the preload exposes exactly this allowlist (no `require`, no arbitrary channel).
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: typed contextBridge IPC surface`

### Task 18: ZoogVPN plan-vs-password heuristic + failure reasons

**Files:**
- Modify: `app/src/main/providers/zoogvpn/index.ts`, `app/src/main/health/state-machine.ts`
- Create: `app/src/main/accounts/refusals.ts` (7-day cache per (account,server))
- Test: `refusals.test.ts`

**Interfaces:**
- Produces: `recordAuthFailure(accountId, serverKey)`, `classifyAuthFailure(accountId): 'not-in-plan'|'bad-login'` — not-in-plan when another server on the account works; bad-login when ≥3 servers fail and none works.

- [ ] **Step 1:** Tests: fail on server A while server B online → A `not-in-plan`; fail on 3 servers, none online → `bad-login`; cache entry expires after 7 days (fake timer).
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: ZoogVPN plan-vs-login heuristic`

### Task 19: Renderer UI (onboarding, main table, tray, i18n)

**Files:**
- Create: `app/src/renderer/` components (OnboardingCards, ProviderForms, PortTable, Settings, OtherVpnNote), `app/src/renderer/i18n/{en,vi}.json`, `app/src/renderer/i18n/index.ts`
- Create: `app/src/main/tray.ts`
- Test: `app/src/renderer/i18n/parity.test.ts` + a render smoke test per screen (testing-library)

**Interfaces:**
- Consumes: Task 17 `window.pf`.
- Produces: the four onboarding cards; the port table (status dot, `host:port` chip with copy, exit IP+country, latency, Copy, Rotate); bulk actions; export modal; settings; the grey "another VPN active" note (driven by a `window.pf` default-route signal); tray with online count.

- [ ] **Step 1:** Write the i18n parity test (every key in `en.json` exists in `vi.json` and vice-versa) and a smoke render of PortTable from a fake status. This task's UI is adapted from v1 `manager/ui.html`; the impeccable skill drives the visual pass and owner approves screenshots before merge.
- [ ] **Step 2–4:** parity test FAIL (stub locale) → fill → PASS; render smoke PASS.
- [ ] **Step 5: Commit** `feat: renderer UI + i18n (en/vi) + tray`

### Task 20: Power + webhook + integration harness

**Files:**
- Create: `app/src/main/power/index.ts` (powerSaveBlocker + suspend/resume), `app/src/main/webhook/index.ts` (opt-in listener)
- Test: `webhook.test.ts`, and an **integration** test `app/test/integration/engine.int.test.ts` that runs the real sing-box against a local WireGuard userspace peer + a local OpenVPN test server.

**Interfaces:**
- Consumes: Tasks 11,15.
- Produces: `startWebhook({port, bearer, hostAllowlist})` — `POST /rotate/<key>` only, constant-time bearer check, Host allowlist, no CORS, off by default; `installPowerHooks(portManager)`.

- [ ] **Step 1:** Webhook tests: GET → 405; wrong bearer → 401 (constant-time path); off-allowlist Host → 403; good → calls `rotatePort`. Integration: start a WG port and an OpenVPN port, assert online + a distinct exit vs a direct probe, assert an IPv6 literal through the proxy is refused, assert orphan reaping kills a deliberately-leaked child.
- [ ] **Step 2–4:** Fail → implement → pass (integration gated behind a `RUN_INT=1` env).
- [ ] **Step 5: Commit** `feat: power hooks + hardened rotate webhook + integration harness`

---

## Phase E — Windows helper (after a Windows spike; see §12)

> Do not start Phase E until the Windows spike confirms: the `auth` file format, the server cert/CA, and process-stop behaviour. Record findings in the spec before implementing.

### Task 21: Go helper service + pipe protocol + installer

**Files:**
- Create: `helper/main.go`, `helper/pipe_windows.go`, `helper/service_windows.go`, `helper/install/main.go`, `helper/go.mod`
- Create: `app/src/main/helper-client/index.ts` (named-pipe client, SCM server-PID verification)
- Test: `helper/*_test.go`, `app/src/main/helper-client/index.test.ts`

**Interfaces:**
- Produces: a LocalSystem service answering `GetVersion`, `GetHmaCredentials` (`{user,pass,ca,mtime}`), `Subscribe`→`CredentialsChanged`; pipe DACL = SYSTEM full + recorded user SID r/w, deny `FILE_CREATE_PIPE_INSTANCE` to others, deny Anonymous, `PIPE_REJECT_REMOTE_CLIENTS`, message mode, no shared secret; client verifies pipe-server PID == registered service PID (SCM) running as LocalSystem.

- [ ] **Step 1:** Go tests for the DACL builder (expected SDDL) and the message framing; TS test for the client rejecting a server whose PID ≠ the SCM-registered service PID (mock SCM).
- [ ] **Step 2–4:** Fail → implement → pass (unit-testable parts; live pipe behaviour is on the manual Windows checklist §10).
- [ ] **Step 5: Commit** `feat: Windows HMA helper service + client`

### Task 22: Windows HMA provider wiring + NSIS HMA-support option

**Files:**
- Modify: `app/src/main/providers/hma/index.ts` (use HelperClient on win32), `app/forge.config.ts` (NSIS `oneClick:false`, custom include with the "HMA support" checkbox that runs `ProxyFarmHelper-install.exe` elevated), `app/scripts/local-release.ps1`
- Test: extend `hma.test.ts` to cover the win32 credential source (mock HelperClient)

- [ ] **Step 1:** Test that on a simulated win32 platform the HMA provider pulls creds from the HelperClient (mock) and builds the same `EndpointSpec`, bundling both the Sectigo R46 and the helper-provided `ca.crt.pem`.
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5: Commit** `feat: Windows HMA wiring + NSIS HMA-support option`

---

## Phase F — Release

### Task 23: macOS release pipeline

**Files:**
- Create: `app/scripts/local-release.sh`, `app/scripts/sign-proxyfarm-bundle.sh`, `app/scripts/release-with-x64.sh`
- Modify: `app/forge.config.ts` (app-update.yml hook; attach source tarball note)

**Interfaces:**
- Produces: a notarized, stapled ZIP+DMG, `latest-mac.yml` (dual-arch, arm64 first), a `gh release` on `huuhoa143/proxy-farm` with the sing-box source tarball attached.

- [ ] **Step 1:** Port lingoreup `scripts/local-release.sh` + `sign-lingoreup-bundle.sh` + `release-with-x64.sh`, renaming to `sign-proxyfarm-bundle.sh`, identity `Developer ID Application: Chien Bui Minh (CCQUC3AGRH)`, notarize profile `PROXYFARM_NOTARIZE`, min macOS 12, app-translocation guard. Drop the Python/venv/cythonize steps.
- [ ] **Step 2:** `bash app/scripts/local-release.sh <ver> --dry-run` → rehearses without upload; confirm signing + notarize steps resolve and the source tarball is staged.
- [ ] **Step 3: Commit** `feat: macOS local release pipeline`

### Task 24: Windows release pipeline + v1 archival

**Files:**
- Create: `app/scripts/local-release.ps1`
- Create: `docs/README-v2.md`; tag note for `v1-docker`

**Interfaces:**
- Produces: an unsigned NSIS `Setup.exe` + `latest.yml` + `.blockmap` + sing-box source tarball uploaded to the release; the helper built first.

- [ ] **Step 1:** Port lingoreup `scripts/local-release.ps1`, adding a "build helper" step and the HMA-support NSIS include; keep it unsigned with the signing hook. Document (don't execute) — it runs on the Windows machine.
- [ ] **Step 2:** Tag the current Docker tree `v1-docker` (note in README) so v2 can remove Docker files from `main` later.
- [ ] **Step 3: Commit** `feat: Windows release pipeline + v1 archival note`

---

## Self-review notes

- **Spec coverage:** §2→T1-4; §3 architecture→T4,7,11,17; §4 UX/i18n→T19; §4.2 parity→T8,9,15,16,19; §5.1 HMA→T8,22; §5.2 Zoog→T9,18; §5.3 Surfshark→T9; §5.4 file→T9; §6.1 invariants→T4,6; §6.2 ports→T5,11; §6.3 lifecycle→T11,12; §6.4 health→T13,14; §6.5 rotate→T15; §6.6 webhook→T20; §6.7 power→T20; §7 helper→T21,22; §9 release→T23,24; §10 testing→woven per task + T20 integration.
- **Windows (Phase E) is gated** behind the spike in §12; Phases A–D and F(macOS) are independent of it.
- **Deferred:** the HMA server-discovery method and catalog-feed generator (spec §12, Windows track) are not a task here — they produce `catalog/hma.json`, which T8 already consumes.
