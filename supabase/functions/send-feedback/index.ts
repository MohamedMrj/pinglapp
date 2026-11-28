// @ts-nocheck  (the marked block below is plain JavaScript, so tests/feedback.test.mjs can run it in Node)
// Pinglapp: "Rapportera ett problem eller ge ett förslag" (Settings → Hjälp och feedback). Emails what the person wrote,
// their screenshots and (if they left the box ticked) technical details to support@pinglapp.com, through Brevo's
// email API. Pressing Reply in the support inbox answers the address they gave. Nothing is stored in the database
// except a count of sends (support_slot(), migration 20261203000013_support.sql), for the limits.
//
// Who may send: someone signed in (their session is checked here), or anyone who passed the robot check (Cloudflare
// Turnstile, the same widget as log-in; the answer is checked here with the secret key). Limits in support_slot().
//
// Secrets (Edge Functions → Secrets): BREVO_API_KEY (Brevo → SMTP & API → API keys; not the SMTP key) and
// TURNSTILE_SECRET (Cloudflare → Turnstile → the pinglapp.com widget → secret key, the same one Supabase's captcha
// setting has). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Deploy with "Verify JWT" off:
// people without an account send too, and the session is checked here. See supabase/README.md → "Support form setup".
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

/*FEEDBACK-START*/
const ALLOWED_ORIGINS = ['https://pinglapp.com', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const SUPPORT_TO = 'support@pinglapp.com';
const SUPPORT_FROM = { name: 'Pinglapp', email: 'no-reply@pinglapp.com' };
const KINDS = { bug: 'Bugg', idea: 'Förslag', question: 'Fråga', account: 'Konto och inloggning', other: 'Annat' };
const MAX_TEXT = 5000, MAX_SHOTS = 3, MAX_SHOT_BYTES = 1500000, MAX_DIAG = 8000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Text from the form is shown as plain text in an email: control and direction characters go (line breaks and tabs
// stay in the message; a one-line field loses them too).
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const cleanText = (s, max) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(BAD, '').trim().slice(0, max);
const cleanLine = (s, max) => String(s == null ? '' : s).replace(BAD, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const validEmail = s => s.length <= 254 && /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]{2,}$/.test(s);

// A screenshot: { name, data } with data = base64 of a JPEG or PNG (the app shrinks them to JPEG). Returns the
// attachment for Brevo, or null if it isn't one.
function shotAttachment(s, i) {
  const data = s && typeof s.data === 'string' ? s.data : '';
  if (!data || data.length > Math.ceil(MAX_SHOT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const head = atob(data.slice(0, 12));
  const ext = head.startsWith('\xff\xd8\xff') ? 'jpg' : head.startsWith('\x89PNG') ? 'png' : '';
  return ext ? { name: `skarmbild-${i + 1}.${ext}`, content: data } : null;
}

// Technical details the app collected (Settings shows the person exactly what): flat key → value, as text lines.
function diagLines(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return '';
  const out = [];
  for (const [k, v] of Object.entries(d).slice(0, 60)) {
    const key = cleanLine(k, 40);
    if (!key) continue;
    if (Array.isArray(v)) { out.push(key + ':'); v.slice(0, 20).forEach(x => out.push('  - ' + cleanLine(typeof x === 'string' ? x : JSON.stringify(x), 400))); }
    else out.push(key + ': ' + cleanLine(typeof v === 'string' ? v : JSON.stringify(v), 400));
  }
  return out.join('\n').slice(0, MAX_DIAG);
}

async function turnstileOk(fetchFn, secret, token, ip) {
  if (!secret || !token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = await res.json();
    return !!(out && out.success) && (!out.action || out.action === 'support');
  } catch (e) {
    return false;
  }
}

// For the log when Brevo refuses the key: what kind of value BREVO_API_KEY holds, without any of its secret part.
function keyShape(k) {
  if (!k) return 'BREVO_API_KEY: missing (check the secret name and project)';
  const kind = /^xkeysib-/.test(k) ? 'API key (xkeysib-)' : /^xsmtpsib-/.test(k) ? 'SMTP key (xsmtpsib-): wrong kind, make an API key'
    : /^["']/.test(k) ? 'starts with a quote mark: paste it without quotes' : 'unknown format (an API key starts with xkeysib-)';
  return `BREVO_API_KEY: ${kind}, ${k.length} characters`;
}

// Returns [status, body]. env: { admin (service-role client), fetch, brevoKey, turnstileSecret }.
async function sendFeedback(env, body, jwt, ip) {
  body = body && typeof body === 'object' ? body : {};
  const kind = Object.hasOwn(KINDS, body.kind) ? body.kind : 'other';
  const text = cleanText(body.text, MAX_TEXT);
  if (text.length < 3) return [400, { error: 'text_bad' }];
  const email = cleanLine(body.email, 254);
  if (email && !validEmail(email)) return [400, { error: 'email_bad' }];
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length > MAX_SHOTS) return [400, { error: 'shots_bad' }];
  const shots = shotsIn.map(shotAttachment);
  if (shots.some(s => !s)) return [400, { error: 'shots_bad' }];

  // Signed in (a real session, not the app's public key), else the robot check.
  let user = null;
  if (jwt && jwt.split('.').length === 3) {
    const { data } = await env.admin.auth.getUser(jwt);
    user = data && data.user || null;
  }
  if (!user && !await turnstileOk(env.fetch, env.turnstileSecret, body.captcha, ip)) return [400, { error: 'captcha_failed' }];

  let username = '';
  if (user) {
    const { data: prof } = await env.admin.from('profiles').select('username').eq('id', user.id).maybeSingle();
    username = prof && prof.username || '';
  }
  const { data: slot, error: slotErr } = await env.admin.rpc('support_slot', { who: user ? user.id : null });
  if (slotErr) return [500, { error: 'server' }];
  if (slot !== 'ok') return [429, { error: slot === 'user_limit' ? 'user_limit' : 'day_limit' }];

  const first = cleanLine(text.split('\n')[0], 70);
  const who = user ? `konto ${username ? '@' + username : '(inget användarnamn)'} (${user.email || 'ingen e-post'}, id ${user.id})` : 'utan konto';
  const diag = diagLines(body.diag);
  const lines = [
    `Typ: ${KINDS[kind]}`,
    `Från: ${who}`,
    `Svara till: ${email || 'ingen adress angiven'}`,
    `Skärmbilder: ${shots.length}`,
    '', '---', '', text, '',
    '---', diag ? 'Teknisk information:\n' + diag : 'Ingen teknisk information skickades med.',
  ];
  const mail = {
    sender: SUPPORT_FROM,
    to: [{ email: SUPPORT_TO }],
    subject: `[Pinglapp] ${KINDS[kind]}: ${first}`.slice(0, 120),
    textContent: lines.join('\n'),
  };
  if (email) mail.replyTo = { email };
  if (shots.length) mail.attachment = shots;
  try {
    const res = await env.fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST',
      headers: { 'api-key': env.brevoKey || '', 'content-type': 'application/json', 'accept': 'application/json' }, body: JSON.stringify(mail) });
    if (!res.ok) { console.error('send-feedback brevo', res.status, await res.text().catch(() => ''), keyShape(env.brevoKey)); return [502, { error: 'send_failed' }]; }
  } catch (e) {
    console.error('send-feedback brevo', e && e.message);
    return [502, { error: 'send_failed' }];
  }
  return [200, { ok: true }];
}
/*FEEDBACK-END*/

Deno.serve(async req => {
  const headers = { ...corsHeaders(req.headers.get('origin') || ''), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });
  if (Number(req.headers.get('content-length') || 0) > 8000000) return new Response(JSON.stringify({ error: 'shots_bad' }), { status: 413, headers });
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) return new Response(JSON.stringify({ error: 'server' }), { status: 500, headers });
  const admin = createClient(Deno.env.get('SUPABASE_URL'), key, { auth: { persistSession: false, autoRefreshToken: false } });
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  let body = {};
  try { body = await req.json(); } catch (e) { }
  try {
    // Trimmed: a space or line break pasted along with a secret makes Brevo answer "Key not found".
    const env = { admin, fetch, brevoKey: (Deno.env.get('BREVO_API_KEY') || '').trim(), turnstileSecret: (Deno.env.get('TURNSTILE_SECRET') || '').trim() };
    const [status, out] = await sendFeedback(env, body, jwt, ip);
    return new Response(JSON.stringify(out), { status, headers });
  } catch (e) {
    console.error('send-feedback', e);
    return new Response(JSON.stringify({ error: 'server' }), { status: 500, headers });
  }
});
