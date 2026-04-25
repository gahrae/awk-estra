// @ts-check
// Ctrl+K command palette. Runs ad-hoc awk on the current selection (or whole
// buffer). Chain-mode builds a pipeline step-by-step, previewing the cumulative
// effect.

import {
  $,
  uid,
  safeSetItem,
  showToast,
  truncateLines,
  editText,
  editTextRange,
  renderParamRows,
  cleanParams,
  appAlert,
  appConfirm,
  createStalenessGuard,
} from './core.js';
import { LS_KEYS } from './data.js';
import { dispatch, on } from './events.js';
import {
  state,
  saveState,
  collectPipelineVars,
  resolveStepVars,
  stepLabel,
  allSnippetTags,
  allTemplateTags,
} from './state.js';
import { settings, openSettingsDialog } from './settings.js';
import { runAwk, runAwkMulti, findCandidateVars, highlightAwk } from './awk.js';
import { appendSafetyChangeSettingIfBlocked } from './safety.js';
import { getSel, writeOutput } from './editor.js';
import { addPipelineStep, renderPipeline, copyIoSettingsFromSteps } from './pipeline.js';
import { resolveInput } from './inputMode.js';
import {
  renderPaletteReference,
  wireDetectFsButton,
  wireColumnsButton,
  wireFpatButton,
  wireStrftimeButton,
  wireFormatButton,
} from './dialogs.js';

/**
 * Debounce handle for the palette's live preview. Re-scheduled by every
 * `input` keystroke; the last one wins.
 * @type {ReturnType<typeof setTimeout> | undefined}
 */
let paletteDebounce;
/**
 * Staleness guard ensuring only the latest preview's `runAwk` result is
 * applied to `#palette-output`. See `core.js` / `createStalenessGuard`.
 */
const palettePreviewGuard = createStalenessGuard();
/**
 * Module-scoped debounced preview trigger — shared by the input
 * listener, the var-edit listener, and the param-row mutation
 * handlers (add / remove / detect / clear). Hoisted here so
 * `renderPaletteVars` can pass it into `renderParamRows` as the
 * onChange callback; a function declaration inside `setupPaletteWiring`
 * wouldn't be visible at module scope.
 */
function schedulePaletteDebounced() {
  clearTimeout(paletteDebounce);
  paletteDebounce = setTimeout(palettePreview, 180);
}
/**
 * ResizeObserver tracking the palette dialog so child textareas and the
 * reference pane resync their layout. Held at module scope so it can be
 * disconnected when the dialog closes.
 * @type {ResizeObserver | null}
 */
let paletteResizeObserver = null;
/** @type {{name:string, default?:string}[]} per-session palette vars — not persisted */
let paletteVars = [];
/**
 * Last height `autosizePaletteInput` set on `#palette-input`. If the current
 * `style.height` differs from this, the user has dragged the resize handle
 * and autosize should no longer fight them. Reset to `null` whenever the
 * palette opens fresh.
 * @type {string | null}
 */
let lastAutosizedHeight = null;
/**
 * id of the snippet whose body was most recently inserted into the palette
 * via a Snippets-list click. Tracks user intent so that "Add to pipeline"
 * with no custom step-name / vars references the snippet the user actually
 * picked, not the first arbitrary snippet whose program text happens to
 * match. Cleared whenever the program text drifts from that snippet's body
 * (the user's edit signals the linkage is no longer valid).
 * @type {string | null}
 */
let paletteSelectedSnippetId = null;
/**
 * Non-zero while the user is hovering or keyboard-focusing a Snippets /
 * Templates chip: `#palette-output` is showing that chip's source (syntax-
 * highlighted) rather than the live-run preview. palettePreview's writes
 * are gated on this — any result that would land mid-hover is dropped, and
 * the live preview is re-fetched when hover ends. A depth counter (not
 * just a bool) so rapid-fire enter/leave between adjacent chips doesn't
 * clear the preview too early.
 * @type {number}
 */
let paletteOutputChipHoverDepth = 0;

function showChipPreviewInOutput(source) {
  paletteOutputChipHoverDepth++;
  const out = $('#palette-output');
  out.classList.remove('error');
  // `highlightAwk` HTML-escapes each token internally — safe to innerHTML.
  out.innerHTML = highlightAwk(source);
}

function clearChipPreviewFromOutput() {
  if (paletteOutputChipHoverDepth > 0) paletteOutputChipHoverDepth--;
  if (paletteOutputChipHoverDepth === 0) {
    // Re-run the live preview so the pane shows a fresh run against the
    // current program + input instead of stale chip source.
    palettePreview();
  }
}

/**
 * Called at the top of every chip-list render. A render tears the current
 * chips out of the DOM, so any hover bookkeeping tied to those elements
 * is invalidated — `mouseleave` never fires on a removed node, and
 * without this reset the counter stays `> 0` forever and palettePreview
 * stops writing, leaving the output stuck on the last chip's source.
 */
function resetChipHoverState() {
  if (paletteOutputChipHoverDepth === 0) return;
  paletteOutputChipHoverDepth = 0;
  // Kick off a live refresh so the pane doesn't linger on the orphan
  // source. Fire-and-forget — palettePreview is async but the caller
  // (usually a click handler that also re-dispatches `input`) will
  // trigger another preview shortly; the staleness guard ensures only
  // the latest result lands.
  palettePreview();
}

// ---------- command history ----------
/**
 * Ring buffer of recent palette commits (Apply + Add-to-pipeline).
 * Persisted in localStorage under LS_KEYS.PALETTE_HISTORY. Most-recent
 * first. Capped at HISTORY_MAX; consecutive-duplicate commits collapse
 * to a single entry (bash `HISTCONTROL=ignoredups` convention).
 *
 * @typedef PaletteHistoryEntry
 * @property {string} id
 * @property {string} program
 * @property {Record<string,string>} vars
 * @property {string} [name]
 * @property {number} ts
 * @property {'apply' | 'pipe'} mode
 */
const HISTORY_MAX = 50;

