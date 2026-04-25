// @ts-check
// Main editor surface: tabs, word-wrap, find/replace, match overlay,
// jump-to-line, file drop/save, selection helpers.

import {
  $,
  uid,
  editText,
  editTextRange,
  attachTabIndent,
  escapeHtml,
  showToast,
  closestOn,
  appConfirm,
  appPrompt,
  appContextMenu,
  highlightSidebarRow,
  welcomeSampleText,
} from './core.js';
import { state, saveState } from './state.js';
import { settings } from './settings.js';
import { openWorkspacesDialog } from './workspaces.js';
import { dispatch, on } from './events.js';
import { renderInputModeToggle } from './inputMode.js';

// Re-bind the editor textarea + overlay + tab strip after a workspace
// load. workspaces.js fires this event (event-based boundary to avoid
// a module cycle — see workspaces.js for rationale).
on('workspace:loaded', () => {
  const next = activeTab();
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  ed.value = next ? next.content : '';
  ed.selectionStart = ed.selectionEnd = 0;
  applyEditorWrap();
  refreshEditorOverlay();
  rebuildMruFromState();
  renderTabs();
});

// ---------- selection / replace primitives ----------
export function getSel() {
  const ed = $('#editor');
  const s = ed.selectionStart;
  const e = ed.selectionEnd;
  const hasSel = s !== e;
  const target = hasSel ? ed.value.slice(s, e) : ed.value;
  return { s, e, hasSel, target };
}

export function replaceSelection(output) {
  const ed = $('#editor');
  const { s, e, hasSel } = getSel();
  if (hasSel) {
    editTextRange(ed, s, e, output);
  } else {
    editTextRange(ed, 0, ed.value.length, output);
  }
}

/**
 * Trim a single trailing newline from awk stdout when the setting
 * `editor.stripTrailingNewline` is on. `print` in awk always emits
 * `\n`, so a selection transformed by a snippet comes back one
 * newline longer than it went in — this drops it when the user has
 * opted in.
 *
 * Off by default: preserving awk's native output is the less
 * surprising baseline; users who mainly transform single-line
 * fragments can flip it on in Settings → Editor.
 *
 * Only one trailing `\n` is removed; multi-record output that ends
 * in `\n` on the last record has exactly one trailing newline to
 * strip, and programs that use `printf` without `\n` produce no
 * trailing newline for the strip to touch. Test assertions and
 * pipeline intermediate streams see raw stdout — the strip happens
 * only at the final write to the editor.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function normalizeAwkOutput(stdout) {
  if (settings.editor?.stripTrailingNewline !== true) return stdout;
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

/**
 * Route awk stdout to the sink resolved by `inputMode.resolveInput()`.
 * Central so every trigger surface writes output the same way:
 *   - `selection`         → replace the originally-selected range
 *     (s/e snapshot, immune to focus shifts during awaits)
 *   - `activeTabContent`  → replace the whole active tab's content
 *   - `newOutputTab`      → create a fresh read-only, excluded tab
 *     titled per `opts.title` (callers pass a descriptive name like
 *     "Results: mySnippet × 3 tabs"). Falls back to "Results" if
 *     omitted.
 *
 * `normalizeAwkOutput` is applied uniformly so the strip-trailing-
 * newline setting affects every sink and every trigger surface.
 *
 * @param {import('./inputMode.js').ResolvedInput['sink']} sink
 * @param {string} stdout
 * @param {{ title?: string }} [opts]
 */
export function writeOutput(sink, stdout, opts) {
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  const text = normalizeAwkOutput(stdout);
  if (sink.type === 'selection') {
    editTextRange(ed, sink.s, sink.e, text);
    return;
  }
  if (sink.type === 'activeTabContent') {
    editTextRange(ed, 0, ed.value.length, text);
    return;
  }
  if (sink.type === 'newOutputTab') {
    createOutputTab((opts && opts.title) || 'Results', text);
  }
}

export function insertAtEditorCursor(text) {
  editText($('#editor'), text);
}

// Tab-as-indent + WCAG-compliant Esc-Tab escape lives in core.attachTabIndent.

// ---------- editor tabs ----------
/**
 * Debounce handle for persisting the active tab's content to localStorage.
 * The editor's `input` listener re-schedules on every keystroke; the last
 * scheduled callback writes through `saveState`.
 * @type {ReturnType<typeof setTimeout> | null}
 */
let saveTabsTimer = null;

export function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

/**
 * True when the strip holds exactly one tab that looks pristine —
 * default-generated name (`newTab()` emits `Tab N`), default-or-empty
 * content, unpinned. The "is this a throwaway scratch tab we can
 * quietly replace?" predicate used by snippet-open and file-drop
 * paths so the user isn't left with a stale `Tab 1` next to the
 * content they actually came to see.
 *
 * Deliberately doesn't consult the textarea's undo/redo stack: the
 * browser doesn't expose it, and the user has signalled via a clean
 * current state that they don't care about the tab regardless.
 */
export function isScratchInitialTab() {
  if (state.tabs.length !== 1) return false;
  const t = state.tabs[0];
  if (t.pinned) return false;
  if (!/^Tab \d+$/.test(t.title)) return false;
  const defaultText = settings.editor.defaultNewTabText || '';
  return t.content === '' || t.content === defaultText || t.content === welcomeSampleText();
}

/**
 * Is `tab` divergent from its backing text snippet? False if the tab has
 * no `sourceSnippetId`, the snippet has been deleted (orphan id), or the
 * content still matches. A pure predicate — callers decide when to
 * re-evaluate (on tab render for batch; on editor input for live update
 * of the active tab; on `library:text-snippets-changed` for cases where
 * a snippet mutation flips the comparison).
 *
 * @param {import('./types.js').Tab} tab
 * @returns {boolean}
 */
export function isTabDirty(tab) {
  if (!tab.sourceSnippetId) return false;
  const snip = state.textSnippets.find((s) => s.id === tab.sourceSnippetId);
  if (!snip) return false;
  return tab.content !== snip.content;
}

/**
 * Toggle the `.dirty` class on just the active tab's DOM node without
 * rebuilding the strip. Called from the editor `input` handler so every
 * keystroke reflects dirty state immediately; a full `renderTabs()` on
 * every keystroke would be wasteful for a visual change that only
 * affects one element.
 */
function updateActiveTabDirty() {
  const t = activeTab();
  if (!t) return;
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(t.id) : t.id;
  const el = document.querySelector(`#tabs .tab[data-id="${safeId}"]`);
  if (el) el.classList.toggle('dirty', isTabDirty(t));
}

// ---------- MRU (session-only) ----------
/**
 * Session-only most-recently-used tab order (head = current, tail = least
 * recent). Seeded from `state.tabs` at load with the active tab in front
 * — prior-session order is not persisted by design, so the user gets a
 * deterministic starting point each reload.
 *
 * Kept as a plain string[] of tab ids (not an object-keyed LRU map)
 * because the list is small (typically <20 tabs) and linear scans beat
 * map overhead at this scale; callers also want stable iteration order.
 *
 * @type {string[]}
 */
let mruOrder = [];

function rebuildMruFromState() {
  mruOrder = [];
  const activeId = state.activeTabId;
  if (activeId && state.tabs.some((t) => t.id === activeId)) {
    mruOrder.push(activeId);
  }
  for (const t of state.tabs) {
    if (t.id !== activeId) mruOrder.push(t.id);
  }
}

function mruPromote(id) {
  const i = mruOrder.indexOf(id);
  if (i === 0) return;
  if (i > 0) mruOrder.splice(i, 1);
  mruOrder.unshift(id);
}

function mruRemove(id) {
  const i = mruOrder.indexOf(id);
  if (i >= 0) mruOrder.splice(i, 1);
}

// ---------- quick-switcher ----------
/**
 * Rank a tab against the filter query. Returns a score ≥ 0 (higher = better
 * match), or null to exclude. Ranking is deliberately coarse — title
 * matches beat content matches beat nothing — because the ordering within a
 * tier should respect MRU recency, which the caller handles as a tiebreaker.
 *
 * @param {import('./types.js').Tab} tab
 * @param {string} query normalized to lowercase
 * @returns {{ score: number, titleMatch: [number, number] | null, contentSnippet: string | null } | null}
 */
