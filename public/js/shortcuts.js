// @ts-check
// Snippet keyboard-shortcut helpers: normalize a KeyboardEvent into a stable
// canonical string, pretty-print it for display, and flag conflicts against
// other snippets, the app's own bindings, and common system/browser bindings.

import { IS_MAC } from './core.js';

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph']);

/**
 * App-owned keyboard actions, user-configurable via Settings → System
 * shortcuts. `defaultCombo` uses `Mod+` — resolved to Ctrl on Linux /
 * Windows, Meta (⌘) on macOS at read time. Handlers live in main.js and
 * are wired by id; the registry is metadata only. Conflict detection
 * (`findConflicts`) reads the effective map (defaults merged with user
 * overrides) via `effectiveSystemShortcuts(settings)`.
 *
 * `derivedFrom` (optional) marks an action whose shortcut is not
 * independently configurable — instead it inherits the combo of another
 * action. Used for actions that share a trigger but switch behaviour
 * based on UI state (e.g. `Mod+K` opens the palette when closed, toggles
 * advanced/simple when open). The settings UI renders derived rows
 * greyed out so the user can see the combo without being able to edit
 * it in isolation; `effectiveSystemShortcuts()` omits derived actions
 * from the dispatch map because the parent action's handler covers both
 * roles.
 *
 * @type {{id: string, label: string, defaultCombo: string, hint?: string, derivedFrom?: string}[]}
 */
export const SYSTEM_ACTIONS = [
  { id: 'openPalette', label: 'Open command palette', defaultCombo: 'Mod+K' },
  {
    id: 'togglePaletteAdvanced',
    label: 'Toggle palette advanced / simple view',
    defaultCombo: 'Mod+K',
    derivedFrom: 'openPalette',
    hint: 'Shares the Open command palette shortcut — the same combo opens the palette when closed and toggles advanced / simple view when it\u2019s already open.',
  },
  {
    id: 'openRunner',
    label: 'Open runner — run on selection',
    defaultCombo: 'Mod+O',
  },
  {
    id: 'openRunnerInsert',
    label: 'Open runner — insert at cursor',
    defaultCombo: 'Mod+Shift+O',
  },
  {
    id: 'find',
    label: 'Find in editor',
    defaultCombo: 'Mod+F',
    hint: 'Only fires when focus is inside the editor or the find panel.',
  },
  {
    id: 'findReplace',
    label: 'Find & replace in editor',
    defaultCombo: 'Mod+H',
    hint: 'Only fires when focus is inside the editor or the find panel.',
  },
  {
    id: 'jumpToLine',
    label: 'Jump to line (textarea-scoped)',
    defaultCombo: 'Mod+G',
    hint: 'Only fires when focus is inside a textarea.',
  },
  {
    id: 'openTabSwitcher',
    label: 'Open tab switcher (quick filter)',
    defaultCombo: 'Mod+P',
  },
  {
    id: 'toggleSidebar',
    label: 'Toggle sidebar',
    defaultCombo: 'Mod+B',
    hint: 'Hides or shows the snippets / chains / templates sidebar. State persists across reloads.',
  },
];

/**
 * Resolve the effective combo for each system action, given the current
 * settings object. A string override replaces the default; an empty
 * string or explicit `null` disables the action (no combo fires it). An
 * absent override falls back to the default.
 *
 * Returns a Map from action id → platform-concrete combo (empty entries
 * omitted, so callers can iterate without checking for disabled rows).
 *
 * @param {{ systemShortcuts?: Record<string, string | null> }} [settings]
 * @returns {Map<string, string>}
 */
export function effectiveSystemShortcuts(settings) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const overrides = settings?.systemShortcuts || {};
  for (const action of SYSTEM_ACTIONS) {
    // Derived actions don't fire independently — their parent action's
    // handler covers both behaviours. Skip so the dispatch loop never
    // double-matches a combo.
    if (action.derivedFrom) continue;
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, action.id);
    if (hasOverride) {
      const v = overrides[action.id];
      if (v === null || v === '') continue; // disabled
      map.set(action.id, v);
    } else {
      map.set(action.id, resolveMod(action.defaultCombo));
    }
  }
  return map;
}

