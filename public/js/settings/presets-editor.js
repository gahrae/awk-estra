// @ts-check
// Presets editor for the Settings dialog — two collapsible sub-sections
// (Field patterns / Timestamp) each rendering a row per entry with
// drag-handle + label / value / description / per-row Reset / Delete.
//
// UI state is staged in a `workingPresets` map owned by this module's
// closure. Settings calls `setupPresetsEditor(settings)` once per dialog
// open (to wire the UI) and calls the returned `commit()` at Save time,
// which writes the staged working arrays back to `settings.presets`.
// Cancelling the dialog discards the working state implicitly — no
// explicit rollback is needed because the live `settings` object isn't
// touched until commit.

import { $, appConfirm } from '../core.js';
import { DEFAULT_FPAT_PRESETS, DEFAULT_STRFTIME_PRESETS } from '../data.js';

/**
 * @typedef {import('../types.js').PresetRow} PresetRow
 * @typedef {import('../types.js').Settings} Settings
 * @typedef {'fpat' | 'timestamp'} PresetKind
 */

/**
 * Wire the Presets editor rows, buttons, and live counters against the
 * Settings dialog's DOM. The caller passes in the live `settings`
 * reference so the initial working arrays are seeded from the user's
 * stored lists (falling back to defaults if the stored list is missing
 * or empty — matching the picker's fallback).
 *
 * Returns a `commit()` function that writes the staged edits back into
 * `settings.presets` when the user Saves the dialog. Empty-label and
 * empty-value rows are dropped (they'd render as unusable in the
 * picker); duplicate ids are regenerated.
 *
 * @param {Settings} settings
 * @returns {{ commit: () => void }}
 */
