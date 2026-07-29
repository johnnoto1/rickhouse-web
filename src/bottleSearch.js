// Catalog search for the shelf-scan review screen.
//
// Distinct from fuzzyMatch.js on purpose. That one asks "is this OCR string the
// same bottle as a catalog row?" and answers with a similarity score and a
// threshold — right for auto-matching, wrong here. This is a human typing a
// partial label they can SEE, so the job is to narrow, not to guess: every
// token must appear, and what survives is ordered by how likely the user means
// it. A thresholded similarity would drop exactly the case that matters —
// "knob creek" scores poorly against "Knob Creek Single Barrel Reserve" as
// whole strings, yet it is precisely the query that must return the family.

const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Every token must appear somewhere in name + distillery. AND, not OR: with OR,
// "knob creek" would drag in every "creek" bottle and bury the family the user
// is looking at.
function matchesAllTokens(haystack, tokens) {
  return tokens.every((t) => haystack.includes(t));
}

/**
 * @param query   raw text from the search box
 * @param catalog rows shaped { id, name, distillery, rounds_played?, rating? }
 * @param limit   max results
 *
 * Ranking, in order:
 *   1. name starts with the query — "eagle rare 10" puts the 10 Year above the 17
 *   2. rounds_played desc — the shelf-scan brief: partial reads surface the
 *      family, most-voted first, so the common bottle is the first tap
 *   3. rating desc, then name — stable, deterministic tiebreak
 */
export function searchBottles(query, catalog, { limit = 25 } = {}) {
  const q = norm(query);
  if (!q) return [];
  const tokens = q.split(" ").filter(Boolean);

  const hits = [];
  for (const b of catalog ?? []) {
    const name = norm(b.name);
    const hay = `${name} ${norm(b.distillery)}`;
    if (!matchesAllTokens(hay, tokens)) continue;
    hits.push({ b, prefix: name.startsWith(q) ? 0 : 1 });
  }

  hits.sort(
    (x, y) =>
      x.prefix - y.prefix ||
      (y.b.rounds_played ?? 0) - (x.b.rounds_played ?? 0) ||
      (y.b.rating ?? 0) - (x.b.rating ?? 0) ||
      String(x.b.name).localeCompare(String(y.b.name))
  );
  return hits.slice(0, limit).map((h) => h.b);
}
