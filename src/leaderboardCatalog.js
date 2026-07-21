// Single source of truth for "the full rated catalog, with price and VALUE
// attached." The Leaderboard table, the bottle profile page (both for the
// bottle itself and its BATCHES table), and anywhere else that needs a
// bottle's VALUE all call this exact function — not parallel
// reimplementations — so the number can never drift between call sites.
//
// Fetches EVERY active bottle — parents, standalone bottles, AND children —
// regardless of who ends up displaying what subset (e.g. the leaderboard
// renders parents-only, but still needs children in this fetch so their
// VALUE/price exist for their own profile page, and so parent rows can look
// up a child's data for their BATCHES table). Filtering for display is the
// caller's job; this function's job is one consistent computation over the
// whole catalog.
//
// rankableOnly (catalog/ranker decoupling, 20260718000001): the leaderboard
// itself must only ever render rankable=true bottles — pass rankableOnly:
// true there. The bottle profile page calls this WITHOUT rankableOnly
// (default false) deliberately: a profile page, and its BATCHES table, must
// still show a bottle's price/VALUE even if that specific bottle (or a
// sibling batch) isn't currently promoted into the ranker — catalog pages
// stay wide even where the ranker itself narrows.
//
// VIRTUAL PARENTS (canon audit): the audit introduced catalog-only
// structural lines — a parent bottle with rankable=false whose CHILDREN are
// rankable (Found North Batch Series, Wild Turkey Master's Keep, WhistlePig
// Boss Hog). Left alone the whole family vanishes from the board: the
// rankableOnly filter drops the parent row, and the App.jsx fold keeps only
// parent_id==null rows so the children never surface either. This function
// therefore RECONSTITUTES those parents as first-class catalog rows whose
// display stats derive from their rankable children (rating = the family's
// best member, W–L = summed, rounds = the best-voted member for the
// graduation test, price = the parent's own price else the children's
// typical). Each such row is flagged isVirtualParent so callers can render
// it structurally (fold-header only, never an individual rating). This is
// done HERE, not in the fold, so VALUE/rank/provisional and every other
// consumer stay consistent with zero special-casing downstream.
import { normalizeValuePerDollar, resolvePrice } from "./tradeValue.js";

// Lower-median of a numeric list (already the "typical" middle value, robust
// to a single outlier batch). Assumes a non-empty, ascending-sorted input.
function lowerMedian(sortedNums) {
  return sortedNums[Math.floor((sortedNums.length - 1) / 2)];
}

export async function fetchLeaderboardCatalog(supabase, { rankableOnly = false } = {}) {
  let query = supabase
    .from("bottle_ratings")
    .select(
      "bottle_id, rating, wins, losses, rounds_played, bottles!inner(id, slug, name, distillery, proof, msrp_usd, secondary_value, parent_id, type, release_year, image_url, rankable)"
    )
    .order("rating", { ascending: false })
    // Safety ceiling only, deliberately above the full rankable catalog
    // (269 today) so the board renders every rankable bottle; board size is
    // governed by bottles.rankable, not this cap.
    .limit(500);
  if (rankableOnly) {
    query = query.eq("bottles.rankable", true);
  }
  const { data } = await query;

  const rows = data ?? [];

  // --- Virtual-parent reconstitution -------------------------------------
  // Group the fetched children by parent so a parent row (present or
  // synthesized) can derive its stats from them. Only children actually in
  // this result set count — under rankableOnly that's exactly the rankable
  // batches, which is what a board family should rank on.
  const childrenByParent = new Map();
  for (const r of rows) {
    const pid = r.bottles?.parent_id;
    if (pid) {
      const list = childrenByParent.get(pid);
      if (list) list.push(r);
      else childrenByParent.set(pid, [r]);
    }
  }

  // A virtual parent can be ABSENT (rankableOnly dropped its rankable=false
  // row) or already PRESENT (the no-filter profile fetch keeps it, since it
  // still owns a bottle_ratings row). Fetch only the absent ones — the ids a
  // child points at that aren't in the result set — straight from `bottles`.
  const presentIds = new Set(rows.map((r) => r.bottle_id));
  const missingParentIds = [
    ...new Set(
      rows
        .map((r) => r.bottles?.parent_id)
        .filter((pid) => pid && !presentIds.has(pid))
    ),
  ];

  let synthesizedRows = [];
  if (missingParentIds.length > 0) {
    const { data: parents } = await supabase
      .from("bottles")
      .select(
        "id, slug, name, distillery, proof, msrp_usd, secondary_value, parent_id, type, release_year, image_url, rankable"
      )
      .in("id", missingParentIds)
      .eq("status", "active");
    // Shape each into a bottle_ratings-style row; stats are overwritten by
    // the derivation pass below, so the placeholders here never surface.
    synthesizedRows = (parents ?? []).map((b) => ({
      bottle_id: b.id,
      rating: 1500,
      wins: 0,
      losses: 0,
      rounds_played: 0,
      bottles: b,
    }));
  }

  // Combine, then derive display stats for every virtual parent — whether it
  // was synthesized above or arrived present-but-rankable=false. A virtual
  // parent is any rankable=false row that actually has children in this set.
  const combined = [...rows, ...synthesizedRows].map((r) => {
    const kids = childrenByParent.get(r.bottle_id);
    const isVirtualParent = r.bottles?.rankable === false && !!kids?.length;
    if (!isVirtualParent) return r;
    return {
      ...r,
      isVirtualParent: true,
      // Family ranks where its best member ranks (matches how an ECBP-style
      // line reads); W–L sums the members; rounds = the best-voted member so
      // "graduated" means "at least one child graduated" for the muted-rating
      // provisional test downstream.
      rating: Math.max(...kids.map((k) => k.rating)),
      wins: kids.reduce((t, k) => t + (k.wins ?? 0), 0),
      losses: kids.reduce((t, k) => t + (k.losses ?? 0), 0),
      rounds_played: Math.max(...kids.map((k) => k.rounds_played ?? 0)),
    };
  });

  // Re-sort rating-desc so synthesized parents land at the rank their derived
  // rating earns (and so index+1 stays a valid rating rank). Stable in V8, so
  // rows tied on rating keep their query order.
  combined.sort((a, b) => b.rating - a.rating);

  // Parent lookup for the inheritance rule — built from this same fetch,
  // since it already contains every active bottle including parents.
  const byBottleId = new Map(combined.map((r) => [r.bottle_id, r.bottles]));

  const withPrice = combined.map((r) => {
    const parent = r.bottles?.parent_id ? byBottleId.get(r.bottles.parent_id) : null;
    let { price, tag } = resolvePrice(r.bottles ?? {}, parent);
    // A virtual parent with no price of its own falls back to the typical
    // (median) of its children's resolved prices, rather than showing "—"
    // for a line that plainly has a going rate.
    if (r.isVirtualParent && price == null) {
      const kidPrices = (childrenByParent.get(r.bottle_id) ?? [])
        .map((k) => resolvePrice(k.bottles ?? {}, r.bottles).price)
        .filter((p) => p != null)
        .sort((a, b) => a - b);
      if (kidPrices.length) {
        price = lowerMedian(kidPrices);
        tag = null;
      }
    }
    return { ...r, price, priceTag: tag, priceIsFallback: tag === "MSRP" };
  });
  const values = normalizeValuePerDollar(withPrice);
  // rows already arrive rating-desc from the sort above, so index+1 is the
  // rating rank — fixed here once, independent of any later client sort.
  return withPrice.map((r, i) => ({ ...r, value: values[i], ratingRank: i + 1 }));
}
