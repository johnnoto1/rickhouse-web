import { useRef, useState } from "react";
import { supabase, FN_URL } from "./supabaseClient";
import BottleImage from "./BottleImage.jsx";
import NewBottleForm from "./NewBottleForm.jsx";
import ContributionGate from "./ContributionGate.jsx";
import SignInNudge from "./SignInNudge.jsx";

// Full-screen "Scan Shelf" flow (mobile-first, not a modal): upload a photo →
// scan-collection edge function reads it → review matched/ambiguous/unmatched
// → confirm writes owned rows to `collections` and routes any "new bottle"
// candidates through the existing NewBottleForm proposals path.
//
// Backend contract (deployed, do not re-derive): the caller uploads to the
// private 'shelf-scans' bucket under its own {uid}/ prefix, then POSTs
// { image_path } to /functions/v1/scan-collection with the user's JWT. The
// response carries { scan_id, matched, ambiguous, unmatched } — no rating
// fields, so nothing here shows a rating (BottleImage's placeholder colour is
// the only place a rating would matter, and it falls back gracefully).

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

// Mirrors storage.buckets.file_size_limit + the function's MAX_IMAGE_BYTES.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// Longest-edge cap for the client-side downscale — big enough to keep labels
// legible for the vision model, small enough that a re-encode lands under the
// cap in one or two quality steps.
const DOWNSCALE_MAX_DIM = 2048;
const JPEG_QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

// Sentinel for an ambiguous candidate resolved to "None of these — submit as
// new bottle" (distinct from a real bottle id and from null = undecided).
const NEW = "__new__";

