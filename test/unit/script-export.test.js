import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShellScriptFromTemplate,
  buildPipelineShellCommand,
  shellSingleQuote,
} from '../../public/js/pipeline.js';
import { DEFAULT_SCRIPT_EXPORT_TEMPLATE } from '../../public/js/data.js';
import { state } from '../../public/js/state.js';

// Helper: reset `state.snippets` for each test so results don't leak.
// Steps may reference `snippetId` which buildShellScriptFromTemplate
// resolves against `state.snippets`; tests pass inline steps only so
// the snippet table stays irrelevant, but we clear it for safety.
function resetState() {
  state.snippets = [];
  state.pipeline = [];
  state.pipelineVars = {};
  state.pipelineStepVars = {};
  state.pipelinePerStepNames = [];
}

const OPTS = (over = {}) => ({
  flatten: true,
  extension: '.sh',
  template: DEFAULT_SCRIPT_EXPORT_TEMPLATE,
  ...over,
});

test('buildShellScriptFromTemplate: SCRIPT_NAME uses sanitized chain name + extension', () => {
  resetState();
  const out = buildShellScriptFromTemplate('My Cool Chain!', [], {}, OPTS());
  assert.equal(out.filename, 'my-cool-chain.sh');
  assert.match(out.content, /chmod u\+x my-cool-chain\.sh/);
});

