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
// Between name and rating the card shows THREE stacked spec lines — type,
// proof, age — sourced from the deal/swap payload (type_label, proof /
// proof_display, age_band / age_years). Styled to the card's existing meta
// treatment; sized by the two knobs below. Both layouts (photo left-aligned,
// placeholder centered) use the same spec block; alignment is inherited.
//
// Variant differences that remain:
//   - swap button: ranker only (needs a positioned wrapper — .swapX is
//     position:absolute — which is why the wrapper sets position:relative only
//     when onSwap is present; a no-op on the gate);
//   - inner .swapIn div key: ranker keys it by bottle id so a swapped-in
//     replacement remounts and replays the swap-in animation; the gate never
//     swaps, so it stays position-keyed (no replay).
const ROLES = [
  { key: "keep", label: "KEEP" },
  { key: "trade", label: "TRADE" },
  { key: "cut", label: "CUT" },
];

// The two size knobs for the spec lines (font px per surface) — cheap to nudge
// after seeing prod. Spacing / letter-spacing / color follow the meta treatment.
const SPEC_FONT_GATE = 10;
const SPEC_FONT_RANKER = 12;

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

  // The three spec lines. TYPE: stored label else the enum, uppercased. PROOF:
  // batch mode shows "PART OF <line>" (preserved); else the real proof, else the
  // varies short form (proof_display), else a safe fallback. AGE: NAS when the
  // band says so, else the age floored to whole years (defensive — a stray
  // decimal can never render as "13.6 YEARS"), else VARIES.
  const typeLine = b.type_label ?? (b.type ?? "").toUpperCase();
  const proofLine =
    batchMode && b.parent_name
      ? `PART OF ${b.parent_name.toUpperCase()}`
      : b.proof != null
      ? `${b.proof} PROOF`
      : b.proof_display || "PROOF N/A";
  const ageLine =
    b.age_band === "nas"
      ? "NAS"
      : b.age_years != null
      ? `${Math.floor(Number(b.age_years))} YEARS`
      : "VARIES";
  const specStyle = {
    fontSize: variant === "ranker" ? SPEC_FONT_RANKER : SPEC_FONT_GATE,
    letterSpacing: "0.22em",
    lineHeight: 1.5,
    color: "#7A5A2E",
    textTransform: "uppercase",
  };
  const specLines = (
    <div style={s.specWrap}>
      <div style={specStyle}>{typeLine}</div>
      <div style={specStyle}>{proofLine}</div>
      <div style={specStyle}>{ageLine}</div>
    </div>
  );

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
              {specLines}
              <div style={s.ratingRowL}>{ratingContent}</div>
            </div>
          </div>
          {roleButtons}
        </div>
      ) : (
        // Placeholder card: centered monogram, centered text (spec lines
        // centered via the container), buttons below.
        <div key={innerKey} className="swapIn" style={s.cardInner}>
          <BottleImage
            bottle={{ name: b.name, image_url: null }}
            rating={b.rating}
            className={s.monogram}
          />
          <div style={s.dist}>{b.distillery}</div>
          <div style={s.name}>{b.name}</div>
          {specLines}
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
  ratingRowL: { margin: "8px 0 0", display: "flex", alignItems: "baseline", gap: 8 },
  cardInner: {
    border: "1px solid #8A6A3A", margin: 5, padding: "8px 12px 10px",
    textAlign: "center", display: "flex", flexDirection: "column",
  },
  dist: { fontSize: 9, letterSpacing: "0.3em", color: "#7A5A2E", textTransform: "uppercase" },
  name: { fontSize: 17, fontWeight: 700, color: "#2A1B0C", margin: "3px 0 0", lineHeight: 1.2 },
  specWrap: { margin: "4px 0 0", display: "flex", flexDirection: "column", gap: 2 },
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
  specWrap: { margin: "6px 0 0", display: "flex", flexDirection: "column", gap: 3 },
  ratingRow: { margin: "14px 0 12px", display: "flex", alignItems: "baseline", justifyContent: "center", gap: 8 },
  ratingNum: { fontSize: 30, fontWeight: 700, color: "#2A1B0C" },
  ratingCap: { fontSize: 9, letterSpacing: "0.3em", color: "#7A5A2E" },
  btnRow: { display: "flex", gap: 6, marginTop: "auto" },
  monogram: "w-14 h-14 rounded-md mx-auto mb-3 block text-lg",
  photoImg: "w-20 h-56 sm:w-24 sm:h-64 rounded-md block shrink-0",
};
