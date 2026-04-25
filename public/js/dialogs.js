// @ts-check
// Library dialogs: snippet, template, chain editors + the awk reference panel
// renderer + promptForVars (run-time variables prompt).
//
// Dialogs emit DOM CustomEvents after saves instead of calling renderers
// directly, to keep the module acyclic with library.js / palette.js.
//   - 'library:snippets-changed'  — after snippet save/create
//   - 'library:templates-changed' — after template save/create
//   - 'library:chains-changed'    — after chain save/create

import {
  $,
  uid,
  editText,
  editTextRange,
  safeSetItem,
  renderParamRows,
  cleanParams,
  favoriteThenName,
  closestOn,
  appAlert,
  appConfirm,
  appChoose,
  showToast,
  pulseSidebarRow,
  highlightSidebarRow,
} from './core.js';
import { LS_KEYS } from './data.js';
import {
  state,
  saveState,
  chainParamList,
  chainParamUsage,
  pruneOrphanStepVars,
  resolveStepVars,
  stepLabel,
  normalizeTags,
  allSnippetTags,
  allChainTags,
  allTemplateTags,
} from './state.js';
import { settings } from './settings.js';
import {
  openInlineStepDialog,
  scheduleAutoPreview,
  renderPipeline,
  buildStepsShellCommand,
  buildShellScriptFromTemplate,
} from './pipeline.js';
import { runAwk, runAwkMulti, findCandidateVars, highlightAwk } from './awk.js';
import { createTagChipInput } from './tag-chip-input.js';
import { resolveInput } from './inputMode.js';
import {
  normalizeShortcut,
  formatShortcut,
  isUsableCombo,
  findConflicts,
  effectiveSystemShortcuts,
} from './shortcuts.js';
import { runSnippetTests, runChainTests, unifiedDiff, clearCachedSummary } from './tests.js';
import { dispatch } from './events.js';
import {
  createPreviewRunner,
  resolvePreviewInput,
  gatePreviewOrNull,
  renderPreviewGate,
  writePreviewStderr,
  writePreviewStdout,
  formatPreviewInputLabel,
} from './previewRunner.js';

// Re-exports from the three submodules under `./dialogs/`. Each block
// imports the names used internally + re-exports the full public
// surface so callers can keep `from './dialogs.js'` without caring that
// the implementation lives in a sibling file. Previous shape had a
// separate `export { ... } from 'x'` and `import { ... } from 'x'`
// pair per block; using `import { ... } from 'x'` + `export { ... }`
// keeps the path in one place per submodule.

// ---------- pickers (FIELDWIDTHS / FPAT / strftime / Detect FS) ----------
import {
  wireDetectFsButton,
  wireColumnsButton,
  wireFpatButton,
  wireStrftimeButton,
} from './dialogs/pickers.js';
export { wireDetectFsButton, wireColumnsButton, wireFpatButton, wireStrftimeButton };

// ---------- gawk --pretty-print button ----------
import { wireFormatButton } from './dialogs/format.js';
export { wireFormatButton };

// ---------- awk reference sidebar ----------
import {
  renderAwkReferenceInto,
  renderSnippetReference,
  renderPaletteReference,
  renderInlineStepReference,
} from './dialogs/reference.js';
export {
  renderAwkReferenceInto,
  renderSnippetReference,
  renderPaletteReference,
  renderInlineStepReference,
};

// ---------- template picker ----------
/**
 * Render a chip list of the current templates (and optionally snippets),
 * favorite-first then by name, into `ul`, wired so:
 *   - Hover or keyboard-focus on a chip calls `opts.onPreview(entry)` so
 *     the caller can update a preview pane. Mouseleave / blur calls
 *     `opts.onPreview(null)` to clear.
 *   - Click on a chip calls `opts.onPick(entry)`.
 *
 * Each `entry` is normalized to `{ kind, id, name, body, description }`
 * so callers don't care whether the chip represents a template
 * (`state.templates[i]`) or a snippet (`state.snippets[i]`). Snippet
 * chips render with a small `snippet` badge so the user can tell the
 * two libraries apart at a glance — useful in the snippet editor where
 * "copy from another snippet as a starting point" is as valid a
 * workflow as "copy from a template".
 *
 * Scope is controlled by two independent flags:
 *   - `showTemplates` (default true) — include `state.templates`.
 *   - `showSnippets`  (default false) — include `state.snippets`.
 * If both are false, an empty-state row is shown.
 *
 * Chips receive `tabindex="0"` so a keyboard user can Tab to them and the
 * preview follows focus. The currently-previewing chip gets a `.previewing`
 * class so the caller's preview pane has a visual anchor.
 *
 * When `opts.filter` is supplied (lowercased), only entries whose name
 * includes the string are rendered. Empty / missing filter = show all.
 *
 * @typedef {{
 *   kind: 'template' | 'snippet',
 *   id: string,
 *   name: string,
 *   body: string,
 *   description?: string,
 * }} TemplateChipEntry
 *
 * @param {HTMLElement} ul
 * @param {{
 *   onPick: (entry: TemplateChipEntry) => void,
 *   onPreview?: (entry: TemplateChipEntry | null) => void,
 *   filter?: string,
 *   showTemplates?: boolean,
 *   showSnippets?: boolean,
 *   excludeSnippetId?: string,
 * }} opts
 */
export function renderTemplateChipList(ul, opts) {
  if (!ul) return;
  const q = (opts.filter || '').trim().toLowerCase();
  const showTemplates = opts.showTemplates !== false;
  const showSnippets = opts.showSnippets === true;
  /** @type {TemplateChipEntry[]} */
  const entries = [];
  if (showTemplates) {
    for (const t of state.templates) {
      entries.push({
        kind: 'template',
        id: t.id,
        name: t.name,
        body: t.body,
        description: t.description,
      });
    }
  }
  if (showSnippets) {
    const skip = opts.excludeSnippetId;
    for (const s of state.snippets) {
      if (skip && s.id === skip) continue;
      entries.push({
        kind: 'snippet',
        id: s.id,
        name: s.name,
        body: s.program,
        description: s.description,
      });
    }
  }
  // Single alphabetic sort across both kinds — the user asked for
  // interleaved order so they can find "Bold first sentence" next to
  // "Bold inline selection" regardless of which library each lives in.
  // Case-insensitive, locale-aware so "Équipe" sorts near "Eager".
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const visible = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  ul.replaceChildren();
  if (!visible.length) {
    // Keep the list in layout so the filter input doesn't jump around on
    // an empty query-hit — show a muted "no matches" row.
    ul.style.display = '';
    const li = document.createElement('li');
    li.className = 'template-chip-empty';
    let emptyLabel;
    if (showTemplates && showSnippets) emptyLabel = 'templates or snippets';
    else if (showSnippets) emptyLabel = 'snippets';
    else if (showTemplates) emptyLabel = 'templates';
    else emptyLabel = 'items (toggle Templates or Snippets above)';
    li.textContent = entries.length ? `(no matching ${emptyLabel})` : `(no ${emptyLabel} yet)`;
    ul.appendChild(li);
    return;
  }
  ul.style.display = '';
  const onPreview = opts.onPreview || (() => {});
  for (const entry of visible) {
    const li = document.createElement('li');
    li.dataset.id = entry.id;
    li.dataset.kind = entry.kind;
    li.tabIndex = 0;
    // Single-letter kind badge — `T` for template, `S` for snippet —
    // so both kinds are labelled in the mixed-alphabetic list without
    // the longer "snippet" text crowding the chip.
    const badge = document.createElement('span');
    badge.className = `template-chip-badge template-chip-badge-${entry.kind} muted`;
    badge.textContent = entry.kind === 'snippet' ? 'S' : 'T';
    badge.title = entry.kind === 'snippet' ? 'Snippet' : 'Template';
    li.appendChild(badge);
    li.appendChild(document.createTextNode(entry.name));
    li.classList.add(entry.kind === 'snippet' ? 'template-chip-snippet' : 'template-chip-template');
    if (entry.description) li.title = entry.description;
    const markPreviewing = () => {
      for (const other of ul.querySelectorAll('li.previewing')) {
        other.classList.remove('previewing');
      }
      li.classList.add('previewing');
      onPreview(entry);
    };
    const clearPreviewing = () => {
      li.classList.remove('previewing');
      onPreview(null);
    };
    li.addEventListener('mouseenter', markPreviewing);
    li.addEventListener('mouseleave', clearPreviewing);
    li.addEventListener('focus', markPreviewing);
    li.addEventListener('blur', clearPreviewing);
    li.addEventListener('click', () => opts.onPick(entry));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        opts.onPick(entry);
      }
    });
    ul.appendChild(li);
  }
  // A filter that narrows down to a single entry feels like the user
  // has effectively "picked" it — auto-preview it so they don't need the
  // extra hover. Equivalent to the mouseenter path (same `previewing`
  // highlight, same onPreview call).
  if (visible.length === 1) {
    const only = /** @type {HTMLElement} */ (ul.firstElementChild);
    only.classList.add('previewing');
    onPreview(visible[0]);
  }
}

/**
 * Insert `body` on the line *following* the textarea's current caret
 * position instead of splitting the current line at the caret. The user's
 * cursor can be mid-statement when they pick a template; dropping a
 * multi-line block there would break that statement.
 *
 * Rules:
 *   - Insert point = end of current line (next `\n` at or after caret,
 *     or end of text if none).
 *   - Prefix a `\n` so the template starts on a fresh line — unless the
 *     current line is empty (caret on blank line) or the textarea is
 *     empty, in which case we write straight into that empty spot.
 *   - `editText` preserves undo; we set the selection to the insert
 *     point first so it replaces "nothing" at the right place.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {string} body
 */
function insertTemplateAfterCurrentLine(ta, body) {
  const value = ta.value;
  const pos = ta.selectionStart;
  const nextNl = value.indexOf('\n', pos);
  const endIdx = nextNl === -1 ? value.length : nextNl;
  let text = body;
  if (endIdx > 0 && value[endIdx - 1] !== '\n') text = '\n' + text;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = endIdx;
  editText(ta, text);
}

/**
 * Bind a template chip list + its preview pane + filter input to a given
 * textarea `ta`. Clicking a chip inserts the template body on a new line
 * after the caret (see `insertTemplateAfterCurrentLine`), undo-preserving.
 * Hovering / focusing a chip updates the preview body; leaving clears it.
 * Typing in the filter input re-renders the chip list to matches only.
 *
 * When `scopeTemplatesBtnId` + `scopeSnippetsBtnId` are both provided,
 * those buttons become toggle pills that scope the picker to templates,
 * snippets, or both — persisted across opens via `LS_KEYS.snippetPickerScope`.
 * Without those, the picker defaults to templates-only (current inline-
 * step behavior). `excludeSnippetId` skips a specific snippet so the
 * snippet editor can hide the snippet being edited from its own picker.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {{
 *   listId: string,
 *   previewId: string,
 *   filterId?: string,
 *   scopeTemplatesBtnId?: string,
 *   scopeSnippetsBtnId?: string,
 *   excludeSnippetId?: string,
 * }} ids
 */
export function attachTemplatePicker(ta, ids) {
  const ul = $(ids.listId);
  const previewRoot = $(ids.previewId);
  const filterInput = ids.filterId ? $(ids.filterId) : null;
  // Reset the filter on every open — the DOM element is shared across
  // dialog openings, so without this a stale query from the previous
  // session (e.g. "csv") would pre-filter the list before the user has
  // typed anything. Mirrors what the chain dialog does for its snippet
  // filter (see `openChainDialog`).
  if (filterInput) filterInput.value = '';
  const previewBody = previewRoot?.querySelector('.template-preview-body');
  const previewName = previewRoot?.querySelector('.template-preview-name');
  const clearPreview = () => {
    if (previewBody) previewBody.textContent = '';
    if (previewName) previewName.textContent = '';
  };

  const tplBtn = ids.scopeTemplatesBtnId ? $(ids.scopeTemplatesBtnId) : null;
  const snBtn = ids.scopeSnippetsBtnId ? $(ids.scopeSnippetsBtnId) : null;
  const hasScopeToggles = !!(tplBtn && snBtn);
  // Persisted per-toggle state. Default both on when toggles are present
  // (the snippet editor's "show me everything I can start from" mode);
  // without toggles, fall back to templates-only (the inline-step path).
  const readScope = () => {
    if (!hasScopeToggles) return { showTemplates: true, showSnippets: false };
    const tRaw = localStorage.getItem(LS_KEYS.snippetPickerScope('templates'));
    const sRaw = localStorage.getItem(LS_KEYS.snippetPickerScope('snippets'));
    return {
      showTemplates: tRaw === null ? true : tRaw === '1',
      showSnippets: sRaw === null ? true : sRaw === '1',
    };
  };
  const syncScopeButtons = () => {
    if (!hasScopeToggles) return;
    const { showTemplates, showSnippets } = readScope();
    tplBtn.classList.toggle('active', showTemplates);
    tplBtn.setAttribute('aria-pressed', String(showTemplates));
    snBtn.classList.toggle('active', showSnippets);
    snBtn.setAttribute('aria-pressed', String(showSnippets));
  };

  const render = () => {
    // Wipe first so a filter hit that removes the previously-previewed
    // chip doesn't leave stale text in the pane. `renderTemplateChipList`
    // will re-populate the pane when exactly one chip survives (single-
    // match auto-preview).
    clearPreview();
    const scope = readScope();
    renderTemplateChipList(ul, {
      filter: filterInput ? filterInput.value : '',
      showTemplates: scope.showTemplates,
      showSnippets: scope.showSnippets,
      excludeSnippetId: ids.excludeSnippetId,
      onPick: (entry) => {
        insertTemplateAfterCurrentLine(ta, entry.body);
        // Clear the filter after a pick so a follow-up insertion starts
        // from the full chip list — mirrors the command palette's
        // post-pick reset, minus the section-state restoration it has
        // to do (the template picker is a flat list, nothing to expand).
        if (filterInput && filterInput.value) {
          filterInput.value = '';
          render();
        }
      },
      onPreview: (entry) => {
        if (!previewBody || !previewName) return;
        if (!entry) {
          clearPreview();
          return;
        }
        // Syntax-highlight the body so the preview matches the main
        // program textarea's coloring. `highlightAwk` HTML-escapes every
        // token internally — safe to assign via innerHTML.
        previewBody.innerHTML = highlightAwk(entry.body);
        previewName.textContent =
          entry.kind === 'snippet' ? `${entry.name} · snippet` : entry.name;
      },
    });
  };

  syncScopeButtons();
  render();
  if (filterInput) {
    filterInput.addEventListener('input', render);
  }
  if (hasScopeToggles) {
    tplBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const { showTemplates } = readScope();
      safeSetItem(LS_KEYS.snippetPickerScope('templates'), showTemplates ? '0' : '1');
      syncScopeButtons();
      render();
    });
    snBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const { showSnippets } = readScope();
      safeSetItem(LS_KEYS.snippetPickerScope('snippets'), showSnippets ? '0' : '1');
      syncScopeButtons();
      render();
    });
  }
}

