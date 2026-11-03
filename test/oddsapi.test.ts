// The Odds API: league priority and budget deferral. Fake server, no real credits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "odds-"));
process.env.ODDS_API_KEY = "test-key-456";

const { attachOdds } = await import("../src/sources/oddsapi.ts");
const { OddsBudget } = await import("../src/odds/budget.ts");
import type { Match } from "../src/types.ts";

const mk = (key: string, league: string, name: string): Match => ({
  key, sport: "football", league: name, start: new Date(Date.now() + 3600_000),
  home: { name: key + " Home" }, away: { name: key + " Away" }, hasDraw: true, neutral: false, context: {},
  espn: { sport: "soccer", league, eventId: key, compId: key },
});

test("important leagues are paid for first; the rest are held when the budget runs out", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    const m = /sports\/([^/]+)\/odds/.exec(u.pathname);
    if (m) calls.push(m[1]);
    // After this call the balance is at the reserve, so nothing more may be spent.
    return new Response("[]", { status: 200, headers: { "x-requests-remaining": "20", "x-requests-last": "1" } });
  }) as typeof fetch;
  try {
    // Last day of the month, 22 credits left, 20 reserved: exactly one call is allowed.
    const now = new Date("2026-11-30T20:00:00Z");
    const budget = OddsBudget.load(now, join(process.env.DATA_DIR!, "b.json"), { monthly: 22, reserve: 20 });
    const seriea = mk("a", "ita.1", "Serie A");
    const ucl = mk("b", "uefa.champions", "Champions League");
    const epl1 = mk("c", "eng.1", "Premier League");
    const epl2 = mk("d", "eng.1", "Premier League");
    // The Premier League has more matches ("busiest") but the Champions League is ranked higher.
    const held = await attachOdds([seriea, epl1, epl2, ucl], budget);
    assert.deepEqual(calls, ["soccer_uefa_champs_league"]);
    assert.deepEqual(new Set(held.map((x) => x.key)), new Set(["a", "c", "d"]));
  } finally {
    globalThis.fetch = realFetch;
  }
});
