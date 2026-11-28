// Draws the app icons that phones need from Pinglapp's bell (the same shape as the favicon in index.html).
// Run from Ping/tests: `node make-icons.mjs`. Writes to Ping/:
//   icon-maskable-192.png, icon-maskable-512.png  full-bleed teal, bell inside the central safe circle (Android crops to
//                                                 a circle, squircle or square, so nothing may sit near the edges)
//   apple-touch-icon.png (180)                    full-bleed teal: iOS rounds the corners itself and turns transparent
//                                                 corners black, so the rounded icon-192.png looks wrong there
// icon-192.png / icon-512.png (rounded, transparent corners) stay as the "any" icons for computers.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BELL = 'M32 13a3 3 0 0 1 3 3v1.5c6 1.4 9.5 6.4 9.5 12.5v8l4 5.5H15.5l4-5.5v-8c0-6.1 3.5-11.1 9.5-12.5V16a3 3 0 0 1 3-3z';
// The bell spans y 13..52.6 and x 15.5..48.5 in the 64-unit box; (32, 32.8) is its middle.
const svg = scale => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%">
  <rect width="64" height="64" fill="#0d7c72"/>
  <g transform="translate(32 32.8) scale(${scale}) translate(-32 -32.8)" fill="#fff">
    <path d="${BELL}"/><ellipse cx="32" cy="49" rx="5" ry="3.6"/>
  </g></svg>`;
const ICONS = [
  { file: 'icon-maskable-192.png', size: 192, scale: 0.78 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.78 },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.92 }
];

function findBrowser() {
  if (process.env.PING_BROWSER) return { executablePath: process.env.PING_BROWSER };
  const pw = join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) if (existsSync(join(pw, d, exe))) return { executablePath: join(pw, d, exe) };
  }
  return { channel: 'msedge' };
}

const browser = await chromium.launch(findBrowser());
try {
  for (const { file, size, scale } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${svg(scale)}</body></html>`);
    await page.screenshot({ path: join(ROOT, file), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote', file);
  }
} finally { await browser.close(); }
