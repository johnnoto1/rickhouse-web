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
