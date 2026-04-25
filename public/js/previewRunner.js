// @ts-check
// Shared scaffolding for the snippet / chain / inline-step preview
// panels. Each dialog's preview wraps a <details> with a meta label +
// output <pre>; the wiring around it (persist the toggle, debounce
// reruns, drop stale results, re-run on input-mode flips, clean up on
// close) is identical. The per-surface differences — which awk
// programs to run, how vars are composed, what the empty / no-output
// message looks like — stay with each caller as a small `run` callback.
//
// Three small helpers come with the scaffold so the callers stay short:
//   - `resolvePreviewInput`  — resolveInput + truncation
//   - `gatePreviewOrNull`    — safety-filter check against settings
//   - `writePreviewStderr`   — stderr + .error class + "Change setting"
//   - `writePreviewStdout`   — success path
//   - `formatPreviewInputLabel` — the "<source> as input[cap]" suffix

import { safeSetItem, createStalenessGuard, truncateLines } from './core.js';
import { on } from './events.js';
import { settings, openSettingsDialog } from './settings.js';
import { resolveInput, getEffectiveInputMode } from './inputMode.js';
import { state } from './state.js';
import {
  shouldGatePreview,
  renderManualPreviewPrompt,
  appendSafetyChangeSettingIfBlocked,
} from './safety.js';

/**
 * Resolve input for a preview and apply the Settings → Max-input-lines
 * cap. Truncation only kicks in on the single-tab, non-selection path:
 *   - selection  → no truncation (user explicitly narrowed)
 *   - allTabs    → no truncation (per-file cap would be misleading)
 *   - currentTab → truncation applies if maxLines > 0
 *
 * Returns both the resolved source (so callers know whether it's multi)
 * and the truncated single-string + truncation note for the single-
 * input path. When truncation didn't apply, `note` is empty.
 *
 * @returns {{
 *   src: ReturnType<typeof resolveInput>,
 *   singleInput: string,
 *   note: string,
 *   truncated: boolean,
 *   originalLines: number,
 * }}
 */
export function resolvePreviewInput() {
  const src = resolveInput();
  const lim = settings.preview.maxLines;
  const doTruncate =
    src.kind === 'single' && src.source.kind !== 'selection' && lim > 0;
  let singleInput = src.kind === 'single' ? src.input : '';
  let truncated = false;
  let originalLines = 0;
  if (doTruncate) {
    const t = truncateLines(singleInput, lim);
    singleInput = t.text;
    truncated = t.truncated;
    originalLines = t.original;
  }
  const note = truncated
    ? `\n[preview limited to first ${lim} of ${originalLines} input lines]`
    : '';
  return { src, singleInput, note, truncated, originalLines };
}

/**
 * Check the safety gate against the full Settings → Safety defaults.
 * Returns `null` when the preview is cleared to run; returns the gate
 * object (suitable for `renderManualPreviewPrompt`) otherwise.
 *
 * @param {string[]} programs
 * @returns {ReturnType<typeof shouldGatePreview> | null}
 */
export function gatePreviewOrNull(programs) {
  const gate = shouldGatePreview(programs, {
    requireManualPreview: !!settings.safety?.requireManualPreview,
    autoPreviewSideEffects: !!settings.safety?.autoPreviewSideEffects,
  });
  return gate.gated ? gate : null;
}

/**
 * Render the manual-preview gate's "Run preview" prompt. Thin wrapper
 * that pre-fills the `onChangeSetting` callback with the Settings
 * dialog navigation the three call sites all use.
 *
 * @param {HTMLElement} out
 * @param {ReturnType<typeof shouldGatePreview>} gate
 * @param {() => void} onRun
 */
export function renderPreviewGate(out, gate, onRun) {
  renderManualPreviewPrompt(out, gate, onRun, (scrollTo) =>
    openSettingsDialog({ scrollTo }),
  );
}

/**
 * Render a stderr result into the preview output element, including the
 * "Change setting" affordance when the stderr is a safety-filter block.
 * Adds the `.error` CSS class so themes can tint accordingly.
 *
 * @param {HTMLElement} out
 * @param {string} text
 */
