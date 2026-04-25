// @ts-check
// Tagged-template helper that makes HTML-escaping the default at every
// interpolation site. Replaces the hand-rolled
// `` `…${escapeHtml(x)}…` `` pattern with `` html`…${x}…` `` —
// same output, but it's now impossible to forget the escape.
//
// No runtime dependencies, ~50 LOC, zero build step.
//
// Usage:
//
//   import { html, raw } from './html.js';
//
//   // Simplest: string coercion on innerHTML assignment calls
//   // toString(), which yields the escaped concatenation.
//   el.innerHTML = html`<span class="name">${userName}</span>: ${count}`;
//
//   // Nested templates opt out of re-escaping automatically.
//   ul.innerHTML = html`<ul>${items.map((it) => html`<li>${it.name}</li>`)}</ul>`;
//
//   // Arrays of templates are joined.
//   el.innerHTML = html`<ol>${rows}</ol>`; // rows: HtmlFragment[]
//
//   // Escape hatch for content you have already escaped or that comes
//   // from a trusted source (e.g. a syntax-highlighter's output).
//   el.innerHTML = html`<pre>${raw(highlightAwk(code))}</pre>`;
//
//   // Nullish / false interpolation renders as empty — handy for
//   // conditional chunks:
//   el.innerHTML = html`<p>${maybe && html`<b>${maybe}</b>`}</p>`;

import { escapeHtml } from './core.js';

/**
 * Marker class for template results and explicit `raw(...)` wraps. The
 * `html` tag returns one of these; when a renderer sees another
 * HtmlFragment in an interpolation slot, it passes the inner string
 * through unmodified — otherwise the value is coerced to string and
 * HTML-escaped.
 *
 * `toString()` lets call sites assign the result straight to
 * `.innerHTML` (the setter coerces via String()), so call sites read
 * as `el.innerHTML = html\`…\`` — no `.html` suffix needed.
 */
class HtmlFragment {
  /** @param {string} s */
  constructor(s) {
    /** @type {string} */
    this.html = s;
  }
  toString() {
    return this.html;
  }
}

/**
 * Tagged-template entry point. Every interpolated value is rendered
 * through `renderValue`, which HTML-escapes strings/numbers by default
 * and passes `HtmlFragment` through unmodified. Arrays are joined.
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {HtmlFragment}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new HtmlFragment(out);
}

/**
 * Escape hatch — mark a string as safe-to-interpolate-as-HTML without
 * further escaping. Use when the content is from a trusted source
 * (author-controlled data, a syntax highlighter that already escaped
 * every token, a pre-rendered template) — *never* for user input.
 *
 * @param {string} s
 * @returns {HtmlFragment}
 */
export function raw(s) {
  return new HtmlFragment(String(s));
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function renderValue(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) {
    let out = '';
    for (const item of v) out += renderValue(item);
    return out;
  }
  if (v instanceof HtmlFragment) return v.html;
  return escapeHtml(/** @type {string} */ (/** @type {unknown} */ (v)));
}
