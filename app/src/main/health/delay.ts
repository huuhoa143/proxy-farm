import type { DelayResult } from '../../shared/contracts';

const PROBE_URL = 'https://www.gstatic.com/generate_204';
const PROBE_TIMEOUT_MS = 5000;

/**
 * Hits sing-box's clash_api `/delay` endpoint for one proxy tag (spec §6.4).
 * Maps HTTP 200 → `{code:200, ms}`, 503 → `{code:503}` (dead/not ready),
 * 504 → `{code:504}` (silent black hole), anything else (bad status, network
 * failure, malformed body) → `{code:'error', message}`.
 */
export async function delayProbe(clashPort: number, secret: string, tag: string): Promise<DelayResult> {
  const url = `http://127.0.0.1:${clashPort}/proxies/${encodeURIComponent(tag)}/delay?url=${encodeURIComponent(PROBE_URL)}&timeout=${PROBE_TIMEOUT_MS}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
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
}
