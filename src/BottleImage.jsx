// Shared bottle thumbnail: renders bottles.image_url when present, else a
// deterministic placeholder (no image, no network request, no layout
// shift) — a tier-colored block from the bottle's rating band plus its
// initials. Deterministic so the same bottle always renders the same
// placeholder across a reload, not a random/hash-of-id color that would
// make placeholders feel buggy when they don't match anything visible.
//
// Collection cards only for now (see 20260717000002 + the collection
// per-row frontend pass) — App.jsx's ranker and BottleProfile are a
// separate audit/deploy.

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
export default function BottleImage({ bottle, rating, className = "" }) {
  if (bottle?.image_url) {
    return (
      <img
        src={bottle.image_url}
        alt={bottle.name ?? ""}
        className={`object-cover ${className}`}
      />
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
