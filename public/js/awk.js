// @ts-check
// Awk client: tokenizer, syntax-highlight overlay, and /run fetch wrapper.

import { escapeHtml } from './core.js';
import { AWK_KEYWORDS, AWK_BUILTINS, AWK_VARS } from './data.js';
import { settings } from './settings.js';
import { findForbiddenMatches, describeForbiddenHit } from './safety.js';
import { dispatch, on } from './events.js';

/** @typedef {import('./types.js').RunResult} RunResult */

function isRegexContext(prev) {
  if (prev === null) return true;
  return !(
    prev === 'ident' ||
    prev === 'number' ||
    prev === 'field' ||
    prev === 'string' ||
    prev === 'regex' ||
    prev === 'close'
  );
}

/**
 * @param {string} src
 * @returns {{t:string,s:string}[]}
 */
export function tokenizeAwk(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  let prev = null;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r'))
        j++;
      tokens.push({ t: 'ws', s: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '#') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      tokens.push({ t: 'comment', s: src.slice(i, j) });
      i = j;
      prev = 'comment';
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < n) j += 2;
        else j++;
      }
      if (j < n && src[j] === '"') j++;
      tokens.push({ t: 'string', s: src.slice(i, j) });
      i = j;
      prev = 'string';
      continue;
    }
    if (c === '/' && isRegexContext(prev)) {
      let j = i + 1;
      while (j < n && src[j] !== '/' && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < n) j += 2;
        else j++;
      }
      if (j < n && src[j] === '/') j++;
      tokens.push({ t: 'regex', s: src.slice(i, j) });
      i = j;
      prev = 'regex';
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      if (j < n && (src[j] === 'e' || src[j] === 'E')) {
        j++;
        if (j < n && (src[j] === '+' || src[j] === '-')) j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      tokens.push({ t: 'number', s: src.slice(i, j) });
      i = j;
      prev = 'number';
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (
        j < n &&
        ((src[j] >= 'A' && src[j] <= 'Z') ||
          (src[j] >= 'a' && src[j] <= 'z') ||
          (src[j] >= '0' && src[j] <= '9') ||
          src[j] === '_')
      )
        j++;
      tokens.push({ t: 'field', s: src.slice(i, j) });
      i = j;
      prev = 'field';
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (
        j < n &&
        ((src[j] >= 'A' && src[j] <= 'Z') ||
          (src[j] >= 'a' && src[j] <= 'z') ||
          (src[j] >= '0' && src[j] <= '9') ||
          src[j] === '_')
      )
        j++;
      const word = src.slice(i, j);
      let type = 'ident';
      if (AWK_KEYWORDS.has(word)) type = 'keyword';
      else if (AWK_BUILTINS.has(word)) type = 'builtin';
      else if (AWK_VARS.has(word)) type = 'var';
      tokens.push({ t: type, s: word });
      i = j;
      prev = type;
      continue;
    }
    if (c === ')' || c === ']') {
      tokens.push({ t: 'punct', s: c });
      i++;
      prev = 'close';
      continue;
    }
    tokens.push({ t: 'punct', s: c });
    i++;
    prev = 'punct';
  }
  return tokens;
}

/**
 * Collapse a multi-line awk program into a single line suitable for
 * embedding inside a shell-quoted argument (e.g. `awk '…'`). Simply
 * replacing `\n` with spaces breaks programs that use newlines as
 * statement separators: `print "a"\nprint "b"` becomes `print "a" print
 * "b"`, which awk rejects. Instead, walk tokens and insert `;` between
 * statements that a newline previously separated.
 *
 * The `;` is suppressed where it would itself be invalid:
 *   - after `{ ( [ , ; ? : }` or a `\` line continuation (`\` is dropped)
 *   - after `&&` / `||` (two-token punct pair)
 *   - after keyword `else` or `do`
 *   - after `)` that closes an `if` / `while` / `for` expression
 *   - before a leading `{` on the next line (function/control-stmt body)
 *
 * Comments are dropped — a `#…` that survived collapsing would swallow
 * every subsequent statement up to the shell argument's close quote.
 *
 * @param {string} src
 * @returns {string}
 */
