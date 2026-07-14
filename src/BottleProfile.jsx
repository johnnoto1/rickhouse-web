import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { fetchLeaderboardCatalog } from "./leaderboardCatalog.js";

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtDate = (d) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

const fmtProof = (p) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

// Effective price: secondary market value when available, else MSRP (same
// fallback rule as the leaderboard and TradeCalculator's effectivePrice).
const effectivePrice = (b) => b.secondary_value ?? b.msrp_usd ?? null;
const isFallback = (b) => b.secondary_value == null && b.msrp_usd != null;

export default function BottleProfile() {
  const { slug } = useParams();
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      // rating_snapshots is only readable by `authenticated` (anonymous
      // sign-ins ride that role) — bootstrap a session the same way
      // Collection.jsx does before touching it.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        await supabase.auth.signInAnonymously();
      }

      const { data: bottle } = await supabase
        .from("bottles")
        .select("id, slug, name, distillery, msrp_usd, secondary_value, proof, proof_note, status")
        .eq("slug", slug)
        .maybeSingle();

      if (cancelled) return;

      // Pending/rejected/merged bottles render the exact same panel as a
      // nonexistent slug — no distinguishing text, so existence of a
      // non-active bottle is never revealed through this page.
      if (!bottle || bottle.status !== "active") {
        setState({ status: "notfound" });
        return;
      }

      const [{ data: ratingRow }, { data: snapshots }, catalog] = await Promise.all([
        supabase
          .from("bottle_ratings")
          .select("rating, wins, losses, rounds_played")
          .eq("bottle_id", bottle.id)
          .maybeSingle(),
        supabase
          .from("rating_snapshots")
          .select("snap_date, rating, rank")
          .eq("bottle_id", bottle.id)
          .order("snap_date", { ascending: true }),
        // Same fetch + same formula the leaderboard uses — see
        // leaderboardCatalog.js. This is what guarantees VALUE here
        // matches VALUE on the leaderboard for this bottle.
        fetchLeaderboardCatalog(supabase),
      ]);

      if (cancelled) return;

      const catalogRow = catalog.find((r) => r.bottle_id === bottle.id);

      setState({
        status: "ok",
        bottle,
        rating: ratingRow ?? { rating: 1500, wins: 0, losses: 0, rounds_played: 0 },
        snapshots: snapshots ?? [],
        value: catalogRow?.value ?? null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.status === "loading") {
    return (
      <Page>
        <p className="text-amber-300/80 text-sm italic text-center py-16">Pulling the bottle record…</p>
      </Page>
    );
  }

  if (state.status === "notfound") {
    return (
      <Page>
        <div className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-8 text-center">
          <div className="font-serif text-2xl text-stone-900 mb-2">Bottle not found</div>
          <p className="text-stone-600 text-sm mb-5">
            That bottle isn't in the rankings.
          </p>
          <Link
            to="/leaderboard"
            className="inline-block text-xs uppercase tracking-widest text-amber-800 border border-amber-700/60 rounded px-4 py-2 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            ← Back to the leaderboard
          </Link>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <Profile {...state} />
    </Page>
  );
}

function Page({ children }) {
  return (
    <div className="min-h-screen bg-stone-950 text-amber-100 px-3 py-6 sm:px-6" style={{ textAlign: "left" }}>
      <div className="max-w-2xl mx-auto">
        <div className="mb-5 flex items-center justify-between">
          <Link
            to="/leaderboard"
            className="text-amber-700 hover:text-amber-400 text-xs uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            ← Leaderboard
          </Link>
          <Link
            to="/"
            className="text-amber-700 hover:text-amber-400 text-xs uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            Keep · Trade · Cut
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}

function Profile({ bottle, rating, snapshots, value }) {
  const price = effectivePrice(bottle);
  const fallback = isFallback(bottle);

  const { rankNow, rankTrend } = useMemo(() => computeRankTrend(snapshots), [snapshots]);

  const proofDisplay =
    bottle.proof != null ? `${fmtProof(bottle.proof)} PROOF` : bottle.proof_note ?? "—";

  const stats = [
    { label: "Rating", value: Math.round(rating.rating) },
    {
      label: "Rank",
      value: rankNow != null ? `#${rankNow}` : "—",
      trend: rankTrend,
    },
    { label: "W–L", value: `${rating.wins}–${rating.losses}` },
    { label: "Rounds", value: rating.rounds_played },
    {
      label: "Price",
      value: price != null ? money(price) : "—",
      tag: fallback ? "MSRP" : null,
    },
    { label: "MSRP", value: bottle.msrp_usd != null ? money(bottle.msrp_usd) : "—" },
    { label: "Proof", value: proofDisplay },
    { label: "Value", value: value != null ? value : "—" },
  ];

  return (
    <>
      <header className="text-center mb-8">
        <h1 className="font-serif text-4xl sm:text-5xl text-amber-200 leading-tight">
          {bottle.name}
        </h1>
        <div className="text-[11px] uppercase tracking-[0.35em] text-amber-600 mt-2">
          {bottle.distillery}
        </div>
        <div className="mt-7 font-serif font-bold text-amber-400 text-6xl sm:text-7xl leading-none">
          {Math.round(rating.rating)}
        </div>
        <div className="text-[11px] uppercase tracking-widest text-amber-600 mt-2">
          Current rating
        </div>
      </header>

      <section className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-4 sm:p-5 mb-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-4 text-center">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <div className="text-stone-900 font-bold text-lg truncate flex items-center justify-center gap-1.5 flex-wrap">
                {s.value}
                {s.tag && (
                  <span className="text-[9px] uppercase tracking-wider text-stone-500 border border-stone-400 rounded px-1 font-normal">
                    {s.tag}
                  </span>
                )}
                {s.trend && (
                  <span
                    className={
                      "text-xs font-semibold " +
                      (s.trend.dir === "up"
                        ? "text-emerald-700"
                        : s.trend.dir === "down"
                        ? "text-red-700"
                        : "text-stone-400")
                    }
                  >
                    {s.trend.dir === "up" ? "▲" : s.trend.dir === "down" ? "▼" : "▬"}
                    {s.trend.n}
                  </span>
                )}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-1">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      <RatingHistory snapshots={snapshots} />
    </>
  );
}

// Trend vs "7 days ago": the closest snapshot dated at or before
// (latest date − 7 days). If nothing that old exists, we don't show a
// trend rather than compare against a snapshot that's only a day or two
// old and mislabel it.
function computeRankTrend(snapshots) {
  if (snapshots.length === 0) return { rankNow: null, rankTrend: null };
  const latest = snapshots[snapshots.length - 1];
  const rankNow = latest.rank;
  if (snapshots.length === 1) return { rankNow, rankTrend: null };

  const latestTime = new Date(latest.snap_date + "T00:00:00").getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const priorCandidates = snapshots
    .slice(0, -1)
    .filter((s) => new Date(s.snap_date + "T00:00:00").getTime() <= latestTime - sevenDaysMs);
  if (priorCandidates.length === 0) return { rankNow, rankTrend: null };

  const ref = priorCandidates[priorCandidates.length - 1];
  const delta = ref.rank - rankNow; // positive = rank number went down = improved
  return {
    rankNow,
    rankTrend: { dir: delta > 0 ? "up" : delta < 0 ? "down" : "flat", n: Math.abs(delta) },
  };
}

// Sparse-data reality: most bottles are seeded and unvoted, so they carry
// a single flat snapshot (or none). Two charts side by side would mostly
// render as two thin, empty-looking lines in that case — a toggle over one
// shared chart area keeps the page honest about how little there sometimes
// is to show, without doubling the empty-state chrome.
function RatingHistory({ snapshots }) {
  const [mode, setMode] = useState("rating");

  if (snapshots.length < 2) {
    return (
      <section className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-6 text-center">
        <div className="text-stone-500 text-sm italic">
          Rating history begins with the first vote.
        </div>
      </section>
    );
  }

  return (
    <section className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-serif text-stone-900 text-lg">Over time</h2>
        <div className="flex gap-2 text-xs">
          {[
            ["rating", "Rating"],
            ["rank", "Rank"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setMode(k)}
              className={`px-3 py-1 rounded-full border uppercase tracking-wider focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                mode === k
                  ? "bg-amber-700 border-amber-600 text-amber-50 font-semibold"
                  : "border-stone-400 text-stone-500 hover:text-stone-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <LineChart
        points={snapshots.map((s) => ({ date: s.snap_date, value: mode === "rating" ? s.rating : s.rank }))}
        invert={mode === "rank"}
        valueLabel={mode === "rating" ? "rating" : "rank"}
      />
    </section>
  );
}

// Inline SVG, no chart library. viewBox is anchored to a small-screen-sized
// reference (400×190) so text stays legible when the container is narrow;
// width:100% lets it scale up cleanly on wider screens without redrawing.
const VB_W = 400;
const VB_H = 190;
const MARGIN = { top: 14, right: 14, bottom: 26, left: 34 };
const PLOT_W = VB_W - MARGIN.left - MARGIN.right;
const PLOT_H = VB_H - MARGIN.top - MARGIN.bottom;

function LineChart({ points, invert, valueLabel }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const { xOf, yOf, yTicks } = useMemo(() => {
    const times = points.map((p) => new Date(p.date + "T00:00:00").getTime());
    const values = points.map((p) => p.value);
    let tMin = Math.min(...times);
    let tMax = Math.max(...times);
    if (tMin === tMax) {
      tMin -= 86400000;
      tMax += 86400000;
    }
    let vMin = Math.min(...values);
    let vMax = Math.max(...values);
    if (vMin === vMax) {
      vMin -= 1;
      vMax += 1;
    }
    const vPad = (vMax - vMin) * 0.12;
    vMin -= vPad;
    vMax += vPad;

    const xOf = (date) => {
      const t = (new Date(date + "T00:00:00").getTime() - tMin) / (tMax - tMin);
      return MARGIN.left + t * PLOT_W;
    };
    const yOf = (v) => {
      const t = (v - vMin) / (vMax - vMin); // 0 at vMin, 1 at vMax
      const frac = invert ? t : 1 - t; // rank: low(best) at top; rating: high(best) at top
      return MARGIN.top + frac * PLOT_H;
    };
    const yTicks = [0, 0.5, 1].map((f) => vMin + f * (vMax - vMin));
    return { xOf, yOf, yTicks };
  }, [points, invert]);

  const path = points.map((p) => `${xOf(p.date)},${yOf(p.value)}`).join(" L ");
  const first = points[0];
  const last = points[points.length - 1];
  const hovered = hoverIdx != null ? points[hoverIdx] : null;

  const handleMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * VB_W;
    let nearest = 0;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(xOf(p.date) - px);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  };

  // Keep the tooltip box on-screen by flipping it left of the point once
  // the point sits in the right margin.
  const tipX = hovered ? xOf(hovered.date) : 0;
  const tipFlip = tipX > VB_W - 90;

  return (
    <div className="w-full max-w-xl mx-auto">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        style={{ height: "auto", display: "block" }}
        role="img"
        aria-label={`${valueLabel} over time`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* gridlines */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={MARGIN.left}
              x2={VB_W - MARGIN.right}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke="#8A6A3A"
              strokeOpacity={0.25}
              strokeWidth={1}
            />
            <text x={MARGIN.left - 6} y={yOf(v) + 3} fontSize={9} textAnchor="end" fill="#7A5A2E">
              {Math.round(v)}
            </text>
          </g>
        ))}

        {/* date axis: first / last labels */}
        <text x={xOf(first.date)} y={VB_H - 6} fontSize={9} textAnchor="start" fill="#7A5A2E">
          {fmtDate(first.date)}
        </text>
        <text x={xOf(last.date)} y={VB_H - 6} fontSize={9} textAnchor="end" fill="#7A5A2E">
          {fmtDate(last.date)}
        </text>

        {/* line */}
        <path d={`M ${path}`} fill="none" stroke="#E8B45A" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* data points */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xOf(p.date)}
            cy={yOf(p.value)}
            r={i === hoverIdx ? 5 : 4}
            fill="#E8B45A"
            stroke="#FFF9EC"
            strokeWidth={2}
          />
        ))}

        {/* endpoint direct label */}
        <text
          x={xOf(last.date) - 4}
          y={yOf(last.value) - 10}
          fontSize={11}
          fontWeight={700}
          textAnchor="end"
          fill="#2A1B0C"
        >
          {Math.round(last.value)}
        </text>

        {/* hover crosshair + tooltip */}
        {hovered && (
          <g>
            <line
              x1={xOf(hovered.date)}
              x2={xOf(hovered.date)}
              y1={MARGIN.top}
              y2={VB_H - MARGIN.bottom}
              stroke="#2A1B0C"
              strokeOpacity={0.25}
              strokeWidth={1}
            />
            <g transform={`translate(${tipFlip ? tipX - 84 : tipX + 8}, ${MARGIN.top})`}>
              <rect width={78} height={30} rx={3} fill="#2A1B0C" opacity={0.92} />
              <text x={7} y={12} fontSize={9} fill="#C9A96E">
                {fmtDate(hovered.date)}
              </text>
              <text x={7} y={24} fontSize={11} fontWeight={700} fill="#F1E6CE">
                {Math.round(hovered.value)}
              </text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
