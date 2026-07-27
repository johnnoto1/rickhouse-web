// CDN cache-busting for bottle photos.
//
// Bottle assets are overwritten IN PLACE in the storage bucket (same slug,
// same public URL — see whiskey-elo admin/reprocess_bottle_images_*.sh). An
// in-place overwrite never purges the CDN edge, so the bare public URL keeps
// serving the OLD bytes with cf-cache-status: HIT until the edge expires.
// Live evidence: the pappy-van-winkle-20-year neck fix was verifiable only
// through a hand-cache-busted URL; the live page stayed stale.
//
// So the app appends ?v=<image_version> — a value that changes on every
// overwrite. A new query string is a new URL to the browser and the CDN, so
// each overwrite busts itself the moment the version field is bumped.
//
// bottles.image_version is a timestamptz set by the admin pipeline on every
// storage write. NULL (never overwritten) deliberately yields the bare URL:
// those assets have no stale edge to bust, and leaving them unversioned keeps
// their existing cache entries warm instead of forcing a needless re-download.

// timestamptz -> epoch ms (short, stable, URL-safe). Also accepts a plain
// counter or opaque string, so the column could become an int later without
// touching any caller.
function versionToken(version) {
  if (version == null) return null;
  if (typeof version === "number") return String(version);
  const parsed = Date.parse(version);
  if (!Number.isNaN(parsed)) return String(parsed);
  const raw = String(version).trim();
  return raw ? encodeURIComponent(raw) : null;
}

// Idempotent: a URL that already carries a v= param is returned untouched, so
// it's safe to call at the fetch layer AND again at render time.
export function versionedImageUrl(url, version) {
  if (!url) return url;
  if (/[?&]v=/.test(url)) return url;
  const token = versionToken(version);
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${token}`;
}

// Row-level convenience: returns the bottle with its image_url versioned.
// Every query that feeds a BottleImage runs its rows through this, so no
// surface has to remember the rule (and the flattened bottle_id -> url maps
// in App.jsx carry an already-versioned string).
export function versionBottleImage(bottle) {
  if (!bottle?.image_url) return bottle;
  const versioned = versionedImageUrl(bottle.image_url, bottle.image_version);
  return versioned === bottle.image_url ? bottle : { ...bottle, image_url: versioned };
}
