// @ts-check
// Export and import the library (snippets + chains + text snippets + templates)
// as a single JSON file. Duplicates are skipped by name within each type.

import { uid, appAlert, appConfirm } from './core.js';
import { state, saveState, normalizeTags, ensureChainStepIds } from './state.js';

/**
 * Schema version the current exporter produces and importer understands.
 * Bump when the on-disk shape changes. A loaded file with a strictly
 * higher version is rejected (we can't safely guess at fields we don't
 * know how to read); missing / older versions prompt the user to confirm,
 * so a legacy export still round-trips when the shape is compatible.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * Classify an imported payload's `version` field against the
 * build-supported schema version. Returns one of:
 *   - `'ok'`          — version matches or is an older known version.
 *   - `'future'`      — version is strictly higher; import MUST be refused.
 *   - `'unversioned'` — version missing / non-numeric; caller should
 *                       confirm with the user before proceeding.
 *
 * Pure function. Exported so unit tests can exercise every branch
 * without having to wire up the file-picker + confirm-dialog plumbing.
 *
 * @param {unknown} parsed  the JSON.parse'd file body
 * @param {number} [supported]  defaults to the current build's
 *   EXPORT_SCHEMA_VERSION
 * @returns {'ok' | 'future' | 'unversioned'}
 */
export function classifyImportVersion(parsed, supported = EXPORT_SCHEMA_VERSION) {
  const v =
    parsed && typeof parsed === 'object' && typeof (/** @type {any} */ (parsed)).version === 'number'
      ? /** @type {any} */ (parsed).version
      : null;
  if (v === null) return 'unversioned';
  if (v > supported) return 'future';
  return 'ok';
}

