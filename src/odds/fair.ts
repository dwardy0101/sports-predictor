/**
 * Turning bookmaker odds into fair probabilities and spotting value.
 *
 * The idea: Pinnacle is the sharpest bookmaker (high limits, low margin, it
 * moves fast on news), so its prices with the margin removed are the best
 * free estimate of the true chances. When another bookmaker pays MORE than
 * that fair price, the bet has positive expected value. This beats trying to
 * out-predict the market with our own model.
 */
import type { BestPrices, BookPrice, Fair, MarketOdds, Probabilities, Side, Value } from "../types.ts";

/** Betting exchanges charge commission on winnings, so their raw prices overstate the payout. */
const EXCHANGE = /betfair_ex|matchbook|smarkets|betdaq/i;
const SHARP = "pinnacle";

function validBook(b: BookPrice, hasDraw: boolean): boolean {
  const ok = (x?: number) => typeof x === "number" && x > 1;
  return ok(b.home) && ok(b.away) && (!hasDraw || ok(b.draw));
}

/** Remove one bookmaker's margin: 1/odds, then scale so the outcomes add to 100%. */
export function devigBook(b: BookPrice, hasDraw: boolean): Probabilities | undefined {
  if (!validBook(b, hasDraw)) return undefined;
  const h = 1 / b.home, a = 1 / b.away, d = hasDraw ? 1 / b.draw! : 0;
  const s = h + a + d;
  return { home: h / s, away: a / s, draw: d / s };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function fairProbs(odds: MarketOdds | undefined, hasDraw: boolean): Fair | undefined {
  const books = (odds?.books ?? []).filter((b) => !EXCHANGE.test(b.key) && validBook(b, hasDraw));
  if (!books.length) return undefined;

  const sharp = books.find((b) => b.key === SHARP);
  if (sharp) return { probs: devigBook(sharp, hasDraw)!, source: "Pinnacle", kind: "sharp" };

  const each = books.map((b) => devigBook(b, hasDraw)!);
  if (each.length >= 3) {
    const r = { home: median(each.map((p) => p.home)), away: median(each.map((p) => p.away)), draw: median(each.map((p) => p.draw)) };
    const s = r.home + r.away + r.draw;
    return { probs: { home: r.home / s, away: r.away / s, draw: r.draw / s }, source: `consensus of ${each.length} books`, kind: "consensus" };
  }
  return { probs: each[0], source: books[0].title, kind: "single" };
}

/** Highest price per outcome across bookmakers (exchanges excluded). */
export function bestPrices(odds: MarketOdds | undefined, hasDraw: boolean): BestPrices | undefined {
  const out: BestPrices = {};
  for (const b of odds?.books ?? []) {
    if (EXCHANGE.test(b.key)) continue;
    for (const side of (hasDraw ? ["home", "away", "draw"] : ["home", "away"]) as Side[]) {
      const p = b[side];
      if (typeof p === "number" && p > 1 && (!out[side] || p > out[side]!.price)) out[side] = { price: p, book: b.title };
    }
  }
  return out.home && out.away ? out : undefined;
}

/**
 * The best positive-EV bet, if any is at least `minEdgePct`.
 * Needs a trustworthy fair price (Pinnacle or a 3+ book consensus): comparing a
 * single book with itself can never show value. Edges above `maxEdgePct` are
 * almost always a data error (wrong match, stale line), so they're dropped.
 */
export function findValue(fair: Fair | undefined, best: BestPrices | undefined, minEdgePct: number, maxEdgePct = 25): Value | undefined {
  if (!fair || !best || fair.kind === "single") return undefined;
  let top: Value | undefined;
  for (const side of ["home", "away", "draw"] as Side[]) {
    const o = best[side];
    const p = fair.probs[side];
    if (!o || !(p > 0)) continue;
    const evPct = (p * o.price - 1) * 100;
    if (evPct > maxEdgePct) {
      console.warn(`[value] ignoring suspicious +${evPct.toFixed(1)}% on ${side} @ ${o.price} (${o.book})`);
      continue;
    }
    if (!top || evPct > top.evPct) top = { side, price: o.price, book: o.book, fairPrice: 1 / p, evPct };
  }
  return top && top.evPct >= minEdgePct ? top : undefined;
}
