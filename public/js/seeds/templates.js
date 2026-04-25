// @ts-check
// Seed templates shipped with a fresh install. Edit this file to change the
// default template library that populates on first run.
//
// Tag taxonomy (keep this set small and stable — the sidebar groups by it):
//   - structure — program skeletons and record/field-separator config
//                 (BEGIN/END blocks, FS/OFS/RS tweaks, if/else).
//   - filter    — pattern rules that select which records pass through
//                 (regex, range, compound, NR-based, exit-early).
//   - loop      — explicit iteration (for, while, do-while, for-each).
//   - idiom     — classic awk one-liner patterns worth knowing by name
//                 (!seen[$0]++, accumulator + END, ring-buffer tail).
//   - fields    — $1..$NF / NF / OFS manipulation.
//   - string    — gsub / substr / length / printf / split.
//   - array     — associative-array usage.
//   - function  — reusable user-defined helpers (trim, round, join).

/** @type {{name: string, description?: string, body: string, tags?: string[]}[]} */
export const AWK_TEMPLATES_SEED = [
  {
    name: 'BEGIN / END blocks',
    description:
      'Full awk skeleton: BEGIN runs once before input, the middle block runs per record, END runs once after all input.',
    body: 'BEGIN {\n  \n}\n\n{\n  \n}\n\nEND {\n  \n}',
    tags: ['structure'],
  },
  {
    name: 'BEGIN only',
    description:
      'Setup-only block. Runs once before any input is read \u2014 useful for emitting a header or initializing variables.',
    body: 'BEGIN {\n  \n}',
    tags: ['structure'],
  },
  {
    name: 'END only',
    description:
      'Summary-only block. Runs once after all input has been consumed \u2014 perfect for totals, counts, or final formatting.',
    body: 'END {\n  \n}',
    tags: ['structure'],
  },
  {
    name: 'Regex filter',
    description: 'Keep only lines matching a regular expression. Replace "pattern" with your own.',
    body: '/pattern/ { print }',
    tags: ['filter'],
  },
  {
    name: 'Regex filter (negated)',
    description: 'Keep lines that do NOT match the regex.',
    body: '!/pattern/ { print }',
    tags: ['filter'],
  },
  {
    name: 'Range pattern',
    description:
      'Print the inclusive range of lines from the first match of /START/ to the next match of /END/.',
    body: '/START/,/END/ { print }',
    tags: ['filter'],
  },
  {
    name: 'Compound pattern',
    description:
      'Combine conditions with && (AND) or || (OR). Here: lines where the first field is "foo" AND the record has more than 3 fields.',
    body: '$1 == "foo" && NF > 3 { print }',
    tags: ['filter'],
  },
  {
    name: 'Last line (END)',
    description: 'Print only the final record. Inside END, $0 still holds the last line awk read.',
    body: 'END { print }',
    tags: ['filter', 'idiom'],
  },
  {
    name: 'Field loop',
    description:
      'Iterate over every field in the current record. NF holds the field count; $1..$NF are the fields.',
    body: '{\n  for (i = 1; i <= NF; i++) {\n    \n  }\n  print\n}',
    tags: ['fields', 'loop'],
  },
  {
    name: 'Custom field separator',
    description:
      'Change the input field separator. Set FS in BEGIN so it applies from the very first record.',
    body: 'BEGIN { FS = "," }\n{\n  \n}',
    tags: ['fields', 'structure'],
  },
  {
    name: 'Reverse fields',
    description: 'Print the fields of each line in reverse order, separated by OFS.',
    body: '{\n  for (i = NF; i >= 1; i--)\n    printf "%s%s", $i, (i > 1 ? OFS : RS)\n}',
    tags: ['fields', 'loop'],
  },
  {
    name: 'Rebuild with OFS',
    description:
      'Read one format and write another. Assigning to any field (even $1 = $1) forces awk to rebuild $0 using OFS.',
    body: 'BEGIN { FS = ","; OFS = "\\t" }\n{ $1 = $1; print }',
    tags: ['fields', 'structure'],
  },
  {
    name: 'If / else',
    description: 'Standard conditional. Works anywhere you can write an action.',
    body: '{\n  if ($1 == "value") {\n    \n  } else {\n    \n  }\n}',
    tags: ['structure'],
  },
  {
    name: 'While loop',
    description: 'Pre-test loop. Condition is checked before each iteration.',
    body: '{\n  i = 1\n  while (i <= NF) {\n    \n    i++\n  }\n}',
    tags: ['loop'],
  },
  {
    name: 'Do / while loop',
    description:
      'Post-test loop. Body runs at least once; condition is checked at the end of each iteration.',
    body: '{\n  i = 1\n  do {\n    \n    i++\n  } while (i <= NF)\n}',
    tags: ['loop'],
  },
  {
    name: 'For loop (C-style)',
    description:
      'Counted loop with init, condition, and increment \u2014 useful for iterating fields or a numeric range.',
    body: '{\n  for (i = 0; i < NF; i++) {\n    \n  }\n}',
    tags: ['loop'],
  },
  {
    name: 'For each (array)',
    description:
      'Iterate the keys of an associative array. Traversal order is unspecified (unless you set PROCINFO["sorted_in"] in gawk).',
    body: '{\n  # populate arr, e.g. arr[$1] = $2\n}\nEND {\n  for (k in arr) {\n    print k, arr[k]\n  }\n}',
    tags: ['array', 'loop'],
  },
  {
    name: 'Accumulator (sum $1)',
    description: 'Sum the first field across all records and print the total when input ends.',
    body: '{ total += $1 }\nEND { print total }',
    tags: ['idiom'],
  },
  {
    name: 'Count by field',
    description:
      'Build a histogram of the first field and print counts with their values right-aligned.',
    body: '{ count[$1]++ }\nEND { for (k in count) printf "%5d  %s\\n", count[k], k }',
    tags: ['array', 'idiom'],
  },
  {
    name: 'Group values by key',
    description:
      'Collect $2 values grouped by $1 into a comma-separated list. Demonstrates string concatenation with a conditional separator.',
    body: '{ groups[$1] = groups[$1] (groups[$1] ? "," : "") $2 }\nEND { for (k in groups) print k, groups[k] }',
    tags: ['array', 'idiom', 'string'],
  },
  {
    name: 'Split and iterate',
    description:
      'Break each line into parts on a delimiter (here comma) into array a, then loop over the parts.',
    body: '{\n  n = split($0, a, ",")\n  for (i = 1; i <= n; i++) print a[i]\n}',
    tags: ['array', 'loop', 'string'],
  },
  {
    name: 'Substitute (gsub)',
    description:
      'Replace all matches of a regex in the current record. Use sub() instead to replace only the first match.',
    body: '{ gsub(/pattern/, "replacement"); print }',
    tags: ['string'],
  },
  {
    name: 'Substring',
    description:
      'Extract a fixed substring. substr(s, start [, length]) \u2014 positions are 1-indexed.',
    body: '{ print substr($0, 1, 10) }',
    tags: ['string'],
  },
  {
    name: 'printf formatted',
    description:
      'Produce fixed-width columns. %-20s left-pads a string to 20 chars; %5d right-aligns a number in 5.',
    body: '{ printf "%-20s %5d\\n", $1, $2 }',
    tags: ['string'],
  },
  {
    name: 'Length of line/field',
    description: 'Report character lengths. length() with no argument gives the length of $0.',
    body: '{ print length($0), length($1) }',
    tags: ['string'],
  },
  {
    name: 'Paragraph mode (RS="")',
    description:
      'Set RS to empty string and awk treats paragraphs (blank-line separated) as single records. Newlines within a paragraph become field separators.',
    body: 'BEGIN { RS = "" }\n{\n  # $0 is a whole paragraph; fields are the individual lines/words\n}',
    tags: ['structure'],
  },
  {
    name: 'Tail (last N lines)',
    description:
      'Mimic tail -n using a ring buffer. Stores the last N records and prints them from the END block.',
    body: 'BEGIN { n = 10 }\n{ buf[NR % n] = $0 }\nEND {\n  start = (NR > n ? NR - n : 0)\n  for (i = start + 1; i <= NR; i++) print buf[i % n]\n}',
    tags: ['array', 'idiom'],
  },
  {
    name: 'Two-way Pipe (sort demo)',
    description:
      'Demo: awk coprocess via |&. Feeds lines into sort and reads them back. Adapt by swapping the hard-coded command and input lines for your own data source.',
    body:
      '# |& is bidirectional: print TO cmd and getline FROM cmd share the SAME child.\n\n# (Plain `print | cmd` and `cmd | getline` spawn two separate children that\n# can\'t see each other\'s data — that\'s why |& exists.)\n\nBEGIN {\n  cmd = "sort"\n  \n  # |& writes to sort\'s stdin\n  print "charlie" |& cmd \n  print "alpha" |& cmd\n  print "bravo" |& cmd\n  \n  # close write-side only → sort sees EOF and can finally emit output. \n  # Sort buffers everything until EOF because it must see all lines before\n  # it knows which is smallest. Without this, the getline below hangs forever.\n  close(cmd, "to")\n  \n  # read sort\'s stdout\n  while ((cmd |& getline line) > 0) {\n    print line \n  }\n\n  # close read-side and reap the child\n  close(cmd) \n}\n\n# Try swapping `sort` for `tr a-z A-Z` — it streams line-by-line, so the\n# close(cmd, "to") becomes unnecessary. Commands that aggregate (sort,\n# column, wc) are exactly the ones that need it.',
    tags: ['idiom'],
  },
  {
    name: 'Print fields 2..NF',
    description:
      'Drop the first field from each line. Useful for stripping a leading prefix column while keeping everything else intact.',
    body: '{\n  for (i = 2; i <= NF; i++) printf "%s%s", $i, (i < NF ? OFS : RS)\n}',
    tags: ['fields', 'loop'],
  },
  {
    name: 'Run only once (exit)',
    description:
      'Act on the first record and stop reading immediately. exit jumps to END (or terminates if there is none).',
    body: 'NR == 1 {\n  # do something with the first line\n  print $0\n  exit\n}',
    tags: ['filter', 'idiom'],
  },
  {
    name: 'trim(s) helper',
    description:
      'Reusable function that strips leading and trailing whitespace (spaces and tabs) from a string and returns the trimmed copy. Handy when parsing with FIELDWIDTHS or any fixed-width input where fields arrive padded.',
    body: 'function trim(s) { sub(/^ +/, "", s); sub(/ +$/, "", s); return s }',
    tags: ['function', 'string'],
  },
];
