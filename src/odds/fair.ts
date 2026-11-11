/**
 * Turning bookmaker odds into fair probabilities and spotting value.
 *
 * The idea: Pinnacle is the sharpest bookmaker (high limits, low margin, it
 * moves fast on news), so its prices with the margin removed are the best
 * free estimate of the true chances. When another bookmaker pays MORE than
 * that fair price, the bet has positive expected value. This beats trying to
 * out-predict the market with our own model.
 *
 * Two things stop that idea producing imaginary edges:
 *  - age: a price the bookmaker last moved hours ago says nothing about now,
 *    so stale prices are shown but never bet on (`maxAgeMinutes`),
 *  - self-reference: when the fair price is a consensus of bookmakers, the one
 *    offering the generous price is taken out of the consensus first, or its
 *    own price would be part of the yardstick it is measured against.
 */
import type { BestPrices, BookPrice, Fair, MarketOdds, Probabilities, Side, Value } from "../types.ts";

/** Betting exchanges charge commission on winnings, so their raw prices overstate the payout. */
const EXCHANGE = /betfair_ex|matchbook|smarkets|betdaq/i;
const SHARP = "pinnacle";

export interface FairOpts {
  now?: Date;
  /** Ignore prices older than this when betting. Default: no limit (used by tests and for display). */
  maxAgeMinutes?: number;
}

function validBook(b: BookPrice, hasDraw: boolean): boolean {
  const ok = (x?: number) => typeof x === "number" && x > 1;
  return ok(b.home) && ok(b.away) && (!hasDraw || ok(b.draw));
}

/** Age of a price in minutes, or undefined when the service doesn't timestamp it. */
export function priceAgeMinutes(b: BookPrice, now = new Date()): number | undefined {
  if (!b.updatedAt) return undefined;
  const t = new Date(b.updatedAt).getTime();
  if (!Number.isFinite(t)) return undefined;
  return (now.getTime() - t) / 60_000;
}

/** A price counts as fresh when it moved recently, or when its age is unknown. */
export const isFresh = (b: BookPrice, now = new Date(), maxAgeMinutes = Infinity): boolean => {
  const age = priceAgeMinutes(b, now);
  return age === undefined || age <= maxAgeMinutes;
};

const newest = (books: BookPrice[]): string | undefined =>
  books.map((b) => b.updatedAt).filter((x): x is string => !!x).sort().pop();

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

/** Books that may be used at all: real bookmakers with a complete, sane price. */
const priceable = (odds: MarketOdds | undefined, hasDraw: boolean) =>
  (odds?.books ?? []).filter((b) => !EXCHANGE.test(b.key) && validBook(b, hasDraw));

/**
 * Fair probabilities from the odds. Stale prices are left out; if every price is
 * stale the result is still returned (the digest should show something) but
 * marked `stale`, and `findValue` refuses to bet on it.
 */
export function fairProbs(odds: MarketOdds | undefined, hasDraw: boolean, opts: FairOpts = {}): Fair | undefined {
  const all = priceable(odds, hasDraw);
  if (!all.length) return undefined;
  const fresh = all.filter((b) => isFresh(b, opts.now, opts.maxAgeMinutes));
  const books = fresh.length ? fresh : all;
  const stale = fresh.length === 0;
  const tag = <T extends Fair>(f: T): T => ({ ...f, asOf: newest(books), ...(stale ? { stale: true } : {}) });

  const sharp = books.find((b) => b.key === SHARP);
  if (sharp) return tag({ probs: devigBook(sharp, hasDraw)!, source: "Pinnacle", kind: "sharp" });

  const each = books.map((b) => devigBook(b, hasDraw)!);
  if (each.length >= 3) {
    const r = { home: median(each.map((p) => p.home)), away: median(each.map((p) => p.away)), draw: median(each.map((p) => p.draw)) };
    const s = r.home + r.away + r.draw;
    return tag({ probs: { home: r.home / s, away: r.away / s, draw: r.draw / s }, source: `consensus of ${each.length} books`, kind: "consensus" });
  }
  return tag({ probs: each[0], source: books[0].title, kind: "single" });
}

