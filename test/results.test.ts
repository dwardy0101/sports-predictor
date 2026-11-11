// Grading finished matches, and keeping the log bounded. These numbers feed the
// accuracy report, so every branch is worth a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "results-"));
process.env.DATA_DIR = DIR;
process.env.PANDASCORE_TOKEN = "ps-test";

const { lookup, lookupTennis, rotateLogs } = await import("../src/results.ts");
import type { Side } from "../src/types.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const soccer = (o: object = {}) => ({ key: "k", start: daysAgo(1), home: "Alpha", away: "Bravo", espn: { sport: "soccer", league: "eng.1", eventId: "7", compId: "7" }, ...o });

/** Answer every request with `body`, or with the first matching entry. */
async function withFetch<T>(routes: [RegExp, unknown][], fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = String(input);
    const hit = routes.find(([re]) => re.test(u));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: 200 });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const summary = (completed: boolean, home: any, away: any) => ({
  header: { competitions: [{ status: { type: { completed } }, competitors: [{ homeAway: "home", ...home }, { homeAway: "away", ...away }] }] },
});

test("a finished match is graded by its winner flag, score or lack of both", async () => {
  await withFetch([[/summary/, summary(true, { winner: true, score: "2" }, { score: "1" })]], async () => {
    assert.equal(await lookup(soccer(), NOW), "home");
  });
  await withFetch([[/summary/, summary(true, { score: "1" }, { winner: true, score: "2" })]], async () => {
    assert.equal(await lookup(soccer(), NOW), "away");
  });
  await withFetch([[/summary/, summary(true, { score: "1" }, { score: "1" })]], async () => {
    assert.equal(await lookup(soccer(), NOW), "draw");
  });
  // Finished, nobody flagged, scores differ: something is wrong, so it is voided rather than guessed.
  await withFetch([[/summary/, summary(true, { score: "3" }, { score: "1" })]], async () => {
    assert.equal(await lookup(soccer(), NOW), null);
  });
  await withFetch([[/summary/, summary(false, { score: "0" }, { score: "0" })]], async () => {
    assert.equal(await lookup(soccer(), NOW), undefined, "still being played");
  });
});

test("esports results come from PandaScore, and a cancelled match is voided", async () => {
  const ps = { key: "ps:csgo:991", start: daysAgo(1), home: "Team A", away: "Team B" };
  await withFetch([[/pandascore/, { status: "finished", winner_id: 10, opponents: [{ opponent: { id: 10 } }, { opponent: { id: 20 } }] }]], async () => {
    assert.equal(await lookup(ps, NOW), "home");
  });
  await withFetch([[/pandascore/, { status: "finished", winner_id: 20, opponents: [{ opponent: { id: 10 } }, { opponent: { id: 20 } }] }]], async () => {
    assert.equal(await lookup(ps, NOW), "away");
  });
  await withFetch([[/pandascore/, { status: "canceled" }]], async () => {
    assert.equal(await lookup(ps, NOW), null);
  });
  await withFetch([[/pandascore/, { status: "running" }]], async () => {
    assert.equal(await lookup(ps, NOW), undefined);
  });
  // No ESPN ids and not a PandaScore key: nothing can ever be looked up.
  assert.equal(await lookup({ key: "mystery", start: daysAgo(1) }, NOW), null);
});