export function flattenAwkProgram(src) {
  if (!src) return '';
  const raw = tokenizeAwk(src);
  // Drop comments; merge each ws run into a single token flagged with
  // whether it contained a newline.
  /** @type {{t:string,s:string,nl?:boolean}[]} */
  const toks = [];
  for (const t of raw) {
    if (t.t === 'comment') continue;
    if (t.t === 'ws') {
      const nl = t.s.includes('\n');
      const last = toks[toks.length - 1];
      if (last && last.t === 'ws') {
        if (nl) last.nl = true;
      } else {
        toks.push({ t: 'ws', s: ' ', nl });
      }
      continue;
    }
    toks.push({ t: t.t, s: t.s });
  }
  while (toks.length && toks[0].t === 'ws') toks.shift();
  while (toks.length && toks[toks.length - 1].t === 'ws') toks.pop();

  const SKIP_AFTER_PUNCT = new Set(['{', '(', '[', ',', ';', '?', ':', '}']);
  const SKIP_AFTER_KEYWORD = new Set(['else', 'do']);
  const CONTROL_KEYWORDS = new Set(['if', 'while', 'for']);

  const closesControlExpr = (idx) => {
    let depth = 1;
    for (let j = idx - 1; j >= 0; j--) {
      const t = toks[j];
      if (t.t !== 'punct') continue;
      if (t.s === ')') depth++;
      else if (t.s === '(') {
        depth--;
        if (depth === 0) {
          for (let k = j - 1; k >= 0; k--) {
            if (toks[k].t === 'ws') continue;
            return toks[k].t === 'keyword' && CONTROL_KEYWORDS.has(toks[k].s);
          }
          return false;
        }
      }
    }
    return false;
  };

  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.t !== 'ws') {
      out.push(tok.s);
      continue;
    }
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (tok.nl && prev && prev.t === 'punct' && prev.s === '\\') {
      out.pop();
      if (out.length && out[out.length - 1] !== ' ') out.push(' ');
      continue;
    }
    if (!tok.nl || !prev || !next) {
      out.push(' ');
      continue;
    }
    let skip = false;
    if (prev.t === 'punct') {
      if (SKIP_AFTER_PUNCT.has(prev.s)) skip = true;
      else if (prev.s === '&' || prev.s === '|') {
        for (let j = i - 2; j >= 0; j--) {
          if (toks[j].t === 'ws') continue;
          if (toks[j].t === 'punct' && toks[j].s === prev.s) skip = true;
          break;
        }
      } else if (prev.s === ')' && closesControlExpr(i - 1)) {
        skip = true;
      }
    } else if (prev.t === 'keyword' && SKIP_AFTER_KEYWORD.has(prev.s)) {
      skip = true;
    }
    if (!skip && next.t === 'punct' && next.s === '{') skip = true;
    out.push(skip ? ' ' : '; ');
  }
  return out.join('');
}

/**
 * I/O-affecting awk variables that are worth copying across chain steps.
 * These are the ones whose setting in an earlier pipeline stage changes
 * how a later stage parses its input or formats its output — so when the
 * user adds an inline step, "import these from the preceding steps' BEGIN
 * blocks" is the right affordance. Non-I/O BEGIN state (counters,
 * arrays, helper functions) is intentionally NOT included; those don't
 * cross `awk | awk` boundaries in the first place.
 */
const IO_CARRY_VARS = new Set([
  'FS',
  'OFS',
  'RS',
  'ORS',
  'FIELDWIDTHS',
  'FPAT',
  'CONVFMT',
  'OFMT',
]);

// ---------- field-separator detection ----------
// Sample up to 50 non-empty lines and pick the one-char separator that
// splits every line into the same (>0) number of fields. Ties broken
// by highest field count — more fields = stronger signal.
//
// Two passes: the well-known separators first (so the common case gets
// a readable label and deterministic pick), then a discovery fallback
// over any other character that passes the consistency test. Discovery
// excludes letters, digits, underscore, and space — those can appear
// consistently in fixed-format text (`INFO:`, hex timestamps, git
// SHAs) without actually being the delimiter, and using a letter as
// FS is almost never what anyone wants. Returns null when no candidate
// survives either pass.
const FS_ALLOWLIST = [',', '\t', '|', ';', ':'];

/**
 * @param {string} text
 * @returns {{ fs: string, fieldCount: number, sampleCount: number } | null}
 */
export function detectFieldSeparator(text) {
  if (!text) return null;
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const sample = lines.slice(0, 50);
  const countChar = (line, ch) => {
    let n = 0;
    for (let i = 0; i < line.length; i++) if (line[i] === ch) n++;
    return n;
  };
  const tryCandidate = (ch) => {
    const first = countChar(sample[0], ch);
    if (first === 0) return null;
    for (let i = 1; i < sample.length; i++) {
      if (countChar(sample[i], ch) !== first) return null;
    }
    return { fieldCount: first + 1, sampleCount: sample.length };
  };
  /** @type {{ fs: string, fieldCount: number, sampleCount: number } | null} */
  let best = null;
  for (const ch of FS_ALLOWLIST) {
    const result = tryCandidate(ch);
    if (result && (!best || result.fieldCount > best.fieldCount)) {
      best = { fs: ch, ...result };
    }
  }
  if (best) return best;
  // Discovery fallback — iterate over the distinct characters in the
  // first sampled line (a candidate must appear ≥1 time on every line,
  // so if it's absent from line 0 it can't win).
  const seen = new Set();
  for (const ch of sample[0]) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    if (FS_ALLOWLIST.includes(ch)) continue; // already tried
    if (/[A-Za-z0-9_ ]/.test(ch)) continue; // see header comment
    if (ch === '\r' || ch === '\n') continue; // line terminators
    const result = tryCandidate(ch);
    if (result && (!best || result.fieldCount > best.fieldCount)) {
      best = { fs: ch, ...result };
    }
  }
  return best;
}

const FS_LABELS = {
  ',': 'comma',
  '\t': 'tab',
  '|': 'pipe',
  ';': 'semicolon',
  ':': 'colon',
};

/**
 * Friendly label for a detected FS: names for allowlist chars, the
 * char itself (quoted) for discovered printables, a hex escape for
 * anything sub-0x20 or DEL (e.g. Hive's ^A → \x01).
 * @param {string} fs
 */
export function fsLabel(fs) {
  if (FS_LABELS[fs]) return FS_LABELS[fs];
  const code = fs.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return `"${fs}"`;
}

