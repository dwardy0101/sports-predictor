/** The daily accuracy report, as a Telegram message. Pure: no network. */
import { clvLines, type ClvRow } from "./clv.ts";
import { healthLines, type RunRow } from "./health.ts";
import type { Totals } from "./archive.ts";
import type { Probabilities, Side } from "./types.ts";

export interface LoggedPrediction {
  key: string;
  hasDraw?: boolean;
  fair?: Probabilities;
  model: Probabilities;
  modelDataPoints?: number;
  value?: { side: Side; price: number; book?: string; evPct?: number };
  /** Kickoff (ISO). Needed for the rolling windows; older logs may not have it. */
  start?: string;
  sport?: string;
}

/** Squared error of the predicted chances against what happened. 0 = perfect, lower is better. */
export const brier = (pr: Probabilities, o: Side) =>
  (["home", "away", "draw"] as Side[]).reduce((s, k) => s + ((pr[k] ?? 0) - (k === o ? 1 : 0)) ** 2, 0);

/** The score you'd get by always saying "equal chances": 0.50 for two-way matches, 0.667 for football. */
export const evenGuess = (hasDraw?: boolean) => (hasDraw ? 2 / 3 : 0.5);

/** A match that still has no result a week after kickoff was postponed or abandoned: stop checking it. */
export const givenUp = (startIso: string, now: Date, days = 7) => now.getTime() - new Date(startIso).getTime() > days * 86400_000;

/**
 * The report is triggered by both the outside timer and GitHub's own schedule, so skip it if one went out
 * in the last few hours. (A manual test later in the day still goes through.)
 */
export function shouldSendReport(lastSentIso: string | undefined, now: Date, minHours = 6): boolean {
  const last = lastSentIso ? new Date(lastSentIso).getTime() : NaN;
  return !(Number.isFinite(last) && now.getTime() - last < minHours * 3600_000);
}

export interface ReportExtras {
  now?: Date;
  /** Run records, for the health block. */
  runs?: RunRow[];
  /** Later sharp prices for bets already placed, for the closing-line block. */
  clv?: ClvRow[];
  /** Numbers for predictions already archived out of the live log. */
  totals?: Totals;
}

/** One settled value bet, flattened for the breakdowns. */
interface SettledBet { sport: string; book: string; evPct?: number; price: number; won: boolean; start?: string }

