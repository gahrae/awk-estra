import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  state,
  chainParamList,
  resolveChainVars,
  pipelineParamList,
  ensureChainStepIds,
  chainParamUsage,
  resolveStepVars,
  planChainVarsPrompt,
  applyChainPromptAnswers,
  pruneOrphanStepVars,
} from '../../public/js/state.js';

// Reset the shared module-level `state` to a known baseline before each test.
// These helpers are pure, but they read state.snippets when resolving
// `step.snippetId` references.
function resetState() {
  state.snippets = [];
  state.chains = [];
  state.textSnippets = [];
  state.templates = [];
  state.tabs = [];
  state.activeTabId = null;
  state.pipeline = [];
  state.pipelineVars = {};
  state.activeStep = null;
}

test('chainParamList: inline step params surface directly', () => {
  resetState();
  const chain = {
    steps: [
      { program: '{ print }', params: [{ name: 'sep', default: ',' }] },
      { program: '{ print }', params: [{ name: 'col' }] },
    ],
  };
  const params = chainParamList(chain);
  assert.equal(params.length, 2);
  assert.equal(params[0].name, 'sep');
  assert.equal(params[0].default, ',');
  assert.equal(params[1].name, 'col');
});

test('chainParamList: snippet steps pull params from state.snippets', () => {
  resetState();
  state.snippets = [
    { id: 's1', name: 'A', program: '{ print }', params: [{ name: 'x', default: '1' }] },
    { id: 's2', name: 'B', program: '{ print }', params: [{ name: 'y' }] },
  ];
  const chain = {
    steps: [{ snippetId: 's1' }, { snippetId: 's2' }],
  };
  const params = chainParamList(chain);
  assert.deepEqual(
    params.map((p) => p.name),
    ['x', 'y'],
  );
});

test('chainParamList: duplicate names — first occurrence wins', () => {
  resetState();
  const chain = {
    steps: [
      { params: [{ name: 'n', default: 'first' }] },
      { params: [{ name: 'n', default: 'second' }] },
    ],
  };
  const params = chainParamList(chain);
  assert.equal(params.length, 1);
  assert.equal(params[0].default, 'first');
});

test('chainParamList: missing snippet reference contributes nothing', () => {
  resetState();
  state.snippets = [];
  const chain = { steps: [{ snippetId: 'does-not-exist' }] };
  assert.deepEqual(chainParamList(chain), []);
});

test('chainParamList: empty/missing steps', () => {
  assert.deepEqual(chainParamList({ steps: [] }), []);
  assert.deepEqual(chainParamList({}), []);
});

test('resolveChainVars: chain-level override wins over step default', () => {
  resetState();
  const chain = {
    vars: { sep: '|' },
    steps: [{ params: [{ name: 'sep', default: ',' }] }],
  };
  const { resolved, needsPrompting } = resolveChainVars(chain, true);
  assert.equal(resolved.sep, '|');
  assert.equal(needsPrompting.length, 0);
});

test('resolveChainVars: acceptDefaults=true uses step default when no chain override', () => {
  resetState();
  const chain = {
    steps: [{ params: [{ name: 'sep', default: ',' }] }],
  };
  const { resolved, needsPrompting } = resolveChainVars(chain, true);
  assert.equal(resolved.sep, ',');
  assert.equal(needsPrompting.length, 0);
});

test('resolveChainVars: acceptDefaults=false always prompts', () => {
  resetState();
  const chain = {
    steps: [{ params: [{ name: 'sep', default: ',' }] }],
  };
  const { resolved, needsPrompting, initialPromptValues } = resolveChainVars(chain, false);
  assert.equal(resolved.sep, undefined);
  assert.equal(needsPrompting.length, 1);
  assert.equal(needsPrompting[0].name, 'sep');
  // Prefill value still provided so the prompt dialog can render defaults.
  assert.equal(initialPromptValues.sep, ',');
});

