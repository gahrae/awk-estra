import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeAwk,
  highlightAwk,
  findCandidateVars,
  flattenAwkProgram,
  extractBeginIoAssignments,
  findBeginBodyStartOffset,
} from '../../public/js/awk.js';

function typesOnly(tokens) {
  // Collapse whitespace-only noise for clarity; type-tag each non-ws token.
  return tokens.filter((t) => t.t !== 'ws').map((t) => ({ t: t.t, s: t.s }));
}

test('tokenizes keywords, builtins, vars, and identifiers', () => {
  const toks = typesOnly(tokenizeAwk('BEGIN { print NR; length(x) }'));
  const types = toks.map((t) => t.t);
  // Expect: keyword (BEGIN), punct, keyword (print), var (NR), punct,
  // builtin (length), punct, ident (x), punct, punct.
  assert.ok(types.includes('keyword'), 'keyword');
  assert.ok(types.includes('builtin'), 'builtin');
  assert.ok(types.includes('var'), 'var');
  assert.ok(types.includes('ident'), 'ident');
});

test('string literals: basic, escaped quote, unterminated on newline', () => {
  const a = typesOnly(tokenizeAwk('"hello"'));
  assert.deepEqual(a, [{ t: 'string', s: '"hello"' }]);

  const b = typesOnly(tokenizeAwk('"a\\"b"'));
  assert.equal(b[0].t, 'string');
  assert.equal(b[0].s, '"a\\"b"');

  // Unterminated string at newline: the tokenizer stops at \n and hands the
  // newline back as whitespace. This is the correct recovery for a running
  // highlighter while the user is still typing.
  const c = tokenizeAwk('"oops\nmore');
  assert.equal(c[0].t, 'string');
  assert.equal(c[0].s, '"oops');
});

test('regex context: / after { is a regex', () => {
  const toks = typesOnly(tokenizeAwk('{ /foo/ }'));
  assert.ok(toks.some((t) => t.t === 'regex' && t.s === '/foo/'));
});

test('regex context: / after a field is division (punct), not regex', () => {
  // $1 / 2 — the / must be division, not a regex literal.
  const toks = typesOnly(tokenizeAwk('$1 / 2'));
  assert.equal(toks[0].t, 'field');
  assert.equal(toks[1].t, 'punct');
  assert.equal(toks[1].s, '/');
  assert.equal(toks[2].t, 'number');
});

test('regex context: / after identifier is division', () => {
  const toks = typesOnly(tokenizeAwk('x / y'));
  assert.equal(toks[0].t, 'ident');
  assert.equal(toks[1].t, 'punct');
  assert.equal(toks[1].s, '/');
});

test('regex context: / after number is division', () => {
  const toks = typesOnly(tokenizeAwk('10 / 2'));
  assert.equal(toks[1].t, 'punct');
  assert.equal(toks[1].s, '/');
});

test('regex context: / after closing paren is division', () => {
  const toks = typesOnly(tokenizeAwk('(a) / 2'));
  // Tokens: '(', 'a', ')', '/', '2'
  assert.equal(toks[3].t, 'punct');
  assert.equal(toks[3].s, '/');
});

test('regex context: / at start of input is regex', () => {
  const toks = typesOnly(tokenizeAwk('/abc/'));
  assert.deepEqual(toks, [{ t: 'regex', s: '/abc/' }]);
});

test('numbers: int, float, scientific', () => {
  assert.equal(typesOnly(tokenizeAwk('42'))[0].s, '42');
  assert.equal(typesOnly(tokenizeAwk('3.14'))[0].s, '3.14');
  assert.equal(typesOnly(tokenizeAwk('1e5'))[0].s, '1e5');
  assert.equal(typesOnly(tokenizeAwk('1.5e-3'))[0].s, '1.5e-3');
});

test('field references: $0, $1, $NF', () => {
  const toks = typesOnly(tokenizeAwk('$0 $NF'));
  assert.equal(toks[0].t, 'field');
  assert.equal(toks[0].s, '$0');
  assert.equal(toks[1].t, 'field');
  assert.equal(toks[1].s, '$NF');
});

test('comments run to end of line', () => {
  const toks = typesOnly(tokenizeAwk('# a comment\nBEGIN'));
  assert.equal(toks[0].t, 'comment');
  assert.equal(toks[0].s, '# a comment');
  assert.equal(toks[1].t, 'keyword');
});

