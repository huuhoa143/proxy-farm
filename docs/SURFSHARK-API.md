# Surfshark API — the standard client flow

How the real Surfshark Windows app (6.20, .NET) talks to `api.surfshark.com`, and how
proxy-farm replicates the parts it needs. Reverse-engineered from the shipped managed
assemblies (`Surfshark.API.dll`, `Surfshark.Service.dll`, `Surfshark.dll`) on 2026-10-24;
two secrets (the mTLS pfx password, the location-blob passphrase) were confirmed by
offline decryption. See the `surfshark-api-discovery` memory for the raw evidence trail.

## Transport

* **Base URL** `https://api.surfshark.com` (`ApiOptions`: `"https://api." + ("surfshark.com" | "surfsharktest.com")`).
* **Mutual TLS.** Every `api.surfshark.com` call presents a **Cloudflare client certificate**,
  shipped as an embedded resource (`Surfshark.API.certificate.pfx`, `CN=Cloudflare Windows`)
  and loaded with the password `base64(SHA512(UTF8("AuthorizationApiClient")))`. There is **no
  static `Api-Key`** on the main API (the `Api-Key` header exists only for the Notification
  Center path, whose key is fetched at runtime). proxy-farm bundles the same cert
  (`account/constants.ts`) and attaches it through an undici `Agent` (`account/net.ts`).
* **Headers** on every call: `Authorization: Bearer <authenticationToken>`,
  `x-device-id: <fingerprint>`, `x-device-type: desktop`, `x-device-platform: windows`,
  `x-device-brand/-model/-version`, `User-Agent: SurfsharkWindows/<ver> device/desktop`,
  and `SS-GENERATED-AT: <ISO8601>` / `SS-CUR` on some calls.
* **Domain failover.** The app retries an alternate API domain when the primary host is
  unreachable; proxy-farm keeps a single host plus its existing DNS-pool resilience.

## Authentication

For an **email + password** Surfshark account (the common case) the app uses the native
token endpoints — no browser:

1. `POST /v1/auth/login` body `{ "username": <email>, "password": <password> }`
   → `{ "renewalToken": "...", "authenticationToken": "..." }` (`Tokens`).
   May instead demand 2FA / a login code (`/v1/auth/remote`, `otp`/`code` bodies); surfaced
   to the user when it happens.
2. The **`authenticationToken`** is the `Authorization: Bearer` token (a JWT; its `exp` is
   parsed to know when to renew).
3. `POST /v1/auth/renew` with the **`renewalToken`** → a fresh token pair.

proxy-farm uses the password **once** to obtain the token pair, then stores only the
`renewalToken` (encrypted secret) and renews from it — the password is never persisted.

> Social login (Google / Apple / Microsoft) uses a browser + `auth.surfshark.com/oauthredirect/*`
> and the app's `/v1/challenge/` + `/v2/oauth/` PKCE exchange. Not implemented here (email/password
> covers a normal subscription); the architecture leaves room to add it.

## Device identity

The app derives `x-device-id` from a hardware fingerprint (SHA256 over WMI CPU/RAM/disk/NIC)
and caches it. proxy-farm derives **its own** stable fingerprint from the machine id
(`MachineGuid` on Windows, `IOPlatformUUID` on macOS), salted so it never collides with the
app's — one machine is one proxy-farm device, stable across re-add and reinstall, distinct
from the installed Surfshark app's device. Same approach as `hma/se-platform/fingerprint.ts`.

## WireGuard key registration (the piece proxy-farm was missing)

Surfshark WireGuard keys are **account-bound and expire**. The server completes a handshake
only for a **registered, non-expired** client public key — this is why a stale downloaded
`.conf` key silently fails to handshake.

* `POST /v1/account/users/public-keys` body `{ "pubKey": "<base64 public key>" }`
  → `{ "PublicKey": "...", "ExpiresAt": "<ISO8601>" }` (`PublicKeysResponse`).
* `POST /v1/account/users/public-keys/validate` — confirms a key is still valid.
* Re-register when `ExpiresAt − now < 1 day` (`minimumKeyValidityBeforeExpiration` in the
  app's appsettings; retry 2× with 6 s backoff, 30 s timeout).

proxy-farm generates its own X25519 keypair (`wg-key.ts#generateWgKeyPair`), registers the
public key, tracks `ExpiresAt`, and re-registers before expiry (`refreshCredentials`). The
private key is the account's `wgkey` secret; `bind()` pairs it with the cluster's peer
public key (from the cluster list) and a pool server IP — unchanged from the manual-`.conf`
path, which stays as a fallback.

## Server list

* The app fetches clusters per country on **v5**:
  `GET /v5/server/clusters/{generic,static,obfuscated}?countryCode=<cc>`.
  proxy-farm keeps using `GET /v4/server/clusters/all` (one call, still served) — same record
  shape (`countryCode/country/location/connectionName/pubKey/type/tags`); only the peer
  public key and hostname are needed, and both are plaintext.
* Each record's `info[].entry.value` is an OpenSSL `Salted__` AES-256-CBC blob (MD5
  `EVP_BytesToKey`) holding only the **entry IPv4**. proxy-farm does **not** need it — its
  DNS-pool sampling already discovers server IPs. (Bundled-seed passphrase, if ever wanted:
  `ec1-41-61-52-81.eu-west-42-31-91535.console.amazonaws.com`.)

## proxy-farm module layout (`app/src/main/providers/surfshark/`)

* `account/constants.ts` — hosts, endpoints, embedded Cloudflare client cert + password,
  device-header constants, key-renewal threshold.
* `account/net.ts` — `SsFetch` over undici with the mTLS client cert attached.
* `account/fingerprint.ts` — stable machine-derived device fingerprint (`x-device-id`).
* `account/client.ts` — pure request/response: `login`, `renewTokens`, `registerPublicKey`,
  `validatePublicKey`; builds the device + auth headers. Errors as `SsError{kind}`.
* `account/session.ts` — token store that renews from the `renewalToken`, plus the WG-key
  registration/renewal helper.
* `index.ts` — provider: `resolveInput` (login → register device + WG key), `check`,
  `targets` (clusters + DNS pool, unchanged), `refreshCredentials` (renew token + WG key),
  `bind` (unchanged). The manual-`.conf` path stays as a fallback.
