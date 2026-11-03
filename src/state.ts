/**
 * Tiny file-based state. GitHub Actions has no memory between runs, so the
 * workflow keeps data/ on a separate `bot-data` branch and pushes it after
 * each run. In a dry run nothing is written (except the odds budget, because
 * those credits were really spent).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";

export const DATA_DIR = process.env.DATA_DIR || "data";
const SENT = `${DATA_DIR}/sent.json`;
export const PREDICTIONS = `${DATA_DIR}/predictions.jsonl`;
export const RESULTS = `${DATA_DIR}/results.jsonl`;

mkdirSync(DATA_DIR, { recursive: true });

export function loadSent(): Record<string, string> {
  if (!existsSync(SENT)) return {};
  try {
    const all = JSON.parse(readFileSync(SENT, "utf8")) as Record<string, string>;
    const cutoff = Date.now() - 4 * 86400_000; // forget after 4 days
    return Object.fromEntries(Object.entries(all).filter(([, t]) => new Date(t).getTime() > cutoff));
  } catch {
    return {};
  }
}

export function saveSent(sent: Record<string, string>) {
  if (config.dryRun) return;
  writeFileSync(SENT, JSON.stringify(sent, null, 1));
}

export function appendJsonl(file: string, row: unknown) {
  if (config.dryRun) return;
  appendFileSync(file, JSON.stringify(row) + "\n");
}

export function readJsonl<T = any>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}
