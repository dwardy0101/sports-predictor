// OddsPapi adapter. Runs against a fake server: no network, no real requests used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set before the modules load (config and state read the environment on import).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "papi-"));
process.env.ODDSPAPI_KEY = "test-key-123";
process.env.ODDSPAPI_GAP_MS = "0";

const { papiName, winnerPrices, pickTournaments, matchFixture, attachPapiOdds } = await import("../src/sources/oddspapi.ts");
const { predict } = await import("../src/predict.ts");
import type { Match } from "../src/types.ts";

const START = new Date(Date.now() + 2 * 3600_000);
const base = (o: Partial<Match>): Match => ({
  key: "k", sport: "tennis", league: "Chennai Open – Women's Singles", start: START,
  home: { name: "Janice Tjen" }, away: { name: "Katherine Hui" }, hasDraw: false, neutral: true, context: {}, ...o,
});

const market = (id: number, p1: number, p2: number, active = true) => ({
  marketActive: active,
  outcomes: { [id]: { players: { "0": { price: p1, active: false } } }, [id + 1]: { players: { "0": { price: p2, active: false } } } },
});
const fixture = (over: any = {}, book = "pinnacle", p1 = 1.5, p2 = 2.6, sport = 12) => ({
  fixtureId: "f1", participant1Id: 11, participant2Id: 22, sportId: sport, tournamentId: 37307, statusId: 0, hasOdds: true,
  startTime: START.toISOString(),
  bookmakerOdds: { [book]: { suspended: false, markets: { [({ 12: 121, 16: 161, 17: 171 } as any)[sport]]: market(({ 12: 121, 16: 161, 17: 171 } as any)[sport], p1, p2) } } },
  ...over,
});

test("names arrive as 'Surname, First'", () => {
  assert.equal(papiName("Gasquet, Richard"), "Richard Gasquet");
  assert.equal(papiName("Natus Vincere"), "Natus Vincere");
});

test("winner prices: read the price, ignore the unreliable 'active' flag, reject closed or suspended", () => {
  assert.deepEqual(winnerPrices(fixture(), "pinnacle", 12), { p1: 1.5, p2: 2.6 });
  assert.deepEqual(winnerPrices(fixture({}, "1xbet", 1.4, 2.9, 17), "1xbet", 17), { p1: 1.4, p2: 2.9 });
  const closed = fixture(); closed.bookmakerOdds.pinnacle.markets["121"].marketActive = false;
  assert.equal(winnerPrices(closed, "pinnacle", 12), undefined);
  const susp = fixture(); susp.bookmakerOdds.pinnacle.suspended = true;
  assert.equal(winnerPrices(susp, "pinnacle", 12), undefined);
  assert.equal(winnerPrices(fixture(), "1xbet", 12), undefined); // that bookmaker isn't on the fixture
  assert.equal(winnerPrices(fixture({}, "pinnacle", 1.0, 2.6), "pinnacle", 12), undefined); // not a real price
});

test("tournament picking skips junk and needs a name overlap with our matches", () => {
  const list = [
    { tournamentId: 1, tournamentName: "ATP Paris, France Men Singles", categoryName: "ATP", upcomingFixtures: 6 },
    { tournamentId: 2, tournamentName: "ATP Paris, France Men Doubles", categoryName: "ATP", upcomingFixtures: 2 },
    { tournamentId: 3, tournamentName: "WTA Chennai, India, Women Singles", categoryName: "WTA", upcomingFixtures: 4 },
    { tournamentId: 4, tournamentName: "Chennai Open", categoryName: "ITF Women", upcomingFixtures: 9 },
    { tournamentId: 5, tournamentName: "WTA Cali, Colombia Women Singles", categoryName: "WTA 125K", upcomingFixtures: 0 },
  ];
  const needy = [base({}), base({ league: "Rolex Paris Masters – Men's Singles" })];
  assert.deepEqual(pickTournaments({ 12: list }, needy).sort(), [1, 3]);
  const esports = [
    { tournamentId: 10, tournamentName: "ESL Challenger League", categoryName: "Europe", upcomingFixtures: 3 },
    { tournamentId: 11, tournamentName: "ESL Challenger League", categoryName: "Simulated Reality", upcomingFixtures: 8 },
    { tournamentId: 12, tournamentName: "Unrelated Cup", categoryName: "Asia", upcomingFixtures: 5 },
  ];
  assert.deepEqual(pickTournaments({ 17: esports }, [base({ sport: "cs2", league: "ESL Challenger League – Season 54" })]), [10]);
  const many = Array.from({ length: 9 }, (_, i) => ({ tournamentId: 100 + i, tournamentName: "Chennai Open", categoryName: "WTA", upcomingFixtures: i + 1 }));
  assert.equal(pickTournaments({ 12: many }, needy).length, 5); // the API's per-call limit
});

