// Settings are checked at startup: a typo used to look exactly like a quiet night.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SPORTS = "nba, quidditch ,NBA";
process.env.MIN_EDGE_PCT = "not a number";
process.env.TIMEZONE = "Mars/Olympus";
process.env.LEAD_MIN_MINUTES = "20";
process.env.LEAD_MAX_MINUTES = "10"; // below the minimum: impossible
process.env.KELLY_FRACTION = "3"; // more than full Kelly
process.env.BOOKMAKERS = "";

const { config, configWarnings, reportConfig, SPORT_GROUPS } = await import("../src/config.ts");

test("unknown sports are dropped, not silently obeyed", () => {
  assert.deepEqual(config.sports, ["nba"]);
  assert.ok(configWarnings.some((w) => /quidditch/.test(w)), configWarnings.join("; "));
  assert.ok(SPORT_GROUPS.includes("tennis"));
});

test("a nonsense number or timezone falls back to the default and says so", () => {
  assert.equal(config.minEdgePct, 3);
  assert.equal(config.timezone, "Asia/Manila");
  assert.equal(config.kellyFraction, 0.25);
  assert.ok(configWarnings.some((w) => /MIN_EDGE_PCT/.test(w)));
  assert.ok(configWarnings.some((w) => /TIMEZONE/.test(w)));
  assert.ok(configWarnings.some((w) => /KELLY_FRACTION/.test(w)));
});

test("a pickup window that cannot work is repaired", () => {
  assert.equal(config.leadMinMinutes, 20);
  assert.equal(config.leadMaxMinutes, 140);
  assert.ok(configWarnings.some((w) => /LEAD_MAX_MINUTES/.test(w)));
});

test("the advice printed at startup covers the settings that silently cost money", () => {
  const lines: string[] = [];
  reportConfig((s) => lines.push(s));
  assert.ok(lines.some((l) => /BOOKMAKERS is not set/.test(l)));
  assert.ok(lines.some((l) => /quidditch/.test(l)));
  assert.equal(lines.filter((l) => /pickup window/.test(l)).length, 1); // 20–140 is narrower than the 120 min interval
});

test("the defaults that matter are what the README promises", () => {
  assert.equal(config.minEdgeConsensusPct, 6);
  assert.equal(config.maxOddsAgeMinutes, 30);
  assert.equal(config.maxStakePct, 2);
  assert.equal(config.keepDays, 120);
  assert.equal(config.trackClv, true);
  assert.equal(config.watchdogRuns, 12);
});
