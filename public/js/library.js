// @ts-check
// Sidebar library: snippets, chains, text snippets, templates.
// Owns their render functions, favorite / duplicate / delete / rename actions,
// run-on-selection and run-at-cursor entry points, and the sidebar search
// filter. Event-driven updates from dialogs.js and pipeline.js.

import {
  $,
  uid,
  editText,
  editTextRange,
  IS_MAC,
  showToast,
  pulseSidebarRow,
  favoriteThenName,
  closestOn,
  appAlert,
  appConfirm,
  appChoose,
  appPrompt,
  safeSetItem,
  showListPlaceholder,
  reconcileKeyedList,
} from './core.js';
import { LS_KEYS } from './data.js';
import { dispatch, on } from './events.js';
import {
  state,
  saveState,
  stepLabel,
  allSnippetTags,
  allChainTags,
  allTemplateTags,
  normalizeTags,
  planChainVarsPrompt,
  applyChainPromptAnswers,
  resolveStepVars,
} from './state.js';
import { getCachedSummary } from './tests.js';
import { formatShortcut } from './shortcuts.js';
import { settings } from './settings.js';
import { runAwk, runAwkMulti } from './awk.js';
import {
  getSel,
  insertAtEditorCursor,
  renderTabs,
  activeTab,
  refreshEditorOverlay,
  isScratchInitialTab,
  writeOutput,
  normalizeAwkOutput,
} from './editor.js';
import { resolveInput } from './inputMode.js';
import { addPipelineStep, loadChainIntoPipeline, appendChainToPipeline } from './pipeline.js';
import {
  openSnippetDialog,
  openTemplateDialog,
  openChainDialog,
  promptForVars,
} from './dialogs.js';

// ---------- utilities ----------
function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/**
 * Deep-clone a chain, assign a fresh id and a unique name, push onto
 * `state.chains`, and persist. Caller is responsible for re-rendering
 * (`renderChains()`) and any dialog opening — this helper just
 * mutates state. Returns the new chain so chained flows (like "clone
 * for edit") can act on it.
 *
 * `desiredName` is an optional base name for the copy. Passed through
 * `uniqueName` so same-name collisions still get a " 2" / " 3" suffix,
 * but otherwise lets callers set the name from their own context
 * (e.g. the Detect FS clone-for-edit flow uses "<chain> (users.json)"
 * or "<chain> (selection 1)"). Omitted → the traditional "<name> copy"
 * default used by the sidebar's Duplicate button.
 *
 * @param {import('./types.js').Chain} original
 * @param {string} [desiredName]
 * @returns {import('./types.js').Chain}
 */
export function cloneChain(original, desiredName) {
  const taken = new Set(state.chains.map((x) => x.name));
  /** @type {import('./types.js').Chain} */
  const copy = {
    id: uid(),
    name: uniqueName(desiredName || `${original.name} copy`, taken),
    steps: original.steps.map((st) => ({ ...st })),
  };
  if (original.description) copy.description = original.description;
  if (original.tags && original.tags.length) copy.tags = [...original.tags];
  if (original.vars) copy.vars = { ...original.vars };
  if (original.tests && original.tests.length) {
    copy.tests = original.tests.map((t) => ({
      ...t,
      id: uid(),
      vars: t.vars ? { ...t.vars } : undefined,
    }));
  }
  state.chains.push(copy);
  saveState();
  return copy;
}

/**
 * Live case-insensitive filter applied to every sidebar list (snippets,
 * chains, text snippets, templates). Updated by `setSidebarFilter`; each
 * `render*` function re-reads this and shows "(no matches)" when nothing
 * survives the filter.
 * @type {string}
 */
let sidebarFilter = '';

/**
 * Which fields the sidebar filter is allowed to search. Persisted across
 * sessions; both fields default to true so the sidebar's behaviour out of
 * the box is "search everything." `name` covers item names + descriptions
 * (short metadata); `content` covers bodies (snippet program, template
 * body, text-snippet content) and only kicks in past `BODY_SEARCH_MIN`.
 *
 * Both off = nothing matches; we render the placeholders and leave the
 * decision to the user — they explicitly turned every search target off.
 */
let sidebarSearchScope = loadSidebarSearchScope();
let sidebarFilterFailing = false;

/**
 * Per-section sort mode. 'T' = group by tag (default, preserves the
 * original sidebar layout); 'A' = flat A-Z; 'Z' = flat Z-A. Stored
 * per-section in localStorage so each list can be toggled independently.
 */
const SORT_CYCLE = /** @type {const} */ (['T', 'A', 'Z']);
const SORTABLE_SECTIONS = /** @type {const} */ (['snippets', 'chains', 'templates']);
const sortModes = /** @type {Record<string, 'T' | 'A' | 'Z'>} */ ({});
for (const key of SORTABLE_SECTIONS) {
  const raw = localStorage.getItem(LS_KEYS.sortMode(key));
  sortModes[key] = raw === 'A' || raw === 'Z' ? raw : 'T';
}
function sortModeTitle(mode) {
  if (mode === 'A') return 'Sort: A-Z (click to switch to Z-A)';
  if (mode === 'Z') return 'Sort: Z-A (click to switch to Tag groups)';
  return 'Sort: Tag groups (click to switch to A-Z)';
}
function applyFlatSort(items, mode) {
  const sorted = [...items].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  if (mode === 'Z') sorted.reverse();
  return sorted;
}

/**
 * In 'A' / 'Z' flat view the per-tag-group counts aren't rendered, so the
 * user loses the at-a-glance "how many are there?" signal. Surface it on
 * the section header instead. 'T' mode clears the span (each tag group
 * already shows its own count).
 */
function updateSectionCount(key, count) {
  const span = document.querySelector(`[data-section-count="${key}"]`);
  if (!span) return;
  const mode = sortModes[key];
  span.textContent = mode === 'A' || mode === 'Z' ? ` (${count})` : '';
}

function loadSidebarSearchScope() {
  try {
    const raw = localStorage.getItem(LS_KEYS.SIDEBAR_SEARCH_SCOPE);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        name: parsed.name !== false,
        tags: parsed.tags !== false,
        content: parsed.content !== false,
      };
    }
  } catch (_) {
    // Corrupt LS entry — fall through to the all-on default rather
    // than surfacing a parse error for a UI preference.
  }
  return { name: true, tags: true, content: true };
}

function saveSidebarSearchScope() {
  safeSetItem(LS_KEYS.SIDEBAR_SEARCH_SCOPE, JSON.stringify(sidebarSearchScope));
}

export function setupSectionSortModes() {
  const renderers = {
    snippets: renderSnippets,
    chains: renderChains,
    templates: renderTemplates,
  };
  for (const key of SORTABLE_SECTIONS) {
    const btn = document.getElementById(`${key}-sort-mode`);
    if (!btn) continue;
    const reflect = () => {
      btn.textContent = sortModes[key];
      btn.setAttribute('title', sortModeTitle(sortModes[key]));
    };
    reflect();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = SORT_CYCLE.indexOf(sortModes[key]);
      const next = SORT_CYCLE[(i + 1) % SORT_CYCLE.length];
      sortModes[key] = next;
      safeSetItem(LS_KEYS.sortMode(key), next);
      reflect();
      renderers[key]();
    });
  }
}

export function setupSidebarSearchScope() {
  const scopeButtons = {
    name: $('#sidebar-search-scope-name'),
    tags: $('#sidebar-search-scope-tags'),
    content: $('#sidebar-search-scope-content'),
  };
  const reflect = () => {
    for (const [key, btn] of Object.entries(scopeButtons)) {
      const on = !!sidebarSearchScope[key];
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    }
  };
  reflect();
  const toggle = (key) => {
    sidebarSearchScope[key] = !sidebarSearchScope[key];
    reflect();
    saveSidebarSearchScope();
    // Re-render only when a filter is active — toggles are a no-op visually
    // when the search box is empty, and avoiding the renders keeps any
    // in-progress hover / focus state intact in that common case.
    if (sidebarFilter) {
      renderSnippets();
      renderChains();
      renderTextSnippets();
      renderTemplates();
    }
  };
  for (const key of Object.keys(scopeButtons)) {
    scopeButtons[key].addEventListener('click', () => toggle(key));
  }

  const failingBtn = $('#sidebar-filter-failing');
  const reflectFailing = () => {
    failingBtn.setAttribute('aria-pressed', sidebarFilterFailing ? 'true' : 'false');
    failingBtn.classList.toggle('active', sidebarFilterFailing);
  };
  reflectFailing();
  failingBtn.addEventListener('click', () => {
    sidebarFilterFailing = !sidebarFilterFailing;
    reflectFailing();
    renderSnippets();
    renderChains();
    renderTextSnippets();
    renderTemplates();
  });
}

