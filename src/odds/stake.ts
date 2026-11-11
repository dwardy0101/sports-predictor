/**
 * How much to bet. Expected value says whether a bet is worth taking; it says
 * nothing about size, and sizing is where bankrolls are actually lost.
 *
 * Kelly gives the stake that maximises long-run growth: f = (p·odds − 1) / (odds − 1).
 * Full Kelly is far too aggressive in practice, because our p is an estimate with
 * error in it, so the advice is a fraction of Kelly (a quarter by default) and
 * capped at a small share of the bankroll.
 */

/** Full Kelly stake as a fraction of bankroll. 0 when the bet has no edge. */
export function kelly(prob: number, price: number): number {
  if (!(prob > 0) || !(price > 1)) return 0;
  return Math.max(0, (prob * price - 1) / (price - 1));
}

export interface StakeOpts {
  /** Fraction of full Kelly to advise (0.25 = quarter Kelly). 0 switches stake advice off. */
  fraction: number;
  /** Hard cap as a percentage of bankroll. */
  capPct: number;
}

/** Advised stake as a percentage of bankroll, or undefined when there is nothing to advise. */
export function stakePct(prob: number, price: number, opts: StakeOpts): number | undefined {
  if (!(opts.fraction > 0)) return undefined;
  const pct = kelly(prob, price) * opts.fraction * 100;
  if (!(pct > 0)) return undefined;
  return Math.round(Math.min(pct, opts.capPct) * 100) / 100;
}
