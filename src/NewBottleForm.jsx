import { useState, useMemo } from "react";
import { supabase } from "./supabaseClient";

// Extracted verbatim from Collection.jsx (was defined inline there) so the
// shelf-scan flow can reuse the exact same proposals path for its "submit as
// new bottle" candidates — one implementation, not a reimplementation. The
// only addition is optional prefill props (initial*), which seed the form's
// starting state and nothing else; the submit/proposals logic is unchanged.

const NEW_BOTTLE_TYPE_KEYS = ["bourbon", "rye", "other"];
const NEW_BOTTLE_TYPE_LABELS = { bourbon: "Bourbon", rye: "Rye", other: "Other" };
const MIN_RELEASE_YEAR = 1990;

// v1: no bottles row is created here — this only writes a proposals row.
// The bottle enters the catalog (with a curator-set tier + pricing) only
// once accepted; see admin/review-proposals.sql.
export default function NewBottleForm({
  userId,
  catalog,
  onSubmitted,
  onCancel,
  initialName = "",
  initialDistillery = "",
  initialProof = "",
  initialNotes = "",
}) {
  const [name, setName] = useState(initialName);
  const [distillery, setDistillery] = useState(initialDistillery);
  const [proof, setProof] = useState(initialProof);
  const [parentSlug, setParentSlug] = useState("");
  const [type, setType] = useState("bourbon");
  const [releaseYear, setReleaseYear] = useState("");
  const [notes, setNotes] = useState(initialNotes);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const maxReleaseYear = new Date().getFullYear() + 1;

  // Current parents + parentable bottles = every parent_id-null bottle —
  // the depth-guard trigger only blocks a bottle that's ALREADY a child
  // from becoming a parent, so any standalone/parent bottle qualifies.
  const parentOptions = useMemo(
    () => catalog.filter((b) => b.parent_id == null).sort((a, b) => a.name.localeCompare(b.name)),
    [catalog]
  );
  const selectedParent = useMemo(
    () => (parentSlug ? catalog.find((b) => b.slug === parentSlug) : null),
    [parentSlug, catalog]
  );
  // A batch release doesn't get its own type choice — it's whatever the
  // line already is. Read-only display, not just a disabled selector, so
  // there's no forged-then-ignored value sitting in the payload either.
  const effectiveType = parentSlug ? selectedParent?.type ?? "bourbon" : type;

  const submit = async () => {
    if (!name.trim() || !distillery.trim()) {
      setError("Name and distillery are required.");
      return;
    }
    let releaseYearNum = null;
    if (releaseYear.trim()) {
      const y = Number(releaseYear.trim());
      if (!Number.isInteger(y) || releaseYear.trim().length !== 4 || y < MIN_RELEASE_YEAR || y > maxReleaseYear) {
        setError(`Release year must be a 4-digit year between ${MIN_RELEASE_YEAR} and ${maxReleaseYear}.`);
        return;
      }
      releaseYearNum = y;
    }
    setSubmitting(true);
    setError("");
    const payload = { name: name.trim(), distillery: distillery.trim(), type: effectiveType };
    if (proof.trim()) payload.proof = Number(proof);
    if (parentSlug) payload.parent_slug = parentSlug;
    if (releaseYearNum != null) payload.release_year = releaseYearNum;
    if (notes.trim()) payload.notes = notes.trim();

    const { error: err } = await supabase.from("proposals").insert({
      user_id: userId,
      type: "new_bottle",
      payload,
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    await onSubmitted();
  };

  return (
    <div>
      <button
        onClick={onCancel}
        className="text-xs text-stone-400 hover:text-amber-300 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
      >
        ← Back
      </button>
      <h3 className="font-serif text-amber-300 text-lg mb-3">Suggest a new bottle</h3>

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Name *</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Distillery *</label>
      <input
        value={distillery}
        onChange={(e) => setDistillery(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Proof (optional)</label>
      <input
        value={proof}
        onChange={(e) => setProof(e.target.value)}
        type="number"
        step="0.1"
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">
        This is a batch of… (optional)
      </label>
      <select
        value={parentSlug}
        onChange={(e) => setParentSlug(e.target.value)}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        <option value="">— standalone bottle —</option>
        {parentOptions.map((b) => (
          <option key={b.id} value={b.slug}>
            {b.name}
          </option>
        ))}
      </select>

      {parentSlug ? (
        <p className="text-xs text-stone-400 mb-3">
          Type: <span className="text-amber-300 font-semibold">{NEW_BOTTLE_TYPE_LABELS[effectiveType]}</span>, from the line
        </p>
      ) : (
        <>
          <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Type *</label>
          <div className="flex gap-2 mb-3">
            {NEW_BOTTLE_TYPE_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setType(key)}
                aria-pressed={type === key}
                className={
                  "flex-1 py-2 rounded-md border text-xs uppercase tracking-widest font-semibold focus:outline-none focus:ring-2 focus:ring-amber-500 " +
                  (type === key
                    ? "bg-amber-700 border-amber-600 text-stone-950"
                    : "border-stone-700 text-stone-400 hover:text-amber-300 hover:border-amber-700/60")
                }
              >
                {NEW_BOTTLE_TYPE_LABELS[key]}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Release year (optional)</label>
      <input
        value={releaseYear}
        onChange={(e) => setReleaseYear(e.target.value)}
        type="number"
        inputMode="numeric"
        min={MIN_RELEASE_YEAR}
        max={maxReleaseYear}
        placeholder="e.g. 2026"
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      <label className="block text-xs uppercase tracking-widest text-stone-400 mb-1">Notes (optional)</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        className="w-full bg-stone-950 border border-stone-700 rounded-md px-3 py-2 text-amber-100 mb-3 focus:outline-none focus:ring-2 focus:ring-amber-500"
      />

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="w-full py-2 rounded-md bg-amber-700 text-stone-950 font-semibold hover:bg-amber-600 disabled:opacity-50 text-sm uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        {submitting ? "Submitting…" : "Submit for review"}
      </button>
    </div>
  );
}
