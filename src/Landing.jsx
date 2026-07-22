import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { eloToDisplayRating } from "./ratingDisplay.js";
import { fetchLeaderboardCatalog } from "./leaderboardCatalog.js";

// Graduated floor — the same rounds_played >= 10 the leaderboard uses to gate
// "provisional" (App.jsx). A rail must not surface a seed-prior bottle that
// hasn't actually earned its number.
const GRADUATED_MIN_ROUNDS = 10;
const RAIL_SIZE = 5;
const BOARD_SIZE = 5; // top-5 preview so board + rails read as one dashboard
// Delta green, matching the ranker's rating-delta treatment (App.jsx uses
// #3E7C4F for a positive display-rating change). Heating Up has no fallers.
const DELTA_GREEN = "#3E7C4F";

const isoDaysAgo = (n) =>
  new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");

export default function Landing() {
  const [rows, setRows] = useState(null);
  // Rails hydrate AFTER auth (rating_snapshots is authenticated-read); null =
  // still loading, [] = loaded-but-nothing-qualifies (rail hides).
  const [heatingUp, setHeatingUp] = useState(null);
  const [bestValue, setBestValue] = useState(null);

  useEffect(() => {
    // rankable=true (20260718000001): same "top N by rating" concept as the
    // leaderboard. Deliberately NOT gated on auth — this (and the hero) must
    // paint on the first frame. bottle_ratings/bottles are anon-readable, so
    // TOP OF THE BOARD renders immediately; the rails hydrate separately.
    supabase
      .from("bottle_ratings")
      .select("rating, wins, losses, bottles!inner(slug, name, distillery, parent_id)")
      .is("bottles.parent_id", null)
      .eq("bottles.rankable", true)
      .order("rating", { ascending: false })
      .limit(BOARD_SIZE)
      .then(({ data }) => setRows(data ?? []));
  }, []);

  // Engagement rails — hydrated async so they never block first paint. They
  // sit in the dashboard row BELOW the hero, so appearing never moves the hero.
  // rating_snapshots needs an authenticated session (anon is revoked), so
  // ensure one first; any failure leaves the rails hidden.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        const { data } = await supabase.auth.signInAnonymously();
        sess = { session: data.session };
      }
      if (cancelled || !sess.session) {
        if (!cancelled) {
          setHeatingUp([]);
          setBestValue([]);
        }
        return;
      }

      const [catalog, snapRes] = await Promise.all([
        fetchLeaderboardCatalog(supabase, { rankableOnly: true }),
        supabase
          .from("rating_snapshots")
          .select("bottle_id, snap_date, rating")
          .gte("snap_date", isoDaysAgo(8)),
      ]);
      if (cancelled) return;

      // Parents-only, same fold as TOP OF THE BOARD and the leaderboard.
      const parents = catalog.filter((r) => r.bottles?.parent_id == null);

      // --- Heating Up: recent display-rating gainers (no fallers) ---
      // Computed FIRST so its winners can be deduped out of Best Value below.
      const parentById = new Map(parents.map((r) => [r.bottle_id, r]));
      const byBottle = new Map();
      for (const s of snapRes.data ?? []) {
        const list = byBottle.get(s.bottle_id);
        if (list) list.push(s);
        else byBottle.set(s.bottle_id, [s]);
      }
      const cutoff = isoDaysAgo(7); // prior = closest snapshot at/before 7d ago
      const gains = [];
      for (const [bid, list] of byBottle) {
        const p = parentById.get(bid);
        if (!p || (p.rounds_played ?? 0) < GRADUATED_MIN_ROUNDS) continue;
        if (list.length < 2) continue;
        list.sort((a, b) => (a.snap_date < b.snap_date ? -1 : 1));
        const latest = list[list.length - 1];
        // Closest snapshot on/before the 7-day cutoff; if the whole window is
        // younger than 7 days (young board), fall back to the earliest we have.
        let prior = null;
        for (const s of list) if (s.snap_date <= cutoff) prior = s;
        if (!prior) prior = list[0];
        if (prior.snap_date === latest.snap_date) continue;
        const gain =
          eloToDisplayRating(latest.rating) - eloToDisplayRating(prior.rating);
        if (gain > 0) gains.push({ p, gain });
      }
      gains.sort((a, b) => b.gain - a.gain);
      const huTop = gains.slice(0, RAIL_SIZE);
      const huIds = new Set(huTop.map((x) => x.p.bottle_id));
      setHeatingUp(
        huTop.map(({ p, gain }) => ({
          slug: p.bottles?.slug,
          name: p.bottles?.name,
          distillery: p.bottles?.distillery,
          main: "+" + gain,
          mainColor: DELTA_GREEN,
        }))
      );

      // --- Best Value: rating-per-dollar leaders, real secondary only ---
      // priceTag "MSRP" = MSRP fallback (understated street price → fake
      // value); exclude it. Dedupe: anything already shown in Heating Up is
      // skipped so the next value qualifier fills the slot instead.
      const bv = parents
        .filter(
          (r) =>
            r.priceTag !== "MSRP" &&
            (r.rounds_played ?? 0) >= GRADUATED_MIN_ROUNDS &&
            r.value != null &&
            !huIds.has(r.bottle_id)
        )
        .sort((a, b) => b.value - a.value)
        .slice(0, RAIL_SIZE)
        .map((r) => ({
          slug: r.bottles?.slug,
          name: r.bottles?.name,
          distillery: r.bottles?.distillery,
          meta: r.price != null ? fmtMoney(r.price) : null,
          main: String(r.value),
        }));
      setBestValue(bv);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const boardRows = (rows ?? []).map((r) => ({
    slug: r.bottles?.slug,
    name: r.bottles?.name,
    distillery: r.bottles?.distillery,
    main: String(eloToDisplayRating(r.rating)),
  }));

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#17100A_0%,#1E1409_55%,#17100A_100%)] text-[#F1E6CE] font-serif">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">

        {/* Compact hero band — brand + headline + CTAs, no photo. */}
        <header className="text-center mb-6">
          <div className="text-[10px] uppercase tracking-[0.5em] text-[#B08040]">The</div>
          <div className="text-[clamp(24px,4vw,36px)] font-bold tracking-[0.1em] text-[#E8B45A] leading-none [text-shadow:0_2px_0_#5A3A12]">
            RICKHOUSE
          </div>
          <h1 className="mt-3 text-amber-200 font-bold text-xl sm:text-2xl leading-tight">
            Whiskey rankings, built by the community
          </h1>
          <p className="mt-2 text-[#C9A96E] text-sm max-w-xl mx-auto">
            Every rating is earned head-to-head — real drinkers voting bottle versus bottle, no critics and no paid scores.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <Link
              to="/rank"
              className="rounded-md bg-[#E8B45A] text-[#2A1B0C] border border-[#E8B45A] font-bold uppercase tracking-[0.25em] text-xs px-6 py-2.5 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
            >
              Start Ranking
            </Link>
            <Link
              to="/leaderboard"
              className="rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-xs uppercase tracking-widest px-6 py-2.5"
            >
              Rankings
            </Link>
            <Link
              to="/trade"
              className="rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-xs uppercase tracking-widest px-6 py-2.5"
            >
              Trade Calculator
            </Link>
          </div>
        </header>

        {/* Dashboard — TOP OF THE BOARD + the two rails as one equal-height
            row on desktop, stacked on mobile. Flex adapts to how many cards
            are present (rails hide when empty), so a lone board still fills
            the row cleanly rather than sitting at 1/3 width. */}
        <div className="flex flex-col lg:flex-row gap-4 items-stretch">
          <RailCard title="TOP OF THE BOARD" rows={boardRows} loading={rows === null} />
          {heatingUp?.length > 0 && <RailCard title="HEATING UP" rows={heatingUp} />}
          {bestValue?.length > 0 && <RailCard title="BEST VALUE" rows={bestValue} />}
        </div>

        {/* One-line footer inside the viewport — replaces the old banner strip
            and the separate AGED-IN-OAK footer. */}
        <footer className="mt-6 pt-4 border-t border-[#5A3A12]/60 text-center">
          <Link
            to="/rank"
            className="text-[#C9A96E] italic text-xs hover:text-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            Every rating starts from a seeded baseline and moves with every vote — the board is young. Come move the numbers.
          </Link>
        </footer>
      </div>
    </div>
  );
}

