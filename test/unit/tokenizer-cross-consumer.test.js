import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenAwkProgram } from '../../public/js/awk.js';
import { findSideEffects } from '../../public/js/safety.js';

// These tests protect the invariant that the awk tokenizer and every
// consumer on top of it (findSideEffects, flattenAwkProgram,
// syntax-highlight) agree on what's code vs. string vs. regex vs.
// comment. A silent tokenizer drift would otherwise break the
// auto-preview gate (findSideEffects) without the user noticing — the
// highlighter would paint the same character as a string while the
// side-effect scan treated it as a pipe.

// ---------- findSideEffects positive cases ----------
//
// These programs contain a genuine side-effecting construct at the
// code level; findSideEffects must report at least one hit.

test('findSideEffects: system() call detected', () => {
  const hits = findSideEffects('BEGIN { system("ls") }');
  assert.ok(hits.includes('system() call'), `expected system() hit, got ${JSON.stringify(hits)}`);
});

test('findSideEffects: getline detected', () => {
  assert.ok(findSideEffects('{ getline x < "file" }').includes('getline (reads files or commands)'));
  assert.ok(findSideEffects('{ "cmd" | getline }').includes('getline (reads files or commands)'));
});

test('findSideEffects: plain pipe to command detected', () => {
  const hits = findSideEffects('{ print $0 | "sort" }');
  assert.ok(hits.includes('pipe to command'), `got ${JSON.stringify(hits)}`);
});

test('findSideEffects: |& coprocess pipe detected and labeled distinctly', () => {
  const hits = findSideEffects('{ print $0 |& "cmd" }');
  assert.ok(hits.includes('|& coprocess pipe'), `got ${JSON.stringify(hits)}`);
  // When the scan sees |& it must not also report a plain pipe.
  assert.equal(hits.includes('pipe to command'), false);
});

test('findSideEffects: > redirect after print detected', () => {
  const hits = findSideEffects('{ print $0 > "out.txt" }');
  assert.ok(hits.includes('output redirect (> or >>)'), `got ${JSON.stringify(hits)}`);
});

test('findSideEffects: > redirect after printf detected', () => {
  const hits = findSideEffects('{ printf "%s\\n", $0 > "out.txt" }');
  assert.ok(hits.includes('output redirect (> or >>)'), `got ${JSON.stringify(hits)}`);
});

// ---------- findSideEffects tokenizer-agreement negative cases ----------
//
// The side-effect keywords / punct appear literally in the source here,
// but the tokenizer classifies them as string / regex / comment — so
// findSideEffects must NOT report them. This is the core "tokenizer
// consumers agree" invariant.

test('findSideEffects: system() inside a string literal is not a call', () => {
  const hits = findSideEffects('{ print "system(x)" }');
  assert.deepEqual(hits, []);
});

test('findSideEffects: getline inside a string literal is inert', () => {
  const hits = findSideEffects('{ print "getline next" }');
  assert.deepEqual(hits, []);
});

test('findSideEffects: | inside a string literal is not a pipe', () => {
  const hits = findSideEffects('{ print "a|b|c" }');
  assert.deepEqual(hits, []);
});

test('findSideEffects: > inside a string literal is not a redirect', () => {
  const hits = findSideEffects('{ print "a>b" }');
  assert.deepEqual(hits, []);
});

test('findSideEffects: | inside a regex literal is not a pipe', () => {
  const hits = findSideEffects('/a|b/ { print }');
  assert.deepEqual(hits, []);
});

test('findSideEffects: system / getline / | / > inside a comment are all inert', () => {
  const prog = '# system() | getline > "x"\n{ print }';
  const hits = findSideEffects(prog);
  assert.deepEqual(hits, []);
});

// ---------- findSideEffects operator-disambiguation cases ----------
//
// These aren't string-or-regex cases — they're just operators that
// LOOK like side effects but aren't. The scan has to know the
// difference.

test('findSideEffects: || logical-or is not two pipes', () => {
  const hits = findSideEffects('{ if (a || b) print }');
  assert.equal(hits.includes('pipe to command'), false);
});

test('findSideEffects: > as comparison (no preceding print) is not a redirect', () => {
  const hits = findSideEffects('{ if (a > b) x = 1 }');
  assert.equal(hits.includes('output redirect (> or >>)'), false);
});

test('findSideEffects: system identifier without ( is not a call', () => {
  // `system` as a bare identifier (e.g. a user variable — unusual but
  // legal, and the scan shouldn't overcount).
  const hits = findSideEffects('{ system = 1 }');
  assert.equal(hits.includes('system() call'), false);
});

test('findSideEffects: semicolon resets the "print-seen" flag before a stray >', () => {
  // `print $1; if (a > b) ...` — the semicolon ends the print
  // statement, so the subsequent > is a comparison, not a redirect.
  const hits = findSideEffects('{ print $1; if (a > b) x = 1 }');
  assert.equal(hits.includes('output redirect (> or >>)'), false);
});

// ---------- flattenAwkProgram tokenizer-agreement cases ----------
//
// The collapser must respect the same string / regex / comment
// boundaries the tokenizer identifies; otherwise a newline or `;`
// inside a string would split the statement when collapsed.

test('flattenAwkProgram: comments dropped', () => {
  assert.equal(
    flattenAwkProgram('# leading comment\n{ print }'),
    '{ print }',
  );
});

test('flattenAwkProgram: newline inside a string literal is preserved verbatim', () => {
  // A `\n` escape inside a string is an escape sequence, not a raw
  // newline — the tokenizer keeps the literal two-character \n in the
  // token, so flattening doesn't touch it.
  const src = '{ print "a\\nb" }';
  const out = flattenAwkProgram(src);
  // The literal `\n` inside the quotes survives — no accidental split.
  assert.match(out, /"a\\nb"/);
});

test('flattenAwkProgram: | inside regex literal survives flattening', () => {
  const out = flattenAwkProgram('/a|b/ {\n  print\n}');
  // Regex intact; newlines inside the body became `;` or spaces.
  assert.match(out, /\/a\|b\//);
  assert.match(out, /print/);
});

test('flattenAwkProgram: multi-line if/else collapses cleanly', () => {
  const src = `{
  if (x)
    a = 1
  else
    b = 2
}`;
  const out = flattenAwkProgram(src);
  // Single line, `else` still attached — statement terminators respect
  // the `SKIP_AFTER_KEYWORD` rule for `else`.
  assert.ok(!out.includes('\n'), 'output is single-line');
  assert.match(out, /if \(x\)/);
  assert.match(out, /else/);
});

test('flattenAwkProgram: # inside a regex is not a comment', () => {
  // A `#` inside a `/.../` regex is a literal character — the tokenizer
  // keeps it in the regex token, so the comment-stripper can't eat it.
  const out = flattenAwkProgram('/a#b/ { print }');
  assert.match(out, /\/a#b\//);
});

test('flattenAwkProgram: empty / whitespace-only input yields empty string', () => {
  assert.equal(flattenAwkProgram(''), '');
  assert.equal(flattenAwkProgram('   \n  \t\n'), '');
  // Comments-only input: everything is dropped.
  assert.equal(flattenAwkProgram('# only a comment\n# and another'), '');
});