export function writePreviewStderr(out, text) {
  out.classList.add('error');
  out.textContent = text;
  appendSafetyChangeSettingIfBlocked(out, text, () =>
    openSettingsDialog({ scrollTo: 'set-safety-forbidden-row' }),
  );
}

/**
 * Render a successful stdout result. Clears any prior error state.
 *
 * @param {HTMLElement} out
 * @param {string} text
 */
export function writePreviewStdout(out, text) {
  out.classList.remove('error');
  out.textContent = text;
}

/**
 * The trailing "<source> as input[cap]" fragment shared by all preview
 * meta labels. Callers prepend their own prefix ("N steps · ", etc.)
 * and render the full string into their meta element.
 *
 * @returns {string}
 */
export function formatPreviewInputLabel() {
  const eff = getEffectiveInputMode();
  const lim = settings.preview.maxLines;
  let source;
  if (eff === 'selection') source = 'selection';
  else if (eff === 'allTabs') {
    const count = state.tabs.filter((t) => !t.excluded).length;
    source = `all tabs (${count})`;
  } else source = 'active tab';
  const canCap = eff === 'currentTab' && lim > 0;
  const cap = canCap ? ` · capped at first ${lim} input line${lim === 1 ? '' : 's'}` : '';
  return `${source} as input${cap}`;
}

/**
 * Wire the shared preview scaffold around a `<details>` panel. `run` is
 * the caller's implementation — it gets called on toggle-open, on every
 * scheduled rerun, and after every input-mode flip. The caller is
 * responsible for running awk and writing to its own output element
 * (use `writePreviewStderr` / `writePreviewStdout` for consistency).
 *
 * The scaffold handles every cross-surface concern:
 *   - Restore the `open` state from localStorage.
 *   - Debounce `schedulePreview()` calls to one run after `debounceMs`.
 *   - Provide a staleness guard the caller claims at the top of `run`
 *     and checks after each awaited awk call.
 *   - Persist the toggle and re-run on open via `toggle` listener.
 *   - Re-run + re-label on `input-mode:changed`.
 *   - Tear everything down in `cleanup()`.
 *
 * @param {{
 *   details: HTMLDetailsElement,
 *   lsKey: string,
 *   run: (manual?: boolean) => Promise<void> | void,
 *   refreshMeta: () => void,
 *   debounceMs?: number,
 * }} opts
 * @returns {{
 *   schedulePreview: () => void,
 *   refreshMetaAndMaybeRun: () => void,
 *   guard: ReturnType<typeof createStalenessGuard>,
 *   cleanup: () => void,
 * }}
 */
export function createPreviewRunner(opts) {
  const { details, lsKey, run, refreshMeta } = opts;
  const debounceMs = opts.debounceMs ?? 200;
  const guard = createStalenessGuard();
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let debounce = 0;

  details.open = localStorage.getItem(lsKey) === '1';
  refreshMeta();

  const schedulePreview = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => run(), debounceMs);
  };
  const onToggle = () => {
    safeSetItem(lsKey, details.open ? '1' : '0');
    if (details.open) run();
  };
  details.addEventListener('toggle', onToggle);

  const refreshMetaAndMaybeRun = () => {
    refreshMeta();
    if (details.open) schedulePreview();
  };
  const offInputMode = on('input-mode:changed', refreshMetaAndMaybeRun);
  // Deferred a microtask so callers can finish their `const runner =
  // createPreviewRunner(...)` assignment before `run` fires — many
  // `run` callbacks reference the runner via closure (e.g. for the
  // staleness guard), which is in the TDZ until the assignment lands.
  if (details.open) queueMicrotask(run);

  return {
    schedulePreview,
    refreshMetaAndMaybeRun,
    guard,
    cleanup: () => {
      clearTimeout(debounce);
      guard.claim();
      details.removeEventListener('toggle', onToggle);
      offInputMode();
    },
  };
}
