// @ts-check
// Safety analysis for awk programs. Two jobs:
//
//   1. `findSideEffects(program)` — static scan for constructs that can
//      touch the outside world (system(), pipes, getline, `>` redirects).
//      Used to gate *auto-preview*: if a program has side effects, we
//      don't run it on every keystroke — the user must click a manual
//      "Run preview" button.
//
//      The scan tokenizes via awk.js so `|` inside a regex literal
//      (`/a|b/`) or a string (`"a | b"`) is NOT treated as a pipe.
//      Without that, every awk program using regex alternation would
//      require a manual preview click — unacceptable UX.
//
//   2. `findForbiddenMatches(program, vars, patterns)` — regex search
//      (case-insensitive) against both the awk source and any var values
//      passed in. Used as a hard *block* at execution time (see awk.js >
//      runAwk). This is a speed-bump against pasted / half-typed destructive
//      commands like `rm -rf /`, not a security boundary — a determined
//      author can bypass by string concatenation. Patterns are regex so a
//      single entry can cover flag-order and URL variants (e.g. one rule
//      for all `curl … | sh` shapes). Invalid regex entries are skipped
//      with a console warning; they do not block execution on their own.
//      Lines starting with `#` are treated as comments and ignored —
//      users can annotate their own lists the same way the defaults are
//      annotated.

import { tokenizeAwk } from './awk.js';

/**
 * Default forbidden-pattern list seeded into Settings → Safety on first
 * run. Each entry is a JavaScript regex source (matched case-insensitively
 * via `new RegExp(entry, 'i')`); if any pattern matches the awk source or
 * the value of any variable passed to runAwk, execution is blocked. Users
 * can edit the list (or clear it) in settings.
 *
 * The goal is to catch common destructive shapes with flag-order and URL
 * variants covered in a single rule. False positives are preferable to
 * false negatives here — users can remove entries they don't want.
 *
 * This list is duplicated in data.js > DEFAULT_SETTINGS.safety.
 * forbiddenPatterns and must be kept in sync with it.
 */
export const DEFAULT_FORBIDDEN_PATTERNS = [
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
];

/**
 * Scan an awk program for constructs that can have side effects. Returns
 * the human-readable labels of each kind detected (de-duplicated). Empty
 * array means the program is safe to auto-preview.
 *
 * Walks the tokenized source so `|` inside a regex literal or string
 * doesn't count as a pipe — that turned out to be the dominant false
 * positive in typical awk programs.
 *
 * @param {string} program
 * @returns {string[]}
 */
export function findSideEffects(program) {
  if (!program) return [];
  const tokens = tokenizeAwk(program);
  /** @type {Set<string>} */
  const hits = new Set();
  // Track whether the current statement has seen `print`/`printf` so a
  // subsequent `>` punct can be recognised as a file redirect (versus a
  // comparison like `if (a > b)`).
  let seenPrintInStmt = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'regex' || tok.t === 'string' || tok.t === 'comment') continue;
    if (tok.t === 'ws') {
      if (tok.s.includes('\n')) seenPrintInStmt = false;
      continue;
    }
    if (tok.t === 'keyword' || tok.t === 'ident' || tok.t === 'builtin') {
      if (tok.s === 'getline') {
        hits.add('getline (reads files or commands)');
      } else if (tok.s === 'system') {
        // Look ahead past ws for '(' to confirm it's the function call.
        let j = i + 1;
        while (j < tokens.length && tokens[j].t === 'ws') j++;
        if (j < tokens.length && tokens[j].t === 'punct' && tokens[j].s === '(') {
          hits.add('system() call');
        }
      } else if (tok.s === 'print' || tok.s === 'printf') {
        seenPrintInStmt = true;
      }
      continue;
    }
    if (tok.t === 'punct') {
      if (tok.s === '|') {
        // `||` is logical-or — two adjacent `|` puncts, neither a pipe.
        const nextIsPipe =
          i + 1 < tokens.length && tokens[i + 1].t === 'punct' && tokens[i + 1].s === '|';
        const prevIsPipe =
          i > 0 && tokens[i - 1].t === 'punct' && tokens[i - 1].s === '|';
        if (nextIsPipe || prevIsPipe) continue;
        // `|&` is coprocess; plain `|` is regular pipe.
        const nextIsAmp =
          i + 1 < tokens.length && tokens[i + 1].t === 'punct' && tokens[i + 1].s === '&';
        hits.add(nextIsAmp ? '|& coprocess pipe' : 'pipe to command');
      } else if (tok.s === '>' && seenPrintInStmt) {
        hits.add('output redirect (> or >>)');
      } else if (tok.s === ';' || tok.s === '{' || tok.s === '}') {
        seenPrintInStmt = false;
      }
    }
  }
  return [...hits];
}