export function setSidebarFilter(v) {
  sidebarFilter = String(v || '').trim();
  renderSnippets();
  renderChains();
  renderTextSnippets();
  renderTemplates();
  // When the filter is cleared, restore every section's persisted collapsed
  // state — earlier filter renders may have force-expanded sections to
  // surface matches, and we don't want those expansions to stick.
  if (!sidebarFilter) {
    for (const key of ['snippets', 'chains', 'text-snippets', 'templates']) {
      restoreSectionCollapsed(key);
    }
  }
}

/**
 * Force a sidebar section open (without persisting) so a filter match
 * inside it is actually visible. Called by each `renderXxx` after it's
 * decided whether the section has matches under the current filter.
 */
function expandSectionForMatch(key) {
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section[data-section="${key}"]`)
  );
  if (!section || !section.classList.contains('collapsed')) return;
  section.classList.remove('collapsed');
  const head = section.querySelector('.section-head');
  if (head) head.setAttribute('aria-expanded', 'true');
}

/**
 * Re-apply a section's persisted collapsed state — undoes any filter-driven
 * `expandSectionForMatch` once the filter is cleared. Matches the resolution
 * logic in `sidebar.js#setupSectionToggles`: explicit storage wins, falling
 * back to the user's per-section default.
 */
function restoreSectionCollapsed(key) {
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section[data-section="${key}"]`)
  );
  if (!section) return;
  const stored = localStorage.getItem(LS_KEYS.sectionCollapsed(key));
  // `sectionsExpanded` is the affirmative-polarity default map — true =
  // expanded, false = collapsed. Negate to match the local boolean.
  const defaultCollapsed = settings.ui.sectionsExpanded?.[key] === false;
  const collapsed = stored === null ? defaultCollapsed : stored === '1';
  section.classList.toggle('collapsed', collapsed);
  const head = section.querySelector('.section-head');
  if (head) head.setAttribute('aria-expanded', String(!collapsed));
}

/**
 * Minimum query length before we start scanning bodies (program text,
 * template body, text-snippet content). Matching a 1- or 2-character query
 * inside a multi-kilobyte program would surface every snippet that happens
 * to contain "a"; the threshold keeps body search focused on intent.
 * Names and descriptions still match at any length — they're short enough
 * for noise not to be a problem.
 */
const BODY_SEARCH_MIN = 3;

function matchesSidebar(item, extra) {
  if (sidebarFilterFailing) {
    const summary = getCachedSummary(item.id);
    if (!summary || summary.fail === 0) return false;
  }
  if (!sidebarFilter) return true;
  const q = sidebarFilter.toLowerCase();
  if (sidebarSearchScope.name) {
    if ((item.name || '').toLowerCase().includes(q)) return true;
    if (item.description && item.description.toLowerCase().includes(q)) return true;
  }
  if (sidebarSearchScope.tags) {
    if (item.tags && item.tags.some((t) => t.toLowerCase().includes(q))) return true;
  }
  if (sidebarSearchScope.content && q.length >= BODY_SEARCH_MIN) {
    if (item.program && item.program.toLowerCase().includes(q)) return true;
    if (item.body && item.body.toLowerCase().includes(q)) return true;
    if (extra && extra.toLowerCase().includes(q)) return true;
  }
  return false;
}

function toggleFavorite(item) {
  item.favorite = !item.favorite;
  saveState();
}

function sortedSnippets() {
  return [...state.snippets].sort(favoriteThenName);
}
function sortedChains() {
  return [...state.chains].sort(favoriteThenName);
}
function sortedTemplates() {
  return [...state.templates].sort(favoriteThenName);
}
function sortedTextSnippets() {
  return [...state.textSnippets].sort(favoriteThenName);
}

// ---------- snippets ----------
const SNIPPETS_ITEM_HTML = `
  <button class="sidebar-star" data-act="fav" title="Toggle favorite" aria-pressed="false" aria-label="Toggle favorite">★</button>
  <span class="name"></span>
  <span class="shortcut-label muted" hidden></span>
  <span class="test-status" hidden></span>
  <span class="actions">
    <button data-act="pipe" title="Add to pipeline" aria-label="Add to pipeline">→</button>
    <button data-act="dup" title="Duplicate" aria-label="Duplicate">⎘</button>
    <button data-act="edit" title="Edit" aria-label="Edit">✎</button>
    <button data-act="del" title="Delete" aria-label="Delete">✕</button>
  </span>`;

/** One-shot guard: delegated click listener on `#snippets` attached once. */
let snippetsDelegationWired = false;
function wireSnippetsDelegation() {
  if (snippetsDelegationWired) return;
  snippetsDelegationWired = true;
  setupTagDragAndDrop('#snippets', () => state.snippets, renderSnippets);
  $('#snippets').addEventListener('click', async (e) => {
    const li = closestOn(e, 'li[data-id]');
    if (!li) return;
    const sn = state.snippets.find((x) => x.id === li.dataset.id);
    if (!sn) return;
    const act = closestOn(e, 'button')?.dataset?.act;
    if (act === 'fav') {
      toggleFavorite(sn);
      renderSnippets();
    } else if (act === 'pipe') {
      addPipelineStep({ id: uid(), snippetId: sn.id });
    } else if (act === 'dup') {
      const taken = new Set(state.snippets.map((s) => s.name));
      const copy = { id: uid(), name: uniqueName(`${sn.name} copy`, taken), program: sn.program };
      if (sn.params) copy.params = sn.params.map((p) => ({ ...p }));
      if (sn.tags && sn.tags.length) copy.tags = [...sn.tags];
      if (sn.tests && sn.tests.length) {
        copy.tests = sn.tests.map((t) => ({
          ...t,
          id: uid(),
          vars: t.vars ? { ...t.vars } : undefined,
        }));
      }
      state.snippets.push(copy);
      saveState();
      renderSnippets();
      dispatch('library:snippets-changed');
    } else if (act === 'edit') {
      openSnippetDialog(sn);
    } else if (act === 'del') {
      // Snippets can be referenced by chain steps via `snippetId`. If any
      // chains reference this snippet, surface that and offer to inline the
      // step bodies into those chains so they keep working after the
      // snippet itself goes away.
      const usedByChains = state.chains.filter((c) =>
        (c.steps || []).some((st) => st.snippetId === sn.id),
      );
      const usedBy = usedByChains.map((c) => c.name);
      let action;
      if (!usedBy.length) {
        // No chain references — original two-button confirm.
        action = (await appConfirm(`Delete snippet "${sn.name}"?`, {
          title: 'Delete snippet',
          danger: true,
          okLabel: 'Delete',
        }))
          ? 'delete'
          : null;
      } else {
        // Three-way choice. Default focus lands on the safer (Convert)
        // option; "Delete (break chains)" is still a single click away
        // for users who want it.
        const list = usedBy.map((n) => `\u2022 ${n}`).join('\n');
        const message =
          `Delete snippet "${sn.name}"?\n\nUsed by ${usedBy.length} chain${usedBy.length === 1 ? '' : 's'}:\n${list}\n\n` +
          'You can convert those chain steps to inline copies (chains keep working with the same program/parameters embedded), or delete the snippet anyway and let those steps break.';
        action = await appChoose(message, {
          title: 'Delete snippet',
          buttons: [
            { value: 'cancel', label: 'Cancel' },
            { value: 'delete', label: 'Delete (break chains)', danger: true },
            { value: 'inline', label: 'Convert to inline & delete', primary: true, danger: true },
          ],
        });
      }
      if (action === 'inline') {
        // Replace each chain step pointing at this snippet with an inline
        // copy carrying the snippet's program / name / params.
        for (const c of usedByChains) {
          c.steps = c.steps.map((st) => {
            if (st.snippetId !== sn.id) return st;
            /** @type {any} */
            const inlined = { program: sn.program };
            if (sn.name) inlined.name = sn.name;
            if (sn.params) inlined.params = sn.params.map((p) => ({ ...p }));
            return inlined;
          });
        }
      }
      if (action === 'delete' || action === 'inline') {
        state.snippets = state.snippets.filter((x) => x.id !== sn.id);
        saveState();
        renderSnippets();
        renderChains();
        dispatch('library:snippets-changed');
        if (action === 'inline' && usedByChains.length) {
          showToast({
            title: `Inlined snippet into ${usedByChains.length} chain${usedByChains.length === 1 ? '' : 's'}`,
            level: 'info',
            duration: 3000,
          });
        }
      }
    } else {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod) runSnippetAtCursor(sn);
      else runSnippetOnSelection(sn);
    }
  });
}

/** Sentinel keys for the two synthetic groups (Favorites + Untagged). */
const FAVORITES_GROUP = '__favorites';
const UNTAGGED_GROUP = '__untagged';

/**
 * Apply a "drag an item onto a tag group" drop to `item`. `srcGroup` is the
 * group the drag started from (may be a real tag, `__favorites`, or
 * `__untagged`); `tgtGroup` likewise is the group it was dropped on. `mode`
 * controls whether the source tag is also removed.
 *
 * - Dropping onto a real tag: add that tag.
 * - Dropping onto `__untagged`: no tag added; in 'move' mode the source
 *   tag is still removed.
 * - `move` only removes a source tag when the drag started from a real
 *   tag (Favorites / Untagged have no tag to strip).
 *
 * @param {{tags?: string[]}} item
 * @param {string | null} srcGroup
 * @param {string} tgtGroup
 * @param {'add'|'move'} mode
 */
function applyTagDrop(item, srcGroup, tgtGroup, mode) {
  // Dropping onto Untagged strips every tag, regardless of add/move mode.
  // Caller confirms with the user before reaching here.
  if (tgtGroup === UNTAGGED_GROUP) {
    delete item.tags;
    return;
  }
  const current = Array.isArray(item.tags) ? [...item.tags] : [];
  if (!current.includes(tgtGroup)) {
    current.push(tgtGroup);
  }
  const next =
    mode === 'move' && srcGroup && srcGroup !== UNTAGGED_GROUP && srcGroup !== FAVORITES_GROUP
      ? current.filter((t) => t !== srcGroup)
      : current;
  const normalized = normalizeTags(next);
  if (normalized.length) item.tags = normalized;
  else delete item.tags;
}

/**
 * Prompt for a new tag name and add it to every item currently carrying
 * `oldTag`. The original tag is kept — this is a clone, not a rename.
 * Collisions merge harmlessly (already-present target is deduped).
 *
 * @param {'snippets' | 'chains' | 'templates'} kind
 * @param {string} oldTag
 */
async function cloneTag(kind, oldTag) {
  const newRaw = await appPrompt(`Clone tag "${oldTag}" as:`, {
    title: 'Clone tag',
  });
  if (!newRaw) return;
  const next = String(newRaw).trim().toLowerCase();
  if (!next || next === oldTag) return;
  const items =
    kind === 'snippets' ? state.snippets : kind === 'chains' ? state.chains : state.templates;
  let changed = false;
  for (const item of items) {
    if (!item.tags || !item.tags.includes(oldTag)) continue;
    if (item.tags.includes(next)) continue;
    item.tags = normalizeTags([...item.tags, next]);
    changed = true;
  }
  if (!changed) return;
  saveState();
  rerenderSection(kind);
}

/**
 * Prompt the user for a new name for `oldTag` and rename it across every
 * item in the given section. If the target name collides with an existing
 * tag, the two are merged (any item carrying both ends up with one, thanks
 * to normalizeTags dedup). No-op on cancel or empty/unchanged input.
 *
 * @param {'snippets' | 'chains' | 'templates'} kind
 * @param {string} oldTag
 */
async function renameTag(kind, oldTag) {
  const newRaw = await appPrompt(`New name for tag "${oldTag}":`, {
    title: 'Rename tag',
    defaultValue: oldTag,
  });
  if (!newRaw) return;
  const next = String(newRaw).trim().toLowerCase();
  if (!next || next === oldTag) return;
  const items =
    kind === 'snippets' ? state.snippets : kind === 'chains' ? state.chains : state.templates;
  let changed = false;
  for (const item of items) {
    if (!item.tags || !item.tags.includes(oldTag)) continue;
    const merged = item.tags.filter((t) => t !== oldTag);
    if (!merged.includes(next)) merged.push(next);
    const normalized = normalizeTags(merged);
    if (normalized.length) item.tags = normalized;
    else delete item.tags;
    changed = true;
  }
  if (!changed) return;
  saveState();
  rerenderSection(kind);
}

/**
 * Confirm, then strip `tag` from every item in the given section. Items
 * that had only that tag become untagged; the items themselves are left
 * alone.
 *
 * @param {'snippets' | 'chains' | 'templates'} kind
 * @param {string} tag
 */
async function deleteTag(kind, tag) {
  const ok = await appConfirm(
    `Remove tag "${tag}" from every ${kind === 'snippets' ? 'snippet' : kind === 'chains' ? 'chain' : 'template'} that carries it?\n\nThe items stay; only the tag is removed.`,
    { title: 'Delete tag', danger: true, okLabel: 'Delete tag' },
  );
  if (!ok) return;
  const items =
    kind === 'snippets' ? state.snippets : kind === 'chains' ? state.chains : state.templates;
  let changed = false;
  for (const item of items) {
    if (!item.tags || !item.tags.includes(tag)) continue;
    const remaining = item.tags.filter((t) => t !== tag);
    if (remaining.length) item.tags = remaining;
    else delete item.tags;
    changed = true;
  }
  if (!changed) return;
  saveState();
  rerenderSection(kind);
}

function rerenderSection(kind) {
  if (kind === 'snippets') renderSnippets();
  else if (kind === 'chains') renderChains();
  else if (kind === 'templates') renderTemplates();
}

/**
 * Append rename (✎) and delete (✕) buttons to a tag-group `<summary>` for
 * real tags. Favorites and Untagged are synthetic groups with no
 * underlying tag string, so they get no action buttons.
 *
 * @param {HTMLElement} summary
 * @param {{ key: string }} group
 * @param {'snippets' | 'chains' | 'templates'} kind
 */
function appendTagSummaryActions(summary, group, kind) {
  if (group.key === FAVORITES_GROUP || group.key === UNTAGGED_GROUP) return;
  const actions = document.createElement('span');
  actions.className = 'sidebar-tag-actions';
  const clone = document.createElement('button');
  clone.type = 'button';
  clone.className = 'sidebar-tag-action';
  clone.textContent = '⎘';
  clone.title = `Clone tag "${group.key}"`;
  clone.setAttribute('aria-label', `Clone tag ${group.key}`);
  clone.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    cloneTag(kind, group.key);
  });
  actions.appendChild(clone);
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'sidebar-tag-action';
  rename.textContent = '✎';
  rename.title = `Rename tag "${group.key}"`;
  rename.setAttribute('aria-label', `Rename tag ${group.key}`);
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    renameTag(kind, group.key);
  });
  actions.appendChild(rename);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'sidebar-tag-action';
  del.textContent = '✕';
  del.title = `Delete tag "${group.key}"`;
  del.setAttribute('aria-label', `Delete tag ${group.key}`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    deleteTag(kind, group.key);
  });
  actions.appendChild(del);
  summary.appendChild(actions);
}