test('resolveChainVars: empty string chain override falls through to default/prompt', () => {
  resetState();
  // An explicit empty chainVars entry means "unset" — should NOT override
  // the step's default when acceptDefaults is on.
  const chain = {
    vars: { sep: '' },
    steps: [{ params: [{ name: 'sep', default: ',' }] }],
  };
  const { resolved } = resolveChainVars(chain, true);
  assert.equal(resolved.sep, ',');
});

test('resolveChainVars: no default + accept mode still prompts', () => {
  resetState();
  const chain = {
    steps: [{ params: [{ name: 'col' }] }],
  };
  const { needsPrompting } = resolveChainVars(chain, true);
  assert.equal(needsPrompting.length, 1);
  assert.equal(needsPrompting[0].name, 'col');
});

test('pipelineParamList: dedupes by name, first-wins default', () => {
  resetState();
  state.pipeline = [
    { program: '{ print }', params: [{ name: 'col', default: '1' }] },
    { program: '{ print }', params: [{ name: 'col', default: '2' }] },
    { program: '{ print }', params: [{ name: 'sep', default: ',' }] },
  ];
  const list = pipelineParamList();
  assert.deepEqual(list, [
    { name: 'col', default: '1' },
    { name: 'sep', default: ',' },
  ]);
});

// ---------------------------------------------------------------- //
// Per-step chain vars (design v4)
// ---------------------------------------------------------------- //

test('ensureChainStepIds: stamps id on every step missing one, returns true if mutated', () => {
  resetState();
  const chain = {
    steps: [{ program: '{}' }, { id: 'kept', program: '{}' }, { program: '{}' }],
  };
  const mutated = ensureChainStepIds(chain);
  assert.equal(mutated, true);
  assert.ok(chain.steps[0].id, 'first step got an id');
  assert.equal(chain.steps[1].id, 'kept', 'existing id preserved');
  assert.ok(chain.steps[2].id, 'third step got an id');
  // Second call is a no-op.
  assert.equal(ensureChainStepIds(chain), false);
});

test('chainParamUsage: groups (step, param) pairs by name, skips disabled', () => {
  resetState();
  const chain = {
    steps: [
      { id: 'a', program: '{}', params: [{ name: 'cmd' }, { name: 'sep', default: ',' }] },
      { id: 'b', program: '{}', params: [{ name: 'cmd' }], disabled: true },
      { id: 'c', program: '{}', params: [{ name: 'cmd' }] },
    ],
  };
  const usage = chainParamUsage(chain);
  assert.deepEqual(
    usage.cmd.map((u) => u.stepId).sort(),
    ['a', 'c'],
    'disabled step "b" should not appear',
  );
  assert.equal(usage.sep.length, 1);
  assert.equal(usage.sep[0].stepId, 'a');
});

test('resolveStepVars: precedence is step default → chain.vars → stepVars → overlay', () => {
  resetState();
  const step = {
    id: 's1',
    program: '{}',
    params: [
      { name: 'cmd', default: 'default-cmd' },
      { name: 'sep', default: ',' },
    ],
  };
  const chain = {
    steps: [step],
    vars: { cmd: 'chain-cmd' },
    stepVars: { s1: { cmd: 'step-cmd' } },
  };
  // Without overlay: step default < chain.vars < stepVars → step-cmd wins.
  assert.equal(resolveStepVars(chain, step).cmd, 'step-cmd');
  // Overlay wins over stepVars.
  assert.equal(resolveStepVars(chain, step, { cmd: 'overlay-cmd' }).cmd, 'overlay-cmd');
  // Unaffected sibling name reaches its step default.
  assert.equal(resolveStepVars(chain, step).sep, ',');
});

test('resolveStepVars: empty chain.vars or stepVars values do NOT override step defaults', () => {
  resetState();
  const step = {
    id: 's1',
    program: '{}',
    params: [{ name: 'col', default: '1' }],
  };
  const chain = {
    steps: [step],
    vars: { col: '' },
    stepVars: { s1: { col: '' } },
  };
  assert.equal(resolveStepVars(chain, step).col, '1');
});

