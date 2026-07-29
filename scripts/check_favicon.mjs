/**
 * Verify public/favicon.svg stays legible at the sizes browsers actually paint.
 *
 * Companion to make_favicon.py — run this after regenerating the lettermark,
 * especially after changing TARGET_H or the font. The bowl counter of the "d"
 * is the first thing to close up as the glyph shrinks, and it goes at 16px
 * long before anything looks wrong at 64px.
 *
 * Usage:
 *     node scripts/check_favicon.mjs [outfile.png]
 *
 * Writes a contact sheet (default scratchpad/favicon-check.png, gitignored):
 *   - the true 16x16 and 32x32 rasters, magnified nearest-neighbour so you
 *     judge real pixels rather than a fresh render at a bigger size
 *   - 1:1 samples on light and dark tab strips
 *
 * Requires playwright. NOTE: playwright is not declared in package.json, so on
 * a clean `npm ci` this script will fail to resolve it until it is added as a
 * devDependency (see the commit message for why that was left as a decision).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = path.join(ROOT, 'public', 'favicon.svg');
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'scratchpad', 'favicon-check.png');

if (!fs.existsSync(SVG_PATH)) {
  console.error(`favicon not found: ${SVG_PATH}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const uri =
  'data:image/svg+xml;base64,' + Buffer.from(fs.readFileSync(SVG_PATH)).toString('base64');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favicon-check-'));
const png = (n) => path.join(tmp, `fav${n}.png`);

// PNG dimensions live at fixed offsets in the IHDR chunk — cheap way to assert
// we really captured NxN without pulling in an image library.
const dims = (f) => {
  const b = fs.readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const browser = await chromium.launch();
try {
  // Step 1 — rasterize at the true target sizes. deviceScaleFactor 1 so a 16px
  // element screenshot is exactly 16x16 real pixels, which is what a tab shows.
  // omitBackground keeps the rounded corners transparent instead of picking up
  // the capture page's background.
  const shot = await browser.newPage({
    viewport: { width: 200, height: 120 },
    deviceScaleFactor: 1,
  });
  await shot.setContent(
    [16, 32]
      .map((n) => `<img id="i${n}" src="${uri}" width="${n}" height="${n}" style="display:block">`)
      .join('')
  );
  await shot.waitForFunction('[...document.images].every(i => i.complete && i.naturalWidth)');
  for (const n of [16, 32]) {
    await shot.locator(`#i${n}`).screenshot({ path: png(n), omitBackground: true });
    const [w, h] = dims(png(n));
    if (w !== n || h !== n) throw new Error(`expected ${n}x${n} raster, got ${w}x${h}`);
    console.log(`rasterized ${n}x${n}`);
  }
  await shot.close();

  // Step 2 — magnify those exact rasters with nearest-neighbour, plus 1:1
  // samples on both tab-strip backgrounds.
  const b64 = (n) => 'data:image/png;base64,' + fs.readFileSync(png(n)).toString('base64');
  const [p16, p32] = [b64(16), b64(32)];
  const strip = (bg, fg, label) => `
    <div style="margin-top:12px;background:${bg};color:${fg};padding:9px 14px;display:flex;
                align-items:center;gap:9px;border-radius:6px">
      <img src="${p16}" width="16" height="16"><span>dranker &mdash; drink &middot; rank &middot; repeat</span>
      <img src="${p32}" width="32" height="32" style="margin-left:24px"><span>${label}</span>
    </div>`;

  const sheet = await browser.newPage({
    viewport: { width: 700, height: 560 },
    deviceScaleFactor: 2,
  });
  await sheet.setContent(`<body style="margin:0;background:#3a3a3a;font:13px system-ui;color:#eee;padding:20px">
    <div style="display:flex;gap:30px">
      <div><img src="${p16}" width="256" height="256" style="image-rendering:pixelated">
        <div style="margin-top:6px">16&times;16 actual pixels, magnified &times;16</div></div>
      <div><img src="${p32}" width="256" height="256" style="image-rendering:pixelated">
        <div style="margin-top:6px">32&times;32 actual pixels, magnified &times;8</div></div>
    </div>
    ${strip('#f2f2f2', '#111', 'light strip, 32px 1:1')}
    ${strip('#202124', '#e8eaed', 'dark strip, 32px 1:1')}
  </body>`);
  await sheet.waitForFunction('[...document.images].every(i => i.complete && i.naturalWidth)');
  await sheet.screenshot({ path: OUT });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
