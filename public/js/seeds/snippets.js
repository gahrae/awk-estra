// @ts-check
// Seed snippets shipped with a fresh install. Edit this file to change the
// default library contents that populate on first run.

/**
 * @typedef {import('../types.js').Snippet} Snippet
 * @typedef {import('../types.js').Test} Test
 * @typedef {Omit<Snippet, 'id' | 'tests'> & {
 *   tests?: Omit<Test, 'id'>[],
 *   seedId?: string,
 * }} SeedSnippet
 *
 * `seedId` is a stable identifier used only at seed time — it lets seed
 * chains reference a seed snippet by a name that survives across installs
 * (the real `id` is generated fresh by `uid()` when the library is seeded).
 * Stripped from the persisted snippet shape by `instantiateSeedSnippet`.
 */

/** @type {SeedSnippet[]} */
export const SEED_SNIPPETS = [
  {
    name: 'Uppercase',
    seedId: 'uppercase',
    description: 'Convert each line to UPPERCASE.',
    program: '{ print toupper($0) }',
    tags: ['case'],
    tests: [
      {
        name: 'Uppercases each line',
        input: 'hello\nworld',
        expected: 'HELLO\nWORLD',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Lowercase',
    description: 'Convert each line to lowercase.',
    program: '{ print tolower($0) }',
    tags: ['case'],
    tests: [
      {
        name: 'Lowercases each line',
        input: 'HELLO\nWorld',
        expected: 'hello\nworld',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Title Case',
    description: 'Capitalize the first letter of each word.',
    program:
      '{\n  for (i = 1; i <= NF; i++) {\n    $i = toupper(substr($i, 1, 1)) tolower(substr($i, 2))\n  }\n  print\n}',
    tags: ['case'],
    tests: [
      {
        name: 'Capitalizes each word',
        input: 'hello world\nfoo bar',
        expected: 'Hello World\nFoo Bar',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Remove Whitespace (with gsub)',
    description:
      'Trims leading/trailing whitespace from each line and collapses runs of internal spaces/tabs into a single space.',
    program: '{\n  gsub(/^[ \\t]+|[ \\t]+$/, "");\n  gsub(/[ \\t]+/, " ");\n  print\n}',
    tags: ['whitespace'],
    tests: [
      {
        name: 'Trims and collapses spaces',
        input: '  hello   world  ',
        expected: 'hello world',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Remove whitespace (rebuild)',
    seedId: 'remove-whitespace-rebuild',
    description:
      'Same result as the gsub version, but idiomatic awk. Assigning to any field ($1=$1) forces awk to rebuild $0 from $1..$NF joined by OFS (default: single space). The default FS already splits on runs of whitespace and trims leading/trailing, so the output is the line with normalized spacing. The trailing `1` is a truthy pattern that triggers the default action — print.',
    program: '{ $1=$1 }1',
    tags: ['whitespace'],
    tests: [
      {
        name: 'Trims and collapses spaces',
        input: '  hello   world  ',
        expected: 'hello world',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Remove Blank Lines',
    seedId: 'remove-blank-lines',
    description:
      'Drop blank or whitespace-only lines. A truthy pattern without an action block implicitly prints the record.',
    program: 'NF',
    tags: ['filter', 'whitespace'],
    tests: [
      {
        name: 'Drops blank lines',
        input: 'hello\n\nworld\n\n\nfoo',
        expected: 'hello\nworld\nfoo',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Unique Lines (Unsorted)',
    description:
      'Keep only the first occurrence of each line, preserving input order. Demonstrates awk associative arrays.',
    program: '!seen[$0]++',
    tags: ['filter'],
    tests: [
      {
        name: 'Keeps first occurrence only',
        input: 'apple\nbanana\napple\ncherry\nbanana',
        expected: 'apple\nbanana\ncherry',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Number Lines',
    description:
      'Prefix every line with its line number. NR is awk\u2019s built-in record counter.',
    program: '{ printf "%4d  %s\\n", NR, $0 }',
    tags: ['format'],
    tests: [
      {
        name: 'Prefixes line numbers',
        input: 'a\nb\nc',
        expected: '   1  a\n   2  b\n   3  c',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Reverse Lines',
    description:
      'Reverse the order of all lines. Stores lines into an array, then prints in reverse from the END block.',
    program: '{ a[NR] = $0 }\nEND { for (i = NR; i >= 1; i--) print a[i] }',
    tags: ['order'],
    tests: [
      {
        name: 'Reverses line order',
        input: 'one\ntwo\nthree',
        expected: 'three\ntwo\none',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Indent',
    description:
      'Prefix each line with a string. Set "prefix" to "\\t" for a tab, "> " for a Markdown quote, or any marker you like.',
    program: '{ print prefix $0 }',
    params: [{ name: 'prefix', default: '  ' }],
    tags: ['format', 'markdown'],
    tests: [
      {
        name: 'Indents with two spaces',
        input: 'hello\nworld',
        expected: '  hello\n  world',
        vars: { prefix: '  ' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Bullet List',
    description: 'Turn each line into a Markdown bullet.',
    program: '{ print "- " $0 }',
    tags: ['markdown'],
    tests: [
      {
        input: 'apple\nbanana\norange',
        expected: '- apple\n- banana\n- orange',
        name: 'Can make items bulleted',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Numbered List',
    description: 'Turn each line into a numbered Markdown list item.',
    program: '{ print NR ". " $0 }',
    tags: ['markdown'],
    tests: [
      {
        name: 'Numbers each line',
        input: 'apple\nbanana',
        expected: '1. apple\n2. banana',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Markdown Heading',
    description: 'Prepend a Markdown heading to each line. Set "level" to 1-6.',
    program:
      'BEGIN { for (i = 1; i <= level; i++) h = h "#" }\n/^$/ || /^[ \\t]+$/ { print $0; next }\n{ print h, $0 }',
    params: [{ name: 'level', default: '1' }],
    tags: ['markdown'],
    tests: [
      {
        name: 'Adds a level-1 heading',
        input: 'hello world',
        expected: '# hello world',
        vars: { level: '1' },
        trimTrailingNewline: true,
      },
      {
        name: 'Adds a level-2 heading',
        input: 'hello world',
        expected: '## hello world',
        vars: { level: '2' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Keep Matching',
    description:
      'Keep only lines matching the "pattern" regex. Change it to filter for e.g. ^#, ERROR, or your own pattern.',
    program: '$0 ~ pattern',
    params: [{ name: 'pattern' }],
    tags: ['filter'],
    tests: [
      {
        name: 'Keeps lines matching "error"',
        input: 'info: ok\nerror: bad\nwarn: maybe\nerror: fatal',
        expected: 'error: bad\nerror: fatal',
        vars: { pattern: 'error' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Skip Matching',
    description:
      'Drop lines matching the "pattern" regex. Default drops Markdown/shell comment lines.',
    program: '$0 !~ pattern',
    params: [{ name: 'pattern', default: '^#' }],
    tags: ['filter'],
    tests: [
      {
        name: 'Drops lines starting with #',
        input: '# comment\nhello\n# another\nworld',
        expected: 'hello\nworld',
        vars: { pattern: '^#' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Sum Column',
    description: 'Sum a whitespace-separated column of numbers. Set "col" to 1, 2, \u2026, N',
    program: '{ total += $col }\nEND { print total }',
    params: [{ name: 'col' }],
    tags: ['fields', 'math'],
    tests: [
      {
        name: 'Sums the first column',
        input: '10\n20\n30',
        expected: '60',
        vars: { col: '1' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Count by First Field',
    description:
      'Tally occurrences of the first field and print a histogram. Shows off associative arrays + for-in + END.',
    program: '{ count[$1]++ }\nEND { for (k in count) printf "%5d  %s\\n", count[k], k }',
    tags: ['fields', 'math'],
    tests: [
      {
        input: 'fun\nfun\nfun\npower\npower\nmoney',
        expected: '    2  power\n    3  fun\n    1  money',
        name: 'Can sum first field',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Change FS',
    description:
      'Convert between delimiters by splitting on old_fs and rejoining with new_fs. Assigning $1=$1 forces awk to rebuild $0 from the split fields using OFS.',
    program: 'BEGIN {\n  FS = old_fs\n  OFS = new_fs\n}\n{\n  $1=$1\n  print\n}',
    params: [
      { name: 'old_fs', default: ',' },
      { name: 'new_fs', default: ' ' },
    ],
    tags: ['fields'],
    tests: [
      {
        name: 'Splits on comma, rejoins with space',
        input: 'a,b,c\nd,e,f',
        expected: 'a b c\nd e f',
        vars: { old_fs: ',', new_fs: ' ' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'CSV Column',
    description:
      'Print a single column from delimited input. Try sep="," for CSV, "\\t" for TSV, "|" for pipe-delimited.',
    program: 'BEGIN { FS = sep }\n{ print $col }',
    params: [{ name: 'sep', default: ',' }, { name: 'col' }],
    tags: ['fields'],
    tests: [
      {
        name: 'Extracts second CSV column',
        input: 'a,b,c\nd,e,f',
        expected: 'b\ne',
        vars: { col: '2' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Show Fields',
    description:
      'Print each field with its index \u2014 useful for checking how awk splits a line under the current FS.',
    program: '{\n  for (i = 1; i <= NF; i++) {\n    printf "[%d]%s ", i, $i\n  }\n  print ""\n}',
    tags: ['fields'],
    tests: [
      {
        name: 'Indexes each field',
        input: 'hello world',
        expected: '[1]hello [2]world ',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Join Consecutive Lines',
    seedId: 'join-consecutive-lines',
    description:
      'Collapse consecutive lines into single-line paragraphs. Blank lines separate paragraphs.',
    program:
      '/^$/ { if (buf) print buf; print ""; buf = ""; next }\n{ buf = (buf ? buf " " : "") $0 }\nEND { if (buf) print buf }',
    tags: ['format'],
    tests: [
      {
        name: 'Joins paragraph lines',
        input: 'hello\nworld\n\nfoo\nbar',
        expected: 'hello world\n\nfoo bar',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Insert Date',
    description: 'Fetch date from system command',
    program:
      'BEGIN {\n  ORS = ""\n  cmd = "date +%Y-%m-%d"\n  cmd | getline date_value;\n  print date_value;\n  close(cmd)\n}',
    tags: ['content', 'system'],
  },
  {
    name: 'Bold inline selection',
    seedId: 'bold-inline',
    description: 'Add markdown bold (**) around a selection of text within a line',
    program: 'BEGIN { ORS="" }\n{ print "**" $0 "**" }',
    tags: ['markdown'],
    tests: [
      {
        input: 'bold',
        expected: '**bold**',
        name: 'Can bold selection',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Insert US Public Holidays',
    program:
      '# Purpose: Fetch US public holidays and display them in a table\n# Requires jq - https://jqlang.org/\n\nBEGIN {\n  cmd_fetch = "curl -s https://date.nager.at/api/v3/NextPublicHolidays/US" \\\n              " | jq -r \'.[] | \\"| \\\\(.date) | \\\\(.name) |\\"\'"\n\n  unformatted = "|DATE|NAME|\\n|---|---|"\n  while ((cmd_fetch | getline line) > 0) unformatted = unformatted "\\n" line\n  close(cmd_fetch)\n\n  cmd_format = "column -t -s \'|\' -o \'|\'"\n  print unformatted |& cmd_format\n  close(cmd_format, "to")\n\n  while ((cmd_format |& getline line) > 0) {\n    if (line ~ /^\\|[- ]+\\|[- ]+\\|$/) {\n      gsub(/[^|]/, "-", line)\n    }\n    print line\n  }\n  close(cmd_format)\n}\n',
    tags: ['content', 'markdown', 'system'],
  },
  {
    name: 'Run Command (no stdin)',
    seedId: 'run-cmd-nostdin',
    program: 'BEGIN {\n  while ((cmd |& getline line) > 0) {\n    print line\n  }\n  close(cmd)\n}',
    tags: ['content', 'system'],
    description: 'Run command and display output',
    params: [
      {
        name: 'cmd',
      },
    ],
  },
  {
    name: 'Run Command (with stdin)',
    seedId: 'run-cmd-stdin',
    program:
      '{\n  # |& writes to the command\'s stdin\n  print $0 |& cmd \n}\n\nEND {\n  # close write-side\n  close(cmd, "to")\n\n  # read commands stdout\n  while ((cmd |& getline line) > 0) {\n    print line \n  }\n\n  # close read-side and reap the child\n  close(cmd) \n}\n',
    tags: ['content', 'system'],
    params: [
      {
        name: 'cmd',
      },
    ],
    "shortcut": "Ctrl+I",
    "shortcutInsert": "Ctrl+Shift+I"
  },
  {
    name: 'JSON to JSONL',
    seedId: 'json-to-jsonl',
    description:
      'Explode a JSON array to JSON-lines (one compact JSON value per line) via `jq -c \'<query>\'`. The default `.[]` flattens a top-level array; use `.users[]` / `.data.items[]` to reach a nested one.',
    program:
      'BEGIN {\n  # Single-quote the filter for the shell; jq filters rarely contain\n  # single quotes themselves. |& is bidirectional — see "Two-way Pipe\n  # (sort demo)" for why this is the right idiom for commands that\n  # aggregate (here, jq has to see all of stdin before emitting).\n  cmd = "jq -c \'" jq_array_query "\'"\n}\n\n{ print $0 |& cmd }\n\nEND {\n  # Close write-side so jq sees EOF and can finally emit output.\n  close(cmd, "to")\n  while ((cmd |& getline line) > 0) print line\n  # Close read-side and reap the child.\n  close(cmd)\n}\n',
    tags: ['content', 'json', 'system'],
    params: [{ name: 'jq_array_query', default: '.[]' }],
  },
  {
    name: 'JSONL to JSON',
    description:
      'Slurp JSON-lines into a single JSON array via `jq -s .`. `-s` (slurp) tells jq to read every top-level value in stdin and combine them into one array.',
    program:
      'BEGIN {\n  # See "Two-way Pipe (sort demo)" for the |& idiom. jq -s must see\n  # all input before it can emit, which is why close(cmd, "to") is\n  # needed before the getline loop.\n  cmd = "jq -s ."\n}\n\n{ print $0 |& cmd }\n\nEND {\n  close(cmd, "to")\n  while ((cmd |& getline line) > 0) print line\n  close(cmd)\n}\n',
    tags: ['content', 'json', 'system'],
  },
  {
    name: 'JSONL to TSV',
    description:
      'Convert JSON-lines to tab-separated values — one header row + one row per record. Column order is taken from the FIRST record\u2019s keys; keys appearing only in later records are silently dropped. For heterogeneous JSONL, swap `(.[0] | keys_unsorted)` for `([.[] | keys_unsorted[]] | unique)` to get the union of all keys (alphabetised). Pipe-friendly primitive — pair with `cut`, `sort -t$\'\\t\'`, or `column -t` for display.',
    program:
      'BEGIN {\n  # jq builds the TSV: capture first record\'s keys as $h, then emit\n  # $h followed by each row\'s values in that order. @tsv handles tab\n  # joining + escaping. See "Two-way Pipe (sort demo)" for why |& and\n  # close(cmd, "to") are the right shape when jq -s has to see every\n  # input line before it can emit anything.\n  cmd = "jq -s -r \'(.[0] | keys_unsorted) as $h | $h, (.[] | [.[$h[]]]) | @tsv\'"\n}\n\n{ print $0 |& cmd }\n\nEND {\n  close(cmd, "to")\n  while ((cmd |& getline line) > 0) print line\n  close(cmd)\n}\n',
    tags: ['content', 'json', 'system'],
  },
  {
    name: 'JSONL to table',
    seedId: 'jsonl-to-table',
    description:
      'Aligned human-readable table from JSON-lines: jq builds TSV, `column -t` pads each column to the widest cell. Same first-record-wins key rule as "JSONL to TSV". Great for eyeballing data; don\u2019t pipe further — the whitespace padding is display-only.',
    program:
      'BEGIN {\n  # Same jq filter as "JSONL to TSV", then column -t aligns. The \\t\n  # inside the awk string is a literal tab at run-time, which the\n  # shell hands to column as its -s separator. Without -s, column\n  # would split on any whitespace and munge cells containing spaces.\n  cmd = "jq -s -r \'(.[0] | keys_unsorted) as $h | $h, (.[] | [.[$h[]]]) | @tsv\' | column -t -s \'\\t\'"\n}\n\n{ print $0 |& cmd }\n\nEND {\n  close(cmd, "to")\n  while ((cmd |& getline line) > 0) print line\n  close(cmd)\n}\n',
    tags: ['content', 'json', 'system'],
  },
  {
    name: 'TSV to JSONL',
    description:
      'Naive TSV (tab-separated, no escape mechanism) to JSON-lines. The first non-empty line is headers; each subsequent line becomes one JSON object, fields matched by position. All values stay strings — no type guessing, so `"42"` and `42` are indistinguishable inputs and both come out as `"42"`. Only `"` and `\\` in cells are JSON-escaped; naive TSV can\u2019t contain literal tabs / newlines inside cells. Pure awk, no external deps. Pair with "JSONL to JSON" if you need a single array instead of newline-delimited records.',
    program:
      'BEGIN {\n  FS = "\\t"\n}\n\nNF == 0 { next }\n\nncols == 0 {\n  # First non-empty line holds the column names. Freeze the width\n  # here — any row with a different NF uses the header count, so\n  # ragged rows produce empty trailing values / drop extras.\n  for (i = 1; i <= NF; i++) headers[i] = json_escape($i)\n  ncols = NF\n  next\n}\n\n{\n  line = "{"\n  for (i = 1; i <= ncols; i++) {\n    if (i > 1) line = line ","\n    line = line "\\"" headers[i] "\\":\\"" json_escape($i) "\\""\n  }\n  line = line "}"\n  print line\n}\n\n# Minimal JSON string escape for naive TSV input: backslash first\n# (so we don\'t double-escape the backslashes we just added), then\n# double-quote. Tab / newline / CR aren\'t handled because they\n# can\'t appear inside a cell under TSV\'s no-escape rules — if your\n# input might violate that, run an unescape pass first.\nfunction json_escape(s,    out, i, n, c) {\n  n = length(s)\n  out = ""\n  for (i = 1; i <= n; i++) {\n    c = substr(s, i, 1)\n    if (c == "\\\\") out = out "\\\\\\\\"\n    else if (c == "\\"") out = out "\\\\\\""\n    else out = out c\n  }\n  return out\n}\n',
    tags: ['content', 'json'],
  },

  // --- case additions ---
  {
    name: 'Sentence case',
    description:
      'Uppercase the first letter of the line and the first letter after every sentence-ending punctuation (. ! ?) followed by a space.',
    program:
      '{\n  s = $0\n  s = toupper(substr(s, 1, 1)) substr(s, 2)\n  while (match(s, /[.!?] [a-z]/)) {\n    pos = RSTART + 2\n    s = substr(s, 1, pos-1) toupper(substr(s, pos, 1)) substr(s, pos+1)\n  }\n  print s\n}',
    tags: ['case'],
    tests: [
      {
        name: 'Capitalizes first letter of each sentence',
        input: 'hello world. this is another. and one more.',
        expected: 'Hello world. This is another. And one more.',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Swap case',
    description: 'Invert upper \u2194 lower case for every letter; non-letters pass through.',
    program:
      '{\n  s = ""\n  for (i = 1; i <= length($0); i++) {\n    c = substr($0, i, 1)\n    if (c ~ /[A-Z]/) s = s tolower(c)\n    else if (c ~ /[a-z]/) s = s toupper(c)\n    else s = s c\n  }\n  print s\n}',
    tags: ['case'],
    tests: [
      {
        name: 'Inverts letter case',
        input: 'Hello World',
        expected: 'hELLO wORLD',
        trimTrailingNewline: true,
      },
    ],
  },

  // --- whitespace additions ---
  {
    name: 'Trim only',
    seedId: 'trim-only',
    description:
      'Strip leading and trailing spaces/tabs from each line; internal whitespace is preserved.',
    program: '{ gsub(/^[ \\t]+|[ \\t]+$/, ""); print }',
    tags: ['whitespace'],
    tests: [
      {
        name: 'Trims edges, keeps interior',
        input: '  hello   world  ',
        expected: 'hello   world',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Collapse blank runs',
    seedId: 'collapse-blank-runs',
    description:
      'Collapse two or more consecutive blank lines into a single blank line.\nA blank line is one that has no content or just whitespace.',
    program: '/^[ \\t]*$/ { if (!blank) print ""; blank = 1; next }\n{ blank = 0; print }',
    tags: ['whitespace'],
    tests: [
      {
        input: 'hello\n\n\nworld\n\n\n\nfoo',
        expected: 'hello\n\nworld\n\nfoo',
        name: 'Multiple blanks collapse to one',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Expand tabs',
    description: 'Replace each tab character with "width" spaces. Default width is 4.',
    program:
      'BEGIN { for (i = 0; i < width; i++) spaces = spaces " " }\n{ gsub(/\\t/, spaces); print }',
    params: [{ name: 'width', default: '4' }],
    tags: ['whitespace'],
    tests: [
      {
        name: 'Expands tab to 4 spaces',
        input: 'foo\tbar',
        expected: 'foo    bar',
        vars: { width: '4' },
        trimTrailingNewline: true,
      },
    ],
  },

  // --- filter additions ---
  {
    name: 'Header only (NR==1)',
    description:
      'Print only the first input line. NR is awk\u2019s running record counter (1-indexed).',
    program: 'NR == 1 { print }',
    tags: ['filter'],
    tests: [
      {
        name: 'Keeps only the first line',
        input: 'name,age\nalice,30\nbob,25',
        expected: 'name,age',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Skip header (NR>1)',
    description:
      'Skip the first line and print the rest \u2014 common when processing CSV or TSV with a header row.',
    program: 'NR > 1 { print }',
    tags: ['filter'],
    tests: [
      {
        name: 'Drops the first line',
        input: 'name,age\nalice,30\nbob,25',
        expected: 'alice,30\nbob,25',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Head',
    description: 'Print the first "n" lines. Default n = 10.',
    program: 'NR <= n',
    params: [{ name: 'n', default: '10' }],
    tags: ['filter'],
    tests: [
      {
        name: 'Keeps first two lines',
        input: 'a\nb\nc\nd',
        expected: 'a\nb',
        vars: { n: '2' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Tail',
    description:
      'Print the last "n" lines. Uses a ring buffer keyed by NR % n so memory stays bounded regardless of input length.',
    program:
      '{ buf[NR % n] = $0 }\nEND {\n  start = NR - n + 1\n  if (start < 1) start = 1\n  for (i = start; i <= NR; i++) print buf[i % n]\n}',
    params: [{ name: 'n', default: '10' }],
    tags: ['filter'],
    tests: [
      {
        name: 'Keeps last two lines',
        input: 'a\nb\nc\nd',
        expected: 'c\nd',
        vars: { n: '2' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Range between patterns',
    description:
      'Print lines from the first match of "start" through the next match of "end", inclusive. Uses awk\u2019s range pattern (pat1, pat2) with variable-driven regexes.',
    program: '$0 ~ start, $0 ~ end',
    params: [{ name: 'start' }, { name: 'end' }],
    tags: ['filter'],
    tests: [
      {
        name: 'Extracts BEGIN..END block',
        input: 'before\nBEGIN\nmiddle\nEND\nafter',
        expected: 'BEGIN\nmiddle\nEND',
        vars: { start: '^BEGIN', end: '^END' },
        trimTrailingNewline: true,
      },
    ],
  },

  // --- format additions ---
  {
    name: 'Replace pattern',
    description:
      'Replace every match of the "pattern" regex with "replacement" on each line. Uses gsub, so & in the replacement expands to the matched text.',
    program: '{ gsub(pattern, replacement); print }',
    params: [{ name: 'pattern' }, { name: 'replacement', default: '' }],
    tags: ['format'],
    tests: [
      {
        name: 'Replaces all matches per line',
        input: 'foo qux foo',
        expected: 'bar qux bar',
        vars: { pattern: 'foo', replacement: 'bar' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Wrap in quotes',
    description:
      'Wrap each line with the "q" character on both sides. Default q is a double quote.',
    program: '{ print q $0 q }',
    params: [{ name: 'q', default: '"' }],
    tags: ['format'],
    tests: [
      {
        name: 'Double-quotes each line',
        input: 'hello\nworld',
        expected: '"hello"\n"world"',
        vars: { q: '"' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Comment lines (toggle)',
    description:
      'Toggle comment on each line: already-commented lines get uncommented, plain lines get the marker added. Leading indentation is preserved. Uses gawk\u2019s gensub() for the regex back-reference \u2014 requires GNU awk. Marker must not contain regex metacharacters (`#`, `//`, `--`, `;`, `%` are all fine).',
    program:
      '{\n  if ($0 ~ "^[[:space:]]*" marker) {\n    print gensub("^([[:space:]]*)" marker " ?", "\\\\1", 1)\n  } else {\n    print marker " " $0\n  }\n}',
    params: [{ name: 'marker', default: '#' }],
    tags: ['format'],
    tests: [
      {
        name: 'Comments a plain line',
        input: 'hello',
        expected: '# hello',
        vars: { marker: '#' },
        trimTrailingNewline: true,
      },
      {
        name: 'Uncomments an already-commented line',
        input: '# hello',
        expected: 'hello',
        vars: { marker: '#' },
        trimTrailingNewline: true,
      },
      {
        name: 'Toggles mixed input line-by-line',
        input: '# hello\nworld',
        expected: 'hello\n# world',
        vars: { marker: '#' },
        trimTrailingNewline: true,
      },
      {
        name: 'Preserves leading indentation when uncommenting',
        input: '  # indented',
        expected: '  indented',
        vars: { marker: '#' },
        trimTrailingNewline: true,
      },
      {
        name: 'Uncomments with no space after the marker',
        input: '#tight',
        expected: 'tight',
        vars: { marker: '#' },
        trimTrailingNewline: true,
      },
      {
        name: 'Works with a multi-character marker (//)',
        input: '// commented\nplain',
        expected: 'commented\n// plain',
        vars: { marker: '//' },
        trimTrailingNewline: true,
      },
    ],
  },

  // --- order additions ---
  {
    name: 'Sort lines',
    description:
      'Sort all input lines alphabetically. Uses gawk\u2019s asort() to sort values in place; requires GNU awk.',
    program:
      '{ lines[NR] = $0 }\nEND {\n  n = asort(lines)\n  for (i = 1; i <= n; i++) print lines[i]\n}',
    tags: ['order'],
    tests: [
      {
        name: 'Sorts alphabetically',
        input: 'charlie\nalpha\nbravo',
        expected: 'alpha\nbravo\ncharlie',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Shuffle lines',
    description:
      'Print lines in random order using a Fisher\u2013Yates shuffle. Seeded from the current time, so each run produces a different order; not deterministic.',
    program:
      '{ a[NR] = $0 }\nEND {\n  srand()\n  for (i = NR; i > 1; i--) {\n    j = int(rand() * i) + 1\n    t = a[i]; a[i] = a[j]; a[j] = t\n  }\n  for (i = 1; i <= NR; i++) print a[i]\n}',
    tags: ['order'],
  },

  // --- markdown additions ---
  {
    name: 'Code fence',
    description:
      'Wrap the whole input in a Markdown triple-backtick fenced code block. Set "lang" to e.g. "awk", "python", or leave blank for a plain fence.',
    program: 'BEGIN { print "```" lang }\n{ print }\nEND { print "```" }',
    params: [{ name: 'lang', default: '' }],
    tags: ['markdown'],
    tests: [
      {
        name: 'Fences content with language',
        input: 'print(1)',
        expected: '```python\nprint(1)\n```',
        vars: { lang: 'python' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Italic',
    description: 'Wrap each line in Markdown italics (*\u2026*).',
    program: '{ print "*" $0 "*" }',
    tags: ['markdown'],
    tests: [
      {
        name: 'Italicizes each line',
        input: 'hello\nworld',
        expected: '*hello*\n*world*',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Blockquote',
    description: 'Prefix each line with "> " to turn the block into a Markdown blockquote.',
    program: '{ print "> " $0 }',
    tags: ['markdown'],
    tests: [
      {
        name: 'Prepends blockquote marker',
        input: 'hello\nworld',
        expected: '> hello\n> world',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Bold first sentence',
    seedId: 'bold-first-sentence',
    description:
      'Wrap the first sentence of each line in Markdown bold (**\u2026**). A sentence ends at the first `.`, `!`, or `?`. Any leading bullet marker (optional spaces + `-` + space) stays outside the bold so list markup is preserved. Sentences that span multiple lines are not handled \u2014 each line is processed independently.',
    program:
      '{\n  line = $0\n  prefix = ""\n  if (match(line, /^[ \\t]*-[ \\t]+/)) {\n    prefix = substr(line, 1, RLENGTH)\n    line = substr(line, RLENGTH + 1)\n  }\n  if (line == "") { print $0; next }\n  if (match(line, /[.!?]/)) {\n    end = RSTART\n    print prefix "**" substr(line, 1, end) "**" substr(line, end + 1)\n  } else {\n    print prefix "**" line "**"\n  }\n}',
    tags: ['markdown'],
    tests: [
      {
        name: 'Bolds the first sentence',
        input: 'Hello world. This is another.',
        expected: '**Hello world.** This is another.',
        trimTrailingNewline: true,
      },
      {
        name: 'Preserves leading bullet marker',
        input: '  - First sentence. Second sentence.',
        expected: '  - **First sentence.** Second sentence.',
        trimTrailingNewline: true,
      },
      {
        name: 'Handles "!" and "?" sentence endings',
        input: 'Wow! More text.\nReally? Yes.',
        expected: '**Wow!** More text.\n**Really?** Yes.',
        trimTrailingNewline: true,
      },
      {
        name: 'Bolds whole line when no sentence punctuation',
        input: 'no punctuation here',
        expected: '**no punctuation here**',
        trimTrailingNewline: true,
      },
      {
        name: 'Leaves blank lines alone',
        input: 'First. Second.\n\nNext. Paragraph.',
        expected: '**First.** Second.\n\n**Next.** Paragraph.',
        trimTrailingNewline: true,
      },
    ],
  },

  // --- fields additions ---
  {
    name: 'Swap two fields',
    description:
      'Swap the fields at positions "a" and "b" (1-indexed) on each line. Assigning to a field rebuilds $0 with OFS between fields.',
    program: '{ t = $a; $a = $b; $b = t; print }',
    params: [{ name: 'a' }, { name: 'b' }],
    tags: ['fields'],
    tests: [
      {
        name: 'Swaps field 1 with field 3',
        input: 'one two three',
        expected: 'three two one',
        vars: { a: '1', b: '3' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Keep first N fields',
    seedId: 'keep-first-n-fields',
    description:
      'Drop every field past position "n" on each line. Setting NF triggers awk to rebuild $0 with only the fields that remain.',
    program: '{ NF = n; print }',
    params: [{ name: 'n' }],
    tags: ['fields'],
    tests: [
      {
        name: 'Keeps first two fields',
        input: 'a b c d',
        expected: 'a b',
        vars: { n: '2' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Unique field values',
    description:
      'Print unique values of field "col" in order of first appearance. Same !seen[$0]++ trick, but keyed by a single field.',
    program: '!seen[$col]++ { print $col }',
    params: [{ name: 'col' }],
    tags: ['fields'],
    tests: [
      {
        name: 'First column, unique only',
        input: 'apple 1\nbanana 2\napple 3\ncherry 4',
        expected: 'apple\nbanana\ncherry',
        vars: { col: '1' },
        trimTrailingNewline: true,
      },
    ],
  },

  // --- math additions ---
  {
    name: 'Average of column',
    description: 'Print the arithmetic mean of column "col" across all input lines.',
    program: '{ sum += $col; n++ }\nEND { if (n) print sum / n }',
    params: [{ name: 'col' }],
    tags: ['fields', 'math'],
    tests: [
      {
        name: 'Averages first column',
        input: '10\n20\n30',
        expected: '20',
        vars: { col: '1' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Max of column',
    description: 'Print the maximum numeric value found in column "col".',
    program: 'NR == 1 { max = $col; next }\n$col > max { max = $col }\nEND { print max }',
    params: [{ name: 'col' }],
    tags: ['fields', 'math'],
    tests: [
      {
        name: 'Finds the maximum',
        input: '10\n5\n20\n15',
        expected: '20',
        vars: { col: '1' },
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Running total',
    description: 'Print a running cumulative sum of column "col" \u2014 one value per input line.',
    program: '{ total += $col; print total }',
    params: [{ name: 'col' }],
    tags: ['fields', 'math'],
    tests: [
      {
        name: 'Cumulative sum of first column',
        input: '10\n20\n30',
        expected: '10\n30\n60',
        vars: { col: '1' },
        trimTrailingNewline: true,
      },
    ],
  },

  // --- system additions ---
  {
    name: 'Prefix with timestamp',
    description:
      'Prepend the current date (YYYY-MM-DD) to every line. Shells out to `date` once in BEGIN, then reuses the value.',
    program:
      'BEGIN { "date +%Y-%m-%d" | getline ts; close("date +%Y-%m-%d") }\n{ print ts " " $0 }',
    tags: ['format', 'system'],
  },
  {
    name: 'Prepend hostname',
    description:
      'Prepend the machine hostname to every line. Shells out to `hostname` once in BEGIN.',
    program: 'BEGIN { "hostname" | getline host; close("hostname") }\n{ print host ": " $0 }',
    tags: ['format', 'system'],
  },

  // --- content additions ---
  {
    name: 'Print env var',
    description:
      'Print the value of the named environment variable using awk\u2019s ENVIRON[] array. Does not read input.',
    program: 'BEGIN { print ENVIRON[name] }',
    params: [{ name: 'name' }],
    tags: ['content', 'system'],
  },
  {
    name: 'Line count',
    description: 'Print only the total number of input lines, like `wc -l`.',
    program: 'END { print NR }',
    tags: ['math'],
    tests: [
      {
        name: 'Counts three lines',
        input: 'a\nb\nc',
        expected: '3',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Parse CSV (FPAT)',
    description:
      'Parse CSV with quoted fields (commas inside double quotes are preserved as part of the field) using gawk\'s FPAT. Strips the surrounding quotes for display. gawk-only. Try it on the seeded `quoted.csv` text snippet.',
    program:
      '# Parse CSV with quoted fields using gawk\'s FPAT.\n' +
      '# A field is either a bare comma-free run or a "..." string;\n' +
      '# commas inside the quotes stay part of the field. gawk-only —\n' +
      '# POSIX awk has no FPAT.\n' +
      '\n' +
      'function unquote(s) {\n' +
      '  if (length(s) >= 2 && substr(s, 1, 1) == "\\"" && substr(s, length(s), 1) == "\\"") {\n' +
      '    return substr(s, 2, length(s) - 2)\n' +
      '  }\n' +
      '  return s\n' +
      '}\n' +
      '\n' +
      'BEGIN { FPAT = "([^,]*)|(\\"[^\\"]*\\")" }\n' +
      '\n' +
      '{\n' +
      '  for (i = 1; i <= NF; i++) {\n' +
      '    printf "%s%s", unquote($i), (i < NF ? " | " : "\\n")\n' +
      '  }\n' +
      '}\n',
    tags: ['gawk', 'csv'],
    tests: [
      {
        name: 'Preserves commas inside quoted fields',
        input: 'Alice,30,"Loves cats, dogs"',
        expected: 'Alice | 30 | Loves cats, dogs',
        trimTrailingNewline: true,
      },
      {
        name: 'Three plain fields',
        input: 'Bob,25,Paris',
        expected: 'Bob | 25 | Paris',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Parse ls -l (FIELDWIDTHS)',
    description:
      'Parse `ls -l` output into named fields (perms, lnk, owner, group, size, date, name) with gawk\'s FIELDWIDTHS, then re-print as an aligned table. gawk-only. Try it on the seeded `mi6-intercept.txt` text snippet.',
    program:
      '# Parse `ls -l` output into named fields using gawk\'s FIELDWIDTHS.\n' +
      '# Each width includes the leading space separator, so trim() strips\n' +
      '# it before printing. gawk-only — POSIX awk has no FIELDWIDTHS.\n' +
      '\n' +
      'function trim(s) { sub(/^ +/, "", s); sub(/ +$/, "", s); return s }\n' +
      '\n' +
      'BEGIN {\n' +
      '  FIELDWIDTHS = "10 3 8 9 8 13 *"\n' +
      '  printf "%-10s  %3s  %-7s  %-8s  %7s  %-12s  %s\\n", \\\n' +
      '    "perms", "lnk", "owner", "group", "size", "date", "name"\n' +
      '}\n' +
      '\n' +
      '# Skip `ls -l`\'s "total N" preamble.\n' +
      '$0 ~ /^total[[:space:]]/ { next }\n' +
      '\n' +
      '{\n' +
      '  printf "%-10s  %3s  %-7s  %-8s  %7s  %-12s  %s\\n", \\\n' +
      '    trim($1), trim($2), trim($3), trim($4), trim($5), trim($6), trim($7)\n' +
      '}\n',
    tags: ['gawk', 'columns'],
    tests: [
      {
        name: 'Parses one row into named fields',
        input:
          '-rw-r--r--  1 alice   staff        42 Jan 15  2024 notes.txt',
        expected:
          'perms       lnk  owner    group        size  date          name\n' +
          '-rw-r--r--    1  alice    staff          42  Jan 15  2024  notes.txt',
        trimTrailingNewline: true,
      },
    ],
  },
];
