// End-to-end and in-page unit tests: the real index.html in a real browser (Chrome, Edge or Playwright's Chromium).
// Every test gets a fresh browser profile, so nothing here touches anyone's real Pinglapp data.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };
let server, base, browser;

function findBrowser() {
  if (process.env.PING_BROWSER) return { executablePath: process.env.PING_BROWSER };
  const pw = join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) if (existsSync(join(pw, d, exe))) return { executablePath: join(pw, d, exe) };
  }
  return { channel: 'msedge' };
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
    try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(findBrowser());
});
after(async () => { await browser?.close(); server?.close(); });

// A fresh profile with Pinglapp open. `seed` is put in localStorage before Pinglapp starts.
async function open({ seed, lang = 'sv', tz = 'Europe/Stockholm', onboarded = true, init } = {}) {
  const ctx = await browser.newContext({ timezoneId: tz, serviceWorkers: 'block' });
  const errors = [];
  if (seed !== undefined || onboarded || lang) {
    await ctx.addInitScript(([seed, lang, onboarded]) => {
      if (sessionStorage.getItem('seeded')) return;        // only on the first load, so reloads show what Pinglapp saved
      sessionStorage.setItem('seeded', '1');
      if (typeof seed === 'string') localStorage.setItem('reminder-by-me.v1', seed);
      else {
        const d = seed || {};
        d.settings = Object.assign({ lang, onboarded, driveGuideSeen: onboarded }, d.settings || {});
        localStorage.setItem('reminder-by-me.v1', JSON.stringify(d));
      }
    }, [seed, lang, onboarded]);
  }
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());                      // confirm() boxes: say yes
  await page.goto(base);
  await page.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow && fileInitDone);
  return { ctx, page, errors };
}
const tab = (page, name) => page.click(`.tabs [data-tab="${name}"]`);
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('reminder-by-me.v1')));

// ------------------------------------------------------------------ start-up and every screen
test('Pinglapp starts without errors and every tab and dialog opens, in Swedish and English', async () => {
  for (const lang of ['sv', 'en']) {
    const { ctx, page, errors } = await open({ lang });
    for (const k of ['notes', 'settings', 'reminders']) { await tab(page, k); await page.waitForTimeout(50); }
    await page.evaluate(() => { openStartupGuide(); });
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#startupDlg'), true, 'Escape closes the startup guide');
    await page.evaluate(() => { openSetup(0, true); });
    assert.equal(await page.isVisible('#setupStep0'), true);
    await page.click('[data-act="setup-drive-next"]');
    assert.equal(await page.isVisible('#setupStep1'), true);
    await page.click('#setupStep1 [data-act="setup-skip"]');
    assert.equal(await page.isVisible('#setupStep2'), true);
    await page.click('#setupStep2 [data-act="setup-done"]:visible');
    assert.equal(await page.isHidden('#setupDlg'), true);
    assert.deepEqual(errors, [], lang);
    await ctx.close();
  }
});

test('every text has both languages: no missing translations and no untranslated keys on screen', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const src = [...document.scripts].map(s => s.textContent).join('\n');
    const used = new Set([...src.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('_')));   // 'snd_' + id and the like are prefixes
    const staticKeys = new Set([...document.querySelectorAll('[data-i18n],[data-i18n-ph],[data-i18n-title],[data-i18n-aria]')]
      .flatMap(el => ['data-i18n', 'data-i18n-ph', 'data-i18n-title', 'data-i18n-aria'].map(a => el.getAttribute(a)).filter(Boolean)));
    return {
      dynMissingSv: [...used].filter(k => !(k in T.sv)),
      dynMissingEn: [...used].filter(k => !(k in T.en)),
      staticMissingEn: [...staticKeys].filter(k => !(k in T.en)),
    };
  });
  assert.deepEqual(r.dynMissingEn, [], 'used with t() but missing in T.en');
  assert.deepEqual(r.staticMissingEn, [], 'data-i18n key without English');
  assert.deepEqual(r.dynMissingSv, [], 'used with t() but missing in T.sv (would show English in the Swedish app)');
  await ctx.close();
});

// ------------------------------------------------------------------ the Google Drive / OneDrive guide
test('a new person sees the cloud-folder guide first, with Google Drive and OneDrive steps', async () => {
  const { ctx, page, errors } = await open({ onboarded: false });
  await page.waitForSelector('#setupStep0', { state: 'visible' });
  assert.match(await page.textContent('#setupStep0 .step'), /1 av 3/);
  assert.equal(await page.isVisible('[data-cloud="gdrive"]'), true);
  assert.equal(await page.isHidden('[data-cloud="onedrive"]'), true);
  assert.match(await page.textContent('[data-cloud="gdrive"]'), /google\.com\/drive\/download/);
  await page.click('[data-cloud-set="onedrive"]');
  assert.equal(await page.isVisible('[data-cloud="onedrive"]'), true);
  assert.equal(await page.isHidden('[data-cloud="gdrive"]'), true);
  assert.match(await page.textContent('[data-cloud="onedrive"]'), /Behåll alltid på den här enheten/);
  assert.equal((await stored(page)).settings.cloud, 'onedrive', 'the choice is remembered');
  // English
  await page.evaluate(() => { S.settings.lang = 'en'; applyLang(); });
  assert.match(await page.textContent('[data-cloud="onedrive"]'), /Always keep on this device/);
  assert.match(await page.textContent('#setupStep0 .step'), /Step 1 of 3/);
  await page.click('[data-act="setup-drive-next"]');
  assert.equal(await page.isVisible('#setupStep1'), true);
  assert.match(await page.textContent('#setupStep1 .step'), /Step 2 of 3/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('people set up before the guide existed (no save file) see it once, then never again', async () => {
  const { ctx, page } = await open({ seed: { reminders: [], notes: [], settings: { onboarded: true } }, onboarded: true, lang: 'sv',
    init: () => { /* simulate an old profile: driveGuideSeen missing */ } });
  // the seed helper sets driveGuideSeen = onboarded, so clear it and re-run onboarding as on an old profile
  await page.evaluate(() => { delete S.settings.driveGuideSeen; $('setupDlg').hidden = true; maybeOnboard(); });
  const supportsFiles = await page.evaluate(() => fileApi);
  if (supportsFiles) {
    assert.equal(await page.isVisible('#setupStep0'), true);
    await page.evaluate(() => finishSetup());
    await page.reload(); await page.waitForFunction(() => isActiveWindow && fileInitDone);
    await page.waitForTimeout(200);
    assert.equal(await page.isHidden('#setupDlg'), true);
  }
  await ctx.close();
});

test('Settings has a button that opens the guide', async () => {
  const { ctx, page } = await open();
  await tab(page, 'settings');
  await page.click('[data-act="setup-open-wizard"]');
  assert.equal(await page.isVisible('#setupStep0'), true);
  await ctx.close();
});

// ------------------------------------------------------------------ saving in the browser
test('a reminder typed in quick add survives a reload', async () => {
  const { ctx, page } = await open();
  await page.fill('#quickInput', 'Ring Anna imorgon 10:00 #jobb !!');
  await page.press('#quickInput', 'Enter');
  await page.reload(); await page.waitForFunction(() => isActiveWindow);
  const d = await stored(page);
  assert.equal(d.reminders.length, 1);
  assert.equal(d.reminders[0].title, 'Ring Anna');
  assert.deepEqual(d.reminders[0].tags, ['jobb']);
  assert.equal(d.reminders[0].priority, 2);
  assert.match(await page.textContent('#groups'), /Ring Anna/);
  await ctx.close();
});

test('unreadable browser data is kept aside, not overwritten', async () => {
  const broken = '{"reminders":[{"id":"a","title":"important"'; // cut off half way
  const { ctx, page } = await open({ seed: broken });
  await page.waitForTimeout(300);
  const kept = await page.evaluate(async () => { const keys = (await kv.keys()).map(String).filter(k => k.startsWith('unreadable-')); return keys.length ? kv.get(keys[0]) : null; });
  assert.equal(kept, broken);
  await ctx.close();
});

test('when browser storage is full, old note versions are thinned out and saving still works', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === KEY && v.length > 2500) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return real.call(this, k, v); };
    S.notes.push({ id: 'n1', text: 'x', created: 1, modified: 1, history: Array.from({ length: 8 }, (_, i) => ({ t: i, text: 'v'.repeat(400) })) });
    save();
    const ok = { err: lastSaveError, hist: S.notes[0].history.length };
    Storage.prototype.setItem = real;
    return ok;
  });
  assert.equal(r.err, '');
  assert.ok(r.hist < 8);
  await ctx.close();
});