/**
 * Build a default chain name for "Save as chain" invoked from a snippet-run
 * prompt: `<snippet name> (name=value, …)` including only non-empty values.
 * Empty values mean "prompt at run time" (chain.vars is stored the same way
 * by resolveChainVars) — leaving them out of the name mirrors that intent.
 *
 * @param {{name: string}} sn
 * @param {Record<string, string>} values
 * @returns {string}
 */
function defaultChainNameFromSnippetRun(sn, values) {
  const parts = Object.entries(values)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${sn.name} (${parts.join(', ')})` : sn.name;
}

/**
 * "Save as chain" escape hatch from the run-vars prompt. Creates a chain
 * wrapping a single reference step (`{ snippetId: sn.id }`, not inlined —
 * the snippet stays canonical and the chain travels separately) with the
 * provided values as chain-level `vars`, then opens the chain dialog for
 * refinement. The chain is pushed to state before the dialog opens; if
 * the user cancels in the chain dialog the row persists — they can
 * delete it from the sidebar. This matches "Save pipeline as chain".
 *
 * @param {any} sn
 * @param {Record<string, string>} values
 */
function createChainFromSnippetRun(sn, values) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [k, v] of Object.entries(values)) {
    // Empty chain-level vars still prompt at run time — preserve that
    // contract and keep them out of `vars` (resolveChainVars treats
    // undefined and '' identically).
    if (v !== '') vars[k] = v;
  }
  /** @type {any} */
  const chain = {
    id: uid(),
    name: defaultChainNameFromSnippetRun(sn, values),
    steps: [{ snippetId: sn.id }],
  };
  if (Object.keys(vars).length) chain.vars = vars;
  state.chains.push(chain);
  saveState();
  dispatch('library:chains-changed');
  // Flash the new row in the sidebar. The chain dialog will be covering
  // the sidebar when this actually paints, so the pulse mostly plays to
  // an empty audience — but it also expands a collapsed Chains section
  // and scrolls the row into view, so when the user closes the dialog
  // the newly-created chain is already positioned and visible.
  highlightSidebarRow({ sectionKey: 'chains', listId: 'chains', itemId: chain.id });
  // Defer so the run-vars dialog's close animation settles before we
  // showModal the chain dialog — stacking showModal calls within the
  // same tick makes Firefox drop the second open silently.
  queueMicrotask(() => openChainDialog(chain));
}

// ---------- run-time variables prompt ----------
/**
 * Prompt for run-time variable values.
 *
 * `opts.hidden` is an iterable of param names that should render as
 * collapsed rows behind a "Show all N parameters" button — used when the
 * caller has pre-resolved some params (e.g. accepted their defaults) and
 * the user might still want to see / override them. Hidden rows are still
 * prefilled from `initialValues`, so revealing them exposes the value
 * that would otherwise have been taken silently.
 *
 * `opts.saveAsChainSnippet` enables the "Save as chain…" escape hatch.
 * When provided, clicking the button cancels the run, creates a new chain
 * with a single step referencing this snippet (by id, not inline) plus
 * the current input values as chain-level `vars`, then opens that chain
 * for editing. Only meaningful on snippet-run prompts — omit for chains.
 *
 * Each param supports an optional `displayLabel` that overrides the
 * label shown in the UI. Used by chain runs to surface per-step rows
 * like `cmd · Step 2: Run Command` while keying the row by a unique id
 * (see `planChainVarsPrompt` in state.js).
 *
 * @param {{name: string, default?: string, displayLabel?: string}[]} params  full param list
 * @param {Record<string, string> | undefined} initialValues
 * @param {{ hidden?: Iterable<string>, saveAsChainSnippet?: any }} [opts]
 * @returns {Promise<Record<string, string> | null>}  null on cancel
 */
export function promptForVars(params, initialValues, opts = {}) {
  const hidden = new Set(opts.hidden || []);
  const saveAsChainSn = opts.saveAsChainSnippet || null;
  return new Promise((resolve) => {
    const dlg = $('#run-vars-dialog');
    const list = $('#run-vars-list');
    list.innerHTML = '';
    const inputs = {};
    // Enter in any input triggers Run. Native <form method="dialog"> default-
    // submit picks the first submit button (Cancel), which is the opposite of
    // what the user wants — intercept explicitly.
    const submitRun = () => dlg.close('run');
    for (const p of params) {
      const row = document.createElement('div');
      row.className = 'param-row';
      if (hidden.has(p.name)) row.classList.add('run-vars-row-hidden');
      row.innerHTML = `
        <label style="flex:0 0 auto; font-family:monospace; font-size:.85rem;"></label>
        <input spellcheck="false">`;
      row.querySelector('label').textContent = p.displayLabel || p.name;
      const input = row.querySelector('input');
      input.value = initialValues?.[p.name] ?? p.default ?? '';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitRun();
        }
      });
      inputs[p.name] = input;
      list.appendChild(row);
    }
    const showAllBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('run-vars-show-all')
    );
    if (showAllBtn) {
      if (hidden.size > 0) {
        showAllBtn.hidden = false;
        showAllBtn.textContent = `Show all ${params.length} parameter${params.length === 1 ? '' : 's'}`;
        showAllBtn.onclick = (e) => {
          e.preventDefault();
          for (const row of list.querySelectorAll('.run-vars-row-hidden')) {
            row.classList.remove('run-vars-row-hidden');
          }
          showAllBtn.hidden = true;
        };
      } else {
        showAllBtn.hidden = true;
        showAllBtn.onclick = null;
      }
    }
    const saveAsChainBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('run-vars-save-as-chain')
    );
    if (saveAsChainBtn) {
      if (saveAsChainSn) {
        saveAsChainBtn.hidden = false;
        saveAsChainBtn.onclick = (e) => {
          e.preventDefault();
          // Read whatever is currently typed, including values from rows
          // still hidden behind the "Show all" toggle — they're the
          // effective defaults and belong in the chain just as much as
          // the visible overrides.
          /** @type {Record<string, string>} */
          const currentValues = {};
          for (const [name, el] of Object.entries(inputs)) currentValues[name] = el.value;
          createChainFromSnippetRun(saveAsChainSn, currentValues);
          // Cancel the run: the close listener resolves null when the
          // returnValue isn't 'run', and we intentionally don't set it.
          dlg.close();
        };
      } else {
        saveAsChainBtn.hidden = true;
        saveAsChainBtn.onclick = null;
      }
    }
    dlg.returnValue = '';
    dlg.showModal();
    // Focus the first *visible* input so keyboarding into a prompt still
    // lands on something the user can type into — not a hidden default row.
    setTimeout(() => {
      const firstVisible = list.querySelector('.param-row:not(.run-vars-row-hidden) input');
      const el = /** @type {HTMLInputElement | null} */ (
        firstVisible || list.querySelector('input')
      );
      el?.focus();
    }, 10);
    dlg.addEventListener(
      'close',
      () => {
        if (dlg.returnValue !== 'run') {
          resolve(null);
          return;
        }
        /** @type {Record<string, string>} */
        const values = {};
        for (const [name, el] of Object.entries(inputs)) values[name] = el.value;
        resolve(values);
      },
      { once: true },
    );
  });
}

/**
 * Append `text` to `parent` with whitespace visualised:
 *   - tabs render as `→\t` so the marker is visible AND the tab stop still
 *     consumes the right amount of column space below it
 *   - trailing spaces render as one `·` per space
 *
 * Markers are wrapped in `.diff-invisible` so CSS can fade them. Used by
 * the test-failure diff so users can distinguish "expected three trailing
 * spaces" from "expected nothing."
 *
 * @param {Node} parent
 * @param {string} text  one line, no embedded "\n"
 */
function appendVisualizedLine(parent, text) {
  // Trailing spaces are rendered as dots; everything before them stays
  // intact so leading/inline spaces aren't visually punished.
  let trailingStart = text.length;
  while (trailingStart > 0 && text[trailingStart - 1] === ' ') trailingStart--;
  const main = text.slice(0, trailingStart);
  const trailing = text.slice(trailingStart);
  let buf = '';
  for (const ch of main) {
    if (ch === '\t') {
      if (buf) {
        parent.appendChild(document.createTextNode(buf));
        buf = '';
      }
      const tabSpan = document.createElement('span');
      tabSpan.className = 'diff-invisible';
      // Marker first, then the real tab so the column layout still snaps
      // to the next tab stop.
      tabSpan.textContent = '→\t';
      parent.appendChild(tabSpan);
    } else {
      buf += ch;
    }
  }
  if (buf) parent.appendChild(document.createTextNode(buf));
  if (trailing.length) {
    const trSpan = document.createElement('span');
    trSpan.className = 'diff-invisible';
    trSpan.textContent = '·'.repeat(trailing.length);
    parent.appendChild(trSpan);
  }
}

/**
 * Build the per-test "Variables" `<details>` section. The test's `vars`
 * object is mutated in place — empty values delete the key, so a saved
 * test never carries an entry whose value was just cleared.
 *
 * Snippet-declared params get their name as a fixed label and a value
 * input prefilled from `t.vars[name]` (or empty, with the snippet
 * default surfaced as placeholder text). Ad-hoc rows let the user
 * exercise vars that aren't in the snippet's param list.
 *
 * @param {any} t                            the test (mutated)
 * @param {{name: string, default?: string}[]} workingParams snippet params
 *                                                            from the dialog
 */
function buildTestVarsSection(t, workingParams) {
  const det = document.createElement('details');
  det.className = 'test-vars-section';
  if (t.vars && Object.keys(t.vars).length) det.open = true;
  const sum = document.createElement('summary');
  sum.className = 'test-vars-summary';
  sum.textContent = 'Variables';
  const summaryCount = document.createElement('span');
  summaryCount.className = 'test-vars-count muted';
  det.appendChild(sum);
  sum.appendChild(summaryCount);

  const list = document.createElement('div');
  list.className = 'test-vars-list';
  det.appendChild(list);

  const refreshSummaryCount = () => {
    const n = t.vars ? Object.keys(t.vars).length : 0;
    summaryCount.textContent = n ? ` · ${n} override${n === 1 ? '' : 's'}` : '';
  };

  /** Update t.vars[name] = value (or delete the key when value is empty). */
  const setVar = (name, value) => {
    if (!name) return;
    if (!t.vars) t.vars = {};
    if (value === '' || value == null) delete t.vars[name];
    else t.vars[name] = value;
    if (t.vars && !Object.keys(t.vars).length) delete t.vars;
    refreshSummaryCount();
  };

  // Declared-param rows (name fixed, not deletable). An inline × inside
  // the value field clears the override — same affordance as the sidebar
  // filter's ×. Hidden when the field is empty (via :placeholder-shown).
  const paramNames = new Set();
  for (const p of workingParams) {
    if (!p || !p.name) continue;
    paramNames.add(p.name);
    const r = document.createElement('div');
    r.className = 'test-var-row';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'test-var-name';
    nameLabel.textContent = p.name;
    const fieldWrap = document.createElement('span');
    fieldWrap.className = 'test-var-field';
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'test-var-value';
    valInput.value = (t.vars && t.vars[p.name]) || '';
    valInput.placeholder = p.default ? `default: ${p.default}` : 'no default';
    valInput.oninput = () => setVar(p.name, valInput.value);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'test-var-inline-clear';
    clearBtn.textContent = '×';
    clearBtn.title = 'Clear override (revert to default)';
    clearBtn.tabIndex = -1;
    clearBtn.onclick = (e) => {
      e.preventDefault();
      valInput.value = '';
      setVar(p.name, '');
      valInput.focus();
    };
    fieldWrap.appendChild(valInput);
    fieldWrap.appendChild(clearBtn);
    r.appendChild(nameLabel);
    r.appendChild(fieldWrap);
    list.appendChild(r);
  }

  // Ad-hoc rows: anything in t.vars not covered by snippet params, plus a
  // mutable list of new rows the user adds via the button below.
  const adhocRows = [];
  if (t.vars) {
    for (const [k, v] of Object.entries(t.vars)) {
      if (paramNames.has(k)) continue;
      adhocRows.push({ name: k, value: v });
    }
  }
  /** Render the ad-hoc list (rebuilds — small, so cheap). */
  const renderAdhoc = () => {
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (
      list.querySelectorAll('.test-var-row.adhoc')
    ))
      el.remove();
    adhocRows.forEach((row, idx) => {
      const r = document.createElement('div');
      r.className = 'test-var-row adhoc';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'test-var-name-input';
      nameInput.placeholder = 'name';
      nameInput.value = row.name;
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'test-var-value';
      valInput.placeholder = 'value';
      valInput.value = row.value;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'test-var-del';
      del.textContent = '✕';
      del.title = 'Remove this override';
      // `prevName` lets us delete the old key when the user renames the
      // var, so a rename doesn't leave an orphan entry behind.
      let prevName = row.name;
      const apply = () => {
        if (prevName && prevName !== nameInput.value) setVar(prevName, '');
        prevName = nameInput.value;
        setVar(nameInput.value, valInput.value);
      };
      nameInput.oninput = () => {
        row.name = nameInput.value;
        apply();
      };
      valInput.oninput = () => {
        row.value = valInput.value;
        apply();
      };
      del.onclick = (e) => {
        e.preventDefault();
        if (prevName) setVar(prevName, '');
        adhocRows.splice(idx, 1);
        renderAdhoc();
      };
      r.appendChild(nameInput);
      r.appendChild(valInput);
      r.appendChild(del);
      list.appendChild(r);
    });
  };
  renderAdhoc();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'test-vars-add';
  addBtn.textContent = '+ Add variable';
  addBtn.onclick = (e) => {
    e.preventDefault();
    adhocRows.push({ name: '', value: '' });
    renderAdhoc();
  };
  det.appendChild(addBtn);

  refreshSummaryCount();
  return det;
}

// ---------- shared test-cases section ----------
/**
 * Wire a Tests section that is reusable across snippet and chain dialogs.
 * DOM structure is identical in both — three IDs differ — and the per-test
 * "run" callback is the only behaviour difference.
 *
 * @param {{
 *   sectionId: string,
 *   listId: string,
 *   summaryId: string,
 *   addBtnId: string,
 *   runAllBtnId: string,
 *   captureBtnId?: string,
 *   captureCurrent?: () => Promise<{input: string, expected: string, name?: string, vars?: Record<string,string>} | null>,
 *   existingTests: any[] | undefined,
 *   existingId: string | undefined,
 *   getParams: () => {name: string, default?: string}[],
 *   runOneTest: (test: any, lastResults: Map<string, any>) => Promise<void>,
 *   defaultOpen?: boolean,
 * }} opts
 * @returns {{ workingTests: any[], renderTests: () => void, cleanup: () => void }}
 */
function wireTestsSection(opts) {
  const section = /** @type {HTMLDetailsElement} */ ($(opts.sectionId));
  const listEl = $(opts.listId);
  const summaryEl = $(opts.summaryId);
  /** @type {any[]} */
  const workingTests = opts.existingTests
    ? opts.existingTests.map((t) => ({ ...t, vars: t.vars ? { ...t.vars } : undefined }))
    : [];
  /** @type {Map<string, any>} */
  const lastResults = new Map();
  const defaultOpen =
    opts.defaultOpen !== undefined ? opts.defaultOpen : workingTests.length > 0;
  rememberSectionOpenState(section, `tests:${opts.sectionId}`, defaultOpen);

  const refreshSummary = () => {
    if (!workingTests.length) {
      summaryEl.textContent = '';
      return;
    }
    let pass = 0,
      fail = 0,
      untested = 0;
    for (const t of workingTests) {
      const r = lastResults.get(t.id);
      if (!r) untested++;
      else if (r.pass) pass++;
      else fail++;
    }
    const parts = [`${workingTests.length} test${workingTests.length === 1 ? '' : 's'}`];
    if (pass) parts.push(`${pass} passing`);
    if (fail) parts.push(`${fail} failing`);
    if (untested) parts.push(`${untested} not run`);
    summaryEl.textContent = `· ${parts.join(' · ')}`;
  };

  /**
   * ResizeObservers that keep each row's Input + Expected textarea heights
   * in lockstep. One per row, disconnected at the start of every render so
   * the observer set matches the live DOM.
   * @type {ResizeObserver[]}
   */
  let heightSyncObservers = [];
  const renderTests = () => {
    for (const ob of heightSyncObservers) ob.disconnect();
    heightSyncObservers = [];
    listEl.replaceChildren();
    if (!workingTests.length) {
      const empty = document.createElement('div');
      empty.className = 'tests-empty muted';
      empty.textContent =
        'No test cases yet. Add one to lock in expected output for a given input.';
      listEl.appendChild(empty);
      refreshSummary();
      return;
    }
    workingTests.forEach((t, idx) => {
      const result = lastResults.get(t.id);
      const row = document.createElement('div');
      row.className = 'test-row';
      if (result) row.classList.add(result.pass ? 'pass' : 'fail');

      const head = document.createElement('div');
      head.className = 'test-row-head';
      const dot = document.createElement('span');
      dot.className = 'test-dot';
      dot.textContent = result ? (result.pass ? '✓' : '✗') : '◯';
      dot.title = result ? (result.pass ? 'Pass' : 'Fail') : 'Not run';
      head.appendChild(dot);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'test-name';
      nameInput.placeholder = `Test ${idx + 1}`;
      nameInput.value = t.name || '';
      nameInput.oninput = () => {
        t.name = nameInput.value;
      };
      head.appendChild(nameInput);
      const trimLabel = document.createElement('label');
      trimLabel.className = 'test-trim-label';
      trimLabel.title =
        "awk's print appends a newline (ORS), so output almost always ends with \\n even if your Expected doesn't. With this on, one trailing \\n is ignored on both sides before comparing — saves you from typing the newline into every Expected field.";
      const trimCb = document.createElement('input');
      trimCb.type = 'checkbox';
      trimCb.checked = !!t.trimTrailingNewline;
      trimCb.onchange = () => {
        t.trimTrailingNewline = trimCb.checked;
      };
      trimLabel.appendChild(trimCb);
      trimLabel.appendChild(document.createTextNode(' trim \\n'));
      head.appendChild(trimLabel);
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'test-run';
      runBtn.textContent = '▶';
      runBtn.title = 'Run this test';
      runBtn.onclick = async (e) => {
        e.preventDefault();
        await opts.runOneTest(t, lastResults);
        renderTests();
      };
      head.appendChild(runBtn);
      const dupBtn = document.createElement('button');
      dupBtn.type = 'button';
      dupBtn.className = 'test-dup';
      dupBtn.textContent = '⎘';
      dupBtn.title = 'Duplicate this test';
      dupBtn.onclick = (e) => {
        e.preventDefault();
        const copy = {
          id: uid(),
          name: t.name ? `${t.name} copy` : '',
          input: t.input || '',
          expected: t.expected || '',
          trimTrailingNewline: !!t.trimTrailingNewline,
        };
        if (t.vars && Object.keys(t.vars).length) copy.vars = { ...t.vars };
        workingTests.splice(idx + 1, 0, copy);
        renderTests();
      };
      head.appendChild(dupBtn);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'test-del';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete this test';
      delBtn.onclick = (e) => {
        e.preventDefault();
        workingTests.splice(idx, 1);
        lastResults.delete(t.id);
        renderTests();
      };
      head.appendChild(delBtn);
      row.appendChild(head);

      const body = document.createElement('div');
      body.className = 'test-row-body';
      const inputCol = document.createElement('label');
      inputCol.className = 'test-col';
      inputCol.appendChild(document.createTextNode('Input'));
      const inputTa = document.createElement('textarea');
      inputTa.rows = 3;
      inputTa.spellcheck = false;
      inputTa.value = t.input || '';
      inputTa.oninput = () => {
        t.input = inputTa.value;
      };
      inputCol.appendChild(inputTa);
      body.appendChild(inputCol);
      const expCol = document.createElement('label');
      expCol.className = 'test-col';
      expCol.appendChild(document.createTextNode('Expected'));
      const expTa = document.createElement('textarea');
      expTa.rows = 3;
      expTa.spellcheck = false;
      expTa.value = t.expected || '';
      expTa.oninput = () => {
        t.expected = expTa.value;
      };
      expCol.appendChild(expTa);
      body.appendChild(expCol);
      row.appendChild(body);

      // Sync heights: when the user drags one textarea's resize handle,
      // mirror the height onto its sibling so Input and Expected always
      // show the same number of rows. We compare against the already-set
      // style.height on the sibling before writing, so the observer-
      // induced resize on the sibling is a no-op and the feedback loop
      // terminates without needing a suppress flag.
      const syncHeights = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const source = /** @type {HTMLTextAreaElement} */ (entry.target);
          const target = source === inputTa ? expTa : inputTa;
          const h = source.style.height;
          if (!h || target.style.height === h) continue;
          target.style.height = h;
        }
      });
      syncHeights.observe(inputTa);
      syncHeights.observe(expTa);
      heightSyncObservers.push(syncHeights);

      row.appendChild(buildTestVarsSection(t, opts.getParams()));

      if (result && !result.pass) {
        const fb = document.createElement('div');
        fb.className = 'test-feedback';
        if (result.stderr) {
          const errPre = document.createElement('pre');
          errPre.className = 'test-stderr';
          errPre.textContent = result.stderr;
          fb.appendChild(errPre);
        }
        const promoteRow = document.createElement('div');
        promoteRow.className = 'test-promote-row';
        const promoteBtn = document.createElement('button');
        promoteBtn.type = 'button';
        promoteBtn.className = 'test-promote';
        promoteBtn.textContent = 'Use actual as expected';
        promoteBtn.title =
          'Overwrite Expected with the actual output from this run, then re-run the test';
        promoteBtn.onclick = async (e) => {
          e.preventDefault();
          t.expected = result.actual;
          await opts.runOneTest(t, lastResults);
          renderTests();
        };
        promoteRow.appendChild(promoteBtn);
        fb.appendChild(promoteRow);
        const lines = unifiedDiff(result.expected, result.actual);
        const diff = document.createElement('pre');
        diff.className = 'test-diff';
        for (const line of lines) {
          const span = document.createElement('span');
          span.className = `diff-${line.sign === '+' ? 'add' : line.sign === '-' ? 'del' : 'ctx'}`;
          span.appendChild(document.createTextNode(`${line.sign} `));
          appendVisualizedLine(span, line.text);
          const eol = document.createElement('span');
          eol.className = 'diff-invisible diff-eol';
          eol.textContent = '↵';
          span.appendChild(eol);
          span.appendChild(document.createTextNode('\n'));
          diff.appendChild(span);
        }
        fb.appendChild(diff);
        row.appendChild(fb);
      }

      listEl.appendChild(row);
    });
    refreshSummary();
  };
  renderTests();
  $(opts.addBtnId).onclick = (e) => {
    e.preventDefault();
    workingTests.push({ id: uid(), name: '', input: '', expected: '', trimTrailingNewline: true });
    section.open = true;
    renderTests();
  };
  if (opts.captureBtnId && opts.captureCurrent) {
    const captureBtn = $(opts.captureBtnId);
    if (captureBtn) {
      captureBtn.onclick = async (e) => {
        e.preventDefault();
        const snap = await opts.captureCurrent();
        if (!snap) return;
        /** @type {any} */
        const row = {
          id: uid(),
          name: snap.name || '',
          input: snap.input || '',
          expected: snap.expected || '',
          trimTrailingNewline: true,
        };
        if (snap.vars && Object.keys(snap.vars).length) row.vars = { ...snap.vars };
        workingTests.push(row);
        section.open = true;
        renderTests();
      };
    }
  }
  $(opts.runAllBtnId).onclick = async (e) => {
    e.preventDefault();
    if (!workingTests.length) return;
    for (const t of workingTests) await opts.runOneTest(t, lastResults);
    renderTests();
  };
  return {
    workingTests,
    renderTests,
    cleanup: () => {
      for (const ob of heightSyncObservers) ob.disconnect();
      heightSyncObservers = [];
    },
  };
}

/**
 * Clean a working-tests array for persistence: drops empty rows, trims
 * keys, normalises the shape. Shared by snippet and chain save paths.
 */
function cleanTests(workingTests) {
  return workingTests
    .filter((t) => (t.input || '').length || (t.expected || '').length)
    .map((t) => {
      const out = { id: t.id, input: t.input || '', expected: t.expected || '' };
      if (t.name) out.name = t.name;
      if (t.trimTrailingNewline) out.trimTrailingNewline = true;
      if (t.vars && Object.keys(t.vars).length) out.vars = { ...t.vars };
      return out;
    });
}

// ---------- snippet dialog helpers ----------

/**
 * True when the in-dialog edits touch a field that chain steps depend on
 * (name/program/params). Tag-only, description-only, and test-only edits
 * return false so the "Snippet used by chains" prompt can be skipped.
 *
 * @param {any} existing
 * @param {import('./types.js').Param[]} workingParams
 * @returns {boolean}
 */
function snippetEditAffectsChains(existing, workingParams) {
  const nextName = $('#snippet-name').value.trim();
  const nextProgram = $('#snippet-program').value;
  if ((existing.name || '') !== nextName) return true;
  if ((existing.program || '') !== nextProgram) return true;
  const prev = existing.params || [];
  const next = cleanParams(workingParams);
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if ((prev[i].name || '') !== (next[i].name || '')) return true;
    if ((prev[i].default ?? '') !== (next[i].default ?? '')) return true;
  }
  return false;
}

/**
 * Configure the fork banner and button states for the snippet dialog.
 * Resets everything first so a prior fork-mode open doesn't leak state.
 */
function wireSnippetFork(existing, opts) {
  const banner = $('#snippet-fork-banner');
  const forkBtn = $('#snippet-fork');
  const saveBtn = $('#snippet-save');
  banner.hidden = true;
  banner.replaceChildren();
  forkBtn.hidden = true;
  saveBtn.textContent = 'Save';
  saveBtn.classList.add('primary');

  if (!opts.forkInto) return;

  const strong = document.createElement('strong');
  strong.appendChild(document.createTextNode('Editing global '));
  if (existing?.name) {
    const nameNode = document.createElement('span');
    nameNode.textContent = `'${existing.name}'`;
    strong.appendChild(nameNode);
  } else {
    strong.appendChild(document.createTextNode('this snippet'));
  }
  strong.appendChild(document.createTextNode('.'));
  banner.appendChild(strong);
  banner.appendChild(document.createTextNode(' Saving with '));
  const em1 = document.createElement('em');
  em1.textContent = 'Update global snippet';
  banner.appendChild(em1);
  banner.appendChild(
    document.createTextNode(' changes it for every chain and pipeline step that references it. '),
  );
  const em2 = document.createElement('em');
  em2.textContent = 'Fork to inline step';
  banner.appendChild(em2);
  const forkScope = opts.forkContext || 'this step';
  banner.appendChild(
    document.createTextNode(
      ` copies the current values into ${forkScope} only; the global snippet is unchanged.`,
    ),
  );
  banner.hidden = false;
  forkBtn.hidden = false;
  saveBtn.textContent = 'Update global snippet';
  saveBtn.classList.remove('primary');
}

/**
 * Wire the snippet preview toggle. Returns `{ schedulePreview, cleanup }`
 * — the caller must attach `schedulePreview` to textarea/param input
 * events and call `cleanup` on dialog close. The cross-surface preview
 * wiring (details toggle, debounce, staleness, input-mode subscription)
 * lives in `previewRunner.js`; here we only wire the snippet-specific
 * run (single program, one awk call).
 */
function wireSnippetPreview(ta, workingParams) {
  const details = /** @type {HTMLDetailsElement} */ ($('#snippet-preview-details'));
  const meta = /** @type {HTMLElement} */ ($('#snippet-preview-meta'));
  const out = /** @type {HTMLElement} */ ($('#snippet-preview-output'));
  out.classList.remove('error');
  const refreshMeta = () => {
    meta.textContent = formatPreviewInputLabel();
  };
  const run = async (manual = false) => {
    if (!details.open) return;
    const program = ta.value;
    if (!manual) {
      const gate = gatePreviewOrNull([program]);
      if (gate) {
        renderPreviewGate(out, gate, () => run(true));
        return;
      }
    }
    const token = runner.guard.claim();
    /** @type {Record<string,string>} */
    const vars = {};
    for (const p of workingParams) {
      if (p.name && vars[p.name] === undefined) vars[p.name] = p.default ?? '';
    }
    const { src, singleInput, note } = resolvePreviewInput();
    if (!program.trim()) {
      writePreviewStdout(out, '(enter an awk program above to preview its output)');
      return;
    }
    const r =
      src.kind === 'multi'
        ? await runAwkMulti(program, src.inputs, vars)
        : await runAwk(program, singleInput, vars);
    if (!runner.guard.isCurrent(token)) return;
    if (r.stderr) writePreviewStderr(out, r.stderr);
    else writePreviewStdout(out, r.stdout + note);
  };
  const runner = createPreviewRunner({
    details,
    lsKey: LS_KEYS.SNIPPET_PREVIEW_ON,
    run,
    refreshMeta,
  });
  return {
    schedulePreview: runner.schedulePreview,
    cleanup: runner.cleanup,
  };
}

/**
 * Wire the **Copy as shell** button in the snippet dialog. Operates on
 * the live edits (program text + working params), not the saved
 * snippet. No vars supplied, so each `-v` flag falls back to its
 * declared default.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {import('./types.js').Param[]} workingParams
 */
function wireSnippetCopyShell(ta, workingParams) {
  const btn = /** @type {HTMLButtonElement} */ ($('#snippet-copy-shell'));
  btn.onclick = async (e) => {
    e.preventDefault();
    const program = ta.value;
    if (!program.trim()) {
      appAlert('Program is empty.', { level: 'error' });
      return;
    }
    const params = cleanParams(workingParams);
    const cmd = buildStepsShellCommand([{ program, params }], {});
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(cmd);
      btn.textContent = 'Copied!';
    } catch (err) {
      btn.textContent = 'Copy failed';
      console.error(err);
    }
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  };
}

/**
 * Wire the **Download script** button in the snippet dialog. Wraps the
 * live program + params as a single-step "chain" and routes through
 * `buildShellScriptFromTemplate` so the snippet, chain, and inline-step
 * download buttons all share the same template + extension + flatten
 * settings. Reads `settings.scriptExport` fresh on every click so an
 * in-session Settings edit applies without reopening.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {import('./types.js').Param[]} workingParams
 */
function wireSnippetDownloadScript(ta, workingParams) {
  const btn = /** @type {HTMLButtonElement} */ ($('#snippet-download-sh'));
  btn.onclick = (e) => {
    e.preventDefault();
    const program = ta.value;
    if (!program.trim()) {
      appAlert('Program is empty.', { level: 'error' });
      return;
    }
    const params = cleanParams(workingParams);
    const name = $('#snippet-name').value.trim() || 'snippet';
    const cfg = settings.scriptExport || {};
    const { filename, content } = buildShellScriptFromTemplate(
      name,
      [{ name, program, params }],
      {},
      cfg,
    );
    const blob = new Blob([content], { type: 'application/x-shellscript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

/**
 * Wire the keyboard-shortcut capture section in the snippet dialog.
 * Two independent rows per snippet:
 *   `shortcut`       → runs against the current selection
 *   `shortcutInsert` → runs with no input, inserts output at cursor
 * Both inputs are readonly and record their own keydown; each
 * `wireShortcutRow` call stopsPropagation so the pressed combo doesn't
 * *also* fire whatever global/app shortcut would match. The section
 * auto-expands when either combo is set.
 *
 * @param {any} existing  the snippet being edited, or undefined for new
 * @returns {{
 *   workingShortcuts: Record<'shortcut' | 'shortcutInsert', string>,
 *   shortcutCleanups: (() => void)[],
 * }}
 */
function wireSnippetShortcuts(existing) {
  const shortcutDetails = /** @type {HTMLDetailsElement} */ ($('#snippet-shortcut-section'));
  const shortcutSummary = /** @type {HTMLElement} */ ($('#snippet-shortcut-summary'));
  /** @type {Record<'shortcut' | 'shortcutInsert', string>} */
  const workingShortcuts = {
    shortcut: existing?.shortcut || '',
    shortcutInsert: existing?.shortcutInsert || '',
  };
  rememberSectionOpenState(
    shortcutDetails,
    'snippet-shortcut',
    !!(workingShortcuts.shortcut || workingShortcuts.shortcutInsert),
  );
  const refreshSummary = () => {
    const parts = [];
    if (workingShortcuts.shortcut) parts.push(formatShortcut(workingShortcuts.shortcut));
    if (workingShortcuts.shortcutInsert)
      parts.push(`${formatShortcut(workingShortcuts.shortcutInsert)}*`);
    shortcutSummary.textContent = parts.length ? `· ${parts.join(' / ')}` : '';
  };
  /** @type {(() => void)[]} */
  const shortcutCleanups = [];
  for (const [field, inputId, clearId, warnId] of /** @type {const} */ ([
    ['shortcut', '#snippet-shortcut-input', '#snippet-shortcut-clear', '#snippet-shortcut-warning'],
    [
      'shortcutInsert',
      '#snippet-shortcut-insert-input',
      '#snippet-shortcut-insert-clear',
      '#snippet-shortcut-insert-warning',
    ],
  ])) {
    shortcutCleanups.push(
      wireShortcutRow({
        ownerKind: 'snippet',
        ownerId: existing?.id,
        field,
        inputEl: /** @type {HTMLInputElement} */ ($(inputId)),
        clearEl: /** @type {HTMLButtonElement} */ ($(clearId)),
        warnEl: /** @type {HTMLElement} */ ($(warnId)),
        workingShortcuts,
        refreshSummary,
      }),
    );
  }
  return { workingShortcuts, shortcutCleanups };
}

/**
 * Wire the snippet dialog's Test cases section via the shared
 * `wireTestsSection` helper. The only snippet-specific concerns are:
 *   - the `runOneTest` callback that builds a synthetic snippet from
 *     live dialog state
 *   - the `captureCurrent` callback that turns the current preview
 *     input + actual output into a new test case
 *
 * Multi-file (All Tabs) input in the capture path is flattened into a
 * single string (tabs joined with a newline) since tests are single-
 * input — good enough for programs that don't care about FILENAME/FNR
 * per-file semantics.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {import('./types.js').Param[]} workingParams
 * @param {any} existing
 * @returns {ReturnType<typeof wireTestsSection>}
 */
function wireSnippetTestsSection(ta, workingParams, existing) {
  const snippetTestRunOne = async (test, results) => {
    const synthetic = {
      id: existing?.id || '__draft__',
      name: $('#snippet-name').value || 'draft',
      program: ta.value,
      params: cleanParams(workingParams),
      tests: [test],
    };
    const summary = await runSnippetTests(synthetic);
    const r = summary.results[0];
    if (r) results.set(test.id, r);
    if (!existing) clearCachedSummary('__draft__');
  };
  return wireTestsSection({
    sectionId: '#snippet-tests-section',
    listId: '#snippet-tests-list',
    summaryId: '#snippet-tests-summary',
    addBtnId: '#snippet-tests-add',
    runAllBtnId: '#snippet-tests-run-all',
    captureBtnId: '#snippet-tests-capture',
    captureCurrent: async () => {
      const program = ta.value;
      if (!program.trim()) {
        appAlert('Program is empty.', { level: 'error' });
        return null;
      }
      const src = resolveInput();
      const input =
        src.kind === 'single' ? src.input : src.inputs.map((t) => t.content).join('\n');
      /** @type {Record<string, string>} */
      const vars = {};
      for (const p of workingParams) {
        if (p.name && vars[p.name] === undefined) vars[p.name] = p.default ?? '';
      }
      const r = await runAwk(program, input, vars);
      if (r.stderr) {
        appAlert(`awk error — nothing to capture.\n\n${r.stderr}`, { level: 'error' });
        return null;
      }
      return { input, expected: r.stdout };
    },
    existingTests: existing?.tests,
    existingId: existing?.id,
    getParams: () => cleanParams(workingParams),
    runOneTest: snippetTestRunOne,
    defaultOpen: false,
  });
}

/**
 * Wire the **Copy as shell** button in the chain dialog. Produces the
 * full `awk … | awk … | …` pipe for the current live chain, using
 * chain-level var values.
 *
 * @param {any[]} steps
 * @param {Record<string, string>} chainVars
 */
function wireChainCopyShell(steps, chainVars, getCtx) {
  const btn = /** @type {HTMLButtonElement} */ ($('#chain-copy-shell'));
  btn.onclick = async (e) => {
    e.preventDefault();
    if (!steps.length) {
      appAlert('Chain is empty.', { level: 'error' });
      return;
    }
    // Pass the live per-step context so `buildStepsShellCommand`
    // inlines each step's resolved value (including per-step cmd
    // overrides for encode/decode-style chains).
    const cmd = buildStepsShellCommand(steps, chainVars, getCtx ? getCtx() : {});
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(cmd);
      btn.textContent = 'Copied!';
    } catch (err) {
      btn.textContent = 'Copy failed';
      console.error(err);
    }
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  };
}

/**
 * Wire the **Download script** button in the chain dialog. Reads
 * `settings.scriptExport` fresh on every click so an in-session
 * Settings edit applies without needing to close+reopen the dialog.
 * `buildShellScriptFromTemplate` handles missing / partial config by
 * falling back to the shipped defaults for each field.
 *
 * @param {any[]} steps
 * @param {Record<string, string>} chainVars
 */
function wireChainDownloadScript(steps, chainVars, getCtx) {
  const btn = /** @type {HTMLButtonElement} */ ($('#chain-download-sh'));
  btn.onclick = (e) => {
    e.preventDefault();
    if (!steps.length) {
      appAlert('Chain is empty.', { level: 'error' });
      return;
    }
    const cfg = settings.scriptExport || {};
    const ctx = getCtx ? getCtx() : {};
    // Merge per-step context into the script-export opts — the
    // generator produces numbered `name_N` shell vars when the chain
    // has `perStepNames` listed for a multi-use name.
    const { filename, content } = buildShellScriptFromTemplate(
      $('#chain-name').value,
      steps,
      chainVars,
      { ...cfg, stepVars: ctx.stepVars, perStepNames: ctx.perStepNames },
    );
    const blob = new Blob([content], { type: 'application/x-shellscript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

/**
 * Wire the chain dialog's keyboard-shortcut capture section. Mirrors
 * the snippet dialog's equivalent helper — same two-row shape, same
 * conflict detection via `wireShortcutRow` across both snippets and
 * chains.
 *
 * @param {any} existing
 * @returns {{
 *   chainWorkingShortcuts: Record<'shortcut' | 'shortcutInsert', string>,
 *   chainShortcutCleanups: (() => void)[],
 * }}
 */
function wireChainShortcuts(existing) {
  const chainShortcutDetails = /** @type {HTMLDetailsElement} */ (
    $('#chain-shortcut-section')
  );
  const chainShortcutSummary = /** @type {HTMLElement} */ ($('#chain-shortcut-summary'));
  /** @type {Record<'shortcut' | 'shortcutInsert', string>} */
  const chainWorkingShortcuts = {
    shortcut: existing?.shortcut || '',
    shortcutInsert: existing?.shortcutInsert || '',
  };
  rememberSectionOpenState(
    chainShortcutDetails,
    'chain-shortcut',
    !!(chainWorkingShortcuts.shortcut || chainWorkingShortcuts.shortcutInsert),
  );
  const refreshChainShortcutSummary = () => {
    const parts = [];
    if (chainWorkingShortcuts.shortcut)
      parts.push(formatShortcut(chainWorkingShortcuts.shortcut));
    if (chainWorkingShortcuts.shortcutInsert)
      parts.push(`${formatShortcut(chainWorkingShortcuts.shortcutInsert)}*`);
    chainShortcutSummary.textContent = parts.length ? `· ${parts.join(' / ')}` : '';
  };
  /** @type {(() => void)[]} */
  const chainShortcutCleanups = [];
  for (const [field, inputId, clearId, warnId] of /** @type {const} */ ([
    ['shortcut', '#chain-shortcut-input', '#chain-shortcut-clear', '#chain-shortcut-warning'],
    [
      'shortcutInsert',
      '#chain-shortcut-insert-input',
      '#chain-shortcut-insert-clear',
      '#chain-shortcut-insert-warning',
    ],
  ])) {
    chainShortcutCleanups.push(
      wireShortcutRow({
        ownerKind: 'chain',
        ownerId: existing?.id,
        field,
        inputEl: /** @type {HTMLInputElement} */ ($(inputId)),
        clearEl: /** @type {HTMLButtonElement} */ ($(clearId)),
        warnEl: /** @type {HTMLElement} */ ($(warnId)),
        workingShortcuts: chainWorkingShortcuts,
        refreshSummary: refreshChainShortcutSummary,
      }),
    );
  }
  return { chainWorkingShortcuts, chainShortcutCleanups };
}

/**
 * Wire the chain dialog's Test cases section. Builds a synthetic
 * chain from live dialog state (steps + chainVars) for each run so
 * the developer can iterate without saving. The capture callback
 * mirrors the chain preview's var resolution rules (step defaults
 * overridden by chainVars) and threads the input through each
 * enabled step; multi-file input is flattened the same way as the
 * snippet case.
 *
 * @param {any[]} steps
 * @param {Record<string, string>} chainVars
 * @param {any} existing
 * @returns {ReturnType<typeof wireTestsSection>}
 */
function wireChainTestsSection(steps, chainVars, existing) {
  const chainTestRunOne = async (test, results) => {
    const synthetic = {
      id: existing?.id || '__chain_draft__',
      name: $('#chain-name').value || 'draft',
      steps,
      vars: { ...chainVars },
      tests: [test],
    };
    const summary = await runChainTests(synthetic);
    const r = summary.results[0];
    if (r) results.set(test.id, r);
    if (!existing) clearCachedSummary('__chain_draft__');
  };
  return wireTestsSection({
    sectionId: '#chain-tests-section',
    listId: '#chain-tests-list',
    summaryId: '#chain-tests-summary',
    addBtnId: '#chain-tests-add',
    runAllBtnId: '#chain-tests-run-all',
    captureBtnId: '#chain-tests-capture',
    captureCurrent: async () => {
      if (!steps.length) {
        appAlert('Chain is empty.', { level: 'error' });
        return null;
      }
      /** @type {Record<string, string>} */
      const vars = {};
      const addParams = (list) => {
        if (!list) return;
        for (const p of list) {
          if (vars[p.name] !== undefined) continue;
          const cv = chainVars[p.name];
          vars[p.name] = cv !== undefined && cv !== '' ? cv : (p.default ?? '');
        }
      };
      for (const s of steps) {
        if (s.disabled) continue;
        if (s.snippetId) {
          const sn = state.snippets.find((x) => x.id === s.snippetId);
          addParams(sn?.params);
        } else {
          addParams(s.params);
        }
      }
      const src = resolveInput();
      const input =
        src.kind === 'single' ? src.input : src.inputs.map((t) => t.content).join('\n');
      let cur = input;
      for (const s of steps) {
        if (s.disabled) continue;
        const sn = s.snippetId ? state.snippets.find((x) => x.id === s.snippetId) : null;
        const prog = sn ? sn.program : s.program || '';
        if (!prog) continue;
        const r = await runAwk(prog, cur, vars);
        if (r.stderr) {
          appAlert(`awk error in step "${stepLabel(s)}" — nothing to capture.\n\n${r.stderr}`, {
            level: 'error',
          });
          return null;
        }
        cur = r.stdout;
      }
      return { input, expected: cur };
    },
    existingTests: existing?.tests,
    existingId: existing?.id,
    getParams: () => chainParamList({ steps }),
    runOneTest: chainTestRunOne,
    defaultOpen: false,
  });
}

// ---------- shared shortcut row helper ----------
/**
 * Human-readable tag for a conflict hit's `type` — used in the "will override"
 * / "already claimed by" warning lists.
 *
 * @param {{type: 'snippet'|'chain'|'app'|'system'}} c
 */
function conflictTag(c) {
  switch (c.type) {
    case 'snippet':
      return 'another snippet';
    case 'chain':
      return 'another chain';
    case 'app':
      return 'an app shortcut';
    default:
      return 'a system/browser shortcut';
  }
}

/**
 * Wire one shortcut-capture row (input + Clear + warning block) for a snippet
 * or chain edit dialog. Shared so conflict detection, usability checks, and
 * the warning UI stay identical across both dialogs.
 *
 * The capture rows mutate `workingShortcuts` in place; saving is the caller's
 * responsibility. Returns a cleanup to detach the keydown listener.
 *
 * @param {{
 *   ownerKind: 'snippet' | 'chain',
 *   ownerId?: string,
 *   field: 'shortcut' | 'shortcutInsert',
 *   inputEl: HTMLInputElement,
 *   clearEl: HTMLButtonElement,
 *   warnEl: HTMLElement,
 *   workingShortcuts: { shortcut: string, shortcutInsert: string },
 *   refreshSummary: () => void,
 * }} opts
 * @returns {() => void}
 */
function wireShortcutRow({
  ownerKind,
  ownerId,
  field,
  inputEl,
  clearEl,
  warnEl,
  workingShortcuts,
  refreshSummary,
}) {
  const ownerLabel = ownerKind === 'chain' ? 'chain' : 'snippet';
  const computeConflicts = (combo) =>
    findConflicts(combo, {
      snippets: state.snippets,
      chains: state.chains,
      systemBindings: effectiveSystemShortcuts(settings),
      ignoreSnippetId: ownerKind === 'snippet' ? ownerId : undefined,
      ignoreChainId: ownerKind === 'chain' ? ownerId : undefined,
      ignoreField: field,
    });
  const pushSameOwnerConflict = (conflicts, combo) => {
    // `state.snippets` / `state.chains` don't see the in-flight working copy
    // until save, so cross-field conflicts on the *same* item have to be
    // added manually here.
    const otherField = field === 'shortcut' ? 'shortcutInsert' : 'shortcut';
    if (workingShortcuts[otherField] && workingShortcuts[otherField] === combo) {
      conflicts.push({
        type: ownerKind,
        label: `this ${ownerLabel}${otherField === 'shortcutInsert' ? ' (insert at cursor)' : ''}`,
        blocking: true,
      });
    }
  };
  const renderWarningList = (conflicts, heading) => {
    warnEl.replaceChildren();
    const h = document.createElement('strong');
    h.textContent = heading;
    warnEl.appendChild(h);
    const ul = document.createElement('ul');
    for (const c of conflicts) {
      const li = document.createElement('li');
      li.textContent = `${conflictTag(c)}: ${c.label}`;
      ul.appendChild(li);
    }
    warnEl.appendChild(ul);
  };

  const refresh = () => {
    const cur = workingShortcuts[field];
    inputEl.value = cur ? formatShortcut(cur) : '';
    refreshSummary();
    if (!cur) {
      warnEl.hidden = true;
      warnEl.classList.remove('hard-block');
      warnEl.replaceChildren();
      return;
    }
    const conflicts = computeConflicts(cur);
    pushSameOwnerConflict(conflicts, cur);
    if (!conflicts.length) {
      warnEl.hidden = true;
      warnEl.classList.remove('hard-block');
      warnEl.replaceChildren();
      return;
    }
    warnEl.hidden = false;
    warnEl.classList.remove('hard-block');
    renderWarningList(conflicts, `${formatShortcut(cur)} will be saved and will override:`);
  };

  const onKeydown = (e) => {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      workingShortcuts[field] = '';
      refresh();
      return;
    }
    const combo = normalizeShortcut(e);
    if (!combo) return;
    if (!isUsableCombo(combo)) {
      inputEl.value = formatShortcut(combo);
      warnEl.hidden = false;
      warnEl.classList.add('hard-block');
      warnEl.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = `Can't use ${formatShortcut(combo)} — won't be saved.`;
      warnEl.appendChild(heading);
      const msg = document.createElement('div');
      msg.textContent =
        'Needs a modifier plus a non-modifier key — or a bare function key (F1–F24). Try Ctrl / Alt / Cmd with any key, or Shift with a named key (Enter, Tab, Escape, Space).';
      warnEl.appendChild(msg);
      return;
    }
    const conflicts = computeConflicts(combo);
    pushSameOwnerConflict(conflicts, combo);
    if (conflicts.some((c) => c.blocking)) {
      inputEl.value = formatShortcut(combo);
      warnEl.hidden = false;
      warnEl.classList.add('hard-block');
      warnEl.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = `Can't use ${formatShortcut(combo)} — won't be saved.`;
      warnEl.appendChild(heading);
      const why = document.createElement('div');
      why.textContent = 'Already claimed by:';
      warnEl.appendChild(why);
      const ul = document.createElement('ul');
      for (const c of conflicts) {
        const li = document.createElement('li');
        li.textContent = `${conflictTag(c)}: ${c.label}`;
        ul.appendChild(li);
      }
      warnEl.appendChild(ul);
      return;
    }
    workingShortcuts[field] = combo;
    refresh();
  };

  inputEl.addEventListener('keydown', onKeydown);
  clearEl.onclick = (ev) => {
    ev.preventDefault();
    workingShortcuts[field] = '';
    refresh();
    inputEl.focus();
  };
  refresh();
  return () => inputEl.removeEventListener('keydown', onKeydown);
}

// ---------- dialog section open-state memory ----------
//
// Several <details> sections inside the snippet- and chain-edit dialogs used
// to reset their expand/collapse state on every open: the content-based
// default (e.g. "open metadata if description is set") overwrote the user's
// previous interaction, so closing a section on one chain didn't carry to
// the next. This in-memory map carries each section's last toggle across
// dialog opens within the session; it resets on full reload (intentionally
// — no durable storage for this).
//
// The `*-preview-details` sections keep their own LS_KEYS-backed persistence
// because they carry a "re-run preview on toggle-open" side effect that
// doesn't belong in this generic helper.

/** @type {Map<string, boolean>} */
const rememberedSectionOpen = new Map();
/** @type {WeakSet<HTMLElement>} */
const sectionsWiredForMemory = new WeakSet();

/**
 * Apply the remembered open state to a <details> section, falling back to
 * `contentDefault` the first time this key is seen. Each subsequent user
 * toggle (or programmatic `.open = x`) records the new state, so the next
 * dialog open reuses it.
 *
 * Key should be stable across dialog opens (e.g. `'snippet-metadata'`).
 *
 * @param {HTMLDetailsElement} details
 * @param {string} key
 * @param {boolean} contentDefault
 */
function rememberSectionOpenState(details, key, contentDefault) {
  details.open = rememberedSectionOpen.has(key)
    ? /** @type {boolean} */ (rememberedSectionOpen.get(key))
    : contentDefault;
  if (sectionsWiredForMemory.has(details)) return;
  sectionsWiredForMemory.add(details);
  details.addEventListener('toggle', () => {
    rememberedSectionOpen.set(key, details.open);
  });
}

// ---------- snippet dialog ----------
/**
 * Open the snippet dialog to create or edit a global snippet.
 *
 * If `opts.forkInto` is supplied the dialog is being opened from a chain
 * or pipeline step. Fields are fully editable (the user can legitimately
 * want to fix a typo in the global snippet), but a persistent banner
 * explains the reach of each save path, and two submit buttons are shown:
 * **Update global snippet** mutates the shared snippet as usual, and
 * **Fork to inline step** (primary) instead calls `opts.forkInto(payload)`
 * so the caller can replace its `snippetId` reference with an inline copy —
 * the global snippet stays untouched on that path.
 *
 * `opts.forkContext` parameterises the banner copy ("...this chain step
 * only" vs. "...this pipeline step only").
 *
 * @param {any} existing
 * @param {{
 *   forkInto?: (payload: {name?: string, program: string, params?: any[]}) => void,
 *   forkContext?: string,
 * }} [opts]
 */
export function openSnippetDialog(existing, opts = {}) {
  const dlg = $('#snippet-dialog');
  $('#snippet-title').textContent = existing ? 'Edit snippet' : 'New snippet';
  $('#snippet-name').value = existing?.name || '';
  $('#snippet-description').value = existing?.description || '';
  rememberSectionOpenState(
    /** @type {HTMLDetailsElement} */ ($('#snippet-metadata-section')),
    'snippet-metadata',
    !!(existing?.description || (existing?.tags && existing.tags.length)),
  );
  const snippetTagsWidget = createTagChipInput($('#snippet-tags'), {
    initial: existing?.tags || [],
    suggestions: allSnippetTags(),
    placeholder: 'Add tag…',
  });
  const ta = $('#snippet-program');
  ta.value = existing?.program || '';
  ta.style.width = '';
  ta.style.height = '';
  const lines = ta.value ? ta.value.split('\n').length : 0;
  ta.rows = Math.max(6, Math.min(lines + 1, 30));
  ta.dispatchEvent(new Event('input'));

  const paramsUl = $('#snippet-params');
  const paramsDetails = /** @type {HTMLDetailsElement} */ ($('#snippet-params-section'));
  const workingParams = existing?.params ? existing.params.map((p) => ({ ...p })) : [];
  // Forward-declare `schedulePreview` so the params ✕ / + / Detect
  // handlers below can trigger preview even though the real scheduler
  // isn't wired until `wireSnippetPreview(...)` runs much later. The
  // thunk captures the `let` binding and reads the latest value at
  // call time — safe because none of the clicks can fire before the
  // dialog is fully wired.
  /** @type {() => void} */
  let schedulePreview = () => {};
  const fireParamsChange = () => schedulePreview();
  renderParamRows(paramsUl, workingParams, fireParamsChange);
  rememberSectionOpenState(paramsDetails, 'snippet-params', workingParams.length > 0);
  $('#snippet-add-param').onclick = (e) => {
    e.preventDefault();
    workingParams.push({ name: '', default: '' });
    renderParamRows(paramsUl, workingParams, fireParamsChange);
    paramsDetails.open = true;
    fireParamsChange();
  };
  // Same heuristic as the palette's "Detect from program": tokenize the
  // current program, surface every free identifier that isn't a keyword /
  // builtin / awk-special var / function decl-or-call / array name, and
  // skip names already present in the params list.
  $('#snippet-detect-params').onclick = (e) => {
    e.preventDefault();
    const detected = findCandidateVars(ta.value);
    const existingNames = new Set(workingParams.map((p) => p.name));
    let added = 0;
    for (const name of detected) {
      if (existingNames.has(name)) continue;
      workingParams.push({ name, default: '' });
      existingNames.add(name);
      added++;
    }
    if (added) {
      renderParamRows(paramsUl, workingParams, fireParamsChange);
      paramsDetails.open = true;
      fireParamsChange();
    } else {
      showToast({
        title: 'No new parameters detected',
        body: detected.length
          ? 'Every inferred variable is already in the parameters list.'
          : 'Couldn\u2019t find any `-v` candidates in the current program.',
        level: 'info',
        duration: 3500,
      });
    }
  };

  wireSnippetFork(existing, opts);

  renderSnippetReference();
  // Chip-list template picker with live preview. Hover / keyboard-focus
  // a chip → body previewed in the adjacent pane; click → inserted at
  // the caret. `editText` (via attachTemplatePicker) preserves undo.
  attachTemplatePicker(ta, {
    listId: '#snippet-template-list',
    previewId: '#snippet-template-preview',
    filterId: '#snippet-template-filter',
    // Scope toggles let the user narrow to templates, snippets, or both.
    // Snippets are valid starting points — especially parametric one-liners
    // that also need to be first-class snippets (so chains can reference
    // them). Exclude the snippet being edited so the user can't insert
    // its own body into itself.
    scopeTemplatesBtnId: '#snippet-template-scope-templates',
    scopeSnippetsBtnId: '#snippet-template-scope-snippets',
    excludeSnippetId: existing?.id,
  });

  $('#snippet-program-clear').onclick = async (e) => {
    e.preventDefault();
    if (ta.value && settings.editor.confirmClearProgram) {
      const ok = await appConfirm('Clear the awk program?', {
        title: 'Clear program',
        danger: true,
        okLabel: 'Clear',
      });
      if (!ok) return;
    }
    editTextRange(ta, 0, ta.value.length, '');
  };

  wireDetectFsButton($('#snippet-detect-fs'), ta);
  wireColumnsButton($('#snippet-columns'), ta);
  wireFpatButton($('#snippet-fpat'), ta);
  wireStrftimeButton($('#snippet-strftime'), ta);
  wireFormatButton($('#snippet-format'), ta);

  wireSnippetCopyShell(ta, workingParams);
  wireSnippetDownloadScript(ta, workingParams);

  const _wiredPreview = wireSnippetPreview(ta, workingParams);
  schedulePreview = _wiredPreview.schedulePreview;
  const previewCleanup = _wiredPreview.cleanup;
  ta.addEventListener('input', schedulePreview);
  paramsUl.addEventListener('input', schedulePreview);

  const { workingShortcuts, shortcutCleanups } = wireSnippetShortcuts(existing);
  const { workingTests } = wireSnippetTestsSection(ta, workingParams, existing);

  const row = dlg.querySelector('.snippet-editor-row');
  const refStored = localStorage.getItem(LS_KEYS.REF_HIDDEN);
  const refHidden = refStored === null ? !settings.ui.referenceDefaultShown : refStored === '1';
  row.classList.toggle('ref-hidden', refHidden);
  const refBtn = $('#ref-toggle');
  refBtn.textContent = refHidden ? 'Show reference' : 'Hide reference';
  refBtn.onclick = () => {
    const hidden = !row.classList.contains('ref-hidden');
    row.classList.toggle('ref-hidden', hidden);
    refBtn.textContent = hidden ? 'Show reference' : 'Hide reference';
    safeSetItem(LS_KEYS.REF_HIDDEN, hidden ? '1' : '0');
  };

  const sizeRaw = localStorage.getItem(LS_KEYS.SNIPPET_DLG_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }

  const refAside = $('#snippet-reference');
  const refSizeRaw = localStorage.getItem(LS_KEYS.REF_SIZE);
  if (refSizeRaw) {
    try {
      const { width, height } = JSON.parse(refSizeRaw);
      if (width) refAside.style.width = width + 'px';
      if (height) refAside.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }

  // When editing an existing snippet that is referenced by chains, intercept
  // the Save click to warn the user and offer alternatives. Skipped when the
  // edit doesn't affect how chains execute — tags, description, tests,
  // favourite, and shortcut are chain-safe, so tag-only edits save directly
  // without the prompt.
  const saveBtn = /** @type {HTMLButtonElement} */ ($('#snippet-save'));
  const onSaveClick = async (e) => {
    if (!existing) return; // new snippet — no chain references possible
    const referencingChains = state.chains.filter((c) =>
      c.steps.some((s) => s.snippetId === existing.id),
    );
    if (!referencingChains.length) return; // no chain references
    if (!snippetEditAffectsChains(existing, workingParams)) return;
    e.preventDefault();
    const names = referencingChains.map((c) => c.name).join(', ');
    const choice = await appChoose(
      `This snippet is used by ${referencingChains.length} chain${referencingChains.length === 1 ? '' : 's'}: ${names}. Saving will affect those chains.`,
      {
        title: 'Snippet used by chains',
        buttons: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'inline', label: 'Convert to inline' },
          { value: 'new', label: 'Save as new' },
          { value: 'save', label: 'Save anyway', primary: true },
        ],
      },
    );
    if (choice === 'save') {
      dlg.close('save');
    } else if (choice === 'new') {
      // Save as a new snippet — clear `existing` linkage by closing with
      // a custom return value handled in the close listener.
      dlg.close('save-as-new');
    } else if (choice === 'inline') {
      // Convert all chain references to inline steps, then save.
      for (const c of referencingChains) {
        for (const s of c.steps) {
          if (s.snippetId === existing.id) {
            s.program = existing.program;
            s.name = existing.name;
            if (existing.params) s.params = existing.params.map((p) => ({ ...p }));
            delete s.snippetId;
          }
        }
      }
      saveState();
      dispatch('library:chains-changed');
      dlg.close('save');
    }
    // else cancelled — do nothing, dialog stays open
  };
  saveBtn.addEventListener('click', onSaveClick);

  dlg.returnValue = '';
  dlg.showModal();
  const rect = dlg.getBoundingClientRect();
  let lastW = rect.width,
    lastH = rect.height;
  const saveSize = () => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(LS_KEYS.SNIPPET_DLG_SIZE, JSON.stringify({ width: r.width, height: r.height }));
    }
  };
  const ro = new ResizeObserver(saveSize);
  ro.observe(dlg);
  const refRect = refAside.getBoundingClientRect();
  let lastRefW = refRect.width,
    lastRefH = refRect.height;
  const saveRefSize = () => {
    const r = refAside.getBoundingClientRect();
    if (Math.abs(r.width - lastRefW) > 2 || Math.abs(r.height - lastRefH) > 2) {
      lastRefW = r.width;
      lastRefH = r.height;
      safeSetItem(LS_KEYS.REF_SIZE, JSON.stringify({ width: r.width, height: r.height }));
    }
  };
  const roRef = new ResizeObserver(saveRefSize);
  roRef.observe(refAside);
  dlg.addEventListener(
    'close',
    () => {
      ro.disconnect();
      roRef.disconnect();
      ta.removeEventListener('input', schedulePreview);
      paramsUl.removeEventListener('input', schedulePreview);
      for (const fn of shortcutCleanups) fn();
      previewCleanup();
      saveBtn.removeEventListener('click', onSaveClick);
      const saveAsNew = dlg.returnValue === 'save-as-new';
      if (dlg.returnValue !== 'save' && dlg.returnValue !== 'fork' && !saveAsNew) return;
      const name = $('#snippet-name').value.trim();
      const program = $('#snippet-program').value;
      const description = $('#snippet-description').value.trim();
      if (!name) return;
      const params = cleanParams(workingParams);
      const tags = normalizeTags(snippetTagsWidget.getTags());
      // Fork path: hand the chain dialog a payload to replace its step with an
      // inline copy. Global snippet stays untouched. Description is dropped
      // because inline steps don't carry one today.
      if (dlg.returnValue === 'fork' && opts.forkInto) {
        const payload = { program };
        if (name) payload.name = name;
        if (params.length) payload.params = params;
        opts.forkInto(payload);
        return;
      }
      const savedTests = cleanTests(workingTests);
      /** @type {string | null} */
      let createdSnippetId = null;
      if (existing && !saveAsNew) {
        existing.name = name;
        existing.program = program;
        if (description) existing.description = description;
        else delete existing.description;
        if (params.length) existing.params = params;
        else delete existing.params;
        if (tags.length) existing.tags = tags;
        else delete existing.tags;
        if (workingShortcuts.shortcut) existing.shortcut = workingShortcuts.shortcut;
        else delete existing.shortcut;
        if (workingShortcuts.shortcutInsert)
          existing.shortcutInsert = workingShortcuts.shortcutInsert;
        else delete existing.shortcutInsert;
        if (savedTests.length) existing.tests = savedTests;
        else delete existing.tests;
        // The cached test summary is keyed off the snippet id; the program
        // (or its tests) just changed, so invalidate to force a re-run on the
        // next read instead of showing a stale ✓ / ✗.
        clearCachedSummary(existing.id);
      } else {
        const snippet = { id: uid(), name, program };
        if (description) snippet.description = description;
        if (params.length) snippet.params = params;
        if (tags.length) snippet.tags = tags;
        if (workingShortcuts.shortcut) snippet.shortcut = workingShortcuts.shortcut;
        if (workingShortcuts.shortcutInsert)
          snippet.shortcutInsert = workingShortcuts.shortcutInsert;
        if (savedTests.length) snippet.tests = savedTests;
        state.snippets.push(snippet);
        createdSnippetId = snippet.id;
      }
      saveState();
      renderPipeline();
      scheduleAutoPreview();
      dispatch('library:snippets-changed');
      // Just-created snippets: expand the Snippets section if it was
      // collapsed, scroll the new row into view, and briefly flash it
      // green. Skipped for edits — the user already knows where that row
      // is. Runs after the render event above so the li exists when
      // highlightSidebarRow queries it.
      if (createdSnippetId) {
        highlightSidebarRow({
          sectionKey: 'snippets',
          listId: 'snippets',
          itemId: createdSnippetId,
        });
      }
      // Optional: run the snippet's tests after every save. Toggled in
      // Settings → Tests (on by default). On failure: toast, briefly flash
      // the sidebar row, and ask main.js to make the row visible (expand any
      // collapsed parents). Reveal/pulse goes via CustomEvent to avoid a
      // dialogs.js → library.js import cycle (library.js imports dialogs.js).
      if (settings.tests?.runOnSave && savedTests.length) {
        const target = existing || state.snippets[state.snippets.length - 1];
        if (target) {
          runSnippetTests(target)
            .then((summary) => {
              if (summary.fail > 0) {
                showToast({
                  title: `"${target.name}": ${summary.fail} of ${summary.total} test${summary.total === 1 ? '' : 's'} failing`,
                  level: 'error',
                  duration: 5000,
                });
                pulseSidebarRow('snippets', target.id);
                dispatch('tests:reveal-snippet', { snippetId: target.id });
              }
            })
            .catch((err) => {
              // A rejection means the runner itself threw (network
              // drop, server 5xx) — distinct from a test just failing.
              // Surface so the user isn't left wondering why their
              // status dot never updated.
              showToast({
                title: `Couldn't run tests for "${target.name}"`,
                body: String(err && err.message ? err.message : err),
                level: 'error',
                duration: 6000,
              });
            });
        }
      }
    },
    { once: true },
  );
}

