// Single source of truth for "the leaderboard's full rated catalog, with
// price and VALUE attached." Both the Leaderboard table and the bottle
// profile page call this exact function — not parallel reimplementations —
// so the VALUE shown on a bottle's profile is structurally guaranteed to
// match what the leaderboard shows for that same bottle, not just
// coincidentally equal.
import { normalizeValuePerDollar } from "./tradeValue.js";

export async function fetchLeaderboardCatalog(supabase) {
  const { data } = await supabase
    .from("bottle_ratings")
    .select(
      "bottle_id, rating, wins, losses, rounds_played, bottles(id, slug, name, distillery, msrp_usd, secondary_value)"
    )
    .order("rating", { ascending: false })
    .limit(200);

  const rows = data ?? [];
  const withPrice = rows.map((r) => {
    const secondary = r.bottles?.secondary_value ?? null;
    const msrp = r.bottles?.msrp_usd ?? null;
    const price = secondary ?? msrp;
    return { ...r, price, priceIsFallback: secondary == null && msrp != null };
  });
  const values = normalizeValuePerDollar(withPrice);
  // rows already arrive rating-desc from the query, so index+1 is the
  // rating rank — fixed here once, independent of any later client sort.
  return withPrice.map((r, i) => ({ ...r, value: values[i], ratingRank: i + 1 }));
}
