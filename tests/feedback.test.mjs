// The send-feedback Edge Function (supabase/functions/send-feedback/index.ts): its marked block runs here in Node with
// a stand-in for the service-role client, Turnstile and Brevo. The limits themselves (support_slot) are in db.test.mjs;
// the form in the app is in accounts.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const FILE = fileURLToPath(new URL('../supabase/functions/send-feedback/index.ts', import.meta.url));
function load() {
  const src = readFileSync(FILE, 'utf8'), a = src.indexOf('/*FEEDBACK-START*/'), b = src.indexOf('/*FEEDBACK-END*/');
  assert.ok(a >= 0 && b > a, 'marked block found');
  const ctx = vm.createContext({ console: { error() { } }, atob, URLSearchParams });
  vm.runInContext(src.slice(a, b) + '\n;globalThis.__out = { sendFeedback, corsHeaders, diagLines, cleanText, keyShape };', ctx);
  return ctx.__out;
}
const fn = load();
const plain = x => JSON.parse(JSON.stringify(x));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]).toString('base64');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const JWT_A = 'h.payload-a.sig';

function env({ slot = 'ok', captchaOk = true, brevoStatus = 201, users = { [JWT_A]: { id: 'ua', email: 'a@example.com' } } } = {}) {
  const st = { slots: [], turnstile: [], brevo: [] };
  const e = {
    brevoKey: 'brevo-key', turnstileSecret: 'ts-secret',
    admin: {
      auth: { async getUser(jwt) { const u = users[jwt]; return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }; } },
      from(table) {
        assert.equal(table, 'profiles');
        let id; const q = { select() { return q; }, eq(c, v) { id = v; return q; }, async maybeSingle() { return { data: id === 'ua' ? { username: 'alice' } : null, error: null }; } };
        return q;
      },
      async rpc(name, args) { assert.equal(name, 'support_slot'); st.slots.push(args.who); return slot instanceof Error ? { data: null, error: slot } : { data: slot, error: null }; },
    },
    async fetch(url, o) {
      if (url.includes('turnstile')) {
        st.turnstile.push(Object.fromEntries(o.body));
        return { async json() { return { success: captchaOk, action: 'support' }; } };
      }
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      st.brevo.push({ headers: o.headers, mail: JSON.parse(o.body) });
      return { ok: brevoStatus < 300, status: brevoStatus, async text() { return 'nope'; } };
    },
  };
  return { e, st };
}
const send = async (e, body, jwt = '', ip = '203.0.113.9') => plain(await fn.sendFeedback(e, body, jwt, ip));

test('signed in: no robot check; the email has the text, who sent it, the reply address, screenshots and details', async () => {
  const { e, st } = env();
  const res = await send(e, { kind: 'bug', text: '  Ljudet spelas inte\r\nnär fliken är i bakgrunden.‮  ', email: 'svar@example.com',
    shots: [{ data: JPEG }, { data: PNG }], diag: { browser: 'Chrome\n142', errors: ['12:00:01 boom', '12:00:02 bang'] } }, JWT_A);
  assert.deepEqual(res, [200, { ok: true }]);
  assert.deepEqual(st.turnstile, [], 'signed in: no robot check');
  assert.deepEqual(st.slots, ['ua']);
  const { headers, mail } = st.brevo[0];
  assert.equal(headers['api-key'], 'brevo-key');
  assert.deepEqual(mail.to, [{ email: 'support@pinglapp.com' }]);
  assert.deepEqual(mail.sender, { name: 'Pinglapp', email: 'no-reply@pinglapp.com' });
  assert.deepEqual(mail.replyTo, { email: 'svar@example.com' });
  assert.equal(mail.subject, '[Pinglapp] Bugg: Ljudet spelas inte');
  assert.equal(mail.htmlContent, undefined, 'plain text only: nothing from the form is ever HTML');
  assert.match(mail.textContent, /Från: konto @alice \(a@example\.com, id ua\)/);
  assert.match(mail.textContent, /Svara till: svar@example\.com/);
  assert.match(mail.textContent, /Ljudet spelas inte\nnär fliken är i bakgrunden\./);
  assert.ok(!mail.textContent.includes('‮') && !mail.textContent.includes('\r'));
  assert.match(mail.textContent, /browser: Chrome 142/, 'one value stays on one line');
  assert.match(mail.textContent, /errors:\n  - 12:00:01 boom\n  - 12:00:02 bang/);
  assert.deepEqual(mail.attachment, [{ name: 'skarmbild-1.jpg', content: JPEG }, { name: 'skarmbild-2.png', content: PNG }]);
});