// ---------- template dialog ----------
export function openTemplateDialog(existing) {
  const dlg = $('#template-dialog');
  $('#template-title').textContent = existing ? 'Edit template' : 'New template';
  $('#template-name').value = existing?.name || '';
  $('#template-description').value = existing?.description || '';
  /** @type {HTMLDetailsElement} */ ($('#template-metadata-section')).open = !!(
    existing?.description ||
    (existing?.tags && existing.tags.length)
  );
  const templateTagsWidget = createTagChipInput($('#template-tags'), {
    initial: existing?.tags || [],
    suggestions: allTemplateTags(),
    placeholder: 'Add tag…',
  });
  const ta = $('#template-body');
  ta.value = existing?.body || '';
  ta.style.height = '';
  const lines = ta.value ? ta.value.split('\n').length : 0;
  ta.rows = Math.max(10, Math.min(lines + 1, 30));
  ta.dispatchEvent(new Event('input'));

  const sizeRaw = localStorage.getItem(LS_KEYS.TEMPLATE_DLG_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }

  dlg.returnValue = '';
  dlg.showModal();

  const rect0 = dlg.getBoundingClientRect();
  let lastW = rect0.width,
    lastH = rect0.height;
  const saveSize = () => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(LS_KEYS.TEMPLATE_DLG_SIZE, JSON.stringify({ width: r.width, height: r.height }));
    }
  };
  const ro = new ResizeObserver(saveSize);
  ro.observe(dlg);

  dlg.addEventListener(
    'close',
    () => {
      ro.disconnect();
      if (dlg.returnValue !== 'save') return;
      const name = $('#template-name').value.trim();
      const body = $('#template-body').value;
      const description = $('#template-description').value.trim();
      const tags = normalizeTags(templateTagsWidget.getTags());
      if (!name) return;
      if (existing) {
        existing.name = name;
        existing.body = body;
        if (description) existing.description = description;
        else delete existing.description;
        if (tags.length) existing.tags = tags;
        else delete existing.tags;
      } else {
        const tpl = { id: uid(), name, body };
        if (description) tpl.description = description;
        if (tags.length) tpl.tags = tags;
        state.templates.push(tpl);
      }
      saveState();
      dispatch('library:templates-changed');
    },
    { once: true },
  );
}