/** @returns {PaletteHistoryEntry[]} */
function loadPaletteHistory() {
  try {
    const raw = localStorage.getItem(LS_KEYS.PALETTE_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/** @param {PaletteHistoryEntry[]} entries */
function savePaletteHistory(entries) {
  safeSetItem(LS_KEYS.PALETTE_HISTORY, JSON.stringify(entries));
}

/**
 * Push a new history entry. Collapses consecutive duplicates (same
 * program + same vars + same mode) so hitting Apply twice doesn't
 * double-log.
 * @param {{program: string, vars: Record<string,string>, name?: string, mode: 'apply' | 'pipe'}} commit
 */
function pushPaletteHistoryEntry(commit) {
  const entries = loadPaletteHistory();
  const prev = entries[0];
  const sameVars = (a, b) => {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (a[k] !== b[k]) return false;
    return true;
  };
  if (
    prev &&
    prev.program === commit.program &&
    prev.mode === commit.mode &&
    (prev.name || '') === (commit.name || '') &&
    sameVars(prev.vars || {}, commit.vars || {})
  ) {
    // Dedupe: still bump the timestamp so the "just used" feel is right.
    prev.ts = Date.now();
    savePaletteHistory(entries);
  } else {
    /** @type {PaletteHistoryEntry} */
    const entry = {
      id: uid(),
      program: commit.program,
      vars: { ...commit.vars },
      name: commit.name,
      ts: Date.now(),
      mode: commit.mode,
    };
    entries.unshift(entry);
    if (entries.length > HISTORY_MAX) entries.length = HISTORY_MAX;
    savePaletteHistory(entries);
  }
  // Re-render if the palette is currently open so the chip appears
  // immediately — useful because Apply normally closes the palette, but
  // Add-to-pipeline in pipeline mode leaves it open.
  if (!$('#palette').classList.contains('hidden')) renderPaletteHistory();
}

/** @param {PaletteHistoryEntry} entry */
function historyChipLabel(entry) {
  if (entry.name) return entry.name;
  const firstLine = entry.program.split('\n')[0].trim();
  if (!firstLine) return '(empty program)';
  return firstLine.length > 36 ? firstLine.slice(0, 35) + '\u2026' : firstLine;
}

export function renderPaletteHistory() {
  const ul = $('#palette-history');
  if (!ul) return;
  resetChipHoverState();
  const entries = loadPaletteHistory();
  ul.replaceChildren();
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No history yet — your recent Apply / Add-to-pipeline runs will appear here.';
    ul.appendChild(li);
    return;
  }
  // Filter by the dedicated search field: match against the chip label
  // (step-name or first-line preview) AND the full program.
  const q = ($('#palette-search') || {}).value
    ? $('#palette-search').value.trim().toLowerCase()
    : '';
  const visible = q
    ? entries.filter(
        (e) =>
          historyChipLabel(e).toLowerCase().includes(q) ||
          (e.program || '').toLowerCase().includes(q),
      )
    : entries;
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '(no history entries match the filter)';
    ul.appendChild(li);
    return;
  }
  for (const entry of visible) {
    const li = document.createElement('li');
    li.dataset.id = entry.id;
    li.textContent = historyChipLabel(entry);
    const varsText = Object.entries(entry.vars || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const modeTag = entry.mode === 'pipe' ? 'Added to pipeline' : 'Applied';
    li.title = `${modeTag}\n${entry.program}${varsText ? `\n\nvars: ${varsText}` : ''}`;
    wireChipSourcePreview(li, () => entry.program);
    li.addEventListener('click', () => {
      resetPaletteSearchAndSections();
      restorePaletteHistoryEntry(entry);
    });
    ul.appendChild(li);
  }
}

/**
 * Restore a history entry into the palette: program text, vars rows, and
 * step-name. Mirrors the snippet-click flow, but *replaces* the vars list
 * wholesale (the user is rehydrating a complete past invocation) instead
 * of merging name-by-name.
 * @param {PaletteHistoryEntry} entry
 */
function restorePaletteHistoryEntry(entry) {
  const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
  // editTextRange goes through execCommand('insertText') and preserves
  // the textarea's native undo stack. Direct `input.value = …` would
  // wipe the stack, so a user who picks a history entry to inspect
  // couldn't Ctrl+Z back to their in-flight draft.
  editTextRange(input, 0, input.value.length, entry.program);
  // No snippet link — this came from history, not the library.
  paletteSelectedSnippetId = null;
  autosizePaletteInput();
  input.dispatchEvent(new Event('input'));
  paletteVars = Object.entries(entry.vars || {}).map(([name, value]) => ({
    name,
    default: value,
  }));
  renderPaletteVars();
  if (paletteVars.length) {
    const details = /** @type {HTMLDetailsElement | null} */ ($('#palette details.palette-vars'));
    if (details) details.open = true;
  }
  /** @type {HTMLInputElement} */ ($('#palette-step-name')).value = entry.name || '';
  renderPaletteLibrary();
  palettePreview();
  input.focus();
}

/**
 * Attach hover / focus listeners to a chip so the palette's Preview pane
 * temporarily shows its source body in place of the live run. Used by
 * both the Snippets suggestion chips and the Templates chips.
 * @param {HTMLElement} li
 * @param {() => string} bodyFn  Late-bound so renaming / editing the
 *   underlying snippet before the user's mouse lands still previews the
 *   current body.
 */
function wireChipSourcePreview(li, bodyFn) {
  li.addEventListener('mouseenter', () => showChipPreviewInOutput(bodyFn()));
  li.addEventListener('mouseleave', clearChipPreviewFromOutput);
  li.addEventListener('focus', () => showChipPreviewInOutput(bodyFn()));
  li.addEventListener('blur', clearChipPreviewFromOutput);
}

function renderPaletteVars() {
  // Pass the debounced preview scheduler so row removals (via the ✕
  // button) retrigger preview — typing in name/default inputs already
  // bubbles `input` events to the list listener below, so those are
  // covered there.
  renderParamRows($('#palette-vars-list'), paletteVars, schedulePaletteDebounced);
}

/**
 * Append missing rows to `paletteVars` for each `{name, default?}` in
 * `candidates` that isn't already represented. Re-renders and opens the
 * Variables details if anything was added. Returns the count of new rows.
 *
 * @param {{name: string, default?: string}[]} candidates
 */
function mergePaletteVars(candidates) {
  if (!candidates.length) return 0;
  const existing = new Set(paletteVars.map((p) => p.name));
  let added = 0;
  for (const c of candidates) {
    if (!c.name || existing.has(c.name)) continue;
    paletteVars.push({ name: c.name, default: c.default ?? '' });
    existing.add(c.name);
    added++;
  }
  if (added) {
    renderPaletteVars();
    const details = /** @type {HTMLDetailsElement | null} */ ($('#palette details.palette-vars'));
    if (details) details.open = true;
  }
  return added;
}

/**
 * Map the palette's working vars into the `-v name=value` form used by
 * `runAwk`. Rows with empty names (half-typed) are skipped; each var's
 * "default" field carries the user-provided value for this run.
 * @returns {Record<string,string>}
 */
function collectPaletteVars() {
  /** @type {Record<string,string>} */
  const vars = {};
  for (const p of paletteVars) {
    if (p.name) vars[p.name] = p.default ?? '';
  }
  return vars;
}

function updatePaletteScope() {
  const { hasSel, target } = getSel();
  const len = target.length;
  const lines = target ? target.split('\n').length : 0;
  $('#palette-scope').textContent = hasSel
    ? `Selection: ${len} chars, ${lines} lines`
    : `Whole buffer: ${len} chars, ${lines} lines`;
}

function autosizePaletteInput() {
  const ta = $('#palette-input');
  // If the user has manually resized the textarea since our last autosize,
  // its `style.height` no longer matches what we set. Leave it alone — the
  // user's intent (a taller box for a long program) wins over autosize.
  if (lastAutosizedHeight !== null && ta.style.height !== lastAutosizedHeight) {
    return;
  }
  ta.style.height = 'auto';
  // `scrollHeight` is content + padding only — it excludes border. With
  // `box-sizing: border-box` (our global reset), setting `height = scrollHeight`
  // gives the border box exactly that many pixels, leaving the content box
  // short by the border-top+bottom width. A vertical scrollbar then appears
  // because the content overflows by that few pixels. Add the border back.
  const cs = getComputedStyle(ta);
  const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const next = ta.scrollHeight + borderY + 'px';
  ta.style.height = next;
  lastAutosizedHeight = next;
}

function applyPaletteRefState() {
  const shown = localStorage.getItem(LS_KEYS.PALETTE_REF_SHOWN) === '1';
  $('#palette .palette-inner').classList.toggle('with-ref', shown);
  $('#palette-ref-toggle').textContent = shown ? 'Hide reference' : 'Show reference';
}

/**
 * Counter raised while the palette is programmatically opening/closing
 * a section (filter auto-expand, state restore, chip-click reset). The
 * `toggle` persist listener below checks this and no-ops — otherwise
 * the filter's force-open on a collapsed section would rewrite the
 * user's stored "collapsed" preference to "expanded".
 *
 * Counter (not bool) so nested programmatic changes compose correctly.
 */
let suppressSectionPersist = 0;

/**
 * Run `fn` with the persist-suppression counter raised, deferring the
 * decrement past the next task so the asynchronous `toggle` event
 * (dispatched by the browser from its own task queue when `det.open`
 * changes) observes the counter as still raised.
 *
 * If we decremented synchronously in a `finally` block — as the first
 * attempt did — the toggle event would fire *after* decrement, see the
 * counter at 0, and persist anyway. `setTimeout(0)` ran on the same
 * task queue as the toggle event, FIFO: the toggle event was queued
 * during `det.open = X` (inside `fn`), so it runs first and the
 * decrement runs second.
 *
 * Every programmatic `det.open = …` write must go through this helper
 * (or be inside a caller that does) to stay clean across LS.
 *
 * @param {() => void} fn
 */
function withSuppressedSectionPersist(fn) {
  suppressSectionPersist++;
  try {
    fn();
  } finally {
    setTimeout(() => {
      suppressSectionPersist--;
    }, 0);
  }
}

/**
 * Restore the collapsed/expanded state of each palette list section
 * (Snippets, Templates, History). Per-session LS wins when present;
 * otherwise we fall back to `settings.ui.paletteSectionsExpanded[key]`
 * (the user-configured default from the Settings dialog — true =
 * expanded, false = collapsed). Mirrors the sidebar section-toggle
 * pattern so both surfaces behave the same way.
 */
/**
 * When a palette search filter is active, force-open any collapsed section
 * whose list has visible matches. When the filter is cleared, restore the
 * user's persisted collapsed state.
 */
function autoExpandFilteredPaletteSections() {
  const q = ($('#palette-search') || {}).value ? $('#palette-search').value.trim() : '';
  if (!q) {
    applyPaletteSectionState();
    return;
  }
  withSuppressedSectionPersist(() => {
    for (const key of ['library', 'history']) {
      const det = /** @type {HTMLDetailsElement | null} */ ($('#palette-section-' + key));
      if (!det) continue;
      const ul = det.querySelector('ul');
      if (ul && ul.style.display !== 'none') det.open = true;
    }
  });
}

function applyPaletteSectionState() {
  const defaults = settings.ui.paletteSectionsExpanded || {};
  withSuppressedSectionPersist(() => {
    for (const key of ['library', 'history']) {
      const det = /** @type {HTMLDetailsElement | null} */ ($('#palette-section-' + key));
      if (!det) continue;
      // LS now stores '1' = expanded, '0' = collapsed — flipped along
      // with the DEFAULT_SETTINGS polarity so the whole chain reads
      // affirmatively. Missing default key → expanded (matches the
      // fresh-install defaults in DEFAULT_SETTINGS).
      const stored = localStorage.getItem(LS_KEYS.paletteSectionExpanded(key));
      const expanded = stored === null ? defaults[key] !== false : stored === '1';
      det.open = expanded;
    }
  });
}

/**
 * Clear the palette filter input and restore each list section to its
 * persisted collapsed/expanded state. Called at the start of every
 * chip-click handler (snippet / template / history) so picking a match
 * also drops the filter and returns the palette to the visual state it
 * had at open time — the user's "narrow down → pick → back to quiet"
 * flow works without forcing them to hit the filter's × button.
 */
function resetPaletteSearchAndSections() {
  const search = /** @type {HTMLInputElement | null} */ ($('#palette-search'));
  if (!search || !search.value) return;
  search.value = '';
  renderPaletteLibrary();
  renderPaletteHistory();
  // Query is now empty, so autoExpand delegates to applyPaletteSectionState.
  autoExpandFilteredPaletteSections();
}

/**
 * Decide whether the palette opens in simple or advanced view. A stored LS
 * choice always wins (the user flipped it explicitly); otherwise we fall
 * back to `settings.ui.paletteDefaultAdvanced`. Simple view hides every
 * control except the program textarea, preview, Close, Apply, and the
 * advanced-toggle itself (see CSS `.simple-view`).
 */
function applyPaletteView() {
  const stored = localStorage.getItem(LS_KEYS.PALETTE_ADVANCED);
  const advanced = stored === null ? !!settings.ui.paletteDefaultAdvanced : stored === '1';
  const inner = $('#palette .palette-inner');
  inner.classList.toggle('simple-view', !advanced);
  $('#palette-advanced-toggle').textContent = advanced ? 'Hide advanced' : 'Show advanced';
}

/**
 * Flip the palette's advanced / simple view and persist the choice. Exposed
 * so the Ctrl+K keyboard shortcut can reuse the same behaviour as the
 * `#palette-advanced-toggle` button when the palette is already open.
 */
export function togglePaletteAdvanced() {
  const inner = $('#palette .palette-inner');
  const nowAdvanced = inner.classList.contains('simple-view');
  inner.classList.toggle('simple-view', !nowAdvanced);
  $('#palette-advanced-toggle').textContent = nowAdvanced ? 'Hide advanced' : 'Show advanced';
  safeSetItem(LS_KEYS.PALETTE_ADVANCED, nowAdvanced ? '1' : '0');
}

/** @returns {boolean} true when the palette is on-screen. */
export function isPaletteOpen() {
  return !$('#palette').classList.contains('hidden');
}

function applyPalettePipelineState() {
  const on = localStorage.getItem(LS_KEYS.PALETTE_PIPELINE) === '1';
  $('#palette-pipeline-mode').checked = on;
  $('#palette .palette-inner').classList.toggle('pipeline-mode-on', on);
  updatePalettePipelineCount();
}

function updatePalettePipelineCount() {
  const el = $('#palette-pipeline-count');
  const n = state.pipeline.length;
  el.textContent = `Pipeline: ${n} step${n === 1 ? '' : 's'}`;
}

function isPalettePipelineMode() {
  return $('#palette-pipeline-mode').checked;
}

export function openPalette() {
  const pal = $('#palette');
  pal.classList.remove('hidden');
  pal.setAttribute('aria-hidden', 'false');
  // Fresh session — autosize owns the textarea height again until the user
  // drags it.
  lastAutosizedHeight = null;
  // No snippet selection until the user clicks one.
  paletteSelectedSnippetId = null;
  const sizeRaw = localStorage.getItem(LS_KEYS.PALETTE_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) pal.style.width = width + 'px';
      if (height) pal.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }
  renderPaletteReference();
  syncPaletteScopeButtons();
  renderPaletteTagFilter();
  renderPaletteLibrary();
  renderPaletteHistory();
  applyPaletteRefState();
  applyPalettePipelineState();
  applyPaletteView();
  applyPaletteSectionState();
  $('#palette-search').value = '';
  // Fresh-session reset uses direct `.value = ''` deliberately — it
  // wipes the textarea's native undo stack so Ctrl+Z on a freshly-
  // opened palette can't resurrect the prior session's program. Every
  // *in-session* write (snippet click, history restore, Apply-then-
  // clear) goes through editTextRange to preserve undo.
  $('#palette-input').value = '';
  $('#palette-input').dispatchEvent(new Event('input'));
  /** @type {HTMLInputElement} */ ($('#palette-step-name')).value = '';
  paletteVars = [];
  renderPaletteVars();
  $('#palette-output').textContent = '';
  $('#palette-output').classList.remove('error');
  updatePaletteScope();
  renderPaletteLibrary();
  autosizePaletteInput();
  setTimeout(() => $('#palette-input').focus(), 10);

  if (paletteResizeObserver) paletteResizeObserver.disconnect();
  const r0 = pal.getBoundingClientRect();
  let lastW = r0.width,
    lastH = r0.height;
  paletteResizeObserver = new ResizeObserver(() => {
    const r = pal.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(LS_KEYS.PALETTE_SIZE, JSON.stringify({ width: r.width, height: r.height }));
    }
  });
  paletteResizeObserver.observe(pal);
}

