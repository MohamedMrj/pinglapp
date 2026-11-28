// The send-due-pushes Edge Function (supabase/functions/send-due-pushes/index.ts): its marked block runs here in Node.
// The encryption is checked by decrypting with http_ece (the reference implementation the web-push library uses),
// the VAPID header by verifying its signature. The database side is in db.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createECDH, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import ece from 'http_ece';

const FILE = fileURLToPath(new URL('../supabase/functions/send-due-pushes/index.ts', import.meta.url));
function load() {
  const src = readFileSync(FILE, 'utf8'), a = src.indexOf('/*PUSH-START*/'), b = src.indexOf('/*PUSH-END*/');
  assert.ok(a >= 0 && b > a, 'marked block found');
  const ctx = vm.createContext({ crypto, TextEncoder, URL, btoa, atob, Promise, JSON, Date });
  vm.runInContext(src.slice(a, b) + '\n;globalThis.__out = { b64u, unb64u, sameSecret, vapidKey, vapidAuth, encryptPush, pushPayload, eventPayload, sendOne, runTick };', ctx);
  return ctx.__out;
}
const P = load();
const b64u = b => Buffer.from(b).toString('base64url');

// A device: its ECDH key pair and auth secret, as a browser would make them.
function device() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, p256dh: b64u(ecdh.getPublicKey()), authB64: b64u(auth) };
}
const decrypt = (d, body) => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: d.ecdh, dh: undefined, authSecret: d.auth });
async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const d = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
  return { pair, pub, d, vapid: await P.vapidKey(pub, d) };
}

test('push: the message is encrypted so that only the device can read it (checked with http_ece)', async () => {
  const d = device();
  const msg = new TextEncoder().encode(JSON.stringify({ t: 'Ring mamma 📞 åäö', at: 1, id: 'r1', l: 'sv' }));
  const body = await P.encryptPush(msg, d.p256dh, d.authB64);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, 'record size');
  assert.equal(body[20], 65, 'sender key length');
  assert.equal(decrypt(d, body).toString('utf8'), JSON.stringify({ t: 'Ring mamma 📞 åäö', at: 1, id: 'r1', l: 'sv' }));
  // Another device can't read it, and two messages never look the same.
  assert.throws(() => decrypt(device(), body));
  const again = await P.encryptPush(msg, d.p256dh, d.authB64);
  assert.notDeepEqual(Buffer.from(again), Buffer.from(body));
});

test('push: the VAPID header is a valid ES256 token for the push service, signed with our key', async () => {
  const { pair, pub, vapid } = await vapidPair();
  const now = Date.UTC(2026, 11, 1, 12);
  const h = await P.vapidAuth(vapid, 'https://fcm.googleapis.com/fcm/send/abc', now);
  const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, h);
  assert.equal(m[4], pub);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 43200, sub: 'mailto:support@pinglapp.com' });
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(m[3], 'base64url'), new TextEncoder().encode(m[1] + '.' + m[2]));
  assert.equal(ok, true);
  await assert.rejects(P.vapidKey('AAAA', 'x'));
});

test('push: the secret check, and the payload the service worker reads', () => {
  assert.equal(P.sameSecret('abc', 'abc'), true);
  for (const [a, b] of [['abc', 'abd'], ['abc', 'abcd'], ['', ''], [null, null], ['x', undefined]]) assert.equal(P.sameSecret(a, b), false);
  const p = JSON.parse(P.pushPayload({ title: 'x'.repeat(400), at: '2026-12-01T12:00:00Z', reminder_id: 'r9', lang: 'de' }));
  assert.deepEqual({ ...p, t: p.t.length }, { t: 300, at: Date.UTC(2026, 11, 1, 12), id: 'r9', l: 'sv' });
});

