/**
 * The pipeline. Each run (every 2 hours):
 *  1. Collect matches starting in LEAD_MIN..LEAD_MAX minutes that we haven't sent yet.
 *  2. Attach odds from many bookmakers (The Odds API, within the daily credit budget).
 *  3. Fair chances = Pinnacle with its margin removed (or a consensus of bookmakers).
 *     The stats model is only used when there are no odds.
 *  4. Value bet = some bookmaker pays more than the fair price by MIN_EDGE_PCT or more.
 *  5. Send ONE digest of everything starting soon, plus a detailed alert per value bet
 *     (with injuries/news and the optional AI analyst).
 *  6. Log every prediction for the daily accuracy report.
 */
import { config } from "./config.ts";
import { fetchEspnContext, fetchEspnMatches } from "./sources/espn.ts";
import { fetchEsportsMatches } from "./sources/esports.ts";
import { attachOdds } from "./sources/oddsapi.ts";
import { attachPapiOdds } from "./sources/oddspapi.ts";
import { OddsBudget } from "./odds/budget.ts";
import { analyze } from "./agent/analyst.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { deliver, toMarkSent } from "./deliver.ts";
import { appendJsonl, loadSent, PREDICTIONS, saveSent } from "./state.ts";
import { predict } from "./predict.ts";
import type { Match, Prediction } from "./types.ts";

async function main() {
  const now = new Date();
  const from = new Date(now.getTime() + config.leadMinMinutes * 60_000);
  const to = new Date(now.getTime() + config.leadMaxMinutes * 60_000);
  console.log(`[run] ${now.toISOString()} kickoffs ${from.toISOString().slice(11, 16)}–${to.toISOString().slice(11, 16)} UTC, sports: ${config.sports.join(", ")}${config.dryRun ? " (dry run)" : ""}`);

  const [espn, esports] = await Promise.all([fetchEspnMatches(config.sports, from, to), fetchEsportsMatches(config.sports, from, to)]);
  const sent = loadSent();
  const fresh = [...espn, ...esports].filter((m) => !sent[m.key]);
  console.log(`[run] found ${espn.length + esports.length} matches, ${fresh.length} new`);
  if (!fresh.length) return;

  const budget = OddsBudget.load(now);
  const skipped = await attachOdds(fresh, budget);
  if (config.oddsApiKey) budget.save(); // even in a dry run: those credits were really spent

  const skippedPapi = await attachPapiOdds(fresh, now); // tennis + esports odds The Odds API doesn't have

  // Matches left unpriced only because the budget ran out are held back for the next run, if that
  // run can still see them (it starts runIntervalMinutes later and needs leadMinMinutes to spare).
  // The extra minutes cover a timer that fires a little late.
  const canWait = (m: Match) => m.start.getTime() - now.getTime() > (config.runIntervalMinutes + config.leadMinMinutes + config.holdMarginMinutes) * 60_000;
  const held = new Set([...skipped, ...skippedPapi].filter((m) => !m.odds?.books.length && canWait(m)));
  if (held.size) console.log(`[run] holding ${held.size} match(es) until the next run (odds budget used up)`);
  const ready = fresh.filter((m) => !held.has(m));
  if (!ready.length) return;

  const preds = ready.map(predict);
  const shown = preds.filter((p) => config.includeUnrated || p.fair || p.modelDataPoints > 0);
  const values = shown.filter((p) => p.value);
  console.log(`[run] ${shown.length} to show (${preds.length - shown.length} with no data skipped), ${values.length} value bet(s)`);

  const result = await deliver(shown, values, now, { send: sendTelegram, enrich });

  // If the digest failed, leave everything unsent so the next run retries it. A failed value alert only
  // keeps its own match unsent.
  if (!result.digestOk) {
    console.error("[run] digest failed; will retry next run");
    process.exitCode = 1;
    return;
  }
  if (result.failedAlerts.length) {
    console.error(`[run] ${result.failedAlerts.length} value alert(s) failed; those matches will be retried next run`);
    process.exitCode = 1;
  }
  for (const p of toMarkSent(preds, result)) {
    sent[p.match.key] = now.toISOString();
    appendJsonl(PREDICTIONS, toLog(p, shown.includes(p)));
  }
  saveSent(sent);
}

/** Context for a value-bet alert: injuries and news from ESPN, plus the optional AI notes. */
async function enrich(p: Prediction) {
  Object.assign(p.match.context, await fetchEspnContext(p.match));
  p.factors.push(...injuryFactors(p.match));
  const ai = await analyze(p);
  if (ai) {
    p.factors.unshift(...ai.key_factors);
    p.risks.push(...ai.risks);
    p.confidence = ai.confidence;
    p.aiUsed = true;
  }
  p.factors = [...new Set(p.factors)];
}

function injuryFactors(m: Match): string[] {
  const inj = (m.context.injuries as { team?: string; out?: string[] }[] | undefined) ?? [];
  return inj.filter((t) => t?.out?.length).map((t) => `${t.team} injuries: ${t.out!.slice(0, 3).join(", ")}`);
}

function toLog(p: Prediction, shown: boolean) {
  const m = p.match;
  return {
    key: m.key, sport: m.sport, league: m.league, start: m.start.toISOString(), loggedAt: new Date().toISOString(),
    home: m.home.name, away: m.away.name, hasDraw: m.hasDraw,
    model: p.model, modelDataPoints: p.modelDataPoints, fair: p.fair?.probs, fairSource: p.fair?.kind,
    best: p.best, value: p.value, shown, espn: m.espn,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
