// @ts-check
// Runner — Ctrl+O modal that lets the user pick a snippet OR chain by
// name and run it against the current selection. A simpler sibling of
// the Ctrl+K command palette: no inline program editing, no history —
// just typeahead → Enter → run.
//
// Two chips (Snippets / Chains) scope the list; the active scope is
// persisted in `settings.ui.runnerScope` so repeat opens land on the
// user's preferred mix. Each row carries a tiny SN / CH tag so the two
// kinds are visually distinct even when their names overlap.

import { $, showToast, editTextRange, pulseSidebarRow } from './core.js';
import {
  state,
  stepLabel,
  planChainVarsPrompt,
  applyChainPromptAnswers,
  resolveStepVars,
} from './state.js';
import { getSel, writeOutput, normalizeAwkOutput } from './editor.js';
import { runAwk, runAwkMulti } from './awk.js';
import { settings, saveSettings } from './settings.js';
import { promptForVars } from './dialogs.js';
import { resolveInput } from './inputMode.js';

/**
 * @typedef {import('./types.js').Snippet} Snippet
 * @typedef {import('./types.js').Chain} Chain
 * @typedef {{ kind: 'snippet', item: Snippet } | { kind: 'chain', item: Chain }} RunnerRow
 */

let wired = false;
let highlighted = 0;
/** @type {RunnerRow[]} */
let rows = [];

/**
 * Session-scoped "keep open after run" toggle. Reset to false every time
 * the dialog opens — intentionally not persisted to settings. The usage
 * pattern is "sometimes I want to fire several in a row right now",
 * which is a session thing, not a workflow preference. A persisted
 * setting would leave the Runner stuck in multi-run mode across
 * sessions, which is harder to notice and recover from than "click the
 * pin again tomorrow."
 *
 * Toggled by the pin button in the header; Shift+Enter ALSO keeps the
 * dialog open for a single run without needing the pin latched.
 */
let keepOpen = false;

/**
 * How the dialog runs the chosen item:
 * - 'apply'  (Ctrl+O)       — feed the selection in, replace the selection
 *                              with stdout. Mirrors sidebar click behavior.
 * - 'insert' (Ctrl+Shift+O) — ignore the selection as input (target = ''),
 *                              insert stdout at the cursor. Mirrors sidebar
 *                              Ctrl+click behavior.
 * @type {'apply' | 'insert'}
 */
let mode = 'apply';

/**
 * Selection snapshot captured at open time. The dialog's showModal() moves
 * focus away from the editor and, on some browsers, collapses the visible
 * textarea selection — so we record the range up front and feed it straight
 * to runAwk/editTextRange after the dialog closes.
 * @type {{ s: number, e: number, hasSel: boolean, target: string } | null}
 */
let savedSel = null;

/**
 * Snapshot of the *effective input source* at dialog-open time. Captures
 * the input-mode toggle's decision (Current Tab / All Tabs / selection)
 * plus the sink, so apply-mode runs can route to the right destination
 * (selection replace / tab replace / new output tab) after the modal
 * round-trip. Null until the Runner is opened.
 * @type {import('./inputMode.js').ResolvedInput | null}
 */
let savedSrc = null;

/**
 * Resolve the current scope. Falls back to 'both' when settings is
 * missing the key (fresh install, or the old pre-Runner library).
 * @returns {'both' | 'snippets' | 'chains'}
 */
function currentScope() {
  const v = settings.ui?.runnerScope;
  return v === 'snippets' || v === 'chains' ? v : 'both';
}

function setScope(next) {
  if (!settings.ui) return;
  settings.ui.runnerScope = next;
  saveSettings();
}

function sortedRows() {
  const scope = currentScope();
  /** @type {RunnerRow[]} */
  const out = [];
  if (scope !== 'chains') {
    for (const sn of state.snippets) out.push({ kind: 'snippet', item: sn });
  }
  if (scope !== 'snippets') {
    for (const ch of state.chains) out.push({ kind: 'chain', item: ch });
  }
  // Favorites surface first; then alphabetical, case-insensitive.
  return out.sort((a, b) => {
    const af = !!a.item.favorite;
    const bf = !!b.item.favorite;
    if (af !== bf) return af ? -1 : 1;
    return a.item.name.localeCompare(b.item.name, undefined, { sensitivity: 'base' });
  });
}

