import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, createStalenessGuard } from '../../public/js/core.js';

test('escapeHtml escapes HTML metacharacters', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<a href="x">&amp;</a>'), '&lt;a href="x"&gt;&amp;amp;&lt;/a&gt;');
});

test('escapeHtml null/undefined coerce to empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml non-string input is stringified first', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml({ toString: () => '<x>' }), '&lt;x&gt;');
});

test('escapeHtml does not double-escape', () => {
  // Characters beyond &, <, > pass through — including single quotes and
  // double quotes. This is safe for textContent-equivalent HTML contexts,
  // which is what every call site uses.
  assert.equal(escapeHtml('it\'s "ok"'), 'it\'s "ok"');
});

test('createStalenessGuard: claim advances, isCurrent tracks latest', () => {
  const g = createStalenessGuard();
  const t1 = g.claim();
  assert.equal(g.isCurrent(t1), true);
  const t2 = g.claim();
  assert.equal(g.isCurrent(t1), false);
  assert.equal(g.isCurrent(t2), true);
});

test('createStalenessGuard: independent guards do not share state', () => {
  const a = createStalenessGuard();
  const b = createStalenessGuard();
  const at = a.claim();
  b.claim();
  b.claim();
  // a's token stays current regardless of b's claims.
  assert.equal(a.isCurrent(at), true);
});

test('createStalenessGuard: first claim returns 1 (non-zero sentinel)', () => {
  // Tokens must be truthy so callers storing them in optional variables can
  // distinguish "claimed" from "never claimed" without a separate flag.
  const g = createStalenessGuard();
  assert.equal(g.claim(), 1);
});
