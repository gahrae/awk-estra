// @ts-check
// Picker widgets for gawk-specific splitting features + FS detection.
// Exports the four `wire*Button` helpers used by the snippet editor, the
// palette, and the inline-step dialog:
//
//   - wireDetectFsButton  — sample → detectFieldSeparator → splice FS
//   - wireColumnsButton   — FIELDWIDTHS (fixed-width columnar input)
//   - wireFpatButton      — FPAT (regex defining what each field looks like)
//   - wireStrftimeButton  — strftime() format picker
//
// Shared picker helpers (spliceBeginVar, showGawkInsertToast, …) live here
// rather than in a cross-file helpers module because they're picker-
// internal and nothing outside the pickers needs them.

import { $, editTextRange, safeSetItem, showToast } from '../core.js';
import {
  LS_KEYS,
  DEFAULT_FPAT_PRESETS,
  DEFAULT_STRFTIME_PRESETS,
} from '../data.js';
import { state } from '../state.js';
import { settings, openSettingsDialog } from '../settings.js';
import {
  findBeginBodyStartOffset,
  findBeginAssignmentRange,
  detectFieldSeparator,
  detectDefaultFsUsable,
  detectJsonArray,
  fsLabel,
  fsAwkLiteral,
} from '../awk.js';
import { getSel } from '../editor.js';
import { dispatch } from '../events.js';

/**
 * Wire a "Detect FS" button to the given program textarea. On click:
 * samples the current editor selection via `detectFieldSeparator`,
 * then splices the detected FS into the program textarea using one
 * of four paths, in preference order:
 *
 *   1. FS already assigned in a BEGIN block — replace its RHS in
 *      place (never leaves two FS assignments).
 *   2. BEGIN block exists without FS — inject `FS = "...";` into the
 *      BEGIN body via `findBeginBodyStartOffset` (never creates two
 *      BEGIN blocks; same trick the inline-step "Copy I/O settings"
 *      button uses).
 *   3. Program is empty — write a scaffold: the BEGIN with FS, plus
 *      `{ print $1, $2, …, $N }` so the preview shows every field
 *      separated by OFS and the user has a starting point to edit.
 *   4. Program is non-empty and has no BEGIN — prepend a fresh
 *      BEGIN block.
 *
 * Surfaces the detection + action taken via `showToast`. Safe to
 * call when the button doesn't exist (no-ops) so dialog templates
 * without the button can share code with those that do.
 *
 * @param {HTMLButtonElement | null} btn
 * @param {HTMLTextAreaElement} ta
 * @param {(() => Promise<{ target: string, hasSel?: boolean, source?: any } | null>) | null} [getSample]
 *   Optional async sample provider. When present and it resolves to a
 *   non-null tuple, Detect FS runs against `target` (and uses `source`
 *   for the JSON-clone escalation's chain-name suffix) instead of
 *   reading from the main editor via `getSel()`. Used by the inline-
 *   step dialog to sample the *preceding step's output* rather than
 *   the editor selection, since that's what the step will actually
 *   receive at run time.
 */
export function wireDetectFsButton(btn, ta, getSample) {
  if (!btn) return;
  btn.onclick = async (e) => {
    e.preventDefault();
    // Prefer the caller's sample when provided; fall back to the main
    // editor selection / active tab. Null/undefined from getSample
    // means "I don't have a sample to offer, use the default."
    let target;
    let hasSel;
    let overrideSource = null;
    if (getSample) {
      const override = await getSample();
      if (override && typeof override.target === 'string') {
        target = override.target;
        hasSel = !!override.hasSel;
        overrideSource = override.source || null;
      }
    }
    if (target === undefined) {
      const sel = getSel();
      target = sel.target;
      hasSel = sel.hasSel;
    }
    // Intercept the JSON-array case before FS detection runs. A JSON
    // array of objects would otherwise trick FS detection into picking
    // `:` or `,` — both present, both consistent per line, both wrong.
    // The right move is a table conversion chain, so we offer a toast
    // link that clones the 'JSON to Table' seed chain and opens it for
    // edit. Event-based handoff keeps this module from importing
    // chain-mutation code directly.
    const jsonArray = detectJsonArray(target);
    if (jsonArray) {
      // Capture where the input came from now (not when the user
      // clicks the toast action) so it survives any tab-switch /
      // selection-change in the meantime. Selection = generic bucket
      // numbered by main.js; full tab = use the tab title verbatim.
      // Caller-supplied source (e.g. "preceding step output") wins;
      // otherwise derive from the editor state.
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      const source =
        overrideSource ||
        (hasSel
          ? { kind: 'selection' }
          : { kind: 'tab', title: (activeTab && activeTab.title) || 'tab' });
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = "Clone chain 'JSON to Table'";
      action.addEventListener('click', () => {
        dispatch('library:clone-chain-for-edit', { name: 'JSON to Table', source });
      });
      showToast({
        title: 'Looks like JSON',
        body: `Array of ${jsonArray.count} record${jsonArray.count === 1 ? '' : 's'} detected. Setting FS on raw JSON doesn’t work — a two-step chain converts the array into an aligned table.`,
        level: 'info',
        duration: 8000,
        dom: action,
      });
      return;
    }
    const detected = detectFieldSeparator(target);
    if (!detected) {
      // Custom-FS detection failed — but the user may not need one.
      // Awk's default FS splits on whitespace runs, and for
      // log-style / whitespace-columnar input that already produces
      // the structure they want. Surface that as a friendly "no
      // change needed" toast; if the program is empty, also drop in
      // the `{ print $1, $2, … $N }` scaffold so the preview shows
      // every field straight away (parallels the custom-FS empty-
      // program path — no BEGIN needed since default FS is default).
      const defaultFs = detectDefaultFsUsable(target);
      if (defaultFs) {
        let scaffoldNote = '';
        if (!ta.value.trim()) {
          const fieldList = Array.from(
            { length: defaultFs.fieldCount },
            (_, n) => `$${n + 1}`,
          ).join(', ');
          editTextRange(ta, 0, ta.value.length, `{ print ${fieldList} }\n`);
          scaffoldNote = ' Scaffold inserted so the preview shows each field.';
        }
        showToast({
          title: "Awk's default FS already works",
          body: `No custom separator found, but every sampled line splits into ${defaultFs.fieldCount} fields on whitespace (awk's default). Leave FS unset — $1..$${defaultFs.fieldCount} will work out of the box.${scaffoldNote}`,
          level: 'info',
          duration: 4500,
        });
        return;
      }
      // Quoted-CSV escalation. When custom-FS detection fails but the
      // sample contains both `"` and `,`, the classic cause is a CSV
      // file with commas inside quoted fields — FPAT is the right
      // tool. Surface it as a toast action that opens the FPAT picker
      // pre-loaded with the CSV preset, mirroring the JSON → "Clone
      // chain for edit" escalation elsewhere in this handler.
      const looksLikeQuotedCsv = target.includes(',') && target.includes('"');
      let fpatAction;
      if (looksLikeQuotedCsv) {
        fpatAction = document.createElement('button');
        fpatAction.type = 'button';
        fpatAction.className = 'toast-action';
        fpatAction.textContent = 'Try FPAT for quoted CSV';
        fpatAction.addEventListener('click', () => {
          openFpatPicker(ta, { forcePreset: 'csv' });
        });
      }
      showToast({
        title: 'No clear separator detected',
        body: looksLikeQuotedCsv
          ? 'Tried comma, tab, pipe, semicolon, colon, and every other punctuation / symbol character in the sample — none split every sampled line into the same number of fields. The sample has commas and double-quotes, though, so quoted CSV is a likely fit — try FPAT.'
          : 'Tried comma, tab, pipe, semicolon, colon, and every other punctuation / symbol character in the sample — none split every sampled line into the same number of fields.',
        level: 'info',
        duration: looksLikeQuotedCsv ? 6000 : 3500,
        dom: fpatAction,
      });
      return;
    }
    const fsRhs = `"${fsAwkLiteral(detected.fs)}"`;
    const assignment = `FS = ${fsRhs};`;
    let action;
    const fsRange = findBeginAssignmentRange(ta.value, 'FS');
    if (fsRange) {
      editTextRange(ta, fsRange.start, fsRange.end, `FS = ${fsRhs}`);
      action = 'replaced existing FS';
    } else {
      const bodyStart = findBeginBodyStartOffset(ta.value);
      if (bodyStart >= 0) {
        const next = ta.value.charAt(bodyStart);
        const trailing = next === '\n' ? '' : '\n';
        editTextRange(ta, bodyStart, bodyStart, `\n  ${assignment}${trailing}`);
        action = 'added FS to existing BEGIN';
      } else if (!ta.value.trim()) {
        const fieldList = Array.from(
          { length: detected.fieldCount },
          (_, n) => `$${n + 1}`,
        ).join(', ');
        editTextRange(
          ta,
          0,
          ta.value.length,
          `BEGIN {\n  ${assignment}\n}\n{ print ${fieldList} }\n`,
        );
        action = 'inserted scaffold with FS';
      } else {
        editTextRange(ta, 0, 0, `BEGIN {\n  ${assignment}\n}\n\n`);
        action = 'prepended BEGIN with FS';
      }
    }
    showToast({
      title: `Detected ${fsLabel(detected.fs)} as FS`,
      body: `${action} — ${detected.fieldCount} fields across ${detected.sampleCount} sampled lines`,
      level: 'info',
      duration: 3000,
    });
  };
}

