/** The real-network `SeFetch`, wrapping the global `fetch` into the minimal shape the
 * se-platform client needs. Tests inject their own instead.
 *
 * A hard per-request timeout matters: without it a hung connection would leave the catalog
 * store's single in-flight refresh stuck forever (its `refreshing` guard never clears), so
 * discovery would silently stop until the app restarts. */
import type { SeFetch } from './types';

const REQUEST_TIMEOUT_MS = 15_000;

export const defaultSeFetch: SeFetch = async (url, init) => {
  const res = await fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: res.status, json: () => res.json(), text: () => res.text() };
};
