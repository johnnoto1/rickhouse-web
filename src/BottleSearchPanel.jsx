import { useEffect, useMemo, useRef, useState } from "react";
import BottleImage from "./BottleImage.jsx";
import { searchBottles } from "./bottleSearch.js";

// Inline catalog search used by every correctable row on the shelf-scan review
// screen. Deliberately INLINE rather than a modal: the user is comparing what
// the scan guessed against the bottle in their hand, and a full-screen sheet
// hides the row being corrected. On a phone that context is the whole task.
//
// The catalog is already in memory (passed down from Collection), so filtering
// is local and the debounce exists only to keep keystrokes from re-rendering a
// long list — there is no network call per keystroke.
export default function BottleSearchPanel({
  catalog,
  onPick,
  onCancel,
  placeholder = "Search bottle or distillery…",
  autoFocus = true,
  testId,
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const results = useMemo(() => searchBottles(debounced, catalog), [debounced, catalog]);
  const typed = debounced.trim().length > 0;

  return (
    <div
      className="mt-2 rounded-md border border-amber-700/50 bg-stone-950/80 p-2"
      data-testid={testId}
      onClick={(e) => {
        // Rows live inside <label> elements; without this a click in here
        // toggles that row's checkbox.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search the bottle catalog"
          data-testid={testId ? `${testId}-input` : undefined}
          className="flex-1 min-w-0 bg-stone-900 border border-stone-700 rounded px-2.5 py-2 text-sm text-amber-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-xs uppercase tracking-wider text-stone-400 hover:text-amber-300 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
        >
          Cancel
        </button>
      </div>

      {typed && results.length === 0 && (
        <div className="text-stone-500 text-xs text-center py-3">
          Nothing in the catalog matches that.
        </div>
      )}

      {results.length > 0 && (
        <ul className="mt-2 max-h-56 overflow-y-auto space-y-1">
          {results.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onPick(b)}
                data-testid="bottle-search-result"
                className="w-full text-left flex items-center gap-2.5 bg-stone-900/70 hover:bg-amber-900/25 border border-stone-800 rounded px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                <BottleImage bottle={b} className="w-9 h-9 rounded text-[10px]" />
                <span className="flex-1 min-w-0">
                  <span className="block font-serif text-amber-100 text-sm truncate">{b.name}</span>
                  <span className="block text-[11px] uppercase tracking-wider text-stone-500 truncate">
                    {b.distillery}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
