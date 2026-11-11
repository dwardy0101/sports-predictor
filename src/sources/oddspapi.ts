/**
 * OddsPapi (free plan: 250 requests/month). Used for what The Odds API can't
 * cover: tennis tour events and Dota 2 / CS2, with Pinnacle and 1xBet prices.
 *
 * How it keeps inside 250 requests a month:
 *  - it only runs when a tennis/esports match in this run has no odds yet,
 *  - ONE bulk call per bookmaker covers up to 5 tournaments (all their upcoming matches),
 *  - tournament and name lists are cached for days in data/,
 *  - OddsBudget caps the daily spend, and /account (free) gives the true balance.
 * OddsPapi gives participant IDs, not names, so names come from a cached /participants list.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { httpsLink } from "../http.ts";
import { DATA_DIR } from "../state.ts";
import { OddsBudget } from "../odds/budget.ts";
import { nameScore } from "./oddsapi.ts";
import type { BookPrice, Match, SportGroup } from "../types.ts";

const BASE = "https://api.oddspapi.io/v4";
const OLD_CACHE = `${DATA_DIR}/oddspapi-cache.json`; // one big file in earlier versions
const TOURNAMENTS_FILE = `${DATA_DIR}/oddspapi-tournaments.json`;
const NAMES_FILE = `${DATA_DIR}/oddspapi-names.json`;
const BUDGET = `${DATA_DIR}/oddspapi-budget.json`;
const LIST_TTL = 20 * 3600_000;

/** OddsPapi sport ids for the sports we use it for. */
export const SPORT_ID: Partial<Record<SportGroup, number>> = { tennis: 12, dota2: 16, cs2: 17 };
/** The match-winner market per sport. Outcome ids are the market id (side 1) and market id + 1 (side 2). */
const WINNER_MARKET: Record<number, number> = { 12: 121, 16: 161, 17: 171 };
/** At most this many tournaments per bulk call (OddsPapi rejects more). */
const MAX_TOURNAMENTS = 5;

export interface Tournament { tournamentId: number; tournamentName: string; categoryName: string; upcomingFixtures: number; liveFixtures?: number }
interface Cache {
  /** `miss` = when a fresh list still had no tournament for our matches (so we don't keep re-fetching). */
  tournaments: Record<string, { at: number; list: Tournament[]; miss?: number }>;
  participants: Record<string, { at: number; names: Record<string, string> }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Gasquet, Richard" -> "Richard Gasquet". */
export function papiName(raw: string): string {
  const i = raw.indexOf(",");
  return i > 0 ? `${raw.slice(i + 1).trim()} ${raw.slice(0, i).trim()}` : raw.trim();
}

/** Win prices for side 1 and side 2 from one bookmaker, or undefined if the market is missing, suspended or closed. */
export function winnerPrices(fx: any, bookmaker: string, sportId: number): { p1: number; p2: number } | undefined {
  const bo = fx?.bookmakerOdds?.[bookmaker];
  const id = WINNER_MARKET[sportId];
  if (!bo || bo.suspended === true || !id) return undefined;
  const mk = bo.markets?.[String(id)];
  if (!mk || mk.marketActive === false) return undefined;
  // The per-outcome "active" flag is unreliable (false on live 1xBet prices), so only the price is checked.
  const price = (outcome: number) => Number(mk.outcomes?.[String(outcome)]?.players?.["0"]?.price);
  const p1 = price(id), p2 = price(id + 1);
  return p1 > 1 && p2 > 1 ? { p1, p2 } : undefined;
}

const NOISE = new Set(["men", "mens", "women", "womens", "ladies", "singles", "doubles", "atp", "wta", "tennis", "open", "presented", "season", "stage", "group", "groups", "playoffs", "the", "and", "powered"]);
const tokens = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !NOISE.has(w));

/** Real tournaments only: tennis tour level, no doubles, no "Simulated Reality" fake esports. */
export function worthKeeping(t: Tournament, sportId: number): boolean {
  if (/simulated|\bsrl\b/i.test(`${t.categoryName} ${t.tournamentName}`)) return false;
  if (sportId === 12) return /^(ATP|WTA)\b/i.test(t.categoryName) && !/doubles/i.test(t.tournamentName);
  return true;
}

function eligible(t: Tournament, sportId: number): boolean {
  // A tournament with a match in play today often shows 0 "upcoming" until tomorrow's draw is out.
  return (t.upcomingFixtures > 0 || (t.liveFixtures ?? 0) > 0) && worthKeeping(t, sportId);
}

/**
 * Pick up to 5 tournaments that match the leagues of the matches that still need odds.
 * A tournament scores one point per such match whose league name shares a word with it.
 */