test('when storage stays full, the header says “Not saved!” and it recovers afterwards', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k) { if (k === KEY) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } };
    S.reminders.push(newReminder({ title: 'x' })); save();
    const bad = $('saveChip').classList.contains('bad');
    Storage.prototype.setItem = real; save();
    return { bad, after: $('saveChip').classList.contains('bad') };
  });
  assert.deepEqual(r, { bad: true, after: false });
  await ctx.close();
});

test('daily copies are named after the local date, not the UTC date', async () => {
  const { ctx, page } = await open({ tz: 'Pacific/Kiritimati', seed: { reminders: [{ id: 'a', title: 'x', due: Date.now() + 3600e3, repeat: 'none', tags: [] }], notes: [] } });
  await page.waitForTimeout(400);
  const r = await page.evaluate(async () => ({ keys: (await kv.keys()).map(String).filter(k => k.startsWith('snap-')), local: isoDate(new Date()) }));
  assert.deepEqual(r.keys, ['snap-' + r.local]);
  await ctx.close();
});

// ------------------------------------------------------------------ restore and undo
test('restore from backup: "add" keeps everything and adds what is missing; "replace" can be undone', async () => {
  const { ctx, page } = await open({ seed: { reminders: [{ id: 'mine', title: 'mine', due: Date.now() + 1e6, repeat: 'none', tags: [] }], notes: [] } });
  const r = await page.evaluate(async () => {
    const backup = { reminders: [{ id: 'old', title: 'from backup', due: Date.now() + 1e6, repeat: 'none', tags: [] }], notes: [{ id: 'n', text: 'note from backup' }] };
    pendingRestore = backup; document.querySelector('input[name=restoreMode][value=add]').checked = true; await doRestore();
    const added = S.reminders.map(x => x.id).sort().join() + '|' + S.notes.length;
    pendingRestore = backup; document.querySelector('input[name=restoreMode][value=replace]').checked = true; await doRestore();
    const replaced = S.reminders.map(x => x.id).sort().join();
    $('toastAct').click();                     // Undo
    return { added, replaced, undone: S.reminders.map(x => x.id).sort().join() };
  });
  assert.equal(r.added, 'mine,old|1');
  assert.equal(r.replaced, 'old');
  assert.equal(r.undone, 'mine,old');
  await ctx.close();
});

// ------------------------------------------------------------------ the save file (Google Drive / OneDrive folder)
// A stand-in for a file the person picked: behaves like the browser's file handle.
const FAKE_FILE = () => {
  window.makeFile = (text, opts = {}) => {
    const f = { text, writes: 0, name: 'Pinglapp-data.json', perm: 'granted', fail: null };
    f.queryPermission = async () => f.perm;
    f.requestPermission = async () => (f.perm = 'granted');
    f.getFile = async () => { if (f.fail) { const e = new Error(f.fail); e.name = f.fail; throw e; } return { text: async () => f.text }; };
    f.createWritable = async () => { let buf = ''; return { write: async s => { buf += s; }, close: async () => { f.text = buf; f.writes++; } }; };
    return Object.assign(f, opts);
  };
};

test('the save file merges two computers: nothing from either side is lost', async () => {
  const now = Date.now();
  const { ctx, page } = await open({ init: FAKE_FILE, seed: { reminders: [{ id: 'here', title: 'on this PC', due: now + 1e6, repeat: 'none', tags: [], updated: now }], notes: [] } });
  const r = await page.evaluate(async now => {
    const other = { reminders: [{ id: 'there', title: 'on the other PC', due: now + 2e6, repeat: 'none', tags: [], updated: now }], notes: [{ id: 'n', text: 'note from the other PC', updated: now }] };
    const f = makeFile(JSON.stringify(other));
    fileHandle = f; fileState = 'ok'; await syncFile();
    const inFile = JSON.parse(f.text);
    return { here: S.reminders.map(x => x.id).sort().join(), file: inFile.reminders.map(x => x.id).sort().join(), notes: inFile.notes.length, state: fileState };
  }, now);
  assert.deepEqual(r, { here: 'here,there', file: 'here,there', notes: 1, state: 'ok' });
  await ctx.close();
});

test('a half-synced save file is never overwritten, and Pinglapp says it will retry', async () => {
  const { ctx, page } = await open({ init: FAKE_FILE });
  const r = await page.evaluate(async () => {
    const f = makeFile('{"reminders":[{"id":"a"'); fileHandle = f; fileState = 'ok';
    S.reminders.push(newReminder({ title: 'x' })); save(); await syncFile();
    return { writes: f.writes, text: f.text, state: fileState, kind: fileErrKind, chip: $('saveChipText').textContent };
  });
  assert.equal(r.writes, 0);
  assert.equal(r.text, '{"reminders":[{"id":"a"');
  assert.equal(r.kind, 'unreadable');
  assert.match(r.chip, /försöker igen/);
  await ctx.close();
});

test('a moved or deleted save file shows the banner, and lost permission only asks for a click', async () => {
  const { ctx, page } = await open({ init: FAKE_FILE });
  const r = await page.evaluate(async () => {
    const f = makeFile('{}', { fail: 'NotFoundError' }); fileHandle = f; fileState = 'ok'; await syncFile();
    const gone = { banner: !$('fileBanner').hidden, kind: fileErrKind };
    f.fail = null; f.perm = 'prompt'; fileState = 'ok'; await syncFile();
    return { gone, needs: fileState, chip: $('saveChipText').textContent };
  });
  assert.deepEqual(r.gone, { banner: true, kind: 'gone' });
  assert.equal(r.needs, 'needs-permission');
  assert.match(r.chip, /klick/);
  await ctx.close();
});

test('a file that is not a Pinglapp save file is refused when opened', async () => {
  const { ctx, page } = await open({ init: FAKE_FILE });
  const r = await page.evaluate(async () => { const f = makeFile('{"hello":1}'); await useFile(f, true); return { used: fileHandle === f, writes: f.writes }; });
  assert.deepEqual(r, { used: false, writes: 0 });
  await ctx.close();
});