// ---------- Columns picker (FIELDWIDTHS) ----------
/**
 * Find column positions where every sampled line long enough to reach
 * that column has a space. Collapse runs of such "gap" columns and
 * return the column immediately *after* each run — i.e. where the next
 * field begins. Leading gaps (starting at column 0) and trailing gaps
 * (running off the end of the longest line) don't produce boundaries.
 *
 * @param {string[]} lines
 * @returns {number[]} ascending list of boundary columns
 */
function detectColumnBoundaries(lines) {
  if (!lines.length) return [];
  let maxLen = 0;
  for (const l of lines) if (l.length > maxLen) maxLen = l.length;
  const boundaries = [];
  let col = 0;
  while (col < maxLen) {
    // Is this column a gap (space/tab in every line long enough to reach it)?
    let allSpace = true;
    let hit = 0;
    for (const l of lines) {
      if (l.length > col) {
        hit++;
        const ch = l[col];
        if (ch !== ' ' && ch !== '\t') { allSpace = false; break; }
      }
    }
    if (!allSpace || hit === 0) { col++; continue; }
    // Scan to end of gap run.
    const gapStart = col;
    let gapEnd = col + 1;
    while (gapEnd < maxLen) {
      let gapAllSpace = true;
      let gapHit = 0;
      for (const l of lines) {
        if (l.length > gapEnd) {
          gapHit++;
          const ch = l[gapEnd];
          if (ch !== ' ' && ch !== '\t') { gapAllSpace = false; break; }
        }
      }
      if (!gapAllSpace || gapHit === 0) break;
      gapEnd++;
    }
    // Skip leading edge and trailing edge groups.
    if (gapStart > 0 && gapEnd < maxLen) boundaries.push(gapEnd);
    col = gapEnd;
  }
  return boundaries;
}

/**
 * Parse an existing `FIELDWIDTHS = "…"` assignment back into the
 * picker's model (internal boundary columns + trailing-star flag).
 * Returns null if no assignment is found or the RHS isn't a plain
 * string literal the picker can round-trip.
 *
 * With N numeric widths, the widget shows N-1 internal boundaries
 * (the final cumulative offset is the end of the last field, not a
 * split). With a trailing `*`, all N cumulative offsets are kept
 * because the `*` field begins at the last one.
 *
 * @param {string} program
 * @returns {{ boundaries: number[], hasStar: boolean } | null}
 */
function parseExistingFieldwidthsBoundaries(program) {
  const range = findBeginAssignmentRange(program, 'FIELDWIDTHS');
  if (!range) return null;
  const rhs = program.slice(range.start, range.end);
  const m = rhs.match(/"([^"]*)"/);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const boundaries = [];
  let hasStar = false;
  let acc = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '*') {
      if (i !== parts.length - 1) return null;
      hasStar = true;
      break;
    }
    const m2 = p.match(/^(?:(\d+):)?(\d+)$/);
    if (!m2) return null;
    const skip = m2[1] ? parseInt(m2[1], 10) : 0;
    const width = parseInt(m2[2], 10);
    acc += skip + width;
    boundaries.push(acc);
  }
  if (!hasStar && boundaries.length > 0) boundaries.pop();
  return { boundaries, hasStar };
}

/**
 * Turn the picker's model back into a FIELDWIDTHS RHS. Returns null
 * when there isn't enough info to emit something awk can parse — at
 * least one internal boundary is required, even with trailing `*`,
 * because gawk rejects `FIELDWIDTHS = "*"` on its own.
 *
 * @param {number[]} sortedBoundaries
 * @param {number} maxLen
 * @param {boolean} trailingStar
 * @returns {string | null}
 */
function computeFieldwidths(sortedBoundaries, maxLen, trailingStar) {
  if (!sortedBoundaries.length) return null;
  const widths = [];
  let prev = 0;
  for (const b of sortedBoundaries) {
    widths.push(b - prev);
    prev = b;
  }
  if (trailingStar) return widths.map(String).concat(['*']).join(' ');
  widths.push(Math.max(1, maxLen - prev));
  return widths.map(String).join(' ');
}

/**
 * `$1, $2, … $n` for the main-action scaffold. Falls back to `$0`
 * when there's no field split to describe.
 *
 * @param {number} n
 * @returns {string}
 */
function buildPrintFieldList(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');
}

/**
 * Append `{ print $1, $2, … $N }` to the program. Called on every
 * FIELDWIDTHS splice path that isn't the empty-program one (which
 * bakes the same scaffold into its wholesale write). A duplicate
 * print rule from repeat clicks just produces repeated output and
 * is trivial for the user to delete — not worth the tokeniser walk
 * that a "does a main rule already exist?" check would cost.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {number} fieldCount
 */
function appendMainActionBlock(ta, fieldCount) {
  const fieldList = buildPrintFieldList(fieldCount);
  const current = ta.value;
  const prefix =
    current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  editTextRange(
    ta,
    current.length,
    current.length,
    `${prefix}{ print ${fieldList} }\n`,
  );
}