test('without an account: the robot check must pass (with the secret and the address), and it counts as a guest', async () => {
  let { e, st } = env();
  assert.deepEqual(await send(e, { kind: 'idea', text: 'Mörkt läge på tavlan' }), [400, { error: 'captcha_failed' }], 'no answer');
  assert.deepEqual(st.brevo, []);
  assert.deepEqual(await send(e, { kind: 'idea', text: 'Mörkt läge på tavlan', captcha: 'tok' }, 'sb_publishable_xyz'), [200, { ok: true }],
    'the app\'s public key is not a session');
  assert.deepEqual(st.turnstile, [{ secret: 'ts-secret', response: 'tok', remoteip: '203.0.113.9' }]);
  assert.deepEqual(st.slots, [null]);
  const { mail } = st.brevo[0];
  assert.match(mail.textContent, /Från: utan konto/);
  assert.match(mail.textContent, /Svara till: ingen adress angiven/);
  assert.match(mail.textContent, /Ingen teknisk information skickades med\./);
  assert.equal(mail.replyTo, undefined);
  assert.equal(mail.attachment, undefined);
  ({ e, st } = env({ captchaOk: false }));
  assert.deepEqual(await send(e, { text: 'hej hej', captcha: 'tok' }), [400, { error: 'captcha_failed' }]);
  ({ e, st } = env());
  assert.deepEqual(await send(e, { text: 'hej hej', captcha: 'tok' }, 'x.expired.jwt'), [200, { ok: true }], 'an old session falls back to the robot check');
  assert.deepEqual(st.slots, [null]);
});

test('what is refused: too little text, a bad address, too many or false screenshots; limits; Brevo failing', async () => {
  const { e, st } = env();
  assert.deepEqual(await send(e, { text: ' a ' }, JWT_A), [400, { error: 'text_bad' }]);
  assert.deepEqual(await send(e, { text: 'hej hej', email: 'inte en adress' }, JWT_A), [400, { error: 'email_bad' }]);
  assert.deepEqual(await send(e, { text: 'hej hej', email: 'a@b.se\nBcc: x@y.se' }, JWT_A), [400, { error: 'email_bad' }]);
  assert.deepEqual(await send(e, { text: 'hej hej', shots: [{ data: JPEG }, { data: JPEG }, { data: JPEG }, { data: JPEG }] }, JWT_A), [400, { error: 'shots_bad' }]);
  assert.deepEqual(await send(e, { text: 'hej hej', shots: [{ data: Buffer.from('<svg onload=alert(1)>').toString('base64') }] }, JWT_A), [400, { error: 'shots_bad' }]);
  assert.deepEqual(await send(e, { text: 'hej hej', shots: [{ data: 'not base64!' }] }, JWT_A), [400, { error: 'shots_bad' }]);
  assert.deepEqual(await send(e, { text: 'hej hej', shots: [{ data: JPEG + 'A'.repeat(2100000) }] }, JWT_A), [400, { error: 'shots_bad' }]);
  assert.deepEqual(st.slots, [], 'nothing refused counts');
  assert.deepEqual(await send(env({ slot: 'user_limit' }).e, { text: 'hej hej' }, JWT_A), [429, { error: 'user_limit' }]);
  assert.deepEqual(await send(env({ slot: 'day_limit' }).e, { text: 'hej hej' }, JWT_A), [429, { error: 'day_limit' }]);
  assert.deepEqual(await send(env({ slot: new Error('db') }).e, { text: 'hej hej' }, JWT_A), [500, { error: 'server' }]);
  assert.deepEqual(await send(env({ brevoStatus: 401 }).e, { text: 'hej hej' }, JWT_A), [502, { error: 'send_failed' }]);
  // An unknown kind is "Annat"; a long first line is cut in the subject; the text is cut at 5000.
  const o = env();
  await send(o.e, { kind: 'constructor', text: 'x'.repeat(6000) }, JWT_A);
  assert.match(o.st.brevo[0].mail.subject, /^\[Pinglapp\] Annat: x{70}$/);
  assert.equal(o.st.brevo[0].mail.textContent.match(/x{100,}/)[0].length, 5000);
});

test('technical details: flat key/value lines, limited in size; CORS only for Pinglapp', () => {
  assert.equal(fn.diagLines(null), '');
  assert.equal(fn.diagLines(['a']), '');
  assert.equal(fn.diagLines({ a: 1, b: true, c: { d: 'e' } }), 'a: 1\nb: true\nc: {"d":"e"}');
  assert.ok(fn.diagLines({ big: 'x'.repeat(10000) }).length <= 405);
  assert.ok(fn.diagLines(Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, 'v'.repeat(300)]))).length <= 8000);
  assert.equal(fn.corsHeaders('https://pinglapp.com')['Access-Control-Allow-Origin'], 'https://pinglapp.com');
  assert.equal(fn.corsHeaders('https://evil.example')['Access-Control-Allow-Origin'], 'https://pinglapp.com');
});

test('when Brevo refuses the key, the log says what kind of value the secret holds, never the secret part', () => {
  assert.match(fn.keyShape(''), /missing/);
  assert.match(fn.keyShape('xkeysib-abc123secret'), /API key \(xkeysib-\), 20 characters/);
  assert.match(fn.keyShape('xsmtpsib-abc'), /SMTP key/);
  assert.match(fn.keyShape('"xkeysib-abc"'), /quote/);
  for (const k of ['xkeysib-abc123secret', 'xsmtpsib-abc123secret', 'zzz-abc123secret']) assert.ok(!fn.keyShape(k).includes('abc123secret'));
});
