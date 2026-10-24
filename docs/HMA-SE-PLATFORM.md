# HMA se-platform (dynamic discovery) path

HMA's Windows app (26.9, `UseNlokVpnInfra=1`) no longer connects to a fixed server list. It
registers a device against the Avast/NLOK **se-platform** backend from the subscription
license key, mints its own token, and asks the backend for fresh gateways on every connect
— which is why its exit IPs are many and keep changing. proxy-farm replicates this for HMA
in `app/src/main/providers/hma/se-platform/`, so the HMA provider offers the same large,
rotating pool instead of the bundled static seed.

This document is the protocol, reverse-engineered from the live client. It contains **no
credentials** — every value shown is a placeholder or the app's public static client
identity (the embedded `SE-Client-API-Key`, shipped in every install).

## Endpoints

Host `https://api.se-platform.com` unless noted. All se-platform calls carry the static
`SE-Client-API-Key`, `SE-Client-Name: GVPN`, `SE-Client-Type: hma101`,
`SE-Client-Version`, `User-Agent: GVPN`, and `X-NLok-Tenant-ID: <tenant guid>`.

| Step | Call | In | Out |
|---|---|---|---|
| 1 | `POST my-win.avast.com/v1/query/get-exact-application-licenses` (Vaar headers, `Device-Id` = fingerprint) | `{walletKeys:[<licenseKey>]}` | license, `[0].id` = **container_id** |
| 2 | `POST /aladdin/v1/authorization/associate-license` (no Authorization) | `{container_id, device_fingerprint, wallet_key}` | `{device_udid, access_token (JWT ~12h), refresh_token}` |
| 3 | `PUT /passage/v6/devices/{udid}/credentials` (Bearer, body `null`) | — | `{device_udid, device_password (OpenVPN pw), openvpn_ca_certificate, certificate (PKCS#12), …}` |
| 4 | `GET /discovery/v12/geos` (Bearer) | — | countries → cities (`location_key`) |
| 5 | `GET /discovery/v9/discover?location_key=…` (Bearer) | — | gateways `{ip, protocol, udp_ports, geo}`; `expires_at−current_time ≈ 120s` |

- The elysium JWT's `sub` is the `device_udid` (`U1.<tenant>.hma101.<64hex>`); its `tenant`
  is the GUID embedded in the udid. **associate-license is idempotent** for a given
  `(container_id, device_fingerprint)`, so proxy-farm re-mints the token by calling it
  again rather than persisting the short-lived JWT.
- `discover` returns gateways for every protocol; proxy-farm uses only `protocol == "openvpn"`
  (udp/1194, servers under `*.gen-vpn.com`), which its existing OpenVPN engine path connects
  to with the device username/password.

## OpenVPN connect (what HMA itself does, confirmed)

```
openvpn --auth-user-pass <auth file>   # line 1 = device_udid, line 2 = device_password
        --ca <openvpn_ca_certificate> --remote <discovered ip> 1194 udp
        --client --dev tun --remote-cert-tls server
```
Server cert CN is `openvpn.gen-vpn.com`.

## How proxy-farm uses it

- **Account add** (`HmaCard` license-key field → `addAccount('hma', {licenseKey})` →
  `facade.connectHmaLicense`): registers proxy-farm's **own** device (a fresh random
  `device_fingerprint`, so it never shares — or disturbs — the installed HMA app's device
  and never burns an extra license slot on re-add, which reuses the stored fingerprint).
  The device `userpass` (udid + password) becomes the account secret; the durable identity
  (`walletKey`, `deviceFingerprint`, `tenant`, `containerId`, `deviceUdid`, `openvpnCa`)
  goes in `account.meta`.
- **Locations** (`targets`): the location list comes from `geos`; the per-location server
  pool is filled by repeated `discover` calls, folded into the on-disk catalog with the
  existing `mergeCatalog`, and keeps accumulating fresh IPs (`SeCatalogStore`).
- **Connect** (`bind`): OpenVPN to the discovered IP with the device credentials and the
  device's `openvpn_ca_certificate`.

## Module map

- `client.ts` — pure request/response for every endpoint (network injected as `SeFetch`).
- `device.ts` — device registration + `TokenMinter` (re-mint on expiry) + `account.meta` pack/unpack.
- `discover-source.ts` — discover → OpenVPN-only catalog feed for `mergeCatalog`.
- `catalog-store.ts` — geos (12h cache) + accumulating discover pool; `snapshot()` + throttled `kickRefresh()`.
- `jwt.ts` — read a JWT's `exp` (no verification).
- `constants.ts` / `net.ts` / `types.ts` — static client identity, real fetch, response shapes.

The legacy "local" path (credentials imported from an installed HMA app, bundled seed
catalog) is unchanged and still the default when no license key is entered.
