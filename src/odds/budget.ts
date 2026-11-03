/**
 * Spreads a monthly free quota (The Odds API: 500 credits, OddsPapi: 250
 * requests) evenly over the month. Each day may spend (left − reserve) / days
 * left in the month, so a busy weekend can't burn the whole quota. When a
 * service reports the true balance, we trust that over our own count.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { DATA_DIR } from "../state.ts";

const FILE = `${DATA_DIR}/odds-budget.json`;

interface Saved { month: string; day: string; usedToday: number; remaining: number }
export interface BudgetOpts {
  monthly: number;
  reserve: number;
  /** Hold back part of each day's share for later (default on). Set false to allow all of it at any hour. */
  pace?: boolean;
}

export class OddsBudget {
  private constructor(private s: Saved, private now: Date, private opts: BudgetOpts) {}

  static load(
    now = new Date(),
    file = FILE,
    opts: BudgetOpts = { monthly: config.oddsMonthlyCredits, reserve: config.oddsReserve },
  ): OddsBudget {
    const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
    let s: Saved = { month, day, usedToday: 0, remaining: opts.monthly };
    if (existsSync(file)) {
      try {
        const old = JSON.parse(readFileSync(file, "utf8")) as Saved;
        s = {
          month,
          day,
          usedToday: old.day === day ? old.usedToday : 0,
          // New month: assume the quota reset until the service tells us otherwise.
          remaining: old.month === month ? old.remaining : opts.monthly,
        };
      } catch { /* start fresh */ }
    }
    return new OddsBudget(s, now, opts);
  }

  /** Credits allowed for the whole of today. */
  dailyAllowance(): number {
    const y = this.now.getUTCFullYear(), m = this.now.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const daysLeft = daysInMonth - this.now.getUTCDate() + 1;
    // remaining already excludes what we spent today, so add it back before dividing.
    return Math.floor(Math.max(0, this.s.remaining + this.s.usedToday - this.opts.reserve) / daysLeft);
  }

  /**
   * Share of today's allowance that may be spent by now (UTC). Early runs can't eat the whole
   * day's credits, so the busy afternoon and evening (European football, NBA) still get theirs.
   */
  paceShare(): number {
    if (this.opts.pace === false) return 1;
    const h = this.now.getUTCHours();
    return h < 6 ? 0.25 : h < 12 ? 0.45 : h < 18 ? 0.75 : 1;
  }

  canSpend(cost = 1): boolean {
    const limit = Math.ceil(this.dailyAllowance() * this.paceShare());
    return this.s.remaining - cost >= this.opts.reserve && this.s.usedToday + cost <= limit;
  }

  /** Record one call. `remainingHeader` / `lastCostHeader` come from the service (e.g. x-requests-remaining / x-requests-last). */
  record(remainingHeader: string | null | undefined, lastCostHeader: string | null | undefined, assumedCost = 1) {
    const cost = Number(lastCostHeader);
    const used = lastCostHeader != null && lastCostHeader !== "" && Number.isFinite(cost) ? cost : assumedCost;
    this.s.usedToday += used;
    const r = Number(remainingHeader);
    this.s.remaining = Number.isFinite(r) && remainingHeader != null && remainingHeader !== "" ? r : this.s.remaining - used;
  }

  summary(): string {
    return `${this.s.usedToday}/${this.dailyAllowance()} used today, ${this.s.remaining} left this month`;
  }

  save(file = FILE) {
    writeFileSync(file, JSON.stringify(this.s, null, 1));
  }
}
