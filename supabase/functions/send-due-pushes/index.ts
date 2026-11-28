// @ts-nocheck  (the marked block below is plain JavaScript, so tests/push.test.mjs can run it in Node)
// Pinglapp: send the reminders that are due now as Web Push notifications (phase 7b, see PLAN-mobile.md), and since
// E1 (PLAN-engage.md) friend events: friend requests, reminders from friends and board invites (push_take_events).
//
// Called every minute by pg_cron through public.push_tick() (migration 20261201000011_push.sql) with the header
// x-cron-secret. It takes what is due with push_take_due() (which marks it sent), sends one encrypted message per
// device and reports back with push_report(). The message is encrypted for the device (RFC 8291, aes128gcm), so the
// push services (Google, Apple, Mozilla, Microsoft) only carry it and can't read it. The VAPID signature (RFC 8292)
// tells them it comes from Pinglapp. Only WebCrypto is used: no web-push library.
//
// Secrets (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (both base64url, from tests/make-vapid.mjs)
// and PUSH_CRON_SECRET (the same value as the Vault secret push_cron_secret). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Deploy with "Verify JWT" off: the cron secret is the check.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

/*PUSH-START*/
const VAPID_SUBJECT = 'mailto:support@pinglapp.com';
const PUSH_TTL = 3600;                 // seconds a push service keeps a message for a device that is offline
const enc = new TextEncoder();

function b64u(bytes) {
  let s = ''; bytes = new Uint8Array(bytes);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// The same-length string comparison takes the same time whatever the input, so the secret can't be guessed byte by byte.
function sameSecret(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function vapidKey(publicB64u, privateB64u) {
  const pub = unb64u(publicB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 point');
  const jwk = { kty: 'EC', crv: 'P-256', d: privateB64u, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { key, publicB64u };
}
// "vapid t=<signed JWT>, k=<public key>" for the push service at `endpoint`.
async function vapidAuth(vapid, endpoint, nowMs) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicB64u}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
// RFC 8291: encrypt `plain` (bytes) for the device keys p256dh / auth (base64url). Returns the request body.
async function encryptPush(plain, p256dhB64u, authB64u, opts = {}) {
  const ua = unb64u(p256dhB64u), secret = unb64u(authB64u);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = opts.localKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(secret, shared, concat(enc.encode('WebPush: info\0'), ua, as), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // record size 4096: one record, as every push service expects
  return concat(salt, rs, new Uint8Array([as.length]), as, sealed);
}

// What the service worker shows (sw.js → 'push'): title, when it was due, the reminder id (notification tag) and the
// language for formatting the time.
const pushPayload = row => JSON.stringify({ t: String(row.title || '').slice(0, 300), at: Date.parse(row.at), id: row.reminder_id, l: row.lang === 'en' ? 'en' : 'sv' });

// A friend event (plan E1, push_take_events): k = kind, t = title, b = body, id = the notification tag, l = language.
// The texts are made here, in the device's language, so even a service worker from before E1 shows them (it reads t).
// The name and text come from another user: notifications show plain text only; control and direction characters go.
const EV_TEXT = {
  sv: { friend: n => `${n} vill bli din vän`, reminder: n => `Påminnelse från ${n}`, board: n => `${n} bjuder in dig till en tavla`,
        friendBody: 'Öppna Pinglapp för att svara.', boardBody: 'Gå med medan den delas.' },
  en: { friend: n => `${n} wants to be your friend`, reminder: n => `Reminder from ${n}`, board: n => `${n} invites you to a whiteboard`,
        friendBody: 'Open Pinglapp to answer.', boardBody: 'Join while it is being shared.' },
};
const plainText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function eventPayload(row) {
  const l = row.lang === 'en' ? 'en' : 'sv', T = EV_TEXT[l], k = ['friend', 'reminder', 'board'].includes(row.kind) ? row.kind : 'friend';
  const name = plainText(row.display_name, 40) || '@' + plainText(row.username, 20);
  const text = plainText(row.body, 200);
  const b = k === 'friend' ? T.friendBody : k === 'reminder' ? text : (text ? `“${text}” · ` : '') + T.boardBody;
  return JSON.stringify({ k, t: T[k](name), b, id: 'ev-' + row.event_id, l });
}

// Sends one message. Returns 'ok', 'gone' (the device unsubscribed: forget it) or 'failed'.
async function sendOne(fetchFn, vapid, row, nowMs, payload = pushPayload) {
  try {
    const host = new URL(row.endpoint).hostname;
    if (!/^(fcm\.googleapis\.com|[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)$/.test(host)) return 'gone';
    const body = await encryptPush(enc.encode(payload(row)), row.p256dh, row.auth);
    const res = await fetchFn(row.endpoint, { method: 'POST', body, headers: {
      'Authorization': await vapidAuth(vapid, row.endpoint, nowMs), 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', 'TTL': String(PUSH_TTL), 'Urgency': 'high' } });
    if (res.status >= 200 && res.status < 300) return 'ok';
    return res.status === 404 || res.status === 410 ? 'gone' : 'failed';
  } catch (e) {
    return 'failed';
  }
}

// One run: take what's due (in batches), send (20 at a time), report; then the same for friend events. Returns counts.
// A failing push_take_events (e.g. the E1 migration not run yet) is logged and leaves the reminders' result alone.
async function runTick(admin, fetchFn, vapid, opts = {}) {
  const now = opts.now || (() => Date.now()), started = now(), batch = opts.batch || 500;
  const out = { ok: 0, gone: 0, failed: 0 };
  const drain = async (take, payload) => {
    for (let round = 0; round < 20 && now() - started < 45000; round++) {
      const { data: rows, error } = await admin.rpc(take, { max_rows: batch });
      if (error) throw new Error(take + ': ' + error.message);
      if (!rows || !rows.length) break;
      const res = { ok: [], gone: [], failed: [] };
      for (let i = 0; i < rows.length; i += 20) {
        const part = rows.slice(i, i + 20);
        const got = await Promise.all(part.map(r => sendOne(fetchFn, vapid, r, now(), payload)));
        got.forEach((g, k) => res[g].push(part[k].sub_id));
      }
      const { error: repErr } = await admin.rpc('push_report', res);
      if (repErr) throw new Error('push_report: ' + repErr.message);
      for (const k in res) out[k] += res[k].length;
      if (rows.length < batch) break;   // fewer than a batch: nothing more waits (the batch counts reminders/events; rows are per device)
    }
  };
  await drain('push_take_due', pushPayload);
  try { await drain('push_take_events', eventPayload); }
  catch (e) { (opts.log || console.error)('send-due-pushes events', e && e.message); out.eventsError = String(e && e.message); }
  return out;
}
/*PUSH-END*/

let vapidCache = null;
Deno.serve(async req => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'method' });
  if (!sameSecret(req.headers.get('x-cron-secret'), Deno.env.get('PUSH_CRON_SECRET'))) return json(401, { error: 'secret' });
  try {
    vapidCache ||= await vapidKey(Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_PRIVATE_KEY'));
    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
    return json(200, await runTick(admin, fetch, vapidCache));
  } catch (e) {
    console.error('send-due-pushes', e);
    return json(500, { error: 'server' });
  }
});