/**
 * Splice `<varName> = "…"` into a BEGIN block in the snippet program,
 * mirroring the Detect FS cascade: replace an existing assignment,
 * else inject into an existing BEGIN, else scaffold on empty program,
 * else prepend a fresh BEGIN. Always appends a `{ print $1, …, $N }`
 * main rule afterwards (except in the wholesale empty-program write,
 * which bakes the scaffold into the same edit) — without one, FPAT /
 * FIELDWIDTHS would silently produce no output. Returns a short human
 * label describing the primary action taken, suitable for a toast
 * body.
 *
 * Used by both the Fixed Columns picker (FIELDWIDTHS) and the FPAT
 * picker. The `awkLiteral` argument is whatever should appear inside
 * the `"…"` on the RHS — the caller is responsible for any awk-string
 * escaping needed (FIELDWIDTHS values never contain `"`; FPAT values
 * usually do, see `awkStringEscape`).
 *
 * @param {HTMLTextAreaElement} ta
 * @param {string} varName e.g. `'FIELDWIDTHS'` or `'FPAT'`
 * @param {string} awkLiteral RHS string body without surrounding quotes
 * @param {number} fieldCount number of fields implied by `awkLiteral`
 * @returns {string} short label describing the action taken
 */
function spliceBeginVar(ta, varName, awkLiteral, fieldCount) {
  const quoted = `"${awkLiteral}"`;
  const assignment = `${varName} = ${quoted};`;
  const fieldList = buildPrintFieldList(fieldCount);
  const existingRange = findBeginAssignmentRange(ta.value, varName);
  if (existingRange) {
    editTextRange(ta, existingRange.start, existingRange.end, `${varName} = ${quoted}`);
    appendMainActionBlock(ta, fieldCount);
    return `replaced existing ${varName}`;
  }
  const bodyStart = findBeginBodyStartOffset(ta.value);
  if (bodyStart >= 0) {
    const next = ta.value.charAt(bodyStart);
    const trailing = next === '\n' ? '' : '\n';
    editTextRange(ta, bodyStart, bodyStart, `\n  ${assignment}${trailing}`);
    appendMainActionBlock(ta, fieldCount);
    return `added ${varName} to existing BEGIN`;
  }
  if (!ta.value.trim()) {
    editTextRange(
      ta,
      0,
      ta.value.length,
      `BEGIN {\n  ${assignment}\n}\n{ print ${fieldList} }\n`,
    );
    return `inserted scaffold with ${varName}`;
  }
  editTextRange(ta, 0, 0, `BEGIN {\n  ${assignment}\n}\n\n`);
  appendMainActionBlock(ta, fieldCount);
  return `prepended BEGIN with ${varName}`;
}

/**
 * Show the gawk-only insertion toast — same shape for FIELDWIDTHS and
 * FPAT. When `settings.ui.warnGawkOnly` is on (the default), the toast
 * carries a "Disable this warning" action button that opens Settings
 * scrolled to the relevant checkbox row.
 *
 * @param {string} varName e.g. `'FIELDWIDTHS'`
 * @param {string} action short label from `spliceBeginVar`
 */
function showGawkInsertToast(varName, action) {
  const warn = settings.ui.warnGawkOnly !== false;
  let actionBtn;
  if (warn) {
    actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'toast-action';
    actionBtn.textContent = 'Disable this warning';
    actionBtn.addEventListener('click', async () => {
      await openSettingsDialog({ scrollTo: 'set-warn-gawk-only-row' });
    });
  }
  showToast({
    title: warn ? `Inserted ${varName} (gawk-only)` : `Inserted ${varName}`,
    body: warn
      ? `${action}. ${varName} is a gawk extension — programs using it won’t run under mawk or one-true-awk.`
      : action,
    level: 'info',
    duration: warn ? 6000 : 2500,
    dom: actionBtn,
  });
}

/**
 * Read the current editor selection (or whole active tab) and open the
 * column picker modal. Clicking ruler positions toggles boundaries;
 * Auto-detect seeds them from columns-of-spaces; Insert splices the
 * result into `ta` and fires a portability-warning toast if enabled.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {{ sampleTarget?: string }} [opts]
 *   `sampleTarget` overrides the default editor-selection sample. Used
 *   by the inline-step dialog to feed the preceding step's output
 *   here — the data the step will actually receive at run time.
 */