/**
 * Aggregate side-effect scan across an ordered list of program strings —
 * useful for chains / pipelines where any step's side effect defeats the
 * auto-preview.
 *
 * @param {string[]} programs
 * @returns {string[]}
 */
export function findSideEffectsAcross(programs) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const p of programs) {
    for (const label of findSideEffects(p)) seen.add(label);
  }
  return [...seen];
}

/**
 * Look for forbidden regex matches in the awk program and in any variable
 * values that would be passed via `-v NAME=VALUE` on the next run. Each
 * pattern is compiled as a case-insensitive regex (`new RegExp(p, 'i')`).
 * Invalid regex entries are logged to console and skipped — they never
 * block execution on their own.
 *
 * Returns one entry per (pattern, location) pair, including the matched
 * substring so the UI can show the user exactly what tripped the filter.
 *
 * @param {string} program
 * @param {Record<string, string> | undefined | null} vars
 * @param {string[] | undefined | null} patterns
 * @returns {{ pattern: string, where: string, match: string }[]}
 */
export function findForbiddenMatches(program, vars, patterns) {
  /** @type {{ pattern: string, where: string, match: string }[]} */
  const hits = [];
  if (!patterns || !patterns.length) return hits;
  for (const raw of patterns) {
    const p = (raw || '').trim();
    if (!p) continue;
    // `#`-prefixed lines are comments so users can annotate their patterns.
    if (p.startsWith('#')) continue;
    let re;
    try {
      re = new RegExp(p, 'i');
    } catch (err) {
      console.warn(`safety: ignoring invalid forbidden pattern ${JSON.stringify(p)}:`, err);
      continue;
    }
    if (program) {
      const m = program.match(re);
      if (m) hits.push({ pattern: p, where: 'awk program', match: m[0] });
    }
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        if (typeof value !== 'string') continue;
        const m = value.match(re);
        if (m) hits.push({ pattern: p, where: `variable "${name}"`, match: m[0] });
      }
    }
  }
  return hits;
}

/**
 * Format a single forbidden hit into an error sentence suitable for
 * display in a stderr-style banner or toast. Shows both the pattern that
 * matched and the offending substring so the user can correct either.
 *
 * @param {{ pattern: string, where: string, match: string }} hit
 * @returns {string}
 */
export function describeForbiddenHit(hit) {
  return `${SAFETY_BLOCKED_PREFIX} pattern /${hit.pattern}/i matched ${JSON.stringify(hit.match)} in ${hit.where}. Edit the list in Settings → Safety if this is intentional.`;
}

/**
 * Stable prefix of every stderr message produced by `describeForbiddenHit`.
 * Exposed so stderr-rendering panes can detect a safety-blocked error and
 * surface an inline "Change setting" affordance next to the message —
 * the toast fired by `runAwk` is transient, so the inline button is the
 * durable fallback.
 */
export const SAFETY_BLOCKED_PREFIX = 'Blocked by safety filter:';

/** @param {string | undefined | null} stderr */
export function isSafetyBlockedStderr(stderr) {
  return typeof stderr === 'string' && stderr.includes(SAFETY_BLOCKED_PREFIX);
}

/**
 * If `stderr` is a safety-blocked message, append a block-level "Change
 * setting" button to `containerEl`. No-op otherwise. Returns true if it
 * appended so the caller can avoid double-wiring.
 *
 * Button styling matches the auto-preview gate's secondary affordance
 * (`.preview-manual-change`) for visual consistency — both surfaces
 * route the user to the same Settings → Safety fieldset.
 *
 * Rendered as a block element (container div) because many of the
 * stderr panes are `<pre>` elements — appending a raw inline-block
 * button would trail awkwardly after the text's last line.
 *
 * @param {HTMLElement} containerEl
 * @param {string | undefined | null} stderr
 * @param {() => void} onChangeSetting
 * @returns {boolean}
 */
