/**
 * The pipeline. Each run (every 2 hours):
 *  1. Collect matches starting in LEAD_MIN..LEAD_MAX minutes that we haven't sent yet.
 *  2. Attach odds from many bookmakers (The Odds API, within the daily credit budget).
 *  3. Fair chances = Pinnacle with its margin removed (or a consensus of bookmakers).
 *     The stats model is only used when there are no odds.
 *  4. Value bet = some bookmaker pays more than the fair price by MIN_EDGE_PCT or more.
 *  5. Send ONE digest of everything starting soon, plus a detailed alert per value bet
 *     (with injuries/news and the optional AI analyst).
 *  6. Log every prediction for the daily accuracy report, write down what this run saw
 *     (so a broken feed can't hide as a quiet night), and take a free later snapshot of
 *     the sharp price for bets already sent (closing line value).
 */
import { pathToFileURL } from "node:url";
import { config, reportConfig } from "./config.ts";
import { fetchEspnContext, fetchEspnMatches } from "./sources/espn.ts";
import { fetchEsportsMatches } from "./sources/esports.ts";
import { attachOdds } from "./sources/oddsapi.ts";
import { attachPapiOdds } from "./sources/oddspapi.ts";
import { OddsBudget } from "./odds/budget.ts";
import { fairProbs } from "./odds/fair.ts";
import { analyze } from "./agent/analyst.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { deliver, toMarkSent } from "./deliver.ts";
import { httpStats } from "./http.ts";
import { snapshot } from "./clv.ts";
import { shouldWarn, watchdogAlarm, type RunRow } from "./health.ts";
import { appendJsonl, CLV, PREDICTIONS, RUNS, DATA_DIR, loadSent, readJson, readJsonl, saveSent, writeJson } from "./state.ts";
import { predict } from "./predict.ts";
import type { Match, Prediction, Side } from "./types.ts";

const WATCHDOG = `${DATA_DIR}/watchdog.json`;

/** What this run saw, written to runs.jsonl whatever happens. */
type Counts = Pick<RunRow, "found" | "fresh" | "priced" | "sharp" | "shown" | "values" | "held">;

async function main() {
  const now = new Date();
  reportConfig();
  const counts: Counts = { found: 0, fresh: 0, priced: 0, sharp: 0, shown: 0, values: 0, held: 0 };
  try {
    await run(now, counts);
  } finally {
    await finishRun(now, counts);
  }
}

