// Syncing pictures in notes and whiteboards through an account, the storage quota, and "remove from this device".
// Two browser profiles ("devices") share one FakeServer, whose storage follows the bucket policies.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { FAKE, FakeServer } from './fake-supabase.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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

const T0 = Date.now() - 3600000;
const ready = page => page.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow && fileInitDone && imgReady);
async function device(srv, data) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.exposeFunction('__pingServer', json => srv.handle(json));
  await ctx.addInitScript(data => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const d = Object.assign({ reminders: [], notes: [] }, data || {});
    d.settings = Object.assign({ lang: 'en', onboarded: true, driveGuideSeen: true }, d.settings || {});
    localStorage.setItem('reminder-by-me.v1', JSON.stringify(d));
  }, data || null);
  await ctx.addInitScript(FAKE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  await page.goto(base);
  await ready(page);
  return { ctx, page, errors };
}
async function login(page, email = 'a@example.com', pw = 'correct-horse-1') {
  if (await page.isHidden('#acctDlg')) await page.click('#acctChip');
  await page.fill('#acctDlg [data-acct-view=signin] [name=email]', email);
  await page.fill('#acctDlg [data-acct-view=signin] [name=password]', pw);
  await page.click('#acctDlg [data-acct-view=signin] [type=submit]');
  await page.waitForFunction(() => !!acct.session && acct.profile !== undefined);
}
const settled = page => page.waitForFunction(() => !cloud.busy && !cloud.timer && ['ok', 'full', 'error', 'offline', 'toobig'].includes(cloud.state));
const sync = async page => { await page.evaluate(() => cloudSync()); await settled(page); };
async function mergeIfAsked(page) {
  await page.waitForFunction(() => acct.pendingStep || cloud.state === 'ok' || cloud.state === 'full');
  if (await page.evaluate(() => acct.pendingStep === 'ask')) await page.click('#acctDlg [data-acct-view=merge] [data-act=acct-merge]');
  await settled(page);
}
// The account page, whether or not the dialog is already open on another step.
async function openAccount(page) {
  if (await page.isHidden('#acctDlg')) await page.click('#acctChip');
  else await page.evaluate(() => acctShow('account'));
  await page.waitForFunction(() => acct.view === 'account');
}
const addPicture =(page, id) => page.evaluate(async ([id, png]) => { await kv.set('img-' + id, png); imgCache.set(id, png); imgIds.add(id); }, [id, PNG]);
const addBoard = (page, title) => page.evaluate(async title => {
  const b = Board.newBoard(title); b.modified = Date.now() - 60000;
  await kv.set('board-' + b.id, JSON.stringify(b)); await wbLoadList(); return b.id;
}, title);
const boardTitle = (page, id) => page.evaluate(async id => { const t = await kv.get('board-' + id); return t ? JSON.parse(t).title : null; }, id);

test('a picture in a note goes up once and appears on the other device', async () => {
  const srv = new FakeServer();
  const A = await device(srv, { notes: [{ id: 'n1', text: 'See ![x](ping-img:k1-pic)', created: T0, modified: T0, updated: T0 }] });
  await addPicture(A.page, 'k1-pic');
  await login(A.page);
  await mergeIfAsked(A.page);
  assert.deepEqual(srv.paths('u-a', 'note-images'), ['u-a/k1-pic']);
  const uploads = () => srv.log.filter(q => q.op === 'storage' && q.act === 'upload').length;
  const n = uploads();
  await sync(A.page);
  assert.equal(uploads(), n, 'not uploaded again');

  const B = await device(srv);
  await login(B.page);
  await settled(B.page);
  assert.equal(await B.page.evaluate(() => kv.get('img-k1-pic')), PNG);
  assert.equal(await B.page.evaluate(() => imgIds.has('k1-pic')), true);
  assert.match(await B.page.textContent('#acctChip'), /@alice/);
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close(); await B.ctx.close();
});

test('boards: created, edited and deleted on one device, the same on the other; old versions are cleaned up', async () => {
  const srv = new FakeServer();
  const A = await device(srv);
  const id = await addBoard(A.page, 'Plan');
  await login(A.page);
  await mergeIfAsked(A.page);
  assert.equal(srv.table('u-a', 'boards').get(id).data.title, 'Plan');
  assert.equal(srv.paths('u-a', 'boards').length, 1);

  const B = await device(srv);
  await login(B.page);
  await settled(B.page);
  assert.equal(await boardTitle(B.page, id), 'Plan');

  await B.page.evaluate(async id => { const b = JSON.parse(await kv.get('board-' + id)); b.title = 'Plan v2'; b.modified = Date.now(); await kv.set('board-' + id, JSON.stringify(b)); await wbLoadList(); }, id);
  await sync(B.page);
  assert.equal(srv.paths('u-a', 'boards').length, 1, 'the old version’s file was removed');
  await sync(A.page);
  assert.equal(await boardTitle(A.page, id), 'Plan v2');

  await A.page.evaluate(id => wbDeleteBoard(id), id);
  await sync(A.page);
  assert.equal(srv.table('u-a', 'boards').get(id).deleted, true);
  // (deleting the last board makes a fresh empty one, as always; that one may be there)
  assert.deepEqual(srv.paths('u-a', 'boards').filter(p => p.startsWith(`u-a/${id}-`)), [], 'the deleted board’s file is gone too');
  await sync(B.page);
  assert.equal(await boardTitle(B.page, id), null, 'deleted on B as well');
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close(); await B.ctx.close();
});

