// Regression tests for bugs found in a code review.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
process.env.TELEGRAM_CHAT_ID = "42";

const { chunk, fitTelegram, sendTelegram } = await import("../src/notify/telegram.ts");
const { deliver, toMarkSent } = await import("../src/deliver.ts");
const { nameScore, parseBooks, similar } = await import("../src/sources/oddsapi.ts");
const { matchFixture } = await import("../src/sources/oddspapi.ts");
const { givenUp, shouldSendReport } = await import("../src/report.ts");
const { predict } = await import("../src/predict.ts");
import type { Match, MarketOdds } from "../src/types.ts";

const match = (o: Partial<Match> = {}): Match => ({
  key: "k", sport: "nba", league: "NBA", start: new Date(Date.now() + 3600_000),
  home: { name: "Alpha Team" }, away: { name: "Bravo Team" }, hasDraw: false, neutral: false, context: {}, ...o,
});
const valueOdds = (): MarketOdds => ({ source: "t", books: [
  { key: "pinnacle", title: "Pinnacle", home: 2.0, away: 1.9 },
  { key: "unibet", title: "Unibet", home: 2.25, away: 1.7 },
] });

const balanced = (s: string) => (s.match(/<a /g) ?? []).length === (s.match(/<\/a>/g) ?? []).length && (s.match(/<i>/g) ?? []).length === (s.match(/<\/i>/g) ?? []).length;

test("a huge league block is split between lines, never inside an HTML tag", () => {
  const line = (i: number) => `${i}:00 PM Player Number${i} 50% · Other Person${i} 50% <i>P</i> <a href="https://1xbet.example/line/${i}">🔗</a>`;
  const block = ["🎾 <b>Big Open</b>", ...Array.from({ length: 120 }, (_, i) => line(i))].join("\n");
  assert.ok(block.length > 3800);
  const parts = chunk(["header", block, "<i>footer</i>"]);
  assert.ok(parts.length > 1);
  for (const p of parts) { assert.ok(p.length <= 3800, `chunk of ${p.length}`); assert.ok(balanced(p), "tags cut in half"); }
  const all = parts.join("\n");
  for (let i = 0; i < 120; i++) assert.ok(all.includes(`Player Number${i} `), `lost match ${i}`);
});

test("a message over Telegram's limit is cut at a line break", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i} <b>bold</b> ${"x".repeat(30)}`).join("\n");
  const cut = fitTelegram(long);
  assert.ok(cut.length <= 3800 && long.length > 4096);
  assert.ok(balanced(cut) && !cut.endsWith("<"));
  assert.equal(fitTelegram("short"), "short");
});

test("if Telegram rejects the HTML, the same words are sent as plain text", async () => {
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" }), { status: 400 })
      : new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await sendTelegram("<b>Tom &amp; Jerry</b> 1 &lt; 2 <a href=\"https://x.example\">🔗</a>"), true);
    assert.equal(bodies[0].parse_mode, "HTML");
    assert.equal(bodies[1].parse_mode, undefined);
    assert.equal(bodies[1].text, "Tom & Jerry 1 < 2 🔗");
    // Any other error is a failure, reported once.
    bodies.length = 0;
    globalThis.fetch = (async (_u: any, init: any) => { bodies.push(init); return new Response("{\"description\":\"chat not found\"}", { status: 400 }); }) as typeof fetch;
    assert.equal(await sendTelegram("hello"), false);
    assert.equal(bodies.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one failed value alert does not make the whole digest go out again", async () => {
  const a = predict(match({ key: "a", odds: valueOdds() }));
  const b = predict(match({ key: "b", odds: valueOdds() }));
  const plain = predict(match({ key: "c", odds: valueOdds() }));
  let n = 0;
  const sentTexts: string[] = [];
  const d = await deliver([a, b, plain], [a, b], new Date(), {
    send: async (t) => { sentTexts.push(t); n++; return n !== 3; }, // message 1 = digest, 2 = alert a, 3 = alert b (fails)
    enrich: async () => {},
  });
  assert.equal(d.digestOk, true);
  assert.deepEqual(d.failedAlerts, [b]);
  assert.deepEqual(toMarkSent([a, b, plain], d), [a, plain]); // b is retried next run, the rest are done
  // A failed digest marks nothing.
  const bad = await deliver([a], [], new Date(), { send: async () => false, enrich: async () => {} });
  assert.deepEqual(toMarkSent([a], bad), []);
  // With the digest switched off only the alerts are sent.
  sentTexts.length = 0;
  await deliver([a], [a], new Date(), { send: async (t) => (sentTexts.push(t), true), enrich: async () => {} }, false);
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0], /Value bet/);
});

test("'Inter Milan' is not mistaken for 'AC Milan'", () => {
  assert.ok(similar("Inter Milan", "AC Milan")); // the loose matcher alone can't tell them apart...
  assert.ok(nameScore("Inter Milan", "Inter Milan") > nameScore("Inter Milan", "AC Milan")); // ...but the score can
  const m = match({ sport: "football", hasDraw: true, home: { name: "AC Milan" }, away: { name: "Inter Milan" } });
  for (const order of [["AC Milan", "Inter Milan"], ["Inter Milan", "AC Milan"]]) {
    const price = (n: string) => (n === "AC Milan" ? 3.1 : 2.2);
    const ev = { bookmakers: [{ key: "x", title: "X", markets: [{ key: "h2h", outcomes: [...order.map((n) => ({ name: n, price: price(n) })), { name: "Draw", price: 3.4 }] }] }] };
    const [book] = parseBooks(ev, m);
    assert.deepEqual([book.home, book.away, book.draw], [3.1, 2.2, 3.4], `outcome order ${order}`);
  }
  // OddsPapi side detection uses the same scoring.
  const names = { "1": "Inter Milan", "2": "AC Milan" };
  const fx = { startTime: m.start.toISOString(), participant1Id: 1, participant2Id: 2 };
  assert.deepEqual(matchFixture(m, fx, names), { swap: true });
});

test("the report is not sent twice in a day, and old unfinished matches are given up on", () => {
  const now = new Date("2026-11-04T06:30:00Z");
  assert.equal(shouldSendReport(undefined, now), true);
  assert.equal(shouldSendReport("2026-11-04T06:23:00Z", now), false); // the other trigger already sent it
  assert.equal(shouldSendReport("2026-11-03T06:23:00Z", now), true);
  assert.equal(shouldSendReport("garbage", now), true);
  assert.equal(givenUp("2026-10-20T10:00:00Z", now), true);
  assert.equal(givenUp("2026-11-02T10:00:00Z", now), false);
});