export function pickTournaments(lists: Record<number, Tournament[]>, needy: Match[], max = MAX_TOURNAMENTS): number[] {
  const scored: { id: number; score: number; upcoming: number }[] = [];
  for (const [sid, list] of Object.entries(lists)) {
    const mine = needy.filter((m) => SPORT_ID[m.sport] === Number(sid)).map((m) => new Set(tokens(`${m.league} ${m.tournament ?? ""}`)));
    for (const t of list) {
      if (!eligible(t, Number(sid))) continue;
      const tt = tokens(`${t.tournamentName} ${t.categoryName}`);
      const score = mine.filter((words) => tt.some((w) => words.has(w))).length;
      if (score > 0) scored.push({ id: t.tournamentId, score, upcoming: t.upcomingFixtures });
    }
  }
  return scored.sort((a, b) => b.score - a.score || b.upcoming - a.upcoming).slice(0, max).map((x) => x.id);
}

/** Does this OddsPapi fixture belong to our match? Returns whether sides are the same way round. */
export function matchFixture(m: Match, fx: any, names: Record<string, string>): { swap: boolean } | undefined {
  if (Math.abs(new Date(fx.startTime).getTime() - m.start.getTime()) > 3 * 3600_000) return undefined;
  const n1 = names[String(fx.participant1Id)], n2 = names[String(fx.participant2Id)];
  if (!n1 || !n2) return undefined;
  const direct = Math.min(nameScore(n1, m.home.name), nameScore(n2, m.away.name));
  const swapped = Math.min(nameScore(n1, m.away.name), nameScore(n2, m.home.name));
  if (direct > 0 && direct >= swapped) return { swap: false };
  if (swapped > 0) return { swap: true };
  return undefined;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
/** Two small files instead of one big one, so a daily list refresh doesn't rewrite the 25,000 player names. */
function loadCache(): Cache {
  const old = readJson<Partial<Cache>>(OLD_CACHE, {});
  return { tournaments: readJson(TOURNAMENTS_FILE, old.tournaments ?? {}), participants: readJson(NAMES_FILE, old.participants ?? {}) };
}
function saveCache(c: Cache) {
  writeFileSync(TOURNAMENTS_FILE, JSON.stringify(c.tournaments));
  writeFileSync(NAMES_FILE, JSON.stringify(c.participants));
  rmSync(OLD_CACHE, { force: true });
}

/** One call. Never logs the URL (it contains the key). Waits and retries on HTTP 429. */
async function papiGet(path: string, params: Record<string, string | number> = {}): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const u = new URL(BASE + path);
      u.searchParams.set("apiKey", config.oddspapiKey);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
      const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
      if (r.status === 429) {
        if (/REQUEST_LIMIT_EXCEEDED/.test(await r.text().catch(() => ""))) { console.warn("[oddspapi] monthly request limit reached"); return null; }
        await sleep(Math.max(config.oddspapiGapMs, 1000) * 2); // too many calls too fast: wait and retry
        continue;
      }
      if (!r.ok) { console.warn(`[oddspapi] ${path} HTTP ${r.status}`); return null; }
      return await r.json();
    } catch (err) {
      console.warn(`[oddspapi] ${path} failed: ${(err as Error).message}`);
      return null;
    }
  }
  console.warn(`[oddspapi] ${path} still rate-limited; giving up`);
  return null;
}

const title = (slug: string) => (slug === "1xbet" ? "1xBet" : slug.charAt(0).toUpperCase() + slug.slice(1));

/** Pinnacle (the fair-price yardstick) plus the bookmaker(s) you bet with. Two at most, since each one costs a request. */
export function oddspapiBooks(): string[] {
  return [...new Set(["pinnacle", ...(config.bookmakers.length ? config.bookmakers : ["1xbet"])])].slice(0, 2);
}

/**
 * Does this match still need a sharp price? Having *some* price is not enough: a
 * single bookmaker can never show value against itself (`findValue` refuses a
 * "single" fair price), so a tennis match priced by one soft book used to be
 * dropped here and could never produce a value bet. OddsPapi is asked whenever
 * there is no Pinnacle price and too few books for a consensus.
 */
export function needsSharpOdds(m: Match): boolean {
  const books = m.odds?.books ?? [];
  return !books.some((b) => b.key.toLowerCase() === "pinnacle") && books.length < 3;
}

