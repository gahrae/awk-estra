// @ts-check
// Pipeline: state/render/preview/apply, auto-preview scheduling, drag-to-reorder,
// shell-copy, save-as-chain, chain ↔ pipeline conversions, inline-step dialog.
//
// Cross-module communication uses DOM custom events (no circular imports):
//   - dispatches 'pipeline:snippets-changed' after save-as-snippet creates a
//     new snippet — main wires this to renderSnippets
//   - dispatches 'pipeline:steps-changed' after every renderPipeline so the
//     palette can re-run its preview while open
// (Editing a snippet-ref step now goes through `openSnippetDialog` directly
// — see `editPipelineStep`. The chain dialog ↔ pipeline circular import is
// safe because both sides dereference at call time.)

import {
  $,
  uid,
  MOD_LABEL,
  renderParamRows,
  cleanParams,
  closestOn,
  editTextRange,
  safeSetItem,
  appAlert,
  appConfirm,
  appPrompt,
  highlightSidebarRow,
  showToast,
} from './core.js';
import { html } from './html.js';
import { LS_KEYS } from './data.js';
import { dispatch, on } from './events.js';
import {
  state,
  saveState,
  collectPipelineVars,
  stepLabel,
  resolveStepVars,
  chainParamUsage,
} from './state.js';
import { settings } from './settings.js';
import {
  runAwk,
  runAwkMulti,
  findCandidateVars,
  flattenAwkProgram,
  extractBeginIoAssignments,
  findBeginBodyStartOffset,
} from './awk.js';
import { getSel, writeOutput } from './editor.js';
import { resolveInput } from './inputMode.js';
import { truncateLines } from './core.js';
// dialogs.js imports openInlineStepDialog from here — the circular edge is
// safe because both sides dereference at call time, not at module eval.
import {
  attachTemplatePicker,
  renderInlineStepReference,
  openSnippetDialog,
  wireDetectFsButton,
  wireColumnsButton,
  wireFpatButton,
  wireStrftimeButton,
  wireFormatButton,
} from './dialogs.js';
import { findSideEffectsAcross } from './safety.js';
import {
  createPreviewRunner,
  resolvePreviewInput,
  gatePreviewOrNull,
  renderPreviewGate,
  writePreviewStderr,
  writePreviewStdout,
  formatPreviewInputLabel,
} from './previewRunner.js';

// ---------- auto-preview scheduler ----------
/**
 * Debounce handle for the pipeline's auto-preview. Fires a full pipeline run
 * against the current selection after step/var edits settle. Gated by
 * `settings.pipeline.autoPreviewOnStepChange`.
 * @type {ReturnType<typeof setTimeout> | null}
 */
let autoPreviewTimer = null;
export function scheduleAutoPreview() {
  clearTimeout(autoPreviewTimer);
  if (!settings.pipeline.autoPreviewOnStepChange) return;
  if (!state.pipeline.length) return;
  // Safety gate: skip auto-preview entirely when the user has set "always
  // manual" or when any step program has side effects. The user's manual
  // run path (Run pipeline / Apply) is unaffected; it still goes through
  // runAwk's forbidden-pattern check.
  if (settings.safety?.requireManualPreview) return;
  const programs = state.pipeline.map((step) => {
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    return sn ? sn.program : step.program || '';
  });
  if (findSideEffectsAcross(programs).length) return;
  autoPreviewTimer = setTimeout(() => {
    previewPipeline();
  }, 300);
}

// A flip of the Input toggle (Current Tab ↔ All Tabs) or a selection
// appearing/clearing changes what the next preview would process, so
// refresh the pipeline preview when the pipeline has steps. Routed
// through `scheduleAutoPreview` so all the usual rules apply — auto-
// preview off, requireManualPreview, or side-effecting programs all
// still block the refresh.
on('input-mode:changed', () => scheduleAutoPreview());

// ---------- mutations ----------

/**
 * Expand the pipeline `<section>` if it's currently collapsed, updating
 * the toggle button's `aria-expanded` and persisting the user's new
 * preference. No-op if already expanded. Called by every mutation path
 * that adds steps — if the user just made the pipeline bigger, they
 * should see the result.
 */
function expandPipelineIfCollapsed() {
  const pipelineEl = $('#pipeline');
  if (!pipelineEl || !pipelineEl.classList.contains('collapsed')) return;
  pipelineEl.classList.remove('collapsed');
  const btn = $('#pipeline-collapse');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  safeSetItem(LS_KEYS.PIPELINE_COLLAPSED, '0');
}

export function addPipelineStep(step) {
  state.pipeline.push(step);
  state.activeStep = state.pipeline.length - 1;
  const newIndex = state.pipeline.length - 1;
  renderPipeline();
  scheduleAutoPreview();
  expandPipelineIfCollapsed();
  // Briefly highlight the new step.
  requestAnimationFrame(() => {
    const li = /** @type {HTMLElement | null} */ (
      document.querySelector(`#pipeline-steps li[data-index="${newIndex}"]`)
    );
    if (!li) return;
    li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    li.classList.add('pulse-success');
    setTimeout(() => li.classList.remove('pulse-success'), 1300);
  });
}

export function chainStepToPipelineStep(st) {
  // Preserve the chain step's `id` when present — `chain.stepVars`
  // keys on it, so pipelineStepVars (which the chain-loader copies
  // across) only matches up if we keep the same ids. Steps created
  // from outside a chain (`addPipelineStep` callers that don't set an
  // id) still get a fresh uid().
  const id = st.id || uid();
  if (st.snippetId) return { id, snippetId: st.snippetId };
  /** @type {any} */
  const step = { id, program: st.program || '' };
  if (st.name) step.name = st.name;
  // Deep-copy params so pipeline-side edits don't reach back into the
  // saved chain definition. Previously dropped entirely — inline steps
  // with declared `-v` parameters arrived in the pipeline with no params
  // rows, and the chain's `sep=','` / `col=1` defaults silently vanished.
  if (st.params && st.params.length) step.params = st.params.map((p) => ({ ...p }));
  return step;
}

export function loadChainIntoPipeline(chain) {
  // Preserve chain step ids so `pipelineStepVars` keys line up with the
  // copied `chain.stepVars`. Whole pipeline is replaced, so there's no
  // risk of id collisions with pre-existing steps.
  state.pipeline = chain.steps.map((st) => chainStepToPipelineStep(st));
  state.activeStep = null;
  // Replace pipeline-level vars with the chain's saved overrides — loading a
  // chain should bring its variable defaults along. Names not in chain.vars
  // fall through to the step-level defaults at runtime as usual.
  state.pipelineVars = { ...(chain.vars || {}) };
  // Per-step overrides and the per-step mode flag carry through so every
  // step keeps the value it had in the chain. `resolveStepVars` reads
  // these at run time and `renderPipelineVars` surfaces them in the UI.
  state.pipelineStepVars = {};
  if (chain.stepVars) {
    for (const [sid, overrides] of Object.entries(chain.stepVars)) {
      state.pipelineStepVars[sid] = { ...overrides };
    }
  }
  state.pipelinePerStepNames = [...(chain.perStepNames || [])];
  renderPipeline();
  scheduleAutoPreview();
  // If the user just dropped a whole chain into the pipeline, they
  // want to see it — expand the panel if collapsed.
  if (state.pipeline.length) expandPipelineIfCollapsed();
}

