/**
 * Constants for HMA's "se-platform" backend — the Avast/NLOK SecureLine API the HMA
 * Windows app (26.9) uses to discover servers dynamically, reverse-engineered from the
 * live client (docs/HMA-SE-PLATFORM.md). All values below are the app's own static
 * client identity, not secrets: the API key is embedded verbatim in every install.
 *
 * Flow (see ./client.ts):
 *   1. get-exact-application-licenses (Avast)       walletKey      -> containerId
 *   2. aladdin/v1/authorization/associate-license   license + fp   -> deviceUdid, JWT, refresh
 *   3. passage/v6/devices/{udid}/credentials         Bearer         -> devicePassword + CA
 *   4. discovery/v12/geos                            (no auth)      -> location list
 *   5. discovery/v9/discover?location_key=…          Bearer         -> fresh gateways
 *   6. elysium/v1/renew                              Basic nsv:udid -> next JWT + refresh token
 */

/** se-platform API host (discovery, passage, aladdin, elysium). */
export const SE_HOST = 'https://api.se-platform.com';

/** Avast license query host (step 1). */
export const AVAST_LICENSE_HOST = 'https://my-win.avast.com';

/** Static client API key embedded in the HMA Windows app — identifies the GVPN client to
 * se-platform. Public (shipped in every install), not an account secret. */
export const SE_CLIENT_API_KEY = 'DECE424681E71043331A3DB13CB0905E03EB605478F1584055ED0EECE80A3E01';

export const SE_CLIENT_NAME = 'GVPN';
export const SE_CLIENT_TYPE = 'hma101';
/** App version string the backend expects; purely cosmetic in requests. */
export const SE_CLIENT_VERSION = '26.9.12397';
export const SE_PLATFORM_ID = 'win-x86-64';
export const SE_SDK_VERSION = `win-${SE_CLIENT_VERSION}`;
export const SE_OS_TYPE = 'Windows 10 Pro';
export const SE_OS_VERSION = '10.0.19045';

/** Vaar headers for the Avast license query (step 1). */
export const AVAST_APP_BUILD_VERSION = '12397';
export const AVAST_APP_IPM_PRODUCT = '78';
export const AVAST_APP_PRODUCT_BRAND = 'PRIVAX';
export const AVAST_APP_PRODUCT_EDITION = 'HMA_VPN_CONSUMER';
export const AVAST_APP_PRODUCT_MODE = 'PAID';

/** The NLOK tenant every HMA device lives under (the GUID inside `U1.<tenant>.hma101.…`).
 * The app sends it on its very first call, before any device exists, and the backend binds
 * a new device under it whatever tenant a client claims — so it is per brand, not per user. */
export const HMA_TENANT_ID = '3bfdc5ab-a90f-4503-8349-34d0991d33a3';

/** Basic-auth user of `elysium/v1/renew` (`Basic base64("nsv:" + device_udid)`). */
export const ELYSIUM_RENEW_USER = 'nsv';

/** How long the app trusts a passage credential before re-fetching it: it stamps
 * `now + 7 days` itself when it parses the response (the API returns no expiry). */
export const DEVICE_CREDENTIALS_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

/** OpenVPN server port HMA gateways listen on (udp). */
export const OPENVPN_UDP_PORT = 1194;
/** OpenVPN server certificate CN, for `verify-x509-name` / sing-box `server_name`. */
export const OPENVPN_SERVER_NAME = 'openvpn.gen-vpn.com';