/**
 * Wire drag-and-drop inside a sidebar list container so the user can drag
 * items between tag groups. A drop re-tags the item per the
 * `ui.dragToTagMode` setting ('add' appends the target tag; 'move' also
 * strips the source tag). Uses event delegation on the container so it
 * survives every re-render without rebinding.
 *
 * @param {string} containerId CSS selector for the list container (e.g. '#snippets')
 * @param {() => Array<{id: string, tags?: string[]}>} getItems returns the source-of-truth array
 * @param {() => void} onChanged re-render callback, run after saveState()
 */
function setupTagDragAndDrop(containerId, getItems, onChanged) {
  const container = /** @type {HTMLElement} */ ($(containerId));
  /** @type {{ id: string, srcGroup: string | null } | null} */
  let dragState = null;

  const clearDropTargets = () => {
    for (const el of container.querySelectorAll('.tag-drop-target')) {
      el.classList.remove('tag-drop-target');
    }
  };

  container.addEventListener('dragstart', (e) => {
    const li = /** @type {HTMLElement | null} */ (
      /** @type {Element} */ (e.target).closest('li[data-id]')
    );
    if (!li || !container.contains(li)) return;
    const group = li.closest('.sidebar-tag-group');
    const srcGroup =
      group && /** @type {HTMLElement} */ (group).dataset.group
        ? /** @type {HTMLElement} */ (group).dataset.group
        : null;
    dragState = { id: li.dataset.id || '', srcGroup };
    li.classList.add('dragging');
    if (e.dataTransfer) {
      const mode = settings.ui.dragToTagMode === 'move' ? 'move' : 'copy';
      e.dataTransfer.effectAllowed = mode;
      // Firefox requires some data to be set or the drag is cancelled.
      e.dataTransfer.setData('text/plain', dragState.id);
    }
  });

  container.addEventListener('dragend', () => {
    if (dragState) {
      const prev = container.querySelector('li.dragging');
      if (prev) prev.classList.remove('dragging');
    }
    clearDropTargets();
    dragState = null;
  });

  container.addEventListener('dragover', (e) => {
    if (!dragState) return;
    const group = /** @type {HTMLElement | null} */ (
      /** @type {Element} */ (e.target).closest('.sidebar-tag-group')
    );
    if (!group) return;
    const tgtGroup = group.dataset.group || '';
    if (tgtGroup === FAVORITES_GROUP) return;
    if (tgtGroup === dragState.srcGroup) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = settings.ui.dragToTagMode === 'move' ? 'move' : 'copy';
    }
    if (!group.classList.contains('tag-drop-target')) {
      clearDropTargets();
      group.classList.add('tag-drop-target');
    }
  });

  container.addEventListener('drop', async (e) => {
    if (!dragState) return;
    const group = /** @type {HTMLElement | null} */ (
      /** @type {Element} */ (e.target).closest('.sidebar-tag-group')
    );
    if (!group) return;
    const tgtGroup = group.dataset.group || '';
    if (tgtGroup === FAVORITES_GROUP) return;
    if (tgtGroup === dragState.srcGroup) return;
    e.preventDefault();
    // Capture drag data synchronously — `dragend` fires between `drop` and
    // any `await` below, clearing `dragState` before the async step resumes.
    const item = getItems().find((x) => x.id === dragState.id);
    if (!item) return;
    const srcGroup = dragState.srcGroup;
    const mode = settings.ui.dragToTagMode === 'move' ? 'move' : 'add';

    if (tgtGroup === UNTAGGED_GROUP) {
      if (!item.tags || !item.tags.length) return;
      const label = /** @type {any} */ (item).name || 'this item';
      const tagCount = item.tags.length;
      const srcIsRealTag =
        !!srcGroup && srcGroup !== FAVORITES_GROUP && srcGroup !== UNTAGGED_GROUP;
      // If the source tag is the only tag on the item, "remove just src"
      // and "remove all" collapse to the same action — ask once.
      const srcIsOnlyTag = srcIsRealTag && tagCount === 1 && item.tags[0] === srcGroup;
      let untaggedChoice; // 'one' | 'all'
      if (!srcIsRealTag || srcIsOnlyTag) {
        const ok = await appConfirm(
          srcIsOnlyTag
            ? `Remove tag "${srcGroup}" from "${label}"?`
            : `Remove all ${tagCount} tag${tagCount === 1 ? '' : 's'} from "${label}"?`,
          {
            title: srcIsOnlyTag ? 'Remove tag' : 'Remove all tags',
            danger: true,
            okLabel: srcIsOnlyTag ? 'Remove tag' : 'Remove all tags',
          },
        );
        if (!ok) return;
        untaggedChoice = 'all';
      } else {
        const choice = await appChoose(
          `Drop "${label}" onto Untagged — remove just the "${srcGroup}" tag, or every tag (${tagCount})?`,
          {
            title: 'Remove tags',
            buttons: [
              { value: 'cancel', label: 'Cancel' },
              { value: 'one', label: `Remove "${srcGroup}"`, danger: true },
              { value: 'all', label: `Remove all ${tagCount} tags`, danger: true, primary: true },
            ],
          },
        );
        if (choice !== 'one' && choice !== 'all') return;
        untaggedChoice = choice;
      }
      if (untaggedChoice === 'one') {
        const remaining = item.tags.filter((t) => t !== srcGroup);
        if (remaining.length) item.tags = remaining;
        else delete item.tags;
      } else {
        delete item.tags;
      }
    } else {
      applyTagDrop(item, srcGroup, tgtGroup, mode);
    }
    saveState();
    onChanged();
  });
}

