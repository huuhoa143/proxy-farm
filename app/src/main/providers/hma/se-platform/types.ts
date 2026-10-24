/**
 * Response shapes for the se-platform API (see ./client.ts). Only the fields proxy-farm
 * uses are modelled; everything else in the JSON is ignored.
 */

/** A minimal fetch, so tests can inject a fake without a real network. Matches the subset
 * of the global `fetch` contract the client relies on. */
export type SeFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<SeResponse>;

export interface SeResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Avast license record (step 1); only `id` (= container_id) and expiry are used. */
export interface SeLicense {
  /** License container id — the `container_id` associate-license needs. */
  id: string;
  walletKeys: string[];
  /** Epoch ms the subscription expires. */
  expires?: number;
  mode?: string;
}

/** An elysium token pair (associate-license / elysium renew). */
export interface SeTokens {
  /** elysium RS256 JWT, ~12h TTL. */
  accessToken: string;
  /** Single-use: a renew spends it and returns the next one. */
  refreshToken: string;
}

/** associate-license result (step 2). */
export interface SeDeviceToken extends SeTokens {
  /** `U1.<tenant>.hma101.<64hex>` — the OpenVPN username and the token subject. */
  deviceUdid: string;
}

/** passage credentials (step 3). */
export interface SeDeviceCredentials {
  deviceUdid: string;
  /** 64-hex OpenVPN password (auth file line 2). */
  devicePassword: string;
  /** PEM CA that signs the OpenVPN server cert (openvpn.gen-vpn.com). */
  openvpnCaCertificate: string;
  /** PKCS#12 bundle (base64) for IKEv2/mimic/WireGuard; kept for completeness. */
  certificate?: string;
  certificatePassword?: string;
}

/** One city under a country in the geos list (step 4). */
export interface SeGeoCity {
  locationKey: string; // e.g. 'US-HI-HONOLULU'
  city: string;
  active: boolean;
}

/** One country in the geos list (step 4). */
export interface SeGeoCountry {
  locationKey: string; // country code, e.g. 'US'
  countryCode: string;
  countryName: string;
  active: boolean;
  cities: SeGeoCity[];
}

/** A VPN protocol se-platform can hand back for a gateway. */
export type SeProtocol = 'openvpn' | 'wireguard' | 'ipsec' | 'mimic';

/** One gateway from a discover call (step 5). */
export interface SeGateway {
  ip: string;
  protocol: SeProtocol;
  /** TCP ports (openvpn/mimic). */
  ports?: number[];
  /** UDP ports (openvpn: [1194]; ipsec: [500,4500]). */
  udpPorts?: number[];
  countryCode: string;
  locationKey: string;
  city: string;
}

/** A discover response (step 5): gateways plus how long they stay valid. */
export interface SeDiscoverResult {
  gateways: SeGateway[];
  /** Server clock (epoch seconds) at the time of the response. */
  currentTime: number;
  /** Epoch seconds these gateways stop being offered (≈ currentTime + 120). */
  expiresAt: number;
}
