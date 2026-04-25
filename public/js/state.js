// @ts-check
// App state (library + editor tabs + pipeline) and its persistence.

import { safeSetItem, uid, showToast } from './core.js';
import {
  LS_KEY,
  SEED_SNIPPETS,
  SEED_CHAINS,
  AWK_TEMPLATES_SEED,
  TEXT_SNIPPETS_SEED,
} from './data.js';

/**
 * @typedef {import('./types.js').AppState} AppState
 * @typedef {import('./types.js').Param} Param
 * @typedef {import('./types.js').PipelineStep} PipelineStep
 */

export const state = /** @type {AppState} */ ({
  snippets: [],
  chains: [],
  textSnippets: [],
  templates: [],
  tabs: [],
  activeTabId: null,
  pipeline: [],
  pipelineVars: {},
  // Per-step overrides that flow in from a chain with `perStepNames` so
  // loading a chain into the pipeline preserves per-step var intent
  // (encode-then-decode style). Keyed by pipeline step id.
  pipelineStepVars: /** @type {Record<string, Record<string, string>>} */ ({}),
  // Names for which per-step resolution applies (matches `chain.perStepNames`
  // from whichever chain was loaded). Empty = flat precedence only.
  pipelinePerStepNames: /** @type {string[]} */ ([]),
  activeStep: null,
  workspaces: [],
  // Intentionally not persisted — see saveState(). Reset to 'currentTab'
  // on every page load so a user who left the app in 'allTabs' last
  // session doesn't unknowingly process every open tab the next day.
  inputMode: 'currentTab',
});

/** @param {PipelineStep} step @returns {Param[]} */
export function paramsOf(step) {
  if (step.snippetId) {
    const sn = state.snippets.find((s) => s.id === step.snippetId);
    return (sn && sn.params) || [];
  }
  return step.params || [];
}

/**
 * Display label for a pipeline / chain step. Single source of truth so
 * every surface (pipeline list, palette preview, chain dialog, error
 * toasts) renders steps the same way.
 *
 * - Snippet-ref step → snippet's name verbatim (or `(missing snippet)` if
 *   the snippet has been deleted).
 * - Inline step with a name → `"<name> (inline)"`. The "(inline)" suffix
 *   is what tells the user this isn't a library reference, since otherwise
 *   `"CSV Column"` typed into an inline step would look indistinguishable
 *   from the saved `CSV Column` snippet.
 * - Inline step without a name → `"(inline)"`.
 *
 * @param {{snippetId?: string, name?: string}} step
 * @returns {string}
 */
export function stepLabel(step) {
  if (step.snippetId) {
    const sn = state.snippets.find((s) => s.id === step.snippetId);
    return sn ? sn.name : '(missing snippet)';
  }
  return step.name ? `${step.name} (inline)` : '(inline)';
}

/** @returns {{name:string, default?:string}[]} union of all pipeline step params */
export function pipelineParamList() {
  const seen = new Map();
  for (const step of state.pipeline) {
    for (const p of paramsOf(step)) {
      if (!seen.has(p.name)) seen.set(p.name, p.default);
    }
  }
  return [...seen.entries()].map(([name, def]) => ({ name, default: def }));
}

