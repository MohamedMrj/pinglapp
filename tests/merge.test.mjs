// Shared notes: the three-way line merge (the MERGE block of index.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './extract.mjs';

const { merge3, lineHunks, mergeHistory } = load('MERGE', ['merge3', 'lineHunks', 'mergeHistory']);
const plain = x => JSON.parse(JSON.stringify(x));
const m = (base, mine, theirs) => plain(merge3(base.join('\n'), mine.join('\n'), theirs.join('\n')));
const lines = r => r.text.split('\n');

test('nothing changed on one side: the other side wins as it is', () => {
  assert.deepEqual(plain(merge3('a', 'a', 'b')), { text: 'b', clash: false });
  assert.deepEqual(plain(merge3('a', 'b', 'a')), { text: 'b', clash: false });
  assert.deepEqual(plain(merge3('a', 'b', 'b')), { text: 'b', clash: false });
  assert.deepEqual(plain(merge3('a\r\nb', 'a\nb', 'a\nb\nc')), { text: 'a\nb\nc', clash: false }, 'Windows line ends count as the same');
});

test('changes to different lines are both kept (a ticked box here, a new line there)', () => {
  const base = ['Inköp', '- [ ] mjölk', '- [ ] bröd', '- [ ] ägg'];
  const r = m(base, ['Inköp', '- [x] mjölk', '- [ ] bröd', '- [ ] ägg'], ['Inköp', '- [ ] mjölk', '- [ ] bröd', '- [x] ägg']);
  assert.deepEqual(lines(r), ['Inköp', '- [x] mjölk', '- [ ] bröd', '- [x] ägg']);
  assert.equal(r.clash, false);
});

test('lines both added at the same place are both kept, theirs first; the same line added twice appears once', () => {
  const base = ['Inköp', '- [ ] mjölk'];
  const r = m(base, [...base, '- [ ] kaffe'], [...base, '- [ ] te']);
  assert.deepEqual(lines(r), ['Inköp', '- [ ] mjölk', '- [ ] te', '- [ ] kaffe']);
  assert.equal(r.clash, false);
  assert.deepEqual(lines(m(base, [...base, '- [ ] te'], [...base, '- [ ] te'])), [...base, '- [ ] te']);
  assert.deepEqual(lines(m(base, [...base, '- [ ] te', '- [ ] kaffe'], [...base, '- [ ] te'])), [...base, '- [ ] te', '- [ ] kaffe']);
});

test('an added line next to a changed line is not a clash', () => {
  const base = ['a', 'b', 'c'];
  const r = m(base, ['a', 'new', 'b', 'c'], ['a', 'B', 'c']);
  assert.deepEqual(lines(r), ['a', 'new', 'B', 'c']);
  assert.equal(r.clash, false);
  const r2 = m(base, ['a', 'b', 'new', 'c'], ['a', 'B', 'c']);
  assert.deepEqual(lines(r2), ['a', 'B', 'new', 'c']);
  assert.equal(r2.clash, false);
});

test('both changed the same line: a clash, and the saved version (theirs) wins there; the rest is still combined', () => {
  const base = ['Möte', 'Tid: 10', 'Plats: rum 1', 'Agenda'];
  const r = m(base, ['Möte', 'Tid: 11', 'Plats: rum 1', 'Agenda', '- budget'], ['Möte', 'Tid: 14', 'Plats: rum 2', 'Agenda']);
  assert.equal(r.clash, true);
  assert.deepEqual(lines(r), ['Möte', 'Tid: 14', 'Plats: rum 2', 'Agenda', '- budget']);
});

test('one side deleted a line the other changed: a clash, theirs wins', () => {
  const r = m(['a', 'b', 'c'], ['a', 'c'], ['a', 'B', 'c']);
  assert.equal(r.clash, true);
  assert.deepEqual(lines(r), ['a', 'B', 'c']);
  const r2 = m(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'c']);
  assert.equal(r2.clash, true);
  assert.deepEqual(lines(r2), ['a', 'c']);
});

test('the same change on both sides is no clash', () => {
  const r = m(['a', 'b', 'c'], ['a', 'X', 'c', 'd'], ['a', 'X', 'c']);
  assert.deepEqual(lines(r), ['a', 'X', 'c', 'd']);
  assert.equal(r.clash, false);
});

test('empty notes and whole-note changes', () => {
  assert.deepEqual(plain(merge3('', 'mine', 'theirs')), { text: 'theirs\nmine', clash: false }, 'both wrote into an empty note: both kept');
  assert.deepEqual(plain(merge3('x', '', 'y')).clash, true);
  assert.deepEqual(plain(merge3(null, undefined, 'a')), { text: 'a', clash: false });
});

test('the hunks describe how to get from one text to the other', () => {
  assert.deepEqual(plain(lineHunks(['a', 'b', 'c'], ['a', 'c'])), [{ s: 1, e: 2, lines: [] }]);
  assert.deepEqual(plain(lineHunks(['a', 'c'], ['a', 'b', 'c'])), [{ s: 1, e: 1, lines: ['b'] }]);
  assert.deepEqual(plain(lineHunks(['a', 'b'], ['x', 'b', 'y'])), [{ s: 0, e: 1, lines: ['x'] }, { s: 2, e: 2, lines: ['y'] }]);
  assert.deepEqual(plain(lineHunks(['a'], ['a'])), []);
});

test('big, very different notes still merge (as one change), quickly', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i), b = Array.from({ length: 3000 }, (_, i) => 'b' + i);
  const t0 = Date.now();
  const theirs = ['X', ...a.slice(1)].join('\n');
  const r = plain(merge3(a.join('\n'), b.join('\n'), theirs));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.clash, true);
  assert.equal(r.text, theirs);
  // One side rewrote everything, the other only added a line at the end: both kept.
  assert.deepEqual(plain(merge3(a.join('\n'), b.join('\n'), a.concat('end').join('\n'))), { text: b.concat('end').join('\n'), clash: false });
});

test('histories from two copies combine: each version once, oldest first, capped', () => {
  const a = [{ t: 1, text: 'one' }, { t: 3, text: 'three' }], b = [{ t: 2, text: 'two' }, { t: 3, text: 'three' }, null, { t: 4 }];
  assert.deepEqual(plain(mergeHistory(a, b)), [{ t: 1, text: 'one' }, { t: 2, text: 'two' }, { t: 3, text: 'three' }]);
  assert.deepEqual(plain(mergeHistory(a, b, 2)).map(h => h.t), [2, 3]);
  assert.deepEqual(plain(mergeHistory(null, undefined)), []);
});
