import { test } from "node:test";
import assert from "node:assert/strict";
import { brier, buildReport } from "../src/report.ts";
import type { Side } from "../src/types.ts";

const row = (key: string, fair: number, model: number, extra: object = {}) => ({
  key, fair: { home: fair, away: 1 - fair, draw: 0 }, model: { home: model, away: 1 - model, draw: 0 }, modelDataPoints: 1, ...extra,
});
const outcomes = (o: [string, Side | null][]) => new Map(o);

test("brier: perfect is 0, an even guess is 0.5 (two-way) or 0.667 (football)", () => {
  assert.equal(brier({ home: 1, away: 0, draw: 0 }, "home"), 0);
  assert.equal(brier({ home: 0.5, away: 0.5, draw: 0 }, "home"), 0.5);
  assert.ok(Math.abs(brier({ home: 1 / 3, away: 1 / 3, draw: 1 / 3 }, "draw") - 2 / 3) < 1e-9);
});

test("report: nothing finished means no message", () => {
  assert.equal(buildReport([row("a", 0.6, 0.5)], outcomes([])), undefined);
  assert.equal(buildReport([row("a", 0.6, 0.5)], outcomes([["a", null]])), undefined); // voided
});

test("report: market more accurate than our guess, in plain words", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`m${i}`, 0.9, 0.55)); // market confident and right, model vague
  const res = outcomes(rows.map((r) => [r.key, "home"] as [string, Side]));
  const msg = buildReport(rows, res)!;
  assert.match(msg, /12 finished matches/);
  assert.match(msg, /Bookmaker odds, margin removed: <b>0\.020<\/b>/);
  assert.match(msg, /Our own stats guess: <b>0\.405<\/b>/);
  assert.match(msg, /Just guessing evenly: 0\.500/);
  assert.match(msg, /clearly more accurate than our own guess/);
  assert.match(msg, /none finished yet/);
  assert.doesNotMatch(msg, /Brier/i);
});

test("report: few matches, football baseline, and value-bet profit", () => {
  const football = { key: "f", hasDraw: true, fair: { home: 0.5, away: 0.25, draw: 0.25 }, model: { home: 0.4, away: 0.3, draw: 0.3 }, modelDataPoints: 1 };
  const rows = [
    football,
    row("v1", 0.5, 0.5, { value: { side: "home", price: 2.2 } }),
    row("v2", 0.5, 0.5, { value: { side: "home", price: 2.4 } }),
    row("v3", 0.5, 0.5, { value: { side: "away", price: 2.1 } }),
  ];
  const msg = buildReport(rows, outcomes([["f", "home"], ["v1", "home"], ["v2", "away"], ["v3", "away"]]))!;
  assert.match(msg, /4 finished matches/);
  assert.match(msg, /Too few matches to say much yet/);
  assert.match(msg, /Just guessing evenly: 0\.542/); // (0.667 + 3 × 0.5) / 4
  // 3 bets of 1 unit: wins return 2.2 and 2.1, one loses: profit 2.2 + 2.1 - 3 = +1.30
  assert.match(msg, /3 finished\. Betting 1 unit on each would have made <b>\+1\.30 units<\/b> \(\+43\.3%/);
  assert.match(msg, /mostly luck/);
});
