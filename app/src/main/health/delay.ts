import type { DelayResult } from '../../shared/contracts';

const PROBE_URL = 'https://www.gstatic.com/generate_204';
/** Server-side `timeout` query param: how long sing-box itself waits on the probe URL. */
export const PROBE_TIMEOUT_MS = 5000;
/** Client-side hard cap, a few seconds above `PROBE_TIMEOUT_MS`: a healthy clash_api always
 * answers within its own timeout, so silence past this means the controller itself is not
 * responding (e.g. the process is wedged or SIGSTOPped). */
export const FETCH_TIMEOUT_MS = PROBE_TIMEOUT_MS + 3000;

export interface DelayProbeOptions {
  /** Client-side hard timeout covering the whole request, body included. @default 8000 */
  fetchTimeoutMs?: number;
  /** @default globalThis.fetch — injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Hits sing-box's clash_api `/delay` endpoint for one proxy tag (spec §6.4).
 * Maps HTTP 200 → `{code:200, ms}`, 503 → `{code:503}` (dead/not ready),
 * 504 → `{code:504}` (silent black hole), anything else (bad status, network
 * failure, malformed body) → `{code:'error', message}`. If the controller does
 * not answer within the hard timeout the result is `{code:'error', timedOut:true}`.
 *
 * The timeout is a plain `setTimeout` + `AbortController` that also races the
 * request, so it settles even if the fetch implementation ignores the signal.
 */
export async function delayProbe(clashPort: number, secret: string, tag: string, opts: DelayProbeOptions = {}): Promise<DelayResult> {
  const url = `http://127.0.0.1:${clashPort}/proxies/${encodeURIComponent(tag)}/delay?url=${encodeURIComponent(PROBE_URL)}&timeout=${PROBE_TIMEOUT_MS}`;
  const timeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const doFetch = opts.fetchFn ?? fetch;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DelayResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ code: 'error', timedOut: true, message: `delayProbe: clash_api did not answer within ${timeoutMs} ms` });
    }, timeoutMs);
  });

  const request = (async (): Promise<DelayResult> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: controller.signal });
    } catch (err) {
      return { code: 'error', message: `delayProbe: request failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (res.status === 503) return { code: 503 };
    if (res.status === 504) return { code: 504 };

    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        return { code: 'error', message: `delayProbe: 200 response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
      }
      const ms = (body as { delay?: unknown })?.delay;
      if (typeof ms === 'number' && Number.isFinite(ms)) {
        return { code: 200, ms };
      }
      return { code: 'error', message: `delayProbe: 200 response missing numeric "delay" field: ${JSON.stringify(body)}` };
    }

    return { code: 'error', message: `delayProbe: unexpected HTTP status ${res.status}` };
  })();

  try {
    // Whichever settles first. Once the timer has fired, the aborted request's own
    // (later) error result is dropped.
    return await Promise.race([request, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
