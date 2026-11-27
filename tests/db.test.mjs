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
    // pg_cron isn't available in PGlite; the stand-in cron schema above takes its place.
    const sql = readFileSync(DIR + f, 'utf8').replace(/create extension if not exists pg_cron;/i, '');
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

test('deleting an account removes all its rows', async () => {
  const E2 = '00000000-0000-4000-8000-0000000000e2';
  await signUp(E2, 'e2@example.com', { username: 'eve2' });
  await rows(A, `select public.friend_request('eve2')`);
  await rows(E2, `select public.friend_respond('alice', true)`);
  await rows(A, `select public.send_reminder('eve2', 'from alice')`);
  await rows(E2, `select public.send_reminder('alice', 'to alice')`);
  await rows(A, `select public.report_user('bob', 'sent by alice')`);
  const E = '00000000-0000-4000-8000-0000000000e1';
  await signUp(E, 'e@example.com', { username: 'erin' });
  await rows(E, `select public.report_user('alice', 'about alice')`);
  await db.query('delete from auth.users where id = $1', [A]);
  // Reports about the account go; reports it sent stay for the operator, with no link to the account.
  assert.equal((await db.query('select 1 from public.reports where target = $1', [A])).rows.length, 0);
  assert.deepEqual((await db.query(`select reporter from public.reports where reason = 'sent by alice'`)).rows.map(r => r.reporter), [null]);
  for (const t of ['profiles', 'account_private']) assert.equal((await db.query(`select 1 from public.${t} where id = $1`, [A])).rows.length, 0, t);
  for (const t of ['reminders', 'notes', 'boards', 'user_settings']) assert.equal((await db.query(`select 1 from public.${t} where user_id = $1`, [A])).rows.length, 0, t);
  assert.equal((await db.query('select 1 from public.blocks where blocker = $1 or blocked = $1', [A])).rows.length, 0);
  assert.equal((await db.query('select 1 from public.friendships where a = $1 or b = $1 or requested_by = $1', [A])).rows.length, 0);
  assert.equal((await db.query('select 1 from public.inbox_items where sender = $1 or recipient = $1', [A])).rows.length, 0);
});
