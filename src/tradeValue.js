// Convex value transform for trade comparison.
//
// Raw ELO summing lets several average bottles outweigh one elite bottle.
// The power-law lifts each ELO point above 1200 non-linearly, so prestige
// bottles can't simply be matched by volume.
//
//   ELO 1500 → ~15.6 pts   ELO 1700 → ~57.2 pts   ELO 1900 → ~129.6 pts

export const ELO_FLOOR = 1200;
export const VALUE_EXPONENT = 2.5;

export function bottleValue(elo) {
  const x = (elo - ELO_FLOOR) / 100;
  return x > 0 ? Math.pow(x, VALUE_EXPONENT) : 0;
}

// % difference of the smaller side relative to the larger (0–100).
export function tradePct(valueA, valueB) {
  const max = Math.max(valueA, valueB);
  return max > 0 ? (Math.abs(valueB - valueA) / max) * 100 : 0;
}

// ---- Leaderboard "VALUE" column: convex trade value per dollar ----
// Shared by the leaderboard and the bottle profile page so the displayed
// number can never drift between the two — both call this, not a
// reimplementation of the formula.

// Raw ratio; null when the bottle has no eligible price or sits at/below
// the ELO floor (bottleValue is 0 there, which would divide to 0, not null).
export function rawValuePerDollar(rating, price) {
  if (price == null || price <= 0) return null;
  const raw = bottleValue(rating);
  return raw > 0 ? raw / price : null;
}

// items: array of { rating, price }. Returns a parallel array of integers
// (or null), normalized so the single best-value item in this set is
// exactly 100 and everything else scales linearly against it. Normalizing
// is only meaningful over a fixed comparison set — callers must pass the
// same catalog slice everywhere they want matching numbers (e.g. the full
// active catalog, same as the leaderboard's fetch).
export function normalizeValuePerDollar(items) {
  const raws = items.map((it) => rawValuePerDollar(it.rating, it.price));
  const maxRaw = raws.reduce((m, v) => (v != null && v > m ? v : m), 0);
  return raws.map((r) => (r != null && maxRaw > 0 ? Math.round((r / maxRaw) * 100) : null));
}

// ---- Batch hierarchy: price with parent inheritance ----
// Locked pricing rule (from the batch-hierarchy seed review): a child with
// no secondary_value of its own inherits its PARENT's secondary_value for
// display and for the VALUE formula, tagged "LINE PRICE" (styled like the
// MSRP tag) so it's clear the number came from the line, not that specific
// batch. A child only falls back to its own msrp_usd if the parent ALSO
// has no secondary — same MSRP-fallback rule every other bottle already
// uses. Parents and standalone bottles (no parent_id) are unaffected: own
// secondary, else own msrp_usd, else null.
//
// One implementation, called everywhere a price is shown or fed into the
// VALUE formula (leaderboard, bottle profile, trade calculator,
// collection) — structural parity, same reasoning as normalizeValuePerDollar
// itself. `parent` is the parent bottle row (or null/undefined); callers
// resolve it client-side from whatever catalog they already fetched.
export function resolvePrice(bottle, parent) {
  if (bottle.secondary_value != null) {
    return { price: bottle.secondary_value, tag: null };
  }
  if (parent?.secondary_value != null) {
    return { price: parent.secondary_value, tag: "LINE PRICE" };
  }
  if (bottle.msrp_usd != null) {
    return { price: bottle.msrp_usd, tag: "MSRP" };
  }
  return { price: null, tag: null };
}

// ---- Trade verdict: secondary price is the primary axis, convex ELO is a
// bounded, price-proximity-gated tiebreaker ----
//
// The old trade verdict ranked purely by convex ELO points (bottleValue
// above). That let two similarly-elite bottles read as a near-fair trade
// even when their real-world price gap was enormous — e.g. Elijah Craig
// Barrel Proof C923 (~$150 secondary) vs. Pappy Van Winkle 20 Year
// (~$1,450 secondary) scored "22% slight edge," burying a $1,300 gap.
// Price (via resolvePrice's existing secondary → line price → MSRP chain)
// is now what the verdict is actually measuring; ELO only gets a say when
// the price gap is small enough that taste plausibly matters as much as
// the price tag, and even then only within a hard cap.

// Flat percentage-point ceiling on how far the ELO signal may move the
// verdict's price-based pct, in either direction, before any attenuation.
// A flat cap (not a proportional one) is what lets ELO visibly break a
// near-tie on price (small base pct + up to 10 points of adjustment is a
// meaningful swing) while still being structurally incapable of
// out-arguing any real price gap once that gap is itself much larger than
// 10 points.
export const ELO_ADJUST_CAP = 10;

