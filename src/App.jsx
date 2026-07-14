import { useState, useEffect, useMemo, useRef } from "react";
import { Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { supabase, FN_URL } from "./supabaseClient";
import TradeCalculator from "./TradeCalculator";
import Collection from "./Collection";
import Landing from "./Landing";
import BottleProfile from "./BottleProfile";
import AddEmail from "./AddEmail";
import { fetchLeaderboardCatalog } from "./leaderboardCatalog.js";

const ROLES = [
  { key: "keep", label: "KEEP" },
  { key: "trade", label: "TRADE" },
  { key: "cut", label: "CUT" },
];

const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/trade" element={<TradeCalculator />} />
      <Route path="/collection" element={<Collection />} />
      <Route path="/bottle/:slug" element={<BottleProfile />} />
      <Route path="/*" element={<RickhouseApp />} />
    </Routes>
  );
}

// URL <-> internal tab-view mapping. Kept as a plain lookup rather than
// separate <Route> entries so switching tabs never remounts Game (which
// would re-bootstrap the anon session and refetch the current deal).
const PATH_VIEW = { "/rank": "rank", "/leaderboard": "board", "/board": "mine" };
const VIEW_PATH = { rank: "/rank", board: "/leaderboard", mine: "/board" };

// ---------------- Root app ----------------
function RickhouseApp() {
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

  if (!ready) return <Shell><p style={S.hint}>Loading…</p></Shell>;
  if (!session) return <Shell><p style={S.hint}>Unable to start session. Please refresh.</p></Shell>;
  return <Shell session={session}><Game session={session} /></Shell>;
}

