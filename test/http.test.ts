// The request pool and the per-run request tally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getJson, httpStats, pool } from "../src/http.ts";

test("the pool keeps the order and never exceeds the limit", async () => {
  let live = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 * (8 - n))); // later items finish sooner
    live--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(peak, 3);
  assert.deepEqual(await pool([], 3, async (n) => n), []);
});

test("requests are tallied per host, so a dead feed can be seen", async () => {
  const real = globalThis.fetch;
  httpStats.reset();
  globalThis.fetch = (async (input: any) => {
    const ok = String(input).includes("/good");
    return new Response(ok ? "{\"a\":1}" : "nope", { status: ok ? 200 : 404 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await getJson("https://a.example/good"), { a: 1 });
    assert.equal(await getJson("https://a.example/bad"), null);
    assert.equal(await getJson("https://b.example/bad"), null);
    assert.equal(httpStats.ok, 1);
    assert.equal(httpStats.failed, 2);
    assert.deepEqual(httpStats.byHost["a.example"], { ok: 1, failed: 1 });
    assert.deepEqual(httpStats.byHost["b.example"], { ok: 0, failed: 1 });
  } finally {
    globalThis.fetch = real;
    httpStats.reset();
  }
});
