import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileKeyedList } from '../../public/js/core.js';
import { makeNode } from '../dom-stub.js';

// Helpers — make an `ul` with pre-seeded `<li data-id=…>` children, and a
// pair of create/update callbacks that stamp a `created` count onto each
// new node so we can assert "this node was reused, not re-created".
function makeUlWith(ids) {
  const ul = makeNode();
  for (const id of ids) {
    const li = makeNode();
    li.dataset.id = id;
    li.updated = 0;
    ul.insertBefore(li, null);
  }
  return ul;
}

function createFn() {
  const li = makeNode();
  li.created = true;
  li.updated = 0;
  return li;
}

function updateFn(li, item) {
  li.updated++;
  li.lastItem = item;
}

function ids(ul) {
  return ul.children.map((c) => c.dataset.id);
}

test('reconcileKeyedList: identical list leaves all nodes in place', () => {
  const ul = makeUlWith(['a', 'b', 'c']);
  const originals = [...ul.children];
  reconcileKeyedList(ul, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], createFn, updateFn);
  assert.deepEqual(ids(ul), ['a', 'b', 'c']);
  // Same object identity — no node was recreated.
  assert.strictEqual(ul.children[0], originals[0]);
  assert.strictEqual(ul.children[1], originals[1]);
  assert.strictEqual(ul.children[2], originals[2]);
  // update callback fires once per item.
  for (const li of ul.children) assert.equal(li.updated, 1);
});

test('reconcileKeyedList: new item at end is appended without disturbing others', () => {
  const ul = makeUlWith(['a', 'b']);
  const originalA = ul.children[0];
  const originalB = ul.children[1];
  reconcileKeyedList(ul, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], createFn, updateFn);
  assert.deepEqual(ids(ul), ['a', 'b', 'c']);
  assert.strictEqual(ul.children[0], originalA);
  assert.strictEqual(ul.children[1], originalB);
  assert.equal(ul.children[2].created, true);
  assert.equal(ul.children[2].dataset.id, 'c');
});

test('reconcileKeyedList: missing ids are removed and old nodes detached', () => {
  const ul = makeUlWith(['a', 'b', 'c']);
  const removed = ul.children[1];
  reconcileKeyedList(ul, [{ id: 'a' }, { id: 'c' }], createFn, updateFn);
  assert.deepEqual(ids(ul), ['a', 'c']);
  assert.equal(removed.parentNode, null, 'removed node is detached from parent');
});

test('reconcileKeyedList: reorder reuses nodes (focus / hover survive)', () => {
  const ul = makeUlWith(['a', 'b', 'c']);
  const [a, b, c] = ul.children;
  reconcileKeyedList(ul, [{ id: 'c' }, { id: 'a' }, { id: 'b' }], createFn, updateFn);
  assert.deepEqual(ids(ul), ['c', 'a', 'b']);
  // Same node instances — that's the whole point of the keyed reconciler.
  assert.strictEqual(ul.children[0], c);
  assert.strictEqual(ul.children[1], a);
  assert.strictEqual(ul.children[2], b);
});

test('reconcileKeyedList: empty → populated adds everything from scratch', () => {
  const ul = makeNode();
  reconcileKeyedList(ul, [{ id: 'a' }, { id: 'b' }], createFn, updateFn);
  assert.deepEqual(ids(ul), ['a', 'b']);
  assert.equal(ul.children[0].created, true);
  assert.equal(ul.children[1].created, true);
});

test('reconcileKeyedList: populated → empty clears everything', () => {
  const ul = makeUlWith(['a', 'b', 'c']);
  reconcileKeyedList(ul, [], createFn, updateFn);
  assert.deepEqual(ids(ul), []);
});

test('reconcileKeyedList: children without data-id are evicted', () => {
  const ul = makeNode();
  const stray = makeNode();
  ul.insertBefore(stray, null);
  reconcileKeyedList(ul, [{ id: 'a' }], createFn, updateFn);
  // The stray (no data-id) is removed; the `a` item is appended fresh.
  assert.deepEqual(ids(ul), ['a']);
  assert.equal(stray.parentNode, null);
});

test('reconcileKeyedList: update callback sees the latest item payload', () => {
  const ul = makeUlWith(['a']);
  reconcileKeyedList(ul, [{ id: 'a', name: 'first' }], createFn, updateFn);
  assert.equal(ul.children[0].lastItem.name, 'first');
  reconcileKeyedList(ul, [{ id: 'a', name: 'second' }], createFn, updateFn);
  assert.equal(ul.children[0].lastItem.name, 'second');
  // Same node; update fired again.
  assert.equal(ul.children[0].updated, 2);
});

test('reconcileKeyedList: swapped-and-extended list', () => {
  const ul = makeUlWith(['a', 'b', 'c']);
  const [a, b, c] = ul.children;
  reconcileKeyedList(
    ul,
    [{ id: 'b' }, { id: 'a' }, { id: 'd' }, { id: 'c' }],
    createFn,
    updateFn,
  );
  assert.deepEqual(ids(ul), ['b', 'a', 'd', 'c']);
  assert.strictEqual(ul.children[0], b);
  assert.strictEqual(ul.children[1], a);
  assert.equal(ul.children[2].created, true, '"d" is a fresh node');
  assert.strictEqual(ul.children[3], c);
});
