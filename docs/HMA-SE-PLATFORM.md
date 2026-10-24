# HMA se-platform (dynamic discovery) path

HMA's Windows app (26.9, `UseNlokVpnInfra=1`) no longer connects to a fixed server list. It
registers a device against the Avast/NLOK **se-platform** backend from the subscription
license key, mints its own token, and asks the backend for fresh gateways on every connect
— which is why its exit IPs are many and keep changing. proxy-farm replicates this for HMA
in `app/src/main/providers/hma/se-platform/`, so the HMA provider offers the same large,
rotating pool.

This document is the protocol, reverse-engineered from the live client (TLS captured from
`VpnSvc.exe`, then confirmed by decompiling it with Ghidra). It contains **no credentials** —
every value shown is a placeholder or the app's public static client identity (the embedded
`SE-Client-API-Key`, shipped in every install).

## Endpoints

Host `https://api.se-platform.com` unless noted. Every se-platform call carries
`Accept: application/json`, `Cache-Control: no-cache`, `Content-Type: application/json;
charset=utf-8` (GETs included), the static `SE-Client-API-Key`, `SE-Client-Name: GVPN`,
`SE-Client-Type: hma101`, `SE-Client-Version`, `User-Agent: GVPN` and `X-NLok-Tenant-ID`.
On top of that the app adds, per endpoint:

- associate-license: `SE-Client-Locale`, `SE-Operating-System-Type/-Version`,
  `SE-Platform-ID`, `SE-SDK-Version`;
- geos: `SE-Client-Locale` only;
- passage, discover, renew: nothing more.

The tenant is HMA's (`3bfdc5ab-…`, the GUID inside every HMA `device_udid`); the app sends
it before any device exists, and the backend binds new devices under it whatever a client
claims.

| Step | Call | In | Out |
|---|---|---|---|
| 1 | `POST my-win.avast.com/v1/query/get-exact-application-licenses` (Vaar headers, `Device-Id` = fingerprint, no `Content-Type`) | `{walletKeys:[<licenseKey>]}` | license, `[0].id` = the container id |
| 2 | `POST /aladdin/v1/authorization/associate-license` (no Authorization) | `{container_id: <license id without '-'>, device_fingerprint, wallet_key}` | `{device_udid, access_token (JWT ~12h), refresh_token}` |
| 3 | `PUT /passage/v6/devices/{udid}/credentials` (Bearer, body `null`) | — | `{device_udid, device_password (OpenVPN pw), openvpn_ca_certificate, certificate (PKCS#12), …}` |
| 4 | `GET /discovery/v12/geos` (**no** Authorization) | — | countries → cities (`location_key`) |
| 5 | `GET /discovery/v9/discover?location_key=…` (Bearer) | — | gateways `{ip, protocol, udp_ports, geo}`; `expires_at−current_time ≈ 120s` |
| 6 | `POST /elysium/v1/renew` (`Authorization: Basic base64("nsv:" + device_udid)`) | `{grant_type: "refresh_token", refresh_token}` | `{access_token, refresh_token}` — the refresh token is single-use and rotates |

- The elysium JWT's `sub` is the `device_udid` (`U1.<tenant>.hma101.<64hex>`).
- **Token lifetime.** The app renews only when its JWT is within 15 s of `exp`, with step 6.
  A 410 from renew means the device was removed from the license: the app drops its bind
  data and associates again. associate-license is idempotent for a given
  `(container_id, device_fingerprint)` (same udid back) — unless that device was removed,
  in which case it binds a **new** udid.
- **Credential lifetime.** The passage response carries no expiry; the app stamps
  `now + 7 days` itself when it parses it (`HmaProVpn.ini` `…CredentialsValidity`) and calls
  step 3 again once that passes. Step 3 rotates the device password.
- `discover` returns gateways for every protocol; proxy-farm uses only `protocol == "openvpn"`
  (udp/1194, servers under `*.gen-vpn.com`). The app discovers one location per connect
  (and on "Shuffle IP"); it never sweeps every country.

## OpenVPN connect (what HMA itself does, confirmed)

```
openvpn --auth-user-pass <auth file>   # line 1 = device_udid, line 2 = device_password
        --ca <openvpn_ca_certificate> --remote <discovered ip> 1194 udp
        --client --dev tun --remote-cert-tls server
```
Server cert CN is `openvpn.gen-vpn.com`. One device holds many concurrent sessions on the
same password.

## How proxy-farm uses it

- **Account add** (`HmaCard` license-key field → `addAccount('hma', {licenseKey})` →
  `facade.connectHmaLicense`): registers proxy-farm's **own** device under HMA's tenant, with
  a fingerprint derived from this machine (`fingerprint.ts`), so it never shares — or
  disturbs — the installed HMA app's device and re-adding reuses the same device slot. The
  device `userpass` (udid + password), the license key and the refresh token are the
  encrypted account secret; the non-secret identity (`deviceFingerprint`, `tenant`,
  `containerId`, `deviceUdid`, `openvpnCa`, `credsAt`) goes in `account.meta`.
- **Tokens** (`TokenMinter`): renews with the stored refresh token (step 6) and writes the
  rotated one back at once; falls back to associate-license when renew is refused. If
  associate-license returns a different udid, the provider fetches that device's
  credentials and replaces the account's. A 401 on any call drops the cached token and
  retries once with a new one (`withToken`).
- **Credentials**: re-fetched (step 3) once 7 days old while the account has no port
  switched on, or when a connection is refused with nothing online — or refused three times
  in a row even though a sibling port is online (that sibling only survives on a session it
  opened before the password went stale).
- **Locations** (`targets`): the location list comes from `geos`; a location's gateways are
  discovered on demand — when a port is added there, on Change IP, when its server list is
  opened — and re-discovered every 10 minutes while a port holds it. The results are folded
  into the on-disk catalog with `mergeCatalog`. "Load locations" re-fetches the geos list.
- **Connect** (`bind`): OpenVPN to the discovered IP with the device credentials and the
  device's `openvpn_ca_certificate`.

## Module map

- `client.ts` — pure request/response for every endpoint (network injected as `SeFetch`).
- `device.ts` — device registration, `TokenMinter` (renew → associate fallback), `withToken`,
  the 7-day `credentialsDue` check, `account.meta` pack/unpack.
- `discover-source.ts` — discover → OpenVPN-only catalog feed for `mergeCatalog`.
- `catalog-store.ts` — geos (12h cache) + the discovered pool; `snapshot()` + on-demand `refreshOne()`.
- `fingerprint.ts` — the machine-derived device fingerprint.
- `jwt.ts` — read a JWT's `exp` (no verification).
- `constants.ts` / `net.ts` / `types.ts` — static client identity, real fetch, response shapes.
