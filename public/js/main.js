// @ts-check
// Entry point. Imports feature modules and wires DOM listeners.
// Heavy lifting lives in:
//   core.js       — DOM / text-edit / toast / storage primitives
//   data.js       — seeds, reference, awk keyword sets, defaults
//   state.js      — app state + load/save/seeds + param helpers
//   settings.js   — settings + apply + dialog + server policy
//   awk.js        — runAwk client + tokenizer + syntax overlay
//   editor.js     — main editor: tabs, wrap, find/replace, jump, drop/save
//   pipeline.js   — pipeline state/render/run/apply + shell-copy
//   dialogs.js    — snippet/template/chain dialogs + reference + vars prompt
//   library.js    — sidebar lists (snippets/chains/text/templates)
//   palette.js    — Ctrl+K palette
//   sidebar.js    — section toggles + drag-to-resize
//   import-export.js — library JSON round-trip

import { $, IS_MAC, appAlert, preventEnterFormSubmit, welcomeSampleText } from './core.js';
import {
  loadState,
  restoreDefaultSnippets,
  restoreDefaultChains,
  restoreDefaultTemplates,
  restoreDefaultTextSnippets,
} from './state.js';
import {
  loadSettings,
  applySettings,
  openSettingsDialog,
  fetchServerPolicy,
  serverPolicy,
  settings,
} from './settings.js';
import { attachHighlighter } from './awk.js';
import {
  activeTab,
  applyEditorWrap,
  toggleActiveTabWrap,
  attachEditorMatchOverlay,
  refreshEditorOverlay,
  openFindPanel,
  closeFindPanel,
  setupFindPanel,
  jumpToLineInTextarea,
  saveActiveTabToFile,
  setupEditorTabs,
  setupLineNumbers,
  openTabSwitcher,
} from './editor.js';
import {
  renderPipeline,
  previewPipeline,
  applyPipeline,
  copyPipelineShell,
  savePipelineAsChain,
} from './pipeline.js';
import { openSnippetDialog, openChainDialog, openTemplateDialog } from './dialogs.js';
import {
  renderSnippets,
  renderChains,
  renderTextSnippets,
  renderTemplates,
  newTextSnippetFromEditor,
  setSidebarFilter,
  setupSidebarSearchScope,
  setupSectionSortModes,
  runSnippetOnSelection,
  runSnippetAtCursor,
  runChainOnSelection,
  runChainAtCursor,
  refreshSnippetTestStatusDots,
  refreshChainTestStatusDots,
  revealSnippetInSidebar,
  revealChainInSidebar,
  cloneChain,
} from './library.js';
import { matchesShortcut, effectiveSystemShortcuts } from './shortcuts.js';
import { runAllSnippetTests, runAllChainTests } from './tests.js';
import { showToast, pulseSidebarRow } from './core.js';
import {
  openPalette,
  closePalette,
  setupPaletteWiring,
  togglePaletteAdvanced,
  isPaletteOpen,
} from './palette.js';
import { openRunner, isRunnerOpen } from './runner.js';
import { setupResizer, setupSectionToggles, expandSection } from './sidebar.js';
import { exportState, importState } from './import-export.js';
import { initInputMode } from './inputMode.js';
import { state, saveState } from './state.js';
import { safeSetItem } from './core.js';
import { LS_KEYS } from './data.js';
import { dispatch, on } from './events.js';

/**
 * Wire a single cycling "toggle all tag groups" button. State starts as
 * 'expanded' (matches the defaults for tag-group open state). Each click
 * flips the stored state, applies the bulk action, and swaps the icon +
 * tooltip so the button always advertises the *next* action.
 *
 * @param {HTMLElement} btn
 * @param {string} sectionKey e.g. 'snippets' — passed to expandSection()
 * @param {(open: boolean) => void} apply
 */
function wireBulkGroupsButton(btn, sectionKey, apply) {
  let state = 'expanded';
  const reflect = () => {
    if (state === 'expanded') {
      btn.textContent = '⊟';
      btn.setAttribute('title', 'Collapse all tag groups (click to toggle)');
    } else {
      btn.textContent = '⊞';
      btn.setAttribute('title', 'Expand all tag groups (click to toggle)');
    }
  };
  reflect();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    expandSection(sectionKey);
    if (state === 'expanded') {
      apply(false);
      state = 'collapsed';
    } else {
      apply(true);
      state = 'expanded';
    }
    reflect();
  });
}

