// @ts-check
// Pure data constants, runtime defaults, and awk-language reference.
// Seed snippets and templates live in ./seeds/ so they can be edited
// independently of the app logic and its constants.

/**
 * Single source of truth for every localStorage key the app touches.
 * Group by concern; prefix every key with `awk-estra-` to avoid
 * colliding with other apps on the same origin. The `LIBRARY` key carries a
 * schema version (`-v1`) so a future format migration can be detected by a
 * fresh key name instead of parsing the payload.
 */
export const LS_KEYS = Object.freeze({
  LIBRARY: 'awk-estra-v1',
  SETTINGS: 'awk-estra-settings',
  SIDEBAR_WIDTH: 'awk-estra-sidebar-width',
  PIPELINE_COLLAPSED: 'awk-estra-pipeline-collapsed',
  SIDEBAR_HIDDEN: 'awk-estra-sidebar-hidden',
  REF_HIDDEN: 'awk-estra-ref-hidden',
  REF_SIZE: 'awk-estra-ref-size',
  REF_SECTIONS_OPEN: 'awk-estra-ref-sections-open',
  SNIPPET_DLG_SIZE: 'awk-estra-snippet-dlg-size',
  TEMPLATE_DLG_SIZE: 'awk-estra-template-dlg-size',
  CHAIN_DLG_SIZE: 'awk-estra-chain-dlg-size',
  INLINE_STEP_DLG_SIZE: 'awk-estra-inline-step-dlg-size',
  COLUMNS_DLG_SIZE: 'awk-estra-columns-dlg-size',
  FPAT_DLG_SIZE: 'awk-estra-fpat-dlg-size',
  STRFTIME_DLG_SIZE: 'awk-estra-strftime-dlg-size',
  INLINE_STEP_PREVIEW_ON: 'awk-estra-inline-step-preview-on',
  CHAIN_PREVIEW_ON: 'awk-estra-chain-preview-on',
  SNIPPET_PREVIEW_ON: 'awk-estra-snippet-preview-on',
  PALETTE_SIZE: 'awk-estra-palette-size',
  PALETTE_REF_SHOWN: 'awk-estra-palette-ref-shown',
  PALETTE_PIPELINE: 'awk-estra-palette-pipeline',
  PALETTE_ADVANCED: 'awk-estra-palette-advanced',
  WELCOME_SEEN: 'awk-estra-welcome-seen',
  PALETTE_HISTORY: 'awk-estra-palette-history',
  PALETTE_TAG_FILTER: 'awk-estra-palette-tag-filter',
  SIDEBAR_SEARCH_SCOPE: 'awk-estra-sidebar-search-scope',
  /** @param {string} key section identifier (e.g. 'snippets') */
  sectionCollapsed: (key) => `awk-estra-section-${key}`,
  /** @param {string} key palette section id (e.g. 'snippets', 'templates', 'history') */
  paletteSectionExpanded: (key) => `awk-estra-palette-section-expanded-${key}`,
  /** @param {string} tag normalized tag name (or '__favorites' / '__untagged') */
  tagSectionCollapsed: (tag) => `awk-estra-tag-section-${tag}`,
  /** @param {string} key section identifier (e.g. 'snippets') */
  sortMode: (key) => `awk-estra-sort-mode-${key}`,
  /** @param {'templates'|'snippets'} kind which scope toggle in the snippet editor's picker */
  snippetPickerScope: (kind) => `awk-estra-snippet-picker-scope-${kind}`,
  /** @param {'templates'|'snippets'} kind which scope toggle in the command palette's library */
  paletteLibraryScope: (kind) => `awk-estra-palette-library-scope-${kind}`,
});

// Back-compat exports used by existing modules.
export const LS_KEY = LS_KEYS.LIBRARY;
export const SETTINGS_KEY = LS_KEYS.SETTINGS;
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * POSIX-standard awk keywords, builtins, and special variables — always
 * highlighted regardless of the gawk-extensions setting, because they
 * run under every awk implementation (gawk, mawk, one-true-awk).
 */
const POSIX_KEYWORDS = [
  'BEGIN',
  'END',
  'if',
  'else',
  'while',
  'for',
  'do',
  'break',
  'continue',
  'next',
  'exit',
  'return',
  'function',
  'in',
  'delete',
  'getline',
  'print',
  'printf',
];
const POSIX_BUILTINS = [
  'length',
  'split',
  'sub',
  'gsub',
  'match',
  'sprintf',
  'substr',
  'index',
  'toupper',
  'tolower',
  'int',
  'sqrt',
  'exp',
  'log',
  'sin',
  'cos',
  'atan2',
  'rand',
  'srand',
  'system',
  'fflush',
  'close',
];
const POSIX_VARS = [
  'NR',
  'NF',
  'FS',
  'OFS',
  'ORS',
  'RS',
  'FILENAME',
  'FNR',
  'RSTART',
  'RLENGTH',
  'SUBSEP',
  'ENVIRON',
  'ARGV',
  'ARGC',
  'CONVFMT',
  'OFMT',
];