test("tennis is graded off the scoreboard, and a walkover is voided", async () => {
  const tennis = (o: object = {}) => ({ key: "t", start: daysAgo(1), home: "Janice Tjen", away: "Katherine Hui", espn: { sport: "tennis", league: "wta", eventId: "e1", compId: "c1" }, ...o });
  const board = (comp: object) => ({ events: [{ id: "e1", name: "Open", groupings: [{ grouping: { slug: "womens-singles" }, competitions: [{ id: "c1", ...comp }] }] }] });
  const won = (name: string) => board({ status: { type: { completed: true } }, competitors: [{ athlete: { displayName: name }, winner: true }, { athlete: { displayName: "Someone" } }] });

  await withFetch([[/scoreboard/, won("Janice Tjen")]], async () => {
    assert.equal(await lookupTennis(tennis(), NOW), "home");
  });
  await withFetch([[/scoreboard/, won("Katherine Hui")]], async () => {
    assert.equal(await lookupTennis(tennis(), NOW), "away");
  });
  await withFetch([[/scoreboard/, board({ status: { type: { completed: true } }, competitors: [{ athlete: { displayName: "A" } }, { athlete: { displayName: "B" } }] })]], async () => {
    assert.equal(await lookupTennis(tennis(), NOW), null, "nobody flagged as winner: walkover or retirement");
  });
  await withFetch([[/scoreboard/, board({ status: { type: { completed: false } }, competitors: [] })]], async () => {
    assert.equal(await lookupTennis(tennis(), NOW), undefined);
  });
  // Missing from every day's board: wait a week, then give up.
  await withFetch([[/scoreboard/, { events: [] }]], async () => {
    assert.equal(await lookupTennis(tennis(), NOW), undefined);
    assert.equal(await lookupTennis(tennis({ start: daysAgo(9) }), NOW), null);
  });
  // A tennis prediction is routed to the scoreboard, not the summary page.
  await withFetch([[/scoreboard/, won("Janice Tjen")], [/summary/, summary(true, { winner: true }, {})]], async () => {
    assert.equal(await lookup(tennis(), NOW), "home");
  });
});

test("old predictions are archived, their totals kept, and the files trimmed", () => {
  const row = (key: string, days: number, extra: object = {}) => ({
    key, start: daysAgo(days), sport: "nba", home: "A", away: "B",
    fair: { home: 0.5, away: 0.5, draw: 0 }, model: { home: 0.5, away: 0.5, draw: 0 }, ...extra,
  });
  const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(DIR, "predictions.jsonl"), lines([
    row("old1", 200, { value: { side: "home", price: 2.2, book: "1xBet" } }),
    row("old2", 150),
    row("recent", 2, { value: { side: "away", price: 2.0, book: "1xBet" } }),
  ]));
  writeFileSync(join(DIR, "results.jsonl"), lines([
    { key: "old1", outcome: "home" }, { key: "old2", outcome: "away" }, { key: "recent", outcome: "away" },
  ]));
  writeFileSync(join(DIR, "clv.jsonl"), lines([
    { key: "old1", side: "home", betPrice: 2.2, fairPrice: 2.0, source: "Pinnacle", at: daysAgo(200), minsToStart: 10 },
    { key: "recent", side: "away", betPrice: 2.0, fairPrice: 1.95, source: "Pinnacle", at: daysAgo(2), minsToStart: 10 },
  ]));
  writeFileSync(join(DIR, "runs.jsonl"), lines(Array.from({ length: 600 }, (_, i) => ({ at: daysAgo(i / 12), found: 1, fresh: 1, priced: 1, sharp: 1, shown: 1, values: 0, held: 0, http: { ok: 1, failed: 0 } }))));

  const results = new Map<string, Side | null>([["old1", "home"], ["old2", "away"], ["recent", "away"]]);
  const out = rotateLogs(NOW, results);

  assert.deepEqual(out.rows.map((r: any) => r.key), ["recent"]);
  assert.deepEqual(out.clv.map((r) => r.key), ["recent"]);
  assert.equal(out.runs.length, 500);
  assert.equal(out.totals.archived, 2);
  assert.equal(out.totals.graded, 2);
  assert.equal(out.totals.bets, 1);
  assert.equal(out.totals.returned, 2.2, "the archived bet won");
  assert.equal(out.totals.clvN, 1);
  // The detail is still on disk, just not read every day.
  assert.ok(existsSync(join(DIR, "archive/predictions-2026-04.jsonl")));
  assert.ok(existsSync(join(DIR, "archive/predictions-2026-06.jsonl")));
  assert.equal(readFileSync(join(DIR, "predictions.jsonl"), "utf8").trim().split("\n").length, 1);
  // Running it again archives nothing new and leaves the totals alone.
  const again = rotateLogs(NOW, results);
  assert.equal(again.totals.archived, 2);
});
