// @ts-check
// Unit tests for public/js/inputMode.js — the resolveInput helper that
// drives every preview surface (snippet, chain, inline-step, palette,
// pipeline) + every apply path (snippet run, chain run, palette apply).
// Selection-wins precedence, All-Tabs gathering with `excluded` filter,
// and the fallback-to-single-empty case are load-bearing — a regression
// here shows up as "preview shows wrong input" across the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getInputMode,
  setInputMode,
  toggleInputMode,
  getEffectiveInputMode,
  resolveInput,
} from '../../public/js/inputMode.js';
import { state } from '../../public/js/state.js';

/**
 * Build a minimal fake textarea that resolveInput / getEffectiveInputMode
 * can read selection data from. When `s === e`, the textarea has no
 * selection — matches the DOM's selectionStart === selectionEnd behavior.
 * @param {{ value?: string, s?: number, e?: number }} [opts]
 */
function fakeEditor(opts = {}) {
  const value = opts.value ?? '';
  const s = opts.s ?? 0;
  const e = opts.e ?? 0;
  return { value, selectionStart: s, selectionEnd: e };
}

/**
 * Reset module-shared state + override `document.getElementById` to the
 * fake editor so `getEditor()` returns it. Returns a function that
 * restores the original getElementById when called; every test should
 * invoke it in the finally-block to avoid leaking stubs across tests.
 * @param {ReturnType<typeof fakeEditor> | null} editor
 */
function setup(editor) {
  state.tabs = [];
  state.activeTabId = null;
  state.inputMode = 'currentTab';
  const originalGet = /** @type {any} */ (globalThis.document).getElementById;
  /** @type {any} */ (globalThis.document).getElementById = (id) => {
    if (id === 'editor') return editor;
    if (id === 'input-mode-btn') return null;
    return null;
  };
  return () => {
    /** @type {any} */ (globalThis.document).getElementById = originalGet;
  };
}

// ---------------------------------------------------------------- //
// getInputMode / setInputMode / toggleInputMode — the backing toggle
// ---------------------------------------------------------------- //

test('getInputMode: defaults to currentTab', () => {
  const restore = setup(null);
  try {
    assert.equal(getInputMode(), 'currentTab');
  } finally {
    restore();
  }
});

test('getInputMode: unrecognised value on state normalises to currentTab', () => {
  const restore = setup(null);
  try {
    /** @type {any} */ (state).inputMode = 'bogusValue';
    assert.equal(getInputMode(), 'currentTab');
  } finally {
    restore();
  }
});

test('setInputMode: accepts allTabs, normalises unknown to currentTab', () => {
  const restore = setup(null);
  try {
    setInputMode('allTabs');
    assert.equal(getInputMode(), 'allTabs');
    setInputMode(/** @type {any} */ ('totallyBogus'));
    assert.equal(getInputMode(), 'currentTab');
  } finally {
    restore();
  }
});