/** @returns {Record<string,string>} effective variable values for a pipeline run */
export function collectPipelineVars() {
  /** @type {Record<string,string>} */
  const vars = {};
  for (const { name, default: def } of pipelineParamList()) {
    vars[name] = state.pipelineVars[name] !== undefined ? state.pipelineVars[name] : (def ?? '');
  }
  return vars;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.snippets = parsed.snippets || [];
      state.chains = parsed.chains || [];
      state.textSnippets = parsed.textSnippets || [];
      state.templates = parsed.templates || [];
      state.tabs = parsed.tabs || [];
      state.activeTabId = parsed.activeTabId || null;
      state.workspaces = parsed.workspaces || [];
      // Every chain step needs a stable id — it's the key for
      // per-step var overrides in `chain.stepVars`. Backfill any
      // steps still missing one (pre-stepVars exports, legacy seeds).
      for (const c of state.chains) ensureChainStepIds(c);
    }
  } catch (err) {
    console.error('loadState: failed to parse library data', err);
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      try {
        const blob = new Blob([raw], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'awk-estra-recovery.json';
        a.textContent = 'Download raw data';
        a.style.color = 'var(--accent)';
        showToast({
          title: 'Library data is corrupted and could not be loaded.',
          body: 'Starting fresh. Click below to download the raw data for manual recovery.',
          level: 'error',
          duration: 0,
          dom: a,
        });
      } catch (_) {
        showToast({
          title: 'Library data is corrupted and could not be loaded.',
          body: 'Starting fresh. Check the browser console for the raw data.',
          level: 'error',
          duration: 15000,
        });
      }
    }
  }
  if (!state.snippets.length) {
    const seedIdToUid = seedSnippets();
    // Chains only seed alongside snippets, because they reference snippet
    // uids that were just generated. An existing user without any chains
    // won't get the seed set on their next load — they can import or create
    // the chains themselves.
    if (!state.chains.length) seedChains(seedIdToUid);
  }
  if (!state.templates.length) seedTemplates();
  if (!state.textSnippets.length) seedTextSnippets();
  if (!state.tabs.length) {
    state.tabs = [{ id: uid(), title: 'Tab 1', content: '' }];
    state.activeTabId = state.tabs[0].id;
  }
  if (!state.tabs.find((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
  }
}

// When "Reset application" is about to reload the page, we must stop any
// further writes to LS_KEY — otherwise the `beforeunload` handler in
// editor.js (and any still-pending debounced saves) would rewrite the
// in-memory library back on top of the just-cleared localStorage.
let _appResetting = false;
export function beginAppReset() {
  _appResetting = true;
}

let _lastSaveWarning = 0;
export function saveState() {
  if (_appResetting) return;
  const json = JSON.stringify({
    snippets: state.snippets,
    chains: state.chains,
    textSnippets: state.textSnippets,
    templates: state.templates,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    workspaces: state.workspaces,
  });
  const ok = safeSetItem(LS_KEY, json);
  if (ok) {
    const stored = localStorage.getItem(LS_KEY);
    if (stored && stored.length !== json.length) {
      const now = Date.now();
      if (now - _lastSaveWarning > 30000) {
        _lastSaveWarning = now;
        showToast({
          title: 'Save may be incomplete',
          body: `Written data (${stored.length} bytes) differs from expected (${json.length} bytes). Export your library now as a backup.`,
          level: 'error',
          duration: 15000,
        });
      }
    }
  }
}

/**
 * Seed snippets ship with optional `tests` arrays whose entries have no
 * `id` — assign fresh ids so the runner (tests.js) can key results by them.
 * `seedId` is stripped: it's only used at seed time to let chains reference
 * seed snippets across installs, and should not be persisted on the snippet.
 *
 * @param {import('./seeds/snippets.js').SeedSnippet} seed
 * @returns {import('./types.js').Snippet}
 */
function instantiateSeedSnippet(seed) {
  const { tests, seedId: _seedId, ...rest } = seed;
  /** @type {import('./types.js').Snippet} */
  const item = { id: uid(), ...rest };
  if (tests && tests.length) {
    item.tests = tests.map((t) => ({ ...t, id: uid() }));
  }
  return item;
}

/**
 * Populate `state.snippets` with seed data and return a Map of each seed's
 * `seedId` → the uid assigned to the instantiated snippet. Callers (notably
 * `seedChains`) use the map to resolve seed-time `seedId` refs to real uids.
 *
 * @returns {Map<string, string>}
 */
export function seedSnippets() {
  /** @type {Map<string, string>} */
  const seedIdToUid = new Map();
  state.snippets = SEED_SNIPPETS.map((seed) => {
    const item = instantiateSeedSnippet(seed);
    if (seed.seedId) seedIdToUid.set(seed.seedId, item.id);
    return item;
  });
  saveState();
  return seedIdToUid;
}

/**
 * Populate `state.chains` with seed data. Each seed step references a seed
 * snippet by `seedId`; we resolve it to the real uid assigned by
 * `seedSnippets`. A chain whose step can't be resolved is silently skipped —
 * it means the seed snippet it depended on was removed.
 *
 * @param {Map<string, string>} seedIdToUid
 */
export function seedChains(seedIdToUid) {
  /** @type {import('./types.js').Chain[]} */
  const out = [];
  for (const seed of SEED_CHAINS) {
    const chain = instantiateSeedChain(seed, (sid) => seedIdToUid.get(sid));
    if (chain) out.push(chain);
  }
  state.chains = out;
  saveState();
}

/**
 * Instantiate one seed chain into a runtime Chain, resolving each
 * step's `seedId` ref via `resolveSeedId`. Returns `null` if any step
 * can't be resolved — callers then skip the chain (same "quiet skip"
 * policy used at first-install seeding time).
 *
 * Factored out of `seedChains` so `restoreDefaultChains` can share it
 * without duplicating the tag / vars / tests / shortcut copying.
 *
 * @param {import('./seeds/chains.js').SeedChain} seed
 * @param {(seedId: string) => string | undefined} resolveSeedId
 * @returns {import('./types.js').Chain | null}
 */
function instantiateSeedChain(seed, resolveSeedId) {
  /** @type {import('./types.js').ChainStep[]} */
  const steps = [];
  for (const step of seed.steps) {
    if (step.seedId) {
      const resolved = resolveSeedId(step.seedId);
      if (!resolved) return null;
      /** @type {import('./types.js').ChainStep} */
      const s = { id: uid(), snippetId: resolved };
      if (step.name) s.name = step.name;
      if (step.params) s.params = step.params;
      steps.push(s);
    } else if (step.program) {
      /** @type {import('./types.js').ChainStep} */
      const s = { id: uid(), program: step.program };
      if (step.name) s.name = step.name;
      if (step.params) s.params = step.params;
      steps.push(s);
    } else {
      return null;
    }
  }
  /** @type {import('./types.js').Chain} */
  const chain = { id: uid(), name: seed.name, steps };
  if (seed.description) chain.description = seed.description;
  if (seed.tags && seed.tags.length) chain.tags = seed.tags;
  if (seed.vars && Object.keys(seed.vars).length) chain.vars = seed.vars;
  if (seed.favorite) chain.favorite = true;
  if (seed.shortcut) chain.shortcut = seed.shortcut;
  if (seed.shortcutInsert) chain.shortcutInsert = seed.shortcutInsert;
  // Tests ship without ids (see SeedChain typedef); mirror the snippet
  // pattern and assign fresh ids so the runner can key results off them.
  if (seed.tests && seed.tests.length) {
    chain.tests = seed.tests.map((t) => ({ ...t, id: uid() }));
  }
  return chain;
}

/**
 * Re-add any seed chains that aren't currently in `state.chains`
 * (matched by name). Mirrors `restoreDefaultSnippets`: user-edited
 * chains and user-authored chains with unrelated names are left
 * untouched; only missing defaults are appended.
 *
 * Each seed step references a snippet by `seedId`, which isn't stored
 * on instantiated snippets — we go `seedId` → seed snippet's name →
 * current `state.snippets` id. A chain whose snippet dependency has
 * been deleted or renamed by the user is silently skipped (the same
 * "quiet skip" policy as first-install seeding). Advise the user to
 * "Restore default snippets" first if they expect more chains.
 *
 * @returns {number} how many chains were added
 */
export function restoreDefaultChains() {
  /** @type {Map<string, string>} */
  const nameBySeedId = new Map();
  for (const s of SEED_SNIPPETS) {
    if (s.seedId) nameBySeedId.set(s.seedId, s.name);
  }
  /** @type {Map<string, string>} */
  const idByName = new Map(state.snippets.map((s) => [s.name, s.id]));
  const resolve = (seedId) => {
    const name = nameBySeedId.get(seedId);
    return name ? idByName.get(name) : undefined;
  };
  const existing = new Set(state.chains.map((c) => c.name));
  let added = 0;
  for (const seed of SEED_CHAINS) {
    if (existing.has(seed.name)) continue;
    const chain = instantiateSeedChain(seed, resolve);
    if (!chain) continue;
    state.chains.push(chain);
    added++;
  }
  if (added) saveState();
  return added;
}

/**
 * Compute the union of variable params declared by a chain's steps. Each
 * name appears once; the first occurrence wins (mirrors `pipelineParamList`).
 * Pure — no DOM, no state writes.
 * @param {{steps: any[]}} chain
 * @returns {Param[]}
 */
export function chainParamList(chain) {
  /** @type {Map<string, Param>} */
  const seen = new Map();
  for (const step of chain.steps || []) {
    if (step.disabled) continue;
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    const params = sn ? sn.params || [] : step.params || [];
    for (const p of params) if (!seen.has(p.name)) seen.set(p.name, p);
  }
  return [...seen.values()];
}

/**
 * Resolve a chain's effective variable values. Chain-level overrides
 * (`chain.vars`) win; otherwise, when `acceptDefaults` is true, a non-empty
 * step-level `default` is taken silently. Anything still unresolved goes
 * into `needsPrompting` for a single batched prompt at the call site.
 *
 * `initialPromptValues` is provided so the call site can prefill the prompt
 * inputs uniformly, regardless of whether the prompt covers only the
 * unresolved subset or every declared var (always-prompt mode).
 *
 * @param {any} chain
 * @param {boolean} acceptDefaults
 * @returns {{
 *   allParams: Param[],
 *   resolved: Record<string,string>,
 *   needsPrompting: Param[],
 *   initialPromptValues: Record<string,string>,
 * }}
 */
export function resolveChainVars(chain, acceptDefaults) {
  const allParams = chainParamList(chain);
  const chainVars = chain.vars || {};
  /** @type {Record<string,string>} */
  const resolved = {};
  /** @type {Param[]} */
  const needsPrompting = [];
  /** @type {Record<string,string>} */
  const initialPromptValues = {};

  for (const p of allParams) {
    const chainVal = chainVars[p.name];
    const stepDef = p.default;
    initialPromptValues[p.name] = chainVal !== undefined ? chainVal : (stepDef ?? '');
    if (chainVal !== undefined && chainVal !== '') {
      resolved[p.name] = chainVal;
    } else if (acceptDefaults && stepDef !== undefined && stepDef !== '') {
      resolved[p.name] = stepDef;
    } else {
      needsPrompting.push(p);
    }
  }
  return { allParams, resolved, needsPrompting, initialPromptValues };
}

// ---------- per-step chain vars (design v4) ----------

/**
 * Backfill a stable `id` on every step of `chain` that lacks one. Returns
 * true if any step was mutated — callers that also persist the chain
 * (save paths) can use that to decide whether to touch the state blob.
 *
 * Step ids are how `chain.stepVars` keys its per-step overrides; without
 * stable ids a reorder or a same-name duplicate would silently rebind
 * overrides to the wrong step.
 *
 * @param {{ steps?: any[] }} chain
 * @returns {boolean} whether any step was mutated
 */
export function ensureChainStepIds(chain) {
  let mutated = false;
  for (const step of chain.steps || []) {
    if (!step.id) {
      step.id = uid();
      mutated = true;
    }
  }
  return mutated;
}

/**
 * Who uses each declared param name? Returns a map from param name to
 * `{stepId, step, index, param}[]` for every (step, param) pair that
 * declares that name under the enabled steps of `chain`. `index` is
 * the step's 0-based position in `chain.steps` (including disabled
 * siblings) so UI labels like "1. Run Command …" stay stable when a
 * step is disabled / re-enabled. Disabled steps themselves are
 * skipped — they wouldn't run.
 *
 * Used by the chain dialog to decide which names need the "Different
 * per step?" expansion (names with 2+ entries), and by the run-vars
 * prompt to render per-step rows where appropriate.
 *
 * @param {{ steps?: any[] }} chain
 * @returns {Record<string, {stepId: string, step: any, index: number, param: Param}[]>}
 */
export function chainParamUsage(chain) {
  /** @type {Record<string, {stepId: string, step: any, index: number, param: Param}[]>} */
  const out = {};
  const steps = chain.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.disabled) continue;
    const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
    const params = sn ? sn.params || [] : step.params || [];
    for (const p of params) {
      if (!out[p.name]) out[p.name] = [];
      out[p.name].push({ stepId: step.id, step, index: i, param: p });
    }
  }
  return out;
}