function scoreTabForSwitcher(tab, query) {
  if (!query) {
    return { score: 1, titleMatch: null, contentSnippet: null };
  }
  const title = (tab.title || '').toLowerCase();
  const titleIdx = title.indexOf(query);
  if (titleIdx >= 0) {
    // Leading match beats mid-string match so "Tab 1" outranks "Scratch tab".
    const base = titleIdx === 0 ? 1000 : 800;
    return {
      score: base + (tab.title.length - query.length),
      titleMatch: [titleIdx, titleIdx + query.length],
      contentSnippet: null,
    };
  }
  const content = (tab.content || '').toLowerCase();
  const contentIdx = content.indexOf(query);
  if (contentIdx >= 0) {
    const rawStart = Math.max(0, contentIdx - 16);
    const rawEnd = Math.min(tab.content.length, contentIdx + query.length + 40);
    const prefix = rawStart > 0 ? '…' : '';
    const suffix = rawEnd < tab.content.length ? '…' : '';
    const raw = tab.content.slice(rawStart, rawEnd).replace(/\s+/g, ' ');
    return { score: 400, titleMatch: null, contentSnippet: prefix + raw + suffix };
  }
  return null;
}

let switcherHighlightIdx = 0;
/** @type {Array<{tab: import('./types.js').Tab, titleMatch: [number,number] | null, contentSnippet: string | null}>} */
let switcherResults = [];

function renderSwitcherList() {
  const list = $('#tab-switcher-list');
  list.replaceChildren();
  if (!switcherResults.length) {
    const empty = document.createElement('li');
    empty.className = 'tab-switcher-empty';
    empty.textContent = 'No matching tabs';
    list.appendChild(empty);
    return;
  }
  switcherResults.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'tab-switcher-item';
    li.setAttribute('role', 'option');
    li.dataset.id = r.tab.id;
    if (i === switcherHighlightIdx) li.classList.add('highlighted');

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-switcher-item-title';
    if (r.titleMatch) {
      const [s, e] = r.titleMatch;
      titleEl.append(
        document.createTextNode(r.tab.title.slice(0, s)),
        Object.assign(document.createElement('span'), {
          className: 'tab-switcher-item-match',
          textContent: r.tab.title.slice(s, e),
        }),
        document.createTextNode(r.tab.title.slice(e)),
      );
    } else {
      titleEl.textContent = r.tab.title;
    }
    li.appendChild(titleEl);

    if (r.tab.pinned) {
      const pinEl = document.createElement('span');
      pinEl.className = 'tab-switcher-item-pin';
      pinEl.textContent = 'pinned';
      li.appendChild(pinEl);
    }

    if (r.contentSnippet) {
      const snippetEl = document.createElement('span');
      snippetEl.className = 'tab-switcher-item-snippet';
      snippetEl.textContent = r.contentSnippet;
      li.appendChild(snippetEl);
    }
    list.appendChild(li);
  });
  // Keep highlighted row in view for long lists.
  const highlighted = list.querySelector('.tab-switcher-item.highlighted');
  /** @type {HTMLElement | null} */ (highlighted)?.scrollIntoView({ block: 'nearest' });
}

function computeSwitcherResults(queryRaw) {
  const query = queryRaw.trim().toLowerCase();
  // MRU position is the tiebreaker: a tab that was recently active should
  // float above an equally-ranked tab that wasn't.
  const mruRank = new Map(mruOrder.map((id, i) => [id, i]));
  const fallbackRank = state.tabs.length;
  const scored = [];
  for (const tab of state.tabs) {
    const res = scoreTabForSwitcher(tab, query);
    if (!res) continue;
    scored.push({
      tab,
      titleMatch: res.titleMatch,
      contentSnippet: res.contentSnippet,
      score: res.score,
      rank: mruRank.has(tab.id) ? /** @type {number} */ (mruRank.get(tab.id)) : fallbackRank,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  switcherResults = scored.map(({ tab, titleMatch, contentSnippet }) => ({
    tab,
    titleMatch,
    contentSnippet,
  }));
  switcherHighlightIdx = 0;
}

let switcherWired = false;
function wireSwitcher() {
  if (switcherWired) return;
  switcherWired = true;
  const dlg = /** @type {HTMLDialogElement} */ ($('#tab-switcher'));
  const input = /** @type {HTMLInputElement} */ ($('#tab-switcher-input'));
  const list = $('#tab-switcher-list');

  input.addEventListener('input', () => {
    computeSwitcherResults(input.value);
    renderSwitcherList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!switcherResults.length) return;
      switcherHighlightIdx = (switcherHighlightIdx + 1) % switcherResults.length;
      renderSwitcherList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!switcherResults.length) return;
      switcherHighlightIdx =
        (switcherHighlightIdx - 1 + switcherResults.length) % switcherResults.length;
      renderSwitcherList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = switcherResults[switcherHighlightIdx];
      if (pick) {
        switchToTab(pick.tab.id);
        dlg.close('ok');
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dlg.close('cancel');
    }
  });
  list.addEventListener('click', (e) => {
    const li = closestOn(e, '.tab-switcher-item');
    if (!li) return;
    const id = li.dataset.id;
    if (id) {
      switchToTab(id);
      dlg.close('ok');
    }
  });
  // Reset state on close so a subsequent open doesn't inherit stale filter.
  dlg.addEventListener('close', () => {
    input.value = '';
    switcherResults = [];
    switcherHighlightIdx = 0;
  });
}

export function openTabSwitcher() {
  wireSwitcher();
  const dlg = /** @type {HTMLDialogElement} */ ($('#tab-switcher'));
  const input = /** @type {HTMLInputElement} */ ($('#tab-switcher-input'));
  computeSwitcherResults('');
  renderSwitcherList();
  dlg.showModal();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 10);
}

/** One-shot guard: delegated click/dblclick listeners on `#tabs` are wired exactly once. */
let tabsDelegationWired = false;

