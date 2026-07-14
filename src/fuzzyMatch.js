// Lightweight fuzzy name matching for new_bottle's "did you mean?" step.
// No external library — the catalog is only ~150 rows, so a simple
// normalize + substring + Levenshtein heuristic is plenty (same reasoning
// as the bottle profile's inline-SVG chart: no library for a small,
// bounded job).

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// 0..1, higher = more similar. Exact match after normalizing = 1;
// substring in either direction = 0.9; otherwise 1 - edit-distance ratio.
function similarity(a, b) {
  const na = normalize(a),
    nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

// Returns up to `limit` catalog entries whose name (bare, or distillery +
// name) is similar to `query`, best match first, above `threshold`.
export function fuzzyMatchBottles(query, catalog, { limit = 3, threshold = 0.45 } = {}) {
  const q = query.trim();
  if (!q) return [];
  return catalog
    .map((b) => ({
      bottle: b,
      score: Math.max(similarity(q, b.name), similarity(q, `${b.distillery ?? ""} ${b.name}`)),
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.bottle);
}
