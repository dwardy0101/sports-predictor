/**
 * Run records and the watchdog. The bot is unattended: when ESPN renames a
 * field or a league page stops answering, the pipeline finds nothing, sends
 * nothing and the job still goes green. Silence is then indistinguishable from
 * a quiet night, so every run writes down what it saw and we shout if the
 * silence goes on too long.
 */

export interface RunRow {
  at: string;
  /** Matches inside the pickup window. */
  found: number;
  /** Of those, not sent in an earlier run. */
  fresh: number;
  /** Fresh matches that got at least one bookmaker price. */
  priced: number;
  /** Fresh matches with a fair price good enough to bet against (Pinnacle or a consensus). */
  sharp: number;
  shown: number;
  values: number;
  held: number;
  http: { ok: number; failed: number };
  /** Sports this run was configured to cover. */
  sports?: string[];
  dry?: boolean;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

/** Rows from the last `hours`, newest last. Dry runs are left out: they prove nothing about the real job. */
export function recent(runs: RunRow[], now: Date, hours = 24): RunRow[] {
  const cutoff = now.getTime() - hours * 3600_000;
  return runs.filter((r) => !r.dry && new Date(r.at).getTime() > cutoff);
}

/** The health block for the daily report. */
export function healthLines(runs: RunRow[], now: Date, hours = 24): string[] {
  const rows = recent(runs, now, hours);
  if (!rows.length) return ["🩺 <b>Health:</b> no run recorded in the last day. The schedule may not be firing."];
  const sum = (f: (r: RunRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const found = sum((r) => r.found), fresh = sum((r) => r.fresh);
  const ok = sum((r) => r.http.ok), failed = sum((r) => r.http.failed);
  const L = [
    `🩺 <b>Health (last ${hours}h):</b> ${rows.length} run${rows.length > 1 ? "s" : ""}, ${found} match${found === 1 ? "" : "es"} seen, ${sum((r) => r.values)} value bet${sum((r) => r.values) === 1 ? "" : "s"}.`,
    `• Odds coverage: ${pct(sum((r) => r.priced), fresh)} of new matches priced, ${pct(sum((r) => r.sharp), fresh)} with a price worth betting against.`,
  ];
  if (failed) L.push(`• Requests: ${failed} of ${ok + failed} failed.`);
  const quiet = rows.filter((r) => r.found === 0).length;
  if (quiet === rows.length) L.push("• ⚠️ Every run found nothing. Check whether the schedule sources still work.");
  return L;
}

/**
 * A message to send right now, or nothing. Fires when the last `minRuns` real runs
 * all came up empty, or when a run could not reach anything at all.
 */
export function watchdogAlarm(runs: RunRow[], minRuns: number): string | undefined {
  const real = runs.filter((r) => !r.dry);
  const last = real[real.length - 1];
  if (!last) return undefined;
  if (last.http.ok === 0 && last.http.failed > 0) {
    return `⚠️ <b>Predictor warning</b>\nEvery one of the ${last.http.failed} requests in the last run failed, so no match could be read. The bot will keep trying.`;
  }
  const tail = real.slice(-minRuns);
  if (tail.length < minRuns || tail.some((r) => r.found > 0)) return undefined;
  const since = new Date(tail[0].at);
  return `⚠️ <b>Predictor warning</b>\nNo match found in the last ${tail.length} runs (since ${since.toISOString().slice(0, 16).replace("T", " ")} UTC). Either nothing is scheduled in the sports you follow, or a schedule source has changed and needs a look.`;
}

/** Don't repeat the same warning every two hours. */
export function shouldWarn(lastWarnIso: string | undefined, now: Date, minHours = 12): boolean {
  const t = lastWarnIso ? new Date(lastWarnIso).getTime() : NaN;
  return !(Number.isFinite(t) && now.getTime() - t < minHours * 3600_000);
}
