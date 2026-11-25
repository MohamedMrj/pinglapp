// Sync with a Ping account: the CLOUD block of index.html (with the SYNC block it builds on).
// A small in-memory server below follows the same rules as the database triggers in supabase/migrations
// (newest wins, a deletion wins a tie, stamps far in the future refused, server_at moves forward), so whole
// round trips between devices can be tested without a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './extract.mjs';

const { cloudState, cloudPushSet, cloudPushed, cloudApply, cloudSince, cloudPrune, cloudFirstStep, canonJson,
  makeBase, stampChanges, syncKey, CLOUD_OVERLAP_MS, CLOUD_MAX_CHARS } =
  load(['SYNC', 'CLOUD'], ['cloudState', 'cloudPushSet', 'cloudPushed', 'cloudApply', 'cloudSince', 'cloudPrune',
    'cloudFirstStep', 'canonJson', 'makeBase', 'stampChanges', 'syncKey', 'CLOUD_OVERLAP_MS', 'CLOUD_MAX_CHARS']);

const plain = x => JSON.parse(JSON.stringify(x));
const data = (o = {}) => Object.assign({ reminders: [], notes: [], deleted: {}, settings: { lang: 'sv', theme: 'system' }, settingsUpdated: 0 }, o);
const rem = (id, updated, extra = {}) => Object.assign({ id, title: id, updated, tags: [], priority: 0 }, extra);
const note = (id, updated, text = id) => ({ id, text, updated, pinned: false });
const ids = a => Array.from(a, x => x.id).sort();

// jsonb doesn't keep key order: give rows back with keys in another order, as the real server would.
const shuffleKeys = o => o && typeof o === 'object' && !Array.isArray(o)
  ? Object.keys(o).reverse().reduce((r, k) => { r[k] = shuffleKeys(o[k]); return r; }, {}) : o;

class FakeServer {
  constructor() { this.t = Date.UTC(2026, 10, 25, 12); this.tables = { reminders: new Map(), notes: new Map() }; this.settings = null; }
  tick() { return new Date(this.t += 1000).toISOString(); }
  write(kind, row, nowMs) {
    if (row.updated > nowMs + 86400000) return false;
    const old = this.tables[kind].get(row.id);
    if (old && (row.updated < old.updated || (row.updated === old.updated && !(row.deleted && !old.deleted)))) return false;
    this.tables[kind].set(row.id, { ...plain(row), data: shuffleKeys(plain(row.data)), server_at: this.tick() });
    return true;
  }
  push(set, nowMs) {
    const accepted = { reminders: [], notes: [] };
    for (const kind of ['reminders', 'notes']) for (const r of set[kind]) if (this.write(kind, r, nowMs)) accepted[kind].push(r.id);
    if (set.settings && (!this.settings || set.settings.settings_updated > this.settings.settings_updated))
      this.settings = { ...plain(set.settings), server_at: this.tick() };
    return accepted;
  }
  pull(cs) {
    const out = {};
    for (const kind of ['reminders', 'notes']) {
      const since = cloudSince(cs, kind);
      out[kind] = [...this.tables[kind].values()].filter(r => !since || r.server_at > since).map(plain);
    }
    const ss = cloudSince(cs, 'settings');
    out.settings = this.settings && (!ss || this.settings.server_at > ss) ? plain(this.settings) : null;
    return out;
  }
  fetch(refetch) {
    const out = { reminders: [], notes: [] };
    for (const kind of ['reminders', 'notes']) for (const id of refetch[kind]) { const r = this.tables[kind].get(id); if (r) out[kind].push(plain(r)); }
    return out;
  }
}

// One device: its data, baseline and sync state, doing what the app will do (stamp on save, pull, push, refetch).
class Device {
  constructor(server, d = data()) { this.server = server; this.S = plain(d); this.base = makeBase(this.S); this.cs = cloudState({}); this.now = Date.UTC(2026, 10, 25, 12); }
  save() { stampChanges(this.S, this.base, this.now += 10); }
  sync() {
    this.save();
    this.S = cloudApply(this.S, this.server.pull(this.cs), this.cs, this.now); this.base = makeBase(this.S);
    const set = cloudPushSet(this.S, this.cs);
    const refetch = cloudPushed(this.cs, set, this.server.push(set, this.now));
    if (refetch.reminders.length || refetch.notes.length) { this.S = cloudApply(this.S, this.server.fetch(refetch), this.cs, this.now); this.base = makeBase(this.S); }
    cloudPrune(this.S, this.cs);
    return set;
  }
}