export function setupPresetsEditor(settings) {
  // Presets editor (FPAT + Timestamp). Each sub-section renders a row
  // per entry with three inputs (label / value / description) and a
  // delete button. Rows whose id matches a built-in default also get a
  // per-row "Reset row" button that appears only when the live edit
  // differs from the shipped default. Edits are staged in the working
  // array until Save; cancelling the dialog discards them.
  //
  // Mirrors the safety-tests pattern: DOM is rebuilt on structural
  // change (add / delete / reset), but text edits just repaint the
  // affected row's decoration so the typing `<input>` keeps focus.
  const presetsConfigs = /** @type {const} */ ([
    {
      kind: 'fpat',
      defaults: DEFAULT_FPAT_PRESETS,
      stored: settings.presets?.fpat,
      listEl: /** @type {HTMLElement} */ ($('#set-presets-fpat-list')),
      addBtn: /** @type {HTMLButtonElement} */ ($('#set-presets-fpat-add')),
      restoreBtn: /** @type {HTMLButtonElement} */ ($('#set-presets-fpat-restore')),
      groupEl: /** @type {HTMLDetailsElement} */ ($('#set-presets-fpat-group')),
      countEl: /** @type {HTMLElement} */ ($('#set-presets-fpat-count')),
      valuePlaceholder: '"[^"]*"|[^,]+',
      labelHint: 'e.g. CSV (quoted fields)',
      valueHint: 'Regex — matches one field. Emitted as `FPAT = "…"` in BEGIN.',
      descriptionHint: 'Shown under the preset dropdown. Describe what the pattern matches and any caveats.',
    },
    {
      kind: 'timestamp',
      defaults: DEFAULT_STRFTIME_PRESETS,
      stored: settings.presets?.timestamp,
      listEl: /** @type {HTMLElement} */ ($('#set-presets-timestamp-list')),
      addBtn: /** @type {HTMLButtonElement} */ ($('#set-presets-timestamp-add')),
      restoreBtn: /** @type {HTMLButtonElement} */ ($('#set-presets-timestamp-restore')),
      groupEl: /** @type {HTMLDetailsElement} */ ($('#set-presets-timestamp-group')),
      countEl: /** @type {HTMLElement} */ ($('#set-presets-timestamp-count')),
      valuePlaceholder: '%Y-%m-%dT%H:%M:%S%z',
      labelHint: 'e.g. ISO 8601 date',
      valueHint: 'strftime format string. Emitted as `strftime("…")`.',
      descriptionHint: 'Shown under the preset dropdown. Describe the format and any sort caveats.',
    },
  ]);

  // One working array per kind, seeded from current settings (or from
  // defaults if the stored list is missing / empty — matches what the
  // picker would show). Edits mutate these arrays in place; on Save we
  // write them back to settings.presets.
  /** @type {Record<string, PresetRow[]>} */
  const workingPresets = { fpat: [], timestamp: [] };
  for (const cfg of presetsConfigs) {
    const seed = Array.isArray(cfg.stored) && cfg.stored.length ? cfg.stored : cfg.defaults;
    workingPresets[cfg.kind] = seed.map((p) => ({
      id: p.id || `preset-${Math.random().toString(36).slice(2, 10)}`,
      label: p.label || '',
      pattern: p.pattern || '',
      description: p.description || '',
    }));
  }

  /**
   * Look up a row in the shipped defaults for this kind. Returns null if
   * the row was user-added (its id doesn't correspond to a built-in).
   */
  const findDefault = (kind, id) => {
    const cfg = presetsConfigs.find((c) => c.kind === kind);
    if (!cfg) return null;
    return cfg.defaults.find((p) => p.id === id) || null;
  };

  /** Row is a built-in that the user has modified in any field. */
  const rowDiffersFromDefault = (kind, row) => {
    const def = findDefault(kind, row.id);
    if (!def) return false;
    return (
      row.label !== def.label ||
      row.pattern !== def.pattern ||
      row.description !== def.description
    );
  };

  const buildPresetRow = (cfg, row, rebuild) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'preset-row';

    // Drag handle — only the handle is draggable (inputs still handle
    // text selection normally). dataTransfer carries the source row's
    // current index into the working array; `drop` on any other row
    // splices the moved row into that target position and rebuilds.
    //
    // Lookup at dragstart/drop time rather than closure-captured index,
    // so the handler stays correct after the user adds or deletes rows
    // between renders (rebuildPresetList regenerates the DOM, but an
    // in-flight drag could span an edit).
    const dragHandle = document.createElement('span');
    dragHandle.className = 'preset-drag';
    dragHandle.draggable = true;
    dragHandle.textContent = '⋮⋮';
    dragHandle.title = 'Drag to reorder';
    dragHandle.setAttribute('aria-label', 'Drag to reorder');
    dragHandle.addEventListener('dragstart', (e) => {
      const from = workingPresets[cfg.kind].indexOf(row);
      if (from < 0) return;
      e.dataTransfer.setData('text/plain', `${cfg.kind}:${from}`);
      e.dataTransfer.effectAllowed = 'move';
      rowEl.classList.add('dragging');
    });
    dragHandle.addEventListener('dragend', () => rowEl.classList.remove('dragging'));
    rowEl.addEventListener('dragover', (e) => {
      // Only allow drops originating from the same preset group; other
      // drags (e.g. tab reorders in the main editor) would otherwise
      // flash a drop indicator here. `types` is the only pre-drop hook
      // that lets us gate on content, but it can't read the payload,
      // so we also re-verify the prefix at drop time.
      if (!Array.from(e.dataTransfer.types).includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      rowEl.classList.add('drag-over');
    });
    rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drag-over'));
    rowEl.addEventListener('drop', (e) => {
      rowEl.classList.remove('drag-over');
      const payload = e.dataTransfer.getData('text/plain') || '';
      const [kind, fromStr] = payload.split(':');
      if (kind !== cfg.kind) return; // foreign drag — ignore
      e.preventDefault();
      const arr = workingPresets[cfg.kind];
      const from = parseInt(fromStr, 10);
      const to = arr.indexOf(row);
      if (!Number.isInteger(from) || from < 0 || to < 0 || from === to) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      rebuild();
    });

    const labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.className = 'preset-label';
    labelIn.placeholder = cfg.labelHint;
    labelIn.value = row.label;
    labelIn.spellcheck = false;
    labelIn.autocomplete = 'off';
    labelIn.setAttribute('aria-label', 'Preset label');
    labelIn.oninput = () => {
      row.label = labelIn.value;
      updateResetVisibility();
      updatePresetCount(cfg);
    };

    const valueIn = document.createElement('input');
    valueIn.type = 'text';
    valueIn.className = 'preset-value';
    valueIn.placeholder = cfg.valuePlaceholder;
    valueIn.value = row.pattern;
    valueIn.spellcheck = false;
    valueIn.autocomplete = 'off';
    valueIn.setAttribute('aria-label', 'Preset value');
    valueIn.title = cfg.valueHint;
    valueIn.oninput = () => {
      row.pattern = valueIn.value;
      updateResetVisibility();
      updatePresetCount(cfg);
    };

    const descIn = document.createElement('textarea');
    descIn.className = 'preset-description';
    descIn.rows = 2;
    descIn.placeholder = cfg.descriptionHint;
    descIn.value = row.description;
    descIn.spellcheck = true;
    descIn.setAttribute('aria-label', 'Preset description');
    descIn.oninput = () => {
      row.description = descIn.value;
      updateResetVisibility();
      updatePresetCount(cfg);
    };

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'preset-reset';
    resetBtn.textContent = 'Reset row';
    resetBtn.title = 'Restore this built-in row to its shipped default';
    resetBtn.onclick = (e) => {
      e.preventDefault();
      const def = findDefault(cfg.kind, row.id);
      if (!def) return;
      row.label = def.label;
      row.pattern = def.pattern;
      row.description = def.description;
      labelIn.value = def.label;
      valueIn.value = def.pattern;
      descIn.value = def.description;
      updateResetVisibility();
      updatePresetCount(cfg);
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'preset-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete this preset';
    delBtn.onclick = (e) => {
      e.preventDefault();
      const arr = workingPresets[cfg.kind];
      const i = arr.indexOf(row);
      if (i >= 0) arr.splice(i, 1);
      rebuild();
    };

    const updateResetVisibility = () => {
      resetBtn.hidden = !rowDiffersFromDefault(cfg.kind, row);
    };
    updateResetVisibility();

    actions.appendChild(resetBtn);
    actions.appendChild(delBtn);

    rowEl.appendChild(dragHandle);
    rowEl.appendChild(labelIn);
    rowEl.appendChild(valueIn);
    rowEl.appendChild(descIn);
    rowEl.appendChild(actions);
    return rowEl;
  };

  const updatePresetCount = (cfg) => {
    const arr = workingPresets[cfg.kind];
    const modified = arr.filter((r) => rowDiffersFromDefault(cfg.kind, r)).length;
    const parts = [`${arr.length} preset${arr.length === 1 ? '' : 's'}`];
    if (modified) parts.push(`${modified} modified`);
    cfg.countEl.textContent = `· ${parts.join(', ')}`;
  };

  const rebuildPresetList = (cfg) => {
    cfg.listEl.replaceChildren();
    const arr = workingPresets[cfg.kind];
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.className = 'tests-empty muted';
      empty.textContent =
        'No presets yet. Click + Add preset to create one, or Restore defaults to bring back the shipped set.';
      cfg.listEl.appendChild(empty);
      updatePresetCount(cfg);
      return;
    }
    const rebuild = () => rebuildPresetList(cfg);
    for (const row of arr) {
      cfg.listEl.appendChild(buildPresetRow(cfg, row, rebuild));
    }
    updatePresetCount(cfg);
  };

  for (const cfg of presetsConfigs) {
    rebuildPresetList(cfg);

    cfg.addBtn.onclick = (e) => {
      e.preventDefault();
      workingPresets[cfg.kind].push({
        id: `preset-${Math.random().toString(36).slice(2, 10)}`,
        label: '',
        pattern: '',
        description: '',
      });
      rebuildPresetList(cfg);
      // Expand the group so the new row is visible — Add inside a
      // collapsed <details> would otherwise scroll offscreen.
      if (!cfg.groupEl.open) cfg.groupEl.open = true;
      // Focus the new row's label input so the user can start typing.
      const rows = cfg.listEl.querySelectorAll('.preset-label');
      const last = /** @type {HTMLInputElement | null} */ (rows[rows.length - 1]);
      if (last) last.focus();
    };

    cfg.restoreBtn.onclick = async (e) => {
      e.preventDefault();
      const ok = await appConfirm(
        `Restore ${cfg.kind === 'fpat' ? 'field-pattern' : 'timestamp'} presets to the shipped defaults? Your user-added presets and any edits to built-in rows will be discarded.`,
        { title: 'Restore presets', danger: true, okLabel: 'Restore' },
      );
      if (!ok) return;
      workingPresets[cfg.kind] = cfg.defaults.map((p) => ({ ...p }));
      rebuildPresetList(cfg);
    };

    // Gated by `showRestoreDefaults` — matches the seed-library pattern.
    // Reads the live checkbox state so toggling inside the dialog reveals
    // the buttons without needing a Save + reopen.
    const showRestoreCb = /** @type {HTMLInputElement} */ ($('#set-show-restore-defaults'));
    const syncRestoreVisibility = () => {
      cfg.restoreBtn.hidden = !showRestoreCb.checked;
    };
    syncRestoreVisibility();
    showRestoreCb.addEventListener('change', syncRestoreVisibility);
  }

  /**
   * Commit the edited preset lists back to `settings.presets`. Rows
   * with an empty label or value are dropped — they'd render as
   * unusable entries in the picker. Duplicate ids (which could happen
   * after Restore defaults + manual add combinations) are regenerated
   * to keep the picker's id-keyed lookups unambiguous.
   *
   * Writes to the same `settings` reference passed at construction.
   */
  const commit = () => {
    if (!settings.presets) settings.presets = { fpat: [], timestamp: [] };
    for (const kind of /** @type {const} */ (['fpat', 'timestamp'])) {
      const seen = new Set();
      settings.presets[kind] = workingPresets[kind]
        .map((p) => ({
          id: p.id,
          label: (p.label || '').trim(),
          pattern: p.pattern || '',
          description: (p.description || '').trim(),
        }))
        .filter((p) => p.label && p.pattern)
        .map((p) => {
          let id = p.id;
          while (seen.has(id)) id = `preset-${Math.random().toString(36).slice(2, 10)}`;
          seen.add(id);
          return { ...p, id };
        });
    }
  };

  return { commit };
}
