/**
 * Keeping the prediction log bounded. The daily report used to re-read every
 * prediction ever made; after a year that is a big file read for nothing. Old
 * rows are moved to a monthly archive file and their numbers folded into a
 * small totals file, so the all-time figures survive without the detail.
 */
import { brier, evenGuess, type LoggedPrediction } from "./report.ts";
import { clvPct, latestPerKey, type ClvRow } from "./clv.ts";
import type { Side } from "./types.ts";

export interface Totals {
  /** Predictions moved out of the live log. */
  archived: number;
  /** Of those, ones with a known result. */
  graded: number;
  /** Graded ones that had odds (the accuracy comparison). */
  nFair: number;
  brierMarket: number;
  brierModel: number;
  brierEven: number;
  bets: number;
  /** Total returned by those bets, staking 1 unit each. */
  returned: number;
  clvN: number;
  clvBeat: number;
  clvSum: number;
  /** Newest kickoff included. */
  through?: string;
}

export const EMPTY_TOTALS: Totals = { archived: 0, graded: 0, nFair: 0, brierMarket: 0, brierModel: 0, brierEven: 0, bets: 0, returned: 0, clvN: 0, clvBeat: 0, clvSum: 0 };

/** Split a prediction log into what stays and what is old enough to archive. */
export function splitOld<T extends { start?: string }>(rows: T[], now: Date, keepDays: number): { keep: T[]; old: T[] } {
  const cutoff = now.getTime() - keepDays * 86400_000;
  const keep: T[] = [], old: T[] = [];
  for (const r of rows) {
    const t = r.start ? new Date(r.start).getTime() : NaN;
    (Number.isFinite(t) && t < cutoff ? old : keep).push(r);
  }
  return { keep, old };
}

/** Fold archived rows into the running totals. */
export function addToTotals(
  totals: Totals,
  old: (LoggedPrediction & { start?: string })[],
  results: Map<string, Side | null>,
  clv: ClvRow[] = [],
): Totals {
  const t = { ...totals };
  const byKey = new Map(latestPerKey(clv).map((r) => [r.key, r]));
  for (const p of old) {
    t.archived++;
    if (p.start && (!t.through || p.start > t.through)) t.through = p.start;
    const o = results.get(p.key);
    if (!o) continue;
    t.graded++;
    if (p.fair) {
      t.nFair++;
      t.brierMarket += brier(p.fair, o);
      t.brierModel += brier(p.model, o);
      t.brierEven += evenGuess(p.hasDraw);
    }
    if (p.value) {
      t.bets++;
      if (p.value.side === o) t.returned += p.value.price;
    }
    const c = byKey.get(p.key);
    if (c) { t.clvN++; t.clvSum += clvPct(c); if (clvPct(c) > 0) t.clvBeat++; }
  }
  return t;
}
