/** Turn one match (with odds, if any) into a prediction. Pure: no network. */
import { config } from "./config.ts";
import { bestPrices, bookLink, fairProbs, findValue } from "./odds/fair.ts";
import { modelProbs } from "./model/probability.ts";
import type { Match, Prediction } from "./types.ts";

export function predict(m: Match): Prediction {
  const { probs: model, dataPoints } = modelProbs(m);
  const fair = fairProbs(m.odds, m.hasDraw);
  const best = bestPrices(m.odds, m.hasDraw, config.bookmakers);
  const betLink = bookLink(m.odds, config.bookmakers.length ? config.bookmakers : ["1xbet"]);
  const value = findValue(fair, best, config.minEdgePct);
  const confidence: Prediction["confidence"] = fair?.kind === "sharp" ? "high" : fair ? "medium" : "low";
  return {
    match: m, model, modelDataPoints: dataPoints, fair, final: fair?.probs ?? model, best, betLink, value,
    confidence, factors: baseFactors(m), risks: [], aiUsed: false,
  };
}

/** Plain facts the system knows even without AI. */
function baseFactors(m: Match): string[] {
  const f: string[] = [];
  const rec = (r?: { w: number; d: number; l: number }) => (r ? (m.hasDraw ? `${r.w}-${r.d}-${r.l}` : `${r.w}-${r.l}`) : undefined);
  for (const t of [m.home, m.away]) {
    const bits = [
      rec(t.record) && `record ${rec(t.record)}`,
      t.form?.length && `form ${t.form.slice(-5).join("")}`,
      t.rank && `world #${t.rank}`,
      t.rating && `Elo ${Math.round(t.rating)}`,
    ].filter(Boolean);
    if (bits.length) f.push(`${t.name}: ${bits.join(", ")}`);
  }
  if (!m.neutral && m.sport !== "tennis") f.push(`${m.home.name} at home`);
  return f;
}