// ---------- image prep ----------

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function loadBitmap(file) {
  // imageOrientation: "from-image" applies EXIF rotation so a phone-portrait
  // photo isn't re-encoded sideways. Falls back to an <img> for the rare
  // browser without createImageBitmap.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Client-side guard for the 8 MB cap. Files already under the cap upload
// untouched (no needless quality loss). Over-cap files are drawn to a canvas
// scaled so the longest edge is <= DOWNSCALE_MAX_DIM, then exported as JPEG at
// descending quality until one fits. Throws if nothing fits or decode fails —
// the caller turns that into a friendly error and does NOT upload.
async function prepareUpload(file) {
  if (file.size <= MAX_UPLOAD_BYTES) return file;

  const bitmap = await loadBitmap(file);
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = Math.min(1, DOWNSCALE_MAX_DIM / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (typeof bitmap.close === "function") bitmap.close();

  for (const q of JPEG_QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, q);
    if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
  }
  throw new Error("too-large");
}

// ---------- error mapping ----------

// Maps a scan-collection failure to a human message + a follow-up action.
// action: "retry" → offer another photo; "nudge" → the user's session can't
// scan (missing/guest), route to SignInNudge.
function mapFunctionError(status, errorText) {
  const text = (errorText ?? "").toLowerCase();
  if (status === 401 || (status === 403 && (text.includes("account") || text.includes("guest")))) {
    return {
      action: "nudge",
      message: "Scanning needs a full account. Add an email to continue — your collection carries over.",
    };
  }
  if (text.includes("exceeds") || text.includes("too large")) {
    return { action: "retry", message: "That photo's too large — try again and we'll shrink it." };
  }
  if (status === 502 || status === 500 || text.includes("identify") || text.includes("not configured")) {
    return { action: "retry", message: "Couldn't read that photo. Try better lighting or a closer shot." };
  }
  // Bad path, download failure, malformed request, or anything unforeseen —
  // never a raw string, always retryable.
  return { action: "retry", message: "Something went wrong reading that photo. Give it another try." };
}

// ---------- display helpers ----------

function scoreHint(score) {
  if (score >= 0.75) return "Strong match";
  if (score >= 0.6) return "Good match";
  return "Fair match";
}

function candidateLabel(c) {
  return [c.brand, c.expression].filter(Boolean).join(" ") || c.brand || "Unrecognized bottle";
}

function optionPrice(b) {
  const price = b.secondary_value ?? b.msrp_usd ?? null;
  return price != null ? money(price) : "no price data";
}

// ---------- component ----------

export default function ShelfScan({ session, userId, catalog, ownedCountByBottleId, onDone }) {
  // "upload" | "scanning" | "review" | "newbottles" | "error"
  const [phase, setPhase] = useState("upload");
  const [errorInfo, setErrorInfo] = useState(null); // { action, message }
  const [scan, setScan] = useState(null); // { scan_id, matched, ambiguous, unmatched }

  // Review selections, indexed positionally (NOT by bottle id — duplicates
  // legitimately share an id and each row toggles independently).
  const [matchedChecked, setMatchedChecked] = useState([]);
  const [ambiguousChoice, setAmbiguousChoice] = useState([]); // bottleId | NEW | null
  const [unmatchedKeep, setUnmatchedKeep] = useState([]);

  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState("");

  // New-bottle queue, resolved at confirm time and walked one form at a time.
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);

  const fileInputRef = useRef(null);

  const startReview = (data) => {
    const matched = data.matched ?? [];
    const ambiguous = data.ambiguous ?? [];
    const unmatched = data.unmatched ?? [];
    if (matched.length === 0 && ambiguous.length === 0 && unmatched.length === 0) {
      setErrorInfo({
        action: "retry",
        message: "We couldn't spot any bottles in that photo. Try better lighting or a closer shot.",
      });
      setPhase("error");
      return;
    }
    setScan({ ...data, matched, ambiguous, unmatched });
    setMatchedChecked(matched.map(() => true)); // pre-checked
    setAmbiguousChoice(ambiguous.map(() => null)); // none pre-selected
    setUnmatchedKeep(unmatched.map(() => true)); // pre-set to "submit as new"
    setInlineError("");
    setPhase("review");
  };

  const runScan = async (file) => {
    setPhase("scanning");
    setErrorInfo(null);

    let blob;
    try {
      blob = await prepareUpload(file);
    } catch {
      setErrorInfo({
        action: "retry",
        message: "That photo's too large and we couldn't shrink it — try a smaller one.",
      });
      setPhase("error");
      return;
    }

    const path = `${userId}/${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from("shelf-scans")
      .upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (upErr) {
      setErrorInfo({
        action: "retry",
        message: "Couldn't upload that photo — check your connection and try again.",
      });
      setPhase("error");
      return;
    }

    let res;
    try {
      res = await fetch(`${FN_URL}/scan-collection`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image_path: path }),
      });
    } catch {
      setErrorInfo({
        action: "retry",
        message: "Couldn't reach the scanner — check your connection and try again.",
      });
      setPhase("error");
      return;
    }

    let data = {};
    try {
      data = await res.json();
    } catch {
      /* leave data = {} — handled by the !res.ok branch or empty-scan guard */
    }
    if (!res.ok) {
      setErrorInfo(mapFunctionError(res.status, data?.error));
      setPhase("error");
      return;
    }
    startReview(data);
  };

  const onFileChange = (e) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file still fires onChange.
    e.target.value = "";
    if (file) runScan(file);
  };

  // Live confirm count — checked matched + ambiguous resolved to a CATALOG
  // option. Ambiguous left undecided or set to "new", and unmatched, never
  // count here (they write no collections row).
  const nMatched = matchedChecked.filter(Boolean).length;
  const nAmbiguousResolved = ambiguousChoice.filter((c) => c && c !== NEW).length;
  const confirmCount = nMatched + nAmbiguousResolved;
  const newBottleCount =
    ambiguousChoice.filter((c) => c === NEW).length + unmatchedKeep.filter(Boolean).length;

  const onConfirm = async () => {
    if (!scan) return;
    setSubmitting(true);
    setInlineError("");

    // 1. Owned rows — one batched insert. status 'sealed' (schema default,
    //    set explicitly), designation carried from the candidate when present.
    const inserts = [];
    scan.matched.forEach((m, i) => {
      if (matchedChecked[i]) {
        inserts.push({
          user_id: userId,
          bottle_id: m.bottle.id,
          status: "sealed",
          designation: m.candidate.release_designation ?? null,
        });
      }
    });
    scan.ambiguous.forEach((a, i) => {
      const choice = ambiguousChoice[i];
      if (choice && choice !== NEW) {
        inserts.push({
          user_id: userId,
          bottle_id: choice,
          status: "sealed",
          designation: a.candidate.release_designation ?? null,
        });
      }
    });

    if (inserts.length > 0) {
      const { error } = await supabase.from("collections").insert(inserts);
      if (error) {
        setSubmitting(false);
        setInlineError("Couldn't save those bottles — give it another try.");
        return;
      }
    }

    // 2. New-bottle candidates → sequential NewBottleForm queue.
    const nextQueue = [];
    scan.ambiguous.forEach((a, i) => {
      if (ambiguousChoice[i] === NEW) nextQueue.push(a.candidate);
    });
    scan.unmatched.forEach((u, i) => {
      if (unmatchedKeep[i]) nextQueue.push(u.candidate);
    });

    setSubmitting(false);
    if (nextQueue.length > 0) {
      setQueue(nextQueue);
      setQueueIndex(0);
      setPhase("newbottles");
    } else {
      onDone();
    }
  };

  const advanceQueue = () => {
    const next = queueIndex + 1;
    if (next >= queue.length) onDone();
    else setQueueIndex(next);
  };

  // ---------- render ----------

  if (phase === "upload") {
    return (
      <Frame>
        <ScanHeader title="Scan your shelf" onClose={onDone} />
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 text-center gap-4">
          <p className="text-amber-200/90 max-w-sm">
            Take a photo of your shelf — or pick one from your library — and we'll
            read the labels and match them to the catalog.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onFileChange}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-6 py-3 rounded-md bg-amber-600 text-stone-950 font-semibold uppercase tracking-widest text-sm hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            Choose a photo
          </button>
          <p className="text-stone-500 text-xs max-w-xs">
            Large photos are shrunk on your device before upload. Reading a shelf
            takes about 10–30 seconds.
          </p>
        </div>
      </Frame>
    );
  }

  if (phase === "scanning") {
    return (
      <Frame>
        <ScanHeader title="Scan your shelf" />
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div
            className="w-10 h-10 rounded-full border-2 border-amber-700/40 border-t-amber-400 animate-spin"
            role="status"
            aria-label="Reading your shelf"
          />
          <p className="text-amber-200 font-serif text-lg">Reading your shelf…</p>
          <p className="text-stone-500 text-xs">This usually takes 10–30 seconds.</p>
        </div>
      </Frame>
    );
  }

  if (phase === "error") {
    const info = errorInfo ?? { action: "retry", message: "Something went wrong." };
    return (
      <Frame>
        <ScanHeader title="Scan your shelf" onClose={onDone} />
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 text-center gap-5">
          {info.action === "nudge" ? (
            <div className="w-full max-w-md">
              <p className="text-amber-200/90 mb-4">{info.message}</p>
              <SignInNudge onDone={onDone} message={info.message} />
            </div>
          ) : (
            <>
              <p className="text-amber-200/90 max-w-sm">{info.message}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setErrorInfo(null);
                    setPhase("upload");
                  }}
                  className="px-5 py-2.5 rounded-md bg-amber-600 text-stone-950 font-semibold uppercase tracking-widest text-sm hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  Try another photo
                </button>
                <button
                  onClick={onDone}
                  className="px-5 py-2.5 rounded-md border border-stone-700 text-stone-300 uppercase tracking-widest text-sm hover:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </Frame>
    );
  }

  if (phase === "newbottles") {
    const cand = queue[queueIndex];
    const initialName = [cand.brand, cand.expression].filter(Boolean).join(" ");
    const initialNotes = [cand.release_designation, "from shelf scan"].filter(Boolean).join(" · ");
    const initialProof = cand.proof_visible != null ? String(cand.proof_visible) : "";
    return (
      <Frame>
        <ScanHeader title="Add new bottles" onClose={onDone} />
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-lg mx-auto">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs uppercase tracking-widest text-amber-500/80">
                New bottle {queueIndex + 1} of {queue.length}
              </span>
              <button
                onClick={advanceQueue}
                className="text-xs uppercase tracking-widest text-stone-400 hover:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded px-1"
              >
                Skip this one →
              </button>
            </div>
            {/* Non-anon by construction (scanning is gated), so the gate is a
                pass-through here — kept for defense in depth. */}
            <ContributionGate session={session} onDone={advanceQueue}>
              <NewBottleForm
                // Remount per queue item so each candidate's prefill takes.
                key={queueIndex}
                userId={userId}
                catalog={catalog}
                onSubmitted={advanceQueue}
                onCancel={advanceQueue}
                initialName={initialName}
                initialDistillery={cand.brand ?? ""}
                initialProof={initialProof}
                initialNotes={initialNotes}
              />
            </ContributionGate>
          </div>
        </div>
      </Frame>
    );
  }

  // phase === "review"
  const { matched, ambiguous, unmatched } = scan;
  const primaryLabel =
    confirmCount > 0
      ? `Add ${confirmCount} bottle${confirmCount === 1 ? "" : "s"} to collection`
      : newBottleCount > 0
      ? `Submit ${newBottleCount} new bottle${newBottleCount === 1 ? "" : "s"}`
      : "Nothing selected";
  const primaryDisabled = (confirmCount === 0 && newBottleCount === 0) || submitting;

  return (
    <Frame>
      <ScanHeader title="Review your shelf" onClose={onDone} />
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3">
        <div className="max-w-lg mx-auto space-y-6">
          {/* MATCHED */}
          {matched.length > 0 && (
            <section>
              <GroupHeading>Matched</GroupHeading>
              <div className="space-y-2">
                {matched.map((m, i) => {
                  const dupCount = matched.slice(0, i).filter((x) => x.bottle.id === m.bottle.id).length;
                  const alreadyOwned = (ownedCountByBottleId?.get(m.bottle.id) ?? 0) > 0;
                  return (
                    <label
                      key={i}
                      className="flex items-start gap-3 bg-amber-50 rounded-md border border-amber-200 px-3 py-2.5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={matchedChecked[i]}
                        onChange={() =>
                          setMatchedChecked((prev) => prev.map((v, j) => (j === i ? !v : v)))
                        }
                        className="mt-1 h-4 w-4 accent-amber-600"
                        aria-label={`Add ${m.bottle.name}`}
                      />
                      <BottleImage bottle={m.bottle} className="w-11 h-11 rounded text-xs" />
                      <div className="flex-1 min-w-0">
                        <div className="font-serif font-bold text-stone-900 leading-tight flex items-center gap-2">
                          <span className="truncate">{m.bottle.name}</span>
                          {dupCount > 0 && (
                            <span className="shrink-0 text-[10px] font-bold text-amber-800 border border-amber-500 rounded px-1">
                              ×{dupCount + 1}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] uppercase tracking-widest text-stone-500 mt-0.5">
                          {m.bottle.distillery}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-stone-600">
                          <span>{scoreHint(m.score)}</span>
                          {m.candidate.release_designation && (
                            <span className="text-[10px] uppercase tracking-wider text-amber-800 border border-amber-400 rounded px-1">
                              {m.candidate.release_designation}
                            </span>
                          )}
                          {alreadyOwned && (
                            <span className="text-[10px] uppercase tracking-wider text-stone-500">
                              already in collection
                            </span>
                          )}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          {/* AMBIGUOUS */}
          {ambiguous.length > 0 && (
            <section>
              <GroupHeading>Not sure — pick one</GroupHeading>
              <div className="space-y-3">
                {ambiguous.map((a, i) => (
                  <div key={i} className="bg-stone-900/60 border border-stone-800 rounded-md p-3">
                    <div className="text-sm text-amber-100 mb-0.5">
                      Read: <span className="font-semibold">{candidateLabel(a.candidate)}</span>
                    </div>
                    {a.candidate.release_designation && (
                      <div className="text-[11px] uppercase tracking-wider text-amber-400/80 mb-2">
                        {a.candidate.release_designation}
                      </div>
                    )}
                    <div className="space-y-1.5 mt-2">
                      {a.options.map((opt) => (
                        <label
                          key={opt.id}
                          className="flex items-center gap-2.5 bg-stone-950/60 border border-stone-800 rounded px-2.5 py-2 cursor-pointer"
                        >
                          <input
                            type="radio"
                            name={`amb-${i}`}
                            checked={ambiguousChoice[i] === opt.id}
                            onChange={() =>
                              setAmbiguousChoice((prev) => prev.map((v, j) => (j === i ? opt.id : v)))
                            }
                            className="h-4 w-4 accent-amber-600"
                          />
                          <span className="flex-1 min-w-0">
                            <span className="text-amber-100 font-serif truncate block">{opt.name}</span>
                            <span className="text-[11px] text-stone-500 flex items-center gap-2">
                              <span className="uppercase tracking-wider truncate">{opt.distillery}</span>
                              <span className="shrink-0">{optionPrice(opt)}</span>
                            </span>
                          </span>
                        </label>
                      ))}
                      <label className="flex items-center gap-2.5 px-2.5 py-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`amb-${i}`}
                          checked={ambiguousChoice[i] === NEW}
                          onChange={() =>
                            setAmbiguousChoice((prev) => prev.map((v, j) => (j === i ? NEW : v)))
                          }
                          className="h-4 w-4 accent-amber-600"
                        />
                        <span className="text-sm text-amber-300">None of these — submit as new bottle</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* UNMATCHED */}
          {unmatched.length > 0 && (
            <section>
              <GroupHeading>New to us</GroupHeading>
              <div className="space-y-2">
                {unmatched.map((u, i) => (
                  <label
                    key={i}
                    className="flex items-start gap-3 bg-stone-900/60 border border-stone-800 rounded-md px-3 py-2.5 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={unmatchedKeep[i]}
                      onChange={() =>
                        setUnmatchedKeep((prev) => prev.map((v, j) => (j === i ? !v : v)))
                      }
                      className="mt-1 h-4 w-4 accent-amber-600"
                      aria-label={`Submit ${candidateLabel(u.candidate)} as new bottle`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-amber-100">
                        Read: <span className="font-semibold">{candidateLabel(u.candidate)}</span>
                      </div>
                      {u.candidate.release_designation && (
                        <div className="text-[11px] uppercase tracking-wider text-amber-400/80 mt-0.5">
                          {u.candidate.release_designation}
                        </div>
                      )}
                      <div className="text-xs text-stone-500 mt-0.5">Submit as new bottle</div>
                    </div>
                  </label>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-stone-800 bg-stone-950 px-4 py-3">
        <div className="max-w-lg mx-auto">
          {inlineError && <p className="text-red-400 text-sm mb-2 text-center">{inlineError}</p>}
          {newBottleCount > 0 && confirmCount > 0 && (
            <p className="text-stone-500 text-[11px] text-center mb-2">
              Plus {newBottleCount} new bottle{newBottleCount === 1 ? "" : "s"} to submit next.
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={onDone}
              className="px-4 py-2.5 rounded-md border border-stone-700 text-stone-300 uppercase tracking-widest text-sm hover:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={primaryDisabled}
              className="flex-1 py-2.5 rounded-md bg-amber-600 text-stone-950 font-semibold uppercase tracking-widest text-sm hover:bg-amber-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              {submitting ? "Saving…" : primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </Frame>
  );
}

// ---------- small presentational bits ----------

// Module-scope (not defined inside the render body) so a state change never
// remounts the whole flow — a nested component identity changes every render.
function Frame({ children }) {
  return (
    <div className="fixed inset-0 z-50 bg-stone-950 text-amber-100 flex flex-col">
      {children}
    </div>
  );
}

function ScanHeader({ title, onClose }) {
  return (
    <div className="flex items-center justify-between border-b border-stone-800 px-4 py-3 shrink-0">
      <h2 className="font-serif text-amber-300 text-lg">{title}</h2>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close scan"
          className="text-stone-400 hover:text-amber-300 text-2xl leading-none px-1 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
        >
          ×
        </button>
      )}
    </div>
  );
}

function GroupHeading({ children }) {
  return (
    <h3 className="text-[11px] uppercase tracking-widest text-amber-500/70 mb-2">{children}</h3>
  );
}
