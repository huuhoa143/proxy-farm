/**
 * The real-network `SsFetch`: Node's `fetch` (undici) with the Surfshark Cloudflare client
 * certificate attached, because every api.surfshark.com call is mutual-TLS. The cert is
 * carried on an undici `Agent` passed as the request `dispatcher`; a hard per-request
 * timeout keeps a hung connection from stalling token/key refresh forever.
 *
 * Tests never use this — they inject their own `SsFetch` (no TLS, no cert).
 */
// `fetch` is imported from undici (not the global) on purpose: a `dispatcher` built from this
// package's `Agent` is only compatible with this package's `fetch`. Mixing the standalone
// Agent with Node/Electron's built-in global fetch throws `invalid onRequestStart` (confirmed
// live), so both must come from the same undici instance.
import { Agent, fetch } from 'undici';
import { clientPfx, SS_CLIENT_PFX_PASSWORD } from './constants';
import type { SsFetch } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

let agent: Agent | undefined;

/** The mTLS dispatcher, built once. `connect.pfx`/`passphrase` are passed straight to
 * Node's TLS layer, so the Cloudflare client cert is presented on every connection. */
function mtlsAgent(): Agent {
  agent ??= new Agent({ connect: { pfx: clientPfx(), passphrase: SS_CLIENT_PFX_PASSWORD } });
  return agent;
}

export const defaultSsFetch: SsFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    dispatcher: mtlsAgent(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, json: () => res.json(), text: () => res.text() };
};
