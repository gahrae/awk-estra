import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShortcut,
  matchesShortcut,
  isUsableCombo,
  formatShortcut,
  resolveMod,
} from '../../public/js/shortcuts.js';

// Build a KeyboardEvent-shaped object. normalizeShortcut only reads
// `key` + the four modifier flags, so we don't need a real event.
function ev({ key, ctrl = false, meta = false, alt = false, shift = false }) {
  return { key, ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift };
}

test('normalizeShortcut: lone modifier press returns null', () => {
  assert.equal(normalizeShortcut(ev({ key: 'Control' })), null);
  assert.equal(normalizeShortcut(ev({ key: 'Shift' })), null);
  assert.equal(normalizeShortcut(ev({ key: 'Meta' })), null);
  assert.equal(normalizeShortcut(ev({ key: 'Alt' })), null);
});

test('normalizeShortcut: canonical modifier order is Ctrl, Meta, Alt, Shift', () => {
  // Regardless of how the event reports them, the output string puts
  // modifiers in this order so two recordings of the same chord compare
  // byte-equal.
  const combo = normalizeShortcut(ev({ key: 'k', ctrl: true, meta: true, alt: true, shift: true }));
  assert.equal(combo, 'Ctrl+Meta+Alt+Shift+K');
});

test('normalizeShortcut: uppercases single-char keys', () => {
  assert.equal(normalizeShortcut(ev({ key: 'k', ctrl: true })), 'Ctrl+K');
  assert.equal(normalizeShortcut(ev({ key: 'K', ctrl: true })), 'Ctrl+K');
});

test('normalizeShortcut: named keys pass through unchanged', () => {
  assert.equal(normalizeShortcut(ev({ key: 'Enter', ctrl: true })), 'Ctrl+Enter');
  assert.equal(normalizeShortcut(ev({ key: 'F1' })), 'F1');
  assert.equal(normalizeShortcut(ev({ key: 'Escape' })), 'Escape');
});

test('normalizeShortcut: space / plus / minus get readable names', () => {
  assert.equal(normalizeShortcut(ev({ key: ' ', ctrl: true })), 'Ctrl+Space');
  assert.equal(normalizeShortcut(ev({ key: '+', ctrl: true })), 'Ctrl+Plus');
  assert.equal(normalizeShortcut(ev({ key: '-', ctrl: true })), 'Ctrl+Minus');
});

test('matchesShortcut: empty combo never matches', () => {
  assert.equal(matchesShortcut(ev({ key: 'k', ctrl: true }), ''), false);
  assert.equal(matchesShortcut(ev({ key: 'k', ctrl: true }), null), false);
});

test('matchesShortcut: exact match wins, near-misses lose', () => {
  assert.equal(matchesShortcut(ev({ key: 'k', ctrl: true }), 'Ctrl+K'), true);
  assert.equal(matchesShortcut(ev({ key: 'k' }), 'Ctrl+K'), false);
  assert.equal(matchesShortcut(ev({ key: 'k', ctrl: true, shift: true }), 'Ctrl+K'), false);
});

test('isUsableCombo: function keys (F1-F24) are always usable', () => {
  assert.equal(isUsableCombo('F1'), true);
  assert.equal(isUsableCombo('F12'), true);
  assert.equal(isUsableCombo('F24'), true);
  assert.equal(isUsableCombo('Shift+F3'), true);
  assert.equal(isUsableCombo('Ctrl+F3'), true);
});

test('isUsableCombo: function keys above F24 are rejected', () => {
  assert.equal(isUsableCombo('F25'), false);
  assert.equal(isUsableCombo('F0'), false);
});

test('isUsableCombo: bare non-function keys are rejected (would fire on typing)', () => {
  assert.equal(isUsableCombo('K'), false);
  assert.equal(isUsableCombo('Enter'), false);
  assert.equal(isUsableCombo('Space'), false);
});

test('isUsableCombo: Shift-only + single-char rejected (just types a capital)', () => {
  assert.equal(isUsableCombo('Shift+A'), false);
  assert.equal(isUsableCombo('Shift+K'), false);
});

test('isUsableCombo: Shift-only + named key accepted', () => {
  assert.equal(isUsableCombo('Shift+Enter'), true);
  assert.equal(isUsableCombo('Shift+Tab'), true);
  assert.equal(isUsableCombo('Shift+Escape'), true);
});

test('isUsableCombo: any combo with Ctrl/Meta/Alt is accepted', () => {
  assert.equal(isUsableCombo('Ctrl+K'), true);
  assert.equal(isUsableCombo('Meta+K'), true);
  assert.equal(isUsableCombo('Alt+K'), true);
  assert.equal(isUsableCombo('Ctrl+Shift+K'), true);
});

test('isUsableCombo: unknown modifier rejected', () => {
  assert.equal(isUsableCombo('Foo+K'), false);
});

test('isUsableCombo: empty combo rejected', () => {
  assert.equal(isUsableCombo(''), false);
  assert.equal(isUsableCombo(null), false);
});

test('resolveMod: Mod+ prefix becomes Ctrl+ or Meta+ depending on platform', () => {
  // Setup stubs navigator.platform to 'Linux', so IS_MAC is false →
  // Mod+ resolves to Ctrl+.
  assert.equal(resolveMod('Mod+K'), 'Ctrl+K');
  assert.equal(resolveMod('Mod+Shift+P'), 'Ctrl+Shift+P');
  // No Mod+ prefix — passes through unchanged.
  assert.equal(resolveMod('Alt+K'), 'Alt+K');
});

test('formatShortcut: non-mac returns combo unchanged', () => {
  // IS_MAC is false under the Linux stub in test/setup.js.
  assert.equal(formatShortcut('Ctrl+K'), 'Ctrl+K');
  assert.equal(formatShortcut('Ctrl+Shift+P'), 'Ctrl+Shift+P');
  assert.equal(formatShortcut(''), '');
});