export function appendChainToPipeline(chain) {
  // Snapshot each existing / incoming using-step's resolved value BEFORE
  // mutating state so we can detect value conflicts the flat scalar
  // can't represent and auto-engage per-step mode.
  const synthExisting = {
    steps: state.pipeline,
    vars: state.pipelineVars,
    stepVars: state.pipelineStepVars,
    perStepNames: state.pipelinePerStepNames,
  };
  const existingResolved = resolvedByStepId(
    chainParamUsage({ steps: state.pipeline }),
    (s) => resolveStepVars(synthExisting, s),
  );
  const incomingResolved = resolvedByStepId(chainParamUsage(chain), (s) =>
    resolveStepVars(chain, s),
  );

  // Fresh ids on appended steps so repeat appends of the same chain (or
  // any chain-step id that collides with an existing pipeline step) don't
  // let `pipelineStepVars` entries apply to the wrong step.
  /** @type {Record<string, string>} old chain-step id → new pipeline-step id */
  const idMap = {};
  const newSteps = chain.steps.map((st) => {
    const step = chainStepToPipelineStep(st);
    const oldId = st.id || step.id;
    step.id = uid();
    idMap[oldId] = step.id;
    return step;
  });
  state.pipeline.push(...newSteps);
  state.activeStep = state.pipeline.length - 1;

  // Merge chain.vars — last append wins. Preserved even on auto-promote
  // so a chain carrying `vars[msg]='chain'` alongside per-step `a,b,c`
  // brings `msg='chain'` through as the flat fallback for any step
  // without its own per-step value.
  if (chain.vars) {
    for (const [k, v] of Object.entries(chain.vars)) state.pipelineVars[k] = v;
  }

  const perStepSet = new Set(state.pipelinePerStepNames);
  for (const [name, incomingByOldId] of Object.entries(incomingResolved)) {
    const existingByStepId = existingResolved[name] || {};
    if (!shouldPromoteOnAppend(chain, name, existingByStepId, incomingByOldId, perStepSet)) {
      continue;
    }
    const flatVal = state.pipelineVars[name];
    for (const [sid, { val, param }] of Object.entries(existingByStepId)) {
      snapshotPipelineStepVar(sid, name, val, param, flatVal);
    }
    for (const [oldSid, { val, param }] of Object.entries(incomingByOldId)) {
      const newSid = idMap[oldSid];
      if (!newSid) continue;
      snapshotPipelineStepVar(newSid, name, val, param, flatVal);
    }
    perStepSet.add(name);
  }
  state.pipelinePerStepNames = [...perStepSet];

  renderPipeline();
  scheduleAutoPreview();
  if (newSteps.length) expandPipelineIfCollapsed();
}

/**
 * Map each `(name, stepId)` pair in a usage map to the value the given
 * `resolve` function returns for that step, alongside the param that
 * declared the name (so callers can consult its default without a
 * second lookup).
 *
 * @param {Record<string, {stepId: string, step: any, param: any}[]>} usage
 * @param {(step: any) => Record<string, string>} resolve
 * @returns {Record<string, Record<string, { val: string, param: any }>>}
 */
function resolvedByStepId(usage, resolve) {
  /** @type {Record<string, Record<string, { val: string, param: any }>>} */
  const out = {};
  for (const [name, uses] of Object.entries(usage)) {
    out[name] = {};
    for (const u of uses) {
      out[name][u.stepId] = { val: resolve(u.step)[name], param: u.param };
    }
  }
  return out;
}

/**
 * Decide whether `name` should be per-step after appending `chain`.
 * True when any of:
 *   - existing pipeline already had it per-step,
 *   - the chain declares it per-step (via `perStepNames` or a non-empty
 *     `stepVars` entry),
 *   - combined existing + incoming resolved values disagree across
 *     steps — a single flat scalar can't represent that.
 *
 * @param {any} chain
 * @param {string} name
 * @param {Record<string, { val: string, param: any }>} existingByStepId
 * @param {Record<string, { val: string, param: any }>} incomingByOldId
 * @param {Set<string>} perStepSet
 */
function shouldPromoteOnAppend(chain, name, existingByStepId, incomingByOldId, perStepSet) {
  if (perStepSet.has(name)) return true;
  if ((chain.perStepNames || []).includes(name)) return true;
  if (
    chain.stepVars &&
    Object.values(chain.stepVars).some((sv) => sv[name] !== undefined && sv[name] !== '')
  ) {
    return true;
  }
  const combined = new Set([
    ...Object.values(existingByStepId).map((e) => e.val),
    ...Object.values(incomingByOldId).map((e) => e.val),
  ]);
  return combined.size > 1;
}

/**
 * Write `val` into `state.pipelineStepVars[sid][name]` only when runtime
 * per-step resolution *wouldn't* already produce it. In per-step mode
 * resolveStepVars returns the step's own declared default if set, else
 * the chain-level flat fallback. If `val` equals either, no override is
 * needed — the fallback will do the job and we keep pipelineStepVars
 * minimal so the UI shows placeholders, not redundant values.
 *
 * @param {string} sid
 * @param {string} name
 * @param {string | undefined} val
 * @param {{ default?: string } | undefined} param
 * @param {string | undefined} flatVal  post-merge state.pipelineVars[name]
 */
function snapshotPipelineStepVar(sid, name, val, param, flatVal) {
  if (val === undefined) return;
  const def = param?.default;
  const hasStepDef = def !== undefined && def !== '';
  const hasFlat = flatVal !== undefined && flatVal !== '';
  const naturalVal = hasStepDef ? def : hasFlat ? flatVal : '';
  if (val === naturalVal) return;
  if (!state.pipelineStepVars[sid]) state.pipelineStepVars[sid] = {};
  if (state.pipelineStepVars[sid][name] === undefined) {
    state.pipelineStepVars[sid][name] = val;
  }
}

// ---------- render ----------
export function renderPipeline() {
  const ul = $('#pipeline-steps');
  ul.innerHTML = '';
  state.pipeline.forEach((step, i) => {
    ul.appendChild(buildPipelineStepLi(step, i));
  });
  renderPipelineVars();
  renderPipelineOutputs();
  // Notify subscribers (currently just the palette) that the pipeline shape
  // may have changed — reorder, add, delete, or active-step move. Fired
  // unconditionally from renderPipeline() so every mutation site stays
  // single-source and we don't have to remember to dispatch elsewhere.
  dispatch('pipeline:steps-changed');
}

/**
 * Build the `<li>` for a single pipeline step at index `i`, with its
 * drag-reorder and click-action handlers attached. Split out of
 * `renderPipeline` to keep the top-level render loop skimmable and to
 * isolate each concern (drag vs. click) in its own helper.
 *
 * @param {any} step
 * @param {number} i
 */
function buildPipelineStepLi(step, i) {
  const li = document.createElement('li');
  li.draggable = true;
  li.dataset.index = String(i);
  if (state.activeStep === i) li.classList.add('active');
  if (step.errored) li.classList.add('errored');
  attachPipelineStepReorderHandlers(li, i);
  li.innerHTML = `
    <span class="step-label"></span>
    <button data-act="up" title="Move left">◀</button>
    <button data-act="down" title="Move right">▶</button>
    <button data-act="edit" title="Edit">✎</button>
    <button data-act="rm" title="Remove">✕</button>`;
  // Prefix with the step's 1-based position so users can match a step
  // to its per-step variable row (which labels itself "N. stepLabel").
  li.querySelector('.step-label').textContent = `${i + 1}. ${stepLabel(step)}`;
  attachPipelineStepClickHandler(li, i);
  return li;
}

/**
 * Wire HTML5 drag-and-drop so a pipeline step can be dropped onto
 * another to reorder. `from` is the source index (read from
 * dataTransfer), `to` is this element's index. Self-drops clear the
 * `drag-over` styling and early-return.
 *
 * @param {HTMLLIElement} li
 * @param {number} i  this step's position in `state.pipeline`
 */
function attachPipelineStepReorderHandlers(li, i) {
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
    if (!Number.isInteger(from) || from === i) return;
    const moved = state.pipeline.splice(from, 1)[0];
    state.pipeline.splice(i, 0, moved);
    state.activeStep = i;
    renderPipeline();
    scheduleAutoPreview();
  });
}

/**
 * Delegate clicks on a pipeline step's action buttons (up / down /
 * edit / remove). A click on the `<li>` body with no button target
 * falls through to the "select active step" branch.
 *
 * @param {HTMLLIElement} li
 * @param {number} i
 */