test('a full storage quota: pictures stay on the device, text still syncs, and it catches up when there’s room', async () => {
  const srv = new FakeServer();
  srv.quota['u-a'] = 1;
  srv.files.set('note-images/u-a/already-there', { b64: '', type: 'image/png', size: 5 });   // already over the limit
  const A = await device(srv, { notes: [{ id: 'n1', text: '![x](ping-img:k2-pic)', created: T0, modified: T0, updated: T0 }] });
  await addPicture(A.page, 'k2-pic');
  await login(A.page);
  await mergeIfAsked(A.page);
  assert.equal(await A.page.evaluate(() => cloud.state), 'full');
  assert.match(await A.page.getAttribute('#acctChip', 'class'), /\boff\b/);
  assert.deepEqual(srv.rows('u-a', 'notes').map(r => r.id), ['n1'], 'the note itself synced');
  assert.ok(!srv.paths('u-a', 'note-images').includes('u-a/k2-pic'));
  await openAccount(A.page);
  assert.match(await A.page.textContent('#acctSyncState'), /storage is full.*of 0 MB used/s);
  srv.quota['u-a'] = 26214400;
  await sync(A.page);
  assert.equal(await A.page.evaluate(() => cloud.state), 'ok');
  assert.ok(srv.paths('u-a', 'note-images').includes('u-a/k2-pic'));
  await A.ctx.close();
});

test('remove from this device: refused while something isn’t in the account; then everything here goes', async () => {
  const srv = new FakeServer();
  const A = await device(srv, { notes: [{ id: 'n1', text: '![x](ping-img:k3-pic)', created: T0, modified: T0, updated: T0 }] });
  await addPicture(A.page, 'k3-pic');
  const id = await addBoard(A.page, 'Secret plan');
  await login(A.page);
  await mergeIfAsked(A.page);
  await openAccount(A.page);
  await A.page.click('#acctDlg [data-acct-view=account] [data-act=acct-signout-ask]');
  assert.equal(await A.page.evaluate(() => acct.view), 'signout');

  srv.offline = true;
  await A.page.click('#acctDlg [data-act=acct-signout-remove]');
  await A.page.waitForFunction(() => /Not everything has reached/.test(document.getElementById('acctMsg').textContent));
  assert.equal(await A.page.evaluate(() => !!acct.session), true, 'still logged in');
  assert.equal(await boardTitle(A.page, id), 'Secret plan', 'nothing removed');

  srv.offline = false;
  await Promise.all([A.page.waitForEvent('load'), A.page.click('#acctDlg [data-act=acct-signout-remove]')]);
  await ready(A.page);
  const left = await A.page.evaluate(async () => ({
    notes: S.notes.length, keys: (await kv.keys()).map(String).filter(k => /^(img-|board-|snap-|file$)/.test(k)),
    cloud: localStorage.getItem('pinglapp.cloud'), session: localStorage.getItem('pinglapp.auth'), chip: document.getElementById('acctChipText').textContent,
  }));
  assert.deepEqual(left, { notes: 0, keys: [], cloud: null, session: null, chip: 'Log in' });
  assert.deepEqual(srv.rows('u-a', 'notes').map(r => r.id), ['n1'], 'the account still has everything');
  assert.ok(srv.paths('u-a', 'note-images').includes('u-a/k3-pic'));
  assert.equal(srv.table('u-a', 'boards').get(id).data.title, 'Secret plan');

  await login(A.page);
  await settled(A.page);
  assert.equal(await boardTitle(A.page, id), 'Secret plan', 'logging in again brings it all back');
  assert.equal(await A.page.evaluate(() => kv.get('img-k3-pic')), PNG);
  await A.ctx.close();
});

test('another account’s boards are not mixed in either', async () => {
  const srv = new FakeServer();
  const A = await device(srv);
  await A.page.evaluate(() => localStorage.setItem('pinglapp.cloud', JSON.stringify({ owner: 'u-a' })));
  const id = await addBoard(A.page, 'Alice’s board');
  await login(A.page, 'c@example.com', 'correct-horse-3');
  await A.page.waitForFunction(() => acct.view === 'other');
  await Promise.all([A.page.waitForEvent('download'), A.page.click('#acctDlg [data-acct-view=other] [data-act=acct-replace]')]);
  await settled(A.page);
  assert.equal(await boardTitle(A.page, id), null);
  assert.deepEqual(srv.rows('u-c', 'boards'), []);
  assert.deepEqual(srv.paths('u-c', 'boards'), []);
  await A.ctx.close();
});
