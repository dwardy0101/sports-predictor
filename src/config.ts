/**
 * Every setting comes from an environment variable. Values are validated with
 * zod: a bad number falls back to the default with a warning, and an unknown
 * sport is dropped instead of silently producing no matches at all (a typo in
 * SPORTS used to look exactly like a quiet night).
 */
import { z } from "zod";
import type { SportGroup } from "./types.ts";

const env = process.env;

export const SPORT_GROUPS = ["nba", "wnba", "basketball", "football", "tennis", "dota2", "cs2"] as const;

/** Problems found while reading the settings. Printed once at startup. */
export const configWarnings: string[] = [];

/** Validate one value; on failure warn and use the default. */
function read<T>(name: string, raw: unknown, schema: z.ZodType<T>, fallback: T): T {
  if (raw === undefined || raw === "") return fallback;
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  configWarnings.push(`${name}=${String(raw)} is not valid (${r.error.issues[0]?.message}); using ${JSON.stringify(fallback)}`);
  return fallback;
}

/** A number inside a sensible range. */
const num = (min: number, max: number) =>
  z.coerce.number().refine((n) => Number.isFinite(n), "not a number").refine((n) => n >= min && n <= max, `must be between ${min} and ${max}`);

const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const lower = (v: string | undefined) => csv(v).map((s) => s.toLowerCase());

/** An IANA timezone name such as "Asia/Manila". */
const timezone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}, "unknown timezone");

function sports(raw: string | undefined): SportGroup[] {
  const wanted = lower(raw);
  if (!wanted.length) return ["nba", "wnba", "football", "tennis", "dota2", "cs2"];
  const ok = wanted.filter((s): s is SportGroup => (SPORT_GROUPS as readonly string[]).includes(s));
  for (const bad of wanted.filter((s) => !ok.includes(s as SportGroup))) {
    configWarnings.push(`SPORTS: "${bad}" is not a sport I know (${SPORT_GROUPS.join(", ")}); ignoring it`);
  }
  if (!ok.length) throw new Error(`SPORTS=${raw} has no sport I know. Valid: ${SPORT_GROUPS.join(", ")}`);
  return [...new Set(ok)];
}

const leadMin = read("LEAD_MIN_MINUTES", env.LEAD_MIN_MINUTES, num(0, 10080), 15);
const leadMax = read("LEAD_MAX_MINUTES", env.LEAD_MAX_MINUTES, num(1, 10080), 150);

