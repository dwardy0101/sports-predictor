/**
 * Simple, transparent statistical models. They are deliberately basic and
 * only used when there are no bookmaker odds (or as context next to them):
 * the market is better informed than any of these.
 */
import type { Match, Probabilities, TeamSide } from "../types.ts";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (p: number, lo = 0.02, hi = 0.98) => Math.min(hi, Math.max(lo, p));

/** Home advantage in log-odds. Roughly: NBA home teams win ~58% of evenly matched games. */
const HOME_ADV: Record<string, number> = { nba: 0.3, wnba: 0.3, basketball: 0.45, football: 0.35 };

/** Rank assumed for a tennis player outside ESPN's top-150 list. */
const UNRANKED = 200;

/** Win rate pulled toward 50% when there are few games (Bayesian shrinkage). */
export function shrunkWinRate(r?: { w: number; d: number; l: number }, prior = 6): number | undefined {
  if (!r) return undefined;
  const n = r.w + r.d + r.l;
  if (n === 0) return undefined;
  return (r.w + 0.5 * r.d + prior * 0.5) / (n + prior);
}

/** Recent form, newer games weigh more. Returns a 0..1 score. */
export function formScore(form?: string[]): number | undefined {
  if (!form?.length) return undefined;
  const last = form.slice(-10);
  let num = 3 * 0.5, den = 3; // prior of 3 "half" games
  last.forEach((r, i) => {
    const w = 1 + i / last.length; // later = heavier
    num += w * (r === "W" ? 1 : r === "D" ? 0.5 : 0);
    den += w;
  });
  return num / den;
}

/** Bill James' log5: chance A beats B given each one's win rate vs. an average team. */
export function log5(pa: number, pb: number): number {
  return (pa * (1 - pb)) / (pa * (1 - pb) + pb * (1 - pa));
}

export const eloWinProb = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));

/** Tennis by ranking: #1 vs #10 is about 86%, #50 vs #100 about 64%. */
export const rankWinProb = (ra: number, rb: number) => sigmoid(0.8 * (Math.log(rb) - Math.log(ra)));

function teamStrength(t: TeamSide, useVenue: boolean): number | undefined {
  const overall = shrunkWinRate(t.record);
  const venue = useVenue ? shrunkWinRate(t.venueRecord) : undefined;
  const form = formScore(t.form);
  const parts: [number, number][] = [];
  if (overall !== undefined) parts.push([overall, 0.6]);
  if (venue !== undefined) parts.push([venue, 0.2]);
  if (form !== undefined) parts.push([form, 0.3]);
  if (!parts.length) return undefined;
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return clamp(parts.reduce((s, [p, x]) => s + p * x, 0) / w, 0.05, 0.95);
}

/** Two-way sports (basketball, tennis, esports). */
function twoWay(m: Match): { p: number; dataPoints: number } {
  const logits: number[] = [];

  if (m.sport === "tennis" && (m.home.rank || m.away.rank)) {
    logits.push(logit(rankWinProb(m.home.rank ?? UNRANKED, m.away.rank ?? UNRANKED)));
  }
  if (m.home.rating && m.away.rating) logits.push(logit(eloWinProb(m.home.rating, m.away.rating)));

  const sa = teamStrength(m.home, !m.neutral);
  const sb = teamStrength(m.away, !m.neutral);
  if (sa !== undefined && sb !== undefined) logits.push(logit(log5(sa, sb)));

  let x = logits.length ? logits.reduce((a, b) => a + b, 0) / logits.length : 0;
  if (!m.neutral) x += HOME_ADV[m.sport] ?? 0;
  return { p: clamp(sigmoid(x)), dataPoints: logits.length };
}

/**
 * Football (three outcomes). Strength = points per game (shrunk), turned into
 * home/draw/away with an ordered-logit. With equal teams it gives about
 * 45% home / 27% draw / 28% away, which is close to the real league average.
 */
export function footballProbs(m: Match): { probs: Probabilities; dataPoints: number } {
  const ppg = (t: TeamSide) => {
    const r = t.record;
    const prior = 4, avg = 1.37;
    const fromRecord = r ? (3 * r.w + r.d + prior * avg) / (r.w + r.d + r.l + prior) : undefined;
    const f = formScore(t.form);
    const fromForm = f !== undefined ? 3 * f * 0.9 : undefined; // rough map 0..1 -> ppg
    if (fromRecord !== undefined && fromForm !== undefined) return { v: 0.7 * fromRecord + 0.3 * fromForm, n: 2 };
    if (fromRecord !== undefined) return { v: fromRecord, n: 1 };
    if (fromForm !== undefined) return { v: fromForm, n: 1 };
    return { v: avg, n: 0 };
  };
  const H = ppg(m.home), A = ppg(m.away);
  const d = 0.85 * (H.v - A.v) + (m.neutral ? 0 : HOME_ADV.football);
  const t = 0.553;
  const home = sigmoid(d - t);
  const away = sigmoid(-d - t);
  return { probs: { home, away, draw: Math.max(0.05, 1 - home - away) }, dataPoints: Math.min(H.n, A.n) };
}

export function modelProbs(m: Match): { probs: Probabilities; dataPoints: number } {
  if (m.hasDraw) return footballProbs(m);
  const { p, dataPoints } = twoWay(m);
  return { probs: { home: p, away: 1 - p, draw: 0 }, dataPoints };
}