/**
 * Default (platform-concrete) combo for one action — convenience used by
 * the settings UI to show "default: ⌘K" next to the capture cell.
 *
 * @param {string} id
 * @returns {string | null}
 */
export function defaultSystemCombo(id) {
  const a = SYSTEM_ACTIONS.find((x) => x.id === id);
  return a ? resolveMod(a.defaultCombo) : null;
}

// Common OS / browser bindings. `blocking: true` marks combos the browser
// (or OS) won't let JS preventDefault on — binding a snippet to one would
// never fire, so we refuse to save it. `blocking: false` entries the
// browser hands to us if our keydown listener calls preventDefault: those
// are overridable, so we downgrade to a warning and let the user decide.
// `Mod+` is Ctrl on Linux/Windows, Cmd on macOS.
const SYSTEM_SHORTCUTS = [
  { combo: 'Mod+C', label: 'Copy', blocking: false },
  { combo: 'Mod+V', label: 'Paste', blocking: false },
  { combo: 'Mod+X', label: 'Cut', blocking: false },
  { combo: 'Mod+A', label: 'Select all', blocking: false },
  { combo: 'Mod+Z', label: 'Undo', blocking: false },
  { combo: 'Mod+Y', label: 'Redo', blocking: false },
  { combo: 'Mod+Shift+Z', label: 'Redo', blocking: false },
  { combo: 'Mod+S', label: 'Save page', blocking: false },
  { combo: 'Mod+P', label: 'Print', blocking: false },
  { combo: 'Mod+N', label: 'New window', blocking: true },
  { combo: 'Mod+T', label: 'New tab', blocking: true },
  { combo: 'Mod+W', label: 'Close tab', blocking: true },
  { combo: 'Mod+R', label: 'Reload', blocking: true },
  { combo: 'Mod+L', label: 'Focus address bar', blocking: true },
  { combo: 'Mod+D', label: 'Bookmark page', blocking: false },
  { combo: 'Mod+J', label: 'Downloads', blocking: false },
  { combo: 'Mod+O', label: 'Open file', blocking: false },
  { combo: 'Mod+U', label: 'View source', blocking: false },
  { combo: 'Mod+Plus', label: 'Zoom in', blocking: false },
  { combo: 'Mod+Minus', label: 'Zoom out', blocking: false },
  { combo: 'Mod+0', label: 'Reset zoom', blocking: false },
];

/**
 * Resolve a `Mod+` prefix to the platform-concrete modifier. We store and
 * compare shortcuts in platform-concrete form (`Ctrl+K` or `Meta+K`) so two
 * users on different OSes can't accidentally trip each other's bindings.
 */
export function resolveMod(combo) {
  return combo.replace(/^Mod\+/, IS_MAC ? 'Meta+' : 'Ctrl+');
}

/**
 * Normalize a KeyboardEvent into a canonical `Ctrl+Shift+K` style string.
 * Returns null if the event is a bare modifier press (no real key yet).
 *
 * Modifier order is fixed: Ctrl, Meta, Alt, Shift — so two recordings of
 * the same chord always compare equal.
 *
 * @param {KeyboardEvent} e
 * @returns {string|null}
 */
export function normalizeShortcut(e) {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key === '+') key = 'Plus';
  else if (key === '-') key = 'Minus';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/**
 * Return true if a normalized combo looks like a reasonable snippet shortcut.
 * A shortcut needs either a function key (dedicated to shortcuts) or a
 * modifier paired with a non-modifier key — otherwise it would fire on
 * normal typing.
 *
 *   - Function keys (F1 – F24), alone or with any modifier, are accepted.
 *   - Bare non-function keys (Enter, Space, K, …) are rejected: every
 *     keystroke would trigger them.
 *   - Shift-only + a single-character key (e.g. `Shift+A`) is rejected
 *     because that chord just types a capital letter.
 *   - Shift-only + a named key (Shift+Enter, Shift+Tab, Shift+Escape, …)
 *     is accepted — these chords are purely functional on a QWERTY
 *     keyboard.
 *   - Any combo with Ctrl / Meta / Alt is accepted.
 *
 * @param {string} combo
 */
