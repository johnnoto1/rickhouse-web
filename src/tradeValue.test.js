// Sanity checks for the bottle value transform.
// Run with: node src/tradeValue.test.js
//
// Uses hypothetical production ELOs — local-dev bottles are all 1500 (no
// rounds played yet), so these test transform math, not live DB values.
import assert from "node:assert/strict";
import { ELO_FLOOR, bottleValue, tradePct, tradeVerdict, resolvePrice } from "./tradeValue.js";

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

// ---- tradeVerdict: price-primary, ELO as a bounded/attenuated tiebreaker ----
// Observed values documented alongside each assertion so a future change to
// the constants shows its blast radius immediately, not just a red assert.

// a. C923 ($150 secondary) vs Pappy Van Winkle 20 ($1,450 secondary) — the
//    motivating regression. Under the old convex-ELO verdict this read as a
//    mere "22% slight edge"; price alone puts the gap at ~90%, and the price
//    gap is so large ELO's (capped, attenuated) influence is fully zeroed —
//    it must land in the strongest band, favoring whoever receives C923.
{
  const v = tradeVerdict(
    [{ elo: 1750, price: 1450 }], // you send: Pappy 20
    [{ elo: 1800, price: 150 }]   // you receive: C923
  );
  assert.equal(v.tier, 3, "a $1,300 gap on a $1,450 bottle must hit the top band");
  assert.equal(v.favors, "them", "giving up the $1,450 bottle for the $150 one favors them");
  assert.equal(v.eloAdjust, 0, "price gap this large (~90%) fully zeroes ELO's influence");
  assert.ok(Math.abs(v.priceDiff + 1300) < 0.01, `priceDiff should be -$1,300 (got ${v.priceDiff})`);
  console.log(`  a. C923 vs Pappy 20: tier ${v.tier}, favors ${v.favors}, ${v.pct.toFixed(1)}%, priceDiff ${v.priceDiff}`);
}

// b. Two bottles within ~10% on price (full ELO attenuation zone), but a
//    real ELO gap between them. Price alone is only a "Fair trade" (tier 1,
//    ≤15%); the capped +10-point ELO nudge pushes it into "Slight edge"
//    (tier 2) — a genuine band change, so the UI's crowd-preference note
//    must be eligible to render.
{
  const v = tradeVerdict(
    [{ elo: 1500, price: 500 }],
    [{ elo: 1750, price: 545 }]
  );
  assert.equal(v.tier, 2, "ELO's tiebreak should push this from Fair trade into Slight edge");
  assert.equal(v.favors, "you");
  assert.equal(v.eloAdjust, 10, "price gap (~8%) is inside the full-effect zone (≤15%) — no attenuation");
  assert.equal(v.crowdBrokeTheTie, true, "band changed vs. price alone — note must render");
  console.log(`  b. tie-break: tier ${v.tier}, favors ${v.favors}, eloAdjust ${v.eloAdjust}, brokeTie ${v.crowdBrokeTheTie}`);
}

// c. Same two prices as (b), but the ELO gap is reversed (swap which
//    bottle has the higher rating). If the tiebreak were decorative, this
//    would have no effect; it must actually flip who the verdict favors —
//    proof the ELO signal is live, not cosmetic.
{
  const v = tradeVerdict(
    [{ elo: 1750, price: 500 }],
    [{ elo: 1500, price: 545 }]
  );
  assert.equal(v.favors, "them", "reversing the ELO gap must flip who the verdict favors");
  assert.equal(v.eloAdjust, -10);
  assert.equal(v.crowdBrokeTheTie, true);
  console.log(`  c. reversed: tier ${v.tier}, favors ${v.favors}, eloAdjust ${v.eloAdjust}`);
}

// d. An exact 2x price gap (the documented zero-effect boundary) with a
//    huge ELO gap pointing the OPPOSITE way from price. Price must still
//    win outright — ELO's influence should be fully attenuated to zero at
//    this boundary, so no crowd note, no band change.
{
  const v = tradeVerdict(
    [{ elo: 1900, price: 500 }],  // you send: much higher ELO
    [{ elo: 1500, price: 1000 }]  // you receive: double the price, lower ELO
  );
  assert.equal(v.pct, 50, "exact 2x price gap is exactly the 50%-of-larger-side boundary");
  assert.equal(v.eloAdjust, 0, "at the 2x boundary, attenuation must be exactly zero");
  assert.equal(v.favors, "you", "price alone (2x gap) determines the verdict");
  assert.equal(v.crowdBrokeTheTie, false, "no band change → no crowd note");
  console.log(`  d. 2x gap vs opposing ELO: tier ${v.tier}, favors ${v.favors}, eloAdjust ${v.eloAdjust}`);
}

// e. A child bottle with no secondary_value of its own, whose parent DOES
//    have one, must price at the parent's inherited "LINE PRICE" value in
//    the verdict math — not its own MSRP, and not null. Exercises the same
//    resolvePrice chain the trade calculator itself calls before feeding
//    tradeVerdict, proving the two are wired together correctly.
{
  const child = { secondary_value: null, msrp_usd: 80 };
  const parent = { secondary_value: 300 };
  const resolved = resolvePrice(child, parent);
  assert.equal(resolved.price, 300, "child must inherit the parent's secondary_value");
  assert.equal(resolved.tag, "LINE PRICE");
  const v = tradeVerdict(
    [{ elo: 1500, price: 200 }],
    [{ elo: 1500, price: resolved.price }]
  );
  assert.equal(v.priceB, 300, "the verdict must use the inherited $300, not the child's own $80 MSRP");
  console.log(`  e. LINE PRICE child inherits $${resolved.price} into the verdict (not its own $80 MSRP)`);
}

// Degenerate cases: empty side → no verdict; a side with an unpriceable
// bottle → no verdict (same "must be fully priced" guard the calculator
// already applied before tradeVerdict existed).
assert.equal(tradeVerdict([], [{ elo: 1500, price: 100 }]), null, "empty side must yield no verdict");
assert.equal(tradeVerdict([{ elo: 1500, price: 100 }], []), null, "empty side must yield no verdict");
assert.equal(
  tradeVerdict([{ elo: 1500, price: null }], [{ elo: 1500, price: 100 }]),
  null,
  "an unpriceable bottle must yield no verdict"
);

console.log("✓ All tradeVerdict fixtures passed");