function filterRows(q) {
  const all = sortedRows();
  if (!q) return all;
  const needle = q.toLowerCase();
  return all.filter((r) => r.item.name.toLowerCase().includes(needle));
}

function renderChips() {
  const scope = currentScope();
  const snippetsBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('runner-chip-snippets')
  );
  const chainsBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('runner-chip-chains')
  );
  const snippetsOn = scope !== 'chains';
  const chainsOn = scope !== 'snippets';
  if (snippetsBtn) {
    snippetsBtn.classList.toggle('active', snippetsOn);
    snippetsBtn.setAttribute('aria-pressed', snippetsOn ? 'true' : 'false');
  }
  if (chainsBtn) {
    chainsBtn.classList.toggle('active', chainsOn);
    chainsBtn.setAttribute('aria-pressed', chainsOn ? 'true' : 'false');
  }
}

function renderDropdown() {
  const input = /** @type {HTMLInputElement} */ ($('#runner-input'));
  const dropdown = /** @type {HTMLUListElement} */ ($('#runner-dropdown'));
  rows = filterRows(input.value.trim());
  if (highlighted >= rows.length) highlighted = 0;
  dropdown.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'runner-empty muted';
    li.textContent = 'No matches';
    dropdown.appendChild(li);
    return;
  }
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'runner-item';
    if (i === highlighted) li.classList.add('highlighted');
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);

    const tag = document.createElement('span');
    tag.className = `runner-tag runner-tag-${row.kind}`;
    tag.textContent = row.kind === 'snippet' ? 'S' : 'C';
    tag.title = row.kind === 'snippet' ? 'Snippet' : 'Chain';
    li.appendChild(tag);

    const name = document.createElement('span');
    name.className = 'runner-name';
    name.textContent = row.item.name;
    li.appendChild(name);

    const description = /** @type {any} */ (row.item).description;
    if (description) {
      const desc = document.createElement('span');
      desc.className = 'runner-desc muted';
      desc.textContent = description;
      li.appendChild(desc);
    }

    // A click on a dropdown row is treated as a selection — it runs
    // immediately instead of populating the input. Shift-click mirrors
    // Shift+Enter (one keep-open run without latching the pin).
    // `mousedown` is preventDefaulted so focus doesn't shift to the <li>
    // before the click lands; the actual run fires on `click`.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      highlighted = i;
      updateHighlight();
    });
    li.addEventListener('click', (e) => {
      e.preventDefault();
      highlighted = i;
      runHighlighted({ keepOpenOverride: e.shiftKey });
    });
    li.addEventListener('mouseenter', () => {
      highlighted = i;
      updateHighlight();
    });
    dropdown.appendChild(li);
  });
}

function updateHighlight() {
  const items = document.querySelectorAll('#runner-dropdown .runner-item');
  items.forEach((el, i) => el.classList.toggle('highlighted', i === highlighted));
  const hl = /** @type {HTMLElement | undefined} */ (items[highlighted]);
  if (hl) hl.scrollIntoView({ block: 'nearest' });
}

/**
 * @param {{ keepOpenOverride?: boolean }} [opts]
 *   `keepOpenOverride: true` forces keep-open for this single run even if
 *   the pin is off — used by Shift+Enter to avoid a "latch the pin" step
 *   when the user only wants one extra run queued up.
 */
