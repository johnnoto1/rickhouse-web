import { useEffect, useRef, useState } from "react";
import BottleImage from "./BottleImage.jsx";
import { eloToDisplayRating } from "./ratingDisplay.js";

// One real keep/trade/cut round, extracted from Game's inline ranker so the
// Leaderboard vote gate can present a GENUINE round: the same deal/resolve
// edge functions, so it writes to `rounds` and is weighted anon ×0.5 by
// resolve, exactly like any vote — no reimplementation of the vote mechanics.
//
// NOTE — Game (App.jsx) still renders its own copy of this card/round markup.
// Consolidating Game onto this component is queued in the handoff small-pass
// queue; until it lands, keep the two card renderers in sync.
//
// Props:
//   authedFetch   — (path, body) => Promise, provided by the caller (VoteGate),
//                   which owns the auth token — so this stays session-agnostic
//   initialDeal   — the trio the gate already dealt (fail-open happens upstream)
//   imageUrlById  — Map(bottle_id -> image_url); deal payloads carry no image
//   onComplete    — called once the round resolves (the real vote landed)
const ROLES = [
  { key: "keep", label: "KEEP" },
  { key: "trade", label: "TRADE" },
  { key: "cut", label: "CUT" },
];

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
        {(deal?.bottles ?? []).map((b, idx) => {
          const role = picks[b.id];
          const d = result?.deltas?.[b.id];
          return (
            <div key={idx} className={"label" + (role ? " label-" + role : "")}>
              <div className="swapIn" style={S.cardInner}>
                <BottleImage
                  bottle={{ name: b.name, image_url: imageUrlById?.get(b.id) ?? null }}
                  rating={b.rating}
                  className="w-9 h-9 rounded-md mx-auto mb-1.5 block text-sm"
                />
                <div style={S.dist}>{b.distillery}</div>
                {/* Name + proof on one line; proof omitted entirely when null
                    (no "PROOF N/A"). */}
                <div style={S.name}>
                  {b.name}
                  {b.proof != null && <span style={S.proofInline}> · {b.proof} PROOF</span>}
                </div>
                <div style={S.ratingRow}>
                  <span style={S.ratingNum}>{eloToDisplayRating(d ? d.new_rating : b.rating)}</span>
                  <span style={S.ratingCap}>RATING</span>
                  {d && (() => {
                    const dd =
                      eloToDisplayRating(d.new_rating) - eloToDisplayRating(d.new_rating - d.change);
                    return (
                      <span className="delta" style={{ color: dd >= 0 ? "#3E7C4F" : "#A03325" }}>
                        {dd >= 0 ? "+" : ""}
                        {dd}
                      </span>
                    );
                  })()}
                </div>
                <div style={S.btnRow}>
                  {ROLES.map((r) => (
                    <button
                      key={r.key}
                      className={"roleBtn roleBtn-" + r.key + (role === r.key ? " roleOn" : "")}
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
  // Compact so three cards sit close to one mobile screen: small monogram,
  // tight padding, name+proof on one line. Role buttons stay full-size.
  cardInner: {
    border: "1px solid #8A6A3A", margin: 5, padding: "8px 12px 10px",
    textAlign: "center", display: "flex", flexDirection: "column",
  },
  dist: { fontSize: 9, letterSpacing: "0.3em", color: "#7A5A2E", textTransform: "uppercase" },
  name: { fontSize: 17, fontWeight: 700, color: "#2A1B0C", margin: "3px 0 0", lineHeight: 1.2 },
  proofInline: { fontSize: 11, fontWeight: 400, letterSpacing: "0.08em", color: "#7A5A2E" },
  ratingRow: { margin: "5px 0 7px", display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 },
  ratingNum: { fontSize: 22, fontWeight: 700, color: "#2A1B0C" },
  ratingCap: { fontSize: 8, letterSpacing: "0.3em", color: "#7A5A2E" },
  btnRow: { display: "flex", gap: 6, marginTop: "auto" },
  footer: { textAlign: "center", marginTop: 14, minHeight: 30, display: "flex", alignItems: "center", justifyContent: "center" },
  done: { fontSize: 13, color: "#3E7C4F", fontStyle: "italic", fontWeight: 700 },
  hint: { fontSize: 13, color: "#C9A96E", fontStyle: "italic" },
  err: { fontSize: 13, color: "#A03325", textAlign: "center", marginBottom: 8 },
};
