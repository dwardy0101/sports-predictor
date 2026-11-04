/** Sending the digest and the value alerts, and working out which matches count as delivered. */
import { config } from "./config.ts";
import { formatAlert, formatDigest } from "./notify/telegram.ts";
import type { Prediction } from "./types.ts";

export interface DeliverDeps {
  send: (html: string) => Promise<boolean>;
  /** Adds injuries, news and AI notes to a value bet before its alert is written. */
  enrich: (p: Prediction) => Promise<void>;
}

export interface Delivered {
  /** False if any digest message failed: nothing is marked as sent, so the next run retries. */
  digestOk: boolean;
  /** Value alerts that failed. Those matches stay unsent and are tried again next run. */
  failedAlerts: Prediction[];
}

export async function deliver(shown: Prediction[], values: Prediction[], now: Date, deps: DeliverDeps, digest = config.digest): Promise<Delivered> {
  let digestOk = true;
  if (digest) for (const msg of formatDigest(shown)) digestOk = (await deps.send(msg)) && digestOk;
  const failedAlerts: Prediction[] = [];
  for (const p of values) {
    await deps.enrich(p);
    if (!(await deps.send(formatAlert(p, now)))) failedAlerts.push(p);
  }
  return { digestOk, failedAlerts };
}

/** Predictions to mark as sent (and log) after a delivery; none if the digest failed. */
export function toMarkSent(preds: Prediction[], d: Delivered): Prediction[] {
  return d.digestOk ? preds.filter((p) => !d.failedAlerts.includes(p)) : [];
}
