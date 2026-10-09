# Contributing to Proxy Farm

Thanks for helping. Bug reports, fixes, translations and provider support are all
welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- Questions: [Discussions](https://github.com/huuhoa143/proxy-farm/discussions).
- Bugs and feature requests: [Issues](https://github.com/huuhoa143/proxy-farm/issues).
- Security problems: [SECURITY.md](SECURITY.md), never a public issue.

For anything bigger than a small fix, open an issue or discussion first so we can agree
on the approach before you spend time on it.

## Development setup

Requirements:

- macOS 12+ or Windows 10/11 x64.
- Node.js 22 (≥ 22.22.2) or 24 (≥ 24.15.0). jsdom, used by the unit tests, requires one
  of these.
- pnpm.

```bash
git clone https://github.com/huuhoa143/proxy-farm.git
cd proxy-farm/app
pnpm install
pnpm start      # downloads the pinned sing-box once, then runs the app
pnpm dev        # runs the app without the sing-box download step
```

`app/scripts/prebuild-singbox.mjs` downloads sing-box 1.14.2 for your platform from the
official SagerNet releases and refuses any file whose sha256 differs from
`app/scripts/singbox.pins.json`. It runs automatically before `pnpm start`,
`pnpm package` and `pnpm make`.

To run with a throwaway data folder instead of your real one, set
`PROXYFARM_USER_DATA_DIR=/some/empty/dir`.

## Project layout

```
app/
  src/
    main/          Electron main process
      providers/   one folder per provider: hma, zoogvpn, surfshark, nordvpn, expressvpn, file
      controller/  port manager, Change IP, auto-rotate, server health, settings
      engine/      sing-box config renderer + invariants, supervisor, log ring, pid registry
      health/      /delay probe, exit-IP probe, back-off, port state machine
      accounts/    multi-account pools and refusal memory
      store/       state.json store and safeStorage secret store
      bootstrap/   app wiring: IPC facade, updater, HMA local credentials, tray, speed test
      ipc/         IPC handlers
      power/       keep-awake, sleep/wake
      webhook/     optional rotate webhook
    preload/       contextBridge API exposed to the renderer
    renderer/      React UI; i18n/en.json and i18n/vi.json hold every string
    shared/        contracts.ts: types shared by main, preload and renderer
  resources/       bundled CA certificates and server catalogs
  scripts/         sing-box prebuild, maintainer server scans, release scripts
  tests/e2e/       Playwright tests against the packaged app
docs/              design spec and screenshots
```

The design document,
[docs/superpowers/specs/2026-10-07-desktop-app-design.md](docs/superpowers/specs/2026-10-07-desktop-app-design.md),
explains the reasoning behind the engine, health checks and server pools.

## Tests

From `app/`:

```bash
pnpm test                # unit tests (vitest), hermetic: no network, no real VPN
pnpm exec tsc --noEmit   # type check
pnpm package && pnpm test:e2e
                         # end-to-end tests against the packaged app, using local
                         # WireGuard peers on this computer (no VPN account needed)
```

On Windows the e2e suite's WireGuard peers run from `%TEMP%\pf-e2e-wg-peer\`; Windows
Firewall asks once to allow them (they listen on every interface). The app's own engines
never trigger that prompt.

Unit tests must not touch the network or real provider servers. Inject network access
(see `PoolNet` in `providers/surfshark/pool.ts` or the probe functions in
`controller/engine-adapter.ts`) and use fixtures.

## Respect providers

Proxy Farm runs on other companies' VPN infrastructure. Do not make it look like abuse.

- **Never write code or tests that hammer provider servers.** No tight retry loops, no
  mass parallel connects, no repeated logins. The app's back-off and start queue exist for
  this reason; do not bypass them.
- **Rate-limit live experiments.** When you test against real servers by hand, keep it to
  a few connections and space attempts out (the project's own live checks use at most one
  attempt per location per 10 minutes). A WireGuard key that gets no answer is not a dead
  server: stop after two or three tries. Mass failed WireGuard handshakes got a Surfshark
  account's VPN access suspended on 2026-10-08.
- Server discovery that probes networks (`pnpm scan:hma-servers`,
  `pnpm scan:zoog-servers`) is a maintainer job, run rarely. Do not add probing to code
  that runs on users' machines.
- Use your own accounts only.

## Adding a provider

1. Add the id to `ProviderId` in `app/src/shared/contracts.ts`.
2. Create `app/src/main/providers/<id>/index.ts` that implements the `Provider`
   interface from `contracts.ts`:
   - `check(input)`: validate and normalise the user's input, with no network access;
     return the secret to store and display metadata.
   - `targets(account)`: the account's locations, each with its pool of servers.
   - `bind(target, serverIp, account, secret)`: return the sing-box endpoint
     (`wireguard` or `openvpn-client`) for one server. Keep it pure.
3. Register it in `app/src/main/providers/index.ts`.
4. Add the onboarding card and form in `app/src/renderer/components/OnboardingCards.tsx`
   and `Onboarding.tsx`, the display name in `app/src/renderer/ui/providerName.ts`, and
   all strings in both `en.json` and `vi.json`. If the user has to fetch a credential
   from the provider's website, give the card a `guide` (numbered steps, see
   `CredentialGuide.tsx`) and add the page it starts on to `PROVIDER_LINKS` in
   `app/src/shared/links.ts`: only listed URLs open in the browser.
5. Add unit tests with recorded fixtures. The config invariants in
   `app/src/main/engine/invariants.ts` must pass for your provider's output.
6. If the provider needs a new network endpoint, list it in [PRIVACY.md](PRIVACY.md).

Look at `providers/zoogvpn` (OpenVPN, username/password), `providers/expressvpn`
(OpenVPN with a shared client certificate, bundled server list, DNS pools) or
`providers/surfshark` (WireGuard, public server API) for complete examples.

## Commit messages

Follow the style of the existing history:

- Subject in the imperative mood, at most 72 characters, no trailing period:
  `Keep a port's exit IP through drops and correlated outages`. An optional area prefix
  is fine: `controller: …`, `surfshark: …`, `i18n: …`.
- Blank line, then a body that explains **why**: the problem, and why this change fixes
  it. The diff already shows what changed.
- One logical change per commit.

## Pull request checklist

- [ ] `pnpm test` passes.
- [ ] `pnpm exec tsc --noEmit` passes.
- [ ] New behaviour has tests.
- [ ] Every new or changed UI string is in **both** `app/src/renderer/i18n/en.json` and
      `vi.json` (a unit test checks key parity).
- [ ] No secrets, VPN configs, `.env` files, account data, personal IPs or logs with
      credentials are committed.
- [ ] New network calls are documented in PRIVACY.md.
- [ ] UI changes include a screenshot in the PR.

## Releasing (maintainers)

Releases are built on the maintainer's machines, not in CI, because signing and
notarization need long-lived credentials:

- macOS: `bash app/scripts/local-release.sh <X.Y.Z>` (`--dry-run` to rehearse,
  `--resume` after a failure); `app/scripts/release-with-x64.sh <X.Y.Z>` adds an Intel
  build.
- Windows: `app\scripts\local-release.ps1 <X.Y.Z>`.

Each release attaches the matching sing-box source tarball (GPL-3.0 §6). Update
[CHANGELOG.md](CHANGELOG.md) before tagging.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
