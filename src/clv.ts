/**
 * Closing line value: did we take a price better than the sharp price became?
 *
 * Profit is the goal but a terrible measuring stick — a few hundred bets are
 * needed before it means anything. Beating the sharp closing price is the same
 * question asked in a way that converges in dozens of bets: if a bookmaker's
 * price is consistently better than where Pinnacle ends up, the edge is real.
 *
 * Snapshots are free. Every run already asks The Odds API for each sport in the
 * window; matches we alerted on earlier simply ride along on that same call.
 */
import type { Fair, Side } from "./types.ts";

export interface ClvRow {
  key: string;
  side: Side;
  /** The price the alert told you to take. */
  betPrice: number;
  /** 1 / fair probability of that side, at snapshot time. */
  fairPrice: number;
  /** Where the later fair price came from, e.g. "Pinnacle". */
  source: string;
  at: string;
  /** Minutes between the snapshot and kickoff: smaller is closer to the close. */
  minsToStart: number;
}

/** How much better than the later fair price the bet was taken at, in percent. */
export const clvPct = (r: ClvRow) => (r.betPrice / r.fairPrice - 1) * 100;

export function snapshot(
  bet: { key: string; side: Side; price: number; start: string },
  fair: Fair,
  now: Date,
): ClvRow | undefined {
  const p = fair.probs[bet.side];
  if (!(p > 0) || !(bet.price > 1)) return undefined;
  // Only a price good enough to be a yardstick, and only before kickoff.
  if (fair.kind === "single" || fair.stale) return undefined;
  const mins = Math.round((new Date(bet.start).getTime() - now.getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return undefined;
  return { key: bet.key, side: bet.side, betPrice: bet.price, fairPrice: 1 / p, source: fair.source, at: now.toISOString(), minsToStart: mins };
}

/** One row per bet: the snapshot taken closest to kickoff. */
export function latestPerKey(rows: ClvRow[]): ClvRow[] {
  const best = new Map<string, ClvRow>();
  for (const r of rows) {
    const cur = best.get(r.key);
    if (!cur || r.minsToStart < cur.minsToStart) best.set(r.key, r);
  }
  return [...best.values()];
}

export function clvSummary(rows: ClvRow[]): { n: number; beat: number; avgPct: number } | undefined {
  const latest = latestPerKey(rows);
  if (!latest.length) return undefined;
  const pcts = latest.map(clvPct);
  return {
    n: latest.length,
    beat: pcts.filter((x) => x > 0).length,
    avgPct: pcts.reduce((s, x) => s + x, 0) / latest.length,
  };
}

/** The closing-line block for the daily report. */
export function clvLines(rows: ClvRow[]): string[] {
  const s = clvSummary(rows);
  if (!s) return [];
  const sign = s.avgPct >= 0 ? "+" : "";
  const L = [`🎯 <b>Did we beat the sharp price?</b> ${s.beat} of ${s.n} bets, average ${sign}${s.avgPct.toFixed(1)}% better than the later fair price.`];
  if (s.n < 20) L.push("<i>Still few bets, but this tells you whether the edge is real long before the profit does.</i>");
  else if (s.avgPct > 0) L.push("<i>Taking prices better than the sharp line is the sign of a real edge.</i>");
  else L.push("<i>The prices were not better than the sharp line, so the alerts are not finding a real edge yet.</i>");
  return L;
}
