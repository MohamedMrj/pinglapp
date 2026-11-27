// A stand-in for supabase-js and the Supabase server, for the browser tests.
//  * FAKE runs in the page (via addInitScript) and becomes window.PING_ACCOUNTS_FAKE: sign-in, sessions and profiles
//    are kept per browser profile; every call is recorded in PING_ACCOUNTS_FAKE.db.calls.
//  * FakeServer runs in Node and holds the synced tables. Pages reach it through window.__pingServer (exposed with
//    context.exposeFunction), so two browser profiles - two "devices" - share one server. Its rules follow the
//    database triggers in supabase/migrations: newest wins, a deletion wins a tie, far-future stamps are refused,
//    and a row can only be written by its owner.

export const FAKE = () => {
  const db = JSON.parse(sessionStorage.getItem('fakedb') || 'null') || {
    users: { 'a@example.com': { pw: 'correct-horse-1', id: 'u-a' }, 'b@example.com': { pw: 'correct-horse-2', id: 'u-b' },
      'c@example.com': { pw: 'correct-horse-3', id: 'u-c' } },
    profiles: { 'u-a': { username: 'alice', display_name: 'Alice' }, 'u-c': { username: 'carol', display_name: 'Carol' } },
    priv: { 'u-a': { terms_accepted_at: '2026-11-01' }, 'u-b': {}, 'u-c': { terms_accepted_at: '2026-11-01' } },
    taken: ['alice', 'carol', 'admin'], calls: [], created: 0, blocks: [],
  };
  db.blocks ||= [];
  const keep = () => sessionStorage.setItem('fakedb', JSON.stringify(db));
  let cbs = [], session = null;
  try { session = JSON.parse(localStorage.getItem('pinglapp.auth')); } catch { }
  const setSession = (s, ev) => {
    session = s;
    if (s) localStorage.setItem('pinglapp.auth', JSON.stringify(s)); else localStorage.removeItem('pinglapp.auth');
    cbs.forEach(cb => cb(ev, session));
  };
  const call = (...c) => { db.calls.push(c); keep(); };
  const server = async q => JSON.parse(await window.__pingServer(JSON.stringify(Object.assign({}, q, { uid: session && session.user.id }))));
  async function run(q) {
    const id = session && session.user.id;
    if (q.table === 'profiles' && q.op === 'update') {
      call('update', q.table, q.values);
      if (!id || q.eq !== id || !db.profiles[id]) return { data: null, error: null };   // row-level security: no row changed
      const av = q.values.avatar_path;
      if (av != null && !new RegExp(`^${id}/avatar\\.webp\\?v=\\d{1,15}$`).test(av))
        return { data: null, error: { code: '23514', message: 'new row for relation "profiles" violates check constraint "profiles_avatar_path_own"' } };
      const st = q.values.avatar_style, N = { s: 6, c: 12, e: 8, m: 8, a: 8, b: 12 };   // as valid_avatar_style()
      if (st != null && !(st && typeof st === 'object' && st.v === 1 && Object.keys(st).length === 7
        && Object.entries(N).every(([k, n]) => Number.isInteger(st[k]) && st[k] >= 0 && st[k] < n)))
        return { data: null, error: { code: '23514', message: 'new row for relation "profiles" violates check constraint "profiles_avatar_style_valid"' } };
      Object.assign(db.profiles[id], q.values); keep();
      return { data: null, error: null };
    }
    if (q.table === 'profiles' || q.table === 'account_private') {
      const src = q.table === 'profiles' ? db.profiles : db.priv;
      let row = (id && src[id]) || null;
      if (row && q.table === 'account_private' && window.__pingServer) row = Object.assign({}, row, (await server({ op: 'usage' })).data);
      return { data: row, error: null };
    }
    if (!window.__pingServer) return { data: q.single ? null : [], error: null };
    return JSON.parse(await window.__pingServer(JSON.stringify(Object.assign({}, q, { uid: id }))));
  }
  const from = table => {
    const q = { table, op: 'select', single: false };
    const b = {
      select(cols) { q.cols = cols; return b; },
      order() { return b; },
      limit(n) { q.limit = n; return b; },
      gt(col, v) { q.gt = v; return b; },
      in(col, ids) { q.in = ids; return b; },
      upsert(rows, o) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.onConflict = o && o.onConflict; return b; },
      update(values) { q.op = 'update'; q.values = values; return b; },
      eq(col, v) { q.eq = v; return b; },
      maybeSingle() { q.single = true; return b; },
      then(res, rej) { return run(q).then(res, rej); },
    };
    return b;
  };
  const client = {
    auth: {
      onAuthStateChange(cb) {
        cbs.push(cb);
        setTimeout(() => cb(sessionStorage.getItem('fakeRecovery') ? 'PASSWORD_RECOVERY' : 'INITIAL_SESSION', session));
        return { data: { subscription: { unsubscribe() { } } } };
      },
      async signInWithPassword({ email, password, options }) {
        call('signIn', email, options && options.captchaToken);
        const u = db.users[email];
        if (!u || u.pw !== password) return { data: {}, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
        setSession({ user: { id: u.id, email } }, 'SIGNED_IN');
        return { data: {}, error: null };
      },
      async signUp(a) { call('signUp', a); return { data: { user: {}, session: null }, error: null }; },
      async resetPasswordForEmail(email, o) { call('reset', email, o); return { data: {}, error: null }; },
      async updateUser(a, o) {
        call('updateUser', a, o);
        if (a.email && db.users[a.email]) return { data: {}, error: { code: 'email_exists', status: 422, message: 'A user with this email address has already been registered' } };
        // db.needReauth: "secure password change" with an old session; the emailed code is 123456.
        if (a.password && db.needReauth && a.nonce !== '123456') return { data: {}, error: a.nonce
          ? { code: 'reauthentication_not_valid', status: 400, message: 'Reauthentication failed' }
          : { code: 'reauthentication_needed', status: 400, message: 'Password update requires reauthentication' } };
        return { data: {}, error: null };
      },
      async reauthenticate() { call('reauthenticate'); return { data: {}, error: null }; },
      async getUser() { call('getUser'); return { data: { user: session ? Object.assign({}, session.user, db.userNow || {}) : null }, error: null }; },
      async signOut(o) { call('signOut', o && o.scope); if (!o || o.scope !== 'others') setSession(null, 'SIGNED_OUT'); return { error: null }; },
      async signInWithOAuth(a) { call('oauth', a.provider); return { error: null }; },
    },
    from,
    // The delete-account Edge Function: checks the typed username, then the account and everything in it is gone.
    functions: {
      async invoke(name, o) {
        call('invoke', name, o && o.body);
        const fail = (status, code) => ({ data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
          context: new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json' } }) } });
        if (name !== 'delete-account') return fail(404, 'not_found');
        if (!session) return fail(401, 'not_signed_in');
        const me = session.user.id, p = db.profiles[me];
        if (!p || (o && o.body && o.body.confirm) !== p.username) return fail(400, 'confirm_mismatch');
        delete db.profiles[me]; delete db.priv[me];
        db.taken = db.taken.filter(n => n !== p.username);
        db.blocks = db.blocks.filter(([a, b]) => a !== me && b !== me);
        for (const e of Object.keys(db.users)) if (db.users[e].id === me) delete db.users[e];
        keep();
        if (window.__pingServer) await server({ op: 'deleteUser' });
        return { data: { ok: true }, error: null };
      },
    },
    storage: {
      from: bucket => ({
        async upload(path, blob, o) {
          if (!window.__pingServer) {   // the sign-in tests have no shared server: just record the upload
            call('upload', bucket, path, (o && o.contentType) || blob.type, blob.size, !!(o && o.upsert));
            return session && path.startsWith(session.user.id + '/') ? { data: { path }, error: null } : { data: null, error: { message: 'new row violates row-level security policy' } };
          }
          const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(blob); });
          return server({ op: 'storage', act: 'upload', bucket, path, b64, type: (o && o.contentType) || blob.type, size: blob.size, upsert: !!(o && o.upsert) });
        },
        async download(path) {
          const r = await server({ op: 'storage', act: 'download', bucket, path });
          if (r.error) return r;
          const bin = atob(r.data.b64), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return { data: new Blob([bytes], { type: r.data.type }), error: null };
        },
        async remove(paths) { if (!window.__pingServer) { call('remove', bucket, paths); return { data: [], error: null }; } return server({ op: 'storage', act: 'remove', bucket, paths }); },
      }),
    },
    async rpc(name, args) {
      call('rpc', name, args);
      if (name === 'username_available') return { data: !db.taken.includes(args.name), error: null };
      if (name === 'set_username') {
        if (db.taken.includes(args.name)) return { data: null, error: { code: '23505', hint: 'username_taken', message: 'username taken' } };
        db.profiles[session.user.id] = Object.assign({ display_name: null }, db.profiles[session.user.id], { username: args.name }); keep();
        return { data: args.name, error: null };
      }
      if (name === 'accept_terms') { db.priv[session.user.id] = { terms_accepted_at: 'now' }; keep(); return { data: null, error: null }; }
      // Profiles, following get_profile / find_profiles / block_user … in the core migration.
      const me = session && session.user.id;
      if (!me) return { data: null, error: { code: '42501', message: 'permission denied' } };
      const idOf = n => Object.keys(db.profiles).find(k => db.profiles[k].username === String(n).toLowerCase());
      const isFriend = k => (db.friends || []).some(f => f.status === 'accepted' && ((f.a === me && f.b === k) || (f.b === me && f.a === k)));
      const visible = k => k === me || ((db.profiles[k].visibility !== 'private' || isFriend(k)) && !db.blocks.some(([a, b]) => a === k && b === me));
      const pub = k => { const p = db.profiles[k]; return { username: p.username, display_name: p.display_name || null, avatar_path: p.avatar_path || null, avatar_style: p.avatar_style || null, bio: p.bio || null, member_since: '2026-11-01' }; };
      if (name === 'find_profiles') {
        const pre = String(args.prefix).toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(pre)) return { data: [], error: null };
        const ks = Object.keys(db.profiles).filter(k => db.profiles[k].username.startsWith(pre) && visible(k)).sort((a, b) => db.profiles[a].username < db.profiles[b].username ? -1 : 1);
        return { data: ks.slice(0, 20).map(k => { const { username, display_name, avatar_path, avatar_style } = pub(k); return { username, display_name, avatar_path, avatar_style }; }), error: null };
      }
      if (name === 'get_profile') { const k = idOf(args.name); return { data: k && visible(k) ? [pub(k)] : [], error: null }; }
      if (name === 'block_user' || name === 'unblock_user') {
        const k = idOf(args.name);
        if (!k || k === me) return { data: false, error: null };
        db.blocks = db.blocks.filter(([a, b]) => !(a === me && b === k));
        if (name === 'block_user') { db.blocks.push([me, k]); db.friends = (db.friends || []).filter(f => !((f.a === me && f.b === k) || (f.b === me && f.a === k))); }
        keep(); return { data: true, error: null };
      }
      if (name === 'my_blocks') return { data: db.blocks.filter(([a]) => a === me).map(([, b]) => ({ username: db.profiles[b].username, blocked_at: '2026-11-27' })), error: null };
      // Friends, following the friends migration: db.friends = [{ a, b, by, status }] (a < b).
      db.friends ||= [];
      const pair = k => db.friends.find(f => f.a === [me, k].sort()[0] && f.b === [me, k].sort()[1]);
      const fstatus = k => { if (!k) return 'none'; if (k === me) return 'self'; const f = pair(k); return !f ? 'none' : f.status === 'accepted' ? 'friends' : f.by === me ? 'outgoing' : 'incoming'; };
      const err = hint => ({ data: null, error: { code: 'P0001', hint, message: hint } });
      if (name === 'friend_status') return { data: fstatus(idOf(args.name)), error: null };
      if (name === 'friend_request') {
        const k = idOf(args.name);
        if (!k || k === me || !visible(k)) return err('friend_unknown');
        if (db.blocks.some(([a, b]) => a === me && b === k)) return err('friend_blocked');
        const f = pair(k);
        if (f) { if (f.status === 'pending' && f.by !== me) { f.status = 'accepted'; keep(); return { data: 'friends', error: null }; } return { data: fstatus(k), error: null }; }
        if (db.friendLimit) return err('friend_limit');
        const [a, b] = [me, k].sort(); db.friends.push({ a, b, by: me, status: 'pending' }); keep();
        return { data: 'outgoing', error: null };
      }
      if (name === 'friend_respond') {
        const k = idOf(args.name), f = k && pair(k);
        if (f && f.status === 'pending' && f.by === k) {
          if (args.accept) f.status = 'accepted'; else db.friends = db.friends.filter(x => x !== f);
          keep();
        }
        return { data: args.accept ? fstatus(k) : 'none', error: null };
      }
      if (name === 'friend_remove') {
        const k = idOf(args.name), f = k && pair(k);
        const ok = !!f && (f.status === 'accepted' || f.by === me);
        if (ok) { db.friends = db.friends.filter(x => x !== f); keep(); }
        return { data: ok, error: null };
      }
      if (name === 'my_friends') return { data: db.friends.filter(f => f.status === 'accepted' && (f.a === me || f.b === me))
        .map(f => { const k = f.a === me ? f.b : f.a, p = pub(k); return { username: p.username, display_name: p.display_name, avatar_path: p.avatar_path, avatar_style: p.avatar_style, since: '2026-11-28' }; }), error: null };
      // Items from friends, following the inbox_items migration: db.items = [{ id, from, to, kind, payload, at, answered }].
      db.items ||= [];
      if (name === 'send_reminder') {
        const k = idOf(args.name), body = String(args.body ?? '').trim();
        if (!k || k === me || !isFriend(k)) return err('send_not_friend');
        if (body.length < 1 || body.length > 300) return err('send_text_bad');
        if (db.sendLimit) return err('send_limit');
        const id = (db.items.reduce((m, i) => Math.max(m, i.id), 0) || 0) + 1;
        db.items.push({ id, from: me, to: k, kind: 'reminder', payload: { text: body }, at: new Date().toISOString(), answered: false }); keep();
        return { data: id, error: null };
      }
      if (name === 'answer_item') {
        const it = db.items.find(i => i.id === args.item && i.to === me && !i.answered);
        if (it) { it.answered = true; keep(); }
        return { data: !!it, error: null };
      }
      if (name === 'my_inbox') {
        const row = (kind, id, k, payload, at) => { const p = pub(k); return { kind, id, username: p.username, display_name: p.display_name, avatar_path: p.avatar_path, avatar_style: p.avatar_style, payload, created_at: at }; };
        const reqs = db.friends.filter(f => f.status === 'pending' && f.by !== me && (f.a === me || f.b === me))
          .map(f => row('friend_request', null, f.by, null, '2026-11-28T10:00:00Z'));
        const items = db.items.filter(i => i.to === me && !i.answered && isFriend(i.from) && db.profiles[i.from])
          .map(i => row(i.kind, i.id, i.from, i.payload, i.at));
        return { data: [...reqs, ...items].sort((a, b) => a.created_at < b.created_at ? 1 : -1), error: null };
      }
      if (name === 'report_user') {
        if (db.reportLimit) return { data: null, error: { code: 'P0001', hint: 'report_limit', message: 'too many reports' } };
        return { data: !!idOf(args.name), error: null };
      }
      return { data: null, error: { message: 'unknown rpc ' + name } };
    },
  };
  window.PING_ACCOUNTS_FAKE = { createClient: () => { db.created++; keep(); return client; }, providers: { google: true, azure: false }, db };
};

