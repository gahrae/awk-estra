// @ts-check
// Input-mode toggle — the header button that controls
// what awk runs consume as input across every surface: snippet apply,
// chain apply, pipeline run, palette apply. The toggle has two backing
// values, `currentTab` and `allTabs`, plus a third *effective* value,
// `selection`, that is not user-selectable — it kicks in whenever a
// non-empty text selection exists in the active editor tab.
//
// Design notes:
//   • Selection always wins. A user who highlighted text has expressed
//     explicit intent; the toolbar mode is ambient state and loses.
//     When selection wins, output is written back to the selection too
//     (see resolveInput().sink) — mixing "multi-file input, new-tab
//     output" with an existing selection would be surprising.
//   • The underlying toggle stays flippable while "Selection" is shown,
//     so the user can pre-set the mode that will apply the moment they
//     deselect.
//   • Mode is NOT persisted. It resets to `currentTab` on page load —
//     see state.js. Leaving the app in `allTabs` and coming back
//     tomorrow to silently process every open tab would be a footgun.

import { state } from './state.js';
import { dispatch, on } from './events.js';

// Mirror the tiny editor.js helpers locally to sidestep a module cycle
// (editor.js calls renderInputModeToggle on tab switch and also
// exports getSel/activeTab). Both are one-liners so duplicating is
// cheaper than refactoring the editor surface to break the cycle.
function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}
function getEditor() {
  return /** @type {HTMLTextAreaElement | null} */ (document.getElementById('editor'));
}
function getEditorSelection() {
  const ed = getEditor();
  if (!ed) return { s: 0, e: 0, hasSel: false, target: '' };
  const s = ed.selectionStart;
  const e = ed.selectionEnd;
  const hasSel = s !== e;
  const target = hasSel ? ed.value.slice(s, e) : ed.value;
  return { s, e, hasSel, target };
}

/**
 * @typedef {'currentTab' | 'allTabs'} InputMode
 * @typedef {'currentTab' | 'allTabs' | 'selection'} EffectiveInputMode
 */

/**
 * Output sink: where the final stdout lands.
 *   - `selection`         → replace the originally-selected range (s/e
 *     snapshot survives focus shifts during await)
 *   - `activeTabContent`  → replace the whole active tab's content
 *   - `newOutputTab`      → create a fresh read-only, excluded tab
 *
 * @typedef {(
 *   | { type: 'selection', s: number, e: number }
 *   | { type: 'activeTabContent' }
 *   | { type: 'newOutputTab' }
 * )} ResolvedSink
 *
 * Resolved input + sink for a single run. `kind` drives which awk
 * client (`runAwk` vs `runAwkMulti`) the caller hits; `sink` tells
 * writeOutput where to put stdout.
 *
 * `source` is a structured description so callers can label errors and
 * output tabs meaningfully ("Results: myprog × 3 tabs").
 *
 * Sink is deliberately a broad union rather than discriminated on
 * `kind`: the `allTabs, no-tabs-survived-excluded-filter` fallback
 * yields `kind: 'single'` (runs against an empty string) with sink
 * `newOutputTab` (result still goes somewhere users can find it).
 *
 * @typedef {(
 *   | { kind: 'single', input: string }
 *   | { kind: 'multi', inputs: Array<{name: string, content: string}> }
 * ) & { sink: ResolvedSink, source: InputSource }} ResolvedInput
 *
 * @typedef {(
 *   | { kind: 'selection' }
 *   | { kind: 'currentTab', title: string }
 *   | { kind: 'allTabs', count: number }
 * )} InputSource
 */

/** @returns {InputMode} */
export function getInputMode() {
  return state.inputMode === 'allTabs' ? 'allTabs' : 'currentTab';
}

// Last-known *effective* input mode — the value `input-mode:changed`
// subscribers care about. `selectionchange` fires on every caret tick
// (thousands of times during normal use); without this tracker every
// tick would re-fire the event and e.g. restart the pipeline preview
// debounce even when nothing meaningful changed.
/** @type {EffectiveInputMode | null} */
let lastEffectiveMode = null;

/**
 * Update `lastEffectiveMode` and report whether it transitioned. A
 * return value of `false` means the event that prompted the call is a
 * no-op from the "what does the next run process" perspective —
 * subscribers (auto-preview, palette preview) should stay silent.
 * @returns {boolean}
 */
function advanceEffectiveMode() {
  const next = getEffectiveInputMode();
  const changed = next !== lastEffectiveMode;
  lastEffectiveMode = next;
  return changed;
}

/** @param {InputMode} next */
export function setInputMode(next) {
  const v = next === 'allTabs' ? 'allTabs' : 'currentTab';
  if (state.inputMode === v) return;
  state.inputMode = v;
  // Always re-render — the `input-mode-all` class on the toggle reflects
  // the backing mode, which just changed. But only dispatch when the
  // *effective* mode transitioned: flipping the backing with a selection
  // still shown ('selection' before and after) is silent.
  const effChanged = advanceEffectiveMode();
  renderInputModeToggle();
  if (effChanged) dispatch('input-mode:changed');
}

export function toggleInputMode() {
  setInputMode(getInputMode() === 'allTabs' ? 'currentTab' : 'allTabs');
}

/**
 * Current *effective* mode — the one that will actually apply on the
 * next run. `selection` is returned whenever there's a non-empty
 * selection in the active editor; the toggle setting is preserved but
 * doesn't drive the run.
 * @returns {EffectiveInputMode}
 */
