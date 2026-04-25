// @ts-check
// Unit tests for public/js/tests.js — the snippet/chain test runner,
// its var-resolution helpers, and the unified-diff formatter.
//
// NO AWK EXECUTION: `runSnippetTests` and `runChainTests` both accept an
// injected `runner` parameter. Every test here supplies a FAKE runner
// that returns canned `{stdout, stderr}` objects synchronously. No
// shell, no `child_process`, no network — purely in-memory JS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSnippetTests,
  runChainTests,
  resolveTestVars,
  resolveChainTestVars,
  unifiedDiff,
  clearAllCachedSummaries,
  getCachedSummary,
} from '../../public/js/tests.js';
import { state } from '../../public/js/state.js';

/**
 * Build a fake runner for runSnippetTests / runChainTests. `respond`
 * can be a plain object (same reply for every call) or a function that
 * receives `(program, input, vars)` and returns the reply. The runner
 * records every invocation into `calls` so tests can assert on the
 * sequence.
 * @param {object | ((p: string, i: string, v: Record<string,string>) => {stdout: string, stderr: string})} respond
 */
function fakeRunner(respond) {
  /** @type {{program: string, input: string, vars: Record<string,string>}[]} */
  const calls = [];
  const fn = async (program, input, vars) => {
    calls.push({ program, input, vars });
    return typeof respond === 'function' ? respond(program, input, vars) : respond;
  };
  return { fn, calls };
}

function resetState() {
  state.snippets = [];
  state.chains = [];
  state.tabs = [];
  state.activeTabId = null;
  state.pipeline = [];
  state.pipelineVars = {};
  state.activeStep = null;
  clearAllCachedSummaries();
}

// ---------------------------------------------------------------- //
// resolveTestVars — snippet var precedence
// ---------------------------------------------------------------- //

test('resolveTestVars: empty snippet + empty test → {}', () => {
  const r = resolveTestVars({ params: [] }, {});
  assert.deepEqual(r, {});
});

test('resolveTestVars: snippet param defaults propagate through', () => {
  const snippet = {
    params: [
      { name: 'sep', default: ',' },
      { name: 'col', default: '1' },
    ],
  };
  const r = resolveTestVars(snippet, {});
  assert.deepEqual(r, { sep: ',', col: '1' });
});

test('resolveTestVars: params with no default fall back to empty string', () => {
  const r = resolveTestVars({ params: [{ name: 'pattern' }] }, {});
  assert.deepEqual(r, { pattern: '' });
});

test('resolveTestVars: per-test vars override snippet defaults', () => {
  const snippet = { params: [{ name: 'sep', default: ',' }] };
  const test = { vars: { sep: '\t' } };
  const r = resolveTestVars(snippet, test);
  assert.deepEqual(r, { sep: '\t' });
});

test('resolveTestVars: per-test vars add names not declared by the snippet', () => {
  // Harmless — extra -v flags just set extra awk vars. We do pass them
  // through so the test is self-describing.
  const snippet = { params: [{ name: 'sep', default: ',' }] };
  const test = { vars: { newVar: 'x' } };
  const r = resolveTestVars(snippet, test);
  assert.deepEqual(r, { sep: ',', newVar: 'x' });
});

test('resolveTestVars: null / undefined var values stringify to empty string', () => {
  const snippet = { params: [{ name: 'a', default: 'default-a' }] };
  const test = { vars: { a: null, b: undefined } };
  const r = resolveTestVars(snippet, test);
  assert.equal(r.a, '');
  assert.equal(r.b, '');
});

// ---------------------------------------------------------------- //
// resolveChainTestVars — chain var precedence
// ---------------------------------------------------------------- //

// `resolveChainTestVars` now takes `(chain, step, test)` so per-step
// overrides can land on the right step. Every test builds the step
// inline and feeds it explicitly.

