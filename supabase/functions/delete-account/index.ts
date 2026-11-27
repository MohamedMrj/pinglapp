// @ts-nocheck  (the marked block below is plain JavaScript, so tests/delete-account.test.mjs can run it in Node)
// Pinglapp: delete the signed-in user's account for good.
//
// Called by the app (account page → "Radera kontot") with the user's own session and { confirm: <their username> }.
// Order matters: first every file in the user's folder of each bucket (and the pictures of notes they shared, in
// note-images/shared/{note id}/), then the user. Deleting the user removes all
// their rows (every table references auth.users with on delete cascade; reports they sent keep the text with no
// reporter). Storage files are not rows we own, so they must go first, through the Storage API.
//
// Deploy (dashboard): Edge Functions → Deploy a new function → name `delete-account`, paste this file, and switch
// "Verify JWT" off: the function checks the session itself with auth.getUser(), which also works with the new
// (non-JWT) API keys. See supabase/README.md.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

/*DELETE-START*/
const ALLOWED_ORIGINS = ['https://pinglapp.com', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const BUCKETS = ['note-images', 'boards', 'avatars'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Every file under `prefix` (a folder), including any sub-folders a user may have made inside their own folder.
async function listFiles(store, prefix, depth = 0) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await store.list(prefix, { limit: 1000, offset });
    if (error) throw error;
    for (const f of data || []) {
      if (f.id) out.push(`${prefix}/${f.name}`);                       // a file
      else if (depth < 10) out.push(...await listFiles(store, `${prefix}/${f.name}`, depth + 1));   // a folder
    }
    if (!data || data.length < 1000) return out;
  }
}

// Returns [status, body]. `admin` is a supabase-js client made with the service-role key.
async function deleteAccount(admin, jwt, confirm) {
  if (!jwt) return [401, { error: 'not_signed_in' }];
  const { data: got, error: authErr } = await admin.auth.getUser(jwt);
  const user = got && got.user;
  if (authErr || !user) return [401, { error: 'not_signed_in' }];

  // Typing the username is the confirmation; checked here too, so a stray request can't delete an account.
  const { data: prof, error: profErr } = await admin.from('profiles').select('username').eq('id', user.id).maybeSingle();
  if (profErr) return [500, { error: 'server' }];
  const expected = prof ? prof.username : String(user.email || '').toLowerCase();
  if (!expected || String(confirm || '').trim().replace(/^@/, '').toLowerCase() !== expected) return [400, { error: 'confirm_mismatch' }];

  // Notes this user shared keep their pictures in shared/{note id}/ (note-images): those go too.
  const { data: owned, error: ownErr } = await admin.from('shared_notes').select('id').eq('owner', user.id);
  if (ownErr) return [500, { error: 'server' }];
  const folders = { 'note-images': [user.id, ...(owned || []).map(n => `shared/${n.id}`)] };

  for (const bucket of BUCKETS) {
    const store = admin.storage.from(bucket);
    let files = [];
    try { for (const f of folders[bucket] || [user.id]) files.push(...await listFiles(store, f)); } catch (e) { return [500, { error: 'storage' }]; }
    for (let i = 0; i < files.length; i += 1000) {
      const { error } = await store.remove(files.slice(i, i + 1000));
      if (error) return [500, { error: 'storage' }];
    }
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) return [500, { error: 'delete_failed' }];
  return [200, { ok: true }];
}
/*DELETE-END*/

Deno.serve(async req => {
  const headers = { ...corsHeaders(req.headers.get('origin') || ''), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) return new Response(JSON.stringify({ error: 'server' }), { status: 500, headers });
  const admin = createClient(Deno.env.get('SUPABASE_URL'), key, { auth: { persistSession: false, autoRefreshToken: false } });
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let body = {};
  try { body = await req.json(); } catch (e) { }
  try {
    const [status, out] = await deleteAccount(admin, jwt, body && body.confirm);
    return new Response(JSON.stringify(out), { status, headers });
  } catch (e) {
    console.error('delete-account', e);
    return new Response(JSON.stringify({ error: 'server' }), { status: 500, headers });
  }
});