export function closePalette() {
  const pal = $('#palette');
  pal.classList.add('hidden');
  pal.setAttribute('aria-hidden', 'true');
  if (paletteResizeObserver) {
    paletteResizeObserver.disconnect();
    paletteResizeObserver = null;
  }
  $('#editor').focus();
}

/**
 * Insert `body` into the palette program textarea. When the textarea is
 * the current `activeElement` we treat the caret as known and insert at
 * its position (replacing any selection). When it isn't — palette just
 * opened, user was typing in the filter input, etc. — the caret is
 * effectively unknown, so we append at the end after a separating
 * newline (skipped when the textarea is empty or already ends with one).
 * Preserves undo via `editText` / `editTextRange` in both paths.
 * @param {string} body
 */
function insertOrAppendIntoPaletteInput(body) {
  const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
  const focused = document.activeElement === input;
  if (focused) {
    editText(input, body);
    return;
  }
  const current = input.value;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  editTextRange(input, current.length, current.length, sep + body);
}

/**
 * Insert a template into the palette program (at the caret when
 * focused, appended otherwise — see `insertOrAppendIntoPaletteInput`),
 * resize, surface any newly-detected `-v` vars, refresh preview.
 * Shared by the list click and any future entry points.
 * @param {{body: string}} tpl
 */