test('resolveChainTestVars: step-declared param defaults propagate', () => {
  resetState();
  const step = {
    id: 's1',
    program: '{ print }',
    params: [{ name: 'col', default: '2' }],
  };
  const chain = { steps: [step] };
  const r = resolveChainTestVars(chain, step, {});
  assert.deepEqual(r, { col: '2' });
});

test('resolveChainTestVars: chain-level vars override step defaults', () => {
  resetState();
  const step = {
    id: 's1',
    program: '{ print }',
    params: [{ name: 'col', default: '2' }],
  };
  const chain = { steps: [step], vars: { col: '5' } };
  const r = resolveChainTestVars(chain, step, {});
  assert.deepEqual(r, { col: '5' });
});

test('resolveChainTestVars: empty-string chain vars do not override step defaults', () => {
  // The chain-vars dialog stores '' as "prompt at run time / use
  // default" — it must NOT override a declared non-empty default.
  resetState();
  const step = {
    id: 's1',
    program: '{ print }',
    params: [{ name: 'col', default: '2' }],
  };
  const chain = { steps: [step], vars: { col: '' } };
  const r = resolveChainTestVars(chain, step, {});
  assert.deepEqual(r, { col: '2' });
});

test('resolveChainTestVars: per-test vars override chain vars and step defaults', () => {
  resetState();
  const step = {
    id: 's1',
    program: '{ print }',
    params: [{ name: 'col', default: '2' }],
  };
  const chain = { steps: [step], vars: { col: '5' } };
  const test = { vars: { col: '9' } };
  const r = resolveChainTestVars(chain, step, test);
  assert.deepEqual(r, { col: '9' });
});

test('resolveChainTestVars: per-step override wins over chain.vars and step default', () => {
  resetState();
  const step = {
    id: 's1',
    program: '{ print }',
    params: [{ name: 'cmd', default: 'base64' }],
  };
  const chain = {
    steps: [step],
    vars: { cmd: 'chain-level' },
    stepVars: { s1: { cmd: 'base64 -d' } },
  };
  const r = resolveChainTestVars(chain, step, {});
  assert.equal(r.cmd, 'base64 -d');
});

test('resolveChainTestVars: sibling step is unaffected by another step\'s override', () => {
  // The user's encode-then-decode case: two steps both declare `cmd`,
  // each with its own per-step override. The resolver must return the
  // correct value for each step, not leak across.
  resetState();
  const stepA = { id: 'a', program: '{}', params: [{ name: 'cmd', default: '' }] };
  const stepB = { id: 'b', program: '{}', params: [{ name: 'cmd', default: '' }] };
  const chain = {
    steps: [stepA, stepB],
    stepVars: {
      a: { cmd: 'base64' },
      b: { cmd: 'base64 -d' },
    },
  };
  assert.equal(resolveChainTestVars(chain, stepA, {}).cmd, 'base64');
  assert.equal(resolveChainTestVars(chain, stepB, {}).cmd, 'base64 -d');
});

// ---------------------------------------------------------------- //
// runSnippetTests — with injected fake runner (no awk spawned)
// ---------------------------------------------------------------- //

test('runSnippetTests: all passing → pass count matches total', async () => {
  const runner = fakeRunner({ stdout: 'HELLO', stderr: '' });
  const snippet = {
    id: 's1',
    program: '{ print toupper($0) }',
    tests: [
      { id: 't1', input: 'hello', expected: 'HELLO', trimTrailingNewline: false },
      { id: 't2', input: 'hello', expected: 'HELLO', trimTrailingNewline: false },
    ],
  };
  const summary = await runSnippetTests(snippet, runner.fn);
  assert.equal(summary.pass, 2);
  assert.equal(summary.fail, 0);
  assert.equal(summary.total, 2);
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0].program, '{ print toupper($0) }');
  assert.equal(runner.calls[0].input, 'hello');
});