async function run(now: Date, counts: Counts) {
  const from = new Date(now.getTime() + config.leadMinMinutes * 60_000);
  const to = new Date(now.getTime() + config.leadMaxMinutes * 60_000);
  console.log(`[run] ${now.toISOString()} kickoffs ${from.toISOString().slice(11, 16)}–${to.toISOString().slice(11, 16)} UTC, sports: ${config.sports.join(", ")}${config.dryRun ? " (dry run)" : ""}`);

  const [espn, esports] = await Promise.all([fetchEspnMatches(config.sports, from, to), fetchEsportsMatches(config.sports, from, to)]);
  const sent = loadSent();
  const fresh = [...espn, ...esports].filter((m) => !sent[m.key]);
  counts.found = espn.length + esports.length;
  counts.fresh = fresh.length;
  console.log(`[run] found ${counts.found} matches, ${fresh.length} new`);

  // Bets already alerted on whose match hasn't started: they ride along free on the
  // odds calls below, giving a later sharp price to compare the bet against.
  const watch = config.trackClv ? openBets(now) : [];
  if (watch.length) console.log(`[clv] watching ${watch.length} open bet(s) for a later sharp price`);
  if (!fresh.length && !watch.length) return;

  const budget = OddsBudget.load(now);
  const skipped = await attachOdds(fresh, budget, watch.map((w) => w.match));
  if (config.oddsApiKey) budget.save(); // even in a dry run: those credits were really spent
  recordClv(watch, now);
  if (!fresh.length) return;

  const skippedPapi = await attachPapiOdds(fresh, now); // tennis + esports odds The Odds API doesn't have
  counts.priced = fresh.filter((m) => m.odds?.books.length).length;

  // Matches left unpriced only because the budget ran out are held back for the next run, if that
  // run can still see them (it starts runIntervalMinutes later and needs leadMinMinutes to spare).
  // The extra minutes cover a timer that fires a little late.
  const canWait = (m: Match) => m.start.getTime() - now.getTime() > (config.runIntervalMinutes + config.leadMinMinutes + config.holdMarginMinutes) * 60_000;
  const held = new Set([...skipped, ...skippedPapi].filter((m) => !m.odds?.books.length && canWait(m)));
  counts.held = held.size;
  if (held.size) console.log(`[run] holding ${held.size} match(es) until the next run (odds budget used up)`);
  const ready = fresh.filter((m) => !held.has(m));
  if (!ready.length) return;

  const preds = ready.map((m) => predict(m, now));
  const shown = preds.filter((p) => config.includeUnrated || p.fair || p.modelDataPoints > 0);
  const values = shown.filter((p) => p.value);
  counts.sharp = preds.filter((p) => p.fair && p.fair.kind !== "single" && !p.fair.stale).length;
  counts.shown = shown.length;
  counts.values = values.length;
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

/** Record the run and, if the bot has been silent for too long, say so on Telegram. */
async function finishRun(now: Date, counts: Counts) {
  const row: RunRow = {
    at: now.toISOString(), ...counts,
    http: { ok: httpStats.ok, failed: httpStats.failed },
    sports: config.sports,
    ...(config.dryRun ? { dry: true } : {}),
  };
  console.log(`[run] ${JSON.stringify(row)}`);
  appendJsonl(RUNS, row);
  if (config.dryRun) return;

  // The row above is already in the file; fall back to it if the write was skipped.
  const history = readJsonl<RunRow>(RUNS);
  const alarm = watchdogAlarm(history.length ? history : [row], config.watchdogRuns);
  if (!alarm) return;
  const last = readJson<{ at?: string }>(WATCHDOG, {});
  if (!shouldWarn(last.at, now)) return;
  if (await sendTelegram(alarm)) writeJson(WATCHDOG, { at: now.toISOString() });
}

/** A bet we have already sent an alert for, whose match hasn't started yet. */
interface OpenBet { match: Match; bet: { key: string; side: Side; price: number; start: string } }

/**
 * Rebuilt from the prediction log, so no state is duplicated. Only matches with ESPN
 * ids can ride along on an odds call, which is also the only place a later sharp price
 * can come from for free.
 */
export function openBets(now: Date, rows = readJsonl(PREDICTIONS)): OpenBet[] {
  const out: OpenBet[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const start = new Date(r.start);
    if (!r.value || !r.espn || seen.has(r.key) || isNaN(start.getTime())) continue;
    // Still ahead of us, and close enough that the odds call for its sport covers it.
    const mins = (start.getTime() - now.getTime()) / 60_000;
    if (mins <= 0 || mins > config.leadMaxMinutes) continue;
    seen.add(r.key);
    out.push({
      bet: { key: r.key, side: r.value.side, price: r.value.price, start: start.toISOString() },
      match: {
        key: r.key, sport: r.sport, league: r.league ?? "", start, home: { name: r.home }, away: { name: r.away },
        hasDraw: !!r.hasDraw, neutral: false, tournament: r.tournament, context: {}, espn: r.espn,
      },
    });
  }
  return out;
}

/** Log how the sharp price looks now for bets we have already sent. */
function recordClv(watch: OpenBet[], now: Date) {
  for (const w of watch) {
    if (!w.match.odds?.books.length) continue;
    const fair = fairProbs(w.match.odds, w.match.hasDraw, { now, maxAgeMinutes: config.maxOddsAgeMinutes });
    const row = fair && snapshot(w.bet, fair, now);
    if (!row) continue;
    appendJsonl(CLV, row);
    console.log(`[clv] ${w.match.home.name} vs ${w.match.away.name}: took ${row.betPrice.toFixed(2)}, fair now ${row.fairPrice.toFixed(2)} (${row.minsToStart}m to start)`);
  }
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
    home: m.home.name, away: m.away.name, hasDraw: m.hasDraw, tournament: m.tournament,
    model: p.model, modelDataPoints: p.modelDataPoints, fair: p.fair?.probs, fairSource: p.fair?.kind,
    best: p.best, value: p.value, shown, espn: m.espn,
  };
}

/** Only run the pipeline when this file is the program, so tests can import the helpers. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