test('findCandidateVars picks free identifiers and skips keywords/builtins/vars', () => {
  const vars = findCandidateVars('BEGIN { FS = sep } { print $col; print length($0) }');
  const set = new Set(vars);
  assert.ok(set.has('sep'), 'sep');
  assert.ok(set.has('col'), 'col');
  assert.ok(!set.has('BEGIN'), 'BEGIN is a keyword');
  assert.ok(!set.has('FS'), 'FS is an awk var');
  assert.ok(!set.has('length'), 'length is a builtin and a function call');
  assert.ok(!set.has('print'), 'print is a keyword');
});

test('findCandidateVars excludes variables assigned in the program', () => {
  // `total` is compound-assigned — its final value depends on program flow,
  // not on a seed. Exclude. `col` is pure-read — include.
  const vars = findCandidateVars('{ total += $col } END { print total }');
  const set = new Set(vars);
  assert.ok(set.has('col'), 'col');
  assert.ok(!set.has('total'), 'total is assigned, not a -v candidate');
});

test('findCandidateVars excludes simple assignment, compound, and ++/--', () => {
  assert.ok(!findCandidateVars('{ x = 1; print x }').includes('x'));
  assert.ok(!findCandidateVars('{ x += 1; print x }').includes('x'));
  assert.ok(!findCandidateVars('{ x++ ; print x }').includes('x'));
  assert.ok(!findCandidateVars('{ ++x; print x }').includes('x'));
});

test('findCandidateVars keeps identifiers only used in equality comparisons', () => {
  // `x == 1` is a read, not an assign — should still be a candidate.
  const vars = findCandidateVars('{ if (x == 1) print }');
  assert.ok(vars.includes('x'));
});

test('findCandidateVars skips array names', () => {
  // `seen` and `count` are array names — can't be `-v`-supplied.
  const vars = findCandidateVars('!seen[$0]++ { count[$1]++ }');
  assert.ok(!vars.includes('seen'));
  assert.ok(!vars.includes('count'));
});

test('findCandidateVars skips array names seen as the RHS of `in`', () => {
  // `total_revenue` is subscripted in some occurrences and used as
  // `in total_revenue` in others — the array-name filter catches it
  // whole-program so the non-subscript usage is still excluded. `product`
  // is a `for (... in ...)` loop target — assigned on each iteration.
  const src = `
{
  total_revenue[$1] = $2
}
END {
  for (product in total_revenue) {
    print product, total_revenue[product]
  }
}`;
  const vars = findCandidateVars(src);
  assert.ok(!vars.includes('total_revenue'), 'total_revenue is an array');
  assert.ok(!vars.includes('product'), 'product is a for-in loop target');
});

test('findCandidateVars skips arrays marked only via `key in arr` (no subscript)', () => {
  // `keys` is only seen as the RHS of the `in` operator. Awk's `in`
  // requires an array, so this alone qualifies `keys` as an array.
  const vars = findCandidateVars('{ if ($1 in keys) print }');
  assert.ok(!vars.includes('keys'));
});

test('findCandidateVars skips user-defined function names', () => {
  const vars = findCandidateVars('function shout(s) { return toupper(s) } { print shout($0) }');
  assert.ok(!vars.includes('shout'), 'shout (declared + called)');
});

test('findCandidateVars dedupes repeated references', () => {
  const vars = findCandidateVars('{ print x; print x; print x }');
  assert.equal(vars.filter((v) => v === 'x').length, 1);
});

test('flattenAwkProgram: inserts ; between statements separated by newlines', () => {
  const out = flattenAwkProgram('BEGIN {\n  print "first"\n  print "second"\n}');
  assert.equal(out, 'BEGIN { print "first"; print "second"; }');
});

test('flattenAwkProgram: leaves already-single-line programs alone', () => {
  assert.equal(flattenAwkProgram('BEGIN { print "x" }'), 'BEGIN { print "x" }');
});

test('flattenAwkProgram: drops comments so they do not swallow the rest', () => {
  const out = flattenAwkProgram('# heading\nBEGIN { print "a" }  # trailing\n{ print }');
  assert.ok(!out.includes('#'), 'no # survives flattening');
  assert.ok(out.includes('BEGIN'));
  assert.ok(out.includes('{ print }'));
});

test('flattenAwkProgram: preserves strings containing # and ;', () => {
  const out = flattenAwkProgram('BEGIN {\n  print "a;b#c"\n  print "d"\n}');
  assert.equal(out, 'BEGIN { print "a;b#c"; print "d"; }');
});

