// Keeping the log bounded without losing the all-time numbers, and the extra
// report sections built on top of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addToTotals, EMPTY_TOTALS, splitOld } from "../src/archive.ts";
import { buildReport, type LoggedPrediction } from "../src/report.ts";
import type { ClvRow } from "../src/clv.ts";
import type { RunRow } from "../src/health.ts";
import type { Side } from "../src/types.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const row = (key: string, o: Partial<LoggedPrediction> = {}): LoggedPrediction => ({
  key, start: daysAgo(1), sport: "nba",
  fair: { home: 0.5, away: 0.5, draw: 0 }, model: { home: 0.5, away: 0.5, draw: 0 }, ...o,
});
const bet = (price: number, book = "1xBet", evPct = 6) => ({ side: "home" as Side, price, book, evPct });

test("old predictions are split off; undated ones are kept", () => {
  const rows = [row("new"), row("old", { start: daysAgo(200) }), row("undated", { start: undefined })];
  const { keep, old } = splitOld(rows, NOW, 120);
  assert.deepEqual(keep.map((r) => r.key), ["new", "undated"]);
  assert.deepEqual(old.map((r) => r.key), ["old"]);
});

test("archived rows keep their numbers in the totals", () => {
  const old = [
    row("a", { value: bet(2.2) }),
    row("b", { value: bet(2.4) }),
    row("c", { hasDraw: true }),
    row("ungraded"),
  ];
  const results = new Map<string, Side | null>([["a", "home"], ["b", "away"], ["c", "draw"]]);
  const clv: ClvRow[] = [{ key: "a", side: "home", betPrice: 2.2, fairPrice: 2.0, source: "Pinnacle", at: daysAgo(200), minsToStart: 20 }];
  const t = addToTotals(EMPTY_TOTALS, old, results, clv);
  assert.equal(t.archived, 4);
  assert.equal(t.graded, 3);
  assert.equal(t.nFair, 3);
  assert.equal(t.bets, 2);
  assert.equal(t.returned, 2.2); // "a" won, "b" lost
  assert.equal(t.clvN, 1);
  assert.equal(t.clvBeat, 1);
  assert.ok(Math.abs(t.brierEven - (0.5 + 0.5 + 2 / 3)) < 1e-9);
});

test("the report adds windows, breakdowns, closing-line and health", () => {
  const rows = [
    row("w1", { start: daysAgo(2), value: bet(2.2), sport: "nba" }),
    row("w2", { start: daysAgo(3), value: bet(2.4, "Bet365", 9), sport: "football", hasDraw: true }),
    row("w3", { start: daysAgo(20), value: bet(2.1, "1xBet", 4), sport: "tennis" }),
    row("w4", { start: daysAgo(25), value: bet(1.9, "1xBet", 4), sport: "tennis" }),
    row("w5", { start: daysAgo(26), value: bet(2.0, "Bet365", 9), sport: "football", hasDraw: true }),
  ];
  const results = new Map<string, Side | null>(rows.map((r, i) => [r.key, i % 2 ? "away" : "home"]));
  const runs: RunRow[] = [{ at: daysAgo(0.1), found: 6, fresh: 3, priced: 3, sharp: 2, shown: 3, values: 1, held: 0, http: { ok: 30, failed: 0 } }];
  const clv: ClvRow[] = [{ key: "w1", side: "home", betPrice: 2.2, fairPrice: 2.05, source: "Pinnacle", at: daysAgo(2), minsToStart: 15 }];
  const totals = { ...EMPTY_TOTALS, archived: 40, graded: 30, bets: 10, returned: 11.5 };
  const msg = buildReport(rows, results, { now: NOW, runs, clv, totals })!;

  assert.match(msg, /Last 7 days: 2 matches, 2 bets/);
  assert.match(msg, /Last 30 days: 5 matches, 5 bets/);
  assert.match(msg, /All time, including archived: 15 bets/);
  assert.match(msg, /<b>By sport<\/b>/);
  assert.match(msg, /• tennis: 2 bets/);
  assert.match(msg, /<b>By bookmaker<\/b>/);
  assert.match(msg, /• 1xBet: 3 bets/);
  assert.match(msg, /<b>By edge<\/b>/);
  assert.match(msg, /• edge 3–5%: 2 bets/);
  assert.match(msg, /beat the sharp price\?<\/b> 1 of 1 bets/);
  assert.match(msg, /Health \(last 24h\)/);
});

test("sections with nothing to say are left out", () => {
  // An old log without kickoff times can still be reported on: it just gets no windows.
  const rows = [row("a", { start: undefined, value: bet(2.2) })];
  const msg = buildReport(rows, new Map<string, Side | null>([["a", "home"]]))!;
  assert.match(msg, /1 finished match/);
  assert.doesNotMatch(msg, /Health|Last 7 days|By sport|beat the sharp/);
});
