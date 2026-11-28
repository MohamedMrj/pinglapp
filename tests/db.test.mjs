// The database rules in supabase/migrations, run in PGlite (real Postgres compiled to WebAssembly; no Docker needed).
// Supabase's own schemas (auth, storage, cron) are replaced by small stand-ins with the same names and columns the
// migrations use, and requests are made as the real API roles (anon / authenticated), so row-level security applies.
// This checks our SQL and rules; the Postman collection in supabase/tests checks the same things on a real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));

const SUPABASE_STANDIN = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets,
  name text not null, metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql as $$
  declare _parts text[]; begin _parts := string_to_array(name, '/'); return _parts[1:array_length(_parts, 1) - 1]; end $$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to authenticated, service_role;
create schema cron;
create table cron.job (jobname text primary key, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
  insert into cron.job values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command; select 1::bigint $$;
create schema vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
create schema net;
create table net.calls (url text, body jsonb, headers jsonb, timeout_milliseconds int);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net.calls values (url, body, headers, timeout_milliseconds); select 1::bigint $$;
`;

let db;
const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c';
const now = () => Date.now();

// Run queries as a signed-in user (uid), as anon (uid = null), or as service_role.
async function as(uid, fn) {
  const role = uid === 'service' ? 'service_role' : uid ? 'authenticated' : 'anon';
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid && uid !== 'service' ? uid : '']);
  await db.exec(`set role ${role}`);
  try { return await fn((sql, params) => db.query(sql, params)); }
  finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
}
const rows = async (uid, sql, params) => (await as(uid, q => q(sql, params))).rows;
async function fails(uid, sql, params, re) {
  let err = null;
  try { await as(uid, q => q(sql, params)); } catch (e) { err = e; }
  assert.ok(err, 'expected an error for: ' + sql);
  if (re) assert.match(`${err.message} ${err.hint || ''}`, re);
  return err;
}
const signUp = (id, email, meta = {}) => db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, email, meta]);
const upsert = (uid, table, id, updated, data = {}, deleted = false) => rows(uid,
  `insert into public.${table} (id, data, updated, deleted) values ($1, $2, $3, $4)
   on conflict (user_id, id) do update set data = excluded.data, updated = excluded.updated, deleted = excluded.deleted
   returning id, updated, deleted, data`, [id, data, updated, deleted]);

test.before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STANDIN);
  for (const f of readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
    // pg_cron and pg_net aren't available in PGlite; the stand-in cron schema above takes its place.
    const sql = readFileSync(DIR + f, 'utf8').replace(/create extension if not exists pg_(cron|net);/gi, '');
    try { await db.exec(sql); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  await signUp(A, 'a@example.com', { username: 'alice', display_name: 'Alice', terms: 'true' });
  await signUp(B, 'b@example.com', { username: 'bob' });
});
test.after(() => db && db.close());

test('sign-up creates the private account row and, with a valid username, the profile', async () => {
  const [pa] = await rows(A, 'select * from public.account_private');
  assert.equal(pa.id, A); assert.equal(Number(pa.quota_bytes), 26214400);
  assert.ok(pa.terms_accepted_at);
  const [p] = await rows(A, 'select username, display_name from public.profiles');
  assert.deepEqual({ ...p }, { username: 'alice', display_name: 'Alice' });
});

test('a sign-up with a reserved, invalid or taken username still succeeds, without a profile', async () => {
  const ids = ['00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d3'];
  await signUp(ids[0], 'd1@example.com', { username: 'admin' });
  await signUp(ids[1], 'd2@example.com', { username: 'No Spaces!' });
  await signUp(ids[2], 'd3@example.com', { username: 'alice' });
  for (const id of ids) {
    assert.equal((await rows(id, 'select * from public.profiles')).length, 0);
    assert.equal((await rows(id, 'select * from public.account_private')).length, 1);
  }
});

test('anon can check username availability but read nothing', async () => {
  const avail = async n => (await rows(null, 'select public.username_available($1) as ok', [n]))[0].ok;
  assert.equal(await avail('alice'), false);
  assert.equal(await avail('ALICE'), false);
  assert.equal(await avail('carol_99'), true);
  assert.equal(await avail('support'), false);
  assert.equal(await avail('pinglapp'), false);
  assert.equal(await avail('ab'), false);
  for (const t of ['reminders', 'notes', 'profiles', 'account_private', 'user_settings', 'blocks', 'reports'])
    await fails(null, `select * from public.${t}`, [], /permission denied/);
  await fails(null, `select * from public.find_profiles('ali')`, [], /permission denied/);
});

test('user A cannot read or change user B\'s synced items', async () => {
  await upsert(A, 'reminders', 'r1', now() - 1000, { id: 'r1', title: 'A secret' });
  assert.equal((await rows(B, 'select * from public.reminders')).length, 0);
  assert.equal((await rows(B, `update public.reminders set data = '{"title":"hacked"}' where id = 'r1' returning id`)).length, 0);
  await fails(B, `insert into public.reminders (user_id, id, data, updated) values ($1, 'r1', '{}', $2)`, [A, now()], /row-level security/);
  await fails(A, `delete from public.reminders where id = 'r1'`, [], /permission denied/);   // deletions are tombstones
  const [r] = await rows(A, `select data->>'title' as t from public.reminders where id = 'r1'`);
  assert.equal(r.t, 'A secret');
  // B's own row with the same item id is a separate row
  await upsert(B, 'reminders', 'r1', now(), { title: 'B' });
  assert.equal((await rows(A, `select data->>'title' as t from public.reminders where id = 'r1'`))[0].t, 'A secret');
});

test('the server keeps the newest version; a deletion wins a tie; future stamps are refused', async () => {
  const T = now() - 60000;
  assert.equal((await upsert(A, 'notes', 'n1', T, { text: 'v2' })).length, 1);
  assert.equal((await upsert(A, 'notes', 'n1', T - 5, { text: 'old' })).length, 0, 'older version refused');
  assert.equal((await upsert(A, 'notes', 'n1', T, { text: 'same stamp' })).length, 0, 'tie: server keeps its copy');
  assert.equal((await rows(A, `select data->>'text' as t from public.notes where id = 'n1'`))[0].t, 'v2');
  assert.equal((await upsert(A, 'notes', 'n1', T, {}, true)).length, 1, 'tie: deletion wins');
  assert.equal((await upsert(A, 'notes', 'n1', T + 1, { text: 'edited after delete' })).length, 1);
  assert.equal((await upsert(A, 'notes', 'nf', now() + 2 * 86400000, { text: 'future' })).length, 0, 'wrong clock refused');
  assert.equal((await rows(A, `select * from public.notes where id = 'nf'`)).length, 0);
  await fails(A, `update public.notes set id = 'other', updated = $1 where id = 'n1'`, [now()], /owner or id/);
});

test('server_at moves forward on every accepted write (the sync cursor)', async () => {
  const [a] = await upsert(A, 'notes', 'c1', now() - 5000, { text: '1' });
  const t1 = (await rows(A, `select server_at from public.notes where id = 'c1'`))[0].server_at;
  await upsert(A, 'notes', 'c1', now() - 4000, { text: '2' });
  const t2 = (await rows(A, `select server_at from public.notes where id = 'c1'`))[0].server_at;
  assert.ok(a && t2 > t1);
  const since = await rows(A, 'select id from public.notes where server_at > $1', [t1]);
  assert.deepEqual(since.map(r => r.id), ['c1']);
});

test('settings: newer wins, per user', async () => {
  const S = `insert into public.user_settings (data, settings_updated) values ($1, $2)
    on conflict (user_id) do update set data = excluded.data, settings_updated = excluded.settings_updated returning settings_updated`;
  assert.equal((await rows(A, S, [{ lang: 'en' }, 100])).length, 1);
  assert.equal((await rows(A, S, [{ lang: 'sv' }, 50])).length, 0);
  assert.equal((await rows(A, S, [{ lang: 'sv' }, 200])).length, 1);
  assert.equal((await rows(B, 'select * from public.user_settings')).length, 0);
});

test('account data: quota and usage can\'t be changed by the user', async () => {
  await fails(A, 'update public.account_private set quota_bytes = 999999999', [], /permission denied/);
  await fails(A, 'update public.account_private set used_bytes = 0', [], /permission denied/);
  await fails(A, 'update public.account_private set terms_accepted_at = now()', [], /permission denied/);
  assert.equal((await rows(A, `update public.account_private set language = 'en' returning language`))[0].language, 'en');
  assert.equal((await rows(A, `update public.account_private set language = 'en' where id = $1 returning id`, [B])).length, 0);
  await fails(A, `insert into public.account_private (id) values ($1)`, [C], /permission denied/);
});

test('profiles: only your own row is readable directly; username changes go through set_username', async () => {
  assert.equal((await rows(A, 'select * from public.profiles')).length, 1);
  await fails(A, `update public.profiles set username = 'x_alice'`, [], /permission denied/);
  assert.equal((await rows(A, `update public.profiles set bio = 'hi', display_name = 'Al' returning bio`))[0].bio, 'hi');
  assert.equal((await rows(A, `update public.profiles set bio = 'pwned' where id = $1 returning id`, [B])).length, 0);
  await fails(A, `update public.profiles set bio = repeat('x', 301)`, [], /check constraint/);
});

test('profiles: the avatar path can only name your own avatar file, with a version', async () => {
  const set = (uid, v) => rows(uid, 'update public.profiles set avatar_path = $1 returning avatar_path', [v]);
  assert.equal((await set(A, `${A}/avatar.webp?v=1764000000000`))[0].avatar_path, `${A}/avatar.webp?v=1764000000000`);
  for (const bad of [`${B}/avatar.webp?v=1`, `${A}/avatar.webp`, `${A}/other.webp?v=1`, 'https://evil.example/x.webp',
    `${A}/avatar.webp?v=1"><script>`, `../${A}/avatar.webp?v=1`])
    await fails(A, 'update public.profiles set avatar_path = $1', [bad], /check constraint/);
  assert.equal((await set(A, null))[0].avatar_path, null);
});

