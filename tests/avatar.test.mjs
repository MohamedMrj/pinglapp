// Creative avatars: the spec rules in index.html's /*AVATAR-START*/ block, which must match the database's
// valid_avatar_style() (tested in db.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './extract.mjs';

const DEC = new Date(2026, 11, 13), JULY = new Date(2027, 6, 1);

const { avatarSpec, avatarDefault, avatarRandom, avatarStep, avatarSeason, avatarChoices, AV_N } = load('AVATAR', ['avatarSpec', 'avatarDefault', 'avatarRandom', 'avatarStep', 'avatarSeason', 'avatarChoices', 'AV_N']);
const plain = x => JSON.parse(JSON.stringify(x));   // objects made in the block's own realm
const OK = { v: 1, s: 5, c: 11, e: 7, m: 7, a: 11, b: 11 };

test('only a complete spec with whole numbers in range is accepted', () => {
  assert.deepEqual(plain(avatarSpec(OK)), OK);
  assert.deepEqual(plain(avatarSpec({ v: 1, s: 0, c: 0, e: 0, m: 0, a: 0, b: 0 })), { v: 1, s: 0, c: 0, e: 0, m: 0, a: 0, b: 0 });
  for (const bad of [null, undefined, 'x', [1], {}, { ...OK, v: 2 }, { ...OK, s: 6 }, { ...OK, c: 12 }, { ...OK, e: 8 }, { ...OK, a: 12 },
    { ...OK, m: -1 }, { ...OK, a: 1.5 }, { ...OK, b: '3' }, { ...OK, extra: 1 }, { v: 1, s: 1 }]) {
    assert.equal(avatarSpec(bad), null, JSON.stringify(bad));
  }
});

test('the default is valid, stable for a username, and varies between usernames', () => {
  for (const name of ['alice', 'bob', 'åsa_99', '', undefined, '😀']) {
    const a = plain(avatarDefault(name));
    assert.deepEqual(plain(avatarSpec(a)), a, String(name));
    assert.deepEqual(plain(avatarDefault(name)), a, 'same every time');
  }
  const seen = new Set(Array.from({ length: 200 }, (_, i) => JSON.stringify(plain(avatarDefault('user' + i)))));
  assert.ok(seen.size > 180, `200 usernames give ${seen.size} different avatars`);
  const withAcc = Array.from({ length: 300 }, (_, i) => avatarDefault('u' + i)).filter(s => s.a > 0).length;
  assert.ok(withAcc > 30 && withAcc < 150, `about a third wear an accessory (${withAcc}/300)`);
});

test('shuffling always gives a valid spec; stepping wraps around both ways', () => {
  for (let i = 0; i < 500; i++) assert.ok(avatarSpec(avatarRandom()));
  assert.ok(avatarSpec(avatarRandom(() => 0.9999999)));
  assert.ok(avatarSpec(avatarRandom(() => 0.9999999, JULY)));
  assert.equal(avatarStep(OK, 's', 1).s, 0, 'past the last shape: back to the first');
  assert.equal(avatarStep({ ...OK, c: 0 }, 'c', -1).c, AV_N.c - 1, 'before the first colour: the last');
  assert.equal(avatarStep({ ...OK, e: 3 }, 'e', 1).e, 4);
  assert.equal(avatarStep({ ...OK, a: 11 }, 'a', 1, DEC).a, 0, 'in December, the last accessory is the scarf');
  assert.equal(OK.s, 5, 'the original spec is not changed');
});

// The old rule (S1), copied here: defaults must never change when parts are added, or people's avatars would change.
function s1Default(seed) {
  const N = { s: 6, c: 12, e: 8, m: 8, a: 8, b: 12 };
  let h = 2166136261;
  for (const ch of String(seed || '?')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const o = { v: 1 };
  for (const k of ['s', 'c', 'e', 'm', 'a', 'b']) { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; o[k] = h % N[k]; }
  if (h % 3) o.a = 0;
  return o;
}

test('December pack (E1): defaults are unchanged, the new items are offered in season only, saved ones always show', () => {
  for (let i = 0; i < 500; i++) assert.deepEqual(plain(avatarDefault('user' + i)), s1Default('user' + i));
  assert.deepEqual(plain(avatarDefault('')), s1Default(''));
  // The season: 20 November to the end of January.
  for (const [d, on] of [[new Date(2026, 10, 19), false], [new Date(2026, 10, 20), true], [DEC, true], [new Date(2027, 0, 31), true],
    [new Date(2027, 1, 1), false], [JULY, false]]) assert.equal(avatarSeason(d), on, d.toDateString());
  assert.deepEqual(plain(avatarChoices('a', DEC)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(plain(avatarChoices('a', JULY)), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(plain(avatarChoices('a', JULY, 9)), [0, 1, 2, 3, 4, 5, 6, 7, 9], 'the chosen one stays in the list');
  assert.equal(plain(avatarChoices('s', JULY)).length, 6, 'other parts are not seasonal');
  // Stepping: in December 7 → 8 (Santa hat); in July 7 → 0 and back 0 → 7.
  assert.equal(avatarStep({ ...OK, a: 7 }, 'a', 1, DEC).a, 8);
  assert.equal(avatarStep({ ...OK, a: 7 }, 'a', 1, JULY).a, 0);
  assert.equal(avatarStep({ ...OK, a: 0 }, 'a', -1, JULY).a, 7);
  // In July, someone wearing the Lucia crown keeps it (it is valid and drawn) and can step off it, but not back.
  assert.ok(avatarSpec({ ...OK, a: 9 }));
  assert.equal(avatarStep({ ...OK, a: 9 }, 'a', 1, JULY).a, 0);
  assert.equal(avatarStep({ ...OK, a: 9 }, 'a', -1, JULY).a, 7);
  // Shuffling: seasonal items only in season.
  const july = new Set(Array.from({ length: 400 }, (_, i) => avatarRandom(() => (i + 0.5) / 400, JULY).a));
  assert.ok([...july].every(a => a < 8), 'not in July');
  const dec = new Set(Array.from({ length: 400 }, (_, i) => avatarRandom(() => (i + 0.5) / 400, DEC).a));
  assert.ok([8, 9, 10, 11].every(a => dec.has(a)), 'all four in December');
});
