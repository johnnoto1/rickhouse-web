import { useEffect, useRef, useState } from "react";
import RankCard from "./RankCard.jsx";

// One real keep/trade/cut round, presented by the Leaderboard vote gate: the
// same deal/resolve edge functions Game uses, so it writes to `rounds` and is
// weighted anon ×0.5 by resolve, exactly like any vote — no reimplementation
// of the vote mechanics. The card itself is the shared RankCard (gate variant),
// the same component Game's ranker renders.
//
// Props:
//   authedFetch   — (path, body) => Promise, provided by the caller (VoteGate),
//                   which owns the auth token — so this stays session-agnostic
//   initialDeal   — the trio the gate already dealt (fail-open happens upstream)
//   imageUrlById  — Map(bottle_id -> image_url); deal payloads carry no image
//   onComplete    — called once the round resolves (the real vote landed)
export default function RankRound({ authedFetch, initialDeal, imageUrlById, onComplete }) {
  const [deal, setDeal] = useState(initialDeal);
  const [picks, setPicks] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Guards a re-deal ("I don't know these") against out-of-order responses,
  // same pattern as Game.newDeal.
  const dealRequestId = useRef(0);
  const completedRef = useRef(false);

  const assign = (bottleId, role) => {
    if (result || busy) return;
    setPicks((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) if (next[id] === role) delete next[id];
      if (next[bottleId] === role) delete next[bottleId];
      else next[bottleId] = role;
      return next;
    });
  };

  // Resolve the moment all three roles are assigned — the real vote.
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
        const res = await authedFetch("resolve", { deal_id: deal.deal_id, keep, trade, cut });
        setResult(res);
      } catch (e) {
        setErr(e.message);
        setPicks({});
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks]);

  // Completing the round unlocks the board — after a short beat so the voter
  // sees their pick's rating move (same delta treatment as the ranker).
  useEffect(() => {
    if (!result || completedRef.current) return;
    completedRef.current = true;
    const t = setTimeout(() => onComplete(), 1200);
    return () => clearTimeout(t);
  }, [result, onComplete]);

  // "I don't know these bottles" — a full re-deal of all three, not a
  // per-slot swap. A re-deal failure stays inline (the gate is already shown);
  // fail-open only governs the FIRST deal, upstream in VoteGate.
  const newTrio = async () => {
    if (busy) return;
    const reqId = ++dealRequestId.current;
    setBusy(true);
    setErr("");
    setPicks({});
    setResult(null);
    try {
      const d = await authedFetch("deal", { batch_mode: false });
      if (dealRequestId.current !== reqId) return;
      if (d?.bottles?.length >= 3) setDeal(d);
      else setErr("Couldn't deal a new trio — try again.");
    } catch (e) {
      if (dealRequestId.current === reqId) setErr(e.message);
    } finally {
      if (dealRequestId.current === reqId) setBusy(false);
    }
  };

  return (
    <div>
      {err && <p style={S.err}>{err}</p>}
      <div style={S.cards}>
        {(deal?.bottles ?? []).map((b, idx) => (
          <RankCard
            key={idx}
            bottle={b}
            role={picks[b.id]}
            delta={result?.deltas?.[b.id]}
            imgUrl={imageUrlById?.get(b.id) ?? null}
            onAssign={(r) => assign(b.id, r)}
            resolved={!!result}
            busy={busy}
          />
        ))}
      </div>

      <div style={S.footer}>
        {result ? (
          <span style={S.done}>Vote counted — opening the rankings…</span>
        ) : busy ? (
          <span style={S.hint}>Pouring…</span>
        ) : (
          <button type="button" className="gateRedeal" onClick={newTrio}>
            I don't know these bottles →
          </button>
        )}
      </div>
    </div>
  );
}

const S = {
  cards: { display: "flex", flexDirection: "column", gap: 8 },
  footer: { textAlign: "center", marginTop: 14, minHeight: 30, display: "flex", alignItems: "center", justifyContent: "center" },
  done: { fontSize: 13, color: "#3E7C4F", fontStyle: "italic", fontWeight: 700 },
  hint: { fontSize: 13, color: "#C9A96E", fontStyle: "italic" },
  err: { fontSize: 13, color: "#A03325", textAlign: "center", marginBottom: 8 },
};
