/**
 * Shared types for the Surfshark account (mTLS + auth) path. Network is abstracted behind
 * `SsFetch` so the client is pure and tests stay hermetic (no real TLS, no mTLS cert).
 */

/** The minimal response shape the client needs from a fetch. */
export interface SsResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The injectable network function. The real one (account/net.ts) attaches the mTLS client
 * certificate; tests pass a fake. */
export type SsFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<SsResponse>;

/** The token pair `/v1/auth/login` and `/v1/auth/renew` return. */
export interface SsTokens {
  /** Long-lived token used to mint fresh access tokens via /v1/auth/renew. Stored encrypted. */
  renewalToken: string;
  /** Short-lived JWT sent as `Authorization: Bearer`. Never persisted. */
  authenticationToken: string;
}

/** A registered WireGuard public key and when it expires. */
export interface SsPublicKey {
  /** The public key the server now recognises for this account. */
  publicKey: string;
  /** Epoch ms the registration expires; re-register before it. */
  expiresAtMs: number;
}