function attachPipelineStepClickHandler(li, i) {
  li.addEventListener('click', (e) => {
    const act = closestOn(e, 'button')?.dataset?.act;
    if (act === 'up' && i > 0) {
      [state.pipeline[i - 1], state.pipeline[i]] = [state.pipeline[i], state.pipeline[i - 1]];
      renderPipeline();
      scheduleAutoPreview();
    } else if (act === 'down' && i < state.pipeline.length - 1) {
      [state.pipeline[i], state.pipeline[i + 1]] = [state.pipeline[i + 1], state.pipeline[i]];
      renderPipeline();
      scheduleAutoPreview();
    } else if (act === 'edit') {
      editPipelineStep(i);
    } else if (act === 'rm') {
      const removed = state.pipeline.splice(i, 1)[0];
      if (removed && removed.id && state.pipelineStepVars) {
        delete state.pipelineStepVars[removed.id];
      }
      if (state.activeStep !== null && state.activeStep >= state.pipeline.length) {
        state.activeStep = state.pipeline.length ? state.pipeline.length - 1 : null;
      }
      renderPipeline();
      scheduleAutoPreview();
    } else {
      state.activeStep = i;
      renderPipeline();
    }
  });
}

function renderPipelineVars() {
  const container = $('#pipeline-vars');
  // Capture which var input (if any) had focus + its caret position before
  // blowing the container away. Auto-preview triggers a full re-render, so
  // without this the user's typing would lose focus as soon as the preview
  // debounce fires. `stepId` is empty for chain-level inputs.
  const active = /** @type {HTMLInputElement|null} */ (document.activeElement);
  const restore =
    active && active.tagName === 'INPUT' && container.contains(active)
      ? {
          name: active.dataset.varName || '',
          stepId: active.dataset.stepId || '',
          start: active.selectionStart ?? 0,
          end: active.selectionEnd ?? 0,
        }
      : null;
  container.innerHTML = '';
  const usage = chainParamUsage({ steps: state.pipeline });
  const names = Object.keys(usage);
  if (!names.length) return;
  const head = document.createElement('div');
  head.className = 'pipeline-vars-head';
  head.textContent = 'Variables';
  container.appendChild(head);
  const list = document.createElement('ul');
  list.className = 'pipeline-vars-list';
  const perStepNames = new Set(state.pipelinePerStepNames);

  // Placeholder copy for a per-step input — mirrors run-time precedence
  // under per-step mode (step default > chain-level fallback).
  const perStepPlaceholder = (param, name) => {
    if (param.default !== undefined && param.default !== '') {
      return `default: ${param.default}`;
    }
    const chainVal = state.pipelineVars[name];
    if (chainVal !== undefined && chainVal !== '') {
      return `pipeline default: ${chainVal}`;
    }
    return '(no default — will prompt)';
  };

  for (const name of names) {
    const uses = usage[name];
    const defaultParam = uses[0].param;
    const expanded = perStepNames.has(name) && uses.length > 1;

    const li = document.createElement('li');
    li.className = 'chain-var-row';

    // ----- chain-level row -----
    const row = document.createElement('div');
    row.className = 'chain-var-head';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    row.appendChild(label);

    // Chain-level input: meaningful in both modes. In flat mode it
    // overrides every step; in per-step mode it's the fallback for
    // steps without their own default.
    /** @type {{input: HTMLInputElement, param: import('./types.js').Param}[]} */
    const subInputsForName = [];
    const chainInput = document.createElement('input');
    chainInput.type = 'text';
    chainInput.spellcheck = false;
    chainInput.dataset.varName = name;
    chainInput.value =
      state.pipelineVars[name] !== undefined ? state.pipelineVars[name] : '';
    chainInput.placeholder = defaultParam.default
      ? `No value, default is ${defaultParam.default}`
      : 'No value, no default';
    chainInput.addEventListener('input', () => {
      // Clearing the field removes the override entirely so collectPipelineVars
      // (state.js) falls back to `p.default` — matches the placeholder copy.
      const v = chainInput.value;
      if (v === '') delete state.pipelineVars[name];
      else state.pipelineVars[name] = v;
      // Sub-input placeholders reflect the chain-level value when the
      // step has no default of its own — refresh them in place so the
      // user doesn't lose focus to a full re-render.
      for (const { input, param } of subInputsForName) {
        input.placeholder = perStepPlaceholder(param, name);
      }
      scheduleAutoPreview();
    });
    row.appendChild(chainInput);

    // Per-step toggle — only offered when multiple steps use this
    // name. A single-using-step name wouldn't need to differentiate.
    if (uses.length > 1) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'chain-var-perstep-toggle';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? 'Per-step ▾' : 'Different per step? ▸';
      toggle.title = 'Set a different value for each step that uses this variable';
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (perStepNames.has(name)) {
          // Collapse: drop every per-step override for this name so
          // chain-level + step defaults take over again.
          const next = state.pipelinePerStepNames.filter((n) => n !== name);
          state.pipelinePerStepNames = next;
          for (const u of uses) {
            if (state.pipelineStepVars[u.stepId]) {
              delete state.pipelineStepVars[u.stepId][name];
              if (Object.keys(state.pipelineStepVars[u.stepId]).length === 0) {
                delete state.pipelineStepVars[u.stepId];
              }
            }
          }
        } else {
          state.pipelinePerStepNames = [...state.pipelinePerStepNames, name];
        }
        renderPipelineVars();
        scheduleAutoPreview();
      });
      row.appendChild(toggle);
    }
    li.appendChild(row);

    // ----- per-step rows (only when expanded) -----
    if (expanded) {
      const subList = document.createElement('ul');
      subList.className = 'chain-var-perstep-list';
      for (const u of uses) {
        const subLi = document.createElement('li');
        subLi.className = 'chain-var-perstep-row';
        const subLabel = document.createElement('span');
        subLabel.className = 'chain-var-perstep-label muted';
        subLabel.textContent = `${u.index + 1}. ${stepLabel(u.step)}`;
        const subInput = document.createElement('input');
        subInput.type = 'text';
        subInput.spellcheck = false;
        subInput.dataset.varName = name;
        subInput.dataset.stepId = u.stepId;
        const cur = state.pipelineStepVars[u.stepId]?.[name];
        subInput.value = cur !== undefined ? cur : '';
        subInput.placeholder = perStepPlaceholder(u.param, name);
        subInput.addEventListener('input', () => {
          const v = subInput.value;
          if (!state.pipelineStepVars[u.stepId]) state.pipelineStepVars[u.stepId] = {};
          if (v === '') delete state.pipelineStepVars[u.stepId][name];
          else state.pipelineStepVars[u.stepId][name] = v;
          if (Object.keys(state.pipelineStepVars[u.stepId]).length === 0) {
            delete state.pipelineStepVars[u.stepId];
          }
          scheduleAutoPreview();
        });
        subInputsForName.push({ input: subInput, param: u.param });
        subLi.appendChild(subLabel);
        subLi.appendChild(subInput);
        subList.appendChild(subLi);
      }
      li.appendChild(subList);
    }
    list.appendChild(li);
  }
  container.appendChild(list);
  // Put focus back on whichever var input was being typed into, keyed by
  // both var name and step id so per-step rows restore correctly.
  if (restore && restore.name) {
    const sel = restore.stepId
      ? `input[data-var-name="${CSS.escape(restore.name)}"][data-step-id="${CSS.escape(restore.stepId)}"]`
      : `input[data-var-name="${CSS.escape(restore.name)}"]:not([data-step-id])`;
    const next = /** @type {HTMLInputElement|null} */ (container.querySelector(sel));
    if (next) {
      next.focus();
      try {
        next.setSelectionRange(restore.start, restore.end);
      } catch (_) {
        // The element we found isn't a selection-aware input (some
        // browsers throw on number / range inputs). Focus is enough.
      }
    }
  }
}

function renderPipelineOutputs() {
  const out = $('#pipeline-outputs');
  if (!state.pipeline.length) {
    out.innerHTML = `<div class="empty">Empty pipeline. Click → on a snippet to add it, or build an ad-hoc step from the ${MOD_LABEL}+K palette.</div>`;
    return;
  }
  const i = state.activeStep ?? state.pipeline.length - 1;
  const step = state.pipeline[i];
  if (!step) {
    out.innerHTML = '';
    return;
  }
  const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
  const name = stepLabel(step);
  const prog = sn ? sn.program : step.program || '';
  const output = step.output;
  out.innerHTML = html`
    <div class="step-meta">Step ${i + 1}: <span class="name">${name}</span> — <code>${prog}</code></div>
    <pre></pre>`;
  const pre = out.querySelector('pre');
  if (output == null) pre.textContent = '(not run yet — click Preview or Run & Apply)';
  else pre.textContent = output;
  if (step.errored) pre.style.color = 'var(--danger)';
  else pre.style.color = '';
}

