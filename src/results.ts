/**
 * Accuracy tracker. Looks up final results for past predictions and reports:
 *  - Brier score of the fair market odds vs. our stats model (0 = perfect, lower is better)
 *  - profit if you had bet 1 unit on every value-bet alert (the number that matters)
 * Runs once a day from the workflow and sends a short summary to Telegram.
 */
import { config } from "./config.ts";
import { getJson, ymd } from "./http.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { competitions, competitorName } from "./sources/espn.ts";
import { appendJsonl, PREDICTIONS, readJsonl, RESULTS } from "./state.ts";
import type { Probabilities, Side } from "./types.ts";

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

const brier = (pr: Probabilities, o: Side) =>
  (["home", "away", "draw"] as Side[]).reduce((s, k) => s + ((pr[k] ?? 0) - (k === o ? 1 : 0)) ** 2, 0);

async function main() {
  const done = new Set(readJsonl(RESULTS).map((r) => r.key));
  const pending = readJsonl(PREDICTIONS).filter((p) => !done.has(p.key) && Date.now() - +new Date(p.start) > 4 * 3600_000);
  for (const p of pending) {
    const outcome = await lookup(p);
    if (outcome === undefined) continue; // not finished yet
    appendJsonl(RESULTS, { key: p.key, outcome, checkedAt: new Date().toISOString() });
  }

  const results = new Map(readJsonl(RESULTS).map((r) => [r.key, r.outcome as Side | null]));
  const rows = readJsonl(PREDICTIONS).filter((p) => results.get(p.key));
  if (!rows.length) return console.log("[results] nothing graded yet");

  let nFair = 0, bFair = 0, bModelSame = 0, nModel = 0, bModel = 0, bets = 0, returned = 0;
  for (const p of rows) {
    const o = results.get(p.key)!;
    if (p.fair) {
      nFair++;
      bFair += brier(p.fair, o);
      bModelSame += brier(p.model, o);
    }
    if (p.modelDataPoints > 0) { nModel++; bModel += brier(p.model, o); }
    if (p.value) { bets++; if (p.value.side === o) returned += p.value.price; }
  }
  const f = (x: number) => x.toFixed(3);
  const summary = [
    `📈 <b>Accuracy report</b> (${rows.length} graded matches)`,
    nFair ? `Brier on ${nFair} matches with odds (lower is better): market ${f(bFair / nFair)} · our stats model ${f(bModelSame / nFair)}` : `No graded matches with odds yet`,
    nModel ? `Stats model on all ${nModel} matches it rated: ${f(bModel / nModel)}` : "",
    bets
      ? `💎 Value bets: ${bets}, profit ${(returned - bets).toFixed(2)} units (ROI ${(((returned - bets) / bets) * 100).toFixed(1)}%)` +
        (bets < 200 ? `\n<i>Under ~200 bets this is mostly luck; judge it over months.</i>` : "")
      : `💎 Value bets: none graded yet`,
  ].filter(Boolean).join("\n");
  console.log(summary.replace(/<[^>]+>/g, ""));
  if (process.env.SEND_REPORT === "1") await sendTelegram(summary);
}

main().catch((e) => { console.error(e); process.exit(1); });