test('resolveStepVars: flat mode — chain.vars wins over step default', () => {
  // Without `perStepNames`, chain.vars blankets every step. This is
  // the behaviour people rely on when they type a single flat value
  // in the Variables section.
  resetState();
  const a = { id: 'a', program: '{}', params: [{ name: 'sep', default: ',' }] };
  const b = { id: 'b', program: '{}', params: [{ name: 'sep', default: ',' }] };
  const chain = { steps: [a, b], vars: { sep: '\t' } };
  assert.equal(resolveStepVars(chain, a).sep, '\t');
  assert.equal(resolveStepVars(chain, b).sep, '\t');
});

test('resolveStepVars: per-step mode — step default wins over chain.vars', () => {
  // The screenshot scenario: user set chain.vars.cmd to fill the
  // default-less step, engaged per-step mode. The step with its own
  // default must keep it, not get overridden by the chain-level value.
  resetState();
  const encode = { id: 'encode', program: '{}', params: [{ name: 'cmd' }] };
  const decode = { id: 'decode', program: '{}', params: [{ name: 'cmd', default: 'base64 -d' }] };
  const chain = {
    steps: [encode, decode],
    vars: { cmd: 'base64' },
    perStepNames: ['cmd'],
  };
  // encode has no default → chain.vars fills the gap.
  assert.equal(resolveStepVars(chain, encode).cmd, 'base64');
  // decode has its own default → wins over chain.vars.
  assert.equal(resolveStepVars(chain, decode).cmd, 'base64 -d');
});

test('resolveStepVars: per-step mode — stored stepVars still win over step default', () => {
  resetState();
  const step = { id: 's1', program: '{}', params: [{ name: 'cmd', default: 'base64' }] };
  const chain = {
    steps: [step],
    perStepNames: ['cmd'],
    stepVars: { s1: { cmd: 'base64 -d' } },
  };
  assert.equal(resolveStepVars(chain, step).cmd, 'base64 -d');
});

test('planChainVarsPrompt: one flat row per name when no per-step overrides are stored', () => {
  resetState();
  const chain = {
    steps: [
      { id: 'a', program: '{}', params: [{ name: 'cmd' }] },
      { id: 'b', program: '{}', params: [{ name: 'cmd' }] },
    ],
  };
  const plan = planChainVarsPrompt(chain, false);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].stepId, null);
  assert.equal(plan.rows[0].name, 'cmd');
});

test('planChainVarsPrompt: per-step rows when any step has an override stored', () => {
  resetState();
  const chain = {
    steps: [
      { id: 'a', program: '{}', params: [{ name: 'cmd' }] },
      { id: 'b', program: '{}', params: [{ name: 'cmd' }] },
    ],
    stepVars: { a: { cmd: 'base64' } },
  };
  const plan = planChainVarsPrompt(chain, false);
  // Step `a` is settled (override present), so it's skipped.
  // Step `b` still needs a value — prompt for it per-step.
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].stepId, 'b');
  assert.equal(plan.rows[0].name, 'cmd');
  assert.ok(plan.rows[0].label.includes('cmd'));
});

test('planChainVarsPrompt: divergent step defaults are silent under acceptDefaults', () => {
  // Regression for the encode-then-decode case: two steps declare the
  // same name with different non-empty defaults, chain.vars blank,
  // stepVars empty. Under acceptDefaults each step's own layer-1
  // default is authoritative — the prompt shouldn't fire.
  resetState();
  const chain = {
    steps: [
      {
        id: 'encode',
        program: '{}',
        params: [{ name: 'cmd', default: 'base64' }],
      },
      {
        id: 'decode',
        program: '{}',
        params: [{ name: 'cmd', default: 'base64 -d' }],
      },
    ],
  };
  const plan = planChainVarsPrompt(chain, true);
  assert.equal(plan.rows.length, 0, 'no prompt when step defaults settle every step');
  assert.equal(plan.needsPrompting, false);
});

