// Shared bottle thumbnail: renders bottles.image_url when present, else a
// deterministic placeholder (no image, no network request, no layout
// shift) — a tier-colored block from the bottle's rating band plus its
// initials. Deterministic so the same bottle always renders the same
// placeholder across a reload, not a random/hash-of-id color that would
// make placeholders feel buggy when they don't match anything visible.
//
// Used on every surface (ranker cards, vote-gate cards, bottle profile,
// collection, shelf scan).

// Real photos are 1000² transparent WebPs with a UNIFORM bottle height and
// ~15% dead vertical padding (measured: bottle ≈ 83–85% of the canvas,
// centered), plus wide horizontal padding since bottles are tall and narrow.
// At 1:1 in a slot the bottle only fills ~85% and floats. Scaling ~1.18×
// inside an overflow-hidden slot crops that dead margin so the bottle fills
// the slot HEIGHT: the tallest measured bottles (85%) fill almost exactly,
// the shortest (~83%) keep a hair of padding, and none clip the cap/base
// (worst-case crop ~1px of the 1000px canvas at the very tip). The slot keeps
// its caller-given size, so nothing about layout, alignment, or the
// placeholder tiles changes — only the photo grows within its box.
const IMAGE_ZOOM = 1.18;

// Same ELO floor as tradeValue.js (bottles at/below this are worth 0 in
// the convex formula) — reused here only as the bottom of the placeholder
// band, not the value math itself, so this file doesn't need to import it.
const TIER_BANDS = [
  { min: 1650, bg: "#78350f", fg: "#fde68a" }, // elite — gold on dark amber
  { min: 1500, bg: "#57534e", fg: "#e7e5e4" }, // high — silver on stone
  { min: 1350, bg: "#44403c", fg: "#d6d3d1" }, // mid — bronze on stone
  { min: -Infinity, bg: "#292524", fg: "#a8a29e" }, // base — muted
];

function tierColors(rating) {
  return TIER_BANDS.find((t) => rating >= t.min) ?? TIER_BANDS[TIER_BANDS.length - 1];
}

function initials(name) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

// bottle: needs `name` and `image_url`. `rating` is passed separately
// since callers source it from different shapes (catalog rows carry a
// flat `rating`, owned rows carry `bottle_ratings.rating`) — resolving
// that here would mean this component needs to know both query shapes.
// imageClassName (optional): the slot size for the PHOTO only — defaults to
// className. Lets a surface grow the photo without touching the placeholder
// size (e.g. the profile hero uses a bigger portrait slot). Placeholder
// always uses className, so its size never changes.
export default function BottleImage({ bottle, rating, className = "", imageClassName }) {
  if (bottle?.image_url) {
    return (
      <div className={`overflow-hidden shrink-0 ${imageClassName ?? className}`}>
        <img
          src={bottle.image_url}
          alt={bottle.name ?? ""}
          className="w-full h-full object-cover block"
          style={{ transform: `scale(${IMAGE_ZOOM})` }}
        />
      </div>
    );
  }

  const { bg, fg } = tierColors(rating ?? 1500);
  return (
    <div
      role="img"
      aria-label={bottle?.name ? `${bottle.name} (no photo)` : "No photo"}
      className={`flex items-center justify-center font-serif font-bold shrink-0 ${className}`}
      style={{ backgroundColor: bg, color: fg }}
    >
      {initials(bottle?.name)}
    </div>
  );
}
