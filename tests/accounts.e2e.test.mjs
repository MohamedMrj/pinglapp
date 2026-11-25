// Accounts: the sign-in screens in the real page, with a stand-in for supabase-js (window.PING_ACCOUNTS_FAKE), so no
// emails are sent and nothing touches the real Supabase project. The database rules themselves are tested in db.test.mjs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { FAKE } from './fake-supabase.mjs';

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
const fileFor = async url => {
  const path = decodeURIComponent(new URL(url, 'http://x').pathname).replace(/\/$/, '/index.html');
  return { body: await readFile(join(ROOT, path)), type: TYPES[extname(path)] || 'application/octet-stream' };
};
before(async () => {
  server = http.createServer(async (req, res) => {
    try { const f = await fileFor(req.url); res.writeHead(200, { 'content-type': f.type }); res.end(f.body); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(findBrowser());
});
after(async () => { await browser?.close(); server?.close(); });

// A stand-in for Cloudflare Turnstile: each widget answers "tok-1", "tok-2", … shortly after render() or reset(),
// unless turnstile.hold is set; then turnstile.solve() answers.
const FAKE_TURNSTILE = () => {
  window.PING_ACCOUNTS_FAKE.turnstile = 'test-site-key';
  const ts = window.turnstile = { n: 0, hold: false, calls: [], opts: {}, pending: [],
    answer(id) { const o = ts.opts[id], go = () => o.callback('tok-' + (++ts.n)); if (ts.hold) ts.pending.push(go); else setTimeout(go, 20); },
    render(box, o) { const id = 'w' + Object.keys(ts.opts).length; ts.opts[id] = o; ts.calls.push(['render', o.sitekey, o.action, o.language]); ts.answer(id); return id; },
    reset(id) { ts.calls.push(['reset', id]); ts.answer(id); },
    solve() { ts.hold = false; ts.pending.splice(0).forEach(f => f()); },
    remove() { }, getResponse() { } };
};

async function open({ session, recovery, url = base, fake = true, route, captcha = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  if (route) await ctx.route(route.pattern, async r => { const f = await fileFor(new URL(r.request().url()).pathname); await r.fulfill({ body: f.body, contentType: f.type }); });
  await ctx.addInitScript(([session, recovery]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('reminder-by-me.v1', JSON.stringify({ reminders: [], notes: [], settings: { lang: 'sv', onboarded: true, driveGuideSeen: true } }));
    if (session) localStorage.setItem('pinglapp.auth', JSON.stringify(session));
    if (recovery) sessionStorage.setItem('fakeRecovery', '1');
  }, [session || null, !!recovery]);
  if (fake) await ctx.addInitScript(FAKE);
  if (captcha) await ctx.addInitScript(FAKE_TURNSTILE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow && fileInitDone);
  return { ctx, page, errors };
}
const calls = page => page.evaluate(() => window.PING_ACCOUNTS_FAKE ? window.PING_ACCOUNTS_FAKE.db.calls : []);
const msg = page => page.textContent('#acctMsg');
const view = page => page.evaluate(() => acct.view);
const inView = (v, sel) => `#acctDlg [data-acct-view="${v}"] ${sel}`;

test('a guest sees "Logga in" and downloads nothing until they open it', async () => {
  const { ctx, page, errors } = await open();
  assert.equal(await page.textContent('#acctChipText'), 'Logga in');
  assert.equal(await page.evaluate(() => window.PING_ACCOUNTS_FAKE.db.created), 0, 'no client made for a guest');
  assert.equal(await page.locator('script[src*="supabase"]').count(), 0);
  await page.click('#acctChip');
  assert.equal(await view(page), 'signin');
  assert.equal(await page.textContent('#acctTitle'), 'Logga in');
  await page.waitForSelector('#acctDlg .acct-oauth:not([hidden])');
  assert.equal(await page.isVisible('[data-provider="google"]'), true, 'Google is on for the project');
  assert.equal(await page.isVisible('[data-provider="azure"]'), false, 'Microsoft is off');
  assert.equal(await page.locator('script[src*="challenges.cloudflare.com"]').count(), 0, 'no robot check without a site key');
  assert.equal(await page.isVisible(inView('signin', '.acct-captcha')), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#acctDlg'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('log in: a wrong password is refused; the right one shows @username, and a reload keeps you logged in', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#acctChip');
  await page.fill(inView('signin', '[name=email]'), 'a@example.com');
  await page.fill(inView('signin', '[name=password]'), 'nope');
  await page.click(inView('signin', '[type=submit]'));
  await page.waitForFunction(() => document.getElementById('acctMsg').textContent.includes('Fel e-post'));
  await page.fill(inView('signin', '[name=password]'), 'correct-horse-1');
  await page.click(inView('signin', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'account');
  assert.equal(await msg(page), 'Du är inloggad.');
  assert.equal(await page.textContent('#acctWhoUser'), '@alice');
  assert.equal(await page.textContent('#acctChipText'), '@alice');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === '@alice');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('create an account: username checked live, rules enforced, then "check your email"', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#acctChip');
  await page.click(inView('signin', '[data-to=signup]'));
  assert.equal(await view(page), 'signup');
  await page.fill(inView('signup', '[name=username]'), 'Alice');
  assert.equal(await page.inputValue(inView('signup', '[name=username]')), 'alice', 'lower-cased while typing');
  await page.waitForFunction(() => /upptaget/.test(document.querySelector('[data-acct-view=signup] .acct-uname').textContent));
  await page.fill(inView('signup', '[name=username]'), 'ny');
  assert.match(await page.textContent(inView('signup', '.acct-uname')), /3–20 tecken/);
  await page.fill(inView('signup', '[name=username]'), 'new_user');
  await page.waitForFunction(() => /ledigt/.test(document.querySelector('[data-acct-view=signup] .acct-uname').textContent));
  await page.fill(inView('signup', '[name=email]'), 'new@example.com');
  await page.fill(inView('signup', '[name=password]'), 'short');
  assert.equal(await page.getAttribute(inView('signup', '.pw-meter'), 'data-s'), '1');
  await page.click(inView('signup', '[type=submit]'));
  assert.equal(await msg(page), 'Lösenordet behöver minst 10 tecken.');
  await page.fill(inView('signup', '[name=password]'), 'Long-and-Varied-123');
  assert.equal(await page.getAttribute(inView('signup', '.pw-meter'), 'data-s'), '4');
  await page.click(inView('signup', '[type=submit]'));
  assert.equal(await msg(page), 'Godkänn villkoren för att fortsätta.');
  await page.check(inView('signup', '[name=terms]'));
  await page.click(inView('signup', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'sent');
  assert.match(await msg(page), /new@example\.com/);
  const signUp = (await calls(page)).find(c => c[0] === 'signUp')[1];
  assert.equal(signUp.email, 'new@example.com');
  assert.equal(signUp.options.data.username, 'new_user');
  assert.equal(signUp.options.data.terms, 'true');
  assert.equal(signUp.options.data.lang, 'sv');
  assert.equal(signUp.options.emailRedirectTo, base);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('forgot password: the same answer whether or not there is an account', async () => {
  const { ctx, page } = await open();
  await page.click('#acctChip');
  await page.click(inView('signin', '[data-to=forgot]'));
  await page.fill(inView('forgot', '[name=email]'), 'nobody@example.com');
  await page.click(inView('forgot', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'sent');
  assert.match(await msg(page), /Om det finns ett konto/);
  const reset = (await calls(page)).find(c => c[0] === 'reset');
  assert.equal(reset[2].redirectTo, base + '?reset=1');
  await ctx.close();
});

test('the reset link opens "choose a new password"; saving it logs out the other devices', async () => {
  const { ctx, page, errors } = await open({ session: { user: { id: 'u-a', email: 'a@example.com' } }, recovery: true });
  await page.waitForFunction(() => acct.view === 'reset' && !document.getElementById('acctDlg').hidden);
  await page.fill(inView('reset', '[name=password]'), 'a-brand-new-password');
  await page.fill(inView('reset', '[name=password2]'), 'something else');
  await page.click(inView('reset', '[type=submit]'));
  assert.equal(await msg(page), 'De två lösenorden är inte lika.');
  await page.fill(inView('reset', '[name=password2]'), 'a-brand-new-password');
  await page.click(inView('reset', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'account');
  assert.match(await msg(page), /nya lösenord är sparat/);
  const c = await calls(page);
  assert.deepEqual(c.find(x => x[0] === 'updateUser')[1], { password: 'a-brand-new-password' });
  assert.ok(c.some(x => x[0] === 'signOut' && x[1] === 'others'));
  assert.equal(await page.textContent('#acctChipText'), '@alice');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an account without a username (e.g. after Google) must pick one and accept the terms first', async () => {
  const { ctx, page, errors } = await open({ session: { user: { id: 'u-b', email: 'b@example.com' } } });
  await page.waitForFunction(() => acct.view === 'username' && !document.getElementById('acctDlg').hidden);
  assert.equal(await page.textContent('#acctChipText'), 'Konto');
  assert.equal(await page.isVisible(inView('username', '[data-terms]')), true);
  await page.fill(inView('username', '[name=username]'), 'admin');
  await page.check(inView('username', '[name=terms]'));
  await page.click(inView('username', '[type=submit]'));
  await page.waitForFunction(() => /upptaget/.test(document.getElementById('acctMsg').textContent));
  await page.fill(inView('username', '[name=username]'), 'bob_b');
  await page.click(inView('username', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'account');
  assert.equal(await msg(page), 'Välkommen, @bob_b!');
  assert.equal(await page.textContent('#acctChipText'), '@bob_b');
  assert.ok((await calls(page)).some(c => c[0] === 'rpc' && c[1] === 'accept_terms'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('log out: back to "Logga in", the session is gone, the data stays', async () => {
  const { ctx, page } = await open({ session: { user: { id: 'u-a', email: 'a@example.com' } } });
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === '@alice');
  await page.click('#acctChip');
  await page.click(inView('account', '[data-act=acct-signout-ask]:not([data-all])'));
  assert.equal(await view(page), 'signout');
  await page.click(inView('signout', '[data-act=acct-signout]'));
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === 'Logga in');
  assert.equal(await page.evaluate(() => localStorage.getItem('pinglapp.auth')), null);
  assert.ok(await page.evaluate(() => localStorage.getItem('reminder-by-me.v1')));
  assert.match(await page.textContent('#toastMsg'), /Utloggad/);
  await ctx.close();
});

test('robot check: with a site key, log-in, sign-up and forgot-password each send a fresh Turnstile answer', async () => {
  let { ctx, page, errors } = await open({ captcha: true });
  const ts = () => page.evaluate(() => window.turnstile.calls);
  await page.click('#acctChip');
  await page.waitForFunction(() => window.turnstile.calls.length > 0);
  assert.deepEqual((await ts())[0], ['render', 'test-site-key', 'signin', 'sv']);
  assert.equal(await page.locator('script[src*="challenges.cloudflare.com"]').count(), 0, 'the stand-in is used, not Cloudflare');
  // log in: each attempt uses its own answer, and the widget is reset for the next one
  await page.waitForFunction(() => window.turnstile.n === 1);
  await page.fill(inView('signin', '[name=email]'), 'a@example.com');
  await page.fill(inView('signin', '[name=password]'), 'nope');
  await page.click(inView('signin', '[type=submit]'));
  await page.waitForFunction(() => document.getElementById('acctMsg').textContent.includes('Fel e-post'));
  await page.fill(inView('signin', '[name=password]'), 'correct-horse-1');
  await page.click(inView('signin', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'account');
  assert.deepEqual((await calls(page)).filter(c => c[0] === 'signIn').map(c => c[2]), ['tok-1', 'tok-2']);
  assert.ok((await ts()).some(c => c[0] === 'reset'));
  await ctx.close();

  // forgot password: if the answer isn't there yet, it waits for it
  ({ ctx, page, errors } = await open({ captcha: true }));
  await page.evaluate(() => { window.turnstile.hold = true; });
  await page.click('#acctChip');
  await page.click(inView('signin', '[data-to=forgot]'));
  await page.fill(inView('forgot', '[name=email]'), 'b@example.com');
  await page.click(inView('forgot', '[type=submit]'));
  await page.waitForFunction(() => /inte är en robot/.test(document.getElementById('acctMsg').textContent));
  await page.evaluate(() => window.turnstile.solve());
  await page.waitForFunction(() => acct.view === 'sent');
  const reset = (await calls(page)).find(c => c[0] === 'reset');
  assert.match(reset[2].captchaToken, /^tok-\d+$/);
  assert.ok((await ts()).some(c => c[0] === 'render' && c[2] === 'forgot'));

  // sign-up
  await page.evaluate(() => acctShow('signup'));
  await page.fill(inView('signup', '[name=email]'), 'new@example.com');
  await page.fill(inView('signup', '[name=password]'), 'Long-and-Varied-123');
  await page.fill(inView('signup', '[name=username]'), 'new_user');
  await page.check(inView('signup', '[name=terms]'));
  await page.click(inView('signup', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'sent');
  const signUp = (await calls(page)).find(c => c[0] === 'signUp')[1];
  assert.match(signUp.options.captchaToken, /^tok-\d+$/);
  assert.notEqual(signUp.options.captchaToken, reset[2].captchaToken, 'answers are never reused');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('robot check: no answer from Cloudflare means a clear message, not a stuck dialog', async () => {
  const { ctx, page } = await open({ captcha: true });
  await page.evaluate(() => { window.turnstile.render = () => { throw new Error('blocked'); }; });
  await page.click('#acctChip');
  await page.fill(inView('signin', '[name=email]'), 'a@example.com');
  await page.fill(inView('signin', '[name=password]'), 'correct-horse-1');
  await page.click(inView('signin', '[type=submit]'));
  await page.waitForFunction(() => /Robotkontrollen/.test(document.getElementById('acctMsg').textContent));
  assert.equal((await calls(page)).filter(c => c[0] === 'signIn').length, 0, 'no log-in without an answer');
  assert.equal(await page.isDisabled(inView('signin', '[type=submit]')), false);
  await ctx.close();
});

test('accounts are off on pinglapp.com until switched on with ?accounts=staging (and off again)', async () => {
  const route = { pattern: 'https://pinglapp.com/**' };
  let { ctx, page } = await open({ url: 'https://pinglapp.com/', route, fake: false });
  assert.equal(await page.isVisible('#acctChip'), false);
  await page.goto('https://pinglapp.com/?accounts=staging');
  await page.waitForFunction(() => typeof acct !== 'undefined' && acct.project === 'staging');
  assert.equal(await page.isVisible('#acctChip'), true);
  assert.equal(new URL(page.url()).search, '', 'the switch is removed from the address');
  await page.goto('https://pinglapp.com/');
  await page.waitForFunction(() => typeof acct !== 'undefined' && acct.project === 'staging');
  await page.goto('https://pinglapp.com/?accounts=off');
  await page.waitForFunction(() => typeof fileInitDone !== 'undefined' && fileInitDone);
  assert.equal(await page.isVisible('#acctChip'), false);
  await ctx.close();
});
