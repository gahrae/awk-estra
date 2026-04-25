// @ts-check
// Awk reference panel — shared renderer for the snippet editor dialog, the
// inline-step dialog, and the command palette. Owns per-section open-state
// persistence via localStorage.

import { $, safeSetItem } from '../core.js';
import { AWK_REFERENCE, LS_KEYS } from '../data.js';

/**
 * Render the awk reference panel into the given root. Section titles come
 * in as plain text and are set via `textContent`. Item bodies in
 * `AWK_REFERENCE` intentionally contain `<code>` markup — that data is
 * author-controlled (hard-coded in `data.js`), so assigning via
 * `innerHTML` is the trust boundary. If item content ever becomes
 * user-supplied, this function must be revisited.
 *
 * Per-section open state persists across panel opens and across the three
 * surfaces (snippet / inline-step / palette) that share this renderer.
 * Default is collapsed; only explicit user toggles are recorded.
 *
 * @param {HTMLElement} root
 */
export function renderAwkReferenceInto(root) {
  root.replaceChildren();
  /** @type {Record<string, boolean>} */
  let openMap = {};
  try {
    const raw = localStorage.getItem(LS_KEYS.REF_SECTIONS_OPEN);
    if (raw) openMap = JSON.parse(raw) || {};
  } catch (_) {
    // Corrupt LS entry for open-section state — default to all closed.
  }
  AWK_REFERENCE.forEach((s) => {
    const details = document.createElement('details');
    if (openMap[s.title]) details.open = true;
    details.addEventListener('toggle', () => {
      openMap[s.title] = details.open;
      safeSetItem(LS_KEYS.REF_SECTIONS_OPEN, JSON.stringify(openMap));
    });
    const summary = document.createElement('summary');
    summary.textContent = s.title;
    details.appendChild(summary);
    const ul = document.createElement('ul');
    for (const it of s.items) {
      const li = document.createElement('li');
      li.innerHTML = it; // trusted author data — see docstring
      ul.appendChild(li);
    }
    details.appendChild(ul);
    root.appendChild(details);
  });
  const footer = document.createElement('div');
  footer.className = 'ref-footer';
  const label = document.createElement('div');
  label.textContent = 'More:';
  footer.appendChild(label);
  const ul = document.createElement('ul');
  for (const link of [
    { href: 'https://awk.js.org/help.html', text: 'awk.js.org/help' },
    {
      href: 'https://www.gnu.org/software/gawk/manual/gawk.html',
      text: 'GNU Awk User’s Guide',
    },
  ]) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = link.text;
    li.appendChild(a);
    ul.appendChild(li);
  }
  footer.appendChild(ul);
  root.appendChild(footer);
}

export function renderSnippetReference() {
  renderAwkReferenceInto($('#snippet-reference'));
}

export function renderPaletteReference() {
  renderAwkReferenceInto($('#palette-reference'));
}

export function renderInlineStepReference() {
  renderAwkReferenceInto($('#inline-step-reference'));
}