// ---------- chain dialog ----------
/**
 * Scheduler for the in-progress chain-dialog preview. Installed by
 * `openChainDialog` and cleared on close so `renderChainDialogSteps` can
 * trigger a re-run after any mutation (add / remove / reorder / inline edit)
 * without each call site needing to know preview exists.
 * @type {() => void}
 */
let scheduleChainPreview = () => {};

function renderChainDialogSteps(steps) {
  const ol = $('#chain-steps');
  ol.innerHTML = '';
  scheduleChainPreview();
  if (!steps.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'No steps yet. Add one below.';
    ol.appendChild(div);
    return;
  }
  steps.forEach((step, i) => {
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    // Prefix with the step's 1-based position so two steps using the
    // same snippet (e.g. `Run Command (with stdin)` twice) can be
    // distinguished without forking to inline just to rename.
    const name = `${i + 1}. ${stepLabel(step)}`;
    const prog = sn ? sn.program : step.program || '';
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.index = String(i);
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const to = i;
      if (!Number.isInteger(from) || from === to) return;
      const moved = steps.splice(from, 1)[0];
      steps.splice(to, 0, moved);
      renderChainDialogSteps(steps);
    });
    li.innerHTML = `<span class="name"></span>
      <button type="button" data-act="toggle">⏻</button>
      <button type="button" data-act="up" title="Up">▲</button>
      <button type="button" data-act="down" title="Down">▼</button>
      <button type="button" data-act="edit" title="Edit">✎</button>
      <button type="button" data-act="rm" title="Remove">✕</button>`;
    li.querySelector('.name').textContent = name;
    li.title = prog;
    if (step.disabled) li.classList.add('step-disabled');
    const toggleBtn = /** @type {HTMLButtonElement} */ (
      li.querySelector('[data-act="toggle"]')
    );
    toggleBtn.title = step.disabled ? 'Enable step' : 'Disable step';
    toggleBtn.setAttribute('aria-pressed', step.disabled ? 'true' : 'false');
    li.addEventListener('click', (e) => {
      const b = closestOn(e, 'button');
      if (!b) return;
      e.preventDefault();
      const act = b.dataset.act;
      if (act === 'up' && i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
      else if (act === 'down' && i < steps.length - 1)
        [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
      else if (act === 'rm') steps.splice(i, 1);
      else if (act === 'toggle') {
        if (step.disabled) delete step.disabled;
        else step.disabled = true;
      } else if (act === 'edit') {
        if (step.snippetId) {
          if (sn) {
            // Fork mode — editing from within a chain should never silently
            // mutate the shared global snippet. The dialog starts read-only;
            // an explicit Fork converts this step into an inline copy.
            openSnippetDialog(sn, {
              forkContext: 'this chain step',
              forkInto: (payload) => {
                delete step.snippetId;
                delete step.name;
                delete step.params;
                step.program = payload.program;
                if (payload.name) step.name = payload.name;
                if (payload.params && payload.params.length) step.params = payload.params;
                renderChainDialogSteps(steps);
              },
            });
          } else {
            appAlert('Snippet no longer exists.', { level: 'error' });
          }
        } else {
          openInlineStepDialog(step, () => renderChainDialogSteps(steps), steps.slice(0, i));
        }
        return;
      }
      renderChainDialogSteps(steps);
    });
    ol.appendChild(li);
  });
}

