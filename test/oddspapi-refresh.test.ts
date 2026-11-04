// A saved tournament list that predates today's draw must not hide the tournament.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "papi-refresh-"));
mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;
process.env.ODDSPAPI_KEY = "test-key-789";
process.env.ODDSPAPI_GAP_MS = "0";

const NOW = new Date("2026-11-04T20:00:00Z");
const hoursAgo = (h: number) => NOW.getTime() - h * 3600_000;
const hk = (up: number, live: number) => ({ tournamentId: 11111, tournamentName: "WTA Hong Kong, Hong Kong Women Singles", categoryName: "WTA", upcomingFixtures: up, liveFixtures: live });
// Cache saved 10 hours ago, when the tournament showed 0 upcoming matches (like the real one on Nov 3).
writeFileSync(join(dir, "oddspapi-cache.json"), JSON.stringify({
  tournaments: { "12": { at: hoursAgo(10), list: [hk(0, 0)] } },
  participants: { "12": { at: hoursAgo(1), names: { "11": "Talia Gibson", "22": "Aliaksandra Sasnovich" } } },
}));

const { attachPapiOdds, pickTournaments } = await import("../src/sources/oddspapi.ts");
import type { Match } from "../src/types.ts";

const START = new Date(NOW.getTime() + 2 * 3600_000);
const mk = (): Match => ({
  key: "hk", sport: "tennis", league: "Prudential Hong Kong Tennis Open – Women's Singles", start: START,
  home: { name: "Talia Gibson" }, away: { name: "Aliaksandra Sasnovich" }, hasDraw: false, neutral: true, context: {},
});

test("a tournament with a match in play counts as active", () => {
  assert.deepEqual(pickTournaments({ 12: [hk(0, 1)] }, [mk()]), [11111]);
  assert.deepEqual(pickTournaments({ 12: [hk(0, 0)] }, [mk()]), []);
});

test("an old list that shows nothing is refreshed, then the matches are priced", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    calls.push(u.pathname.replace("/v4", "") + (u.searchParams.get("bookmaker") ? `?${u.searchParams.get("bookmaker")}` : ""));
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (u.pathname.endsWith("/account")) return json({ subscriptions: [{ is_active: true, request_limit: 250, request_count: 30 }] });
    if (u.pathname.endsWith("/tournaments")) {
      // Today's draw is out now. The list also holds junk that must not be saved.
      return json([hk(4, 0),
        { tournamentId: 5, tournamentName: "ITF Women Somewhere", categoryName: "ITF Women", upcomingFixtures: 9 },
        { tournamentId: 6, tournamentName: "WTA Hong Kong Women Doubles", categoryName: "WTA", upcomingFixtures: 2 },
        { tournamentId: 7, tournamentName: "SRL Hong Kong", categoryName: "Simulated Reality", upcomingFixtures: 3 }]);
    }
    if (u.pathname.endsWith("/odds-by-tournaments")) {
      const fx = { fixtureId: "f1", participant1Id: 11, participant2Id: 22, sportId: 12, tournamentId: 11111, statusId: 0, startTime: START.toISOString() };
      const b = u.searchParams.get("bookmaker")!;
      return json([{ ...fx, bookmakerOdds: { [b]: { suspended: false, fixturePath: `https://${b}.example/hk`, markets: { "121": { marketActive: true, outcomes: { "121": { players: { "0": { price: 1.6 } } }, "122": { players: { "0": { price: 2.4 } } } } } } } } }]);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const m = mk();
    const held = await attachPapiOdds([m], NOW);
    assert.deepEqual(held, []);
    assert.equal(m.odds?.books.length, 2);
    assert.equal(m.odds?.books[1].link, "https://1xbet.example/hk");
    assert.deepEqual(calls.filter((c) => !c.includes("account")), ["/tournaments", "/odds-by-tournaments?pinnacle", "/odds-by-tournaments?1xbet"]);
    // The old one-file cache was migrated into two small files holding only real tournaments.
    assert.equal(existsSync(join(dir, "oddspapi-cache.json")), false);
    const saved = JSON.parse(readFileSync(join(dir, "oddspapi-tournaments.json"), "utf8"));
    assert.deepEqual(saved["12"].list.map((t: any) => t.tournamentId), [11111]);
    assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, "oddspapi-names.json"), "utf8"))["12"].names).length >= 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
