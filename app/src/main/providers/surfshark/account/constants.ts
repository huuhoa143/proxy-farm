/**
 * Static constants for the Surfshark account (mTLS + auth) path.
 *
 * Reverse-engineered from the Surfshark Windows app 6.20 (docs/SURFSHARK-API.md). The API
 * base, the embedded Cloudflare client certificate, its password, the device headers and the
 * endpoint paths below are exactly what the real app sends; proxy-farm presents the same
 * client so api.surfshark.com accepts its calls.
 */

/** Production API host. */
export const SS_API_BASE = 'https://api.surfshark.com';

/** Endpoint paths (relative to SS_API_BASE). */
export const SS_ENDPOINTS = {
  login: '/v1/auth/login',
  renew: '/v1/auth/renew',
  registerPublicKey: '/v1/account/users/public-keys',
  validatePublicKey: '/v1/account/users/public-keys/validate',
  me: '/v1/account/users/me',
} as const;

/** Device headers the app stamps on every call (x-device-*). proxy-farm fills x-device-id
 * with its own stable fingerprint; the rest are the app's fixed desktop values. */
export const SS_DEVICE = {
  type: 'desktop',
  platform: 'windows',
  brand: 'proxy-farm',
  model: 'desktop',
  appVersion: '6.20.0.999',
} as const;

/** User-Agent the app sends: `SurfsharkWindows/<ver> device/desktop`. */
export const SS_USER_AGENT = `SurfsharkWindows/${SS_DEVICE.appVersion} device/desktop`;

/**
 * Re-register a WireGuard public key once it is within this long of expiry. Matches the
 * app's `minimumKeyValidityBeforeExpiration` (1 day).
 */
export const SS_KEY_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/** Refresh the Bearer token this long before its JWT `exp`. */
export const SS_TOKEN_RENEW_SKEW_MS = 60 * 60 * 1000;

/**
 * The Cloudflare mutual-TLS CLIENT certificate (PKCS#12), exactly as the app embeds it
 * (`Surfshark.API.certificate.pfx`, CN=Cloudflare Windows). Base64 of the raw .pfx bytes.
 * api.surfshark.com requires it on every request; see account/net.ts.
 */
export const SS_CLIENT_PFX_BASE64 =
  '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' +
  'bWjof6h5BBDS6Ph5RCllUYd5zr/rkHZaAgIIAA==';


/** Password that unlocks SS_CLIENT_PFX_BASE64 — `base64(SHA512(UTF8("AuthorizationApiClient")))`,
 * computed by the app's Surfshark.Service.dll (verified: it loads the pfx above). */
export const SS_CLIENT_PFX_PASSWORD =
  'JhmJLqrU68Bg7i13rDQVO+1S/0btDDaqcS6OYiyRsjINKJ950TYhJ3SikhlgsqD+vPUhdF3bYSuvghw6EU2P0Q==';

/** The raw .pfx bytes, decoded once. */
export function clientPfx(): Buffer {
  return Buffer.from(SS_CLIENT_PFX_BASE64, 'base64');
}
