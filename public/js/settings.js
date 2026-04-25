// @ts-check
// User settings: persistent prefs + server policy + settings dialog.
// Fires `dispatch('settings-saved')` (see events.js) after save
// so feature modules can react (e.g. re-apply editor wrap).

import { $, safeSetItem, appConfirm, showToast } from './core.js';
import { dispatch } from './events.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  rebuildAwkVocabulary,
  DEFAULT_SCRIPT_EXPORT_TEMPLATE,
} from './data.js';
import { state, saveState, beginAppReset } from './state.js';
import {
  normalizeShortcut,
  formatShortcut,
  isUsableCombo,
  findConflicts,
  SYSTEM_ACTIONS,
  defaultSystemCombo,
  effectiveSystemShortcuts,
} from './shortcuts.js';
import { findForbiddenMatches } from './safety.js';
import { setupPresetsEditor } from './settings/presets-editor.js';

/**
 * @typedef {import('./types.js').Settings} Settings
 * @typedef {import('./types.js').ServerPolicy} ServerPolicy
 */

/** @type {Settings} */
export let settings = /** @type {Settings} */ (structuredClone(DEFAULT_SETTINGS));

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      migrateLegacySettings(parsed);
      settings = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
    }
  } catch (err) {
    console.error('loadSettings: failed to parse settings', err);
    appConfirm(
      'Settings data is corrupted and could not be loaded. Defaults have been applied. Reset the stored settings to clear the error?',
      { title: 'Settings error', danger: true, okLabel: 'Reset settings' },
    ).then((ok) => {
      if (ok) {
        localStorage.removeItem(SETTINGS_KEY);
      }
    });
  }
}

export function saveSettings() {
  safeSetItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * One-shot migration for settings keys whose polarity was flipped to
 * keep the settings-dialog labels consistently affirmative (toggle ON
 * = turn the thing on). Mutates `parsed` in place before deepMerge so
 * the old keys never land in `settings`; a subsequent save will
 * persist only the new keys. Safe to run repeatedly.
 *
 * - `referenceDefaultHidden` (old, default true) →
 *   `referenceDefaultShown` (new, default false). Inverted value.
 * - `hideGawkButtons` (old, default false) →
 *   `showGawkButtons` (new, default true). Inverted value.
 * - `hideFormatButton` (old, default false) →
 *   `showFormatButton` (new, default true). Inverted value.
 *
 * Each migration runs only if the old key is present and the new key
 * is NOT yet set — so a user who has both (mixed state from a manual
 * edit) keeps their explicit new-key value.
 *
 * @param {any} parsed
 */
function migrateLegacySettings(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.ui) return;
  const ui = parsed.ui;
  /** @type {[string, string][]} */
  const flips = [
    ['referenceDefaultHidden', 'referenceDefaultShown'],
    ['hideGawkButtons', 'showGawkButtons'],
    ['hideFormatButton', 'showFormatButton'],
  ];
  for (const [oldKey, newKey] of flips) {
    if (typeof ui[oldKey] === 'boolean' && ui[newKey] === undefined) {
      ui[newKey] = !ui[oldKey];
    }
    delete ui[oldKey];
  }
}

// OS-theme follow: when the user has `theme: 'auto'` selected, re-apply
// the resolved theme whenever the OS flips between light and dark mid-
// session. No-op when the user has picked an explicit theme id — the
// `resolveTheme` call would just return that same id anyway, but the
// guard avoids the needless attribute write + repaint.
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!settings.ui?.theme || settings.ui.theme === 'auto') {
      document.documentElement.dataset.theme = resolveTheme(settings.ui?.theme);
    }
  });
} catch (_) {
  /* matchMedia unavailable — skip auto-follow silently */
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  for (const k of Object.keys(extra)) {
    if (
      extra[k] &&
      typeof extra[k] === 'object' &&
      !Array.isArray(extra[k]) &&
      base[k] &&
      typeof base[k] === 'object'
    ) {
      deepMerge(base[k], extra[k]);
    } else if (extra[k] !== undefined) {
      base[k] = extra[k];
    }
  }
  return base;
}

/**
 * Resolve the user's theme choice to a concrete theme id that CSS can
 * match. `auto` (or any falsy value, which happens only if a stored
 * settings blob predates the theme key) returns `dark` or `light`
 * depending on the OS `prefers-color-scheme` hint. Any other string is
 * passed through — that's either a built-in theme id (dark / light /
 * dracula / …) or a stale id whose file was removed, in which case CSS
 * silently falls back to the baseline variable defaults and the
 * settings dialog surfaces a `(missing)` suffix.
 *
 * @param {string | undefined | null} choice
 * @returns {string}
 */
export function resolveTheme(choice) {
  if (!choice || choice === 'auto') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      // matchMedia is universal in modern browsers; the try/catch is
      // paranoia for exotic runtimes (headless tests, old WebViews).
      return 'dark';
    }
  }
  return choice;
}

/**
 * Apply UI-density by toggling `body.density-compact` / `body.density-roomy`.
 * Normal / unknown values clear both classes so the baseline `--density-*`
 * tokens in `:root` (style.css) take over. Exported for use by the
 * Settings dialog's live-preview path.
 *
 * @param {string | undefined} density
 */
export function applyDensity(density) {
  const cls = document.body.classList;
  cls.toggle('density-compact', density === 'compact');
  cls.toggle('density-roomy', density === 'roomy');
}

/**
 * Clear any inline `font-family` / `tab-size` styles left on `.hl-pre`
 * elements by `syncStyles` in `editor.js` and `awk.js`. Those two
 * syncStyles used to copy the values as inline overrides; they no
 * longer do, but a change to Tab size or Font family is reflow-free,
 * so no ResizeObserver fires and stale inline values from earlier
 * syncStyles runs linger with higher specificity than the CSS rule.
 * A single sweep on every `applySettings` / live-preview write wipes
 * them so the CSS var can take over.
 */
function clearStaleOverlayFontInlineStyles() {
  for (const pre of document.querySelectorAll('.hl-pre')) {
    /** @type {HTMLElement} */ (pre).style.fontFamily = '';
    /** @type {HTMLElement} */ (pre).style.tabSize = '';
  }
  // Dispatch so `editor.js` / `awk.js` can re-run their own syncStyles
  // (they listen on `document`). Font-family / tab-size changes don't
  // reflow the textarea, so the ResizeObserver that normally retriggers
  // syncStyles won't fire — this gives those modules a deterministic
  // hook to refresh padding / border / font-size in the same frame.
  dispatch('editor-font-settings-changed');
}