// ---------- edit step ----------
function editPipelineStep(i) {
  const step = state.pipeline[i];
  if (!step) return;
  if (step.snippetId) {
    const sn = state.snippets.find((s) => s.id === step.snippetId);
    if (!sn) {
      appAlert('Snippet no longer exists.', { level: 'error' });
      return;
    }
    // Open the snippet dialog in fork-aware mode: the user can either
    // Update global snippet (mutates the shared snippet — every chain /
    // pipeline reference picks up the change) or Fork to inline step
    // (replaces just this pipeline step's `snippetId` reference with an
    // inline copy carrying the edited program / name / params; the global
    // snippet is unchanged). Mirrors the chain dialog's behaviour so the
    // same affordance covers both surfaces — without it, a tweak made
    // here silently mutates the library snippet.
    openSnippetDialog(sn, {
      forkContext: 'this pipeline step',
      forkInto: (payload) => {
        delete step.snippetId;
        delete step.name;
        delete step.params;
        step.program = payload.program;
        if (payload.name) step.name = payload.name;
        if (payload.params && payload.params.length) step.params = payload.params;
        renderPipeline();
        scheduleAutoPreview();
      },
    });
  } else {
    openInlineStepDialog(step, undefined, state.pipeline.slice(0, i));
  }
}

/**
 * Open the inline-step editor. When `precedingSteps` is supplied, the dialog
 * offers a Preview toggle that runs those steps (in order) against the active
 * tab and pipes the output through the step's current program.
 *
 * @param {any} step            the step being created or edited (mutated on save)
 * @param {() => void} [onChange] invoked after save / save-as-snippet
 * @param {any[]} [precedingSteps] steps that would run before this one
 */