/**
 * Would awk's default whitespace FS already produce a consistent,
 * meaningful field split across `text`? Returns `{ fieldCount,
 * sampleCount }` when every sampled non-empty line splits into the
 * same (>=2) number of fields on runs of whitespace — awk's default
 * behavior — and `null` otherwise. Used by the Detect FS flow as a
 * fallback after custom-FS detection fails, so a happy-path
 * "whitespace already works" case can be surfaced instead of a bare
 * "nothing detected" message.
 *
 * Split mirrors awk: trim leading / trailing whitespace, then split
 * on `\s+`. Requires `fieldCount >= 2` so a file of single-word
 * lines doesn't trigger a false positive (one "field" isn't useful
 * structure).
 *
 * @param {string} text
 * @returns {{ fieldCount: number, sampleCount: number } | null}
 */
export function detectDefaultFsUsable(text) {
  if (!text) return null;
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const sample = lines.slice(0, 50);
  const firstCount = sample[0].trim().split(/\s+/).length;
  if (firstCount < 2) return null;
  for (let i = 1; i < sample.length; i++) {
    if (sample[i].trim().split(/\s+/).length !== firstCount) return null;
  }
  return { fieldCount: firstCount, sampleCount: sample.length };
}

/**
 * Cheap check: does `text` parse as a JSON array of (at least one)
 * object? Used to steer the "Detect FS" flow — if the input is a JSON
 * array, setting FS is the wrong move and we'd rather suggest the
 * JSON-to-Table chain. Returns `{ count }` on a match, `null` otherwise.
 *
 * Rules: trimmed text starts with `[` and ends with `]`; `JSON.parse`
 * succeeds; parsed value is a non-empty array; at least one element is
 * a plain object (covers the "array of records" shape relevant to
 * table conversion — an array of primitives doesn't benefit from the
 * chain).
 *
 * @param {string} text
 * @returns {{ count: number } | null}
 */
export function detectJsonArray(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const hasObjects = parsed.some(
    (x) => x && typeof x === 'object' && !Array.isArray(x),
  );
  if (!hasObjects) return null;
  return { count: parsed.length };
}

/**
 * Render `fs` as the contents of an awk double-quoted string literal.
 * Tab, backslash, and double-quote need escaping; sub-0x20 / DEL chars
 * use awk's octal form `\NNN`; everything else is safe literal.
 * @param {string} fs
 */
export function fsAwkLiteral(fs) {
  if (fs === '\t') return '\\t';
  if (fs === '\\') return '\\\\';
  if (fs === '"') return '\\"';
  const code = fs.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) {
    return '\\' + code.toString(8).padStart(3, '0');
  }
  return fs;
}

/**
 * Character offset of the position immediately after the `{` that opens
 * the first `BEGIN { … }` block in `program`, or `-1` when the program
 * has no BEGIN block. Used by callers that want to inject statements
 * into an existing BEGIN instead of prepending a second one.
 *
 * Strings and regexes are opaque to the tokenizer, so a `{` inside a
 * literal (`BEGIN { FS = "{" }`) is not mistaken for the BEGIN brace.
 *
 * @param {string} program
 * @returns {number}
 */
export function findBeginBodyStartOffset(program) {
  if (!program) return -1;
  const tokens = tokenizeAwk(program);
  let offset = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'keyword' && t.s === 'BEGIN') {
      let at = offset + t.s.length;
      for (let j = i + 1; j < tokens.length; j++) {
        const tk = tokens[j];
        if (tk.t === 'ws') {
          at += tk.s.length;
          continue;
        }
        if (tk.t === 'punct' && tk.s === '{') {
          return at + tk.s.length;
        }
        // BEGIN not immediately followed by `{` — malformed; give up.
        break;
      }
    }
    offset += t.s.length;
  }
  return -1;
}

/**
 * Scan `program`'s `BEGIN { … }` blocks for top-level assignments to
 * I/O-affecting awk variables (see `IO_CARRY_VARS`) and return a map
 * from var name → the verbatim source text of its right-hand side.
 *
 * Multiple assignments to the same var in a single program follow
 * last-writer-wins (the final assignment's RHS replaces earlier ones).
 * Callers that merge across several programs can iterate the maps in
 * order to preserve that semantics across steps too.
 *
 * Only the outermost `BEGIN` block's top-level statements are
 * considered — assignments nested inside `if` / `for` / function
 * definitions are skipped, since those aren't unconditional I/O setup.
 * Strings and regexes are parsed correctly (embedded `;` / `}` / `\n`
 * inside a literal don't break statement boundaries).
 *
 * @param {string} program
 * @returns {Map<string, string>}  e.g. `{ FS: '","', OFS: '"\\t"' }`
 */
