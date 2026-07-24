import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from "react";
import { Routes, Route, Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { supabase, FN_URL } from "./supabaseClient";
import TradeCalculator from "./TradeCalculator";
import Collection from "./Collection";
import Landing from "./Landing";
import BottleProfile from "./BottleProfile";
import AddEmail from "./AddEmail";
import { fetchLeaderboardCatalog } from "./leaderboardCatalog.js";
import { eloToDisplayRating, DISPLAY_MAX } from "./ratingDisplay.js";
import RankRound from "./RankRound.jsx";
import RankCard from "./RankCard.jsx";

const TYPE_KEYS = ["bourbon", "rye", "other"];
const TYPE_LABELS = { bourbon: "Bourbon", rye: "Rye", other: "Other" };

const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/trade" element={<TradeCalculator />} />
      <Route path="/collection" element={<Collection />} />
      <Route path="/bottle/:slug" element={<BottleProfile />} />
      {/* My Board (personal ratings view) was removed from the nav — this
          keeps any bookmarked/shared /board links landing somewhere real
          instead of a blank or 404'd view. */}
      <Route path="/board" element={<Navigate to="/leaderboard" replace />} />
      <Route path="/*" element={<RickhouseApp />} />
    </Routes>
  );
}

// URL <-> internal tab-view mapping. Kept as a plain lookup rather than
// separate <Route> entries so switching tabs never remounts Game (which
// would re-bootstrap the anon session and refetch the current deal).
const PATH_VIEW = { "/rank": "rank", "/leaderboard": "board" };
const VIEW_PATH = { rank: "/rank", board: "/leaderboard" };

// ---------------- Root app ----------------
function RickhouseApp() {
  const location = useLocation();
  const navigate = useNavigate();
  // Seeded once from the URL on mount so deep links (/rank, /leaderboard)
  // land on the right tab; subsequent tab clicks just update local state +
  // the URL, without remounting Game (/rank and /leaderboard both match
  // the same /* wildcard route, so Game is never remounted between them —
  // view/goView live here, one level up, so Shell's header nav can drive
  // the same state Game's own second-row tabs do; a plain <Link> from
  // Shell would change the URL without Game ever seeing it, since nothing
  // re-syncs view from location after the initial mount).
  const [view, setView] = useState(() => PATH_VIEW[location.pathname] ?? "rank");
  // "upgrade" (the sign-in view) has no URL of its own — it's a local-only
  // view swap, same as it was before view/goView lived here. Only
  // navigate for keys that actually map to a real path.
  const goView = (key) => {
    setView(key);
    if (VIEW_PATH[key]) navigate(VIEW_PATH[key]);
  };

  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  // StrictMode double-invokes this effect in dev; both getSession() calls can
  // resolve with no session before either signInAnonymously() completes,
  // creating two anon sessions. The ref makes the sign-in itself idempotent
  // without skipping the auth-state subscription on the second invocation.
  const bootstrapping = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session) {
        setSession(data.session);
        setReady(true);
      } else if (!bootstrapping.current) {
        bootstrapping.current = true;
        // First visit — sign in anonymously so the user can vote immediately.
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

  if (!ready) return <Shell view={view} goView={goView}><p style={S.hint}>Loading…</p></Shell>;
  if (!session) return <Shell view={view} goView={goView}><p style={S.hint}>Unable to start session. Please refresh.</p></Shell>;
  return (
    <Shell session={session} view={view} goView={goView}>
      <Game session={session} view={view} goView={goView} />
    </Shell>
  );
}