function openColumnsPicker(ta, opts = {}) {
  const dlg = $('#columns-dialog');
  const target = opts.sampleTarget !== undefined ? opts.sampleTarget : getSel().target;
  const rawLines = target.split('\n').filter((l) => l.length > 0);
  // Cap at 20 lines × 200 chars each so the DOM stays cheap even if the
  // user has a huge tab selected. That's plenty to eyeball alignment.
  const lines = rawLines.slice(0, 20).map((l) => (l.length > 200 ? l.slice(0, 200) : l));
  let maxLen = 0;
  for (const l of lines) if (l.length > maxLen) maxLen = l.length;
  // `fullMaxLen` covers lines beyond the 20-line sample — used by the
  // Fit button so it can size the ruler to the widest actual line in
  // the source, not just the widest rendered line.
  let fullMaxLen = 0;
  for (const l of rawLines) if (l.length > fullMaxLen) fullMaxLen = l.length;
  // Pad the ruler out to a minimum width so it's usable even on very
  // short samples (otherwise there'd be nowhere to click). Mutable
  // because the Widen + button grows it at runtime.
  let rulerLen = Math.max(maxLen, 80);

  const emptyMsg = /** @type {HTMLElement} */ ($('#cp-empty'));
  const sampleWrap = /** @type {HTMLElement} */ ($('#cp-sample-wrap'));
  const controls = /** @type {HTMLElement} */ (dlg.querySelector('.cp-controls'));
  const readoutBox = /** @type {HTMLElement} */ (dlg.querySelector('.cp-readout'));
  const insertBtn = /** @type {HTMLButtonElement} */ ($('#cp-insert'));
  const hasSample = lines.length > 0;
  emptyMsg.hidden = hasSample;
  sampleWrap.hidden = !hasSample;
  controls.hidden = !hasSample;
  readoutBox.hidden = !hasSample;
  insertBtn.disabled = !hasSample;

  /** @type {Set<number>} */
  const boundaries = new Set();
  const existing = parseExistingFieldwidthsBoundaries(ta.value);
  const starCb = /** @type {HTMLInputElement} */ ($('#cp-trailing-star'));
  if (existing) {
    for (const b of existing.boundaries) if (b > 0 && b < rulerLen) boundaries.add(b);
    starCb.checked = !!existing.hasStar;
  } else {
    // Fresh picker session on a snippet without FIELDWIDTHS: the
    // trailing-* flag is the common case (ragged last field), so
    // default it on. Auto-detect below may revise it based on the
    // actual sample.
    starCb.checked = true;
    const detected = detectColumnBoundaries(lines);
    for (const b of detected) boundaries.add(b);
    const sortedB = [...boundaries].sort((a, b) => a - b);
    const lastB = sortedB.length ? sortedB[sortedB.length - 1] : 0;
    const tailLens = lines.filter((l) => l.length > lastB).map((l) => l.length);
    const tailsVary = tailLens.length > 1 && new Set(tailLens).size > 1;
    starCb.checked = tailsVary;
  }

  const rulerLabels = $('#cp-ruler-labels');
  const ruler = $('#cp-ruler');
  const sample = $('#cp-sample');
  const readoutCode = $('#cp-readout-code');

  // Render a labels row as a single pre-formatted string so multi-digit
  // numbers like "10", "20" flow naturally across their columns without
  // needing per-char positioning. Monospace + `white-space: pre` keeps
  // them aligned to the ruler below.
  function renderLabelsRow(len) {
    let out = '';
    let i = 0;
    while (i < len) {
      if (i > 0 && i % 10 === 0) {
        const label = String(i);
        if (i + label.length <= len) {
          out += label;
          i += label.length;
          continue;
        }
      }
      out += ' ';
      i++;
    }
    return out;
  }

  function render() {
    const sorted = [...boundaries].sort((a, b) => a - b);
    const sortedSet = new Set(sorted);
    rulerLabels.textContent = renderLabelsRow(rulerLen);
    // Ruler: one clickable cell per column, graded visibility so the
    // user can see every column is a valid target while still being
    // able to read the 5/10 structure at a glance.
    ruler.replaceChildren();
    for (let i = 0; i < rulerLen; i++) {
      const cell = document.createElement('span');
      cell.className = 'cp-cell';
      cell.dataset.col = String(i);
      if (sortedSet.has(i)) {
        cell.classList.add('cp-boundary');
        cell.textContent = '│';
      } else if (i > 0 && i % 10 === 0) {
        cell.classList.add('cp-cell-10');
        cell.textContent = '│';
      } else if (i > 0 && i % 5 === 0) {
        cell.classList.add('cp-cell-5');
        cell.textContent = '┊';
      } else {
        cell.textContent = '·';
      }
      ruler.appendChild(cell);
    }
    sample.replaceChildren();
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'cp-line';
      let fieldIdx = 0;
      for (let i = 0; i < rulerLen; i++) {
        if (sortedSet.has(i)) fieldIdx++;
        const ch = i < line.length ? line[i] : ' ';
        const span = document.createElement('span');
        span.className = `cp-char cp-field-${fieldIdx % 6}`;
        span.dataset.col = String(i);
        if (sortedSet.has(i)) span.classList.add('cp-at-boundary');
        span.textContent = ch === ' ' ? ' ' : ch;
        row.appendChild(span);
      }
      sample.appendChild(row);
    }
    const fw = computeFieldwidths(sorted, rulerLen, starCb.checked);
    if (!fw) readoutCode.textContent = '(no boundaries yet)';
    else readoutCode.textContent = `FIELDWIDTHS = "${fw}"`;
    insertBtn.disabled = !fw;
  }

  function toggleBoundaryAtCol(col) {
    if (!Number.isFinite(col) || col <= 0) return;
    if (boundaries.has(col)) boundaries.delete(col);
    else boundaries.add(col);
    render();
  }

  // Pick up clicks on either the ruler cells or the sample characters —
  // the sample is the more intuitive surface ("split here, between these
  // two characters"), but the ruler stays clickable for positions that
  // fall past the end of every sampled line.
  function colFromEvent(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const colStr = t && t.dataset && t.dataset.col;
    if (!colStr) return NaN;
    return parseInt(colStr, 10);
  }
  ruler.onclick = (e) => toggleBoundaryAtCol(colFromEvent(e));
  sample.onclick = (e) => toggleBoundaryAtCol(colFromEvent(e));

  $('#cp-auto-detect').onclick = () => {
    const detected = detectColumnBoundaries(lines);
    boundaries.clear();
    for (const b of detected) boundaries.add(b);
    // Heuristic for trailing-star: if tail lengths vary after the last
    // boundary, the last field is ragged (think ls -l filenames) and
    // `*` captures it cleanly. Otherwise stick with a concrete width.
    const sortedB = [...boundaries].sort((a, b) => a - b);
    const lastB = sortedB.length ? sortedB[sortedB.length - 1] : 0;
    const tailLens = lines.filter((l) => l.length > lastB).map((l) => l.length);
    const tailsVary = tailLens.length > 1 && new Set(tailLens).size > 1;
    starCb.checked = tailsVary;
    render();
  };

  $('#cp-clear').onclick = () => {
    boundaries.clear();
    starCb.checked = false;
    render();
  };

  const widenStep = /** @type {HTMLInputElement} */ ($('#cp-widen-step'));
  $('#cp-widen-btn').onclick = () => {
    const step = parseInt(widenStep.value, 10);
    if (!Number.isFinite(step) || step <= 0) return;
    rulerLen += step;
    render();
  };
  $('#cp-shrink-btn').onclick = () => {
    const step = parseInt(widenStep.value, 10);
    if (!Number.isFinite(step) || step <= 0) return;
    // Refuse to hide the sampled data or any existing boundary — those
    // would silently disappear on the next render. Also keep at least
    // 10 columns of clickable ruler so the picker stays usable when
    // the user overshoots.
    const maxBoundary = boundaries.size ? Math.max(...boundaries) : 0;
    const minLen = Math.max(maxLen, maxBoundary + 1, 10);
    rulerLen = Math.max(minLen, rulerLen - step);
    render();
  };
  $('#cp-fit-btn').onclick = () => {
    // Size the ruler to the widest line in the full input — not just
    // the 20-line sample. Still honour the minimum floor (data +
    // boundaries + 10).
    const maxBoundary = boundaries.size ? Math.max(...boundaries) : 0;
    rulerLen = Math.max(fullMaxLen, maxBoundary + 1, 10);
    render();
  };

  starCb.onchange = render;

  insertBtn.onclick = () => {
    const sorted = [...boundaries].sort((a, b) => a - b);
    const fw = computeFieldwidths(sorted, rulerLen, starCb.checked);
    if (!fw) return;
    const fieldCount = sorted.length + 1;
    const action = spliceBeginVar(ta, 'FIELDWIDTHS', fw, fieldCount);
    dlg.close('insert');
    showGawkInsertToast('FIELDWIDTHS', action);
    ta.dispatchEvent(new Event('input'));
  };

  render();

  // Restore any saved size before opening, mirroring the snippet /
  // inline-step / chain dialogs. A ResizeObserver below writes the
  // final size back on each user-driven resize.
  const sizeRaw = localStorage.getItem(LS_KEYS.COLUMNS_DLG_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }

  dlg.showModal();
  const rect = dlg.getBoundingClientRect();
  let lastW = rect.width;
  let lastH = rect.height;
  const ro = new ResizeObserver(() => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(
        LS_KEYS.COLUMNS_DLG_SIZE,
        JSON.stringify({ width: r.width, height: r.height }),
      );
    }
  });
  ro.observe(dlg);
  dlg.addEventListener('close', () => ro.disconnect(), { once: true });
}

/**
 * Wire a "Columns…" button to open the FIELDWIDTHS picker for `ta`.
 *
 * @param {HTMLButtonElement | null} btn
 * @param {HTMLTextAreaElement} ta
 * @param {(() => Promise<{ target: string } | null>) | null} [getSample]
 *   Optional async sample provider. When present and it resolves to
 *   `{ target }`, the picker is opened with that sample instead of
 *   reading from `getSel()`. Used by the inline-step dialog.
 */
export function wireColumnsButton(btn, ta, getSample) {
  if (!btn) return;
  btn.onclick = async (e) => {
    e.preventDefault();
    let sampleTarget;
    if (getSample) {
      const override = await getSample();
      if (override && typeof override.target === 'string') sampleTarget = override.target;
    }
    openColumnsPicker(ta, sampleTarget !== undefined ? { sampleTarget } : undefined);
  };
}

