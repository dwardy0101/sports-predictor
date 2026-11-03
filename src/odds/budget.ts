/**
 * Spreads The Odds API free quota (500 credits/month) evenly over the month.
 * Each day may spend (credits left − reserve) / days left in the month, so a
 * busy weekend can't burn the whole quota. The API reports the true balance
 * in a response header after every call; we trust that over our own count.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { DATA_DIR } from "../state.ts";

const FILE = `${DATA_DIR}/odds-budget.json`;

interface Saved { month: string; day: string; usedToday: number; remaining: number }

export class OddsBudget {
  private constructor(private s: Saved, private now: Date) {}

  static load(now = new Date(), file = FILE): OddsBudget {
    const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
    let s: Saved = { month, day, usedToday: 0, remaining: config.oddsMonthlyCredits };
    if (existsSync(file)) {
      try {
        const old = JSON.parse(readFileSync(file, "utf8")) as Saved;
        s = {
          month,
          day,
          usedToday: old.day === day ? old.usedToday : 0,
          // New month: assume the quota reset until the API tells us otherwise.
          remaining: old.month === month ? old.remaining : config.oddsMonthlyCredits,
        };
      } catch { /* start fresh */ }
    }
    return new OddsBudget(s, now);
  }

  /** Credits allowed for the whole of today. */
  dailyAllowance(): number {
    const y = this.now.getUTCFullYear(), m = this.now.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const daysLeft = daysInMonth - this.now.getUTCDate() + 1;
    // remaining already excludes what we spent today, so add it back before dividing.
    return Math.floor(Math.max(0, this.s.remaining + this.s.usedToday - config.oddsReserve) / daysLeft);
  }

  canSpend(cost = 1): boolean {
    return this.s.remaining - cost >= config.oddsReserve && this.s.usedToday + cost <= this.dailyAllowance();
  }

  /** Record one call. `remainingHeader` / `lastCostHeader` come from x-requests-remaining / x-requests-last. */
  record(remainingHeader: string | null | undefined, lastCostHeader: string | null | undefined, assumedCost = 1) {
    const cost = Number(lastCostHeader);
    const used = Number.isFinite(cost) ? cost : assumedCost;
    this.s.usedToday += used;
    const r = Number(remainingHeader);
    this.s.remaining = Number.isFinite(r) && remainingHeader != null && remainingHeader !== "" ? r : this.s.remaining - used;
  }

  summary(): string {
    return `${this.s.usedToday}/${this.dailyAllowance()} credits used today, ${this.s.remaining} left this month`;
  }

  save(file = FILE) {
    writeFileSync(file, JSON.stringify(this.s, null, 1));
  }
}
