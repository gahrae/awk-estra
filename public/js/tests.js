// @ts-check
// Snippet test fixtures: a snippet may carry an array of `{input, expected}`
// pairs (see types.js Test). This module owns
//   - running tests against the awk runner (one snippet at a time, or all),
//   - in-memory result cache so sidebar status dots survive re-renders, and
//   - a tiny line-level unified diff renderer for the dialog UI.

import { runAwk } from './awk.js';
import { state, stepLabel, resolveStepVars } from './state.js';
import { dispatch } from './events.js';

/**
 * @typedef {import('./types.js').Snippet} Snippet
 * @typedef {import('./types.js').Chain} Chain
 * @typedef {import('./types.js').Test} Test
 */

/**
 * @typedef {Object} TestRunResult
 * @property {string} testId
 * @property {boolean} pass
 * @property {string} actual the comparison-ready stdout (post-trim if
 *   `trimTrailingNewline` was set on the test). Always comparable with
 *   `expected` below — the diff renders these directly.
 * @property {string} stderr non-empty stderr forces a failure even if the
 *   stdout happens to match `expected`
 * @property {string} expected what we compared against (post-trim if
 *   `trimTrailingNewline` was set on the test)
 */

/**
 * @typedef {Object} SnippetTestSummary
 * @property {string} snippetId
 * @property {number} pass
 * @property {number} fail
 * @property {number} total
 * @property {TestRunResult[]} results
 */

/**
 * In-memory cache keyed by snippet id. Sidebar dots and the snippet-edit
 * dialog read from here so re-renders don't have to re-execute every test.
 * `null` means "tests exist but haven't been run this session"; absence of a
 * key means the same. Cleared whenever a snippet's tests are modified.
 *
 * @type {Map<string, SnippetTestSummary>}
 */
const resultsCache = new Map();

/** @param {string} id */
export function getCachedSummary(id) {
  return resultsCache.get(id) || null;
}

/** @param {string} id */
export function clearCachedSummary(id) {
  resultsCache.delete(id);
}

export function clearAllCachedSummaries() {
  resultsCache.clear();
}

/** Trim exactly one trailing "\n" if present. Used for the per-test toggle. */
function maybeTrim(s, on) {
  if (!on) return s;
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/**
 * Resolve vars for a single test: per-test overrides win over snippet
 * param defaults; missing names fall back to empty string.
 *
 * Exported for unit tests. Treat as module-internal in production
 * callers — the public runner paths resolve vars internally.
 */
export function resolveTestVars(snippet, test) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const p of snippet.params || []) {
    if (p && p.name) out[p.name] = p.default ?? '';
  }
  if (test.vars) {
    for (const [k, v] of Object.entries(test.vars)) out[k] = v == null ? '' : String(v);
  }
  return out;
}

/**
 * Run every test in `snippet.tests` and return a summary. Caches the
 * result and broadcasts a `tests:run` event so the sidebar can refresh
 * its status dots without each caller having to re-render explicitly.
 *
 * `runner` is injectable so unit tests can supply a stub that returns
 * canned `{stdout, stderr}` without spawning awk. Production callers
 * pass no second argument and get the real `runAwk`.
 *
 * @param {Snippet} snippet
 * @param {(program: string, input: string, vars: Record<string,string>) => Promise<{stdout: string, stderr: string}>} [runner]
 * @returns {Promise<SnippetTestSummary>}
 */
export async function runSnippetTests(snippet, runner = runAwk) {
  /** @type {TestRunResult[]} */
  const results = [];
  let pass = 0;
  let fail = 0;
  for (const t of snippet.tests || []) {
    const vars = resolveTestVars(snippet, t);
    const r = await runner(snippet.program, t.input, vars);
    const trim = !!t.trimTrailingNewline;
    const expected = maybeTrim(t.expected || '', trim);
    const actual = maybeTrim(r.stdout || '', trim);
    const ok = !r.stderr && actual === expected;
    if (ok) pass++;
    else fail++;
    results.push({
      testId: t.id,
      pass: ok,
      // Store the trimmed strings so the diff stays apples-to-apples and
      // `actual` is safe to write straight back to a fixture via
      // "Use actual as expected".
      actual,
      stderr: r.stderr || '',
      expected,
    });
  }
  /** @type {SnippetTestSummary} */
  const summary = {
    snippetId: snippet.id,
    pass,
    fail,
    total: results.length,
    results,
  };
  resultsCache.set(snippet.id, summary);
  dispatch('tests:run', { snippetId: snippet.id });
  return summary;
}

/**
 * Run tests for every snippet in the library that has any. Returns one
 * summary per snippet and emits a final `tests:run-all` event.
 *
 * @returns {Promise<SnippetTestSummary[]>}
 */