// ---------- FPAT picker ----------
// Default preset list lives in data.js (DEFAULT_FPAT_PRESETS); the user's
// active list is in settings.presets.fpat and is read fresh at picker
// open time via `currentFpatPresets()` below. The Custom… sentinel is
// appended by that helper.

/**
 * The freeform "Custom…" row appended to the end of the FPAT preset
 * dropdown. It's UI state ("I'm typing my own pattern"), not a stored
 * preset, so it lives here rather than in `settings.presets.fpat`. The
 * Settings editor filters it out on save so it never gets stored.
 */
const FPAT_CUSTOM_PRESET = Object.freeze({
  id: 'custom',
  label: 'Custom…',
  pattern: '',
  description:
    'Type your own regex. Anything matched becomes a field; gaps between matches are discarded.',
});

/**
 * Current FPAT preset list shown in the picker: the user's stored list
 * (seeded from `DEFAULT_FPAT_PRESETS` and edited in Settings → Presets)
 * plus the Custom sentinel at the bottom. Read fresh on each open —
 * `settings.presets.fpat` is edited in place by the Settings dialog, so
 * the picker always sees the latest list without needing a
 * `settings-saved` subscription.
 *
 * Falls back to `DEFAULT_FPAT_PRESETS` if the stored list is missing or
 * empty, so the picker never renders an empty dropdown.
 *
 * @returns {{ id: string, label: string, pattern: string, description: string }[]}
 */
function currentFpatPresets() {
  const stored = settings.presets && settings.presets.fpat;
  const base = Array.isArray(stored) && stored.length ? stored : DEFAULT_FPAT_PRESETS;
  return [...base, FPAT_CUSTOM_PRESET];
}

/**
 * Escape a regex pattern for embedding inside an awk string literal:
 * double every backslash and escape every double-quote. Awk's string
 * parser then halves the backslashes back out and resolves `\"` to `"`,
 * so the regex engine sees the original pattern.
 *
 * @param {string} s
 * @returns {string}
 */
function awkStringEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Inverse of `awkStringEscape` — used to read an existing
 * `FPAT = "…"` back into the picker's plain-pattern model.
 *
 * @param {string} s
 * @returns {string}
 */
