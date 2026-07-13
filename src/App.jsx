import { useState, useEffect } from "react";
import { Routes, Route, Link } from "react-router-dom";
import { supabase, FN_URL } from "./supabaseClient";
import TradeCalculator from "./TradeCalculator";

const ROLES = [
  { key: "keep", label: "KEEP" },
  { key: "trade", label: "TRADE" },
  { key: "cut", label: "CUT" },
];

export default function App() {
  return (
    <Routes>
      <Route path="/trade" element={<TradeCalculator />} />
      <Route path="/*" element={<RickhouseApp />} />
    </Routes>
  );
}

// ---------------- Root app (auth-gated) ----------------
function RickhouseApp() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s)
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <Shell><p style={S.hint}>Loading…</p></Shell>;
  if (!session) return <Shell><SignIn /></Shell>;
  return <Shell session={session}><Game session={session} /></Shell>;
}

// ---------------- Auth ----------------
function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  const send = async () => {
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setErr(error.message);
    else setSent(true);
  };

  return (
    <div style={{ ...S.panel, maxWidth: 420, textAlign: "center" }}>
      <div style={S.panelHead}>ENTER THE RICKHOUSE</div>
      {sent ? (
        <p style={{ padding: 24 }}>
          Check your email — your sign-in link is on the way.
        </p>
      ) : (
        <div style={{ padding: 24 }}>
          <p style={{ marginTop: 0, fontSize: 14 }}>
            Sign in with a magic link to start ranking. Your votes shape the
            board.
          </p>
          <input
            className="field"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
          {err && <p style={{ color: "#A03325", fontSize: 13 }}>{err}</p>}
          <button className="pourBtn" style={{ marginTop: 14 }} onClick={send}>
            SEND LINK
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- Game ----------------
function Game({ session }) {
  const [view, setView] = useState("rank");
  const [deal, setDeal] = useState(null);
  const [picks, setPicks] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

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

  const newDeal = async () => {
    setErr("");
    setBusy(true);
    setPicks({});
    setResult(null);
    try {
      setDeal(await authedFetch("deal"));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
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
            onClick={() => setView(k)}
          >
            {label}
          </button>
        ))}
        <Link to="/trade" className="tab">Trade</Link>
        <button className="tab" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </nav>

      {view === "rank" && (
        <main style={S.main}>
          {err && <p style={{ ...S.hint, color: "#E8B45A" }}>{err}</p>}
          <div style={S.cardRow}>
            {(deal?.bottles ?? []).map((b) => {
              const role = picks[b.id];
              const d = result?.deltas?.[b.id];
              return (
                <div key={b.id} className={"label" + (role ? " label-" + role : "")}>
                  <div style={S.labelBorder}>
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
    </>
  );
}

// ---------------- Boards ----------------
function Leaderboard() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    supabase
      .from("bottle_ratings")
      .select("rating, wins, losses, rounds_played, bottles(name, distillery)")
      .gt("rounds_played", 0)
      .order("rating", { ascending: false })
      .limit(200)
      .then(({ data }) => setRows(data ?? []));
  }, []);
  return <Board title="BARREL RANKINGS" rows={rows} />;
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

function Board({ title, rows, empty }) {
  return (
    <main style={S.main}>
      <div style={S.panel}>
        <div style={S.panelHead}>{title}</div>
        {rows === null && <p style={{ padding: 18 }}>Loading…</p>}
        {rows?.length === 0 && (
          <p style={{ padding: 18, fontSize: 14 }}>
            {empty ?? "No rated bottles yet."}
          </p>
        )}
        {rows?.map((r, i) => (
          <div key={i} className="row">
            <span style={S.rowRank}>{i + 1}</span>
            <span style={S.rowName}>
              {r.bottles?.name}
              <span style={S.rowDist}> {r.bottles?.distillery}</span>
            </span>
            <span style={S.rowRecord}>{r.wins}–{r.losses}</span>
            <span style={S.rowRating}>{Math.round(r.rating)}</span>
          </div>
        ))}
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
        <nav style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
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
  rowRank: { width: 34, fontWeight: 700, color: "#A6521B" },
  rowName: { flex: 1, fontWeight: 600 },
  rowDist: { fontWeight: 400, fontSize: 11, color: "#7A5A2E", marginLeft: 6 },
  rowRecord: { width: 70, textAlign: "right", fontSize: 12, color: "#7A5A2E" },
  rowRating: { width: 64, textAlign: "right", fontWeight: 700 },
  footer: { textAlign: "center", padding: "18px 10px 24px", fontSize: 10, letterSpacing: "0.35em", color: "#7A5A2E" },
};

const CSS = `
.tab { background: transparent; border: 1px solid #5A3A12; color: #C9A96E; padding: 8px 20px; font-family: Georgia, serif; font-size: 12px; letter-spacing: 0.25em; cursor: pointer; transition: all .15s; text-decoration: none; display: inline-block; }
.tab:hover { border-color: #B08040; color: #E8B45A; }
.tabOn { background: #E8B45A; color: #2A1B0C; border-color: #E8B45A; font-weight: 700; }
.tab:focus-visible, .roleBtn:focus-visible, .pourBtn:focus-visible, .field:focus-visible { outline: 2px solid #E8B45A; outline-offset: 2px; }
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
.field { padding: 9px 12px; font-family: Georgia, serif; font-size: 13px; background: #FFF9EC; border: 1px solid #8A6A3A; color: #2A1B0C; }
.delta { font-size: 14px; font-weight: 700; animation: pop .3s ease; }
@keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .label, .pourBtn, .tab, .roleBtn { transition: none; } .delta { animation: none; } }
`;