test('runSnippetTests: expected mismatch → single fail', async () => {
  const runner = fakeRunner({ stdout: 'WORLD', stderr: '' });
  const snippet = {
    id: 's1',
    program: '{ print toupper($0) }',
    tests: [{ id: 't1', input: 'hello', expected: 'HELLO', trimTrailingNewline: false }],
  };
  const summary = await runSnippetTests(snippet, runner.fn);
  assert.equal(summary.pass, 0);
  assert.equal(summary.fail, 1);
  assert.equal(summary.results[0].pass, false);
  assert.equal(summary.results[0].actual, 'WORLD');
  assert.equal(summary.results[0].expected, 'HELLO');
});

test('runSnippetTests: non-empty stderr forces a fail even if stdout matches', async () => {
  // A warning from awk doesn't affect stdout, but we treat any stderr
  // as a failure for the test. The UI shows the stderr alongside the
  // diff so the user can decide whether the warning is acceptable.
  const runner = fakeRunner({ stdout: 'HELLO', stderr: 'awk: warning something' });
  const snippet = {
    id: 's1',
    program: 'x',
    tests: [{ id: 't1', input: 'hello', expected: 'HELLO', trimTrailingNewline: false }],
  };
  const summary = await runSnippetTests(snippet, runner.fn);
  assert.equal(summary.pass, 0);
  assert.equal(summary.fail, 1);
  assert.ok(summary.results[0].stderr.includes('awk: warning'));
});

test('runSnippetTests: trimTrailingNewline strips one \\n from both sides before comparing', async () => {
  // awk's print appends ORS (default '\n'), so raw stdout almost always
  // ends with a newline. With the toggle on, one trailing '\n' is
  // stripped from both actual and expected before comparing — saves
  // the user from having to type it into every Expected.
  const runner = fakeRunner({ stdout: 'HELLO\n', stderr: '' });
  const snippet = {
    id: 's1',
    program: 'x',
    tests: [{ id: 't1', input: 'hello', expected: 'HELLO', trimTrailingNewline: true }],
  };
  const summary = await runSnippetTests(snippet, runner.fn);
  assert.equal(summary.pass, 1);
  // Both sides are stored trimmed.
  assert.equal(summary.results[0].actual, 'HELLO');
  assert.equal(summary.results[0].expected, 'HELLO');
});

test('runSnippetTests: passes resolved vars to the runner', async () => {
  const runner = fakeRunner({ stdout: '', stderr: '' });
  const snippet = {
    id: 's1',
    program: 'p',
    params: [{ name: 'sep', default: ',' }],
    tests: [
      { id: 't1', input: 'x', expected: '', vars: { sep: '\t' } },
    ],
  };
  await runSnippetTests(snippet, runner.fn);
  assert.deepEqual(runner.calls[0].vars, { sep: '\t' });
});

test('runSnippetTests: caches summary so getCachedSummary returns it', async () => {
  resetState();
  const runner = fakeRunner({ stdout: '', stderr: '' });
  const snippet = {
    id: 'cached-id',
    program: 'x',
    tests: [{ id: 't1', input: '', expected: '', trimTrailingNewline: false }],
  };
  await runSnippetTests(snippet, runner.fn);
  const cached = getCachedSummary('cached-id');
  assert.ok(cached);
  assert.equal(cached.snippetId, 'cached-id');
  assert.equal(cached.pass, 1);
});

test('runSnippetTests: snippet with no tests returns an empty summary', async () => {
  const runner = fakeRunner({ stdout: '', stderr: '' });
  const summary = await runSnippetTests({ id: 's1', program: 'x', tests: [] }, runner.fn);
  assert.equal(summary.total, 0);
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------- //
// runChainTests — pipeline through injected runner
// ---------------------------------------------------------------- //

test('runChainTests: sequential steps, each fed the previous stdout', async () => {
  resetState();
  let callIdx = 0;
  const replies = [
    { stdout: 'A', stderr: '' },
    { stdout: 'B', stderr: '' },
  ];
  const runner = fakeRunner(() => replies[callIdx++]);
  const chain = {
    id: 'c1',
    steps: [
      { program: 'step1', params: [] },
      { program: 'step2', params: [] },
    ],
    tests: [{ id: 't1', input: 'seed', expected: 'B', trimTrailingNewline: false }],
  };
  const summary = await runChainTests(chain, runner.fn);
  assert.equal(summary.pass, 1);
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0].input, 'seed', 'first step sees the test input');
  assert.equal(runner.calls[1].input, 'A', 'second step sees first step stdout');
});