function insertPaletteTemplate(tpl) {
  const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
  insertOrAppendIntoPaletteInput(tpl.body);
  autosizePaletteInput();
  const candidates = findCandidateVars(tpl.body).map((name) => ({ name, default: '' }));
  mergePaletteVars(candidates);
  renderPaletteLibrary();
  clearTimeout(paletteDebounce);
  paletteDebounce = setTimeout(palettePreview, 180);
  input.focus();
}

/**
 * Scope-toggle state for the combined palette library (T · Templates /
 * S · Snippets). Default both on — the user can narrow to just one.
 * Persisted via `LS_KEYS.paletteLibraryScope(kind)`; '0' means off.
 */
function readPaletteScope() {
  const tRaw = localStorage.getItem(LS_KEYS.paletteLibraryScope('templates'));
  const sRaw = localStorage.getItem(LS_KEYS.paletteLibraryScope('snippets'));
  return {
    showTemplates: tRaw === null ? true : tRaw === '1',
    showSnippets: sRaw === null ? true : sRaw === '1',
  };
}

function syncPaletteScopeButtons() {
  const tpl = $('#palette-scope-templates');
  const sn = $('#palette-scope-snippets');
  if (!tpl || !sn) return;
  const { showTemplates, showSnippets } = readPaletteScope();
  tpl.classList.toggle('active', showTemplates);
  tpl.setAttribute('aria-pressed', String(showTemplates));
  sn.classList.toggle('active', showSnippets);
  sn.setAttribute('aria-pressed', String(showSnippets));
}

/**
 * Currently-selected tag chip in the palette ('' = All). Persisted across
 * palette opens via `LS_KEYS.PALETTE_TAG_FILTER`. Reading lazily so an
 * external library import (which mutates `state.snippets` /
 * `state.templates`) doesn't strand the filter on a tag nobody has
 * anymore — we drop it silently instead of leaving the list empty.
 */
function paletteActiveTag() {
  const t = localStorage.getItem(LS_KEYS.PALETTE_TAG_FILTER) || '';
  if (!t) return '';
  const used =
    state.snippets.some((s) => (s.tags || []).includes(t)) ||
    state.templates.some((x) => (x.tags || []).includes(t));
  return used ? t : '';
}

export function renderPaletteTagFilter() {
  const wrap = $('#palette-tag-filter');
  // Union of snippet + template tags — the combined library can be
  // filtered by any tag either kind uses. Sorted + deduped.
  const tagSet = new Set([...allSnippetTags(), ...allTemplateTags()]);
  const tags = [...tagSet].sort();
  if (!tags.length) {
    wrap.hidden = true;
    wrap.replaceChildren();
    return;
  }
  wrap.hidden = false;
  wrap.replaceChildren();
  const active = paletteActiveTag();
  const mkChip = (label, tagValue) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'palette-tag-chip';
    btn.textContent = label;
    if (active === tagValue) btn.classList.add('active');
    btn.addEventListener('click', () => {
      const next = active === tagValue ? '' : tagValue;
      safeSetItem(LS_KEYS.PALETTE_TAG_FILTER, next);
      renderPaletteTagFilter();
      renderPaletteLibrary();
    });
    return btn;
  };
  wrap.appendChild(mkChip('All', ''));
  for (const t of tags) wrap.appendChild(mkChip(t, t));
}

/**
 * Render the combined snippet + template library chip list. Honours the
 * T / S scope toggles, the active tag filter, and the palette search
 * query. Sorted alphabetically across both kinds (case-insensitive,
 * locale-aware) — matches the snippet dialog's template picker. Every
 * chip carries a T / S letter badge so users can tell at a glance which
 * library the chip came from.
 *
 * Click behaviour differs by kind:
 *   - Snippet click → replaces the palette program with the snippet body
 *     (the snippet is a complete, ready-to-run program).
 *   - Template click → inserts the template body at the caret (a
 *     template is a fragment the user will adapt).
 */
