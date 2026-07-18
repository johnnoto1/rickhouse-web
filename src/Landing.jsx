import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { eloToDisplayRating } from "./ratingDisplay.js";
import medalsHeroWebp from "./assets/medals-hero.webp";
import medalsHeroJpg from "./assets/medals-hero-fallback.jpg";
import medalsHeroMobileWebp from "./assets/medals-hero-mobile.webp";
import medalsHeroMobileJpg from "./assets/medals-hero-mobile-fallback.jpg";

export default function Landing() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    // rankable=true (20260718000001, not in the original ranker-filter
    // spec by name but flagged and applied here): this preview renders
    // the same "top N by rating" concept as the leaderboard itself — a
    // bottle absent from the real leaderboard shouldn't still show up
    // here as if it were ranked.
    supabase
      .from("bottle_ratings")
      .select("rating, wins, losses, bottles!inner(name, distillery, parent_id)")
      .is("bottles.parent_id", null)
      .eq("bottles.rankable", true)
      .order("rating", { ascending: false })
      .limit(10)
      .then(({ data }) => setRows(data ?? []));
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
