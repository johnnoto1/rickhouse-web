import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import { resolvePrice } from "./tradeValue.js";
import { fuzzyMatchBottles } from "./fuzzyMatch.js";
import ContributionGate from "./ContributionGate.jsx";

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
  const autoOpened = useRef(false);

  const loadCatalog = () =>
    supabase
      .from("bottle_ratings")
      .select("rating, bottles!inner(id, slug, name, distillery, msrp_usd, secondary_value, parent_id, status, type)")
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
        "id, qty, added_at, bottles(id, slug, name, distillery, msrp_usd, secondary_value, parent_id, bottle_ratings(rating, wins, losses))"
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

  const byBottleId = useMemo(() => {
    const m = new Map();
    (rows ?? []).forEach((r) => m.set(r.bottles?.id, r));
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

  const addBottle = async (bottleId) => {
    const existing = byBottleId.get(bottleId);
    const qty = existing ? Math.min(existing.qty + 1, 99) : 1;
    await supabase
      .from("collections")
      .upsert(
        { user_id: userId, bottle_id: bottleId, qty },
        { onConflict: "user_id,bottle_id" }
      );
    closePicker();
    await loadRows();
  };

  const bump = async (row, delta) => {
    const next = row.qty + delta;
    if (next < 1) {
      setConfirmingId(row.id);
      return;
    }
    await supabase
      .from("collections")
      .update({ qty: Math.min(next, 99) })
      .eq("id", row.id);
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

  const totalBottles = (rows ?? []).reduce((t, r) => t + r.qty, 0);
  const totalStreetValue = (rows ?? []).reduce((t, r) => {
    const price = priceInfo(r.bottles).price;
    return t + (price ?? 0) * r.qty;
  }, 0);
  const ratedRows = (rows ?? []).filter((r) => r.bottles?.bottle_ratings);
  const avgRating =
    ratedRows.length > 0
      ? ratedRows.reduce((t, r) => t + r.bottles.bottle_ratings.rating, 0) /
        ratedRows.length
      : null;

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
            <section className="bg-stone-900/70 border border-amber-900/40 rounded-lg p-4 mb-5 grid grid-cols-3 gap-2 text-center">
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
                  {avgRating != null ? Math.round(avgRating) : "—"}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">Avg rating</div>
              </div>
            </section>

            {rows.length === 0 && pendingNewBottles.length === 0 ? (
              <div className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-6 text-center text-stone-700">
                Your shelf is empty. Add what you own and see what the crowd thinks it's worth.
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => {
                  const b = r.bottles;
                  if (!b) return null;
                  const { price, tag } = priceInfo(b);
                  const rating = b.bottle_ratings?.rating ?? 1500;
                  const wins = b.bottle_ratings?.wins ?? 0;
                  const losses = b.bottle_ratings?.losses ?? 0;
                  const confirming = confirmingId === r.id;
                  return (
                    <div
                      key={r.id}
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
                          <span className="font-semibold">{Math.round(rating)} rating</span>
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
                            onClick={() => removeRow(r)}
                            className="text-xs uppercase tracking-wider text-red-700 font-semibold px-2 py-1 rounded border border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-amber-500"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmingId(null)}
                            className="text-xs uppercase tracking-wider text-stone-500 px-2 py-1 rounded border border-stone-300 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => bump(r, -1)}
                            aria-label={`Decrease quantity of ${b.name}`}
                            className="w-7 h-7 flex items-center justify-center rounded border border-stone-400 text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
                          >
                            −
                          </button>
                          <span className="w-5 text-center font-semibold text-stone-900">{r.qty}</span>
                          <button
                            onClick={() => bump(r, 1)}
                            aria-label={`Increase quantity of ${b.name}`}
                            disabled={r.qty >= 99}
                            className="w-7 h-7 flex items-center justify-center rounded border border-stone-400 text-stone-700 hover:bg-stone-100 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-amber-500"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

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

            <button
              onClick={() => { setPickerOpen(true); setQuery(""); setSubmitMode(null); }}
              className="mt-4 w-full py-2 rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest"
            >
              + Add bottle
            </button>

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
                    const owned = byBottleId.get(b.id);
                    const { price, tag } = priceInfo(b);
                    return (
                      <button
                        key={b.id}
                        onClick={() => addBottle(b.id)}
                        className="w-full text-left bg-stone-950/60 hover:bg-amber-900/20 border border-stone-800 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-serif text-amber-100 truncate">{b.name}</span>
                          <span className="text-amber-400 font-semibold text-sm shrink-0">
                            {Math.round(b.rating)}
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
                            {owned && (
                              <span className="text-amber-500">owned ×{owned.qty}</span>
                            )}
                          </span>
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

const NEW_BOTTLE_TYPE_KEYS = ["bourbon", "rye", "other"];
const NEW_BOTTLE_TYPE_LABELS = { bourbon: "Bourbon", rye: "Rye", other: "Other" };
const MIN_RELEASE_YEAR = 1990;

// v1: no bottles row is created here — this only writes a proposals row.
// The bottle enters the catalog (with a curator-set tier + pricing) only
// once accepted; see admin/review-proposals.sql.
function NewBottleForm({ userId, catalog, onSubmitted, onCancel }) {
  const [name, setName] = useState("");
  const [distillery, setDistillery] = useState("");
  const [proof, setProof] = useState("");
  const [parentSlug, setParentSlug] = useState("");
  const [type, setType] = useState("bourbon");
  const [releaseYear, setReleaseYear] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const maxReleaseYear = new Date().getFullYear() + 1;

  // Current parents + parentable bottles = every parent_id-null bottle —
  // the depth-guard trigger only blocks a bottle that's ALREADY a child
  // from becoming a parent, so any standalone/parent bottle qualifies.
  const parentOptions = useMemo(
    () => catalog.filter((b) => b.parent_id == null).sort((a, b) => a.name.localeCompare(b.name)),
    [catalog]
  );
  const selectedParent = useMemo(
    () => (parentSlug ? catalog.find((b) => b.slug === parentSlug) : null),
    [parentSlug, catalog]
  );
  // A batch release doesn't get its own type choice — it's whatever the
  // line already is. Read-only display, not just a disabled selector, so
  // there's no forged-then-ignored value sitting in the payload either.
  const effectiveType = parentSlug ? selectedParent?.type ?? "bourbon" : type;

  const submit = async () => {
    if (!name.trim() || !distillery.trim()) {
      setError("Name and distillery are required.");
      return;
    }
    let releaseYearNum = null;
    if (releaseYear.trim()) {
      const y = Number(releaseYear.trim());
      if (!Number.isInteger(y) || releaseYear.trim().length !== 4 || y < MIN_RELEASE_YEAR || y > maxReleaseYear) {
        setError(`Release year must be a 4-digit year between ${MIN_RELEASE_YEAR} and ${maxReleaseYear}.`);
        return;
      }
      releaseYearNum = y;
    }
    setSubmitting(true);
    setError("");
    const payload = { name: name.trim(), distillery: distillery.trim(), type: effectiveType };
    if (proof.trim()) payload.proof = Number(proof);
    if (parentSlug) payload.parent_slug = parentSlug;
    if (releaseYearNum != null) payload.release_year = releaseYearNum;
    if (notes.trim()) payload.notes = notes.trim();

    const { error: err } = await supabase.from("proposals").insert({
      user_id: userId,
      type: "new_bottle",
      payload,
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    await onSubmitted();
  };

  return (
    <div>
      <button
        onClick={onCancel}
        className="text-xs text-stone-400 hover:text-amber-300 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
      >
        ← Back
      </button>
      <h3 className="font-serif text-amber-300 text-lg mb-3">Suggest a new bottle</h3>

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Name *</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Distillery *</label>
      <input
        value={distillery}
        onChange={(e) => setDistillery(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Proof (optional)</label>
      <input
        value={proof}
        onChange={(e) => setProof(e.target.value)}
        type="number"
        step="0.1"
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">
        This is a batch of… (optional)
      </label>
      <select
        value={parentSlug}
        onChange={(e) => setParentSlug(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        <option value="">— standalone bottle —</option>
        {parentOptions.map((b) => (
          <option key={b.id} value={b.slug}>
            {b.name}
          </option>
        ))}
      </select>

      {parentSlug ? (
        <p className="text-xs text-stone-400 mb-3">
          Type: <span className="text-amber-300 font-semibold">{NEW_BOTTLE_TYPE_LABELS[effectiveType]}</span>, from the line
        </p>
      ) : (
        <>
          <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Type *</label>
          <div className="flex gap-2 mb-3">
            {NEW_BOTTLE_TYPE_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setType(key)}
                aria-pressed={type === key}
                className={
                  "flex-1 py-2 rounded-md border text-xs uppercase tracking-widest font-semibold focus:outline-none focus:ring-2 focus:ring-amber-500 " +
                  (type === key
                    ? "bg-amber-700 border-amber-600 text-stone-950"
                    : "border-stone-700 text-stone-400 hover:text-amber-300 hover:border-amber-700/60")
                }
              >
                {NEW_BOTTLE_TYPE_LABELS[key]}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Release year (optional)</label>
      <input
        value={releaseYear}
        onChange={(e) => setReleaseYear(e.target.value)}
        type="number"
        inputMode="numeric"
        min={MIN_RELEASE_YEAR}
        max={maxReleaseYear}
        placeholder="e.g. 2026"
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Notes (optional)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="w-full py-2 rounded-md bg-amber-700 text-stone-950 font-semibold hover:bg-amber-600 disabled:opacity-50 text-sm uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        {submitting ? "Submitting…" : "Submit for review"}
      </button>
    </div>
  );
}