/**
 * gawk extensions — highlighted when `settings.ui.highlightGawkExtensions`
 * is on (default). Covers the non-POSIX control-flow keywords, the
 * time / sort / regex-substitution / bitwise / boolean builtins, and
 * every common gawk-only special variable. `@`-prefixed lexer
 * directives (`@include`, `@load`, `@namespace`) still need tokenizer
 * support and aren't handled here — see README.md.
 */
const GAWK_KEYWORDS = ['func', 'nextfile', 'switch', 'case', 'default'];
const GAWK_BUILTINS = [
  'systime',
  'strftime',
  'mktime',
  'gensub',
  'asort',
  'asorti',
  'patsplit',
  'isarray',
  'typeof',
  // Bitwise ops — called as functions: `and(x, y)`, `lshift(x, n)`, etc.
  'compl',
  'and',
  'or',
  'xor',
  'lshift',
  'rshift',
  // gawk 5.2+ boolean coercion.
  'mkbool',
];
const GAWK_VARS = [
  'PROCINFO',
  'FIELDWIDTHS',
  'FPAT',
  'IGNORECASE',
  'RT',
  'ERRNO',
  'ARGIND',
  'LINT',
  'TEXTDOMAIN',
  'SYMTAB',
  'FUNCTAB',
  'BINMODE',
];

/**
 * Live vocabulary sets consumed by the tokenizer / highlighter
 * (`awk.js`) and the `-v` candidate detector. `rebuildAwkVocabulary`
 * mutates them in place so downstream code doesn't need to re-import
 * when the setting changes — `AWK_KEYWORDS.has(x)` reads current state.
 *
 * Initial contents include gawk extensions so highlighting works even
 * before the first `applySettings` call (e.g. if a module reads one of
 * these sets during early bootstrap). `settings.js#applySettings` calls
 * `rebuildAwkVocabulary` on every save, keeping the sets in sync with
 * the current setting value.
 */
export const AWK_KEYWORDS = new Set([...POSIX_KEYWORDS, ...GAWK_KEYWORDS]);
export const AWK_BUILTINS = new Set([...POSIX_BUILTINS, ...GAWK_BUILTINS]);
export const AWK_VARS = new Set([...POSIX_VARS, ...GAWK_VARS]);

/**
 * Repopulate the live vocabulary sets in place. When `includeGawk` is
 * true, gawk extensions are added alongside POSIX; when false, only
 * POSIX entries remain — so choosing `mawk` / `awk` as the binary (or
 * disabling the setting explicitly) stops painting unsupported tokens
 * as if they were standard.
 *
 * @param {boolean} includeGawk
 */
export function rebuildAwkVocabulary(includeGawk) {
  const repopulate = (target, base, extra) => {
    target.clear();
    for (const k of base) target.add(k);
    if (includeGawk) for (const k of extra) target.add(k);
  };
  repopulate(AWK_KEYWORDS, POSIX_KEYWORDS, GAWK_KEYWORDS);
  repopulate(AWK_BUILTINS, POSIX_BUILTINS, GAWK_BUILTINS);
  repopulate(AWK_VARS, POSIX_VARS, GAWK_VARS);
}

/**
 * Built-in FPAT presets. Each entry is a row the user sees in the FPAT
 * picker's preset dropdown (and in Settings → Presets → Field patterns).
 * `pattern` is the literal regex (suitable for `new RegExp(pattern, 'g')`);
 * the picker's splice path runs it through `awkStringEscape` to produce
 * the awk source. The CSV presets use the JS-friendly `"…"|[^,]+` shape
 * rather than the canonical `([^,]*)|("[^"]*")` because JS regex
 * alternation is greedy-first (no longest-match), so the canonical form
 * mis-splits quoted fields in the live preview. Trade-off: empty CSV
 * fields between consecutive commas are dropped — called out in the
 * description.
 *
 * These are the defaults seeded into `settings.presets.fpat`. Users can
 * edit, add, or delete rows in Settings; the picker reads the current
 * list from `settings` at open time. The `custom` sentinel row the
 * picker shows at the bottom is synthesized in dialogs.js — it's UI
 * state meaning "typing freeform", not a stored preset.
 *
 * @type {{ id: string, label: string, pattern: string, description: string }[]}
 */