// Price-proximity attenuation for the (already-capped) ELO adjustment:
// full strength while the sides are within ELO_FULL_EFFECT_PRICE_PCT of
// each other on price, then a straight linear ramp down to zero by
// ELO_ZERO_EFFECT_PRICE_PCT. 50 is not an arbitrary round number — it's
// the exact pct-of-larger-side value a 2x price gap produces (for prices
// x and 2x: (2x - x) / 2x = 50%), so "ELO stops mattering once one side
// costs roughly double the other" is a literal, checkable property of
// this constant, not just a description of it. A straight line between
// the two named anchors is the simplest curve that satisfies both
// endpoints; nothing about the problem calls for an easing curve more
// elaborate than that.
export const ELO_FULL_EFFECT_PRICE_PCT = 15;
export const ELO_ZERO_EFFECT_PRICE_PCT = 50;

function eloAttenuation(pricePctMagnitude) {
  if (pricePctMagnitude <= ELO_FULL_EFFECT_PRICE_PCT) return 1;
  if (pricePctMagnitude >= ELO_ZERO_EFFECT_PRICE_PCT) return 0;
  return (
    1 -
    (pricePctMagnitude - ELO_FULL_EFFECT_PRICE_PCT) /
      (ELO_ZERO_EFFECT_PRICE_PCT - ELO_FULL_EFFECT_PRICE_PCT)
  );
}

// Same magnitude as tradePct, but signed: positive when B > A. Built on
// tradePct rather than reimplementing the ratio, so the two can never
// drift apart on what "% apart" means.
function signedTradePct(a, b) {
  if (b === a) return 0;
  return tradePct(a, b) * (b > a ? 1 : -1);
}

// Verdict tone/band tier from a pct magnitude — 0 (dead even) through 3
// (heavily in favor). Exported as a pure number, not label strings: this
// module stays framework-agnostic (no JSX/Tailwind), same as every other
// export here. Callers map tier + favors to actual copy.
export function verdictTier(pctMagnitude) {
  if (pctMagnitude <= 5) return 0;
  if (pctMagnitude <= 15) return 1;
  if (pctMagnitude <= 35) return 2;
  return 3;
}

// sideA/sideB: arrays of { elo, price }. `price` must already be resolved
// by the caller via resolvePrice (this module has no catalog/parent-lookup
// access to do that itself) — same division of labor as every other
// consumer of resolvePrice. Returns null for an empty side, or a side
// containing any bottle with no resolvable price anywhere in the chain
// (secondary, line price, and MSRP all null) — a side made entirely of
// MSRP-fallback bottles is NOT this case; MSRP is a real, valid rung of
// the chain and prices the side normally.
export function tradeVerdict(sideA, sideB) {
  if (sideA.length === 0 || sideB.length === 0) return null;
  if ([...sideA, ...sideB].some((b) => b.price == null)) return null;

  const priceA = sideA.reduce((t, b) => t + b.price, 0);
  const priceB = sideB.reduce((t, b) => t + b.price, 0);
  const convexA = sideA.reduce((t, b) => t + bottleValue(b.elo), 0);
  const convexB = sideB.reduce((t, b) => t + bottleValue(b.elo), 0);

  const pricePct = signedTradePct(priceA, priceB);
  const convexPct = signedTradePct(convexA, convexB);

  const eloAdjustCapped = Math.max(-ELO_ADJUST_CAP, Math.min(ELO_ADJUST_CAP, convexPct));
  // `|| 0` normalizes -0 (e.g. a negative capped signal times zero
  // attenuation) to plain 0 — same value, avoids a confusing "-0" surfacing
  // in the UI or in strict-equality test assertions.
  const eloAdjust = eloAdjustCapped * eloAttenuation(Math.abs(pricePct)) || 0;

  const adjustedPct = Math.max(-100, Math.min(100, pricePct + eloAdjust));
  const favors = adjustedPct > 0 ? "you" : adjustedPct < 0 ? "them" : null;

  // Whether ELO's contribution actually changed which band the verdict
  // lands in (vs. price alone) — the signal for the UI's "crowd
  // preference" note. A nonzero eloAdjust that merely nudges the number
  // within the same band does NOT count; the note is reserved for a
  // genuine tiebreak, not decoration.
  const crowdBrokeTheTie = verdictTier(Math.abs(pricePct)) !== verdictTier(Math.abs(adjustedPct));

  return {
    priceA,
    priceB,
    priceDiff: priceB - priceA,
    pct: Math.abs(adjustedPct),
    favors,
    tier: verdictTier(Math.abs(adjustedPct)),
    eloAdjust,
    crowdBrokeTheTie,
  };
}