export function getEffectiveInputMode() {
  const { hasSel } = getEditorSelection();
  if (hasSel) return 'selection';
  return getInputMode();
}

/**
 * Gather the tabs that should feed an All-Tabs run. Strip order
 * (left-to-right) — which pinned tabs already cluster to the left of —
 * is the natural "order as seen by the user". Tabs marked `excluded`
 * are filtered out so user-designated scratchpads and auto-tagged
 * result tabs don't accidentally feed back into the next run.
 * @returns {Array<{name: string, content: string}>}
 */
function gatherAllTabsInputs() {
  const out = [];
  const active = getActiveTab();
  const ed = getEditor();
  for (const tab of state.tabs) {
    if (tab.excluded) continue;
    // The active tab's live content lives in the textarea; everywhere
    // else tab.content is authoritative. Reading from ed keeps pending
    // keystrokes (not yet debounced to saveState) in the input stream.
    const content = active && tab.id === active.id && ed ? ed.value : tab.content;
    out.push({ name: tab.title || 'tab', content });
  }
  return out;
}

/**
 * Resolve the input + output sink for a run. Central so every trigger
 * surface (snippet, chain, pipeline, palette, runner dialog) agrees on
 * precedence. Callers switch on `kind` to pick runAwk vs runAwkMulti.
 * @returns {ResolvedInput}
 */
export function resolveInput() {
  const sel = getEditorSelection();
  if (sel.hasSel) {
    return {
      kind: 'single',
      input: sel.target,
      sink: { type: 'selection', s: sel.s, e: sel.e },
      source: { kind: 'selection' },
    };
  }
  if (getInputMode() === 'allTabs') {
    const inputs = gatherAllTabsInputs();
    // Zero tabs survive the `excluded` filter — fall back to a
    // single-file run against an empty string. Preserves the "a run
    // always fires" invariant so the user isn't silently ignored, and
    // the pipeline/palette's empty-input handling surfaces the normal
    // "nothing to process" result.
    if (!inputs.length) {
      return {
        kind: 'single',
        input: '',
        sink: { type: 'newOutputTab' },
        source: { kind: 'allTabs', count: 0 },
      };
    }
    return {
      kind: 'multi',
      inputs,
      sink: { type: 'newOutputTab' },
      source: { kind: 'allTabs', count: inputs.length },
    };
  }
  // currentTab: the full active tab contents.
  return {
    kind: 'single',
    input: sel.target,
    sink: { type: 'activeTabContent' },
    source: { kind: 'currentTab', title: getActiveTab()?.title || '' },
  };
}

/**
 * Re-render the toolbar toggle button to reflect the effective mode.
 * Called on toggle click, on tab switch, and on selection change.
 */
export function renderInputModeToggle() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('input-mode-btn'));
  if (!btn) return;
  const eff = getEffectiveInputMode();
  const backing = getInputMode();
  btn.classList.toggle('input-mode-all', backing === 'allTabs');
  btn.classList.toggle('input-mode-selection', eff === 'selection');
  // Label shows the *effective* mode so users see exactly what the next
  // run will process. The backing mode is still flippable via click;
  // the tooltip explains precedence.
  let label;
  if (eff === 'selection') label = '◉ Input: Selection';
  else if (eff === 'allTabs') label = '▦ Input: All Tabs';
  else label = '▭ Input: Current Tab';
  btn.textContent = label;
  btn.setAttribute(
    'title',
    'Input source for awk runs. Click to toggle between Current Tab and All Tabs. ' +
      'A text selection always takes priority and is processed in place.',
  );
  btn.setAttribute('aria-pressed', backing === 'allTabs' ? 'true' : 'false');
}

/**
 * Wire the toolbar button + listeners. Called once at startup from
 * main.js. Idempotent via a module-local flag so a second call is a
 * no-op rather than double-binding click handlers.
 */
let wired = false;
export function initInputMode() {
  if (wired) return;
  wired = true;
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('input-mode-btn'));
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleInputMode();
  });
  // Re-render on selection change so the "Selection" label appears
  // instantly when the user highlights text, and disappears the moment
  // they collapse it. `selectionchange` fires on document and covers
  // both mouse and keyboard selection — but it also fires on every
  // caret move inside a single tab, which would otherwise rebuild the
  // toggle and restart every preview debounce on every arrow key. Gate
  // on `advanceEffectiveMode`: if the effective mode didn't transition,
  // nothing visible about the next run changed and we stay silent.
  document.addEventListener('selectionchange', () => {
    if (!advanceEffectiveMode()) return;
    renderInputModeToggle();
    dispatch('input-mode:changed');
  });
  // Tab switch changes which tab's selection we should be reading;
  // renderTabs fires no dedicated event, so we lean on the workspace
  // load hook (which rebinds the editor) plus a cheap MutationObserver-
  // free approach: editor.js already calls renderInputModeToggle after
  // switchToTab via a direct import (see editor.js changes).
  on('workspace:loaded', () => {
    // Workspace load may have switched the active tab's selection state
    // out from under us; resync the tracker so the next selectionchange
    // compares against the post-load mode, not a stale one.
    advanceEffectiveMode();
    renderInputModeToggle();
  });
  // Seed the tracker so the first real selection / toggle transition
  // after init is detected correctly.
  lastEffectiveMode = getEffectiveInputMode();
  renderInputModeToggle();
}
