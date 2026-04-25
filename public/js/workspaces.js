// @ts-check
// Named workspaces — save/load snapshots of the tab strip.
//
// A workspace captures (`Tab[]`, `activeTabId`) at a moment in time.
// Loading replaces the live tab strip verbatim with the saved set;
// saving deep-clones the live tabs so later edits don't mutate the
// snapshot. The library-vs-session boundary observed by import-export
// holds here: workspaces live in `state.workspaces` and persist via
// `saveState`, but aren't part of the exportable JSON bundle.

import { $, uid, closestOn, appConfirm, appPrompt, showToast } from './core.js';
import { state, saveState } from './state.js';
import { dispatch } from './events.js';

// Module boundary: we deliberately do NOT import from editor.js —
// that would create a cycle (editor.js imports `openWorkspacesDialog`
// here). Instead we mutate `state` and fire a DOM CustomEvent, and
// editor.js listens for it to refresh the editor surface. This
// follows the project's "avoid cycles via events" convention (see
// ARCHITECTURE.md > Module boundary rules).

/**
 * Deep-copy a tab for persistence. Only the serializable fields are
 * kept — ephemeral editor overlay state (find matches, scroll) isn't
 * on the object anyway. Returning a fresh object means subsequent
 * edits to the live tab don't leak into the workspace.
 *
 * @param {import('./types.js').Tab} t
 * @returns {import('./types.js').Tab}
 */
function cloneTab(t) {
  /** @type {import('./types.js').Tab} */
  const out = { id: t.id, title: t.title, content: t.content };
  if (t.wordWrap) out.wordWrap = t.wordWrap;
  if (t.pinned) out.pinned = true;
  if (t.sourceSnippetId) out.sourceSnippetId = t.sourceSnippetId;
  return out;
}

/**
 * Flush any pending editor content into the active tab's `content`
 * before snapshotting. The editor's `input` handler keeps this synced
 * on every keystroke, so it's normally a no-op — we call it
 * defensively in case a save fires right after a programmatic content
 * change that bypassed the `input` event.
 */
function syncActiveTabContent() {
  const t = state.tabs.find((x) => x.id === state.activeTabId);
  const ed = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('editor'));
  if (t && ed && t.content !== ed.value) t.content = ed.value;
}

/** @param {string} name */
function makeWorkspaceFromCurrent(name) {
  syncActiveTabContent();
  return /** @type {import('./types.js').Workspace} */ ({
    id: uid(),
    name,
    tabs: state.tabs.map(cloneTab),
    activeTabId: state.activeTabId,
    savedAt: Date.now(),
  });
}

/** @param {string} name */
function nextFreeWorkspaceName(name) {
  let i = 2;
  while (state.workspaces.some((w) => w.name === `${name} (${i})`)) i++;
  return `${name} (${i})`;
}

/**
 * Prompt for a name and create a new workspace from the current tabs.
 * Collision handling mirrors the save-as-snippet flow: user-chosen
 * name that already exists auto-suffixes to `(2)` rather than failing.
 */
async function saveCurrentAsWorkspace() {
  const suggested = 'Workspace ' + (state.workspaces.length + 1);
  const rawName = await appPrompt('Save current tabs as a new workspace:', {
    title: 'Save workspace',
    defaultValue: suggested,
    placeholder: 'Workspace name',
    okLabel: 'Save',
  });
  if (rawName === null) return;
  const typed = rawName.trim();
  if (!typed) return;
  const finalName = state.workspaces.some((w) => w.name === typed)
    ? nextFreeWorkspaceName(typed)
    : typed;
  state.workspaces.push(makeWorkspaceFromCurrent(finalName));
  saveState();
  renderWorkspacesList();
  showToast({
    title: 'Workspace saved',
    body: `"${finalName}"`,
    level: 'info',
    duration: 2500,
  });
}

/**
 * Replace the live tab strip with a saved workspace. Prompts first —
 * this is a destructive operation (current tabs are discarded; they
 * only survive if they're already saved in some other workspace).
 *
 * @param {string} id
 */
async function loadWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return;
  const currentHasContent = state.tabs.some((t) => !!t.content);
  if (currentHasContent) {
    const ok = await appConfirm(
      `Load workspace "${ws.name}"? This replaces your current tabs.`,
      { title: 'Load workspace', okLabel: 'Load' },
    );
    if (!ok) return;
  }
  state.tabs = ws.tabs.map(cloneTab);
  state.activeTabId =
    ws.activeTabId && state.tabs.some((t) => t.id === ws.activeTabId)
      ? ws.activeTabId
      : state.tabs[0]?.id || null;
  saveState();
  // Editor listens for this and rebinds the editor textarea + overlay
  // + tab strip. Event-based handoff keeps this module free of an
  // editor.js import.
  dispatch('workspace:loaded');
  /** @type {HTMLDialogElement | null} */ (
    document.getElementById('workspaces-dialog')
  )?.close();
  showToast({
    title: 'Workspace loaded',
    body: `"${ws.name}"`,
    level: 'info',
    duration: 2500,
  });
}