/**
 * When true, tag-group `<details>` toggle handlers skip persistence. Used
 * for transient bulk-opens (test-failure expansion) so the user's saved
 * collapsed preference isn't clobbered. Reset on the next tick.
 */
let suppressTagToggleSave = false;

/**
 * Build the ordered list of groups to render in the sidebar:
 *   1. Favorites (only if any favorites exist) — every favorited snippet
 *      regardless of tag, so the user's pinned items stay one click away.
 *   2. Each tag, alphabetical.
 *   3. Untagged (only if any snippet has no tags).
 *
 * A multi-tagged snippet appears under every tag it has — that's the point
 * of grouping; otherwise users have to remember which single bucket they
 * filed something under.
 *
 * @param {any[]} snippets already-sidebar-filtered list
 */
function buildSnippetGroups(snippets) {
  /** @type {{ key: string, label: string, items: any[] }[]} */
  const groups = [];
  const favs = snippets.filter((s) => s.favorite);
  if (favs.length) {
    groups.push({ key: FAVORITES_GROUP, label: 'Favorites', items: favs });
  }
  // Walk the canonical tag list (rather than re-deriving from `snippets`)
  // so the section order is stable across filter changes.
  for (const tag of allSnippetTags()) {
    const items = snippets.filter((s) => (s.tags || []).includes(tag));
    if (items.length) groups.push({ key: tag, label: tag, items });
  }
  // Always show Untagged (even when empty) so the user has a drag target
  // for stripping tags off an item.
  const untagged = snippets.filter((s) => !s.tags || !s.tags.length);
  groups.push({ key: UNTAGGED_GROUP, label: 'Untagged', items: untagged });
  return groups;
}

/**
 * Show / hide the Snippets-section header buttons:
 *   - Expand-all / collapse-all only matter when there are tag groups
 *   - Run-all-tests only matters when at least one snippet has tests
 *
 * The two visibility decisions are independent; passing `null` for
 * `hasGroups` means "leave the group buttons alone" (used by the
 * tests:run event handler).
 */
function setSnippetsBulkButtonsVisibility(hasGroups) {
  if (hasGroups !== null) {
    const bulk = document.getElementById('snippets-bulk-groups');
    if (bulk) bulk.hidden = !hasGroups;
  }
  const runAll = document.getElementById('snippets-run-all-tests');
  if (runAll) {
    const anyTests = state.snippets.some((s) => s.tests && s.tests.length);
    runAll.hidden = !(anyTests && settings.ui.showRunAllTests);
  }
}

export function renderSnippets() {
  wireSnippetsDelegation();
  const ul = $('#snippets');
  if (!state.snippets.length) {
    setSnippetsBulkButtonsVisibility(false);
    showListPlaceholder(ul, '(no snippets yet)');
    updateSectionCount('snippets', 0);
    return;
  }
  const visible = sortedSnippets().filter((sn) => matchesSidebar(sn));
  updateSectionCount('snippets', visible.length);
  if (!visible.length) {
    setSnippetsBulkButtonsVisibility(false);
    showListPlaceholder(ul, '(no matches)');
    return;
  }
  // Filter is active: ensure the user can see the matches even if the
  // section header was previously collapsed.
  if (sidebarFilter) expandSectionForMatch('snippets');
  if (sortModes.snippets !== 'T') {
    setSnippetsBulkButtonsVisibility(false);
    ul.replaceChildren();
    const flat = applyFlatSort(visible, sortModes.snippets);
    for (const sn of flat) ul.appendChild(buildSnippetLi(sn));
    return;
  }
  const groups = buildSnippetGroups(visible);
  setSnippetsBulkButtonsVisibility(groups.length > 1);
  ul.replaceChildren();
  const filtering = !!sidebarFilter;
  for (const [i, g] of groups.entries()) {
    const details = document.createElement('details');
    details.className = 'sidebar-tag-group';
    details.setAttribute('role', 'group');
    details.setAttribute('aria-label', g.label);
    details.dataset.group = g.key;
    const collapsedKey = LS_KEYS.tagSectionCollapsed(g.key);
    // Filter mode: force every group open so matches are visible. Skip the
    // persistence listener too, so a user collapsing a group while a filter
    // is active doesn't overwrite their pre-filter preference.
    if (filtering) {
      details.open = true;
    } else {
      // No saved preference → only the first group is open, to keep the
      // sidebar approachable on first visit. Saved '1' = collapsed, '0' = open.
      const saved = localStorage.getItem(collapsedKey);
      details.open = saved === null ? i === 0 : saved !== '1';
      details.addEventListener('toggle', () => {
        // `suppressTagToggleSave` is set when we open groups for transient
        // reasons (e.g. surfacing test failures). Without this, the
        // programmatic open would overwrite the user's saved preference.
        if (suppressTagToggleSave) return;
        safeSetItem(collapsedKey, details.open ? '0' : '1');
      });
    }
    const summary = document.createElement('summary');
    summary.className = 'sidebar-tag-summary';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'sidebar-tag-label';
    labelSpan.textContent = g.label;
    summary.appendChild(labelSpan);
    const count = document.createElement('span');
    count.className = 'sidebar-tag-count muted';
    count.textContent = String(g.items.length);
    summary.appendChild(count);
    appendTagSummaryActions(summary, g, 'snippets');
    details.appendChild(summary);
    const inner = document.createElement('ul');
    inner.className = 'sidebar-tag-list';
    inner.setAttribute('role', 'list');
    for (const sn of g.items) inner.appendChild(buildSnippetLi(sn));
    details.appendChild(inner);
    ul.appendChild(details);
  }
}