export function renderPaletteLibrary() {
  const ul = $('#palette-library');
  if (!ul) return;
  resetChipHoverState();
  ul.innerHTML = '';
  const q = ($('#palette-search') || {}).value
    ? $('#palette-search').value.trim().toLowerCase()
    : '';
  const tag = paletteActiveTag();
  const { showTemplates, showSnippets } = readPaletteScope();
  // Names + descriptions match at any length; bodies only join in once
  // the query is specific enough to avoid noisy matches. Threshold is
  // mirrored from library.js's BODY_SEARCH_MIN.
  const scanBodies = q.length >= 3;
  /** @type {{kind: 'template' | 'snippet', id: string, name: string, body: string, description?: string, tags?: string[], raw: any}[]} */
  const entries = [];
  if (showTemplates) {
    for (const t of state.templates) {
      entries.push({
        kind: 'template',
        id: t.id,
        name: t.name,
        body: t.body,
        description: t.description,
        tags: t.tags,
        raw: t,
      });
    }
  }
  if (showSnippets) {
    for (const s of state.snippets) {
      entries.push({
        kind: 'snippet',
        id: s.id,
        name: s.name,
        body: s.program,
        description: s.description,
        tags: s.tags,
        raw: s,
      });
    }
  }
  let matches = tag ? entries.filter((e) => (e.tags || []).includes(tag)) : entries;
  if (q) {
    matches = matches.filter((e) => {
      if (e.name.toLowerCase().includes(q)) return true;
      if (e.description && e.description.toLowerCase().includes(q)) return true;
      if (scanBodies && e.body && e.body.toLowerCase().includes(q)) return true;
      return false;
    });
  }
  matches.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!matches.length) {
    const scopeLabel =
      showTemplates && showSnippets
        ? 'snippets or templates'
        : showSnippets
          ? 'snippets'
          : showTemplates
            ? 'templates'
            : 'items (toggle T or S above)';
    if (q || tag || !(showTemplates && showSnippets)) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `(no ${scopeLabel} match)`;
      ul.appendChild(li);
      ul.style.display = '';
    } else {
      ul.style.display = 'none';
    }
    return;
  }
  ul.style.display = '';
  for (const entry of matches) {
    const li = document.createElement('li');
    li.dataset.id = entry.id;
    li.dataset.kind = entry.kind;
    const badge = document.createElement('span');
    badge.className = `palette-kind-badge palette-kind-badge-${entry.kind}`;
    badge.textContent = entry.kind === 'snippet' ? 'S' : 'T';
    badge.title = entry.kind === 'snippet' ? 'Snippet' : 'Template';
    li.appendChild(badge);
    li.appendChild(document.createTextNode(entry.name));
    // Tooltip: description first, body preview otherwise — matches the
    // sidebar + old separate-list behaviour.
    if (entry.description) li.title = entry.description;
    else li.title = (entry.body || '').split('\n').slice(0, 6).join('\n');
    // Hover → swap the Preview pane to this chip's source. Bound late via
    // a live state lookup so an edit in between doesn't show stale text.
    wireChipSourcePreview(li, () => {
      if (entry.kind === 'snippet') {
        const current = state.snippets.find((s) => s.id === entry.id);
        return current ? current.program : entry.body;
      }
      const current = state.templates.find((x) => x.id === entry.id);
      return current ? current.body : entry.body;
    });
    li.addEventListener('click', () => {
      // Drop the filter + restore collapsed sections FIRST so re-renders
      // below operate on the unfiltered list.
      resetPaletteSearchAndSections();
      if (entry.kind === 'template') {
        insertPaletteTemplate(entry.raw);
        return;
      }
      // Snippet: insert the body at the caret (or append at end when
      // the cursor is unknown). Still link "selected snippet" so the
      // pipeline-promotion heuristic in paletteAddToPipeline can spot
      // the case where the program is nothing but this snippet's body;
      // the input listener's drift-check clears the link automatically
      // once the program no longer matches (e.g. after inserting into
      // a non-empty textarea).
      const sn = entry.raw;
      const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
      insertOrAppendIntoPaletteInput(sn.program);
      // Set the selection link BEFORE dispatching input, so the input
      // listener's drift-check sees `program === sn.program` and keeps it.
      paletteSelectedSnippetId = sn.id;
      // Resize BEFORE dispatching input so the overlay's sync reads the
      // final scrollTop for a fully-fitting textarea. Otherwise the sync
      // runs while the textarea is still single-line height and captures
      // a nonzero scroll offset that the later autosize can't clear.
      autosizePaletteInput();
      input.dispatchEvent(new Event('input'));
      // Pre-populate the snippet's declared params; existing rows keep
      // whatever value the user already entered.
      if (sn.params) mergePaletteVars(sn.params);
      renderPaletteLibrary();
      palettePreview();
      input.focus();
    });
    ul.appendChild(li);
  }
}

async function palettePreview() {
  // Don't clobber a hover-source preview. The final `clearChipPreviewFromOutput`
  // call when the mouse leaves will re-invoke palettePreview for a fresh
  // run.
  if (paletteOutputChipHoverDepth > 0) return;
  const program = $('#palette-input').value;
  const out = $('#palette-output');
  out.classList.remove('error');
  const chain = isPalettePipelineMode();
  if (!program.trim() && !chain) {
    out.textContent = '';
    return;
  }
  const src = resolveInput();
  // Preview-line cap only applies to single-input, non-selection
  // previews. In multi-file mode the user has opted into All Tabs
  // processing and a per-file truncation would give a misleading
  // picture. Selection previews already express explicit scope.
  const doTruncate =
    src.kind === 'single' && src.source.kind !== 'selection' && settings.preview.maxLines > 0;
  let truncated = false;
  let original = 0;
  let initialSingle = src.kind === 'single' ? src.input : '';
  if (doTruncate) {
    const t = truncateLines(initialSingle, settings.preview.maxLines);
    initialSingle = t.text;
    truncated = t.truncated;
    original = t.original;
  }
  const token = palettePreviewGuard.claim();

  let cur = initialSingle;
  let firstStep = true;
  // Palette-typed vars override pipeline defaults — explicit user intent
  // wins. For pipeline mode, resolve per step so `pipelineStepVars` and
  // `pipelinePerStepNames` apply; for solo program runs, a flat merge is
  // sufficient since there are no per-step overrides to honor.
  const paletteVars = collectPaletteVars();
  const synthChain = chain
    ? {
        steps: state.pipeline,
        vars: state.pipelineVars,
        stepVars: state.pipelineStepVars,
        perStepNames: state.pipelinePerStepNames,
      }
    : null;
  const soloVars = { ...(chain ? collectPipelineVars() : {}), ...paletteVars };
  if (chain && state.pipeline.length) {
    for (const step of state.pipeline) {
      const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
      const prog = sn ? sn.program : step.program || '';
      const label = stepLabel(step);
      const vars = { ...resolveStepVars(synthChain, step), ...paletteVars };
      const r =
        firstStep && src.kind === 'multi'
          ? await runAwkMulti(prog, src.inputs, vars)
          : await runAwk(prog, cur, vars);
      if (!palettePreviewGuard.isCurrent(token)) return;
      // Hover may have started mid-flight; don't write over the chip preview.
      if (paletteOutputChipHoverDepth > 0) return;
      if (r.stderr) {
        out.classList.add('error');
        out.textContent = `[error in pipeline step "${label}"]\n${r.stderr}`;
        appendSafetyChangeSettingIfBlocked(out, r.stderr, () =>
          openSettingsDialog({ scrollTo: 'set-safety-forbidden-row' }),
        );
        return;
      }
      cur = r.stdout;
      firstStep = false;
    }
  }

  if (program.trim()) {
    const r =
      firstStep && src.kind === 'multi'
        ? await runAwkMulti(program, src.inputs, soloVars)
        : await runAwk(program, cur, soloVars);
    if (!palettePreviewGuard.isCurrent(token)) return;
    if (paletteOutputChipHoverDepth > 0) return;
    if (r.stderr) {
      out.classList.add('error');
      out.textContent = r.stderr;
      appendSafetyChangeSettingIfBlocked(out, r.stderr, () =>
        openSettingsDialog({ scrollTo: 'set-safety-forbidden-row' }),
      );
      return;
    }
    cur = r.stdout;
    firstStep = false;
  }
  if (paletteOutputChipHoverDepth > 0) return;
  const note = truncated
    ? `\n[preview limited to first ${settings.preview.maxLines} of ${original} input lines]`
    : '';
  out.textContent = cur + note;
}