test('planChainVarsPrompt: divergent step defaults prompt per-step when not accepting defaults', () => {
  // With acceptDefaults off the user has asked to always see the
  // prompt. Defaults diverge, so we still use per-step rows (not a
  // flat row) so a single answer can't accidentally clobber both.
  resetState();
  const chain = {
    steps: [
      {
        id: 'encode',
        program: '{}',
        params: [{ name: 'cmd', default: 'base64' }],
      },
      {
        id: 'decode',
        program: '{}',
        params: [{ name: 'cmd', default: 'base64 -d' }],
      },
    ],
  };
  const plan = planChainVarsPrompt(chain, false);
  assert.equal(plan.rows.length, 2);
  assert.deepEqual(
    plan.rows.map((r) => r.stepId).sort(),
    ['decode', 'encode'],
  );
  // Each row's initial is the step's OWN default.
  const encodeRow = plan.rows.find((r) => r.stepId === 'encode');
  const decodeRow = plan.rows.find((r) => r.stepId === 'decode');
  assert.equal(encodeRow.initial, 'base64');
  assert.equal(decodeRow.initial, 'base64 -d');
});

test('planChainVarsPrompt: partially-defaulted — prompt only the step without a default', () => {
  // One step has a non-empty default, the other doesn't. Under
  // acceptDefaults only the default-less step is unsettled; the other
  // silently uses its layer-1 default.
  resetState();
  const chain = {
    steps: [
      { id: 'a', program: '{}', params: [{ name: 'x', default: 'fixed' }] },
      { id: 'b', program: '{}', params: [{ name: 'x' }] },
    ],
  };
  const plan = planChainVarsPrompt(chain, true);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].stepId, 'b', 'only the default-less step prompts');
});

test('planChainVarsPrompt: chain-global value satisfies all using steps', () => {
  resetState();
  const chain = {
    steps: [
      { id: 'a', program: '{}', params: [{ name: 'col' }] },
      { id: 'b', program: '{}', params: [{ name: 'col' }] },
    ],
    vars: { col: '2' },
  };
  const plan = planChainVarsPrompt(chain, false);
  assert.equal(plan.rows.length, 0, 'chain.vars settles the flat row');
});

test('applyChainPromptAnswers: splits flat answers into chain + step overlays', () => {
  const rows = [
    { key: 'sep', name: 'sep', label: 'sep', stepId: null, param: { name: 'sep' }, initial: '' },
    { key: 'a:cmd', name: 'cmd', label: 'cmd · A', stepId: 'a', param: { name: 'cmd' }, initial: '' },
    { key: 'b:cmd', name: 'cmd', label: 'cmd · B', stepId: 'b', param: { name: 'cmd' }, initial: '' },
  ];
  const { chainOverlay, stepOverlay } = applyChainPromptAnswers(rows, {
    sep: ',',
    'a:cmd': 'base64',
    'b:cmd': 'base64 -d',
  });
  assert.deepEqual(chainOverlay, { sep: ',' });
  assert.deepEqual(stepOverlay, { a: { cmd: 'base64' }, b: { cmd: 'base64 -d' } });
});

test('pruneOrphanStepVars: drops entries for missing step ids and undeclared names', () => {
  resetState();
  const chain = {
    steps: [
      { id: 'a', program: '{}', params: [{ name: 'cmd' }] },
    ],
    stepVars: {
      a: { cmd: 'keep', gone: 'drop' },
      missing: { cmd: 'drop' },
    },
  };
  pruneOrphanStepVars(chain);
  assert.deepEqual(chain.stepVars, { a: { cmd: 'keep' } });
});

test('pruneOrphanStepVars: removes chain.stepVars entirely when every entry was orphaned', () => {
  resetState();
  const chain = {
    steps: [{ id: 'a', program: '{}', params: [] }],
    stepVars: { missing: { x: 'y' } },
  };
  pruneOrphanStepVars(chain);
  assert.equal(chain.stepVars, undefined);
});
