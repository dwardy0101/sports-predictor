// Bets already alerted on get a later sharp price for free: they are added to odds
// calls that are happening anyway, and never cause one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "clv-run-"));
process.env.DATA_DIR = DIR;
process.env.ODDS_API_KEY = "test-key-789";

const NOW = new Date("2026-11-11T12:00:00Z");
const inMins = (m: number) => new Date(NOW.getTime() + m * 60_000);

writeFileSync(join(DIR, "predictions.jsonl"), [
  // An open bet: alerted earlier, kicks off in an hour.
  { key: "espn:eng.1:900", sport: "football", league: "Premier League", start: inMins(60).toISOString(), home: "Arsenal", away: "Chelsea", hasDraw: true, espn: { sport: "soccer", league: "eng.1", eventId: "900", compId: "900" }, value: { side: "home", price: 2.3 } },
  // Same match, logged twice in different runs: only watched once.
  { key: "espn:eng.1:900", sport: "football", league: "Premier League", start: inMins(60).toISOString(), home: "Arsenal", away: "Chelsea", hasDraw: true, espn: { sport: "soccer", league: "eng.1", eventId: "900", compId: "900" }, value: { side: "home", price: 2.3 } },
  // Already kicked off: nothing to snapshot.
  { key: "espn:eng.1:800", sport: "football", league: "Premier League", start: inMins(-30).toISOString(), home: "Spurs", away: "Everton", hasDraw: true, espn: { sport: "soccer", league: "eng.1", eventId: "800", compId: "800" }, value: { side: "home", price: 2.0 } },
  // No value bet: not watched.
  { key: "espn:eng.1:700", sport: "football", league: "Premier League", start: inMins(60).toISOString(), home: "Leeds", away: "Burnley", hasDraw: true, espn: { sport: "soccer", league: "eng.1", eventId: "700", compId: "700" } },
].map((r) => JSON.stringify(r)).join("\n") + "\n");

const { openBets } = await import("../src/main.ts");
const { attachOdds } = await import("../src/sources/oddsapi.ts");
const { OddsBudget } = await import("../src/odds/budget.ts");
const { fairProbs } = await import("../src/odds/fair.ts");
const { clvPct, snapshot } = await import("../src/clv.ts");
import type { Match } from "../src/types.ts";

test("only open bets are watched, once each", () => {
  const open = openBets(NOW);
  assert.deepEqual(open.map((o) => o.bet.key), ["espn:eng.1:900"]);
  assert.equal(open[0].bet.price, 2.3);
  assert.equal(open[0].match.hasDraw, true);
  assert.equal(open[0].match.espn!.eventId, "900");
});

test("a watched bet rides along on a call that was happening anyway", async () => {
  const fresh: Match = {
    key: "espn:eng.1:901", sport: "football", league: "Premier League", start: inMins(45),
    home: { name: "Liverpool" }, away: { name: "Everton" }, hasDraw: true, neutral: false, context: {},
    espn: { sport: "soccer", league: "eng.1", eventId: "901", compId: "901" },
  };
  const open = openBets(NOW);
  const event = (id: string, home: string, away: string, start: Date, price: number) => ({
    id, commence_time: start.toISOString(), home_team: home, away_team: away,
    bookmakers: [{
      key: "pinnacle", title: "Pinnacle", last_update: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      markets: [{ key: "h2h", last_update: new Date(NOW.getTime() - 2 * 60_000).toISOString(), outcomes: [
        { name: home, price }, { name: away, price: 3.2 }, { name: "Draw", price: 3.6 },
      ] }],
    }],
  });

  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    return new Response(JSON.stringify([
      event("901", "Liverpool", "Everton", inMins(45), 1.9),
      event("900", "Arsenal", "Chelsea", inMins(60), 2.05),
    ]), { status: 200, headers: { "x-requests-remaining": "400", "x-requests-last": "1" } });
  }) as typeof fetch;
  try {
    const budget = OddsBudget.load(NOW, join(DIR, "b.json"), { monthly: 500, reserve: 20, pace: false });
    await attachOdds([fresh], budget, open.map((o) => o.match));
    // One sport, one call: the watched bet cost nothing.
    assert.deepEqual(calls, ["/v4/sports/soccer_epl/odds"]);
    assert.equal(fresh.odds?.books.length, 1);
    assert.equal(open[0].match.odds?.books[0].key, "pinnacle");
    // The price timestamp came through, so the line is known to be fresh.
    assert.equal(open[0].match.odds!.books[0].updatedAt, new Date(NOW.getTime() - 2 * 60_000).toISOString());

    const fair = fairProbs(open[0].match.odds, true, { now: NOW, maxAgeMinutes: 30 })!;
    const row = snapshot(open[0].bet, fair, NOW)!;
    assert.equal(row.key, "espn:eng.1:900");
    // Pinnacle's 2.05 with its margin removed is a fair price of about 2.16, so the
    // 2.30 the alert told us to take did beat the later sharp line.
    assert.ok(row.fairPrice > 2.1 && row.fairPrice < 2.25, `fair now ${row.fairPrice}`);
    assert.ok(clvPct(row) > 5, `clv ${clvPct(row)}`);
    assert.equal(row.minsToStart, 60);
  } finally {
    globalThis.fetch = real;
  }
});

test("watched bets alone never start a call", async () => {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => { calls.push(String(input)); return new Response("[]", { status: 200 }); }) as typeof fetch;
  try {
    const budget = OddsBudget.load(NOW, join(DIR, "b2.json"), { monthly: 500, reserve: 20, pace: false });
    assert.deepEqual(await attachOdds([], budget, openBets(NOW).map((o) => o.match)), []);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = real;
  }
});