export function openInlineStepDialog(step, onChange, precedingSteps = []) {
  const dlg = $('#inline-step-dialog');
  const ta = /** @type {HTMLTextAreaElement} */ ($('#inline-step-program'));
  ta.value = step.program || '';
  $('#inline-step-name').value = step.name || '';
  ta.dispatchEvent(new Event('input'));
  const paramsUl = $('#inline-step-params');
  const paramsDetails = /** @type {HTMLDetailsElement} */ ($('#inline-step-params-section'));
  const workingParams = step.params ? step.params.map((p) => ({ ...p })) : [];
  // Forward-declared thunk so row ✕ / + / Detect handlers can fire the
  // real debounced preview defined much further below. The thunk
  // re-reads `schedulePreview` at call time, so reassigning the `let`
  // later "publishes" the real scheduler to the handlers.
  /** @type {() => void} */
  let schedulePreview = () => {};
  const fireParamsChange = () => schedulePreview();
  renderParamRows(paramsUl, workingParams, fireParamsChange);
  paramsDetails.open = workingParams.length > 0;
  $('#inline-step-add-param').onclick = (e) => {
    e.preventDefault();
    workingParams.push({ name: '', default: '' });
    renderParamRows(paramsUl, workingParams, fireParamsChange);
    paramsDetails.open = true;
    fireParamsChange();
  };
  // Same "Detect from program" affordance the snippet dialog and palette
  // offer: tokenize the current program, surface every free identifier
  // that isn't a keyword / builtin / awk-special var / function decl-or-
  // call / array name, skip names already in workingParams. Helps the user
  // populate `-v` rows without retyping when they're inlining a step from
  // the palette or after editing.
  $('#inline-step-detect-params').onclick = (e) => {
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

  // Template picker — chip list + live preview + filter, same as the
  // snippet dialog. Click inserts the body at the caret (undo-preserving).
  attachTemplatePicker(ta, {
    listId: '#inline-step-template-list',
    previewId: '#inline-step-template-preview',
    filterId: '#inline-step-template-filter',
  });

  // Clear program — matches the snippet dialog's confirm-on-clear behavior.
  $('#inline-step-program-clear').onclick = async (e) => {
    e.preventDefault();
    if (!ta.value) return;
    if (settings.editor.confirmClearProgram) {
      const ok = await appConfirm('Clear the awk program?', {
        title: 'Clear program',
        danger: true,
        okLabel: 'Clear',
      });
      if (!ok) return;
    }
    editTextRange(ta, 0, ta.value.length, '');
  };

  // Sample provider for Detect FS, Fixed Columns, and FPAT: when there
  // are preceding steps, run them against the editor's current input
  // and hand each picker the output that *this* step will actually
  // receive — not the raw editor selection. Otherwise fall through
  // (return null) so the buttons default to the editor's `getSel()`
  // sample. Timestamp has no input-sample, so it's not wired here.
  const upstreamSample = async () => {
    if (!precedingSteps.length) return null;
    const { target } = getSel();
    /** @type {Record<string,string>} */
    const vars = {};
    const addParams = (list) => {
      if (!list) return;
      for (const p of list) if (vars[p.name] === undefined) vars[p.name] = p.default ?? '';
    };
    for (const s of precedingSteps) {
      if (s.snippetId) {
        const sn = state.snippets.find((x) => x.id === s.snippetId);
        addParams(sn?.params);
      } else {
        addParams(s.params);
      }
    }
    addParams(workingParams);
    let cur = target;
    for (const s of precedingSteps) {
      const sn = s.snippetId ? state.snippets.find((x) => x.id === s.snippetId) : null;
      const prog = sn ? sn.program : s.program || '';
      if (!prog) continue;
      const label = stepLabel(s);
      const r = await runAwk(prog, cur, vars);
      if (r.stderr) {
        showToast({
          title: `Error in preceding step "${label}"`,
          body: r.stderr,
          level: 'error',
          duration: 5000,
        });
        return null;
      }
      cur = r.stdout;
    }
    // `hasSel: false` — upstream output is a single contiguous string
    // with no selection-vs-tab distinction; pass a descriptive source
    // so the JSON-clone escalation can label the cloned chain
    // sensibly rather than inheriting the editor's active-tab name.
    return { target: cur, hasSel: false, source: { kind: 'upstream' } };
  };

  wireDetectFsButton($('#inline-step-detect-fs'), ta, upstreamSample);
  wireColumnsButton($('#inline-step-columns'), ta, upstreamSample);
  wireFpatButton($('#inline-step-fpat'), ta, upstreamSample);
  wireStrftimeButton($('#inline-step-strftime'), ta);
  wireFormatButton(
    /** @type {HTMLButtonElement} */ ($('#inline-step-format')),
    ta,
  );

  // Copy-I/O only makes sense when there's actually an upstream step to
  // copy from. For the first step the handler falls through to a "this
  // is the first step" toast anyway, but hiding the button avoids the
  // dead affordance. Toggle every open, not just on first render, since
  // the dialog instance is reused across edit targets.
  /** @type {HTMLButtonElement} */ ($('#inline-step-copy-io')).hidden =
    precedingSteps.length === 0;

  // "Copy I/O settings from preceding steps": walks upstream step BEGIN
  // blocks for assignments to FS / OFS / RS / ORS / FIELDWIDTHS / FPAT /
  // CONVFMT / OFMT (the vars that affect how this step would parse or
  // format its I/O), merges last-writer-wins across steps, drops any
  // var the current step already sets explicitly, and prepends a
  // `BEGIN { … }` block to the textarea. Disabled upstream steps are
  // ignored — they wouldn't run in a chain execution, so their
  // settings don't apply. Snippet-reference steps contribute via the
  // referenced snippet's program.
  $('#inline-step-copy-io').onclick = (e) => {
    e.preventDefault();
    copyIoSettingsFromSteps(ta, precedingSteps);
  };

  // Copy as shell — same single-step shell command the snippet dialog
  // produces: the live dialog program + cleaned working params, no vars
  // supplied so `-v` flags fall back to each param's declared default.
  const copyShellBtn = /** @type {HTMLButtonElement} */ ($('#inline-step-copy-shell'));
  copyShellBtn.onclick = async (e) => {
    e.preventDefault();
    const program = ta.value;
    if (!program.trim()) {
      appAlert('Program is empty.', { level: 'error' });
      return;
    }
    const params = cleanParams(workingParams);
    const cmd = buildStepsShellCommand([{ program, params }], {});
    const original = copyShellBtn.textContent;
    try {
      await navigator.clipboard.writeText(cmd);
      copyShellBtn.textContent = 'Copied!';
    } catch (err) {
      copyShellBtn.textContent = 'Copy failed';
      console.error(err);
    }
    setTimeout(() => {
      copyShellBtn.textContent = original;
    }, 1200);
  };

  // Download script — wraps the live dialog state as a single-step chain
  // and routes through `buildShellScriptFromTemplate`, sharing the
  // user's `settings.scriptExport` config with the snippet + chain
  // dialogs' equivalent buttons.
  const downloadShBtn = /** @type {HTMLButtonElement} */ ($('#inline-step-download-sh'));
  downloadShBtn.onclick = (e) => {
    e.preventDefault();
    const program = ta.value;
    if (!program.trim()) {
      appAlert('Program is empty.', { level: 'error' });
      return;
    }
    const params = cleanParams(workingParams);
    const name = $('#inline-step-name').value.trim() || 'step';
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

  // Preview toggle — runs `precedingSteps` on the active tab, then pipes
  // that through the current program. Cross-surface wiring (debounce,
  // staleness, toggle persistence, input-mode subscription, cleanup)
  // lives in `previewRunner.js`; here we just define the inline-step-
  // specific run (preceding-then-authored).
  const previewDetails = /** @type {HTMLDetailsElement} */ ($('#inline-step-preview-details'));
  const previewMeta = /** @type {HTMLElement} */ ($('#inline-step-preview-meta'));
  const previewOut = /** @type {HTMLElement} */ ($('#inline-step-preview-output'));
  previewOut.classList.remove('error');
  const refreshPreviewMeta = () => {
    let prefix;
    if (!precedingSteps.length) {
      prefix = 'no preceding steps — ';
    } else {
      // Count disabled ones so the user knows the preview is running
      // a narrower pipeline than the raw step count suggests — matches
      // the chain dialog's "N of M active" treatment.
      const disabled = precedingSteps.filter((s) => s.disabled).length;
      const n = precedingSteps.length;
      const active = n - disabled;
      const core = `${active} preceding step${active === 1 ? '' : 's'}`;
      const note = disabled ? ` (${disabled} disabled skipped)` : '';
      prefix = `${core}${note} · `;
    }
    previewMeta.textContent = `${prefix}${formatPreviewInputLabel()}`;
  };
  const runPreview = async (manual = false) => {
    if (!previewDetails.open) return;
    const program = ta.value;
    if (!manual) {
      const programs = precedingSteps.map((s) => {
        const sn = s.snippetId ? state.snippets.find((x) => x.id === s.snippetId) : null;
        return sn ? sn.program : s.program || '';
      });
      programs.push(program);
      const gate = gatePreviewOrNull(programs);
      if (gate) {
        renderPreviewGate(previewOut, gate, () => runPreview(true));
        return;
      }
    }
    const token = runner.guard.claim();
    /** @type {Record<string,string>} */
    const vars = {};
    const addParams = (list) => {
      if (!list) return;
      for (const p of list) if (vars[p.name] === undefined) vars[p.name] = p.default ?? '';
    };
    for (const s of precedingSteps) {
      if (s.snippetId) {
        const sn = state.snippets.find((x) => x.id === s.snippetId);
        addParams(sn?.params);
      } else {
        addParams(s.params);
      }
    }
    addParams(workingParams);
    const { src, singleInput, note } = resolvePreviewInput();
    let cur = singleInput;
    let firstStep = true;
    for (const s of precedingSteps) {
      const sn = s.snippetId ? state.snippets.find((x) => x.id === s.snippetId) : null;
      const prog = sn ? sn.program : s.program || '';
      const label = stepLabel(s);
      if (!prog) continue;
      const r =
        firstStep && src.kind === 'multi'
          ? await runAwkMulti(prog, src.inputs, vars)
          : await runAwk(prog, cur, vars);
      if (!runner.guard.isCurrent(token)) return;
      if (r.stderr) {
        writePreviewStderr(previewOut, `[error in preceding step "${label}"]\n${r.stderr}`);
        return;
      }
      cur = r.stdout;
      firstStep = false;
    }
    if (!program.trim()) {
      writePreviewStdout(previewOut, (cur || '(no output from preceding steps)') + note);
      return;
    }
    const r =
      firstStep && src.kind === 'multi'
        ? await runAwkMulti(program, src.inputs, vars)
        : await runAwk(program, cur, vars);
    if (!runner.guard.isCurrent(token)) return;
    if (r.stderr) writePreviewStderr(previewOut, r.stderr);
    else writePreviewStdout(previewOut, r.stdout + note);
  };
  const runner = createPreviewRunner({
    details: previewDetails,
    lsKey: LS_KEYS.INLINE_STEP_PREVIEW_ON,
    run: runPreview,
    refreshMeta: refreshPreviewMeta,
  });
  // Assign the real scheduler onto the forward-declared `let` up top
  // so the params handlers' thunk starts firing the actual preview.
  schedulePreview = runner.schedulePreview;
  ta.addEventListener('input', schedulePreview);
  paramsUl.addEventListener('input', schedulePreview);

  // Reference aside — shares LS_KEYS.REF_HIDDEN / REF_SIZE with the other
  // dialogs so the user's show/hide and width preferences carry across.
  renderInlineStepReference();
  const editorRow = /** @type {HTMLElement} */ (dlg.querySelector('.snippet-editor-row'));
  const refAside = /** @type {HTMLElement} */ ($('#inline-step-reference'));
  const refBtn = /** @type {HTMLButtonElement} */ ($('#inline-step-ref-toggle'));
  const refStored = localStorage.getItem(LS_KEYS.REF_HIDDEN);
  const refHidden = refStored === null ? !settings.ui.referenceDefaultShown : refStored === '1';
  editorRow.classList.toggle('ref-hidden', refHidden);
  refBtn.textContent = refHidden ? 'Show reference' : 'Hide reference';
  refBtn.onclick = (e) => {
    e.preventDefault();
    const hidden = !editorRow.classList.contains('ref-hidden');
    editorRow.classList.toggle('ref-hidden', hidden);
    refBtn.textContent = hidden ? 'Show reference' : 'Hide reference';
    safeSetItem(LS_KEYS.REF_HIDDEN, hidden ? '1' : '0');
  };
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

  // Apply persisted dialog size before showing so the initial frame isn't
  // the CSS default that then snaps to the saved size.
  const dlgSizeRaw = localStorage.getItem(LS_KEYS.INLINE_STEP_DLG_SIZE);
  if (dlgSizeRaw) {
    try {
      const { width, height } = JSON.parse(dlgSizeRaw);
      if (width) dlg.style.width = width + 'px';
      if (height) dlg.style.height = height + 'px';
    } catch (_) {
      // Corrupt LS size entry — fall back to CSS default.
    }
  }

  dlg.returnValue = '';
  dlg.showModal();

  // Persist dialog resize. Matches the snippet/chain/template pattern.
  const dlgRect0 = dlg.getBoundingClientRect();
  let lastDlgW = dlgRect0.width,
    lastDlgH = dlgRect0.height;
  const ro = new ResizeObserver(() => {
    const r = dlg.getBoundingClientRect();
    if (Math.abs(r.width - lastDlgW) > 2 || Math.abs(r.height - lastDlgH) > 2) {
      lastDlgW = r.width;
      lastDlgH = r.height;
      safeSetItem(
        LS_KEYS.INLINE_STEP_DLG_SIZE,
        JSON.stringify({ width: r.width, height: r.height }),
      );
    }
  });
  ro.observe(dlg);

  // Persist aside resize — disconnect on close to avoid leaked observers.
  const refRect0 = refAside.getBoundingClientRect();
  let lastRefW = refRect0.width,
    lastRefH = refRect0.height;
  const roRef = new ResizeObserver(() => {
    const r = refAside.getBoundingClientRect();
    if (Math.abs(r.width - lastRefW) > 2 || Math.abs(r.height - lastRefH) > 2) {
      lastRefW = r.width;
      lastRefH = r.height;
      safeSetItem(LS_KEYS.REF_SIZE, JSON.stringify({ width: r.width, height: r.height }));
    }
  });
  roRef.observe(refAside);

  const notify =
    onChange ||
    (() => {
      renderPipeline();
      scheduleAutoPreview();
    });
  dlg.addEventListener(
    'close',
    () => {
      ro.disconnect();
      roRef.disconnect();
      ta.removeEventListener('input', schedulePreview);
      paramsUl.removeEventListener('input', schedulePreview);
      runner.cleanup();
      const program = ta.value;
      const name = $('#inline-step-name').value.trim();
      const params = cleanParams(workingParams);
      if (dlg.returnValue === 'save') {
        step.program = program;
        if (name) step.name = name;
        else delete step.name;
        if (params.length) step.params = params;
        else delete step.params;
        step.output = undefined;
        step.errored = false;
        notify();
      } else if (dlg.returnValue === 'save-as-snippet') {
        if (!name) {
          appAlert('Give the step a name before saving it as a snippet.', { level: 'error' });
          openInlineStepDialog(step, onChange, precedingSteps);
          return;
        }
        if (!program.trim()) {
          appAlert('Program is empty.', { level: 'error' });
          openInlineStepDialog(step, onChange, precedingSteps);
          return;
        }
        if (state.snippets.some((s) => s.name === name)) {
          appAlert(`A snippet named "${name}" already exists. Pick a different name.`, {
            title: 'Name in use',
            level: 'error',
          });
          openInlineStepDialog(step, onChange, precedingSteps);
          return;
        }
        const snippet = { id: uid(), name, program };
        if (params.length) snippet.params = params;
        state.snippets.push(snippet);
        delete step.program;
        delete step.name;
        delete step.params;
        step.snippetId = snippet.id;
        step.output = undefined;
        step.errored = false;
        saveState();
        dispatch('pipeline:snippets-changed');
        notify();
      }
    },
    { once: true },
  );
}

// ---------- run ----------
/**
 * @param {boolean} [preview]
 * @param {import('./inputMode.js').ResolvedInput} [srcOverride] resolved
 *   input to use verbatim. `applyPipeline` resolves once at call time
 *   and passes it in so the sink returned from the compute matches
 *   the input gathered (a selection-change mid-await would otherwise
 *   break the pairing). When omitted, `resolveInput` is invoked here —
 *   used by `previewPipeline` where live-mode-tracking is the point.
 */
export async function runPipelineCompute(preview = false, srcOverride) {
  // Synthesize a chain-shaped object so per-step resolution works
  // the same way the chain runtime does. When `pipelineStepVars` /
  // `pipelinePerStepNames` are empty (the common, non-chain-loaded
  // case) this degrades to flat-mode precedence — identical to the
  // previous `collectPipelineVars()` behaviour.
  const synthChain = {
    steps: state.pipeline,
    vars: state.pipelineVars,
    stepVars: state.pipelineStepVars,
    perStepNames: state.pipelinePerStepNames,
  };
  const src = srcOverride || resolveInput();
  let cur = src.kind === 'single' ? src.input : '';
  let previewNote = '';
  // Max input lines applies only to the single-input preview path.
  // A manual selection overrides it (the user has already narrowed
  // scope); multi-file (All Tabs) previews bypass it too — users who
  // flipped to All Tabs mode have asserted intent to process every
  // tab, and per-file truncation would give a misleading preview.
  if (
    preview &&
    src.kind === 'single' &&
    src.source.kind !== 'selection' &&
    settings.preview.maxLines > 0
  ) {
    const { text, truncated, original } = truncateLines(cur, settings.preview.maxLines);
    cur = text;
    if (truncated)
      previewNote = `\n[preview limited to first ${settings.preview.maxLines} of ${original} input lines]`;
  }
  for (const step of state.pipeline) {
    step.output = undefined;
    step.errored = false;
  }
  let aborted = false;
  for (let i = 0; i < state.pipeline.length; i++) {
    const step = state.pipeline[i];
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    const prog = sn ? sn.program : step.program || '';
    // Resolve vars *per step* so a chain loaded with per-step
    // overrides (e.g. encode=base64, decode=base64 -d) runs each
    // step against the value the chain author wanted.
    const vars = resolveStepVars(synthChain, step);
    // Only the first step gets multi-file semantics. After step 0 the
    // stream is a single concatenated string; there are no per-file
    // boundaries left to preserve.
    const { stdout, stderr } =
      i === 0 && src.kind === 'multi'
        ? await runAwkMulti(prog, src.inputs, vars)
        : await runAwk(prog, cur, vars);
    if (stderr) {
      step.output = stderr;
      step.errored = true;
      state.activeStep = i;
      if (settings.pipeline.onError === 'skip') {
        continue;
      }
      aborted = true;
      break;
    }
    step.output = stdout;
    cur = stdout;
  }
  if (!aborted) state.activeStep = state.pipeline.length - 1;
  if (previewNote && !aborted && state.pipeline.length) {
    const last = state.pipeline[state.pipeline.length - 1];
    if (last && typeof last.output === 'string') last.output = last.output + previewNote;
  }
  renderPipeline();
  return { finalOutput: cur, aborted, src };
}

export async function previewPipeline() {
  if (!state.pipeline.length) return;
  await runPipelineCompute(true);
}

export async function applyPipeline() {
  if (!state.pipeline.length) return;
  // Resolve once up-front so the sink we write to matches the input we
  // gathered — otherwise a mid-run selection change could redirect the
  // output somewhere the user didn't intend.
  const src = resolveInput();
  const { finalOutput, aborted } = await runPipelineCompute(false, src);
  if (aborted) return;
  writeOutput(src.sink, finalOutput, {
    title: src.source.kind === 'allTabs' ? `Results: pipeline × ${src.source.count} tabs` : 'Results: pipeline',
  });
}

// ---------- shell copy + save-as-chain ----------
export function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build a shell pipe command for an arbitrary list of steps. Each step's
 * `awk` invocation only emits `-v` flags for variables declared by *that*
 * step (snippet refs resolved via `state.snippets`), never the union — so
 * vars don't leak across steps that don't reference them. Caller supplies
 * `vars`; per-name lookup falls back to the step param's `default` if the
 * caller didn't provide one.
 *
 * @param {any[]} steps
 * @param {Record<string,string>} vars
 * @returns {string}
 */
/**
 * Build the clipboard one-liner form of a chain / pipeline. Each
 * enabled step gets an `awk -v NAME='value' ...` where `value` is
 * resolved per-step via `resolveStepVars` — so a chain whose
 * `perStepNames` marks `cmd` as per-step gets the correct distinct
 * value inlined on each step's `-v cmd=…` flag.
 *
 * `ctx` is an optional chain context. When omitted, the output is
 * equivalent to the old flat behaviour (useful for the pipeline and
 * single-snippet Copy-shell paths that have no per-step overrides).
 *
 * @param {any[]} steps
 * @param {Record<string, string>} vars  chain-level var map
 * @param {{ stepVars?: Record<string, Record<string, string>>, perStepNames?: string[] }} [ctx]
 * @returns {string}
 */
export function buildStepsShellCommand(steps, vars, ctx = {}) {
  // Synth a chain-like object so `resolveStepVars` sees consistent
  // precedence (step default → chain.vars → stepVars → overlay).
  const synth = {
    steps,
    vars: vars || {},
    stepVars: ctx.stepVars || {},
    perStepNames: ctx.perStepNames || [],
  };
  return steps
    .filter((step) => !step.disabled)
    .map((step) => {
      const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
      const raw = sn ? sn.program : step.program || '';
      const prog = flattenAwkProgram(raw);
      const stepParams = sn ? sn.params || [] : step.params || [];
      const resolved = resolveStepVars(synth, step);
      const flags = stepParams
        .map((p) => `-v ${shellSingleQuote(`${p.name}=${resolved[p.name] ?? ''}`)}`)
        .join(' ');
      return `awk${flags ? ' ' + flags : ''} ${shellSingleQuote(prog)}`;
    })
    .join(' | ');
}

// ---------- template-based script export ----------
// The snippet and chain dialogs' "Download script" buttons route through this path.
// Honours `settings.scriptExport`:
//   - `flatten`  — each step's awk program is flattened via
//                  `flattenAwkProgram` when true (default); when false
//                  the original newlines survive inside the `'…'`.
//   - `extension` — appended to the sanitized chain name for the
//                   filename.
//   - `template`  — the body, with `{NAME}` tokens substituted.
// Copy-shell buttons (pipeline + per-snippet one-liners) continue to
// use `buildStepsShellCommand` unchanged.

/**
 * Sanitize a chain name for use as a filename stem. Lowercases, replaces
 * non-`[a-z0-9_-]` runs with `-`, trims leading/trailing dashes. Falls
 * back to `chain` if the result is empty.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeScriptStem(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'chain';
}

/**
 * Normalise the user-entered extension. Empty = no extension at all.
 * Otherwise ensure exactly one leading `.` and pass the rest through
 * unmodified (so `.tar.gz` stays `.tar.gz`, and a bare `sh` becomes
 * `.sh`).
 *
 * @param {string} ext
 * @returns {string}
 */
function normaliseScriptExtension(ext) {
  const s = String(ext ?? '').trim();
  if (!s) return '';
  return s.startsWith('.') ? s : '.' + s;
}

/**
 * For each `name` declared by any step, decide the shell-variable
 * shape the exported script should use:
 *   - Per-step: emit numbered `name_N` vars (1-based, by the step's
 *     position in the original `chain.steps` array, *not* among
 *     active-only), one per using step. Triggered when the chain
 *     lists the name in `perStepNames` AND ≥2 steps use it.
 *   - Flat: emit a single `name` var (legacy behaviour).
 *
 * Returns a lookup so `buildStepAwkInvocation` and
 * `buildVariablesBlock` can agree on what to emit.
 *
 * The returned structure:
 *   - `varNameFor(step, paramName)` → the shell var to reference in
 *     the awk invocation's `-v` flag (e.g. `cmd_3` or `cmd`).
 *   - `declarations` → ordered list of `{varName, defaultValue}` the
 *     variables block should emit. Duplicates (same name-value pair
 *     emitted by two steps in flat mode) are deduped.
 *
 * @param {any} chain  synth chain object: `{ steps, vars, stepVars, perStepNames }`
 */
function planChainScriptVars(chain) {
  const steps = chain.steps || [];
  const usage = chainParamUsage(chain);
  const perStepSet = new Set(chain.perStepNames || []);
  // Which names should number per step?
  /** @type {Set<string>} */
  const perStepNames = new Set();
  for (const [name, uses] of Object.entries(usage)) {
    if (perStepSet.has(name) && uses.length > 1) perStepNames.add(name);
  }
  /** @type {{ varName: string, defaultValue: string }[]} */
  const declarations = [];
  const seenFlatNames = new Set();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.disabled) continue;
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    const params = sn ? sn.params || [] : step.params || [];
    if (!params.length) continue;
    const resolved = resolveStepVars(chain, step);
    for (const p of params) {
      if (perStepNames.has(p.name)) {
        declarations.push({
          varName: `${p.name}_${i + 1}`,
          defaultValue: resolved[p.name] ?? '',
        });
      } else if (!seenFlatNames.has(p.name)) {
        seenFlatNames.add(p.name);
        declarations.push({
          varName: p.name,
          defaultValue: resolved[p.name] ?? '',
        });
      }
    }
  }
  /**
   * @param {any} step
   * @param {string} paramName
   * @returns {string}
   */
  const varNameFor = (step, paramName) => {
    if (!perStepNames.has(paramName)) return paramName;
    const idx = steps.indexOf(step);
    return `${paramName}_${idx + 1}`;
  };
  return { varNameFor, declarations };
}