/**
 * Resolve the effective vars for a single step of a chain. Precedence
 * depends on whether the user has engaged **per-step mode** for each
 * name (tracked in `chain.perStepNames`):
 *
 *   - Flat mode (default — `name` not in `perStepNames`):
 *       step default < chain.vars < stepVars < overlay
 *     A chain-level `chain.vars[name]` blankets every using step, which
 *     is the right behaviour when the user set a single flat input.
 *
 *   - Per-step mode (`name` listed in `perStepNames`):
 *       chain.vars < step default < stepVars < overlay
 *     Each step's own declared default wins over a chain-level value;
 *     `chain.vars[name]` is a fallback for steps with no default. This
 *     matches the "Different per step?" UI — once engaged, each step's
 *     authored default IS the intent for that step, and chain.vars
 *     only fills the gaps.
 *
 * Empty strings at the chain / step-override / overlay layers are
 * treated as "unset" so a blank entry doesn't blank out a useful
 * underlying value.
 *
 * @param {any} chain
 * @param {any} step
 * @param {Record<string, string>} [overlay]  run-time overrides
 * @returns {Record<string, string>}
 */
export function resolveStepVars(chain, step, overlay = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
  const params = sn ? sn.params || [] : step.params || [];
  const perStepNames = new Set(chain.perStepNames || []);
  const chainVars = chain.vars || {};
  for (const p of params) {
    const chainVal = chainVars[p.name];
    const hasChainVal = chainVal !== undefined && chainVal !== '';
    const hasStepDef = p.default !== undefined && p.default !== '';
    if (perStepNames.has(p.name)) {
      // Per-step mode: step default > chain.vars.
      if (hasStepDef) out[p.name] = p.default;
      else if (hasChainVal) out[p.name] = chainVal;
      else out[p.name] = '';
    } else {
      // Flat mode: chain.vars > step default.
      if (hasChainVal) out[p.name] = chainVal;
      else out[p.name] = p.default ?? '';
    }
  }
  // Stored per-step overrides always win (explicit user value for the step).
  const sv = chain.stepVars && chain.stepVars[step.id];
  if (sv) {
    for (const [k, v] of Object.entries(sv)) {
      if (v !== undefined && v !== '') out[k] = v;
    }
  }
  // Runtime overlay (prompt answers / test.vars) wins over everything.
  for (const [k, v] of Object.entries(overlay)) {
    if (v !== undefined) out[k] = v == null ? '' : String(v);
  }
  return out;
}