export const config = {
  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
  oddsApiKey: env.ODDS_API_KEY ?? "",
  pandascoreToken: env.PANDASCORE_TOKEN ?? "",
  anthropicKey: env.ANTHROPIC_API_KEY ?? "",
  /** Only used for value-bet alerts. Haiku keeps it to cents per month. */
  llmModel: env.LLM_MODEL || "claude-haiku-5-5",
  /** Matches are picked up when kickoff is between these many minutes away. With runs every 2h, keep the gap > 120. */
  leadMinMinutes: leadMin,
  leadMaxMinutes: leadMax > leadMin ? leadMax : (configWarnings.push(`LEAD_MAX_MINUTES must be above LEAD_MIN_MINUTES (${leadMin}); using ${leadMin + 120}`), leadMin + 120),
  /** How often the outside timer starts a run. A match with odds still missing is retried only if another run can still see it. */
  runIntervalMinutes: read("RUN_INTERVAL_MINUTES", env.RUN_INTERVAL_MINUTES, num(1, 10080), 120),
  /** Timezone for the times shown in Telegram messages (12-hour clock). */
  timezone: read("TIMEZONE", env.TIMEZONE, timezone, "Asia/Manila"),
  /** Extra minutes of safety when deciding a match can wait for the next run (timers fire a little late). */
  holdMarginMinutes: 10,
  /** Minimum expected value (%) for an alert off a sharp (Pinnacle) fair price. */
  minEdgePct: read("MIN_EDGE_PCT", env.MIN_EDGE_PCT, num(0, 100), 3),
  /**
   * Minimum expected value (%) when the fair price is a consensus of bookmakers.
   * Higher than the sharp threshold: a consensus devig is noisier, so a small
   * edge against it is usually measurement error rather than money.
   */
  minEdgeConsensusPct: read("MIN_EDGE_CONSENSUS_PCT", env.MIN_EDGE_CONSENSUS_PCT, num(0, 100), 6),
  /** Edges above this are treated as a data error (wrong match, stale line), not value. */
  maxEdgePct: read("MAX_EDGE_PCT", env.MAX_EDGE_PCT, num(1, 1000), 25),
  /**
   * How old a bookmaker's price may be (minutes) before it is ignored for
   * finding value. A stale sharp line is the main source of imaginary edges.
   * Prices from services that don't timestamp them count as fresh.
   */
  maxOddsAgeMinutes: read("MAX_ODDS_AGE_MINUTES", env.MAX_ODDS_AGE_MINUTES, num(1, 1440), 30),
  /** Stake sizing: fraction of the full Kelly stake (0.25 = quarter Kelly). 0 switches stake advice off. */
  kellyFraction: read("KELLY_FRACTION", env.KELLY_FRACTION, num(0, 1), 0.25),
  /** Never advise staking more than this percentage of the bankroll on one bet. */
  maxStakePct: read("MAX_STAKE_PCT", env.MAX_STAKE_PCT, num(0.1, 100), 2),
  /** Optional bankroll, in your currency. Set it to see stakes in money as well as percent. */
  bankroll: read("BANKROLL", env.BANKROLL, num(0, 1e9), 0),
  /** Also list matches we know nothing about (no odds, no stats). Off by default: they'd all be 50/50. */
  includeUnrated: env.INCLUDE_UNRATED === "1",
  /** Send the "starting soon" digest. Set DIGEST=0 to only get value-bet alerts. */
  digest: env.DIGEST !== "0",
  dryRun: env.DRY_RUN === "1",
  sports: sports(env.SPORTS),
  /**
   * Bookmakers you can bet with, e.g. "1xbet,bet365". Value alerts only use their prices.
   * Matched against The Odds API key or title (case-insensitive). Empty = all.
   */
  bookmakers: lower(env.BOOKMAKERS),
  /** PandaScore tournament tiers to include (s = top ... d = lowest, plus "unranked"). */
  esportsTiers: lower(env.ESPORTS_TIERS).length ? lower(env.ESPORTS_TIERS) : ["s", "a", "b"],
  /** The Odds API: "eu" includes Pinnacle plus most European bookmakers. */
  oddsRegions: env.ODDS_REGIONS || "eu",
  oddsMonthlyCredits: read("ODDS_MONTHLY_CREDITS", env.ODDS_MONTHLY_CREDITS, num(1, 1e7), 500),
  /** Never spend the last few credits. */
  oddsReserve: 20,
  /** OddsPapi (free: 250 requests/month). Adds odds for tennis and esports where The Odds API has none. */
  oddspapiKey: env.ODDSPAPI_KEY ?? "",
  oddspapiMonthly: read("ODDSPAPI_MONTHLY", env.ODDSPAPI_MONTHLY, num(1, 1e7), 250),
  oddspapiReserve: 10,
  /** OddsPapi rejects calls that come too fast (HTTP 429), so leave a gap between them. */
  oddspapiGapMs: read("ODDSPAPI_GAP_MS", env.ODDSPAPI_GAP_MS, num(0, 60_000), 3500),
  /** PandaScore pages of 100 past matches used to compute esports Elo. */
  esportsHistoryPages: 5,
  /** How many ESPN/PandaScore requests may be in flight at once. */
  fetchConcurrency: read("FETCH_CONCURRENCY", env.FETCH_CONCURRENCY, num(1, 20), 5),
  /** Log the sharp price again later for matches with an open value bet (free: it rides along with calls we already make). */
  trackClv: env.TRACK_CLV !== "0",
  /** Warn on Telegram after this many consecutive runs that found no match at all. */
  watchdogRuns: read("WATCHDOG_RUNS", env.WATCHDOG_RUNS, num(2, 1000), 12),
  /** Predictions older than this are archived out of the live log (their totals are kept). */
  keepDays: read("KEEP_DAYS", env.KEEP_DAYS, num(7, 3650), 120),
};

