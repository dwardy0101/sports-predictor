// Two ways a positive-EV number can be a lie: the price is old, or the fair
// price was partly made from the very bookmaker we are measuring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestPrices, fairProbs, fairWithout, findValue, isFresh, priceAgeMinutes } from "../src/odds/fair.ts";
import { needsSharpOdds } from "../src/sources/oddspapi.ts";
import type { BookPrice, MarketOdds, Match } from "../src/types.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const book = (key: string, home: number, away: number, age?: number): BookPrice =>
  ({ key, title: key[0].toUpperCase() + key.slice(1), home, away, ...(age === undefined ? {} : { updatedAt: minsAgo(age) }) });
const odds = (...books: BookPrice[]): MarketOdds => ({ source: "t", books });
const fresh30 = { now: NOW, maxAgeMinutes: 30 };

test("a price is fresh when it moved recently, or when its age is unknown", () => {
  assert.equal(priceAgeMinutes(book("a", 2, 2, 12), NOW), 12);
  assert.equal(priceAgeMinutes(book("a", 2, 2), NOW), undefined);
  assert.equal(priceAgeMinutes({ ...book("a", 2, 2), updatedAt: "not a date" }, NOW), undefined);
  assert.ok(isFresh(book("a", 2, 2, 12), NOW, 30));
  assert.ok(!isFresh(book("a", 2, 2, 90), NOW, 30));
  assert.ok(isFresh(book("a", 2, 2), NOW, 30), "unknown age counts as fresh");
});

test("a stale Pinnacle line is not used as the yardstick", () => {
  const o = odds(book("pinnacle", 2.4, 1.7, 180), book("a", 2.0, 1.9, 5), book("b", 2.05, 1.85, 5), book("c", 1.95, 1.95, 5));
  const fair = fairProbs(o, false, fresh30)!;
  assert.equal(fair.kind, "consensus", "the three fresh books are used instead");
  assert.equal(fair.stale, undefined);
  // Without an age limit the stale sharp line would have been trusted.
  assert.equal(fairProbs(o, false)!.kind, "sharp");
});

test("when every price is old the chances are still shown, but never bet on", () => {
  const o = odds(book("pinnacle", 2.0, 1.9, 200), book("soft", 2.4, 1.6, 200));
  const fair = fairProbs(o, false, fresh30)!;
  assert.equal(fair.kind, "sharp");
  assert.equal(fair.stale, true);
  assert.equal(fair.asOf, minsAgo(200));
  // The digest can show it; the value finder refuses it.
  assert.equal(findValue(fair, bestPrices(o, false, [], { now: NOW }), 1), undefined);
  // A stale offer is not a price you can take either.
  assert.equal(bestPrices(o, false, [], fresh30), undefined);
});

test("a bookmaker is never part of the consensus it is measured against", () => {
  const even = [book("a", 2.0, 2.0, 1), book("b", 2.0, 2.0, 1)];
  const generous = book("soft", 2.3, 1.9, 1);
  const without = (o: MarketOdds) => (k: string) => fairWithout(o, false, k, fresh30);

  // Three books, one of them the generous one: taking it out leaves two, which is
  // not enough for a consensus, so no value is claimed.
  const three = odds(...even, generous);
  assert.equal(fairProbs(three, false, fresh30)!.kind, "consensus");
  assert.equal(findValue(fairProbs(three, false, fresh30), bestPrices(three, false, [], fresh30), 3, { without: without(three) }), undefined);

  // Four books: three independent ones remain, so the edge can be measured.
  const four = odds(...even, book("c", 2.0, 2.0, 1), generous);
  const v = findValue(fairProbs(four, false, fresh30), bestPrices(four, false, [], fresh30), 3, { without: without(four) })!;
  assert.equal(v.book, "Soft");
  assert.ok(Math.abs(v.evPct - 15) < 0.01, `ev ${v.evPct}`); // 0.5 × 2.30 − 1
  assert.equal(v.prob, 0.5);
});

test("a small edge against a consensus needs a bigger threshold than against Pinnacle", () => {
  const books = [book("a", 2.0, 2.0, 1), book("b", 2.0, 2.0, 1), book("c", 2.0, 2.0, 1), book("soft", 2.08, 1.95, 1)];
  const cons = odds(...books);
  const opts = { without: (k: string) => fairWithout(cons, false, k, fresh30), consensusMinEdgePct: 6 };
  const best = bestPrices(cons, false, [], fresh30);
  // 4% edge: enough against a sharp line, not enough against a consensus devig.
  assert.equal(findValue(fairProbs(cons, false, fresh30), best, 3, opts), undefined);
  assert.ok(findValue(fairProbs(cons, false, fresh30), best, 3, { ...opts, consensusMinEdgePct: 3 }));
  const sharp = odds(book("pinnacle", 2.0, 2.0, 1), book("soft", 2.08, 1.95, 1));
  const v = findValue(fairProbs(sharp, false, fresh30), bestPrices(sharp, false, [], fresh30), 3, opts)!;
  assert.ok(Math.abs(v.evPct - 4) < 0.01, `ev ${v.evPct}`);
});

test("one soft bookmaker is not a reason to stop looking for a sharp price", () => {
  const m = (o?: MarketOdds): Match => ({
    key: "k", sport: "tennis", league: "ATP", start: NOW, home: { name: "A" }, away: { name: "B" },
    hasDraw: false, neutral: true, context: {}, odds: o,
  });
  assert.ok(needsSharpOdds(m()), "no odds at all");
  assert.ok(needsSharpOdds(m(odds(book("soft", 2.0, 1.9)))), "a single soft book can never show value");
  assert.ok(needsSharpOdds(m(odds(book("a", 2.0, 1.9), book("b", 2.0, 1.9)))), "two books are not a consensus");
  assert.ok(!needsSharpOdds(m(odds(book("pinnacle", 2.0, 1.9)))), "Pinnacle is what we were after");
  assert.ok(!needsSharpOdds(m(odds(book("a", 2, 2), book("b", 2, 2), book("c", 2, 2)))), "three books make a consensus");
});
