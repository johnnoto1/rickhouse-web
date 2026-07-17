import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { bottleValue, resolvePrice, tradeVerdict } from "./tradeValue.js";
import { eloToDisplayRating, convexToDisplayPoints } from "./ratingDisplay.js";

// Maps a tradeVerdict tier + favored side to display copy. Kept local to
// this component (not tradeValue.js) — that module stays framework/JSX
// agnostic, same as bottleValue/tradePct/resolvePrice already are.
function verdictCopy(tier, favors) {
  if (tier === 0) return { label: "Dead even", tone: "text-amber-300" };
  if (tier === 1) return { label: "Fair trade", tone: "text-amber-300" };
  if (tier === 2) {
    return {
      label: `Slight edge, in ${favors === "you" ? "your" : "their"} favor`,
      tone: "text-amber-400",
    };
  }
  return {
    label: `Heavily in ${favors === "you" ? "your" : "their"} favor`,
    tone: favors === "you" ? "text-emerald-400" : "text-red-400",
  };
}

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function TradeCalculator() {
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sideA, setSideA] = useState([]);   // "You send" — array of bottle ids
  const [sideB, setSideB] = useState([]);   // "You receive"
  const [pickerFor, setPickerFor] = useState(null); // "A" | "B" | null
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("elo");

  useEffect(() => {
    supabase
      .from("bottle_ratings")
      .select(
        "rating, rounds_played, bottles!inner(id, slug, name, distillery, msrp_usd, secondary_value, secondary_source, secondary_updated_at, parent_id, status)"
      )
      .order("rating", { ascending: false })
      .then(({ data }) => {
        setCatalog(
          (data ?? [])
            .filter((row) => row.bottles?.status === "active")
            .map((row) => ({
              ...row.bottles,
              elo: row.rating ?? 1500,
              msrp: row.bottles.msrp_usd ?? null,
              rounds_played: row.rounds_played ?? 0,
            }))
        );
        setLoading(false);
      });
  }, []);

  const anyGraduated = useMemo(
    () => catalog.some((b) => (b.rounds_played ?? 0) >= 10),
    [catalog]
  );

  // Fast id→bottle lookup rebuilt when catalog changes — also doubles as
  // the parent lookup for the batch-hierarchy pricing rule below, since
  // this fetch is unconditional over every active bottle (parents and
  // children alike), so a child's parent_id always resolves here.
  const byId = useMemo(
    () => Object.fromEntries(catalog.map((b) => [b.id, b])),
    [catalog]
  );

  // Effective price + tag, batch-hierarchy aware: a child with no
  // secondary_value of its own inherits its parent's — shared resolvePrice
  // formula (tradeValue.js), same rule the leaderboard and bottle profile
  // use, not a reimplementation. Returns { price, tag }; price is null if
  // nothing is set anywhere in the chain — callers must guard.
  const priceInfo = (b) => resolvePrice(b, b.parent_id ? byId[b.parent_id] : null);
  const effectivePrice = (b) => priceInfo(b).price;

  // Compact batch naming for the picker: "{Parent Name} · {batch suffix}"
  // instead of visually grouping/indenting children under their parent.
  // Grouping would fight the picker's own sort modes (top rated / best
  // value / cheapest) — a child can legitimately land far from its parent
  // under any of those, so a rigid adjacency-based layout would break.
  // The compact name keeps the line identity visible wherever a batch
  // sorts to, without depending on where that is.
  const displayName = (b) => {
    if (!b.parent_id) return b.name;
    const parent = byId[b.parent_id];
    if (!parent) return b.name;
    const suffix = b.name.startsWith(parent.name)
      ? b.name.slice(parent.name.length).trim()
      : b.name;
    return `${parent.name} · ${suffix || b.name}`;
  };

  // Human-readable price line for a bottle card/picker row. Preserves the
  // existing "MSRP $X · Secondary $Y" dual-display when a real secondary
  // price is available (own or inherited) and there's also an MSRP to
  // show alongside it; falls back to a single "$X MSRP" when nothing else
  // is set. null when there's no price at all anywhere in the chain.
  const priceLine = (b) => {
    const { price, tag } = priceInfo(b);
    if (price == null) return null;
    if (tag === "MSRP") return `${money(price)} MSRP`;
    const label = tag === "LINE PRICE" ? "Line price" : "Secondary";
    return b.msrp != null ? `MSRP ${money(b.msrp)} · ${label} ${money(price)}` : `${label} ${money(price)}`;
  };

  // ★ Top-quartile ELO/price threshold — recomputed after load.
  // Uses each bottle's effectivePrice so secondary values (own or
  // inherited) shift the cutoff.
  const valueCutoff = useMemo(() => {
    const priced = catalog.filter((b) => effectivePrice(b) != null);
    if (priced.length === 0) return Infinity;
    const ratios = priced
      .map((b) => b.elo / effectivePrice(b))
      .sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length * 0.75)];
    // effectivePrice is a plain derivation of byId/catalog (both listed
    // below), recreated every render — including it here would just
    // thrash the memo without changing when it actually needs to recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, byId]);

  // ELO per effective-price dollar; null when no price available. Drives
  // sort order and the ★ value-cutoff threshold — deliberately untouched
  // raw ELO, NOT eloToDisplayRating(b.elo)/ep. That's not an oversight:
  // eloToDisplayRating is a nonlinear (convex) transform, so replacing the
  // numerator here would change which bottles clear valueCutoff and how
  // "Best value" sorts — a behavior change, not a display one, which the
  // "display layer only" constraint rules out. See displayRatio below for
  // the text actually shown to the user.
  const ratio = (b) => {
    const ep = effectivePrice(b);
    return ep != null ? b.elo / ep : null;
  };

  // Display-only counterpart to ratio() above: same bottle, same price,
  // but the numerator is the display-scale rating so the printed text
  // never shows a raw ELO number (or the word "ELO") — only the sort/
  // threshold logic keeps using ratio()'s raw value.
  const displayRatio = (b) => {
    const ep = effectivePrice(b);
    return ep != null ? eloToDisplayRating(b.elo) / ep : null;
  };

  // Bottles on the *opposite* side are blocked from the picker — you can't
  // trade a bottle for itself. Same-side duplicates (e.g. 2× Eagle Rare 10)
  // are allowed so multi-bottle trades reflect reality.
  const oppositeIds = useMemo(
    () => new Set(pickerFor === "A" ? sideB : sideA),
    [pickerFor, sideA, sideB]
  );

  const pickerResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = catalog.filter(
      (b) =>
        !oppositeIds.has(b.id) &&
        (b.name.toLowerCase().includes(q) ||
          (b.distillery ?? "").toLowerCase().includes(q))
    );
    if (sortKey === "elo") {
      list.sort((a, b) => b.elo - a.elo);
    } else if (sortKey === "msrp") {
      list.sort((a, b) => {
        if (a.msrp == null && b.msrp == null) return 0;
        if (a.msrp == null) return 1;
        if (b.msrp == null) return -1;
        return a.msrp - b.msrp;
      });
    } else if (sortKey === "value") {
      list.sort((a, b) => {
        const ra = ratio(a), rb = ratio(b);
        if (ra == null && rb == null) return 0;
        if (ra == null) return 1;
        if (rb == null) return -1;
        return rb - ra;
      });
    }
    return list;
    // ratio is a plain derivation of byId/catalog, recreated every render —
    // catalog is already listed, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sortKey, oppositeIds, catalog]);

  const getBotles = (ids) => ids.map((id) => byId[id]).filter(Boolean);
  const priceSum = (ids, priceFn) =>
    getBotles(ids).reduce((t, b) => t + (priceFn(b) ?? 0), 0);

  // convexA/convexB: the old "pts" measure — still computed (tradeVerdict
  // needs it for the ELO tiebreaker, and each side card still shows the
  // total as demoted metadata), just no longer the verdict's primary axis.
  const convexA = getBotles(sideA).reduce((t, b) => t + bottleValue(b.elo), 0);
  const convexB = getBotles(sideB).reduce((t, b) => t + bottleValue(b.elo), 0);
  const msrpA = priceSum(sideA, (b) => b.msrp);
  const msrpB = priceSum(sideB, (b) => b.msrp);
  const streetA = priceSum(sideA, effectivePrice);
  const streetB = priceSum(sideB, effectivePrice);
  const msrpDiff = msrpB - msrpA;

  const hasTrade = sideA.length > 0 && sideB.length > 0;
  const tradeBottles = [...getBotles(sideA), ...getBotles(sideB)];
  // A real secondary price — the bottle's own, or inherited from its
  // parent — not just an MSRP fallback. Drives whether the summary line
  // shows a separate "secondary" delta alongside the MSRP delta.
  const anySecondary = tradeBottles.some((b) => {
    const info = priceInfo(b);
    return info.price != null && info.tag !== "MSRP";
  });
  // Only show price deltas when every bottle in the trade has at least an MSRP.
  const allPriced =
    hasTrade && tradeBottles.every((b) => b.msrp != null);

  // tradeVerdict is the single source of truth for the verdict: price
  // (via effectivePrice, the same resolvePrice chain used everywhere else)
  // is the primary axis, with convex ELO as a bounded, price-proximity-
  // gated tiebreaker. See tradeValue.js for the full model + rationale.
  const verdict = hasTrade
    ? tradeVerdict(
        getBotles(sideA).map((b) => ({ elo: b.elo, price: effectivePrice(b) })),
        getBotles(sideB).map((b) => ({ elo: b.elo, price: effectivePrice(b) }))
      )
    : null;
  const verdictText = verdict ? verdictCopy(verdict.tier, verdict.favors) : null;

  // Signed pct (positive = favors you) for the beam tilt, on the same
  // 0–100 "pct of the larger side" scale tradeVerdict itself uses.
  const signedPct = !verdict
    ? 0
    : verdict.favors === "you"
    ? verdict.pct
    : verdict.favors === "them"
    ? -verdict.pct
    : 0;
  // /50 anchors full tilt (±6°) to roughly the same 2x-price-gap point
  // where ELO's influence (see ELO_ZERO_EFFECT_PRICE_PCT) goes to zero —
  // the beam maxes out its lean right around where the verdict becomes
  // "price alone, full stop."
  const tilt = hasTrade && verdict ? Math.max(-6, Math.min(6, (signedPct / 50) * 6)) : 0;

  const addToSide = (id) => {
    if (pickerFor === "A") setSideA((s) => [...s, id]);
    else setSideB((s) => [...s, id]);
    setPickerFor(null);
    setQuery("");
  };

  const removeFromSide = (side, idx) => {
    (side === "A" ? setSideA : setSideB)((s) => s.filter((_, i) => i !== idx));
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background:
            "linear-gradient(180deg, #17100A 0%, #1E1409 55%, #17100A 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Georgia', 'Times New Roman', serif",
        }}
      >
        <p style={{ fontSize: 13, color: "#C9A96E", fontStyle: "italic" }}>
          Pulling bottles from the cellar…
        </p>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-stone-950 text-amber-100 px-3 py-6 sm:px-6"
      style={{ textAlign: "left" }}
    >
      <div className="max-w-3xl mx-auto">

        {/* Back link */}
        <div className="mb-5 flex items-center justify-between">
          <Link
            to="/"
            className="text-amber-700 hover:text-amber-400 text-xs uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            ← Keep · Trade · Cut
          </Link>
          <Link
            to="/collection"
            className="text-amber-700 hover:text-amber-400 text-xs uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            Collection
          </Link>
        </div>

        {/* Header */}
        <header className="text-center mb-6">
          <div className="text-[11px] uppercase tracking-[0.35em] text-amber-600">
            The Rickhouse
          </div>
          <h1 className="font-serif text-3xl sm:text-4xl text-amber-200 mt-1">
            Trade Calculator
          </h1>
          <div className="mx-auto mt-2 h-px w-24 bg-amber-700/60" />
        </header>

        {/* Verdict beam */}
        <section
          aria-live="polite"
          className="bg-stone-900/70 border border-amber-900/40 rounded-lg p-4 mb-5 text-center"
        >
          {/* h-20, not the old h-14: price labels ("$1,450.00") run much
              longer than the old convex-pts labels ("88.2") did, and at the
              beam's full ±6° tilt the low end can rotate down by ~23px. The
              old h-14 + overflow-hidden clipped a label pushed up far enough
              to clear the line at that rotation — taller box first, then
              enough clearance to actually clear the line at max tilt. */}
          <div className="relative h-28 flex items-center justify-center overflow-hidden">
            <div
              className="w-full max-w-md h-1.5 bg-amber-700 rounded-full relative transition-transform duration-500 motion-reduce:transition-none"
              style={{ transform: `rotate(${-tilt}deg)` }}
            >
              {/* left-0/right-0, not the old -left-1/-right-1: on narrow
                  viewports the beam's max-w-md cap never engages (the line
                  is w-full, filling the clip box exactly), so any outward
                  overhang here pushes straight past the clip boundary — a
                  short "88.2"-style label hid this; a wider price string
                  ("$150.00") visibly clips its last character. */}
              <div className="absolute left-0 -top-6 text-xs text-amber-400 font-semibold">
                {sideA.length > 0 ? money(streetA) : "—"}
              </div>
              <div className="absolute right-0 -top-6 text-xs text-amber-400 font-semibold">
                {sideB.length > 0 ? money(streetB) : "—"}
              </div>
              <div className="absolute left-1/2 -translate-x-1/2 -top-1 w-3 h-3 rounded-full bg-amber-400" />
            </div>
          </div>

          {verdict ? (
            <>
              <div className={`font-serif text-xl ${verdictText.tone}`}>
                {verdictText.label}
              </div>
              <div className="text-sm text-amber-100/80 mt-1">
                {verdict.pct < 1
                  ? "Perfectly balanced."
                  : `${verdict.pct.toFixed(0)}% value ${
                      verdict.favors === "you" ? "in your favor" : "against you"
                    }`}
                {allPriced && (
                  <>
                    {" · "}
                    {anySecondary ? (
                      // Secondary delta leads — it's what the verdict is
                      // actually measuring now; MSRP delta follows as
                      // secondary reference info.
                      <>
                        {verdict.priceDiff === 0
                          ? "secondary even"
                          : `you ${verdict.priceDiff > 0 ? "gain" : "give up"} ${money(
                              Math.abs(verdict.priceDiff)
                            )} secondary`}
                        {" · "}
                        {msrpDiff === 0
                          ? "MSRP even"
                          : `you ${msrpDiff > 0 ? "gain" : "give up"} ${money(
                              Math.abs(msrpDiff)
                            )} MSRP`}
                      </>
                    ) : (
                      <>
                        {msrpDiff === 0
                          ? "MSRP is even."
                          : `you ${msrpDiff > 0 ? "gain" : "give up"} ${money(
                              Math.abs(msrpDiff)
                            )} in MSRP`}
                      </>
                    )}
                  </>
                )}
              </div>
              {verdict.crowdBrokeTheTie && (
                <div className="text-xs italic text-amber-500/70 mt-1.5">
                  crowd rating breaks the tie {verdict.favors === "you" ? "your" : "their"} way
                </div>
              )}
            </>
          ) : (
            <div className="text-stone-400 text-sm">
              Add bottles to both sides to weigh the trade.
            </div>
          )}
        </section>

        {/* Trade sides */}
        <div className="flex flex-col sm:flex-row gap-4">
          {(["A", "B"] ).map((side) => {
            const ids = side === "A" ? sideA : sideB;
            const sidePrice = side === "A" ? streetA : streetB;
            const sideConvex = side === "A" ? convexA : convexB;
            const msrp = side === "A" ? msrpA : msrpB;
            const title = side === "A" ? "You send" : "You receive";
            return (
              <div
                key={side}
                className="flex-1 min-w-0 bg-stone-900/70 border border-amber-900/40 rounded-lg p-3 sm:p-4"
              >
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="font-serif text-amber-300 text-lg">{title}</h2>
                  <div className="text-right">
                    <div className="text-amber-100 font-bold">
                      {ids.length > 0 ? money(sidePrice) : "—"}
                    </div>
                    {/* Rating demoted to metadata: each bottle below already
                        shows its own rating, this is just the side's convex-
                        value total, secondary to the price headline above.
                        convexToDisplayPoints, not eloToDisplayRating — this
                        is a SUM across bottles, not one bottle's own rating,
                        so it deliberately isn't clamped to the single-bottle
                        0-9999 ceiling (see ratingDisplay.js). Same DISPLAY_SCALE
                        as every other rating on screen, so this number is
                        finally on the same scale as the leaderboard. */}
                    <div className="text-amber-500/80 text-xs">
                      {msrp > 0 && `${money(msrp)} MSRP`}
                      {msrp > 0 && ids.length > 0 && " · "}
                      {ids.length > 0 && `${convexToDisplayPoints(sideConvex)} pts`}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {ids.length === 0 && (
                    <div className="text-stone-500 text-sm italic py-4 text-center border border-dashed border-stone-700 rounded-md">
                      Add a bottle to this side of the trade.
                    </div>
                  )}
                  {getBotles(ids).map((b, idx) => {
                    const r = ratio(b);
                    const dr = displayRatio(b);
                    const line = priceLine(b);
                    return (
                      <div
                        key={`${b.id}-${idx}`}
                        className="bg-amber-50 rounded-md border border-amber-200 shadow-md px-3 py-2.5 flex items-start gap-3"
                      >
                        <div className="flex-1 min-w-0">
                          <Link
                            to={`/bottle/${b.slug}`}
                            className="font-serif font-bold text-stone-900 leading-tight truncate block hover:text-amber-700 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                          >
                            {b.name}
                          </Link>
                          <div className="text-[11px] uppercase tracking-widest text-stone-500 mt-0.5">
                            {b.distillery}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-stone-700">
                            <span className="font-semibold">{eloToDisplayRating(b.elo)} Rating</span>
                            {anyGraduated && b.rounds_played < 10 && (
                              <span className="italic" style={{ color: "#B08040" }}>provisional</span>
                            )}
                            {line && (
                              <>
                                <span>{line}</span>
                                <span
                                  className={
                                    r >= valueCutoff
                                      ? "text-emerald-700 font-semibold"
                                      : "text-stone-500"
                                  }
                                >
                                  {dr.toFixed(1)} pts/$
                                  {r >= valueCutoff ? " ★" : ""}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => removeFromSide(side, idx)}
                          aria-label={`Remove ${b.name}`}
                          className="text-stone-400 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded px-1 text-lg leading-none"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>

                <button
                  onClick={() => {
                    setPickerFor(side);
                    setQuery("");
                  }}
                  className="mt-3 w-full py-2 rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest"
                >
                  + Add bottle
                </button>
              </div>
            );
          })}
        </div>

        {(sideA.length > 0 || sideB.length > 0) && (
          <button
            onClick={() => { setSideA([]); setSideB([]); }}
            className="mt-4 mx-auto block text-xs uppercase tracking-widest text-stone-500 hover:text-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded px-2 py-1"
          >
            Clear trade
          </button>
        )}
      </div>

      {/* Bottle picker overlay */}
      {pickerFor && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-0 sm:p-6"
          onClick={() => setPickerFor(null)}
        >
          <div
            className="bg-stone-900 border border-amber-900/50 rounded-t-xl sm:rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Picker header */}
            <div className="p-4 border-b border-stone-800">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-serif text-amber-300 text-lg">
                  Add to &ldquo;{pickerFor === "A" ? "You send" : "You receive"}&rdquo;
                </h3>
                <button
                  onClick={() => setPickerFor(null)}
                  aria-label="Close picker"
                  className="text-stone-400 hover:text-amber-300 text-xl px-1 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                >
                  ×
                </button>
              </div>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search bottle or distillery…"
                className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              <div className="flex gap-2 mt-3 text-xs">
                {[
                  ["elo", "Top rated"],
                  ["value", "Best value (pts/$)"],
                  ["msrp", "Cheapest"],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setSortKey(k)}
                    className={`px-3 py-1.5 rounded-full border uppercase tracking-wider focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                      sortKey === k
                        ? "bg-amber-700 border-amber-600 text-stone-950 font-semibold"
                        : "border-stone-700 text-stone-400 hover:text-amber-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Picker list */}
            <div className="overflow-y-auto p-3 space-y-1.5">
              {pickerResults.length === 0 && (
                <div className="text-stone-500 text-sm text-center py-6">
                  No bottles match that search.
                </div>
              )}
              {pickerResults.map((b) => {
                const r = ratio(b);
                const dr = displayRatio(b);
                const line = priceLine(b);
                return (
                  <button
                    key={b.id}
                    onClick={() => addToSide(b.id)}
                    className="w-full text-left bg-stone-950/60 hover:bg-amber-900/20 border border-stone-800 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-serif text-amber-100 truncate">
                        {displayName(b)}
                      </span>
                      <span className="text-amber-400 font-semibold text-sm shrink-0">
                        {eloToDisplayRating(b.elo)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs mt-0.5">
                      <span className="text-stone-500 uppercase tracking-wider">
                        {b.distillery}
                      </span>
                      {line && (
                        <span
                          className={
                            r >= valueCutoff
                              ? "text-emerald-400 font-semibold"
                              : "text-stone-400"
                          }
                        >
                          {line}
                          {" · "}
                          {dr.toFixed(1)} pts/$
                          {r >= valueCutoff ? " ★" : ""}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