/**
 * Replace a saved workspace's contents with the current tabs. Keeps
 * the workspace id stable (so anything referencing it by id still
 * works) and bumps `savedAt` so the row's timestamp reflects the
 * overwrite.
 *
 * @param {string} id
 */
async function overwriteWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return;
  const ok = await appConfirm(
    `Overwrite workspace "${ws.name}" with the current tabs?`,
    { title: 'Overwrite workspace', danger: true, okLabel: 'Overwrite' },
  );
  if (!ok) return;
  syncActiveTabContent();
  ws.tabs = state.tabs.map(cloneTab);
  ws.activeTabId = state.activeTabId;
  ws.savedAt = Date.now();
  saveState();
  renderWorkspacesList();
  showToast({
    title: 'Workspace overwritten',
    body: `"${ws.name}"`,
    level: 'info',
    duration: 2500,
  });
}

/** @param {string} id */
async function renameWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return;
  const rawName = await appPrompt('New workspace name:', {
    title: 'Rename workspace',
    defaultValue: ws.name,
  });
  if (rawName === null) return;
  const typed = rawName.trim();
  if (!typed || typed === ws.name) return;
  if (state.workspaces.some((w) => w.id !== id && w.name === typed)) {
    showToast({
      title: 'Name already in use',
      body: `Another workspace is already named "${typed}".`,
      level: 'error',
      duration: 3500,
    });
    return;
  }
  ws.name = typed;
  saveState();
  renderWorkspacesList();
}

/** @param {string} id */
async function deleteWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return;
  const ok = await appConfirm(`Delete workspace "${ws.name}"?`, {
    title: 'Delete workspace',
    danger: true,
    okLabel: 'Delete',
  });
  if (!ok) return;
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  saveState();
  renderWorkspacesList();
}

/**
 * Human-readable relative time like "2m ago", "just now". Kept inline
 * (rather than importing Intl.RelativeTimeFormat) because the full
 * Intl formatter is overkill for a five-tier approximation and the
 * message here is never user-editable.
 *
 * @param {number} savedAt epoch ms
 */
function formatSavedAt(savedAt) {
  const deltaS = Math.floor((Date.now() - savedAt) / 1000);
  if (deltaS < 30) return 'just now';
  if (deltaS < 60) return `${deltaS}s ago`;
  const m = Math.floor(deltaS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(savedAt).toLocaleDateString();
}

function renderWorkspacesList() {
  const list = $('#workspaces-list');
  if (!list) return;
  list.replaceChildren();
  if (!state.workspaces.length) {
    const empty = document.createElement('li');
    empty.className = 'workspaces-empty';
    empty.textContent = 'No saved workspaces yet.';
    list.appendChild(empty);
    return;
  }
  // Newest-saved first — matches "last used" mental model without
  // requiring a separate lastUsedAt field.
  const sorted = [...state.workspaces].sort((a, b) => b.savedAt - a.savedAt);
  for (const ws of sorted) {
    const li = document.createElement('li');
    li.className = 'workspaces-item';
    li.dataset.id = ws.id;
    li.innerHTML = `
      <div class="workspaces-item-main">
        <span class="workspaces-item-name"></span>
        <span class="workspaces-item-meta muted"></span>
      </div>
      <div class="workspaces-item-actions">
        <button type="button" data-act="load" title="Load this workspace (replaces current tabs)">Load</button>
        <button type="button" data-act="overwrite" title="Save current tabs into this workspace">Overwrite</button>
        <button type="button" data-act="rename" title="Rename" aria-label="Rename">\u270e</button>
        <button type="button" data-act="delete" title="Delete" aria-label="Delete">\u2715</button>
      </div>`;
    li.querySelector('.workspaces-item-name').textContent = ws.name;
    const meta = `${ws.tabs.length} tab${ws.tabs.length === 1 ? '' : 's'} \u00b7 ${formatSavedAt(ws.savedAt)}`;
    li.querySelector('.workspaces-item-meta').textContent = meta;
    list.appendChild(li);
  }
}

let dialogWired = false;
function wireDialog() {
  if (dialogWired) return;
  dialogWired = true;
  $('#workspaces-save-current').addEventListener('click', saveCurrentAsWorkspace);
  $('#workspaces-list').addEventListener('click', (e) => {
    const li = closestOn(e, '.workspaces-item');
    if (!li) return;
    const id = li.dataset.id;
    if (!id) return;
    const act = closestOn(e, 'button[data-act]')?.dataset?.act;
    if (act === 'load') loadWorkspace(id);
    else if (act === 'overwrite') overwriteWorkspace(id);
    else if (act === 'rename') renameWorkspace(id);
    else if (act === 'delete') deleteWorkspace(id);
  });
}

export function openWorkspacesDialog() {
  wireDialog();
  // Re-render on every open so timestamps ("2m ago") stay fresh and
  // any workspaces added/removed outside the dialog show up.
  renderWorkspacesList();
  const dlg = /** @type {HTMLDialogElement} */ ($('#workspaces-dialog'));
  dlg.showModal();
}