function renderChainSnippetPicker(steps, filter = '') {
  const div = $('#chain-snippet-picker');
  div.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const sorted = [...state.snippets].sort(favoriteThenName);
  const list = q ? sorted.filter((sn) => sn.name.toLowerCase().includes(q)) : sorted;
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No matches.';
    div.appendChild(empty);
    return;
  }
  for (const sn of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '+ ' + sn.name;
    b.title = sn.description || sn.program;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      // Stamp a stable `id` on every new step — per-step var overrides
      // in `chain.stepVars` key on it.
      steps.push({ id: uid(), snippetId: sn.id });
      renderChainDialogSteps(steps);
    });
    div.appendChild(b);
  }
}

export function openChainDialog(existing) {
  const dlg = $('#chain-dialog');
  $('#chain-title').textContent = existing ? 'Edit chain' : 'New chain';
  $('#chain-name').value = existing?.name || '';
  $('#chain-description').value = existing?.description || '';
  rememberSectionOpenState(
    /** @type {HTMLDetailsElement} */ ($('#chain-metadata-section')),
    'chain-metadata',
    !!(existing?.description || (existing?.tags && existing.tags.length)),
  );
  const chainTagsWidget = createTagChipInput($('#chain-tags'), {
    initial: existing?.tags || [],
    suggestions: allChainTags(),
    placeholder: 'Add tag…',
  });
  // Deep-ish copy of existing steps so edits don't mutate the saved
  // chain until the user hits Save. Backfill `id` on any step that
  // predates per-step-vars — `chain.stepVars` keys on it.
  const steps = existing
    ? existing.steps.map((s) => ({ ...s, id: s.id || uid() }))
    : [];
  renderChainDialogSteps(steps);
  // New chain: expand "Add step" so the user sees the snippet picker and the
  // inline-step button immediately — they have nothing to browse yet. Edit
  // chain: leave the user's previous open/closed choice alone. The <details>
  // element is shared DOM across opens, so without this call a New-chain
  // dialog could inherit a "collapsed" state from an earlier Edit session.
  if (!existing) {
    /** @type {HTMLDetailsElement} */ (
      document.querySelector('#chain-dialog .chain-add-step-section')
    ).open = true;
  }
  const filterInput = $('#chain-snippet-filter');
  filterInput.value = '';
  filterInput.oninput = () => renderChainSnippetPicker(steps, filterInput.value);
  renderChainSnippetPicker(steps, '');

  const sizeRaw = localStorage.getItem(LS_KEYS.CHAIN_DLG_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }

  // "+ Add inline step" delegates to the inline-step dialog (same editor the
  // user sees when they click ✎ on an inline step), giving parity between
  // create and edit: templates, reference, params, Save-as-snippet, etc.
  // The draft object is mutated in-place by the sub-dialog on save; we only
  // push it onto the chain if the callback fires (i.e. save path, not cancel).
  $('#chain-add-inline').onclick = (e) => {
    e.preventDefault();
    const draft = { id: uid(), program: '' };
    // New step appends to the chain — every current step precedes it.
    openInlineStepDialog(
      draft,
      () => {
        steps.push(draft);
        renderChainDialogSteps(steps);
      },
      steps.slice(),
    );
  };

  // Chain-level variable defaults plus optional per-step overrides.
  // `chainVars[name]` applies to every step that declares `name`;
  // `stepVars[stepId][name]` wins for that specific step when set.
  // Both are mutated in place via input handlers; orphaned entries are
  // pruned on save. The list rebuilds whenever the step set changes.
  /** @type {Record<string, string>} */
  const chainVars = { ...(existing?.vars || {}) };
  /** @type {Record<string, Record<string, string>>} */
  const stepVars = {};
  if (existing?.stepVars) {
    for (const [sid, overrides] of Object.entries(existing.stepVars)) {
      stepVars[sid] = { ...overrides };
    }
  }
  // Per-dialog state for the "Different per step?" toggle. Tracked
  // separately from `stepVars` so a name can be expanded without the
  // user having typed any value yet — the sub-inputs render with the
  // step's own declared default as placeholder text.
  /** @type {Set<string>} */
  const expandedNames = new Set();
  // Names the user has manually clicked (in either direction). Auto-
  // expand stops re-firing on them so a manual collapse sticks; a
  // manually-expanded name stays expanded even if the step set
  // changes such that the auto-expand heuristic would no longer
  // apply.
  /** @type {Set<string>} */
  const userDecidedNames = new Set();
  // On load, hydrate expansion state from the chain's explicit
  // `perStepNames` (the persisted mode flag) AND from any stored
  // per-step overrides (legacy chains, or ones where the user typed
  // values). Both signal "per-step mode is engaged."
  if (existing?.perStepNames) {
    for (const name of existing.perStepNames) {
      expandedNames.add(name);
      userDecidedNames.add(name);
    }
  }
  if (existing?.stepVars) {
    for (const overrides of Object.values(existing.stepVars)) {
      for (const name of Object.keys(overrides)) {
        expandedNames.add(name);
        userDecidedNames.add(name);
      }
    }
  }
  const varsListEl = /** @type {HTMLElement} */ ($('#chain-vars-list'));
  const varsEmptyEl = /** @type {HTMLElement} */ ($('#chain-vars-empty'));
  const varsCountEl = /** @type {HTMLElement} */ ($('#chain-vars-count'));

  /**
   * Auto-expand heuristic: when a name is used by multiple steps AND
   * the chain-level value is unset AND the step-declared defaults
   * differ across those steps, pre-expand the per-step view so the
   * divergent defaults are visible as placeholders. Saves the user a
   * click in the exact case where per-step values are the obvious
   * intent (encode-then-decode with two different `cmd` defaults).
   */
  const shouldAutoExpand = (name, uses) => {
    if (uses.length < 2) return false;
    if (chainVars[name] !== undefined && chainVars[name] !== '') return false;
    const distinct = new Set(uses.map((u) => u.param.default ?? ''));
    return distinct.size > 1;
  };

  /**
   * Placeholder text for a per-step input. Mirrors the run-time
   * precedence under per-step mode: step default wins, chain-level
   * fills gaps, otherwise the step will prompt at run time. Kept in
   * one place so the chain-level input's 'input' handler can re-run
   * it on each keystroke without duplicating the branch logic.
   *
   * @param {import('./types.js').Param} param
   * @param {string} name
   */
  const perStepPlaceholder = (param, name) => {
    if (param.default !== undefined && param.default !== '') {
      return `default: ${param.default}`;
    }
    if (chainVars[name] !== undefined && chainVars[name] !== '') {
      return `chain default: ${chainVars[name]}`;
    }
    return '(no default — will prompt)';
  };

  const renderChainVars = () => {
    const usage = chainParamUsage({ steps });
    const names = Object.keys(usage);
    varsListEl.innerHTML = '';
    varsEmptyEl.hidden = names.length > 0;
    for (const name of names) {
      const uses = usage[name];
      const defaultParam = uses[0].param;
      // Auto-expand when the step defaults diverge — the user's
      // obvious intent for encode-then-decode style chains. Skip if
      // the user has manually clicked the toggle already (in either
      // direction), so their choice sticks.
      if (!userDecidedNames.has(name) && shouldAutoExpand(name, uses)) {
        expandedNames.add(name);
      }
      const expanded = expandedNames.has(name);
      const li = document.createElement('li');
      li.className = 'chain-var-row';

      // ----- chain-level header row -----
      const head = document.createElement('div');
      head.className = 'chain-var-head';
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = name;
      head.appendChild(label);

      // Chain-global input, meaningful in both collapsed + expanded
      // modes (when expanded, it's the fallback for steps without an
      // explicit override).
      const chainInput = document.createElement('input');
      chainInput.type = 'text';
      chainInput.spellcheck = false;
      chainInput.value = chainVars[name] !== undefined ? chainVars[name] : '';
      chainInput.placeholder = defaultParam.default
        ? `default: ${defaultParam.default}`
        : '(no default — will prompt)';
      // Track per-step inputs for this name so a change to the chain-
      // level input can update their placeholders in place (without a
      // full re-render that would blow away the user's focus).
      /** @type {{input: HTMLInputElement, param: import('./types.js').Param}[]} */
      const subInputsForName = [];
      chainInput.addEventListener('input', () => {
        const v = chainInput.value;
        if (v === '') delete chainVars[name];
        else chainVars[name] = v;
        // Per-step sub-inputs without a step default fall back to the
        // chain-level value as their placeholder; refresh those labels
        // so the user sees what will actually be used as they type.
        for (const { input, param } of subInputsForName) {
          input.placeholder = perStepPlaceholder(param, name);
        }
        refreshVarsCount();
      });
      head.appendChild(chainInput);

      // Per-step toggle — only offered when multiple steps use this
      // name. A single user wouldn't need to differentiate, and the
      // toggle would just be noise on the common case.
      if (uses.length > 1) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'chain-var-perstep-toggle';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? 'Per-step ▾' : 'Different per step? ▸';
        toggle.title =
          'Set a different value for each step that uses this variable';
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          userDecidedNames.add(name);
          if (expandedNames.has(name)) {
            // Collapse: drop every per-step override for this name.
            // Chain-global + step default take over.
            expandedNames.delete(name);
            for (const u of uses) {
              if (stepVars[u.stepId]) delete stepVars[u.stepId][name];
              if (
                stepVars[u.stepId] &&
                Object.keys(stepVars[u.stepId]).length === 0
              ) {
                delete stepVars[u.stepId];
              }
            }
          } else {
            // Expand: just remember the choice. Don't seed any values —
            // the per-step inputs render empty with the step's declared
            // `default` as placeholder, so the user sees what will be
            // used and only types to override.
            expandedNames.add(name);
          }
          renderChainVars();
          refreshVarsCount();
          // Toggling the per-step mode changes how `resolveStepVars`
          // picks values — collapse drops the per-step overrides and
          // hands resolution back to chainVars / step defaults; expand
          // promotes step defaults over chainVars. Either way the run-
          // time output for every using step changes, so refresh the
          // preview to keep what the user sees in sync with what would
          // run.
          chainRunner.schedulePreview();
        });
        head.appendChild(toggle);
      }
      li.appendChild(head);

      // ----- per-step rows (only when expanded) -----
      if (expanded && uses.length > 1) {
        const subList = document.createElement('ul');
        subList.className = 'chain-var-perstep-list';
        for (const u of uses) {
          const subLi = document.createElement('li');
          subLi.className = 'chain-var-perstep-row';
          const subLabel = document.createElement('span');
          subLabel.className = 'chain-var-perstep-label muted';
          // Match the "N. Label" prefix used in the Steps list above
          // so the user can align per-step inputs with the right step
          // at a glance.
          subLabel.textContent = `${u.index + 1}. ${stepLabel(u.step)}`;
          const subInput = document.createElement('input');
          subInput.type = 'text';
          subInput.spellcheck = false;
          const cur = stepVars[u.stepId]?.[name];
          subInput.value = cur !== undefined ? cur : '';
          subInput.placeholder = perStepPlaceholder(u.param, name);
          subInput.addEventListener('input', () => {
            const v = subInput.value;
            if (!stepVars[u.stepId]) stepVars[u.stepId] = {};
            if (v === '') delete stepVars[u.stepId][name];
            else stepVars[u.stepId][name] = v;
            if (Object.keys(stepVars[u.stepId]).length === 0) {
              delete stepVars[u.stepId];
            }
            refreshVarsCount();
          });
          subInputsForName.push({ input: subInput, param: u.param });
          subLi.appendChild(subLabel);
          subLi.appendChild(subInput);
          subList.appendChild(subLi);
        }
        li.appendChild(subList);
      }
      varsListEl.appendChild(li);
    }
    refreshVarsCount();
  };

  const refreshVarsCount = () => {
    const params = chainParamList({ steps });
    if (!params.length) {
      varsCountEl.textContent = '';
      return;
    }
    // Count chain-level + any per-step overrides as "set", so the user
    // sees a non-zero count when they've dialled in an override even
    // with no chain-level value.
    const setNames = new Set();
    for (const [k, v] of Object.entries(chainVars)) {
      if (v !== '') setNames.add(k);
    }
    for (const overrides of Object.values(stepVars)) {
      for (const [k, v] of Object.entries(overrides)) {
        if (v !== '') setNames.add(k);
      }
    }
    if (setNames.size) {
      varsCountEl.textContent = `· ${setNames.size} of ${params.length} set`;
    } else {
      varsCountEl.textContent = `· ${params.length} available`;
    }
  };

  // Copy this chain as a shell pipe — uses the working steps and chainVars
  // (current edit state, may not yet be saved). The `getCtx` closure
  // captures live per-step state (stepVars + which names are expanded
  // per-step) so the export reflects edits the user just made.
  const getChainShellCtx = () => {
    // Snapshot perStepNames from the live expansion set, filtered to
    // names still declared by at least one live step.
    const liveNames = new Set(chainParamList({ steps }).map((p) => p.name));
    return {
      stepVars,
      perStepNames: [...expandedNames].filter((n) => liveNames.has(n)),
    };
  };
  wireChainCopyShell(steps, chainVars, getChainShellCtx);
  wireChainDownloadScript(steps, chainVars, getChainShellCtx);

  // Preview section — runs the whole chain against the active tab. The
  // toggle state persists across opens via LS_KEYS.CHAIN_PREVIEW_ON. Every
  // step mutation routes through renderChainDialogSteps, which calls the
  // scheduler set up here (and reset to noop on close).
  const previewDetails = /** @type {HTMLDetailsElement} */ ($('#chain-preview-details'));
  const previewMeta = /** @type {HTMLElement} */ ($('#chain-preview-meta'));
  const previewOut = /** @type {HTMLElement} */ ($('#chain-preview-output'));
  previewOut.classList.remove('error');
  const refreshChainMeta = () => {
    const active = steps.filter((s) => !s.disabled).length;
    const countLabel =
      active === steps.length
        ? `${steps.length} step${steps.length === 1 ? '' : 's'}`
        : `${active} of ${steps.length} step${steps.length === 1 ? '' : 's'} active`;
    const prefix = steps.length ? `${countLabel}` : 'chain is empty';
    previewMeta.textContent = `${prefix} · ${formatPreviewInputLabel()}`;
  };
  const runChainPreview = async (manual = false) => {
    if (!previewDetails.open) return;
    // Safety gate applied to the union of all step programs — a single
    // side-effecting step is enough to require a manual "Run preview".
    if (!manual) {
      const programs = steps
        .filter((s) => !s.disabled)
        .map((s) => {
          const sn = s.snippetId ? state.snippets.find((x) => x.id === s.snippetId) : null;
          return sn ? sn.program : s.program || '';
        });
      const gate = gatePreviewOrNull(programs);
      if (gate) {
        renderPreviewGate(previewOut, gate, () => runChainPreview(true));
        return;
      }
    }
    const token = chainRunner.guard.claim();
    // Synth a chain shape from the dialog's live state so resolveStepVars
    // sees the same precedence the saved chain would: chainVars + stepVars
    // + per-step mode flag (the names whose "Different per step?" toggle
    // is currently expanded). This is the path that lets per-step values
    // typed in the dialog actually flow through to each step's awk run.
    const synthChain = {
      steps,
      vars: chainVars,
      stepVars,
      perStepNames: [...expandedNames],
    };
    const { src, singleInput, note } = resolvePreviewInput();
    let cur = singleInput;
    let firstStep = true;
    for (const s of steps) {
      if (s.disabled) continue;
      const sn = s.snippetId ? state.snippets.find((x) => x.id === s.snippetId) : null;
      const prog = sn ? sn.program : s.program || '';
      const label = stepLabel(s);
      if (!prog) continue;
      const vars = resolveStepVars(synthChain, s);
      // Multi-file semantics only apply to the first executed step; after
      // that the stream is a single concatenated string (mirrors pipeline).
      const r =
        firstStep && src.kind === 'multi'
          ? await runAwkMulti(prog, src.inputs, vars)
          : await runAwk(prog, cur, vars);
      if (!chainRunner.guard.isCurrent(token)) return;
      if (r.stderr) {
        writePreviewStderr(previewOut, `[error in step "${label}"]\n${r.stderr}`);
        return;
      }
      cur = r.stdout;
      firstStep = false;
    }
    // Final freshness check before the synchronous write. Cheap belt-and-
    // suspenders against a same-tick claim by a newer run sneaking in
    // between the last per-await check and this commit.
    if (!chainRunner.guard.isCurrent(token)) return;
    writePreviewStdout(previewOut, (cur || '(no output)') + note);
  };
  const chainRunner = createPreviewRunner({
    details: previewDetails,
    lsKey: LS_KEYS.CHAIN_PREVIEW_ON,
    run: runChainPreview,
    refreshMeta: refreshChainMeta,
  });
  scheduleChainPreview = () => {
    chainRunner.refreshMetaAndMaybeRun();
    renderChainVars();
    reRenderChainTests();
  };
  // Var-row edits should also refresh the preview so the user sees the
  // effect of changing a default immediately. `varsListEl` is the same
  // DOM node across dialog opens, so the listener has to be removed on
  // close — otherwise each reopen stacks another listener and a single
  // keystroke ends up scheduling N runs through N stale chainRunner
  // closures, with the slowest stale run racing past the current one.
  const onVarsInput = () => chainRunner.schedulePreview();
  varsListEl.addEventListener('input', onVarsInput);
  renderChainVars();

  const { workingTests: chainWorkingTests, renderTests: reRenderChainTests } =
    wireChainTestsSection(steps, chainVars, existing);
  const { chainWorkingShortcuts, chainShortcutCleanups } = wireChainShortcuts(existing);

  dlg.returnValue = '';
  dlg.showModal();

  const rect0 = dlg.getBoundingClientRect();
  let lastW = rect0.width,
    lastH = rect0.height;
  const saveSize = () => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(LS_KEYS.CHAIN_DLG_SIZE, JSON.stringify({ width: r.width, height: r.height }));
    }
  };
  const ro = new ResizeObserver(saveSize);
  ro.observe(dlg);

  dlg.addEventListener(
    'close',
    () => {
      ro.disconnect();
      chainRunner.cleanup();
      varsListEl.removeEventListener('input', onVarsInput);
      scheduleChainPreview = () => {};
      for (const fn of chainShortcutCleanups) fn();
      if (dlg.returnValue !== 'save') return;
      const name = $('#chain-name').value.trim();
      if (!name) {
        appAlert('Chain needs a name.', { level: 'error' });
        return;
      }
      if (!steps.length) {
        appAlert('Chain needs at least one step.', { level: 'error' });
        return;
      }
      // Prune chainVars whose names are no longer declared by any step — keeps
      // saved data clean as the user edits the chain over time.
      const liveNames = new Set(chainParamList({ steps }).map((p) => p.name));
      /** @type {Record<string,string>} */
      const finalVars = {};
      for (const [k, v] of Object.entries(chainVars)) {
        if (liveNames.has(k) && v !== '') finalVars[k] = v;
      }
      // Per-step overrides: keep only non-empty entries; `pruneOrphanStepVars`
      // below drops stepIds no longer in `steps` and names no longer declared
      // by their step. Build `finalStepVars` as a fresh copy so we don't mutate
      // the working state if save bails later.
      /** @type {Record<string, Record<string, string>>} */
      const finalStepVars = {};
      for (const [sid, overrides] of Object.entries(stepVars)) {
        /** @type {Record<string, string>} */
        const clean = {};
        for (const [k, v] of Object.entries(overrides)) {
          if (v !== '') clean[k] = v;
        }
        if (Object.keys(clean).length) finalStepVars[sid] = clean;
      }
      // Persist which names the user engaged per-step mode for, but
      // only ones still declared by at least one live step. This is
      // the mode flag that flips `resolveStepVars`'s precedence so
      // step defaults beat `chain.vars` when the user's expecting
      // per-step behaviour.
      const finalPerStepNames = [...expandedNames].filter((n) => liveNames.has(n));
      const description = $('#chain-description').value.trim();
      const tags = normalizeTags(chainTagsWidget.getTags());
      const savedChainTests = cleanTests(chainWorkingTests);
      /** @type {string | null} */
      let createdChainId = null;
      if (existing) {
        existing.name = name;
        existing.steps = steps;
        if (description) existing.description = description;
        else delete existing.description;
        if (tags.length) existing.tags = tags;
        else delete existing.tags;
        if (Object.keys(finalVars).length) existing.vars = finalVars;
        else delete existing.vars;
        if (Object.keys(finalStepVars).length) existing.stepVars = finalStepVars;
        else delete existing.stepVars;
        if (finalPerStepNames.length) existing.perStepNames = finalPerStepNames;
        else delete existing.perStepNames;
        pruneOrphanStepVars(existing);
        if (chainWorkingShortcuts.shortcut) existing.shortcut = chainWorkingShortcuts.shortcut;
        else delete existing.shortcut;
        if (chainWorkingShortcuts.shortcutInsert)
          existing.shortcutInsert = chainWorkingShortcuts.shortcutInsert;
        else delete existing.shortcutInsert;
        if (savedChainTests.length) existing.tests = savedChainTests;
        else delete existing.tests;
        clearCachedSummary(existing.id);
      } else {
        /** @type {any} */
        const chain = { id: uid(), name, steps };
        if (description) chain.description = description;
        if (tags.length) chain.tags = tags;
        if (Object.keys(finalVars).length) chain.vars = finalVars;
        if (Object.keys(finalStepVars).length) chain.stepVars = finalStepVars;
        if (finalPerStepNames.length) chain.perStepNames = finalPerStepNames;
        pruneOrphanStepVars(chain);
        if (chainWorkingShortcuts.shortcut) chain.shortcut = chainWorkingShortcuts.shortcut;
        if (chainWorkingShortcuts.shortcutInsert)
          chain.shortcutInsert = chainWorkingShortcuts.shortcutInsert;
        if (savedChainTests.length) chain.tests = savedChainTests;
        state.chains.push(chain);
        createdChainId = chain.id;
      }
      saveState();
      dispatch('library:chains-changed');
      // Mirror the New-snippet highlight: uncollapse the Chains section if
      // needed, scroll the new row into view, and flash it green. Skipped
      // for edits — the user already knows where that row is.
      if (createdChainId) {
        highlightSidebarRow({
          sectionKey: 'chains',
          listId: 'chains',
          itemId: createdChainId,
        });
      }
      if (settings.tests?.runOnSave && savedChainTests.length) {
        const target = existing || state.chains[state.chains.length - 1];
        if (target) {
          runChainTests(target)
            .then((summary) => {
              if (summary.fail > 0) {
                showToast({
                  title: `"${target.name}": ${summary.fail} of ${summary.total} test${summary.total === 1 ? '' : 's'} failing`,
                  level: 'error',
                  duration: 5000,
                });
                pulseSidebarRow('chains', target.id);
                dispatch('tests:reveal-chain', { chainId: target.id });
              }
            })
            .catch((err) => {
              // Runner-level rejection, not a test fail — surface so
              // the user can see that the run itself crashed.
              showToast({
                title: `Couldn't run tests for "${target.name}"`,
                body: String(err && err.message ? err.message : err),
                level: 'error',
                duration: 6000,
              });
            });
        }
      }
    },
    { once: true },
  );
}