test('buildShellScriptFromTemplate: USAGE_EXAMPLE resolves nested {SCRIPT_NAME}', () => {
  resetState();
  const out = buildShellScriptFromTemplate('foo', [], {}, OPTS());
  // The default template writes `{USAGE_EXAMPLE}` verbatim; the helper
  // pre-expands SCRIPT_NAME inside it before the single-pass replace.
  assert.match(out.content, /# \.\/foo\.sh < INPUT_FILE/);
  assert.doesNotMatch(out.content, /\{SCRIPT_NAME\}/);
  assert.doesNotMatch(out.content, /\{USAGE_EXAMPLE\}/);
});

test('buildShellScriptFromTemplate: STEP_NAMES_LIST_NUMBERED numbers starting at 1', () => {
  resetState();
  // Populate state.snippets so stepLabel resolves the names cleanly (no
  // "(inline)" suffix) — mirrors the typical snippet-ref chain.
  state.snippets = [
    { id: 'sn-lower', name: 'Lowercase', program: '{ print tolower($0) }' },
    { id: 'sn-swap', name: 'Swap case', program: '{ print $0 }' },
    { id: 'sn-sent', name: 'Sentence case', program: '{ print $0 }' },
  ];
  const steps = [
    { id: 's1', snippetId: 'sn-lower' },
    { id: 's2', snippetId: 'sn-swap' },
    { id: 's3', snippetId: 'sn-sent' },
  ];
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS());
  assert.match(out.content, /# 1\. Lowercase/);
  assert.match(out.content, /# 2\. Swap case/);
  assert.match(out.content, /# 3\. Sentence case/);
});

test('buildShellScriptFromTemplate: STEP_NAMES_LIST emits plain # per step (no numbers)', () => {
  resetState();
  state.snippets = [
    { id: 'sn-a', name: 'First', program: '1' },
    { id: 'sn-b', name: 'Second', program: '1' },
  ];
  const steps = [
    { id: 's1', snippetId: 'sn-a' },
    { id: 's2', snippetId: 'sn-b' },
  ];
  const template = '{STEP_NAMES_LIST}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  assert.equal(out.content, '# First\n# Second');
});

test('buildShellScriptFromTemplate: inline steps get the "(inline)" suffix stepLabel applies', () => {
  resetState();
  const steps = [
    { id: 's1', name: 'Clean', program: '{ print }' },
    { id: 's2', program: '{ print }' }, // no name → "(inline)"
  ];
  const template = '{STEP_NAMES_LIST_NUMBERED}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  assert.equal(out.content, '# 1. Clean (inline)\n# 2. (inline)');
});

test('buildShellScriptFromTemplate: AWK_PIPE_CMD joins steps with | and shell-quotes each program', () => {
  resetState();
  const steps = [
    { id: 's1', name: 'a', program: '{ print }' },
    { id: 's2', name: 'b', program: '{ print NR }' },
  ];
  const template = '{AWK_PIPE_CMD}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  assert.match(out.content, /awk '\{ print \}' \\\n {2}\| awk '\{ print NR \}'/);
});

test('buildShellScriptFromTemplate: flatten=true collapses multi-line awk', () => {
  resetState();
  const multi = 'BEGIN {\n  FS = ","\n}\n{ print $1 }';
  const steps = [{ id: 's1', name: 'a', program: multi }];
  const template = '{AWK_PIPE_CMD}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ flatten: true, template }));
  // Inside the single quotes there should be no raw newline between
  // `BEGIN` and `{ print $1 }`.
  assert.doesNotMatch(out.content, /BEGIN \{\n/);
  assert.match(out.content, /FS = ","/);
  assert.match(out.content, /print \$1/);
});

test('buildShellScriptFromTemplate: flatten=false preserves newlines inside single quotes', () => {
  resetState();
  const multi = 'BEGIN {\n  FS = ","\n}\n{ print $1 }';
  const steps = [{ id: 's1', name: 'a', program: multi }];
  const template = '{AWK_PIPE_CMD}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ flatten: false, template }));
  // The raw program (with newlines) round-trips via shellSingleQuote; the
  // ' ... ' bracketing keeps the newlines literal.
  assert.ok(out.content.includes(shellSingleQuote(multi)));
  // Sanity: there's an actual newline between BEGIN and the closing brace.
  assert.match(out.content, /BEGIN \{\n {2}FS = ","\n\}/);
});

test('buildShellScriptFromTemplate: disabled steps are skipped everywhere', () => {
  resetState();
  const steps = [
    { id: 's1', name: 'keep', program: '{ print }' },
    { id: 's2', name: 'skip me', program: '{ bad }', disabled: true },
    { id: 's3', name: 'also keep', program: '{ print NR }' },
  ];
  const template = '{STEP_NAMES_LIST}\n---\n{AWK_PIPE_CMD}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  assert.doesNotMatch(out.content, /skip me/);
  assert.doesNotMatch(out.content, /\{ bad \}/);
  assert.match(out.content, /# keep/);
  assert.match(out.content, /# also keep/);
});

test('buildShellScriptFromTemplate: empty VARIABLES_BLOCK swallows its whole template line', () => {
  resetState();
  const steps = [{ id: 's1', name: 'a', program: '{ print }' }];
  // Token sits alone on its line (surrounded by blanks). With no params
  // the block is empty, and the substitutor drops the whole line so the
  // output is `before\n\nafter` — not `before\n\n\nafter`.
  const template = 'before\n\n{VARIABLES_BLOCK}\n\nafter';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  assert.equal(out.content, 'before\n\n\nafter');
});

test('buildShellScriptFromTemplate: VARIABLES_BLOCK emits ONLY the shell var assignments (no header)', () => {
  resetState();
  const steps = [
    {
      id: 's1',
      name: 'a',
      program: '{ print }',
      params: [
        { name: 'sep', default: ',' },
        { name: 'col', default: '2' },
      ],
    },
  ];
  const template = '{VARIABLES_BLOCK}';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  // No `# Variables` header — the template owns that text now.
  assert.doesNotMatch(out.content, /# Variables/);
  assert.doesNotMatch(out.content, /\.\/script < input/);
  assert.equal(out.content, 'sep="${sep:-,}"\ncol="${col:-2}"');
});

test('buildShellScriptFromTemplate: empty token surrounded by indent/whitespace still swallows the line', () => {
  resetState();
  // Leading spaces before the token — still considered "alone on line".
  const template = 'a\n   {VARIABLES_BLOCK}   \nb';
  const out = buildShellScriptFromTemplate('x', [], {}, OPTS({ template }));
  assert.equal(out.content, 'a\nb');
});

test('buildShellScriptFromTemplate: non-empty token on its own line substitutes in place', () => {
  resetState();
  const steps = [
    {
      id: 's1',
      name: 'a',
      program: '{ print }',
      params: [{ name: 'sep', default: ',' }],
    },
  ];
  const template = 'a\n{VARIABLES_BLOCK}\nb';
  const out = buildShellScriptFromTemplate('x', steps, {}, OPTS({ template }));
  assert.equal(out.content, 'a\nsep="${sep:-,}"\nb');
});

test('buildShellScriptFromTemplate: inline empty token does NOT swallow the surrounding text', () => {
  resetState();
  // Token embedded in a line with other content — inline substitution
  // kicks in, and the line stays (just with the token replaced by "").
  const template = '# vars: {VARIABLES_BLOCK} (none)';
  const out = buildShellScriptFromTemplate('x', [], {}, OPTS({ template }));
  assert.equal(out.content, '# vars:  (none)');
});

test('buildShellScriptFromTemplate: chain-level vars override step defaults in the block', () => {
  resetState();
  const steps = [
    {
      id: 's1',
      name: 'a',
      program: '{ print }',
      params: [{ name: 'sep', default: ',' }],
    },
  ];
  const template = '{VARIABLES_BLOCK}';
  const out = buildShellScriptFromTemplate('x', steps, { sep: ';' }, OPTS({ template }));
  assert.match(out.content, /sep="\$\{sep:-;\}"/);
});

test('buildShellScriptFromTemplate: extension "sh" (no dot) gets normalised to ".sh"', () => {
  resetState();
  const out = buildShellScriptFromTemplate('x', [], {}, OPTS({ extension: 'sh' }));
  assert.equal(out.filename, 'x.sh');
});

test('buildShellScriptFromTemplate: extension "" yields a bare filename with no dot', () => {
  resetState();
  const out = buildShellScriptFromTemplate('x', [], {}, OPTS({ extension: '' }));
  assert.equal(out.filename, 'x');
});

test('buildShellScriptFromTemplate: extension with existing dot is left alone', () => {
  resetState();
  const out = buildShellScriptFromTemplate('x', [], {}, OPTS({ extension: '.bash' }));
  assert.equal(out.filename, 'x.bash');
});

test('buildShellScriptFromTemplate: extension with multi-segment (.tar.gz) is preserved verbatim', () => {
  // Unusual for scripts, but the normaliser's contract is "add one
  // leading dot if missing, otherwise pass through" — don't over-parse.
  resetState();
  const out = buildShellScriptFromTemplate('x', [], {}, OPTS({ extension: 'tar.gz' }));
  assert.equal(out.filename, 'x.tar.gz');
});

test('buildShellScriptFromTemplate: empty chain name falls back to "chain"', () => {
  resetState();
  const out = buildShellScriptFromTemplate('', [], {}, OPTS());
  assert.equal(out.filename, 'chain.sh');
});

test('buildShellScriptFromTemplate: chain name sanitizes to lowercase with punctuation → dashes', () => {
  resetState();
  const out = buildShellScriptFromTemplate('  Weird/Name@#!  ', [], {}, OPTS());
  assert.equal(out.filename, 'weird-name.sh');
});

test('buildShellScriptFromTemplate: unknown tokens pass through unchanged', () => {
  resetState();
  const template = 'hello {NOT_A_TOKEN} world {SCRIPT_NAME}';
  const out = buildShellScriptFromTemplate('foo', [], {}, OPTS({ template }));
  assert.equal(out.content, 'hello {NOT_A_TOKEN} world foo.sh');
});

test('buildShellScriptFromTemplate: empty steps list still emits SCRIPT_NAME / USAGE_EXAMPLE, AWK_PIPE_CMD blank', () => {
  resetState();
  const template = '{SCRIPT_NAME} | {AWK_PIPE_CMD} | {USAGE_EXAMPLE}';
  const out = buildShellScriptFromTemplate('foo', [], {}, OPTS({ template }));
  assert.equal(out.content, 'foo.sh |  | # ./foo.sh < INPUT_FILE');
});

test('buildShellScriptFromTemplate: per-step mode emits numbered name_N shell vars', () => {
  // The encode-then-decode scenario: two steps declare `cmd` with
  // different defaults, user engaged per-step mode. The script must
  // emit `cmd_1="${cmd_1:-base64}"` and `cmd_2="${cmd_2:-base64 -d}"`
  // and wire each step's awk invocation to its numbered var.
  resetState();
  const steps = [
    {
      id: 'encode',
      program: '{ print $0 |& cmd }',
      params: [{ name: 'cmd', default: 'base64' }],
    },
    {
      id: 'decode',
      program: '{ print $0 |& cmd }',
      params: [{ name: 'cmd', default: 'base64 -d' }],
    },
  ];
  const template = '{VARIABLES_BLOCK}\n---\n{AWK_PIPE_CMD}';
  const out = buildShellScriptFromTemplate(
    'roundtrip',
    steps,
    {},
    OPTS({ template, perStepNames: ['cmd'] }),
  );
  // Variables block declares both numbered vars with each step's default.
  assert.match(out.content, /cmd_1="\$\{cmd_1:-base64\}"/);
  assert.match(out.content, /cmd_2="\$\{cmd_2:-base64 -d\}"/);
  assert.doesNotMatch(out.content, /\bcmd="\$\{cmd:-/, 'no unnumbered cmd in per-step mode');
  // Each awk invocation references its own numbered var.
  assert.match(out.content, /awk -v cmd="\$cmd_1" /);
  assert.match(out.content, /awk -v cmd="\$cmd_2" /);
});

test('buildShellScriptFromTemplate: per-step mode with 6 using steps renders 6 numbered vars', () => {
  // User's real chain: alternating encode / decode across 6 steps.
  // Mixed shapes (explicit defaults, stepVars overrides) — all lanes
  // end up as numbered `cmd_N` vars with correct resolved defaults.
  resetState();
  const steps = [
    { id: 'a', program: '{}', params: [{ name: 'cmd', default: 'base64' }] },
    { id: 'b', program: '{}', params: [{ name: 'cmd', default: 'base64 -d' }] },
    { id: 'c', program: '{}', params: [{ name: 'cmd' }] },
    { id: 'd', program: '{}', params: [{ name: 'cmd' }] },
    { id: 'e', program: '{}', params: [{ name: 'cmd' }] },
    { id: 'f', program: '{}', params: [{ name: 'cmd' }] },
  ];
  const template = '{VARIABLES_BLOCK}';
  const out = buildShellScriptFromTemplate(
    'roundtrip',
    steps,
    {},
    OPTS({
      template,
      perStepNames: ['cmd'],
      stepVars: {
        c: { cmd: 'base64' },
        d: { cmd: 'base64 -d' },
        e: { cmd: 'base64' },
        f: { cmd: 'base64 -d' },
      },
    }),
  );
  assert.match(out.content, /cmd_1="\$\{cmd_1:-base64\}"/);
  assert.match(out.content, /cmd_2="\$\{cmd_2:-base64 -d\}"/);
  assert.match(out.content, /cmd_3="\$\{cmd_3:-base64\}"/);
  assert.match(out.content, /cmd_4="\$\{cmd_4:-base64 -d\}"/);
  assert.match(out.content, /cmd_5="\$\{cmd_5:-base64\}"/);
  assert.match(out.content, /cmd_6="\$\{cmd_6:-base64 -d\}"/);
});

test('buildShellScriptFromTemplate: flat mode (no perStepNames) still emits unnumbered name', () => {
  // Backwards compat: absent `perStepNames`, even a chain with
  // differing step defaults falls through to the legacy single-var
  // output. Keeps simple chains (one var used by every step) looking
  // the same as before this change.
  resetState();
  const steps = [
    { id: 'a', program: '{}', params: [{ name: 'sep', default: ',' }] },
    { id: 'b', program: '{}', params: [{ name: 'sep', default: ',' }] },
  ];
  const template = '{VARIABLES_BLOCK}\n---\n{AWK_PIPE_CMD}';
  const out = buildShellScriptFromTemplate('x', steps, { sep: '|' }, OPTS({ template }));
  assert.match(out.content, /sep="\$\{sep:-\|\}"/);
  // Unnumbered awk invocations.
  assert.match(out.content, /awk -v sep="\$sep" /);
  assert.doesNotMatch(out.content, /sep_\d/, 'no numbered vars in flat mode');
});

test('buildShellScriptFromTemplate: per-step name with only one using step stays unnumbered', () => {
  // Defensive: if perStepNames lists a name but only one step uses
  // it (stale list / orphan), fall back to unnumbered form so we
  // don't emit `cmd_1` as the sole var for no reason.
  resetState();
  const steps = [
    { id: 's1', program: '{}', params: [{ name: 'cmd', default: 'base64' }] },
  ];
  const template = '{VARIABLES_BLOCK}';
  const out = buildShellScriptFromTemplate(
    'x',
    steps,
    {},
    OPTS({ template, perStepNames: ['cmd'] }),
  );
  assert.match(out.content, /cmd="\$\{cmd:-base64\}"/);
  assert.doesNotMatch(out.content, /cmd_1=/);
});

test('buildPipelineShellCommand: encode/decode chain loaded into pipeline keeps per-step values', () => {
  // Regression: loading a per-step chain into the pipeline used to
  // collapse every step's `cmd` to the same value because the copy-shell
  // path pulled flat `collectPipelineVars()` without honoring
  // `state.pipelineStepVars` / `state.pipelinePerStepNames`.
  resetState();
  state.pipeline = [
    {
      id: 'encode',
      program: '{ print $0 |& cmd }',
      params: [{ name: 'cmd', default: 'base64' }],
    },
    {
      id: 'decode',
      program: '{ print $0 |& cmd }',
      params: [{ name: 'cmd', default: 'base64 -d' }],
    },
  ];
  state.pipelineVars = {};
  state.pipelineStepVars = {};
  state.pipelinePerStepNames = ['cmd'];
  const out = buildPipelineShellCommand();
  assert.match(out, /-v 'cmd=base64' /);
  assert.match(out, /-v 'cmd=base64 -d' /);
  // Two awk invocations joined by a pipe.
  assert.equal(out.split(' | ').length, 2);
});

test('buildPipelineShellCommand: pipelineStepVars overrides win over step defaults', () => {
  // Simulates a chain where the first step declares a default but the
  // user stored an explicit per-step override in pipelineStepVars.
  resetState();
  state.pipeline = [
    {
      id: 'a',
      program: '{ print $0 |& cmd }',
      params: [{ name: 'cmd', default: 'base64' }],
    },
    {
      id: 'b',
      program: '{ print $0 |& cmd }',
      params: [{ name: 'cmd' }],
    },
  ];
  state.pipelineVars = {};
  state.pipelineStepVars = { b: { cmd: 'base64 -d' } };
  state.pipelinePerStepNames = ['cmd'];
  const out = buildPipelineShellCommand();
  assert.match(out, /-v 'cmd=base64' /);
  assert.match(out, /-v 'cmd=base64 -d' /);
});

test('buildShellScriptFromTemplate: default template with a two-step chain produces runnable script shape', () => {
  resetState();
  state.snippets = [
    { id: 'sn-up', name: 'uppercase', program: '{ print toupper($0) }' },
    { id: 'sn-trim', name: 'trim', program: '{ sub(/ +$/, ""); print }' },
  ];
  const steps = [
    { id: 's1', snippetId: 'sn-up' },
    { id: 's2', snippetId: 'sn-trim' },
  ];
  const out = buildShellScriptFromTemplate('my chain', steps, {}, OPTS());
  assert.equal(out.filename, 'my-chain.sh');
  assert.match(out.content, /^#!\/usr\/bin\/env bash\n/);
  assert.match(out.content, /set -euo pipefail/);
  assert.match(out.content, /chmod u\+x my-chain\.sh/);
  assert.match(out.content, /# \.\/my-chain\.sh < INPUT_FILE/);
  assert.match(out.content, /# 1\. uppercase/);
  assert.match(out.content, /# 2\. trim/);
  assert.match(out.content, /awk '\{ print toupper\(\$0\) \}' \\\n {2}\| awk/);
});