/**
 * Plan the run-time vars prompt for a chain. For each declared param
 * name, decides whether the prompt should show a single chain-level row
 * (when no step has an override stored) or one row per using step
 * (when any step has an override in `chain.stepVars`). Rows whose
 * resolution is already settled by chain-global / per-step / step-
 * default (under `acceptDefaults`) are marked "skip"; every other row
 * goes into `rows`.
 *
 * The caller (snippet / chain dialog prompt, runner) walks `rows` to
 * render inputs; on submit it turns the flat `answers` back into a
 * `chainOverlay: Record<name,string>` + `stepOverlay: Record<sid,
 * Record<name,string>>` pair via `applyChainPromptAnswers`.
 *
 * @param {any} chain
 * @param {boolean} acceptDefaults
 * @returns {{
 *   rows: Array<{
 *     key: string,          // unique row key; flat for chain rows, `${sid}:${name}` for step rows
 *     name: string,         // the param name
 *     label: string,        // display label for the row (`name` or `name · stepLabel`)
 *     stepId: string | null,// null for chain-global rows
 *     param: Param,         // the declared param (for default / description)
 *     initial: string,      // prefill value
 *   }>,
 *   needsPrompting: boolean,
 * }}
 */
export function planChainVarsPrompt(chain, acceptDefaults) {
  const usage = chainParamUsage(chain);
  const perStepNames = new Set(chain.perStepNames || []);
  /** @type {{ key: string, name: string, label: string, stepId: string | null, param: Param, initial: string }[]} */
  const rows = [];
  for (const [name, uses] of Object.entries(usage)) {
    const chainVal = chain.vars && chain.vars[name];
    const chainSettled = chainVal !== undefined && chainVal !== '';

    // Per-step mode engaged if the user explicitly listed it OR any
    // step has a stored override (legacy chains pre-`perStepNames`) OR
    // the declared step defaults themselves diverge (authored intent).
    const anyStoredOverride = uses.some(
      (u) =>
        chain.stepVars &&
        chain.stepVars[u.stepId] &&
        chain.stepVars[u.stepId][name] !== undefined &&
        chain.stepVars[u.stepId][name] !== '',
    );
    const defaultSet = new Set(uses.map((u) => u.param.default ?? ''));
    const perStep =
      perStepNames.has(name) || anyStoredOverride || defaultSet.size > 1;

    // Would `resolveStepVars` return a concrete value for this step
    // without prompting? The settlement rule tracks resolver precedence:
    // in per-step mode the step's own default settles it; in flat mode
    // chain.vars settles it; either way a stored per-step override or
    // a chain-global value will do.
    const isSettled = (u) => {
      if (chain.stepVars && chain.stepVars[u.stepId]) {
        const sv = chain.stepVars[u.stepId][name];
        if (sv !== undefined && sv !== '') return true;
      }
      const hasStepDef = u.param.default !== undefined && u.param.default !== '';
      if (perStep) {
        // Per-step: step default wins. Chain.vars is only the fallback
        // for steps with no default of their own.
        if (acceptDefaults && hasStepDef) return true;
        if (chainSettled) return true;
        return false;
      }
      // Flat mode: chain.vars blankets all steps. Step default only
      // settles a step when chain.vars is absent.
      if (chainSettled) return true;
      if (acceptDefaults && hasStepDef) return true;
      return false;
    };

    const unsettled = uses.filter((u) => !isSettled(u));
    if (unsettled.length === 0) continue;

    if (!perStep) {
      // One flat row; initial is the (shared) step default.
      rows.push({
        key: name,
        name,
        label: name,
        stepId: null,
        param: unsettled[0].param,
        initial: unsettled[0].param.default ?? '',
      });
    } else {
      // One row per unsettled step. Settled steps keep using their
      // already-resolved source (stepVars / step default / chain.vars).
      for (const u of unsettled) {
        const sv = chain.stepVars && chain.stepVars[u.stepId] && chain.stepVars[u.stepId][name];
        const initial =
          sv !== undefined ? sv : (u.param.default ?? '') || chainVal || '';
        rows.push({
          key: `${u.stepId}:${name}`,
          name,
          // Prefix with the step's visible position ("3. …") so the
          // user can match the row to the Steps list even when
          // multiple steps share a snippet-derived label.
          label: `${name} · ${u.index + 1}. ${stepLabel(u.step)}`,
          stepId: u.stepId,
          param: u.param,
          initial,
        });
      }
    }
  }
  return { rows, needsPrompting: rows.length > 0 };
}

