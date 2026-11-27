// Creative avatars: the spec rules in index.html's /*AVATAR-START*/ block, which must match the database's
// valid_avatar_style() (tested in db.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './extract.mjs';

const { avatarSpec, avatarDefault, avatarRandom, avatarStep, AV_N } = load('AVATAR', ['avatarSpec', 'avatarDefault', 'avatarRandom', 'avatarStep', 'AV_N']);
const plain = x => JSON.parse(JSON.stringify(x));   // objects made in the block's own realm
const OK = { v: 1, s: 5, c: 11, e: 7, m: 7, a: 7, b: 11 };

test('only a complete spec with whole numbers in range is accepted', () => {
  assert.deepEqual(plain(avatarSpec(OK)), OK);
  assert.deepEqual(plain(avatarSpec({ v: 1, s: 0, c: 0, e: 0, m: 0, a: 0, b: 0 })), { v: 1, s: 0, c: 0, e: 0, m: 0, a: 0, b: 0 });
  for (const bad of [null, undefined, 'x', [1], {}, { ...OK, v: 2 }, { ...OK, s: 6 }, { ...OK, c: 12 }, { ...OK, e: 8 },
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
  assert.equal(avatarStep(OK, 's', 1).s, 0, 'past the last shape: back to the first');
  assert.equal(avatarStep({ ...OK, c: 0 }, 'c', -1).c, AV_N.c - 1, 'before the first colour: the last');
  assert.equal(avatarStep({ ...OK, e: 3 }, 'e', 1).e, 4);
  assert.equal(OK.s, 5, 'the original spec is not changed');
});