function buildSnippetLi(sn) {
  const li = document.createElement('li');
  li.dataset.id = sn.id;
  li.draggable = true;
  li.innerHTML = SNIPPETS_ITEM_HTML;
  const star = li.querySelector('.sidebar-star');
  star.classList.toggle('active', !!sn.favorite);
  star.setAttribute('aria-pressed', sn.favorite ? 'true' : 'false');
  li.querySelector('.name').textContent = sn.name;
  li.title = sn.description || sn.program;
  applyShortcutLabel(li, sn);
  applyTestStatusToRow(li, sn);
  return li;
}

function applyShortcutLabel(li, item) {
  const el = li.querySelector('.shortcut-label');
  if (!el) return;
  const parts = [];
  if (item.shortcut) parts.push(formatShortcut(item.shortcut));
  if (item.shortcutInsert) parts.push(`${formatShortcut(item.shortcutInsert)}*`);
  if (parts.length) {
    el.textContent = `[${parts.join(' / ')}]`;
    el.title = item.shortcutInsert
      ? 'Second combo with * inserts output at cursor (no input)'
      : 'Runs on current selection';
    el.hidden = false;
  } else {
    el.textContent = '';
    el.removeAttribute('title');
    el.hidden = true;
  }
}

/**
 * Paint the test status dot on a snippet row. Three states:
 *   - hidden when the snippet has no tests at all (or when tests exist but
 *     haven't been run this session and settings.tests.showUnknownStatus is off),
 *   - "?" (grey) when tests exist but no cached run this session and the
 *     setting is on,
 *   - "✓"/"✗" (green/red) reflecting the cached summary.
 *
 * Hover tooltip carries the breakdown so the user doesn't have to open
 * the dialog to see "3/4 passing."
 */
function applyTestStatusToRow(li, sn) {
  const dot = li.querySelector('.test-status');
  if (!dot) return;
  if (!sn.tests || !sn.tests.length) {
    dot.hidden = true;
    dot.className = 'test-status';
    dot.textContent = '';
    dot.removeAttribute('title');
    return;
  }
  const summary = getCachedSummary(sn.id);
  if (!summary) {
    if (!settings.tests?.showUnknownStatus) {
      dot.hidden = true;
      dot.className = 'test-status';
      dot.textContent = '';
      dot.removeAttribute('title');
      return;
    }
    dot.hidden = false;
    dot.className = 'test-status status-unknown';
    dot.textContent = '?';
    dot.title = `${sn.tests.length} test${sn.tests.length === 1 ? '' : 's'} (not run this session)`;
  } else if (summary.fail === 0) {
    dot.hidden = false;
    dot.className = 'test-status status-pass';
    dot.textContent = '✓';
    dot.title = `All ${summary.total} test${summary.total === 1 ? '' : 's'} passing`;
  } else {
    dot.hidden = false;
    dot.className = 'test-status status-fail';
    dot.textContent = '✗';
    dot.title = `${summary.fail} of ${summary.total} test${summary.total === 1 ? '' : 's'} failing`;
  }
}

/**
 * Refresh just the status dots on already-rendered rows, without rebuilding
 * the whole sidebar. Bound to the `tests:run` / `tests:run-all` events so
 * dialog or "Run all tests" results show up immediately.
 */
export function refreshSnippetTestStatusDots() {
  const lis = /** @type {NodeListOf<HTMLLIElement>} */ (
    document.querySelectorAll('#snippets li[data-id]')
  );
  for (const li of lis) {
    const sn = state.snippets.find((s) => s.id === li.dataset.id);
    if (sn) applyTestStatusToRow(li, sn);
  }
  setSnippetsBulkButtonsVisibility(null); // leave groups alone, refresh Run-all
}

/**
 * Make a single snippet row visible in the sidebar without changing the
 * user's saved collapsed-state preferences:
 *   - opens the Snippets section header if collapsed
 *   - opens any tag-group `<details>` ancestors that are collapsed
 *   - scrolls the row into view
 *
 * Multi-tagged snippets render once per tag group; we open every ancestor
 * so the user sees at least one row immediately. Persistence is suppressed
 * via the same flag the bulk-expansion path uses.
 *
 * @param {string} snippetId
 */