// ------------------------------------------------------------------ when reminders go off
test('monthly and yearly repeats keep their day (31st, 29 Feb) instead of drifting', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const L = (y, m, d, h = 9) => new Date(y, m - 1, d, h).getTime(), D = ms => isoDate(new Date(ms));
    const rm = { repeat: 'monthly', monthDay: 31 }, out = [];
    let due = L(2027, 1, 31);
    for (let i = 0; i < 4; i++) { due = nextAfter(rm, due, due); out.push(D(due)); }
    const ry = { repeat: 'yearly', monthDay: 29 }; let y = L(2028, 2, 29); const years = [];
    for (let i = 0; i < 4; i++) { y = nextAfter(ry, y, y); years.push(D(y)); }
    const caught = D(nextAfter({ repeat: 'monthly', monthDay: 31 }, L(2027, 1, 31), L(2027, 3, 15)));
    const old = D(nextAfter({ repeat: 'monthly' }, L(2027, 1, 30), L(2027, 1, 30)));
    return { out, years, caught, old, hour: new Date(nextAfter(rm, L(2027, 3, 1, 9), L(2027, 3, 1, 9))).getHours() };
  });
  assert.deepEqual(r.out, ['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.deepEqual(r.years, ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  assert.equal(r.caught, '2027-03-31');          // missed while closed: jumps to the next one after now
  assert.equal(r.old, '2027-02-28');             // reminders saved before monthDay existed
  assert.equal(r.hour, 9);                       // across the change to summer time
  await ctx.close();
});

test('daily, weekday, weekly and interval repeats', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const L = (y, m, d, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).getTime(), F = ms => new Date(ms).toString().slice(0, 21);
    return {
      dailyDst: F(nextAfter({ repeat: 'daily' }, L(2027, 3, 27), L(2027, 3, 27))),
      weekdayFri: F(nextAfter({ repeat: 'weekdays' }, L(2026, 11, 27), L(2026, 11, 27))),
      weekly: F(nextAfter({ repeat: 'weekly' }, L(2026, 11, 23), L(2026, 12, 1))),
      interval: F(nextAfter({ repeat: 'interval', every: 30 }, L(2026, 11, 23, 9), L(2026, 11, 23, 10, 5))),
    };
  });
  assert.equal(r.dailyDst, 'Sun Mar 28 2027 09:00');
  assert.equal(r.weekdayFri, 'Mon Nov 30 2026 09:00');
  assert.equal(r.weekly, 'Mon Dec 07 2026 09:00');
  assert.equal(r.interval, 'Mon Nov 23 2026 10:30');
  await ctx.close();
});

test('a reminder fires once, is marked overdue, and does not fire again after a reload', async () => {
  const { ctx, page } = await open({ seed: { reminders: [{ id: 'r', title: 'Due now', due: Date.now() - 1000, repeat: 'none', tags: [], fired: false, done: false, snoozeUntil: null }], notes: [] } });
  await page.waitForSelector('.alert');
  assert.match(await page.textContent('.alert'), /Due now/);
  const d = await stored(page);
  assert.equal(d.reminders[0].fired, true);
  await page.reload(); await page.waitForFunction(() => isActiveWindow);
  await page.evaluate(() => check());
  assert.equal(await page.locator('.alert').count(), 0);
  assert.match(await page.textContent('#groups'), /Försenade/);
  await ctx.close();
});

test('snoozing a reminder before it goes off moves it: it does not also go off at the old time', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const fired = []; window.fire = (x, at) => fired.push(at);
    const rem = newReminder({ title: 'later', due: Date.now() + 60000 }); S.reminders.push(rem); save();
    snooze(rem, Date.now() + 3600000);
    rem.due = Date.now() - 1; check();            // the old time passes
    const atOld = fired.length;
    rem.snoozeUntil = Date.now() - 1; check();    // the snooze time passes
    return { atOld, total: fired.length, overdue: isOverdue(rem) };
  });
  assert.deepEqual(r, { atOld: 0, total: 1, overdue: true });
  await ctx.close();
});

test('a repeating reminder missed while Pinglapp was closed fires once and moves to the next time', async () => {
  const day = 86400000;
  const { ctx, page } = await open({ seed: { reminders: [{ id: 'd', title: 'daily', due: Date.now() - 3 * day - 1000, repeat: 'daily', tags: [], fired: false, done: false, snoozeUntil: null }], notes: [] } });
  await page.waitForSelector('.alert');
  assert.equal(await page.locator('.alert').count(), 1);
  const d = await stored(page);
  assert.ok(d.reminders[0].due > Date.now() && d.reminders[0].due <= Date.now() + day);
  await ctx.close();
});

// ------------------------------------------------------------------ showing text safely
test('titles, notes and Markdown can never run code or inject HTML', async () => {
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  const { ctx, page } = await open({ seed: { reminders: [{ id: 'x', title: evil, notes: evil, due: Date.now() - 1000, repeat: 'none', tags: ['<b>'], fired: false }], notes: [{ id: 'n', text: '# ' + evil + '\n\n' + evil + '\n\n[click](javascript:alert(1)) ![a](javascript:alert(1))\n\n```html\n' + evil + '\n```', modified: Date.now() }] } });
  await page.waitForSelector('.alert');
  await tab(page, 'notes');
  await page.evaluate(() => liveFocus(0));   // the formatted note and the open editor, both at once
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#notePreview a[href^="javascript"], #notePreview img[src^="javascript"]').count(), 0);
  assert.equal(await page.locator('#groups img, .alert img, #notePreview img, #noteHl img').count(), 0);
  await ctx.close();
});

test('links keep their underscores and stars; formatting around them still works', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = inlineMd('see https://example.com/_a_/b*c*d and **bold** _it_ #tag https://x.se/#frag');
    return { hrefs: [...box.querySelectorAll('a')].map(a => a.getAttribute('href')), bold: box.querySelector('strong')?.textContent, em: box.querySelector('em')?.textContent, tags: box.querySelectorAll('.ntag').length };
  });
  assert.deepEqual(r.hrefs, ['https://example.com/_a_/b*c*d', 'https://x.se/#frag']);
  assert.equal(r.bold, 'bold');
  assert.equal(r.em, 'it');
  assert.equal(r.tags, 1);
  await ctx.close();
});

// ------------------------------------------------------------------ Outlook calendar file
test('calendar lines are at most 75 bytes and never split a letter or emoji', async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(() => {
    const line = 'SUMMARY:' + 'Möte med Åsa 🎉 och Örjan – planering '.repeat(6);
    const folded = fold(line), parts = folded.split('\r\n'), enc = new TextEncoder();
    return { max: Math.max(...parts.map(p => enc.encode(p).length)), back: parts.map((p, i) => i ? p.slice(1) : p).join('') === line, lone: /[\ud800-\udbff](?![\udc00-\udfff])/.test(folded), short: fold('SUMMARY:x') };
  });
  assert.ok(r.max <= 75, 'line too long: ' + r.max);
  assert.equal(r.back, true);
  assert.equal(r.lone, false);
  assert.equal(r.short, 'SUMMARY:x');
  await ctx.close();
});