function init() {
  // Localise `<span class="kbd" data-mod>Ctrl</span>` placeholders on macOS.
  // One pass at startup covers the palette title, welcome dialog, and any
  // future surface that uses the same authoring convention.
  if (IS_MAC) {
    for (const el of document.querySelectorAll('.kbd[data-mod]')) el.textContent = '⌘';
  }
  loadSettings();
  applySettings();
  loadState();

  renderSnippets();
  renderChains();
  renderTextSnippets();
  renderTemplates();
  renderPipeline();
  initInputMode();

  // Sidebar visibility: shared path for both toggle buttons (one
  // inside the sidebar, one inside the editor area) and the
  // `toggleSidebar` system shortcut. Updates the body class, flips
  // aria-expanded on both buttons for screen readers, and persists
  // the choice. Accepts `hidden` so callers can state the target
  // state instead of toggling the current one (makes the on-load
  // restore path a straight write rather than a conditional flip).
  const sidebarCollapseBtn = $('#sidebar-collapse-btn');
  const sidebarShowBtn = $('#sidebar-show-btn');
  const setSidebarHidden = (hidden) => {
    document.body.classList.toggle('sidebar-hidden', hidden);
    sidebarCollapseBtn.setAttribute('aria-expanded', String(!hidden));
    sidebarShowBtn.setAttribute('aria-expanded', String(!hidden));
    safeSetItem(LS_KEYS.SIDEBAR_HIDDEN, hidden ? '1' : '0');
  };

  // Per-action handlers for the built-in system shortcuts. Each returns
  // true if it handled the event (so the caller should preventDefault
  // and stop), false if a context gate rejected it (caller lets the
  // browser's native behavior through — e.g. Ctrl+F outside the editor
  // falls back to the browser's own find). Registry + combos live in
  // shortcuts.js > SYSTEM_ACTIONS; the user can rebind or disable any
  // row via Settings → System shortcuts.
  const systemHandlers = {
    openPalette: () => {
      // Dual role: open the palette when it's closed, toggle advanced /
      // simple view when it's already open. The `togglePaletteAdvanced`
      // row in SYSTEM_ACTIONS is flagged `derivedFrom: 'openPalette'`
      // so it appears in the settings list as read-only — there's no
      // separate handler for it.
      if (isPaletteOpen()) togglePaletteAdvanced();
      else openPalette();
      return true;
    },
    openRunner: () => {
      // Always "handled" so we preventDefault the browser's Open-File
      // dialog even when the gate below rejects the action.
      if (!isRunnerOpen() && !isPaletteOpen()) {
        openRunner('apply');
      }
      return true;
    },
    openRunnerInsert: () => {
      if (!isRunnerOpen() && !isPaletteOpen()) {
        openRunner('insert');
      }
      return true;
    },
    find: () => {
      const inEditor =
        document.activeElement === $('#editor') ||
        document.activeElement?.closest?.('#find-panel') ||
        $('#find-panel').classList.contains('hidden') === false;
      if (!inEditor) return false;
      openFindPanel('find');
      return true;
    },
    findReplace: () => {
      const inEditor =
        document.activeElement === $('#editor') ||
        document.activeElement?.closest?.('#find-panel');
      if (!inEditor) return false;
      openFindPanel('replace');
      return true;
    },
    jumpToLine: () => {
      const ae = document.activeElement;
      if (!ae || ae.tagName !== 'TEXTAREA') return false;
      jumpToLineInTextarea(ae);
      return true;
    },
    openTabSwitcher: () => {
      openTabSwitcher();
      return true;
    },
    toggleSidebar: () => {
      setSidebarHidden(!document.body.classList.contains('sidebar-hidden'));
      return true;
    },
  };

  // Keyboard shortcuts. Snippet / chain shortcuts run BEFORE system
  // bindings so a user combo like Ctrl+Shift+K (bound to some snippet)
  // isn't silently swallowed by the palette's toggle-advanced action.
  // Snippet / chain handlers are skipped while a dialog is open so the
  // user can type programs and record new combos without accidentally
  // firing another snippet.
  //
  // Each snippet / chain can carry TWO combos:
  //   `shortcut`       → run*OnSelection (transforms selection)
  //   `shortcutInsert` → run*AtCursor (runs with no input, inserts)
  document.addEventListener('keydown', (e) => {
    if (!document.querySelector('dialog[open]')) {
      for (const sn of state.snippets) {
        if (sn.shortcut && matchesShortcut(e, sn.shortcut)) {
          e.preventDefault();
          runSnippetOnSelection(sn);
          return;
        }
        if (sn.shortcutInsert && matchesShortcut(e, sn.shortcutInsert)) {
          e.preventDefault();
          runSnippetAtCursor(sn);
          return;
        }
      }
      for (const ch of state.chains) {
        if (ch.shortcut && matchesShortcut(e, ch.shortcut)) {
          e.preventDefault();
          runChainOnSelection(ch);
          return;
        }
        if (ch.shortcutInsert && matchesShortcut(e, ch.shortcutInsert)) {
          e.preventDefault();
          runChainAtCursor(ch);
          return;
        }
      }
    }
    const bindings = effectiveSystemShortcuts(settings);
    for (const [actionId, combo] of bindings) {
      if (!matchesShortcut(e, combo)) continue;
      const handler = systemHandlers[actionId];
      if (!handler) continue;
      if (handler()) {
        e.preventDefault();
        return;
      }
      // Handler rejected the action (context gate failed). Stop looking
      // — no other system action can match the same combo (conflict
      // detection at bind time keeps the map unique) — and let the
      // browser / native textarea handle the event.
      break;
    }
    // Skip palette/find-panel ESC handling while a native `<dialog>` is
    // open on top — the dialog's own ESC-to-close must run first so the
    // closing order matches what the user sees (topmost layer closes
    // first). Without this guard, opening the Fixed Columns dialog (or
    // any dialog) from the palette would have ESC close the palette
    // underneath instead of the dialog on top.
    const modalOpen = !!document.querySelector('dialog[open]');
    if (e.key === 'Escape' && !modalOpen && !$('#palette').classList.contains('hidden')) {
      e.preventDefault();
      closePalette();
    } else if (
      e.key === 'Escape' &&
      !modalOpen &&
      !$('#find-panel').classList.contains('hidden') &&
      (document.activeElement === $('#editor') || document.activeElement?.closest?.('#find-panel'))
    ) {
      e.preventDefault();
      closeFindPanel();
    }
  });

  // Palette wiring
  setupPaletteWiring();

  // Bulk expand / collapse the tag groups inside the Chains sidebar section.
  // Single button that cycles its icon on each click: ⊟ "collapse all" →
  // ⊞ "expand all" → ⊟ ... . Icon reflects the action the next click takes.
  const bulkSetChainGroups = (open) => {
    for (const d of /** @type {NodeListOf<HTMLDetailsElement>} */ (
      document.querySelectorAll('#chains .sidebar-tag-group')
    )) {
      if (d.open !== open) d.open = open;
    }
  };
  wireBulkGroupsButton($('#chains-bulk-groups'), 'chains', bulkSetChainGroups);
  // Run all chain tests — same pattern as snippet tests.
  $('#chains-run-all-tests').addEventListener('click', async (e) => {
    e.stopPropagation();
    const summaries = await runAllChainTests();
    const totalChains = summaries.length;
    const totalTests = summaries.reduce((n, s) => n + s.total, 0);
    const failing = summaries.filter((s) => s.fail > 0);
    const totalFailing = failing.reduce((n, s) => n + s.fail, 0);
    if (!totalChains) {
      showToast({ title: 'No chain tests defined.', level: 'info', duration: 2500 });
      return;
    }
    if (totalFailing === 0) {
      showToast({
        title: `All ${totalTests} test${totalTests === 1 ? '' : 's'} passing across ${totalChains} chain${totalChains === 1 ? '' : 's'}.`,
        level: 'info',
        duration: 3000,
      });
    } else {
      showToast({
        title: `${totalFailing} test${totalFailing === 1 ? '' : 's'} failing in ${failing.length} chain${failing.length === 1 ? '' : 's'} (${totalTests} total).`,
        level: 'error',
        duration: 6000,
      });
      for (const s of failing) {
        revealChainInSidebar(s.snippetId);
        pulseSidebarRow('chains', s.snippetId);
      }
    }
  });

  // "New" buttons
  $('#new-snippet').addEventListener('click', () => openSnippetDialog(null));
  $('#new-chain').addEventListener('click', () => openChainDialog(null));
  $('#new-text-snippet').addEventListener('click', newTextSnippetFromEditor);
  $('#new-template').addEventListener('click', () => openTemplateDialog(null));
  // Bulk expand / collapse the tag groups inside the Templates sidebar section.
  const bulkSetTemplateGroups = (open) => {
    for (const d of /** @type {NodeListOf<HTMLDetailsElement>} */ (
      document.querySelectorAll('#templates .sidebar-tag-group')
    )) {
      if (d.open !== open) d.open = open;
    }
  };
  wireBulkGroupsButton($('#templates-bulk-groups'), 'templates', bulkSetTemplateGroups);
  $('#restore-templates').addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger section collapse toggle
    const added = restoreDefaultTemplates();
    dispatch('library:templates-changed');
    if (added) {
      appAlert(`Restored ${added} default template${added === 1 ? '' : 's'}.`, {
        level: 'info',
        duration: 2500,
      });
    } else {
      appAlert('All default templates are already present.', { level: 'info', duration: 2500 });
    }
  });
  $('#restore-text-snippets').addEventListener('click', (e) => {
    e.stopPropagation();
    const added = restoreDefaultTextSnippets();
    dispatch('library:text-snippets-changed');
    if (added) {
      appAlert(`Restored ${added} default text snippet${added === 1 ? '' : 's'}.`, {
        level: 'info',
        duration: 2500,
      });
    } else {
      appAlert('All default text snippets are already present.', {
        level: 'info',
        duration: 2500,
      });
    }
  });
  // Bulk expand / collapse the tag groups inside the Snippets sidebar
  // section. Setting `details.open` programmatically still fires `toggle`,
  // so the per-tag persistence in renderSnippets picks it up automatically.
  const bulkSetGroups = (open) => {
    for (const d of /** @type {NodeListOf<HTMLDetailsElement>} */ (
      document.querySelectorAll('#snippets .sidebar-tag-group')
    )) {
      if (d.open !== open) d.open = open;
    }
  };
  wireBulkGroupsButton($('#snippets-bulk-groups'), 'snippets', bulkSetGroups);
  // Run every snippet's tests. Toast a one-line summary; auto-expand and
  // pulse any failing snippets in the sidebar so they're easy to find.
  $('#snippets-run-all-tests').addEventListener('click', async (e) => {
    e.stopPropagation();
    const summaries = await runAllSnippetTests();
    const totalSnippets = summaries.length;
    const totalTests = summaries.reduce((n, s) => n + s.total, 0);
    const failingSnippets = summaries.filter((s) => s.fail > 0);
    const totalFailing = failingSnippets.reduce((n, s) => n + s.fail, 0);
    if (!totalSnippets) {
      showToast({ title: 'No snippet tests defined.', level: 'info', duration: 2500 });
      return;
    }
    if (totalFailing === 0) {
      showToast({
        title: `All ${totalTests} test${totalTests === 1 ? '' : 's'} passing across ${totalSnippets} snippet${totalSnippets === 1 ? '' : 's'}.`,
        level: 'info',
        duration: 3000,
      });
    } else {
      showToast({
        title: `${totalFailing} test${totalFailing === 1 ? '' : 's'} failing in ${failingSnippets.length} snippet${failingSnippets.length === 1 ? '' : 's'} (${totalTests} total).`,
        level: 'error',
        duration: 6000,
      });
      // Make the failing rows findable. Reveal expands just the parents
      // each failure needs (without persisting); pulse adds a brief red
      // flash. The first failure also gets scrolled into view.
      for (const s of failingSnippets) {
        revealSnippetInSidebar(s.snippetId);
        pulseSidebarRow('snippets', s.snippetId);
      }
    }
  });
  $('#restore-snippets').addEventListener('click', (e) => {
    e.stopPropagation();
    const added = restoreDefaultSnippets();
    dispatch('library:snippets-changed');
    if (added) {
      appAlert(`Restored ${added} default snippet${added === 1 ? '' : 's'}.`, {
        level: 'info',
        duration: 2500,
      });
    } else {
      appAlert('All default snippets are already present.', { level: 'info', duration: 2500 });
    }
  });
  $('#restore-chains').addEventListener('click', (e) => {
    e.stopPropagation();
    const added = restoreDefaultChains();
    dispatch('library:chains-changed');
    if (added) {
      appAlert(`Restored ${added} default chain${added === 1 ? '' : 's'}.`, {
        level: 'info',
        duration: 2500,
      });
    } else {
      // Distinguish "nothing missing" from "a chain is missing but couldn't
      // be restored because its snippet dependency isn't present" — the
      // latter is a real failure mode (user deleted Run Command (with
      // stdin), then tries to restore a chain that needs it).
      appAlert(
        'All default chains are already present — or the snippets they depend on are missing. Try "Restore default snippets" first.',
        { level: 'info', duration: 3500 },
      );
    }
  });

  // Pipeline buttons
  $('#run-pipeline').addEventListener('click', applyPipeline);
  $('#preview-pipeline').addEventListener('click', previewPipeline);
  $('#save-pipeline').addEventListener('click', savePipelineAsChain);
  $('#copy-pipeline').addEventListener('click', copyPipelineShell);

  const pipelineEl = $('#pipeline');
  const pipelineCollapseBtn = $('#pipeline-collapse');
  // First-time visitors (no stored preference) see the pipeline collapsed
  // to keep the initial view uncluttered. Saved '0' = user expanded,
  // '1' = user collapsed; anything else (null / missing) defaults collapsed.
  const initiallyCollapsed = localStorage.getItem(LS_KEYS.PIPELINE_COLLAPSED) !== '0';
  if (initiallyCollapsed) pipelineEl.classList.add('collapsed');
  pipelineCollapseBtn.setAttribute('aria-expanded', String(!initiallyCollapsed));
  pipelineCollapseBtn.setAttribute('aria-controls', 'pipeline-steps');
  pipelineCollapseBtn.addEventListener('click', () => {
    const collapsed = pipelineEl.classList.toggle('collapsed');
    pipelineCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
    safeSetItem(LS_KEYS.PIPELINE_COLLAPSED, collapsed ? '1' : '0');
  });
  $('#clear-pipeline').addEventListener('click', () => {
    state.pipeline = [];
    state.pipelineVars = {};
    state.pipelineStepVars = {};
    state.pipelinePerStepNames = [];
    state.activeStep = null;
    renderPipeline();
  });

  // Export / import
  $('#export').addEventListener('click', exportState);
  $('#import').addEventListener('click', () =>
    importState(() => {
      renderSnippets();
      renderChains();
      renderTextSnippets();
      renderTemplates();
    }),
  );

  // Header actions
  $('#settings-btn').addEventListener('click', openSettingsDialog);
  $('#save-tab-btn').addEventListener('click', saveActiveTabToFile);
  $('#wrap-btn').addEventListener('click', toggleActiveTabWrap);
  sidebarCollapseBtn.addEventListener('click', () => setSidebarHidden(true));
  sidebarShowBtn.addEventListener('click', () => setSidebarHidden(false));
  // Restore the sidebar's hidden state on load so reloads don't flash
  // the sidebar in for a frame before the preference applies.
  setSidebarHidden(localStorage.getItem(LS_KEYS.SIDEBAR_HIDDEN) === '1');

  // Cross-module bridges
  on('settings-saved', () => {
    applyEditorWrap();
    refreshSnippetTestStatusDots();
    refreshChainTestStatusDots();
  });
  // Test runs (single snippet or "Run all") update the cached summaries —
  // refresh the sidebar status dots in place without rebuilding the list.
  on('tests:run', () => {
    refreshSnippetTestStatusDots();
    refreshChainTestStatusDots();
  });
  // Run-all is an explicit user action, and the "Failing" filter decides
  // row visibility from the cached summaries — so a full re-render is the
  // right call here. It makes any newly-failing items appear (or passing
  // items disappear) without the user having to toggle the filter.
  on('tests:run-all', () => {
    renderSnippets();
    renderChains();
  });
  // Run-on-save failures dispatch this so we can expand any collapsed
  // ancestors (section header / tag group) and bring the row into view.
  on('tests:reveal-snippet', ({ snippetId }) => {
    if (snippetId) revealSnippetInSidebar(snippetId);
  });
  on('tests:reveal-chain', ({ chainId }) => {
    if (chainId) revealChainInSidebar(chainId);
  });
  // Settings → Edit snippet hyperlink. The settings dialog fires this after
  // closing itself so the snippet dialog can take over without a modal stack.
  on('settings:edit-snippet', ({ snippetId }) => {
    if (!snippetId) return;
    const sn = state.snippets.find((s) => s.id === snippetId);
    if (sn) openSnippetDialog(sn);
  });
  on('settings:edit-chain', ({ chainId }) => {
    if (!chainId) return;
    const ch = state.chains.find((c) => c.id === chainId);
    if (ch) openChainDialog(ch);
  });

  // "Clone chain for edit" — dispatched by the Detect FS toast when
  // the input looks like a JSON array. Closes whichever surface the
  // toast is hosted in (modal dialog or the palette), clones the
  // chain with a source-aware name ("<chain> (users.json)" for full
  // tabs; "<chain> (selection 1)" / "(selection 2)" / ... for
  // selections, numbering by highest-existing + 1), refreshes the
  // sidebar, and opens the new chain for edit so the user can tweak
  // and save immediately. No-ops gracefully if the chain has been
  // renamed or deleted from the library — surfaces an error toast so
  // the click isn't silently lost.
  on('library:clone-chain-for-edit', ({ name, source }) => {
    if (!name) return;
    const original = state.chains.find((c) => c.name === name);
    if (!original) {
      showToast({
        title: `Chain "${name}" not found`,
        body: 'It may have been renamed or deleted. Restore default chains from Settings if needed.',
        level: 'error',
        duration: 5000,
      });
      return;
    }
    // Close whatever surface launched the toast before opening the
    // new dialog, so we don't end up with stacked modals.
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog instanceof HTMLDialogElement) openDialog.close();
    if (isPaletteOpen()) closePalette();
    // Derive the suffix from the source captured at detect time.
    // Selection: find the highest existing `(selection N)` for this
    // chain base name and use N+1. Tab: use the title verbatim.
    // uniqueName handles any residual collision with a " 2" suffix.
    let desiredName;
    if (source && source.kind === 'selection') {
      const escapedBase = original.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${escapedBase} \\(selection (\\d+)\\)$`);
      let maxN = 0;
      for (const ch of state.chains) {
        const m = ch.name.match(re);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      }
      desiredName = `${original.name} (selection ${maxN + 1})`;
    } else if (source && source.kind === 'tab' && source.title) {
      desiredName = `${original.name} (${source.title})`;
    }
    const copy = cloneChain(original, desiredName);
    renderChains();
    openChainDialog(copy);
  });

  // runAwk fires this when it blocks a run against the forbidden-pattern
  // list. We surface a toast with a quick-link button so the user can jump
  // straight to Settings → Safety to edit the list (or just confirm why
  // the run was blocked). Throttle at 3s so a burst (e.g. chain with
  // several blocking steps, or a run of tests) produces a single toast.
  //
  // showToast is deferred via queueMicrotask so that when a forbidden run
  // fires during dialog opening (preview was already open and the newly
  // loaded snippet contains a pattern), the toast is rendered AFTER the
  // dialog's showModal() completes — otherwise it mounts to document.body
  // and the dialog's backdrop would render it dim. By the time the
  // microtask runs, `dialog[open]` is true and showToast reparents the
  // toast into the dialog.
  let lastSafetyToast = 0;
  on('safety:blocked', ({ pattern, where }) => {
    const now = Date.now();
    if (now - lastSafetyToast < 3000) return;
    lastSafetyToast = now;
    queueMicrotask(() => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = 'Open safety settings';
      btn.addEventListener('click', async () => {
        await openSettingsDialog({ scrollTo: 'set-safety-forbidden-row' });
      });
      showToast({
        title: 'Blocked by safety filter',
        body: pattern ? `Pattern "${pattern}" found in ${where}.` : undefined,
        level: 'error',
        duration: 8000,
        dom: btn,
      });
    });
  });

  // Generic `.filter-clear` affordance inside any `.filter-field` wrapper.
  // One delegated click listener covers every filter input in the app
  // (sidebar search, chain-dialog snippet filter, template filters in
  // snippet/inline-step dialogs). Clears the sibling input and dispatches
  // an `input` event so existing filter listeners re-render.
  document.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (
      /** @type {Element} */ (e.target).closest('.filter-clear')
    );
    if (!btn) return;
    const wrap = btn.closest('.filter-field');
    if (!wrap) return;
    const input = /** @type {HTMLInputElement | null} */ (wrap.querySelector('input'));
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  // Sidebar chrome + find panel
  setupResizer();
  setupSectionToggles();
  setupFindPanel();

  // Multi-field editor dialogs: Enter in a text input shouldn't submit
  // the `<form method="dialog">` and close the whole thing. The palette
  // (a div, not a dialog) keeps its own Enter-applies behavior via
  // `settings.editor.paletteEnterApplies`. Simple prompt/confirm dialogs
  // are left alone — Enter-to-accept is their natural UX.
  for (const id of [
    'snippet-dialog',
    'template-dialog',
    'chain-dialog',
    'inline-step-dialog',
    'settings-dialog',
    'run-vars-dialog',
  ]) {
    preventEnterFormSubmit(document.getElementById(id));
  }

  // Syntax highlighter overlays on awk textareas
  for (const id of [
    'snippet-program',
    'inline-step-program',
    'template-body',
    'palette-input',
    'chain-inline-input',
  ]) {
    const ta = /** @type {HTMLTextAreaElement | null} */ (document.getElementById(id));
    if (ta) attachHighlighter(ta);
  }

  // Sidebar search
  $('#sidebar-search').addEventListener('input', (/** @type {Event} */ e) =>
    setSidebarFilter(/** @type {HTMLInputElement} */ (e.target).value),
  );
  setupSidebarSearchScope();
  setupSectionSortModes();

  // Main editor: tabs + overlay + wrap + first-run sample text
  setupEditorTabs();
  attachEditorMatchOverlay($('#editor'));
  applyEditorWrap();
  setupLineNumbers();
  const cur = activeTab();
  if (cur && !cur.content) {
    cur.content = welcomeSampleText();
    $('#editor').value = cur.content;
    refreshEditorOverlay();
    saveState();
  }

  setupWelcomeDialog();

  // Dismiss the unsafe-mode warning for the current session. We don't
  // persist the dismissal — the underlying risk survives across reloads,
  // so the banner should come back on a fresh page load.
  const unsafeBannerClose = document.getElementById('unsafe-mode-banner-close');
  if (unsafeBannerClose) {
    unsafeBannerClose.addEventListener('click', () => {
      const banner = document.getElementById('unsafe-mode-banner');
      if (banner) banner.hidden = true;
    });
  }
  // Inline "Settings → Safety" link in the banner — opens the settings
  // dialog and scrolls straight to the forbidden-patterns field so the
  // user can add blocks while the warning is fresh in mind.
  const unsafeBannerLink = document.getElementById('unsafe-mode-banner-link');
  if (unsafeBannerLink) {
    unsafeBannerLink.addEventListener('click', async () => {
      await openSettingsDialog({ scrollTo: 'set-safety-forbidden-row' });
    });
  }

  // Surface unsafe-mode once the server replies. Fire-and-forget — init
  // stays synchronous, and the banner is hidden by default so there's no
  // flash while the fetch is in flight. If the fetch fails, settings.js
  // falls back to `sandboxEnforced: true` and the banner stays hidden.
  fetchServerPolicy().then(() => {
    const banner = document.getElementById('unsafe-mode-banner');
    if (banner) banner.hidden = !!serverPolicy?.sandboxEnforced;
  });
}

function setupWelcomeDialog() {
  const dlg = /** @type {HTMLDialogElement} */ ($('#welcome-dialog'));
  if (!dlg) return;
  $('#help-btn').addEventListener('click', () => dlg.showModal());
  if (localStorage.getItem(LS_KEYS.WELCOME_SEEN) !== '1') {
    // Delay one tick so the rest of the app lays out first — the dialog
    // otherwise sometimes shows over an unstyled background on a cold load.
    requestAnimationFrame(() => dlg.showModal());
  }
  dlg.addEventListener('close', () => {
    safeSetItem(LS_KEYS.WELCOME_SEEN, '1');
  });
}

init();
