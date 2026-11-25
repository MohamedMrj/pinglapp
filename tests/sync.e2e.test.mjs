// Syncing reminders, notes and settings through an account, in the real page. Each test uses a fresh FakeServer
// (rules as in the database) shared by two browser profiles - two "devices".
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
const rem = (id, title, updated = T0) => ({ id, title, due: Date.now() + 86400000 * 7, updated, tags: [], priority: 0, notes: '' });
const note = (id, text, updated = T0) => ({ id, text, created: updated, modified: updated, updated, pinned: false });

// One device: a fresh browser profile with Pinglapp open, talking to `srv`.
async function device(srv, { data, cloudState } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.exposeFunction('__pingServer', json => srv.handle(json));
  await ctx.addInitScript(([data, cloudState]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const d = Object.assign({ reminders: [], notes: [] }, data || {});
    d.settings = Object.assign({ lang: 'sv', onboarded: true, driveGuideSeen: true }, d.settings || {});
    localStorage.setItem('reminder-by-me.v1', JSON.stringify(d));
    if (cloudState) localStorage.setItem('pinglapp.cloud', JSON.stringify(cloudState));
  }, [data || null, cloudState || null]);
  await ctx.addInitScript(FAKE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  await page.goto(base);
  await page.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow && fileInitDone);
  return { ctx, page, errors };
}
async function login(page, email, pw) {
  await page.click('#acctChip');
  await page.fill('#acctDlg [data-acct-view=signin] [name=email]', email);
  await page.fill('#acctDlg [data-acct-view=signin] [name=password]', pw);
  await page.click('#acctDlg [data-acct-view=signin] [type=submit]');
  await page.waitForFunction(() => !!acct.session && acct.profile !== undefined);
}
const synced = page => page.waitForFunction(() => cloud.state === 'ok' && !cloud.busy && !cloud.timer);
const sync = async page => { await page.evaluate(() => cloudSync()); await synced(page); };
const local = page => page.evaluate(() => ({ reminders: S.reminders.map(r => [r.id, r.title]), notes: S.notes.map(n => [n.id, n.text]), lang: S.settings.lang, deleted: Object.keys(S.deleted) }));
const live = (srv, uid, kind) => srv.rows(uid, kind).filter(r => !r.deleted).map(r => r.id).sort();

test('a guest’s data is added to the account after asking, and a second device gets it', async () => {
  const srv = new FakeServer();
  const A = await device(srv, { data: { reminders: [rem('r1', 'Pay rent')], notes: [note('n1', 'Shopping list')], settings: { lang: 'en' }, settingsUpdated: T0 } });
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await A.page.waitForFunction(() => acct.view === 'merge' && !document.getElementById('acctDlg').hidden);
  assert.equal(await A.page.evaluate(() => cloud.state), 'waiting');
  assert.equal(srv.log.filter(q => q.op === 'upsert').length, 0, 'nothing is sent before the answer');
  await A.page.click('#acctDlg [data-act=acct-merge]');
  await synced(A.page);
  assert.deepEqual(live(srv, 'u-a', 'reminders'), ['r1']);
  assert.deepEqual(live(srv, 'u-a', 'notes'), ['n1']);
  assert.equal(srv.table('u-a', 'settings').get('s').data.lang, 'en');
  assert.match(await A.page.getAttribute('#acctChip', 'class'), /\bon\b/);

  const B = await device(srv);
  await login(B.page, 'a@example.com', 'correct-horse-1');
  await synced(B.page);
  assert.notEqual(await B.page.evaluate(() => acct.view), 'merge', 'an empty device is not asked');
  const b = await local(B.page);
  assert.deepEqual(b.reminders, [['r1', 'Pay rent']]);
  assert.deepEqual(b.notes, [['n1', 'Shopping list']]);
  assert.equal(b.lang, 'en', 'the account’s settings win over a fresh device’s');
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close(); await B.ctx.close();
});

test('edits and deletions go both ways, and once in step nothing more is sent', async () => {
  const srv = new FakeServer();
  const A = await device(srv, { data: { reminders: [rem('r1', 'Pay rent')], notes: [note('n1', 'Shopping list')] } });
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await A.page.click('#acctDlg [data-act=acct-merge]');
  await synced(A.page);
  const B = await device(srv);
  await login(B.page, 'a@example.com', 'correct-horse-1');
  await synced(B.page);

  await B.page.evaluate(() => { S.reminders[0].title = 'Pay rent (done by B)'; save(); });
  await sync(B.page);
  await sync(A.page);
  assert.deepEqual((await local(A.page)).reminders, [['r1', 'Pay rent (done by B)']]);

  await A.page.evaluate(() => { S.notes = []; save(); });
  await sync(A.page);
  await sync(B.page);
  assert.deepEqual((await local(B.page)).notes, [], 'the deletion reached B');
  assert.deepEqual(live(srv, 'u-a', 'notes'), []);

  await A.page.evaluate(() => { S.reminders.push({ id: 'r2', title: 'Call mum', due: Date.now() + 3600000, tags: [], priority: 0, notes: '' }); save(); });
  await sync(A.page); await sync(B.page);
  assert.deepEqual((await local(B.page)).reminders.map(r => r[0]).sort(), ['r1', 'r2']);

  const mark = srv.log.length;
  for (let i = 0; i < 2; i++) { await sync(A.page); await sync(B.page); }
  const sent = srv.log.slice(mark).filter(q => q.op === 'upsert' && q.rows.length);
  assert.deepEqual(sent, [], 'in step: nothing is pushed again');
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close(); await B.ctx.close();
});

