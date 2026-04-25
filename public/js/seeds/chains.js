// @ts-check
// Seed chains shipped with a fresh install. Edit this file to change the
// default chain library that populates on first run.
//
// Steps reference seed snippets by `seedId` rather than `snippetId`: the
// real snippet ids are generated at seed time (see state.js > seedChains),
// so `snippetId` refs would go stale across installs. `seedChains` resolves
// each `seedId` to the uid assigned during `seedSnippets`.
//
// Tag convention:
//   - `preset`      — chain is a pre-configured wrapper that feeds specific
//                     args (via chain-level `vars`) to a generic Run Command
//                     snippet. All the "named shell recipes" below carry it.
//   - `cmd`         — every step in the chain invokes a Run Command snippet
//                     (`run-cmd-stdin` or `run-cmd-nostdin`). A superset of
//                     `preset`; set by hand on each qualifying chain so the
//                     filter works even for chains that don't use chain-vars.
//   - `single-step` — the chain has exactly one step.
//   - Pure-awk composition chains (e.g. Clean & normalize, Bold + uppercase
//     shout) intentionally omit `preset` — they demonstrate snippet
//     composition without any shell wiring.

/**
 * @typedef {import('../types.js').Chain} Chain
 * @typedef {import('../types.js').Param} Param
 * @typedef {import('../types.js').Test} Test
 * @typedef {{ seedId?: string, program?: string, name?: string, params?: Param[] }} SeedChainStep
 * @typedef {Omit<Chain, 'id' | 'steps' | 'tests'> & {
 *   steps: SeedChainStep[],
 *   tests?: Omit<Test, 'id'>[],
 * }} SeedChain
 */