async function paletteApply() {
  const program = $('#palette-input').value.trim();
  const chain = isPalettePipelineMode();
  if (!program && !(chain && state.pipeline.length)) {
    // Guide the user to a next action instead of silently swallowing
    // the click. A visible filter match with nothing typed in the awk
    // field looks like "ready to apply" — the toast disambiguates.
    // Focus the program textarea so the user can start typing (or use
    // the filter field above to browse snippets) without re-reaching
    // for the mouse.
    showToast({
      title: 'Nothing to run',
      body: 'Enter an awk program, or search then select one.',
      level: 'info',
      duration: 3500,
    });
    const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
    input.focus();
    return;
  }

  const src = resolveInput();
  let cur = src.kind === 'single' ? src.input : '';
  let firstStep = true;
  const paletteVars = collectPaletteVars();
  const synthChain = chain
    ? {
        steps: state.pipeline,
        vars: state.pipelineVars,
        stepVars: state.pipelineStepVars,
        perStepNames: state.pipelinePerStepNames,
      }
    : null;
  const soloVars = { ...(chain ? collectPipelineVars() : {}), ...paletteVars };

  if (chain && state.pipeline.length) {
    for (const step of state.pipeline) {
      const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
      if (step.snippetId && !sn) {
        showToast({ title: 'Missing snippet in pipeline step' });
        return;
      }
      const prog = sn ? sn.program : step.program || '';
      const label = stepLabel(step);
      const vars = { ...resolveStepVars(synthChain, step), ...paletteVars };
      const { stdout, stderr } =
        firstStep && src.kind === 'multi'
          ? await runAwkMulti(prog, src.inputs, vars)
          : await runAwk(prog, cur, vars);
      if (stderr) {
        showToast({ title: `awk error in pipeline step "${label}"`, body: stderr });
        return;
      }
      cur = stdout;
      firstStep = false;
    }
  }

  if (program) {
    const { stdout, stderr } =
      firstStep && src.kind === 'multi'
        ? await runAwkMulti(program, src.inputs, soloVars)
        : await runAwk(program, cur, soloVars);
    if (stderr) {
      showToast({ title: 'awk error', body: stderr });
      return;
    }
    cur = stdout;
    firstStep = false;
  }

  writeOutput(src.sink, cur, {
    title:
      src.source.kind === 'allTabs'
        ? `Results: palette × ${src.source.count} tabs`
        : 'Results: palette',
  });
  // Record a successful Apply. Empty programs in pure pipeline-mode runs
  // (where the pipeline does all the work) are skipped — nothing to
  // recall. The paletteVars here are the user's `-v` values; history
  // preserves them so a restore re-populates the form exactly.
  if (program) {
    pushPaletteHistoryEntry({
      program,
      vars: collectPaletteVars(),
      name: /** @type {HTMLInputElement} */ ($('#palette-step-name')).value.trim() || undefined,
      mode: 'apply',
    });
  }
  closePalette();
}

function paletteSaveAsSnippet() {
  const program = $('#palette-input').value.trim();
  const nameInput = /** @type {HTMLInputElement} */ ($('#palette-step-name'));
  const name = nameInput.value.trim();
  if (!program) {
    appAlert('Type an awk program first.');
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')).focus();
    return;
  }
  if (!name) {
    appAlert('Enter a name in the step-name field above to save as a snippet.', { level: 'error' });
    nameInput.focus();
    return;
  }
  if (state.snippets.some((s) => s.name === name)) {
    appAlert(`A snippet named "${name}" already exists. Pick a different name.`, {
      title: 'Name in use',
      level: 'error',
    });
    nameInput.focus();
    return;
  }
  const snippet = { id: uid(), name, program };
  const params = cleanParams(paletteVars);
  if (params.length) snippet.params = params;
  state.snippets.push(snippet);
  saveState();
  dispatch('library:snippets-changed');
  renderPaletteLibrary();
  appAlert(`Saved snippet "${name}".`, { level: 'info', duration: 2500 });
  // Reset the palette so the user can start the next one cleanly — mirrors
  // the pipeline-mode Add-to-pipeline clear behavior.
  paletteClear();
  // Draw the user's eye to the newly-created row so the save is visible at
  // a glance. paletteClear re-rendered suggestions; the post-clear filter
  // is the empty query, so every snippet is in the DOM.
  highlightPaletteRow('#palette-library', snippet.id);
}

function paletteSaveAsTemplate() {
  const body = $('#palette-input').value;
  const nameInput = /** @type {HTMLInputElement} */ ($('#palette-step-name'));
  const name = nameInput.value.trim();
  if (!body.trim()) {
    appAlert('Type an awk program first.');
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')).focus();
    return;
  }
  if (!name) {
    appAlert('Enter a name in the step-name field above to save as a template.', {
      level: 'error',
    });
    nameInput.focus();
    return;
  }
  if (state.templates.some((t) => t.name === name)) {
    appAlert(`A template named "${name}" already exists. Pick a different name.`, {
      title: 'Name in use',
      level: 'error',
    });
    nameInput.focus();
    return;
  }
  const template = { id: uid(), name, body };
  state.templates.push(template);
  saveState();
  dispatch('library:templates-changed');
  renderPaletteLibrary();
  appAlert(`Saved template "${name}".`, { level: 'info', duration: 2500 });
  // Match "Save as snippet" ergonomics: clear the palette so the next
  // exploration starts fresh, then draw attention to the new row.
  paletteClear();
  highlightPaletteRow('#palette-library', template.id);
}

/**
 * Scroll a row keyed by `data-id` into view in the given `<ul>` and briefly
 * flash it with the `pulse-success` keyframe. No-op if the row isn't in the
 * DOM (e.g. filtered out by the current palette-input query).
 *
 * @param {string} ulSelector    e.g. '#palette-library' or '#palette-history'
 * @param {string} id            row's snippet/template id
 */
function highlightPaletteRow(ulSelector, id) {
  const ul = $(ulSelector);
  if (!ul) return;
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  const li = /** @type {HTMLElement | null} */ (ul.querySelector(`li[data-id="${safeId}"]`));
  if (!li) return;
  li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  li.classList.remove('pulse-success');
  // Force reflow so re-adding the class restarts the animation even if the
  // user saves twice in quick succession.
  void li.offsetWidth;
  li.classList.add('pulse-success');
  setTimeout(() => li.classList.remove('pulse-success'), 1300);
}