async function runHighlighted(opts = {}) {
  const input = /** @type {HTMLInputElement} */ ($('#runner-input'));
  let row = rows[highlighted];
  if (!row) {
    // Fallback: exact name match against typed text, preferring snippets
    // when a snippet and chain share a name (unlikely but possible).
    const typed = input.value.trim().toLowerCase();
    if (typed) {
      const scope = currentScope();
      if (scope !== 'chains') {
        const sn = state.snippets.find((s) => s.name.toLowerCase() === typed);
        if (sn) row = { kind: 'snippet', item: sn };
      }
      if (!row && scope !== 'snippets') {
        const ch = state.chains.find((c) => c.name.toLowerCase() === typed);
        if (ch) row = { kind: 'chain', item: ch };
      }
    }
  }
  if (!row) {
    showToast({
      title: `No ${scopeNoun(currentScope())} named "${input.value.trim()}"`,
      level: 'error',
      duration: 2500,
    });
    return;
  }
  const stayOpen = !!(keepOpen || opts.keepOpenOverride);
  const snap = savedSel;
  const snapSrc = savedSrc;
  const runMode = mode;

  // The dialog is ALWAYS closed before the run commits. While it's open
  // modally, every element outside it (including `#editor`) is `inert`,
  // so `editTextRange` can't refocus the editor — `execCommand('insertText')`
  // then falls through to the currently-focused element, which is
  // `#runner-input`, and the output ends up in the dialog's text field.
  // Closing releases the modal inertness; for keep-open we reopen after
  // the write lands.
  const wasPinned = keepOpen;
  closeRunner();

  const runP =
    row.kind === 'snippet'
      ? runSnippetWithSnapshot(row.item, snap, runMode, snapSrc)
      : runChainWithSnapshot(row.item, snap, runMode, snapSrc);

  if (!stayOpen) {
    // Final close path: await the write, then collapse the output-
    // range selection to a caret at its end. writeRunnerOutput's
    // re-select (done so keep-open streaks can chain) would otherwise
    // linger as a highlighted range after the dialog is gone. Match
    // the pre-reselect default: caret immediately after the last
    // character of the transformation.
    await runP;
    const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
    ed.setSelectionRange(ed.selectionEnd, ed.selectionEnd);
    return;
  }

  // Keep-open path: await the write so we can re-snapshot the (shifted)
  // selection before reopening, then reopen with pin state preserved.
  // Selection stays spanning the output so a follow-up run in the
  // streak chains off the transformation.
  await runP;
  savedSel = getSel();
  // Re-resolve the input-mode decision too: a multi-file run would
  // have dropped output into a new tab, and `savedSrc` must reflect
  // the NEW active tab's content for the next run in the streak,
  // not the tabs that were gathered a moment ago.
  savedSrc = resolveInput();
  reopenRunnerAfterRun(wasPinned);
}

/**
 * Reopen the Runner after a keep-open run committed. Preserves the pin
 * state (so a pinned streak stays pinned until the user unpins or Escs)
 * and resets transient UI (input empty, highlight at top) for the next
 * run. `savedSel` is re-snapshotted upstream in runHighlighted; we
 * explicitly DON'T call openRunner() because that would re-read the
 * selection before the previous write had registered on some browsers.
 *
 * @param {boolean} wasPinned
 */
function reopenRunnerAfterRun(wasPinned) {
  const dlg = /** @type {HTMLDialogElement} */ ($('#runner'));
  if (dlg.open) return;
  keepOpen = wasPinned;
  reflectPin();
  reflectMode();
  renderChips();
  const input = /** @type {HTMLInputElement} */ ($('#runner-input'));
  input.value = '';
  highlighted = 0;
  dlg.showModal();
  renderDropdown();
  requestAnimationFrame(() => input.focus());
}

function scopeNoun(scope) {
  if (scope === 'snippets') return 'snippet';
  if (scope === 'chains') return 'chain';
  return 'snippet or chain';
}

/**
 * Run a snippet against the snapshot captured at dialog-open time.
 * - `runMode === 'insert'`: always empty-input (input-mode ignored;
 *   the user explicitly asked for a BEGIN-block run at the cursor).
 * - `runMode === 'apply'` + multi-file src: real awk multi-file via
 *   `runAwkMulti`, output to a new read-only tab.
 * - `runMode === 'apply'` + single src: classic stdin run, output to
 *   selection / active tab per the src's sink.
 * @param {Snippet} sn
 * @param {{ s: number, e: number, hasSel: boolean, target: string } | null} snap
 * @param {'apply' | 'insert'} runMode
 * @param {import('./inputMode.js').ResolvedInput | null} [src]
 */