export function exportState() {
  const data = {
    snippets: state.snippets,
    chains: state.chains,
    textSnippets: state.textSnippets,
    templates: state.templates,
    version: EXPORT_SCHEMA_VERSION,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'awk-estra-library.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function importState(onAfterImport) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // Schema-version gate. A strictly-higher version from the future is
      // rejected outright — we can't guarantee the shape hasn't shifted
      // in a way that would silently drop or corrupt fields we now
      // interpret differently. A missing / older version is more
      // forgiving: prompt once, let the user accept or cancel.
      const classification = classifyImportVersion(data);
      if (classification === 'future') {
        appAlert(
          `This file was written by a newer version of awk-estra (schema v${data.version}; this build supports up to v${EXPORT_SCHEMA_VERSION}). ` +
            'Update awk-estra before importing, or open the file in a matching build and re-export.',
          { title: 'Import aborted', level: 'error' },
        );
        return;
      }
      if (classification === 'unversioned') {
        const ok = await appConfirm(
          'This file has no schema version. It may be an older export or hand-edited JSON. ' +
            'Importing will skip any field this build doesn’t recognize. Continue?',
          { title: 'Unversioned import', okLabel: 'Import anyway' },
        );
        if (!ok) return;
      }
      let added = 0;
      let skipped = 0;
      const existingSnippetNames = new Set(state.snippets.map((s) => s.name));
      const existingChainNames = new Set(state.chains.map((c) => c.name));
      if (Array.isArray(data.snippets)) {
        for (const s of data.snippets) {
          if (s && s.name && typeof s.program === 'string') {
            if (existingSnippetNames.has(s.name)) {
              skipped++;
              continue;
            }
            const item = { id: uid(), name: s.name, program: s.program };
            if (s.description) item.description = s.description;
            if (s.params) item.params = s.params;
            if (s.favorite) item.favorite = true;
            const tags = normalizeTags(s.tags);
            if (tags.length) item.tags = tags;
            if (typeof s.shortcut === 'string' && s.shortcut) item.shortcut = s.shortcut;
            if (typeof s.shortcutInsert === 'string' && s.shortcutInsert)
              item.shortcutInsert = s.shortcutInsert;
            // Tests come over verbatim if they look well-formed. Re-issue
            // ids so they don't collide with anything already in-state.
            if (Array.isArray(s.tests)) {
              const tests = s.tests
                .filter((t) => t && typeof t.input === 'string' && typeof t.expected === 'string')
                .map((t) => {
                  const out = { id: uid(), input: t.input, expected: t.expected };
                  if (t.name) out.name = String(t.name);
                  if (t.trimTrailingNewline) out.trimTrailingNewline = true;
                  if (t.vars && typeof t.vars === 'object') out.vars = { ...t.vars };
                  return out;
                });
              if (tests.length) item.tests = tests;
            }
            state.snippets.push(item);
            existingSnippetNames.add(s.name);
            added++;
          }
        }
      }
      if (Array.isArray(data.chains)) {
        for (const c of data.chains) {
          if (c && c.name && Array.isArray(c.steps)) {
            if (existingChainNames.has(c.name)) {
              skipped++;
              continue;
            }
            const item = { id: uid(), name: c.name, steps: c.steps };
            if (c.favorite) item.favorite = true;
            if (c.vars && typeof c.vars === 'object') item.vars = { ...c.vars };
            // Copy per-step overrides verbatim; id-matching happens
            // against the (now-backfilled) step ids below.
            if (c.stepVars && typeof c.stepVars === 'object') {
              item.stepVars = {};
              for (const [sid, overrides] of Object.entries(c.stepVars)) {
                if (overrides && typeof overrides === 'object') {
                  item.stepVars[sid] = { ...overrides };
                }
              }
            }
            // `perStepNames` carries the per-name mode flag that
            // `resolveStepVars` consults for precedence.
            if (Array.isArray(c.perStepNames)) {
              const names = c.perStepNames.filter((n) => typeof n === 'string');
              if (names.length) item.perStepNames = [...new Set(names)];
            }
            if (typeof c.shortcut === 'string' && c.shortcut) item.shortcut = c.shortcut;
            if (typeof c.shortcutInsert === 'string' && c.shortcutInsert)
              item.shortcutInsert = c.shortcutInsert;
            if (Array.isArray(c.tests)) {
              const tests = c.tests
                .filter((t) => t && typeof t.input === 'string' && typeof t.expected === 'string')
                .map((t) => {
                  const out = { id: uid(), input: t.input, expected: t.expected };
                  if (t.name) out.name = String(t.name);
                  if (t.trimTrailingNewline) out.trimTrailingNewline = true;
                  if (t.vars && typeof t.vars === 'object') out.vars = { ...t.vars };
                  return out;
                });
              if (tests.length) item.tests = tests;
            }
            // Backfill step ids before push so downstream code (incl.
            // `chain.stepVars` lookups) has stable keys from the start.
            ensureChainStepIds(item);
            state.chains.push(item);
            existingChainNames.add(c.name);
            added++;
          }
        }
      }
      const existingTextSnippetNames = new Set(state.textSnippets.map((t) => t.name));
      if (Array.isArray(data.textSnippets)) {
        for (const t of data.textSnippets) {
          if (t && t.name && typeof t.content === 'string') {
            if (existingTextSnippetNames.has(t.name)) {
              skipped++;
              continue;
            }
            const item = { id: uid(), name: t.name, content: t.content };
            if (t.favorite) item.favorite = true;
            state.textSnippets.push(item);
            existingTextSnippetNames.add(t.name);
            added++;
          }
        }
      }
      const existingTemplateNames = new Set(state.templates.map((t) => t.name));
      if (Array.isArray(data.templates)) {
        for (const t of data.templates) {
          if (t && t.name && typeof t.body === 'string') {
            if (existingTemplateNames.has(t.name)) {
              skipped++;
              continue;
            }
            const tpl = { id: uid(), name: t.name, body: t.body };
            if (t.description) tpl.description = t.description;
            if (t.favorite) tpl.favorite = true;
            state.templates.push(tpl);
            existingTemplateNames.add(t.name);
            added++;
          }
        }
      }
      saveState();
      if (onAfterImport) onAfterImport();
      appAlert(
        `Imported ${added} item${added === 1 ? '' : 's'}; skipped ${skipped} duplicate${skipped === 1 ? '' : 's'} (matched by name).`,
        { title: 'Import complete', level: 'info', duration: 5000 },
      );
    } catch (e) {
      appAlert('Import failed: ' + e.message, { title: 'Import failed', level: 'error' });
    }
  };
  inp.click();
}
