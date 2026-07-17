// KTC-style 0–9999 display scale for ratings — DISPLAY LAYER ONLY.
//
// The stored ELO (bottle_ratings.rating, initial_rating tiers, the K-factor
// math in _shared/elo.ts, the rounds event log, replay) is completely
// untouched by this module. This is purely a render-time transform: take
// the same convex curve the trade math already uses (bottleValue, from
// tradeValue.js — not reimplemented here) and rescale it into a bigger,
// more legible number for on-screen display.
//
// Anchor: ELO 1900 maps to exactly 9999. Fixed and deliberately above the
// current top of the board (~1859 as of the last check, Michter's 20
// Year) so no bottle sits at the display ceiling today — there's room
// for the board to climb before this needs revisiting. If the top of the
// board ever approaches 1900, recalibrate by changing DISPLAY_ANCHOR_ELO
// here — DISPLAY_SCALE is derived from it, never hand-tuned.
import { bottleValue } from "./tradeValue.js";

export const DISPLAY_ANCHOR_ELO = 1900;
export const DISPLAY_MAX = 9999;

// Derived, not hardcoded — DISPLAY_ANCHOR_ELO is the one knob.
export const DISPLAY_SCALE = DISPLAY_MAX / bottleValue(DISPLAY_ANCHOR_ELO);

// For a RAW convex-points value that may already be a SUM across several
// bottles (a trade calculator side total) — same DISPLAY_SCALE as a single
// bottle's rating, but deliberately NOT clamped to DISPLAY_MAX. The 0-9999
// ceiling is a single-bottle display concept (nothing can outrank the
// anchor bottle); a multi-bottle sum legitimately exceeds it, and clamping
// it would misrepresent a trade of several elite bottles as no more
// valuable than one. eloToDisplayRating (below) is this function plus the
// single-bottle clamp.
export function convexToDisplayPoints(rawConvexValue) {
  return Math.round(DISPLAY_SCALE * rawConvexValue);
}

export function eloToDisplayRating(elo) {
  // bottleValue already returns exactly 0 for any elo <= ELO_FLOOR (1200),
  // so the floor behavior falls out of the shared formula rather than
  // being re-asserted here — one definition of "at or below the floor."
  const raw = convexToDisplayPoints(bottleValue(elo));
  return Math.max(0, Math.min(DISPLAY_MAX, raw));
}