test('a change saved here is synced by itself a few seconds later', async () => {
  const srv = new FakeServer();
  const A = await device(srv);
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await synced(A.page);
  await A.page.evaluate(() => { S.notes.push({ id: 'auto', text: 'typed', created: Date.now(), modified: Date.now(), pinned: false }); save(); });
  await A.page.waitForFunction(() => cloud.timer !== null);
  await synced(A.page);
  await A.page.waitForTimeout(3500);
  await synced(A.page);
  assert.deepEqual(live(srv, 'u-a', 'notes'), ['auto']);
  await A.ctx.close();
});

test('offline: the chip says so, nothing is lost, and the changes go up when back online', async () => {
  const srv = new FakeServer();
  const A = await device(srv);
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await synced(A.page);
  srv.offline = true;
  await A.page.evaluate(() => { S.reminders.push({ id: 'off1', title: 'Written offline', due: Date.now() + 3600000, tags: [], priority: 0, notes: '' }); save(); });
  await A.page.evaluate(() => cloudSync());
  await A.page.waitForFunction(() => cloud.state === 'offline');
  assert.match(await A.page.getAttribute('#acctChip', 'class'), /\boff\b/);
  assert.match(await A.page.getAttribute('#acctChip', 'title'), /Offline/);
  assert.deepEqual((await local(A.page)).reminders.map(r => r[0]), ['off1']);
  srv.offline = false;
  await A.page.evaluate(() => dispatchEvent(new Event('online')));
  await synced(A.page);
  assert.deepEqual(live(srv, 'u-a', 'reminders'), ['off1']);
  assert.deepEqual(A.errors, []);
  await A.ctx.close();
});

test('another account’s data on this device is never mixed in: backup first, then only the new account', async () => {
  const srv = new FakeServer();
  const A = await device(srv, { data: { reminders: [rem('a-r', 'Alice’s reminder')], deleted: { 'a-old': T0 } }, cloudState: { owner: 'u-a' } });
  await login(A.page, 'c@example.com', 'correct-horse-3');
  await A.page.waitForFunction(() => acct.view === 'other' && !document.getElementById('acctDlg').hidden);
  assert.equal(srv.log.filter(q => q.op === 'upsert').length, 0);
  const [download] = await Promise.all([A.page.waitForEvent('download'), A.page.click('#acctDlg [data-acct-view=other] [data-act=acct-replace]')]);
  assert.match(download.suggestedFilename(), /^pinglapp-backup-.*\.json$/);
  await synced(A.page);
  const a = await local(A.page);
  assert.deepEqual(a.reminders, []);
  assert.deepEqual(a.deleted, [], 'no tombstones left over to push');
  assert.deepEqual(srv.rows('u-c', 'reminders'), [], 'nothing of Alice’s reached Carol’s account');
  assert.equal(await A.page.evaluate(() => JSON.parse(localStorage.getItem('pinglapp.cloud')).owner), 'u-c');
  assert.deepEqual(A.errors, []);
  await A.ctx.close();
});

test('answering no: a backup is downloaded and the device shows only the account’s data', async () => {
  const srv = new FakeServer();
  srv.run({ uid: 'u-a', table: 'reminders', op: 'upsert', rows: [{ user_id: 'u-a', id: 'acc-r', data: rem('acc-r', 'From the account'), updated: T0, deleted: false }] });
  const A = await device(srv, { data: { reminders: [rem('guest-r', 'Guest reminder')] } });
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await A.page.waitForFunction(() => acct.view === 'merge');
  const [download] = await Promise.all([A.page.waitForEvent('download'), A.page.click('#acctDlg [data-acct-view=merge] [data-act=acct-replace]')]);
  assert.ok(download);
  await synced(A.page);
  assert.deepEqual((await local(A.page)).reminders, [['acc-r', 'From the account']]);
  assert.deepEqual(live(srv, 'u-a', 'reminders'), ['acc-r'], 'the guest reminder was not added');
  await A.ctx.close();
});

test('signing in again on the same device just syncs, without asking', async () => {
  const srv = new FakeServer();
  const A = await device(srv, { data: { reminders: [rem('r1', 'Mine')] } });
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await A.page.click('#acctDlg [data-act=acct-merge]');
  await synced(A.page);
  if (await A.page.isHidden('#acctDlg')) await A.page.click('#acctChip');
  await A.page.click('#acctDlg [data-acct-view=account] [data-act=acct-signout]');
  await A.page.waitForFunction(() => !acct.session);
  assert.deepEqual((await local(A.page)).reminders, [['r1', 'Mine']], 'logging out keeps a copy');
  await A.page.evaluate(() => { S.reminders[0].title = 'Edited while logged out'; save(); });
  await login(A.page, 'a@example.com', 'correct-horse-1');
  await synced(A.page);
  assert.notEqual(await A.page.evaluate(() => acct.view), 'merge');
  assert.equal(srv.table('u-a', 'reminders').get('r1').data.title, 'Edited while logged out');
  await A.ctx.close();
});