function awkStringUnescape(s) {
  return s.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

/**
 * Pull the existing `FPAT = "…"` (if any) out of the program so the
 * picker opens pre-populated with the user's current pattern.
 *
 * @param {string} program
 * @returns {string | null}
 */
function parseExistingFpat(program) {
  const range = findBeginAssignmentRange(program, 'FPAT');
  if (!range) return null;
  const rhs = program.slice(range.start, range.end);
  const m = rhs.match(/"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return awkStringUnescape(m[1]);
}

/**
 * Open the FPAT picker against `ta`. Sample comes from the main
 * editor's selection (or active tab). On first open with no existing
 * FPAT, defaults to the CSV preset; otherwise pre-fills with the
 * existing pattern. Callers that know the user's intent (e.g. the
 * Detect-FS → FPAT escalation on quoted CSV) can pass
 * `{ forcePreset: 'csv' }` to override the existing-FPAT pre-fill.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {{ forcePreset?: string, sampleTarget?: string }} [opts]
 *   `sampleTarget` overrides the default editor-selection sample —
 *   used by the inline-step dialog to sample the preceding step's
 *   output.
 */
function openFpatPicker(ta, opts = {}) {
  const dlg = $('#fpat-dialog');
  const target = opts.sampleTarget !== undefined ? opts.sampleTarget : getSel().target;
  const rawLines = target.split('\n').filter((l) => l.length > 0);
  // Cap sample so the live preview stays cheap on big tabs.
  const lines = rawLines.slice(0, 20).map((l) => (l.length > 400 ? l.slice(0, 400) : l));

  const emptyMsg = /** @type {HTMLElement} */ ($('#fp-empty'));
  const presetSel = /** @type {HTMLSelectElement} */ ($('#fp-preset'));
  const presetDesc = /** @type {HTMLElement} */ ($('#fp-preset-desc'));
  const regexInput = /** @type {HTMLInputElement} */ ($('#fp-regex'));
  const previewWrap = /** @type {HTMLElement} */ ($('#fp-preview-wrap'));
  const previewMeta = /** @type {HTMLElement} */ ($('#fp-preview-meta'));
  const previewEl = /** @type {HTMLElement} */ ($('#fp-preview'));
  const readoutCode = /** @type {HTMLElement} */ ($('#fp-readout-code'));
  const insertBtn = /** @type {HTMLButtonElement} */ ($('#fp-insert'));

  const hasSample = lines.length > 0;
  emptyMsg.hidden = hasSample;
  previewWrap.hidden = !hasSample;

  // Snapshot of the current preset list (user-edited in Settings +
  // the Custom sentinel). Reading once per open is enough — the user
  // can't edit Settings while this dialog is modal.
  const presets = currentFpatPresets();

  // Populate the preset dropdown once per open (cheap; keeps the
  // markup self-documenting since labels live in JS data not HTML).
  presetSel.replaceChildren();
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    presetSel.appendChild(opt);
  }

  // Look up a preset by id, falling back to the stock default from
  // DEFAULT_FPAT_PRESETS if the user has deleted or renamed the row.
  // Needed because `forcePreset: 'csv'` (used by the Detect-FS JSON
  // escalation) must still produce a working pattern even if the user
  // has nuked the CSV preset from Settings. Returns null if the id
  // isn't in the current list *and* not in the defaults either.
  const presetById = (id) => {
    const cur = presets.find((p) => p.id === id);
    if (cur) return cur;
    return DEFAULT_FPAT_PRESETS.find((p) => p.id === id) || null;
  };

  const existingPattern = parseExistingFpat(ta.value);
  // Pick the initial preset: `forcePreset` wins if the caller asked
  // for a specific one (e.g. Detect-FS's "try CSV" escalation); else
  // if there's an existing FPAT matching a preset pattern exactly,
  // select that preset; else "Custom" holding the existing text.
  // With no existing FPAT and no force, default to CSV — most common
  // reach for FPAT. If the user has deleted the CSV preset, fall back
  // to the first non-custom preset in the list (or Custom if the list
  // is entirely empty — currentFpatPresets guarantees at least the
  // defaults + sentinel, so this last branch is paranoia).
  const csv = presetById('csv');
  const firstReal = presets.find((p) => p.id !== 'custom');
  let initialPresetId = csv ? csv.id : firstReal ? firstReal.id : 'custom';
  let initialPattern = csv ? csv.pattern : firstReal ? firstReal.pattern : '';
  const forced = opts.forcePreset ? presetById(opts.forcePreset) : null;
  if (forced) {
    // If the forced preset was deleted from the user's list, `forced`
    // is the default-library fallback — surface it as Custom in the UI
    // (so the user can see exactly what we injected) while still
    // using the default's pattern.
    initialPresetId = presets.some((p) => p.id === forced.id) ? forced.id : 'custom';
    initialPattern = forced.pattern;
  } else if (existingPattern !== null) {
    const match = presets.find((p) => p.pattern === existingPattern);
    if (match) {
      initialPresetId = match.id;
      initialPattern = match.pattern;
    } else {
      initialPresetId = 'custom';
      initialPattern = existingPattern;
    }
  }
  presetSel.value = initialPresetId;
  regexInput.value = initialPattern;

  /**
   * Re-render the preset description, live preview, and readout
   * against the current `regexInput.value`. Called on every input
   * change and preset switch.
   */
  function render() {
    const preset = presets.find((p) => p.id === presetSel.value) || presets[0];
    presetDesc.textContent = preset.description;
    const pattern = regexInput.value;
    // Readout: the line we'd actually splice. Empty pattern → placeholder.
    if (!pattern) {
      readoutCode.textContent = '(no pattern yet)';
      previewEl.replaceChildren();
      previewMeta.textContent = '';
      insertBtn.disabled = true;
      return;
    }
    readoutCode.textContent = `FPAT = "${awkStringEscape(pattern)}"`;
    if (!hasSample) {
      previewEl.replaceChildren();
      previewMeta.textContent = '';
      insertBtn.disabled = false;
      return;
    }
    let regex;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (err) {
      previewEl.replaceChildren();
      previewMeta.textContent = `Invalid regex: ${err.message}`;
      previewMeta.classList.add('fp-mismatch');
      // Don't block Insert — gawk's regex dialect differs from JS, and
      // a pattern that's invalid here may still be valid in gawk. The
      // user accepts that risk by hitting Insert with no preview.
      insertBtn.disabled = false;
      return;
    }
    previewMeta.classList.remove('fp-mismatch');
    previewEl.replaceChildren();
    /** @type {number[]} */
    const fieldCounts = [];
    for (const line of lines) {
      const matches = [...line.matchAll(regex)].filter((m) => m[0].length > 0);
      fieldCounts.push(matches.length);
      const row = document.createElement('div');
      row.className = 'fp-line';
      let cursor = 0;
      matches.forEach((m, i) => {
        const start = m.index;
        const end = start + m[0].length;
        if (cursor < start) {
          const gap = document.createElement('span');
          gap.className = 'fp-gap';
          gap.textContent = line.slice(cursor, start);
          row.appendChild(gap);
        }
        const field = document.createElement('span');
        field.className = `fp-field fp-field-${i % 6}`;
        field.title = `$${i + 1}`;
        field.textContent = m[0];
        row.appendChild(field);
        cursor = end;
      });
      if (cursor < line.length) {
        const tail = document.createElement('span');
        tail.className = 'fp-gap';
        tail.textContent = line.slice(cursor);
        row.appendChild(tail);
      }
      previewEl.appendChild(row);
    }
    const max = fieldCounts.reduce((a, b) => Math.max(a, b), 0);
    const consistent = fieldCounts.length > 0 && new Set(fieldCounts).size === 1;
    if (max === 0) {
      previewMeta.textContent = 'No matches in any sampled line.';
      previewMeta.classList.add('fp-mismatch');
    } else if (consistent) {
      previewMeta.textContent = `${fieldCounts[0]} field${fieldCounts[0] === 1 ? '' : 's'} per line across ${lines.length} sample line${lines.length === 1 ? '' : 's'}.`;
    } else {
      previewMeta.textContent = `Field counts vary across sample lines: ${fieldCounts.join(', ')}.`;
    }
    insertBtn.disabled = max === 0;
  }

  presetSel.onchange = () => {
    const preset = presets.find((p) => p.id === presetSel.value);
    if (preset && preset.id !== 'custom') {
      regexInput.value = preset.pattern;
    }
    render();
  };
  regexInput.oninput = () => {
    // Any manual edit jumps to the Custom preset unless it still
    // exactly matches one of the user's presets.
    const match = presets.find((p) => p.pattern === regexInput.value && p.id !== 'custom');
    presetSel.value = match ? match.id : 'custom';
    render();
  };

  insertBtn.onclick = () => {
    const pattern = regexInput.value;
    if (!pattern) return;
    // Field count for the print scaffold: max non-empty matches across
    // the sample. Falls back to 3 when there's no sample so the
    // scaffold still prints something useful.
    let fieldCount = 3;
    if (hasSample) {
      try {
        const regex = new RegExp(pattern, 'g');
        let max = 0;
        for (const line of lines) {
          const n = [...line.matchAll(regex)].filter((m) => m[0].length > 0).length;
          if (n > max) max = n;
        }
        fieldCount = Math.max(max, 1);
      } catch (_) {
        /* keep default */
      }
    }
    const action = spliceBeginVar(ta, 'FPAT', awkStringEscape(pattern), fieldCount);
    dlg.close('insert');
    showGawkInsertToast('FPAT', action);
    ta.dispatchEvent(new Event('input'));
  };

  render();

  // Restore size, mirror the columns picker.
  const sizeRaw = localStorage.getItem(LS_KEYS.FPAT_DLG_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }
  dlg.showModal();
  // Defer focus so the browser's auto-focus on the first input doesn't
  // win the race; `regexInput` is the field most users want to land in.
  setTimeout(() => regexInput.focus(), 0);
  const rect = dlg.getBoundingClientRect();
  let lastW = rect.width;
  let lastH = rect.height;
  const ro = new ResizeObserver(() => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(
        LS_KEYS.FPAT_DLG_SIZE,
        JSON.stringify({ width: r.width, height: r.height }),
      );
    }
  });
  ro.observe(dlg);
  dlg.addEventListener('close', () => ro.disconnect(), { once: true });
}

/**
 * Wire a "Field Pattern…" button to open the FPAT picker for `ta`.
 *
 * @param {HTMLButtonElement | null} btn
 * @param {HTMLTextAreaElement} ta
 * @param {(() => Promise<{ target: string } | null>) | null} [getSample]
 *   Optional async sample provider. When present and it resolves to
 *   `{ target }`, the picker opens with that sample instead of reading
 *   from `getSel()`. Used by the inline-step dialog.
 */
export function wireFpatButton(btn, ta, getSample) {
  if (!btn) return;
  btn.onclick = async (e) => {
    e.preventDefault();
    let sampleTarget;
    if (getSample) {
      const override = await getSample();
      if (override && typeof override.target === 'string') sampleTarget = override.target;
    }
    openFpatPicker(ta, sampleTarget !== undefined ? { sampleTarget } : undefined);
  };
}

// ---------- strftime() picker ----------
// Default preset list lives in data.js (DEFAULT_STRFTIME_PRESETS); the
// user's active list is in settings.presets.timestamp and is read fresh
// at picker open time via `currentStrftimePresets()` below. The Custom…
// sentinel is appended by that helper.

/**
 * The freeform "Custom…" row appended to the end of the strftime preset
 * dropdown. UI state, not a stored preset — the Settings editor filters
 * it out on save so it never gets stored.
 */
const STRFTIME_CUSTOM_PRESET = Object.freeze({
  id: 'custom',
  label: 'Custom…',
  pattern: '',
  description:
    'Type your own format string. `%` begins a directive; `%%` emits a literal percent. See the reference below for the full code table.',
});

/**
 * Current strftime preset list shown in the picker: the user's stored
 * list (seeded from `DEFAULT_STRFTIME_PRESETS` and edited in Settings →
 * Presets) plus the Custom sentinel at the bottom. Read fresh on each
 * open. Falls back to `DEFAULT_STRFTIME_PRESETS` if the stored list is
 * missing or empty.
 *
 * @returns {{ id: string, label: string, pattern: string, description: string }[]}
 */