/** Print whatever looked wrong in the settings, plus advice that depends on them. */
export function reportConfig(log: (s: string) => void = console.warn) {
  for (const w of configWarnings) log(`[config] ${w}`);
  if (!config.bookmakers.length) {
    log("[config] BOOKMAKERS is not set, so value bets may name a bookmaker you have no account with. Set it to the ones you use, e.g. BOOKMAKERS=1xbet,bet365.");
  }
  // A window exactly as wide as the interval only works with a punctual timer, and
  // GitHub's cron is often minutes late, so the margin is counted in as well.
  const gap = config.leadMaxMinutes - config.leadMinMinutes;
  if (gap < config.runIntervalMinutes + config.holdMarginMinutes) {
    log(`[config] the pickup window is only ${gap} min wide (${config.leadMinMinutes}–${config.leadMaxMinutes}), so matches can slip between runs ${config.runIntervalMinutes} min apart. Widen LEAD_MAX_MINUTES.`);
  }
}

/**
 * The Odds API sports to spend credits on first, best first. Anything not listed
 * (e.g. tennis tournaments) comes after, busiest first.
 */
export const ODDS_PRIORITY = [
  "soccer_uefa_champs_league", "soccer_epl", "basketball_nba", "soccer_spain_la_liga", "soccer_italy_serie_a",
  "soccer_germany_bundesliga", "soccer_france_ligue_one", "soccer_uefa_europa_league", "basketball_wnba", "basketball_ncaab",
];

/** ESPN public JSON endpoints (no key). sport/league path pairs, plus The Odds API sport key. */
export interface LeagueDef { sport: string; league: string; name: string; group: SportGroup; oddsKey?: string }

export const ESPN_LEAGUES: Record<string, LeagueDef[]> = {
  nba: [{ sport: "basketball", league: "nba", name: "NBA", group: "nba", oddsKey: "basketball_nba" }],
  wnba: [{ sport: "basketball", league: "wnba", name: "WNBA", group: "wnba", oddsKey: "basketball_wnba" }],
  basketball: [
    { sport: "basketball", league: "mens-college-basketball", name: "NCAA Men", group: "basketball", oddsKey: "basketball_ncaab" },
  ],
  football: [
    { sport: "soccer", league: "eng.1", name: "Premier League", group: "football", oddsKey: "soccer_epl" },
    { sport: "soccer", league: "esp.1", name: "La Liga", group: "football", oddsKey: "soccer_spain_la_liga" },
    { sport: "soccer", league: "ita.1", name: "Serie A", group: "football", oddsKey: "soccer_italy_serie_a" },
    { sport: "soccer", league: "ger.1", name: "Bundesliga", group: "football", oddsKey: "soccer_germany_bundesliga" },
    { sport: "soccer", league: "fra.1", name: "Ligue 1", group: "football", oddsKey: "soccer_france_ligue_one" },
    { sport: "soccer", league: "uefa.champions", name: "Champions League", group: "football", oddsKey: "soccer_uefa_champs_league" },
    { sport: "soccer", league: "uefa.europa", name: "Europa League", group: "football", oddsKey: "soccer_uefa_europa_league" },
  ],
  tennis: [
    { sport: "tennis", league: "atp", name: "ATP", group: "tennis" },
    { sport: "tennis", league: "wta", name: "WTA", group: "tennis" },
  ],
};