/**
 * Turn a flat map of prompt answers (keyed by row.key) back into the
 * structured chain + step overlays that `resolveStepVars` consumes.
 *
 * @param {ReturnType<typeof planChainVarsPrompt>['rows']} rows
 * @param {Record<string, string>} answers  keyed by row.key
 * @returns {{
 *   chainOverlay: Record<string, string>,
 *   stepOverlay: Record<string, Record<string, string>>,
 * }}
 */
export function applyChainPromptAnswers(rows, answers) {
  /** @type {Record<string, string>} */
  const chainOverlay = {};
  /** @type {Record<string, Record<string, string>>} */
  const stepOverlay = {};
  for (const row of rows) {
    const v = answers[row.key];
    if (v === undefined) continue;
    if (row.stepId === null) {
      chainOverlay[row.name] = v;
    } else {
      if (!stepOverlay[row.stepId]) stepOverlay[row.stepId] = {};
      stepOverlay[row.stepId][row.name] = v;
    }
  }
  return { chainOverlay, stepOverlay };
}

/**
 * Drop `chain.stepVars` entries whose step id is no longer present in
 * `chain.steps`, entries whose name is no longer declared by that
 * step, and `chain.perStepNames` entries for names no longer declared
 * by any step. Called on chain save so edits don't leave dangling
 * overrides that would silently re-bind if a same-id step ever
 * reappeared.
 *
 * @param {any} chain
 */