const RLS = { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
export class FakeServer {
  constructor() { this.t = Date.now(); this.users = {}; this.offline = false; this.log = []; this.files = new Map(); this.quota = {}; }
  tick() { this.t = Math.max(this.t + 1, Date.now()); return new Date(this.t).toISOString(); }
  table(uid, name) { const u = (this.users[uid] ||= {}); return (u[name] ||= new Map()); }
  rows(uid, name) { return [...this.table(uid, name).values()]; }
  // Files in a bucket for a user, e.g. paths('u-a', 'boards') -> ['u-a/b1-123.json']
  paths(uid, bucket) { return [...this.files.keys()].filter(k => k.startsWith(`${bucket}/${uid}/`)).map(k => k.slice(bucket.length + 1)).sort(); }
  used(uid) { let n = 0; for (const [k, f] of this.files) if (/^(note-images|boards)\//.test(k) && k.split('/')[1] === uid) n += f.size; return n; }
  handle(json) { const q = JSON.parse(json); this.log.push(q); return JSON.stringify(this.run(q)); }
  storage(q) {
    if (!q.paths && !String(q.path).startsWith(q.uid + '/')) return RLS;
    if (q.act === 'upload') {
      const key = `${q.bucket}/${q.path}`;
      if (this.files.has(key) && !q.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
      if (q.bucket !== 'avatars' && this.used(q.uid) >= (this.quota[q.uid] ?? 26214400)) return RLS;   // the quota policy
      this.files.set(key, { b64: q.b64, type: q.type, size: q.size });
      return { data: { path: q.path }, error: null };
    }
    if (q.act === 'download') {
      const f = this.files.get(`${q.bucket}/${q.path}`);
      return f ? { data: { b64: f.b64, type: f.type }, error: null } : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    }
    if (q.act === 'remove') {
      for (const p of q.paths) if (p.startsWith(q.uid + '/')) this.files.delete(`${q.bucket}/${p}`);
      return { data: [], error: null };
    }
    return { data: null, error: { message: 'unknown storage call' } };
  }
  run(q) {
    if (this.offline) return { data: null, error: { message: 'TypeError: Failed to fetch', status: 0 } };
    if (!q.uid) return { data: null, error: { code: '42501', message: 'permission denied' } };
    if (q.op === 'storage') return this.storage(q);
    if (q.op === 'deleteUser') {                    // the Edge Function: files first, then the user and all their rows
      for (const k of [...this.files.keys()]) if (k.split('/')[1] === q.uid) this.files.delete(k);
      delete this.users[q.uid];
      return { data: { ok: true }, error: null };
    }
    if (q.op === 'usage') return { data: { quota_bytes: this.quota[q.uid] ?? 26214400, used_bytes: this.used(q.uid) }, error: null };
    const future = Date.now() + 86400000;
    if (q.table === 'user_settings') {
      const t = this.table(q.uid, 'settings');
      if (q.op === 'upsert') {
        const r = q.rows[0], old = t.get('s');
        if (r.user_id !== q.uid) return RLS;
        if (r.settings_updated > future || (old && r.settings_updated <= old.settings_updated)) return { data: [], error: null };
        t.set('s', { data: r.data, settings_updated: r.settings_updated, server_at: this.tick() });
        return { data: [{ user_id: q.uid }], error: null };
      }
      return { data: t.get('s') || null, error: null };
    }
    if (q.table === 'reminders' || q.table === 'notes' || q.table === 'boards') {
      const t = this.table(q.uid, q.table);
      if (q.op === 'upsert') {
        const ok = [];
        for (const r of q.rows) {
          if (r.user_id !== q.uid) return RLS;
          if (r.updated > future) continue;
          const old = t.get(r.id);
          if (old && (r.updated < old.updated || (r.updated === old.updated && !(r.deleted && !old.deleted)))) continue;
          t.set(r.id, { id: r.id, data: r.data, updated: r.updated, deleted: !!r.deleted, server_at: this.tick() });
          ok.push({ id: r.id });
        }
        return { data: ok, error: null };
      }
      let rows = [...t.values()];
      if (q.gt) rows = rows.filter(r => r.server_at > q.gt);
      if (q.in) rows = rows.filter(r => q.in.includes(r.id));
      rows.sort((a, b) => (a.server_at < b.server_at ? -1 : 1));
      if (q.limit) rows = rows.slice(0, q.limit);
      return { data: rows, error: null };
    }
    return { data: null, error: { message: 'unknown table ' + q.table } };
  }
}