test('toggleInputMode: flips between the two valid modes', () => {
  const restore = setup(null);
  try {
    assert.equal(getInputMode(), 'currentTab');
    toggleInputMode();
    assert.equal(getInputMode(), 'allTabs');
    toggleInputMode();
    assert.equal(getInputMode(), 'currentTab');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- //
// getEffectiveInputMode — "what will the next run actually use?"
// ---------------------------------------------------------------- //

test('getEffectiveInputMode: no selection + currentTab mode → currentTab', () => {
  const restore = setup(fakeEditor({ value: 'hello', s: 0, e: 0 }));
  try {
    assert.equal(getEffectiveInputMode(), 'currentTab');
  } finally {
    restore();
  }
});

test('getEffectiveInputMode: no selection + allTabs mode → allTabs', () => {
  const restore = setup(fakeEditor({ value: 'hello', s: 3, e: 3 }));
  try {
    state.inputMode = 'allTabs';
    assert.equal(getEffectiveInputMode(), 'allTabs');
  } finally {
    restore();
  }
});

test('getEffectiveInputMode: active selection overrides allTabs', () => {
  // Critical invariant: selection ALWAYS wins. The toggle setting is
  // preserved (for when selection clears), but the next run reads the
  // highlighted text.
  const restore = setup(fakeEditor({ value: 'hello world', s: 0, e: 5 }));
  try {
    state.inputMode = 'allTabs';
    assert.equal(getEffectiveInputMode(), 'selection');
  } finally {
    restore();
  }
});

test('getEffectiveInputMode: no editor element → falls back to toggle state', () => {
  // When the editor isn't in the DOM (palette open with no textarea
  // yet, or test context) `getEditor()` returns null; no selection is
  // detectable, so we fall through to the toggle.
  const restore = setup(null);
  try {
    state.inputMode = 'allTabs';
    assert.equal(getEffectiveInputMode(), 'allTabs');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- //
// resolveInput — the central precedence rule
// ---------------------------------------------------------------- //

test('resolveInput: selection wins → single-input, sink=selection with {s,e}', () => {
  const restore = setup(fakeEditor({ value: 'hello world', s: 6, e: 11 }));
  try {
    state.inputMode = 'allTabs';  // Still gets overridden by selection.
    state.tabs = [
      { id: 't1', title: 'a', content: 'A', excluded: false },
      { id: 't2', title: 'b', content: 'B', excluded: false },
    ];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'single');
    assert.equal(r.input, 'world');
    assert.equal(r.sink.type, 'selection');
    assert.equal(r.sink.s, 6);
    assert.equal(r.sink.e, 11);
    assert.equal(r.source.kind, 'selection');
  } finally {
    restore();
  }
});

test('resolveInput: currentTab mode → single-input, sink=activeTabContent', () => {
  const restore = setup(fakeEditor({ value: 'live editor text', s: 0, e: 0 }));
  try {
    state.inputMode = 'currentTab';
    state.tabs = [{ id: 't1', title: 'scratch', content: 'stale on-disk', excluded: false }];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'single');
    // The live editor value — not the persisted tab.content — should
    // be used. resolveInput uses `sel.target` which is the textarea's
    // current value when there's no selection.
    assert.equal(r.input, 'live editor text');
    assert.equal(r.sink.type, 'activeTabContent');
    assert.equal(r.source.kind, 'currentTab');
    assert.equal(r.source.title, 'scratch');
  } finally {
    restore();
  }
});

test('resolveInput: allTabs mode → multi, tabs in left-to-right order', () => {
  const restore = setup(fakeEditor({ value: 'live-a', s: 0, e: 0 }));
  try {
    state.inputMode = 'allTabs';
    state.tabs = [
      { id: 't1', title: 'a', content: 'on-disk-a', excluded: false },
      { id: 't2', title: 'b', content: 'on-disk-b', excluded: false },
      { id: 't3', title: 'c', content: 'on-disk-c', excluded: false },
    ];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'multi');
    assert.equal(r.inputs.length, 3);
    // Active tab should read from the live textarea, not stale content.
    assert.equal(r.inputs[0].content, 'live-a');
    assert.equal(r.inputs[0].name, 'a');
    assert.equal(r.inputs[1].content, 'on-disk-b');
    assert.equal(r.inputs[2].content, 'on-disk-c');
    assert.equal(r.sink.type, 'newOutputTab');
    assert.equal(r.source.kind, 'allTabs');
    assert.equal(r.source.count, 3);
  } finally {
    restore();
  }
});

test('resolveInput: allTabs mode drops tabs marked excluded', () => {
  const restore = setup(fakeEditor({ value: 'a-live', s: 0, e: 0 }));
  try {
    state.inputMode = 'allTabs';
    state.tabs = [
      { id: 't1', title: 'a', content: 'x', excluded: false },
      { id: 't2', title: 'scratchpad', content: 'noise', excluded: true },
      { id: 't3', title: 'c', content: 'z', excluded: false },
    ];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'multi');
    assert.equal(r.inputs.length, 2, 'excluded tab should be filtered out');
    assert.deepEqual(
      r.inputs.map((t) => t.name),
      ['a', 'c'],
    );
    assert.equal(r.source.count, 2);
  } finally {
    restore();
  }
});

test('resolveInput: allTabs mode with zero surviving tabs → single empty string fallback', () => {
  // Every tab excluded (or no tabs at all). The function MUST still
  // return a valid result — it's not allowed to crash the run — and
  // should degrade to a single-input run against "" so downstream
  // pipeline/palette "nothing to process" handling applies normally.
  const restore = setup(fakeEditor({ value: '', s: 0, e: 0 }));
  try {
    state.inputMode = 'allTabs';
    state.tabs = [
      { id: 't1', title: 'scratch', content: 'noise', excluded: true },
    ];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'single');
    assert.equal(r.input, '');
    assert.equal(r.sink.type, 'newOutputTab');
    assert.equal(r.source.kind, 'allTabs');
    assert.equal(r.source.count, 0);
  } finally {
    restore();
  }
});

test('resolveInput: allTabs with no tabs at all → same empty fallback', () => {
  const restore = setup(fakeEditor({ value: '', s: 0, e: 0 }));
  try {
    state.inputMode = 'allTabs';
    state.tabs = [];
    state.activeTabId = null;
    const r = resolveInput();
    assert.equal(r.kind, 'single');
    assert.equal(r.input, '');
    assert.equal(r.source.count, 0);
  } finally {
    restore();
  }
});

test('resolveInput: selection wins even over excluded-tab edge cases', () => {
  // Selection present + allTabs mode + every tab excluded — the
  // "selection always wins" rule means we still return the selection,
  // not the empty-fallback. Double-checks the precedence order.
  const restore = setup(fakeEditor({ value: 'hello world', s: 0, e: 5 }));
  try {
    state.inputMode = 'allTabs';
    state.tabs = [{ id: 't1', title: 'x', content: '', excluded: true }];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'single');
    assert.equal(r.input, 'hello');
    assert.equal(r.sink.type, 'selection');
    assert.equal(r.source.kind, 'selection');
  } finally {
    restore();
  }
});

test('resolveInput: tab with no title falls back to "tab" placeholder', () => {
  const restore = setup(fakeEditor({ value: 'x', s: 0, e: 0 }));
  try {
    state.inputMode = 'allTabs';
    state.tabs = [
      { id: 't1', title: '', content: 'x', excluded: false },
      { id: 't2', title: null, content: 'y', excluded: false },
    ];
    state.activeTabId = 't1';
    const r = resolveInput();
    assert.equal(r.kind, 'multi');
    assert.equal(r.inputs[0].name, 'tab');
    assert.equal(r.inputs[1].name, 'tab');
  } finally {
    restore();
  }
});