// ---------------- Game ----------------
function Game({ session }) {
  const location = useLocation();
  const navigate = useNavigate();
  // Seeded once from the URL on mount so deep links (/rank, /leaderboard,
  // /board) land on the right tab; subsequent tab clicks just update local
  // state + the URL, without remounting this component.
  const [view, setView] = useState(() => PATH_VIEW[location.pathname] ?? "rank");
  const goView = (key) => {
    setView(key);
    navigate(VIEW_PATH[key]);
  };
  const [deal, setDeal] = useState(null);
  const [picks, setPicks] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [swapsRemaining, setSwapsRemaining] = useState(2);
  const [swappingSlot, setSwappingSlot] = useState(null);
  const [batchMode, setBatchMode] = useState(false);
  // In-memory only (not localStorage) — resets on reload, matches the task's
  // "persists for the session" spec. Explainer shows on the first ever
  // enable in this session and never again, even after toggling off/on.
  const [showBatchExplainer, setShowBatchExplainer] = useState(false);
  const explainerShownRef = useRef(false);

  const isAnon = session?.user?.is_anonymous === true;

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

  // mode defaults to the current batchMode state; the toggle passes the
  // NEW value explicitly since setBatchMode hasn't re-rendered yet when it
  // also calls newDeal in the same click.
  const newDeal = async (mode = batchMode) => {
    setErr("");
    setBusy(true);
    setPicks({});
    setResult(null);
    setSwapsRemaining(2);
    try {
      setDeal(await authedFetch("deal", { batch_mode: mode }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
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
        {[
          ["rank", "Rank"],
          ["board", "Leaderboard"],
          ["mine", "My Board"],
        ].map(([k, label]) => (
          <button
            key={k}
            className={"tab" + (view === k ? " tabOn" : "")}
            onClick={() => goView(k)}
          >
            {label}
          </button>
        ))}
        <Link to="/trade" className="tab">Trade</Link>
        <Link to="/collection" className="tab">Collection</Link>
        {isAnon ? (
          <button
            className={"tab" + (view === "upgrade" ? " tabOn" : "")}
            onClick={() => setView("upgrade")}
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
          <div style={S.cardRow}>
            {(deal?.bottles ?? []).map((b, idx) => {
              const role = picks[b.id];
              const d = result?.deltas?.[b.id];
              return (
                <div
                  key={idx}
                  className={"label" + (role ? " label-" + role : "")}
                  style={{ position: "relative" }}
                >
                  {!result && (
                    <button
                      className="swapX"
                      disabled={swapsRemaining <= 0 || swappingSlot !== null}
                      onClick={() => doSwap(idx)}
                      aria-label={`Swap out ${b.name}`}
                      title={
                        swapsRemaining <= 0
                          ? "No swaps remaining"
                          : "Don't know this one? Swap it out"
                      }
                    >
                      {swappingSlot === idx ? "…" : "×"}
                    </button>
                  )}
                  <div key={b.id} className="swapIn" style={S.labelBorder}>
                    <div style={S.labelDistillery}>{b.distillery}</div>
                    <div style={S.labelName}>{b.name}</div>
                    <div style={S.labelMeta}>
                      {b.proof ? `${b.proof} PROOF` : "BATCH PROOF"}
                    </div>
                    <div style={S.labelRating}>
                      <span style={S.ratingNum}>
                        {d ? d.new_rating : b.rating}
                      </span>
                      <span style={S.ratingCap}>RATING</span>
                      {d && (
                        <span
                          className="delta"
                          style={{ color: d.change >= 0 ? "#3E7C4F" : "#A03325" }}
                        >
                          {d.change >= 0 ? "+" : ""}
                          {d.change}
                        </span>
                      )}
                    </div>
                    <div style={S.btnRow}>
                      {ROLES.map((r) => (
                        <button
                          key={r.key}
                          className={
                            "roleBtn roleBtn-" + r.key +
                            (role === r.key ? " roleOn" : "")
                          }
                          disabled={!!result || busy}
                          onClick={() => assign(b.id, r.key)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {!result && deal && (
            <div style={S.swapCounter}>
              {swapsRemaining} SWAP{swapsRemaining === 1 ? "" : "S"} LEFT
            </div>
          )}
          <div style={S.underRow}>
            {result ? (
              <button className="pourBtn" onClick={newDeal}>
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

      {view === "board" && <Leaderboard />}
      {view === "mine" && <MyBoard userId={session.user.id} />}
      {view === "upgrade" && (
        <main style={S.main}>
          <AddEmail onDone={() => goView("rank")} />
        </main>
      )}
    </>
  );
}

// ---------------- Boards ----------------
function Leaderboard() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    fetchLeaderboardCatalog(supabase).then((catalog) => {
      // Children stay off the leaderboard entirely — a line and each of its
      // batch releases would otherwise show up as 3-5 near-duplicate rows
      // back to back (same name, same distillery), drowning the rest of
      // the board in density/clutter for very little signal. Batches are
      // still fully rankable — just on the parent's own profile page (its
      // BATCHES table), plus Trade Calculator and Collection where picking
      // a specific batch is the point.
      const childCounts = new Map();
      for (const r of catalog) {
        if (r.bottles?.parent_id) {
          childCounts.set(r.bottles.parent_id, (childCounts.get(r.bottles.parent_id) ?? 0) + 1);
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
        }));
      setRows(parentsOnly);
    });
  }, []);
  return <Board title="BARREL RANKINGS" rows={rows} sortable />;
}

function MyBoard({ userId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    supabase
      .from("user_bottle_ratings")
      .select("rating, wins, losses, bottles(name, distillery)")
      .eq("user_id", userId)
      .order("rating", { ascending: false })
      .then(({ data }) => setRows(data ?? []));
  }, [userId]);
  return <Board title="YOUR SHELF" rows={rows} empty="Judge some pours first — your personal board builds from your own rounds." />;
}

// Per-bottle effective price: secondary market when available, else MSRP
// (matches the fallback rule in TradeCalculator's effectivePrice).
function Board({ title, rows, empty, sortable = false }) {
  const [sortKey, setSortKey] = useState("rating");
  const [sortDir, setSortDir] = useState("desc");

  const clickSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // rows (for a sortable board) already carry price/priceIsFallback/value/
  // ratingRank — fetchLeaderboardCatalog computes all of that once at fetch
  // time, independent of the active sort, using the same shared formula the
  // bottle profile page calls too.

  // Null price/value always sorts last, in both asc and desc.
  const displayRows = useMemo(() => {
    if (!rows || !sortable) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const arr = [...rows];
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
  }, [rows, sortKey, sortDir, sortable]);

  const finalRows = sortable ? displayRows : rows;
  const anyGraduated = finalRows?.some((r) => (r.rounds_played ?? 0) >= 10) ?? false;

  const hdrStyle = (key, base) => ({
    ...base,
    color: sortKey === key ? "#A6521B" : "#7A5A2E",
  });
  const arrow = (key) => (sortKey === key ? (sortDir === "desc" ? " ▾" : " ▴") : "");

  return (
    <main style={S.main}>
      <div style={S.panel}>
        <div style={S.panelHead}>{title}</div>
        {finalRows === null && <p style={{ padding: 18 }}>Loading…</p>}
        {finalRows?.length === 0 && (
          <p style={{ padding: 18, fontSize: 14 }}>
            {empty ?? "No rated bottles yet."}
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
        {finalRows?.map((r, i) => {
          const provisional = anyGraduated && (r.rounds_played ?? 0) < 10;
          const rank = sortable ? r.ratingRank : i + 1;
          const slug = r.bottles?.slug;
          // Whole row is tappable to /bottle/:slug when we have one (only the
          // Leaderboard query selects slug). Sort-header clicks live in the
          // separate .colHeaderRow sibling above, never inside a .row, so
          // there's no click-bubbling conflict to guard against here.
          const RowTag = slug ? Link : "div";
          const rowProps = slug ? { to: `/bottle/${slug}` } : {};
          return (
            <RowTag key={i} className="row" {...rowProps}>
              <span style={S.rowRank}>{rank}</span>
              <span style={S.rowName}>
                {r.bottles?.name}
                <span style={S.rowDist}> {r.bottles?.distillery}</span>
                {r.childCount > 0 && (
                  <span style={S.rowBatchBadge}>
                    {r.childCount} batch{r.childCount === 1 ? "" : "es"}
                  </span>
                )}
              </span>
              <span style={S.rowRecord} className="hideMobile">{r.wins}–{r.losses}</span>
              <span style={S.rowRating}>{Math.round(r.rating)}</span>
              {sortable && (
                <span style={S.rowPrice} className="hideMobile">
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
                <span style={S.rowValue}>{r.value != null ? r.value : "—"}</span>
              )}
              {provisional && (
                <span style={S.rowRoundsProvisional}>provisional</span>
              )}
            </RowTag>
          );
        })}
      </div>
    </main>
  );
}

// ---------------- Chrome ----------------
function Shell({ children }) {
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
          <Link to="/trade" className="tab">Trade Calculator</Link>
          <Link to="/collection" className="tab">Collection</Link>
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
  labelBorder: {
    border: "1px solid #8A6A3A", margin: 6, padding: "18px 14px 16px",
    textAlign: "center", display: "flex", flexDirection: "column",
    height: "calc(100% - 12px)", boxSizing: "border-box",
  },
  labelDistillery: { fontSize: 10, letterSpacing: "0.35em", color: "#7A5A2E", textTransform: "uppercase" },
  labelName: {
    fontSize: 22, fontWeight: 700, color: "#2A1B0C", margin: "10px 0 4px",
    lineHeight: 1.15, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "center",
  },
  labelMeta: { fontSize: 11, letterSpacing: "0.3em", color: "#7A5A2E" },
  labelRating: { margin: "14px 0 12px", display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 },
  ratingNum: { fontSize: 30, fontWeight: 700, color: "#2A1B0C" },
  ratingCap: { fontSize: 9, letterSpacing: "0.3em", color: "#7A5A2E" },
  btnRow: { display: "flex", gap: 6, marginTop: "auto" },
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
  rowRank: { width: 30, fontWeight: 700, color: "#A6521B" },
  rowName: { flex: 1, minWidth: 0, fontWeight: 600 },
  rowDist: { fontWeight: 400, fontSize: 11, color: "#7A5A2E", marginLeft: 6 },
  rowBatchBadge: {
    fontWeight: 700, fontSize: 9, color: "#A6521B", marginLeft: 6,
    letterSpacing: "0.05em", textTransform: "uppercase",
    border: "1px solid #A6521B", borderRadius: 3, padding: "1px 4px",
  },
  rowRecord: { width: 64, textAlign: "right", fontSize: 12, color: "#7A5A2E" },
  rowRating: { width: 58, textAlign: "right", fontWeight: 700 },
  rowPrice: { width: 72, textAlign: "right", fontSize: 13 },
  rowValue: { width: 50, textAlign: "right", fontWeight: 700 },
  priceTagStyle: {
    fontSize: 9, color: "#B08040", marginLeft: 4,
    letterSpacing: "0.05em", textTransform: "uppercase",
  },
  rowRoundsProvisional: { fontSize: 11, color: "#B08040", fontStyle: "italic" },
  colHeaderRow: {
    display: "flex", alignItems: "baseline", gap: 10,
    padding: "7px 18px", borderBottom: "1px solid rgba(42,27,12,0.2)",
    fontSize: 9, letterSpacing: "0.2em", color: "#7A5A2E", fontWeight: 700,
    textTransform: "uppercase",
  },
  colHdrRank: { width: 30 },
  colHdrName: { flex: 1 },
  colHdrRecord: { width: 64, textAlign: "right" },
  colHdrRating: { width: 58, textAlign: "right" },
  colHdrPrice: { width: 72, textAlign: "right" },
  colHdrValue: { width: 50, textAlign: "right" },
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
.tab:focus-visible, .roleBtn:focus-visible, .pourBtn:focus-visible, .field:focus-visible, .sortHdr:focus-visible, .batchToggle:focus-visible { outline: 2px solid #E8B45A; outline-offset: 2px; }
.sortHdr { background: none; border: none; padding: 0; margin: 0; font-family: inherit; font-size: inherit; font-weight: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; }
.sortHdr:hover { color: #E8B45A !important; }
@media (max-width: 500px) { .hideMobile { display: none; } }
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
.row { display: flex; align-items: baseline; gap: 10px; padding: 10px 18px; border-bottom: 1px solid rgba(42,27,12,0.15); font-size: 14px; text-align: left; }
.row:nth-child(odd) { background: rgba(42,27,12,0.03); }
a.row { text-decoration: none; color: inherit; cursor: pointer; }
a.row:hover { background: rgba(232,180,90,0.18); }
a.row:focus-visible { outline: 2px solid #E8B45A; outline-offset: -2px; }
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