function currentStrftimePresets() {
  const stored = settings.presets && settings.presets.timestamp;
  const base = Array.isArray(stored) && stored.length ? stored : DEFAULT_STRFTIME_PRESETS;
  return [...base, STRFTIME_CUSTOM_PRESET];
}

/**
 * The subset of strftime format codes the live preview understands.
 * gawk supports everything here plus a few locale-dependent codes
 * (`%c`, `%x`, `%X`); those fall through to locale strings in JS, which
 * is a reasonable best-effort match. Unknown codes pass through
 * unchanged so the user still sees what they typed.
 *
 * Used both by `formatStrftime` and to populate the cheatsheet table
 * in the dialog — keep the human-readable descriptions accurate
 * against the actual output.
 */
const STRFTIME_CODES = [
  { code: 'Y', desc: '4-digit year (2024)' },
  { code: 'y', desc: '2-digit year (24)' },
  { code: 'C', desc: 'century (20)' },
  { code: 'm', desc: 'month, zero-padded (01–12)' },
  { code: 'B', desc: 'full month name (January)' },
  { code: 'b', desc: 'abbreviated month (Jan); same as %h' },
  { code: 'd', desc: 'day of month, zero-padded (01–31)' },
  { code: 'e', desc: 'day of month, space-padded ( 1–31)' },
  { code: 'j', desc: 'day of year (001–366)' },
  { code: 'A', desc: 'full weekday name (Monday)' },
  { code: 'a', desc: 'abbreviated weekday (Mon)' },
  { code: 'u', desc: 'ISO weekday (1=Monday … 7=Sunday)' },
  { code: 'w', desc: 'weekday (0=Sunday … 6=Saturday)' },
  { code: 'U', desc: 'week of year, Sunday-start (00–53)' },
  { code: 'W', desc: 'week of year, Monday-start (00–53)' },
  { code: 'V', desc: 'ISO 8601 week number (01–53)' },
  { code: 'G', desc: 'ISO 8601 week-numbering year' },
  { code: 'H', desc: 'hour, 24h zero-padded (00–23)' },
  { code: 'I', desc: 'hour, 12h zero-padded (01–12)' },
  { code: 'k', desc: 'hour, 24h space-padded ( 0–23)' },
  { code: 'l', desc: 'hour, 12h space-padded ( 1–12)' },
  { code: 'M', desc: 'minute (00–59)' },
  { code: 'S', desc: 'second (00–59)' },
  { code: 'p', desc: 'AM/PM' },
  { code: 'P', desc: 'am/pm (gawk extension)' },
  { code: 'z', desc: 'timezone offset ±HHMM' },
  { code: 'Z', desc: 'timezone name (TZ-dependent)' },
  { code: 's', desc: 'Unix epoch seconds' },
  { code: 'D', desc: 'shorthand for %m/%d/%y' },
  { code: 'F', desc: 'shorthand for %Y-%m-%d' },
  { code: 'R', desc: 'shorthand for %H:%M' },
  { code: 'T', desc: 'shorthand for %H:%M:%S' },
  { code: 'r', desc: 'shorthand for %I:%M:%S %p' },
  { code: 'n', desc: 'newline' },
  { code: 't', desc: 'tab' },
  { code: '%', desc: 'literal percent sign' },
];

/**
 * Best-effort JS implementation of gawk's strftime for the live
 * preview. Matches gawk's output for the codes listed in
 * `STRFTIME_CODES`. Codes not recognised pass through literally (e.g.
 * `%Q` renders as `%Q`), so typos are visible rather than silently
 * dropped.
 *
 * Timezone information is read from the host environment, so the
 * preview reflects the user's local clock — the program itself, when
 * run server-side by gawk, will produce the server's timezone. Close
 * enough for a format cheatsheet.
 *
 * @param {string} fmt
 * @param {Date} d
 * @returns {string}
 */
function formatStrftime(fmt, d) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const spad = (n, w = 2) => String(n).padStart(w, ' ');
  const weekdaysLong = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ];
  const weekdaysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsLong = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthsShort = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();
  const wday = d.getDay();
  const hour = d.getHours();
  const minute = d.getMinutes();
  const second = d.getSeconds();

  const yearStart = new Date(year, 0, 1);
  const doy = Math.floor((d.getTime() - yearStart.getTime()) / 86400000) + 1;

  // ISO 8601 week computation: the ISO week containing `d` is the week
  // whose Thursday is in the same calendar year as `d`. Weeks start on
  // Monday; weekday 0 (Sunday) is treated as 7 for the +4−(wday||7)
  // shift to land on Thursday of the same week.
  const isoTarget = new Date(d);
  isoTarget.setHours(0, 0, 0, 0);
  isoTarget.setDate(isoTarget.getDate() + 4 - (isoTarget.getDay() || 7));
  const isoYear = isoTarget.getFullYear();
  const firstThu = new Date(isoYear, 0, 4);
  firstThu.setHours(0, 0, 0, 0);
  firstThu.setDate(firstThu.getDate() + 4 - (firstThu.getDay() || 7));
  const isoWeek = 1 + Math.round((isoTarget.getTime() - firstThu.getTime()) / (7 * 86400000));

  // Week of year — Sunday-first (%U) and Monday-first (%W). Both
  // report 00 for the partial week before the first Sunday / Monday
  // of the year, per strftime(3).
  const yStartDow = yearStart.getDay();
  const weekSun = Math.floor((doy + yStartDow - 1) / 7);
  const yStartDowMon = (yStartDow + 6) % 7;
  const weekMon = Math.floor((doy + yStartDowMon - 1) / 7);

  // Browsers report offset with the opposite sign to strftime's %z
  // (JS: minutes WEST of UTC; strftime: hours/minutes EAST of UTC).
  const tzOffset = d.getTimezoneOffset();
  const tzSign = tzOffset <= 0 ? '+' : '-';
  const tzAbs = Math.abs(tzOffset);
  const tzStr = `${tzSign}${pad(Math.floor(tzAbs / 60))}${pad(tzAbs % 60)}`;
  let tzName = '';
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d);
    tzName = parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch (_) {
    tzName = '';
  }

  const epoch = Math.floor(d.getTime() / 1000);

  return fmt.replace(/%(.)/g, (m, c) => {
    switch (c) {
      case 'Y': return String(year);
      case 'y': return pad(year % 100);
      case 'C': return pad(Math.floor(year / 100));
      case 'm': return pad(month + 1);
      case 'B': return monthsLong[month];
      case 'b': case 'h': return monthsShort[month];
      case 'd': return pad(day);
      case 'e': return spad(day);
      case 'j': return pad(doy, 3);
      case 'A': return weekdaysLong[wday];
      case 'a': return weekdaysShort[wday];
      case 'u': return String(wday === 0 ? 7 : wday);
      case 'w': return String(wday);
      case 'U': return pad(weekSun);
      case 'W': return pad(weekMon);
      case 'V': return pad(isoWeek);
      case 'G': return String(isoYear);
      case 'H': return pad(hour);
      case 'I': return pad(hour % 12 || 12);
      case 'k': return spad(hour);
      case 'l': return spad(hour % 12 || 12);
      case 'M': return pad(minute);
      case 'S': return pad(second);
      case 'p': return hour < 12 ? 'AM' : 'PM';
      case 'P': return hour < 12 ? 'am' : 'pm';
      case 'z': return tzStr;
      case 'Z': return tzName;
      case 's': return String(epoch);
      case 'D': return `${pad(month + 1)}/${pad(day)}/${pad(year % 100)}`;
      case 'F': return `${year}-${pad(month + 1)}-${pad(day)}`;
      case 'R': return `${pad(hour)}:${pad(minute)}`;
      case 'T': return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
      case 'r': return `${pad(hour % 12 || 12)}:${pad(minute)}:${pad(second)} ${hour < 12 ? 'AM' : 'PM'}`;
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return m; // unknown — pass through so typos are visible
    }
  });
}

