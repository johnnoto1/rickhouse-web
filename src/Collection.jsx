import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { resolvePrice } from "./tradeValue.js";
import { eloToDisplayRating } from "./ratingDisplay.js";
import { fuzzyMatchBottles } from "./fuzzyMatch.js";
import ContributionGate from "./ContributionGate.jsx";
import BottleImage from "./BottleImage.jsx";
import NewBottleForm from "./NewBottleForm.jsx";
import ShelfScan from "./ShelfScan.jsx";
import SignInNudge from "./SignInNudge.jsx";

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const PROPOSAL_STATUS_LABEL = {
  pending: "Pending review",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
};
const PROPOSAL_STATUS_COLOR = {
  pending: "text-amber-400",
  accepted: "text-emerald-400",
  rejected: "text-red-400",
  superseded: "text-stone-500",
};
const proposalSummary = (p) => {
  if (p.type === "new_bottle") return p.payload?.name ?? "New bottle";
  if (p.type === "edit_field") return `Edit: ${p.payload?.field ?? "?"}`;
  return `Price report: ${p.payload?.price != null ? money(p.payload.price) : "?"}`;
};

export default function Collection() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session) {
        setSession(data.session);
        setReady(true);
      } else {
        const { data: { session: anon } } = await supabase.auth.signInAnonymously();
        setSession(anon);
        setReady(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready || !session) {
    return (
      <div className="min-h-screen bg-stone-950 flex items-center justify-center">
        <p className="text-amber-300/80 text-sm italic">
          {ready ? "Unable to start session. Please refresh." : "Loading…"}
        </p>
      </div>
    );
  }

  return <Shelf session={session} userId={session.user.id} />;
}