export function extractBeginIoAssignments(program) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!program) return out;
  const tokens = tokenizeAwk(program);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.t === 'keyword' && t.s === 'BEGIN') {
      // Next non-ws token must be '{'; otherwise this is a bare BEGIN
      // (syntactically invalid, but we just skip).
      let j = i + 1;
      while (j < tokens.length && tokens[j].t === 'ws') j++;
      if (j < tokens.length && tokens[j].t === 'punct' && tokens[j].s === '{') {
        const bodyStart = j + 1;
        // Walk to matching `}` (track nested braces so a `{...}` in a
        // loop body is closed before the BEGIN block's own `}`).
        let depth = 1;
        let k = bodyStart;
        while (k < tokens.length) {
          const tk = tokens[k];
          if (tk.t === 'punct') {
            if (tk.s === '{') depth++;
            else if (tk.s === '}') {
              depth--;
              if (depth === 0) break;
            }
          }
          k++;
        }
        extractTopLevelAssignments(tokens, bodyStart, k, out);
        i = k + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Source range of the last top-level assignment to `varName` inside any
 * `BEGIN { … }` block of `program`. The returned offsets cover just the
 * `varName = rhs` span (end-exclusive) — trailing `;` or newline is
 * left in place, so callers can replace the range with a fresh
 * `varName = newRhs` without disturbing surrounding punctuation or
 * statements. Returns `null` when no such assignment exists.
 *
 * "Last" matches `extractBeginIoAssignments`'s last-writer-wins
 * semantics: in `BEGIN { FS="," } BEGIN { FS="|" }` the second BEGIN
 * wins at run time, so that's the one a replacement should target.
 *
 * @param {string} program
 * @param {string} varName
 * @returns {{ start: number, end: number } | null}
 */
export function findBeginAssignmentRange(program, varName) {
  if (!program) return null;
  const tokens = tokenizeAwk(program);
  // Token-index → absolute source offset; [tokens.length] is program end.
  const offsets = new Array(tokens.length + 1);
  offsets[0] = 0;
  for (let n = 0; n < tokens.length; n++) offsets[n + 1] = offsets[n] + tokens[n].s.length;
  /** @type {{ start: number, end: number } | null} */
  let last = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.t === 'keyword' && t.s === 'BEGIN') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].t === 'ws') j++;
      if (j >= tokens.length || tokens[j].t !== 'punct' || tokens[j].s !== '{') {
        i = j;
        continue;
      }
      const bodyStart = j + 1;
      // Matching `}` — braces nested inside control-flow bodies count.
      let depth = 1;
      let k = bodyStart;
      while (k < tokens.length) {
        const tk = tokens[k];
        if (tk.t === 'punct') {
          if (tk.s === '{') depth++;
          else if (tk.s === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        k++;
      }
      // Walk statements within [bodyStart, k).
      let s = bodyStart;
      while (s < k) {
        while (s < k && (tokens[s].t === 'ws' || tokens[s].t === 'comment')) s++;
        if (s >= k) break;
        const stmtStart = s;
        let d = 0;
        let stmtEnd = k;
        while (s < k) {
          const tk = tokens[s];
          if (tk.t === 'punct') {
            if (tk.s === '{' || tk.s === '(' || tk.s === '[') d++;
            else if (tk.s === '}' || tk.s === ')' || tk.s === ']') {
              if (d === 0) {
                stmtEnd = s;
                break;
              }
              d--;
              if (d === 0 && tk.s === '}') {
                s++;
                stmtEnd = s;
                break;
              }
            } else if (tk.s === ';' && d === 0) {
              s++;
              stmtEnd = s;
              break;
            }
          } else if (tk.t === 'ws' && d === 0 && tk.s.includes('\n')) {
            s++;
            stmtEnd = s;
            break;
          }
          s++;
        }
        // Shape-check: first meaningful token is `varName`, next is `=`
        // (not `==`).
        let p = stmtStart;
        while (p < stmtEnd && (tokens[p].t === 'ws' || tokens[p].t === 'comment')) p++;
        if (p < stmtEnd) {
          const first = tokens[p];
          if ((first.t === 'var' || first.t === 'ident') && first.s === varName) {
            let q = p + 1;
            while (q < stmtEnd && tokens[q].t === 'ws') q++;
            const isEq =
              q < stmtEnd && tokens[q].t === 'punct' && tokens[q].s === '=';
            const isEqEq =
              isEq &&
              q + 1 < stmtEnd &&
              tokens[q + 1].t === 'punct' &&
              tokens[q + 1].s === '=';
            if (isEq && !isEqEq) {
              // Trim back past the terminator and any trailing ws/comment
              // so the returned range ends at the last RHS token.
              let endIdx = stmtEnd - 1;
              while (endIdx > p) {
                const tk = tokens[endIdx];
                if (
                  tk.t === 'ws' ||
                  tk.t === 'comment' ||
                  (tk.t === 'punct' && tk.s === ';')
                ) {
                  endIdx--;
                  continue;
                }
                break;
              }
              last = { start: offsets[p], end: offsets[endIdx + 1] };
            }
          }
        }
      }
      i = k + 1;
      continue;
    }
    i++;
  }
  return last;
}

/**
 * Walk tokens[start..end), slice into top-level statements on `;` or
 * newline at paren / brace / bracket depth 0, and feed each statement
 * to `recordAssignment`.
 */
function extractTopLevelAssignments(tokens, start, end, out) {
  let i = start;
  while (i < end) {
    while (i < end && (tokens[i].t === 'ws' || tokens[i].t === 'comment')) i++;
    if (i >= end) break;
    const stmtStart = i;
    let depth = 0;
    let stmtEnd = end;
    while (i < end) {
      const tk = tokens[i];
      if (tk.t === 'punct') {
        if (tk.s === '{' || tk.s === '(' || tk.s === '[') depth++;
        else if (tk.s === '}' || tk.s === ')' || tk.s === ']') {
          // Stray top-level closer inside the BEGIN body — caller
          // already excluded the outer brace, so this is malformed
          // input. Bail on the current statement defensively.
          if (depth === 0) {
            stmtEnd = i;
            break;
          }
          depth--;
          // A `}` that returns us to top level closes a control-flow
          // body (`if (…) { … }`, `for (…) { … }`, …). Treat that as
          // the statement's natural end, so the next token starts a
          // fresh top-level statement even without an explicit `;` or
          // newline between them. Doesn't apply to `)` / `]` — those
          // just close grouping inside an ongoing expression.
          if (depth === 0 && tk.s === '}') {
            i++;
            stmtEnd = i;
            break;
          }
        } else if (tk.s === ';' && depth === 0) {
          stmtEnd = i;
          i++;
          break;
        }
      } else if (tk.t === 'ws' && depth === 0 && tk.s.includes('\n')) {
        stmtEnd = i;
        i++;
        break;
      }
      i++;
    }
    recordAssignment(tokens, stmtStart, stmtEnd, out);
  }
}