function wireTabsDelegation() {
  if (tabsDelegationWired) return;
  tabsDelegationWired = true;
  const container = $('#tabs');
  container.setAttribute('role', 'tablist');
  container.addEventListener('click', (e) => {
    if (closestOn(e, '#new-tab-btn')) {
      // Ctrl/Cmd+click bypasses `settings.editor.defaultNewTabText` for a
      // truly blank tab — useful when the user has a non-empty default
      // (e.g. a scaffold) but occasionally wants a scratchpad.
      newTab({ blank: e.ctrlKey || e.metaKey });
      return;
    }
    if (closestOn(e, '#workspaces-btn')) {
      openWorkspacesDialog();
      return;
    }
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    const id = tabEl.dataset.id;
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (closestOn(e, '.tab-close')) {
      e.stopPropagation();
      closeTab(tab);
      return;
    }
    if (closestOn(e, '.tab-pin')) {
      e.stopPropagation();
      togglePin(tab);
      return;
    }
    switchToTab(id);
  });
  container.addEventListener('dblclick', (e) => {
    if (closestOn(e, '.tab-close')) return;
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    const tab = state.tabs.find((t) => t.id === tabEl.dataset.id);
    if (tab) renameTab(tab);
  });
  // ---- drag-and-drop (reorder + Shift-drop to merge) ----
  // Drag source is tracked in-module, not via DataTransfer.getData, because
  // `getData` is unavailable during `dragover` (by spec) and we need the id
  // live to update the drop indicator. DataTransfer.setData is still set
  // so external drop targets see a sensible payload.
  //
  // Modifier detection for merge-on-drop is intentionally redundant. Each
  // individual path has a known failure mode in at least one engine:
  //   - `DragEvent.shiftKey` on Chromium is frozen to the dragstart value
  //     (spec-ambiguous), so it won't pick up shift pressed mid-drag.
  //   - Our document-level `shiftHeld` flag relies on keydown bubbling to
  //     `document`; if the tab had focus and another handler (or the OS
  //     drag machinery) swallowed the Shift keydown before it reached us,
  //     the flag never flips.
  //   - Capturing at dragstart fails if the user releases Shift between
  //     pressing and releasing the mouse.
  // `isMergeGesture(e)` ORs all three — whichever one sees Shift wins.
  // Capture-phase key listeners bypass any bubble-phase stopPropagation.
  /** @type {string | null} */
  let draggingTabId = null;
  let dragStartedWithShift = false;
  let shiftHeld = false;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Shift') shiftHeld = true;
    },
    true,
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Shift') shiftHeld = false;
    },
    true,
  );
  window.addEventListener('blur', () => {
    shiftHeld = false;
  });
  const isMergeGesture = (e) => !!(e.shiftKey || shiftHeld || dragStartedWithShift);

  function clearDropMarkers() {
    for (const el of container.querySelectorAll('.tab')) {
      el.classList.remove('drop-before', 'drop-after', 'drop-merge');
    }
  }

  container.addEventListener('dragstart', (e) => {
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    draggingTabId = tabEl.dataset.id || null;
    dragStartedWithShift = !!e.shiftKey || shiftHeld;
    tabEl.classList.add('dragging');
    if (e.dataTransfer) {
      // `copyMove` lets the OS/browser pick the effect based on modifier
      // state without rejecting the drop. (Using `move` alone can collide
      // with Shift's OS-level "force move" semantics on some platforms and
      // silently suppresses the drop.)
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', tabEl.querySelector('.tab-title')?.textContent || '');
    }
  });

  container.addEventListener('dragover', (e) => {
    if (!draggingTabId) return;
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    const id = tabEl.dataset.id;
    if (!id || id === draggingTabId) return;
    e.preventDefault();
    const merge = isMergeGesture(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = merge ? 'copy' : 'move';
    clearDropMarkers();
    if (merge) {
      tabEl.classList.add('drop-merge');
    } else {
      const rect = tabEl.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      tabEl.classList.add(after ? 'drop-after' : 'drop-before');
    }
  });

  container.addEventListener('dragleave', (e) => {
    // Only clear when the cursor leaves a .tab entirely — dragleave also
    // fires when moving between child elements of the same tab.
    const tabEl = closestOn(e, '.tab');
    if (tabEl && !tabEl.contains(/** @type {Node} */ (e.relatedTarget))) {
      tabEl.classList.remove('drop-before', 'drop-after', 'drop-merge');
    }
  });

  container.addEventListener('drop', (e) => {
    if (!draggingTabId) return;
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    const targetId = tabEl.dataset.id;
    if (!targetId || targetId === draggingTabId) return;
    e.preventDefault();
    const source = state.tabs.find((t) => t.id === draggingTabId);
    const target = state.tabs.find((t) => t.id === targetId);
    if (!source || !target) return;
    if (isMergeGesture(e)) {
      mergeTabs(source, target);
    } else {
      const rect = tabEl.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      reorderTab(source, target, after);
    }
    clearDropMarkers();
  });

  container.addEventListener('dragend', () => {
    for (const el of container.querySelectorAll('.tab.dragging')) {
      el.classList.remove('dragging');
    }
    clearDropMarkers();
    draggingTabId = null;
    dragStartedWithShift = false;
  });

  // Middle-click closes. Suppress the default `mousedown` autoscroll cursor
  // on the tab strip — `auxclick` alone is too late: autoscroll has already
  // started by the time it fires.
  container.addEventListener('mousedown', (e) => {
    if (e.button === 1 && closestOn(e, '.tab')) e.preventDefault();
  });
  container.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    e.preventDefault();
    const tab = state.tabs.find((t) => t.id === tabEl.dataset.id);
    if (tab) closeTab(tab);
  });
  container.addEventListener('contextmenu', async (e) => {
    const tabEl = closestOn(e, '.tab');
    if (!tabEl) return;
    e.preventDefault();
    const tab = state.tabs.find((t) => t.id === tabEl.dataset.id);
    if (!tab) return;
    const idx = state.tabs.indexOf(tab);
    // Disable flags on bulk-close items consider pin protection: if nothing
    // in the range is unpinned, the item is a no-op and disabling it tells
    // the user why.
    const hasUnpinnedOthers = state.tabs.some((t) => t.id !== tab.id && !t.pinned);
    const hasUnpinnedLeft = state.tabs.slice(0, idx).some((t) => !t.pinned);
    const hasUnpinnedRight = state.tabs.slice(idx + 1).some((t) => !t.pinned);
    const hasAnyUnpinned = state.tabs.some((t) => !t.pinned);
    const choice = await appContextMenu(
      { clientX: e.clientX, clientY: e.clientY },
      [
        { label: tab.pinned ? 'Unpin' : 'Pin', value: 'pin' },
        {
          label: tab.excluded ? 'Include in All Tabs input' : 'Exclude from All Tabs input',
          value: 'toggle-excluded',
        },
        { separator: true },
        { label: 'Close', value: 'close' },
        { label: 'Close others', value: 'close-others', disabled: !hasUnpinnedOthers },
        { label: 'Close tabs to the left', value: 'close-left', disabled: !hasUnpinnedLeft },
        {
          label: 'Close tabs to the right',
          value: 'close-right',
          disabled: !hasUnpinnedRight,
        },
        { label: 'Close all', value: 'close-all', danger: true, disabled: !hasAnyUnpinned },
        { separator: true },
        { label: 'Duplicate', value: 'duplicate' },
        { label: 'Rename…', value: 'rename' },
        { label: 'Download', value: 'download' },
        { label: 'Save as new text snippet…', value: 'save-as-snippet' },
      ],
    );
    switch (choice) {
      case 'pin':
        togglePin(tab);
        break;
      case 'toggle-excluded':
        toggleTabExcluded(tab);
        break;
      case 'close':
        closeTab(tab);
        break;
      case 'close-others':
        closeOtherTabs(tab);
        break;
      case 'close-left':
        closeTabsLeft(tab);
        break;
      case 'close-right':
        closeTabsRight(tab);
        break;
      case 'close-all':
        closeAllTabs();
        break;
      case 'duplicate':
        duplicateTab(tab);
        break;
      case 'rename':
        renameTab(tab);
        break;
      case 'download':
        saveTabToFile(tab);
        break;
      case 'save-as-snippet':
        saveTabAsSnippet(tab);
        break;
    }
  });
  // Keyboard nav over the tab strip. ARIA Authoring Practices for tablist:
  // ArrowLeft/Right move focus+activate; Home/End jump to first/last; Enter
  // and Space on a focused tab activate it (redundant since focus activates,
  // but matches expectations). Delete closes the focused tab.
  container.addEventListener('keydown', (e) => {
    const tabEl = /** @type {HTMLElement | null} */ (
      document.activeElement && document.activeElement.classList.contains('tab')
        ? document.activeElement
        : null
    );
    if (!tabEl) return;
    const tabs = Array.from(container.querySelectorAll('.tab'));
    const idx = tabs.indexOf(tabEl);
    if (idx < 0) return;
    let next = null;
    if (e.key === 'ArrowLeft') next = tabs[Math.max(0, idx - 1)];
    else if (e.key === 'ArrowRight') next = tabs[Math.min(tabs.length - 1, idx + 1)];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    else if (e.key === 'Delete') {
      e.preventDefault();
      const tab = state.tabs.find((t) => t.id === tabEl.dataset.id);
      if (tab) closeTab(tab);
      return;
    } else return;
    e.preventDefault();
    const nextId = /** @type {HTMLElement} */ (next).dataset.id;
    if (nextId) {
      switchToTab(nextId);
      // renderTabs rebuilds; refocus the tab at the new index.
      requestAnimationFrame(() => {
        const fresh = container.querySelector(`.tab[data-id="${CSS.escape(nextId)}"]`);
        /** @type {HTMLElement | null} */ (fresh)?.focus();
      });
    }
  });
}