async function runSnippetWithSnapshot(sn, snap, runMode, src) {
  const vars = await ensureSnippetVars(sn);
  if (vars === null) return;
  const sel = snap || getSel();
  if (runMode === 'apply' && src && src.kind === 'multi') {
    const { stdout, stderr } = await runAwkMulti(sn.program, src.inputs, vars);
    if (stderr) {
      showToast({ title: `awk error in "${sn.name}"`, body: stderr });
      pulseSidebarRow('snippets', sn.id);
      return;
    }
    writeOutput(src.sink, stdout, {
      title: `Results: ${sn.name} × ${src.source.kind === 'allTabs' ? src.source.count : 0} tabs`,
    });
    return;
  }
  const input = runMode === 'insert' ? '' : sel.target;
  const { stdout, stderr } = await runAwk(sn.program, input, vars);
  if (stderr) {
    showToast({ title: `awk error in "${sn.name}"`, body: stderr });
    pulseSidebarRow('snippets', sn.id);
    return;
  }
  writeRunnerOutput(sel, runMode, stdout);
}

/**
 * Run a chain end-to-end against the selection captured at dialog-open
 * time. Kept local to avoid pulling `library.js` (and its sidebar-render
 * graph) into this module; mirrors `library.js#runChainOnSelection` /
 * `runChainAtCursor` but reads from a snapshot instead of re-querying the
 * editor after the dialog round-trip.
 *
 * @param {Chain} chain
 * @param {{ s: number, e: number, hasSel: boolean, target: string } | null} snap
 * @param {'apply' | 'insert'} runMode
 */
async function runChainWithSnapshot(chain, snap, runMode, src) {
  const getVars = await ensureChainVars(chain);
  if (getVars === null) return;
  const sel = snap || getSel();
  // Multi-file flows through step 1 only (real FILENAME / FNR); later
  // steps see a single concatenated stream. Insert mode ignores the
  // input-mode toggle entirely — user explicitly requested empty input.
  const isMulti = runMode === 'apply' && src && src.kind === 'multi';
  let cur = '';
  if (runMode !== 'insert') cur = isMulti ? '' : sel.target;
  let firstStep = true;
  for (const step of chain.steps) {
    if (step.disabled) continue;
    const sn = step.snippetId
      ? state.snippets.find((s) => s.id === step.snippetId)
      : null;
    if (step.snippetId && !sn) {
      showToast({ title: `Missing snippet in chain "${chain.name}"` });
      pulseSidebarRow('chains', chain.id);
      return;
    }
    const prog = sn ? sn.program : step.program || '';
    const label = stepLabel(step);
    const vars = getVars(step);
    const { stdout, stderr } =
      firstStep && isMulti
        ? await runAwkMulti(prog, src.inputs, vars)
        : await runAwk(prog, cur, vars);
    if (stderr) {
      showToast({
        title: `Error in chain "${chain.name}" step "${label}"`,
        body: stderr,
      });
      pulseSidebarRow('chains', chain.id);
      return;
    }
    cur = stdout;
    firstStep = false;
  }
  if (isMulti) {
    writeOutput(src.sink, cur, {
      title: `Results: ${chain.name} × ${src.source.kind === 'allTabs' ? src.source.count : 0} tabs`,
    });
    return;
  }
  writeRunnerOutput(sel, runMode, cur);
}

function writeRunnerOutput(sel, runMode, stdout) {
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  // Apply the trailing-newline setting at the final write, consistent
  // with every other awk-output sink (see editor.js#writeOutput).
  const text = normalizeAwkOutput(stdout);
  // Track where the write lands so we can re-select the inserted region
  // afterwards. execCommand('insertText') collapses the selection at the
  // end of the inserted text by default; we want the whole output
  // selected so a follow-up run (Runner's keep-open streak, or a
  // manual re-apply) operates on the transformation's result instead
  // of an empty selection at the end of it.
  let start;
  if (runMode === 'insert') {
    start = sel.s;
    editTextRange(ed, sel.s, sel.e, text);
  } else if (sel.hasSel) {
    start = sel.s;
    editTextRange(ed, sel.s, sel.e, text);
  } else {
    start = 0;
    editTextRange(ed, 0, ed.value.length, text);
  }
  // editTextRange focuses the editor and commits via execCommand, which
  // leaves selectionStart === selectionEnd at the end of the write. Re-
  // span the selection to cover the full output. If the editor is inert
  // (the Runner dialog is still modal on the first keep-open iteration —
  // runHighlighted closes the dialog BEFORE calling the run, so by the
  // time we reach this point the modal is released), setSelectionRange
  // still takes effect on the underlying textarea.
  ed.setSelectionRange(start, start + text.length);
}