test('avatars: only a valid spec can be saved; others see it through get_profile and find_profiles', async () => {
  const ok = { v: 1, s: 5, c: 11, e: 7, m: 7, a: 7, b: 11 };
  await rows(A, 'update public.profiles set avatar_style = $1 where id = $2', [ok, A]);
  for (const bad of [{ ...ok, s: 6 }, { ...ok, c: 12 }, { ...ok, v: 2 }, { ...ok, x: 1 }, { v: 1, s: 0 }, { ...ok, e: '1' },
    { ...ok, m: 1.5 }, { ...ok, a: -1 }, [1, 2], 'smile', { ...ok, b: 100 }]) {
    await fails(A, 'update public.profiles set avatar_style = $1 where id = $2', [JSON.stringify(bad), A], /avatar_style_valid/);
  }
  const [p] = await rows(B, `select * from public.get_profile('alice')`);
  assert.deepEqual(p.avatar_style, ok);
  const [f] = await rows(B, `select * from public.find_profiles('ali')`);
  assert.deepEqual(f.avatar_style, ok);
  await rows(A, 'update public.profiles set avatar_style = null where id = $1', [A]);   // back to the default
  assert.equal((await rows(B, `select avatar_style from public.get_profile('alice')`))[0].avatar_style, null);
  assert.equal((await rows(null, `select has_function_privilege('anon', 'public.get_profile(text)', 'execute') as x`))[0].x, false);
});

test('set_username: pick, validate, taken, and at most one change per 30 days', async () => {
  await signUp(C, 'c@example.com', { full_name: 'Carol from Google' });   // OAuth-style: no username yet
  assert.equal((await rows(C, 'select * from public.profiles')).length, 0);
  await fails(C, `select public.set_username('bob')`, [], /username_taken/);
  await fails(C, `select public.set_username('Bad Name')`, [], /username_invalid/);
  await fails(C, `select public.set_username('admin')`, [], /username_invalid/);
  assert.equal((await rows(C, `select public.set_username('Carol')  as u`))[0].u, 'carol');
  assert.equal((await rows(C, 'select display_name from public.profiles'))[0].display_name, 'Carol from Google');
  assert.equal((await rows(C, `select public.set_username('carol_c') as u`))[0].u, 'carol_c');   // first change is free
  await fails(C, `select public.set_username('carol_d')`, [], /username_too_soon/);
  await fails(null, `select public.set_username('anon_user')`, [], /permission denied/);
});

test('find and view profiles: privacy setting and blocks apply', async () => {
  const find = (uid, p) => rows(uid, 'select username from public.find_profiles($1)', [p]).then(r => r.map(x => x.username));
  const get = (uid, n) => rows(uid, 'select * from public.get_profile($1)', [n]);
  assert.deepEqual(await find(B, 'ali'), ['alice']);
  assert.deepEqual(await find(B, 'al'), [], 'at least 3 characters');
  assert.deepEqual(await find(B, 'a%_'), [], 'no wildcards');
  const [p] = await get(B, 'alice');
  assert.equal(p.username, 'alice'); assert.ok(!('email' in p) && !('id' in p));
  // A blocks B: B no longer finds or sees A, others still do
  assert.equal((await rows(A, `select public.block_user('bob') as ok`))[0].ok, true);
  assert.deepEqual(await find(B, 'ali'), []);
  assert.equal((await get(B, 'alice')).length, 0);
  assert.deepEqual(await find(C, 'ali'), ['alice']);
  assert.equal((await rows(B, 'select * from public.blocks')).length, 0, 'B can\'t see who blocked them');
  assert.deepEqual((await rows(A, 'select username from public.my_blocks()')).map(r => r.username), ['bob']);
  await fails(B, `insert into public.blocks values ($1, $2)`, [B, A], /permission denied/);
  await rows(A, `select public.unblock_user('bob')`);
  assert.deepEqual(await find(B, 'ali'), ['alice']);
  // private profile: only the owner sees it
  await rows(A, `update public.profiles set visibility = 'private'`);
  assert.equal((await get(B, 'alice')).length, 0);
  assert.equal((await get(A, 'alice')).length, 1);
  await rows(A, `update public.profiles set visibility = 'users'`);
});