export function renderTabs() {
  wireTabsDelegation();
  const container = $('#tabs');
  let addBtn = container.querySelector('#new-tab-btn');
  if (!addBtn) {
    addBtn = document.createElement('button');
    addBtn.id = 'new-tab-btn';
    addBtn.textContent = '+';
    addBtn.title = 'New tab (Ctrl/\u2318-click for blank tab, bypassing the default new-tab text)';
    container.appendChild(addBtn);
  }
  let wsBtn = container.querySelector('#workspaces-btn');
  if (!wsBtn) {
    wsBtn = document.createElement('button');
    wsBtn.id = 'workspaces-btn';
    wsBtn.textContent = '\u25f1';
    wsBtn.title = 'Workspaces: save and load named tab sets';
    container.appendChild(wsBtn);
  }
  const existing = new Map();
  for (const el of container.querySelectorAll('.tab')) existing.set(el.dataset.id, el);
  for (const tab of state.tabs) {
    let el = existing.get(tab.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab';
      el.dataset.id = tab.id;
      el.setAttribute('role', 'tab');
      el.setAttribute('draggable', 'true');
      // Pin button lives left of the title and is CSS-hidden on unpinned
      // tabs. Rendering it always keeps the DOM stable so we don't pay a
      // full innerHTML rebuild on every pin toggle.
      //
      // Children are `draggable="false"` so mousedown on the title text
      // (or on either button) resolves the drag source upward to the
      // `.tab[draggable=true]` ancestor instead of initiating a native
      // text-drag on the span — the latter suppresses our dragstart and
      // leaves the user puzzled as to why dragging "on the text" doesn't
      // work the same as dragging "around" it.
      el.innerHTML = `<button class="tab-pin" draggable="false" title="Unpin" aria-label="Unpin tab"></button><span class="tab-dirty-dot" aria-hidden="true" title="Unsaved changes vs. source snippet"></span><span class="tab-title" draggable="false"></span><button class="tab-close" draggable="false" title="Close" aria-label="Close tab">×</button>`;
    }
    el.querySelector('.tab-title').textContent = tab.title;
    // Native tooltip for truncated titles; the close/pin buttons have their
    // own titles so hovering them doesn't trigger this one.
    el.title = tab.title;
    const isActive = tab.id === state.activeTabId;
    el.classList.toggle('active', isActive);
    el.classList.toggle('pinned', !!tab.pinned);
    el.classList.toggle('excluded', !!tab.excluded);
    el.classList.toggle('dirty', isTabDirty(tab));
    el.setAttribute('aria-selected', String(isActive));
    // Roving tabindex: only the active tab is in the Tab sequence; arrow keys
    // move focus within the strip.
    el.tabIndex = isActive ? 0 : -1;
    if (el.nextSibling !== addBtn) container.insertBefore(el, addBtn);
    existing.delete(tab.id);
  }
  for (const el of existing.values()) el.remove();
  const active = activeTab();
  const activeTitle = active && active.title ? active.title.trim() : '';
  document.title = activeTitle ? `${activeTitle} — Awk-estra` : 'Awk-estra';
}

export function switchToTab(id) {
  if (id === state.activeTabId) return;
  const cur = activeTab();
  if (cur) cur.content = $('#editor').value;
  state.activeTabId = id;
  mruPromote(id);
  const next = activeTab();
  $('#editor').value = next ? next.content : '';
  $('#editor').selectionStart = $('#editor').selectionEnd = 0;
  applyEditorWrap();
  updateLineNumbers();
  saveState();
  renderTabs();
  renderInputModeToggle();
}

/**
 * Create a new tab that holds awk output. Marked `excluded` so a
 * follow-up All-Tabs run doesn't feed the results back into its own
 * input. Stays fully editable — users routinely want to tweak output
 * or pipe it through another snippet. Switches focus to the new tab
 * and returns it.
 *
 * @param {string} title
 * @param {string} content
 */
export function createOutputTab(title, content) {
  const cur = activeTab();
  if (cur) cur.content = $('#editor').value;
  /** @type {import('./types.js').Tab} */
  const t = {
    id: uid(),
    title: title || 'Results',
    content: content || '',
    excluded: true,
  };
  state.tabs.push(t);
  state.activeTabId = t.id;
  mruPromote(t.id);
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  ed.value = t.content;
  ed.selectionStart = ed.selectionEnd = 0;
  applyEditorWrap();
  saveState();
  renderTabs();
  renderInputModeToggle();
  return t;
}

/** @param {import('./types.js').Tab} tab */
export function toggleTabExcluded(tab) {
  if (tab.excluded) delete tab.excluded;
  else tab.excluded = true;
  saveState();
  renderTabs();
  renderInputModeToggle();
}

/**
 * @param {{ blank?: boolean }} [opts] `blank: true` bypasses
 *   `settings.editor.defaultNewTabText` and creates a truly empty tab.
 */
export function newTab(opts = {}) {
  const cur = activeTab();
  if (cur) cur.content = $('#editor').value;
  const content = opts.blank ? '' : settings.editor.defaultNewTabText || '';
  const t = { id: uid(), title: `Tab ${state.tabs.length + 1}`, content };
  state.tabs.push(t);
  state.activeTabId = t.id;
  mruPromote(t.id);
  $('#editor').value = content;
  applyEditorWrap();
  $('#editor').focus();
  saveState();
  renderTabs();
  renderInputModeToggle();
}

export async function closeTab(tab) {
  const isActive = tab.id === state.activeTabId;
  const currentContent = isActive ? $('#editor').value : tab.content;
  if (currentContent && settings.editor.confirmCloseTabWithContent) {
    const ok = await appConfirm(`Close "${tab.title}"? Its content will be lost.`, {
      title: 'Close tab',
      danger: true,
      okLabel: 'Close',
    });
    if (!ok) return;
  }
  const idx = state.tabs.findIndex((t) => t.id === tab.id);
  state.tabs.splice(idx, 1);
  mruRemove(tab.id);
  if (state.tabs.length === 0) {
    // Closing the last tab: spawn a fresh blank tab rather than leaving
    // the editor tabless. `newTab()` reuses the default-new-tab-text
    // setting and the `Tab ${length + 1}` naming formula — with 0 tabs
    // left that resolves to 'Tab 1', matching first-run state. It also
    // saves state and re-renders the tab strip, so no more work needed.
    newTab();
    return;
  }
  if (isActive) {
    const nextIdx = Math.min(idx, state.tabs.length - 1);
    state.activeTabId = state.tabs[nextIdx].id;
    $('#editor').value = state.tabs[nextIdx].content;
    $('#editor').selectionStart = $('#editor').selectionEnd = 0;
    applyEditorWrap();
  }
  saveState();
  renderTabs();
  renderInputModeToggle();
}

/**
 * Move `source` to the position before/after `target`. Pin-cluster
 * invariant is restored by `applyPinSort()` — if the user dropped across
 * the boundary, the dragged tab snaps back to its own cluster edge.
 * Concrete examples with tabs [P1, P2, U1, U2, U3] (P* pinned):
 *   - drag U3 before P1      → clamped to [P1, P2, U3, U1, U2]
 *   - drag U1 before U3      → [P1, P2, U2, U1, U3] (normal reorder)
 *   - drag P1 after U1       → clamped to [P2, P1, U1, U2, U3]
 *
 * @param {import('./types.js').Tab} source
 * @param {import('./types.js').Tab} target
 * @param {boolean} after
 */
export function reorderTab(source, target, after) {
  const fromIdx = state.tabs.indexOf(source);
  if (fromIdx < 0) return;
  state.tabs.splice(fromIdx, 1);
  const toIdx = state.tabs.indexOf(target);
  if (toIdx < 0) {
    // Shouldn't happen, but if it does, append as a safe fallback.
    state.tabs.push(source);
  } else {
    state.tabs.splice(toIdx + (after ? 1 : 0), 0, source);
  }
  applyPinSort();
  saveState();
  renderTabs();
}

