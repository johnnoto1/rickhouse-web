/**
 * Guard the nav tabs against the gold-on-gold hover regression.
 *
 * .tabOn fills the active tab with #E8B45A and sets #2A1B0C text. .tab:hover
 * sets #E8B45A text and, at (0,2,0), outranks .tabOn (0,1,0) — so any hover
 * rule that reaches the active tab paints its label #E8B45A on #E8B45A and the
 * label disappears. Two ways in: tap a tab on touch, where :hover sticks
 * afterwards, or point a mouse at the tab that is already active. The fix in
 * App.jsx's CSS is `@media (hover: hover) { .tab:hover:not(.tabOn) { ... } }`;
 * .typeChip carries the same fix for the same reason.
 *
 * Run this after touching .tab / .tabOn / .typeChip or anything else that adds
 * a :hover rule over a filled-background state. It asserts computed text color
 * != computed background color on the active tab in four states, and exits
 * non-zero if any of them go invisible.
 *
 * Requires a dev server (npm run dev) — pass a different origin as the 2nd arg
 * to point it at a preview build instead.
 *
 * Usage:
 *     npm run dev &
 *     node scripts/verify-tab-hover.mjs [outdir] [baseURL]
 *
 * Writes one screenshot per state (default scratchpad/tab-hover/, gitignored).
 *
 * Requires playwright. NOTE: playwright is not declared in package.json, so on
 * a clean `npm ci` this script will fail to resolve it until it is added as a
 * devDependency — same caveat as check_favicon.mjs.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'scratchpad', 'tab-hover');
const BASE = process.argv[3] ?? 'http://localhost:5173';

fs.mkdirSync(OUT, { recursive: true });

// Mobile viewport — the sticky-hover half of the bug is a touch behaviour, and
// 390x844 is the phone size the rest of the QA in this repo uses.
const VP = { width: 390, height: 844 };
// The nav sits at the top; no need to capture the whole page per state.
const CLIP = { x: 0, y: 0, width: 390, height: 320 };

// Read the active tab (.tabOn) as the browser actually computes it. Comparing
// resolved colors — rather than asserting a specific hex — is what makes this
// survive a palette change: the invariant is "label differs from its fill",
// not "label is #2A1B0C".
const readActiveTab = () => {
  const el = document.querySelector('nav .tabOn');
  if (!el) return { error: 'no .tabOn found' };
  const cs = getComputedStyle(el);
  return {
    text: el.textContent.trim(),
    color: cs.color,
    bg: cs.backgroundColor,
    visible: cs.color !== cs.backgroundColor,
  };
};

const readInactiveTab = () => {
  const el = document.querySelector('nav .tab:not(.tabOn)');
  if (!el) return { error: 'no inactive .tab found' };
  const cs = getComputedStyle(el);
  return {
    text: el.textContent.trim(),
    color: cs.color,
    bg: cs.backgroundColor,
    visible: cs.color !== cs.backgroundColor,
  };
};

const browser = await chromium.launch();
const results = [];

try {
  // --- Hover-capable pointer: (hover: hover), (pointer: fine) ---
  {
    const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(BASE + '/rank', { waitUntil: 'networkidle' });
    // "Rank Bottles" is active on /rank and renders without a session, so this
    // runs against a plain dev server with no local Supabase up.
    await page.locator('nav .tabOn').first().waitFor();

    await page.mouse.move(5, 800); // park the pointer away from the nav
    results.push({ state: 'default (mouse device)', ...(await page.evaluate(readActiveTab)) });
    await page.screenshot({ path: path.join(OUT, 'tab-1-default.png'), clip: CLIP });

    await page.locator('nav .tabOn').first().hover();
    await page.waitForTimeout(250); // .tab has a .15s transition
    results.push({
      state: 'hovering the ACTIVE tab (mouse)',
      ...(await page.evaluate(readActiveTab)),
    });
    await page.screenshot({ path: path.join(OUT, 'tab-2-hover-active.png'), clip: CLIP });

    // Regression guard in the other direction: the fix must narrow the hover
    // rule, not delete it. An inactive tab should still take the gold text.
    await page.locator('nav .tab:not(.tabOn)').first().hover();
    await page.waitForTimeout(250);
    results.push({
      state: 'hovering an INACTIVE tab (affordance intact)',
      ...(await page.evaluate(readInactiveTab)),
    });
    await ctx.close();
  }

  // --- Touch device: (hover: none), (pointer: coarse). Tap leaves :hover stuck. ---
  {
    const ctx = await browser.newContext({
      viewport: VP,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/rank', { waitUntil: 'networkidle' });
    await page.locator('nav .tabOn').first().waitFor();

    // Recorded so a failure tells you whether the media query even disengaged.
    const media = await page.evaluate(() => ({
      hoverHover: matchMedia('(hover: hover)').matches,
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
    }));

    // Tap the already-active tab — that leaves :hover stuck on a .tabOn
    // element, which is precisely the state that went gold-on-gold.
    await page.getByRole('button', { name: 'Rank Bottles' }).tap();
    await page.waitForTimeout(400);
    results.push({
      state: 'post-tap sticky hover (touch)',
      media,
      ...(await page.evaluate(readActiveTab)),
    });
    await page.screenshot({ path: path.join(OUT, 'tab-3-sticky-hover-touch.png'), clip: CLIP });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
console.log(`screenshots in ${OUT}`);

const bad = results.filter((r) => r.visible === false || r.error);
console.log(bad.length ? `FAIL: ${bad.length} state(s) invisible` : 'PASS: label visible in every state');
process.exit(bad.length ? 1 : 0);
