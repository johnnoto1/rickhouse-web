// Sanity checks for the bottle value transform.
// Run with: node src/tradeValue.test.js
//
// Uses hypothetical production ELOs — local-dev bottles are all 1500 (no
// rounds played yet), so these test transform math, not live DB values.
import assert from "node:assert/strict";
import { ELO_FLOOR, bottleValue, tradePct } from "./tradeValue.js";

const ELO = {
  GTS:     1800, // George T. Stagg — elite BTAC
  ECSmall: 1480, // Elijah Craig Small Batch — solid everyday
  ER10:    1510, // Eagle Rare 10 Year — popular allocated-shelf
  Blantons: 1630, // Blanton's Original — mid-tier allocated
};

// 1. GTS alone beats 2× EC Small Batch.
//    A single elite bottle must outweigh two above-average ones.
const gts  = bottleValue(ELO.GTS);
const ec2x = 2 * bottleValue(ELO.ECSmall);
assert.ok(gts > ec2x,
  `GTS (${gts.toFixed(1)} pts) must beat 2× EC Small Batch (${ec2x.toFixed(1)} pts)`);

// 2. 2× ER10 vs Blanton's stays within fair-trade range (≤25% gap).
//    Similar-tier trade should feel balanced, not a blowout.
const er2x     = 2 * bottleValue(ELO.ER10);
const blantons = bottleValue(ELO.Blantons);
const pct      = tradePct(er2x, blantons);
assert.ok(pct <= 25,
  `2× ER10 vs Blanton's should be ≤25% apart (got ${pct.toFixed(1)}%)`);

// 3. ELO floor: bottles at or below 1200 contribute zero value.
assert.equal(bottleValue(ELO_FLOOR), 0);
assert.equal(bottleValue(ELO_FLOOR - 100), 0);
assert.ok(bottleValue(ELO_FLOOR + 1) > 0, "just above floor must be positive");

console.log("✓ All sanity checks passed");
console.log(`  GTS: ${gts.toFixed(1)} pts  vs  2× EC Small Batch: ${ec2x.toFixed(1)} pts`);
console.log(`  2× ER10: ${er2x.toFixed(1)} pts  vs  Blanton's: ${blantons.toFixed(1)} pts  (${pct.toFixed(1)}% diff)`);