/**
 * Separator for Shift+drop tab merges. Resolved from
 * `settings.editor.tabMergeSeparator`:
 *   - `'dash'`    → `\n---\n` (default; visually explicit divider line)
 *   - `'newline'` → `\n`      (just start source on a new line)
 *   - `'none'`    → `''`      (direct concatenation; useful when merging
 *                               structured content the user has already
 *                               shaped at the source's boundary)
 *
 * Skipped entirely when the target is empty (any mode) so merges into a
 * fresh tab don't produce a leading blank line or stray `---`.
 *
 * @returns {string}
 */
function mergeSeparator() {
  switch (settings.editor.tabMergeSeparator) {
    case 'newline':
      return '\n';
    case 'none':
      return '';
    case 'dash':
    default:
      return '\n---\n';
  }
}

/**
 * Append `source.content` to `target.content` with the user's configured
 * separator (skipped when target is empty). Source stays open; target
 * becomes active so the user sees the merged result. Empty source is a
 * no-op with a toast.
 *
 * @param {import('./types.js').Tab} source
 * @param {import('./types.js').Tab} target
 */
export function mergeTabs(source, target) {
  if (!source.content) {
    showToast({
      title: `"${source.title}" is empty`,
      body: 'Nothing to merge.',
      level: 'info',
      duration: 2500,
    });
    return;
  }
  const sep = target.content ? mergeSeparator() : '';
  const appended = sep + source.content;
  // Switch to target first (when needed) so the editor displays its
  // pre-merge content. We deliberately do *not* pre-mutate
  // target.content — the editTextRange call below appends through
  // execCommand('insertText'), which fires a native input event that
  // the editor's listener uses to sync editor.value → target.content
  // automatically. Going via insertText keeps the merge on the
  // textarea's native undo stack, so Ctrl+Z reverts it cleanly; a
  // direct `.value =` assignment (the previous code path) would have
  // wiped the stack and made the merge unreversible.
  if (target.id !== state.activeTabId) {
    switchToTab(target.id);
  }
  const ed = $('#editor');
  editTextRange(ed, ed.value.length, ed.value.length, appended);
  showToast({
    title: 'Merged',
    body: `"${source.title}" → "${target.title}"`,
    level: 'info',
    duration: 2500,
  });
}

/**
 * Stable-sort `state.tabs` so pinned tabs cluster at the left, preserving
 * relative order within each group. Idempotent — safe to call after any
 * tab mutation that might violate the invariant.
 */
function applyPinSort() {
  const pinned = state.tabs.filter((t) => t.pinned);
  const rest = state.tabs.filter((t) => !t.pinned);
  state.tabs = [...pinned, ...rest];
}

/**
 * Toggle `tab.pinned` and re-cluster. Unpin flag is deleted rather than
 * set to `false` so serialized tabs stay shaped like pre-Phase-2 data
 * (an unpinned tab has no `pinned` field, same as before the feature).
 */
export function togglePin(tab) {
  if (tab.pinned) delete tab.pinned;
  else tab.pinned = true;
  applyPinSort();
  saveState();
  renderTabs();
}

/**
 * Bulk close helper. One confirm dialog (not N) when any of the doomed tabs
 * has content and `confirmCloseTabWithContent` is on — batch UX beats a
 * dialog-storm. The editor's `input` handler keeps `activeTab().content` in
 * sync with the textarea on every keystroke, so `t.content` is authoritative
 * here; we don't have to special-case the active tab.
 *
 * @param {import('./types.js').Tab[]} tabsToClose
 * @param {string} title
 */