test('cloudState repairs missing or damaged state', () => {
  const cs = cloudState({ owner: 5, cursor: 'x', known: { notes: [1] } });
  assert.equal(cs.owner, null);
  assert.deepEqual(plain(cs.cursor), { reminders: 0, notes: 0, settings: 0 });
  assert.deepEqual(plain(cs.known), { reminders: {}, notes: {} });
  assert.deepEqual(plain(cloudState(null)), plain(cloudState({})));
});

test('canonJson ignores key order at every level, but not array order', () => {
  assert.equal(canonJson({ a: 1, b: { c: 2, d: [1, { e: 1, f: 2 }] } }), canonJson({ b: { d: [1, { f: 2, e: 1 }], c: 2 }, a: 1 }));
  assert.notEqual(canonJson({ a: [1, 2] }), canonJson({ a: [2, 1] }));
});

test('push set: only items and tombstones the server does not have yet', () => {
  const cs = cloudState({ known: { reminders: { a: 5, gone: 3 }, notes: { n: 7 } } });
  const d = data({ reminders: [rem('a', 5), rem('b', 6)], notes: [note('n', 9)], deleted: { gone: 8, newdel: 4 }, settingsUpdated: 11 });
  const s = cloudPushSet(d, cs);
  assert.deepEqual(plain(s.reminders.map(r => [r.id, r.deleted])), [['b', false], ['gone', true], ['newdel', true]]);
  assert.deepEqual(plain(s.notes.map(r => [r.id, r.updated, r.deleted])), [['n', 9, false], ['newdel', 4, true]]);   // unknown kind: both tables
  assert.equal(s.settings.settings_updated, 11);
  assert.deepEqual(plain(s.settings.data), { lang: 'sv', theme: 'system' });   // shared settings (unset ones drop out of JSON)
  // the unknown tombstone goes to reminders too
  assert.ok(s.reminders.some(r => r.id === 'newdel' && r.deleted));
  // nothing new after the server took it all
  cloudPushed(cs, s, { reminders: s.reminders.map(r => r.id), notes: s.notes.map(r => r.id) });
  const again = cloudPushSet(d, cs);
  assert.equal(again.reminders.length + again.notes.length, 0);
  assert.equal(again.settings, null);
});

test('push set: device-only settings are never sent', () => {
  const s = cloudPushSet(data({ settings: { lang: 'en', onboarded: true, lastBackup: 5 }, settingsUpdated: 3 }), cloudState({}));
  assert.equal(s.settings.data.lang, 'en');
  assert.ok(!('onboarded' in s.settings.data) && !('lastBackup' in s.settings.data));
});

test('push set: an item too big for the server is held back and reported, the rest still goes', () => {
  const big = note('big', 5, 'x'.repeat(CLOUD_MAX_CHARS + 1));
  const s = cloudPushSet(data({ notes: [big, note('small', 5)] }), cloudState({}));
  assert.deepEqual(plain(s.notes.map(r => r.id)), ['small']);
  assert.deepEqual(plain(s.tooBig), ['big']);
});

test('items the server refused are fetched back; it already had a newer copy', () => {
  const cs = cloudState({});
  const set = cloudPushSet(data({ notes: [note('a', 5), note('b', 5)] }), cs);
  const refetch = cloudPushed(cs, set, { notes: ['a'] });
  assert.deepEqual(plain(refetch), { reminders: [], notes: ['b'] });
  assert.equal(cs.known.notes.b, 5);   // not retried until it changes again
});