/** @type {SeedChain[]} */
export const SEED_CHAINS = [
  // ---------- case / shell preset ----------
  {
    name: 'tr - uppercase',
    description:
      'Uppercase input by shelling out to tr. Demonstrates parameterizing the generic Run Command snippet via chain-level vars.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['case', 'cmd', 'preset', 'single-step', 'system'],
    vars: { cmd: "tr '[a-z]' '[A-Z]'" },
    tests: [
      {
        name: 'Uppercases input',
        input: 'hello world',
        expected: 'HELLO WORLD',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'tr - lowercase',
    description: 'Lowercase input by shelling out to tr.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['case', 'cmd', 'preset', 'single-step', 'system'],
    vars: { cmd: "tr '[A-Z]' '[a-z]'" },
    tests: [
      {
        name: 'Lowercases input',
        input: 'HELLO WORLD',
        expected: 'hello world',
        trimTrailingNewline: true,
      },
    ],
  },

  // ---------- json ----------
  {
    name: 'Pretty JSON',
    description: 'Format minified JSON for human reading via jq.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'json', 'preset', 'single-step', 'system'],
    vars: { cmd: 'jq .' },
    tests: [
      {
        name: 'Indents JSON object (preserves key order)',
        input: '{"b":2,"a":1}',
        expected: '{\n  "b": 2,\n  "a": 1\n}',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Minify JSON',
    description: 'Collapse JSON to a single line via jq -c.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'json', 'preset', 'single-step', 'system'],
    vars: { cmd: 'jq -c .' },
    tests: [
      {
        name: 'Collapses to one line',
        input: '{\n  "a": 1,\n  "b": 2\n}',
        expected: '{"a":1,"b":2}',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Sort JSON keys',
    description: 'Recursively sort JSON keys alphabetically via jq -S — invaluable for diffing API responses.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'json', 'preset', 'single-step', 'system'],
    vars: { cmd: 'jq -S .' },
    tests: [
      {
        name: 'Sorts keys alphabetically',
        input: '{"b":2,"a":1}',
        expected: '{\n  "a": 1,\n  "b": 2\n}',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'JSON → Markdown table',
    description:
      'Convert a JSON array of uniform objects into a Markdown table. Keys come from the first object; values are stringified.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'json', 'markdown', 'preset', 'single-step', 'system'],
    vars: {
      cmd: 'jq -r \'def row(x): "| " + (x | join(" | ")) + " |"; (.[0] | keys_unsorted) as $k | row($k), row($k | map("---")), (.[] | row([.[ $k[] ]] | map(tostring)))\'',
    },
    tests: [
      {
        name: 'Builds a markdown table from uniform objects',
        input: '[{"a":1,"b":2},{"a":3,"b":4}]',
        expected: '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
        trimTrailingNewline: true,
      },
    ],
  },

  // ---------- net ----------
  {
    name: 'Fetch URL',
    description:
      'Feed one or more URLs (one per line); emit each response body. Building block for the other net chains. Requires curl.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'net', 'preset', 'single-step', 'system'],
    vars: { cmd: 'xargs -L1 curl -s' },
  },
  {
    name: 'Fetch + pretty-print JSON',
    description: 'Feed a JSON endpoint URL; fetch via curl and pretty-print via jq.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'json', 'net', 'preset', 'single-step', 'system'],
    vars: { cmd: 'xargs -L1 curl -s | jq .' },
  },
  {
    name: 'My public IP',
    description:
      'Insert your current public IP at the cursor (queries api.ipify.org, no input needed). Good candidate for an Insert-at-cursor shortcut.',
    steps: [{ seedId: 'run-cmd-nostdin' }],
    tags: ['cmd', 'content', 'net', 'preset', 'single-step', 'system'],
    vars: { cmd: 'curl -s https://api.ipify.org' },
  },
  {
    name: 'Weather now',
    description: 'Feed a city name; get a one-line current forecast from wttr.in.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'net', 'preset', 'single-step', 'system'],
    vars: { cmd: "xargs -I{} curl -s 'wttr.in/{}?format=3'" },
  },
  {
    name: 'URL status check',
    description:
      'Feed URLs (one per line); print HTTP status code and final effective URL per line. Sequential — slow for large lists.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'net', 'preset', 'single-step', 'system'],
    vars: {
      cmd: "xargs -L1 curl -s -o /dev/null -w '%{http_code} %{url_effective}\\n'",
    },
  },
  {
    name: 'GitHub repo info',
    description:
      'Feed "owner/repo" lines; get name, stars, forks, and description as a JSON array — feedable into Pretty JSON, Minify JSON, Sort JSON keys, or JSON → Markdown table. Unauthenticated GitHub API — subject to rate limits.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'json', 'net', 'preset', 'single-step', 'system'],
    vars: {
      // `jq -s` slurps the per-repo objects that xargs-curl emits back-to-back
      // into one array; `map(...)` then projects each element's fields.
      cmd: "xargs -I{} curl -s https://api.github.com/repos/{} | jq -s 'map({name, stars: .stargazers_count, forks: .forks_count, description})'",
    },
  },

  // ---------- order / filter ----------
  {
    name: 'Sort and dedupe',
    description: 'Sort lines alphabetically and drop duplicates via sort -u.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'filter', 'order', 'preset', 'single-step', 'system'],
    vars: { cmd: 'sort -u' },
    tests: [
      {
        name: 'Sorts and dedupes',
        input: 'b\na\nc\na\nb',
        expected: 'a\nb\nc',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Top lines by frequency',
    description:
      'Count each line and list the most common first. Classic log-triage pipeline: sort | uniq -c | sort -nr.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'math', 'order', 'preset', 'single-step', 'system'],
    vars: { cmd: 'sort | uniq -c | sort -nr' },
  },
  {
    name: 'Word frequency',
    description:
      'Tokenize input on whitespace, then rank each distinct word by frequency. The quintessential Unix teaching pipeline.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'math', 'order', 'preset', 'single-step', 'system'],
    vars: { cmd: "tr -s ' \\t' '\\n' | sort | uniq -c | sort -nr" },
  },
  {
    name: 'Clean & normalize',
    description:
      'Normalize whitespace within each line (trims edges and collapses internal runs via `$1=$1`), then join consecutive non-blank lines into single-line paragraphs, and finally collapse any run of blank lines so exactly one blank line separates each paragraph. Pure-awk chain composing three existing snippets — no shell dependency.',
    steps: [
      { seedId: 'remove-whitespace-rebuild' },
      { seedId: 'join-consecutive-lines' },
      { seedId: 'collapse-blank-runs' },
    ],
    tags: ['format', 'whitespace'],
    tests: [
      {
        name: 'Normalizes whitespace and joins paragraph lines',
        input: '  hello   world  \n\n  foo\n  bar  ',
        expected: 'hello world\n\nfoo bar',
        trimTrailingNewline: true,
      },
      {
        name: 'Collapses multi-blank paragraph gaps to a single blank line',
        input: 'hello   world\n\n\n\nfoo  bar',
        expected: 'hello world\n\nfoo bar',
        trimTrailingNewline: true,
      },
    ],
  },

  // ---------- encode ----------
  {
    name: 'Base64 encode',
    description: 'Encode input as base64.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'encode', 'preset', 'single-step', 'system'],
    vars: { cmd: 'base64' },
    tests: [
      {
        name: 'Encodes "hello" (including the trailing newline awk appends)',
        input: 'hello',
        expected: 'aGVsbG8K',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Base64 decode',
    description:
      'Decode base64 input. On older BSD base64 (macOS pre-11), swap `-d` for `-D` in the cmd var.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'encode', 'preset', 'single-step', 'system'],
    vars: { cmd: 'base64 -d' },
    tests: [
      {
        name: 'Decodes "aGVsbG8K" back to "hello"',
        input: 'aGVsbG8K',
        expected: 'hello',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'URL-encode',
    description: 'Percent-encode input per line via jq @uri.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'encode', 'preset', 'single-step', 'system'],
    vars: { cmd: 'jq -Rr @uri' },
    tests: [
      {
        name: 'Encodes spaces and punctuation',
        input: 'hello world & friends',
        expected: 'hello%20world%20%26%20friends',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'SHA-256 hash',
    description:
      'SHA-256 hex digest of input. Mixes a shell command with an awk snippet — the first step runs sha256sum, the second keeps only the hash column (sha256sum suffixes "  -" on stdin input, which we strip).',
    steps: [{ seedId: 'run-cmd-stdin' }, { seedId: 'keep-first-n-fields' }],
    tags: ['encode', 'preset', 'system'],
    vars: { cmd: 'sha256sum', n: '1' },
  },
  {
    name: 'ROT13',
    description: 'Rotate each letter by 13 positions via tr.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'encode', 'preset', 'single-step', 'system'],
    vars: { cmd: "tr 'A-Za-z' 'N-ZA-Mn-za-m'" },
    tests: [
      {
        name: 'Rotates letters, preserves punctuation',
        input: 'Hello, World!',
        expected: 'Uryyb, Jbeyq!',
        trimTrailingNewline: true,
      },
    ],
  },

  // ---------- format ----------
  {
    name: 'Align columns',
    description: 'Pretty-print whitespace-separated tables via column -t.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'format', 'preset', 'single-step', 'system'],
    vars: { cmd: 'column -t' },
  },
  {
    name: 'Wrap at 80 columns',
    description: 'Reflow prose to 80-column lines via fmt.',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'format', 'preset', 'single-step', 'system'],
    vars: { cmd: 'fmt -w 80' },
  },
  {
    name: 'Markdown task list',
    description: 'Turn each line into an unchecked markdown task ("- [ ] ...").',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'format', 'markdown', 'preset', 'single-step', 'system'],
    vars: { cmd: "sed 's/^/- [ ] /'" },
    tests: [
      {
        name: 'Prepends - [ ] to each line',
        input: 'buy milk\nwrite docs',
        expected: '- [ ] buy milk\n- [ ] write docs',
        trimTrailingNewline: true,
      },
    ],
  },
  {
    name: 'Line / word / char count',
    description: 'Print a one-liner summary of input: line count, word count, character count (wc -lwc).',
    steps: [{ seedId: 'run-cmd-stdin' }],
    tags: ['cmd', 'math', 'preset', 'single-step', 'system'],
    vars: { cmd: 'wc -lwc' },
  },
  {
    name: 'Bold + uppercase shout',
    description:
      'Uppercase a single-line selection, then wrap it in Markdown bold. Pure-awk chain — intended for inline selections (multi-line input collapses because the Bold snippet sets ORS="").',
    steps: [{ seedId: 'uppercase' }, { seedId: 'bold-inline' }],
    tags: ['case', 'markdown'],
    tests: [
      {
        name: 'Uppercases and bolds a single line',
        input: 'hello world',
        expected: '**HELLO WORLD**',
        trimTrailingNewline: true,
      },
    ],
  },

  // ---------- content (generative, no stdin) ----------
  {
    name: 'Insert ISO timestamp (UTC)',
    description:
      'Insert the current UTC timestamp in ISO 8601 Z form. Portable across macOS and Linux.',
    steps: [{ seedId: 'run-cmd-nostdin' }],
    tags: ['cmd', 'content', 'preset', 'single-step', 'system'],
    vars: { cmd: 'date -u +%Y-%m-%dT%H:%M:%SZ' },
  },
  {
    name: 'Insert UUID',
    description:
      'Insert a random UUID. Requires `uuidgen` — usually present on macOS; on Linux install `util-linux` or `uuid-runtime`.',
    steps: [{ seedId: 'run-cmd-nostdin' }],
    tags: ['cmd', 'content', 'preset', 'single-step', 'system'],
    vars: { cmd: 'uuidgen' },
  },
  {
    name: 'Random password (24 chars)',
    description: 'Generate a 24-character base64-encoded random password via openssl.',
    steps: [{ seedId: 'run-cmd-nostdin' }],
    tags: ['cmd', 'content', 'preset', 'single-step', 'system'],
    vars: { cmd: 'openssl rand -base64 24' },
  },

  // ---------- JSON pipelines ----------
  {
    name: 'JSON to Table',
    description:
      'Render a JSON array as an aligned table. Step 1 explodes the array to JSON-lines via jq; step 2 pipes those through jq + `column -t` to align columns. The chain is offered as a clone suggestion when the snippet / inline-step / palette "Detect FS" button sees input that parses as a JSON array of objects.',
    steps: [{ seedId: 'json-to-jsonl' }, { seedId: 'jsonl-to-table' }],
    tags: ['content', 'json', 'system'],
  },
];