async function closeTabs(tabsToClose, title) {
  if (!tabsToClose.length) return;
  if (settings.editor.confirmCloseTabWithContent) {
    const withContent = tabsToClose.filter((t) => !!(t.content && t.content.length));
    if (withContent.length) {
      const n = tabsToClose.length;
      const msg =
        withContent.length === n
          ? `Close ${n} tab${n === 1 ? '' : 's'}? Content will be lost.`
          : `Close ${n} tabs (${withContent.length} with content)? Content will be lost.`;
      const ok = await appConfirm(msg, { title, danger: true, okLabel: 'Close' });
      if (!ok) return;
    }
  }
  const ids = new Set(tabsToClose.map((t) => t.id));
  state.tabs = state.tabs.filter((t) => !ids.has(t.id));
  for (const id of ids) mruRemove(id);
  if (state.tabs.length === 0) {
    // Mirrors closeTab's last-tab handling: spawn a fresh blank tab so the
    // editor is never tabless. `newTab()` saves state + re-renders.
    newTab();
    return;
  }
  if (!state.tabs.find((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
    $('#editor').value = state.tabs[0].content;
    $('#editor').selectionStart = $('#editor').selectionEnd = 0;
    applyEditorWrap();
  }
  saveState();
  renderTabs();
}

// Bulk closes skip pinned tabs by design. The anchor tab itself *is* closed
// when the user invoked these via its menu (the anchor was the click target),
// even if pinned — that's outside the "bulk" contract. Actually no: "close
// others" explicitly keeps the anchor; "close left/right/all" operate on
// ranges. For range variants, pinning protects everything including the
// anchor if it falls in the range. Simpler mental model: pinned = immune
// to any bulk close.
export function closeOtherTabs(keep) {
  return closeTabs(
    state.tabs.filter((t) => t.id !== keep.id && !t.pinned),
    'Close other tabs',
  );
}
export function closeTabsLeft(anchor) {
  const idx = state.tabs.findIndex((t) => t.id === anchor.id);
  if (idx <= 0) return;
  return closeTabs(
    state.tabs.slice(0, idx).filter((t) => !t.pinned),
    'Close tabs to the left',
  );
}
export function closeTabsRight(anchor) {
  const idx = state.tabs.findIndex((t) => t.id === anchor.id);
  if (idx < 0 || idx >= state.tabs.length - 1) return;
  return closeTabs(
    state.tabs.slice(idx + 1).filter((t) => !t.pinned),
    'Close tabs to the right',
  );
}
export function closeAllTabs() {
  return closeTabs(
    state.tabs.filter((t) => !t.pinned),
    'Close all tabs',
  );
}

/**
 * Insert a copy of `tab` directly to its right and activate the copy. Title
 * gets a " (copy)" suffix; wrap preference carries over.
 */
export function duplicateTab(tab) {
  const idx = state.tabs.findIndex((t) => t.id === tab.id);
  if (idx < 0) return;
  /** @type {import('./types.js').Tab} */
  const copy = { id: uid(), title: `${tab.title} (copy)`, content: tab.content };
  if (tab.wordWrap) copy.wordWrap = tab.wordWrap;
  if (tab.pinned) copy.pinned = true;
  state.tabs.splice(idx + 1, 0, copy);
  state.activeTabId = copy.id;
  $('#editor').value = copy.content;
  $('#editor').selectionStart = $('#editor').selectionEnd = 0;
  applyEditorWrap();
  saveState();
  renderTabs();
}

/**
 * Return the smallest `(N)`-suffixed variant of `base` that doesn't
 * collide with an existing text snippet name. The suffix is inserted
 * *before* the filename extension when one is present — `users.json`
 * becomes `users (2).json`, matching the convention most file pickers
 * use. "Extension" here is the substring after the last `.`, unless the
 * name starts with a dot (hidden-file style) or ends with one, in which
 * case the name is treated as extensionless.
 *
 * @param {string} base
 * @returns {string}
 */
function nextFreeName(base) {
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && dot < base.length - 1;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot) : '';
  let i = 2;
  while (state.textSnippets.some((s) => s.name === `${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}

/**
 * Save `tab`'s current content as a text snippet. Three branches based
 * on how many existing snippets share the tab's title:
 *
 *   - **0 matches** — simple "New text snippet name:" prompt; save
 *     creates a fresh snippet.
 *   - **1 match** — dialog offers **Overwrite** as an extra action
 *     alongside "Save as new" (which uses the `(N)`-suffixed default).
 *     Overwrite targets that single match, regardless of what the
 *     user typed into the input — the button label names the target.
 *   - **2+ matches** — Overwrite is too ambiguous to offer (which one?),
 *     so we drop it and explain in the message. Cancel still flashes
 *     every matching row so the user can disambiguate visually and
 *     click the right ⟳ in the sidebar.
 *
 * Both save paths relink the tab's `sourceSnippetId` so the dirty-dot
 * comparison restarts clean against the just-created/updated snippet.
 *
 * @param {import('./types.js').Tab} tab
 */
async function saveTabAsSnippet(tab) {
  const base = (tab.title || '').trim();
  const matches = base ? state.textSnippets.filter((s) => s.name === base) : [];
  const defaultName = matches.length ? nextFreeName(base) : base;

  let message;
  if (matches.length === 0) {
    message = 'New text snippet name:';
  } else if (matches.length === 1) {
    message =
      `A text snippet named "${base}" already exists.\n` +
      `Overwrite replaces it. Save as new creates "${defaultName}".`;
  } else {
    message =
      `${matches.length} text snippets are named "${base}" — too ambiguous to overwrite from here.\n` +
      `Save as new creates "${defaultName}". To overwrite a specific one, cancel and use its \u21bb button in the Text Snippets sidebar.`;
  }

  const extraActions =
    matches.length === 1
      ? [{ value: 'overwrite', label: `Overwrite "${base}"`, danger: true }]
      : [];
  const okLabel = matches.length ? 'Save as new' : 'Save';

  const result = await appPrompt(message, {
    title: 'Save as text snippet',
    defaultValue: defaultName,
    placeholder: 'Snippet name',
    okLabel,
    extraActions,
  });

  // Cancel / Esc on the collision path implicitly means "take me to the
  // ⟳ button" — flash every matching row so the user's eye lands on the
  // overwrite control. Plain cancel (no matches) has nothing to point at.
  if (result === null) {
    for (const s of matches) {
      highlightSidebarRow({
        sectionKey: 'text-snippets',
        listId: 'text-snippets',
        itemId: s.id,
      });
    }
    return;
  }

  const isObject = typeof result === 'object';
  const action = isObject ? result.action : 'ok';

  if (action === 'overwrite' && matches.length === 1) {
    const target = matches[0];
    target.content = tab.content;
    tab.sourceSnippetId = target.id;
    // Usually a no-op (the collision was keyed off tab.title === target.name)
    // but covers the edge case where the snippet was renamed between
    // opening and save: the tab should reflect its new source.
    tab.title = target.name;
    saveState();
    dispatch('library:text-snippets-changed');
    renderTabs();
    highlightSidebarRow({
      sectionKey: 'text-snippets',
      listId: 'text-snippets',
      itemId: target.id,
    });
    showToast({
      title: 'Overwrote text snippet',
      body: `"${target.name}"`,
      level: 'info',
      duration: 2500,
    });
    return;
  }

  // Save as new — either OK submit (string or `{action:'ok'}`) or a
  // stray extra action that wasn't overwrite (future-proofing).
  const typed = (isObject ? result.text : result).trim();
  if (!typed) return;
  const finalName = state.textSnippets.some((s) => s.name === typed)
    ? nextFreeName(typed)
    : typed;
  const snippet = { id: uid(), name: finalName, content: tab.content };
  state.textSnippets.push(snippet);
  tab.sourceSnippetId = snippet.id;
  // Tab title follows the snippet name — if the user saved as
  // "users (2).json" the tab should read "users (2).json" too, matching
  // the experience of opening that snippet fresh from the sidebar.
  tab.title = snippet.name;
  saveState();
  dispatch('library:text-snippets-changed');
  renderTabs();
  highlightSidebarRow({
    sectionKey: 'text-snippets',
    listId: 'text-snippets',
    itemId: snippet.id,
  });
  showToast({
    title: 'Saved as text snippet',
    body: `"${finalName}"`,
    level: 'info',
    duration: 2500,
  });
}

async function renameTab(tab) {
  const name = await appPrompt('New tab name:', { title: 'Rename tab', defaultValue: tab.title });
  if (name && name.trim()) {
    tab.title = name.trim();
    saveState();
    renderTabs();
  }
}

// ---------- word wrap ----------
/**
 * Cached wrap state for the main editor. Source of truth is the active tab's
 * `wordWrap` (fallback: `settings.editor.defaultWordWrap`); this is a local
 * copy read by `attachEditorMatchOverlay` and its `withWrapMarkers` closure
 * so they don't have to re-resolve the tab/setting on every render. Updated
 * by `applyEditorWrap`.
 */
let editorWrapOn = false;

function effectiveWrap(tab) {
  if (tab && (tab.wordWrap === 'on' || tab.wordWrap === 'off')) return tab.wordWrap;
  return settings.editor.defaultWordWrap === 'on' ? 'on' : 'off';
}

export function applyEditorWrap() {
  const tab = activeTab();
  const on = effectiveWrap(tab) === 'on';
  editorWrapOn = on;
  const editor = $('#editor');
  editor.setAttribute('wrap', on ? 'soft' : 'off');
  const area = document.getElementById('editor-area');
  if (area) area.classList.toggle('wrap-on', on);
  const btn = document.getElementById('wrap-btn');
  if (btn) btn.classList.toggle('active', on);
  findState.redrawOverlay();
}

export function toggleActiveTabWrap() {
  const tab = activeTab();
  if (!tab) return;
  const current = effectiveWrap(tab);
  tab.wordWrap = current === 'on' ? 'off' : 'on';
  applyEditorWrap();
  saveState();
}

// ---------- find / replace ----------
/**
 * Find-panel subsystem state. The `#find-input` panel is a singleton UI —
 * there is no concurrent-flow race to worry about. Grouping these four fields
 * into one object makes the reset points (`openFindPanel`, `closeFindPanel`,
 * `computeFindMatches` on clear/error) and the ownership contract explicit.
 *
 * - `matches`: half-open [start, end) ranges into `#editor.value`.
 * - `index`: active match cursor, or -1 when none.
 * - `redrawOverlay`: repaints the overlay `<pre>`. Assigned by
 *   `attachEditorMatchOverlay`; a no-op before the overlay attaches.
 * - `debounceTimer`: handle from `scheduleFindRefresh`; cleared by `flush` /
 *   `close`.
 *
 * @type {{
 *   matches: Array<[number, number]>,
 *   index: number,
 *   redrawOverlay: () => void,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }}
 */
const findState = {
  matches: [],
  index: -1,
  redrawOverlay: () => {},
  debounceTimer: null,
};

/**
 * Repaint the main editor's highlight overlay after a programmatic content
 * change (tab switch, template load, file open, wrap toggle, etc.). Prefer
 * this over `editor.dispatchEvent(new Event('input'))`, which also fires the
 * content-save listener unnecessarily.
 */
export function refreshEditorOverlay() {
  findState.redrawOverlay();
}
/** @type {WeakMap<HTMLTextAreaElement, ResizeObserver>} */
const EDITOR_OVERLAY_OBSERVERS = new WeakMap();

/**
 * Detach the find-overlay from a textarea, disconnecting its ResizeObserver.
 * @param {HTMLTextAreaElement} textarea
 */
export function detachEditorMatchOverlay(textarea) {
  const ro = EDITOR_OVERLAY_OBSERVERS.get(textarea);
  if (ro) {
    ro.disconnect();
    EDITOR_OVERLAY_OBSERVERS.delete(textarea);
  }
}

export function attachEditorMatchOverlay(textarea) {
  const wrap = document.createElement('div');
  wrap.className = 'hl-wrap';
  textarea.parentNode.insertBefore(wrap, textarea);
  const pre = document.createElement('pre');
  pre.className = 'hl-pre';
  pre.setAttribute('aria-hidden', 'true');
  // Inner wrapper is the only child of `pre`. Content goes here; scroll sync
  // is a CSS transform on this element. Transforms are composited, so the
  // overlay updates in the same frame as the textarea's native scroll — no
  // one-frame lag like there was with `pre.scrollTop = textarea.scrollTop`.
  const preInner = document.createElement('div');
  preInner.className = 'hl-pre-inner';
  pre.appendChild(preInner);
  wrap.appendChild(pre);
  wrap.appendChild(textarea);
  textarea.classList.add('hl-textarea');

  const syncStyles = () => {
    const cs = getComputedStyle(textarea);
    // Clear any stale inline values left over from a previous build
    // that synced these two via `pre.style.*`. Without this, a soft
    // reload over an already-running session would keep the overlay
    // locked to the pre-fix font / tab-size until a full reload.
    pre.style.fontFamily = '';
    pre.style.tabSize = '';
    // `tabSize` and `fontFamily` are deliberately NOT synced via
    // inline style. Both sides already resolve against shared CSS
    // custom properties — `--editor-tab-size` (set by applySettings)
    // and `--editor-font-family` (ditto). Syncing via `pre.style.X`
    // would snapshot the current value as a higher-specificity inline
    // override, so the overlay stayed stuck on whatever was current
    // at sync time until the next ResizeObserver fire — reflow-free
    // setting changes (tab-size flip, font-family flip) wouldn't
    // update the overlay at all. Letting CSS own them means a single
    // applySettings write repaints both the textarea and the overlay
    // in the same frame.
    for (const prop of [
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'paddingTop',
      'paddingBottom',
      'paddingLeft',
      'paddingRight',
      'borderTopWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'borderRightWidth',
    ]) {
      pre.style[prop] = cs[prop];
    }
  };
  const withWrapMarkers = (s) =>
    editorWrapOn ? s.replace(/\n/g, '<span class="wrap-endline">\u21b5</span>\n') : s;
  const render = () => {
    const text = textarea.value;
    if (!findState.matches.length) {
      preInner.innerHTML = withWrapMarkers(escapeHtml(text));
    } else {
      let html = '';
      let cursor = 0;
      for (let i = 0; i < findState.matches.length; i++) {
        const [s, e] = findState.matches[i];
        html += withWrapMarkers(escapeHtml(text.slice(cursor, s)));
        const cls = i === findState.index ? 'find-current' : 'find-other';
        html += `<span class="${cls}">${escapeHtml(text.slice(s, e))}</span>`;
        cursor = e;
      }
      html += withWrapMarkers(escapeHtml(text.slice(cursor)));
      preInner.innerHTML = html;
    }
  };
  const sync = () => {
    // Round to integer pixels — fractional scroll positions (elastic
    // scrolling, ancestor transforms) would raster the composited layer at
    // sub-pixel offsets and visibly blur the text. When there's no scroll
    // offset at all, remove the transform entirely so the browser keeps the
    // pre in the main paint layer (any non-empty transform — even
    // `translate(0,0)` — can promote it to a compositor layer, which
    // Chrome then rasterizes at fractional origins if the parent doesn't
    // land on an integer pixel).
    const x = Math.round(textarea.scrollLeft);
    const y = Math.round(textarea.scrollTop);
    preInner.style.transform = x === 0 && y === 0 ? '' : `translate(${-x}px, ${-y}px)`;
  };

  syncStyles();
  textarea.addEventListener('input', () => {
    render();
    sync();
  });
  textarea.addEventListener('scroll', sync);
  const ro = new ResizeObserver(() => {
    syncStyles();
    sync();
  });
  ro.observe(textarea);
  EDITOR_OVERLAY_OBSERVERS.set(textarea, ro);
  // Font-family / tab-size changes don't reflow the textarea, so the
  // ResizeObserver above won't retrigger syncStyles. Listen for the
  // deliberate event dispatched by `applySettings` / live-preview to
  // re-sync. Safe to fire more often than needed — syncStyles is cheap.
  on('editor-font-settings-changed', syncStyles);
  render();
  sync();

  findState.redrawOverlay = () => {
    render();
    sync();
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Debounce the typed-input path only. Rebuilding the full match list on every
// keystroke is cheap for small tabs but allocates heavily on large ones;
// 120ms is imperceptible to users yet collapses bursts of typing into one
// compute. Explicit actions (Enter, checkbox toggle, replace) flush any
// pending compute so they never see stale matches.
const FIND_DEBOUNCE_MS = 120;

function runFindRefresh() {
  computeFindMatches();
  if (findState.matches.length && findState.index < 0) {
    findState.index = 0;
    highlightMatch();
  }
}
function scheduleFindRefresh() {
  clearTimeout(findState.debounceTimer);
  findState.debounceTimer = setTimeout(() => {
    findState.debounceTimer = null;
    runFindRefresh();
  }, FIND_DEBOUNCE_MS);
}
function flushFindRefresh() {
  if (findState.debounceTimer === null) return;
  clearTimeout(findState.debounceTimer);
  findState.debounceTimer = null;
  runFindRefresh();
}

function computeFindMatches() {
  const query = $('#find-input').value;
  const countEl = $('#find-count');
  if (!query) {
    findState.matches = [];
    findState.index = -1;
    countEl.textContent = '';
    countEl.classList.remove('no-match');
    return;
  }
  const flags = $('#find-case').checked ? 'g' : 'gi';
  const isRegex = $('#find-regex').checked;
  let re;
  try {
    re = new RegExp(isRegex ? query : escapeRegExp(query), flags);
  } catch (_err) {
    findState.matches = [];
    findState.index = -1;
    countEl.textContent = 'err';
    countEl.classList.add('no-match');
    return;
  }
  const text = $('#editor').value;
  findState.matches = [];
  // Catastrophic-backtracking hedge: V8/SpiderMonkey have no way to bound a
  // single `re.exec` call, so a pathological user pattern can still freeze the
  // tab. What we *can* cap is the outer loop: max match count + wall-clock
  // budget. Hitting either marks the result as truncated; the user gets
  // navigable matches without an unbounded allocation.
  const MAX_MATCHES = 10000;
  const BUDGET_MS = 500;
  const deadline =
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) + BUDGET_MS;
  let truncated = false;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    findState.matches.push([m.index, m.index + m[0].length]);
    if (findState.matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if ((findState.matches.length & 0x3f) === 0) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now > deadline) {
        truncated = true;
        break;
      }
    }
  }
  if (!findState.matches.length) {
    findState.index = -1;
    countEl.textContent = '0 / 0';
    countEl.classList.add('no-match');
  } else {
    findState.index =
      findState.index >= 0 && findState.index < findState.matches.length ? findState.index : 0;
    const total = truncated ? `${findState.matches.length}+` : String(findState.matches.length);
    countEl.textContent = `${findState.index + 1} / ${total}`;
    countEl.classList.remove('no-match');
  }
  findState.redrawOverlay();
}

function highlightMatch() {
  if (findState.index < 0 || findState.index >= findState.matches.length) return;
  const [s, e] = findState.matches[findState.index];
  const editor = $('#editor');
  editor.setSelectionRange(s, e);
  const approxLine = editor.value.slice(0, s).split('\n').length;
  const lineHeight = 1.5 * parseFloat(getComputedStyle(editor).fontSize);
  editor.scrollTop = Math.max(0, approxLine * lineHeight - editor.clientHeight / 2);
}

function findNext() {
  flushFindRefresh();
  if (!findState.matches.length) return;
  findState.index = (findState.index + 1) % findState.matches.length;
  $('#find-count').textContent = `${findState.index + 1} / ${findState.matches.length}`;
  findState.redrawOverlay();
  highlightMatch();
}
function findPrev() {
  flushFindRefresh();
  if (!findState.matches.length) return;
  findState.index = (findState.index - 1 + findState.matches.length) % findState.matches.length;
  $('#find-count').textContent = `${findState.index + 1} / ${findState.matches.length}`;
  findState.redrawOverlay();
  highlightMatch();
}

function replaceCurrent() {
  flushFindRefresh();
  if (findState.index < 0 || findState.index >= findState.matches.length) return;
  const [s, e] = findState.matches[findState.index];
  editTextRange($('#editor'), s, e, $('#replace-input').value);
  computeFindMatches();
  if (findState.matches.length) highlightMatch();
  $('#find-input').focus();
}

function replaceAll() {
  flushFindRefresh();
  const query = $('#find-input').value;
  if (!query) return;
  const flags = $('#find-case').checked ? 'g' : 'gi';
  const isRegex = $('#find-regex').checked;
  let re;
  try {
    re = new RegExp(isRegex ? query : escapeRegExp(query), flags);
  } catch (_) {
    return;
  }
  const editor = $('#editor');
  const replacement = $('#replace-input').value;
  const original = editor.value;
  // Count before mutating — matchAll avoids lastIndex bookkeeping bugs and
  // gives an iterator over all matches on the unmodified source.
  const count = [...original.matchAll(re)].length;
  const updated = original.replace(re, replacement);
  if (updated === original) return;
  editTextRange(editor, 0, original.length, updated);
  editor.setSelectionRange(0, 0);
  computeFindMatches();
  showToast({
    title: 'Replace all',
    body: `${count} replacement${count === 1 ? '' : 's'} made`,
    level: 'info',
    duration: 3000,
  });
  $('#find-input').focus();
}

export function openFindPanel(mode) {
  const panel = $('#find-panel');
  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
  panel.classList.toggle('find-only', mode === 'find');
  const editor = $('#editor');
  const sel =
    editor.selectionStart !== editor.selectionEnd
      ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
      : null;
  if (sel && !sel.includes('\n')) $('#find-input').value = sel;
  computeFindMatches();
  if (findState.matches.length && findState.index < 0) findState.index = 0;
  setTimeout(() => {
    $('#find-input').focus();
    $('#find-input').select();
  }, 10);
}

export function closeFindPanel() {
  if (findState.debounceTimer !== null) {
    clearTimeout(findState.debounceTimer);
    findState.debounceTimer = null;
  }
  const panel = $('#find-panel');
  panel.classList.add('hidden');
  panel.setAttribute('aria-hidden', 'true');
  findState.matches = [];
  findState.index = -1;
  findState.redrawOverlay();
  $('#editor').focus();
}

export function setupFindPanel() {
  $('#find-input').addEventListener('input', () => {
    findState.index = -1;
    scheduleFindRefresh();
  });
  for (const id of ['find-case', 'find-regex']) {
    $('#' + id).addEventListener('change', () => {
      findState.index = -1;
      runFindRefresh();
    });
  }
  $('#find-next').addEventListener('click', findNext);
  $('#find-prev').addEventListener('click', findPrev);
  $('#find-replace').addEventListener('click', replaceCurrent);
  $('#find-replace-all').addEventListener('click', replaceAll);
  $('#find-close').addEventListener('click', closeFindPanel);

  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else findNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindPanel();
    }
  });
  $('#replace-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceCurrent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindPanel();
    }
  });
}