test('flattenAwkProgram: no ; after { or } or ,', () => {
  assert.equal(
    flattenAwkProgram('BEGIN {\nprint "a"\n}\n{\nprint "b"\n}'),
    'BEGIN { print "a"; } { print "b"; }',
  );
  assert.equal(
    flattenAwkProgram('BEGIN {\n  print "a",\n        "b"\n}'),
    'BEGIN { print "a", "b"; }',
  );
});

test('flattenAwkProgram: no ; after && or ||', () => {
  const out = flattenAwkProgram('{\n  if (x > 0 &&\n      y > 0)\n    print "ok"\n}');
  assert.ok(!/&&\s*;/.test(out), 'no ; immediately after &&');
  assert.ok(!/\)\s*;\s*print/.test(out), 'no ; between if-cond and body');
});

test('flattenAwkProgram: no ; between if-header and body, or before else', () => {
  const out = flattenAwkProgram('{\n  if (x)\n    print "a"\n  else\n    print "b"\n}');
  // `if (x) print "a"; else print "b";` is what we want.
  assert.equal(out, '{ if (x) print "a"; else print "b"; }');
});

test('flattenAwkProgram: no ; before a leading { on the next line', () => {
  const out = flattenAwkProgram('function greet(name)\n{\n  print name\n}');
  assert.equal(out, 'function greet(name) { print name; }');
});

test('flattenAwkProgram: strips backslash line continuation', () => {
  const out = flattenAwkProgram('BEGIN {\n  x = 1 + \\\n      2\n  print x\n}');
  assert.equal(out, 'BEGIN { x = 1 + 2; print x; }');
});

test('flattenAwkProgram: for-loop header keeps its ; and body gets ; after', () => {
  const out = flattenAwkProgram('{\n  for (i = 0; i < 3; i++)\n    print i\n}');
  assert.equal(out, '{ for (i = 0; i < 3; i++) print i; }');
});

test('flattenAwkProgram: regex pattern followed by action block', () => {
  const out = flattenAwkProgram('/foo/ {\n  print\n}\n/bar/ {\n  print\n}');
  assert.equal(out, '/foo/ { print; } /bar/ { print; }');
});

test('flattenAwkProgram: do-while', () => {
  // The do-body needs its `;` terminator, but the trailing `while (cond)`
  // before `}` can be unterminated — POSIX awk allows an action block's
  // last statement to be unterminated. Suppressing the `;` after the
  // closing `)` of `while` also keeps plain `while (cond) stmt` correct.
  const out = flattenAwkProgram('{\n  do\n    print i++\n  while (i < 3)\n}');
  assert.equal(out, '{ do print i++; while (i < 3) }');
});

test('flattenAwkProgram: empty program and comment-only program', () => {
  assert.equal(flattenAwkProgram(''), '');
  assert.equal(flattenAwkProgram('# just a comment\n'), '');
});

test('extractBeginIoAssignments: single simple assignment', () => {
  const m = extractBeginIoAssignments('BEGIN { FS = "," } { print $1 }');
  assert.equal(m.size, 1);
  assert.equal(m.get('FS'), '","');
});

test('extractBeginIoAssignments: multiple vars, mixed separators', () => {
  const m = extractBeginIoAssignments('BEGIN {\n  FS = "\\t"\n  OFS = ","\n  RS = "\\n\\n"\n}');
  assert.equal(m.get('FS'), '"\\t"');
  assert.equal(m.get('OFS'), '","');
  assert.equal(m.get('RS'), '"\\n\\n"');
});

test('extractBeginIoAssignments: last writer wins within one program', () => {
  const m = extractBeginIoAssignments('BEGIN { FS = ","; FS = "\\t" }');
  assert.equal(m.get('FS'), '"\\t"');
});

test('extractBeginIoAssignments: ignores non-I/O vars', () => {
  const m = extractBeginIoAssignments('BEGIN { count = 0; FS = "," }');
  assert.equal(m.size, 1);
  assert.ok(!m.has('count'));
  assert.equal(m.get('FS'), '","');
});

test('extractBeginIoAssignments: skips assignments nested in control flow', () => {
  // `FS = "x"` inside the `if` block is conditional, not unconditional
  // BEGIN setup — don't copy it across steps.
  const m = extractBeginIoAssignments('BEGIN { if (ENVIRON["X"]) { FS = "x" } OFS = "|" }');
  assert.ok(!m.has('FS'));
  assert.equal(m.get('OFS'), '"|"');
});

