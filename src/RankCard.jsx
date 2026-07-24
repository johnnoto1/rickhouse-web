import BottleImage from "./BottleImage.jsx";
import { eloToDisplayRating } from "./ratingDisplay.js";

// One keep/trade/cut card — the SINGLE renderer for both the /rank ranker
// (Game, App.jsx) and the leaderboard vote gate (RankRound.jsx). It replaces
// the two hand-synced copies that used to live in those files.
//
// The two surfaces are deliberately DIFFERENT sizes (the gate is a compact
// modal card; the ranker is a large full-page card), so every font size and
// spacing is variant-specific — carried in the GATE/RANKER style tables below
// and selected by `variant`. Defaults reproduce the gate exactly; the ranker
// opts in to its larger sizing, the batch-aware proof line, the swap button,
// and the larger placeholder monogram.
//
// Structural differences preserved byte-for-byte:
//   - placeholder proof: gate shows it INLINE in the name (" · 90 PROOF"),
//     ranker shows it as a SEPARATE meta line (and never omits it — it has a
//     "PROOF N/A" fallback);
//   - swap button: ranker only (needs a positioned wrapper — .swapX is
//     position:absolute — which is why the wrapper always sets position:relative,
//     a no-op with no absolute children on the gate);
//   - inner .swapIn div key: ranker keys it by bottle id so a swapped-in
//     replacement remounts and replays the swap-in animation; the gate never
//     swaps, so it stays position-keyed (no replay), exactly as before.
const ROLES = [
  { key: "keep", label: "KEEP" },
  { key: "trade", label: "TRADE" },
  { key: "cut", label: "CUT" },
];