function paletteAddToPipeline() {
  const program = $('#palette-input').value.trim();
  if (!program) {
    appAlert('Type an awk program first.');
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')).focus();
    return;
  }
  const stepName = /** @type {HTMLInputElement} */ ($('#palette-step-name')).value.trim();
  const params = cleanParams(paletteVars);
  // Auto-promote to a snippet-ref only when the user hasn't typed a step
  // name or added vars — those signal "this step is distinct from any
  // existing snippet's shape." Resolution order:
  //   1. If they clicked a Snippets-list suggestion AND the program still
  //      matches that snippet's body, link to *that* snippet's id —
  //      preserves user intent when several snippets share the same body
  //      (clones, recreations).
  //   2. Otherwise, only promote when exactly one snippet's program matches.
  //      Multiple matches are ambiguous; fall through to inline so the
  //      pipeline doesn't quietly point at the wrong snippet.
  let match = null;
  if (!stepName && !params.length) {
    if (paletteSelectedSnippetId) {
      const selected = state.snippets.find((s) => s.id === paletteSelectedSnippetId);
      if (selected && selected.program.trim() === program) match = selected;
    }
    if (!match) {
      const programMatches = state.snippets.filter((s) => s.program.trim() === program);
      if (programMatches.length === 1) match = programMatches[0];
    }
  }
  if (match) {
    addPipelineStep({ id: uid(), snippetId: match.id });
  } else {
    /** @type {any} */
    const step = { id: uid(), program };
    if (stepName) {
      step.name = stepName;
    } else {
      // Inline step the user didn't name. If the program came from a
      // snippet they clicked (selection link still valid), or it's
      // verbatim a unique snippet, borrow that name so the pipeline shows
      // "CSV Column (inline)" rather than a bare "(inline)". With multiple
      // matching snippets we don't guess.
      const linked = paletteSelectedSnippetId
        ? state.snippets.find((s) => s.id === paletteSelectedSnippetId)
        : null;
      if (linked && linked.program.trim() === program) {
        step.name = linked.name;
      } else {
        const programMatches = state.snippets.filter((s) => s.program.trim() === program);
        if (programMatches.length === 1) step.name = programMatches[0].name;
      }
    }
    if (params.length) step.params = params;
    addPipelineStep(step);
  }
  // Record the Add-to-pipeline in history. Done before paletteClear()
  // wipes the form in pipeline mode, or before closePalette() in normal mode.
  pushPaletteHistoryEntry({
    program,
    vars: collectPaletteVars(),
    name: stepName || undefined,
    mode: 'pipe',
  });
  if (isPalettePipelineMode()) {
    paletteClear();
    updatePalettePipelineCount();
    palettePreview();
  } else {
    closePalette();
  }
}

/**
 * Reset the palette's editable fields — program, step name, variables, and
 * the preview pane. Leaves pipeline mode, reference visibility, and the
 * pipeline itself untouched since those are separate user preferences /
 * state. Focuses the program input so the user can start typing again.
 */
function paletteClear() {
  const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
  // Preserve undo so Ctrl+Z recovers the program a user just committed
  // via Apply / Add-to-pipeline / Save-as-snippet — "oh, I wanted to
  // tweak that last one" is the obvious need. Only the palette-open
  // reset (below, in openPalette) uses direct `.value = ''` to start
  // the stack fresh for a new session.
  editTextRange(input, 0, input.value.length, '');
  /** @type {HTMLInputElement} */ ($('#palette-step-name')).value = '';
  paletteVars = [];
  paletteSelectedSnippetId = null;
  renderPaletteVars();
  $('#palette-output').textContent = '';
  $('#palette-output').classList.remove('error');
  input.dispatchEvent(new Event('input'));
  autosizePaletteInput();
  renderPaletteLibrary();
  input.focus();
}

function palettePopLast() {
  if (!state.pipeline.length) return;
  state.pipeline.pop();
  if (state.activeStep !== null && state.activeStep >= state.pipeline.length) {
    state.activeStep = state.pipeline.length ? state.pipeline.length - 1 : null;
  }
  renderPipeline();
  updatePalettePipelineCount();
  palettePreview();
}

/**
 * Rewrite the palette textarea's placeholder to match the current
 * "Enter in command palette applies and closes" setting. Called on
 * setup and whenever settings save, so the hint always describes the
 * active binding.
 */
function refreshPalettePlaceholder() {
  const ta = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById('palette-input')
  );
  if (!ta) return;
  const enterApplies = !!settings.editor.paletteEnterApplies;
  ta.placeholder = enterApplies
    ? 'awk program (Enter = apply, Shift+Enter = newline)'
    : 'awk program (Ctrl+Enter = apply, Enter = newline)';
}

