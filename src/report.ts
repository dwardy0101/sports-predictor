/** The daily accuracy report, as a Telegram message. Pure: no network. */
import type { Probabilities, Side } from "./types.ts";

export interface LoggedPrediction {
  key: string;
  hasDraw?: boolean;
  fair?: Probabilities;
  model: Probabilities;
  modelDataPoints?: number;
  value?: { side: Side; price: number };
}

/** Squared error of the predicted chances against what happened. 0 = perfect, lower is better. */
export const brier = (pr: Probabilities, o: Side) =>
  (["home", "away", "draw"] as Side[]).reduce((s, k) => s + ((pr[k] ?? 0) - (k === o ? 1 : 0)) ** 2, 0);

/** The score you'd get by always saying "equal chances": 0.50 for two-way matches, 0.667 for football. */
const evenGuess = (hasDraw?: boolean) => (hasDraw ? 2 / 3 : 0.5);

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

export function buildReport(rows: LoggedPrediction[], results: Map<string, Side | null>): string | undefined {
  const graded = rows.filter((p) => results.get(p.key));
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

  const f = (x: number) => x.toFixed(3);
  const L: string[] = [`📈 <b>Accuracy report</b> · ${graded.length} finished match${graded.length > 1 ? "es" : ""}`, ""];

  if (n) {
    const m = market / n, g = model / n;
    L.push("<b>How good were the win chances?</b> (score: 0 = perfect, lower is better)");
    L.push(`• Bookmaker odds, margin removed: <b>${f(m)}</b>`);
    L.push(`• Our own stats guess: <b>${f(g)}</b>`);
    L.push(`• Just guessing evenly: ${f(even / n)}`);
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
  return L.join("\n");
}