function Shelf({ session, userId }) {
  const [catalog, setCatalog] = useState([]);
  const [rows, setRows] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmingId, setConfirmingId] = useState(null);
  // Picker sub-flow: null = normal search/pick, "fuzzy" = "did you mean?"
  // check, "form" = the actual new_bottle proposal form.
  const [submitMode, setSubmitMode] = useState(null);
  // Shelf-scan entry: scanOpen renders the full-screen scan flow (non-anon
  // only); scanNudgeOpen shows the sign-in nudge for guests, who can't scan.
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNudgeOpen, setScanNudgeOpen] = useState(false);
  const autoOpened = useRef(false);

  // Same is_anonymous claim ContributionGate and the scan edge function
  // both check — guests get the nudge, not the scan flow.
  const isAnon = session?.user?.is_anonymous === true;

  const loadCatalog = () =>
    supabase
      .from("bottle_ratings")
      .select("rating, bottles!inner(id, slug, name, distillery, msrp_usd, secondary_value, parent_id, status, type, image_url)")
      .order("rating", { ascending: false })
      .then(({ data }) => {
        setCatalog(
          (data ?? [])
            .filter((row) => row.bottles?.status === "active")
            .map((row) => ({ ...row.bottles, rating: row.rating ?? 1500 }))
        );
      });

  const loadRows = () =>
    supabase
      .from("collections")
      .select(
        "id, added_at, status, purchase_price, acquired_date, notes, designation, bottles(id, slug, name, distillery, msrp_usd, secondary_value, parent_id, image_url, bottle_ratings(rating, wins, losses))"
      )
      .eq("user_id", userId)
      .order("added_at", { ascending: false })
      .then(({ data }) => setRows(data ?? []));

  // Own proposals only (RLS enforces this regardless) — drives both the
  // inline "PENDING REVIEW" rows for new_bottle and the "My proposals"
  // section below.
  const loadProposals = () =>
    supabase
      .from("proposals")
      .select("id, type, bottle_id, payload, status, created_at, review_note")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .then(({ data }) => setProposals(data ?? []));

  useEffect(() => {
    loadCatalog();
    loadRows();
    loadProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (rows !== null && rows.length === 0 && !autoOpened.current) {
      autoOpened.current = true;
      setPickerOpen(true);
    }
  }, [rows]);

  // Per-row model: a bottle_id can appear on multiple rows now (owning
  // three of the same bottle is three legitimate rows), so this is a
  // count, not a single-row lookup — used only for the picker's "owned
  // ×N" badge, never to key an update/delete (those go by row id).
  const ownedCountByBottleId = useMemo(() => {
    const m = new Map();
    (rows ?? []).forEach((r) => {
      const id = r.bottles?.id;
      if (id) m.set(id, (m.get(id) ?? 0) + 1);
    });
    return m;
  }, [rows]);

  // Parent lookup for the batch-hierarchy pricing rule — built from
  // catalog (the full active-bottle fetch used for the picker), which is
  // where a parent's own data lives even for an OWNED row (rows only
  // contains bottles the user actually added, not necessarily their
  // parent line too).
  const catalogById = useMemo(() => {
    const m = new Map();
    catalog.forEach((b) => m.set(b.id, b));
    return m;
  }, [catalog]);

  // Effective price + tag, batch-hierarchy aware: a child with no
  // secondary_value of its own inherits its parent's — shared resolvePrice
  // formula (tradeValue.js), same rule the leaderboard, bottle profile, and
  // trade calculator use, not a reimplementation.
  const priceInfo = (b) =>
    b ? resolvePrice(b, b.parent_id ? catalogById.get(b.parent_id) : null) : { price: null, tag: null };

  const pickerResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog.slice(0, 30);
    return catalog.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.distillery ?? "").toLowerCase().includes(q)
    );
  }, [query, catalog]);

  // Plain insert, no upsert/onConflict: per-row, owning the same bottle
  // twice is two legitimate rows, not a qty bump on one. "Add another" is
  // just calling this again with the same bottleId.
  const addBottle = async (bottleId) => {
    await supabase.from("collections").insert({ user_id: userId, bottle_id: bottleId });
    closePicker();
    await loadRows();
  };

  const updateRow = async (rowId, patch) => {
    await supabase.from("collections").update(patch).eq("id", rowId);
    await loadRows();
  };

  const removeRow = async (row) => {
    await supabase.from("collections").delete().eq("id", row.id);
    setConfirmingId(null);
    await loadRows();
  };

  const closePicker = () => {
    setPickerOpen(false);
    setQuery("");
    setSubmitMode(null);
  };

  const onProposalSubmitted = async () => {
    closePicker();
    await loadProposals();
  };

  // Pending new_bottle proposals: no bottles row exists for these in v1 —
  // they live ONLY as proposals until a curator accepts them. Rendered as
  // their own list items (not merged into `rows`, which comes from the
  // `collections` table), so totals below stay derived from `rows` alone —
  // a pending proposal has no price or rating yet, and a $0 row would
  // distort the shelf value rather than just be absent from it.
  const pendingNewBottles = useMemo(
    () => proposals.filter((p) => p.type === "new_bottle" && p.status === "pending"),
    [proposals]
  );

  // Per-row model: one row IS one bottle now, so totals are plain sums/
  // counts over rows — no more qty multiplier.
  const totalBottles = (rows ?? []).length;
  const totalStreetValue = (rows ?? []).reduce((t, r) => {
    const price = priceInfo(r.bottles).price;
    return t + (price ?? 0);
  }, 0);
  const ratedRows = (rows ?? []).filter((r) => r.bottles?.bottle_ratings);
  const avgRating =
    ratedRows.length > 0
      ? ratedRows.reduce((t, r) => t + r.bottles.bottle_ratings.rating, 0) /
        ratedRows.length
      : null;

  // Cost basis / unrealized P&L: only over rows that actually have a
  // purchase_price. A gift or a bottle with unknown cost has no basis to
  // measure gain/loss against, so it's excluded from both sums rather than
  // silently treated as a $0 cost basis (which would inflate "gain").
  // Further narrowed to rows with a resolvable price (secondary or MSRP
  // fallback, via priceInfo/resolvePrice) — a cost-basis row with no
  // price data anywhere in the chain has nothing to compare its cost to.
  const costBasisRows = (rows ?? []).filter((r) => r.purchase_price != null);
  const totalCostBasis = costBasisRows.reduce((t, r) => t + Number(r.purchase_price), 0);
  const valuedCostBasisRows = costBasisRows.filter((r) => priceInfo(r.bottles).price != null);
  const unrealizedGainLoss = valuedCostBasisRows.reduce(
    (t, r) => t + (priceInfo(r.bottles).price - Number(r.purchase_price)),
    0
  );

  const loading = rows === null;

  return (
    <div className="min-h-screen bg-stone-950 text-amber-100 px-3 py-6 sm:px-6" style={{ textAlign: "left" }}>
      <div className="max-w-3xl mx-auto">
        <div className="mb-5 flex items-center justify-between">
          <Link
            to="/"
            className="text-amber-700 hover:text-amber-400 text-xs uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            ← Keep · Trade · Cut
          </Link>
          <Link
            to="/trade"
            className="text-amber-700 hover:text-amber-400 text-xs uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            Trade Calculator
          </Link>
        </div>

        <header className="text-center mb-6">
          <div className="text-[11px] uppercase tracking-[0.35em] text-amber-600">
            The Rickhouse
          </div>
          <h1 className="font-serif text-3xl sm:text-4xl text-amber-200 mt-1">
            Your Collection Ranked
          </h1>
          <div className="mx-auto mt-2 h-px w-24 bg-amber-700/60" />
        </header>

        {loading ? (
          <p className="text-amber-300/80 text-sm italic text-center">Pulling your shelf…</p>
        ) : (
          <>
            <section className="bg-stone-900/70 border border-amber-900/40 rounded-lg p-4 mb-5">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-amber-100 font-bold text-xl">{totalBottles}</div>
                  <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">Bottles</div>
                </div>
                <div>
                  <div className="text-amber-100 font-bold text-xl">{money(totalStreetValue)}</div>
                  <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">Secondary value</div>
                </div>
                <div>
                  <div className="text-amber-100 font-bold text-xl">
                    {avgRating != null ? eloToDisplayRating(avgRating) : "—"}
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">Avg rating</div>
                </div>
              </div>

              {costBasisRows.length > 0 && (
                <div className="grid grid-cols-2 gap-2 text-center mt-3 pt-3 border-t border-amber-900/40">
                  <div>
                    <div className="text-amber-100 font-bold text-xl">{money(totalCostBasis)}</div>
                    <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">
                      Cost basis ({costBasisRows.length})
                    </div>
                  </div>
                  <div>
                    <div
                      className={
                        "font-bold text-xl " +
                        (unrealizedGainLoss > 0
                          ? "text-emerald-400"
                          : unrealizedGainLoss < 0
                          ? "text-red-400"
                          : "text-amber-100")
                      }
                    >
                      {unrealizedGainLoss >= 0 ? "+" : "−"}
                      {money(Math.abs(unrealizedGainLoss))}
                    </div>
                    <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">
                      Unrealized P/L ({valuedCostBasisRows.length} priced)
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Entry point to the price × rating scatter, landing straight on
                the Map with this shelf highlighted. Only when there's a shelf
                to show — on the map, no owned points is just the empty state. */}
            {totalBottles > 0 && (
              <div className="text-center mb-5 -mt-2">
                <Link
                  to="/leaderboard?view=map"
                  className="text-xs uppercase tracking-widest text-amber-500 hover:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                >
                  See your shelf on the map →
                </Link>
              </div>
            )}

            {rows.length === 0 && pendingNewBottles.length === 0 ? (
              <div className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-6 text-center text-stone-700">
                Your shelf is empty. Add what you own and see what the crowd thinks it's worth.
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => (
                  <CollectionRow
                    key={r.id}
                    row={r}
                    priceInfo={priceInfo}
                    confirming={confirmingId === r.id}
                    onRequestDelete={() => setConfirmingId(r.id)}
                    onConfirmDelete={() => removeRow(r)}
                    onCancelDelete={() => setConfirmingId(null)}
                    onUpdate={(patch) => updateRow(r.id, patch)}
                  />
                ))}

                {pendingNewBottles.map((p) => (
                  <div
                    key={p.id}
                    className="bg-amber-50/50 rounded-md border border-dashed border-amber-500/70 px-3 py-2.5 flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-serif font-bold text-stone-700 leading-tight truncate">
                        {p.payload?.name}
                      </div>
                      <div className="text-[11px] uppercase tracking-widest text-stone-500 mt-0.5">
                        {p.payload?.distillery}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider font-bold text-amber-700 border border-amber-500 rounded px-1.5 py-0.5 shrink-0">
                      Pending review
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => (isAnon ? setScanNudgeOpen(true) : setScanOpen(true))}
                className="flex-1 py-2 rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest"
              >
                Scan Shelf
              </button>
              <button
                onClick={() => { setPickerOpen(true); setQuery(""); setSubmitMode(null); }}
                className="flex-1 py-2 rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest"
              >
                + Add bottle
              </button>
            </div>

            {proposals.length > 0 && (
              <section className="mt-8">
                <h2 className="text-[11px] uppercase tracking-widest text-amber-500/70 mb-2">
                  My proposals
                </h2>
                <div className="space-y-1.5">
                  {proposals.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 bg-stone-900/50 border border-stone-800 rounded px-3 py-2 text-xs"
                    >
                      <span className="text-amber-100/90 truncate">{proposalSummary(p)}</span>
                      <span className={"shrink-0 uppercase tracking-wider font-bold " + PROPOSAL_STATUS_COLOR[p.status]}>
                        {PROPOSAL_STATUS_LABEL[p.status]}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {pickerOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-0 sm:p-6"
          onClick={closePicker}
        >
          <div
            className="bg-stone-900 border border-amber-900/50 rounded-t-xl sm:rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {submitMode === null && (
              <>
                <div className="p-4 border-b border-stone-800">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-serif text-amber-300 text-lg">Add to your shelf</h3>
                    <button
                      onClick={closePicker}
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
                </div>

                <div className="overflow-y-auto p-3 space-y-1.5">
                  {pickerResults.length === 0 && (
                    <div className="text-stone-500 text-sm text-center py-6">
                      No bottles match that search.
                    </div>
                  )}
                  {pickerResults.map((b) => {
                    const ownedCount = ownedCountByBottleId.get(b.id) ?? 0;
                    const { price, tag } = priceInfo(b);
                    return (
                      <button
                        key={b.id}
                        onClick={() => addBottle(b.id)}
                        className="w-full text-left bg-stone-950/60 hover:bg-amber-900/20 border border-stone-800 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500 flex items-center gap-3"
                      >
                        <BottleImage bottle={b} rating={b.rating} className="w-10 h-10 rounded text-xs" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-serif text-amber-100 truncate">{b.name}</span>
                            <span className="text-amber-400 font-semibold text-sm shrink-0">
                              {eloToDisplayRating(b.rating)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs mt-0.5">
                            <span className="text-stone-500 uppercase tracking-wider">{b.distillery}</span>
                            <span className="text-stone-400 flex items-center gap-2">
                              {price != null ? money(price) : "—"}
                              {tag && (
                                <span className="text-[9px] uppercase tracking-wider text-stone-500 border border-stone-600 rounded px-1">
                                  {tag}
                                </span>
                              )}
                              {ownedCount > 0 && (
                                <span className="text-amber-500">owned ×{ownedCount}</span>
                              )}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="p-3 border-t border-stone-800">
                  <button
                    onClick={() => setSubmitMode("fuzzy")}
                    className="w-full text-center text-xs uppercase tracking-widest text-amber-400 hover:text-amber-200 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
                  >
                    Can't find your bottle? →
                  </button>
                </div>
              </>
            )}

            {submitMode === "fuzzy" && (
              <div className="overflow-y-auto p-4">
                <FuzzyCheck
                  query={query}
                  catalog={catalog}
                  onPick={addBottle}
                  onNone={() => setSubmitMode("form")}
                  onBack={() => setSubmitMode(null)}
                />
              </div>
            )}

            {submitMode === "form" && (
              <div className="overflow-y-auto p-4">
                <ContributionGate session={session} onDone={() => setSubmitMode(null)}>
                  <NewBottleForm
                    userId={userId}
                    catalog={catalog}
                    onSubmitted={onProposalSubmitted}
                    onCancel={() => setSubmitMode(null)}
                  />
                </ContributionGate>
              </div>
            )}
          </div>
        </div>
      )}

      {scanOpen && (
        <ShelfScan
          session={session}
          userId={userId}
          catalog={catalog}
          ownedCountByBottleId={ownedCountByBottleId}
          onDone={async () => {
            setScanOpen(false);
            await loadRows();
            await loadProposals();
          }}
        />
      )}

      {scanNudgeOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setScanNudgeOpen(false)}
        >
          <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <SignInNudge
              session={session}
              onDone={() => setScanNudgeOpen(false)}
              message="Scanning your shelf requires a full account — your collection and votes carry over."
            />
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_LABELS = { sealed: "Sealed", open: "Open", finished: "Finished" };

// Native min/max on a date input only mark out-of-range values :invalid and
// block form submission — there's no form here, so those values would flow
// straight to the DB on blur. Validate before persisting. Bounds are
// [1950-01-01, Dec 31 of current year], which reduces to year ∈ [1950, now].
// Validate the year numerically, not by string compare: a 5-digit year like
// "10000" sorts *before* "2026" lexicographically and would slip through.
function isValidAcquiredDate(value) {
  const m = /^(\d+)-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < 1950 || year > new Date().getFullYear()) return false;
  const d = new Date(`${value}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

// One physical bottle, one row, editable inline. purchase_price/
// acquired_date/notes save on blur (not on every keystroke — this is a
// live DB write per field, not local-only state); status saves
// immediately on change since a <select> has no meaningful "still typing"
// state to wait out.
function CollectionRow({ row, priceInfo, confirming, onRequestDelete, onConfirmDelete, onCancelDelete, onUpdate }) {
  const b = row.bottles;
  const [purchasePrice, setPurchasePrice] = useState(row.purchase_price ?? "");
  const [acquiredDate, setAcquiredDate] = useState(row.acquired_date ?? "");
  const [notes, setNotes] = useState(row.notes ?? "");

  if (!b) return null;

  const { price, tag } = priceInfo(b);
  const rating = b.bottle_ratings?.rating ?? 1500;
  const wins = b.bottle_ratings?.wins ?? 0;
  const losses = b.bottle_ratings?.losses ?? 0;

  return (
    <div className="bg-amber-50 rounded-md border border-amber-200 shadow-md px-3 py-2.5">
      <div className="flex items-start gap-3">
        <BottleImage bottle={b} rating={rating} className="w-12 h-12 rounded text-sm" />
        <div className="flex-1 min-w-0">
          <Link
            to={`/bottle/${b.slug}`}
            className="font-serif font-bold text-stone-900 leading-tight truncate block hover:text-amber-700 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
          >
            {b.name}
          </Link>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] uppercase tracking-widest text-stone-500">
              {b.distillery}
            </span>
            {/* Designation (e.g. a store-pick/batch code like "22-03") is
                written by the shelf scan but was never shown — same tag
                language as the scan review screen. Only when present. */}
            {row.designation && (
              <span className="text-[10px] uppercase tracking-wider text-amber-800 border border-amber-400 rounded px-1 shrink-0">
                {row.designation}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-stone-700">
            <span className="font-semibold">{eloToDisplayRating(rating)} rating</span>
            <span>{wins}–{losses}</span>
            {price != null ? (
              <span className="flex items-center gap-1">
                {money(price)}
                {tag && (
                  <span className="text-[10px] uppercase tracking-wider text-stone-500 border border-stone-400 rounded px-1">
                    {tag}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-stone-400">no price data</span>
            )}
          </div>
        </div>

        {confirming ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-stone-600">Remove?</span>
            <button
              onClick={onConfirmDelete}
              className="text-xs uppercase tracking-wider text-red-700 font-semibold px-2 py-1 rounded border border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              Yes
            </button>
            <button
              onClick={onCancelDelete}
              className="text-xs uppercase tracking-wider text-stone-500 px-2 py-1 rounded border border-stone-300 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={onRequestDelete}
            aria-label={`Remove ${b.name}`}
            className="w-7 h-7 shrink-0 flex items-center justify-center rounded border border-stone-400 text-stone-500 hover:text-red-700 hover:border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            ×
          </button>
        )}
      </div>

      <div className="mt-2 pt-2 border-t border-amber-200/70 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={row.status}
          onChange={(e) => onUpdate({ status: e.target.value })}
          aria-label={`Status for ${b.name}`}
          className="bg-white border border-stone-300 rounded px-1.5 py-1 text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          {Object.entries(STATUS_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="Purchase price"
          value={purchasePrice}
          onChange={(e) => setPurchasePrice(e.target.value)}
          onBlur={() =>
            onUpdate({ purchase_price: purchasePrice === "" ? null : Number(purchasePrice) })
          }
          aria-label={`Purchase price for ${b.name}`}
          className="w-28 bg-white border border-stone-300 rounded px-1.5 py-1 text-stone-700 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
        />

        <input
          type="date"
          value={acquiredDate ?? ""}
          min="1950-01-01"
          max={`${new Date().getFullYear()}-12-31`}
          onChange={(e) => setAcquiredDate(e.target.value)}
          onBlur={() => {
            if (acquiredDate === "") {
              onUpdate({ acquired_date: null });
            } else if (isValidAcquiredDate(acquiredDate)) {
              onUpdate({ acquired_date: acquiredDate });
            } else {
              // Out of range — don't persist; revert to the last saved value.
              setAcquiredDate(row.acquired_date ?? "");
            }
          }}
          aria-label={`Acquired date for ${b.name}`}
          className="bg-white border border-stone-300 rounded px-1.5 py-1 text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-500"
        />

        <input
          type="text"
          placeholder="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => onUpdate({ notes: notes.trim() === "" ? null : notes })}
          aria-label={`Notes for ${b.name}`}
          className="flex-1 min-w-[8rem] bg-white border border-stone-300 rounded px-1.5 py-1 text-stone-700 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
      </div>
    </div>
  );
}

// "Did you mean?" — fuzzy-matches whatever the user already typed in the
// picker search box before offering the actual submission form, so a
// near-duplicate ("Weller Special Reserve" vs "W.L. Weller Special
// Reserve") gets intercepted with a one-tap add instead of becoming a
// duplicate proposal for a curator to catch later.
function FuzzyCheck({ query, catalog, onPick, onNone, onBack }) {
  const matches = useMemo(() => fuzzyMatchBottles(query, catalog), [query, catalog]);
  return (
    <div>
      <button
        onClick={onBack}
        className="text-xs text-stone-400 hover:text-amber-300 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
      >
        ← Back to search
      </button>
      <h3 className="font-serif text-amber-300 text-lg mb-1">Can't find your bottle?</h3>
      {matches.length > 0 ? (
        <>
          <p className="text-stone-400 text-sm mb-3">Did you mean one of these?</p>
          <div className="space-y-1.5 mb-4">
            {matches.map((b) => (
              <button
                key={b.id}
                onClick={() => onPick(b.id)}
                className="w-full text-left bg-stone-950/60 hover:bg-amber-900/20 border border-stone-800 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                <span className="font-serif text-amber-100">{b.name}</span>
                <span className="text-stone-500 text-xs uppercase tracking-wider ml-2">{b.distillery}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-stone-400 text-sm mb-4">Doesn't look like it's in the catalog yet.</p>
      )}
      <button
        onClick={onNone}
        className="w-full py-2 rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest"
      >
        {matches.length > 0 ? "None of these — it's new" : "Submit a new bottle"}
      </button>
    </div>
  );
}
