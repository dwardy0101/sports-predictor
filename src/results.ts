/**
 * Accuracy tracker. Looks up final results for past predictions and reports:
 *  - how accurate the bookmaker odds were vs. our own stats guess (lower score is better)
 *  - profit if you had bet 1 unit on every value-bet alert (the number that matters)
 *  - whether the bets beat the sharp closing price (the number that means something sooner)
 *  - a health block, so a bot that has gone quiet says so
 * Runs once a day from the workflow and sends a short summary to Telegram.
 * It also keeps the log bounded: predictions older than KEEP_DAYS move to a
 * monthly archive file and their numbers are folded into data/totals.json.
 */
import { pathToFileURL } from "node:url";
import { config } from "./config.ts";
import { getJson, pool, ymd } from "./http.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { competitions, competitorName } from "./sources/espn.ts";
import { buildReport, givenUp, shouldSendReport } from "./report.ts";
import { addToTotals, EMPTY_TOTALS, splitOld, type Totals } from "./archive.ts";
import type { ClvRow } from "./clv.ts";
import type { RunRow } from "./health.ts";
import {
  appendJsonl, archive, CLV, DATA_DIR, PREDICTIONS, readJson, readJsonl, RESULTS, RUNS, TOTALS, writeJson, writeJsonl,
} from "./state.ts";
import type { Side } from "./types.ts";

const REPORT_STATE = `${DATA_DIR}/report-state.json`;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

/** "home" | "away" | "draw" when finished, null if void/unknowable, undefined if not finished yet. */
export async function lookup(p: any, now = new Date()): Promise<Side | null | undefined> {
  if (p.espn?.sport === "tennis") return lookupTennis(p, now);
  if (p.espn) {
    const s = await getJson(`${ESPN}/${p.espn.sport}/${p.espn.league}/summary?event=${p.espn.eventId}`);
    const c = s?.header?.competitions?.[0];
    if (!c?.status?.type?.completed) return undefined;
    const h = c.competitors?.find((x: any) => x.homeAway === "home");
    const a = c.competitors?.find((x: any) => x.homeAway === "away");
    if (h?.winner) return "home";
    if (a?.winner) return "away";
    return Number(h?.score) === Number(a?.score) ? "draw" : null;
  }
  const ps = /^ps:(\w+):(\d+)$/.exec(p.key);
  if (ps && config.pandascoreToken) {
    const m = await getJson(`https://api.pandascore.co/matches/${ps[2]}`, { headers: { Authorization: `Bearer ${config.pandascoreToken}` } });
    if (m?.status === "canceled") return null;
    if (m?.status !== "finished" || !m?.winner_id) return undefined;
    return m.winner_id === m.opponents?.[0]?.opponent?.id ? "home" : "away";
  }
  return null;
}

/** Tennis has no summary page: find the match on the scoreboard of its day (± 1 for time zones). */
export async function lookupTennis(p: any, now = new Date()): Promise<Side | null | undefined> {
  const start = new Date(p.start);
  for (const off of [0, -1, 1]) {
    const day = ymd(new Date(start.getTime() + off * 86400_000));
    const data = await getJson(`${ESPN}/tennis/${p.espn.league}/scoreboard?dates=${day}&limit=300`);
    const hit = competitions(data).find(({ comp }) => String(comp?.id) === p.espn.compId);
    if (!hit) continue;
    if (!hit.comp?.status?.type?.completed) return undefined;
    const winner = (hit.comp.competitors ?? []).find((c: any) => c.winner);
    if (!winner) return null; // walkover / retirement without a winner flag
    const name = competitorName(winner);
    return name === p.home ? "home" : name === p.away ? "away" : null;
  }
  // Give up after a week.
  return givenUp(p.start, now) ? null : undefined;
}

/**
 * Move predictions older than KEEP_DAYS into a monthly archive, keeping their
 * numbers in totals.json, and trim the files the report reads every day.
 */
export function rotateLogs(now: Date, results: Map<string, Side | null>) {
  const rows = readJsonl(PREDICTIONS);
  let clv = readJsonl<ClvRow>(CLV);
  let totals = readJson<Totals>(TOTALS, EMPTY_TOTALS);
  const { keep, old } = splitOld(rows, now, config.keepDays);

  if (old.length) {
    totals = addToTotals(totals, old, results, clv);
    const byMonth = new Map<string, unknown[]>();
    for (const r of old) {
      const month = String(r.start ?? "").slice(0, 7) || "undated";
      byMonth.set(month, [...(byMonth.get(month) ?? []), r]);
    }
    for (const [month, rs] of byMonth) archive(`predictions-${month}`, rs);
    const live = new Set(keep.map((r) => r.key));
    clv = clv.filter((r) => live.has(r.key));
    writeJsonl(PREDICTIONS, keep);
    writeJsonl(RESULTS, readJsonl(RESULTS).filter((r) => live.has(r.key)));
    writeJsonl(CLV, clv);
    writeJson(TOTALS, totals);
    console.log(`[results] archived ${old.length} prediction(s) older than ${config.keepDays} days`);
  }

  // Run records are only read for the last day or so; keep a few weeks of them.
  const runs = readJsonl<RunRow>(RUNS);
  if (runs.length > 500) writeJsonl(RUNS, runs.slice(-500));

  return { rows: keep, clv, runs: runs.slice(-500), totals };
}

async function main() {
  const now = new Date();
  const done = new Set(readJsonl(RESULTS).map((r) => r.key));
  const pending = readJsonl(PREDICTIONS).filter((p) => !done.has(p.key) && now.getTime() - +new Date(p.start) > 4 * 3600_000);
  const graded = await pool(pending, config.fetchConcurrency, async (p) => ({ p, outcome: await lookup(p, now) }));
  for (const { p, outcome } of graded) {
    if (outcome === undefined) {
      // Not finished yet. A postponed or abandoned match never will be: give up after a week.
      if (givenUp(p.start, now)) appendJsonl(RESULTS, { key: p.key, outcome: null, checkedAt: now.toISOString() });
      continue;
    }
    appendJsonl(RESULTS, { key: p.key, outcome, checkedAt: now.toISOString() });
  }

  const results = new Map(readJsonl(RESULTS).map((r) => [r.key, r.outcome as Side | null]));
  const { rows, clv, runs, totals } = rotateLogs(now, results);
  const summary = buildReport(rows, results, { now, clv, runs, totals });
  if (!summary) return console.log("[results] nothing graded yet");
  console.log(summary.replace(/<[^>]+>/g, ""));
  if (process.env.SEND_REPORT !== "1") return;
  const last = readJson<{ sentAt?: string }>(REPORT_STATE, {}).sentAt;
  if (!shouldSendReport(last, now)) return console.log("[results] a report went out in the last few hours; skipping");
  if ((await sendTelegram(summary)) && !config.dryRun) writeJson(REPORT_STATE, { sentAt: now.toISOString() });
}

/** Only grade and send when this file is the program, so tests can import the lookups. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