const f3 = (x: number) => x.toFixed(3);
const signed = (x: number, digits = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;

function settle(rows: LoggedPrediction[], results: Map<string, Side | null>): SettledBet[] {
  const out: SettledBet[] = [];
  for (const p of rows) {
    const o = results.get(p.key);
    if (!o || !p.value) continue;
    out.push({ sport: p.sport ?? "other", book: p.value.book ?? "unknown", evPct: p.value.evPct, price: p.value.price, won: p.value.side === o, start: p.start });
  }
  return out;
}

const profitOf = (bets: SettledBet[]) => bets.reduce((s, b) => s + (b.won ? b.price - 1 : -1), 0);

/** "4 bets · +1.30 units (+32.5%)" */
function tally(bets: SettledBet[]): string {
  const profit = profitOf(bets);
  return `${bets.length} bet${bets.length === 1 ? "" : "s"} · <b>${signed(profit)} units</b> (${signed((profit / bets.length) * 100, 1)}%)`;
}

/** Breakdown lines, biggest group first, so it is obvious where the money comes from. */
function groupLines(bets: SettledBet[], by: (b: SettledBet) => string | undefined, title: string, max = 5): string[] {
  const groups = new Map<string, SettledBet[]>();
  for (const b of bets) {
    const k = by(b);
    if (k) groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  if (groups.size < 2) return []; // one group tells you nothing the total didn't
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, max);
  return [`${title}`, ...sorted.map(([k, bs]) => `• ${k}: ${tally(bs)}`)];
}

const edgeBucket = (b: SettledBet) =>
  b.evPct === undefined ? undefined : b.evPct < 5 ? "edge 3–5%" : b.evPct < 8 ? "edge 5–8%" : "edge 8%+";

function windowLines(rows: LoggedPrediction[], results: Map<string, Side | null>, now: Date, days: number): string[] {
  const cutoff = now.getTime() - days * 86400_000;
  const inWindow = rows.filter((p) => p.start && new Date(p.start).getTime() >= cutoff && results.get(p.key));
  if (!inWindow.length) return [];
  const bets = settle(inWindow, results);
  const matches = `${inWindow.length} match${inWindow.length === 1 ? "" : "es"}`;
  return [`• Last ${days} days: ${matches}, ${bets.length ? tally(bets) : "no bets settled"}`];
}

export function buildReport(rows: LoggedPrediction[], results: Map<string, Side | null>, extras: ReportExtras = {}): string | undefined {
  const now = extras.now ?? new Date();
  const graded = rows.filter((p) => results.get(p.key));
  const totals = extras.totals;
  if (!graded.length && !(totals?.graded)) return undefined;
  if (!graded.length) return undefined;

  let n = 0, market = 0, model = 0, even = 0;
  let bets = 0, returned = 0;
  for (const p of graded) {
    const o = results.get(p.key)!;
    if (p.fair) {
      n++;
      market += brier(p.fair, o);
      model += brier(p.model, o);
      even += evenGuess(p.hasDraw);
    }
    if (p.value) { bets++; if (p.value.side === o) returned += p.value.price; }
  }

  const L: string[] = [`📈 <b>Accuracy report</b> · ${graded.length} finished match${graded.length > 1 ? "es" : ""}`, ""];

  if (n) {
    const m = market / n, g = model / n;
    L.push("<b>How good were the win chances?</b> (score: 0 = perfect, lower is better)");
    L.push(`• Bookmaker odds, margin removed: <b>${f3(m)}</b>`);
    L.push(`• Our own stats guess: <b>${f3(g)}</b>`);
    L.push(`• Just guessing evenly: ${f3(even / n)}`);
    L.push(`<i>Compared on the ${n} of those matches that had odds.</i>`);
    if (n < 10) L.push("👉 Too few matches to say much yet.");
    else if (m < g - 0.02) L.push("👉 The bookmakers' odds were clearly more accurate than our own guess, so the bot relies on them.");
    else if (g < m - 0.02) L.push("👉 Our own guess did better than the bookmakers' odds on these matches. Unusual: keep watching.");
    else L.push("👉 About the same accuracy.");
  } else {
    L.push("No finished match had odds yet, so there is nothing to compare.");
  }

  L.push("");
  if (bets) {
    const profit = returned - bets;
    L.push(`💎 <b>Value bets:</b> ${bets} finished. Betting 1 unit on each would have made <b>${profit >= 0 ? "+" : ""}${profit.toFixed(2)} units</b> (${profit >= 0 ? "+" : ""}${((profit / bets) * 100).toFixed(1)}% of the money staked).`);
    if (bets < 200) L.push("<i>With fewer than about 200 bets this is mostly luck. Judge it over months.</i>");
  } else {
    L.push("💎 <b>Value bets:</b> none finished yet.");
  }

  // All-time, including what has been archived out of the live log.
  if (totals?.bets) {
    const allBets = totals.bets + bets, allProfit = totals.returned - totals.bets + (returned - bets);
    L.push(`<i>All time, including archived: ${allBets} bets, ${signed(allProfit)} units (${signed((allProfit / allBets) * 100, 1)}%).</i>`);
  }

  // Rolling windows: a lifetime total hides a bot that stopped working last week.
  const windows = [...windowLines(rows, results, now, 7), ...windowLines(rows, results, now, 30)];
  if (windows.length) {
    L.push("");
    L.push("📅 <b>Recently</b>");
    L.push(...windows);
  }

  // Which sports, bookmakers and edge sizes the profit actually comes from.
  const settled = settle(graded, results);
  if (settled.length >= 5) {
    for (const block of [
      groupLines(settled, (b) => b.sport, "🏆 <b>By sport</b>"),
      groupLines(settled, (b) => b.book, "🏪 <b>By bookmaker</b>"),
      groupLines(settled, edgeBucket, "📐 <b>By edge</b>"),
    ]) {
      if (block.length) { L.push(""); L.push(...block); }
    }
  }

  const clv = clvLines(extras.clv ?? []);
  if (clv.length) { L.push(""); L.push(...clv); }

  if (extras.runs) { L.push(""); L.push(...healthLines(extras.runs, now)); }

  return L.join("\n");
}
