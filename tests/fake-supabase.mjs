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
    taken: ['alice', 'carol', 'admin'], calls: [], created: 0,
  };
  const keep = () => sessionStorage.setItem('fakedb', JSON.stringify(db));
  let cbs = [], session = null;
  try { session = JSON.parse(localStorage.getItem('pinglapp.auth')); } catch { }
  const setSession = (s, ev) => {
    session = s;
    if (s) localStorage.setItem('pinglapp.auth', JSON.stringify(s)); else localStorage.removeItem('pinglapp.auth');
    cbs.forEach(cb => cb(ev, session));
  };
  const call = (...c) => { db.calls.push(c); keep(); };
  async function run(q) {
    const id = session && session.user.id;
    if (q.table === 'profiles' || q.table === 'account_private') {
      const src = q.table === 'profiles' ? db.profiles : db.priv;
      return { data: (id && src[id]) || null, error: null };
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
      async signInWithPassword({ email, password }) {
        call('signIn', email);
        const u = db.users[email];
        if (!u || u.pw !== password) return { data: {}, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
        setSession({ user: { id: u.id, email } }, 'SIGNED_IN');
        return { data: {}, error: null };
      },
      async signUp(a) { call('signUp', a); return { data: { user: {}, session: null }, error: null }; },
      async resetPasswordForEmail(email, o) { call('reset', email, o); return { data: {}, error: null }; },
      async updateUser(a) { call('updateUser', a); return { data: {}, error: null }; },
      async signOut(o) { call('signOut', o && o.scope); if (!o || o.scope !== 'others') setSession(null, 'SIGNED_OUT'); return { error: null }; },
      async signInWithOAuth(a) { call('oauth', a.provider); return { error: null }; },
    },
    from,
    async rpc(name, args) {
      call('rpc', name, args);
      if (name === 'username_available') return { data: !db.taken.includes(args.name), error: null };
      if (name === 'set_username') {
        if (db.taken.includes(args.name)) return { data: null, error: { code: '23505', hint: 'username_taken', message: 'username taken' } };
        db.profiles[session.user.id] = { username: args.name, display_name: null }; keep();
        return { data: args.name, error: null };
      }
      if (name === 'accept_terms') { db.priv[session.user.id] = { terms_accepted_at: 'now' }; keep(); return { data: null, error: null }; }
      return { data: null, error: { message: 'unknown rpc ' + name } };
    },
  };
  window.PING_ACCOUNTS_FAKE = { createClient: () => { db.created++; keep(); return client; }, providers: { google: true, azure: false }, db };
};

const RLS = { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
export class FakeServer {
  constructor() { this.t = Date.now(); this.users = {}; this.offline = false; this.log = []; }
  tick() { this.t = Math.max(this.t + 1, Date.now()); return new Date(this.t).toISOString(); }
  table(uid, name) { const u = (this.users[uid] ||= {}); return (u[name] ||= new Map()); }
  rows(uid, name) { return [...this.table(uid, name).values()]; }
  handle(json) { const q = JSON.parse(json); this.log.push(q); return JSON.stringify(this.run(q)); }
  run(q) {
    if (this.offline) return { data: null, error: { message: 'TypeError: Failed to fetch', status: 0 } };
    if (!q.uid) return { data: null, error: { code: '42501', message: 'permission denied' } };
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
    if (q.table === 'reminders' || q.table === 'notes') {
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