export const DEFAULT_FPAT_PRESETS = [
  {
    id: 'csv',
    label: 'CSV (quoted fields)',
    pattern: '"[^"]*"|[^,]+',
    description:
      'Each field is a double-quoted string or a non-empty comma-free run. Handles commas inside quoted fields. Note: empty fields between consecutive commas are dropped.',
  },
  {
    id: 'csv-escaped',
    label: 'CSV (RFC 4180, escaped quotes)',
    pattern: '"(?:[^"]|"")*"|[^,]+',
    description:
      'Like CSV (quoted fields) but `""` inside a quoted field is treated as an escaped quote.',
  },
  {
    id: 'bracketed-log',
    label: 'Bracketed log fields',
    pattern: '\\[[^\\]]*\\]|\\S+',
    description:
      'Each field is either a bracketed run like `[INFO]` or a non-whitespace token. Useful for log lines mixing tagged metadata with bare words.',
  },
  {
    id: 'shell-args',
    label: 'Shell-like quoted args',
    pattern: '"[^"]*"|\'[^\']*\'|[^ \\t]+',
    description:
      'Single-quoted, double-quoted, or bare tokens — like splitting a shell command line.',
  },
  {
    id: 'words',
    label: 'Plain word runs',
    pattern: '[^ \\t]+',
    description:
      'Same as awk’s default FS, expressed as FPAT. Mostly here as a baseline.',
  },
];

/**
 * Built-in strftime format presets — defaults for `settings.presets.timestamp`.
 * Same shape as DEFAULT_FPAT_PRESETS. The splice path in dialogs.js runs
 * `pattern` through `awkStringEscape` when emitting `strftime("…")` so
 * backslashes and double-quotes survive. The `custom` sentinel is
 * synthesized by the picker and not stored here.
 *
 * @type {{ id: string, label: string, pattern: string, description: string }[]}
 */
export const DEFAULT_STRFTIME_PRESETS = [
  {
    id: 'iso-date',
    label: 'ISO 8601 date',
    pattern: '%Y-%m-%d',
    description: 'Calendar date only. Sorts lexicographically, which is usually what you want.',
  },
  {
    id: 'iso-datetime',
    label: 'ISO 8601 date + time (local offset)',
    pattern: '%Y-%m-%dT%H:%M:%S%z',
    description:
      'Full ISO 8601 timestamp ending in the local timezone offset (e.g. +0100). Matches most log formats and parses cleanly in every language.',
  },
  {
    id: 'rfc3339',
    label: 'RFC 3339 (human-readable, with offset)',
    pattern: '%Y-%m-%d %H:%M:%S %z',
    description:
      'Space-separated variant of ISO 8601, easier to eyeball at the cost of needing stricter quoting if embedded in CSV.',
  },
  {
    id: 'us-date',
    label: 'US date (MM/DD/YYYY)',
    pattern: '%m/%d/%Y',
    description: 'US-style slash date. Avoid for sorting — day before month.',
  },
  {
    id: 'eu-date',
    label: 'European date (DD-MM-YYYY)',
    pattern: '%d-%m-%Y',
    description: 'European-style dash date. Also avoid for sorting.',
  },
  {
    id: 'time-24',
    label: 'Time, 24-hour',
    pattern: '%H:%M:%S',
    description: 'Zero-padded 24-hour clock.',
  },
  {
    id: 'time-12',
    label: 'Time, 12-hour with AM/PM',
    pattern: '%I:%M:%S %p',
    description: 'Zero-padded 12-hour clock with AM/PM suffix.',
  },
  {
    id: 'long-date',
    label: 'Long date (Weekday, Month D YYYY)',
    pattern: '%A, %B %d %Y',
    description:
      'Full weekday + month name with zero-padded day. Use %e in place of %d for space-padded day.',
  },
  {
    id: 'apache',
    label: 'Apache access log',
    pattern: '%d/%b/%Y:%H:%M:%S %z',
    description:
      'Format used by Apache / nginx access logs (inside the [brackets]). Drop this into a BEGIN to tag every output line with a log-style timestamp.',
  },
  {
    id: 'syslog',
    label: 'Syslog',
    pattern: '%b %e %H:%M:%S',
    description:
      'Traditional syslog timestamp — abbreviated month, space-padded day, 24-hour time. No year.',
  },
  {
    id: 'filename',
    label: 'Filename-safe',
    pattern: '%Y%m%d-%H%M%S',
    description:
      'No separators a filesystem could object to. Sorts lexicographically; good for archiving.',
  },
  {
    id: 'iso-week',
    label: 'ISO week (YYYY-Www)',
    pattern: '%G-W%V',
    description:
      'ISO 8601 week-numbering year (%G, may differ from %Y near year boundaries) and ISO week number (%V, 01–53, Monday-based).',
  },
  {
    id: 'unix-epoch',
    label: 'Unix epoch seconds',
    pattern: '%s',
    description:
      'Seconds since 1970-01-01 UTC. Useful as a machine-readable sort key when you want to avoid timezone ambiguity entirely.',
  },
];

/**
 * Default template for the "Download script" generator. Tokens recognised
 * (see `buildShellScriptFromTemplate` in pipeline.js):
 *
 *   {SCRIPT_NAME}              — sanitized chain name + extension
 *   {AWK_PIPE_CMD}             — `awk '…' | awk '…' | …` (flattened or
 *                                multi-line per settings.scriptExport.flatten)
 *   {VARIABLES_BLOCK}          — shell var assignments + usage hint when
 *                                the chain has params; empty otherwise
 *   {STEP_NAMES_LIST}          — `# step1\n# step2\n…`
 *   {STEP_NAMES_LIST_NUMBERED} — `# 1. step1\n# 2. step2\n…`
 *   {USAGE_EXAMPLE}            — `# ./{SCRIPT_NAME} < INPUT_FILE` (with
 *                                SCRIPT_NAME already expanded)
 *
 * Users can edit this via Settings → Script export → Template, with a
 * per-field Reset that restores this exact string.
 */
