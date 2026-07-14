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