function recordAssignment(tokens, start, end, out) {
  let i = start;
  while (i < end && (tokens[i].t === 'ws' || tokens[i].t === 'comment')) i++;
  if (i >= end) return;
  const first = tokens[i];
  // FIELDWIDTHS / FPAT / CONVFMT / OFMT tokenize as 'ident' (they're
  // gawk extensions or less common, not in AWK_VARS); FS / OFS / RS /
  // ORS tokenize as 'var'. Accept either.
  if ((first.t !== 'var' && first.t !== 'ident') || !IO_CARRY_VARS.has(first.s)) return;
  const name = first.s;
  i++;
  while (i < end && tokens[i].t === 'ws') i++;
  if (i >= end) return;
  const op = tokens[i];
  if (op.t !== 'punct' || op.s !== '=') return;
  // Reject compound-equality `==`: two consecutive '=' punct tokens.
  if (i + 1 < end && tokens[i + 1].t === 'punct' && tokens[i + 1].s === '=') return;
  i++;
  while (i < end && tokens[i].t === 'ws') i++;
  if (i >= end) return;
  // Skip comments so a statement like `OFS = "," # sep used downstream`
  // doesn't carry the `# sep used downstream` into the pasted BEGIN
  // block (awk comments run to end-of-line, so our statement walker
  // already treated the comment's newline as the statement terminator
  // — we just need to drop the comment token itself from the RHS).
  let rhs = '';
  for (let j = i; j < end; j++) {
    if (tokens[j].t === 'comment') continue;
    rhs += tokens[j].s;
  }
  rhs = rhs.replace(/^\s+|\s+$/g, '');
  if (!rhs) return;
  out.set(name, rhs);
}

/**
 * Extract candidate `-v NAME=VALUE` variables from awk source. Returns
 * identifiers that:
 *   - are NOT keywords / builtins / awk-special vars;
 *   - are NOT function declaration names (`function NAME(...)`);
 *   - are NOT function call names (`NAME(...)`);
 *   - are NOT array names (`NAME[...]` *anywhere* in the program —
 *     can't be set via `-v` even at a usage site that doesn't itself
 *     subscript. Also picks up the right-hand operand of `in` since
 *     awk's `in` only operates on arrays: `key in arr`, `for (k in
 *     arr)` both mark `arr` as an array);
 *   - are NEVER assigned within the program. A variable that's written
 *     anywhere (`x = …`, `x += …`, `x++`, `for (x in arr)`, etc.)
 *     derives its final value from program flow, not from a seed —
 *     passing a `-v` value would be misleading at best. Exclude.
 *
 * Field refs like `$col` are tokenized as one token; we pull the index
 * identifier out so `{ print $col }` still reports `col`.
 *
 * The helper may still over-report (notably, function-parameter names leak
 * through — tracking decl scope is out of scope here). Callers should
 * treat results as a prefill the user can prune, not a strict contract.
 *
 * @param {string} src
 * @returns {string[]}
 */