// A dashboard card — TOP OF THE BOARD and both rails share this. Rows are
// single-line (so all three cards stay equal height) and tap through to the
// bottle profile. `rows` items: { slug, name, distillery, meta?, main, mainColor? }.
function RailCard({ title, rows, loading }) {
  return (
    <div
      data-rail={title}
      className="flex-1 min-w-0 bg-[#F1E6CE] border border-[#8A6A3A]"
      style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.45)" }}
    >
      <div className="px-[16px] py-[10px] border-b-2 border-[#2A1B0C] text-[12px] tracking-[0.28em] font-bold text-[#2A1B0C]">
        {title}
      </div>
      <div>
        {loading && rows.length === 0 && (
          <div className="px-[16px] py-4 text-[13px] text-[#7A5A2E]">Loading…</div>
        )}
        {rows.map((r, i) => {
          const Row = r.slug ? Link : "div";
          const rowProps = r.slug ? { to: `/bottle/${r.slug}` } : {};
          return (
            <Row
              key={i}
              {...rowProps}
              className="flex items-center gap-[8px] px-[16px] py-[5px] text-[13px] text-left border-b border-[rgba(42,27,12,0.12)] no-underline hover:bg-[rgba(232,180,90,0.18)] focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
              style={i % 2 === 0 ? { background: "rgba(42,27,12,0.03)" } : undefined}
            >
              <span className="w-[18px] shrink-0 font-bold text-[#A6521B]">{i + 1}</span>
              <span className="flex-1 min-w-0 font-semibold text-[#2A1B0C] truncate">
                {r.name}
                {r.distillery && (
                  <span className="font-normal text-[10px] text-[#7A5A2E] ml-1.5">
                    {r.distillery}
                  </span>
                )}
                {r.meta && (
                  <span className="font-normal text-[10px] text-[#7A5A2E] ml-1.5">· {r.meta}</span>
                )}
              </span>
              <span
                className="shrink-0 font-bold tabular-nums"
                style={{ color: r.mainColor ?? "#2A1B0C" }}
              >
                {r.main}
              </span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
