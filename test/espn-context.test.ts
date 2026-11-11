// The extra detail that goes into a value-bet alert (and to the AI analyst).
// ESPN's summary endpoint is unofficial, so every field here must be optional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchEspnContext } from "../src/sources/espn.ts";
import type { Match } from "../src/types.ts";

const match = (o: Partial<Match> = {}): Match => ({
  key: "k", sport: "nba", league: "NBA", start: new Date(), home: { name: "Lakers" }, away: { name: "Celtics" },
  hasDraw: false, neutral: false, context: {},
  espn: { sport: "basketball", league: "nba", eventId: "401", compId: "401" }, ...o,
});

async function withBody<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("injuries, news, head-to-head and recent games are trimmed, not dumped", async () => {
  const summary = {
    injuries: [{ team: { displayName: "Lakers" }, injuries: Array.from({ length: 20 }, (_, i) => ({ athlete: { displayName: `Player ${i}` }, status: "Out" })) }],
    news: { articles: Array.from({ length: 12 }, (_, i) => ({ headline: `Story ${i}` })) },
    headToHeadGames: [{ events: Array.from({ length: 9 }, (_, i) => ({ gameDate: "2026-01-01", gameResult: "W", score: "100-90" })) }],
    lastFiveGames: [{ team: { displayName: "Lakers" }, events: [{ gameResult: "W", score: "100-90", opponent: { displayName: "Suns" } }] }],
  };
  const c = await withBody(summary, () => fetchEspnContext(match())) as any;
  assert.equal(c.injuries[0].team, "Lakers");
  assert.equal(c.injuries[0].out.length, 12, "the injury list is capped");
  assert.equal(c.injuries[0].out[0], "Player 0 (Out)");
  assert.equal(c.news.length, 6);
  assert.equal(c.headToHead.length, 5);
  assert.deepEqual(c.lastFive[0].games, ["W 100-90 vs Suns"]);
});

test("missing or broken fields never throw", async () => {
  assert.deepEqual(await withBody({}, () => fetchEspnContext(match())), { injuries: [], news: [], headToHead: [], lastFive: [] });
  // A nameless player is dropped rather than written out as "undefined"; a missing
  // status is still shown, because knowing someone is doubtful matters.
  const odd = { injuries: [{ injuries: [{ athlete: {} }, { athlete: { displayName: "Real Player" } }] }] };
  const c = await withBody(odd, () => fetchEspnContext(match())) as any;
  assert.deepEqual(c.injuries, [{ team: undefined, out: ["Real Player (?)"] }]);
  // Tennis has no summary page, and a match without ESPN ids has nothing to fetch.
  assert.deepEqual(await fetchEspnContext(match({ espn: { sport: "tennis", league: "atp", eventId: "1", compId: "1" } })), {});
  assert.deepEqual(await fetchEspnContext(match({ espn: undefined })), {});
  assert.deepEqual(await withBody(null, () => fetchEspnContext(match())), {});
});
