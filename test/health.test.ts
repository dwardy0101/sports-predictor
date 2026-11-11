// The watchdog: silence must not look like a quiet night.
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthLines, recent, shouldWarn, watchdogAlarm, type RunRow } from "../src/health.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const run = (hoursAgo: number, o: Partial<RunRow> = {}): RunRow => ({
  at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
  found: 4, fresh: 2, priced: 2, sharp: 1, shown: 2, values: 0, held: 0, http: { ok: 20, failed: 0 }, ...o,
});

test("only real runs from the last day count as health", () => {
  const runs = [run(40), run(5), run(1, { dry: true }), run(0.5)];
  assert.deepEqual(recent(runs, NOW).map((r) => r.at), [run(5).at, run(0.5).at]);
});

test("the health block reports coverage and failures in plain words", () => {
  const lines = healthLines([run(5), run(1, { values: 1, priced: 1, sharp: 0, http: { ok: 18, failed: 3 } })], NOW).join("\n");
  assert.match(lines, /2 runs, 8 matches seen, 1 value bet\./);
  assert.match(lines, /75% of new matches priced, 25% with a price worth betting against/);
  assert.match(lines, /3 of 41 failed/);
  assert.doesNotMatch(lines, /Every run found nothing/);
  assert.match(healthLines([], NOW).join("\n"), /no run recorded in the last day/);
  assert.match(healthLines([run(2, { found: 0, fresh: 0, priced: 0, sharp: 0 })], NOW).join("\n"), /Every run found nothing/);
});

test("a long silence raises the alarm, a single quiet run does not", () => {
  const empty = (h: number) => run(h, { found: 0, fresh: 0, priced: 0, sharp: 0, shown: 0 });
  const quiet = Array.from({ length: 12 }, (_, i) => empty(12 - i));
  assert.match(watchdogAlarm(quiet, 12)!, /No match found in the last 12 runs/);
  assert.equal(watchdogAlarm(quiet.slice(-11), 12), undefined, "not enough history yet");
  assert.equal(watchdogAlarm([...quiet.slice(0, 11), run(0.1)], 12), undefined, "the last run found matches");
  // Dry runs never count, in either direction.
  assert.match(watchdogAlarm([...quiet, run(0.1, { dry: true })], 12)!, /No match found/);
});

test("a run that could not reach anything is reported straight away", () => {
  const dead = run(0.1, { found: 0, fresh: 0, priced: 0, sharp: 0, shown: 0, http: { ok: 0, failed: 21 } });
  assert.match(watchdogAlarm([run(3), dead], 12)!, /21 requests in the last run failed/);
});

test("the same warning is not repeated every two hours", () => {
  assert.equal(shouldWarn(undefined, NOW), true);
  assert.equal(shouldWarn(new Date(NOW.getTime() - 3600_000).toISOString(), NOW), false);
  assert.equal(shouldWarn(new Date(NOW.getTime() - 13 * 3600_000).toISOString(), NOW), true);
  assert.equal(shouldWarn("rubbish", NOW), true);
});
