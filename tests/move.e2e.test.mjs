// Moving from the old address (mohamedmrj.github.io/ping/) to pinglapp.com. Both addresses are served from this
// folder by Playwright (no network), so the browser applies its real cross-site rules between the two windows.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD = 'https://mohamedmrj.github.io/ping/', NEW = 'https://pinglapp.com/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let browser;

function findBrowser() {
  if (process.env.PING_BROWSER) return { executablePath: process.env.PING_BROWSER };
  const pw = join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) if (existsSync(join(pw, d, exe))) return { executablePath: join(pw, d, exe) };
  }
  return { channel: 'msedge' };
}
before(async () => { browser = await chromium.launch(findBrowser()); });
after(async () => { await browser?.close(); });

const serve = prefix => async route => {
  const path = new URL(route.request().url()).pathname.slice(prefix.length).replace(/^$|\/$/, '/index.html').replace(/^\/?/, '/');
  try { await route.fulfill({ body: await readFile(join(ROOT, path)), contentType: TYPES[extname(path)] || 'application/octet-stream' }); }
  catch { await route.fulfill({ status: 404, body: '' }); }
};

// A fresh browser profile where both addresses serve this Pinglapp. `seeds` = localStorage data per origin.
async function setup(seeds = {}, { blockNew = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route('https://mohamedmrj.github.io/**', serve('/ping'));
  await ctx.route('https://pinglapp.com/**', blockNew ? r => r.abort() : serve(''));
  await ctx.route('https://evil.example/**', r => r.fulfill({ contentType: 'text/html', body:
    `<button id="go" onclick="go()">go</button><script>function go(){ const w = window.open('${NEW}#move-in');
     setInterval(() => w.postMessage({ type: 'pinglapp-move-data', data: { reminders: [{ id: 'evil', title: 'injected', due: 1 }], notes: [] } }, '*'), 200); }</script>` }));
  await ctx.addInitScript(seeds => {
    const s = seeds[location.origin];
    if (s && !sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('reminder-by-me.v1', JSON.stringify(s)); }
  }, seeds);
  const errors = [];
  ctx.on('page', p => { p.on('pageerror', e => errors.push(String(e))); p.on('dialog', d => d.accept()); });
  return { ctx, errors };
}
const ready = p => p.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow && fileInitDone);
const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem('reminder-by-me.v1')));
const T0 = Date.UTC(2026, 10, 20);

