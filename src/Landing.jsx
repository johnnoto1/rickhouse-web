import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { eloToDisplayRating } from "./ratingDisplay.js";
import { fetchLeaderboardCatalog } from "./leaderboardCatalog.js";
import medalsHeroWebp from "./assets/medals-hero.webp";
import medalsHeroJpg from "./assets/medals-hero-fallback.jpg";
import medalsHeroMobileWebp from "./assets/medals-hero-mobile.webp";
import medalsHeroMobileJpg from "./assets/medals-hero-mobile-fallback.jpg";

// Graduated floor — the same rounds_played >= 10 the leaderboard uses to gate
// "provisional" (App.jsx). A rail must not surface a seed-prior bottle that
// hasn't actually earned its number.
const GRADUATED_MIN_ROUNDS = 10;
const RAIL_SIZE = 5;
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
    // rankable=true (20260718000001, not in the original ranker-filter
    // spec by name but flagged and applied here): this preview renders
    // the same "top N by rating" concept as the leaderboard itself — a
    // bottle absent from the real leaderboard shouldn't still show up
    // here as if it were ranked.
    //
    // Deliberately NOT gated on auth: this (and the hero) must paint on the
    // first frame. bottle_ratings/bottles are anon-readable, so TOP OF THE
    // BOARD renders immediately; the rails below hydrate separately.
    supabase
      .from("bottle_ratings")
      .select("rating, wins, losses, bottles!inner(name, distillery, parent_id)")
      .is("bottles.parent_id", null)
      .eq("bottles.rankable", true)
      .order("rating", { ascending: false })
      .limit(10)
      .then(({ data }) => setRows(data ?? []));
  }, []);

  // Engagement rails — hydrated async so they never block first paint. They
  // live BELOW the hero, so appearing pushes the banner/feature cards down,
  // never the hero. rating_snapshots needs an authenticated session (anon is
  // revoked), so ensure one first; any failure leaves the rails hidden.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        const { data } = await supabase.auth.signInAnonymously();
        sess = { session: data.session };
      }
      if (cancelled || !sess.session) {
        // No session → rails simply never appear (fail closed on the rails
        // only; the rest of the page is unaffected).
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

      // --- Best Value: rating-per-dollar leaders, real secondary only ---
      // priceTag "MSRP" = MSRP fallback (understated street price → fake
      // value); exclude it so the rail can't crown an unpriced bottle. Own
      // secondary (null tag) and inherited LINE PRICE both count.
      const bv = parents
        .filter(
          (r) =>
            r.priceTag !== "MSRP" &&
            (r.rounds_played ?? 0) >= GRADUATED_MIN_ROUNDS &&
            r.value != null
        )
        .sort((a, b) => b.value - a.value)
        .slice(0, RAIL_SIZE)
        .map((r) => ({
          slug: r.bottles?.slug,
          name: r.bottles?.name,
          distillery: r.bottles?.distillery,
          main: String(r.value),
          sub: r.price != null ? fmtMoney(r.price) : null,
        }));
      setBestValue(bv);

      // --- Heating Up: recent display-rating gainers (no fallers) ---
      const parentById = new Map(parents.map((r) => [r.bottle_id, r]));
      const byBottle = new Map();
      for (const s of snapRes.data ?? []) {
        const list = byBottle.get(s.bottle_id);
        if (list) list.push(s);
        else byBottle.set(s.bottle_id, [s]);
      }
      const cutoff = isoDaysAgo(7); // prior = closest snapshot at/before 7d ago
      const hu = [];
      for (const [bid, list] of byBottle) {
        const p = parentById.get(bid);
        if (!p || (p.rounds_played ?? 0) < GRADUATED_MIN_ROUNDS) continue;
        if (list.length < 2) continue;
        list.sort((a, b) => (a.snap_date < b.snap_date ? -1 : 1));
        const latest = list[list.length - 1];
        // Closest snapshot dated on/before the 7-day cutoff; if the whole
        // window is younger than 7 days (young board), fall back to the
        // earliest snapshot we have, so movement still shows.
        let prior = null;
        for (const s of list) if (s.snap_date <= cutoff) prior = s;
        if (!prior) prior = list[0];
        if (prior.snap_date === latest.snap_date) continue;
        const gain =
          eloToDisplayRating(latest.rating) - eloToDisplayRating(prior.rating);
        if (gain > 0) {
          hu.push({
            slug: p.bottles?.slug,
            name: p.bottles?.name,
            distillery: p.bottles?.distillery,
            gain,
          });
        }
      }
      hu.sort((a, b) => b.gain - a.gain);
      setHeatingUp(
        hu.slice(0, RAIL_SIZE).map((r) => ({
          slug: r.slug,
          name: r.name,
          distillery: r.distillery,
          main: "+" + r.gain,
          mainColor: DELTA_GREEN,
          sub: null,
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#17100A_0%,#1E1409_55%,#17100A_100%)] text-[#F1E6CE] font-serif">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

        {/* Brand mark */}
        <div className="text-center sm:text-left mb-10">
          <span className="text-[11px] uppercase tracking-[0.5em] text-[#B08040]">The</span>
          <div
            className="text-[clamp(28px,6vw,44px)] font-bold tracking-[0.1em] text-[#E8B45A] leading-none [text-shadow:0_2px_0_#5A3A12]"
          >
            RICKHOUSE
          </div>
        </div>

        {/* Hero */}
        <div className="grid lg:grid-cols-2 gap-10 items-start">
          {/* Hero left */}
          <div className="min-w-0 text-center lg:text-left">
            <h1 className="text-amber-200 font-bold text-3xl sm:text-4xl leading-tight">
              Whiskey rankings, built by the community
            </h1>
            <p className="mt-4 text-[#C9A96E] text-base sm:text-lg max-w-md mx-auto lg:mx-0">
              Every rating is earned head-to-head — real drinkers voting bottle versus bottle, no critics and no paid scores.
            </p>

            <div className="mt-7 flex flex-wrap justify-center lg:justify-start gap-3">
              <Link
                to="/leaderboard"
                className="rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest px-6 py-2.5"
              >
                Rankings
              </Link>
              <Link
                to="/trade"
                className="rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest px-6 py-2.5"
              >
                Trade Calculator
              </Link>
            </div>

            <div className="mt-4 flex justify-center lg:justify-start">
              <Link
                to="/rank"
                className="inline-block bg-[#E8B45A] text-[#2A1B0C] border border-[#E8B45A] font-bold uppercase tracking-[0.25em] text-xs px-7 py-3 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
              >
                Start Ranking
              </Link>
            </div>

            {/* Editorial photo, filling the dead space below the CTA stack.
                A real content image now (not a backdrop) — shown at every
                width, just with a size-appropriate derivation: the mobile
                <source> (700x326, ~20KB) below sm, the desktop one
                (1200x558, ~52KB) at sm+ and up. Source photo has correct,
                legible medal engravings, so no blur/softening is applied —
                the medals render sharp. The mask-image below is a vignette
                only (edge fade into the page background), not a legibility
                treatment. width/height + h-auto reserve the aspect ratio so
                this never causes layout shift while it loads. */}
            <div className="mt-8">
              <picture>
                <source media="(min-width: 640px)" srcSet={medalsHeroWebp} type="image/webp" />
                <source media="(min-width: 640px)" srcSet={medalsHeroJpg} type="image/jpeg" />
                <source srcSet={medalsHeroMobileWebp} type="image/webp" />
                <img
                  src={medalsHeroMobileJpg}
                  alt="Three Glencairn glasses fitted with gold, silver, and bronze medals, resting on a barrel-wood flight board"
                  width={1200}
                  height={558}
                  loading="eager"
                  className="w-full h-auto max-w-md mx-auto lg:mx-0"
                  style={{
                    maskImage: "radial-gradient(ellipse at center, black 45%, transparent 100%)",
                    WebkitMaskImage: "radial-gradient(ellipse at center, black 45%, transparent 100%)",
                  }}
                />
              </picture>
            </div>
          </div>

          {/* Hero right — live top-10 preview */}
          <div
            className="min-w-0 bg-[#F1E6CE] border border-[#8A6A3A]"
            style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.45)" }}
          >
            <div className="px-[18px] py-[14px] border-b-2 border-[#2A1B0C] text-[13px] tracking-[0.3em] font-bold text-[#2A1B0C]">
              TOP OF THE BOARD
            </div>
            <div>
              {rows === null && <div className="h-[420px]" />}
              {rows?.length === 0 && (
                <p className="px-[18px] py-6 text-[14px] text-[#2A1B0C]">
                  No ratings yet — be the first to vote.
                </p>
              )}
              {rows?.map((r, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-[10px] px-[18px] py-[10px] text-[14px] text-left border-b border-[rgba(42,27,12,0.15)]"
                  style={i % 2 === 0 ? { background: "rgba(42,27,12,0.03)" } : undefined}
                >
                  <span className="w-[26px] shrink-0 font-bold text-[#A6521B]">{i + 1}</span>
                  <span className="flex-1 min-w-0 font-semibold text-[#2A1B0C] truncate">
                    {r.bottles?.name}
                    <span className="font-normal text-[11px] text-[#7A5A2E] ml-1.5">
                      {r.bottles?.distillery}
                    </span>
                  </span>
                  <span className="w-[56px] shrink-0 text-right font-bold text-[#2A1B0C]">
                    {eloToDisplayRating(r.rating)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Engagement rails — hydrate after auth; each hides entirely when
            nothing qualifies. Rendered below the hero so they never shift it. */}
        {((heatingUp?.length ?? 0) > 0 || (bestValue?.length ?? 0) > 0) && (
          <div className="mt-8 grid sm:grid-cols-2 gap-5">
            {heatingUp?.length > 0 && <RailCard title="HEATING UP" rows={heatingUp} />}
            {bestValue?.length > 0 && <RailCard title="BEST VALUE" rows={bestValue} />}
          </div>
        )}

        {/* Banner strip */}
        <Link
          to="/rank"
          className="mt-10 block text-center border-y border-[#5A3A12] py-4 text-[#C9A96E] italic text-sm hover:text-amber-200 hover:border-amber-700/60 transition focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          Every rating starts from a seeded baseline and moves with every vote — the board is young. Come move the numbers.
        </Link>

        {/* Feature cards */}
        <div className="mt-10 grid sm:grid-cols-2 gap-5">
          <div className="bg-stone-900/70 border border-amber-900/40 rounded-lg p-5 sm:p-6 flex flex-col">
            <h2 className="font-serif text-amber-300 text-xl">Your Collection Ranked</h2>
            <p className="mt-2 text-amber-100/80 text-sm flex-1">
              Plug in your bottles, see total secondary value and how the community rates what you own.
            </p>
            <Link
              to="/collection"
              className="mt-5 inline-block text-center rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest px-6 py-2.5"
            >
              Open Collection
            </Link>
          </div>

          <div className="bg-stone-900/70 border border-amber-900/40 rounded-lg p-5 sm:p-6 flex flex-col">
            <h2 className="font-serif text-amber-300 text-xl">Trade Calculator</h2>
            <p className="mt-2 text-amber-100/80 text-sm flex-1">
              Convex-value trade evaluation built on honest secondary pricing.
            </p>
            <Link
              to="/trade"
              className="mt-5 inline-block text-center rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest px-6 py-2.5"
            >
              Open Trade Calculator
            </Link>
          </div>
        </div>

        <footer className="text-center py-8 mt-4 text-[10px] tracking-[0.35em] text-[#7A5A2E]">
          AGED IN CHARRED OAK · RATINGS BY ELO
        </footer>
      </div>
    </div>
  );
}

// A front-page engagement rail — same parchment card language as TOP OF THE
// BOARD. Rows are tappable through to the bottle profile. `rows` items:
// { slug, name, distillery, main, mainColor?, sub? }.
function RailCard({ title, rows }) {
  return (
    <div
      data-rail={title}
      className="min-w-0 bg-[#F1E6CE] border border-[#8A6A3A]"
      style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.45)" }}
    >
      <div className="px-[18px] py-[14px] border-b-2 border-[#2A1B0C] text-[13px] tracking-[0.3em] font-bold text-[#2A1B0C]">
        {title}
      </div>
      <div>
        {rows.map((r, i) => {
          const Row = r.slug ? Link : "div";
          const rowProps = r.slug ? { to: `/bottle/${r.slug}` } : {};
          return (
            <Row
              key={i}
              {...rowProps}
              className="flex items-center gap-[10px] px-[18px] py-[9px] text-[14px] text-left border-b border-[rgba(42,27,12,0.15)] no-underline hover:bg-[rgba(232,180,90,0.18)] focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
              style={i % 2 === 0 ? { background: "rgba(42,27,12,0.03)" } : undefined}
            >
              <span className="w-[22px] shrink-0 font-bold text-[#A6521B]">{i + 1}</span>
              <span className="flex-1 min-w-0 font-semibold text-[#2A1B0C] truncate">
                {r.name}
                {r.distillery && (
                  <span className="font-normal text-[11px] text-[#7A5A2E] ml-1.5">
                    {r.distillery}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right leading-tight">
                <span
                  className="block font-bold tabular-nums"
                  style={{ color: r.mainColor ?? "#2A1B0C" }}
                >
                  {r.main}
                </span>
                {r.sub && (
                  <span className="block text-[11px] text-[#7A5A2E] tabular-nums">{r.sub}</span>
                )}
              </span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