export const DEFAULT_SCRIPT_EXPORT_TEMPLATE = `#!/usr/bin/env bash
set -euo pipefail

# Pre-req: chmod u+x {SCRIPT_NAME}

# Usage:
{USAGE_EXAMPLE}

# Variables (if any) — edit these or override from the command line:
#   var_a=... var_b=... ./script < input
{VARIABLES_BLOCK}

# Steps...
{STEP_NAMES_LIST_NUMBERED}

{AWK_PIPE_CMD}
`;

export const DEFAULT_SETTINGS = {
  exec: {
    binary: 'gawk',
    args: [],
    timeoutMs: 5000,
    maxOutputBytes: 1048576,
  },
  editor: {
    tabSize: 4,
    fontSize: 13,
    // Empty string = let CSS's own fallback stack win (SF Mono → Monaco
    // → Consolas → monospace). A non-empty value is written verbatim to
    // `--editor-font-family` and becomes the *first* entry ahead of
    // that stack — so an unavailable chosen font silently cascades
    // through to the original defaults rather than breaking layout.
    fontFamily: '',
    defaultNewTabText: '',
    confirmCloseTabWithContent: true,
    tabMergeSeparator: 'dash',
    confirmClearProgram: false,
    confirmClearHistory: true,
    defaultWordWrap: 'off',
    lineNumbers: false,
    paletteEnterApplies: false,
    // awk's `print` always emits a trailing \n. When true, a single
    // trailing \n is stripped from awk output before it's written to
    // the editor — handy when the input was a line fragment that
    // didn't originally end in a newline. Off by default to preserve
    // awk's native output; users opt in via Settings → Editor.
    // Intermediate pipeline stream + test assertions see raw stdout
    // regardless.
    stripTrailingNewline: false,
  },
  ui: {
    // 'auto' resolves at apply time via `prefers-color-scheme`: dark OS
    // → 'dark', light OS → 'light'. Existing installs that already
    // stored 'dark' / 'light' keep their explicit choice (deepMerge in
    // loadSettings preserves the stored value). Users can pick 'auto'
    // back from the dropdown if they want to opt into OS-follow later.
    theme: 'auto',
    // UI chrome density — scales button padding, sidebar row heights,
    // section-header padding via `body.density-<value>` CSS classes
    // that override a shared set of `--density-*` custom properties.
    // Doesn't touch the editor font-size (that's Editor → Font size).
    density: 'normal',
    defaultSidebarWidth: 260,
    referenceDefaultShown: false,
    paletteDefaultAdvanced: false,
    showRestoreDefaults: false,
    showRunAllTests: true,
    dragToTagMode: 'add',
    // Sidebar sections expanded by default. `true` = section is
    // expanded on first render; `false` = collapsed. Templates is the
    // one section that ships collapsed by default because it's rarely
    // needed day-to-day.
    sectionsExpanded: {
      snippets: true,
      chains: true,
      'text-snippets': true,
      templates: false,
    },
    // Palette list sections expanded by default. Each key is the
    // `<details>` id suffix (see `#palette-section-${key}` in HTML).
    // true = expanded on open, false = collapsed. Mirrors the sidebar
    // `sectionsExpanded` polarity.
    paletteSectionsExpanded: {
      library: true,
      history: true,
    },
    runnerScope: 'both',
    highlightGawkExtensions: true,
    warnGawkOnly: true,
    showGawkButtons: true,
    showFormatButton: true,
    formatReplaceTabs: true,
    formatTabSpaces: 2,
  },
  pipeline: {
    autoPreviewOnStepChange: true,
    onError: 'stop',
    clearOutputsOnSelectionChange: false,
    acceptDefaultsWithoutPrompting: true,
  },
  tests: {
    runOnSave: true,
    showUnknownStatus: false,
  },
  data: {
    saveDebounceMs: 400,
  },
  preview: {
    maxLines: 0,
  },
  safety: {
    requireManualPreview: false,
    autoPreviewSideEffects: false,
    // Regex patterns, matched case-insensitively. Lines starting with `#`
    // are comments, ignored by the matcher. Kept in sync with safety.js >
    // DEFAULT_FORBIDDEN_PATTERNS — update both when changing.
    forbiddenPatterns: [
      '# rm -rf / and variants — any flag order (-rf, -fr, -Rf, --recursive --force) targeting /, ~, $HOME, ${HOME}',
      '# prevents: "rm -rf /", "rm -Rf ~", "rm --recursive --force $HOME"',
      '# still allows: "rm -i /tmp/foo", "rm -rf ./build"',
      '\\brm\\s+(?:-\\S*[rR]\\S*[fF]\\S*|-\\S*[fF]\\S*[rR]\\S*|--(?:recursive|force))[^\\n]*\\s(?:/|~|\\$HOME|\\$\\{HOME\\})',
      '',
      '# sudo rm with any recursive/force flag, any target',
      '# prevents: "sudo rm -rf /tmp", "sudo rm -R /var/log"',
      '# still allows: "sudo rm file.txt"',
      '\\bsudo\\s+rm\\b[^\\n]*-\\S*[rRfF]',
      '',
      '# classic fork bomb — forks copies of itself until the system hangs',
      '# prevents: ":(){ :|:& };:"',
      ':\\s*\\(\\s*\\)\\s*\\{.*:\\s*\\|\\s*:\\s*&.*\\}\\s*;\\s*:',
      '',
      '# mkfs — formats a filesystem, destroying whatever was there',
      '# prevents: "mkfs.ext4 /dev/sda1", "mkfs -t xfs /dev/nvme0n1"',
      '\\bmkfs(?:\\.\\w+|\\s+-t\\b)',
      '',
      '# dd writing to a block device — wipes the disk',
      '# prevents: "dd if=/dev/zero of=/dev/sda", "dd of=/dev/nvme0n1 if=/dev/urandom"',
      '# still allows: "dd if=/dev/zero of=./disk.img" (loopback image)',
      '\\bdd\\b[^\\n]*\\bof=/dev/(?:sd[a-z]|nvme|hd[a-z]|mmcblk|disk\\d)',
      '',
      '# shell redirect overwriting a block device — corrupts the disk',
      '# prevents: "echo garbage > /dev/sda"',
      '# still allows: "echo hi > /dev/null", "echo hi > /dev/stdout"',
      '>\\s*/dev/(?:sd[a-z]|nvme|hd[a-z]|mmcblk)',
      '',
      '# shutdown / reboot / halt / poweroff / kexec',
      '# prevents: "shutdown -h now", "shutdown -r +5", "shutdown -P now"',
      '\\bshutdown\\b[^\\n]*\\s-[hPrk]\\b',
      '',
      '# curl | sh family — fetch-and-execute a remote script (any URL, any flags, optional sudo, any POSIX shell)',
      '# prevents: "curl https://x | sh", "curl -fsSL https://x | bash", "wget -O- https://x | sudo bash"',
      '# still allows: "curl https://x > out", "echo hi | sort"',
      '\\b(?:curl|wget|fetch)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|dash|ksh|ash)\\b',
      '',
      '# shell -c "$(curl …)" — same idea via command substitution',
      '# prevents: `bash -c "$(curl https://x)"`, `sh -c $(wget -O- https://x)`',
      '\\b(?:sh|bash|zsh|dash|ksh)\\s+-c\\s+["\']?\\$\\(\\s*(?:curl|wget|fetch)\\b',
      '',
      '# shell <(curl …) — same idea via process substitution',
      '# prevents: "bash <(curl https://x)", "zsh <( wget -O- https://x )"',
      '\\b(?:sh|bash|zsh)\\s+<\\s*\\(\\s*(?:curl|wget|fetch)\\b',
    ],
    // One test per example listed in the `# prevents:` / `# still allows:`
    // comment lines above each regex. Loss-of-coverage detection: if a
    // future edit to a regex accidentally drops a case, the row here goes
    // red in Settings → Safety → Saved command checks.
    tests: [
      // rm -rf /, ~, $HOME variants
      { id: 'sfty-seed-rm-1', text: 'rm -rf /', expect: 'prevent' },
      { id: 'sfty-seed-rm-2', text: 'rm -Rf ~', expect: 'prevent' },
      {
        id: 'sfty-seed-rm-3',
        text: 'rm --recursive --force $HOME',
        expect: 'prevent',
      },
      { id: 'sfty-seed-rm-4', text: 'rm -i /tmp/foo', expect: 'allow' },
      { id: 'sfty-seed-rm-5', text: 'rm -rf ./build', expect: 'allow' },
      // sudo rm with recursive/force
      { id: 'sfty-seed-sudo-1', text: 'sudo rm -rf /tmp', expect: 'prevent' },
      { id: 'sfty-seed-sudo-2', text: 'sudo rm -R /var/log', expect: 'prevent' },
      { id: 'sfty-seed-sudo-3', text: 'sudo rm file.txt', expect: 'allow' },
      // fork bomb
      { id: 'sfty-seed-fork-1', text: ':(){ :|:& };:', expect: 'prevent' },
      // mkfs
      { id: 'sfty-seed-mkfs-1', text: 'mkfs.ext4 /dev/sda1', expect: 'prevent' },
      { id: 'sfty-seed-mkfs-2', text: 'mkfs -t xfs /dev/nvme0n1', expect: 'prevent' },
      // dd to a block device
      {
        id: 'sfty-seed-dd-1',
        text: 'dd if=/dev/zero of=/dev/sda bs=1M',
        expect: 'prevent',
      },
      {
        id: 'sfty-seed-dd-2',
        text: 'dd of=/dev/nvme0n1 if=/dev/urandom',
        expect: 'prevent',
      },
      {
        id: 'sfty-seed-dd-3',
        text: 'dd if=/dev/zero of=./disk.img bs=1M count=10',
        expect: 'allow',
      },
      // shell redirect to a block device
      { id: 'sfty-seed-redir-1', text: 'echo garbage > /dev/sda', expect: 'prevent' },
      { id: 'sfty-seed-redir-2', text: 'echo hi > /dev/null', expect: 'allow' },
      { id: 'sfty-seed-redir-3', text: 'echo hi > /dev/stdout', expect: 'allow' },
      // shutdown / reboot / halt / poweroff / kexec
      { id: 'sfty-seed-shutdown-1', text: 'shutdown -h now', expect: 'prevent' },
      { id: 'sfty-seed-shutdown-2', text: 'shutdown -r +5', expect: 'prevent' },
      { id: 'sfty-seed-shutdown-3', text: 'shutdown -P now', expect: 'prevent' },
      // curl | sh family
      {
        id: 'sfty-seed-curlsh-1',
        text: 'curl https://x | sh',
        expect: 'prevent',
      },
      {
        id: 'sfty-seed-curlsh-2',
        text: 'curl -fsSL https://x | bash',
        expect: 'prevent',
      },
      {
        id: 'sfty-seed-curlsh-3',
        text: 'wget -O- https://x | sudo bash',
        expect: 'prevent',
      },
      { id: 'sfty-seed-curlsh-4', text: 'curl https://x > out', expect: 'allow' },
      { id: 'sfty-seed-curlsh-5', text: 'echo hi | sort', expect: 'allow' },
      // shell -c "$(curl …)"
      {
        id: 'sfty-seed-shc-1',
        text: 'bash -c "$(curl https://x)"',
        expect: 'prevent',
      },
      {
        id: 'sfty-seed-shc-2',
        text: 'sh -c $(wget -O- https://x)',
        expect: 'prevent',
      },
      // shell <(curl …)
      {
        id: 'sfty-seed-shproc-1',
        text: 'bash <(curl https://x)',
        expect: 'prevent',
      },
      {
        id: 'sfty-seed-shproc-2',
        text: 'zsh <( wget -O- https://x )',
        expect: 'prevent',
      },
    ],
  },
  // User-editable preset lists used by the pickers in dialogs.js. Seeded
  // from DEFAULT_FPAT_PRESETS / DEFAULT_STRFTIME_PRESETS on first load via
  // the deepMerge bootstrap in settings.js — edits made in Settings →
  // Presets persist; per-row "Reset to default" looks the row up by `id`
  // in the defaults above.
  presets: {
    fpat: structuredClone(DEFAULT_FPAT_PRESETS),
    timestamp: structuredClone(DEFAULT_STRFTIME_PRESETS),
  },
  // System shortcut overrides are keyed by action id (see
  // shortcuts.js > SYSTEM_ACTIONS). Default is empty — every action
  // falls through to its built-in combo.
  systemShortcuts: {},
  // Customisation for the "Download script" button in the snippet and
  // chain dialogs. Does NOT affect the per-step / per-pipeline
  // "Copy as shell" buttons — those stay one-line clipboard output.
  scriptExport: {
    flatten: true,
    extension: '.sh',
    template: DEFAULT_SCRIPT_EXPORT_TEMPLATE,
  },
};
export { SEED_SNIPPETS } from './seeds/snippets.js';
export { SEED_CHAINS } from './seeds/chains.js';
export { AWK_TEMPLATES_SEED } from './seeds/templates.js';
export { TEXT_SNIPPETS_SEED } from './seeds/text-snippets.js';