export function findCandidateVars(src) {
  const tokens = tokenizeAwk(src);
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const assigned = new Set();
  const prevNonWs = (i) => {
    let j = i - 1;
    while (j >= 0 && tokens[j].t === 'ws') j--;
    return j >= 0 ? tokens[j] : null;
  };
  const nextNonWs = (i) => {
    let j = i + 1;
    while (j < tokens.length && tokens[j].t === 'ws') j++;
    return j < tokens.length ? tokens[j] : null;
  };
  const nextNonWsAt = (i) => {
    let j = i + 1;
    while (j < tokens.length && tokens[j].t === 'ws') j++;
    return j < tokens.length ? j : -1;
  };
  const prevNonWsAt = (i) => {
    let j = i - 1;
    while (j >= 0 && tokens[j].t === 'ws') j--;
    return j >= 0 ? j : -1;
  };

  // Pass 1: collect names that ever appear on the LHS of an assignment /
  // increment / decrement. Covers `x = …`, compound `x += -= *= /= %= ^=`,
  // and `x++ ++x x-- --x`.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t !== 'ident') continue;
    const nIdx = nextNonWsAt(i);
    const next = nIdx >= 0 ? tokens[nIdx] : null;
    if (next && next.t === 'punct') {
      if (next.s === '=') {
        // Distinguish `x =` from `x ==` (equality). If the token following
        // `=` is another `=`, it's comparison — skip.
        const after = nIdx + 1 < tokens.length ? tokens[nIdx + 1] : null;
        if (!(after && after.t === 'punct' && after.s === '=')) {
          assigned.add(tok.s);
        }
      } else if ('+-*/%^'.includes(next.s)) {
        const after = nIdx + 1 < tokens.length ? tokens[nIdx + 1] : null;
        if (after && after.t === 'punct') {
          if (after.s === '=') {
            // compound assign: +=, -=, *=, /=, %=, ^=
            assigned.add(tok.s);
          } else if (after.s === next.s && (next.s === '+' || next.s === '-')) {
            // post-increment / decrement
            assigned.add(tok.s);
          }
        }
      }
    }
    // prefix ++/-- : previous two non-ws tokens are identical `+`/`-` punct.
    const pIdx = prevNonWsAt(i);
    if (pIdx >= 0) {
      const prev1 = tokens[pIdx];
      if (prev1.t === 'punct' && (prev1.s === '+' || prev1.s === '-')) {
        const pIdx2 = prevNonWsAt(pIdx);
        if (pIdx2 >= 0) {
          const prev2 = tokens[pIdx2];
          if (prev2.t === 'punct' && prev2.s === prev1.s) {
            assigned.add(tok.s);
          }
        }
      }
    }
  }

  // Pass 1b: collect array names. Any ident immediately followed by
  // `[` is a subscripted array (classic case: `arr[key] = …`); any
  // ident on the RHS of `in` is also an array, because awk's `in`
  // operator only accepts arrays (`key in arr`, `for (k in arr)`).
  // Catching arrays whole-program lets us filter a usage like
  // `for (p in total_revenue)` where `total_revenue` itself has no
  // subscript at that occurrence but was subscripted elsewhere.
  /** @type {Set<string>} */
  const arrays = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t !== 'ident') continue;
    const next = nextNonWs(i);
    if (next && next.t === 'punct' && next.s === '[') arrays.add(tok.s);
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!(tok.t === 'keyword' && tok.s === 'in')) continue;
    const rhsIdx = nextNonWsAt(i);
    if (rhsIdx >= 0 && tokens[rhsIdx].t === 'ident') arrays.add(tokens[rhsIdx].s);
  }

  // Pass 1c: `for (IDENT in ARR)` — IDENT is the loop-iteration target
  // and is effectively assigned on every iteration, so it shouldn't be
  // a `-v` candidate either.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!(tok.t === 'keyword' && tok.s === 'for')) continue;
    const lparenIdx = nextNonWsAt(i);
    if (lparenIdx < 0) continue;
    const lparen = tokens[lparenIdx];
    if (lparen.t !== 'punct' || lparen.s !== '(') continue;
    const itIdx = nextNonWsAt(lparenIdx);
    if (itIdx < 0 || tokens[itIdx].t !== 'ident') continue;
    const inIdx = nextNonWsAt(itIdx);
    if (inIdx < 0) continue;
    const inTok = tokens[inIdx];
    if (inTok.t === 'keyword' && inTok.s === 'in') assigned.add(tokens[itIdx].s);
  }

  // Pass 2: collect candidates, applying the usual filters.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'field') {
      const name = tok.s.slice(1);
      if (!name || /^\d+$/.test(name)) continue;
      if (AWK_KEYWORDS.has(name) || AWK_BUILTINS.has(name) || AWK_VARS.has(name)) continue;
      if (assigned.has(name)) continue;
      if (arrays.has(name)) continue;
      names.add(name);
      continue;
    }
    if (tok.t !== 'ident') continue;
    if (assigned.has(tok.s)) continue;
    if (arrays.has(tok.s)) continue;
    const prev = prevNonWs(i);
    if (prev && prev.t === 'keyword' && (prev.s === 'function' || prev.s === 'func')) continue;
    const next = nextNonWs(i);
    if (next && next.t === 'punct' && (next.s === '(' || next.s === '[')) continue;
    names.add(tok.s);
  }
  return [...names];
}

/**
 * Syntax-highlight an awk source string. Every token is escaped via
 * `escapeHtml`, so the return value is safe for assignment to `.innerHTML`.
 * @param {string} src
 * @returns {string} HTML-safe markup
 */
export function highlightAwk(src) {
  const tokens = tokenizeAwk(src);
  let out = '';
  for (const tok of tokens) {
    const esc = escapeHtml(tok.s);
    if (tok.t === 'ws' || tok.t === 'punct' || tok.t === 'ident') {
      out += esc;
    } else {
      out += `<span class="tok-${tok.t}">${esc}</span>`;
    }
  }
  return out; // HTML-safe: every token is escaped via escapeHtml above
}

const HIGHLIGHTED_TEXTAREAS = new WeakSet();
/** @type {WeakMap<HTMLTextAreaElement, ResizeObserver>} */
const HIGHLIGHTER_RESIZE_OBSERVERS = new WeakMap();
/** @type {WeakMap<HTMLTextAreaElement, () => void>} */
const HIGHLIGHTER_VOCAB_LISTENERS = new WeakMap();

/**
 * Detach the highlighter overlay — disconnects the stored ResizeObserver for
 * `textarea` so it can be attached to a different element or let go.
 * @param {HTMLTextAreaElement} textarea
 */
export function detachHighlighter(textarea) {
  const ro = HIGHLIGHTER_RESIZE_OBSERVERS.get(textarea);
  if (ro) {
    ro.disconnect();
    HIGHLIGHTER_RESIZE_OBSERVERS.delete(textarea);
  }
  const vocabListener = HIGHLIGHTER_VOCAB_LISTENERS.get(textarea);
  if (vocabListener) {
    document.removeEventListener('awk-vocabulary-changed', vocabListener);
    HIGHLIGHTER_VOCAB_LISTENERS.delete(textarea);
  }
  HIGHLIGHTED_TEXTAREAS.delete(textarea);
}

/**
 * Attach the syntax-highlighter overlay to an awk-program textarea.
 * Creates a sibling `<pre class="hl-pre">` that mirrors the textarea's
 * scroll / size / font, re-runs `highlightAwk` on every input event,
 * and wires a ResizeObserver so the overlay tracks user-resize gestures.
 * Idempotent via `HIGHLIGHTED_TEXTAREAS` — a second call on the same
 * textarea is a no-op.
 *
 * Tab-as-indent is deliberately NOT wired here; see the comment inside
 * for the reasoning. Pair with `detachHighlighter` when the textarea is
 * being reused or removed so the ResizeObserver and vocabulary listener
 * don't leak.
 *
 * @param {HTMLTextAreaElement} textarea
 */