test('the old address moves reminders, notes, pictures, boards and settings to pinglapp.com', async () => {
  const { ctx, errors } = await setup({ 'https://mohamedmrj.github.io': {
    reminders: [{ id: 'r1', title: 'Pay rent', due: T0 + 86400000 * 30, updated: T0, tags: [], priority: 0 }],
    notes: [{ id: 'n1', text: 'Picture: ![x](ping-img:k1-test)', created: T0, modified: T0, updated: T0 }],
    settings: { lang: 'en', theme: 'dark', onboarded: true, driveGuideSeen: true }, settingsUpdated: T0,
  } });
  const old = await ctx.newPage();
  await old.goto(OLD); await ready(old);
  await old.evaluate(async png => {
    await kv.set('img-k1-test', png); imgCache.set('k1-test', png); imgIds.add('k1-test');
    await kv.set('board-b1', JSON.stringify({ id: 'b1', title: 'Board one', items: [] }));
    fileHandle = { name: 'Pinglapp-data.json' };              // as if this browser also kept a save file
  }, PNG);
  await old.evaluate(() => renderAll());
  assert.equal(await old.isVisible('#moveBanner'), true);
  assert.match(await old.textContent('#moveBannerText'), /moved to pinglapp\.com/);

  const [neu] = await Promise.all([ctx.waitForEvent('page'), old.click('#moveStartBtn')]);
  await neu.waitForSelector('#moveDlg:not([hidden])');
  const got = await stored(neu);
  assert.deepEqual(got.reminders.map(r => r.title), ['Pay rent']);
  assert.equal(got.reminders[0].updated, T0, 'stamps are kept, not re-stamped as new edits');
  assert.equal(got.notes[0].text, 'Picture: ![x](ping-img:k1-test)');
  assert.equal(got.settings.lang, 'en'); assert.equal(got.settings.theme, 'dark'); assert.equal(got.settings.onboarded, true);
  assert.equal(await neu.evaluate(() => kv.get('img-k1-test')), PNG);
  assert.equal(JSON.parse(await neu.evaluate(() => kv.get('board-b1'))).title, 'Board one');
  assert.match(await neu.textContent('#moveDoneInfo'), /1 reminders, 1 notes and 1 boards/);
  assert.equal(await neu.isVisible('#moveFileStep'), true, 'asks to pick the save file again');
  assert.match(await neu.textContent('#moveFileStep'), /Pinglapp-data\.json/);
  assert.equal(await neu.evaluate(() => location.hash), '');
  assert.equal(await neu.isVisible('#setupDlg'), false, 'no first-run guide: the settings came over');

  await old.waitForFunction(() => !!S.settings.movedAt);
  assert.match(await old.textContent('#moveBannerText'), /Done: your data is on pinglapp\.com/);
  assert.equal(await old.isVisible('#moveOpenBtn'), true);
  assert.equal((await stored(old)).reminders.length, 1, 'nothing is deleted at the old address');
  assert.equal(await neu.isVisible('#moveBanner'), false, 'no move banner on pinglapp.com itself');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('moving into a pinglapp.com that is already in use merges, and takes over from its open window', async () => {
  const { ctx, errors } = await setup({
    'https://mohamedmrj.github.io': { reminders: [], notes: [{ id: 'n-old', text: 'from old', updated: T0 }], settings: { lang: 'sv', onboarded: true } },
    'https://pinglapp.com': { reminders: [], notes: [{ id: 'n-new', text: 'already here', updated: T0 }], settings: { lang: 'en', onboarded: true, driveGuideSeen: true } },
  });
  const here = await ctx.newPage(); await here.goto(NEW); await ready(here);
  const old = await ctx.newPage(); await old.goto(OLD); await ready(old);
  const [neu] = await Promise.all([ctx.waitForEvent('page'), old.click('#moveStartBtn')]);
  await neu.waitForSelector('#moveDlg:not([hidden])');
  const got = await stored(neu);
  assert.deepEqual(got.notes.map(n => n.id).sort(), ['n-new', 'n-old']);
  assert.equal(got.settings.lang, 'en', 'a pinglapp.com already in use keeps its own device settings');
  await here.waitForSelector('#lockDlg:not([hidden])');      // the earlier window steps back instead of overwriting
  await old.waitForFunction(() => !!S.settings.movedAt);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('pinglapp.com ignores data sent by any other site', async () => {
  const { ctx } = await setup();
  const evil = await ctx.newPage(); await evil.goto('https://evil.example/');
  const [neu] = await Promise.all([ctx.waitForEvent('page'), evil.click('#go')]);
  await ready(neu);
  await neu.waitForTimeout(1500);
  const got = await stored(neu);
  assert.ok(!got || !got.reminders.some(r => r.id === 'evil'));
  assert.equal(await neu.isVisible('#moveDlg'), false);
  await ctx.close();
});

test('if pinglapp.com never answers, the old address says so and nothing changes', async () => {
  const { ctx } = await setup({ 'https://mohamedmrj.github.io': { reminders: [], notes: [{ id: 'n', text: 'x', updated: T0 }], settings: { lang: 'en', onboarded: true } } },
    { blockNew: true });
  const old = await ctx.newPage(); await old.goto(OLD); await ready(old);
  const [neu] = await Promise.all([ctx.waitForEvent('page'), old.click('#moveStartBtn')]);
  assert.match(await old.textContent('#moveBannerText'), /Moving to pinglapp\.com/);
  await neu.close();
  await old.waitForFunction(() => /didn’t answer/.test(document.getElementById('moveBannerText').textContent), null, { timeout: 5000 });
  assert.equal(await old.evaluate(() => S.settings.movedAt), undefined);
  assert.equal(await old.isEnabled('#moveStartBtn'), true, 'can try again');
  await ctx.close();
});