// ------------------------------------------------------------------ notes
test('notes: typing saves, delete goes to the trash with undo, and history keeps old versions', async () => {
  const { ctx, page } = await open();
  await tab(page, 'notes');
  await page.click('#noteText');
  await page.keyboard.type('# Första\n\nhej');
  await page.waitForTimeout(400);
  let d = await stored(page);
  assert.equal(d.notes.length, 1);
  assert.match(d.notes[0].text, /# Första/);
  await page.click('[data-act="del-note"]');
  d = await stored(page);
  assert.ok(d.notes[0].trashed);
  await page.click('#toastAct');               // Undo
  d = await stored(page);
  assert.ok(!d.notes[0].trashed);
  await ctx.close();
});

// ------------------------------------------------------------------ themes, dark whiteboard, fullscreen
const THEMES = ['lagoon', 'fjord', 'solarized', 'sunset', 'forest', 'candy', 'neon', 'space', 'interstellar', 'nature', 'mountain', 'desert'];

test('settings is a gear icon with its name written next to it, in Swedish and English', async () => {
  for (const [lang, name] of [['sv', 'Inställningar'], ['en', 'Settings']]) {
    const { ctx, page } = await open({ lang });
    const b = page.locator('.tabs [data-tab="settings"]');
    assert.equal((await b.innerText()).trim(), name, 'a visible name, not just the icon');
    assert.equal(await b.locator('svg').count(), 1);
    await b.click();
    assert.equal(await page.isVisible('#view-settings'), true);
    await ctx.close();
  }
});

// ---- UX update U1: header and navigation
test('phones get a bottom bar with the sections; "Mer" holds settings and help; the header tabs are hidden', async () => {
  const { ctx, page, errors } = await open();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.isVisible('#bottomNav'), true);
  assert.equal(await page.isVisible('header .tabs'), false);
  assert.equal(await page.isVisible('.help-btn'), false);
  const labels = await page.locator('#bottomNav button:visible').allInnerTexts();
  assert.deepEqual(labels.map(s => s.trim()), ['Påminnelser', 'Anteckningar', 'Tavla', 'Vänner', 'Mer']);
  await page.click('#bottomNav [data-tab="notes"]');
  assert.equal(await page.isVisible('#view-notes'), true);
  assert.equal(await page.getAttribute('#bottomNav [data-tab="notes"]', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('.tabs [data-tab="notes"]', 'aria-selected'), 'true', 'the header tabs follow along');
  await page.click('#bnavMore');
  assert.deepEqual((await page.locator('#pop button').allInnerTexts()).slice(0, 2), ['Inställningar', 'Hjälp och kortkommandon']);
  await page.click('#pop button:has-text("Inställningar")');
  assert.equal(await page.isVisible('#view-settings'), true);
  // Buttons in the bar are big enough to tap.
  const box = await page.locator('#bottomNav [data-tab="reminders"]').boundingBox();
  assert.ok(box.height >= 44, 'bottom bar buttons are at least 44 px high');
  // A computer: tabs at the top, no bottom bar, a labelled help button.
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await page.isVisible('#bottomNav'), false);
  assert.equal(await page.isVisible('header .tabs'), true);
  assert.equal((await page.innerText('.help-btn')).replace(/\s+/g, ' ').trim(), '? Hjälp');
  await page.click('.help-btn');
  assert.equal(await page.isVisible('#keysDlg'), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notifications are asked for once: no chip while the banner is up; after "Inte nu" the chip remains', async () => {
  const { ctx, page, errors } = await open({ init: () => { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } });
  assert.equal(await page.isVisible('#notifBanner'), true);
  assert.equal(await page.isVisible('#notifChip'), false, 'not asked twice');
  await page.click('#notifBanner [data-act="hide-banner"]');
  assert.equal(await page.isVisible('#notifBanner'), false);
  assert.equal(await page.isVisible('#notifChip'), true, 'still one click away');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the UTC clock and the code font are switched off once for everyone; switching them back on sticks', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [], settings: { lang: 'sv', onboarded: true, driveGuideSeen: true, utcClock: true, mono: true } } });
  assert.equal(await page.textContent('#clock'), '');
  assert.deepEqual(await page.evaluate(() => [S.settings.utcClock, S.settings.mono, S.settings.uxV, noteText.classList.contains('mono')]), [false, false, 1, false]);
  await tab(page, 'settings');
  await page.check('#setUtc');
  await page.reload();
  await page.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow);
  assert.equal(await page.evaluate(() => S.settings.utcClock), true, 'not switched off again');
  await page.waitForFunction(() => /UTC/.test($('clock').textContent));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('every theme has its own light and dark colours, and the whiteboard paper follows them', async () => {
  const { ctx, page, errors } = await open({ lang: 'en' });
  await tab(page, 'settings');
  assert.equal(await page.locator('[data-palette-set]:visible').count(), THEMES.length, 'every theme has a button');
  const seen = new Set();
  for (const p of THEMES) {
    await page.click(`[data-palette-set="${p}"]`);
    for (const mode of ['light', 'dark']) {
      await page.click(`[data-theme-set="${mode}"]`);
      const r = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, pal: wbPal() }));
      assert.equal(r.scheme, mode, `${p} ${mode}: color-scheme`);
      assert.equal(r.pal.dark, mode === 'dark', `${p} ${mode}: the board knows the mode`);
      const lum = Number(/\d+/.exec(r.bg)[0]);   // the red channel is enough to tell light from dark here
      assert.ok(mode === 'light' ? lum > 200 : lum < 60, `${p} ${mode}: background ${r.bg}`);
      assert.match(r.pal.bg, /^rgb/, `${p} ${mode}: the board paper colour is resolved`);
      seen.add(r.bg + '|' + r.pal.bg);
    }
    assert.equal((await stored(page)).settings.palette, p, 'the theme is saved');
  }
  assert.equal(seen.size, THEMES.length * 2, 'no two themes or modes look the same');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('dark whiteboard: drawings are shown in dark-mode colours but stored and exported in their own', async () => {
  const { ctx, page, errors } = await open({ lang: 'en', seed: { reminders: [], notes: [], settings: { theme: 'dark' } } });
  await tab(page, 'board');
  await page.waitForFunction(() => wb.board);
  const r = await page.evaluate(() => {
    const it = { id: 'n1', type: 'sticky', x: 0, y: 0, w: 100, h: 100, fill: '#fff3a3', text: 'Hej', z: 1, author: wb.me.cid };
    wb.board.items.n1 = it; wbDraw();
    const exp = wbCanvasImage(), px = exp.getContext('2d').getImageData(Math.round(exp.width / 2), 5 + Math.round(exp.height / 4), 1, 1).data;
    return { dark: wbPal().dark, ink: wbCol('#1e1e1e', true), note: wbCol('#fff3a3', true), light: wbCol('#fff3a3', false), odd: wbCol('#123456', true),
      none: wbCol('none', true), stored: wb.board.items.n1.fill, exportPx: [...px].slice(0, 3) };
  });
  assert.equal(r.dark, true);
  assert.equal(r.ink, '#e9ecef', 'black ink turns light');
  assert.equal(r.note, '#5f5524', 'yellow notes turn deep and soft');
  assert.equal(r.light, '#fff3a3', 'light mode leaves colours alone');
  assert.match(r.odd, /^hsl\(210 65% \d+%\)$/, 'other colours keep their hue');
  assert.ok(Number(/(\d+)%\)$/.exec(r.odd)[1]) > 60, 'and get lighter when they were dark');
  assert.equal(r.none, 'none');
  assert.equal(r.stored, '#fff3a3', 'the board keeps the original colour');
  assert.deepEqual(r.exportPx, [0xff, 0xf3, 0xa3], 'pictures are exported in light colours');
  // switching to light mode while the board is open redraws it with the original colours
  await tab(page, 'settings'); await page.click('[data-theme-set="light"]'); await tab(page, 'board');
  assert.equal(await page.evaluate(() => wbPal().dark), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('whiteboard fullscreen: F and the button toggle it, the list hides until B, Esc and other tabs leave it', async () => {
  const { ctx, page, errors } = await open({ lang: 'en' });
  await tab(page, 'board');
  await page.waitForFunction(() => wb.board);
  await page.focus('#wbStage');
  const state = () => page.evaluate(() => ({ full: wbFull(), side: wbSideShown(), sideVisible: !!$('wb').querySelector('.wb-side').offsetParent,
    rect: $('wb').getBoundingClientRect().toJSON(), vw: innerWidth, vh: innerHeight, pref: localStorage.getItem('ping.wbSide'), label: $('wbFullBtn').getAttribute('aria-label') }));
  let s = await state();
  assert.equal(s.full, false); assert.equal(s.sideVisible, true); assert.equal(s.label, 'Fullscreen');
  await page.keyboard.press('f');
  s = await state();
  assert.equal(s.full, true);
  assert.equal(s.sideVisible, false, 'the list of boards hides in fullscreen');
  assert.equal(Math.round(s.rect.width), s.vw); assert.equal(Math.round(s.rect.height), s.vh);
  assert.equal(s.label, 'Exit fullscreen');
  const look = await page.evaluate(() => [$('wbFullBtn'), $('wbSideBtn')].map(b => getComputedStyle(b).backgroundColor));
  assert.equal(look[0], look[1], 'the exit button looks like the other buttons, not filled with colour');
  await page.keyboard.press('b');
  s = await state();
  assert.equal(s.sideVisible, true, 'B shows the list in fullscreen');
  await page.click('#wbSideHide');
  assert.equal((await state()).sideVisible, false, 'the « button hides it again');
  await page.keyboard.press('Escape');
  s = await state();
  assert.equal(s.full, false, 'Esc leaves fullscreen');
  assert.equal(s.sideVisible, true, 'the normal view keeps its own list setting');
  assert.equal(s.pref, null, 'fullscreen does not change the remembered choice');
  // the button, and leaving the tab
  await page.click('#wbFullBtn');
  assert.equal((await state()).full, true);
  await page.evaluate(() => showTab('reminders'));   // e.g. Edit on a reminder that pops up while the board is fullscreen
  assert.equal(await page.evaluate(() => wbFull()), false, 'another tab ends fullscreen');
  // B in the normal view hides the list and remembers it
  await tab(page, 'board'); await page.focus('#wbStage');
  await page.keyboard.press('b');
  s = await state();
  assert.equal(s.sideVisible, false); assert.equal(s.pref, '0');
  assert.equal(await page.getAttribute('#wbSideBtn', 'aria-label'), 'Show your boards');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: the list stays in view at the bottom of a long note, and picking a note starts at its top', async () => {
  const long = '# Lång\n\n' + Array.from({ length: 200 }, (_, i) => `Rad ${i + 1}`).join('\n\n');
  const notes = [{ id: 'a', text: long, created: 2, modified: 2 }, ...Array.from({ length: 40 }, (_, i) => ({ id: 'n' + i, text: '# Anteckning ' + i, created: 1, modified: 1 }))];
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes } });
  await page.setViewportSize({ width: 1280, height: 720 });
  await tab(page, 'notes');
  await page.click('#noteList li[data-id="a"]');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  const r = await page.evaluate(() => ({ y: scrollY, list: $('noteList').getBoundingClientRect().toJSON(), vh: innerHeight, inner: $('noteList').scrollHeight > $('noteList').clientHeight }));
  assert.ok(r.y > 1000, 'the page really scrolled down: ' + r.y);
  assert.ok(r.list.top >= 0 && r.list.top < 120 && r.list.bottom <= r.vh, `the list is on screen: ${JSON.stringify(r.list)}`);
  assert.equal(r.inner, true, 'a long list scrolls inside itself');
  await page.click('#noteList li[data-id="n3"]');
  assert.equal(await page.evaluate(() => curNote.id), 'n3');
  assert.ok(await page.evaluate(() => scrollY) < 200, 'the new note starts at its top');
  // on a phone the list sits above the note and scrolls away as before
  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.note-side')).position), 'static');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ------------------------------------------------------------------ notes: one view (live preview)
const LIVE_NOTE = ['# Plan', '', 'Ett stycke med **fetstil** och en [länk](https://example.com/x).', '', '## Lista', '',
  '- [ ] Ring Anna', '- [ ] Boka möte', '- [ ] Skicka rapport', '', '1. Ett', '2. Två', '3. Tre', '', '```sql', 'SELECT 1;', '```', '', 'Sista raden.'].join('\n');
const liveState = page => page.evaluate(() => ({ live: live && { ...live }, open: liveOpen(), line: lineAt(noteText.selectionStart), focus: document.activeElement === noteText,
  shown: [...$('notePreview').children].filter(e => e !== liveEd).map(e => e.tagName + (e.start > 1 ? '@' + e.start : '')).join(' ') }));

test('notes: one view, formatted, with no Edit/Preview buttons; a click opens just that part with the cursor there', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text: LIVE_NOTE, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  assert.equal(await page.locator('[data-view]').count(), 0, 'no view buttons');
  let s = await liveState(page);
  assert.equal(s.open, false, 'opens fully formatted');
  assert.equal(await page.locator('#notePreview h1').innerText(), 'Plan');
  assert.equal(await page.isVisible('#noteTools'), true, 'the toolbar is always there');
  await page.locator('#notePreview strong', { hasText: 'fetstil' }).click();   // the middle of the word
  s = await liveState(page);
  assert.equal(s.open, true); assert.equal(s.focus, true);
  assert.deepEqual(s.live, { a: 2, b: 3 }, 'only the paragraph is open');
  assert.equal(await page.locator('#notePreview > p').count(), 1, 'the rest stays formatted (the last paragraph)');
  const r = await page.evaluate(() => { const p = noteText.selectionStart, v = noteText.value; return { p, from: v.indexOf('fetstil'), to: v.indexOf('fetstil') + 7 }; });
  assert.ok(r.p > r.from && r.p < r.to, `the cursor lands inside the clicked word: ${JSON.stringify(r)}`);
  // typing changes the note and is saved; Esc shows it all formatted again
  await page.keyboard.press('End'); await page.keyboard.type(' Mer text.');
  await page.waitForTimeout(600);
  assert.match((await stored(page)).notes[0].text, /example\.com\/x\)\. Mer text\./);
  await page.keyboard.press('Escape');
  assert.equal((await liveState(page)).open, false);
  assert.match(await page.locator('#notePreview > p').first().innerText(), /Mer text\.$/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: arrow keys move from part to part, and lists split around the open item', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text: LIVE_NOTE, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  await page.locator('#notePreview li.task span', { hasText: 'Boka möte' }).click();
  let s = await liveState(page);
  assert.deepEqual(s.live, { a: 7, b: 8 }, 'just the one list item');
  assert.match(s.shown, /^H1 P H2 UL UL OL/, 'the list is split around it: ' + s.shown);
  await page.keyboard.press('ArrowDown');
  s = await liveState(page);
  assert.equal(s.line, 8); assert.deepEqual(s.live, { a: 8, b: 9 });
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  s = await liveState(page);
  assert.equal(s.line, 11, 'on "2. Två"');
  assert.match(s.shown, /OL OL@3/, 'the numbered list goes on from 3 after the open item: ' + s.shown);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  assert.equal((await liveState(page)).line, 9, 'a blank line opens with the part above it');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("notes: checkboxes tick, links don't navigate on a plain click, toolbar and find open the right part", async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text: LIVE_NOTE, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  await page.locator('#notePreview li.task input').first().click();
  assert.match((await stored(page)).notes[0].text, /- \[x\] Ring Anna/);
  assert.equal((await liveState(page)).open, false, "ticking a box doesn't open the editor");
  const url = page.url();
  await page.locator('#notePreview a', { hasText: 'länk' }).click();
  assert.equal(page.url(), url, 'a plain click on a link edits instead of leaving');
  assert.equal((await liveState(page)).open, true);
  await page.keyboard.press('Escape');
  // the toolbar works with nothing open: it opens the part at the cursor
  await page.evaluate(() => { const k = noteText.value.indexOf('Sista'); setSel(k, k + 5); });
  await page.click('#noteTools [data-fmt="bold"]');
  assert.match(await page.evaluate(() => noteText.value), /\*\*Sista\*\* raden\./);
  assert.equal((await liveState(page)).open, true);
  // find opens the part that holds the match
  await page.keyboard.press('Control+f');
  await page.keyboard.type('SELECT');
  await page.waitForTimeout(100);
  assert.deepEqual((await liveState(page)).live, { a: 14, b: 17 }, 'the code block with the match is open');
  assert.equal(await page.locator('#noteFind mark.cur').count(), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: a new note opens ready to write, and finished parts turn formatted as you go', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [] } });
  await tab(page, 'notes');
  assert.equal((await liveState(page)).open, true, 'with no notes, the editor is open');
  await page.click('#noteText');
  await page.keyboard.type('# Ny\n\nHej **du**\n\nTredje');
  await page.waitForTimeout(700);
  const s = await liveState(page);
  assert.deepEqual(s.live, { a: 4, b: 5 }, 'the part being written is open');
  assert.match(s.shown, /^H1 P$/, 'the parts above are formatted: ' + s.shown);
  assert.equal(await page.locator('#notePreview strong').innerText(), 'du');
  assert.equal((await stored(page)).notes[0].text, '# Ny\n\nHej **du**\n\nTredje');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: dragging selects formatted text for copying (also across parts); a plain click still opens a part', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text: LIVE_NOTE, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  await page.evaluate(() => document.addEventListener('copy', e => { window.__copied = e.clipboardData.getData('text/plain') || getSelection().toString(); }));
  const drag = async (from, to, dx = 30) => {
    const a = await page.locator(from).boundingBox(), b = await page.locator(to).boundingBox();
    await page.mouse.move(a.x + dx, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
  };
  // from the paragraph down into the list: a normal selection, nothing opens
  await drag('#notePreview > p >> nth=0', '#notePreview li.task >> nth=1');
  let s = await liveState(page);
  assert.equal(s.open, false, 'dragging does not open a part');
  const picked = await page.evaluate(() => getSelection().toString());
  assert.match(picked, /fetstil[\s\S]*Lista[\s\S]*Ring Anna/, 'the selection spans the parts: ' + picked);
  await page.keyboard.press('Control+c');
  assert.match(await page.evaluate(() => window.__copied), /Lista/);
  assert.doesNotMatch(picked, /⏰/, 'the reminder buttons are not part of the selection');
  // a plain click still opens the part
  await page.locator('#notePreview h2').click();
  s = await liveState(page);
  assert.deepEqual(s.live, { a: 4, b: 5 });
  // with that part open, a selection from the heading above to the list below copies the open part's text too
  await drag('#notePreview h1', '#notePreview li.task >> nth=1', 1);
  assert.equal((await liveState(page)).open, true, 'the open part stays while you select');
  await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() => window.__copied);
  assert.match(copied, /Plan[\s\S]*fetstil[\s\S]*## Lista[\s\S]*Ring Anna/, 'copied: ' + copied);
  assert.doesNotMatch(copied, /⏰/, 'no button icons in the copy');
  assert.match(copied, /Ring Anna\n/, 'one line per list item');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: ticking a checkbox keeps the open part and the page where they are (real-speed clicks)', async () => {
  const text = ['# Lång', '', ...Array.from({ length: 20 }, (_, i) => `Stycke ${i + 1}.\n`), ...Array.from({ length: 6 }, (_, i) => `- [ ] Uppgift ${i + 1}`)].join('\n');
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text, created: 1, modified: 1 }] } });
  await page.setViewportSize({ width: 1280, height: 700 });
  await tab(page, 'notes');
  // like Edge on Windows: a clicked checkbox takes the keyboard focus
  await page.evaluate(() => document.addEventListener('mousedown', e => { if (e.target.matches('input[type=checkbox]')) e.target.focus(); }, true));
  await page.locator('#notePreview > p', { hasText: 'Stycke 18.' }).click();
  const before = await page.evaluate(() => ({ live: { ...live }, sel: noteText.selectionStart }));
  await page.locator('#notePreview li.task input').nth(2).scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  for (const k of [2, 3]) await page.locator('#notePreview li.task input').nth(k).click({ delay: 120 });
  await page.waitForTimeout(100);       // Edge resets an unfocused editor's cursor on the next frame: Pinglapp must not follow it
  const after = await page.evaluate(() => ({ live: live && { a: live.a, b: live.b }, sel: selNow()[0], y: scrollY, text: noteText.value }));
  assert.match(after.text, /- \[x\] Uppgift 3\n- \[x\] Uppgift 4/);
  assert.deepEqual(after.live, before.live, 'the open part stays open where it was');
  assert.equal(after.sel, before.sel, 'Pinglapp still has the cursor where it was');
  assert.equal(after.y, y, 'the page did not scroll');
  // carrying on typing (here via the toolbar, which doesn't move the mouse) writes where the cursor was
  await page.click('#noteTools [data-fmt="bold"]');
  assert.match(await page.evaluate(() => noteText.value), /Stycke 18\.\*\*/, 'bold went in at the old cursor, not at the start');
  assert.deepEqual(await page.evaluate(() => ({ a: live.a, b: live.b })), before.live);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('notes: Ctrl+A selects the open part, then everything; margin clicks and quick arrow keys stay in sight', async () => {
  const T = ['# Titel', '', 'Första stycket här.', '', 'Andra stycket här.', '', 'Tredje stycket här.'].join('\n');
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text: T, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  const st = () => page.evaluate(() => ({ live: live && { ...live }, sel: noteText.value.slice(noteText.selectionStart, noteText.selectionEnd), line: lineAt(noteText.selectionStart) }));
  await page.locator('#notePreview > p', { hasText: 'Andra' }).click();
  await page.keyboard.press('Control+a');
  assert.equal((await st()).sel, 'Andra stycket här.', 'first Ctrl+A: just the open part');
  await page.keyboard.press('Control+a');
  let s = await st();
  assert.equal(s.sel, T, 'second Ctrl+A: the whole note');
  assert.deepEqual(s.live, { a: 0, b: 7, all: true }, 'and all of it is open, so you see what is selected');
  await page.keyboard.press('Control+z').catch(() => {});
  await page.keyboard.press('Escape');
  // a click in the margin just above or below the open text stays in that part
  await page.locator('#notePreview > p', { hasText: 'Andra' }).click();
  for (const edge of ['top', 'bottom']) {
    const b = await page.locator('#liveEd').boundingBox();
    await page.mouse.click(b.x + 100, edge === 'top' ? b.y + 2 : b.y + b.height - 2);
    s = await st();
    assert.equal(s.line, 4, `a click in the ${edge} margin stays on the part's line`);
    assert.deepEqual(s.live, { a: 4, b: 5 });
  }
  // arrow keys straight after typing: the cursor's part opens at once
  await page.keyboard.type('x'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  const v = await page.evaluate(() => { const r = caretRect(), e = liveEd.getBoundingClientRect(); return { line: lineAt(noteText.selectionStart), inside: r.top >= e.top - 1 && r.bottom <= e.bottom + 1 }; });
  assert.equal(v.line, 6); assert.equal(v.inside, true, 'the cursor is inside the open window');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ------------------------------------------------------------------ found in the edge-case hunt
test('hunt: a link right after a web address cannot inject attributes; addresses with (brackets) work; CSV cells are not formulas', async () => {
  const text = 'Hover: https://a.com/[click me](https://b.com/onmouseover=window.PWNED=2//) end\n\n[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and https://en.wikipedia.org/wiki/Baz_(qux).';
  const { ctx, page, errors } = await open({ seed: { reminders: [{ id: 'f', title: '=HYPERLINK("http://x","y")', notes: '+cmd', due: Date.now() + 3600e3, repeat: 'none', tags: [], fired: false }], notes: [{ id: 'a', text, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  const r = await page.evaluate(() => ({ attrs: [...document.querySelectorAll('#notePreview a')].map(a => a.getAttributeNames().join(',')), hrefs: [...document.querySelectorAll('#notePreview a')].map(a => a.getAttribute('href')) }));
  for (const names of r.attrs) assert.equal(names, 'href,target,rel', 'only the link attributes we write');
  assert.ok(r.hrefs.includes('https://en.wikipedia.org/wiki/Foo_(bar)'), JSON.stringify(r.hrefs));
  assert.ok(r.hrefs.includes('https://en.wikipedia.org/wiki/Baz_(qux)'), JSON.stringify(r.hrefs));
  for (const a of await page.locator('#notePreview a').all()) await a.hover();
  assert.equal(await page.evaluate(() => window.PWNED), undefined);
  const csv = await page.evaluate(() => { let out = ''; const dl = window.downloadFile; window.downloadFile = (n, c) => { out = c; }; exportCsv(); window.downloadFile = dl; return out; });
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""y"")"`), 'formula cell neutralised: ' + csv.split('\n')[1]);
  assert.ok(csv.includes(`,'+cmd`), 'notes cell neutralised');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('hunt: undo of a deleted note keeps later edits; an emptied note goes to the trash with its text', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text: 'Note A', created: 2, modified: 2 }, { id: 'b', text: 'Note B', created: 1, modified: 1, history: [{ t: 1, text: 'Note B old' }] }] } });
  await tab(page, 'notes');
  await page.click('#noteList li[data-id="a"]');
  await page.click('[data-act="del-note"]');
  await page.evaluate(() => { loadNote(S.notes.find(n => n.id === 'b')); liveFocus(noteText.value.length); });
  await page.keyboard.type(' plus edit');
  await page.waitForTimeout(400);
  await page.click('#toastAct');               // Undo the delete
  let d = await stored(page);
  assert.ok(!d.notes.find(n => n.id === 'a').trashed, 'A is back');
  assert.equal(d.notes.find(n => n.id === 'b').text, 'Note B plus edit', 'the edit to B is kept');
  // empty B completely and switch away: it goes to the trash with its last saved text
  await page.evaluate(() => { loadNote(S.notes.find(n => n.id === 'b')); liveFocus(0); });
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  await page.click('#noteList li[data-id="a"]');
  d = await stored(page);
  const b = d.notes.find(n => n.id === 'b');
  assert.ok(b && b.trashed, 'B is in the trash, not gone');
  assert.ok(b.text.startsWith('Note B'), 'with its last text: ' + (b && b.text));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('hunt: Markdown: fence info, list numbers, backslash escapes, h5/h6, * * *, bold/italic buttons, find with İ', async () => {
  const text = ['```js title="a.js"', 'const x = 1;', '```', '# After', '', '3. three', '4. four', '', String.raw`\*not italic\* and a\_b`, '', '##### five', '###### six', '', '* * *', '', 'İİİ prefix target here; target again'].join('\n');
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'a', text, created: 1, modified: 1 }] } });
  await tab(page, 'notes');
  const r = await page.evaluate(() => ({
    code: [...document.querySelectorAll('#notePreview .code .ln')].map(l => l.textContent).join('|'),
    h1: document.querySelector('#notePreview h1')?.textContent, ol: document.querySelector('#notePreview ol')?.start,
    p: [...document.querySelectorAll('#notePreview p')].map(p => p.textContent), h5: document.querySelector('#notePreview h5')?.textContent,
    h6: document.querySelector('#notePreview h6')?.textContent, hr: document.querySelectorAll('#notePreview hr').length, em: document.querySelectorAll('#notePreview p em').length }));
  assert.equal(r.code, 'const x = 1;'); assert.equal(r.h1, 'After');
  assert.equal(r.ol, 3, 'the list starts at 3');
  assert.ok(r.p.includes('*not italic* and a_b'), JSON.stringify(r.p)); assert.equal(r.em, 0, 'escaped stars are not italic');
  assert.equal(r.h5, 'five'); assert.equal(r.h6, 'six'); assert.equal(r.hr, 1);
  // find: highlights cover "target", even after letters whose lower case is longer
  await page.evaluate(() => liveFocus(0));
  await page.keyboard.press('Control+f'); await page.keyboard.type('target');
  assert.deepEqual(await page.evaluate(() => findHits.map((p, k) => noteText.value.slice(p, p + findLens[k]))), ['target', 'target']);
  await page.keyboard.press('Escape');
  // bold on two lines marks each line; italic on **bold** adds italic
  const fmt = (val, a, b, kind) => page.evaluate(([val, a, b, kind]) => { noteText.value = val; live = null; liveFocus(0); setSel(a, b); applyFmt(kind); return noteText.value; }, [val, a, b, kind]);
  assert.equal(await fmt('line1\nline2', 0, 11, 'bold'), '**line1**\n**line2**');
  assert.equal(await fmt('- a\n- b', 0, 7, 'bold'), '- **a**\n- **b**');
  assert.equal(await fmt('**bold**', 0, 8, 'italic'), '***bold***');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('hunt: reminders: title-only edit keeps the snooze, reopened repeats come back, keys skip hidden rows, dialogs sit above alerts', async () => {
  const now = Date.now(), snoozed = now + 86400e3;
  const { ctx, page, errors } = await open({ seed: { reminders: [
    { id: 's', title: 'Tea', due: now + 7200e3 + 37000, repeat: 'none', tags: [], fired: true, snoozeUntil: snoozed },
    { id: 'd', title: 'Daily', due: now - 7200e3, repeat: 'daily', tags: [], fired: true, done: true, completedAt: now - 3600e3 },
    { id: 'k1', title: 'Repeating', due: now + 3600e3, repeat: 'daily', tags: [], fired: false },
    { id: 'k2', title: 'One-off', due: now + 3600e3, repeat: 'none', tags: [], fired: false }], notes: [] }, lang: 'en' });
  // edit only the title
  await page.evaluate(() => openEditor(find('s'), false));
  await page.fill('#edTitle', 'Green tea');
  await page.evaluate(() => $('editForm').requestSubmit());
  let r = await page.evaluate(() => find('s'));
  assert.equal(r.title, 'Green tea'); assert.equal(r.snoozeUntil, snoozed, 'still snoozed'); assert.equal(r.fired, true);
  // reopen a done daily reminder whose time has passed: it moves to its next time and will go off
  await page.evaluate(() => reopen(find('d')));
  r = await page.evaluate(() => find('d'));
  assert.ok(r.due > Date.now(), 'moved to the next day'); assert.equal(r.fired, false);
  // a key acts only on a reminder you can see: select k2, hide it with a search, press x
  await page.evaluate(() => { selId = 'k2'; $('search').value = 'Repeating'; renderReminders(); });
  assert.equal(await page.locator('.rem[data-id="k2"]').count(), 0, 'k2 is hidden');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('x');
  assert.ok(!(await page.evaluate(() => find('k2'))).done, 'the hidden reminder was not marked done');
  // the editor is above a reminder alert
  const z = await page.evaluate(() => [getComputedStyle($('editor')).zIndex, getComputedStyle(document.querySelector('.alerts')).zIndex].map(Number));
  assert.ok(z[0] > z[1], 'editor ' + z[0] + ' over alerts ' + z[1]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('hunt: daily 02:30 comes back to 02:30 after the spring clock change', async () => {
  const { ctx, page } = await open();
  const runs = await page.evaluate(() => {
    const r = { repeat: 'daily', due: new Date(2026, 2, 28, 2, 30).getTime(), wall: [2, 30] }, out = [];
    for (let k = 0; k < 3; k++) { r.due = nextAfter(r, r.due, r.due); const d = new Date(r.due); out.push(`${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`); }
    return out;
  });
  assert.deepEqual(runs, ['29 3:30', '30 2:30', '31 2:30']);
  await ctx.close();
});

test('hunt: damaged backups are refused cleanly; Replace on the open board shows it, and Undo brings boards back', async () => {
  const { ctx, page, errors } = await open({ seed: { reminders: [], notes: [{ id: 'g', text: 'Good note', created: 1, modified: 1 }] }, lang: 'en' });
  // a damaged entry is dropped, the rest restores
  await page.evaluate(() => { pendingRestore = { reminders: [null, { id: 'r', title: 'Kept', due: Date.now() + 1e6, repeat: 'none' }], notes: [null, { id: 'n', text: 12345 }] }; document.querySelector('input[name=restoreMode][value=add]').checked = true; });
  await page.evaluate(() => doRestore());
  await tab(page, 'notes');
  const d = await stored(page);
  assert.ok(d.reminders.some(r => r.id === 'r'), 'the good reminder was added');
  assert.equal(d.notes.find(n => n.id === 'n').text, '12345', 'a number as text is repaired');
  assert.equal(await page.locator('#noteList li[data-id="g"]').count(), 1, 'the note list still works');
  // boards: Replace while the board is open
  await tab(page, 'board'); await page.waitForFunction(() => wb.board);
  const id = await page.evaluate(() => { wb.board.items.x = { id: 'x', type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: 'OLD', z: 1, author: 'a' }; wbChanged(); return wb.board.id; });
  await page.evaluate(() => wbSaveNow());
  await page.evaluate(id => { pendingRestore = { reminders: [], notes: [], boards: [{ id, title: 'B', items: { y: { id: 'y', type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: 'FROM BACKUP', z: 1, author: 'a' } } }] }; document.querySelector('input[name=restoreMode][value=replace]').checked = true; }, id);
  await page.evaluate(() => doRestore());
  assert.deepEqual(await page.evaluate(() => Object.values(wb.board.items).map(i => i.text)), ['FROM BACKUP'], 'the open board shows the restored one');
  await page.evaluate(() => wbSaveNow());
  assert.match(await page.evaluate(id => kv.get('board-' + id), id), /FROM BACKUP/, 'and storage keeps it');
  await page.click('#toastAct');               // Undo
  await page.waitForFunction(() => wb.board && Object.values(wb.board.items).some(i => i.text === 'OLD'));
  assert.match(await page.evaluate(id => kv.get('board-' + id), id), /OLD/, 'Undo put the board back');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('hunt: whiteboard: a long unbroken word wraps fast; dragging a tied arrow moves it loose and Undo ties it again', async () => {
  const { ctx, page, errors } = await open({ lang: 'en' });
  await tab(page, 'board'); await page.waitForFunction(() => wb.board);
  const ms = await page.evaluate(() => { const t0 = performance.now(); wbFitCache.clear(); wbStickyFs({ text: 'x'.repeat(4000), w: 200, h: 200 }); return performance.now() - t0; });
  assert.ok(ms < 1500, `a 4000-letter word took ${Math.round(ms)} ms`);
  await page.evaluate(() => {
    const it = wb.board.items;
    it.a = { id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 60, z: 1, author: wb.me.cid };
    it.b = { id: 'b', type: 'rect', x: 400, y: 0, w: 100, h: 60, z: 2, author: wb.me.cid };
    it.l = { id: 'l', type: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0, from: 'a', to: 'b', z: 3, author: wb.me.cid };
    wbCenterOn(250, 30, 1); wbDraw();
  });
  const box = await page.locator('#wbCanvas').boundingBox();
  const mid = await page.evaluate(() => { const [p, q] = Board.ends(wb.board.items.l, wb.board.items); return wbToScreen((p[0] + q[0]) / 2, (p[1] + q[1]) / 2); });
  await page.mouse.move(box.x + mid[0], box.y + mid[1]); await page.mouse.down();
  await page.mouse.move(box.x + mid[0], box.y + mid[1] + 120, { steps: 6 }); await page.mouse.up();
  let l = await page.evaluate(() => wb.board.items.l);
  assert.ok(!l.from && !l.to, 'the arrow came loose'); assert.ok(l.y1 > 60, 'and moved down: ' + l.y1);
  await page.keyboard.press('Control+z');
  l = await page.evaluate(() => wb.board.items.l);
  assert.equal(l.from, 'a'); assert.equal(l.to, 'b');
  assert.deepEqual(errors, []);
  await ctx.close();
});