test('apply: server rows merge with newest-wins; jsonb key order is not a change', () => {
  const cs = cloudState({});
  const d = data({ notes: [note('n', 10, 'local'), note('same', 4)] });
  const pulled = { notes: [
    { id: 'n', data: note('n', 20, 'server'), updated: 20, deleted: false, server_at: '2026-11-25T12:00:01.123456+00:00' },
    { id: 'same', data: shuffleKeys(note('same', 4)), updated: 4, deleted: false, server_at: '2026-11-25T12:00:02+00:00' },
  ] };
  const m = cloudApply(d, pulled, cs, Date.UTC(2026, 10, 25, 12));
  assert.equal(m.notes.find(n => n.id === 'n').text, 'server');
  assert.equal(cs.cursor.notes, Date.parse('2026-11-25T12:00:02Z'));
  assert.deepEqual(plain(cs.known.notes), { n: 20, same: 4 });
  // the unchanged note must not look edited to stampChanges (or it would be re-stamped and pushed forever)
  const base = makeBase(d); const after = plain(m); stampChanges(after, base, 999);
  assert.equal(after.notes.find(n => n.id === 'same').updated, 4);
});

test('apply: a tie with different content takes the server copy', () => {
  const cs = cloudState({});
  const m = cloudApply(data({ notes: [note('n', 50, 'zzz local wins a plain tie-break')] }),
    { notes: [{ id: 'n', data: note('n', 50, 'aaa server'), updated: 50, deleted: false, server_at: '2026-11-25T12:00:00Z' }] }, cs, Date.UTC(2026, 10, 25));
  assert.equal(m.notes[0].text, 'aaa server');
});

test('apply: server tombstones delete local items unless edited later; bad rows are ignored', () => {
  const cs = cloudState({}), T = Date.UTC(2026, 10, 25);
  const d = data({ reminders: [rem('a', T + 10), rem('b', T + 30)] });
  const m = cloudApply(d, { reminders: [
    { id: 'a', data: {}, updated: T + 20, deleted: true, server_at: '2026-11-25T12:00:00Z' },
    { id: 'b', data: {}, updated: T + 20, deleted: true, server_at: '2026-11-25T12:00:00Z' },
    null, { id: 7, updated: 1 }, { id: 'c', data: 'nope', updated: 1, deleted: false, server_at: 'x' },
  ] }, cs, T + 1000);
  assert.deepEqual(ids(m.reminders), ['b']);
  assert.equal(m.deleted.a, T + 20);
  assert.equal(cs.known.reminders.a, -(T + 20));
});

test('apply: settings from the server; a tie takes the server copy; device-only settings stay', () => {
  const cs = cloudState({});
  const d = data({ settings: { lang: 'sv', theme: 'dark', onboarded: true }, settingsUpdated: 5 });
  const newer = cloudApply(d, { settings: { data: { lang: 'en', theme: 'light' }, settings_updated: 9, server_at: '2026-11-25T12:00:00Z' } }, cs, 1);
  assert.equal(newer.settings.lang, 'en'); assert.equal(newer.settings.onboarded, true); assert.equal(cs.settingsKnown, 9);
  const tie = cloudApply(d, { settings: { data: { lang: 'en', theme: 'dark' }, settings_updated: 5, server_at: '2026-11-25T12:00:00Z' } }, cloudState({}), 1);
  assert.equal(tie.settings.lang, 'en');
  const older = cloudApply(d, { settings: { data: { lang: 'en' }, settings_updated: 2, server_at: '2026-11-25T12:00:00Z' } }, cloudState({}), 1);
  assert.equal(older.settings.lang, 'sv');
});

test('cloudSince pulls again with an overlap, or everything the first time', () => {
  const cs = cloudState({});
  assert.equal(cloudSince(cs, 'notes'), null);
  cs.cursor.notes = Date.UTC(2026, 10, 25, 12);
  assert.equal(Date.parse(cloudSince(cs, 'notes')), Date.UTC(2026, 10, 25, 12) - CLOUD_OVERLAP_MS);
});

test('cloudPrune forgets items that are gone everywhere', () => {
  const cs = cloudState({ known: { reminders: { a: 1, old: -2 }, notes: { n: 3, del: -4 } } });
  cloudPrune(data({ reminders: [rem('a', 1)], deleted: { del: 4 } }), cs);
  assert.deepEqual(plain(cs.known), { reminders: { a: 1 }, notes: { del: -4 } });
});

test('first sign-in: same account, empty device, a guest\'s data, another account\'s data', () => {
  const d = data({ notes: [note('n', 1)] });
  assert.equal(cloudFirstStep(cloudState({ owner: 'u1' }), 'u1', d), 'same');
  assert.equal(cloudFirstStep(cloudState({}), 'u1', data()), 'empty');
  assert.equal(cloudFirstStep(cloudState({ owner: 'u2' }), 'u1', data()), 'empty');
  assert.equal(cloudFirstStep(cloudState({}), 'u1', d), 'ask');
  assert.equal(cloudFirstStep(cloudState({ owner: 'u2' }), 'u1', d), 'other');
});