export function attachHighlighter(textarea) {
  if (!textarea || HIGHLIGHTED_TEXTAREAS.has(textarea)) return;
  HIGHLIGHTED_TEXTAREAS.add(textarea);
  // NOTE: Tab-as-indent (core.attachTabIndent) is deliberately NOT wired
  // here. Every awk-program textarea in the app lives inside a modal:
  // native <dialog> elements (snippet/inline-step/template/chain) or the
  // custom palette. In modals, Tab is the user's primary tool for cycling
  // focus between controls, and native <dialog> also closes on Esc —
  // which would destroy the Esc-Tab escape pattern. Leaving Tab alone in
  // these textareas preserves both conventions. The main editor (#editor),
  // which is never in a modal, still gets Tab-as-indent via
  // setupEditorTabs in editor.js.
  const wrap = document.createElement('div');
  wrap.className = 'hl-wrap';
  textarea.parentNode.insertBefore(wrap, textarea);
  const pre = document.createElement('pre');
  pre.className = 'hl-pre';
  pre.setAttribute('aria-hidden', 'true');
  // See editor.js attachEditorMatchOverlay for the rationale behind the inner
  // wrapper + transform-based scroll sync. Same pattern applies here.
  const preInner = document.createElement('div');
  preInner.className = 'hl-pre-inner';
  pre.appendChild(preInner);
  wrap.appendChild(pre);
  wrap.appendChild(textarea);
  textarea.classList.add('hl-textarea');

  const syncStyles = () => {
    const cs = getComputedStyle(textarea);
    // Clear any stale inline values from a pre-fix build.
    pre.style.fontFamily = '';
    pre.style.tabSize = '';
    // `tabSize` and `fontFamily` intentionally NOT synced — see the
    // mirror comment in `editor.js#attachEditorMatchOverlay`. Both
    // resolve on the textarea and the `.hl-pre` overlay through the
    // shared `--editor-tab-size` / `--editor-font-family` custom
    // properties, so a settings change repaints both in the same
    // frame. Pushing an inline snapshot onto `pre.style.X` would
    // override the CSS rule and freeze the overlay on the last
    // synced value until a ResizeObserver fired.
    for (const prop of [
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'paddingTop',
      'paddingBottom',
      'paddingLeft',
      'paddingRight',
      'borderTopWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'borderRightWidth',
    ]) {
      pre.style[prop] = cs[prop];
    }
  };
  const update = () => {
    preInner.innerHTML = highlightAwk(textarea.value);
  };
  const sync = () => {
    // Round to integer pixels — fractional scroll positions (elastic
    // scrolling, ancestor transforms) would raster the composited layer at
    // sub-pixel offsets and visibly blur the text. When there's no scroll
    // offset at all, remove the transform entirely so the browser keeps the
    // pre in the main paint layer (any non-empty transform — even
    // `translate(0,0)` — can promote it to a compositor layer, which
    // Chrome then rasterizes at fractional origins if the parent doesn't
    // land on an integer pixel).
    const x = Math.round(textarea.scrollLeft);
    const y = Math.round(textarea.scrollTop);
    preInner.style.transform = x === 0 && y === 0 ? '' : `translate(${-x}px, ${-y}px)`;
  };

  syncStyles();
  textarea.addEventListener('input', () => {
    update();
    sync();
  });
  textarea.addEventListener('scroll', sync);
  const ro = new ResizeObserver(() => {
    syncStyles();
    sync();
  });
  ro.observe(textarea);
  HIGHLIGHTER_RESIZE_OBSERVERS.set(textarea, ro);
  // Font-family / tab-size settings don't reflow the textarea, so the
  // ResizeObserver above won't re-run syncStyles. applySettings (and
  // live preview) dispatch this event so we can pick up the CSS var
  // change in the same frame.
  on('editor-font-settings-changed', syncStyles);
  // Re-run on vocabulary swaps (user toggled the "Highlight gawk
  // extensions" setting). Without this, open textareas would keep their
  // pre-toggle colouring until the next keystroke. Stored so
  // detachHighlighter can remove it and not leak across textarea
  // lifecycle.
  HIGHLIGHTER_VOCAB_LISTENERS.set(textarea, update);
  on('awk-vocabulary-changed', update);
  update();
  sync();
}

/**
 * Run an awk program via the server's /run endpoint, respecting user exec
 * settings (binary, args, timeout, max output).
 *
 * @param {string} program
 * @param {string} input
 * @param {Record<string,string>} [vars]
 * @returns {Promise<RunResult>}
 */