/**
 * Local copy of `library.js#ensureSnippetVars`. Inlined to avoid pulling
 * library.js (and its sidebar-rendering graph) into this module.
 * @param {Snippet} sn
 * @returns {Promise<Record<string, string> | null>}
 */
async function ensureSnippetVars(sn) {
  const params = sn.params || [];
  if (!params.length) return {};
  const accept = !!settings.pipeline.acceptDefaultsWithoutPrompting;
  /** @type {Record<string, string>} */
  const resolved = {};
  /** @type {import('./types.js').Param[]} */
  const needsPrompting = [];
  /** @type {Record<string, string>} */
  const initialValues = {};
  for (const p of params) {
    initialValues[p.name] = p.default ?? '';
    if (accept && p.default !== undefined && p.default !== '') {
      resolved[p.name] = p.default;
    } else {
      needsPrompting.push(p);
    }
  }
  if (accept && !needsPrompting.length) return resolved;
  const hidden = accept ? new Set(Object.keys(resolved)) : new Set();
  const values = await promptForVars(params, initialValues, {
    hidden,
    saveAsChainSnippet: sn,
  });
  if (values === null) return null;
  return { ...resolved, ...values };
}

/**
 * Local copy of `library.js#ensureChainVars`. Kept in lock-step with
 * that function — returns a per-step var resolver for chain runs, or
 * `null` on cancel. See that file's comment for the layering rules
 * (step default → chain.vars → chain.stepVars → prompt answers).
 * @param {Chain} chain
 * @returns {Promise<((step: any) => Record<string, string>) | null>}
 */
async function ensureChainVars(chain) {
  const accept = !!settings.pipeline.acceptDefaultsWithoutPrompting;
  const plan = planChainVarsPrompt(chain, accept);
  if (!plan.needsPrompting) {
    return (step) => resolveStepVars(chain, step);
  }
  const promptParams = plan.rows.map((r) => ({
    name: r.key,
    default: r.initial,
    displayLabel: r.label,
  }));
  /** @type {Record<string, string>} */
  const initialValues = {};
  for (const r of plan.rows) initialValues[r.key] = r.initial;
  const answers = await promptForVars(promptParams, initialValues);
  if (answers === null) return null;
  const { chainOverlay, stepOverlay } = applyChainPromptAnswers(plan.rows, answers);
  return (step) => {
    const overlay = { ...chainOverlay, ...(stepOverlay[step.id] || {}) };
    return resolveStepVars(chain, step, overlay);
  };
}

function closeRunner() {
  const dlg = /** @type {HTMLDialogElement} */ ($('#runner'));
  if (dlg.open) dlg.close();
}

/**
 * @param {'apply' | 'insert'} [openMode]
 */
export function openRunner(openMode = 'apply') {
  if (!wired) setupRunner();
  const dlg = /** @type {HTMLDialogElement} */ ($('#runner'));
  if (dlg.open) return;
  // Snapshot the selection *before* showModal() hands focus to the dialog
  // and (on some browsers) collapses the textarea's visible selection.
  savedSel = getSel();
  // Also snapshot the effective input source at open time: the toolbar
  // mode could theoretically be toggled while the dialog is open (via
  // shortcut), but we want the user's intent at Ctrl+O to be the
  // authoritative decision for this run.
  savedSrc = resolveInput();
  mode = openMode;
  // Pin defaults off on every open — see the `keepOpen` doc comment.
  keepOpen = false;
  reflectPin();
  reflectMode();
  renderChips();
  const input = /** @type {HTMLInputElement} */ ($('#runner-input'));
  input.value = '';
  highlighted = 0;
  dlg.showModal();
  renderDropdown();
  requestAnimationFrame(() => input.focus());
}