test('two devices converge, including edits made on both while offline', () => {
  const server = new FakeServer();
  const A = new Device(server, data({ reminders: [rem('r1', 1)], notes: [note('n1', 1, 'v1')] }));
  const B = new Device(server);
  A.sync(); B.sync();
  assert.equal(syncKey(A.S), syncKey(B.S));
  // offline on both: A edits the reminder and deletes the note, B adds a note and changes the language
  A.S.reminders[0].title = 'A edit'; A.S.notes = [];
  B.S.notes.push(note('n2', undefined, 'from B')); B.S.settings.lang = 'en';
  A.sync(); B.sync(); A.sync();
  assert.equal(syncKey(A.S), syncKey(B.S));
  assert.equal(A.S.reminders[0].title, 'A edit');
  assert.deepEqual(ids(A.S.notes), ['n2']);
  assert.equal(A.S.settings.lang, 'en');
  // once in step, a sync sends nothing (no endless re-pushing)
  const quiet = A.sync();
  assert.equal(quiet.reminders.length + quiet.notes.length, 0);
  assert.equal(quiet.settings, null);
});

test('the same item edited on both devices: the newer edit wins everywhere', () => {
  const server = new FakeServer();
  const A = new Device(server, data({ notes: [note('n', 1, 'start')] })), B = new Device(server);
  A.sync(); B.sync();
  A.S.notes[0].text = 'A'; A.save();
  B.now = A.now + 100; B.S.notes[0].text = 'B (later)'; B.save();
  A.sync(); B.sync(); A.sync();
  assert.equal(A.S.notes[0].text, 'B (later)');
  assert.equal(syncKey(A.S), syncKey(B.S));
});

test('an older copy pushed late does not overwrite the newer one on the server', () => {
  const server = new FakeServer();
  const A = new Device(server, data({ notes: [note('n', 1, 'start')] })), B = new Device(server);
  A.sync(); B.sync();
  B.now = A.now + 500; B.S.notes[0].text = 'newer'; B.sync();
  // A edited earlier but pushes without having pulled (e.g. it raced): the server refuses, A fetches the newer copy
  A.S.notes[0].text = 'older'; A.save();
  const set = cloudPushSet(A.S, A.cs);
  const refetch = cloudPushed(A.cs, set, server.push(set, A.now));
  assert.deepEqual(plain(refetch.notes), ['n']);
  A.S = cloudApply(A.S, server.fetch(refetch), A.cs, A.now);
  assert.equal(A.S.notes[0].text, 'newer');
  assert.equal(server.tables.notes.get('n').data.text, 'newer');
});

test('a device whose clock is days ahead cannot win: its rows are refused and it does not retry forever', () => {
  const server = new FakeServer();
  const A = new Device(server, data({ notes: [note('n', 1, 'start')] }));
  A.sync();
  A.now += 5 * 86400000; A.S.notes[0].text = 'from the future'; A.save();
  const set = cloudPushSet(A.S, A.cs);
  const accepted = server.push(set, Date.UTC(2026, 10, 25, 12));   // the server's own clock
  assert.deepEqual(plain(accepted.notes), []);
  cloudPushed(A.cs, set, accepted);
  assert.equal(cloudPushSet(A.S, A.cs).notes.length, 0);
  assert.equal(server.tables.notes.get('n').data.text, 'start');
});

test('a guest\'s data added to a new account reaches the second device', () => {
  const server = new FakeServer();
  const guest = new Device(server, data({ reminders: [rem('r', 3)], notes: [note('n', 4)], deleted: { x: Date.UTC(2026, 10, 24) } }));
  assert.equal(cloudFirstStep(guest.cs, 'u1', guest.S), 'ask');
  guest.cs.owner = 'u1';
  guest.sync();
  const phone = new Device(server); phone.cs.owner = 'u1';
  phone.sync();
  assert.deepEqual(ids(phone.S.reminders), ['r']);
  assert.deepEqual(ids(phone.S.notes), ['n']);
  assert.equal(syncKey(phone.S), syncKey(guest.S));
});