/**
 * Build the `-v NAME="$NAME"` flag list and the `awk '…'` command for a
 * single step. Honours `flatten`: when false, the program keeps its
 * original newlines inside the single-quoted literal.
 *
 * `varNameFor(step, paramName)` resolves the shell-variable reference
 * to use — `name` in flat mode, `name_N` in per-step mode. See
 * `planChainScriptVars` for the selection rule.
 */
function buildStepAwkInvocation(step, flatten, varNameFor) {
  const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
  const raw = sn ? sn.program : step.program || '';
  const prog = flatten ? flattenAwkProgram(raw) : raw;
  const stepParams = sn ? sn.params || [] : step.params || [];
  const flags = stepParams
    .map((p) => `-v ${p.name}="$${varNameFor(step, p.name)}"`)
    .join(' ');
  return `awk${flags ? ' ' + flags : ''} ${shellSingleQuote(prog)}`;
}

/**
 * Build the shell-variable assignments for a chain's params. Returns
 * the empty string when there's nothing to declare, so a
 * `{VARIABLES_BLOCK}` token sitting alone on its template line
 * collapses the whole line out cleanly (see the substitution logic
 * in `buildShellScriptFromTemplate`).
 *
 * Emits ONLY the `NAME="${NAME:-default}"` lines — no header comment,
 * no usage-example comment. The template owns those (so the user can
 * rephrase or drop them) and they sit above the `{VARIABLES_BLOCK}`
 * token in the shipped default template.
 *
 * For per-step chains (`chain.perStepNames` listing a name used by
 * multiple steps), emits `name_N="${name_N:-…}"` lines — one per
 * using step — so the exported script can invoke each awk step with
 * that step's own default while still allowing a user override.
 *
 * @param {{ varName: string, defaultValue: string }[]} declarations
 *   output of `planChainScriptVars`
 * @returns {string}
 */