test('runChainTests: disabled steps are skipped', async () => {
  resetState();
  const runner = fakeRunner({ stdout: 'X', stderr: '' });
  const chain = {
    id: 'c1',
    steps: [
      { program: 'step1', disabled: true },
      { program: 'step2' },
    ],
    tests: [{ id: 't1', input: 'seed', expected: 'X', trimTrailingNewline: false }],
  };
  const summary = await runChainTests(chain, runner.fn);
  assert.equal(summary.pass, 1);
  assert.equal(runner.calls.length, 1, 'disabled step should not invoke the runner');
  assert.equal(runner.calls[0].program, 'step2');
});

test('runChainTests: stderr from any step fails the whole test', async () => {
  resetState();
  let n = 0;
  const runner = fakeRunner(() => {
    n++;
    if (n === 1) return { stdout: 'partial', stderr: '' };
    return { stdout: '', stderr: 'boom' };
  });
  const chain = {
    id: 'c1',
    steps: [{ program: 'a' }, { program: 'b' }],
    tests: [{ id: 't1', input: '', expected: 'partial', trimTrailingNewline: false }],
  };
  const summary = await runChainTests(chain, runner.fn);
  assert.equal(summary.pass, 0);
  assert.equal(summary.fail, 1);
  assert.ok(summary.results[0].stderr.includes('boom'));
});

test('runChainTests: snippet reference resolves to state.snippets program', async () => {
  resetState();
  state.snippets = [{ id: 'sn-upper', name: 'Upper', program: '{ print toupper($0) }' }];
  const runner = fakeRunner({ stdout: 'HELLO', stderr: '' });
  const chain = {
    id: 'c1',
    steps: [{ snippetId: 'sn-upper' }],
    tests: [{ id: 't1', input: 'hello', expected: 'HELLO', trimTrailingNewline: false }],
  };
  const summary = await runChainTests(chain, runner.fn);
  assert.equal(summary.pass, 1);
  assert.equal(runner.calls[0].program, '{ print toupper($0) }');
});

test('runChainTests: missing snippet reference fails the test cleanly', async () => {
  resetState();
  state.snippets = [];
  const runner = fakeRunner({ stdout: '', stderr: '' });
  const chain = {
    id: 'c1',
    steps: [{ snippetId: 'ghost' }],
    tests: [{ id: 't1', input: '', expected: '', trimTrailingNewline: false }],
  };
  const summary = await runChainTests(chain, runner.fn);
  assert.equal(summary.fail, 1);
  assert.ok(summary.results[0].stderr.includes('Missing snippet'));
  // Runner must NOT have been called — if the step references a ghost
  // snippet we can't build a program string, so we abort before awk.
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------- //
// unifiedDiff — line-level diff formatter (pure)
// ---------------------------------------------------------------- //

test('unifiedDiff: identical strings → all-context lines', () => {
  const d = unifiedDiff('a\nb\nc', 'a\nb\nc');
  assert.ok(d.every((l) => l.sign === ' '));
  assert.equal(d.length, 3);
});

test('unifiedDiff: single-line change emits one - and one +', () => {
  const d = unifiedDiff('hello', 'world');
  const signs = d.map((l) => l.sign);
  assert.ok(signs.includes('-'));
  assert.ok(signs.includes('+'));
});

test('unifiedDiff: pure insertion emits only + lines', () => {
  const d = unifiedDiff('', 'line');
  assert.deepEqual(d, [
    { sign: '-', text: '' },
    { sign: '+', text: 'line' },
  ]);
});
