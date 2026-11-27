// The delete-account Edge Function (supabase/functions/delete-account/index.ts): its marked block runs here in Node
// against a stand-in for the service-role supabase-js client. The database side (every row goes with the user) is
// tested in db.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const FILE = fileURLToPath(new URL('../supabase/functions/delete-account/index.ts', import.meta.url));
function load() {
  const src = readFileSync(FILE, 'utf8'), a = src.indexOf('/*DELETE-START*/'), b = src.indexOf('/*DELETE-END*/');
  assert.ok(a >= 0 && b > a, 'marked block found');
  const ctx = vm.createContext({});
  vm.runInContext(src.slice(a, b) + '\n;globalThis.__out = { deleteAccount, corsHeaders, BUCKETS };', ctx);
  return ctx.__out;
}
const fn = load(), { corsHeaders, BUCKETS } = fn;
const deleteAccount = async (...a) => JSON.parse(JSON.stringify(await fn.deleteAccount(...a)));   // plain arrays from this realm

// A service-role client: users by token, profiles, and files per bucket (listed one folder level at a time, like Storage).
function fakeAdmin({ files = {}, failRemove = false, shared = [] } = {}) {
  const st = { users: { 'tok-a': { id: 'ua', email: 'a@example.com' }, 'tok-b': { id: 'ub', email: 'B@Example.com' } },
    profiles: { ua: { username: 'alice' } }, shared, files: {}, deleted: [], removed: [] };
  for (const bk of BUCKETS) st.files[bk] = new Set(files[bk] || []);
  return {
    st,
    auth: {
      async getUser(jwt) { const u = st.users[jwt]; return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }; },
      admin: { async deleteUser(id) { st.deleted.push(id); return { data: {}, error: null }; } },
    },
    from(table) {
      assert.ok(table === 'profiles' || table === 'shared_notes', table);
      let id;
      const q = { select() { return q; }, eq(col, v) { id = v; return table === 'shared_notes' ? Promise.resolve({ data: st.shared.filter(n => n.owner === v).map(n => ({ id: n.id })), error: null }) : q; },
        async maybeSingle() { return { data: st.profiles[id] || null, error: null }; } };
      return q;
    },
    storage: {
      from(bucket) {
        const set = st.files[bucket];
        return {
          async list(prefix, { limit, offset }) {
            const seen = new Map();
            for (const p of [...set].sort()) {
              if (!p.startsWith(prefix + '/')) continue;
              const rest = p.slice(prefix.length + 1), i = rest.indexOf('/');
              const name = i < 0 ? rest : rest.slice(0, i);
              if (!seen.has(name)) seen.set(name, { name, id: i < 0 ? 'id-' + name : null });
            }
            return { data: [...seen.values()].slice(offset, offset + limit), error: null };
          },
          async remove(paths) {
            if (failRemove) return { data: null, error: { message: 'boom' } };
            st.removed.push(...paths.map(p => bucket + '/' + p));
            paths.forEach(p => set.delete(p));
            return { data: [], error: null };
          },
        };
      },
    },
  };
}

test('no session, or a session that does not check out: 401 and nothing happens', async () => {
  const admin = fakeAdmin({ files: { boards: ['ua/b.json'] } });
  assert.deepEqual(await deleteAccount(admin, '', 'alice'), [401, { error: 'not_signed_in' }]);
  assert.deepEqual(await deleteAccount(admin, 'forged', 'alice'), [401, { error: 'not_signed_in' }]);
  assert.deepEqual(admin.st.deleted, []);
  assert.equal(admin.st.files.boards.size, 1);
});

test('the wrong username: 400 and nothing is deleted', async () => {
  const admin = fakeAdmin({ files: { boards: ['ua/b.json'] } });
  for (const c of ['', 'bob', 'alic', undefined]) assert.deepEqual(await deleteAccount(admin, 'tok-a', c), [400, { error: 'confirm_mismatch' }]);
  assert.deepEqual(admin.st.deleted, []);
  assert.equal(admin.st.files.boards.size, 1);
});

test('the right username: every own file in every bucket goes (sub-folders and >1000 files too), then the user', async () => {
  const many = Array.from({ length: 1205 }, (_, i) => `ua/pic-${String(i).padStart(4, '0')}`);
  const admin = fakeAdmin({ files: {
    'note-images': [...many, 'ua/sub/deeper/x.webp', 'ub/keep.webp'],
    boards: ['ua/b1-1.json', 'ub/b2-1.json'],
    avatars: ['ua/avatar.webp', 'ub/avatar.webp'],
  } });
  assert.deepEqual(await deleteAccount(admin, 'tok-a', ' @Alice '), [200, { ok: true }]);
  for (const bk of BUCKETS) assert.ok(![...admin.st.files[bk]].some(p => p.startsWith('ua/')), bk + ' has no files of the user left');
  assert.deepEqual([...admin.st.files['note-images']], ['ub/keep.webp'], 'other users\' files stay');
  assert.deepEqual([...admin.st.files.boards], ['ub/b2-1.json']);
  assert.deepEqual([...admin.st.files.avatars], ['ub/avatar.webp']);
  assert.ok(admin.st.removed.includes('note-images/ua/sub/deeper/x.webp'));
  assert.deepEqual(admin.st.deleted, ['ua']);
});

test('pictures of notes the user shared (shared/{note}/…) go too; others\' shared notes stay', async () => {
  const admin = fakeAdmin({ shared: [{ id: 'sh-mine00000001', owner: 'ua' }, { id: 'sh-theirs000001', owner: 'ub' }],
    files: { 'note-images': ['shared/sh-mine00000001/p1', 'shared/sh-mine00000001/p2', 'shared/sh-theirs000001/p3', 'ua/own'] } });
  assert.deepEqual(await deleteAccount(admin, 'tok-a', 'alice'), [200, { ok: true }]);
  assert.deepEqual([...admin.st.files['note-images']], ['shared/sh-theirs000001/p3']);
});

test('without a profile (no username yet) the email address confirms, in any case', async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await deleteAccount(admin, 'tok-b', 'bob'), [400, { error: 'confirm_mismatch' }]);
  assert.deepEqual(await deleteAccount(admin, 'tok-b', 'b@example.com'), [200, { ok: true }]);
  assert.deepEqual(admin.st.deleted, ['ub']);
});

test('if the files can\'t be removed, the user is not deleted (no orphaned files)', async () => {
  const admin = fakeAdmin({ files: { boards: ['ua/b.json'] }, failRemove: true });
  assert.deepEqual(await deleteAccount(admin, 'tok-a', 'alice'), [500, { error: 'storage' }]);
  assert.deepEqual(admin.st.deleted, []);
});

test('CORS: Pinglapp and local testing are allowed; any other site gets pinglapp.com back', () => {
  assert.equal(corsHeaders('https://pinglapp.com')['Access-Control-Allow-Origin'], 'https://pinglapp.com');
  assert.equal(corsHeaders('http://localhost:8080')['Access-Control-Allow-Origin'], 'http://localhost:8080');
  assert.equal(corsHeaders('https://evil.example')['Access-Control-Allow-Origin'], 'https://pinglapp.com');
  assert.match(corsHeaders('')['Access-Control-Allow-Headers'], /authorization/);
});
