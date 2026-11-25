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

test('deleting an account removes all its rows', async () => {
  await db.query('delete from auth.users where id = $1', [A]);
  for (const t of ['profiles', 'account_private']) assert.equal((await db.query(`select 1 from public.${t} where id = $1`, [A])).rows.length, 0, t);
  for (const t of ['reminders', 'notes', 'boards', 'user_settings']) assert.equal((await db.query(`select 1 from public.${t} where user_id = $1`, [A])).rows.length, 0, t);
  assert.equal((await db.query('select 1 from public.blocks where blocker = $1 or blocked = $1', [A])).rows.length, 0);
});
