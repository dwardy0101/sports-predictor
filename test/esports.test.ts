// Esports tiers are filtered before the (big) match history is downloaded.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PANDASCORE_TOKEN = "ps-test";
const { fetchEsportsMatches } = await import("../src/sources/esports.ts");

const upcoming = (tier: string | undefined) => [{
  id: 1, begin_at: new Date(Date.now() + 3600_000).toISOString(), number_of_games: 3,
  opponents: [{ opponent: { id: 10, name: "Team A" } }, { opponent: { id: 20, name: "Team B" } }],
  tournament: { tier }, league: { name: "Test League" },
}];

test("low-tier matches don't cost a history download; covered tiers do", async () => {
  const urls: string[] = [];
  let tier: string | undefined = "d";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = String(input);
    urls.push(u);
    return new Response(JSON.stringify(u.includes("/upcoming") ? upcoming(tier) : []), { status: 200 });
  }) as typeof fetch;
  try {
    const from = new Date(), to = new Date(Date.now() + 4 * 3600_000);
    assert.deepEqual(await fetchEsportsMatches(["cs2"], from, to), []);
    assert.equal(urls.filter((u) => u.includes("/past")).length, 0);
    assert.equal(urls.length, 1);

    tier = "a";
    urls.length = 0;
    const out = await fetchEsportsMatches(["cs2"], from, to);
    assert.equal(out.length, 1);
    assert.equal(out[0].home.name, "Team A");
    assert.ok(urls.some((u) => u.includes("/past")));
  } finally {
    globalThis.fetch = realFetch;
  }
});