export function isUsableCombo(combo) {
  if (!combo) return false;
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const valid = new Set(['Ctrl', 'Meta', 'Alt', 'Shift']);
  for (const m of mods) {
    if (!valid.has(m)) return false;
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  if (!mods.length) return false;
  const hasNonShiftMod = mods.some((m) => m !== 'Shift');
  if (hasNonShiftMod) return true;
  // Shift-only: require a named (non-printable) key.
  return key.length > 1;
}

/**
 * Does the pressed event match the stored combo? Uses the same normalizer.
 *
 * @param {KeyboardEvent} e
 * @param {string} combo
 */
export function matchesShortcut(e, combo) {
  if (!combo) return false;
  const pressed = normalizeShortcut(e);
  if (!pressed) return false;
  return pressed === combo;
}

/**
 * Pretty string for display — `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere.
 *
 * @param {string} combo
 */
export function formatShortcut(combo) {
  if (!combo) return '';
  if (!IS_MAC) return combo;
  return combo
    .replace(/Meta\+/g, '⌘')
    .replace(/Ctrl\+/g, '⌃')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧')
    .replace(/\+/g, '');
}

/**
 * Find every conflict for `combo`: other snippets / chains using it, the
 * user's active system-shortcut bindings (from settings, with their
 * defaults), and common browser / OS bindings. Each hit is tagged
 * `blocking` — true for conflicts that make the shortcut unusable (and so
 * should refuse the save), false for overridable ones where the browser
 * lets us `preventDefault`.
 *
 * System-shortcut bindings are passed in from the caller because the
 * settings dialog stages pending overrides that haven't been saved yet;
 * `app` conflicts should reflect the "after Save" state so a combo the
 * user just freed is correctly seen as available. If you're outside the
 * dialog and want the saved state, pass `effectiveSystemShortcuts(settings)`.
 *
 * `ignoreSystemActionId` skips a specific system-action slot — used by
 * the system-shortcut capture so re-recording the same combo into its
 * own row isn't flagged as a conflict with itself.
 *
 * @param {string} combo
 * @param {{
 *   snippets: any[],
 *   chains?: any[],
 *   systemBindings?: Map<string, string>,
 *   ignoreSnippetId?: string,
 *   ignoreChainId?: string,
 *   ignoreSystemActionId?: string,
 *   ignoreField?: 'shortcut' | 'shortcutInsert',
 * }} ctx
 * @returns {{ type: 'snippet'|'chain'|'app'|'system', label: string, blocking: boolean }[]}
 */
export function findConflicts(
  combo,
  {
    snippets,
    chains,
    systemBindings,
    ignoreSnippetId,
    ignoreChainId,
    ignoreSystemActionId,
    ignoreField,
  },
) {
  if (!combo) return [];
  /** @type {{type: 'snippet'|'chain'|'app'|'system', label: string, blocking: boolean}[]} */
  const hits = [];
  for (const sn of snippets) {
    for (const field of /** @type {const} */ (['shortcut', 'shortcutInsert'])) {
      if (!sn[field]) continue;
      if (sn.id === ignoreSnippetId && field === ignoreField) continue;
      if (sn[field] !== combo) continue;
      const action = field === 'shortcutInsert' ? ' (insert at cursor)' : '';
      hits.push({
        type: 'snippet',
        label: `snippet "${sn.name}"${action}`,
        blocking: true,
      });
    }
  }
  for (const c of chains || []) {
    for (const field of /** @type {const} */ (['shortcut', 'shortcutInsert'])) {
      if (!c[field]) continue;
      if (c.id === ignoreChainId && field === ignoreField) continue;
      if (c[field] !== combo) continue;
      const action = field === 'shortcutInsert' ? ' (insert at cursor)' : '';
      hits.push({
        type: 'chain',
        label: `chain "${c.name}"${action}`,
        blocking: true,
      });
    }
  }
  if (systemBindings) {
    for (const [actionId, actionCombo] of systemBindings) {
      if (actionCombo !== combo) continue;
      if (actionId === ignoreSystemActionId) continue;
      const action = SYSTEM_ACTIONS.find((a) => a.id === actionId);
      hits.push({
        type: 'app',
        label: action ? action.label : actionId,
        blocking: true,
      });
    }
  }
  for (const s of SYSTEM_SHORTCUTS) {
    if (resolveMod(s.combo) === combo) {
      hits.push({ type: 'system', label: s.label, blocking: s.blocking });
    }
  }
  return hits;
}
