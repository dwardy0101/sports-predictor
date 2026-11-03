export type SportGroup = "nba" | "wnba" | "basketball" | "football" | "tennis" | "dota2" | "cs2";
export type Side = "home" | "away" | "draw";

export interface TeamSide {
  name: string;
  id?: string;
  /** Wins / draws / losses this season (overall). */
  record?: { w: number; d: number; l: number };
  /** Record at home (for the home side) or on the road (for the away side). */
  venueRecord?: { w: number; d: number; l: number };
  /** Recent form, most recent last: "W" | "D" | "L". */
  form?: string[];
  /** Tennis world ranking (from ESPN's ATP/WTA rankings, top 150 only). */
  rank?: number;
  /** Elo-style rating (esports, computed from PandaScore history). */
  rating?: number;
}

/** Decimal odds from one bookmaker for one match. */
export interface BookPrice {
  key: string;
  title: string;
  home: number;
  away: number;
  draw?: number;
}

export interface MarketOdds {
  books: BookPrice[];
  /** Where the odds came from: "The Odds API" or "ESPN". */
  source: string;
}

export interface Probabilities {
  home: number;
  away: number;
  draw: number;
}

/** Margin-free ("fair") probabilities derived from bookmaker odds. */
export interface Fair {
  probs: Probabilities;
  /** Human label, e.g. "Pinnacle" or "consensus of 7 books". */
  source: string;
  /** "sharp" = Pinnacle, "consensus" = median of 3+ books, "single" = one book only. */
  kind: "sharp" | "consensus" | "single";
}

export type BestPrices = Partial<Record<Side, { price: number; book: string }>>;

export interface Value {
  side: Side;
  price: number;
  book: string;
  /** 1 / fair probability. */
  fairPrice: number;
  /** Expected value in percent: fair probability × price − 1. */
  evPct: number;
}

export interface Match {
  /** Stable unique key, used to avoid sending the same match twice. */
  key: string;
  sport: SportGroup;
  league: string;
  start: Date;
  /** "home" = first listed side. For tennis/esports it's just side A. */
  home: TeamSide;
  away: TeamSide;
  /** True if a draw is a possible result (football). */
  hasDraw: boolean;
  /** Neutral venue (tennis, esports, some cups): no home advantage. */
  neutral: boolean;
  bestOf?: number;
  odds?: MarketOdds;
  link?: string;
  /** Tennis tournament name (used to find its odds). */
  tournament?: string;
  /** Raw context for alerts and the AI analyst: injuries, news, head-to-head, etc. */
  context: Record<string, unknown>;
  /** Where to fetch extra detail and the final result on ESPN. */
  espn?: { sport: string; league: string; eventId: string; compId: string };
}

export interface Prediction {
  match: Match;
  model: Probabilities;
  /** How many independent data sources fed the stats model (0 = it's a coin flip). */
  modelDataPoints: number;
  fair?: Fair;
  /** What we show: fair market probabilities if we have odds, else the stats model. */
  final: Probabilities;
  best?: BestPrices;
  value?: Value;
  confidence: "low" | "medium" | "high";
  factors: string[];
  risks: string[];
  aiUsed: boolean;
}
