import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eloWinProb, footballProbs, log5, modelProbs, rankWinProb, shrunkWinRate } from "../src/model/probability.ts";
import { bestPrices, devigBook, fairProbs, findValue } from "../src/odds/fair.ts";
import { OddsBudget } from "../src/odds/budget.ts";
import { americanToDecimal, parseRecord } from "../src/sources/espn.ts";
import { computeElo } from "../src/sources/esports.ts";
import { sameTournament, similar } from "../src/sources/oddsapi.ts";
import { chunk, formatAlert, formatDigest } from "../src/notify/telegram.ts";
import { predict } from "../src/predict.ts";
import type { MarketOdds, Match } from "../src/types.ts";

const sum = (p: { home: number; away: number; draw: number }) => p.home + p.away + p.draw;
const base = (o: Partial<Match>): Match => ({
  key: "k", sport: "nba", league: "NBA", start: new Date(Date.now() + 3600_000),
  home: { name: "A" }, away: { name: "B" }, hasDraw: false, neutral: false, context: {}, ...o,
});
const odds = (...books: [string, number, number, number?][]): MarketOdds => ({
  source: "t",
  books: books.map(([key, home, away, draw]) => ({ key, title: key[0].toUpperCase() + key.slice(1), home, away, draw })),
});

test("devig removes bookmaker margin", () => {
  const p = devigBook({ key: "x", title: "X", home: 1.9, away: 1.9 }, false)!;
  assert.ok(Math.abs(p.home - 0.5) < 1e-9);
  const f = devigBook({ key: "x", title: "X", home: 2.1, draw: 3.4, away: 3.6 }, true)!;
  assert.ok(Math.abs(sum(f) - 1) < 1e-9);
});

test("power devig takes more margin off the long shot", () => {
  const b = { key: "x", title: "X", home: 1.3, draw: 6.0, away: 10.0 };
  const p = devigBook(b, true)!;
  assert.ok(Math.abs(sum(p) - 1) < 1e-9);
  const q = [1 / 1.3, 1 / 6, 1 / 10], s = q[0] + q[1] + q[2];
  assert.ok(p.away < q[2] / s, "underdog lower than simple scaling");
  assert.ok(p.home > q[0] / s, "favourite higher than simple scaling");
});

test("bookmaker allow-list limits the best prices", () => {
  const o = odds(["pinnacle", 2.0, 1.9], ["unibet_se", 2.3, 1.7], ["onexbet", 2.15, 1.75]);
  o.books[1].title = "Unibet (SE)";
  o.books[2].title = "1xBet";
  assert.equal(bestPrices(o, false)!.home!.book, "Unibet (SE)");
  assert.equal(bestPrices(o, false, ["1xbet"])!.home!.book, "1xBet");
  assert.equal(bestPrices(o, false, ["bet365"]), undefined);
});

test("fair odds: Pinnacle first, then consensus, then single book", () => {
  const withPin = fairProbs(odds(["unibet", 2.2, 1.7], ["pinnacle", 2.0, 1.85], ["bet365", 2.1, 1.75]), false)!;
  assert.equal(withPin.kind, "sharp");
  assert.ok(withPin.probs.home < 0.5);
  const cons = fairProbs(odds(["a", 2.0, 1.8], ["b", 2.1, 1.75], ["c", 1.95, 1.85]), false)!;
  assert.equal(cons.kind, "consensus");
  assert.match(cons.source, /3 books/);
  assert.equal(fairProbs(odds(["draftkings", 2.0, 1.8]), false)!.kind, "single");
  assert.equal(fairProbs(undefined, false), undefined);
  // Exchanges never count as the fair price or the best price.
  assert.equal(fairProbs(odds(["betfair_ex_eu", 2.0, 2.0]), false), undefined);
});