export function pruneOrphanStepVars(chain) {
  const validIds = new Set((chain.steps || []).map((s) => s.id));
  const stepById = new Map((chain.steps || []).map((s) => [s.id, s]));
  if (chain.stepVars) {
    for (const sid of Object.keys(chain.stepVars)) {
      if (!validIds.has(sid)) {
        delete chain.stepVars[sid];
        continue;
      }
      const step = stepById.get(sid);
      const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
      const declaredNames = new Set(
        (sn ? sn.params || [] : step.params || []).map((p) => p.name),
      );
      const overrides = chain.stepVars[sid];
      for (const name of Object.keys(overrides)) {
        if (!declaredNames.has(name)) delete overrides[name];
      }
      if (Object.keys(overrides).length === 0) delete chain.stepVars[sid];
    }
    if (Object.keys(chain.stepVars).length === 0) delete chain.stepVars;
  }
  if (chain.perStepNames) {
    const allDeclared = new Set();
    for (const step of chain.steps || []) {
      const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
      for (const p of sn ? sn.params || [] : step.params || []) allDeclared.add(p.name);
    }
    chain.perStepNames = chain.perStepNames.filter((n) => allDeclared.has(n));
    if (!chain.perStepNames.length) delete chain.perStepNames;
  }
}

/**
 * Non-destructively add any default snippets the user is missing, matched
 * by exact name. Existing snippets (including modified ones with the same
 * name as a default) are left untouched so user edits are never overwritten.
 * @returns {number} how many defaults were added
 */