// ---------- jump to line ----------
export async function jumpToLineInTextarea(ta) {
  const input = await appPrompt('Line number:', { title: 'Jump to line', placeholder: 'e.g. 42' });
  if (!input) return;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1) return;
  const lines = ta.value.split('\n');
  const line = Math.min(n, lines.length);
  let pos = 0;
  for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  const fs = parseFloat(getComputedStyle(ta).fontSize) || 13;
  ta.scrollTop = Math.max(0, (line - 1) * fs * 1.5 - ta.clientHeight / 2);
}

// ---------- file save / drop ----------
/**
 * Download a tab's content as a text file. `tab.content` is authoritative
 * (see note in `closeTabs`), so no editor-value flush needed even when
 * saving the active tab.
 * @param {import('./types.js').Tab} tab
 */
export function saveTabToFile(tab) {
  const blob = new Blob([tab.content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  let name = (tab.title || 'tab').trim() || 'tab';
  if (!/\.\w{1,8}$/.test(name)) name += '.txt';
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function saveActiveTabToFile() {
  const tab = activeTab();
  if (tab) saveTabToFile(tab);
}

async function handleFilesDropped(files) {
  if (!files || !files.length) return;
  const cur = activeTab();
  if (cur) cur.content = $('#editor').value;
  // Snapshot the scratch-tab decision before we start mutating
  // state.tabs — once the first file read succeeds and pushes a tab,
  // `isScratchInitialTab()` would return false for the rest of the
  // loop. Drop the scratch after the reads so a batch of failures
  // doesn't leave the user tabless.
  const scratchId = isScratchInitialTab() ? state.tabs[0].id : null;
  const newTabs = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const t = {
        id: uid(),
        title: file.name || `Tab ${state.tabs.length + newTabs.length + 1}`,
        content: text,
      };
      state.tabs.push(t);
      newTabs.push(t);
    } catch (err) {
      showToast({ title: `Failed to read "${file.name}"`, body: err.message });
    }
  }
  if (!newTabs.length) return;
  if (scratchId) {
    state.tabs = state.tabs.filter((t) => t.id !== scratchId);
    mruRemove(scratchId);
  }
  state.activeTabId = newTabs[newTabs.length - 1].id;
  const tab = activeTab();
  $('#editor').value = tab ? tab.content : '';
  $('#editor').selectionStart = $('#editor').selectionEnd = 0;
  findState.redrawOverlay();
  saveState();
  renderTabs();
  showToast({
    title: `Opened ${newTabs.length} file${newTabs.length === 1 ? '' : 's'}`,
    level: 'info',
    duration: 3000,
  });
}

export function setupEditorTabs() {
  rebuildMruFromState();
  // A text-snippet mutation can flip dirty state for any tab that
  // references it (content change, deletion). Listen here so the strip
  // reflects the new comparison without requiring the library to reach
  // into editor internals.
  on('library:text-snippets-changed', renderTabs);
  renderTabs();
  const cur = activeTab();
  $('#editor').value = cur ? cur.content : '';
  $('#editor').addEventListener('input', () => {
    const t = activeTab();
    if (t) t.content = $('#editor').value;
    updateActiveTabDirty();
    clearTimeout(saveTabsTimer);
    saveTabsTimer = setTimeout(saveState, settings.data.saveDebounceMs);
  });
  attachTabIndent($('#editor'));
  window.addEventListener('beforeunload', () => {
    const t = activeTab();
    if (t) t.content = $('#editor').value;
    saveState();
  });

  const editor = $('#editor');
  const dropTarget = document.getElementById('editor-area') || editor;
  dropTarget.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dropTarget.classList.add('drop-target');
    }
  });
  dropTarget.addEventListener('dragleave', (e) => {
    if (e.target === dropTarget || e.relatedTarget === null) {
      dropTarget.classList.remove('drop-target');
    }
  });
  dropTarget.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dropTarget.classList.remove('drop-target');
    handleFilesDropped(e.dataTransfer.files);
  });
}

