// Closing line value: did the alert's price beat where the sharp line ended up?
import { test } from "node:test";
import assert from "node:assert/strict";
import { clvLines, clvPct, clvSummary, latestPerKey, snapshot, type ClvRow } from "../src/clv.ts";
import type { Fair } from "../src/types.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const bet = { key: "m1", side: "home" as const, price: 2.3, start: new Date(NOW.getTime() + 40 * 60_000).toISOString() };
const fair = (home: number, o: Partial<Fair> = {}): Fair => ({ probs: { home, away: 1 - home, draw: 0 }, source: "Pinnacle", kind: "sharp", ...o });

test("a snapshot records the bet price against the later fair price", () => {
  const r = snapshot(bet, fair(0.5), NOW)!;
  assert.equal(r.fairPrice, 2);
  assert.equal(r.minsToStart, 40);
  assert.ok(Math.abs(clvPct(r) - 15) < 1e-9); // took 2.30 where fair became 2.00
  assert.ok(clvPct({ ...r, betPrice: 1.9 }) < 0, "a worse price than the close is negative");
});

test("a snapshot is only taken from a price worth comparing against", () => {
  assert.equal(snapshot(bet, fair(0.5, { kind: "single" }), NOW), undefined);
  assert.equal(snapshot(bet, fair(0.5, { stale: true }), NOW), undefined);
  assert.equal(snapshot(bet, fair(0), NOW), undefined);
  // After kickoff the price is no longer a closing price.
  assert.equal(snapshot({ ...bet, start: new Date(NOW.getTime() - 60_000).toISOString() }, fair(0.5), NOW), undefined);
});

test("the snapshot closest to kickoff wins, one per bet", () => {
  const rows: ClvRow[] = [
    { key: "a", side: "home", betPrice: 2.3, fairPrice: 2.2, source: "Pinnacle", at: NOW.toISOString(), minsToStart: 120 },
    { key: "a", side: "home", betPrice: 2.3, fairPrice: 2.0, source: "Pinnacle", at: NOW.toISOString(), minsToStart: 20 },
    { key: "b", side: "away", betPrice: 1.9, fairPrice: 2.0, source: "Pinnacle", at: NOW.toISOString(), minsToStart: 30 },
  ];
  assert.deepEqual(latestPerKey(rows).map((r) => [r.key, r.minsToStart]), [["a", 20], ["b", 30]]);
  const s = clvSummary(rows)!;
  assert.equal(s.n, 2);
  assert.equal(s.beat, 1);
  assert.ok(Math.abs(s.avgPct - (15 + -5) / 2) < 1e-9);
  assert.match(clvLines(rows).join("\n"), /1 of 2 bets, average \+5\.0% better/);
  assert.deepEqual(clvLines([]), []);
});