export async function runAwk(program, input, vars) {
  // Forbidden-pattern gate. Blocks any program / var-value containing a
  // configured substring (default list + user edits in Settings → Safety)
  // before it reaches the server. Intentionally a short-circuit: a single
  // hit short-circuits the whole run with an error the caller surfaces
  // like any other stderr.
  const forbiddenHits = findForbiddenMatches(
    program,
    vars || null,
    settings.safety?.forbiddenPatterns || [],
  );
  if (forbiddenHits.length) {
    // Broadcast so the UI can surface a toast with a quick-link into
    // Settings → Safety. The stderr remains the authoritative error
    // message that callers display in their own output panes.
    dispatch('safety:blocked', {
      pattern: forbiddenHits[0].pattern,
      where: forbiddenHits[0].where,
    });
    return { stdout: '', stderr: describeForbiddenHit(forbiddenHits[0]), code: -1 };
  }
  try {
    const body = {
      program,
      input,
      vars: vars || {},
      binary: settings.exec.binary,
      args: settings.exec.args,
      timeoutMs: settings.exec.timeoutMs,
      maxOutputBytes: settings.exec.maxOutputBytes,
    };
    const r = await fetch('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    /** @type {any} */
    const data = await r.json().catch(() => ({}));
    // Server-error envelopes (`{error: "…"}`) and non-2xx statuses must be
    // normalised to the {stdout, stderr, code} contract — otherwise callers
    // that do `out.textContent = result.stdout` end up rendering the literal
    // string "undefined" (e.g. on a rate-limit 429 during a burst of
    // palette previews).
    if (!r.ok || typeof data.stdout !== 'string') {
      return {
        stdout: '',
        stderr: annotateSandboxStderr(
          data.error || `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`,
        ),
        code: -1,
      };
    }
    if (typeof data.stderr === 'string') data.stderr = annotateSandboxStderr(data.stderr);
    return data;
  } catch (e) {
    return { stdout: '', stderr: 'network error: ' + e.message, code: -1 };
  }
}

/**
 * Multi-file variant of `runAwk`. Each `{name, content}` entry is
 * materialised server-side into a temp file; awk is invoked with the
 * filenames as positional args, giving `FILENAME`, `FNR`, `BEGINFILE`,
 * `ENDFILE` real multi-file semantics. Same return envelope as
 * `runAwk` so call sites can compose either uniformly.
 *
 * Forbidden-pattern gating is shared with `runAwk` — input *content*
 * isn't gated (only programs and var values are, same as today), so
 * there's nothing new to screen per-file.
 *
 * @param {string} program
 * @param {Array<{name: string, content: string}>} inputs
 * @param {Record<string,string>} [vars]
 * @returns {Promise<RunResult>}
 */
export async function runAwkMulti(program, inputs, vars) {
  const forbiddenHits = findForbiddenMatches(
    program,
    vars || null,
    settings.safety?.forbiddenPatterns || [],
  );
  if (forbiddenHits.length) {
    dispatch('safety:blocked', {
      pattern: forbiddenHits[0].pattern,
      where: forbiddenHits[0].where,
    });
    return { stdout: '', stderr: describeForbiddenHit(forbiddenHits[0]), code: -1 };
  }
  try {
    const body = {
      program,
      inputs: Array.isArray(inputs) ? inputs : [],
      vars: vars || {},
      binary: settings.exec.binary,
      args: settings.exec.args,
      timeoutMs: settings.exec.timeoutMs,
      maxOutputBytes: settings.exec.maxOutputBytes,
    };
    const r = await fetch('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    /** @type {any} */
    const data = await r.json().catch(() => ({}));
    if (!r.ok || typeof data.stdout !== 'string') {
      return {
        stdout: '',
        stderr: annotateSandboxStderr(
          data.error || `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`,
        ),
        code: -1,
      };
    }
    if (typeof data.stderr === 'string') data.stderr = annotateSandboxStderr(data.stderr);
    return data;
  } catch (e) {
    return { stdout: '', stderr: 'network error: ' + e.message, code: -1 };
  }
}

/**
 * Pretty-print a program via the server's /format endpoint
 * (`gawk --pretty-print`). Returns `{ formatted, stderr, code }`; a
 * non-zero `code` usually means a parse error — the caller should
 * surface `stderr` and leave the program untouched. `formatted` may
 * legitimately be empty for an empty input program.
 *
 * @param {string} program
 * @returns {Promise<{ formatted: string, stderr: string, code: number }>}
 */
export async function formatAwk(program) {
  try {
    const r = await fetch('/format', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program }),
    });
    /** @type {any} */
    const data = await r.json().catch(() => ({}));
    if (!r.ok || typeof data.formatted !== 'string') {
      return {
        formatted: '',
        stderr: data.error || `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`,
        code: -1,
      };
    }
    return data;
  } catch (e) {
    return { formatted: '', stderr: 'network error: ' + e.message, code: -1 };
  }
}

/**
 * If stderr looks like a gawk sandbox rejection, append a short note
 * explaining how to restart the server with sandbox disabled. gawk signs
 * every sandbox-triggered fatal with the literal phrase "sandbox mode"
 * (redirection, system(), pipe getline, dynamic loads — they all surface
 * via that wording), so a single substring test catches the whole family
 * without false positives on regular runtime errors.
 *
 * @param {string} stderr
 * @returns {string}
 */
function annotateSandboxStderr(stderr) {
  if (!stderr || !/sandbox mode/i.test(stderr)) return stderr;
  return (
    stderr.replace(/\s+$/, '') +
    '\n\n' +
    'Hint: sandbox mode (gawk --sandbox) blocks side effects:\n' +
    '- system() calls,\n' +
    '- file redirections (print > "…", print >> "…"),\n' +
    '- pipe I/O (print | "cmd", "cmd" | getline),\n' +
    '- getline from a file, and\n' +
    '- @load.\n\n' +
    'To allow them, stop the server and restart in unsafe mode:\n' +
    '  npm run start:unsafe\n' +
    '  # or equivalently:\n' +
    '  UNSAFE_AWK=1 npm start'
  );
}