export const AWK_REFERENCE = [
  {
    title: 'Patterns',
    items: [
      '<code>BEGIN { ... }</code> — run once before any input',
      '<code>END { ... }</code> — run once after all input',
      '<code>/regex/ { ... }</code> — lines matching regex',
      '<code>!/regex/ { ... }</code> — lines not matching',
      '<code>expr { ... }</code> — any expression (true = non-zero / non-empty)',
      '<code>expr1, expr2 { ... }</code> — range: first match to second, inclusive',
      '<code>NR==1 { ... }</code> — condition on any expression',
      '<code>p1 &amp;&amp; p2 { ... }</code>, <code>p1 || p2 { ... }</code>, <code>!p { ... }</code> — combine patterns',
    ],
  },
  {
    title: 'Records & fields',
    items: [
      '<code>$0</code> whole record; <code>$1</code>, <code>$2</code>, … fields; <code>$NF</code> last field',
      '<code>NF</code> fields in current record',
      '<code>NR</code> total record number; <code>FNR</code> per-file',
      '<code>FS</code> input field separator (default whitespace; can be regex or single char)',
      '<code>OFS</code> output field separator (default space)',
      '<code>RS</code> input record separator (default newline)',
      '<code>ORS</code> output record separator (default newline)',
      '<code>FILENAME</code> name of the current input file',
      'Assigning to <code>$i</code> or <code>NF</code> rebuilds <code>$0</code> using <code>OFS</code>',
    ],
  },
  {
    title: 'FS vs FIELDWIDTHS vs FPAT',
    items: [
      '<code>FS</code> — use when a single <em>separator</em> character (or regex) cleanly splits every record. Default: whitespace runs. Fast and portable.',
      '<code>FIELDWIDTHS</code> — use when the data is <em>fixed-width columnar</em> and separators would be unreliable. Example: <code>BEGIN { FIELDWIDTHS = "10 3 8 *" }</code> for <code>ls -l</code>-style output. <strong>gawk-only.</strong>',
      '<code>FPAT</code> — use when the <em>fields themselves</em> are easier to describe than the gaps. Classic case: CSV with commas inside <code>"…"</code>. Example: <code>BEGIN { FPAT = "([^,]*)|(\\"[^\\"]*\\")" }</code>. <strong>gawk-only.</strong>',
      'Rule of thumb: reach for <code>FS</code> first; fall back to <code>FIELDWIDTHS</code> for positional data; reach for <code>FPAT</code> when separators appear inside fields. The <em>Detect FS</em>, <em>Fixed Columns…</em>, and <em>Field Pattern…</em> buttons in the snippet / inline-step / palette editors wrap each.',
    ],
  },
  {
    title: 'Other variables',
    items: [
      '<code>ARGC</code>, <code>ARGV[0..ARGC-1]</code> — command-line arguments',
      '<code>ENVIRON["VAR"]</code> — process environment',
      '<code>RSTART</code>, <code>RLENGTH</code> — set by <code>match()</code>',
      '<code>SUBSEP</code> — joiner for multi-dim array subscripts (default <code>"\\034"</code>)',
      '<code>CONVFMT</code> — number→string conversion format (default <code>"%.6g"</code>)',
      '<code>OFMT</code> — format for numbers printed with <code>print</code> (default <code>"%.6g"</code>)',
    ],
  },
  {
    title: 'Operators',
    items: [
      'Arithmetic: <code>+ - * / % ^</code> (<code>^</code> is right-associative)',
      'Unary: <code>+x</code>, <code>-x</code>, <code>!x</code>',
      'Increment / decrement: <code>++x</code>, <code>x++</code>, <code>--x</code>, <code>x--</code>',
      'Assignment: <code>= += -= *= /= %= ^=</code>',
      'Compare: <code>== != &lt; &lt;= &gt; &gt;=</code>',
      'Regex match: <code>s ~ /re/</code>, <code>s !~ /re/</code>',
      'Logical: <code>&amp;&amp;</code> <code>||</code> <code>!</code> (short-circuit)',
      'Ternary: <code>c ? a : b</code>',
      'Concat: adjacent expressions — <code>"x" y</code> → <code>"x" . y</code>',
      'Array membership: <code>key in arr</code>, <code>(i, j) in arr</code>',
      'Field: <code>$expr</code> — evaluates <code>expr</code>, then indexes fields',
    ],
  },
  {
    title: 'Control flow',
    items: [
      '<code>if (c) { ... } else { ... }</code>',
      '<code>while (c) { ... }</code>',
      '<code>do { ... } while (c)</code>',
      '<code>for (i = 0; i &lt; n; i++) { ... }</code>',
      '<code>for (k in arr) { ... }</code> — iterate array keys (unspecified order)',
      '<code>break</code>, <code>continue</code> — inside loops',
      '<code>next</code> — skip to next input record',
      '<code>nextfile</code> — skip to next input file',
      '<code>exit [n]</code> — end program (runs <code>END</code>; <code>n</code> = exit code)',
      '<code>return [expr]</code> — return from a user-defined function',
    ],
  },
  {
    title: 'I/O & redirection',
    items: [
      '<code>print</code> — writes <code>$0 ORS</code> to stdout',
      '<code>print a, b, c</code> — fields joined by <code>OFS</code>, terminated by <code>ORS</code>',
      '<code>printf fmt, ...</code> — formatted; no implicit separator or newline',
      '<code>print ... &gt; "file"</code> — write to file (truncates on first use)',
      '<code>print ... &gt;&gt; "file"</code> — append to file',
      '<code>print ... | "cmd"</code> — pipe output into a shell command',
      '<code>getline</code> — read next record into <code>$0</code>; updates <code>NF</code>, <code>NR</code>, <code>FNR</code>',
      '<code>getline var</code> — next record into <code>var</code>; updates <code>NR</code>, <code>FNR</code>',
      '<code>getline &lt; "file"</code> / <code>getline var &lt; "file"</code> — read from file',
      '<code>"cmd" | getline [var]</code> — read a line from a shell command',
      '<code>close("file" | "cmd")</code> — close file or pipe (needed to reopen / finish)',
      '<code>fflush([f])</code> — flush output; <code>fflush()</code> flushes all',
      '<code>system("cmd")</code> — run shell command; returns its exit status',
    ],
  },
  {
    title: 'printf format specifiers',
    items: [
      '<code>%d</code>, <code>%i</code> — decimal integer',
      '<code>%o</code> octal, <code>%x</code> / <code>%X</code> hex (lower / upper)',
      '<code>%u</code> — unsigned decimal',
      '<code>%c</code> — single character (from number or first char of string)',
      '<code>%s</code> — string',
      '<code>%e</code> / <code>%E</code> — scientific notation',
      '<code>%f</code> — floating point',
      '<code>%g</code> / <code>%G</code> — shortest of <code>%e</code> / <code>%f</code>',
      '<code>%%</code> — literal percent sign',
      'Width / precision: <code>%-10s</code>, <code>%5.2f</code>, <code>%*d</code> (<code>*</code> takes next arg)',
      'Flags: <code>-</code> left-align, <code>0</code> zero-pad, <code>+</code> signed, <code>#</code> alt form',
    ],
  },
  {
    title: 'String functions',
    items: [
      '<code>length(s)</code> — chars in <code>s</code>; <code>length(a)</code> — elements in array',
      '<code>toupper(s)</code>, <code>tolower(s)</code>',
      '<code>substr(s, i [, n])</code> — 1-indexed slice',
      '<code>index(s, t)</code> — 1-based position of <code>t</code> in <code>s</code>, or 0',
      '<code>split(s, arr [, sep])</code> — split into <code>arr</code>; returns field count',
      '<code>sub(re, repl [, target])</code> — replace first match; returns 1 / 0',
      '<code>gsub(re, repl [, target])</code> — replace all; returns count',
      '<code>match(s, re)</code> — position of first match (or 0); sets <code>RSTART</code>, <code>RLENGTH</code>',
      '<code>sprintf(fmt, ...)</code> — like <code>printf</code> but returns the string',
      'In <code>sub</code>/<code>gsub</code> replacement: <code>&amp;</code> = whole match; <code>\\&amp;</code> = literal <code>&amp;</code>',
    ],
  },
  {
    title: 'Numeric functions',
    items: [
      '<code>int(x)</code> — truncate toward zero',
      '<code>sqrt(x)</code>, <code>exp(x)</code>, <code>log(x)</code> (natural log)',
      '<code>sin(x)</code>, <code>cos(x)</code> — radians',
      '<code>atan2(y, x)</code> — result in [-π, π]',
      '<code>rand()</code> — value in [0, 1)',
      '<code>srand([seed])</code> — seed RNG; returns previous seed',
    ],
  },
  {
    title: 'Time functions',
    items: [
      '<code>systime()</code> — seconds since the Unix epoch',
      '<code>strftime([fmt [, ts [, utc]]])</code> — format timestamp (e.g. <code>"%Y-%m-%d"</code>)',
      '<code>mktime("YYYY MM DD HH MM SS [DST]")</code> — parse to epoch seconds',
    ],
  },
  {
    title: 'Arrays',
    items: [
      '<code>arr[key] = value</code> — associative; keys are stringified',
      '<code>arr[key]</code> — access (creates key with empty value if unset — use <code>in</code> first)',
      '<code>key in arr</code> — membership test without creating the key',
      '<code>arr[i, j]</code> — multi-dim; subscripts joined by <code>SUBSEP</code>',
      '<code>(i, j) in arr</code> — multi-dim membership test',
      '<code>delete arr[key]</code> — remove element',
      '<code>delete arr</code> — remove all elements (GNU/BWK extension)',
      '<code>for (k in arr) { ... }</code> — iterate (order unspecified)',
    ],
  },
  {
    title: 'User-defined functions',
    items: [
      '<code>function name(p1, p2, locals) { ... return x }</code>',
      'Extra parameters past those passed by the caller are local variables',
      '(awk has no block scope — this is the idiom for locals)',
      'Arrays are passed by reference; scalars by value',
      'Call a function as soon as it is in scope — forward declarations unneeded',
    ],
  },
  {
    title: 'Regular expressions (ERE)',
    items: [
      '<code>.</code> any char · <code>^</code> start · <code>$</code> end',
      '<code>[abc]</code>, <code>[^abc]</code>, <code>[a-z]</code> — character classes',
      '<code>r*</code> zero+ · <code>r+</code> one+ · <code>r?</code> optional',
      '<code>r1|r2</code> alternation · <code>(r)</code> grouping',
      '<code>\\d</code> / <code>\\w</code> are NOT standard — use <code>[0-9]</code> / <code>[A-Za-z0-9_]</code>',
      'Match on field: <code>$1 ~ /^foo/</code> · on record: just <code>/^foo/</code>',
    ],
  },
];
