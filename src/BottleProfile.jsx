import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { fetchLeaderboardCatalog } from "./leaderboardCatalog.js";
import { eloToDisplayRating } from "./ratingDisplay.js";
import ContributionGate from "./ContributionGate.jsx";
import BottleImage from "./BottleImage.jsx";

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtDate = (d) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

const fmtProof = (p) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

export default function BottleProfile() {
  const { slug } = useParams();
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      // rating_snapshots is only readable by `authenticated` (anonymous
      // sign-ins ride that role) — bootstrap a session the same way
      // Collection.jsx does before touching it. Kept in state (not just
      // ensured-to-exist) since the contribution entry points need to know
      // whether this session is anonymous.
      let { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        const signInResult = await supabase.auth.signInAnonymously();
        sessionData = { session: signInResult.data.session };
      }
      const session = sessionData.session;

      const { data: bottle } = await supabase
        .from("bottles")
        .select("id, slug, name, distillery, msrp_usd, secondary_value, proof, proof_note, status, parent_id, image_url")
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

      // catalog carries price/priceTag/value already resolved with the
      // batch-hierarchy inheritance rule (leaderboardCatalog.js) — read
      // them off this bottle's own row rather than recomputing, so a
      // child's numbers here are structurally guaranteed to match wherever
      // else this same catalog fetch is used.
      const catalogRow = catalog.find((r) => r.bottle_id === bottle.id);
      // Virtual parent (canon-audit structural line — rankable=false with
      // rankable children): the catalog flags it and derives its family
      // stats. Its OWN bottle_ratings row is a stale placeholder (~1500, 0
      // rounds), so the page must not present that as an individual rating.
      const isVirtualParent = catalogRow?.isVirtualParent === true;
      const parentRow = bottle.parent_id
        ? catalog.find((r) => r.bottle_id === bottle.parent_id)
        : null;
      // Children of THIS bottle (only populated when this bottle is a
      // parent) — same catalog fetch, no extra query. Ordered by rating
      // desc for the BATCHES table. Named "batches" (not "children") to
      // avoid colliding with React's reserved children prop downstream.
      const batches = catalog
        .filter((r) => r.bottles?.parent_id === bottle.id)
        .sort((a, b) => b.rating - a.rating);

      setState({
        status: "ok",
        session,
        bottle,
        isVirtualParent,
        rating: ratingRow ?? { rating: 1500, wins: 0, losses: 0, rounds_played: 0 },
        snapshots: snapshots ?? [],
        value: catalogRow?.value ?? null,
        price: catalogRow?.price ?? null,
        priceTag: catalogRow?.priceTag ?? null,
        parent: parentRow?.bottles ?? null,
        batches,
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

function Profile({ session, bottle, isVirtualParent, rating, snapshots, value, price, priceTag, parent, batches }) {
  const [openPanel, setOpenPanel] = useState(null); // null | "edit" | "price"
  const { rankNow, rankTrend } = useMemo(() => computeRankTrend(snapshots), [snapshots]);

  const proofDisplay =
    bottle.proof != null ? `${fmtProof(bottle.proof)} PROOF` : bottle.proof_note ?? "—";

  // A virtual parent is a structural line, not an individually-ranked
  // bottle — the crowd votes its batches, not the line itself. Drop the
  // per-bottle vote tiles (Rating/Rank/W–L/Rounds), which would only read
  // as a placeholder ~1500 / 0-0 / 0 rounds; keep the derived line-level
  // Price/MSRP/Proof/Value, and point at the Batches table below.
  const stats = isVirtualParent
    ? [
        {
          label: "Price",
          value: price != null ? money(price) : "—",
          tag: priceTag,
        },
        { label: "MSRP", value: bottle.msrp_usd != null ? money(bottle.msrp_usd) : "—" },
        { label: "Proof", value: proofDisplay },
        { label: "Value", value: value != null ? value : "—" },
      ]
    : [
        { label: "Rating", value: eloToDisplayRating(rating.rating) },
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
          tag: priceTag,
        },
        { label: "MSRP", value: bottle.msrp_usd != null ? money(bottle.msrp_usd) : "—" },
        { label: "Proof", value: proofDisplay },
        { label: "Value", value: value != null ? value : "—" },
      ];

  return (
    <>
      <header className="text-center mb-8">
        {/* The one surface where the image can breathe — a big portrait slot
            for the photo (bottles are tall), while the placeholder keeps its
            square size (imageClassName only enlarges the photo). */}
        <BottleImage
          bottle={bottle}
          rating={rating.rating}
          className="w-28 h-28 sm:w-32 sm:h-32 rounded-lg mx-auto mb-4 block text-3xl"
          imageClassName="w-36 h-48 sm:w-44 sm:h-56 rounded-lg mx-auto mb-4 block"
        />
        <h1 className="font-serif text-4xl sm:text-5xl text-amber-200 leading-tight">
          {bottle.name}
        </h1>
        <div className="text-[11px] uppercase tracking-[0.35em] text-amber-600 mt-2">
          {bottle.distillery}
        </div>
        {parent && (
          <div className="text-xs text-amber-500/80 mt-2">
            part of{" "}
            <Link
              to={`/bottle/${parent.slug}`}
              className="text-amber-300 hover:text-amber-100 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
            >
              {parent.name}
            </Link>
          </div>
        )}
        {isVirtualParent ? (
          <>
            <div className="mt-7 font-serif text-amber-300/90 text-2xl sm:text-3xl leading-tight">
              Not individually ranked
            </div>
            <div className="text-[11px] uppercase tracking-widest text-amber-600 mt-2">
              Ranked as a line — see batches below
            </div>
          </>
        ) : (
          <>
            <div className="mt-7 font-serif font-bold text-amber-400 text-6xl sm:text-7xl leading-none">
              {eloToDisplayRating(rating.rating)}
            </div>
            <div className="text-[11px] uppercase tracking-widest text-amber-600 mt-2">
              Current rating
            </div>
          </>
        )}
      </header>

      <section className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-4 sm:p-5 mb-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-4 text-center">
          {stats.map((s) => {
            // proof_note prose (e.g. "124–140 proof, varies by batch...")
            // can run well past what a single truncated line can show —
            // truncate on a centered flex row clips from both sides, not
            // just the end, producing unreadable mid-string fragments.
            // Long values wrap onto a few smaller lines instead.
            const longValue = typeof s.value === "string" && s.value.length > 14;
            return (
            <div key={s.label} className="min-w-0">
              <div
                className={
                  "text-stone-900 font-bold flex items-center justify-center gap-1.5 flex-wrap " +
                  (longValue ? "text-xs leading-snug" : "text-lg truncate")
                }
              >
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
              {s.label === "Price" && (
                <button
                  type="button"
                  onClick={() => setOpenPanel(openPanel === "price" ? null : "price")}
                  className="text-[10px] text-amber-700 hover:text-amber-900 underline underline-offset-2 mt-1 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                >
                  Report a price
                </button>
              )}
            </div>
            );
          })}
        </div>
      </section>

      {(openPanel === "edit" || openPanel === "price") && (
        <section className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-4 sm:p-5 mb-5">
          <ContributionGate session={session} onDone={() => setOpenPanel(null)}>
            {openPanel === "edit" ? (
              <SuggestEditForm
                bottle={bottle}
                userId={session.user.id}
                onDone={() => setOpenPanel(null)}
              />
            ) : (
              <ReportPriceForm
                bottle={bottle}
                userId={session.user.id}
                onDone={() => setOpenPanel(null)}
              />
            )}
          </ContributionGate>
        </section>
      )}

      <div className="text-center -mt-2 mb-5">
        <button
          type="button"
          onClick={() => setOpenPanel(openPanel === "edit" ? null : "edit")}
          className="text-xs text-amber-600/80 hover:text-amber-400 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
        >
          Suggest an edit
        </button>
      </div>

      {batches.length > 0 && <BatchesTable batches={batches} />}

      <RatingHistory snapshots={snapshots} />
    </>
  );
}

const EDIT_FIELDS = [
  { key: "name", label: "Name" },
  { key: "distillery", label: "Distillery" },
  { key: "proof", label: "Proof" },
  { key: "proof_note", label: "Proof note" },
  { key: "msrp_usd", label: "MSRP" },
];

// Field picker is whitelist-only — the same 5 fields the migration
// documents (never initial_rating, secondary_value, status, parent_id).
// source_note is required (also enforced by a DB check constraint), with
// a placeholder nudging toward a real citation rather than "trust me".
function SuggestEditForm({ bottle, userId, onDone }) {
  const [field, setField] = useState(EDIT_FIELDS[0].key);
  const [proposedValue, setProposedValue] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const currentValue = bottle[field];
  const currentDisplay = currentValue == null || currentValue === "" ? "—" : String(currentValue);

  const submit = async () => {
    if (!proposedValue.trim()) {
      setError("Enter a proposed value.");
      return;
    }
    if (!sourceNote.trim()) {
      setError("Source is required.");
      return;
    }
    setSubmitting(true);
    setError("");
    const { error: err } = await supabase.from("proposals").insert({
      user_id: userId,
      type: "edit_field",
      bottle_id: bottle.id,
      payload: { field, current_value: currentValue ?? null, proposed_value: proposedValue.trim() },
      source_note: sourceNote.trim(),
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="text-center py-2">
        <p className="text-stone-700 text-sm">Thanks — edits are reviewed before they land.</p>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 text-xs uppercase tracking-widest text-amber-800 border border-amber-700/60 rounded px-4 py-2 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-serif text-stone-900 text-lg mb-3">Suggest an edit</h3>

      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Field</label>
      <select
        value={field}
        onChange={(e) => {
          setField(e.target.value);
          setProposedValue("");
        }}
        className="w-full bg-[#FFF9EC] border border-[#8A6A3A] rounded-md px-3 py-2 text-stone-900 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        {EDIT_FIELDS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      <div className="text-xs uppercase tracking-widest text-stone-500 mb-1">Current value</div>
      <div className="text-stone-800 font-semibold mb-3">{currentDisplay}</div>

      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Proposed value</label>
      <input
        value={proposedValue}
        onChange={(e) => setProposedValue(e.target.value)}
        className="w-full bg-[#FFF9EC] border border-[#8A6A3A] rounded-md px-3 py-2 text-stone-900 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Source *</label>
      <input
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        placeholder="e.g. per the label / distillery release page"
        className="w-full bg-[#FFF9EC] border border-[#8A6A3A] rounded-md px-3 py-2 text-stone-900 mb-1 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      {error && <p className="text-red-700 text-sm mt-2">{error}</p>}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="py-2 px-6 rounded-md bg-amber-700 text-amber-50 font-semibold hover:bg-amber-600 disabled:opacity-50 text-sm uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          {submitting ? "Submitting…" : "Submit for review"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-xs uppercase tracking-widest text-stone-500 hover:text-stone-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const PRICE_CONTEXTS = [
  { key: "paid", label: "I paid this" },
  { key: "seen", label: "Seen for sale" },
  { key: "trade", label: "Trade value" },
];

function ReportPriceForm({ bottle, userId, onDone }) {
  const [price, setPrice] = useState("");
  const [context, setContext] = useState("paid");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    const n = Number(price);
    if (!price.trim() || !(n > 0)) {
      setError("Enter a valid price.");
      return;
    }
    setSubmitting(true);
    setError("");
    const { error: err } = await supabase.from("proposals").insert({
      user_id: userId,
      type: "price_report",
      bottle_id: bottle.id,
      payload: { price: n, context },
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="text-center py-2">
        <p className="text-stone-700 text-sm">Thanks — reports are reviewed before they land.</p>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 text-xs uppercase tracking-widest text-amber-800 border border-amber-700/60 rounded px-4 py-2 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-serif text-stone-900 text-lg mb-3">Report a price</h3>

      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Price ($)</label>
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        type="number"
        step="0.01"
        min="0"
        className="w-full bg-[#FFF9EC] border border-[#8A6A3A] rounded-md px-3 py-2 text-stone-900 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Context</label>
      <div className="flex gap-2 mb-3">
        {PRICE_CONTEXTS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setContext(c.key)}
            className={
              "px-3 py-1.5 rounded-full border text-xs uppercase tracking-wider focus:outline-none focus:ring-2 focus:ring-amber-500 " +
              (context === c.key
                ? "bg-amber-700 border-amber-600 text-amber-50 font-semibold"
                : "border-stone-400 text-stone-500 hover:text-stone-800")
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-stone-500 italic mb-3">
        Real transactions only — reports are cross-checked.
      </p>

      {error && <p className="text-red-700 text-sm mb-2">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="py-2 px-6 rounded-md bg-amber-700 text-amber-50 font-semibold hover:bg-amber-600 disabled:opacity-50 text-sm uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          {submitting ? "Submitting…" : "Submit report"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-xs uppercase tracking-widest text-stone-500 hover:text-stone-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// The feature's showcase — "the crowd ranks ECBP batches." Rows already
// arrive rating-desc (sorted where batches is built, in the loading
// effect above), so index+1 doubles as the batch's rank within this line.
// Proof/W–L drop at the same width the leaderboard itself collapses at
// (Tailwind's sm: breakpoint, 640px), keeping # / Batch / Rating / Price —
// the same four columns the leaderboard keeps at 380px.
function BatchesTable({ batches }) {
  return (
    <section className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-4 sm:p-5 mb-5">
      <h2 className="font-serif text-stone-900 text-lg mb-1">Batches</h2>
      <p className="text-xs text-stone-500 mb-3">Ranked by the crowd, highest rated first.</p>

      <div className="flex items-baseline gap-2 px-1 pb-2 border-b border-stone-300 text-[9px] uppercase tracking-widest text-stone-500 font-bold">
        <span className="w-5 shrink-0">#</span>
        <span className="flex-1 min-w-0">Batch</span>
        <span className="w-14 shrink-0 text-right hidden sm:block">Proof</span>
        <span className="w-14 shrink-0 text-right">Rating</span>
        <span className="w-16 shrink-0 text-right hidden sm:block">W–L</span>
        <span className="w-20 shrink-0 text-right">Price</span>
      </div>

      {batches.map((c, i) => (
        <Link
          key={c.bottle_id}
          to={`/bottle/${c.bottles.slug}`}
          className={
            "flex items-baseline gap-2 px-1 py-2 -mx-1 rounded text-sm hover:bg-amber-100/70 focus:outline-none focus:ring-2 focus:ring-amber-500" +
            (i % 2 === 1 ? " bg-amber-900/[0.03]" : "")
          }
        >
          <span className="w-5 shrink-0 font-bold text-amber-800">{i + 1}</span>
          <span className="flex-1 min-w-0 font-serif font-semibold text-stone-900 truncate">
            {c.bottles.name}
          </span>
          <span className="w-14 shrink-0 text-right text-stone-600 hidden sm:block">
            {c.bottles.proof != null ? fmtProof(c.bottles.proof) : "—"}
          </span>
          <span className="w-14 shrink-0 text-right font-bold text-stone-900">
            {eloToDisplayRating(c.rating)}
          </span>
          <span className="w-16 shrink-0 text-right text-stone-500 hidden sm:block">
            {c.wins}–{c.losses}
          </span>
          <span className="w-20 shrink-0 text-right text-stone-700">
            {c.price != null ? money(c.price) : "—"}
            {c.priceTag && (
              <span className="block text-[8px] uppercase tracking-wider text-stone-400">
                {c.priceTag}
              </span>
            )}
          </span>
        </Link>
      ))}
    </section>
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
        points={snapshots.map((s) => ({
          date: s.snap_date,
          // Rank stays a rank (an ordinal, not an ELO-derived scale — never
          // touches eloToDisplayRating). Rating is transformed here, at the
          // data-feed point, so LineChart itself needs no changes: its
          // Y-axis bounds already derive from whatever values it's handed,
          // so they adapt to the display-rating range automatically.
          value: mode === "rating" ? eloToDisplayRating(s.rating) : s.rank,
        }))}
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