export async function runAllSnippetTests() {
  /** @type {SnippetTestSummary[]} */
  const all = [];
  for (const sn of state.snippets) {
    if (!sn.tests || !sn.tests.length) continue;
    all.push(await runSnippetTests(sn));
  }
  dispatch('tests:run-all', { summaries: all });
  return all;
}

/**
 * Resolve vars for a chain test STEP: step defaults → chain.vars →
 * chain.stepVars[sid] → per-test `test.vars`. `test.vars` is flat
 * (applies to every step that uses the name) to keep the test-case
 * editing UI simple; chains that need per-step precision at test time
 * should bake the override into `chain.stepVars`.
 *
 * Exported for unit tests. Treat as module-internal in production
 * callers — the public runner paths resolve vars internally.
 *
 * @param {any} chain
 * @param {any} step
 * @param {{ vars?: Record<string, string> }} test
 */
export function resolveChainTestVars(chain, step, test) {
  return resolveStepVars(chain, step, test.vars || {});
}

/**
 * Run every test in `chain.tests`. Each test feeds `input` through the
 * entire step pipeline; the final stdout is compared to `expected`.
 *
 * `runner` is injectable so unit tests can stub the awk call — see the
 * equivalent note on `runSnippetTests`.
 *
 * @param {Chain} chain
 * @param {(program: string, input: string, vars: Record<string,string>) => Promise<{stdout: string, stderr: string}>} [runner]
 * @returns {Promise<SnippetTestSummary>}
 */
export async function runChainTests(chain, runner = runAwk) {
  /** @type {TestRunResult[]} */
  const results = [];
  let pass = 0;
  let fail = 0;
  for (const t of chain.tests || []) {
    let cur = t.input || '';
    let errMsg = '';
    for (const step of chain.steps || []) {
      if (step.disabled) continue;
      const sn = step.snippetId ? state.snippets.find((s) => s.id === step.snippetId) : null;
      if (step.snippetId && !sn) {
        errMsg = `Missing snippet for step "${stepLabel(step)}"`;
        break;
      }
      const prog = sn ? sn.program : step.program || '';
      if (!prog) continue;
      // Resolve vars *per step* so chain.stepVars overrides land on the
      // correct awk invocation. The test's flat `test.vars` applies
      // uniformly to every using step — per-step test overrides are
      // out of scope for the test-case editor.
      const vars = resolveChainTestVars(chain, step, t);
      const r = await runner(prog, cur, vars);
      if (r.stderr) {
        errMsg = `[step "${stepLabel(step)}"]\n${r.stderr}`;
        break;
      }
      cur = r.stdout;
    }
    const trim = !!t.trimTrailingNewline;
    const expected = maybeTrim(t.expected || '', trim);
    const actual = maybeTrim(cur, trim);
    const ok = !errMsg && actual === expected;
    if (ok) pass++;
    else fail++;
    results.push({
      testId: t.id,
      pass: ok,
      actual,
      stderr: errMsg,
      expected,
    });
  }
  /** @type {SnippetTestSummary} */
  const summary = {
    snippetId: chain.id,
    pass,
    fail,
    total: results.length,
    results,
  };
  resultsCache.set(chain.id, summary);
  dispatch('tests:run', { chainId: chain.id });
  return summary;
}

/**
 * Run tests for every chain that has any.
 * @returns {Promise<SnippetTestSummary[]>}
 */
export async function runAllChainTests() {
  /** @type {SnippetTestSummary[]} */
  const all = [];
  for (const c of state.chains) {
    if (!c.tests || !c.tests.length) continue;
    all.push(await runChainTests(c));
  }
  dispatch('tests:run-all', { summaries: all });
  return all;
}

/**
 * Line-level unified diff. Cheap implementation: split both sides into
 * lines, longest-common-subsequence by table, emit `-`/`+`/` ` lines.
 * Good enough for snippet test output (typically 1–50 lines); for large
 * outputs the table is O(N*M) and could be replaced by a real diff lib.
 *
 * Returned objects describe one line each:
 *   { sign: ' ' | '-' | '+', text: string }
 *
 * @param {string} a expected
 * @param {string} b actual
 * @returns {{sign: ' ' | '-' | '+', text: string}[]}
 */
export function unifiedDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  // LCS length table.
  /** @type {number[][]} */
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  /** @type {{sign: ' ' | '-' | '+', text: string}[]} */
  const out = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ sign: ' ', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: '-', text: A[i] });
      i++;
    } else {
      out.push({ sign: '+', text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ sign: '-', text: A[i++] });
  while (j < m) out.push({ sign: '+', text: B[j++] });
  return out;
}