export function appendSafetyChangeSettingIfBlocked(containerEl, stderr, onChangeSetting) {
  if (!isSafetyBlockedStderr(stderr)) return false;
  const row = document.createElement('div');
  row.className = 'safety-blocked-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'preview-manual-btn preview-manual-change safety-blocked-change';
  btn.textContent = 'Change setting';
  btn.title = 'Open Settings → Safety — edit the forbidden patterns list';
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    onChangeSetting();
  });
  row.appendChild(btn);
  containerEl.appendChild(row);
  return true;
}

/**
 * Decide whether to gate an auto-preview. Returns `gated:true` when either
 * the user has set "Always require manual preview" in settings, or any of
 * the step programs contains a side-effect construct AND the user has
 * *not* opted in to auto-previewing side-effect programs. The caller uses
 * the `effects` list to explain why in the UI.
 *
 * `requireManualPreview` wins over `autoPreviewSideEffects` — if the user
 * asked for strict manual-only mode, the side-effect escape hatch doesn't
 * override it.
 *
 * @param {string[]} programs
 * @param {{ requireManualPreview?: boolean, autoPreviewSideEffects?: boolean }} [opts]
 * @returns {{ gated: boolean, manualOnly: boolean, effects: string[] }}
 */
export function shouldGatePreview(programs, opts = {}) {
  if (opts.requireManualPreview) return { gated: true, manualOnly: true, effects: [] };
  const effects = findSideEffectsAcross(programs);
  if (effects.length && !opts.autoPreviewSideEffects) {
    return { gated: true, manualOnly: false, effects };
  }
  return { gated: false, manualOnly: false, effects: [] };
}

/**
 * Render a "Run preview" prompt into the given output element. Replaces
 * the element's children with a short explanatory line + a row of two
 * buttons: "Run preview" (left) invokes `onRun`; "Change setting"
 * (right) invokes `onChangeSetting` with the id of the settings row
 * that would flip the gate off — the caller wires that to
 * `openSettingsDialog({ scrollTo })` so the user lands on the toggle
 * and sees it flash. Kept out of safety.js's imports to avoid a cycle
 * with settings.js (which already imports from safety.js).
 *
 * @param {HTMLElement} outEl
 * @param {{ manualOnly: boolean, effects: string[] }} reason
 * @param {() => void} onRun
 * @param {((settingId: string) => void) | undefined} [onChangeSetting]
 */
export function renderManualPreviewPrompt(outEl, reason, onRun, onChangeSetting) {
  outEl.classList.remove('error');
  outEl.replaceChildren();
  const msg = document.createElement('div');
  msg.className = 'preview-manual-msg muted';
  msg.textContent = reason.manualOnly
    ? 'Auto-preview disabled (Settings → Safety → Always require manual preview).'
    : `Auto-preview disabled — program contains: ${reason.effects.join(', ')}. Click below to run.`;
  outEl.appendChild(msg);

  const row = document.createElement('div');
  row.className = 'preview-manual-actions';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'preview-manual-btn';
  runBtn.textContent = 'Run preview';
  runBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    onRun();
  });
  row.appendChild(runBtn);

  if (onChangeSetting) {
    // Target the row-level `<label id=…>` rather than the bare checkbox
    // so the flash outline frames the whole "checkbox + explanatory
    // text" block instead of just the tiny input.
    const settingId = reason.manualOnly
      ? 'set-safety-manual-preview-row'
      : 'set-safety-auto-side-effects-row';
    const changeBtn = document.createElement('button');
    changeBtn.type = 'button';
    changeBtn.className = 'preview-manual-btn preview-manual-change';
    changeBtn.textContent = 'Change setting';
    changeBtn.title = reason.manualOnly
      ? 'Open Settings → Safety → Always require manual preview'
      : 'Open Settings → Safety → Auto-preview programs with side effects';
    changeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      onChangeSetting(settingId);
    });
    row.appendChild(changeBtn);
  }

  outEl.appendChild(row);
}
