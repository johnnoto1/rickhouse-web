// KTC-style bottle info card for the leaderboard. Surfaces the essentials —
// full (never-truncated) name, image, display rating, rank, tier, age, proof,
// price, distillery/type — so a mobile user can identify a bottle without
// leaving the board. Renders in two presentation modes from ONE component:
//
//   mode="popover"  desktop / hover-capable: a fixed card anchored beside the
//                   hovered row, flipping side + clamping to stay in viewport.
//   mode="sheet"    touch: a bottom sheet over a dimmed backdrop, with a
//                   prominent "View Bottle" CTA (mobile tap no longer
//                   navigates on its own — the CTA does).
//
// Data-only: every field comes from the leaderboard row object already loaded
// (fetchLeaderboardCatalog widened to carry age_band/age_years/type_label/
// proof_display) — no per-open network fetch. Display rating is always via
// eloToDisplayRating; raw ELO never surfaces. Reuses the board's parchment/oak/
// gold tokens and the same muted provisional treatment the table uses.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import BottleImage from "./BottleImage.jsx";
import { eloToDisplayRating } from "./ratingDisplay.js";

const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-US");
const fmtProof = (p) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

// Age line, matching RankCard's rule (nas -> NAS, else floored whole years so a
// stray decimal never renders as "13.6 YEARS") but falling back to the coarse
// band when a parent line carries no exact age_years — e.g. "12–15 YR".
function ageLabel(b) {
  if (!b) return "—";
  if (b.age_band === "nas") return "NAS";
  if (b.age_years != null) return `${Math.floor(Number(b.age_years))} YR`;
  if (b.age_band) return `${b.age_band.replace("-", "–")} YR`;
  return "—";
}

function proofLabel(b) {
  if (!b) return "—";
  if (b.proof != null) return fmtProof(b.proof);
  return b.proof_display || "—";
}

function typeLabel(b) {
  if (!b) return "—";
  return b.type_label ?? (b.type ? b.type[0].toUpperCase() + b.type.slice(1) : "—");
}

const CARD_W = 320;

// The shared interior — identical in both modes; only the surrounding chrome
// (anchored wrapper vs backdrop+sheet+CTA) differs.
function CardInner({ row, rank, tierNumber, provisional }) {
  const b = row.bottles;
  const ratingStyle = provisional ? S.railRatingProvisional : S.railRating;
  return (
    <div style={S.body}>
      {/* Left rail: dark accent, big rank + display rating + tier. */}
      <div style={S.rail}>
        <div style={S.railKicker}>RANK</div>
        <div style={S.railRank}>{rank}</div>
        <div style={ratingStyle}>{eloToDisplayRating(row.rating)}</div>
        <div style={S.railRatingKicker}>RATING</div>
        {tierNumber != null && <div style={S.railTier}>TIER {tierNumber}</div>}
        {provisional && <div style={S.railProv}>PROVISIONAL</div>}
      </div>

      {/* Right panel: full name, image, and the compact stat grid. */}
      <div style={S.right}>
        <div style={S.name}>{b?.name}</div>
        {b?.distillery && <div style={S.dist}>{b.distillery}</div>}
        <div style={S.rightMain}>
          <BottleImage
            bottle={b}
            rating={row.rating}
            className="w-16 h-20 rounded"
            imageClassName="w-16 h-20 rounded block"
          />
          <div style={S.stats}>
            <Stat label="Type" value={typeLabel(b)} />
            <Stat label="Age" value={ageLabel(b)} />
            <Stat label="Proof" value={proofLabel(b)} />
            <Stat
              label="Price"
              value={
                row.price != null ? (
                  <>
                    {fmtMoney(row.price)}
                    {row.priceTag && <span style={S.priceTag}>{row.priceTag}</span>}
                  </>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{label}</div>
      <div style={S.statValue}>{value}</div>
    </div>
  );
}

export default function BottleCard({
  row,
  rank,
  tierNumber,
  provisional,
  mode,
  anchorRect,
  onClose,
  onPointerEnter,
  onPointerLeave,
}) {
  const cardRef = useRef(null);
  const dialogLabel = row?.bottles?.name ? `${row.bottles.name} — bottle info` : "Bottle info";

  // Escape closes in both modes. Focus return to the trigger is handled by the
  // caller (it owns the trigger node) via onClose.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ---- Popover mode: anchor beside the row, flip + clamp to the viewport ----
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (mode !== "popover" || !anchorRect) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 10;
    // Prefer the right of the row; flip left if it would overflow; clamp if
    // both sides are tight (very narrow desktop window).
    let left = anchorRect.right + gap;
    if (left + CARD_W > vw - 8) left = anchorRect.left - gap - CARD_W;
    left = Math.max(8, Math.min(left, vw - CARD_W - 8));
    // Vertical: align near the row, clamped so the measured card stays fully
    // on screen (repositions near the bottom edge, never clipped).
    const h = cardRef.current?.offsetHeight ?? 220;
    let top = Math.max(8, Math.min(anchorRect.top, vh - h - 8));
    setPos({ left, top });
  }, [mode, anchorRect]);

  if (mode === "sheet") {
    return <Sheet {...{ row, rank, tierNumber, provisional, onClose, dialogLabel }} />;
  }

  // Popover
  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={dialogLabel}
      style={{
        ...S.popover,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <CardInner row={row} rank={rank} tierNumber={tierNumber} provisional={provisional} />
    </div>
  );
}

// Bottom sheet: reuses the vote-gate overlay/modal pattern (dvh anchoring, slide
// up, dimmed backdrop). Backdrop tap and the × close; "View Bottle" navigates.
function Sheet({ row, rank, tierNumber, provisional, onClose, dialogLabel }) {
  const slug = row?.bottles?.slug;
  // Lock body scroll while the sheet is open; restore exactly what was there.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="bottleCardOverlay"
      onClick={onClose}
      // Backdrop is the click target; the sheet stops propagation below.
    >
      <div
        className="bottleCardSheet"
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="bottleCardX" onClick={onClose} aria-label="Close">
          ×
        </button>
        <CardInner row={row} rank={rank} tierNumber={tierNumber} provisional={provisional} />
        {slug && (
          <Link to={`/bottle/${slug}`} className="bottleCardCta">
            View Bottle
          </Link>
        )}
      </div>
    </div>
  );
}