function reflectPin() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('runner-pin'));
  if (!btn) return;
  btn.setAttribute('aria-pressed', keepOpen ? 'true' : 'false');
  btn.classList.toggle('pinned', keepOpen);
  btn.title = keepOpen
    ? 'Click to stop keeping the dialog open after each run'
    : 'Keep open after each run (or use Shift+Enter for one keep-open run)';
}

function reflectMode() {
  const title = document.getElementById('runner-title');
  const hint = document.querySelector('.runner-hint');
  const apply = document.getElementById('runner-apply');
  if (mode === 'insert') {
    if (title) title.textContent = 'Runner — insert at cursor';
    if (hint)
      hint.textContent =
        'Pick a snippet or chain; it runs with no input and the output is inserted at the cursor.\n' +
        'Enter inserts, Esc cancels.\n' +
        'Shift+Enter inserts and stays open.';
    if (apply) apply.textContent = 'Insert';
  } else {
    if (title) title.textContent = 'Runner';
    if (hint)
      hint.textContent =
        'Type a snippet or chain name.\n' +
        'Enter runs, Esc cancels.\n' +
        'Shift+Enter runs and stays open.';
    if (apply) apply.textContent = 'Apply';
  }
}

export function isRunnerOpen() {
  const dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById('runner'));
  return !!dlg && dlg.open;
}

function setupRunner() {
  wired = true;
  const input = /** @type {HTMLInputElement} */ ($('#runner-input'));
  const applyBtn = $('#runner-apply');

  input.addEventListener('input', () => {
    highlighted = 0;
    renderDropdown();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rows.length) {
        highlighted = Math.min(highlighted + 1, rows.length - 1);
        updateHighlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      updateHighlight();
    } else if (e.key === 'Enter') {
      // The form uses method="dialog", so a bare Enter would submit + close.
      // Intercept, then run ourselves. Shift+Enter forces keep-open for
      // this single run even if the pin is off — a keyboard shortcut
      // for the "one more after this" case.
      e.preventDefault();
      runHighlighted({ keepOpenOverride: e.shiftKey });
    }
    // Escape: native <dialog> handles it — cancels and fires 'close'.
  });

  applyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    // Same Shift-accelerator on the Apply button — match the keyboard
    // path so a Shift-click also fires one keep-open run.
    runHighlighted({ keepOpenOverride: e.shiftKey });
  });

  const pinBtn = document.getElementById('runner-pin');
  if (pinBtn) {
    pinBtn.addEventListener('click', (e) => {
      e.preventDefault();
      keepOpen = !keepOpen;
      reflectPin();
      // Keep the typing surface focused — clicking the pin shouldn't
      // force the user back to the mouse to resume typing.
      const input = /** @type {HTMLInputElement} */ ($('#runner-input'));
      input.focus();
    });
  }

  // Scope chips. Clicking a chip toggles its inclusion. At least one
  // kind must stay on — turning off the last-on chip flips the scope to
  // the OTHER kind only rather than showing an empty list.
  const snippetsBtn = $('#runner-chip-snippets');
  const chainsBtn = $('#runner-chip-chains');
  const toggleScope = (clicked) => {
    const scope = currentScope();
    const snippetsOn = scope !== 'chains';
    const chainsOn = scope !== 'snippets';
    let nextSnippets = snippetsOn;
    let nextChains = chainsOn;
    if (clicked === 'snippets') nextSnippets = !snippetsOn;
    else nextChains = !chainsOn;
    if (!nextSnippets && !nextChains) {
      // User clicked the only-active chip — that maps to "I don't want
      // this kind any more". Keep the clicked chip OFF and turn the
      // other one ON. Net effect: both-kinds → this-kind → other-kind →
      // both-kinds as the user cycles through.
      if (clicked === 'snippets') {
        nextSnippets = false;
        nextChains = true;
      } else {
        nextChains = false;
        nextSnippets = true;
      }
    }
    const next =
      nextSnippets && nextChains ? 'both' : nextSnippets ? 'snippets' : 'chains';
    setScope(next);
    renderChips();
    renderDropdown();
  };
  snippetsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleScope('snippets');
  });
  chainsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleScope('chains');
  });
  // Cancel button is type="submit" value="cancel" — native dialog close.
}
