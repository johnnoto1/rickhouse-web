import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

// Street value: secondary market when available, else MSRP. Null when neither is set.
const effectivePrice = (b) => b.secondary_value ?? b.msrp_usd ?? null;
const isFallback = (b) => b.secondary_value == null && b.msrp_usd != null;

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

  return <Shelf userId={session.user.id} />;
}

function Shelf({ userId }) {
  const [catalog, setCatalog] = useState([]);
  const [rows, setRows] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmingId, setConfirmingId] = useState(null);
  const autoOpened = useRef(false);

  const loadCatalog = () =>
    supabase
      .from("bottle_ratings")
      .select("rating, bottles!inner(id, name, distillery, msrp_usd, secondary_value, status)")
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
        "id, qty, added_at, bottles(id, slug, name, distillery, msrp_usd, secondary_value, bottle_ratings(rating, wins, losses))"
      )
      .eq("user_id", userId)
      .order("added_at", { ascending: false })
      .then(({ data }) => setRows(data ?? []));

  useEffect(() => {
    loadCatalog();
    loadRows();
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
    setPickerOpen(false);
    setQuery("");
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

  const totalBottles = (rows ?? []).reduce((t, r) => t + r.qty, 0);
  const totalStreetValue = (rows ?? []).reduce((t, r) => {
    const price = r.bottles ? effectivePrice(r.bottles) : null;
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
                <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">Street value</div>
              </div>
              <div>
                <div className="text-amber-100 font-bold text-xl">
                  {avgRating != null ? Math.round(avgRating) : "—"}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-amber-500/70 mt-1">Avg rating</div>
              </div>
            </section>

            {rows.length === 0 ? (
              <div className="bg-amber-50 rounded-md border border-amber-200 shadow-md p-6 text-center text-stone-700">
                Your shelf is empty. Add what you own and see what the crowd thinks it's worth.
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => {
                  const b = r.bottles;
                  if (!b) return null;
                  const price = effectivePrice(b);
                  const fallback = isFallback(b);
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
                              {fallback && (
                                <span className="text-[10px] uppercase tracking-wider text-stone-500 border border-stone-400 rounded px-1">
                                  MSRP
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
              </div>
            )}

            <button
              onClick={() => { setPickerOpen(true); setQuery(""); }}
              className="mt-4 w-full py-2 rounded-md border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm uppercase tracking-widest"
            >
              + Add bottle
            </button>
          </>
        )}
      </div>

      {pickerOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-0 sm:p-6"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="bg-stone-900 border border-amber-900/50 rounded-t-xl sm:rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-stone-800">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-serif text-amber-300 text-lg">Add to your shelf</h3>
                <button
                  onClick={() => setPickerOpen(false)}
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
                const price = effectivePrice(b);
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
                        {owned && (
                          <span className="text-amber-500">owned ×{owned.qty}</span>
                        )}
                      </span>
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