test("value = a bookmaker pays more than Pinnacle's fair price", () => {
  const o = odds(["pinnacle", 2.0, 1.9], ["unibet", 2.25, 1.7], ["betfair_ex_eu", 2.6, 1.6]);
  const fair = fairProbs(o, false)!;
  const best = bestPrices(o, false)!;
  assert.equal(best.home!.book, "Unibet"); // exchange excluded
  const v = findValue(fair, best, 3)!;
  assert.equal(v.side, "home");
  assert.ok(v.evPct > 3 && v.evPct < 15, `ev ${v.evPct}`);
  assert.ok(Math.abs(v.fairPrice - 1 / fair.probs.home) < 1e-9);
  // Below threshold -> nothing.
  assert.equal(findValue(fair, best, 20), undefined);
  // A single bookmaker can't show value against itself.
  const single = odds(["draftkings", 2.0, 1.8]);
  assert.equal(findValue(fairProbs(single, false), bestPrices(single, false), 0), undefined);
  // Absurd edges are treated as data errors.
  const broken = odds(["pinnacle", 1.5, 2.8], ["soft", 4.0, 1.2]);
  assert.equal(findValue(fairProbs(broken, false), bestPrices(broken, false), 3), undefined);
});

test("predict uses fair odds when present and the model otherwise", () => {
  const m = base({ odds: odds(["pinnacle", 1.5, 2.8]) });
  const p = predict(m);
  assert.equal(p.confidence, "high");
  assert.ok(p.final.home > 0.6);
  const noOdds = predict(base({ neutral: true }));
  assert.equal(noOdds.fair, undefined);
  assert.equal(noOdds.modelDataPoints, 0);
  assert.equal(noOdds.confidence, "low");
});

test("log5, elo and rank models behave sensibly", () => {
  assert.equal(log5(0.5, 0.5), 0.5);
  assert.ok(log5(0.7, 0.4) > 0.7);
  assert.ok(Math.abs(eloWinProb(1600, 1500) - 0.64) < 0.01);
  assert.ok(Math.abs(rankWinProb(1, 10) - 0.86) < 0.01);
  assert.ok(rankWinProb(100, 50) < 0.5);
  // Tennis with only one ranked player: the other counts as ~#200.
  const t = modelProbs(base({ sport: "tennis", neutral: true, home: { name: "A", rank: 20 }, away: { name: "B" } }));
  assert.ok(t.probs.home > 0.75 && t.dataPoints === 1);
});

test("shrinkage pulls small samples toward 50%", () => {
  assert.ok(shrunkWinRate({ w: 2, d: 0, l: 0 })! < 0.7);
  assert.ok(shrunkWinRate({ w: 60, d: 0, l: 20 })! > 0.7);
});

test("football: equal teams ≈ league average, probabilities sum to 1", () => {
  const { probs } = footballProbs(base({ sport: "football", hasDraw: true }));
  assert.ok(Math.abs(sum(probs) - 1) < 1e-9);
  assert.ok(probs.home > 0.42 && probs.home < 0.48, `home ${probs.home}`);
  assert.ok(probs.draw > 0.24 && probs.draw < 0.3, `draw ${probs.draw}`);
  const strong = footballProbs(base({ sport: "football", hasDraw: true, home: { name: "A", record: { w: 10, d: 1, l: 1 } }, away: { name: "B", record: { w: 2, d: 2, l: 8 } } }));
  assert.ok(strong.probs.home > 0.6);
});

test("basketball home advantage and record", () => {
  const even = modelProbs(base({}));
  assert.ok(even.probs.home > 0.55 && even.probs.home < 0.6);
  const neutral = modelProbs(base({ neutral: true }));
  assert.equal(neutral.probs.home, 0.5);
  const fav = modelProbs(base({ home: { name: "A", record: { w: 40, d: 0, l: 10 } }, away: { name: "B", record: { w: 15, d: 0, l: 35 } } }));
  assert.ok(fav.probs.home > 0.75);
});

test("esports Elo from match history", () => {
  const h = Array.from({ length: 10 }, (_, i) => ({ begin_at: new Date(2026, 0, i + 1).toISOString(), winner_id: 1, a: 1, b: 2, aName: "Strong", bName: "Weak" }));
  const s = computeElo(h);
  assert.ok(s.get(1)!.rating > 1600 && s.get(2)!.rating < 1400);
  assert.equal(s.get(1)!.games, 10);
  assert.equal(s.get(2)!.recent[0].result, "L");
});