// Props:
//   bottle        — the dealt bottle: { id, name, distillery, proof, parent_name, rating }
//   role          — this bottle's current pick ("keep"|"trade"|"cut") or undefined
//   delta         — resolve's per-bottle delta { new_rating, change } or undefined
//   imgUrl        — image_url for this bottle, or null (placeholder card)
//   onAssign      — (roleKey) => void
//   resolved      — the round has resolved (disables buttons, hides swap)
//   busy          — a request is in flight (disables buttons)
//   variant       — "gate" (default) | "ranker"
//   batchMode     — ranker only: this deal's batch_mode flag (drives "PART OF …")
//   onSwap        — ranker only: presence enables the × swap button; () => void
//   swapsRemaining, swapBusy, swapping — ranker only: swap button state
export default function RankCard({
  bottle,
  role,
  delta,
  imgUrl,
  onAssign,
  resolved = false,
  busy = false,
  variant = "gate",
  batchMode = false,
  onSwap,
  swapsRemaining = 0,
  swapBusy = false,
  swapping = false,
}) {
  const s = variant === "ranker" ? RANKER : GATE;
  const b = bottle;

  // Gate: "{proof} PROOF", or null → the proof line is omitted entirely.
  // Ranker: batch-aware and never null (PROOF N/A fallback), matching Game's
  // former inline proofText exactly.
  const proofText =
    variant === "ranker"
      ? batchMode && b.parent_name
        ? `PART OF ${b.parent_name.toUpperCase()}`
        : b.proof
        ? `${b.proof} PROOF`
        : "PROOF N/A"
      : b.proof != null
      ? `${b.proof} PROOF`
      : null;

  // d.change is the raw ELO delta; re-derive the pre-round ELO from it so the
  // shown delta is the SAME display transform applied to both ends.
  const ratingContent = (
    <>
      <span style={s.ratingNum}>{eloToDisplayRating(delta ? delta.new_rating : b.rating)}</span>
      <span style={s.ratingCap}>RATING</span>
      {delta &&
        (() => {
          const dd =
            eloToDisplayRating(delta.new_rating) - eloToDisplayRating(delta.new_rating - delta.change);
          return (
            <span className="delta" style={{ color: dd >= 0 ? "#3E7C4F" : "#A03325" }}>
              {dd >= 0 ? "+" : ""}
              {dd}
            </span>
          );
        })()}
    </>
  );

  const roleButtons = (
    <div style={s.btnRow}>
      {ROLES.map((r) => (
        <button
          key={r.key}
          className={"roleBtn roleBtn-" + r.key + (role === r.key ? " roleOn" : "")}
          disabled={resolved || busy}
          onClick={() => onAssign(r.key)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  // Ranker keys the inner swapIn div by bottle id so a swap replays the
  // animation; the gate leaves it position-keyed (undefined), matching before.
  const innerKey = variant === "ranker" ? b.id : undefined;

  // position:relative only where the absolute .swapX button needs a containing
  // block (the ranker) — the gate has no swap button, so it stays static,
  // matching its pre-consolidation markup exactly.
  return (
    <div
      className={"label" + (role ? " label-" + role : "")}
      style={onSwap ? { position: "relative" } : undefined}
    >
      {onSwap && !resolved && (
        <button
          className="swapX"
          disabled={swapsRemaining <= 0 || swapBusy}
          onClick={onSwap}
          aria-label={`Swap out ${b.name}`}
          title={swapsRemaining <= 0 ? "No swaps remaining" : "Don't know this one? Swap it out"}
        >
          {swapping ? "…" : "×"}
        </button>
      )}
      {imgUrl ? (
        // Photo card: large bottle anchored left, text in a right column
        // (never under the bottle), buttons full-width below.
        <div key={innerKey} className="swapIn" style={s.photoInner}>
          <div style={s.photoTop}>
            <BottleImage
              bottle={{ name: b.name, image_url: imgUrl }}
              rating={b.rating}
              imageClassName={s.photoImg}
            />
            <div style={s.photoText}>
              <div style={s.distL}>{b.distillery}</div>
              <div style={s.nameL}>{b.name}</div>
              {proofText && <div style={s.metaL}>{proofText}</div>}
              <div style={s.ratingRowL}>{ratingContent}</div>
            </div>
          </div>
          {roleButtons}
        </div>
      ) : (
        // Placeholder card: centered monogram, centered text, buttons below.
        <div key={innerKey} className="swapIn" style={s.cardInner}>
          <BottleImage
            bottle={{ name: b.name, image_url: null }}
            rating={b.rating}
            className={s.monogram}
          />
          <div style={s.dist}>{b.distillery}</div>
          {variant === "ranker" ? (
            <>
              <div style={s.name}>{b.name}</div>
              <div style={s.meta}>{proofText}</div>
            </>
          ) : (
            <div style={s.name}>
              {b.name}
              {proofText && <span style={s.proofInline}> · {proofText}</span>}
            </div>
          )}
          <div style={s.ratingRow}>{ratingContent}</div>
          {roleButtons}
        </div>
      )}
    </div>
  );
}

// Compact modal card (leaderboard vote gate). Formerly RankRound.jsx's S.
const GATE = {
  photoInner: {
    border: "1px solid #8A6A3A", margin: 5, padding: "10px 12px 12px",
    display: "flex", flexDirection: "column",
  },
  photoTop: { display: "flex", gap: 12, marginBottom: 10 },
  photoText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", textAlign: "left" },
  distL: { fontSize: 9, letterSpacing: "0.3em", color: "#7A5A2E", textTransform: "uppercase" },
  nameL: { fontSize: 17, fontWeight: 700, color: "#2A1B0C", margin: "4px 0 2px", lineHeight: 1.2 },
  metaL: { fontSize: 11, letterSpacing: "0.25em", color: "#7A5A2E" },
  ratingRowL: { margin: "8px 0 0", display: "flex", alignItems: "baseline", gap: 8 },
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
  monogram: "w-9 h-9 rounded-md mx-auto mb-1.5 block text-sm",
  photoImg: "w-20 h-56 sm:w-24 sm:h-64 rounded-md block shrink-0",
};

// Large full-page card (the /rank ranker). Formerly App.jsx's card S keys.
const RANKER = {
  photoInner: {
    border: "1px solid #8A6A3A", margin: 6, padding: "14px 14px 16px",
    display: "flex", flexDirection: "column",
    height: "calc(100% - 12px)", boxSizing: "border-box",
  },
  photoTop: { display: "flex", gap: 12, marginBottom: 12 },
  photoText: {
    flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
    textAlign: "left", paddingRight: 18,
  },
  distL: { fontSize: 10, letterSpacing: "0.3em", color: "#7A5A2E", textTransform: "uppercase" },
  nameL: { fontSize: 19, fontWeight: 700, color: "#2A1B0C", margin: "4px 0 2px", lineHeight: 1.2 },
  metaL: { fontSize: 11, letterSpacing: "0.25em", color: "#7A5A2E" },
  ratingRowL: { margin: "8px 0 0", display: "flex", alignItems: "baseline", gap: 8 },
  cardInner: {
    border: "1px solid #8A6A3A", margin: 6, padding: "18px 14px 16px",
    textAlign: "center", display: "flex", flexDirection: "column",
    height: "calc(100% - 12px)", boxSizing: "border-box",
  },
  dist: { fontSize: 10, letterSpacing: "0.35em", color: "#7A5A2E", textTransform: "uppercase" },
  name: {
    fontSize: 22, fontWeight: 700, color: "#2A1B0C", margin: "10px 0 4px",
    lineHeight: 1.15, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "center",
  },
  meta: { fontSize: 11, letterSpacing: "0.3em", color: "#7A5A2E", minHeight: 26, lineHeight: 1.4 },
  ratingRow: { margin: "14px 0 12px", display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 },
  ratingNum: { fontSize: 30, fontWeight: 700, color: "#2A1B0C" },
  ratingCap: { fontSize: 9, letterSpacing: "0.3em", color: "#7A5A2E" },
  btnRow: { display: "flex", gap: 6, marginTop: "auto" },
  monogram: "w-14 h-14 rounded-md mx-auto mb-3 block text-lg",
  photoImg: "w-20 h-56 sm:w-24 sm:h-64 rounded-md block shrink-0",
};
