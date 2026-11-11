// Stake sizing: Kelly, scaled down and capped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kelly, stakePct } from "../src/odds/stake.ts";

test("Kelly grows with the edge and is zero without one", () => {
  // Fair 50/50 offered at 2.10: edge 5%, Kelly = (0.5*2.1-1)/1.1 = 4.5%.
  assert.ok(Math.abs(kelly(0.5, 2.1) - 0.04545) < 1e-4);
  assert.ok(kelly(0.5, 2.4) > kelly(0.5, 2.1));
  assert.equal(kelly(0.5, 2.0), 0); // no edge, no bet
  assert.equal(kelly(0.5, 1.8), 0); // negative edge is never a stake
  assert.equal(kelly(0, 3), 0);
});

test("the advice is a fraction of Kelly, capped, and rounded", () => {
  const opts = { fraction: 0.25, capPct: 2 };
  assert.equal(stakePct(0.5, 2.1, opts), 1.14); // a quarter of 4.545%
  // A huge edge would be a quarter-Kelly 8.6%; the cap keeps it at 2%.
  assert.equal(stakePct(0.6, 2.4, opts), 2);
  assert.equal(stakePct(0.5, 2.0, opts), undefined);
  // KELLY_FRACTION=0 switches the advice off entirely.
  assert.equal(stakePct(0.5, 2.1, { fraction: 0, capPct: 2 }), undefined);
});