export function revealSnippetInSidebar(snippetId) {
  expandSectionForMatch('snippets');
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(snippetId) : snippetId;
  const rows = /** @type {NodeListOf<HTMLLIElement>} */ (
    document.querySelectorAll(`#snippets li[data-id="${safeId}"]`)
  );
  if (!rows.length) return;
  suppressTagToggleSave = true;
  for (const row of rows) {
    let el = row.parentElement;
    while (el && el.id !== 'snippets') {
      if (el.tagName === 'DETAILS') {
        const det = /** @type {HTMLDetailsElement} */ (el);
        if (!det.open) det.open = true;
      }
      el = el.parentElement;
    }
  }
  queueMicrotask(() => {
    suppressTagToggleSave = false;
  });
  rows[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Resolve a snippet's variables. Honors the global
 * `acceptDefaultsWithoutPrompting` setting exactly like chain runs: on →
 * declared defaults are taken silently, prompt only for params with no
 * default; off → every param is prompted, prefilled from its default.
 * @param {any} sn
 * @returns {Promise<Record<string,string> | null>} null on cancel.
 */
async function ensureSnippetVars(sn) {
  const params = sn.params || [];
  if (!params.length) return {};
  const accept = !!settings.pipeline.acceptDefaultsWithoutPrompting;
  /** @type {Record<string,string>} */
  const resolved = {};
  /** @type {import('./types.js').Param[]} */
  const needsPrompting = [];
  /** @type {Record<string,string>} */
  const initialValues = {};
  for (const p of params) {
    initialValues[p.name] = p.default ?? '';
    if (accept && p.default !== undefined && p.default !== '') {
      resolved[p.name] = p.default;
    } else {
      needsPrompting.push(p);
    }
  }
  // Accept mode with nothing left to prompt → silently use the defaults,
  // matching the setting's name. Otherwise always open the dialog: in
  // accept mode the resolved rows are hidden behind a "Show all" toggle
  // so the user can still review / override them.
  if (accept && !needsPrompting.length) return resolved;
  const hidden = accept ? new Set(Object.keys(resolved)) : new Set();
  const values = await promptForVars(params, initialValues, {
    hidden,
    saveAsChainSnippet: sn,
  });
  if (values === null) return null;
  return { ...resolved, ...values };
}

export async function runSnippetOnSelection(sn) {
  // Snapshot input source BEFORE any await. The vars prompt and the
  // runAwk round-trip both shift focus away from the textarea; focus
  // loss can collapse the selection, so `resolveInput()` must be
  // captured up front. The resolver's sink carries the {s,e} snapshot
  // for selection writes and handles multi-file (All Tabs) gathering
  // in one shot.
  const src = resolveInput();
  const vars = await ensureSnippetVars(sn);
  if (vars === null) return;
  const { stdout, stderr } =
    src.kind === 'multi'
      ? await runAwkMulti(sn.program, src.inputs, vars)
      : await runAwk(sn.program, src.input, vars);
  if (stderr) {
    showToast({ title: `awk error in "${sn.name}"`, body: stderr });
    pulseSidebarRow('snippets', sn.id);
    return;
  }
  writeOutput(src.sink, stdout, {
    title:
      src.source.kind === 'allTabs'
        ? `Results: ${sn.name} × ${src.source.count} tabs`
        : `Results: ${sn.name}`,
  });
}

export async function runSnippetAtCursor(sn) {
  // Snapshot the cursor/selection BEFORE any await. The vars prompt and
  // runAwk round-trip both shift focus away from the editor; when we come
  // back, the textarea's selectionStart may have collapsed to 0 (which would
  // drop the insert at the top of the file) or been lost entirely. Recording
  // {s, e} up front and writing through editTextRange keeps the insert on
  // the position the user was at when they fired the shortcut.
  const { s, e } = getSel();
  const vars = await ensureSnippetVars(sn);
  if (vars === null) return;
  // Empty input = zero records, so main-block actions don't fire.
  // Snippets intended for insert-at-cursor should generate output from a
  // BEGIN block; `{ ... }` patterns only run when there's a record to
  // match, which is correct awk semantics.
  const { stdout, stderr } = await runAwk(sn.program, '', vars);
  if (stderr) {
    showToast({ title: `awk error in "${sn.name}"`, body: stderr });
    pulseSidebarRow('snippets', sn.id);
    return;
  }
  const ed = /** @type {HTMLTextAreaElement} */ ($('#editor'));
  editTextRange(ed, s, e, normalizeAwkOutput(stdout));
}

// ---------- chains ----------
const CHAINS_ITEM_HTML = `
  <button class="sidebar-star" data-act="fav" title="Toggle favorite" aria-pressed="false" aria-label="Toggle favorite">★</button>
  <span class="name"></span>
  <span class="shortcut-label muted" hidden></span>
  <span class="test-status" hidden></span>
  <span class="actions">
    <button data-act="append" title="Append to pipeline" aria-label="Append to pipeline">→</button>
    <button data-act="load" title="Load into pipeline (replace)" aria-label="Load into pipeline">↓</button>
    <button data-act="dup" title="Duplicate" aria-label="Duplicate">⎘</button>
    <button data-act="edit" title="Edit" aria-label="Edit">✎</button>
    <button data-act="del" title="Delete" aria-label="Delete">✕</button>
  </span>`;

/** One-shot guard: delegated click listener on `#chains` attached once. */
let chainsDelegationWired = false;
function wireChainsDelegation() {
  if (chainsDelegationWired) return;
  chainsDelegationWired = true;
  setupTagDragAndDrop('#chains', () => state.chains, renderChains);
  $('#chains').addEventListener('click', async (e) => {
    const li = closestOn(e, 'li[data-id]');
    if (!li) return;
    const c = state.chains.find((x) => x.id === li.dataset.id);
    if (!c) return;
    const act = closestOn(e, 'button')?.dataset?.act;
    if (act === 'fav') {
      toggleFavorite(c);
      renderChains();
    } else if (act === 'load') {
      loadChainIntoPipeline(c);
    } else if (act === 'append') {
      appendChainToPipeline(c);
    } else if (act === 'dup') {
      cloneChain(c);
      renderChains();
    } else if (act === 'edit') {
      openChainDialog(c);
    } else if (act === 'del') {
      if (
        await appConfirm(`Delete chain "${c.name}"?`, {
          title: 'Delete chain',
          danger: true,
          okLabel: 'Delete',
        })
      ) {
        state.chains = state.chains.filter((x) => x.id !== c.id);
        saveState();
        renderChains();
      }
    } else {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod) runChainAtCursor(c);
      else runChainOnSelection(c);
    }
  });
}

/**
 * Build the ordered list of groups to render in the chains sidebar:
 *   1. Favorites (only if any favorites exist)
 *   2. Each tag, alphabetical
 *   3. Untagged (only if any chain has no tags)
 * Mirrors buildSnippetGroups.
 * @param {any[]} chains already-sidebar-filtered list
 */
function buildChainGroups(chains) {
  /** @type {{ key: string, label: string, items: any[] }[]} */
  const groups = [];
  const favs = chains.filter((c) => c.favorite);
  if (favs.length) {
    groups.push({ key: FAVORITES_GROUP, label: 'Favorites', items: favs });
  }
  for (const tag of allChainTags()) {
    const items = chains.filter((c) => (c.tags || []).includes(tag));
    if (items.length) groups.push({ key: tag, label: tag, items });
  }
  const untagged = chains.filter((c) => !c.tags || !c.tags.length);
  groups.push({ key: UNTAGGED_GROUP, label: 'Untagged', items: untagged });
  return groups;
}

function buildChainLi(c) {
  const li = document.createElement('li');
  li.dataset.id = c.id;
  li.draggable = true;
  li.innerHTML = CHAINS_ITEM_HTML;
  const star = li.querySelector('.sidebar-star');
  star.classList.toggle('active', !!c.favorite);
  star.setAttribute('aria-pressed', c.favorite ? 'true' : 'false');
  li.querySelector('.name').textContent = c.name;
  li.title = c.description || c.steps.map(stepLabel).join(' → ');
  applyShortcutLabel(li, c);
  applyTestStatusToRow(li, c);
  return li;
}

function setChainsBulkButtonsVisibility(hasGroups) {
  if (hasGroups !== null) {
    const bulk = document.getElementById('chains-bulk-groups');
    if (bulk) bulk.hidden = !hasGroups;
  }
  const runAll = document.getElementById('chains-run-all-tests');
  if (runAll) {
    const anyTests = state.chains.some((c) => c.tests && c.tests.length);
    runAll.hidden = !(anyTests && settings.ui.showRunAllTests);
  }
}

export function renderChains() {
  wireChainsDelegation();
  const container = $('#chains');
  if (!state.chains.length) {
    setChainsBulkButtonsVisibility(false);
    showListPlaceholder(container, '(no chains yet)');
    updateSectionCount('chains', 0);
    return;
  }
  const visible = sortedChains().filter((c) => matchesSidebar(c));
  updateSectionCount('chains', visible.length);
  if (!visible.length) {
    setChainsBulkButtonsVisibility(false);
    showListPlaceholder(container, '(no matches)');
    return;
  }
  if (sidebarFilter) expandSectionForMatch('chains');
  if (sortModes.chains !== 'T') {
    setChainsBulkButtonsVisibility(false);
    container.replaceChildren();
    const flat = applyFlatSort(visible, sortModes.chains);
    for (const c of flat) container.appendChild(buildChainLi(c));
    return;
  }
  const groups = buildChainGroups(visible);
  setChainsBulkButtonsVisibility(groups.length > 1);
  container.replaceChildren();
  const filtering = !!sidebarFilter;
  for (const [i, g] of groups.entries()) {
    const details = document.createElement('details');
    details.className = 'sidebar-tag-group';
    details.setAttribute('role', 'group');
    details.setAttribute('aria-label', g.label);
    details.dataset.group = g.key;
    const collapsedKey = LS_KEYS.tagSectionCollapsed('chain:' + g.key);
    if (filtering) {
      details.open = true;
    } else {
      const saved = localStorage.getItem(collapsedKey);
      details.open = saved === null ? i === 0 : saved !== '1';
      details.addEventListener('toggle', () => {
        if (suppressTagToggleSave) return;
        safeSetItem(collapsedKey, details.open ? '0' : '1');
      });
    }
    const summary = document.createElement('summary');
    summary.className = 'sidebar-tag-summary';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'sidebar-tag-label';
    labelSpan.textContent = g.label;
    summary.appendChild(labelSpan);
    const count = document.createElement('span');
    count.className = 'sidebar-tag-count muted';
    count.textContent = String(g.items.length);
    summary.appendChild(count);
    appendTagSummaryActions(summary, g, 'chains');
    details.appendChild(summary);
    const inner = document.createElement('ul');
    inner.className = 'sidebar-tag-list';
    inner.setAttribute('role', 'list');
    for (const c of g.items) inner.appendChild(buildChainLi(c));
    details.appendChild(inner);
    container.appendChild(details);
  }
}

export function refreshChainTestStatusDots() {
  const lis = /** @type {NodeListOf<HTMLLIElement>} */ (
    document.querySelectorAll('#chains li[data-id]')
  );
  for (const li of lis) {
    const c = state.chains.find((x) => x.id === li.dataset.id);
    if (c) applyTestStatusToRow(li, c);
  }
  const runAllBtn = document.getElementById('chains-run-all-tests');
  if (runAllBtn) runAllBtn.hidden = !state.chains.some((ch) => ch.tests && ch.tests.length);
}

export function revealChainInSidebar(chainId) {
  expandSectionForMatch('chains');
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(chainId) : chainId;
  const row = /** @type {HTMLLIElement | null} */ (
    document.querySelector(`#chains li[data-id="${safeId}"]`)
  );
  if (!row) return;
  // Open any collapsed tag-group <details> ancestors so the row is
  // actually visible. Suppress persistence — the user's saved
  // collapsed preference for this group should survive a transient reveal.
  suppressTagToggleSave = true;
  let el = row.parentElement;
  while (el && el.id !== 'chains') {
    if (el.tagName === 'DETAILS') {
      const det = /** @type {HTMLDetailsElement} */ (el);
      if (!det.open) det.open = true;
    }
    el = el.parentElement;
  }
  queueMicrotask(() => {
    suppressTagToggleSave = false;
  });
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Compute a per-step var resolver for a chain run, prompting for any
 * names that aren't already pinned by chain-level or per-step overrides.
 * Returns `null` on user cancel.
 *
 * The returned function takes a step and returns the `Record<name,
 * string>` to pass into `runAwk` for that step — merging step defaults,
 * chain-global vars, per-step overrides, and the user's prompt answers
 * (chain-level prompt values apply to every using step; per-step prompt
 * values apply only to their step).
 *
 * @param {any} chain
 * @returns {Promise<((step: any) => Record<string, string>) | null>}
 */
async function ensureChainVars(chain) {
  const accept = !!settings.pipeline.acceptDefaultsWithoutPrompting;
  const plan = planChainVarsPrompt(chain, accept);
  if (!plan.needsPrompting) {
    return (step) => resolveStepVars(chain, step);
  }
  // Build a flat param list from the plan rows — the row key doubles
  // as the param name so `promptForVars` returns values keyed by it.
  // `displayLabel` surfaces per-step rows as "cmd · Step 2: …".
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

export async function runChainOnSelection(chain) {
  // Snapshot before await — see `runSnippetOnSelection` for the
  // rationale. Chains are at-risk because they may prompt for vars
  // AND round-trip through multiple awk runs; any intervening
  // focus-shift would collapse the textarea's selection.
  //
  // Multi-file (All Tabs) only applies to step 1: it gets real
  // per-file FILENAME / FNR semantics. After step 1 the stream is
  // one contiguous string, so steps 2..N run single-input over it.
  const src = resolveInput();
  const getVars = await ensureChainVars(chain);
  if (getVars === null) return;
  let cur = src.kind === 'single' ? src.input : '';
  let firstStep = true;
  for (const step of chain.steps) {
    if (step.disabled) continue;
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    if (step.snippetId && !sn) {
      showToast({ title: `Missing snippet in chain "${chain.name}"` });
      pulseSidebarRow('chains', chain.id);
      return;
    }
    const prog = sn ? sn.program : step.program || '';
    const label = stepLabel(step);
    const vars = getVars(step);
    const { stdout, stderr } =
      firstStep && src.kind === 'multi'
        ? await runAwkMulti(prog, src.inputs, vars)
        : await runAwk(prog, cur, vars);
    if (stderr) {
      showToast({ title: `Error in chain "${chain.name}" step "${label}"`, body: stderr });
      pulseSidebarRow('chains', chain.id);
      return;
    }
    cur = stdout;
    firstStep = false;
  }
  writeOutput(src.sink, cur, {
    title:
      src.source.kind === 'allTabs'
        ? `Results: ${chain.name} × ${src.source.count} tabs`
        : `Results: ${chain.name}`,
  });
}

export async function runChainAtCursor(chain) {
  const getVars = await ensureChainVars(chain);
  if (getVars === null) return;
  let cur = '';
  for (const step of chain.steps) {
    if (step.disabled) continue;
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    if (step.snippetId && !sn) {
      showToast({ title: `Missing snippet in chain "${chain.name}"` });
      pulseSidebarRow('chains', chain.id);
      return;
    }
    const prog = sn ? sn.program : step.program || '';
    const label = stepLabel(step);
    const vars = getVars(step);
    const { stdout, stderr } = await runAwk(prog, cur, vars);
    if (stderr) {
      showToast({ title: `Error in chain "${chain.name}" step "${label}"`, body: stderr });
      pulseSidebarRow('chains', chain.id);
      return;
    }
    cur = stdout;
  }
  insertAtEditorCursor(normalizeAwkOutput(cur));
}

// ---------- text snippets ----------
const TEXT_SNIPPETS_ITEM_HTML = `
  <button class="sidebar-star" data-act="fav" title="Toggle favorite" aria-pressed="false" aria-label="Toggle favorite">★</button>
  <span class="name"></span>
  <span class="actions">
    <button data-act="insert" title="Insert at cursor" aria-label="Insert at cursor">↵</button>
    <button data-act="save-over" title="Overwrite with current editor content" aria-label="Overwrite with current editor content">⟳</button>
    <button data-act="rename" title="Rename" aria-label="Rename">✎</button>
    <button data-act="del" title="Delete" aria-label="Delete">✕</button>
  </span>`;

/** One-shot guard: delegated click listener on `#text-snippets` attached once. */
let textSnippetsDelegationWired = false;
function wireTextSnippetsDelegation() {
  if (textSnippetsDelegationWired) return;
  textSnippetsDelegationWired = true;
  $('#text-snippets').addEventListener('click', async (e) => {
    const li = closestOn(e, 'li[data-id]');
    if (!li) return;
    const t = state.textSnippets.find((x) => x.id === li.dataset.id);
    if (!t) return;
    const act = closestOn(e, 'button')?.dataset?.act;
    if (act === 'fav') {
      toggleFavorite(t);
      renderTextSnippets();
    } else if (act === 'insert') {
      insertTextSnippetAtCursor(t);
    } else if (act === 'rename') {
      const name = await appPrompt('New name:', {
        title: 'Rename text snippet',
        defaultValue: t.name,
      });
      if (name && name.trim()) {
        t.name = name.trim();
        saveState();
        renderTextSnippets();
      }
    } else if (act === 'save-over') {
      if (
        await appConfirm(`Replace the saved content of "${t.name}" with current editor content?`, {
          title: 'Overwrite text snippet',
          okLabel: 'Overwrite',
        })
      ) {
        t.content = $('#editor').value;
        saveState();
        renderTextSnippets();
        // Snippet content changed — any tab linked via `sourceSnippetId`
        // needs its dirty-dot re-evaluated. The editor listens for this.
        dispatch('library:text-snippets-changed');
      }
    } else if (act === 'del') {
      if (
        await appConfirm(`Delete text snippet "${t.name}"?`, {
          title: 'Delete text snippet',
          danger: true,
          okLabel: 'Delete',
        })
      ) {
        state.textSnippets = state.textSnippets.filter((x) => x.id !== t.id);
        saveState();
        renderTextSnippets();
        // Orphaned `sourceSnippetId` links on tabs should stop showing
        // the dirty dot.
        dispatch('library:text-snippets-changed');
      }
    } else {
      openTextSnippetInNewTab(t);
    }
  });
}

export function renderTextSnippets() {
  wireTextSnippetsDelegation();
  const ul = $('#text-snippets');
  if (!state.textSnippets.length) {
    showListPlaceholder(ul, '(none yet — click + to save editor content)');
    return;
  }
  const visibleTexts = sortedTextSnippets().filter((t) => matchesSidebar(t, t.content));
  if (!visibleTexts.length) {
    showListPlaceholder(ul, '(no matches)');
    return;
  }
  if (sidebarFilter) expandSectionForMatch('text-snippets');
  reconcileKeyedList(
    ul,
    visibleTexts,
    () => {
      const li = document.createElement('li');
      li.innerHTML = TEXT_SNIPPETS_ITEM_HTML;
      return li;
    },
    (li, t) => {
      const star = li.querySelector('.sidebar-star');
      star.classList.toggle('active', !!t.favorite);
      star.setAttribute('aria-pressed', t.favorite ? 'true' : 'false');
      li.querySelector('.name').textContent = t.name;
      const lines = t.content.split('\n');
      const preview = lines.slice(0, 3).join('\n');
      li.title = preview + (lines.length > 3 ? '\n…' : '');
    },
  );
}

function openTextSnippetInNewTab(t) {
  const cur = activeTab();
  if (cur) cur.content = $('#editor').value;
  // Pristine-scratch replacement: if the strip is just a lone unused
  // `Tab N`, drop it so the snippet we're opening doesn't stack
  // beside an empty placeholder the user never touched. See
  // editor.js > isScratchInitialTab for the exact predicate; here we
  // only need the cleanup. Leaves `activeTabId` dangling for a moment
  // — repaired by the push below.
  if (isScratchInitialTab()) state.tabs = [];
  // `sourceSnippetId` lets the editor show a dirty dot when the tab's
  // content later diverges from this snippet. The link survives snippet
  // renames (keyed by id) and fails soft on deletion (isTabDirty returns
  // false for orphan ids).
  const nt = { id: uid(), title: t.name, content: t.content, sourceSnippetId: t.id };
  state.tabs.push(nt);
  state.activeTabId = nt.id;
  $('#editor').value = t.content;
  $('#editor').selectionStart = $('#editor').selectionEnd = 0;
  refreshEditorOverlay();
  $('#editor').focus();
  saveState();
  renderTabs();
}

function insertTextSnippetAtCursor(t) {
  const ed = $('#editor');
  editText(ed, t.content);
  const tab = activeTab();
  if (tab) tab.content = ed.value;
  saveState();
}

export async function newTextSnippetFromEditor() {
  const content = $('#editor').value;
  if (!content) {
    appAlert('Editor is empty — nothing to save.');
    return;
  }
  // If the active tab has been renamed (i.e. its title no longer looks
  // like the default `Tab N` produced by the "+" tab button) prefill the
  // snippet name with it — saves the user re-typing the name they've
  // already picked for the tab. Default-named tabs fall through to an
  // empty prompt so the user has to name the snippet deliberately.
  const tab = activeTab();
  const defaultValue = tab && !/^Tab \d+$/.test(tab.title) ? tab.title : '';
  const name = await appPrompt('Text snippet name:', {
    title: 'New text snippet',
    defaultValue,
  });
  if (!name || !name.trim()) return;
  if (state.textSnippets.some((t) => t.name === name.trim())) {
    appAlert(
      `A text snippet named "${name.trim()}" already exists. Pick a different name or use ⟳ to overwrite.`,
      { title: 'Name in use', level: 'error' },
    );
    return;
  }
  state.textSnippets.push({ id: uid(), name: name.trim(), content });
  saveState();
  renderTextSnippets();
  dispatch('library:text-snippets-changed');
}

// ---------- templates ----------
const TEMPLATES_ITEM_HTML = `
  <button class="sidebar-star" data-act="fav" title="Toggle favorite" aria-pressed="false" aria-label="Toggle favorite">★</button>
  <span class="name"></span>
  <span class="actions">
    <button data-act="dup" title="Duplicate" aria-label="Duplicate">⎘</button>
    <button data-act="edit" title="Edit" aria-label="Edit">✎</button>
    <button data-act="del" title="Delete" aria-label="Delete">✕</button>
  </span>`;

/** One-shot guard: delegated click listener on `#templates` attached once. */
let templatesDelegationWired = false;
function wireTemplatesDelegation() {
  if (templatesDelegationWired) return;
  templatesDelegationWired = true;
  setupTagDragAndDrop('#templates', () => state.templates, renderTemplates);
  $('#templates').addEventListener('click', async (e) => {
    const li = closestOn(e, 'li[data-id]');
    if (!li) return;
    const t = state.templates.find((x) => x.id === li.dataset.id);
    if (!t) return;
    const act = closestOn(e, 'button')?.dataset?.act;
    if (act === 'fav') {
      toggleFavorite(t);
      renderTemplates();
    } else if (act === 'dup') {
      const taken = new Set(state.templates.map((x) => x.name));
      const copy = { id: uid(), name: uniqueName(`${t.name} copy`, taken), body: t.body };
      if (t.description) copy.description = t.description;
      if (t.tags && t.tags.length) copy.tags = [...t.tags];
      state.templates.push(copy);
      saveState();
      renderTemplates();
    } else if (act === 'del') {
      if (
        await appConfirm(`Delete template "${t.name}"?`, {
          title: 'Delete template',
          danger: true,
          okLabel: 'Delete',
        })
      ) {
        state.templates = state.templates.filter((x) => x.id !== t.id);
        saveState();
        renderTemplates();
      }
    } else {
      openTemplateDialog(t);
    }
  });
}

function buildTemplateGroups(templates) {
  /** @type {{ key: string, label: string, items: any[] }[]} */
  const groups = [];
  const favs = templates.filter((t) => t.favorite);
  if (favs.length) {
    groups.push({ key: FAVORITES_GROUP, label: 'Favorites', items: favs });
  }
  for (const tag of allTemplateTags()) {
    const items = templates.filter((t) => (t.tags || []).includes(tag));
    if (items.length) groups.push({ key: tag, label: tag, items });
  }
  const untagged = templates.filter((t) => !t.tags || !t.tags.length);
  groups.push({ key: UNTAGGED_GROUP, label: 'Untagged', items: untagged });
  return groups;
}

function buildTemplateLi(t) {
  const li = document.createElement('li');
  li.dataset.id = t.id;
  li.draggable = true;
  li.innerHTML = TEMPLATES_ITEM_HTML;
  const star = li.querySelector('.sidebar-star');
  star.classList.toggle('active', !!t.favorite);
  star.setAttribute('aria-pressed', t.favorite ? 'true' : 'false');
  li.querySelector('.name').textContent = t.name;
  if (t.description) {
    li.title = t.description;
  } else {
    const lines = t.body.split('\n');
    const preview = lines.slice(0, 6).join('\n');
    li.title = preview + (lines.length > 6 ? '\n…' : '');
  }
  return li;
}

function setTemplatesBulkButtonsVisibility(hasGroups) {
  if (hasGroups !== null) {
    const bulk = document.getElementById('templates-bulk-groups');
    if (bulk) bulk.hidden = !hasGroups;
  }
}

export function renderTemplates() {
  wireTemplatesDelegation();
  const container = $('#templates');
  if (!state.templates.length) {
    setTemplatesBulkButtonsVisibility(false);
    showListPlaceholder(container, '(no templates yet)');
    updateSectionCount('templates', 0);
    return;
  }
  const visible = sortedTemplates().filter((t) => matchesSidebar(t));
  updateSectionCount('templates', visible.length);
  if (!visible.length) {
    setTemplatesBulkButtonsVisibility(false);
    showListPlaceholder(container, '(no matches)');
    return;
  }
  if (sidebarFilter) expandSectionForMatch('templates');
  if (sortModes.templates !== 'T') {
    setTemplatesBulkButtonsVisibility(false);
    container.replaceChildren();
    const flat = applyFlatSort(visible, sortModes.templates);
    for (const t of flat) container.appendChild(buildTemplateLi(t));
    return;
  }
  const groups = buildTemplateGroups(visible);
  setTemplatesBulkButtonsVisibility(groups.length > 1);
  container.replaceChildren();
  const filtering = !!sidebarFilter;
  for (const [i, g] of groups.entries()) {
    const details = document.createElement('details');
    details.className = 'sidebar-tag-group';
    details.setAttribute('role', 'group');
    details.setAttribute('aria-label', g.label);
    details.dataset.group = g.key;
    const collapsedKey = LS_KEYS.tagSectionCollapsed('tpl:' + g.key);
    if (filtering) {
      details.open = true;
    } else {
      const saved = localStorage.getItem(collapsedKey);
      details.open = saved === null ? i === 0 : saved !== '1';
      details.addEventListener('toggle', () => {
        if (suppressTagToggleSave) return;
        safeSetItem(collapsedKey, details.open ? '0' : '1');
      });
    }
    const summary = document.createElement('summary');
    summary.className = 'sidebar-tag-summary';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'sidebar-tag-label';
    labelSpan.textContent = g.label;
    summary.appendChild(labelSpan);
    const count = document.createElement('span');
    count.className = 'sidebar-tag-count muted';
    count.textContent = String(g.items.length);
    summary.appendChild(count);
    appendTagSummaryActions(summary, g, 'templates');
    details.appendChild(summary);
    const inner = document.createElement('ul');
    inner.className = 'sidebar-tag-list';
    inner.setAttribute('role', 'list');
    for (const t of g.items) inner.appendChild(buildTemplateLi(t));
    details.appendChild(inner);
    container.appendChild(details);
  }
}

// ---------- event wiring ----------
on('library:snippets-changed', () => {
  renderSnippets();
  renderChains();
});
on('library:chains-changed', renderChains);
on('library:templates-changed', renderTemplates);
on('library:text-snippets-changed', renderTextSnippets);
on('pipeline:snippets-changed', () => {
  renderSnippets();
  renderChains();
});
on('pipeline:chains-changed', renderChains);