export function restoreDefaultSnippets() {
  const existing = new Set(state.snippets.map((s) => s.name));
  let added = 0;
  for (const s of SEED_SNIPPETS) {
    if (existing.has(s.name)) continue;
    state.snippets.push(instantiateSeedSnippet(s));
    added++;
  }
  if (added) saveState();
  return added;
}

/**
 * Normalize a tag list. Accepts either a comma-separated string or an array
 * of strings; trims, lowercases, dedupes, drops empties, sorts. Used both at
 * snippet save time (string from the dialog input) and as a defensive pass
 * on imported library data (array of unknown shape).
 *
 * @param {string|string[]|undefined|null} input
 * @returns {string[]}
 */
export function normalizeTags(input) {
  if (input == null) return [];
  const list = Array.isArray(input) ? input : String(input).split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  out.sort();
  return out;
}

/**
 * Sorted union of every tag currently in use across `state.snippets`.
 * Powers the sidebar grouping, the snippet-dialog autocomplete datalist,
 * and the palette tag chip filter row.
 *
 * @returns {string[]}
 */
export function allSnippetTags() {
  const seen = new Set();
  for (const sn of state.snippets) {
    for (const t of sn.tags || []) seen.add(t);
  }
  return [...seen].sort();
}

/**
 * Sorted union of every tag currently in use across `state.chains`.
 * Powers the sidebar chain grouping and the chain-dialog autocomplete.
 * @returns {string[]}
 */
export function allChainTags() {
  const seen = new Set();
  for (const c of state.chains) {
    for (const t of c.tags || []) seen.add(t);
  }
  return [...seen].sort();
}

/**
 * Sorted union of every tag currently in use across `state.templates`.
 * @returns {string[]}
 */
export function allTemplateTags() {
  const seen = new Set();
  for (const t of state.templates) {
    for (const tag of t.tags || []) seen.add(tag);
  }
  return [...seen].sort();
}

export function seedTemplates() {
  state.templates = AWK_TEMPLATES_SEED.map((t) => {
    const tpl = { id: uid(), name: t.name, body: t.body };
    if (t.description) tpl.description = t.description;
    if (t.tags && t.tags.length) tpl.tags = [...t.tags];
    return tpl;
  });
  saveState();
}

export function seedTextSnippets() {
  state.textSnippets = TEXT_SNIPPETS_SEED.map((t) => ({
    id: uid(),
    name: t.name,
    content: t.content,
  }));
  saveState();
}

/**
 * Non-destructively add any default templates the user is missing, matched
 * by exact name. Existing templates (including modified ones with the same
 * name as a default) are left untouched so user edits are never overwritten.
 * @returns {number} how many defaults were added
 */
export function restoreDefaultTemplates() {
  const existing = new Set(state.templates.map((t) => t.name));
  let added = 0;
  for (const t of AWK_TEMPLATES_SEED) {
    if (existing.has(t.name)) continue;
    const tpl = { id: uid(), name: t.name, body: t.body };
    if (t.description) tpl.description = t.description;
    if (t.tags && t.tags.length) tpl.tags = [...t.tags];
    state.templates.push(tpl);
    added++;
  }
  if (added) saveState();
  return added;
}

/**
 * Non-destructively add any default text snippets the user is missing,
 * matched by exact name. Existing entries (including modified ones with
 * the same name as a default) are left untouched so user edits are
 * never overwritten. Mirrors `restoreDefaultSnippets` /
 * `restoreDefaultTemplates`.
 * @returns {number} how many defaults were added
 */
export function restoreDefaultTextSnippets() {
  const existing = new Set(state.textSnippets.map((t) => t.name));
  let added = 0;
  for (const t of TEXT_SNIPPETS_SEED) {
    if (existing.has(t.name)) continue;
    state.textSnippets.push({ id: uid(), name: t.name, content: t.content });
    added++;
  }
  if (added) saveState();
  return added;
}
