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

/**
 * Remove one bookmaker's margin with the "power" method: find k so that
 * (1/odds)^k adds up to 100%. Unlike simply scaling, this takes more of the
 * margin off long shots, where bookmakers put most of it (the favourite–
 * longshot bias), so underdogs don't look like false value.
 */
export function devigBook(b: BookPrice, hasDraw: boolean): Probabilities | undefined {
  if (!validBook(b, hasDraw)) return undefined;
  const q = [1 / b.home, 1 / b.away, hasDraw ? 1 / b.draw! : 0];
  const total = (k: number) => q.reduce((s, x) => s + (x > 0 ? x ** k : 0), 0);
  let k = 1;
  if (total(1) > 1) {
    let lo = 1, hi = 10;
    for (let i = 0; i < 60; i++) {
      k = (lo + hi) / 2;
      if (total(k) > 1) lo = k; else hi = k;
    }
  }
  const p = q.map((x) => (x > 0 ? x ** k : 0));
  const s = p[0] + p[1] + p[2];
  return { home: p[0] / s, away: p[1] / s, draw: p[2] / s };
}

/** Optional allow-list of bookmakers the user can actually bet with (BOOKMAKERS setting). */
const usable = (b: BookPrice, allow: string[]) =>
  !allow.length || allow.some((a) => b.key.toLowerCase() === a || b.title.toLowerCase().includes(a));

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

/** Highest price per outcome across bookmakers (exchanges excluded; only `allow` books if given). */
export function bestPrices(odds: MarketOdds | undefined, hasDraw: boolean, allow: string[] = []): BestPrices | undefined {
  const out: BestPrices = {};
  for (const b of odds?.books ?? []) {
    if (EXCHANGE.test(b.key) || !usable(b, allow)) continue;
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