test("odds budget spreads the free quota over the month", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-"));
  const file = join(dir, "b.json");
  // 1 Nov, fresh month: (500 - 20 reserve) / 30 days = 16 per day.
  const b = OddsBudget.load(new Date("2026-11-01T10:00:00Z"), file);
  assert.equal(b.dailyAllowance(), 16);
  for (let i = 0; i < 16; i++) { assert.ok(b.canSpend()); b.record(String(499 - i), "1"); }
  assert.equal(b.canSpend(), false);
  b.save(file);
  // Next day the daily count resets and the allowance is recomputed from what's left.
  const next = OddsBudget.load(new Date("2026-11-02T10:00:00Z"), file);
  assert.ok(next.canSpend());
  assert.equal(next.dailyAllowance(), Math.floor((484 - 20) / 29));
  // Near the reserve, nothing more is spent.
  writeFileSync(file, JSON.stringify({ month: "2026-11", day: "2026-11-30", usedToday: 0, remaining: 20 }));
  assert.equal(OddsBudget.load(new Date("2026-11-30T10:00:00Z"), file).canSpend(), false);
});

test("parsers and name matching", () => {
  assert.deepEqual(parseRecord("10-5", false), { w: 10, d: 0, l: 5 });
  assert.deepEqual(parseRecord("8-3-2", true), { w: 8, d: 3, l: 2 });
  assert.equal(parseRecord(undefined, false), undefined);
  assert.equal(americanToDecimal(-200)!.toFixed(2), "1.50");
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(americanToDecimal(null), undefined);
  assert.ok(similar("Manchester United", "Man United"));
  assert.ok(similar("Los Angeles Lakers", "LA Lakers"));
  assert.ok(!similar("Manchester United", "Manchester City"));
  assert.ok(!similar("Real Madrid", "Real Betis"));
  assert.ok(similar("Paris Saint-Germain", "Paris Saint Germain FC"));
  const paris = base({ sport: "tennis", tournament: "Rolex Paris Masters", espn: { sport: "tennis", league: "atp", eventId: "1", compId: "1" } });
  assert.ok(sameTournament(paris, { key: "tennis_atp_paris_masters", title: "ATP Paris Masters" }));
  assert.ok(!sameTournament(paris, { key: "tennis_wta_paris", title: "WTA Paris" })); // wrong tour
  assert.ok(!sameTournament(paris, { key: "tennis_atp_shanghai_masters", title: "ATP Shanghai Masters" }));
});

test("digest groups by league and escapes HTML; alert explains the value", () => {
  const m = base({ home: { name: "A & Co" }, away: { name: "<B>" }, odds: odds(["pinnacle", 2.0, 1.9], ["unibet", 2.25, 1.7]) });
  const p = predict(m);
  assert.ok(p.value);
  const [digest] = formatDigest([p, predict(base({ key: "k2", sport: "football", league: "Premier League", hasDraw: true, home: { name: "C", record: { w: 3, d: 0, l: 0 } }, away: { name: "D", record: { w: 0, d: 0, l: 3 } } }))]);
  assert.match(digest, /A &amp; Co/);
  assert.match(digest, /&lt;B&gt;/);
  assert.match(digest, /<b>NBA<\/b>/);
  assert.match(digest, /<b>Premier League<\/b>/);
  assert.match(digest, /💎/);
  const alert = formatAlert(p);
  assert.match(alert, /Value bet: A &amp; Co @ 2\.25/);
  assert.match(alert, /Unibet/);
  assert.match(alert, /Fair price 2\.\d\d/);
  // Long digests are split under Telegram's limit.
  const parts = chunk(Array.from({ length: 100 }, () => "x".repeat(100)));
  assert.ok(parts.length > 1 && parts.every((s) => s.length <= 3800));
});