export function setupPaletteWiring() {
  refreshPalettePlaceholder();
  on('settings-saved', refreshPalettePlaceholder);
  $('#palette-input').addEventListener('input', () => {
    autosizePaletteInput();
    schedulePaletteDebounced();
    // Drop the "selected snippet" link as soon as the program text drifts
    // from the snippet body the user clicked. The `input` event also fires
    // synchronously when a suggestion-click sets the value to the snippet's
    // body; in that case `program === selected.program`, so the link
    // survives.
    if (paletteSelectedSnippetId) {
      const selected = state.snippets.find((s) => s.id === paletteSelectedSnippetId);
      const program = $('#palette-input').value;
      if (!selected || selected.program !== program) paletteSelectedSnippetId = null;
    }
  });
  $('#palette-search').addEventListener('input', () => {
    renderPaletteLibrary();
    renderPaletteHistory();
    autoExpandFilteredPaletteSections();
  });
  $('#palette-search-clear').addEventListener('click', () => {
    $('#palette-search').value = '';
    renderPaletteLibrary();
    renderPaletteHistory();
    autoExpandFilteredPaletteSections();
    $('#palette-search').focus();
  });
  // Var edits should bubble up through the params-list inputs; re-preview
  // after the user types into any var row.
  $('#palette-vars-list').addEventListener('input', schedulePaletteDebounced);
  $('#palette-add-var').addEventListener('click', (e) => {
    e.preventDefault();
    paletteVars.push({ name: '', default: '' });
    renderPaletteVars();
    /** @type {HTMLDetailsElement} */ (document.querySelector('.palette-vars')).open = true;
    // Focus the new row's name input so the user can start typing.
    const rows = $('#palette-vars-list').querySelectorAll('input.param-name');
    /** @type {HTMLInputElement|undefined} */
    const last = rows[rows.length - 1];
    if (last) last.focus();
    // Fire a preview — an empty row doesn't change the vars map yet,
    // so the preview is effectively unchanged, but keeps mutation
    // feedback consistent with the ✕ / edit paths.
    schedulePaletteDebounced();
  });

  // Wipe every variable row. No confirm — single click to restore via the
  // per-row ✕ was already the UX, and Ctrl-click-through-many-templates
  // ergonomics ask for fast reset rather than safety dialogs.
  $('#palette-vars-clear').addEventListener('click', (e) => {
    e.preventDefault();
    if (!paletteVars.length) return;
    paletteVars = [];
    renderPaletteVars();
    schedulePaletteDebounced();
  });

  // Scan the current awk program for identifiers that look like `-v`
  // candidates (see `findCandidateVars`) and add rows for any that aren't
  // already present. Used after manually typing a program to avoid adding
  // vars by hand; likewise useful after editing a template's body to pick
  // up newly-referenced names.
  $('#palette-vars-detect').addEventListener('click', (e) => {
    e.preventDefault();
    const program = /** @type {HTMLTextAreaElement} */ ($('#palette-input')).value;
    const detected = findCandidateVars(program).map((name) => ({ name, default: '' }));
    const added = mergePaletteVars(detected);
    if (added) schedulePaletteDebounced();
    else {
      showToast({
        title: 'No new variables detected',
        body: detected.length
          ? 'Every inferred variable is already in the list.'
          : 'Couldn\u2019t find any `-v` candidates in the current program.',
        level: 'info',
        duration: 3500,
      });
    }
  });
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      // Ctrl+Enter / Cmd+Enter is always the "force-apply" shortcut —
      // works whether the "Enter applies" setting is on or off. Matches
      // the settings-dialog tooltip's "…use the Apply button or
      // Ctrl+Enter to run" promise, and gives a consistent muscle-
      // memory shortcut regardless of the user's preference.
      e.preventDefault();
      paletteApply();
    } else if (!e.shiftKey && settings.editor.paletteEnterApplies) {
      e.preventDefault();
      paletteApply();
    }
    // Otherwise fall through: Shift+Enter always inserts a newline;
    // bare Enter inserts a newline when paletteEnterApplies is off.
  });
  $('#palette-apply').addEventListener('click', paletteApply);
  $('#palette-cancel').addEventListener('click', closePalette);
  $('#palette-save').addEventListener('click', paletteSaveAsSnippet);
  $('#palette-save-template').addEventListener('click', paletteSaveAsTemplate);
  $('#palette-pipe').addEventListener('click', paletteAddToPipeline);
  $('#palette-advanced-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    togglePaletteAdvanced();
  });
  $('#palette-ref-toggle').addEventListener('click', () => {
    const inner = $('#palette .palette-inner');
    const nowShown = !inner.classList.contains('with-ref');
    inner.classList.toggle('with-ref', nowShown);
    $('#palette-ref-toggle').textContent = nowShown ? 'Hide reference' : 'Show reference';
    safeSetItem(LS_KEYS.PALETTE_REF_SHOWN, nowShown ? '1' : '0');
  });
  $('#palette-pipeline-mode').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('#palette .palette-inner').classList.toggle('pipeline-mode-on', on);
    safeSetItem(LS_KEYS.PALETTE_PIPELINE, on ? '1' : '0');
    updatePalettePipelineCount();
    clearTimeout(paletteDebounce);
    paletteDebounce = null;
    palettePreview();
  });
  $('#palette-pop-last').addEventListener('click', palettePopLast);
  // Copy I/O settings from the current pipeline's steps into this palette
  // program's BEGIN block. Only meaningful in pipeline mode — the palette
  // program runs after every pipeline step, so "preceding steps" = the
  // full pipeline. CSS hides the button when pipeline mode is off.
  $('#palette-copy-io').addEventListener('click', (e) => {
    e.preventDefault();
    copyIoSettingsFromSteps(
      /** @type {HTMLTextAreaElement} */ ($('#palette-input')),
      state.pipeline,
    );
    autosizePaletteInput();
    clearTimeout(paletteDebounce);
    paletteDebounce = setTimeout(palettePreview, 180);
  });

  // Persist user expand preference for each palette list section. The
  // `toggle` event fires on any open/close — user-initiated AND
  // programmatic — so we gate on `suppressSectionPersist` to skip the
  // filter's auto-expand and the chip-click restore. Without the gate,
  // the filter's force-open on a collapsed section would rewrite the
  // stored preference the moment the user started typing. Store '1' for
  // expanded so the affirmative-polarity LS key reads cleanly.
  for (const key of ['library', 'history']) {
    const det = /** @type {HTMLDetailsElement | null} */ ($('#palette-section-' + key));
    if (!det) continue;
    det.addEventListener('toggle', () => {
      if (suppressSectionPersist > 0) return;
      safeSetItem(LS_KEYS.paletteSectionExpanded(key), det.open ? '1' : '0');
    });
  }

  // Templates list is click-driven via `insertPaletteTemplate` wired in
  // `renderPaletteLibrary` — no separate change handler needed here.

  // Scope toggles (T · Templates / S · Snippets) — flip, persist, re-render.
  // Tag-filter re-renders too because turning a kind off may shrink the
  // set of in-use tags down to the other kind's set (or to zero).
  const wireScopeBtn = (btnId, kind) => {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const cur = readPaletteScope();
      const on = kind === 'templates' ? cur.showTemplates : cur.showSnippets;
      safeSetItem(LS_KEYS.paletteLibraryScope(kind), on ? '0' : '1');
      syncPaletteScopeButtons();
      renderPaletteTagFilter();
      renderPaletteLibrary();
    });
  };
  wireScopeBtn('#palette-scope-templates', 'templates');
  wireScopeBtn('#palette-scope-snippets', 'snippets');

  // "Clear program" — wipe the awk textarea so the user can preview another
  // template from scratch. Mirrors the snippet / inline-step dialogs: honours
  // `settings.editor.confirmClearProgram`, undo-preserving via editTextRange.
  // Variables and step-name are left alone — a user cycling through templates
  // with the same vars shouldn't lose them.
  $('#palette-program-clear').addEventListener('click', async (e) => {
    e.preventDefault();
    const input = /** @type {HTMLTextAreaElement} */ ($('#palette-input'));
    if (!input.value) {
      input.focus();
      return;
    }
    if (settings.editor.confirmClearProgram) {
      const ok = await appConfirm('Clear the awk program?', {
        title: 'Clear program',
        danger: true,
        okLabel: 'Clear',
      });
      if (!ok) return;
    }
    editTextRange(input, 0, input.value.length, '');
    autosizePaletteInput();
    renderPaletteLibrary();
    clearTimeout(paletteDebounce);
    paletteDebounce = setTimeout(palettePreview, 180);
    input.focus();
  });

  wireDetectFsButton(
    $('#palette-detect-fs'),
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')),
  );
  wireColumnsButton(
    $('#palette-columns'),
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')),
  );
  wireFpatButton(
    $('#palette-fpat'),
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')),
  );
  wireStrftimeButton(
    $('#palette-strftime'),
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')),
  );
  wireFormatButton(
    /** @type {HTMLButtonElement} */ ($('#palette-format')),
    /** @type {HTMLTextAreaElement} */ ($('#palette-input')),
  );

  // "Clear history" button in the History section summary. Stops the
  // click from bubbling into the `<summary>`'s native toggle, and asks
  // before wiping — destructive and irreversible.
  $('#palette-history-clear').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!loadPaletteHistory().length) return;
    if (settings.editor.confirmClearHistory !== false) {
      const ok = await appConfirm('Clear palette history?', {
        title: 'Clear history',
        danger: true,
        okLabel: 'Clear',
      });
      if (!ok) return;
    }
    savePaletteHistory([]);
    renderPaletteHistory();
  });

  // Keep the library list + tag filter fresh when either library
  // changes. The combined chip list depends on both state.snippets and
  // state.templates, so both -changed events route into the same refresh.
  on('library:snippets-changed', () => {
    renderPaletteTagFilter();
    renderPaletteLibrary();
  });
  on('library:templates-changed', () => {
    renderPaletteTagFilter();
    renderPaletteLibrary();
  });
  on('pipeline:snippets-changed', renderPaletteLibrary);
  on('pipeline:chains-changed', updatePalettePipelineCount);
  // The pipeline can be edited (step deleted, reordered, etc.) while the
  // palette is open, which would leave the cumulative preview stale —
  // re-run it (debounced) and refresh the step count whenever the
  // pipeline's shape changes.
  on('pipeline:steps-changed', () => {
    if (!isPaletteOpen()) return;
    updatePalettePipelineCount();
    schedulePaletteDebounced();
  });
  // A flip of the Input toggle (Current Tab ↔ All Tabs) or a selection
  // appearing/clearing changes what the next palette run would process,
  // so re-run the preview when it happens. Gated on open-state because
  // the palette's preview only has meaning while the dialog is visible;
  // the debounce inside `schedulePaletteDebounced` + the staleness
  // guard inside `palettePreview` are the "rules preventing updates"
  // that still apply — a fast toggle sequence collapses to one rerun.
  on('input-mode:changed', () => {
    if (!isPaletteOpen()) return;
    schedulePaletteDebounced();
  });
}
