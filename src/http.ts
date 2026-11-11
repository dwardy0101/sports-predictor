/** fetch JSON with a timeout and a couple of retries. Never throws: data is null on failure. */

/**
 * Per-host request tally for the run. The bot is unattended, so "ESPN answered
 * 0 of 21 calls" is the difference between a quiet night and a broken feed.
 */
export const httpStats = {
  ok: 0,
  failed: 0,
  byHost: {} as Record<string, { ok: number; failed: number }>,
  reset() { this.ok = 0; this.failed = 0; this.byHost = {}; },
};

function tally(url: string, ok: boolean) {
  let host = "unknown";
  try { host = new URL(url).hostname; } catch { /* keep "unknown" */ }
  const h = (httpStats.byHost[host] ??= { ok: 0, failed: 0 });
  if (ok) { h.ok++; httpStats.ok++; } else { h.failed++; httpStats.failed++; }
}

export async function getJsonRes<T = any>(url: string, init: RequestInit = {}, retries = 2): Promise<{ data: T | null; headers?: Headers }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": "sports-predictor/0.3", Accept: "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        console.warn(`[http] ${res.status} ${redact(url)}`);
        tally(url, false);
        return { data: null, headers: res.headers };
      }
      const data = (await res.json()) as T;
      tally(url, true);
      return { data, headers: res.headers };
    } catch (err) {
      if (attempt === retries) {
        console.warn(`[http] failed ${redact(url)}: ${(err as Error).message}`);
        tally(url, false);
        return { data: null };
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return { data: null };
}

export async function getJson<T = any>(url: string, init: RequestInit = {}, retries = 2): Promise<T | null> {
  return (await getJsonRes<T>(url, init, retries)).data;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, keeping the input order.
 * The schedule fetches are dozens of independent calls to the same public API;
 * doing them one at a time made a slow run take minutes.
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  });
  await Promise.all(workers);
  return out;
}

function redact(url: string) {
  return url.replace(/(apiKey|token)=[^&]+/gi, "$1=***");
}

/** YYYYMMDD in UTC. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** ISO time without milliseconds (The Odds API rejects them). */
export const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Only https links are passed on (they end up in Telegram messages). */
export const httpsLink = (u: unknown): string | undefined => (typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u) ? u : undefined);

/** Lowercase, accents stripped, letters and digits only. For matching names across sources. */
export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
