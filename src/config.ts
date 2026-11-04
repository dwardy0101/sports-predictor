import type { SportGroup } from "./types.ts";

const env = process.env;
/** An IANA timezone name such as "Asia/Manila". Invalid names fall back to UTC. */
const zone = (v: string | undefined) => {
  const tz = v || "Asia/Manila";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
};
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
  oddsApiKey: env.ODDS_API_KEY ?? "",
  pandascoreToken: env.PANDASCORE_TOKEN ?? "",
  anthropicKey: env.ANTHROPIC_API_KEY ?? "",
  /** Only used for value-bet alerts. Haiku keeps it to cents per month. */
  llmModel: env.LLM_MODEL || "claude-haiku-5-5",
  /** Matches are picked up when kickoff is between these many minutes away. With runs every 2h, keep the gap > 120. */
  leadMinMinutes: num(env.LEAD_MIN_MINUTES, 15),
  leadMaxMinutes: num(env.LEAD_MAX_MINUTES, 150),
  /** How often the outside timer starts a run. A match with odds still missing is retried only if another run can still see it. */
  runIntervalMinutes: num(env.RUN_INTERVAL_MINUTES, 120),
  /** Timezone for the times shown in Telegram messages (12-hour clock). */
  timezone: zone(env.TIMEZONE),
  /** Extra minutes of safety when deciding a match can wait for the next run (timers fire a little late). */
  holdMarginMinutes: 10,
  /** Minimum expected value (%) for a value-bet alert. */
  minEdgePct: num(env.MIN_EDGE_PCT, 3),
  /** Also list matches we know nothing about (no odds, no stats). Off by default: they'd all be 50/50. */
  includeUnrated: env.INCLUDE_UNRATED === "1",
  /** Send the "starting soon" digest. Set DIGEST=0 to only get value-bet alerts. */
  digest: env.DIGEST !== "0",
  dryRun: env.DRY_RUN === "1",
  sports: (env.SPORTS || "nba,wnba,football,tennis,dota2,cs2")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SportGroup[],
  /**
   * Bookmakers you can bet with, e.g. "1xbet,bet365". Value alerts only use their prices.
   * Matched against The Odds API key or title (case-insensitive). Empty = all.
   */
  bookmakers: (env.BOOKMAKERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** PandaScore tournament tiers to include (s = top ... d = lowest, plus "unranked"). */
  esportsTiers: (env.ESPORTS_TIERS || "s,a,b").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** The Odds API: "eu" includes Pinnacle plus most European bookmakers. */
  oddsRegions: env.ODDS_REGIONS || "eu",
  oddsMonthlyCredits: num(env.ODDS_MONTHLY_CREDITS, 500),
  /** Never spend the last few credits. */
  oddsReserve: 20,
  /** OddsPapi (free: 250 requests/month). Adds odds for tennis and esports where The Odds API has none. */
  oddspapiKey: env.ODDSPAPI_KEY ?? "",
  oddspapiMonthly: num(env.ODDSPAPI_MONTHLY, 250),
  oddspapiReserve: 10,
  /** OddsPapi rejects calls that come too fast (HTTP 429), so leave a gap between them. */
  oddspapiGapMs: num(env.ODDSPAPI_GAP_MS, 3500),
  /** PandaScore pages of 100 past matches used to compute esports Elo. */
  esportsHistoryPages: 5,
};

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