test('reports: written through report_user only, limited per day', async () => {
  assert.equal((await rows(B, `select public.report_user('alice', 'rude name') as ok`))[0].ok, true);
  assert.equal((await rows(B, `select public.report_user('nobody_here', 'x') as ok`))[0].ok, false);
  await fails(B, 'select * from public.reports', [], /permission denied/);
  for (let i = 0; i < 19; i++) await rows(B, `select public.report_user('alice', 'again')`);
  await fails(B, `select public.report_user('alice', 'one too many')`, [], /report_limit/);
});

test('storage: own folder only, usage is counted, uploads stop at the quota', async () => {
  const put = (uid, bucket, name) => rows(uid, `insert into storage.objects (bucket_id, name) values ($1, $2) returning id`, [bucket, name]);
  const setSize = (bucket, name, size) => db.query(`update storage.objects set metadata = jsonb_build_object('size', $3::bigint) where bucket_id = $1 and name = $2`, [bucket, name, size]);
  const used = async uid => Number((await rows(uid, 'select used_bytes from public.account_private'))[0].used_bytes);
  await db.query('update public.account_private set quota_bytes = 1000, used_bytes = 0 where id = $1', [A]);

  await put(A, 'note-images', `${A}/p1.webp`);
  await setSize('note-images', `${A}/p1.webp`, 600);          // Storage fills in the size after the upload
  assert.equal(await used(A), 600);
  await fails(A, `insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`${B}/x.webp`], /row-level security/);
  await fails(A, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${A}/other.png`], /row-level security/);
  await put(A, 'avatars', `${A}/avatar.webp`);                // the avatar doesn't count and is always allowed
  await put(A, 'boards', `${A}/b1.json`);
  await setSize('boards', `${A}/b1.json`, 500);
  assert.equal(await used(A), 1100);                          // over by at most one file
  await fails(A, `insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`${A}/p2.webp`], /row-level security/);
  assert.equal((await rows(B, `select name from storage.objects`)).length, 0, 'B sees none of A\'s files');
  assert.equal((await rows(A, `delete from storage.objects where name = $1 returning id`, [`${A}/p1.webp`])).length, 1);
  assert.equal(await used(A), 500);
  await put(A, 'note-images', `${A}/p2.webp`);                // room again
  // the weekly recount gives the same answer
  await db.query('update public.account_private set used_bytes = 12345 where id = $1', [A]);
  await as('service', q => q('select public.recount_storage_use()'));
  assert.equal(await used(A), 500);
});

test('scheduled jobs: old tombstones are removed, everything else stays', async () => {
  const [job] = (await db.query(`select command from cron.job where jobname = 'ping-tombstones'`)).rows;
  assert.ok(job);
  await upsert(A, 'reminders', 'gone', now() - 1000, {}, true);
  await upsert(A, 'reminders', 'recent', now() - 1000, {}, true);
  // age the row with triggers off (the newest-wins guard rightly refuses an update that doesn't change the stamp)
  await db.exec(`set session_replication_role = replica;
    update public.reminders set server_at = now() - interval '91 days' where id = 'gone';
    set session_replication_role = origin;`);
  await db.exec(job.command);
  const left = (await rows(A, 'select id from public.reminders order by id')).map(r => r.id);
  assert.ok(!left.includes('gone') && left.includes('recent') && left.includes('r1'), left.join());
  assert.ok((await db.query(`select 1 from cron.job where jobname = 'ping-recount-storage'`)).rows.length);
});

test('scheduled jobs: reports are removed after 12 months, as the privacy policy says', async () => {
  const [job] = (await db.query(`select command from cron.job where jobname = 'ping-old-reports'`)).rows;
  assert.ok(job);
  await db.query(`insert into public.reports (reporter, target, reason, created_at) values
    ($1, $2, 'old one', now() - interval '13 months'), ($1, $2, 'new one', now() - interval '11 months')`, [B, A]);
  await db.exec(job.command);
  const left = (await db.query(`select reason from public.reports where reason in ('old one', 'new one')`)).rows.map(r => r.reason);
  assert.deepEqual(left, ['new one']);
});

test('friends: request, inbox, accept, decline, remove; only through the functions', async () => {
  const F = '00000000-0000-4000-8000-0000000000f1', G = '00000000-0000-4000-8000-0000000000f2', H = '00000000-0000-4000-8000-0000000000f3';
  await signUp(F, 'f@example.com', { username: 'fred', display_name: 'Fred' });
  await signUp(G, 'g@example.com', { username: 'gina' });
  await signUp(H, 'h@example.com', { username: 'hugo' });
  const st = (uid, n) => rows(uid, 'select public.friend_status($1) as s', [n]).then(r => r[0].s);
  const call = (uid, sql, p) => rows(uid, sql, p).then(r => Object.values(r[0])[0]);

  assert.equal(await st(F, 'gina'), 'none');
  assert.equal(await st(F, 'fred'), 'self');
  assert.equal(await call(F, `select public.friend_request('gina')`), 'outgoing');
  assert.equal(await call(F, `select public.friend_request('GINA')`), 'outgoing', 'asking twice changes nothing');
  assert.equal(await st(F, 'gina'), 'outgoing');
  assert.equal(await st(G, 'fred'), 'incoming');
  const inbox = await rows(G, 'select * from public.my_inbox()');
  assert.deepEqual(inbox.map(i => [i.kind, i.username, i.display_name]), [['friend_request', 'fred', 'Fred']]);
  assert.equal((await rows(F, 'select * from public.my_inbox()')).length, 0, 'your own request is not in your inbox');
  assert.equal((await rows(F, 'select * from public.my_friends()')).length, 0, 'not friends until accepted');

  assert.equal(await call(G, `select public.friend_respond('fred', true)`), 'friends');
  assert.equal(await st(F, 'gina'), 'friends');
  assert.deepEqual((await rows(F, 'select username from public.my_friends()')).map(r => r.username), ['gina']);
  assert.deepEqual((await rows(G, 'select username from public.my_friends()')).map(r => r.username), ['fred']);
  assert.equal((await rows(G, 'select * from public.my_inbox()')).length, 0, 'answered: gone from the inbox');

  // Friends see each other's profile even when it isn't findable; strangers don't.
  await rows(G, `update public.profiles set visibility = 'private' where id = $1`, [G]);
  assert.equal((await rows(F, `select * from public.get_profile('gina')`)).length, 1);
  assert.equal((await rows(H, `select * from public.get_profile('gina')`)).length, 0);
  assert.equal((await rows(F, `select * from public.find_profiles('gin')`)).length, 1, 'a friend can find a private profile');
  await fails(H, `select public.friend_request('gina')`, [], /friend_unknown/);   // private and not a friend
  await fails(H, `select public.friend_request('nobody_here')`, [], /friend_unknown/);
  await fails(H, `select public.friend_request('hugo')`, [], /friend_unknown/);   // yourself

  // Removing ends it for both; a declined request just disappears.
  assert.equal(await call(F, `select public.friend_remove('gina')`), true);
  assert.equal(await st(G, 'fred'), 'none');
  await rows(G, `update public.profiles set visibility = 'users' where id = $1`, [G]);
  await call(H, `select public.friend_request('fred')`);
  assert.equal(await call(F, `select public.friend_respond('hugo', false)`), 'none');
  assert.equal(await st(H, 'fred'), 'none');
  // Taking back your own request; the other person can't "remove" it for you by answering a request you didn't get.
  await call(H, `select public.friend_request('gina')`);
  assert.equal(await call(H, `select public.friend_respond('gina', true)`), 'outgoing', 'you can\'t accept your own request');
  assert.equal(await call(H, `select public.friend_remove('gina')`), true);
  assert.equal(await st(G, 'hugo'), 'none');
  // Asking someone who already asked you makes you friends.
  await call(F, `select public.friend_request('hugo')`);
  assert.equal(await call(H, `select public.friend_request('fred')`), 'friends');

  // Blocking ends the friendship; you can't send a request to someone you blocked; they can't find you to ask.
  await rows(F, `select public.block_user('hugo')`);
  assert.equal(await st(H, 'fred'), 'none');
  await fails(F, `select public.friend_request('hugo')`, [], /friend_blocked/);
  await fails(H, `select public.friend_request('fred')`, [], /friend_unknown/);

  // The table itself is out of reach; anon can't call the functions.
  await fails(F, 'select * from public.friendships');
  await fails(F, `insert into public.friendships (a, b, requested_by) values ($1, $2, $1)`, [F < G ? F : G, F < G ? G : F]);
  await fails(null, `select public.friend_request('fred')`);
  await fails(null, `select * from public.my_inbox()`);
});

test('friends: at most 30 requests a day; unanswered requests go after 30 days', async () => {
  const P = '00000000-0000-4000-8000-0000000000a9';
  await signUp(P, 'p@example.com', { username: 'popular' });
  const ids = [];
  for (let i = 0; i < 31; i++) {
    const id = `00000000-0000-4000-8001-${String(i).padStart(12, '0')}`;
    ids.push(id);
    await signUp(id, `n${i}@example.com`, { username: `newbie_${i}` });
  }
  for (let i = 0; i < 30; i++) await rows(P, `select public.friend_request($1)`, [`newbie_${i}`]);
  await fails(P, `select public.friend_request('newbie_30')`, [], /friend_limit/);
  const [job] = (await db.query(`select command from cron.job where jobname = 'ping-old-friend-requests'`)).rows;
  await db.query(`update public.friendships set created_at = now() - interval '31 days' where requested_by = $1 and (a = $2 or b = $2)`, [P, ids[0]]);
  await db.exec(job.command);
  assert.equal((await rows(P, 'select public.friend_status($1) as s', ['newbie_0']))[0].s, 'none');
  assert.equal((await rows(P, 'select public.friend_status($1) as s', ['newbie_1']))[0].s, 'outgoing');
});

test('reminders to friends: send, inbox, answer; friends only; only through the functions', async () => {
  const R = '00000000-0000-4000-8000-0000000000b1', S2 = '00000000-0000-4000-8000-0000000000b2', T = '00000000-0000-4000-8000-0000000000b3';
  await signUp(R, 'r@example.com', { username: 'rita', display_name: 'Rita' });
  await signUp(S2, 's@example.com', { username: 'sam' });
  await signUp(T, 't@example.com', { username: 'tove' });
  const call = (uid, sql, p) => rows(uid, sql, p).then(r => Object.values(r[0])[0]);
  const inbox = uid => rows(uid, 'select * from public.my_inbox()');

  // Not friends yet: nothing can be sent.
  await fails(R, `select public.send_reminder('sam', 'Ring mamma')`, [], /send_not_friend/);
  await call(R, `select public.friend_request('sam')`);
  await fails(R, `select public.send_reminder('sam', 'Ring mamma')`, [], /send_not_friend/);   // a request isn't a friendship
  await call(S2, `select public.friend_respond('rita', true)`);

  // Friends: the text is trimmed and arrives in the recipient's inbox, with who sent it.
  const id = Number(await call(R, `select public.send_reminder('SAM', '  Ring mamma imorgon 18:00 ')`));
  assert.ok(id > 0);
  const got = await inbox(S2);
  assert.deepEqual(got.map(i => [i.kind, Number(i.id), i.username, i.display_name, i.payload]),
    [['reminder', id, 'rita', 'Rita', { text: 'Ring mamma imorgon 18:00' }]]);
  assert.equal((await inbox(R)).length, 0, 'what you sent is not in your own inbox');

  // Text rules; yourself and strangers; anon.
  await fails(R, `select public.send_reminder('sam', '   ')`, [], /send_text_bad/);
  await fails(R, `select public.send_reminder('sam', $1)`, ['x'.repeat(301)], /send_text_bad/);
  assert.ok(await call(R, `select public.send_reminder('sam', $1)`, ['å'.repeat(300)]), '300 characters is fine');
  await fails(R, `select public.send_reminder('rita', 'me')`, [], /send_not_friend/);
  await fails(T, `select public.send_reminder('sam', 'hi')`, [], /send_not_friend/);
  await fails(R, `select public.send_reminder('nobody_here', 'hi')`, [], /send_not_friend/);
  await fails(null, `select public.send_reminder('sam', 'hi')`);
  await fails(null, `select public.answer_item(1)`);

  // Only the recipient can answer, once; then it's gone from the inbox.
  assert.equal(await call(R, 'select public.answer_item($1)', [id]), false, 'the sender can\'t answer it');
  assert.equal(await call(T, 'select public.answer_item($1)', [id]), false);
  assert.equal(await call(S2, 'select public.answer_item($1)', [id]), true);
  assert.equal(await call(S2, 'select public.answer_item($1)', [id]), false, 'answering twice changes nothing');
  assert.deepEqual((await inbox(S2)).map(i => i.payload.text), ['å'.repeat(300)]);

  // Friend requests and reminders share the inbox, newest first.
  await call(T, `select public.friend_request('sam')`);
  assert.deepEqual((await inbox(S2)).map(i => [i.kind, i.username]), [['friend_request', 'tove'], ['reminder', 'rita']]);

  // No longer friends (or blocked): waiting items aren't shown and nothing new can be sent.
  await call(S2, `select public.block_user('rita')`);
  assert.deepEqual((await inbox(S2)).map(i => i.kind), ['friend_request']);
  await fails(R, `select public.send_reminder('sam', 'hi')`, [], /send_not_friend/);

  // The table itself is out of reach.
  await fails(S2, 'select * from public.inbox_items');
  await fails(R, `insert into public.inbox_items (sender, recipient, kind, payload) values ($1, $2, 'reminder', '{"text":"x"}')`, [R, S2]);
  await fails(S2, `update public.inbox_items set answered_at = null`);
});

test('reminders to friends: at most 50 a day; old and answered items are removed', async () => {
  const U = '00000000-0000-4000-8000-0000000000c1', V = '00000000-0000-4000-8000-0000000000c2';
  await signUp(U, 'u@example.com', { username: 'ulla' });
  await signUp(V, 'v@example.com', { username: 'vera' });
  await rows(U, `select public.friend_request('vera')`);
  await rows(V, `select public.friend_respond('ulla', true)`);
  for (let i = 0; i < 50; i++) await rows(U, `select public.send_reminder('vera', $1)`, [`nr ${i}`]);
  await fails(U, `select public.send_reminder('vera', 'one too many')`, [], /send_limit/);
  // Answering doesn't free up the day's limit.
  const [first] = (await db.query(`select id from public.inbox_items where sender = $1 order by id limit 1`, [U])).rows;
  await rows(V, 'select public.answer_item($1)', [first.id]);
  await fails(U, `select public.send_reminder('vera', 'still too many')`, [], /send_limit/);

  const [job] = (await db.query(`select command from cron.job where jobname = 'ping-old-inbox-items'`)).rows;
  assert.ok(job, 'cleanup job is scheduled');
  await db.query(`update public.inbox_items set answered_at = now() - interval '2 days' where id = $1`, [first.id]);
  await db.query(`update public.inbox_items set created_at = now() - interval '31 days' where sender = $1 and payload->>'text' = 'nr 1'`, [U]);
  await db.query(`update public.inbox_items set answered_at = now() - interval '1 hour' where sender = $1 and payload->>'text' = 'nr 2'`, [U]);
  await db.exec(job.command);
  const left = (await db.query(`select payload->>'text' as t from public.inbox_items where sender = $1`, [U])).rows.map(r => r.t);
  assert.equal(left.length, 48);
  assert.ok(!left.includes('nr 0') && !left.includes('nr 1') && left.includes('nr 2'));
  // A day later the limit frees up.
  await db.query(`update public.inbox_items set created_at = now() - interval '25 hours' where sender = $1`, [U]);
  assert.ok(await rows(U, `select public.send_reminder('vera', 'new day')`));
});

test('board invites: friends only, a valid room id, shown for a day, no duplicates, own daily limit', async () => {
  const H1 = '00000000-0000-4000-8000-000000000f41', G1 = '00000000-0000-4000-8000-000000000f42', X1 = '00000000-0000-4000-8000-000000000f43';
  await signUp(H1, 'h1@example.com', { username: 'hosta', display_name: 'Hosta' });
  await signUp(G1, 'g1@example.com', { username: 'gesta' });
  await signUp(X1, 'x1@example.com', { username: 'xena' });
  const call = (uid, sql, p) => rows(uid, sql, p).then(r => Object.values(r[0])[0]);
  const inbox = uid => rows(uid, 'select * from public.my_inbox()');
  const ROOM = 'abcdefghij0123456789';
  await fails(H1, `select public.send_board_invite('gesta', $1, 'Plan')`, [ROOM], /send_not_friend/);
  await call(H1, `select public.friend_request('gesta')`);
  await call(G1, `select public.friend_respond('hosta', true)`);

  const id = Number(await call(H1, `select public.send_board_invite('gesta', $1, $2)`, [ROOM, '  Planering  ']));
  assert.deepEqual((await inbox(G1)).map(i => [i.kind, Number(i.id), i.username, i.payload]),
    [['board_invite', id, 'hosta', { room: ROOM, title: 'Planering' }]]);
  assert.equal(Number(await call(H1, `select public.send_board_invite('gesta', $1, 'Again')`, [ROOM])), id, 'inviting again: same invite');
  assert.equal((await inbox(G1)).length, 1);
  // Room ids must look like the app's; titles are cut to 80; an empty title is fine.
  for (const bad of ['short', 'ABCDEFGHIJ0123456789', 'abcdefghij012345678/', 'https://evil.example/x', 'a'.repeat(41)])
    await fails(H1, `select public.send_board_invite('gesta', $1, 'x')`, [bad], /send_room_bad/);
  await fails(H1, `select public.send_board_invite('gesta', null, 'x')`, [], /send_room_bad/);
  const id2 = await call(H1, `select public.send_board_invite('gesta', $1, $2)`, ['zzzzzzzzzzzz', 'T'.repeat(200)]);
  const [long] = (await db.query('select payload from public.inbox_items where id = $1', [id2])).rows;
  assert.equal(long.payload.title.length, 80);
  assert.ok(await call(H1, `select public.send_board_invite('gesta', 'yyyyyyyyyyyy', '')`));
  await fails(X1, `select public.send_board_invite('gesta', $1, 'x')`, [ROOM], /send_not_friend/);
  await fails(null, `select public.send_board_invite('gesta', $1, 'x')`, [ROOM]);
  // The table's own checks hold even for the service role.
  await assert.rejects(db.query(`insert into public.inbox_items (sender, recipient, kind, payload) values ($1, $2, 'board_invite', '{"room":"bad","title":""}')`, [H1, G1]));
  await assert.rejects(db.query(`insert into public.inbox_items (sender, recipient, kind, payload) values ($1, $2, 'board_invite', $3)`, [H1, G1, { room: ROOM, title: '', url: 'x' }]));
  await assert.rejects(db.query(`insert into public.inbox_items (sender, recipient, kind, payload) values ($1, $2, 'other', '{}')`, [H1, G1]));

  // Answering works as for reminders; a day-old invite is no longer shown, but reminders are.
  assert.equal(await call(G1, 'select public.answer_item($1)', [id]), true);
  await call(H1, `select public.send_reminder('gesta', 'still here')`);
  await db.query(`update public.inbox_items set created_at = now() - interval '25 hours' where sender = $1`, [H1]);
  assert.deepEqual((await inbox(G1)).map(i => i.kind), ['reminder']);
  // After a day, inviting to the same room makes a new invite.
  assert.notEqual(Number(await call(H1, `select public.send_board_invite('gesta', $1, 'Plan')`, [ROOM])), id);

  // Invites and reminders have separate daily limits.
  await db.query(`delete from public.inbox_items where sender = $1`, [H1]);
  for (let i = 0; i < 50; i++) await rows(H1, `select public.send_board_invite('gesta', $1, 'x')`, ['room' + String(i).padStart(10, '0')]);
  await fails(H1, `select public.send_board_invite('gesta', 'roomxxxxxxxxxx', 'x')`, [], /send_limit/);
  assert.ok(await call(H1, `select public.send_reminder('gesta', 'a reminder still goes')`));
});

test('shared notes: share with friends, roles, saving on a revision, conflicts come back, people and leaving', async () => {
  const O = '00000000-0000-4000-8000-000000000a51', E = '00000000-0000-4000-8000-000000000a52', R = '00000000-0000-4000-8000-000000000a53', X = '00000000-0000-4000-8000-000000000a54';
  await signUp(O, 'o5@example.com', { username: 'olga', display_name: 'Olga' });
  await signUp(E, 'e5@example.com', { username: 'edvin' });
  await signUp(R, 'r5@example.com', { username: 'ronja' });
  await signUp(X, 'x5@example.com', { username: 'xerxes' });
  const call = (uid, sql, p) => rows(uid, sql, p).then(r => Object.values(r[0])[0]);
  for (const [who, name] of [[E, 'olga'], [R, 'olga']]) { await call(who, `select public.friend_request($1)`, [name]); }
  await call(O, `select public.friend_respond('edvin', true)`); await call(O, `select public.friend_respond('ronja', true)`);
  const ID = 'sh-abcdefghij012345', people = JSON.stringify([{ name: 'edvin', role: 'edit' }, { name: 'RONJA', role: 'read' }]);
  const sync = (uid, known = {}, one = null) => rows(uid, 'select * from public.shared_notes_sync($1, $2)', [known, one]);

  // Only friends; a valid id; somebody to share with.
  await fails(O, `select public.shared_note_create($1, $2, $3)`, [ID, { text: 'x' }, JSON.stringify([{ name: 'xerxes' }])], /share_not_friend/);
  await fails(O, `select public.shared_note_create($1, $2, $3)`, ['bad-id', { text: 'x' }, people], /share_bad/);
  await fails(O, `select public.shared_note_create($1, $2, '[]')`, [ID, { text: 'x' }], /share_bad/);
  await fails(O, `select public.shared_note_create($1, $2, $3)`, [ID, { text: 'x' }, JSON.stringify([{ name: 'edvin', role: 'owner' }])], /share_bad/);
  assert.equal((await sync(O)).length, 0, 'a refused share leaves nothing behind');
  assert.equal(Number(await call(O, `select public.shared_note_create($1, $2, $3)`, [ID, { text: 'Inköp\n- [ ] mjölk' }, people])), 1);
  assert.equal(Number(await call(O, `select public.shared_note_create($1, $2, $3)`, [ID, { text: 'again' }, people])), 1, 'a retried create changes nothing');
  await fails(E, `select public.shared_note_create($1, $2, '[{"name":"olga"}]')`, [ID, { text: 'x' }], /share_bad/);   // someone else's id

  // Everyone in it sees it with their role and the people; strangers don't.
  const [se] = await sync(E);
  assert.deepEqual([se.id, Number(se.rev), se.role, se.owner_name, se.data], [ID, 1, 'edit', 'olga', { text: 'Inköp\n- [ ] mjölk' }]);
  assert.deepEqual(se.people.map(p => [p.username, p.role]), [['olga', 'owner'], ['edvin', 'edit'], ['ronja', 'read']]);
  assert.equal((await sync(R))[0].role, 'read');
  assert.equal((await sync(X)).length, 0);
  assert.equal((await sync(E, { [ID]: 1 }))[0].data, null, 'no data when this device already has the revision');
  assert.equal((await sync(E, {}, 'sh-other00000000'))[0], undefined);

  // Saving on the current revision works; on an old one the current version comes back instead.
  const save = (uid, rev, body) => rows(uid, 'select * from public.shared_note_save($1, $2, $3)', [ID, rev, body]).then(r => r[0]);
  let s = await save(E, 1, { text: 'Inköp\n- [x] mjölk' });
  assert.deepEqual([Number(s.cur_rev), s.cur_data, s.saved], [2, null, true]);
  s = await save(O, 1, { text: 'Inköp\n- [ ] mjölk\n- [ ] bröd' });
  assert.deepEqual([Number(s.cur_rev), s.cur_data, s.saved], [2, { text: 'Inköp\n- [x] mjölk' }, false], 'a stale save is not stored');
  s = await save(O, 2, { text: 'Inköp\n- [x] mjölk\n- [ ] bröd' });
  assert.equal(s.saved, true);
  await fails(R, 'select * from public.shared_note_save($1, 3, $2)', [ID, { text: 'reader' }], /share_read_only/);
  await fails(X, 'select * from public.shared_note_save($1, 3, $2)', [ID, { text: 'x' }], /share_gone/);
  await fails(E, 'select * from public.shared_note_save($1, 3, $2)', [ID, '"text"'], /share_bad/);

  // Only the owner changes the people.
  await fails(E, `select public.shared_note_set_members($1, '[]')`, [ID], /share_gone/);
  await call(O, `select public.shared_note_set_members($1, $2)`, [ID, JSON.stringify([{ name: 'ronja', role: 'edit' }])]);
  assert.equal((await sync(E)).length, 0, 'removed');
  assert.equal((await sync(R))[0].role, 'edit', 'role changed');
  await fails(O, `select public.shared_note_set_members($1, $2)`, [ID, JSON.stringify([{ name: 'xerxes' }])], /share_not_friend/);
  assert.equal((await sync(R)).length, 1, 'a refused change changes nothing');
  await call(O, `select public.shared_note_set_members($1, $2)`, [ID, people]);

  // Leaving; ending the friendship or blocking removes the person from the other's notes.
  assert.equal(await call(E, `select public.shared_note_leave($1)`, [ID]), true);
  assert.equal((await sync(E)).length, 0);
  await call(O, `select public.shared_note_set_members($1, $2)`, [ID, people]);
  await call(E, `select public.friend_remove('olga')`);
  assert.equal((await sync(E)).length, 0, 'not friends: not in the note');
  await call(R, `select public.block_user('olga')`);
  assert.equal((await sync(R)).length, 0, 'blocked: not in the note');
  assert.deepEqual((await sync(O))[0].people.map(p => p.username), ['olga'], 'the owner still has the note');

  // The tables are out of reach; anon can't call anything; stopping removes it.
  await fails(O, 'select * from public.shared_notes');
  await fails(O, 'select * from public.shared_note_members');
  await fails(O, `insert into public.shared_note_members (note_id, member, role) values ($1, $2, 'edit')`, [ID, X]);
  await fails(null, 'select * from public.shared_notes_sync()');
  await fails(null, `select public.shared_note_stop($1)`, [ID]);
  assert.equal(await call(E, `select public.shared_note_stop($1)`, [ID]), false, 'only the owner can stop sharing');
  assert.equal(await call(O, `select public.shared_note_stop($1)`, [ID]), true);
  assert.equal((await sync(O)).length, 0);
});

test('shared notes: pictures are visible to everyone in the note, added by owner and editors, counted on the owner', async () => {
  const O = '00000000-0000-4000-8000-000000000a61', E = '00000000-0000-4000-8000-000000000a62', R = '00000000-0000-4000-8000-000000000a63', X = '00000000-0000-4000-8000-000000000a64';
  await signUp(O, 'o6@example.com', { username: 'otto' });
  await signUp(E, 'e6@example.com', { username: 'elin' });
  await signUp(R, 'r6@example.com', { username: 'rut' });
  await signUp(X, 'x6@example.com', { username: 'xavier' });
  for (const n of ['elin', 'rut']) await rows(O, `select public.friend_request($1)`, [n]);
  await rows(E, `select public.friend_respond('otto', true)`); await rows(R, `select public.friend_respond('otto', true)`);
  const ID = 'sh-picturenote0001';
  await rows(O, `select public.shared_note_create($1, '{"text":"x"}', $2)`, [ID, JSON.stringify([{ name: 'elin', role: 'edit' }, { name: 'rut', role: 'read' }])]);
  await db.query('update public.account_private set quota_bytes = 1000, used_bytes = 0 where id = $1', [O]);
  const put = (uid, name) => rows(uid, `insert into storage.objects (bucket_id, name) values ('note-images', $1) returning id`, [name]);
  const setSize = (name, size) => db.query(`update storage.objects set metadata = jsonb_build_object('size', $2::bigint) where bucket_id = 'note-images' and name = $1`, [name, size]);
  const used = async uid => Number((await db.query('select used_bytes from public.account_private where id = $1', [uid])).rows[0].used_bytes);
  const see = uid => rows(uid, `select name from storage.objects where name like 'shared/%' order by name`).then(r => r.map(x => x.name));

  await put(E, `shared/${ID}/p1`);
  await setSize(`shared/${ID}/p1`, 700);
  assert.equal(await used(O), 700, 'counted on the owner');
  assert.equal(await used(E), 0);
  await fails(R, `insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`shared/${ID}/p2`], /row-level security/);
  await fails(X, `insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`shared/${ID}/p2`], /row-level security/);
  await fails(E, `insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`shared/${ID}/deep/p2`], /row-level security/);
  await fails(E, `insert into storage.objects (bucket_id, name) values ('boards', $1)`, [`shared/${ID}/p2`], /row-level security/);
  for (const who of [O, E, R]) assert.deepEqual(await see(who), [`shared/${ID}/p1`]);
  assert.deepEqual(await see(X), [], 'strangers see nothing');
  await put(O, `shared/${ID}/p2`);
  await setSize(`shared/${ID}/p2`, 400);
  await fails(E, `insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`shared/${ID}/p3`], /row-level security/);   // owner's quota used up
  // Only the owner removes pictures; the recount agrees.
  assert.equal((await rows(E, `delete from storage.objects where name = $1 returning id`, [`shared/${ID}/p1`])).length, 0);
  assert.equal((await rows(O, `delete from storage.objects where name = $1 returning id`, [`shared/${ID}/p1`])).length, 1);
  assert.equal(await used(O), 400);
  await db.query('update public.account_private set used_bytes = 0 where id = $1', [O]);
  await as('service', q => q('select public.recount_storage_use()'));
  assert.equal(await used(O), 400);
  // Someone removed from the note no longer sees its pictures.
  await rows(O, `select public.shared_note_set_members($1, '[{"name":"rut","role":"read"}]')`, [ID]);
  assert.deepEqual(await see(E), []);
});

// ---- phase 7b: push
const EP = n => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const P256 = 'B' + 'x'.repeat(86), AUTH = 'a'.repeat(22);
const sub = (uid, ep, lang = 'sv') => rows(uid, 'select public.push_subscribe($1, $2, $3, $4) as ok', [ep, P256, AUTH, lang]);
const sched = (uid, items, replace = false) => rows(uid, 'select public.push_schedule_set($1, $2) as ok', [JSON.stringify(items), replace]);

test('push: devices subscribe through the functions only; only push services; ≤ 10 per account; a device moves with sign-in', async () => {
  await fails(A, 'select * from public.push_subscriptions', [], /permission denied/);
  await fails(A, 'select * from public.push_schedule', [], /permission denied/);
  await fails(null, 'select public.push_subscribe($1, $2, $3, $4)', [EP(1), P256, AUTH, 'sv'], /permission denied/);
  await fails(A, 'select public.push_take_due()', [], /permission denied/);
  await fails(A, 'select public.push_report($1, $2, $3)', [[], [], []], /permission denied/);
  await fails(A, 'select public.push_tick()', [], /permission denied/);
  assert.equal((await sub(A, EP(1)))[0].ok, true);
  await sub(A, EP(1), 'en');                                   // again: refreshed, not doubled
  let s = (await db.query('select user_id, lang from public.push_subscriptions where endpoint = $1', [EP(1)])).rows;
  assert.deepEqual(s.map(r => ({ ...r })), [{ user_id: A, lang: 'en' }]);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x'])
    await fails(A, 'select public.push_subscribe($1, $2, $3, $4)', [bad, P256, AUTH, 'sv'], /check constraint/);
  await fails(A, 'select public.push_subscribe($1, $2, $3, $4)', [EP(2), 'short', AUTH, 'sv'], /check constraint/);
  for (const ep of ['https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-db5p.notify.windows.com/w/?token=abc'])
    await sub(B, ep);
  // Bob signs in as Alice on the Apple device: it moves to Alice.
  await sub(A, 'https://web.push.apple.com/abc');
  assert.equal((await db.query(`select user_id from public.push_subscriptions where endpoint = 'https://web.push.apple.com/abc'`)).rows[0].user_id, A);
  for (let i = 10; i < 22; i++) await sub(A, EP(i));
  assert.equal((await db.query('select count(*)::int as n from public.push_subscriptions where user_id = $1', [A])).rows[0].n, 10);
  assert.equal((await db.query('select 1 from public.push_subscriptions where endpoint = $1', [EP(1)])).rows.length, 0, 'the oldest went');
  // Unsubscribe: only your own.
  assert.equal((await rows(B, 'select public.push_unsubscribe($1) as ok', [EP(21)]))[0].ok, false);
  assert.equal((await rows(A, 'select public.push_unsubscribe($1) as ok', [EP(21)]))[0].ok, true);
});

test('push: the schedule keeps future times only, is kept only with a device, and the sender takes what is due once', async () => {
  const C2 = '00000000-0000-4000-8000-0000000000f7';
  await signUp(C2, 'p7@example.com', { username: 'pushy' });
  const t = Date.now(), H = 3600000;
  // No device yet: nothing is kept.
  assert.equal((await sched(C2, [{ id: 'r1', title: 'Ring mamma', times: [t + H] }]))[0].ok, false);
  assert.equal((await db.query('select 1 from public.push_schedule where user_id = $1', [C2])).rows.length, 0);
  await sub(C2, EP('c2'));
  assert.equal((await sched(C2, [
    { id: 'r1', title: '  Ring mamma  ', times: [t + 2 * H, t + H, t + H, t - H, t + 50 * 86400000, 'x'] },
    { id: 'r2', title: '', times: [t + H] },
    { id: 'r3', title: 'Klar', times: [] }
  ]))[0].ok, true);
  let p = (await db.query('select reminder_id, title, cardinality(times) as n, next_at from public.push_schedule where user_id = $1 order by 1', [C2])).rows;
  assert.deepEqual(p.map(r => [r.reminder_id, r.title, r.n]), [['r1', 'Ring mamma', 2], ['r2', '…', 1]]);
  assert.ok(Math.abs(+p[0].next_at - (t + H)) < 1000, 'next_at is the first time');
  const many = Array.from({ length: 40 }, (_, i) => t + (i + 1) * 60000);
  await sched(C2, [{ id: 'r4', title: 'Ofta', times: many }]);
  assert.equal((await db.query(`select cardinality(times) as n from public.push_schedule where user_id = $1 and reminder_id = 'r4'`, [C2])).rows[0].n, 30);
  await fails(C2, 'select public.push_schedule_set($1)', [JSON.stringify([{ id: '', times: [] }])], /push_items_bad/);
  await fails(C2, 'select public.push_schedule_set($1)', [JSON.stringify({ id: 'x' })], /push_items_bad/);
  // A full upload removes what isn't listed.
  await sched(C2, [{ id: 'r1', title: 'Ring mamma', times: [t + H, t + 2 * H] }], true);
  assert.deepEqual((await db.query('select reminder_id from public.push_schedule where user_id = $1', [C2])).rows.map(r => r.reminder_id), ['r1']);
  // Make r1's first time due a minute ago (as if time passed), plus one that is 2 hours late (skipped).
  await db.query(`update public.push_schedule set times = array[now() - interval '2 hours', now() - interval '1 minute', now() + interval '1 hour'],
                  next_at = now() - interval '2 hours' where user_id = $1`, [C2]);
  await sub(C2, EP('c2b'), 'en');
  const due = await rows('service', 'select * from public.push_take_due()');
  const mine = due.filter(d => d.reminder_id === 'r1');
  assert.deepEqual(mine.map(d => d.endpoint).sort(), [EP('c2'), EP('c2b')], 'one row per device');
  assert.ok(Math.abs(+mine[0].at - (Date.now() - 60000)) < 5000, 'the latest due time, not the late one');
  assert.equal(mine.find(d => d.endpoint === EP('c2b')).lang, 'en');
  assert.equal((await rows('service', 'select * from public.push_take_due()')).filter(d => d.reminder_id === 'r1').length, 0, 'sent once');
  const [row] = (await db.query('select next_at from public.push_schedule where user_id = $1', [C2])).rows;
  assert.ok(+row.next_at > Date.now(), 'next_at moved on to the next time');
  // Re-uploading the same times after sending doesn't send them again.
  await db.query(`update public.push_schedule set next_at = null where user_id = $1`, [C2]);
  await sched(C2, [{ id: 'r1', title: 'Ring mamma', times: [t + H] }]);
  assert.ok(+(await db.query('select next_at from public.push_schedule where user_id = $1', [C2])).rows[0].next_at > Date.now());
  // Reports: delivered, gone, failing.
  const ids = (await db.query('select id, endpoint from public.push_subscriptions where user_id = $1 order by id', [C2])).rows;
  await rows('service', 'select public.push_report($1, $2, $3)', [[ids[0].id], [], [ids[1].id]]);
  let s = (await db.query('select endpoint, failures, last_ok_at from public.push_subscriptions where user_id = $1 order by id', [C2])).rows;
  assert.ok(s[0].last_ok_at); assert.equal(s[1].failures, 1);
  await db.query('update public.push_subscriptions set failures = 19 where id = $1', [ids[1].id]);
  await rows('service', 'select public.push_report($1, $2, $3)', [[], [ids[0].id], [ids[1].id]]);
  assert.equal((await db.query('select 1 from public.push_subscriptions where user_id = $1', [C2])).rows.length, 0, 'gone and 20 failures are removed');
});

test('push: the minute job calls the Edge Function only when something is due and the Vault secrets are set', async () => {
  assert.equal((await db.query(`select schedule from cron.job where jobname = 'ping-push'`)).rows[0].schedule, '* * * * *');
  await db.query('delete from net.calls');
  await db.query(`update public.push_schedule set next_at = now() - interval '1 minute' where reminder_id = 'r1'`);
  await db.query('select public.push_tick()');
  assert.equal((await db.query('select count(*)::int as n from net.calls')).rows[0].n, 0, 'no secrets: nothing');
  await db.query(`insert into vault.decrypted_secrets values ('push_function_url', 'https://x.supabase.co/functions/v1/send-due-pushes'), ('push_cron_secret', 's3cret')`);
  await db.query('select public.push_tick()');
  const [c] = (await db.query('select * from net.calls')).rows;
  assert.equal(c.url, 'https://x.supabase.co/functions/v1/send-due-pushes');
  assert.equal(c.headers['x-cron-secret'], 's3cret');
  await db.query('delete from net.calls');
  await db.query('update public.push_schedule set next_at = null');
  await db.query('select public.push_tick()');
  assert.equal((await db.query('select count(*)::int as n from net.calls')).rows[0].n, 0, 'nothing due: no call');
});

test('deleting an account removes all its rows', async () => {
  const E2 = '00000000-0000-4000-8000-0000000000e2';
  await signUp(E2, 'e2@example.com', { username: 'eve2' });
  await rows(A, `select public.friend_request('eve2')`);
  await rows(E2, `select public.friend_respond('alice', true)`);
  await rows(A, `select public.send_reminder('eve2', 'from alice')`);
  await rows(E2, `select public.send_reminder('alice', 'to alice')`);
  await rows(A, `select public.shared_note_create('sh-alicesnote00001', '{"text":"a"}', '[{"name":"eve2"}]')`);
  await rows(E2, `select public.shared_note_create('sh-evesnote000001', '{"text":"e"}', '[{"name":"alice"}]')`);
  await rows(A, `select public.report_user('bob', 'sent by alice')`);
  await sub(A, EP('del'));
  await sched(A, [{ id: 'rdel', title: 'x', times: [Date.now() + 3600000] }]);
  const E ='00000000-0000-4000-8000-0000000000e1';
  await signUp(E, 'e@example.com', { username: 'erin' });
  await rows(E, `select public.report_user('alice', 'about alice')`);
  await db.query('delete from auth.users where id = $1', [A]);
  // Reports about the account go; reports it sent stay for the operator, with no link to the account.
  assert.equal((await db.query('select 1 from public.reports where target = $1', [A])).rows.length, 0);
  assert.deepEqual((await db.query(`select reporter from public.reports where reason = 'sent by alice'`)).rows.map(r => r.reporter), [null]);
  for (const t of ['profiles', 'account_private']) assert.equal((await db.query(`select 1 from public.${t} where id = $1`, [A])).rows.length, 0, t);
  for (const t of ['reminders', 'notes', 'boards', 'user_settings', 'push_subscriptions', 'push_schedule']) assert.equal((await db.query(`select 1 from public.${t} where user_id = $1`, [A])).rows.length, 0, t);
  assert.equal((await db.query('select 1 from public.blocks where blocker = $1 or blocked = $1', [A])).rows.length, 0);
  assert.equal((await db.query('select 1 from public.friendships where a = $1 or b = $1 or requested_by = $1', [A])).rows.length, 0);
  assert.equal((await db.query('select 1 from public.inbox_items where sender = $1 or recipient = $1', [A])).rows.length, 0);
  // Notes the account shared go; notes others shared with it stay, without it.
  assert.deepEqual((await db.query('select id from public.shared_notes order by id')).rows.map(r => r.id).filter(i => /alices|evesn/.test(i)), ['sh-evesnote000001']);
  assert.equal((await db.query('select 1 from public.shared_note_members where member = $1', [A])).rows.length, 0);
});