// ---------- line numbers ----------

let lineNumbersVisible = false;

function updateLineNumbers() {
  const gutter = document.getElementById('line-numbers');
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  if (!gutter || !lineNumbersVisible) return;
  const count = (ed.value.match(/\n/g) || []).length + 1;
  const lines = [];
  for (let i = 1; i <= count; i++) lines.push(String(i));
  gutter.textContent = lines.join('\n');
}

function syncLineNumberScroll() {
  const gutter = document.getElementById('line-numbers');
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  if (gutter && lineNumbersVisible) gutter.scrollTop = ed.scrollTop;
}

export function applyLineNumbers() {
  const gutter = document.getElementById('line-numbers');
  const btn = document.getElementById('line-num-btn');
  const on = !!settings.editor.lineNumbers;
  lineNumbersVisible = on;
  if (gutter) {
    gutter.hidden = !on;
    if (on) updateLineNumbers();
  }
  if (btn) btn.classList.toggle('active', on);
}

export function setupLineNumbers() {
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  ed.addEventListener('input', updateLineNumbers);
  ed.addEventListener('scroll', syncLineNumberScroll);
  const btn = document.getElementById('line-num-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      settings.editor.lineNumbers = !settings.editor.lineNumbers;
      applyLineNumbers();
    });
  }
  applyLineNumbers();
  on('settings-saved', applyLineNumbers);
}
