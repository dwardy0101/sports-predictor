/**
 * The Odds API (free tier: 500 credits/month). One call = 1 credit for one
 * sport, one region, one market. To make the free tier last:
 *  - we only ask for sports that have matches about to start that we haven't sent yet,
 *  - each call is limited to that time range,
 *  - OddsBudget caps how much each day may spend.
 * Listing the sports (/sports) is free.
 */
import { config, ESPN_LEAGUES, ODDS_PRIORITY } from "../config.ts";
import { getJson, getJsonRes, isoSec } from "../http.ts";
import type { OddsBudget } from "../odds/budget.ts";
import type { BookPrice, Match } from "../types.ts";

const BASE = "https://api.the-odds-api.com/v4";

/** Returns the matches left without odds only because the budget ran out (so they can be retried). */
export async function attachOdds(matches: Match[], budget: OddsBudget): Promise<Match[]> {
  const deferred: Match[] = [];
  if (!config.oddsApiKey || !matches.length) return deferred;

  const byKey = new Map<string, Match[]>();
  const add = (k: string, m: Match) => byKey.set(k, [...(byKey.get(k) ?? []), m]);
  const leagues = Object.values(ESPN_LEAGUES).flat();
  for (const m of matches) {
    const lg = leagues.find((l) => m.espn?.league === l.league);
    if (lg?.oddsKey) add(lg.oddsKey, m);
  }

  // Tennis odds keys are per tournament, e.g. tennis_atp_paris_masters.
  const tennis = matches.filter((m) => m.sport === "tennis");
  if (tennis.length) {
    const sports = await getJson<any[]>(`${BASE}/sports?apiKey=${config.oddsApiKey}`);
    const active = (sports ?? []).filter((s) => s.active && /^tennis_/.test(s.key));
    for (const m of tennis) {
      const s = active.find((s) => sameTournament(m, s));
      if (s) add(s.key, m);
    }
  }

  // Most important leagues first, in case the budget runs out part-way.
  const rank = (k: string) => { const i = ODDS_PRIORITY.indexOf(k); return i < 0 ? ODDS_PRIORITY.length : i; };
  const queue = [...byKey].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].length - a[1].length);
  for (let i = 0; i < queue.length; i++) {
    const [sportKey, ms] = queue[i];
    if (!budget.canSpend()) {
      console.warn(`[odds] budget limit reached (${budget.summary()}); ${queue.length - i} sport(s) left unpriced`);
      for (const [, rest] of queue.slice(i)) deferred.push(...rest);
      break;
    }
    const from = new Date(Math.min(...ms.map((m) => +m.start)) - 3600_000);
    const to = new Date(Math.max(...ms.map((m) => +m.start)) + 3600_000);
    const { data, headers } = await getJsonRes<any[]>(
      `${BASE}/sports/${sportKey}/odds?apiKey=${config.oddsApiKey}&regions=${config.oddsRegions}&markets=h2h&oddsFormat=decimal` +
        `&commenceTimeFrom=${isoSec(from)}&commenceTimeTo=${isoSec(to)}`,
    );
    budget.record(headers?.get("x-requests-remaining"), headers?.get("x-requests-last"));
    for (const ev of data ?? []) {
      const m = ms.find((x) => sameEvent(x, ev));
      const books = m && parseBooks(ev, m);
      if (m && books?.length) m.odds = { books, source: "The Odds API" };
    }
  }
  console.log(`[odds] ${budget.summary()}`);
  return deferred;
}

const TOURNEY_NOISE = new Set(["open", "tennis", "ladies", "mens", "womens", "championships", "championship", "cup", "masters", "international", "presented", "rolex", "atp", "wta", "the"]);

/** "Rolex Paris Masters" (ESPN) ~ "ATP Paris Masters" (The Odds API), same tour. */
export function sameTournament(m: Match, s: { key: string; title?: string; description?: string }): boolean {
  const tour = m.espn?.league; // "atp" | "wta"
  if (tour && !s.key.startsWith(`tennis_${tour}_`)) return false;
  const words = (x: string) => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !TOURNEY_NOISE.has(w));
  const ours = words(m.tournament ?? "");
  const theirs = new Set(words(`${s.title ?? ""} ${s.key.replace(/^tennis_(atp|wta)_/, "").replace(/_/g, " ")}`));
  return ours.length > 0 && ours.some((w) => theirs.has(w));
}

function sameEvent(m: Match, ev: any): boolean {
  const t = new Date(ev.commence_time).getTime();
  if (Math.abs(t - m.start.getTime()) > 3 * 3600_000) return false;
  const names = [ev.home_team, ev.away_team].filter(Boolean);
  return names.length === 2 &&
    ((similar(names[0], m.home.name) && similar(names[1], m.away.name)) ||
     (similar(names[0], m.away.name) && similar(names[1], m.home.name)));
}

/** Loose team-name match: "Manchester United" ~ "Man United", "LA Lakers" ~ "Los Angeles Lakers". */
export function similar(a: string, b: string): boolean {
  const tok = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/).filter((w) => w.length > 2 && !["the", "club", "fc"].includes(w));
  const A = tok(a), B = tok(b);
  if (!A.length || !B.length) return false;
  const hits = A.filter((w) => B.some((v) => v === w || v.startsWith(w) || w.startsWith(v))).length;
  const n = Math.min(A.length, B.length);
  // Short names must match fully, so "Manchester United" never matches "Manchester City".
  return hits / n >= (n <= 2 ? 1 : 0.67);
}

/** One BookPrice per bookmaker, with outcomes mapped onto our home/away. */
export function parseBooks(ev: any, m: Match): BookPrice[] {
  const out: BookPrice[] = [];
  for (const bk of ev.bookmakers ?? []) {
    const h2h = bk.markets?.find((x: any) => x.key === "h2h");
    const p: Partial<BookPrice> = { key: bk.key, title: bk.title };
    for (const o of h2h?.outcomes ?? []) {
      if (o.name === "Draw") p.draw = o.price;
      else if (similar(o.name, m.home.name)) p.home = o.price;
      else if (similar(o.name, m.away.name)) p.away = o.price;
    }
    if (p.home && p.away) out.push(p as BookPrice);
  }
  return out;
}