/** The same fair price with one bookmaker left out, so a book is never measured against itself. */
export function fairWithout(odds: MarketOdds | undefined, hasDraw: boolean, bookKey: string, opts: FairOpts = {}): Fair | undefined {
  const books = (odds?.books ?? []).filter((b) => b.key.toLowerCase() !== bookKey.toLowerCase());
  return fairProbs({ books, source: odds?.source ?? "" }, hasDraw, opts);
}

/** Highest price per outcome across bookmakers (exchanges and stale prices excluded; only `allow` books if given). */
export function bestPrices(odds: MarketOdds | undefined, hasDraw: boolean, allow: string[] = [], opts: FairOpts = {}): BestPrices | undefined {
  const out: BestPrices = {};
  for (const b of priceable(odds, hasDraw)) {
    if (!usable(b, allow) || !isFresh(b, opts.now, opts.maxAgeMinutes)) continue;
    for (const side of (hasDraw ? ["home", "away", "draw"] : ["home", "away"]) as Side[]) {
      const p = b[side];
      if (typeof p === "number" && p > 1 && (!out[side] || p > out[side]!.price)) {
        out[side] = { price: p, book: b.title, bookKey: b.key, link: b.link, updatedAt: b.updatedAt };
      }
    }
  }
  return out.home && out.away ? out : undefined;
}

/** Match page at the bookmaker you bet with: the first of `prefer` that has one. */
export function bookLink(odds: MarketOdds | undefined, prefer: string[]): string | undefined {
  for (const name of prefer) {
    const b = (odds?.books ?? []).find((x) => x.link && usable(x, [name.toLowerCase()]));
    if (b) return b.link;
  }
  return undefined;
}

export interface ValueOpts {
  /** Edges above this are almost always a data error (wrong match, stale line), so they're dropped. */
  maxEdgePct?: number;
  /** Threshold when the fair price is a consensus rather than Pinnacle. Defaults to the sharp one. */
  consensusMinEdgePct?: number;
  /** Fair price with one bookmaker left out. Required to allow value against a consensus. */
  without?: (bookKey: string) => Fair | undefined;
}

/**
 * The best positive-EV bet, if any clears the threshold for its kind of fair price.
 * Needs a trustworthy, fresh fair price: a single bookmaker compared with itself can
 * never show value, and neither can a line nobody has moved for hours.
 */
export function findValue(fair: Fair | undefined, best: BestPrices | undefined, minEdgePct: number, opts: ValueOpts = {}): Value | undefined {
  const { maxEdgePct = 25, consensusMinEdgePct = minEdgePct, without } = opts;
  if (!fair || !best || fair.kind === "single") return undefined;
  if (fair.stale) {
    console.warn(`[value] every price is older than the age limit; not betting on it (${fair.source})`);
    return undefined;
  }
  let top: Value | undefined;
  let threshold = minEdgePct;
  for (const side of ["home", "away", "draw"] as Side[]) {
    const o = best[side];
    if (!o) continue;
    // Against a consensus, re-derive the fair price without the book that offers this price.
    let ref = fair;
    if (fair.kind === "consensus") {
      const cleaned = without?.(o.bookKey);
      if (!cleaned || cleaned.kind === "single" || cleaned.stale) continue; // not enough independent books left
      ref = cleaned;
    }
    const p = ref.probs[side];
    if (!(p > 0)) continue;
    const evPct = (p * o.price - 1) * 100;
    if (evPct > maxEdgePct) {
      console.warn(`[value] ignoring suspicious +${evPct.toFixed(1)}% on ${side} @ ${o.price} (${o.book})`);
      continue;
    }
    if (!top || evPct > top.evPct) {
      top = { side, price: o.price, book: o.book, link: o.link, fairPrice: 1 / p, evPct, prob: p, priceAt: o.updatedAt };
      threshold = ref.kind === "sharp" ? minEdgePct : consensusMinEdgePct;
    }
  }
  return top && top.evPct >= threshold ? top : undefined;
}