export function applySettings() {
  document.documentElement.style.setProperty('--editor-font-size', settings.editor.fontSize + 'px');
  document.documentElement.style.setProperty('--editor-tab-size', String(settings.editor.tabSize));
  // Font family: only set the custom property when the user has chosen
  // something non-empty, so the CSS fallback stack (`'SF Mono', Monaco,
  // Consolas, monospace`) wins on every `var(--editor-font-family, …)`
  // site. Removing the property (as opposed to setting it to `''`) is
  // what makes the fallback kick in — `var(--x, fallback)` treats an
  // explicitly-empty value as an invalid substitution anyway, but
  // removing is clearer.
  const fontFamily = (settings.editor.fontFamily || '').trim();
  if (fontFamily) {
    document.documentElement.style.setProperty('--editor-font-family', fontFamily);
  } else {
    document.documentElement.style.removeProperty('--editor-font-family');
  }
  clearStaleOverlayFontInlineStyles();
  document.documentElement.dataset.theme = resolveTheme(settings.ui.theme);
  applyDensity(settings.ui.density);
  // CSS class names kept as `hide-*` (no reason to rename the styling
  // contract); the flag polarity is what flipped. `showGawkButtons:
  // true` → hide class OFF → buttons visible.
  document.body.classList.toggle('hide-gawk-buttons', !settings.ui.showGawkButtons);
  document.body.classList.toggle('hide-format-button', !settings.ui.showFormatButton);
  const showRestore = !!settings.ui.showRestoreDefaults;
  for (const id of ['restore-snippets', 'restore-chains', 'restore-templates', 'restore-text-snippets']) {
    const btn = document.getElementById(id);
    if (btn) btn.hidden = !showRestore;
  }
  // Repopulate the tokenizer's live vocabulary so gawk extensions are
  // either highlighted or rendered as plain identifiers, per the
  // setting. Default (undefined) treated as `true` to match the first-
  // run default in DEFAULT_SETTINGS.
  const includeGawk = settings.ui.highlightGawkExtensions !== false;
  rebuildAwkVocabulary(includeGawk);
  // Each attached highlighter listens for this and re-runs its update()
  // against the new vocabulary. Without it, open textareas would keep
  // their old colouring until the next keystroke.
  dispatch('awk-vocabulary-changed');
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** @type {ServerPolicy|null} */
export let serverPolicy = null;

export async function fetchServerPolicy() {
  try {
    const r = await fetch('/settings/binaries');
    serverPolicy = await r.json();
  } catch (_) {
    serverPolicy = { binaries: [{ name: 'gawk', available: true }], sandboxEnforced: true };
  }
}

/**
 * Open the Settings dialog. When `scrollTo` is provided, the matching
 * element (by id) inside the dialog is scrolled into view and briefly
 * flashed — used by the safety-blocked toast's "Open safety settings"
 * button to land the user directly on the forbidden-patterns field.
 *
 * @param {{ scrollTo?: string }} [opts]
 */
export async function openSettingsDialog(opts = {}) {
  if (!serverPolicy) await fetchServerPolicy();
  const dlg = $('#settings-dialog');

  const binarySelect = $('#set-binary');
  binarySelect.replaceChildren();
  for (const b of serverPolicy.binaries) {
    const opt = document.createElement('option');
    opt.value = b.name;
    if (!b.available) opt.disabled = true;
    opt.textContent = b.available ? b.name : `${b.name} (not installed)`;
    binarySelect.appendChild(opt);
  }
  binarySelect.value = settings.exec.binary;

  const sandboxOn = !!serverPolicy.sandboxEnforced;
  const sandboxStatus = $('#set-sandbox-status');
  if (sandboxStatus) {
    sandboxStatus.textContent = sandboxOn
      ? '(enforced by server — run with --unsafe to disable)'
      : '(DISABLED — server started with --unsafe)';
    sandboxStatus.style.color = sandboxOn ? 'var(--muted)' : 'var(--danger)';
  }
  $('#set-args').value = (settings.exec.args || []).join('\n');
  $('#set-timeout').value = settings.exec.timeoutMs;
  $('#set-max-output').value = settings.exec.maxOutputBytes;

  // Font family: curated dropdown + Custom… input. Stored value is the
  // raw CSS font-family string. On open, match the stored string
  // against presets; non-matches (or explicitly custom stacks) land
  // on Custom… with the stored value pre-filled in the text box. The
  // dropdown's "System default" preset uses the empty string so the
  // `--editor-font-family` var is removed on save and the CSS
  // fallback stack wins.
  /** @type {{value: string, label: string}[]} */
  const fontFamilyPresets = [
    { value: '', label: 'System default' },
    { value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', label: 'System UI monospace' },
    { value: "'SF Mono', Monaco, Consolas, monospace", label: 'SF Mono' },
    { value: 'Menlo, monospace', label: 'Menlo' },
    { value: 'Monaco, monospace', label: 'Monaco' },
    { value: 'Consolas, monospace', label: 'Consolas' },
    { value: "'Cascadia Code', Consolas, monospace", label: 'Cascadia Code' },
    { value: "'Fira Code', monospace", label: 'Fira Code' },
    { value: "'JetBrains Mono', monospace", label: 'JetBrains Mono' },
    { value: "'Source Code Pro', monospace", label: 'Source Code Pro' },
  ];
  const FONT_FAMILY_CUSTOM_SENTINEL = '__custom__';
  // Original font-family captured at dialog-open time so a close-without-
  // save reverts any live preview. Mirrors the theme live-preview pattern.
  const originalFontFamily = (settings.editor.fontFamily || '').trim();
  const originalFontSize = Number.isFinite(settings.editor.fontSize)
    ? settings.editor.fontSize
    : 13;
  /**
   * Apply `px` as a live preview by writing to the root's
   * `--editor-font-size`. Clamped to the same [8, 32] range as the
   * save path so a user typing `500` in the input doesn't blow up
   * the layout before they finish. The `clearStaleOverlayFontInlineStyles`
   * call dispatches `editor-font-settings-changed`, which the overlay
   * syncStyles listeners use to re-copy the textarea's computed
   * font-size onto the `<pre>` — font-size changes DO reflow the
   * textarea in theory, but only after layout settles, and the
   * overlay's inline `style.fontSize` is sticky until the next
   * syncStyles fire.
   *
   * @param {number} px
   */
  const previewFontSize = (px) => {
    const clamped = Math.max(8, Math.min(32, px));
    document.documentElement.style.setProperty('--editor-font-size', clamped + 'px');
    clearStaleOverlayFontInlineStyles();
  };
  /**
   * Apply `fontStack` as a live preview by writing to the root's
   * `--editor-font-family` custom property. Empty string removes the
   * property so the CSS fallback stack wins. Changes take effect in the
   * same frame across every monospace surface in the app — main editor,
   * overlays, snippet / inline-step / chain dialogs, palette input,
   * sidebar code rows, preview panes — since they all resolve against
   * the shared var (see the CSS pass in `style.css`).
   *
   * @param {string} fontStack
   */
  const previewFontFamily = (fontStack) => {
    const trimmed = (fontStack || '').trim();
    if (trimmed) {
      document.documentElement.style.setProperty('--editor-font-family', trimmed);
    } else {
      document.documentElement.style.removeProperty('--editor-font-family');
    }
    // Wipe any stale inline `fontFamily` on overlay `<pre>` elements so
    // the CSS var takes effect immediately — without this the textarea
    // picks up the new font (via the #editor rule) but the overlay
    // stays stuck until `syncStyles` next fires, producing ghost-text
    // selection highlights at the old glyph widths.
    clearStaleOverlayFontInlineStyles();
  };
  const wireFontFamilyPicker = () => {
    const sel = /** @type {HTMLSelectElement} */ ($('#set-font-family'));
    const customRow = /** @type {HTMLElement} */ ($('#set-font-family-custom-row'));
    const customInput = /** @type {HTMLInputElement} */ ($('#set-font-family-custom'));
    sel.replaceChildren();
    for (const p of fontFamilyPresets) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = FONT_FAMILY_CUSTOM_SENTINEL;
    customOpt.textContent = 'Custom…';
    sel.appendChild(customOpt);

    const stored = (settings.editor.fontFamily || '').trim();
    const matched = fontFamilyPresets.find((p) => p.value === stored);
    if (matched) {
      sel.value = matched.value;
      customInput.value = '';
      customRow.hidden = true;
    } else {
      // Any non-preset string — including an empty-after-trim value
      // that doesn't match the System default preset — falls to Custom.
      // (System default preset has value '' already, so empty strings
      // match there first and we don't land here.)
      sel.value = FONT_FAMILY_CUSTOM_SENTINEL;
      customInput.value = stored;
      customRow.hidden = false;
    }
    sel.onchange = () => {
      customRow.hidden = sel.value !== FONT_FAMILY_CUSTOM_SENTINEL;
      if (sel.value === FONT_FAMILY_CUSTOM_SENTINEL) {
        customInput.focus();
        previewFontFamily(customInput.value);
      } else {
        previewFontFamily(sel.value);
      }
    };
    // Live preview while typing a custom stack. Firing on every keystroke
    // is cheap — it's a single CSS property write; the browser coalesces
    // the repaint.
    customInput.oninput = () => {
      if (sel.value === FONT_FAMILY_CUSTOM_SENTINEL) previewFontFamily(customInput.value);
    };
  };

  $('#set-tab-size').value = settings.editor.tabSize;
  $('#set-font-size').value = settings.editor.fontSize;
  // Live preview — a number input fires `input` on every keystroke /
  // spinner click, so the editor retypesets as the user dials the
  // value. A blank / NaN value is ignored until the user types a
  // valid number.
  $('#set-font-size').addEventListener('input', (e) => {
    const n = parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10);
    if (Number.isFinite(n)) previewFontSize(n);
  });
  wireFontFamilyPicker();
  $('#set-default-tab-text').value = settings.editor.defaultNewTabText;
  $('#set-confirm-close').checked = !!settings.editor.confirmCloseTabWithContent;
  $('#set-tab-merge-separator').value = settings.editor.tabMergeSeparator || 'dash';
  $('#set-confirm-clear-program').checked = !!settings.editor.confirmClearProgram;
  $('#set-confirm-clear-history').checked = settings.editor.confirmClearHistory !== false;
  $('#set-line-numbers').checked = !!settings.editor.lineNumbers;
  $('#set-strip-trailing-newline').checked = settings.editor.stripTrailingNewline === true;
  $('#set-palette-enter-applies').checked = !!settings.editor.paletteEnterApplies;
  $('#set-default-wrap').value = settings.editor.defaultWordWrap || 'off';

  // Theme live-preview: apply the selection via <html data-theme="…">
  // immediately so the user can judge the colours against the rest of
  // the app without having to Save + reopen. The original is captured
  // so a close without Save reverts the preview; a Save runs
  // applySettings() which re-commits the chosen theme through the
  // normal path.
  //
  // The dropdown is populated from `/themes` each open: the server
  // scans public/themes/ at startup, so adding a theme file needs a
  // server restart but doesn't need a client rebuild. The saved id is
  // appended at the bottom as a fallback entry if it doesn't match any
  // currently-known theme (so the dialog never shows a blank select,
  // and the user can still see / switch away from the stale value).
  const originalTheme = settings.ui.theme;
  let themePreviewToastShown = false;
  const themeSelect = /** @type {HTMLSelectElement} */ ($('#set-theme'));
  themeSelect.replaceChildren();
  /** @type {{id: string, label: string}[]} */
  let themes = [];
  try {
    const resp = await fetch('/themes');
    if (resp.ok) themes = await resp.json();
  } catch (_) {
    /* keep fallback list below */
  }
  if (!themes.length) {
    themes = [
      { id: 'dark', label: 'Dark' },
      { id: 'light', label: 'Light' },
    ];
  }
  // "Auto (match OS)" goes at the top — it's the first-run default and
  // the most common non-explicit choice, so the user finds it without
  // scrolling through 16 theme ids.
  {
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Auto (match OS)';
    themeSelect.appendChild(autoOpt);
  }
  for (const t of themes) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    themeSelect.appendChild(opt);
  }
  // 'auto' is a valid selection even though it isn't in the /themes
  // response — don't flag it as missing.
  if (originalTheme !== 'auto' && !themes.some((t) => t.id === originalTheme)) {
    const opt = document.createElement('option');
    opt.value = originalTheme;
    opt.textContent = `${originalTheme} (missing)`;
    themeSelect.appendChild(opt);
  }
  themeSelect.value = originalTheme;
  themeSelect.onchange = () => {
    // Resolve 'auto' → dark/light before writing the attribute, because
    // no theme file scopes its rules under `[data-theme="auto"]`.
    document.documentElement.dataset.theme = resolveTheme(themeSelect.value);
    if (themeSelect.value !== originalTheme && !themePreviewToastShown) {
      themePreviewToastShown = true;
      showToast({
        title: 'Previewing theme',
        body: 'Save settings to keep it, or close the dialog to revert.',
        level: 'info',
        duration: 4000,
      });
    }
  };
  // Density — capture original for revert, wire live preview on change.
  const originalDensity = settings.ui.density || 'normal';
  {
    const densitySel = /** @type {HTMLSelectElement} */ ($('#set-density'));
    densitySel.value =
      originalDensity === 'compact' || originalDensity === 'roomy' ? originalDensity : 'normal';
    densitySel.onchange = () => applyDensity(densitySel.value);
  }
  $('#set-sidebar-width').value = settings.ui.defaultSidebarWidth;
  $('#set-ref-default-shown').checked = !!settings.ui.referenceDefaultShown;
  $('#set-palette-default-advanced').checked = !!settings.ui.paletteDefaultAdvanced;
  $('#set-show-restore-defaults').checked = !!settings.ui.showRestoreDefaults;
  $('#set-show-run-all-tests').checked = !!settings.ui.showRunAllTests;
  $('#set-drag-to-tag-mode').value = settings.ui.dragToTagMode === 'move' ? 'move' : 'add';
  {
    const v = settings.ui.runnerScope;
    $('#set-runner-scope').value = v === 'snippets' || v === 'chains' ? v : 'both';
  }
  // Default to true when the key is missing (fresh install on old data).
  $('#set-highlight-gawk').checked = settings.ui.highlightGawkExtensions !== false;
  $('#set-warn-gawk-only').checked = settings.ui.warnGawkOnly !== false;
  $('#set-show-gawk-buttons').checked = settings.ui.showGawkButtons !== false;
  $('#set-show-format-button').checked = settings.ui.showFormatButton !== false;
  $('#set-format-replace-tabs').checked = settings.ui.formatReplaceTabs !== false;
  $('#set-format-tab-spaces').value =
    settings.ui.formatTabSpaces == null ? 2 : settings.ui.formatTabSpaces;
  for (const cb of /** @type {NodeListOf<HTMLInputElement>} */ (
    document.querySelectorAll('[data-section-default]')
  )) {
    const key = cb.dataset.sectionDefault;
    // Treat a missing key as "expanded" — matches the new DEFAULT_SETTINGS
    // polarity for sections the user's saved blob predates.
    cb.checked = settings.ui.sectionsExpanded?.[key] !== false;
  }
  for (const cb of /** @type {NodeListOf<HTMLInputElement>} */ (
    document.querySelectorAll('[data-palette-section-default]')
  )) {
    const key = cb.dataset.paletteSectionDefault;
    // Missing key defaults to expanded — matches the new polarity in
    // DEFAULT_SETTINGS and lines up with the sidebar-sections treatment.
    cb.checked = (settings.ui.paletteSectionsExpanded || {})[key] !== false;
  }

  $('#set-auto-preview').checked = !!settings.pipeline.autoPreviewOnStepChange;
  $('#set-on-error').value = settings.pipeline.onError;
  $('#set-clear-on-sel').checked = !!settings.pipeline.clearOutputsOnSelectionChange;
  $('#set-accept-defaults').checked = !!settings.pipeline.acceptDefaultsWithoutPrompting;

  // Script export — snippet + chain dialogs' "Download script" button. Per-field
  // Reset is only wired on the template textarea (the one field fiddly
  // enough that a restore is worth the UI weight). The Reset button
  // hides while the textarea matches the shipped default so it doesn't
  // add noise when there's nothing to reset.
  const scriptExport = settings.scriptExport || DEFAULT_SETTINGS.scriptExport;
  const scriptFlattenCb = /** @type {HTMLInputElement} */ ($('#set-script-flatten'));
  const scriptExtensionIn = /** @type {HTMLInputElement} */ ($('#set-script-extension'));
  const scriptTemplateTa = /** @type {HTMLTextAreaElement} */ ($('#set-script-template'));
  const scriptTemplateResetBtn = /** @type {HTMLButtonElement} */ ($('#set-script-template-reset'));
  scriptFlattenCb.checked = scriptExport.flatten !== false;
  scriptExtensionIn.value = scriptExport.extension ?? '.sh';
  scriptTemplateTa.value =
    typeof scriptExport.template === 'string' ? scriptExport.template : DEFAULT_SCRIPT_EXPORT_TEMPLATE;
  const syncScriptTemplateReset = () => {
    scriptTemplateResetBtn.hidden = scriptTemplateTa.value === DEFAULT_SCRIPT_EXPORT_TEMPLATE;
  };
  syncScriptTemplateReset();
  scriptTemplateTa.oninput = syncScriptTemplateReset;
  scriptTemplateResetBtn.onclick = (e) => {
    e.preventDefault();
    scriptTemplateTa.value = DEFAULT_SCRIPT_EXPORT_TEMPLATE;
    syncScriptTemplateReset();
  };

  $('#set-save-debounce').value = settings.data.saveDebounceMs;
  $('#set-preview-max-lines').value = settings.preview.maxLines;
  $('#set-tests-run-on-save').checked = !!settings.tests?.runOnSave;
  $('#set-tests-show-unknown').checked = !!settings.tests?.showUnknownStatus;
  $('#set-safety-manual-preview').checked = !!settings.safety?.requireManualPreview;
  $('#set-safety-auto-side-effects').checked = !!settings.safety?.autoPreviewSideEffects;
  $('#set-safety-forbidden').value = (settings.safety?.forbiddenPatterns || []).join('\n');

  // Live "Test a command" area: reads the textarea (pre-Save) and runs it
  // through the same findForbiddenMatches the app uses at run time, so the
  // user can verify without deciphering any regex. Empty input → hidden.
  // Recomputes on every keystroke in either the test input or the patterns
  // textarea, so edits to the regex list reflect immediately.
  const testInput = /** @type {HTMLInputElement} */ ($('#set-safety-test'));
  const testResult = /** @type {HTMLDivElement} */ ($('#set-safety-test-result'));
  const forbiddenTextarea = /** @type {HTMLTextAreaElement} */ ($('#set-safety-forbidden'));
  testInput.value = '';
  const runSafetyTest = () => {
    const cmd = testInput.value;
    testResult.replaceChildren();
    testResult.classList.remove('safety-test-prevented', 'safety-test-allowed');
    if (!cmd) {
      testResult.hidden = true;
      return;
    }
    const patterns = forbiddenTextarea.value.split('\n').map((s) => s.trim());
    const hits = findForbiddenMatches(cmd, null, patterns);
    testResult.hidden = false;
    if (hits.length) {
      testResult.classList.add('safety-test-prevented');
      const hdr = document.createElement('strong');
      hdr.textContent = 'Prevented';
      testResult.appendChild(hdr);
      const why = document.createElement('div');
      why.className = 'safety-test-detail';
      const quoted = document.createElement('code');
      quoted.textContent = hits[0].match;
      why.append('Matched ', quoted, ' via pattern:');
      testResult.appendChild(why);
      const pat = document.createElement('code');
      pat.className = 'safety-test-pattern';
      pat.textContent = `/${hits[0].pattern}/i`;
      testResult.appendChild(pat);
    } else {
      testResult.classList.add('safety-test-allowed');
      const hdr = document.createElement('strong');
      hdr.textContent = 'Allowed';
      testResult.appendChild(hdr);
      const detail = document.createElement('div');
      detail.className = 'safety-test-detail muted';
      detail.textContent = 'No pattern in the list above matches this command.';
      testResult.appendChild(detail);
    }
  };
  testInput.addEventListener('input', runSafetyTest);
  forbiddenTextarea.addEventListener('input', runSafetyTest);
  runSafetyTest();

  // Saved command checks — persistent counterpart to the live tester above.
  // Each test is `{ id, text, expect: 'prevent' | 'allow' }`. On every edit
  // of the patterns textarea (or a test row) we re-run findForbiddenMatches
  // and repaint pass/fail badges, so edits to the regex list can't silently
  // break a known-safe or known-bad command. Auto-opens the <details> if
  // any test is failing, so breakage is hard to miss.
  const testsSection = /** @type {HTMLDetailsElement} */ ($('#safety-tests-section'));
  const testsListEl = $('#safety-tests-list');
  const testsSummaryEl = $('#safety-tests-summary');
  const testsAddBtn = $('#safety-tests-add');
  /** @type {{ id: string, text: string, expect: 'prevent' | 'allow' }[]} */
  const workingSafetyTests = (settings.safety?.tests || []).map((t) => ({
    id: t.id || `sfty-${Math.random().toString(36).slice(2, 10)}`,
    text: t.text || '',
    expect: t.expect === 'allow' ? 'allow' : 'prevent',
  }));

  /** @returns {{ pass: boolean, match?: string, pattern?: string }} */
  const evalSafetyTest = (t) => {
    if (!t.text) return { pass: false };
    const patterns = forbiddenTextarea.value.split('\n').map((s) => s.trim());
    const hits = findForbiddenMatches(t.text, null, patterns);
    const prevented = hits.length > 0;
    const expectedPrevented = t.expect === 'prevent';
    const pass = prevented === expectedPrevented;
    return pass
      ? { pass }
      : prevented
        ? { pass, match: hits[0].match, pattern: hits[0].pattern }
        : { pass };
  };

  const paintSafetyTestsSummary = () => {
    if (!workingSafetyTests.length) {
      testsSummaryEl.textContent = '';
      return;
    }
    let pass = 0;
    let fail = 0;
    for (const t of workingSafetyTests) {
      if (!t.text) continue;
      if (evalSafetyTest(t).pass) pass++;
      else fail++;
    }
    const total = pass + fail;
    if (!total) {
      testsSummaryEl.textContent = `· ${workingSafetyTests.length} empty`;
      return;
    }
    if (fail === 0) {
      testsSummaryEl.textContent = `· all ${total} passing`;
    } else {
      testsSummaryEl.textContent = `· ${fail} of ${total} failing`;
    }
  };

  // The DOM is rebuilt only when the *structure* changes (add / delete).
  // Text and expect edits just repaint the affected row's decoration —
  // rebuilding on every keystroke would destroy the <input> and drop focus
  // after each character.
  /** @type {Map<string, HTMLDivElement>} */
  const rowEls = new Map();

  const repaintRowDecoration = (t) => {
    const row = rowEls.get(t.id);
    if (!row) return;
    const dot = /** @type {HTMLElement} */ (row.querySelector('.test-dot'));
    const oldFb = row.querySelector('.safety-test-feedback');
    if (oldFb) oldFb.remove();
    row.classList.remove('pass', 'fail');
    if (!t.text) {
      dot.textContent = '◯';
      dot.title = 'Empty — add a command to check';
      return;
    }
    const result = evalSafetyTest(t);
    row.classList.add(result.pass ? 'pass' : 'fail');
    dot.textContent = result.pass ? '✓' : '✗';
    dot.title = result.pass ? 'Pass' : 'Fail';
    if (result.pass) return;
    const fb = document.createElement('div');
    fb.className = 'test-feedback safety-test-feedback';
    if (t.expect === 'prevent' && !result.match) {
      fb.textContent = 'Expected a pattern to prevent this, but none matched.';
    } else if (t.expect === 'allow' && result.match) {
      const span = document.createElement('span');
      span.append('Expected this to be allowed, but ');
      const matchCode = document.createElement('code');
      matchCode.textContent = result.match;
      span.append(matchCode, ' matched ');
      const patCode = document.createElement('code');
      patCode.textContent = `/${result.pattern}/i`;
      span.append(patCode, '.');
      fb.appendChild(span);
    }
    row.appendChild(fb);
  };

  const repaintAllSafetyTests = () => {
    let anyFailing = false;
    for (const t of workingSafetyTests) {
      repaintRowDecoration(t);
      if (t.text && !evalSafetyTest(t).pass) anyFailing = true;
    }
    paintSafetyTestsSummary();
    if (anyFailing && !testsSection.open) testsSection.open = true;
  };

  const rebuildSafetyTests = () => {
    testsListEl.replaceChildren();
    rowEls.clear();
    if (!workingSafetyTests.length) {
      const empty = document.createElement('div');
      empty.className = 'tests-empty muted';
      empty.textContent =
        'No saved checks yet. Add one to lock in "this should stay prevented" or "this should stay allowed".';
      testsListEl.appendChild(empty);
      paintSafetyTestsSummary();
      return;
    }
    workingSafetyTests.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'test-row safety-test-row';

      const head = document.createElement('div');
      head.className = 'test-row-head';

      const dot = document.createElement('span');
      dot.className = 'test-dot';
      head.appendChild(dot);

      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'safety-test-text';
      textInput.spellcheck = false;
      textInput.autocomplete = 'off';
      textInput.placeholder = `Check ${idx + 1} — e.g. rm -rf /tmp`;
      textInput.value = t.text;
      textInput.oninput = () => {
        t.text = textInput.value;
        repaintRowDecoration(t);
        paintSafetyTestsSummary();
      };
      head.appendChild(textInput);

      const expectLabel = document.createElement('span');
      expectLabel.className = 'safety-test-expect-label muted';
      expectLabel.textContent = 'expect';
      head.appendChild(expectLabel);
      const expectSel = document.createElement('select');
      expectSel.className = 'safety-test-expect';
      for (const v of /** @type {const} */ (['prevent', 'allow'])) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        if (t.expect === v) opt.selected = true;
        expectSel.appendChild(opt);
      }
      expectSel.onchange = () => {
        t.expect = expectSel.value === 'allow' ? 'allow' : 'prevent';
        repaintRowDecoration(t);
        paintSafetyTestsSummary();
      };
      head.appendChild(expectSel);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'test-del';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete this check';
      delBtn.onclick = (e) => {
        e.preventDefault();
        const i = workingSafetyTests.indexOf(t);
        if (i >= 0) workingSafetyTests.splice(i, 1);
        rebuildSafetyTests();
      };
      head.appendChild(delBtn);
      row.appendChild(head);

      rowEls.set(t.id, row);
      testsListEl.appendChild(row);
    });
    repaintAllSafetyTests();
  };

  testsAddBtn.onclick = (e) => {
    e.preventDefault();
    workingSafetyTests.push({
      id: `sfty-${Math.random().toString(36).slice(2, 10)}`,
      text: '',
      expect: 'prevent',
    });
    if (!testsSection.open) testsSection.open = true;
    rebuildSafetyTests();
    // Focus the new row's input so the user can start typing immediately.
    const rows = testsListEl.querySelectorAll('.safety-test-text');
    const last = /** @type {HTMLInputElement | null} */ (rows[rows.length - 1]);
    if (last) last.focus();
  };

  // Edits to the patterns textarea invalidate every test — repaint, not
  // rebuild, so the user's cursor in the textarea isn't disturbed.
  forbiddenTextarea.addEventListener('input', repaintAllSafetyTests);
  // Start collapsed; the summary (`all N passing` / `F of T failing`) is
  // enough for the healthy path. `repaintAllSafetyTests` auto-opens the
  // section if any test is failing, so breakage is still impossible to miss.
  testsSection.open = false;
  rebuildSafetyTests();

  // Presets editor (FPAT + Timestamp). UI + working state + commit
  // live in settings/presets-editor.js so the Settings dialog body
  // stays focused on the non-modal form fields.
  const presetsEditor = setupPresetsEditor(settings);

  // Shortcut overrides: changes live in these maps until the user hits Save,
  // keyed by snippet / chain id. Empty string = "clear this item's shortcut",
  // missing key = "leave alone". Four maps: {snippet,chain} × {run, insert}.
  // Every visible item gets one row with both fields side by side.
  /** @type {Map<string, string>} */
  const shortcutOverrides = new Map();
  /** @type {Map<string, string>} */
  const shortcutInsertOverrides = new Map();
  /** @type {Map<string, string>} */
  const chainShortcutOverrides = new Map();
  /** @type {Map<string, string>} */
  const chainShortcutInsertOverrides = new Map();
  const overridesFor = (ownerKind, field) => {
    if (ownerKind === 'chain') {
      return field === 'shortcut' ? chainShortcutOverrides : chainShortcutInsertOverrides;
    }
    return field === 'shortcut' ? shortcutOverrides : shortcutInsertOverrides;
  };
  // Staged overrides for the built-in system shortcuts (SYSTEM_ACTIONS
  // in shortcuts.js). `has(id)` means the dialog has a pending change;
  // `get(id)` returns the new value (empty string → revert to default on
  // save). Entries missing from the map are untouched on Save.
  /** @type {Map<string, string>} */
  const systemShortcutOverrides = new Map();
  const shortcutsList = $('#set-shortcuts-list');
  const shortcutsHint = $('#set-shortcuts-hint');
  const shortcutsEmpty = $('#set-shortcuts-empty');
  const chainShortcutsList = $('#set-chain-shortcuts-list');
  const chainShortcutsHint = $('#set-chain-shortcuts-hint');
  const chainShortcutsEmpty = $('#set-chain-shortcuts-empty');
  const effectiveValue = (ownerKind, item, field) => {
    const map = overridesFor(ownerKind, field);
    return map.has(item.id) ? map.get(item.id) : item[field] || '';
  };

  // Build synthetic snapshots of `state.snippets` / `state.chains` with pending
  // overrides applied — conflict checks need to see the "after Save" state so
  // a combo the user just freed on one row is correctly seen as available.
  const pendingSnippets = () =>
    state.snippets.map((other) => ({
      ...other,
      shortcut: shortcutOverrides.has(other.id)
        ? shortcutOverrides.get(other.id)
        : other.shortcut,
      shortcutInsert: shortcutInsertOverrides.has(other.id)
        ? shortcutInsertOverrides.get(other.id)
        : other.shortcutInsert,
    }));
  const pendingChains = () =>
    state.chains.map((other) => ({
      ...other,
      shortcut: chainShortcutOverrides.has(other.id)
        ? chainShortcutOverrides.get(other.id)
        : other.shortcut,
      shortcutInsert: chainShortcutInsertOverrides.has(other.id)
        ? chainShortcutInsertOverrides.get(other.id)
        : other.shortcutInsert,
    }));
  // Effective system-shortcut map merging saved settings with any changes
  // staged in the dialog. Reflects the "after Save" state so conflict
  // detection doesn't flag a combo the user has just freed on another row.
  const pendingSystemBindings = () => {
    /** @type {Record<string, string | null>} */
    const merged = { ...(settings.systemShortcuts || {}) };
    for (const [id, combo] of systemShortcutOverrides) {
      if (combo === '') delete merged[id]; // revert to default
      else merged[id] = combo;
    }
    return effectiveSystemShortcuts({ systemShortcuts: merged });
  };

  /**
   * Wire one input + clear + warn triple for a single (item, field) pair.
   * `ownerKind` is 'snippet' or 'chain' — routes conflict checks to ignore
   * the right item and picks the right override map.
   * Returns the DOM fragment and a repaint function the row can call after
   * sibling-field edits (so same-item cross-field conflicts surface in
   * both warnings).
   */
  const buildCaptureCell = (ownerKind, item, field, renderAll) => {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts-settings-cell';

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.className = 'shortcut-capture-input shortcuts-settings-input';
    const label =
      field === 'shortcutInsert' ? 'Insert shortcut' : 'Run shortcut';
    input.setAttribute('aria-label', `${label} for ${item.name}`);
    input.placeholder = 'Click, then press…';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.className = 'shortcuts-settings-clear';

    const warn = document.createElement('div');
    warn.className = 'shortcut-warning shortcuts-settings-warn';
    warn.hidden = true;

    const renderWarning = (combo, conflicts, hardBlocked, hardMsg) => {
      warn.replaceChildren();
      if (hardBlocked) {
        warn.classList.add('hard-block');
      } else {
        warn.classList.remove('hard-block');
      }
      if (!conflicts.length && !hardBlocked) {
        warn.hidden = true;
        return;
      }
      warn.hidden = false;
      const heading = document.createElement('strong');
      heading.textContent = hardBlocked
        ? `Can't use ${formatShortcut(combo)} — won't be saved.`
        : `${formatShortcut(combo)} will be saved and will override:`;
      warn.appendChild(heading);
      if (hardMsg) {
        const m = document.createElement('div');
        m.textContent = hardMsg;
        warn.appendChild(m);
      }
      if (conflicts.length) {
        if (hardBlocked) {
          const why = document.createElement('div');
          why.textContent = 'Already claimed by:';
          warn.appendChild(why);
        }
        const ul = document.createElement('ul');
        for (const c of conflicts) {
          const li = document.createElement('li');
          const tag =
            c.type === 'snippet'
              ? 'another snippet'
              : c.type === 'chain'
                ? 'another chain'
                : c.type === 'app'
                  ? 'an app shortcut'
                  : 'a system/browser shortcut';
          li.textContent = `${tag}: ${c.label}`;
          ul.appendChild(li);
        }
        warn.appendChild(ul);
      }
    };

    const conflictCtx = (field) => ({
      snippets: pendingSnippets(),
      chains: pendingChains(),
      systemBindings: pendingSystemBindings(),
      ignoreSnippetId: ownerKind === 'snippet' ? item.id : undefined,
      ignoreChainId: ownerKind === 'chain' ? item.id : undefined,
      ignoreField: field,
    });

    const refresh = () => {
      const cur = effectiveValue(ownerKind, item, field);
      input.value = cur ? formatShortcut(cur) : '';
      if (!cur) {
        renderWarning('', [], false);
        return;
      }
      const conflicts = findConflicts(cur, conflictCtx(field));
      renderWarning(cur, conflicts, false);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        overridesFor(ownerKind, field).set(item.id, '');
        renderAll();
        return;
      }
      const combo = normalizeShortcut(e);
      if (!combo) return;
      if (!isUsableCombo(combo)) {
        input.value = formatShortcut(combo);
        renderWarning(
          combo,
          [],
          true,
          'Needs a modifier plus a non-modifier key — or a bare function key (F1–F24). Try Ctrl / Alt / Cmd with any key, or Shift with a named key (Enter, Tab, Escape, Space).',
        );
        return;
      }
      const conflicts = findConflicts(combo, conflictCtx(field));
      if (conflicts.some((c) => c.blocking)) {
        input.value = formatShortcut(combo);
        renderWarning(combo, conflicts, true);
        return;
      }
      overridesFor(ownerKind, field).set(item.id, combo);
      // Re-render every row: both this item's sibling field and other
      // rows (across snippets and chains) may need their warnings refreshed
      // against the new pending map.
      renderAll();
    });

    clearBtn.onclick = (ev) => {
      ev.preventDefault();
      overridesFor(ownerKind, field).set(item.id, '');
      renderAll();
    };

    wrap.appendChild(input);
    wrap.appendChild(clearBtn);
    return { wrap, warn, refresh };
  };

  const renderOneList = ({
    ownerKind,
    items,
    listEl,
    hintEl,
    emptyEl,
    dispatchEdit,
    kindNoun,
  }) => {
    listEl.replaceChildren();
    // Only list items that currently have a shortcut bound — this section
    // is the "what do I already have bound?" view, not a discovery list.
    // New bindings are added from the item's Edit dialog. Sorted by name
    // so repeat visits find the same row in the same spot.
    const visible = items
      .filter(
        (it) =>
          effectiveValue(ownerKind, it, 'shortcut') ||
          effectiveValue(ownerKind, it, 'shortcutInsert'),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    hintEl.hidden = visible.length === 0;
    emptyEl.hidden = visible.length > 0;
    for (const it of visible) {
      const row = document.createElement('div');
      row.className = 'shortcuts-settings-row shortcuts-settings-row-dual';
      row.dataset[ownerKind === 'chain' ? 'chainId' : 'snippetId'] = it.id;

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'shortcuts-settings-name linklike';
      name.textContent = it.name;
      name.title = `Edit ${kindNoun} "${it.name}"`;
      name.onclick = (e) => {
        e.preventDefault();
        const targetId = it.id;
        dlg.close('save');
        dispatchEdit(targetId);
      };
      row.appendChild(name);

      const runCell = buildCaptureCell(ownerKind, it, 'shortcut', renderAll);
      const insertCell = buildCaptureCell(ownerKind, it, 'shortcutInsert', renderAll);
      const runLabel = document.createElement('div');
      runLabel.className = 'shortcuts-settings-cell-label muted';
      runLabel.textContent = 'Run on selection';
      const insertLabel = document.createElement('div');
      insertLabel.className = 'shortcuts-settings-cell-label muted';
      insertLabel.textContent = 'Insert at cursor';
      row.appendChild(runLabel);
      row.appendChild(runCell.wrap);
      row.appendChild(runCell.warn);
      row.appendChild(insertLabel);
      row.appendChild(insertCell.wrap);
      row.appendChild(insertCell.warn);
      runCell.refresh();
      insertCell.refresh();

      listEl.appendChild(row);
    }
  };
  const renderShortcutsList = () =>
    renderOneList({
      ownerKind: 'snippet',
      items: state.snippets,
      listEl: shortcutsList,
      hintEl: shortcutsHint,
      emptyEl: shortcutsEmpty,
      dispatchEdit: (/** @type {string} */ id) => dispatch('settings:edit-snippet', { snippetId: id }),
      kindNoun: 'snippet',
    });
  const renderChainShortcutsList = () =>
    renderOneList({
      ownerKind: 'chain',
      items: state.chains,
      listEl: chainShortcutsList,
      hintEl: chainShortcutsHint,
      emptyEl: chainShortcutsEmpty,
      dispatchEdit: (/** @type {string} */ id) => dispatch('settings:edit-chain', { chainId: id }),
      kindNoun: 'chain',
    });

  /**
   * Build a single-combo capture cell for a system action. Mirrors
   * `buildCaptureCell` but simpler: one field per action (no Run/Insert
   * split), storage keyed by action id in `systemShortcutOverrides`, and
   * the "Reset" button stages a revert-to-default (empty-string override)
   * rather than clearing entirely.
   */
  const buildSystemCaptureCell = (action) => {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts-settings-cell';

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.className = 'shortcut-capture-input shortcuts-settings-input';
    input.setAttribute('aria-label', `Shortcut for ${action.label}`);
    input.placeholder = 'Click, then press…';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Revert this shortcut to its default';
    resetBtn.className = 'shortcuts-settings-clear';

    const warn = document.createElement('div');
    warn.className = 'shortcut-warning shortcuts-settings-warn';
    warn.hidden = true;

    const renderWarning = (combo, conflicts, hardBlocked, hardMsg) => {
      warn.replaceChildren();
      if (hardBlocked) warn.classList.add('hard-block');
      else warn.classList.remove('hard-block');
      if (!conflicts.length && !hardBlocked) {
        warn.hidden = true;
        return;
      }
      warn.hidden = false;
      const heading = document.createElement('strong');
      heading.textContent = hardBlocked
        ? `Can't use ${formatShortcut(combo)} — won't be saved.`
        : `${formatShortcut(combo)} will be saved and will override:`;
      warn.appendChild(heading);
      if (hardMsg) {
        const m = document.createElement('div');
        m.textContent = hardMsg;
        warn.appendChild(m);
      }
      if (conflicts.length) {
        if (hardBlocked) {
          const why = document.createElement('div');
          why.textContent = 'Already claimed by:';
          warn.appendChild(why);
        }
        const ul = document.createElement('ul');
        for (const c of conflicts) {
          const li = document.createElement('li');
          const tag =
            c.type === 'snippet'
              ? 'another snippet'
              : c.type === 'chain'
                ? 'another chain'
                : c.type === 'app'
                  ? 'another app shortcut'
                  : 'a system/browser shortcut';
          li.textContent = `${tag}: ${c.label}`;
          ul.appendChild(li);
        }
        warn.appendChild(ul);
      }
    };

    const conflictCtx = () => ({
      snippets: pendingSnippets(),
      chains: pendingChains(),
      systemBindings: pendingSystemBindings(),
      ignoreSystemActionId: action.id,
    });

    // Effective combo for this row, after merging the saved settings and
    // any pending dialog edit. An empty-string override means "revert to
    // default on save" — surface the default here so the user sees what
    // Save will actually produce.
    const effectiveCombo = () => {
      if (systemShortcutOverrides.has(action.id)) {
        const staged = systemShortcutOverrides.get(action.id);
        if (staged === '') return defaultSystemCombo(action.id) || '';
        return staged || '';
      }
      const saved = settings.systemShortcuts?.[action.id];
      if (saved === '' || saved === null) return '';
      if (typeof saved === 'string') return saved;
      return defaultSystemCombo(action.id) || '';
    };

    const refresh = () => {
      const cur = effectiveCombo();
      input.value = cur ? formatShortcut(cur) : '';
      if (!cur) {
        renderWarning('', [], false);
        return;
      }
      const conflicts = findConflicts(cur, conflictCtx());
      renderWarning(cur, conflicts, false);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Delete/Backspace on a system row = revert to default (staged as
        // empty string — the save path turns that into `delete` so the
        // stored settings stay clean).
        systemShortcutOverrides.set(action.id, '');
        renderAll();
        return;
      }
      const combo = normalizeShortcut(e);
      if (!combo) return;
      if (!isUsableCombo(combo)) {
        input.value = formatShortcut(combo);
        renderWarning(
          combo,
          [],
          true,
          'Needs a modifier plus a non-modifier key — or a bare function key (F1–F24). Try Ctrl / Alt / Cmd with any key, or Shift with a named key (Enter, Tab, Escape, Space).',
        );
        return;
      }
      const conflicts = findConflicts(combo, conflictCtx());
      if (conflicts.some((c) => c.blocking)) {
        input.value = formatShortcut(combo);
        renderWarning(combo, conflicts, true);
        return;
      }
      systemShortcutOverrides.set(action.id, combo);
      renderAll();
    });

    resetBtn.onclick = (ev) => {
      ev.preventDefault();
      systemShortcutOverrides.set(action.id, '');
      renderAll();
    };

    wrap.appendChild(input);
    wrap.appendChild(resetBtn);
    return { wrap, warn, refresh };
  };

  const renderSystemShortcutsList = () => {
    const listEl = $('#set-system-shortcuts-list');
    if (!listEl) return;
    listEl.replaceChildren();
    for (const action of SYSTEM_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'shortcuts-settings-row';
      if (action.derivedFrom) row.classList.add('shortcuts-settings-row-derived');
      row.dataset.systemAction = action.id;

      const name = document.createElement('div');
      name.className = 'shortcuts-settings-name';
      name.textContent = action.label;
      const def = defaultSystemCombo(action.id);
      if (def) name.title = `Default: ${formatShortcut(def)}`;
      if (action.hint) {
        const hint = document.createElement('div');
        hint.className = 'muted shortcuts-system-hint';
        hint.textContent = action.hint;
        name.appendChild(hint);
      }

      row.appendChild(name);
      if (action.derivedFrom) {
        // Read-only display of the parent action's currently-effective
        // combo. The settings live-update the parent every save, so the
        // derived row always reflects whatever the user has bound as
        // their openPalette shortcut (for instance).
        const cell = buildDerivedSystemCell(action);
        row.appendChild(cell.wrap);
      } else {
        const cell = buildSystemCaptureCell(action);
        row.appendChild(cell.wrap);
        row.appendChild(cell.warn);
        cell.refresh();
      }
      listEl.appendChild(row);
    }
  };

  /**
   * Render a derived system action as a non-interactive display row:
   * a greyed input showing the parent action's effective combo. No
   * capture listener, no Reset button — the user configures this
   * shortcut via the parent row instead.
   */
  const buildDerivedSystemCell = (action) => {
    const wrap = document.createElement('div');
    wrap.className = 'shortcuts-settings-cell';

    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.disabled = true;
    input.className = 'shortcut-capture-input shortcuts-settings-input shortcut-derived';
    input.setAttribute('aria-label', `Shortcut for ${action.label} (derived)`);
    // Resolve against pendingSystemBindings so the display updates as the
    // user edits the parent row — no flicker between "what you typed"
    // and "what will be saved".
    const bindings = pendingSystemBindings();
    const parentCombo = bindings.get(action.derivedFrom) || '';
    input.value = parentCombo ? formatShortcut(parentCombo) : '(none)';

    wrap.appendChild(input);
    return { wrap };
  };

  // Changes in any list can invalidate conflict warnings in the others,
  // so all three render functions always run together.
  const renderAll = () => {
    renderShortcutsList();
    renderChainShortcutsList();
    renderSystemShortcutsList();
  };
  renderAll();

  $('#set-reset').onclick = async (e) => {
    e.preventDefault();
    const ok = await appConfirm('Reset all settings to defaults?', {
      title: 'Reset settings',
      danger: true,
      okLabel: 'Reset',
    });
    if (!ok) return;
    settings = /** @type {Settings} */ (structuredClone(DEFAULT_SETTINGS));
    saveSettings();
    applySettings();
    dispatch('settings-saved');
    dlg.close('save');
  };

  $('#set-reset-app').onclick = async (e) => {
    e.preventDefault();
    const ok = await appConfirm(
      'Wipe all app data — snippets, chains, templates, tabs, settings, and UI preferences — then reload. This cannot be undone. Export your library first if you want a backup.',
      { title: 'Reset application', danger: true, okLabel: 'Reset everything' },
    );
    if (!ok) return;
    // Latch the reset flag FIRST — this makes saveState() a no-op so the
    // `beforeunload` handler (and any still-pending debounced save) can't
    // rewrite the library back under LS_KEY after we've cleared it.
    beginAppReset();
    // Remove every key this app has ever written. The shared `awk-estra-`
    // prefix means we can clear only our own entries and leave other apps on
    // the same origin alone. Reload immediately afterwards so in-memory state
    // doesn't get a chance to repopulate localStorage via saveState().
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('awk-estra-')) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
    location.reload();
  };

  // Settings filter: live substring match over each fieldset's children
  // (label text + `title=` tooltips + legend). Each fieldset's `.label-text`
  // header is grouped with its following `.settings-inline` row so the
  // "Sections expanded by default" header doesn't disappear while its
  // checkboxes stay visible (or vice versa). If a legend matches, the whole
  // fieldset stays visible regardless of child match. Empty query → show all.
  const searchInput = /** @type {HTMLInputElement} */ ($('#set-search'));
  const searchEmpty = $('#set-search-empty');
  searchInput.value = '';
  const form = dlg.querySelector('form');

  /** @param {HTMLFieldSetElement} fs */
  const chunkFieldset = (fs) => {
    /** @type {HTMLElement[][]} */
    const chunks = [];
    /** @type {HTMLElement[] | null} */
    let pending = null;
    for (const child of /** @type {HTMLCollectionOf<HTMLElement>} */ (fs.children)) {
      if (child.tagName === 'LEGEND') continue;
      if (child.classList.contains('label-text')) {
        if (pending) chunks.push(pending);
        pending = [child];
        continue;
      }
      if (child.classList.contains('settings-inline') && pending) {
        pending.push(child);
        chunks.push(pending);
        pending = null;
        continue;
      }
      if (pending) {
        chunks.push(pending);
        pending = null;
      }
      chunks.push([child]);
    }
    if (pending) chunks.push(pending);
    return chunks;
  };

  const applyFilter = () => {
    const q = searchInput.value.trim().toLowerCase();
    // Split the query on whitespace so "show line numbers" matches any
    // ordering — previously the whole query had to appear as one
    // literal substring, so "line numbers show" would miss the
    // obviously-intended setting. Empty tokens are dropped (double
    // spaces, leading / trailing whitespace).
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const hasQuery = terms.length > 0;
    // Flashing is only useful once the query is specific enough to point
    // at a real token — a single char lights up almost every row. Wait
    // until the query reaches 3 chars before flashing at all.
    const flashReady = q.length >= 3;
    let anyFieldsetVisible = false;
    for (const fs of /** @type {NodeListOf<HTMLFieldSetElement>} */ (
      form.querySelectorAll('fieldset')
    )) {
      const legendText = (fs.querySelector('legend')?.textContent || '').toLowerCase();
      const legendMatch = hasQuery && terms.every((t) => legendText.includes(t));
      let anyChunkVisible = false;
      for (const chunk of chunkFieldset(fs)) {
        let text = '';
        for (const el of chunk) {
          text += ' ' + (el.textContent || '');
          // `title=` tooltips are searchable too — so a terse label can still
          // be found by words from its description.
          for (const withTitle of el.querySelectorAll('[title]')) {
            text += ' ' + withTitle.getAttribute('title');
          }
          if (el.hasAttribute('title')) text += ' ' + el.getAttribute('title');
        }
        const lcText = text.toLowerCase();
        const chunkMatch = !hasQuery || terms.every((t) => lcText.includes(t));
        const show = !hasQuery || legendMatch || chunkMatch;
        // Only touch elements the filter itself previously hid — tagged
        // with `data-filter-hid`. Otherwise a non-matching chunk would
        // forcibly unhide elements whose `hidden` state is managed
        // elsewhere (e.g. `#set-shortcuts-hint`, which `renderOneList`
        // hides when there are no bound shortcuts so the empty-state
        // message can stand alone).
        for (const el of chunk) {
          if (show) {
            if (el.dataset.filterHid === '1') {
              el.hidden = false;
              delete el.dataset.filterHid;
            }
          } else if (!el.hidden) {
            el.hidden = true;
            el.dataset.filterHid = '1';
          }
        }
        if (show) anyChunkVisible = true;
        // Flash the matching chunk so the eye finds it inside an
        // otherwise-expanded fieldset. Re-triggered on every keystroke
        // for as long as the chunk keeps matching — the animation is
        // short and subtle, so rapid-typing looks like a sustained
        // highlight; stopping lets the last flash play out. Only flash
        // chunks that matched on their own text (not fieldsets revealed
        // by a legend match, which could highlight every row).
        const firstEl = chunk[0];
        if (firstEl) {
          if (show && flashReady && chunkMatch) {
            firstEl.classList.remove('settings-match-flash');
            // Reflow so the animation restarts cleanly when the class
            // is re-added within the same frame.
            void (/** @type {HTMLElement} */ (firstEl)).offsetWidth;
            firstEl.classList.add('settings-match-flash');
          } else {
            firstEl.classList.remove('settings-match-flash');
          }
        }
      }
      fs.hidden = hasQuery && !legendMatch && !anyChunkVisible;
      if (!fs.hidden) anyFieldsetVisible = true;
    }
    searchEmpty.hidden = !hasQuery || anyFieldsetVisible;
  };
  searchInput.oninput = applyFilter;
  applyFilter();

  dlg.returnValue = '';
  dlg.showModal();
  // Start each open at the top. Two things fight us:
  //   1. The dialog's scroll container remembers the previous session's
  //      scrollTop across showModal() calls.
  //   2. showModal() auto-focuses the first focusable element; if that
  //      element is off-screen the browser scrolls to bring it into
  //      view, which beats a synchronous scrollTop reset.
  // Resolution: reset after the autofocus settles (rAF) and again after
  // any layout jolt from the initial render.
  if (!opts.scrollTo) {
    dlg.scrollTop = 0;
    requestAnimationFrame(() => {
      dlg.scrollTop = 0;
      requestAnimationFrame(() => { dlg.scrollTop = 0; });
    });
  }
  if (opts.scrollTo) {
    const target = /** @type {HTMLElement | null} */ (dlg.querySelector(`#${opts.scrollTo}`));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('settings-section-flash');
      setTimeout(() => target.classList.remove('settings-section-flash'), 1500);
    }
  }
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') {
      // Unsaved close: roll back any theme / font-family preview the
      // user triggered via the live-preview listeners above. Without
      // this, closing with Esc / the backdrop would leave the
      // previewed value in place even though `settings.editor` /
      // `settings.ui` still hold the originals.
      if (themeSelect.value !== originalTheme) {
        // Resolve originalTheme in case it was 'auto' — writing 'auto'
        // directly to data-theme wouldn't match any theme file.
        document.documentElement.dataset.theme = resolveTheme(originalTheme);
      }
      previewFontFamily(originalFontFamily);
      previewFontSize(originalFontSize);
      applyDensity(originalDensity);
      return;
    }
    settings.exec.binary = binarySelect.value;
    settings.exec.args = $('#set-args')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    settings.exec.timeoutMs = clampInt($('#set-timeout').value, 100, 60000, 5000);
    settings.exec.maxOutputBytes = clampInt($('#set-max-output').value, 1024, 52428800, 1048576);

    settings.editor.tabSize = clampInt($('#set-tab-size').value, 1, 8, 4);
    settings.editor.fontSize = clampInt($('#set-font-size').value, 8, 32, 13);
    {
      // Dropdown value is either a preset CSS string or the Custom
      // sentinel. On Custom, read the text input. Empty-after-trim
      // (from either branch) stores '' so applySettings removes the
      // var and the CSS fallback stack wins.
      const sel = /** @type {HTMLSelectElement} */ ($('#set-font-family'));
      const customInput = /** @type {HTMLInputElement} */ ($('#set-font-family-custom'));
      const chosen =
        sel.value === FONT_FAMILY_CUSTOM_SENTINEL ? customInput.value.trim() : sel.value;
      settings.editor.fontFamily = chosen;
    }
    settings.editor.defaultNewTabText = $('#set-default-tab-text').value;
    settings.editor.confirmCloseTabWithContent = $('#set-confirm-close').checked;
    {
      const sep = $('#set-tab-merge-separator').value;
      settings.editor.tabMergeSeparator =
        sep === 'newline' || sep === 'none' ? sep : 'dash';
    }
    settings.editor.confirmClearProgram = $('#set-confirm-clear-program').checked;
    settings.editor.confirmClearHistory = $('#set-confirm-clear-history').checked;
    settings.editor.lineNumbers = $('#set-line-numbers').checked;
    settings.editor.stripTrailingNewline = $('#set-strip-trailing-newline').checked;
    settings.editor.paletteEnterApplies = $('#set-palette-enter-applies').checked;
    settings.editor.defaultWordWrap = $('#set-default-wrap').value;

    settings.ui.theme = $('#set-theme').value;
    {
      const v = $('#set-density').value;
      settings.ui.density = v === 'compact' || v === 'roomy' ? v : 'normal';
    }
    settings.ui.defaultSidebarWidth = clampInt($('#set-sidebar-width').value, 150, 600, 260);
    settings.ui.referenceDefaultShown = $('#set-ref-default-shown').checked;
    settings.ui.paletteDefaultAdvanced = $('#set-palette-default-advanced').checked;
    settings.ui.showRestoreDefaults = $('#set-show-restore-defaults').checked;
    settings.ui.showRunAllTests = $('#set-show-run-all-tests').checked;
    settings.ui.dragToTagMode = $('#set-drag-to-tag-mode').value === 'move' ? 'move' : 'add';
    {
      const v = $('#set-runner-scope').value;
      settings.ui.runnerScope = v === 'snippets' || v === 'chains' ? v : 'both';
    }
    settings.ui.highlightGawkExtensions = $('#set-highlight-gawk').checked;
    settings.ui.warnGawkOnly = $('#set-warn-gawk-only').checked;
    settings.ui.showGawkButtons = $('#set-show-gawk-buttons').checked;
    settings.ui.showFormatButton = $('#set-show-format-button').checked;
    settings.ui.formatReplaceTabs = $('#set-format-replace-tabs').checked;
    settings.ui.formatTabSpaces = clampInt($('#set-format-tab-spaces').value, 1, 8, 2);
    if (!settings.ui.sectionsExpanded) settings.ui.sectionsExpanded = {};
    for (const cb of /** @type {NodeListOf<HTMLInputElement>} */ (
      document.querySelectorAll('[data-section-default]')
    )) {
      settings.ui.sectionsExpanded[cb.dataset.sectionDefault] = cb.checked;
    }
    if (!settings.ui.paletteSectionsExpanded) settings.ui.paletteSectionsExpanded = {};
    for (const cb of /** @type {NodeListOf<HTMLInputElement>} */ (
      document.querySelectorAll('[data-palette-section-default]')
    )) {
      settings.ui.paletteSectionsExpanded[cb.dataset.paletteSectionDefault] = cb.checked;
    }

    settings.pipeline.autoPreviewOnStepChange = $('#set-auto-preview').checked;
    settings.pipeline.onError = $('#set-on-error').value;
    settings.pipeline.clearOutputsOnSelectionChange = $('#set-clear-on-sel').checked;
    settings.pipeline.acceptDefaultsWithoutPrompting = $('#set-accept-defaults').checked;

    // Script export — `buildShellScriptFromTemplate` in pipeline.js
    // consults these on every Download script click.
    if (!settings.scriptExport) settings.scriptExport = { ...DEFAULT_SETTINGS.scriptExport };
    settings.scriptExport.flatten = scriptFlattenCb.checked;
    settings.scriptExport.extension = scriptExtensionIn.value;
    settings.scriptExport.template = scriptTemplateTa.value;

    settings.data.saveDebounceMs = clampInt($('#set-save-debounce').value, 0, 5000, 400);
    settings.preview.maxLines = clampInt($('#set-preview-max-lines').value, 0, 1000000, 0);
    if (!settings.tests) settings.tests = { runOnSave: false, showUnknownStatus: false };
    settings.tests.runOnSave = $('#set-tests-run-on-save').checked;
    settings.tests.showUnknownStatus = $('#set-tests-show-unknown').checked;
    if (!settings.safety)
      settings.safety = {
        requireManualPreview: false,
        autoPreviewSideEffects: false,
        forbiddenPatterns: [],
        tests: [],
      };
    settings.safety.requireManualPreview = $('#set-safety-manual-preview').checked;
    settings.safety.autoPreviewSideEffects = $('#set-safety-auto-side-effects').checked;
    settings.safety.tests = workingSafetyTests
      .filter((t) => t.text.trim())
      .map((t) => ({ id: t.id, text: t.text, expect: t.expect }));
    // Preserve blank lines and `#` comments so the list stays readable
    // across Save/Load round-trips. findForbiddenMatches skips both.
    settings.safety.forbiddenPatterns = $('#set-safety-forbidden')
      .value.split('\n')
      .map((s) => s.trim());
    while (
      settings.safety.forbiddenPatterns.length &&
      !settings.safety.forbiddenPatterns[settings.safety.forbiddenPatterns.length - 1]
    ) {
      settings.safety.forbiddenPatterns.pop();
    }

    // Commit the edited preset lists via the presets-editor helper
    // (strips empty-label / empty-value rows, regenerates duplicate
    // ids, writes back to `settings.presets`).
    presetsEditor.commit();

    // Commit staged system-shortcut overrides. Empty string = revert to
    // default (delete the key so it falls back); any other string is an
    // explicit override. Prune entries that collapse to the default so
    // the stored settings don't carry redundant rows.
    if (!settings.systemShortcuts) settings.systemShortcuts = {};
    for (const [id, combo] of systemShortcutOverrides) {
      if (combo === '' || combo === defaultSystemCombo(id)) {
        delete settings.systemShortcuts[id];
      } else {
        settings.systemShortcuts[id] = combo;
      }
    }

    // Commit staged snippet + chain shortcut changes. Empty string means
    // clear; a non-empty string assigns. Only persist / broadcast if
    // something actually changed, so the sidebar re-render doesn't run on
    // every Save. Both fields (`shortcut` and `shortcutInsert`) are
    // committed through the same path, for both snippets and chains.
    let snippetShortcutsChanged = false;
    for (const [map, field] of /** @type {const} */ ([
      [shortcutOverrides, 'shortcut'],
      [shortcutInsertOverrides, 'shortcutInsert'],
    ])) {
      for (const [id, combo] of map) {
        const sn = state.snippets.find((s) => s.id === id);
        if (!sn) continue;
        const prev = sn[field] || '';
        if (prev === combo) continue;
        if (combo) sn[field] = combo;
        else delete sn[field];
        snippetShortcutsChanged = true;
      }
    }
    let chainShortcutsChanged = false;
    for (const [map, field] of /** @type {const} */ ([
      [chainShortcutOverrides, 'shortcut'],
      [chainShortcutInsertOverrides, 'shortcutInsert'],
    ])) {
      for (const [id, combo] of map) {
        const ch = state.chains.find((c) => c.id === id);
        if (!ch) continue;
        const prev = ch[field] || '';
        if (prev === combo) continue;
        if (combo) ch[field] = combo;
        else delete ch[field];
        chainShortcutsChanged = true;
      }
    }
    if (snippetShortcutsChanged || chainShortcutsChanged) {
      saveState();
      if (snippetShortcutsChanged)
        dispatch('library:snippets-changed');
      if (chainShortcutsChanged)
        dispatch('library:chains-changed');
    }

    saveSettings();
    applySettings();
    dispatch('settings-saved');
  };
}
