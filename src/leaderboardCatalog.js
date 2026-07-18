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
import { normalizeValuePerDollar, resolvePrice } from "./tradeValue.js";

export async function fetchLeaderboardCatalog(supabase, { rankableOnly = false } = {}) {
  let query = supabase
    .from("bottle_ratings")
    .select(
      "bottle_id, rating, wins, losses, rounds_played, bottles!inner(id, slug, name, distillery, proof, msrp_usd, secondary_value, parent_id, type, release_year)"
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
  // Parent lookup for the inheritance rule — built from this same fetch,
  // since it already contains every active bottle including parents.
  const byBottleId = new Map(rows.map((r) => [r.bottle_id, r.bottles]));

  const withPrice = rows.map((r) => {
    const parent = r.bottles?.parent_id ? byBottleId.get(r.bottles.parent_id) : null;
    const { price, tag } = resolvePrice(r.bottles ?? {}, parent);
    return { ...r, price, priceTag: tag, priceIsFallback: tag === "MSRP" };
  });
  const values = normalizeValuePerDollar(withPrice);
  // rows already arrive rating-desc from the query, so index+1 is the
  // rating rank — fixed here once, independent of any later client sort.
  return withPrice.map((r, i) => ({ ...r, value: values[i], ratingRank: i + 1 }));
}