const S = {
  popover: {
    position: "fixed",
    zIndex: 60,
    width: CARD_W,
    background: "#F1E6CE",
    color: "#2A1B0C",
    border: "1px solid #8A6A3A",
    borderRadius: 8,
    boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
    fontFamily: "Georgia, serif",
    overflow: "hidden",
    boxSizing: "border-box",
  },
  body: { display: "flex", alignItems: "stretch" },
  rail: {
    flex: "0 0 88px",
    background: "#2A1B0C",
    color: "#F1E6CE",
    padding: "12px 10px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    gap: 1,
  },
  railKicker: { fontSize: 8, letterSpacing: "0.3em", color: "#B08040", fontWeight: 700 },
  railRank: {
    fontSize: 30,
    fontWeight: 700,
    lineHeight: 1.05,
    color: "#E8B45A",
    fontVariantNumeric: "tabular-nums",
  },
  railRating: {
    fontSize: 18,
    fontWeight: 700,
    color: "#E8B45A",
    marginTop: 6,
    fontVariantNumeric: "tabular-nums",
  },
  // Provisional whisper — muted + regular weight, same tone the table uses.
  railRatingProvisional: {
    fontSize: 18,
    fontWeight: 400,
    color: "#A6926B",
    marginTop: 6,
    fontVariantNumeric: "tabular-nums",
  },
  railRatingKicker: { fontSize: 8, letterSpacing: "0.3em", color: "#B08040", fontWeight: 700 },
  railTier: {
    fontSize: 9,
    letterSpacing: "0.2em",
    color: "#C9A96E",
    fontWeight: 700,
    marginTop: 8,
    textTransform: "uppercase",
  },
  railProv: { fontSize: 7, letterSpacing: "0.18em", color: "#8A6A3A", fontWeight: 700, marginTop: 4 },
  right: { flex: 1, minWidth: 0, padding: "12px 14px" },
  name: { fontSize: 16, fontWeight: 700, lineHeight: 1.2, color: "#2A1B0C" },
  dist: {
    fontSize: 9,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    color: "#7A5A2E",
    marginTop: 3,
  },
  rightMain: { display: "flex", gap: 12, marginTop: 10, alignItems: "flex-start" },
  stats: {
    flex: 1,
    minWidth: 0,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px 10px",
    alignContent: "start",
  },
  stat: { minWidth: 0 },
  statLabel: { fontSize: 8, letterSpacing: "0.2em", color: "#7A5A2E", fontWeight: 700, textTransform: "uppercase" },
  statValue: {
    fontSize: 13,
    fontWeight: 600,
    color: "#2A1B0C",
    marginTop: 1,
    fontVariantNumeric: "tabular-nums",
  },
  priceTag: { fontSize: 8, color: "#B08040", marginLeft: 3, letterSpacing: "0.05em", textTransform: "uppercase" },
};