// ---------------- Game ----------------
function Game({ session, view, goView }) {
  const [deal, setDeal] = useState(null);
  const [picks, setPicks] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [swapsRemaining, setSwapsRemaining] = useState(2);
  const [swappingSlot, setSwappingSlot] = useState(null);
  const [batchMode, setBatchMode] = useState(false);
  // Guards against out-of-order /deal responses: if a second newDeal() call
  // starts before an earlier one's response lands, only the LAST call's
  // result may ever reach setDeal — otherwise a slow toggle-off response
  // arriving after a fast toggle-on response would silently overwrite it,
  // leaving the cards on screen out of sync with the toggle.
  const dealRequestId = useRef(0);
  // In-memory only (not localStorage) — resets on reload, matches the task's
  // "persists for the session" spec. Explainer shows on the first ever
  // enable in this session and never again, even after toggling off/on.
  const [showBatchExplainer, setShowBatchExplainer] = useState(false);
  const explainerShownRef = useRef(false);
  // All three on by default (matches the backend's "absent = all types"
  // default exactly, so the very first deal never sends `types` at all).
  // Hidden/ignored while batch mode is on — a line already IS a type.
  const [typeFilters, setTypeFilters] = useState({ bourbon: true, rye: true, other: true });

  const isAnon = session?.user?.is_anonymous === true;

  // Bottle images for the rank cards. /deal and /swap were built before
  // images existed and their bottle payloads carry no image_url (verified in
  // whiskey-elo deal/swap index.ts), so — without touching those functions —
  // we join image_url client-side by bottle_id against the shared leaderboard
  // catalog (which now selects image_url). Missing/unknown id → null → the
  // BottleImage placeholder, same fallback as everywhere else.
  const [imageUrlById, setImageUrlById] = useState(() => new Map());
  useEffect(() => {
    let cancelled = false;
    fetchLeaderboardCatalog(supabase).then((catalog) => {
      if (cancelled) return;
      setImageUrlById(new Map(catalog.map((c) => [c.bottle_id, c.bottles?.image_url ?? null])));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const authedFetch = (path, body) =>
    fetch(`${FN_URL}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
      return data;
    });

  // mode/types default to current state; callers that also change that
  // state in the same click (toggleBatchMode, toggleType) pass the NEW
  // value explicitly since the setter hasn't re-rendered yet.
  const newDeal = async (mode = batchMode, types = typeFilters) => {
    const requestId = ++dealRequestId.current;
    setErr("");
    setBusy(true);
    setPicks({});
    setResult(null);
    setSwapsRemaining(2);
    try {
      const activeTypes = TYPE_KEYS.filter((k) => types[k]);
      const body = { batch_mode: mode };
      // Omitted entirely when every type is active (matches the backend's
      // own "absent = all types" default) — so the request payload only
      // ever carries `types` once the filter has actually narrowed
      // something, and toggling reliably changes what's on the wire.
      // Batch mode ignores this server-side too (a line IS a type), so no
      // need to gate it here beyond that.
      if (!mode && activeTypes.length < TYPE_KEYS.length) {
        body.types = activeTypes;
      }
      const d = await authedFetch("deal", body);
      if (dealRequestId.current === requestId) setDeal(d);
    } catch (e) {
      if (dealRequestId.current === requestId) setErr(e.message);
    } finally {
      if (dealRequestId.current === requestId) setBusy(false);
    }
  };

  // At least one type must stay on — silently ignores the click that
  // would uncheck the last active one, rather than allowing an
  // impossible-to-fill "no type" filter.
  const toggleType = (key) => {
    const activeCount = TYPE_KEYS.filter((k) => typeFilters[k]).length;
    if (typeFilters[key] && activeCount === 1) return;
    const next = { ...typeFilters, [key]: !typeFilters[key] };
    setTypeFilters(next);
    newDeal(batchMode, next);
  };

  const toggleBatchMode = () => {
    const next = !batchMode;
    setBatchMode(next);
    if (next && !explainerShownRef.current) {
      explainerShownRef.current = true;
      setShowBatchExplainer(true);
    } else if (!next) {
      setShowBatchExplainer(false);
    }
    newDeal(next);
  };

  // Swap out a bottle you don't recognize — server picks the replacement.
  // Allowed any time before resolve; clears that slot's pick, if any,
  // since the bottle it referred to no longer exists in this deal.
  const doSwap = async (idx) => {
    if (!deal || result || busy || swappingSlot !== null) return;
    const outgoing = deal.bottles[idx];
    setSwappingSlot(idx);
    setErr("");
    try {
      const res = await authedFetch("swap", { deal_id: deal.deal_id, slot: idx });
      setDeal((prev) => {
        const bottles = [...prev.bottles];
        bottles[idx] = res.replacement;
        return { ...prev, bottles };
      });
      setSwapsRemaining(res.swaps_remaining);
      setPicks((prev) => {
        if (!(outgoing.id in prev)) return prev;
        const next = { ...prev };
        delete next[outgoing.id];
        return next;
      });
    } catch (e) {
      setErr(e.message);
    } finally {
      setSwappingSlot(null);
    }
  };

  useEffect(() => {
    newDeal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const assign = (bottleId, role) => {
    if (result) return;
    setPicks((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (next[id] === role) delete next[id];
      }
      if (next[bottleId] === role) delete next[bottleId];
      else next[bottleId] = role;
      return next;
    });
  };

  useEffect(() => {
    const ids = Object.keys(picks);
    if (ids.length !== 3 || !deal || result || busy) return;
    const keep = ids.find((id) => picks[id] === "keep");
    const trade = ids.find((id) => picks[id] === "trade");
    const cut = ids.find((id) => picks[id] === "cut");
    if (!keep || !trade || !cut) return;
    (async () => {
      setBusy(true);
      setErr("");
      try {
        setResult(await authedFetch("resolve", {
          deal_id: deal.deal_id,
          keep,
          trade,
          cut,
        }));
      } catch (e) {
        setErr(e.message);
        setPicks({});
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks]);

  return (
    <>
      <nav style={S.nav}>
        <button
          className={"tab" + (view === "board" ? " tabOn" : "")}
          onClick={() => goView("board")}
        >
          Leaderboard
        </button>
        <Link to="/collection" className="tab">My Collection</Link>
        {isAnon ? (
          <button
            className={"tab" + (view === "upgrade" ? " tabOn" : "")}
            onClick={() => goView("upgrade")}
          >
            Sign in
          </button>
        ) : (
          <button className="tab" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        )}
      </nav>

      {view === "rank" && (
        <main style={S.main}>
          {err && <p style={{ ...S.hint, color: "#E8B45A" }}>{err}</p>}
          <div style={S.batchToggleRow}>
            <button
              type="button"
              className={"batchToggle" + (batchMode ? " batchToggleOn" : "")}
              onClick={toggleBatchMode}
              disabled={busy}
              aria-pressed={batchMode}
            >
              <span className="batchToggleDot" />
              BATCH MODE
            </button>
            {showBatchExplainer && (
              <span style={S.batchExplainer}>
                Head-to-head between specific batch releases.
              </span>
            )}
          </div>
          {/* Hidden/ignored while batch mode is on — a line already IS a
              type, there's nothing left to filter within one line. */}
          {!batchMode && (
            <div style={S.typeFilterRow}>
              {TYPE_KEYS.map((key) => {
                const isLastActive = typeFilters[key] && TYPE_KEYS.filter((k) => typeFilters[k]).length === 1;
                return (
                  <button
                    key={key}
                    type="button"
                    className={"typeChip" + (typeFilters[key] ? " typeChipOn" : "")}
                    onClick={() => toggleType(key)}
                    disabled={busy || isLastActive}
                    aria-pressed={typeFilters[key]}
                    title={isLastActive ? "At least one type must stay on" : undefined}
                  >
                    {TYPE_LABELS[key]}
                  </button>
                );
              })}
            </div>
          )}
          {/* The same-line backend picks ONE line per batch-mode deal, so
              naming it here isn't decorative — without this, three cards
              that all happen to look similar give no clue they're the
              SAME release line being compared head-to-head. */}
          {deal?.batch_mode && deal.bottles?.[0]?.parent_name && (
            <div style={S.batchLineBanner}>
              COMPARING: {deal.bottles[0].parent_name.toUpperCase()}
            </div>
          )}
          <div style={S.cardRow}>
            {(deal?.bottles ?? []).map((b, idx) => (
              <RankCard
                key={idx}
                variant="ranker"
                bottle={b}
                role={picks[b.id]}
                delta={result?.deltas?.[b.id]}
                imgUrl={imageUrlById.get(b.id) ?? null}
                onAssign={(r) => assign(b.id, r)}
                resolved={!!result}
                busy={busy}
                batchMode={deal?.batch_mode}
                onSwap={() => doSwap(idx)}
                swapsRemaining={swapsRemaining}
                swapBusy={swappingSlot !== null}
                swapping={swappingSlot === idx}
              />
            ))}
          </div>
          {!result && deal && (
            <div style={S.swapCounter}>
              {swapsRemaining} SWAP{swapsRemaining === 1 ? "" : "S"} LEFT
            </div>
          )}
          <div style={S.underRow}>
            {result ? (
              <button className="pourBtn" onClick={() => newDeal()}>
                NEXT POUR →
              </button>
            ) : (
              <div style={S.hint}>
                {busy
                  ? "Pouring…"
                  : "Assign one of each — Keep the best, Cut the worst."}
              </div>
            )}
          </div>
        </main>
      )}

      {view === "board" && <Leaderboard session={session} />}
      {view === "upgrade" && (
        <main style={S.main}>
          <AddEmail onDone={() => goView("rank")} />
        </main>
      )}
    </>
  );
}

// ---------------- Boards ----------------
function Leaderboard({ session }) {
  const [rows, setRows] = useState(null);
  // Table (ranked list) vs Map (price × rating scatter) — two projections of
  // the exact same parents-only board universe, toggled in the panel head.
  // Seeded from ?view=map so the "See your shelf on the map" entry point from
  // /collection lands directly on the Map (no extra tap).
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState(() => (searchParams.get("view") === "map" ? "map" : "table"));
  // childParentId maps a rankable CHILD's bottle_id → its parent's, so a
  // collection that contains a specific batch highlights the parent point on
  // the parents-only map (the board never shows the child as its own row).
  const [childParentId, setChildParentId] = useState(() => new Map());
  const [ownedBottleIds, setOwnedBottleIds] = useState(() => new Set());
  // bottle_id -> image_url, for the vote gate's round cards (deal payloads
  // carry no image_url, same client-side join Game does).
  const [imageUrlById, setImageUrlById] = useState(() => new Map());

  useEffect(() => {
    fetchLeaderboardCatalog(supabase, { rankableOnly: true }).then((catalog) => {
      const cp = new Map();
      for (const r of catalog) {
        if (r.bottles?.parent_id) cp.set(r.bottle_id, r.bottles.parent_id);
      }
      setChildParentId(cp);
      setImageUrlById(new Map(catalog.map((c) => [c.bottle_id, c.bottles?.image_url ?? null])));
      // Children stay off the leaderboard entirely — a line and each of its
      // batch releases would otherwise show up as 3-5 near-duplicate rows
      // back to back (same name, same distillery), drowning the rest of
      // the board in density/clutter for very little signal. Batches are
      // still fully rankable — just on the parent's own profile page (its
      // BATCHES table), plus Trade Calculator and Collection where picking
      // a specific batch is the point.
      const childCounts = new Map();
      // release_year lives on the individual batch release, not the line
      // itself (a line is a bourbon released across many years) — so
      // "recent" for a hidden-behind-a-badge parent has to mean "any of
      // its batches," tracked here as the newest one, not the parent's
      // own (usually null) release_year.
      const childMostRecentYear = new Map();
      for (const r of catalog) {
        if (r.bottles?.parent_id) {
          const pid = r.bottles.parent_id;
          childCounts.set(pid, (childCounts.get(pid) ?? 0) + 1);
          const y = r.bottles.release_year;
          if (y != null) {
            const prev = childMostRecentYear.get(pid);
            if (prev == null || y > prev) childMostRecentYear.set(pid, y);
          }
        }
      }
      // Rank recomputed within the parents-only set — a hidden child
      // shouldn't create a gap in the # column's numbering. Catalog already
      // arrives rating-desc, and filter() preserves that relative order.
      const parentsOnly = catalog
        .filter((r) => r.bottles?.parent_id == null)
        .map((r, i) => ({
          ...r,
          ratingRank: i + 1,
          childCount: childCounts.get(r.bottle_id) ?? 0,
          mostRecentChildYear: childMostRecentYear.get(r.bottle_id) ?? null,
        }));
      setRows(parentsOnly);
    });
  }, []);

  // The signed-in (or anonymous — guests can own a shelf too) user's
  // collection, for the Map's highlight. Same query shape Collection.jsx uses;
  // just the bottle_ids, since the map only needs "do they own this line."
  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    supabase
      .from("collections")
      .select("bottle_id")
      .eq("user_id", userId)
      .then(({ data }) => {
        if (!cancelled) setOwnedBottleIds(new Set((data ?? []).map((r) => r.bottle_id)));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Owned lines, projected onto the parents-only board: a batch the user owns
  // maps up to its parent's id, a standalone/parent maps to itself. A board
  // point is "yours" iff its bottle_id lands in this set.
  const ownedParentIds = useMemo(() => {
    const s = new Set();
    for (const id of ownedBottleIds) s.add(childParentId.get(id) ?? id);
    return s;
  }, [ownedBottleIds, childParentId]);

  const toggle = (
    <div style={S.mapToggle}>
      <button
        type="button"
        className={"segBtn" + (mode === "table" ? " segOn" : "")}
        onClick={() => setMode("table")}
        aria-pressed={mode === "table"}
      >
        Table
      </button>
      <button
        type="button"
        className={"segBtn" + (mode === "map" ? " segOn" : "")}
        onClick={() => setMode("map")}
        aria-pressed={mode === "map"}
      >
        Map
      </button>
    </div>
  );

  // One vote gate wraps BOTH modes, so first-visit gating and the session
  // unlock are shared across Table, Map, and the ?view=map entry (all of them
  // are this single Leaderboard mount). Toggling Table↔Map swaps the children
  // but never remounts the gate.
  return (
    <VoteGate session={session} imageUrlById={imageUrlById}>
      {mode === "table" ? (
        <Board title="BARREL RANKINGS" rows={rows} sortable headerRight={toggle} />
      ) : (
        <ValueMap title="BARREL RANKINGS" rows={rows} ownedParentIds={ownedParentIds} headerRight={toggle} />
      )}
    </VoteGate>
  );
}

// ---------------- Vote gate ----------------
// KTC-style first-visit gate: the board renders blurred behind a modal holding
// one real keep/trade/cut round. Completing the round writes a real vote and
// unlocks the board for the browser session (sessionStorage). Fail-open: any
// deal error, or a deal with fewer than three bottles, shows the board with no
// gate at all. /bottle/:slug is a separate route and is never wrapped by this.
const VOTE_GATE_KEY = "rh_vote_gate_v1";

function VoteGate({ session, imageUrlById, children }) {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem(VOTE_GATE_KEY) === "done";
    } catch {
      return false;
    }
  });
  const [deal, setDeal] = useState(null); // the trio to vote on (null until dealt)
  const [failOpen, setFailOpen] = useState(false); // deal errored/empty → no gate

  const authedFetch = useMemo(
    () => (path, body) =>
      fetch(`${FN_URL}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
        return data;
      }),
    [session?.access_token]
  );

  // Deal FIRST, blur on success: this way the common fail-open path (deal
  // error / empty) never flashes a gate — the board simply stays visible.
  // A plain cancelled flag (no mount-once ref) is what keeps this correct
  // under StrictMode's mount→unmount→remount: run 1's fetch is cancelled by
  // cleanup, run 2 re-deals and keeps the result. A ref guard would let run 2
  // bail while run 1's result is already discarded, and the gate would never
  // arm. Deal is idempotent (it doesn't write a round), so the extra dev-only
  // call is harmless.
  useEffect(() => {
    if (unlocked) return;
    if (!session?.access_token) {
      setFailOpen(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await authedFetch("deal", { batch_mode: false });
        if (cancelled) return;
        if (d?.bottles?.length >= 3) setDeal(d);
        else setFailOpen(true);
      } catch {
        if (!cancelled) setFailOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unlocked, authedFetch, session?.access_token]);

  const onComplete = useCallback(() => {
    try {
      sessionStorage.setItem(VOTE_GATE_KEY, "done");
    } catch {
      /* private mode / storage disabled — unlock for this mount anyway */
    }
    setUnlocked(true);
  }, []);

  const gateActive = !unlocked && !failOpen && !!deal;

  // Lock the page behind the modal while it's open — the blurred board is
  // pointer-events:none, but iOS still rubber-band-scrolls the body behind a
  // fixed overlay; freezing body overflow (plus the modal's overscroll
  // containment) stops the scroll bleed.
  useEffect(() => {
    if (!gateActive) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [gateActive]);

  return (
    <>
      {/* This wrapper interposes between Shell's centering column
          (align-items:center) and the board's <main>, so it has to REPLICATE
          that centering itself — otherwise <main> loses it. width:100% (not
          shrink-to-fit) keeps <main> at viewport width on mobile so the nowrap
          rows don't blow it out to their max-content (~608px) and clip the
          table; flex-column + align-items:center re-centers <main> (capped at
          its own max-width) on desktop, matching the pre-gate baseline. */}
      <div
        className={gateActive ? "gateBlurred" : undefined}
        style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}
        aria-hidden={gateActive || undefined}
      >
        {children}
      </div>
      {gateActive && (
        <div
          className="gateOverlay"
          role="dialog"
          aria-modal="true"
          aria-label="Cast a vote to see the rankings"
        >
          <div className="gateModal">
            <div style={S.gateHead}>
              <div style={S.gateKicker}>ONE POUR TO ENTER</div>
              <div style={S.gateTitle}>Cast a vote to see the rankings</div>
              <div style={S.gateSub}>Keep the best, cut the worst.</div>
            </div>
            <div style={S.gateBody}>
              <RankRound
                authedFetch={authedFetch}
                initialDeal={deal}
                imageUrlById={imageUrlById}
                onComplete={onComplete}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------- Value Map (price × rating scatter) ----------------
// The third launch view: the same parents-only board universe as the ranked
// table, reprojected as rating (eloToDisplayRating, the display number every
// surface shows) against LOG price (secondary → line → MSRP, resolved once in
// fetchLeaderboardCatalog — no parallel price math here). Price provenance is
// encoded in the mark, not just the tooltip: a real secondary_value plots as a
// SOLID point, an MSRP fallback as a HOLLOW one, because MSRP understates the
// street price on hyped bottles and would otherwise drop them falsely into the
// value corner. The signed-in user's own bottles are lifted out in gold.
const MAP_MARGIN = { top: 24, right: 16, bottom: 34, left: 44 };
// Human-friendly log ticks; only those inside the data's padded domain render.
const PRICE_TICKS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const fmtPriceTick = (n) => (n >= 1000 ? "$" + n / 1000 + "k" : "$" + n);

function ValueMap({ title, rows, ownedParentIds, headerRight }) {
  const [w, setW] = useState(0);
  const [active, setActive] = useState(null); // bottle_id of the tapped point
  // Field toggle: fade the full-catalog backdrop out, leaving only the user's
  // own points on the SAME fixed frame (geom is always full-field, below, so
  // nothing moves or rescales). Only offered when they actually have points to
  // isolate — backdrop-only is already the empty state.
  const [showField, setShowField] = useState(true);

  // Callback ref, not useRef + mount effect: the chart container only enters
  // the DOM once `rows` load (before that ValueMap renders a "Loading…"
  // branch). A one-shot mount effect would run while the ref is still null —
  // exactly the case when you land straight on Map via ?view=map — and never
  // attach the observer. A ref callback fires whenever the node mounts, so the
  // observer attaches the moment the chart appears, on either path.
  const roRef = useRef(null);
  const chartRef = useCallback((el) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) setW(Math.round(e.contentRect.width));
      });
      ro.observe(el);
      roRef.current = ro;
    }
  }, []);

  // Only priceable points can be placed on a log axis; every board bottle has
  // an MSRP fallback in practice, so this drops ~nothing, but stays honest.
  const points = useMemo(
    () => (rows ?? []).filter((r) => r.price != null && r.price > 0),
    [rows]
  );

  const geom = useMemo(() => {
    if (!w || points.length === 0) return null;
    // Near-square on a phone, widening to landscape on desktop — the vertical
    // axis stays tall enough to read the rating spread at any width.
    const h = Math.max(300, Math.min(Math.round(w * 0.62), 460));
    const plotL = MAP_MARGIN.left;
    const plotT = MAP_MARGIN.top;
    const plotW = w - MAP_MARGIN.left - MAP_MARGIN.right;
    const plotH = h - MAP_MARGIN.top - MAP_MARGIN.bottom;

    const prices = points.map((p) => p.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const loMin = Math.log10(minP * 0.85);
    const loMax = Math.log10(maxP * 1.12);
    const x = (price) => plotL + ((Math.log10(price) - loMin) / (loMax - loMin)) * plotW;

    const ratings = points.map((p) => eloToDisplayRating(p.rating));
    const maxR = Math.max(...ratings);
    // Clean-gridline top with GUARANTEED headroom: keep the tallest point at
    // ≤90% of the axis (maxR / 0.9) so it never crowds the top-corner cues,
    // regardless of where maxR happens to fall relative to a round thousand
    // (a plain ceil-to-1000 gave almost none when maxR sat just under one —
    // e.g. prod's ~8600 → 9000, only 4% clear). Floored at 2000 so the flat
    // local board (every rating 1500 → ~1202) still has room; clamped to the
    // display ceiling.
    const yMax = Math.min(DISPLAY_MAX, Math.max(2000, Math.ceil(maxR / 0.9 / 1000) * 1000));
    const y = (rating) => plotT + plotH - (rating / yMax) * plotH;

    const yStep = yMax <= 2000 ? 500 : 2000;
    const yTicks = [];
    for (let t = 0; t <= yMax; t += yStep) yTicks.push(t);
    const xTicks = PRICE_TICKS.filter((t) => t >= minP * 0.85 && t <= maxP * 1.12);

    return { h, plotL, plotT, plotW, plotH, x, y, yMax, yTicks, xTicks };
  }, [w, points]);

  const activePoint = active != null ? points.find((p) => p.bottle_id === active) : null;
  const ownedOnBoard = useMemo(
    () => points.filter((p) => ownedParentIds.has(p.bottle_id)),
    [points, ownedParentIds]
  );
  const hasOwnedPoints = ownedOnBoard.length > 0;
  // With no owned points, "hide field" would leave a blank chart — force the
  // field on so the toggle can never strand the user on an empty frame.
  const fieldShown = showField || !hasOwnedPoints;

  return (
    <main style={S.main}>
      <div style={S.panel}>
        <div style={S.panelHeadRow}>
          <span>{title}</span>
          {headerRight}
        </div>

        {rows === null && <p style={{ padding: 18 }}>Loading…</p>}
        {rows?.length === 0 && (
          <p style={{ padding: 18, fontSize: 14 }}>No rated bottles yet.</p>
        )}

        {rows?.length > 0 && (
          <div style={S.mapBody}>
            {hasOwnedPoints && (
              <div style={S.mapFieldRow}>
                <button
                  type="button"
                  className={"typeChip" + (showField ? " typeChipOn" : "")}
                  onClick={() => setShowField((v) => !v)}
                  aria-pressed={showField}
                  title="Fade the full catalog in or out, leaving just your bottles"
                >
                  Full catalog
                </button>
              </div>
            )}
            <div ref={chartRef} style={{ position: "relative", width: "100%" }}>
              {geom && (
                <svg
                  className="mapChart"
                  width={w}
                  height={geom.h}
                  style={{ display: "block", touchAction: "manipulation" }}
                  onClick={() => setActive(null)}
                >
                  {/* Horizontal gridlines + rating labels (recessive) */}
                  {geom.yTicks.map((t) => (
                    <g key={"y" + t}>
                      <line
                        x1={geom.plotL}
                        y1={geom.y(t)}
                        x2={geom.plotL + geom.plotW}
                        y2={geom.y(t)}
                        stroke="rgba(42,27,12,0.10)"
                        strokeWidth="1"
                      />
                      <text
                        x={geom.plotL - 6}
                        y={geom.y(t) + 3}
                        textAnchor="end"
                        fontSize="9"
                        fontFamily="Georgia, serif"
                        fill="#7A5A2E"
                      >
                        {t.toLocaleString("en-US")}
                      </text>
                    </g>
                  ))}
                  {/* X axis line + price ticks */}
                  <line
                    x1={geom.plotL}
                    y1={geom.plotT + geom.plotH}
                    x2={geom.plotL + geom.plotW}
                    y2={geom.plotT + geom.plotH}
                    stroke="rgba(42,27,12,0.28)"
                    strokeWidth="1"
                  />
                  {geom.xTicks.map((t) => (
                    <g key={"x" + t}>
                      <line
                        x1={geom.x(t)}
                        y1={geom.plotT + geom.plotH}
                        x2={geom.x(t)}
                        y2={geom.plotT + geom.plotH + 4}
                        stroke="rgba(42,27,12,0.28)"
                        strokeWidth="1"
                      />
                      <text
                        x={geom.x(t)}
                        y={geom.plotT + geom.plotH + 16}
                        textAnchor="middle"
                        fontSize="9"
                        fontFamily="Georgia, serif"
                        fill="#7A5A2E"
                      >
                        {fmtPriceTick(t)}
                      </text>
                    </g>
                  ))}
                  {/* Corner cues — the value story: up-and-left is the prize.
                      Seated in the top margin, above the plot area, so the
                      tallest point (bounded ≤90% up the axis) can never crowd
                      them. */}
                  <text
                    x={geom.plotL + 2}
                    y={geom.plotT - 7}
                    textAnchor="start"
                    fontSize="8"
                    letterSpacing="1.5"
                    fontFamily="Georgia, serif"
                    fill="#A6926B"
                  >
                    ◤ GREAT VALUE
                  </text>
                  <text
                    x={geom.plotL + geom.plotW - 2}
                    y={geom.plotT - 7}
                    textAnchor="end"
                    fontSize="8"
                    letterSpacing="1.5"
                    fontFamily="Georgia, serif"
                    fill="#A6926B"
                  >
                    TROPHY ◥
                  </text>
                  {/* Axis captions — X below, Y rotated up the left gutter,
                      same size/casing/color. */}
                  <text
                    x={geom.plotL + geom.plotW / 2}
                    y={geom.plotT + geom.plotH + 30}
                    textAnchor="middle"
                    fontSize="9"
                    letterSpacing="2"
                    fontFamily="Georgia, serif"
                    fill="#7A5A2E"
                  >
                    PRICE (LOG)
                  </text>
                  <text
                    transform={`rotate(-90 11 ${geom.plotT + geom.plotH / 2})`}
                    x={11}
                    y={geom.plotT + geom.plotH / 2}
                    textAnchor="middle"
                    fontSize="9"
                    letterSpacing="2"
                    fontFamily="Georgia, serif"
                    fill="#7A5A2E"
                  >
                    RATING
                  </text>

                  {/* Backdrop points (not yours), drawn first so yours sit on
                      top. Solid = real secondary price, hollow = MSRP estimate.
                      The whole layer fades on the field toggle; geom (the
                      frame/scales) is unaffected, so nothing moves. */}
                  <g
                    className="mapFieldLayer"
                    style={{ opacity: fieldShown ? 1 : 0, pointerEvents: fieldShown ? "auto" : "none" }}
                  >
                    {points
                      .filter((p) => !ownedParentIds.has(p.bottle_id))
                      .map((p) => {
                        const cx = geom.x(p.price);
                        const cy = geom.y(eloToDisplayRating(p.rating));
                        return p.priceIsFallback ? (
                          <circle
                            key={p.bottle_id}
                            cx={cx}
                            cy={cy}
                            r="4"
                            fill="none"
                            stroke="#7A5A2E"
                            strokeWidth="1.25"
                            opacity="0.6"
                          />
                        ) : (
                          <circle
                            key={p.bottle_id}
                            cx={cx}
                            cy={cy}
                            r="4"
                            fill="#7A5A2E"
                            opacity="0.5"
                          />
                        );
                      })}
                  </g>
                  {/* Your bottles — gold, larger, ringed; still solid/hollow
                      by price provenance so an MSRP-priced trophy isn't sold
                      as a value even when it's yours. */}
                  {points
                    .filter((p) => ownedParentIds.has(p.bottle_id))
                    .map((p) => {
                      const cx = geom.x(p.price);
                      const cy = geom.y(eloToDisplayRating(p.rating));
                      return p.priceIsFallback ? (
                        <circle
                          key={p.bottle_id}
                          cx={cx}
                          cy={cy}
                          r="6.5"
                          fill="#F1E6CE"
                          stroke="#E8B45A"
                          strokeWidth="2.25"
                        />
                      ) : (
                        <circle
                          key={p.bottle_id}
                          cx={cx}
                          cy={cy}
                          r="6.5"
                          fill="#E8B45A"
                          stroke="#2A1B0C"
                          strokeWidth="1.25"
                        />
                      );
                    })}
                  {/* Transparent hit targets, larger than the marks so a
                      point is tappable on a phone; owned last so they win the
                      overlap. When the field is hidden, only owned points stay
                      interactive (the faded backdrop shouldn't answer taps). */}
                  {(fieldShown ? points : ownedOnBoard).map((p) => (
                    <circle
                      key={"hit" + p.bottle_id}
                      cx={geom.x(p.price)}
                      cy={geom.y(eloToDisplayRating(p.rating))}
                      r="11"
                      fill="transparent"
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActive((cur) => (cur === p.bottle_id ? null : p.bottle_id));
                      }}
                    />
                  ))}
                </svg>
              )}

              {geom && activePoint && (
                <MapTooltip
                  p={activePoint}
                  left={geom.x(activePoint.price)}
                  top={geom.y(eloToDisplayRating(activePoint.rating))}
                  width={w}
                />
              )}
            </div>

            {/* Legend — provenance (solid/hollow) shown once, applies to both
                the oak backdrop and the gold "yours." */}
            <div style={S.mapLegend}>
              <span style={S.mapLegendItem}>
                <svg width="14" height="14" style={{ flexShrink: 0 }}>
                  <circle cx="7" cy="7" r="4" fill="#7A5A2E" opacity="0.7" />
                </svg>
                Secondary price
              </span>
              <span style={S.mapLegendItem}>
                <svg width="14" height="14" style={{ flexShrink: 0 }}>
                  <circle cx="7" cy="7" r="4" fill="none" stroke="#7A5A2E" strokeWidth="1.25" />
                </svg>
                MSRP estimate
              </span>
              <span style={S.mapLegendItem}>
                <svg width="16" height="16" style={{ flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="6" fill="#E8B45A" stroke="#2A1B0C" strokeWidth="1.25" />
                </svg>
                In your collection
              </span>
            </div>

            {ownedParentIds.size === 0 ? (
              <Link to="/collection" style={S.mapCta}>
                Add bottles to your collection to see where yours land →
              </Link>
            ) : (
              rows.every((r) => !ownedParentIds.has(r.bottle_id)) && (
                <div style={S.mapNote}>None of your bottles are on the board yet.</div>
              )
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// Tooltip card for a tapped/hovered point. Positioned in the container's pixel
// space (the svg is drawn at exactly the container width, so point coords map
// 1:1), clamped to stay on-screen, and is itself a link to the bottle profile
// — same "the whole thing is tappable to /bottle/:slug" rule as a board row.
function MapTooltip({ p, left, top, width }) {
  const CARD_W = 168;
  const clampedLeft = Math.max(6, Math.min(left - CARD_W / 2, width - CARD_W - 6));
  const below = top < 110;
  const style = {
    ...S.mapTip,
    width: CARD_W,
    left: clampedLeft,
    top: below ? top + 16 : undefined,
    bottom: below ? undefined : "calc(100% - " + (top - 12) + "px)",
  };
  const slug = p.bottles?.slug;
  const Tag = slug ? Link : "div";
  const tagProps = slug ? { to: `/bottle/${slug}` } : {};
  return (
    <Tag {...tagProps} style={style} onClick={(e) => e.stopPropagation()}>
      <div style={S.mapTipName}>{p.bottles?.name}</div>
      {p.bottles?.distillery && <div style={S.mapTipDist}>{p.bottles.distillery}</div>}
      <div style={S.mapTipStats}>
        <span style={S.mapTipRating}>{eloToDisplayRating(p.rating)}</span>
        <span style={S.mapTipPrice}>
          {fmtMoney(p.price)}
          {p.priceTag && <span style={S.mapTipTag}>{p.priceTag}</span>}
        </span>
        {p.value != null && <span style={S.mapTipValue}>VALUE {p.value}</span>}
      </div>
      {slug && <div style={S.mapTipLink}>View →</div>}
    </Tag>
  );
}

const CURRENT_YEAR = new Date().getFullYear();
// "Recent" = this year or last — a rolling 2-year window instead of a
// single-year cutoff, so the filter doesn't go from "12 bottles" to
// "0 bottles" the moment January hits; it degrades to just-last-year's
// releases for a while instead of emptying out entirely.
const RECENT_RELEASE_MIN_YEAR = CURRENT_YEAR - 1;

// Per-bottle effective price: secondary market when available, else MSRP
// (matches the fallback rule in TradeCalculator's effectivePrice).
function Board({ title, rows, empty, sortable = false, headerRight }) {
  const [sortKey, setSortKey] = useState("rating");
  const [sortDir, setSortDir] = useState("desc");
  // Filters only ever apply to the sortable (Leaderboard) board — MyBoard
  // was removed from the nav, so sortable is the only board left, but the
  // gate stays explicit rather than assuming there's only one caller.
  const [typeFilters, setTypeFilters] = useState({ bourbon: true, rye: true, other: true });
  const [recentOnly, setRecentOnly] = useState(false);
  const [showTierMarks, setShowTierMarks] = useState(true);

  const clickSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const toggleType = (key) => {
    const activeCount = TYPE_KEYS.filter((k) => typeFilters[k]).length;
    if (typeFilters[key] && activeCount === 1) return;
    setTypeFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Client-side — the catalog is already fully fetched (fetchLeaderboardCatalog
  // pulls every active bottle up front), so filtering here is just an array
  // filter, no re-fetch. Type defaults to 'bourbon' for the rare row missing
  // one rather than silently disappearing when its own filter chip is on.
  const filteredRows = useMemo(() => {
    if (!rows || !sortable) return rows;
    return rows.filter((r) => {
      if (!typeFilters[r.bottles?.type ?? "bourbon"]) return false;
      // A line's own release_year is usually null (it's the parent —
      // released across many years); "recent" means its own year OR any
      // hidden-behind-the-badge batch's year qualifies.
      if (recentOnly) {
        const ownYear = r.bottles?.release_year ?? 0;
        const childYear = r.mostRecentChildYear ?? 0;
        if (Math.max(ownYear, childYear) < RECENT_RELEASE_MIN_YEAR) return false;
      }
      return true;
    });
  }, [rows, sortable, typeFilters, recentOnly]);

  // rows (for a sortable board) already carry price/priceIsFallback/value/
  // ratingRank — fetchLeaderboardCatalog computes all of that once at fetch
  // time, independent of the active sort, using the same shared formula the
  // bottle profile page calls too.

  // Null price/value always sorts last, in both asc and desc.
  const displayRows = useMemo(() => {
    if (!filteredRows || !sortable) return filteredRows;
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = [...filteredRows];
    if (sortKey === "rating") {
      arr.sort((a, b) => dir * (a.rating - b.rating));
    } else if (sortKey === "price") {
      arr.sort((a, b) => {
        if (a.price == null && b.price == null) return 0;
        if (a.price == null) return 1;
        if (b.price == null) return -1;
        return dir * (a.price - b.price);
      });
    } else if (sortKey === "value") {
      arr.sort((a, b) => {
        if (a.value == null && b.value == null) return 0;
        if (a.value == null) return 1;
        if (b.value == null) return -1;
        return dir * (a.value - b.value);
      });
    }
    return arr;
  }, [filteredRows, sortKey, sortDir, sortable]);

  const finalRows = sortable ? displayRows : rows;
  const anyGraduated = finalRows?.some((r) => (r.rounds_played ?? 0) >= 10) ?? false;
  const filterActive = sortable && (TYPE_KEYS.some((k) => !typeFilters[k]) || recentOnly);
  const hasAnyRows = (rows?.length ?? 0) > 0;

  // KTC-style dynamic tiers: sort by rating desc, then walk the list in
  // SIZE-BOUNDED chunks — each tier holds between MIN_TIER and MAX_TIER
  // bottles, and within that size window we break at the LARGEST gap to
  // the next bottle (a relative comparison within the window, not a fixed
  // point threshold). A fixed threshold (the prior GAP_THRESHOLD=30
  // design) only works while ratings still cluster in a few widely
  // separated groups, e.g. the curator seed tiers — once real voting
  // smooths the distribution into a near-continuum (prod's adjacent gaps
  // are typically 1-5 points once rounds accumulate), no single fixed
  // number can tell "a real tier boundary" from ordinary rating noise; a
  // relative, size-bounded search is the only approach that still finds
  // meaningful breaks in a smooth curve. Grouping still runs on the
  // ROUNDED rating (matches what the RATING column displays), preserving
  // the earlier fix where raw-float boundary values could floor into the
  // wrong band.
  //
  // MIN_TIER=10, MAX_TIER=15 — tuned directly against prod's live
  // 145-bottle board (read via the anon REST API before this shipped):
  // yields 11 tiers sized 11-15, comfortably inside the 8-15 target.
  //
  // Tie-breaking: when several candidate breakpoints in the size window
  // have an equally large gap — most often because a whole run is tied
  // at the same rating, e.g. today's local seed priors — prefer the
  // LATEST candidate, i.e. consume as much of a uniform run as the
  // window allows before being forced elsewhere. Verified against the
  // six seed-tier priors: this keeps the two largest seed clusters
  // (1640, 1580 — 26 and 28 bottles) splitting cleanly along their own
  // boundary with no tier crossing into the next cluster; the smaller
  // 1520/1470 pair (38 and 30 bottles) still needs one boundary-crossing
  // tier to satisfy MIN_TIER — the expected trade-off the size bound
  // makes on a degenerate step distribution, not a bug.
  //
  // Bands only make sense against the default rating-desc order — asc
  // would put "Tier 1" at the bottom, and price/value sort scrambles
  // rating order entirely — so separators hide themselves in both cases
  // (see tierSeparators below) rather than draw something misleading.
  // Recomputed from finalRows (post type-filter, post Recent Releases),
  // so a rye-only board gets its own tier breaks instead of inheriting
  // gaps from the full catalog.
  const MIN_TIER = 10;
  const MAX_TIER = 15;

  const tierBands = useMemo(() => {
    if (!showTierMarks || !sortable || sortKey !== "rating" || sortDir !== "desc" || !finalRows?.length) {
      return [];
    }
    const ratings = finalRows.map((r) => Math.round(r.rating));
    const n = ratings.length;
    const bands = [];
    let start = 0;
    while (start < n) {
      const remaining = n - start;
      if (remaining <= MAX_TIER) {
        bands.push({ start, end: n - 1 });
        break;
      }
      let bestEnd = start + MIN_TIER - 1;
      let bestGap = -Infinity;
      for (let end = start + MIN_TIER - 1; end <= start + MAX_TIER - 1; end++) {
        const gap = ratings[end] - ratings[end + 1];
        if (gap >= bestGap) {
          bestGap = gap;
          bestEnd = end;
        }
      }
      bands.push({ start, end: bestEnd });
      start = bestEnd + 1;
    }
    return bands.map((b, idx) => ({ ...b, tierNumber: idx + 1 }));
  }, [finalRows, sortKey, sortDir, sortable, showTierMarks]);

  // Row index (the row a separator renders BEFORE) -> tier number. A plain
  // horizontal divider row, not a rotated right-edge label — the earlier
  // gutter-bracket version failed the squint test; a full-width row with
  // upright small-caps text reads at a glance from any column, and doesn't
  // need a minimum-row-count guard the way the vertical text did, so every
  // tier gets a clean label including 1-row ones.
  const tierSeparators = useMemo(() => {
    const map = new Map();
    tierBands.forEach((band) => map.set(band.start, band.tierNumber));
    return map;
  }, [tierBands]);

  const hdrStyle = (key, base) => ({
    ...base,
    color: sortKey === key ? "#A6521B" : "#7A5A2E",
  });
  const arrow = (key) => (sortKey === key ? (sortDir === "desc" ? " ▾" : " ▴") : "");

  return (
    <main style={S.main}>
      <div style={S.panel}>
        <div style={S.panelHeadRow}>
          <span>{title}</span>
          {headerRight}
        </div>

        {sortable && hasAnyRows && (
          <div style={S.leaderFilterRow}>
            {TYPE_KEYS.map((key) => {
              const isLastActive = typeFilters[key] && TYPE_KEYS.filter((k) => typeFilters[k]).length === 1;
              return (
                <button
                  key={key}
                  type="button"
                  className={"typeChip" + (typeFilters[key] ? " typeChipOn" : "")}
                  onClick={() => toggleType(key)}
                  disabled={isLastActive}
                  aria-pressed={typeFilters[key]}
                  title={isLastActive ? "At least one type must stay on" : undefined}
                >
                  {TYPE_LABELS[key]}
                </button>
              );
            })}
            <button
              type="button"
              className={"typeChip" + (recentOnly ? " typeChipOn" : "")}
              onClick={() => setRecentOnly((v) => !v)}
              aria-pressed={recentOnly}
            >
              Recent Releases
            </button>
            {filterActive && (
              <span style={S.leaderFilterCount}>
                {finalRows?.length ?? 0} bottle{finalRows?.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}

        {finalRows === null && <p style={{ padding: 18 }}>Loading…</p>}
        {finalRows?.length === 0 && (
          <p style={{ padding: 18, fontSize: 14 }}>
            {filterActive
              ? recentOnly
                ? `No bottles released in ${RECENT_RELEASE_MIN_YEAR} or later yet.`
                : "No bottles match this filter."
              : empty ?? "No rated bottles yet."}
          </p>
        )}
        {finalRows?.length > 0 && (
          <div style={S.colHeaderRow}>
            <span style={S.colHdrRank}>#</span>
            <span style={S.colHdrName}>BOTTLE</span>
            <span style={S.colHdrRecord} className="hideMobile">W–L</span>
            {sortable ? (
              <button
                type="button"
                className="sortHdr"
                style={hdrStyle("rating", S.colHdrRating)}
                onClick={() => clickSort("rating")}
              >
                RATING{arrow("rating")}
              </button>
            ) : (
              <span style={S.colHdrRating}>RATING</span>
            )}
            {sortable && (
              <button
                type="button"
                className="sortHdr hideMobile"
                style={hdrStyle("price", S.colHdrPrice)}
                onClick={() => clickSort("price")}
              >
                PRICE{arrow("price")}
              </button>
            )}
            {sortable && (
              <button
                type="button"
                className="sortHdr"
                style={hdrStyle("value", S.colHdrValue)}
                onClick={() => clickSort("value")}
              >
                VALUE{arrow("value")}
              </button>
            )}
          </div>
        )}
        {finalRows?.length > 0 && (
          <div>
            {finalRows.map((r, i) => {
              const provisional = anyGraduated && (r.rounds_played ?? 0) < 10;
              const rank = sortable ? r.ratingRank : i + 1;
              const slug = r.bottles?.slug;
              const tierNumber = tierSeparators.get(i);
              // Whole row is tappable to /bottle/:slug when we have one (only the
              // Leaderboard query selects slug). Sort-header clicks live in the
              // separate .colHeaderRow sibling above, never inside a .row, so
              // there's no click-bubbling conflict to guard against here.
              const RowTag = slug ? Link : "div";
              const rowProps = slug ? { to: `/bottle/${slug}` } : {};
              return (
                <Fragment key={i}>
                  {tierNumber != null && (
                    <div className="tierSeparator">
                      <span className="tierSeparatorLine" />
                      <span className="tierSeparatorLabel">TIER {tierNumber}</span>
                      <span className="tierSeparatorLine" />
                    </div>
                  )}
                  <RowTag className="row" {...rowProps}>
                    <span style={S.rankCell}>{rank}</span>
                    <span style={S.rowNameWrap}>
                      <span style={S.rowNameText}>{r.bottles?.name}</span>
                      <span style={S.rowDistText} className="hideMobile">{r.bottles?.distillery}</span>
                    </span>
                    {r.childCount > 0 && (
                      <span style={S.rowBatchBadge}>
                        {r.childCount} batch{r.childCount === 1 ? "" : "es"}
                        {/* Only under the active Recent Releases filter, and only
                            when it's a BATCH's year doing the qualifying (the line's
                            own release_year almost always is null) — explains why a
                            line with no date of its own showed up in a dated filter. */}
                        {recentOnly &&
                          (r.mostRecentChildYear ?? 0) >= RECENT_RELEASE_MIN_YEAR &&
                          (r.bottles?.release_year ?? 0) < RECENT_RELEASE_MIN_YEAR && (
                            <> · {r.mostRecentChildYear}</>
                          )}
                      </span>
                    )}
                    <span style={S.rowRecord} className="hideMobile rowRecordCell">{r.wins}–{r.losses}</span>
                    {/* Provisional (non-graduated, <10 rounds) is now a whisper:
                        the rating renders muted + regular-weight instead of a
                        "prov." token that crowded every name. Graduated rows
                        keep the bold dark treatment. Same number, fixed-width
                        right-aligned cell — no layout shift either way. */}
                    <span
                      style={provisional ? S.rowRatingProvisional : S.rowRating}
                      className="rowRatingCell"
                    >
                      {eloToDisplayRating(r.rating)}
                    </span>
                    {sortable && (
                      <span style={S.rowPrice} className="hideMobile rowPriceCell">
                        {r.price != null ? (
                          <>
                            {fmtMoney(r.price)}
                            {r.priceTag && <span style={S.priceTagStyle}>{r.priceTag}</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    )}
                    {sortable && (
                      <span style={S.rowValue} className="rowValueCell">{r.value != null ? r.value : "—"}</span>
                    )}
                  </RowTag>
                </Fragment>
              );
            })}
          </div>
        )}
        {sortable && finalRows?.length > 0 && (
          <div style={S.tierMarkToggleRow}>
            <button
              type="button"
              className="tierMarkToggle"
              onClick={() => setShowTierMarks((v) => !v)}
            >
              {showTierMarks ? "Hide" : "Show"} rating tier marks
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

// ---------------- Chrome ----------------
function Shell({ children, view, goView }) {
  return (
    <div style={S.page}>
      <style>{CSS}</style>
      <header style={S.header}>
        <div style={S.brand}>
          <span style={S.brandTop}>THE</span>
          <span style={S.brandMain}>RICKHOUSE</span>
          <span style={S.brandSub}>KEEP · TRADE · CUT</span>
        </div>
        <nav style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 14 }}>
          <button
            className={"tab" + (view === "rank" ? " tabOn" : "")}
            onClick={() => goView("rank")}
          >
            Rank Bottles
          </button>
          <Link to="/trade" className="tab">Trade Calculator</Link>
        </nav>
      </header>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, alignItems: "center" }}>
        {children}
      </div>
      <footer style={S.footer}>AGED IN CHARRED OAK · RATINGS BY ELO</footer>
    </div>
  );
}

const S = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #17100A 0%, #1E1409 55%, #17100A 100%)",
    color: "#F1E6CE",
    fontFamily: "'Georgia', 'Times New Roman', serif",
    display: "flex",
    flexDirection: "column",
  },
  header: { padding: "28px 20px 0", textAlign: "center" },
  brand: { display: "flex", flexDirection: "column", alignItems: "center" },
  brandTop: { fontSize: 11, letterSpacing: "0.5em", color: "#B08040" },
  brandMain: {
    fontSize: "clamp(34px, 7vw, 56px)", letterSpacing: "0.12em",
    fontWeight: 700, color: "#E8B45A", lineHeight: 1.05,
    textShadow: "0 2px 0 #5A3A12",
  },
  brandSub: {
    fontSize: 12, letterSpacing: "0.45em", color: "#C9A96E", marginTop: 6,
    borderTop: "1px solid #5A3A12", borderBottom: "1px solid #5A3A12",
    padding: "5px 14px",
  },
  nav: { display: "flex", justifyContent: "center", gap: 8, margin: "22px 0 8px", flexWrap: "wrap" },
  main: { flex: 1, padding: "10px 16px 30px", maxWidth: 1080, width: "100%", boxSizing: "border-box" },
  cardRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 18 },
  batchToggleRow: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 12, flexWrap: "wrap", marginBottom: 16,
  },
  batchExplainer: { fontSize: 12, color: "#C9A96E", fontStyle: "italic" },
  typeFilterRow: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 8, flexWrap: "wrap", marginBottom: 20,
  },
  batchLineBanner: {
    textAlign: "center", fontSize: 12, letterSpacing: "0.25em", fontWeight: 700,
    color: "#E8B45A", marginBottom: 16,
  },
  // The keep/trade/cut card (both photo + placeholder layouts, and their
  // ranker-size styles) now lives in the shared RankCard component, rendered
  // by both this ranker and the leaderboard vote gate (RankRound).
  swapCounter: { textAlign: "center", fontSize: 11, letterSpacing: "0.2em", color: "#7A5A2E", marginTop: 14 },
  underRow: { display: "flex", justifyContent: "center", marginTop: 24, minHeight: 48, alignItems: "center" },
  hint: { fontSize: 13, color: "#C9A96E", fontStyle: "italic", textAlign: "center" },
  panel: {
    background: "#F1E6CE", color: "#2A1B0C", border: "1px solid #8A6A3A",
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)", maxWidth: 720, margin: "10px auto", width: "100%",
    boxSizing: "border-box",
  },
  panelHead: {
    padding: "14px 18px", borderBottom: "2px solid #2A1B0C",
    fontSize: 13, letterSpacing: "0.3em", fontWeight: 700,
  },
  // Same bar as panelHead, now a flex row so a Table/Map toggle can sit
  // right-aligned opposite the title.
  panelHeadRow: {
    padding: "14px 18px", borderBottom: "2px solid #2A1B0C",
    fontSize: 13, letterSpacing: "0.3em", fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
  },
  // Sticky, not flex-pinned: the modal itself is the single scroll container
  // (see .gateModal), so the header lives IN the scroll flow — visible at open
  // (scrollTop 0) and staying put as the cards scroll under it. This is what
  // makes it reachable on iOS, where the old fixed header could sit above the
  // visible viewport with no way to scroll up to it.
  gateHead: {
    padding: "14px 18px 10px", borderBottom: "2px solid #2A1B0C",
    textAlign: "center", position: "sticky", top: 0, background: "#F1E6CE", zIndex: 1,
  },
  gateKicker: { fontSize: 10, letterSpacing: "0.4em", color: "#A6521B", fontWeight: 700 },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "#2A1B0C", marginTop: 6, lineHeight: 1.15 },
  gateSub: { fontSize: 12, color: "#7A5A2E", marginTop: 4, fontStyle: "italic" },
  gateBody: { padding: "12px 14px 16px" },
  mapToggle: { display: "inline-flex", gap: 0, flexShrink: 0 },
  mapBody: { padding: "14px 14px 18px" },
  mapFieldRow: { display: "flex", justifyContent: "flex-end", marginBottom: 6 },
  mapLegend: {
    display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: "center",
    marginTop: 12, fontSize: 11, color: "#5A4526",
  },
  mapLegendItem: { display: "inline-flex", alignItems: "center", gap: 5 },
  mapCta: {
    display: "block", textAlign: "center", marginTop: 12, fontSize: 12,
    color: "#A6521B", textDecoration: "none", fontStyle: "italic",
  },
  mapNote: {
    textAlign: "center", marginTop: 12, fontSize: 12, color: "#7A5A2E", fontStyle: "italic",
  },
  mapTip: {
    position: "absolute", zIndex: 3, background: "#2A1B0C", color: "#F1E6CE",
    border: "1px solid #8A6A3A", borderRadius: 6, padding: "8px 10px",
    boxShadow: "0 6px 18px rgba(0,0,0,0.5)", textDecoration: "none",
    fontFamily: "Georgia, serif", boxSizing: "border-box",
  },
  mapTipName: { fontSize: 13, fontWeight: 700, lineHeight: 1.2, color: "#F1E6CE" },
  mapTipDist: {
    fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase",
    color: "#C9A96E", marginTop: 2,
  },
  mapTipStats: {
    display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px", marginTop: 6,
  },
  mapTipRating: { fontSize: 15, fontWeight: 700, color: "#E8B45A", fontVariantNumeric: "tabular-nums" },
  mapTipPrice: { fontSize: 12, color: "#F1E6CE", fontVariantNumeric: "tabular-nums" },
  mapTipTag: { fontSize: 8, color: "#C9A96E", marginLeft: 3, letterSpacing: "0.05em", textTransform: "uppercase" },
  mapTipValue: { fontSize: 10, color: "#C9A96E", letterSpacing: "0.08em" },
  mapTipLink: { fontSize: 10, color: "#E8B45A", marginTop: 6, letterSpacing: "0.1em", textTransform: "uppercase" },
  // Fixed block, matching .tabOn's gold-fill/dark-numeral treatment —
  // every row gets the same contained rank cell, not just top finishers.
  rankCell: {
    width: 26, height: 26, minWidth: 26, flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "#E8B45A", color: "#2A1B0C", borderRadius: 4,
    fontWeight: 700, fontSize: 12, fontVariantNumeric: "tabular-nums",
  },
  // Name + distillery share one flex-truncating group so distillery gives
  // up its width (effectively drops) well before name has to ellipsis —
  // a much higher flexShrink ratio means distillery absorbs nearly all
  // the squeeze first. The batch badge is a sibling OUTSIDE this group
  // (fixed, never shrink), so it's never the thing that gets crowded out.
  rowNameWrap: {
    flex: 1, minWidth: 0, display: "flex", alignItems: "baseline",
    gap: 6, overflow: "hidden",
  },
  rowNameText: {
    minWidth: 0, flexShrink: 1, fontWeight: 600,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  rowDistText: {
    minWidth: 0, flexShrink: 20, fontWeight: 400, fontSize: 11, color: "#7A5A2E",
    overflow: "hidden", textOverflow: "clip", whiteSpace: "nowrap",
  },
  rowBatchBadge: {
    flexShrink: 0, whiteSpace: "nowrap",
    fontWeight: 700, fontSize: 8, color: "#A6521B",
    letterSpacing: "0.03em", textTransform: "uppercase",
    border: "1px solid #A6521B", borderRadius: 3, padding: "1px 3px",
  },
  // Demoted per the leaderboard overhaul review — lighter + smaller than
  // the rest of the row so RATING/PRICE/VALUE read as the primary numbers.
  rowRecord: {
    width: 56, flexShrink: 0, textAlign: "right", fontSize: 11, color: "#A6926B",
    fontVariantNumeric: "tabular-nums",
  },
  // rating keeps the row's one bold "anchor" weight; price/value are
  // regular weight at the same size as each other, all three hard
  // right-aligned with tabular figures so the columns actually line up.
  rowRating: {
    width: 54, flexShrink: 0, textAlign: "right", fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
  // Provisional whisper: same width/alignment as rowRating (no layout shift),
  // but muted + regular weight so a not-yet-graduated bottle's rating reads as
  // "still settling" without a "prov." label. Same muted tone as the demoted
  // W–L record cell.
  rowRatingProvisional: {
    width: 54, flexShrink: 0, textAlign: "right", fontWeight: 400,
    fontVariantNumeric: "tabular-nums", color: "#A6926B",
  },
  rowPrice: {
    width: 70, flexShrink: 0, textAlign: "right", fontWeight: 400, fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  rowValue: {
    width: 46, flexShrink: 0, textAlign: "right", fontWeight: 400, fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  },
  priceTagStyle: {
    fontSize: 9, color: "#B08040", marginLeft: 4,
    letterSpacing: "0.05em", textTransform: "uppercase",
  },
  leaderFilterRow: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 6, flexWrap: "wrap", padding: "8px 18px", borderBottom: "1px solid rgba(42,27,12,0.15)",
  },
  leaderFilterCount: {
    fontSize: 11, color: "#7A5A2E", fontStyle: "italic", marginLeft: 4,
  },
  tierMarkToggleRow: { textAlign: "center", padding: "8px 0 4px" },
  colHeaderRow: {
    display: "flex", alignItems: "baseline", gap: 10,
    padding: "6px 18px", borderBottom: "1px solid rgba(42,27,12,0.2)",
    fontSize: 9, letterSpacing: "0.2em", color: "#7A5A2E", fontWeight: 700,
    textTransform: "uppercase",
  },
  colHdrRank: { width: 26 },
  colHdrName: { flex: 1 },
  colHdrRecord: { width: 56, textAlign: "right" },
  colHdrRating: { width: 54, textAlign: "right" },
  colHdrPrice: { width: 70, textAlign: "right" },
  colHdrValue: { width: 46, textAlign: "right" },
  footer: { textAlign: "center", padding: "18px 10px 24px", fontSize: 10, letterSpacing: "0.35em", color: "#7A5A2E" },
};

const CSS = `
.tab { background: transparent; border: 1px solid #5A3A12; color: #C9A96E; padding: 8px 20px; font-family: Georgia, serif; font-size: 12px; letter-spacing: 0.25em; cursor: pointer; transition: all .15s; text-decoration: none; display: inline-block; }
.tab:hover { border-color: #B08040; color: #E8B45A; }
.tabOn { background: #E8B45A; color: #2A1B0C; border-color: #E8B45A; font-weight: 700; }
.batchToggle { display: inline-flex; align-items: center; gap: 8px; background: transparent; border: 1px solid #5A3A12; color: #C9A96E; padding: 7px 16px; font-family: Georgia, serif; font-size: 11px; letter-spacing: 0.2em; font-weight: 700; cursor: pointer; border-radius: 999px; transition: all .15s; }
.batchToggle:hover:not(:disabled) { border-color: #B08040; color: #E8B45A; }
.batchToggle:disabled { opacity: .5; cursor: default; }
.batchToggleDot { width: 8px; height: 8px; border-radius: 50%; background: #5A3A12; transition: background .15s; }
.batchToggleOn { background: #E8B45A; color: #2A1B0C; border-color: #E8B45A; }
.batchToggleOn .batchToggleDot { background: #2A1B0C; }
.typeChip { background: transparent; border: 1px solid #5A3A12; color: #C9A96E; padding: 5px 13px; font-family: Georgia, serif; font-size: 10px; letter-spacing: 0.16em; font-weight: 700; text-transform: uppercase; cursor: pointer; border-radius: 999px; transition: all .15s; }
/* Hover only on devices with a real hover pointer. On touch (mobile) the
   :hover state sticks after a tap; combined with .typeChipOn's #E8B45A
   background that made the hover's #E8B45A text gold-on-gold — the label
   went invisible once a chip was toggled back on. */
@media (hover: hover) { .typeChip:hover:not(:disabled) { border-color: #B08040; color: #E8B45A; } }
.typeChip:disabled { opacity: .4; cursor: not-allowed; }
.typeChipOn { background: #E8B45A; color: #2A1B0C; border-color: #E8B45A; }
.tab:focus-visible, .roleBtn:focus-visible, .pourBtn:focus-visible, .field:focus-visible, .sortHdr:focus-visible, .batchToggle:focus-visible, .typeChip:focus-visible { outline: 2px solid #E8B45A; outline-offset: 2px; }
/* Table/Map segmented toggle in the panel head. Small-caps pills sharing a
   border so they read as one control; the active side takes the gold fill. */
.segBtn { background: transparent; border: 1px solid #8A6A3A; color: #7A5A2E; padding: 4px 12px; font-family: Georgia, serif; font-size: 10px; letter-spacing: 0.18em; font-weight: 700; text-transform: uppercase; cursor: pointer; transition: all .15s; }
.segBtn:first-child { border-radius: 999px 0 0 999px; border-right: none; }
.segBtn:last-child { border-radius: 0 999px 999px 0; }
.segBtn:hover:not(.segOn) { color: #2A1B0C; border-color: #2A1B0C; }
.segOn { background: #2A1B0C; color: #E8B45A; border-color: #2A1B0C; }
/* Field toggle: the backdrop layer fades; the frame/axes stay put. */
.mapFieldLayer { transition: opacity .3s ease; }
@media (prefers-reduced-motion: reduce) { .mapFieldLayer { transition: none; } }
/* Vote gate: the board blurs behind a bottom-sheet modal (centered on wider
   screens). Only the board region blurs — the header nav stays live so the
   user can leave to Rank/Trade rather than being hard-trapped. */
.gateBlurred { filter: blur(4px); opacity: .55; pointer-events: none; user-select: none; }
/* Overlay height in dvh (not vh) so a bottom-sheet anchors to the VISIBLE
   viewport bottom on iOS, not the taller toolbar-hidden one. vh is the
   pre-dvh fallback. */
.gateOverlay { position: fixed; inset: 0; height: 100vh; height: 100dvh; z-index: 50; display: flex; align-items: flex-end; justify-content: center; background: rgba(10,6,2,0.74); overflow: hidden; }
/* The modal IS the scroll container that owns all its content (sticky header
   included), capped at 100dvh, so nothing can end up above the fold with no
   way to reach it. overscroll-behavior:contain keeps a bounce from chaining to
   the page behind. */
.gateModal { background: #F1E6CE; color: #2A1B0C; border: 1px solid #8A6A3A; border-radius: 14px 14px 0 0; width: 100%; max-width: 520px; max-height: 92vh; max-height: 100dvh; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; box-shadow: 0 -10px 40px rgba(0,0,0,0.5); animation: gateUp .25s ease; }
@media (min-width: 600px) { .gateOverlay { align-items: center; padding: 20px; } .gateModal { border-radius: 14px; max-height: 90dvh; box-shadow: 0 20px 50px rgba(0,0,0,0.55); } }
@keyframes gateUp { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.gateRedeal { background: none; border: none; color: #A6521B; font-family: Georgia, serif; font-size: 12px; letter-spacing: 0.04em; font-style: italic; cursor: pointer; padding: 6px; }
.gateRedeal:hover { color: #7A3A10; text-decoration: underline; }
.gateRedeal:focus-visible { outline: 2px solid #E8B45A; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .gateModal { animation: none; } }
.segBtn:focus-visible { outline: 2px solid #E8B45A; outline-offset: 2px; }
.sortHdr { background: none; border: none; padding: 0; margin: 0; font-family: inherit; font-size: inherit; font-weight: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; }
.sortHdr:hover { color: #E8B45A !important; }
/* Full-width divider row, not a rotated right-edge label — the earlier
   gutter-bracket version failed the squint test at any font size small
   enough to fit the gutter. Upright small-caps text reads at a glance
   from any column, deliberately shorter than a data row (no hover, not
   a Link — it's a divider, not a bottle) and shows at every width,
   including 380px, since a horizontal rule just fits. */
.tierSeparator { display: flex; align-items: center; gap: 10px; height: 20px; padding: 0 18px; box-sizing: border-box; }
.tierSeparatorLine { flex: 1; height: 1px; background: rgba(166,82,27,0.35); }
.tierSeparatorLabel { font-family: Georgia, serif; font-size: 9px; letter-spacing: 0.25em; text-transform: uppercase; font-weight: 700; color: #A6521B; white-space: nowrap; }
@media (max-width: 500px) {
  .hideMobile { display: none; }
  /* Tighter than desktop so Rank/Leaderboard/Collection/Sign in all sit on
     one row at narrow widths instead of wrapping a 4th tab to its own line. */
  .tab { padding: 8px 11px; font-size: 11px; letter-spacing: 0.1em; }
}
.label { background: #F1E6CE; box-shadow: 0 10px 30px rgba(0,0,0,0.45); transition: transform .18s, box-shadow .18s; }
.label:hover { transform: translateY(-3px); }
.label-keep  { box-shadow: 0 0 0 3px #3E7C4F, 0 10px 30px rgba(0,0,0,0.45); }
.label-trade { box-shadow: 0 0 0 3px #B08040, 0 10px 30px rgba(0,0,0,0.45); }
.label-cut   { box-shadow: 0 0 0 3px #A03325, 0 10px 30px rgba(0,0,0,0.45); opacity: .92; }
.roleBtn { flex: 1; padding: 9px 0; font-family: Georgia, serif; font-size: 11px; letter-spacing: 0.2em; font-weight: 700; cursor: pointer; background: transparent; border: 1px solid #8A6A3A; color: #7A5A2E; transition: all .12s; }
.roleBtn:hover:not(:disabled) { border-color: #2A1B0C; color: #2A1B0C; }
.roleBtn:disabled { cursor: default; opacity: .6; }
.roleBtn-keep.roleOn  { background: #3E7C4F; border-color: #3E7C4F; color: #F1E6CE; opacity: 1; }
.roleBtn-trade.roleOn { background: #B08040; border-color: #B08040; color: #2A1B0C; opacity: 1; }
.roleBtn-cut.roleOn   { background: #A03325; border-color: #A03325; color: #F1E6CE; opacity: 1; }
.pourBtn { background: #E8B45A; color: #2A1B0C; border: none; padding: 12px 34px; font-family: Georgia, serif; font-size: 13px; letter-spacing: 0.3em; font-weight: 700; cursor: pointer; transition: transform .12s; }
.pourBtn:hover { transform: translateY(-2px); }
.row { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 18px; border-bottom: 1px solid rgba(42,27,12,0.15); font-size: 13px; text-align: left; box-sizing: border-box; transition: transform .12s, box-shadow .12s, background .12s; }
a.row { text-decoration: none; color: inherit; cursor: pointer; }
a.row:hover { background: rgba(232,180,90,0.18); transform: translateY(-1px); box-shadow: 0 3px 8px rgba(0,0,0,0.15); position: relative; z-index: 1; }
a.row:focus-visible { outline: 2px solid #E8B45A; outline-offset: -2px; }
.tierMarkToggle { background: none; border: none; padding: 2px 6px; font-family: Georgia, serif; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #7A5A2E; cursor: pointer; }
.tierMarkToggle:hover { color: #A6521B; }
@media (prefers-reduced-motion: reduce) { .row { transition: none; } }
.field { padding: 9px 12px; font-family: Georgia, serif; font-size: 13px; background: #FFF9EC; border: 1px solid #8A6A3A; color: #2A1B0C; }
.delta { font-size: 14px; font-weight: 700; animation: pop .3s ease; }
@keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.swapX { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; border: 1px solid #8A6A3A; background: #F1E6CE; color: #7A5A2E; font-size: 13px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .12s; z-index: 2; }
.swapX:hover:not(:disabled) { border-color: #A03325; color: #A03325; }
.swapX:disabled { opacity: .35; cursor: default; }
.swapX:focus-visible { outline: 2px solid #E8B45A; outline-offset: 2px; }
.swapIn { animation: swapIn .3s ease; }
@keyframes swapIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .label, .pourBtn, .tab, .roleBtn, .swapX { transition: none; } .delta, .swapIn { animation: none; } }
`;
