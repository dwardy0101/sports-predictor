/** fetch JSON with a timeout and a couple of retries. Never throws: data is null on failure. */
export async function getJsonRes<T = any>(url: string, init: RequestInit = {}, retries = 2): Promise<{ data: T | null; headers?: Headers }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": "sports-predictor/0.2", Accept: "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        console.warn(`[http] ${res.status} ${redact(url)}`);
        return { data: null, headers: res.headers };
      }
      return { data: (await res.json()) as T, headers: res.headers };
    } catch (err) {
      if (attempt === retries) {
        console.warn(`[http] failed ${redact(url)}: ${(err as Error).message}`);
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