function buildVariablesBlock(declarations) {
  if (!declarations.length) return '';
  const lines = declarations.map(({ varName, defaultValue }) => {
    const escaped = defaultValue.replace(/"/g, '\\"');
    return `${varName}="\${${varName}:-${escaped}}"`;
  });
  return lines.join('\n');
}

/**
 * Build a downloadable script from a chain using the user's configured
 * template. Returns `{ filename, content }` — the caller is responsible
 * for wrapping in a Blob and triggering the download.
 *
 * Token substitution is single-pass over a regex match for `{TOKEN}`.
 * Tokens whose value itself contains tokens (today: `{USAGE_EXAMPLE}`
 * contains `{SCRIPT_NAME}`) are pre-expanded before the pass so the
 * user sees fully-resolved output.
 *
 * When `opts.perStepNames` names any param used by ≥2 steps, the
 * exported script emits numbered per-step vars (`name_N`) with each
 * step's resolved value as the default, so a chain that encodes and
 * decodes via distinct `cmd` values round-trips correctly when run
 * as a script. Snippet / inline-step / flat chains don't pass
 * `perStepNames` and get the legacy single-var output.
 *
 * @param {string} chainName
 * @param {any[]} steps
 * @param {Record<string, string>} vars
 * @param {{
 *   flatten?: boolean,
 *   extension?: string,
 *   template?: string,
 *   stepVars?: Record<string, Record<string, string>>,
 *   perStepNames?: string[],
 * }} [opts]
 * @returns {{ filename: string, content: string }}
 */
export function buildShellScriptFromTemplate(chainName, steps, vars, opts) {
  const cfg = opts || {};
  const flatten = cfg.flatten !== false;
  const extension = normaliseScriptExtension(cfg.extension ?? '.sh');
  const template = typeof cfg.template === 'string' ? cfg.template : '';

  const stem = sanitizeScriptStem(chainName);
  const scriptName = stem + extension;

  const activeSteps = steps.filter((step) => !step.disabled);
  const stepNames = activeSteps.map((s) => stepLabel(s));

  const stepNamesList = stepNames.map((n) => `# ${n}`).join('\n');
  const stepNamesListNumbered = stepNames.map((n, i) => `# ${i + 1}. ${n}`).join('\n');

  // Usage example is pre-expanded here so `{SCRIPT_NAME}` inside it
  // resolves in the single-pass substitution below.
  const usageExample = `# ./${scriptName} < INPUT_FILE`;

  // Build a synth chain so the same `resolveStepVars` /
  // `chainParamUsage` machinery used everywhere else applies. Script
  // export has always been a chain-shaped thing internally; this just
  // makes it explicit.
  const synthChain = {
    steps,
    vars: vars || {},
    stepVars: cfg.stepVars || {},
    perStepNames: cfg.perStepNames || [],
  };
  const { varNameFor, declarations } = planChainScriptVars(synthChain);

  const awkPipeCmd = activeSteps.length
    ? activeSteps.map((s) => buildStepAwkInvocation(s, flatten, varNameFor)).join(' \\\n  | ')
    : '';

  const variablesBlock = buildVariablesBlock(declarations);

  /** @type {Record<string, string>} */
  const tokens = {
    SCRIPT_NAME: scriptName,
    AWK_PIPE_CMD: awkPipeCmd,
    VARIABLES_BLOCK: variablesBlock,
    STEP_NAMES_LIST: stepNamesList,
    STEP_NAMES_LIST_NUMBERED: stepNamesListNumbered,
    USAGE_EXAMPLE: usageExample,
  };

  // First pass: when a line contains nothing but a single `{TOKEN}`
  // (optional surrounding whitespace) AND the token resolves to an
  // empty string, swallow the whole line — trailing newline included —
  // so the template's surrounding blank lines don't leave a double gap
  // where the token used to be. Tokens embedded within other content
  // on a line fall through to the second pass unchanged.
  const swept = template.replace(
    /^[ \t]*\{([A-Z_]+)\}[ \t]*\r?\n/gm,
    (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) return match;
      return tokens[name] === '' ? '' : match;
    },
  );
  // Second pass: substitute every remaining token in place. Unknown
  // tokens pass through literally so a typo is visible, not swallowed.
  const content = swept.replace(/\{([A-Z_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(tokens, name) ? tokens[name] : match,
  );

  return { filename: scriptName, content };
}

export function buildPipelineShellCommand() {
  return buildStepsShellCommand(state.pipeline, collectPipelineVars(), {
    stepVars: state.pipelineStepVars,
    perStepNames: state.pipelinePerStepNames,
  });
}

export async function copyPipelineShell() {
  if (!state.pipeline.length) {
    appAlert('Pipeline is empty.');
    return;
  }
  const cmd = buildPipelineShellCommand();
  const btn = $('#copy-pipeline');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(cmd);
    btn.textContent = 'Copied!';
  } catch (e) {
    btn.textContent = 'Copy failed';
    console.error(e);
  }
  setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

export async function savePipelineAsChain() {
  if (!state.pipeline.length) {
    appAlert('Nothing to save: the pipeline is empty.');
    return;
  }
  const name = await appPrompt('Chain name:', { title: 'Save pipeline as chain' });
  if (!name) return;
  const steps = state.pipeline.map((s) => {
    // Preserve the pipeline step's id so chain.stepVars (carried over
    // below) still matches its owning step after the save.
    /** @type {any} */
    const step = { id: s.id };
    if (s.snippetId) {
      step.snippetId = s.snippetId;
      return step;
    }
    step.program = s.program || '';
    if (s.name) step.name = s.name;
    // Deep-copy params so later pipeline edits to `s.params` don't bleed
    // into the saved chain definition. This was missed originally — an
    // inline step with `[{name:'sep', default:','}]` was being serialised
    // without its params, so the chain lost the `-v` values the user had
    // already dialled in.
    if (s.params && s.params.length) step.params = s.params.map((p) => ({ ...p }));
    return step;
  });
  /** @type {any} */
  const chain = { id: uid(), name: name.trim(), steps };
  // Carry pipeline-level vars, per-step overrides, and the per-step mode
  // flag through so a chain saved from a loaded-then-tweaked pipeline
  // round-trips cleanly. Prune orphan stepVars entries whose step id is
  // no longer in the pipeline.
  if (Object.keys(state.pipelineVars).length) chain.vars = { ...state.pipelineVars };
  const liveStepIds = new Set(steps.map((s) => s.id));
  /** @type {Record<string, Record<string, string>>} */
  const stepVars = {};
  for (const [sid, overrides] of Object.entries(state.pipelineStepVars)) {
    if (!liveStepIds.has(sid)) continue;
    if (Object.keys(overrides).length) stepVars[sid] = { ...overrides };
  }
  if (Object.keys(stepVars).length) chain.stepVars = stepVars;
  if (state.pipelinePerStepNames.length) {
    chain.perStepNames = [...state.pipelinePerStepNames];
  }
  state.chains.push(chain);
  saveState();
  dispatch('pipeline:chains-changed');
  // The event above re-renders the Chains list. Open the section if the
  // user had it collapsed, scroll to the new row, and flash it.
  highlightSidebarRow({ sectionKey: 'chains', listId: 'chains', itemId: chain.id });
}

/**
 * "Copy I/O settings from preceding steps": walks `precedingSteps`' BEGIN
 * blocks for assignments to FS / OFS / RS / ORS / FIELDWIDTHS / FPAT /
 * CONVFMT / OFMT (the vars that affect how the current step parses or
 * formats its I/O), merges last-writer-wins across steps, drops any var
 * the current step (`ta.value`) already sets explicitly, and prepends a
 * BEGIN block to `ta`. Disabled upstream steps are ignored; snippet-
 * reference steps contribute via the referenced snippet's program.
 *
 * Shared by the inline-step dialog and the command palette's pipeline-mode
 * row so both places agree on semantics.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {Array<{disabled?: boolean, snippetId?: string, program?: string}>} precedingSteps
 */
export function copyIoSettingsFromSteps(ta, precedingSteps) {
  /** @type {Map<string, string>} */
  const merged = new Map();
  let considered = 0;
  for (const prev of precedingSteps) {
    if (prev.disabled) continue;
    /** @type {string} */
    let prog = '';
    if (prev.snippetId) {
      const sn = state.snippets.find((s) => s.id === prev.snippetId);
      if (sn) prog = sn.program || '';
    } else {
      prog = prev.program || '';
    }
    if (!prog) continue;
    considered++;
    const assigns = extractBeginIoAssignments(prog);
    for (const [name, rhs] of assigns) merged.set(name, rhs);
  }
  const current = extractBeginIoAssignments(ta.value);
  /** @type {{name: string, upstream: string, current: string}[]} */
  const conflicts = [];
  for (const [name, currentRhs] of current) {
    const upstreamRhs = merged.get(name);
    if (upstreamRhs !== undefined && upstreamRhs !== currentRhs) {
      conflicts.push({ name, upstream: upstreamRhs, current: currentRhs });
    }
    merged.delete(name);
  }
  const conflictSummary = conflicts.length
    ? '\n\nKept your existing values for:\n' +
      conflicts
        .map((c) => `- ${c.name}: this step has ${c.current}; upstream set ${c.upstream}`)
        .join('\n')
    : '';
  if (merged.size === 0) {
    const reason = !considered
      ? 'There are no preceding steps to copy from.'
      : current.size > 0
        ? "Every I/O var set upstream is already set by this step's BEGIN block."
        : "Preceding BEGIN blocks don't assign FS, OFS, RS, ORS, FIELDWIDTHS, FPAT, CONVFMT, or OFMT.";
    showToast({
      title: 'No I/O settings to copy',
      body: reason + conflictSummary,
      level: 'info',
      duration: conflicts.length > 0 ? 6000 : 4000,
    });
    return;
  }
  const lines = [...merged.entries()].map(([name, rhs]) => `  ${name} = ${rhs};`);
  const insertAt = findBeginBodyStartOffset(ta.value);
  if (insertAt >= 0) {
    const next = ta.value.charAt(insertAt);
    const trailing = next === '\n' ? '' : '\n';
    editTextRange(ta, insertAt, insertAt, '\n' + lines.join('\n') + trailing);
  } else {
    const block = `BEGIN {\n${lines.join('\n')}\n}`;
    const sep = ta.value ? '\n\n' : '';
    editTextRange(ta, 0, 0, block + sep);
  }
  showToast({
    title: 'I/O settings copied',
    body:
      `Prepended a BEGIN block with ${merged.size} assignment${merged.size === 1 ? '' : 's'} (${[...merged.keys()].join(', ')}).` +
      conflictSummary,
    level: 'info',
    duration: conflicts.length > 0 ? 6000 : 3000,
  });
}
