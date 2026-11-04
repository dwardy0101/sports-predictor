/**
 * Accuracy tracker. Looks up final results for past predictions and reports:
 *  - how accurate the bookmaker odds were vs. our own stats guess (lower score is better)
 *  - profit if you had bet 1 unit on every value-bet alert (the number that matters)
 * Runs once a day from the workflow and sends a short summary to Telegram.
 */
import { config } from "./config.ts";
import { getJson, ymd } from "./http.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { competitions, competitorName } from "./sources/espn.ts";
import { buildReport } from "./report.ts";
import { appendJsonl, PREDICTIONS, readJsonl, RESULTS } from "./state.ts";
import type { Side } from "./types.ts";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

/** "home" | "away" | "draw" when finished, null if void/unknowable, undefined if not finished yet. */
async function lookup(p: any): Promise<Side | null | undefined> {
  if (p.espn?.sport === "tennis") return lookupTennis(p);
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
async function lookupTennis(p: any): Promise<Side | null | undefined> {
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
  return Date.now() - +start > 7 * 86400_000 ? null : undefined;
}

async function main() {
  const done = new Set(readJsonl(RESULTS).map((r) => r.key));
  const pending = readJsonl(PREDICTIONS).filter((p) => !done.has(p.key) && Date.now() - +new Date(p.start) > 4 * 3600_000);
  for (const p of pending) {
    const outcome = await lookup(p);
    if (outcome === undefined) continue; // not finished yet
    appendJsonl(RESULTS, { key: p.key, outcome, checkedAt: new Date().toISOString() });
  }

  const results = new Map(readJsonl(RESULTS).map((r) => [r.key, r.outcome as Side | null]));
  const summary = buildReport(readJsonl(PREDICTIONS), results);
  if (!summary) return console.log("[results] nothing graded yet");
  console.log(summary.replace(/<[^>]+>/g, ""));
  if (process.env.SEND_REPORT === "1") await sendTelegram(summary);
}

main().catch((e) => { console.error(e); process.exit(1); });
