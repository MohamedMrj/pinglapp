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

// The stand-in: just enough of supabase-js for the screens, recording every call in PING_ACCOUNTS_FAKE.db.calls.
const FAKE = () => {
  const db = JSON.parse(sessionStorage.getItem('fakedb') || 'null') || {
    users: { 'a@example.com': { pw: 'correct-horse-1', id: 'u-a' }, 'b@example.com': { pw: 'correct-horse-2', id: 'u-b' } },
    profiles: { 'u-a': { username: 'alice', display_name: 'Alice' } }, priv: { 'u-a': { terms_accepted_at: '2026-11-01' }, 'u-b': {} },
    taken: ['alice', 'admin'], calls: [], created: 0,
  };
  const keep = () => sessionStorage.setItem('fakedb', JSON.stringify(db));
  let cbs = [], session = null;
  try { session = JSON.parse(localStorage.getItem('pinglapp.auth')); } catch { }
  const setSession = (s, ev) => {
    session = s;
    if (s) localStorage.setItem('pinglapp.auth', JSON.stringify(s)); else localStorage.removeItem('pinglapp.auth');
    cbs.forEach(cb => cb(ev, session));
  };
  const call = (...c) => { db.calls.push(c); keep(); };
  const client = {
    auth: {
      onAuthStateChange(cb) {
        cbs.push(cb);
        setTimeout(() => cb(sessionStorage.getItem('fakeRecovery') ? 'PASSWORD_RECOVERY' : 'INITIAL_SESSION', session));
        return { data: { subscription: { unsubscribe() { } } } };
      },
      async signInWithPassword({ email, password }) {
        call('signIn', email);
        const u = db.users[email];
        if (!u || u.pw !== password) return { data: {}, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
        setSession({ user: { id: u.id, email } }, 'SIGNED_IN');
        return { data: {}, error: null };
      },
      async signUp(a) { call('signUp', a); return { data: { user: {}, session: null }, error: null }; },
      async resetPasswordForEmail(email, o) { call('reset', email, o); return { data: {}, error: null }; },
      async updateUser(a) { call('updateUser', a); return { data: {}, error: null }; },
      async signOut(o) { call('signOut', o && o.scope); if (!o || o.scope !== 'others') setSession(null, 'SIGNED_OUT'); return { error: null }; },
      async signInWithOAuth(a) { call('oauth', a.provider); return { error: null }; },
    },
    from(table) {
      return { select() { return { async maybeSingle() {
        const id = session && session.user.id, src = table === 'profiles' ? db.profiles : db.priv;
        return { data: (id && src[id]) || null, error: null };
      } }; } };
    },
    async rpc(name, args) {
      call('rpc', name, args);
      if (name === 'username_available') return { data: !db.taken.includes(args.name), error: null };
      if (name === 'set_username') {
        if (db.taken.includes(args.name)) return { data: null, error: { code: '23505', hint: 'username_taken', message: 'username taken' } };
        db.profiles[session.user.id] = { username: args.name, display_name: null }; keep();
        return { data: args.name, error: null };
      }
      if (name === 'accept_terms') { db.priv[session.user.id] = { terms_accepted_at: 'now' }; keep(); return { data: null, error: null }; }
      return { data: null, error: { message: 'unknown rpc ' + name } };
    },
  };
  window.PING_ACCOUNTS_FAKE = { createClient: () => { db.created++; keep(); return client; }, providers: { google: true, azure: false }, db };
};

async function open({ session, recovery, url = base, fake = true, route } = {}) {
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
  await page.click(inView('account', '[data-act=acct-signout]'));
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === 'Logga in');
  assert.equal(await page.evaluate(() => localStorage.getItem('pinglapp.auth')), null);
  assert.ok(await page.evaluate(() => localStorage.getItem('reminder-by-me.v1')));
  assert.match(await page.textContent('#toastMsg'), /Utloggad/);
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
