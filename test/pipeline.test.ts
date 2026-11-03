// End-to-end with fake ESPN responses: no network needed.
import { test } from "node:test";
import assert from "node:assert/strict";

test("ESPN scoreboard -> matches (basketball + tennis groupings + real rankings)", async () => {
  const start = new Date(Date.now() + 2 * 3600_000).toISOString();
  const nba = {
    events: [{
      id: "401", date: start, name: "Celtics at Lakers", links: [{ rel: ["summary"], href: "https://espn.com/x" }],
      competitions: [{
        id: "401", date: start, status: { type: { state: "pre" } },
        odds: [{ provider: { name: "DraftKings" }, homeTeamOdds: { moneyLine: -150 }, awayTeamOdds: { moneyLine: 130 } }],
        competitors: [
          { homeAway: "home", team: { id: "13", displayName: "Los Angeles Lakers" }, records: [{ type: "total", summary: "30-20" }, { type: "home", summary: "18-7" }] },
          { homeAway: "away", team: { id: "2", displayName: "Boston Celtics" }, records: [{ type: "total", summary: "35-15" }, { type: "road", summary: "16-9" }] },
        ],
      }],
    }, { id: "402", date: start, competitions: [{ status: { type: { state: "in" } }, competitors: [] }] }],
  };
  const tennis = {
    events: [{
      id: "t1", name: "Rolex Paris Masters",
      groupings: [
        { grouping: { slug: "mens-singles", displayName: "Men's Singles" }, competitions: [{ id: "c1", date: start, status: { type: { state: "pre" } },
          // curatedRank here is the SEED, which must not be used as the world ranking.
          competitors: [{ athlete: { displayName: "Player One" }, curatedRank: { current: 1 } }, { athlete: { displayName: "Player Two" }, curatedRank: { current: 2 } }] }] },
        { grouping: { slug: "mens-doubles" }, competitions: [{ id: "c2", date: start, competitors: [{}, {}] }] },
      ],
    }],
  };
  const rankings = { rankings: [{ name: "ATP", ranks: [{ current: 3, athlete: { displayName: "Player One" } }, { current: 40, athlete: { displayName: "Player Two" } }] }] };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const body = url.includes("/rankings") ? rankings : url.includes("/nba/") ? nba : url.includes("/atp/") ? tennis : { events: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const { fetchEspnMatches } = await import("../src/sources/espn.ts");
    const { predict } = await import("../src/predict.ts");
    const now = new Date();
    const ms = await fetchEspnMatches(["nba", "tennis"], now, new Date(now.getTime() + 4 * 3600_000));
    assert.equal(ms.length, 2);

    const g = ms.find((m) => m.sport === "nba")!;
    assert.equal(g.home.name, "Los Angeles Lakers");
    assert.deepEqual(g.away.record, { w: 35, d: 0, l: 15 });
    assert.equal(g.odds!.books[0].home.toFixed(3), "1.667");
    const pg = predict(g);
    assert.equal(pg.fair!.kind, "single"); // one US book: shown, but never a value bet
    assert.equal(pg.value, undefined);

    const t = ms.find((m) => m.sport === "tennis")!;
    assert.equal(t.home.rank, 3);
    assert.equal(t.away.rank, 40);
    assert.equal(t.tournament, "Rolex Paris Masters");
    assert.equal(t.espn!.compId, "c1");
    assert.ok(t.neutral);
    assert.ok(predict(t).final.home > 0.85);
  } finally {
    globalThis.fetch = realFetch;
  }
});