test('push: a run sends one message per device, reports delivered / gone / failed, and stops when nothing is due', async () => {
  const { vapid } = await vapidPair();
  const devs = [device(), device(), device(), device()];
  const due = [
    { sub_id: 1, endpoint: 'https://fcm.googleapis.com/fcm/send/one', p256dh: devs[0].p256dh, auth: devs[0].authB64, lang: 'sv', reminder_id: 'r1', title: 'Ring mamma', at: '2026-12-01T17:00:00Z' },
    { sub_id: 2, endpoint: 'https://web.push.apple.com/two', p256dh: devs[1].p256dh, auth: devs[1].authB64, lang: 'en', reminder_id: 'r1', title: 'Ring mamma', at: '2026-12-01T17:00:00Z' },
    { sub_id: 3, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/three', p256dh: devs[2].p256dh, auth: devs[2].authB64, lang: 'sv', reminder_id: 'r2', title: 'Träning', at: '2026-12-01T17:00:00Z' },
    { sub_id: 4, endpoint: 'https://evil.example.com/four', p256dh: devs[3].p256dh, auth: devs[3].authB64, lang: 'sv', reminder_id: 'r2', title: 'x', at: '2026-12-01T17:00:00Z' },
  ];
  const calls = [], sent = [];
  const admin = { async rpc(name, args) { calls.push([name, JSON.parse(JSON.stringify(args))]); return { data: name === 'push_take_due' ? (calls.length === 1 ? due : []) : null, error: null }; } };
  const fetchFn = async (url, init) => {
    sent.push({ url, init });
    return { status: url.endsWith('/one') ? 201 : url.endsWith('/two') ? 410 : 500 };
  };
  const out = await P.runTick(admin, fetchFn, vapid, { batch: 3 });
  assert.deepEqual({ ...out }, { ok: 1, gone: 2, failed: 1 });
  assert.deepEqual(calls.map(c => c[0]), ['push_take_due', 'push_report', 'push_take_due', 'push_take_events'], 'a full batch: asks again; then friend events');
  assert.deepEqual(calls[1][1], { ok: [1], gone: [2, 4], failed: [3] });
  assert.equal(sent.length, 3, 'never sends to an address that is not a push service');
  const first = sent.find(s => s.url.endsWith('/one'));
  assert.equal(first.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(first.init.headers.TTL, '3600');
  assert.match(first.init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(JSON.parse(decrypt(devs[0], first.init.body).toString()), { t: 'Ring mamma', at: Date.UTC(2026, 11, 1, 17), id: 'r1', l: 'sv' });
  // A network error counts as failed; a database error stops the run.
  assert.equal(await P.sendOne(async () => { throw new Error('offline'); }, vapid, due[0], Date.now()), 'failed');
  await assert.rejects(P.runTick({ rpc: async () => ({ data: null, error: { message: 'boom' } }) }, fetchFn, vapid), /push_take_due: boom/);
});

// sw.js in Node: a fake `self` collects the event handlers and the notifications shown.
function loadSw(existing = [], windows = []) {
  const handlers = {}, shown = [], opened = [];
  const self = {
    addEventListener: (t, f) => { handlers[t] = f; },
    registration: { async getNotifications({ tag }) { return existing.filter(n => n.tag === tag); }, async showNotification(t, o) { shown.push({ title: t, ...o }); } },
    clients: { async matchAll() { return windows; }, async openWindow(u) { opened.push(u); } }, skipWaiting() { },
  };
  vm.runInContext(readFileSync(fileURLToPath(new URL('../sw.js', import.meta.url)), 'utf8'), vm.createContext({ self, caches: {}, fetch, location: { origin: 'https://pinglapp.com' }, URL, Intl, Date, Promise, JSON }));
  const push = async data => { let p; handlers.push({ data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) }, waitUntil: x => { p = x; } }); await p; return shown; };
  const click = async data => { let p; let closed = false; handlers.notificationclick({ notification: { data, close() { closed = true; } }, waitUntil: x => { p = x; } }); await p; return closed; };
  return { handlers, shown, push, click, opened };
}

test('push: the service worker shows the reminder, in the chosen language, once', async () => {
  const at = Date.UTC(2026, 11, 1, 17, 0);
  let sw = loadSw();
  let [n] = await sw.push({ t: 'Ring mamma', at, id: 'r1', l: 'sv' });
  assert.equal(n.title, 'Ring mamma');
  assert.equal(n.tag, 'r1');
  assert.equal(n.renotify, true); assert.equal(n.silent, false);
  assert.equal(n.timestamp, at);
  assert.equal(n.data.push, true); assert.equal(n.data.at, at);
  assert.ok(n.body.length > 3, 'the time');
  // Pinglapp was open and already showed this one a minute ago: replace it quietly.
  sw = loadSw([{ tag: 'r1', timestamp: Date.now() - 60000, data: null }]);
  [n] = await sw.push({ t: 'Ring mamma', at, id: 'r1', l: 'en' });
  assert.equal(n.silent, true); assert.equal(n.renotify, false);
  // An old one with the same tag (yesterday's repeat) doesn't count.
  sw = loadSw([{ tag: 'r1', timestamp: Date.now() - 3600000, data: null }]);
  [n] = await sw.push({ t: 'Ring mamma', at, id: 'r1', l: 'sv' });
  assert.equal(n.silent, false);
  // Something unreadable still shows a notification (browsers stop sending to sites that show nothing).
  sw = loadSw();
  [n] = await sw.push('not json');
  assert.equal(n.title, 'Påminnelse'); assert.equal(n.tag, 'ping-push');
  sw = loadSw();
  [n] = await sw.push(undefined);
  assert.equal(n.title, 'Påminnelse');
  assert.ok(sw.handlers.notificationclick, 'a click still opens Pinglapp');
});

test('push (E1): friend events say who and what, in the device language, as plain text', () => {
  const ev = (o) => JSON.parse(P.eventPayload({ event_id: 7, lang: 'sv', username: 'anna', display_name: 'Anna', body: null, ...o }));
  assert.deepEqual(ev({ kind: 'friend' }), { k: 'friend', t: 'Anna vill bli din vän', b: 'Öppna Pinglapp för att svara.', id: 'ev-7', l: 'sv' });
  assert.deepEqual(ev({ kind: 'friend', lang: 'en', display_name: null }), { k: 'friend', t: '@anna wants to be your friend', b: 'Open Pinglapp to answer.', id: 'ev-7', l: 'en' });
  assert.deepEqual(ev({ kind: 'reminder', body: 'Ring mamma 18' }), { k: 'reminder', t: 'Påminnelse från Anna', b: 'Ring mamma 18', id: 'ev-7', l: 'sv' });
  assert.equal(ev({ kind: 'board', body: 'Julplanering' }).b, '“Julplanering” · Gå med medan den delas.');
  assert.equal(ev({ kind: 'board', body: '', lang: 'en' }).b, 'Join while it is being shared.');
  assert.equal(ev({ kind: 'board', lang: 'en' }).t, 'Anna invites you to a whiteboard');
  // Someone else's words: control and direction characters go, length is capped, an unknown kind becomes 'friend'.
  const odd = ev({ kind: 'reminder', display_name: 'An\u202Ena\n\u0007' + 'x'.repeat(80), body: 'rad1\nrad2\t' + 'y'.repeat(400) });
  assert.ok(!/[\u0000-\u001f\u202e]/.test(odd.t + odd.b), JSON.stringify(odd));
  assert.ok(odd.t.length <= 'Påminnelse från '.length + 40);
  assert.equal(odd.b.length, 200);
  assert.ok(odd.b.startsWith('rad1 rad2 '));
  assert.equal(ev({ kind: 'nope' }).k, 'friend');
});

test('push (E1): a run sends friend events after reminders; a missing events function does not fail the reminders', async () => {
  const { vapid } = await vapidPair();
  const d = device();
  const evRow = { sub_id: 5, endpoint: 'https://fcm.googleapis.com/fcm/send/ev', p256dh: d.p256dh, auth: d.authB64, lang: 'sv', kind: 'reminder', event_id: 42, username: 'anna', display_name: 'Anna', body: 'Köp glögg' };
  const calls = [], sent = [];
  let evGiven = false;
  const admin = { async rpc(name, args) {
    calls.push([name, JSON.parse(JSON.stringify(args))]);
    if (name === 'push_take_events' && !evGiven) { evGiven = true; return { data: [evRow], error: null }; }
    return { data: name === 'push_report' ? null : [], error: null };
  } };
  const out = await P.runTick(admin, async (url, init) => { sent.push({ url, init }); return { status: 201 }; }, vapid);
  assert.deepEqual({ ...out }, { ok: 1, gone: 0, failed: 0 });
  assert.deepEqual(calls.map(c => c[0]), ['push_take_due', 'push_take_events', 'push_report']);
  assert.deepEqual(calls[2][1], { ok: [5], gone: [], failed: [] });
  assert.deepEqual(JSON.parse(decrypt(d, sent[0].init.body).toString()), { k: 'reminder', t: 'Påminnelse från Anna', b: 'Köp glögg', id: 'ev-42', l: 'sv' });
  // The E1 migration not run yet: push_take_events fails; reminders are still sent and the run succeeds.
  const logged = [];
  const old = { async rpc(name) { return name === 'push_take_events' ? { data: null, error: { message: 'function does not exist' } } : { data: [], error: null }; } };
  const r = await P.runTick(old, async () => ({ status: 201 }), vapid, { log: (...a) => logged.push(a.join(' ')) });
  assert.equal(r.eventsError, 'push_take_events: function does not exist');
  assert.equal(logged.length, 1);
});

test('push (E1): the service worker shows a friend event with its text, tells open windows, and a click opens Vänner', async () => {
  const posted = [];
  const win = { postMessage: m => posted.push(m), focus: async () => { posted.push('focus'); } };
  let sw = loadSw([], [win]);
  let [n] = await sw.push({ k: 'friend', t: 'Anna vill bli din vän', b: 'Öppna Pinglapp för att svara.', id: 'ev-1', l: 'sv' });
  assert.equal(n.title, 'Anna vill bli din vän');
  assert.equal(n.body, 'Öppna Pinglapp för att svara.');
  assert.equal(n.tag, 'ev-1');
  assert.equal(n.data.k, 'friend');
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ ping: 'inbox' }], 'open windows refresh their inbox');
  // A click with Pinglapp open: that window comes forward on the Vänner tab.
  posted.length = 0;
  assert.equal(await sw.click(n.data), true);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ ping: 'open', tab: 'friends' }, 'focus']);
  // A click with Pinglapp closed: a new window opens on Vänner. A reminder's click opens the start page as before.
  sw = loadSw([], []);
  await sw.click({ k: 'board' });
  assert.deepEqual([...sw.opened], ['./#open=friends']);
  await sw.click({ push: true, id: 'r1' });
  assert.deepEqual([...sw.opened], ['./#open=friends', './']);
  // A reminder push is unchanged (no k): the time as body.
  [n] = await loadSw().push({ t: 'Ring mamma', at: Date.UTC(2026, 11, 1, 17), id: 'r1', l: 'sv' });
  assert.equal(n.data.k, undefined);
  assert.ok(n.body.length > 3);
});