/** Returns the matches still unpriced only because the budget ran out (so they can be retried). */
export async function attachPapiOdds(matches: Match[], now = new Date()): Promise<Match[]> {
  if (!config.oddspapiKey) return [];
  const needy = matches.filter((m) => SPORT_ID[m.sport] && needsSharpOdds(m));
  if (!needy.length) return [];
  let blocked = false;

  const budget = OddsBudget.load(now, BUDGET, { monthly: config.oddspapiMonthly, reserve: config.oddspapiReserve });
  try {
    // /account is free and gives the true balance.
    const acct = await papiGet("/account");
    const sub = acct?.subscriptions?.find((s: any) => s.is_active) ?? acct?.subscriptions?.[0];
    if (sub?.request_limit != null) budget.record(String(sub.request_limit - sub.request_count), "0");

    const cache = loadCache();
    const sids = [...new Set(needy.map((m) => SPORT_ID[m.sport]!))];
    const spend = async (path: string, params: Record<string, string | number> = {}) => {
      if (!budget.canSpend(1)) { blocked = true; return null; }
      const out = await papiGet(path, params);
      budget.record(undefined, "1");
      await sleep(config.oddspapiGapMs);
      return out;
    };

    // Tournament lists say which tournaments have matches. Schedules change daily, so refresh them
    // about once a day, and straight away if nothing matches and the list is a few hours old.
    const refresh = async (sid: number) => {
      const list = await spend("/tournaments", { sportId: sid });
      // Only tournaments that can actually be picked are kept: the raw tennis list is ~11,000
      // entries, nearly all with no fixtures, which made the saved cache megabytes of dead weight.
      if (Array.isArray(list)) { cache.tournaments[sid] = { at: now.getTime(), list: list.filter((t: Tournament) => eligible(t, sid)) }; saveCache(cache); }
    };
    const pick = () => {
      const lists: Record<number, Tournament[]> = {};
      for (const sid of sids) if (cache.tournaments[sid]) lists[sid] = cache.tournaments[sid].list;
      return pickTournaments(lists, needy);
    };
    for (const sid of sids) {
      const c = cache.tournaments[sid];
      if (!c || now.getTime() - c.at >= LIST_TTL) await refresh(sid);
    }
    let ids = pick();
    if (!ids.length) {
      for (const sid of sids) {
        const c = cache.tournaments[sid];
        const recentMiss = c?.miss && now.getTime() - c.miss < 12 * 3600_000;
        if (c && now.getTime() - c.at > 4 * 3600_000 && !recentMiss) await refresh(sid);
      }
      ids = pick();
      if (!ids.length) {
        for (const sid of sids) if (cache.tournaments[sid]) cache.tournaments[sid].miss = now.getTime();
        saveCache(cache);
      }
    }
    if (!ids.length) {
      console.log(`[oddspapi] no active tournament matches ${needy.length} unpriced match(es)${blocked ? " (budget blocked a list refresh)" : ""}`);
      return blocked ? needy : [];
    }

    // One bulk call per bookmaker covers every upcoming match of those tournaments.
    if (!budget.canSpend(oddspapiBooks().length)) { console.warn(`[oddspapi] budget limit reached (${budget.summary()})`); return needy; }
    const byBook: Record<string, any[]> = {};
    for (const b of oddspapiBooks()) {
      const res = await spend("/odds-by-tournaments", { bookmaker: b, tournamentIds: ids.join(",") });
      byBook[b] = Array.isArray(res) ? res : [];
    }

    // Names: participant lists are cached; refresh when a participant is unknown and the list is over 12 hours old.
    const seen = (sid: number) => new Set(Object.values(byBook).flat().filter((f) => f.sportId === sid).flatMap((f) => [String(f.participant1Id), String(f.participant2Id)]));
    for (const sid of sids) {
      const c = cache.participants[sid];
      const missing = !c || (now.getTime() - c.at > 12 * 3600_000 && [...seen(sid)].some((id) => !c.names[id]));
      if (!missing) continue;
      const raw = await spend("/participants", { sportId: sid });
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        cache.participants[sid] = { at: now.getTime(), names: Object.fromEntries(Object.entries(raw).map(([id, n]) => [id, papiName(String(n))])) };
        saveCache(cache);
      }
    }

    let matched = 0;
    for (const m of needy) {
      const sid = SPORT_ID[m.sport]!;
      const names = cache.participants[sid]?.names ?? {};
      const books: BookPrice[] = [];
      for (const [slug, list] of Object.entries(byBook)) {
        for (const fx of list) {
          if (fx.sportId !== sid || fx.statusId !== 0) continue;
          const o = matchFixture(m, fx, names);
          const p = o && winnerPrices(fx, slug, sid);
          if (o && p) { books.push({ key: slug, title: title(slug), home: o.swap ? p.p2 : p.p1, away: o.swap ? p.p1 : p.p2, link: httpsLink(fx.bookmakerOdds?.[slug]?.fixturePath) }); break; }
        }
      }
      if (books.length) { m.odds = { books, source: "OddsPapi" }; matched++; }
    }
    console.log(`[oddspapi] priced ${matched} of ${needy.length} match(es) from ${ids.length} tournament(s); ${budget.summary()}`);
    return blocked ? needy.filter(needsSharpOdds) : [];
  } finally {
    budget.save(BUDGET);
  }
}
