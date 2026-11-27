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

const ALICE = { session: { user: { id: 'u-a', email: 'a@example.com' } } };
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fakeCalls = (page, kind) => calls(page).then(cs => cs.filter(c => c[0] === kind));
const rpcArgs = (page, name) => calls(page).then(cs => cs.filter(c => c[0] === 'rpc' && c[1] === name).map(c => c[2]));

test('profile: edit name, about, visibility and username; the picture is a 256 px square in your own avatar file', async () => {
  const { ctx, page, errors } = await open(ALICE);
  await ctx.route('https://storage.invalid/**', r => r.fulfill({ body: PNG_1PX, contentType: 'image/png' }));   // the public avatar address
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === '@alice');
  await page.click('#acctChip');
  assert.equal(await page.textContent('#acctMyAvatar'), 'A', 'the first letter while there is no picture');
  await page.click(inView('account', '[data-to=profile]'));
  assert.equal(await page.textContent('#acctTitle'), 'Din profil');
  assert.equal(await page.inputValue(inView('profile', '[name=display_name]')), 'Alice');
  assert.equal(await page.inputValue(inView('profile', '[name=username]')), 'alice');
  assert.equal(await page.isChecked(inView('profile', '[name=findable]')), true);
  assert.equal(await page.isVisible('#acctAvatarRemove'), false);
  await page.fill(inView('profile', '[name=display_name]'), 'Alice A.');
  await page.fill(inView('profile', '[name=bio]'), 'Hej!\nJag gillar listor.');
  await page.uncheck(inView('profile', '[name=findable]'));
  await page.fill(inView('profile', '[name=username]'), 'alice_2');
  await page.waitForFunction(() => /ledigt/.test(document.querySelector('[data-acct-view=profile] .acct-uname').textContent));
  await page.click(inView('profile', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'account');
  assert.equal(await msg(page), 'Din profil är sparad.');
  assert.equal(await page.textContent('#acctChipText'), '@alice_2');
  const [, , values] = (await fakeCalls(page, 'update'))[0];
  assert.deepEqual(values, { display_name: 'Alice A.', bio: 'Hej!\nJag gillar listor.', visibility: 'private' });
  assert.deepEqual(await rpcArgs(page, 'set_username'), [{ name: 'alice_2' }]);

  // the picture: cropped to a square, 256 px, WebP
  assert.deepEqual(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 120;
    const out = await acctMakeAvatar(await new Promise(r => c.toBlob(r)));
    const bmp = await createImageBitmap(out);
    return [bmp.width, bmp.height, out.type];
  }), [256, 256, 'image/webp']);
  await page.click(inView('account', '[data-to=profile]'));
  await page.setInputFiles(inView('profile', '[name=avatar]'), { name: 'me.png', mimeType: 'image/png', buffer: PNG_1PX });
  await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Din bild är sparad.');
  const [up] = await fakeCalls(page, 'upload');
  assert.deepEqual(up.slice(1, 4), ['avatars', 'u-a/avatar.webp', 'image/webp']);
  assert.ok(up[4] > 0 && up[4] < 204800 && up[5] === true, 'small enough, and replaces the old one');
  const path = (await fakeCalls(page, 'update')).pop()[2].avatar_path;
  assert.match(path, /^u-a\/avatar\.webp\?v=\d+$/);
  assert.match(await page.getAttribute('#acctProfAvatar img', 'src'), /\/storage\/v1\/object\/public\/avatars\/u-a\/avatar\.webp\?v=\d+$/);
  assert.equal(await page.isVisible('#acctAvatarRemove'), true);
  // a file that isn't a picture
  await page.setInputFiles(inView('profile', '[name=avatar]'), { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not a picture') });
  await page.waitForFunction(() => /går inte att använda som bild/.test(document.getElementById('acctMsg').textContent));
  // remove it
  await page.click('#acctAvatarRemove');
  await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Din bild är borttagen.');
  assert.deepEqual((await fakeCalls(page, 'remove'))[0].slice(1), ['avatars', ['u-a/avatar.webp']]);
  assert.equal((await fakeCalls(page, 'update')).pop()[2].avatar_path, null);
  assert.equal(await page.locator('#acctProfAvatar img').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('find people, view a profile, block, unblock and report; text from other users is never run as HTML', async () => {
  const { ctx, page, errors } = await open(ALICE);
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === '@alice');
  await page.evaluate(() => {
    const db = window.PING_ACCOUNTS_FAKE.db;
    db.profiles['u-x'] = { username: 'carl_xss', display_name: '<img src=x onerror="window.__xss=1">', bio: '<b>bold</b> <script>window.__xss=2</script>' };
    db.profiles['u-p'] = { username: 'carla', display_name: 'Hidden Carla', visibility: 'private' };
  });
  await page.click('#acctChip');
  await page.click(inView('account', '[data-to=people]'));
  assert.equal(await view(page), 'people');
  await page.fill('#acctPeopleQ', 'ca');
  assert.match(await page.textContent('#acctPeopleHint'), /minst 3 tecken/);
  await page.fill('#acctPeopleQ', 'Car');
  await page.waitForFunction(() => document.querySelectorAll('#acctPeopleList li').length === 2);
  const names = await page.$$eval('#acctPeopleList .acct-person', bs => bs.map(b => b.dataset.name));
  assert.deepEqual(names, ['carl_xss', 'carol'], 'a hidden profile is not found');
  assert.match(await page.textContent('#acctPeopleList'), /<img src=x onerror/);
  assert.equal(await page.locator('#acctPeopleList img').count(), 0, 'the name is shown as text');

  // carol's profile: block, then back to the same search
  await page.click('#acctPeopleList [data-name=carol]');
  await page.waitForFunction(() => acct.view === 'person');
  assert.equal(await page.textContent('#acctPersonUser'), '@carol');
  assert.equal(await page.textContent('#acctPersonName'), 'Carol');
  assert.equal(await page.textContent('#acctPersonSince'), 'Medlem sedan november 2026');
  assert.equal(await page.textContent('#acctBlockBtn'), 'Blockera');
  await page.click('#acctBlockBtn');
  await page.waitForFunction(() => /@carol är blockerad/.test(document.getElementById('acctMsg').textContent));
  assert.equal(await page.textContent('#acctBlockBtn'), 'Sluta blockera');
  assert.deepEqual(await rpcArgs(page, 'block_user'), [{ name: 'carol' }]);
  await page.click(inView('person', '[data-to=people]'));
  assert.equal(await page.locator('#acctPeopleList li').count(), 2, 'the search is kept');

  // carl_xss: the about text is text too; report the profile
  await page.click('#acctPeopleList [data-name=carl_xss]');
  await page.waitForFunction(() => acct.view === 'person' && acct.person === 'carl_xss');
  assert.equal(await page.textContent('#acctPersonBio'), '<b>bold</b> <script>window.__xss=2</script>');
  assert.equal(await page.locator('#acctPersonBio *').count(), 0);
  await page.click(inView('person', '[data-act=acct-report]'));
  assert.equal(await page.isVisible('#acctReportBox'), true);
  await page.click('[data-act=acct-report-send]');
  assert.equal(await msg(page), 'Skriv några ord om vad som är fel.');
  await page.fill('#acctReportReason', 'Stötande namn');
  await page.click('[data-act=acct-report-send]');
  await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Tack. Anmälan är skickad.');
  assert.deepEqual(await rpcArgs(page, 'report_user'), [{ name: 'carl_xss', reason: 'Stötande namn' }]);
  assert.equal(await page.isVisible('#acctReportBox'), false);
  await page.evaluate(() => { window.PING_ACCOUNTS_FAKE.db.reportLimit = true; });
  await page.click(inView('person', '[data-act=acct-report]'));
  await page.fill('#acctReportReason', 'Igen');
  await page.click('[data-act=acct-report-send]');
  await page.waitForFunction(() => /många anmälningar/.test(document.getElementById('acctMsg').textContent));

  // your own profile: no block or report
  await page.click(inView('person', '[data-to=people]'));
  await page.fill('#acctPeopleQ', 'ali');
  await page.waitForSelector('#acctPeopleList [data-name=alice]');
  await page.click('#acctPeopleList [data-name=alice]');
  await page.waitForFunction(() => acct.view === 'person' && acct.person === 'alice');
  assert.equal(await msg(page), 'Det här är du.');
  assert.equal(await page.isVisible('#acctBlockBtn'), false);
  assert.equal(await page.isVisible(inView('person', '[data-act=acct-report]')), false);

  // the blocked list in "Edit profile"; unblock from there
  await page.evaluate(() => acctShow('profile'));
  await page.waitForSelector('#acctBlockedList li');
  assert.equal(await page.textContent('#acctBlockedList .who'), '@carol');
  await page.click('#acctBlockedList [data-act=acct-unblock]');
  await page.waitForFunction(() => /@carol är inte längre blockerad/.test(document.getElementById('acctMsg').textContent));
  assert.equal(await page.isVisible(inView('profile', '.acct-blocked')), false);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('pinglapp.com uses prod; ?accounts=staging / off / default switch it (remembered), and a guest still loads nothing', async () => {
  const route = { pattern: 'https://pinglapp.com/**' };
  const project = page => page.evaluate(() => acct.project);
  const ready = page => page.waitForFunction(() => typeof fileInitDone !== 'undefined' && fileInitDone);
  let { ctx, page } = await open({ url: 'https://pinglapp.com/', route, fake: false });
  assert.equal(await project(page), 'prod');
  assert.equal(await page.isVisible('#acctChip'), true);
  assert.equal(await page.locator('script[src*="supabase"]').count(), 0, 'a guest downloads nothing for accounts');
  await page.goto('https://pinglapp.com/?accounts=staging');
  await ready(page);
  assert.equal(await project(page), 'staging');
  assert.equal(new URL(page.url()).search, '', 'the switch is removed from the address');
  await page.goto('https://pinglapp.com/');
  await ready(page);
  assert.equal(await project(page), 'staging', 'remembered');
  await page.goto('https://pinglapp.com/?accounts=off');
  await ready(page);
  assert.equal(await page.isVisible('#acctChip'), false);
  await page.goto('https://pinglapp.com/');
  await ready(page);
  assert.equal(await page.isVisible('#acctChip'), false, 'off is remembered too');
  await page.goto('https://pinglapp.com/?accounts=default');
  await ready(page);
  assert.equal(await project(page), 'prod');
  await ctx.close();
});

test('a local copy can try prod with ?accounts=prod', async () => {
  const { ctx, page } = await open({ url: base + '?accounts=prod', fake: false });
  assert.equal(await page.evaluate(() => acct.project), 'prod');
  assert.equal(await page.evaluate(() => ACCT_PROJECTS.prod.url), 'https://qezhjjcxarugwgqahlik.supabase.co');
  await ctx.close();
});

test('back from Google/Microsoft without a session: Supabase\'s reason is shown (as text), and "confirm your email" is explained', async () => {
  let { ctx, page, errors } = await open({ url: base + '?error=server_error&error_description=' +
    encodeURIComponent('Unverified email with azure. A confirmation email has been sent to your azure email') });
  await page.waitForFunction(() => acct.view === 'signin' && !document.getElementById('acctDlg').hidden);
  assert.match(await msg(page), /Nästan klart: vi har skickat ett mejl/);
  assert.equal(await page.getAttribute('#acctMsg', 'class'), 'acct-msg ok');
  assert.equal(await page.evaluate(() => location.search), '', 'the error is removed from the address');
  assert.deepEqual(errors, []);
  await ctx.close();
  ({ ctx, page, errors } = await open({ url: base + '?error=server_error&error_description=' + encodeURIComponent('Error getting user email <img src=x onerror=alert(1)>') }));
  await page.waitForFunction(() => acct.view === 'signin' && !document.getElementById('acctDlg').hidden);
  assert.match(await msg(page), /Länken kunde inte logga in dig här.*\(Error getting user email <img src=x onerror=alert\(1\)>\)$/);
  assert.equal(await page.locator('#acctMsg img').count(), 0, 'shown as text, never as HTML');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the sign-up screen offers Google / Microsoft too (only those switched on), as the log-in screen does', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#acctChip');
  await page.click(inView('signin', '[data-to=signup]'));
  await page.waitForSelector(inView('signup', '.acct-oauth:not([hidden])'));
  assert.equal(await page.isVisible(inView('signup', '[data-provider="google"]')), true);
  assert.equal(await page.isVisible(inView('signup', '[data-provider="azure"]')), false, 'Microsoft is off in this stand-in');
  await page.click(inView('signup', '[data-provider="google"]'));
  await page.waitForFunction(() => window.PING_ACCOUNTS_FAKE.db.calls.some(c => c[0] === 'oauth' && c[1] === 'google'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('first-run guide: a guest is offered a free account first; the save file stays as the way without one', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => { S.settings.onboarded = false; openSetup(0); });
  assert.equal(await page.isVisible('#setupStep0 .setup-acct'), true);
  assert.equal(await page.isVisible('#setupStep0 .setup-or'), true);
  await page.click('[data-act="setup-drive-next"]');
  assert.equal(await page.isVisible('#setupStep1 [data-acct-only]'), true, 'says "without an account…"');
  assert.equal(await page.isVisible('#setupStep1 [data-acct-off]'), false, 'not "no server and no account"');
  await page.evaluate(() => openSetup(0));
  await page.click('#setupStep0 [data-act="setup-acct"][data-to="signup"]');
  assert.equal(await page.isVisible('#setupDlg'), false);
  assert.equal(await view(page), 'signup');
  assert.equal(await page.evaluate(() => S.settings.onboarded), true, 'the guide doesn\'t come back');
  await page.keyboard.press('Escape');
  await page.evaluate(() => openSetup(0, true));
  await page.click('#setupStep0 [data-act="setup-acct"][data-to="signin"]');
  assert.equal(await view(page), 'signin');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('first-run guide: signed in, the save-file steps are skipped; opened on purpose, no account offer', async () => {
  const { ctx, page, errors } = await open({ session: ALICE.session });
  await page.waitForFunction(() => /^@/.test(document.getElementById('acctChipText').textContent));
  await page.evaluate(() => { S.settings.onboarded = false; openSetup(0); });
  assert.equal(await page.isVisible('#setupStep0'), false);
  await page.evaluate(() => openSetup(0, true));
  assert.equal(await page.isVisible('#setupStep0'), true);
  assert.equal(await page.isVisible('#setupStep0 .setup-acct'), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---- phase 6: email, password, download my data, delete the account, the legal pages
const ALICE_S = ALICE.session;
const signedIn = async (opts = {}) => {
  const o = await open(Object.assign({ session: ALICE_S }, opts));
  await o.page.waitForFunction(() => /^@/.test(document.getElementById('acctChipText').textContent));
  return o;
};
const fakeDb = (page, patch) => page.evaluate(p => Object.assign(window.PING_ACCOUNTS_FAKE.db, p), patch);

test('change email: the same or a taken address is refused; otherwise links go to both addresses', async () => {
  const { ctx, page, errors } = await signedIn();
  await page.click('#acctChip');
  await page.click(inView('account', '[data-to=email]'));
  assert.equal(await view(page), 'email');
  await page.fill(inView('email', '[name=email]'), 'A@example.com');
  await page.click(inView('email', '[type=submit]'));
  assert.equal(await msg(page), 'Det är adressen du redan har.');
  await page.fill(inView('email', '[name=email]'), 'b@example.com');
  await page.click(inView('email', '[type=submit]'));
  await page.waitForFunction(() => /finns redan ett konto/.test(document.getElementById('acctMsg').textContent));
  await page.fill(inView('email', '[name=email]'), 'new@example.com');
  await page.click(inView('email', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'sent');
  assert.match(await msg(page), /new@example\.com och till din nuvarande adress/);
  const c = (await calls(page)).filter(x => x[0] === 'updateUser').pop();
  assert.deepEqual(c.slice(1), [{ email: 'new@example.com' }, { emailRedirectTo: base + '?email=1' }]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('back from a change-of-email link: the URL is cleaned and the page says where the change stands', async () => {
  const { ctx, page, errors } = await open({ session: ALICE_S, url: base + '?email=1#message=Confirmation+link+accepted' });
  await page.waitForFunction(() => acct.view === 'account' && !document.getElementById('acctDlg').hidden);
  assert.equal(await msg(page), 'Din e-postadress är nu a@example.com.');
  assert.equal(await page.evaluate(() => location.search + location.hash), '');
  await fakeDb(page, { userNow: { new_email: 'new@example.com' } });
  await page.evaluate(() => acctEmailBack());
  await page.waitForFunction(() => /andra adressen/.test(document.getElementById('acctMsg').textContent));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('change password: an old session must type the emailed code; a wrong code is cleared; then saved, others logged out', async () => {
  const { ctx, page, errors } = await signedIn();
  await fakeDb(page, { needReauth: true });
  await page.click('#acctChip');
  assert.equal(await page.textContent('#acctPwBtn'), 'Byt lösenord');
  await page.click('#acctPwBtn');
  assert.equal(await view(page), 'password');
  assert.equal(await page.isVisible(inView('password', '[name=nonce]')), false);
  await page.fill(inView('password', '[name=password]'), 'a-brand-new-password');
  await page.fill(inView('password', '[name=password2]'), 'a-brand-new-passwor');
  await page.click(inView('password', '[type=submit]'));
  assert.equal(await msg(page), 'De två lösenorden är inte lika.');
  await page.fill(inView('password', '[name=password2]'), 'a-brand-new-password');
  await page.click(inView('password', '[type=submit]'));
  await page.waitForFunction(() => /skickat en kod/.test(document.getElementById('acctMsg').textContent));
  assert.equal(await page.isVisible(inView('password', '[name=nonce]')), true);
  assert.ok((await calls(page)).some(x => x[0] === 'reauthenticate'));
  await page.fill(inView('password', '[name=nonce]'), '999999');
  await page.click(inView('password', '[type=submit]'));
  await page.waitForFunction(() => /Koden är fel/.test(document.getElementById('acctMsg').textContent));
  assert.equal(await page.inputValue(inView('password', '[name=nonce]')), '');
  await page.fill(inView('password', '[name=nonce]'), '123456');
  await page.click(inView('password', '[type=submit]'));
  await page.waitForFunction(() => acct.view === 'account');
  assert.match(await msg(page), /nya lösenord är sparat/);
  const c = await calls(page);
  assert.deepEqual(c.filter(x => x[0] === 'updateUser').pop()[1], { password: 'a-brand-new-password', nonce: '123456' });
  assert.ok(c.some(x => x[0] === 'signOut' && x[1] === 'others'));
  // Opening the screen again starts clean.
  await page.click('#acctPwBtn');
  assert.equal(await page.inputValue(inView('password', '[name=password]')), '');
  assert.equal(await page.isVisible(inView('password', '[name=nonce]')), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('someone who only used Google sees "Välj ett lösenord"', async () => {
  const { ctx, page } = await signedIn({ session: { user: { id: 'u-a', email: 'a@example.com', app_metadata: { providers: ['google'] } } } });
  await page.click('#acctChip');
  assert.equal(await page.textContent('#acctPwBtn'), 'Välj ett lösenord');
  await ctx.close();
});

test('download all my data: the backup file also has the account section', async () => {
  const { ctx, page, errors } = await signedIn();
  await page.click('#acctChip');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(inView('account', '[data-act=acct-export]'))]);
  assert.match(dl.suggestedFilename(), /^pinglapp-backup-.*\.json$/);
  const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.ok(Array.isArray(data.reminders) && Array.isArray(data.notes));
  assert.equal(data.account.username, 'alice');
  assert.equal(data.account.email, 'a@example.com');
  assert.equal(data.account.terms_accepted_at, '2026-11-01');
  assert.deepEqual(data.account.blocked, []);
  assert.ok((await calls(page)).some(x => x[0] === 'rpc' && x[1] === 'my_blocks'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('delete the account: only the exact username deletes it; then logged out, and the data stays here as a guest’s', async () => {
  const { ctx, page, errors } = await signedIn();
  await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('pinglapp.cloud')).owner === 'u-a'; } catch (e) { return false; } });
  await page.click('#acctChip');
  await page.click(inView('account', '[data-to=delete]'));
  assert.equal(await view(page), 'delete');
  assert.equal(await page.getAttribute(inView('delete', '[name=confirm]'), 'placeholder'), 'alice');
  await page.fill(inView('delete', '[name=confirm]'), 'alic');
  await page.click(inView('delete', '[type=submit]'));
  assert.match(await msg(page), /inte ditt användarnamn/);
  assert.ok(!(await calls(page)).some(x => x[0] === 'invoke'), 'nothing sent');
  await page.fill(inView('delete', '[name=confirm]'), '@Alice');
  await page.click(inView('delete', '[type=submit]'));
  await page.waitForFunction(() => document.getElementById('acctChipText').textContent === 'Logga in');
  assert.equal(await page.isVisible('#acctDlg'), false);
  assert.match(await page.textContent('#toastMsg'), /konto är raderat/);
  assert.deepEqual((await calls(page)).find(x => x[0] === 'invoke').slice(1), ['delete-account', { confirm: 'alice' }]);
  assert.equal(await page.evaluate(() => localStorage.getItem('pinglapp.auth')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('pinglapp.cloud')), null, 'the data here has no owner now');
  assert.ok(await page.evaluate(() => localStorage.getItem('reminder-by-me.v1')));
  // The account is gone: logging in with it fails.
  await page.click('#acctChip');
  await page.fill(inView('signin', '[name=email]'), 'a@example.com');
  await page.fill(inView('signin', '[name=password]'), 'correct-horse-1');
  await page.click(inView('signin', '[type=submit]'));
  await page.waitForFunction(() => /Fel e-post/.test(document.getElementById('acctMsg').textContent));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('delete the account and "remove from this device": the notes here go too', async () => {
  const { ctx, page, errors } = await signedIn();
  await page.evaluate(() => { S.notes.push(normalize({ notes: [{ id: 'n-del', text: 'secret', created: Date.now(), updated: Date.now() }] }).notes[0]); save(); });
  await page.click('#acctChip');
  await page.click(inView('account', '[data-to=delete]'));
  await page.fill(inView('delete', '[name=confirm]'), 'alice');
  await page.check(inView('delete', '[name=wipe]'));
  await Promise.all([page.waitForEvent('load'), page.click(inView('delete', '[type=submit]'))]);
  await page.waitForFunction(() => typeof isActiveWindow !== 'undefined' && isActiveWindow && fileInitDone);
  assert.equal(await page.evaluate(() => S.notes.some(n => n.id === 'n-del')), false);
  assert.equal(await page.textContent('#acctChipText'), 'Logga in');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the terms and privacy pages: linked from sign-up and the account page, Swedish by default, English on request', async () => {
  const { ctx, page, errors } = await signedIn();
  assert.equal(await page.getAttribute(inView('signup', 'a[href="terms.html"]'), 'target'), '_blank');
  assert.ok(await page.$(inView('signup', 'a[href="privacy.html"]')));
  assert.ok(await page.$(inView('username', 'a[href="privacy.html"]')));
  assert.ok(await page.$(inView('account', 'a[href="privacy.html"]')));
  // A visible link on the start page itself (Google's and Microsoft's sign-in reviews check for it); not over the board.
  assert.equal(await page.isVisible('.site-foot a[href="privacy.html"]'), true);
  assert.equal(await page.isVisible('.site-foot a[href="terms.html"]'), true);
  await page.evaluate(() => showTab('board'));
  assert.equal(await page.isVisible('.site-foot'), false);
  await page.evaluate(() => showTab('reminders'));
  for (const [p, sv, en] of [['privacy.html', 'Integritetspolicy', 'Privacy policy'], ['terms.html', 'Villkor', 'Terms of use']]) {
    const pg = await ctx.newPage(), errs = [];
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto(base + p);
    assert.equal(await pg.textContent('h1:visible'), sv, p);
    assert.equal(await pg.getAttribute('html', 'lang'), 'sv');
    await pg.click('[data-set-lang=en]');
    assert.equal(await pg.textContent('h1:visible'), en, p);
    assert.equal(await pg.getAttribute('html', 'lang'), 'en');
    await pg.goto(base + p + '?lang=en');
    assert.equal(await pg.textContent('h1:visible'), en);
    const text = await pg.textContent('main');
    assert.doesNotMatch(text, /\[[A-ZÅÄÖ -]+(:[^\]]*)?\]/, p + ': no placeholder left');
    assert.match(text, /support@pinglapp\.com/, p + ': the contact address is there');
    assert.deepEqual(errs, [], p);
    await pg.close();
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});