/**
 * Fixed reference moment for the "Sample" preview row — Tuesday
 * 5 March 2024, 09:07:03 local time. Chosen so single-digit day and
 * single-digit hour exercise the space-padded variants (%e, %k, %l),
 * the weekday is distinct from "now", and every month-name code
 * produces a concrete output the user can recognise.
 */
const STRFTIME_SAMPLE_DATE = new Date(2024, 2, 5, 9, 7, 3);

/**
 * Open the strftime picker against `ta`. Captures the current cursor /
 * selection before opening (so Insert at the end drops the rendered
 * `strftime("…")` at the same spot the user was typing). Pre-fills the
 * Format input with the ISO 8601 datetime preset; that's the most
 * generally useful shape and is easy to edit from.
 *
 * @param {HTMLTextAreaElement} ta
 */
function openStrftimePicker(ta) {
  const dlg = $('#strftime-dialog');
  // Grab the cursor / selection immediately — the textarea preserves
  // its selection while unfocused, but capturing now makes the flow
  // robust if anything else (focus-stealing, IME) mutates it mid-open.
  const insertStart = ta.selectionStart;
  const insertEnd = ta.selectionEnd;

  const presetSel = /** @type {HTMLSelectElement} */ ($('#sf-preset'));
  const presetDesc = /** @type {HTMLElement} */ ($('#sf-preset-desc'));
  const formatInput = /** @type {HTMLInputElement} */ ($('#sf-format'));
  const previewNow = /** @type {HTMLElement} */ ($('#sf-preview-now'));
  const previewSample = /** @type {HTMLElement} */ ($('#sf-preview-sample'));
  const sampleLabel = /** @type {HTMLElement} */ ($('#sf-sample-label'));
  const readoutCode = /** @type {HTMLElement} */ ($('#sf-readout-code'));
  const insertBtn = /** @type {HTMLButtonElement} */ ($('#sf-insert'));

  // Snapshot of the current preset list (user-edited in Settings +
  // the Custom sentinel). Reading once per open is enough — the user
  // can't edit Settings while this dialog is modal.
  const presets = currentStrftimePresets();

  presetSel.replaceChildren();
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    presetSel.appendChild(opt);
  }
  // ISO datetime is the most generally useful reach-for default. Fall
  // back to the first non-custom preset if the user has deleted that
  // row from Settings; to the built-in default pattern if somehow even
  // that is missing; and finally to the empty string.
  const isoFromUser = presets.find((p) => p.id === 'iso-datetime');
  const isoFromDefaults = DEFAULT_STRFTIME_PRESETS.find((p) => p.id === 'iso-datetime');
  const firstReal = presets.find((p) => p.id !== 'custom');
  if (isoFromUser) {
    presetSel.value = 'iso-datetime';
    formatInput.value = isoFromUser.pattern;
  } else if (firstReal) {
    presetSel.value = firstReal.id;
    formatInput.value = firstReal.pattern;
  } else {
    presetSel.value = 'custom';
    formatInput.value = isoFromDefaults ? isoFromDefaults.pattern : '';
  }

  // Cheatsheet is built once per open. Small enough to rebuild cheaply
  // and keeps the DOM in sync if STRFTIME_CODES is ever edited.
  const cheatBody = /** @type {HTMLElement} */ ($('#sf-cheatsheet-body'));
  cheatBody.replaceChildren();
  for (const entry of STRFTIME_CODES) {
    const item = document.createElement('div');
    item.className = 'sf-cheat-item';
    const code = document.createElement('code');
    code.textContent = `%${entry.code}`;
    item.appendChild(code);
    const desc = document.createElement('span');
    desc.textContent = entry.desc;
    item.appendChild(desc);
    cheatBody.appendChild(item);
  }

  // Label the fixed sample row with the date we're formatting against,
  // so the user can mentally map codes to output (e.g. %B = "March").
  sampleLabel.textContent = ` (Tue 5 Mar 2024, 09:07:03)`;

  function render() {
    const preset = presets.find((p) => p.id === presetSel.value) || presets[0];
    presetDesc.textContent = preset.description;
    const fmt = formatInput.value;
    if (!fmt) {
      readoutCode.textContent = '(no format yet)';
      previewNow.textContent = '';
      previewSample.textContent = '';
      insertBtn.disabled = true;
      return;
    }
    readoutCode.textContent = `strftime("${awkStringEscape(fmt)}")`;
    previewNow.textContent = formatStrftime(fmt, new Date());
    previewSample.textContent = formatStrftime(fmt, STRFTIME_SAMPLE_DATE);
    insertBtn.disabled = false;
  }

  presetSel.onchange = () => {
    const preset = presets.find((p) => p.id === presetSel.value);
    if (preset && preset.id !== 'custom') {
      formatInput.value = preset.pattern;
    }
    render();
  };
  formatInput.oninput = () => {
    const match = presets.find(
      (p) => p.pattern === formatInput.value && p.id !== 'custom',
    );
    presetSel.value = match ? match.id : 'custom';
    render();
  };

  insertBtn.onclick = () => {
    const fmt = formatInput.value;
    if (!fmt) return;
    const call = `strftime("${awkStringEscape(fmt)}")`;
    const hadSelection = insertEnd > insertStart;
    editTextRange(ta, insertStart, insertEnd, call);
    dlg.close('insert');
    const action = hadSelection
      ? `replaced selection with ${call}`
      : `inserted ${call} at cursor`;
    showGawkInsertToast('strftime', action);
    ta.dispatchEvent(new Event('input'));
  };

  render();

  const sizeRaw = localStorage.getItem(LS_KEYS.STRFTIME_DLG_SIZE);
  if (sizeRaw) {
    try {
      const { width, height } = JSON.parse(sizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }
  dlg.showModal();
  setTimeout(() => formatInput.focus(), 0);
  const rect = dlg.getBoundingClientRect();
  let lastW = rect.width;
  let lastH = rect.height;
  const ro = new ResizeObserver(() => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
      lastW = r.width;
      lastH = r.height;
      safeSetItem(
        LS_KEYS.STRFTIME_DLG_SIZE,
        JSON.stringify({ width: r.width, height: r.height }),
      );
    }
  });
  ro.observe(dlg);
  dlg.addEventListener('close', () => ro.disconnect(), { once: true });
}

/**
 * Wire a "Timestamp…" button to open the strftime picker for `ta`.
 *
 * @param {HTMLButtonElement | null} btn
 * @param {HTMLTextAreaElement} ta
 */
export function wireStrftimeButton(btn, ta) {
  if (!btn) return;
  btn.onclick = (e) => {
    e.preventDefault();
    openStrftimePicker(ta);
  };
}