test("fixture matching by time and names, in either order", () => {
  const names = { "11": "Janice Tjen", "22": "Katherine Hui" };
  assert.deepEqual(matchFixture(base({}), fixture(), names), { swap: false });
  assert.deepEqual(matchFixture(base({ home: { name: "Katherine Hui" }, away: { name: "Janice Tjen" } }), fixture(), names), { swap: true });
  assert.equal(matchFixture(base({ start: new Date(START.getTime() + 5 * 3600_000) }), fixture(), names), undefined); // 5h apart
  assert.equal(matchFixture(base({ home: { name: "Someone Else" } }), fixture(), names), undefined);
  assert.equal(matchFixture(base({}), fixture(), {}), undefined); // names unknown
});

test("end to end: fake OddsPapi prices a tennis match, and a value bet appears", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    calls.push(u.pathname + (u.searchParams.get("bookmaker") ? `?${u.searchParams.get("bookmaker")}` : ""));
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (u.pathname.endsWith("/account")) return json({ subscriptions: [{ is_active: true, request_limit: 250, request_count: 20 }] });
    if (u.pathname.endsWith("/tournaments")) return json([{ tournamentId: 37307, tournamentName: "WTA Chennai, India, Women Singles", categoryName: "WTA", upcomingFixtures: 4 }]);
    if (u.pathname.endsWith("/odds-by-tournaments")) {
      const b = u.searchParams.get("bookmaker")!;
      // Pinnacle: fair ~ 60/40. 1xBet pays more on side 2, so side 2 (Katherine Hui) is the value bet.
      return json([b === "pinnacle" ? fixture({}, "pinnacle", 1.62, 2.38) : fixture({}, "1xbet", 1.55, 2.6)]);
    }
    if (u.pathname.endsWith("/participants")) return json({ "11": "Tjen, Janice", "22": "Hui, Katherine", "99": "Other, Player" });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const m = base({});
    const unrelated = base({ key: "k2", sport: "nba", league: "NBA" }); // not an OddsPapi sport: untouched
    const NOW = new Date("2026-11-03T20:00:00Z");
    await attachPapiOdds([m, unrelated], NOW);
    assert.equal(m.odds?.source, "OddsPapi");
    assert.deepEqual(m.odds!.books.map((b) => [b.key, b.home, b.away]), [["pinnacle", 1.62, 2.38], ["1xbet", 1.55, 2.6]]);
    assert.equal(unrelated.odds, undefined);

    const p = predict(m);
    assert.equal(p.fair?.kind, "sharp");
    assert.equal(p.value?.side, "away");
    assert.equal(p.value?.book, "1xBet");

    // 1 tournaments + 2 odds + 1 names = 4 requests, plus the free /account call.
    assert.equal(calls.filter((c) => !c.includes("/account")).length, 4);
    assert.ok(calls.some((c) => c.endsWith("?pinnacle")) && calls.some((c) => c.endsWith("?1xbet")));

    // A second run the same day reuses the cached lists: only the 2 odds calls remain.
    calls.length = 0;
    const m2 = base({ key: "k3" });
    await attachPapiOdds([m2], NOW);
    assert.equal(calls.filter((c) => !c.includes("/account")).length, 2);
    assert.equal(m2.odds?.books.length, 2);

    // Matches that already have odds cost nothing.
    calls.length = 0;
    await attachPapiOdds([m], NOW);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("when the request quota is nearly used up, OddsPapi spends nothing and reports the matches as held", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    return new Response(JSON.stringify({ subscriptions: [{ is_active: true, request_limit: 250, request_count: 245 }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const m = base({ key: "k9", home: { name: "Someone New" }, away: { name: "Another One" } });
    const held = await attachPapiOdds([m], new Date("2026-11-04T20:00:00Z"));
    assert.deepEqual(held, [m]);
    assert.equal(m.odds, undefined);
    assert.deepEqual(calls, ["/v4/account"]); // only the free balance check
  } finally {
    globalThis.fetch = realFetch;
  }
});
