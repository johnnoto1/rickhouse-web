import { useState, useEffect } from "react";
import BottleImage from "./BottleImage.jsx";
import { eloToDisplayRating } from "./ratingDisplay.js";

// The gate modal centers and stops growing at ≥600px (see .gateModal's media
// query in App.jsx); that's exactly where the photo card's text column gains
// the room the 390 compact scale leaves empty, so it's the breakpoint the gate
// text steps up at. Kept in sync with that CSS boundary on purpose.
const GATE_DESKTOP_BREAKPOINT = 600;
// The /rank ranker goes comfortably multi-column (~350px cards) at ≥768px;
// that's where its text steps up and its cards compact. Mobile (<768, the
// stacked full-width layout) keeps RANKER exactly.
const RANKER_DESKTOP_BREAKPOINT = 768;

// Reactive min-width match. Client-only SPA (no SSR), but the window guard keeps
// the first render safe; re-renders on breakpoint cross so the gate swaps its
// size table live. Ranker never calls into a different table, so this only ever
// changes the gate.
function useMinWidth(px) {
  const [match, setMatch] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(`(min-width:${px}px)`).matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(min-width:${px}px)`);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return match;
}

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
// Role = the vote semantics (keep/trade/cut), unchanged. `aria` is the
// accessible name the button keeps regardless of what it shows visually.
const ROLES = [
  { key: "keep", aria: "Keep" },
  { key: "trade", aria: "Trade" },
  { key: "cut", aria: "Cut" },
];

// Button label parts, keyed by role (keep→1st, trade→2nd, cut→3rd). Split so
// the medal glyph scales independently of the ordinal text. Single constants —
// cheap to reskin (themed SVG medals) or resize later. Purely presentational;
// vote semantics untouched.
const ROLE_MEDALS = { keep: "🥇", trade: "🥈", cut: "🥉" };
const ROLE_LABELS = { keep: "1st", trade: "2nd", cut: "3rd" };
// Button label sizing knobs — multiples of the button's own font-size. Medal
// glyph sits on top; the ordinal reads as a small caption beneath it (stacked
// layout enforced in the button below). Ordinal is deliberately small so the
// buttons eat less card height.
const MEDAL_SCALE = 4;
const ORDINAL_SCALE = 1.2;

// The spec-line font is now a per-surface knob IN the style tables (s.specFont),
// alongside every other size, so the desktop gate can step it up with the rest
// of its text. Spacing / letter-spacing / color still follow the meta treatment.

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
  // Each surface steps up at its own desktop breakpoint; below it, the compact
  // base table (GATE / RANKER) is used verbatim so mobile stays measured-equal.
  const isDesktop = useMinWidth(variant === "ranker" ? RANKER_DESKTOP_BREAKPOINT : GATE_DESKTOP_BREAKPOINT);
  const s =
    variant === "ranker"
      ? isDesktop
        ? RANKER_DESKTOP
        : RANKER
      : isDesktop
      ? GATE_DESKTOP
      : GATE;
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
    fontSize: s.specFont,
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
          aria-label={r.aria}
          // Always stacked: medal on top, ordinal centered beneath it. A flex
          // column with centered alignment makes medal-left/text-right wrapping
          // impossible regardless of button width.
          style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px" }}
        >
          <span aria-hidden="true" style={{ fontSize: `${MEDAL_SCALE}em`, lineHeight: 1 }}>
            {ROLE_MEDALS[r.key]}
          </span>
          <span style={{ fontSize: `${ORDINAL_SCALE}em`, lineHeight: 1 }}>{ROLE_LABELS[r.key]}</span>
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
  specFont: 10,
  btnRow: { display: "flex", gap: 6, marginTop: "auto" },
  monogram: "w-9 h-9 rounded-md mx-auto mb-1.5 block text-sm",
  photoImg: "w-20 h-56 sm:w-24 sm:h-64 rounded-md block shrink-0",
};

// Desktop gate: same compact card + buttons/medals + image, but the TEXT column
// steps up toward the ranker's scale so it fills the roomy centered modal
// instead of floating in empty space beside the tall bottle. Only the text-size
// keys change — layout, padding, image, and button row are inherited from GATE
// unchanged. All knob-adjustable, like the rest of the table.
const GATE_DESKTOP = {
  ...GATE,
  distL: { ...GATE.distL, fontSize: 10 },
  nameL: { ...GATE.nameL, fontSize: 20 },
  ratingRowL: { ...GATE.ratingRowL, margin: "10px 0 0" },
  dist: { ...GATE.dist, fontSize: 10 },
  name: { ...GATE.name, fontSize: 20 },
  ratingNum: { ...GATE.ratingNum, fontSize: 27 },
  ratingCap: { ...GATE.ratingCap, fontSize: 9 },
  specFont: 12,
  // The whole point of the desktop step-up: the photo slot was h-64 (256px),
  // ~100px taller than the stepped text column, so the card had a huge blank
  // band between the rating and the buttons. Size the slot to the content
  // column height (~160px) instead — a tall bottle fills it large-but-contained
  // (object-contain), a squat one fills the width and lands near the same
  // height, and the card hugs its content (worst-case rating→button gap ≈ a
  // 1-line-name card, ~13px ≈ normal padding). Wider than the compact slot
  // (w-28) so the bottle reads substantial, not squat. Non-responsive on
  // purpose — GATE_DESKTOP is only ever selected at ≥600px.
  photoImg: "w-28 h-40 rounded-md block shrink-0",
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
  specFont: 12,
  btnRow: { display: "flex", gap: 6, marginTop: "auto" },
  monogram: "w-14 h-14 rounded-md mx-auto mb-3 block text-lg",
  photoImg: "w-20 h-56 sm:w-24 sm:h-64 rounded-md block shrink-0",
};

// Desktop ranker (≥768px). Two problems on desktop: the dist/spec/rating text
// was too small for the roomy card, and the cards carried a lot of dead
// vertical space — the photo card's h-64 (256px) image towered over its short
// text column (a ~100px gap before the buttons), while the placeholder's sparse
// stack (big monogram, minHeight-52 name, generous margins) made it the tallest
// card, which the photo then stretched to match. So this table (a) steps up
// dist/spec/rating — NAME STAYS — and (b) compacts BOTH layouts so their
// natural heights land close together and the whole row hugs content: a shorter
// image slot on the photo card, and a tighter monogram/name/margins on the
// placeholder. Grid-stretch + btnRow marginTop:auto still equalize heights and
// bottom-align the buttons across photo/placeholder/batch. All knob-adjustable.
const RANKER_DESKTOP = {
  ...RANKER,
  // text step-up (name unchanged: nameL 19 / name 22)
  distL: { ...RANKER.distL, fontSize: 12 },
  dist: { ...RANKER.dist, fontSize: 12 },
  ratingNum: { ...RANKER.ratingNum, fontSize: 34 },
  ratingCap: { ...RANKER.ratingCap, fontSize: 10 },
  specFont: 14,
  // compact the placeholder stack (was floating in blank field)
  cardInner: { ...RANKER.cardInner, padding: "12px 14px 12px" },
  monogram: "w-12 h-12 rounded-md mx-auto mb-2 block text-lg",
  name: { ...RANKER.name, minHeight: 40, margin: "6px 0 2px" },
  specWrap: { ...RANKER.specWrap, margin: "5px 0 0" },
  ratingRow: { ...RANKER.ratingRow, margin: "10px 0 10px" },
  // The photo card's height driver is the PLACEHOLDER (its monogram + stacked
  // text is the tallest real content), so the photo card fills DOWN to it with
  // the bottle image rather than leaving the old ~100px gap before the buttons.
  // Slot sized just under the compacted placeholder's natural height so the
  // placeholder stays the definer and the photo stretches only a hair. Wider
  // (w-28) so squat bottles letterbox less inside the tall slot. Non-responsive
  // — RANKER_DESKTOP only applies ≥768px.
  photoInner: { ...RANKER.photoInner, padding: "12px 14px 12px" },
  photoTop: { ...RANKER.photoTop, marginBottom: 10 },
  // Rating anchored to the BOTTOM of the text column (marginTop:auto) so the
  // right side fills to the tall bottle's base instead of stranding the rating
  // at the top with blank beneath it: distillery/name/spec read at the top, the
  // score sits just above the medal buttons.
  ratingRowL: { ...RANKER.ratingRowL, marginTop: "auto", marginBottom: 0 },
  photoImg: "w-28 h-[272px] rounded-md block shrink-0",
};