test('extractBeginIoAssignments: ignores `FS == …` comparison', () => {
  const m = extractBeginIoAssignments('BEGIN { if (FS == ",") OFS = "|" }');
  assert.ok(!m.has('FS'));
});

test('extractBeginIoAssignments: strips trailing line comments from RHS', () => {
  // A `#` comment after the value shouldn't leak into the copied
  // assignment — otherwise pasting it into a downstream step would
  // swallow the following `;`/statements as part of the comment.
  const src = 'BEGIN {\n  FS = "\\t"  # tab-separated\n  OFS = "|" # pipe\n}';
  const m = extractBeginIoAssignments(src);
  assert.equal(m.get('FS'), '"\\t"');
  assert.equal(m.get('OFS'), '"|"');
});

test('extractBeginIoAssignments: handles RHS with string containing ; and }', () => {
  const m = extractBeginIoAssignments('BEGIN { FS = ";}"; OFS = "," }');
  assert.equal(m.get('FS'), '";}"');
  assert.equal(m.get('OFS'), '","');
});

test('extractBeginIoAssignments: picks up FIELDWIDTHS (gawk, tokenized as ident)', () => {
  const m = extractBeginIoAssignments('BEGIN { FIELDWIDTHS = "3 5 7" }');
  assert.equal(m.get('FIELDWIDTHS'), '"3 5 7"');
});

test('extractBeginIoAssignments: no BEGIN block → empty map', () => {
  const m = extractBeginIoAssignments('{ FS = "x"; print }');
  assert.equal(m.size, 0);
});

test('extractBeginIoAssignments: multiple BEGIN blocks, later overrides', () => {
  const m = extractBeginIoAssignments(
    'BEGIN { FS = "," }\nBEGIN { FS = "\\t"; OFS = "|" }\n{ print }',
  );
  assert.equal(m.get('FS'), '"\\t"');
  assert.equal(m.get('OFS'), '"|"');
});

test('findBeginBodyStartOffset: inline BEGIN', () => {
  const src = 'BEGIN { FS = "," }\n{ print }';
  // `BEGIN {` is 7 chars, so the position right after `{` is index 7.
  assert.equal(findBeginBodyStartOffset(src), 7);
  // Sanity: inserting at that offset lands between `{` and the space.
  const inserted = src.slice(0, 7) + '<X>' + src.slice(7);
  assert.equal(inserted, 'BEGIN {<X> FS = "," }\n{ print }');
});

test('findBeginBodyStartOffset: multi-line BEGIN with newline after the brace', () => {
  const src = 'BEGIN {\n  print "hi"\n}';
  // Expect the offset to point at the newline that follows `{` so an
  // insertion of `\n  FOO = "bar";` produces a clean blank line plus
  // the indented assignment before the original content.
  const at = findBeginBodyStartOffset(src);
  assert.equal(src[at], '\n');
  assert.equal(src[at - 1], '{');
});

test('findBeginBodyStartOffset: BEGIN with newline-before-brace', () => {
  const src = 'BEGIN\n{\n  print\n}';
  const at = findBeginBodyStartOffset(src);
  assert.equal(src[at - 1], '{');
});

test('findBeginBodyStartOffset: no BEGIN block → -1', () => {
  assert.equal(findBeginBodyStartOffset('{ print }'), -1);
  assert.equal(findBeginBodyStartOffset(''), -1);
});

test('findBeginBodyStartOffset: literal `{` inside a string is ignored', () => {
  // The `{` inside the FS string must NOT be mistaken for a body brace.
  const src = 'BEGIN { FS = "{" }';
  const at = findBeginBodyStartOffset(src);
  assert.equal(src[at - 1], '{');
  // The returned offset should point right after the FIRST real `{`,
  // not the one inside the string.
  assert.equal(at, 'BEGIN {'.length);
});

test('extractBeginIoAssignments: empty / whitespace-only program', () => {
  assert.equal(extractBeginIoAssignments('').size, 0);
  assert.equal(extractBeginIoAssignments('   \n\n').size, 0);
});

test('highlightAwk returns escaped HTML with token spans', () => {
  const html = highlightAwk('BEGIN { x = "<b>" }');
  // Keyword wrapped in a span.
  assert.match(html, /<span class="tok-keyword">BEGIN<\/span>/);
  // String content HTML-escaped.
  assert.match(html, /&lt;b&gt;/);
  // No raw <b> leakage.
  assert.ok(!html.includes('<b>'), 'no unescaped <b>');
});
