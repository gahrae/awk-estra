// @ts-check
// DOM + platform primitives, toast notifications, pulse, safe localStorage,
// textarea editing helpers. No app-level state.

import { IDENT_RE } from './data.js';

/** @typedef {import('./types.js').Param} Param */

/**
 * document.querySelector shorthand. Returns `any` so callers can access
 * element-subtype properties (e.g. `.value` on inputs) without casting —
 * selectors are known-good at each call site.
 * @param {string} s
 * @returns {any}
 */
export const $ = (s) => document.querySelector(s);
/** @returns {string} 8-char random id */
export const uid = () => Math.random().toString(36).slice(2, 10);
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/**
 * First-run sample text seeded into the initial tab. Exported as a
 * function (not a constant) because `MOD_LABEL` is platform-dependent
 * and the caller needs the string that was *actually* seeded — used
 * both by the seeder in main.js and by `isScratchInitialTab`, which
 * treats a tab still holding this exact content as replaceable.
 */
export function welcomeSampleText() {
  return `# Try me!
# 1. Select some lines below.
# 2. Press ${MOD_LABEL}+K.
# 3. Type an awk program, e.g.   { print toupper($0) }
# 4. Click Apply (or press Ctrl+Enter) to replace the selection.
#
# Or: click a snippet on the left to run it on the selection.
# Or: click → on snippets to add them to the pipeline, then Run.

apple
banana
cherry
apple
date
banana
elderberry
`;
}

/**
 * Staleness guard for async workflows where only the most recent invocation's
 * result should be applied (typing-driven previews, live search, etc.).
 *
 * Usage:
 *     const guard = createStalenessGuard();
 *     async function preview() {
 *       const token = guard.claim();
 *       const r = await fetchThing();
 *       if (!guard.isCurrent(token)) return; // a newer call superseded us
 *       // ...apply r
 *     }
 *
 * Contract:
 * - `claim()` bumps the generation and returns the new token; any in-flight
 *   workflow holding an older token is now stale.
 * - `isCurrent(token)` must be called after every `await`; returning `false`
 *   means a newer `claim()` happened and the caller should bail without
 *   touching shared UI/state.
 *
 * @returns {{ claim: () => number, isCurrent: (token: number) => boolean }}
 */
export function createStalenessGuard() {
  let gen = 0;
  return {
    claim: () => ++gen,
    isCurrent: (token) => token === gen,
  };
}

/**
 * Fill a UL with a single muted "empty state" row. Clears any existing
 * children. Used by sidebar lists when the source is empty or filtered to
 * nothing.
 * @param {HTMLElement} ul
 * @param {string} text
 */
export function showListPlaceholder(ul, text) {
  ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'list-placeholder';
  li.textContent = text;
  ul.appendChild(li);
}

/**
 * Keyed reconciler for lists of items with string `id`s. Reuses existing
 * `<li data-id=...>` nodes across renders so focus, hover state, and
 * outstanding CSS transitions on action buttons survive a re-render. Also
 * avoids the cost of rebuilding large lists node-by-node.
 *
 * Non-keyed children (e.g. a placeholder `<li>` from a prior empty render)
 * are cleared before reconciliation.
 *
 * @template T
 * @param {HTMLElement} ul
 * @param {Array<T & {id: string}>} items  Items in the order they should appear.
 * @param {() => HTMLLIElement} create     Builds a fresh `<li>` skeleton.
 *                                         Must not populate per-item state; the
 *                                         reconciler sets `data-id`, then calls
 *                                         `update`.
 * @param {(li: HTMLLIElement, item: T) => void} update
 *                                         Refreshes mutable fields (title,
 *                                         active class, etc.) on a reused or
 *                                         freshly-created `<li>`.
 */
export function reconcileKeyedList(ul, items, create, update) {
  const existing = new Map();
  for (const el of /** @type {HTMLLIElement[]} */ (Array.from(ul.children))) {
    const id = el.dataset && el.dataset.id;
    if (id) existing.set(id, el);
    else el.remove();
  }
  let anchor = null;
  for (const item of items) {
    let li = existing.get(item.id);
    if (!li) {
      li = create();
      li.dataset.id = item.id;
    }
    update(li, item);
    existing.delete(item.id);
    const expected = anchor ? anchor.nextSibling : ul.firstChild;
    if (li !== expected) ul.insertBefore(li, expected);
    anchor = li;
  }
  for (const el of existing.values()) el.remove();
}

/**
 * Escape HTML text-content metacharacters. Null/undefined pass through as "".
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- textarea editing (undo-preserving) ----------
/**
 * Replace the current selection in `ta` with `text`. Uses execCommand for
 * native undo-stack preservation, falling back to direct assignment.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {string} text
 */
export function editText(ta, text) {
  ta.focus();
  const ok =
    typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!ok) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * Replace [start, end) in `ta` with `text`, preserving undo.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {number} start
 * @param {number} end
 * @param {string} text
 */
export function editTextRange(ta, start, end, text) {
  ta.focus();
  ta.setSelectionRange(start, end);
  editText(ta, text);
}

/**
 * Wire Tab-as-indent on a textarea, with the standard "Esc, Tab" escape
 * hatch so the textarea is not a keyboard trap (WCAG 2.1.2).
 *
 * Behaviour:
 *   - No selection (or selection within one line): Tab inserts `\t`;
 *     Shift+Tab outdents the current line.
 *   - Multi-line selection: Tab indents every line in range, Shift+Tab
 *     outdents. Selection is restored to span the rewritten block so
 *     repeated presses keep working.
 *   - Modifier-Tab combos (Ctrl/Cmd/Alt+Tab) are left to the browser so
 *     OS / tab-strip / accessibility shortcuts still work.
 *   - Esc arms the next Tab to move focus out normally (one-shot, cleared
 *     by any other keydown). Esc itself is not consumed — global Esc
 *     handlers (palette/find-panel close) still see it.
 *
 * Outdent uses one leading `\t` if present, otherwise up to N leading
 * spaces where N is the textarea's effective `tab-size` CSS value
 * (defaults to 4). This keeps the helper self-contained — no need to
 * thread a settings reference through.
 *
 * @param {HTMLTextAreaElement} ta
 */
export function attachTabIndent(ta) {
  let suspended = false;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      suspended = true;
      return;
    }
    if (e.key !== 'Tab') {
      suspended = false;
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (suspended) {
      suspended = false;
      return; // let the browser move focus normally for this one Tab.
    }

    const value = ta.value;
    const s = ta.selectionStart;
    const eEnd = ta.selectionEnd;
    const multiline = s !== eEnd && value.slice(s, eEnd).includes('\n');

    if (!multiline && !e.shiftKey) {
      e.preventDefault();
      editText(ta, '\t');
      return;
    }

    e.preventDefault();
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const lineEndIdx = value.indexOf('\n', eEnd === s ? eEnd : eEnd - 1);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split('\n');

    let updated;
    if (e.shiftKey) {
      const tabSize = parseInt(getComputedStyle(ta).tabSize, 10) || 4;
      updated = lines
        .map((line) => {
          if (line.startsWith('\t')) return line.slice(1);
          let i = 0;
          while (i < tabSize && line[i] === ' ') i++;
          return line.slice(i);
        })
        .join('\n');
    } else {
      updated = lines.map((line) => '\t' + line).join('\n');
    }
    if (updated === block) return;

    editTextRange(ta, lineStart, lineEnd, updated);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + updated.length;
  });
}

// ---------- safe localStorage ----------
/**
 * Timestamp (ms) of the last quota-exceeded toast. Used to throttle repeats
 * so a persistently-full quota doesn't spam the user with toasts on every
 * autosave.
 * @type {number}
 */
let _lastQuotaWarning = 0;
/**
 * localStorage.setItem with quota-error swallowing + throttled user toast.
 * @param {string} key
 * @param {string} value
 * @returns {boolean} true on success
 */
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    const isQuota =
      err &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 ||
        err.code === 1014);
    if (isQuota) {
      const now = Date.now();
      if (now - _lastQuotaWarning > 30000) {
        _lastQuotaWarning = now;
        try {
          showToast({
            title: 'Storage full',
            body: 'Browser localStorage quota exceeded — recent changes may not be saved. Export your library and consider removing large tabs or old snippets.',
            duration: 10000,
          });
        } catch (_) {
          /* toast may fail before DOM ready */
        }
      }
    }
    console.error('[localStorage] setItem failed', key, err);
    return false;
  }
}

// ---------- toast notifications ----------

/**
 * Build an empty toast element with the fixed structural DOM. The title /
 * body text and the `level-*` class are patched per-toast by showToast().
 * @returns {HTMLDivElement}
 */
function buildToastElement() {
  const toast = document.createElement('div');
  toast.className = 'toast';
  const content = document.createElement('div');
  content.className = 'toast-content';
  const title = document.createElement('div');
  title.className = 'toast-title';
  title.hidden = true;
  const body = document.createElement('div');
  body.className = 'toast-body';
  body.hidden = true;
  content.appendChild(title);
  content.appendChild(body);
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'toast-pin';
  pinBtn.title = 'Pin — stop auto-dismiss so you can read the full message';
  pinBtn.setAttribute('aria-pressed', 'false');
  pinBtn.textContent = '\u{1F4CC}'; // 📌
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.title = 'Dismiss';
  closeBtn.textContent = '×';
  toast.appendChild(content);
  toast.appendChild(pinBtn);
  toast.appendChild(closeBtn);
  return toast;
}

/**
 * @param {{ title?: string, body?: string, level?: 'error'|'info', duration?: number, dom?: Node }} [opts]
 */
export function showToast({ title, body, level = 'error', duration = 6000, dom } = {}) {
  let container = document.getElementById('toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toasts';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    // When a dialog closes, move the container back to document.body so
    // visible toasts aren't hidden inside the now-closed dialog.
    document.addEventListener(
      'close',
      (e) => {
        const c = document.getElementById('toasts');
        if (c && e.target instanceof HTMLDialogElement && c.parentNode === e.target) {
          document.body.appendChild(c);
        }
      },
      true,
    );
  }
  // If a modal dialog is open, re-parent the toast container into it so
  // toasts render above the dialog's ::backdrop (which covers everything
  // in document.body).
  const openDialog = document.querySelector('dialog[open]');
  const desiredParent = openDialog || document.body;
  if (container.parentNode !== desiredParent) {
    desiredParent.appendChild(container);
  }
  const toast = buildToastElement();
  toast.classList.add(`level-${level}`);
  const titleEl = /** @type {HTMLElement} */ (toast.querySelector('.toast-title'));
  const bodyEl = /** @type {HTMLElement} */ (toast.querySelector('.toast-body'));
  if (title) {
    titleEl.textContent = title;
    titleEl.hidden = false;
  }
  if (body) {
    bodyEl.textContent = body;
    bodyEl.hidden = false;
  }
  if (dom) toast.appendChild(dom);
  const close = () => {
    if (toast.parentNode) toast.remove();
  };
  /** @type {HTMLButtonElement} */
  (toast.querySelector('.toast-close')).addEventListener('click', close);
  // Pinning freezes the toast: auto-dismiss and mouseleave-restart are both
  // suppressed. The user clicks × when done. Re-clicking the pin unpins and
  // the toast stays visible (no auto-restart) — explicit dismiss only, so
  // the user can't accidentally trigger a late close by unpinning.
  const pinBtn = /** @type {HTMLButtonElement} */ (toast.querySelector('.toast-pin'));
  let pinned = false;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let timer = 0;
  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };
  pinBtn.addEventListener('click', () => {
    pinned = !pinned;
    pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    toast.classList.toggle('pinned', pinned);
    pinBtn.title = pinned
      ? 'Unpin (toast stays open until you click ×)'
      : 'Pin \u2014 stop auto-dismiss so you can read the full message';
    if (pinned) cancelTimer();
  });
  if (duration > 0) {
    timer = setTimeout(close, duration);
    toast.addEventListener('mouseenter', cancelTimer);
    toast.addEventListener('mouseleave', () => {
      if (pinned) return;
      timer = setTimeout(close, 2500);
    });
  }
  container.appendChild(toast);
}

/**
 * Stop Enter inside text inputs from submitting the enclosing
 * `<form method="dialog">` and closing the dialog. Applied to multi-field
 * editor dialogs (snippet / template / chain / …) because it's natural for a
 * user to press Enter after filling one field, not to expect the whole
 * dialog to close. Textareas keep their native Enter-inserts-newline; focus
 * on a submit button still activates it; Escape still closes.
 *
 * @param {HTMLElement | null} dialog
 */
export function preventEnterFormSubmit(dialog) {
  if (!dialog) return;
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = /** @type {Element} */ (e.target);
    if (!(t instanceof HTMLInputElement)) return;
    const type = (t.type || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') return;
    if (type === 'checkbox' || type === 'radio') return;
    e.preventDefault();
  });
}

// Comparator: favorites first, then case-insensitive by name.
/** @param {{name:string,favorite?:boolean}} a @param {{name:string,favorite?:boolean}} b */
export function favoriteThenName(a, b) {
  const af = a.favorite ? 0 : 1;
  const bf = b.favorite ? 0 : 1;
  if (af !== bf) return af - bf;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

// ---------- text helpers ----------
/**
 * @param {string} s
 * @param {number} n  0 or negative = pass through
 * @returns {{text:string, truncated:boolean, original:number}}
 */
export function truncateLines(s, n) {
  if (!n || n <= 0) return { text: s, truncated: false, original: 0 };
  const lines = s.split('\n');
  const hadTrailing = s.endsWith('\n');
  const total = hadTrailing ? lines.length - 1 : lines.length;
  if (total <= n) return { text: s, truncated: false, original: total };
  return { text: lines.slice(0, n).join('\n') + '\n', truncated: true, original: total };
}

// ---------- param-row dialog helpers ----------
/**
 * @param {HTMLElement} ul container the rows will populate
 * @param {Param[]} params mutated in place as the user edits
 * @param {() => void} [onChange] fired after a row-level mutation that
 *   the parent list's `input` listener wouldn't otherwise see — right
 *   now that's only the ✕ remove (row destruction doesn't bubble an
 *   `input` event). Typing in name / default inputs bubbles naturally
 *   so callers can keep relying on a delegated `ul.addEventListener(
 *   'input', …)` for those edits. Missing callback = legacy behaviour.
 */
export function renderParamRows(ul, params, onChange) {
  ul.innerHTML = '';
  params.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'param-row';
    li.innerHTML = `
      <input class="param-name" placeholder="name" spellcheck="false">
      <input class="param-default" placeholder="default (optional)" spellcheck="false">
      <button type="button" class="param-rm" title="Remove">✕</button>`;
    const nameEl = /** @type {HTMLInputElement} */ (li.querySelector('.param-name'));
    const defEl = /** @type {HTMLInputElement} */ (li.querySelector('.param-default'));
    nameEl.value = p.name || '';
    defEl.value = p.default || '';
    nameEl.addEventListener('input', () => {
      p.name = nameEl.value;
    });
    defEl.addEventListener('input', () => {
      p.default = defEl.value;
    });
    li.querySelector('.param-rm').addEventListener('click', (e) => {
      e.preventDefault();
      params.splice(i, 1);
      renderParamRows(ul, params, onChange);
      if (onChange) onChange();
    });
    ul.appendChild(li);
  });
}

/**
 * Remove rows without a valid identifier name. Returns a fresh array.
 * @param {Param[]} params
 * @returns {Param[]}
 */
export function cleanParams(params) {
  return params
    .filter((p) => p.name && IDENT_RE.test(p.name))
    .map((p) => (p.default ? { name: p.name, default: p.default } : { name: p.name }));
}

// ---------- event helpers ----------
/**
 * Return the nearest ancestor of the event target matching a selector.
 * Handles the type narrowing from `EventTarget` to `HTMLElement`.
 * @param {Event} e
 * @param {string} sel
 * @returns {HTMLElement | null}
 */
export function closestOn(e, sel) {
  const t = /** @type {Element | null} */ (e.target);
  return /** @type {HTMLElement | null} */ (t?.closest?.(sel) ?? null);
}

// ---------- in-app alert / confirm / prompt (non-blocking) ----------

/**
 * Non-blocking replacement for `window.alert` — surfaces the message as a
 * toast. Use 'info' level for neutral notifications, 'error' for failures.
 *
 * @param {string} body
 * @param {{title?:string, level?:'error'|'info', duration?:number}} [opts]
 */
export function appAlert(body, opts = {}) {
  showToast({ title: opts.title, body, level: opts.level || 'info', duration: opts.duration });
}

/**
 * Non-blocking replacement for `window.confirm`. Returns a promise that
 * resolves to `true` on OK, `false` on Cancel / Esc.
 *
 * Phrasing convention for callers (kept in one place so new dialogs
 * don't drift from the existing set):
 *   - `message`: a sentence-case question ending in `?`. Name the
 *     specific thing when it exists in state — `Delete snippet "X"?`,
 *     `Close "X"? Its content will be lost.`
 *   - `title`:   2-3 words, sentence case, no trailing punctuation —
 *     `Delete snippet`, `Clear program`, `Reset settings`.
 *   - `okLabel`: the specific action verb + noun where it clarifies
 *     (`Delete`, `Reset everything`, `Clear`). Omit to get the default
 *     `OK`, fine when the title already disambiguates.
 *   - `danger`:  true for anything destructive; paints the OK button
 *     red so the dangerous branch isn't the default-looking one.
 *
 * @param {string} message
 * @param {{title?:string, okLabel?:string, cancelLabel?:string, danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function appConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('app-confirm-dialog'));
    /** @type {HTMLElement} */ (dlg.querySelector('.app-confirm-title')).textContent =
      opts.title || 'Confirm';
    /** @type {HTMLElement} */ (dlg.querySelector('.app-confirm-message')).textContent = message;
    const ok = /** @type {HTMLButtonElement} */ (dlg.querySelector('.app-confirm-ok'));
    const cancel = /** @type {HTMLButtonElement} */ (dlg.querySelector('.app-confirm-cancel'));
    ok.textContent = opts.okLabel || 'OK';
    cancel.textContent = opts.cancelLabel || 'Cancel';
    ok.classList.toggle('danger', !!opts.danger);
    dlg.returnValue = '';
    dlg.showModal();
    setTimeout(() => ok.focus(), 10);
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    });
  });
}

/**
 * Modal choice with N buttons — the OK/Cancel `appConfirm` generalised to
 * three or more options. Reuses the same `<dialog>` chrome by rebuilding
 * its `<menu>` for this call and restoring afterwards. Returns the clicked
 * button's `value`, or `null` if the dialog was dismissed (Esc / backdrop).
 *
 * @param {string} message
 * @param {{
 *   title?: string,
 *   buttons: { value: string, label: string, primary?: boolean, danger?: boolean }[],
 * }} opts
 * @returns {Promise<string | null>}
 */
export function appChoose(message, opts) {
  return new Promise((resolve) => {
    const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('app-confirm-dialog'));
    /** @type {HTMLElement} */ (dlg.querySelector('.app-confirm-title')).textContent =
      opts.title || 'Choose';
    /** @type {HTMLElement} */ (dlg.querySelector('.app-confirm-message')).textContent = message;
    const menu = /** @type {HTMLElement} */ (dlg.querySelector('menu'));
    const originalHTML = menu.innerHTML;
    menu.replaceChildren();
    /** @type {HTMLButtonElement | null} */
    let primaryBtn = null;
    for (const b of opts.buttons) {
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.value = b.value;
      btn.textContent = b.label;
      if (b.primary) {
        btn.classList.add('primary');
        primaryBtn = btn;
      }
      if (b.danger) btn.classList.add('danger');
      menu.appendChild(btn);
    }
    dlg.returnValue = '';
    dlg.showModal();
    setTimeout(() => {
      if (primaryBtn) primaryBtn.focus();
      else /** @type {HTMLButtonElement | null} */ (menu.querySelector('button'))?.focus();
    }, 10);
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      // Restore the dialog's original Cancel/OK markup so subsequent
      // `appConfirm` calls find what they expect.
      menu.innerHTML = originalHTML;
      resolve(dlg.returnValue === '' ? null : dlg.returnValue);
    });
  });
}

/**
 * Non-blocking replacement for `window.prompt`. Two return shapes,
 * discriminated on whether the caller passes `extraActions`.
 *
 * Without `extraActions`: resolves to the entered string on OK or
 * `null` on Cancel / Esc — the classic prompt contract, unchanged.
 *
 * With `extraActions` (array of extra submit buttons inserted between
 * Cancel and OK): resolves to `{ action, text } | null`. `action` is
 * `'ok'` for the primary submit, or whichever button's `value` fired.
 *
 * JSDoc `@overload` discriminates the return type so callers that don't
 * use extras keep getting `string | null` — important because there are
 * several existing callers that `.trim()` the result.
 *
 * @overload
 * @param {string} message
 * @param {{title?:string, defaultValue?:string, placeholder?:string, okLabel?:string}} [opts]
 * @returns {Promise<string | null>}
 */
/**
 * @overload
 * @param {string} message
 * @param {{title?:string, defaultValue?:string, placeholder?:string, okLabel?:string, extraActions: {value:string,label:string,danger?:boolean}[]}} opts
 * @returns {Promise<{action:string, text:string} | null>}
 */
/**
 * @param {string} message
 * @param {{title?:string, defaultValue?:string, placeholder?:string, okLabel?:string, extraActions?: {value:string,label:string,danger?:boolean}[]}} [opts]
 * @returns {Promise<any>}
 */
export function appPrompt(message, opts = {}) {
  return new Promise((resolve) => {
    const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('app-prompt-dialog'));
    /** @type {HTMLElement} */ (dlg.querySelector('.app-prompt-title')).textContent =
      opts.title || 'Enter value';
    /** @type {HTMLElement} */ (dlg.querySelector('.app-prompt-message')).textContent = message;
    const input = /** @type {HTMLInputElement} */ (dlg.querySelector('.app-prompt-input'));
    input.value = opts.defaultValue || '';
    input.placeholder = opts.placeholder || '';
    const ok = /** @type {HTMLButtonElement} */ (dlg.querySelector('.app-prompt-ok'));
    ok.textContent = opts.okLabel || 'OK';

    // Insert any extra buttons between Cancel and OK so the visual
    // order reads Cancel ... extras ... primary, with destructive
    // actions (danger) sitting adjacent to the primary. Tracked so we
    // can remove them on close and leave the dialog's default layout
    // intact for the next caller.
    const menu = /** @type {HTMLElement} */ (dlg.querySelector('menu'));
    /** @type {HTMLButtonElement[]} */
    const extraButtons = [];
    const hasExtras = !!opts.extraActions?.length;
    if (hasExtras) {
      for (const a of /** @type {{value:string,label:string,danger?:boolean}[]} */ (
        opts.extraActions
      )) {
        const btn = document.createElement('button');
        btn.type = 'submit';
        btn.value = a.value;
        btn.textContent = a.label;
        if (a.danger) btn.classList.add('danger');
        menu.insertBefore(btn, ok);
        extraButtons.push(btn);
      }
    }

    // In a <form method="dialog"> with multiple submit buttons, Enter from
    // the input defaults to the *first* submit (Cancel) — which is wrong
    // for a prompt. Intercept Enter and close with 'ok' instead.
    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        dlg.close('ok');
      }
    };
    input.addEventListener('keydown', onKey);
    dlg.returnValue = '';
    dlg.showModal();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 10);
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      input.removeEventListener('keydown', onKey);
      for (const b of extraButtons) b.remove();
      const rv = dlg.returnValue;
      if (hasExtras) {
        if (!rv || rv === 'cancel') resolve(null);
        else resolve({ action: rv, text: input.value });
      } else {
        resolve(rv === 'ok' ? input.value : null);
      }
    });
  });
}

/**
 * Lightweight popover menu anchored at a viewport point. Resolves to the
 * selected item's `value`, or `null` if dismissed (Esc, outside click,
 * window blur, resize).
 *
 * Non-modal by design — kept in the normal paint flow with `position:fixed`
 * rather than a `<dialog>`, because a context menu should dismiss on any
 * click outside it (a `<dialog>`'s modal backdrop swallows those clicks).
 *
 * @param {{clientX:number, clientY:number}} anchor viewport coords, e.g. from a MouseEvent
 * @param {Array<{
 *   label?: string,
 *   value?: string,
 *   danger?: boolean,
 *   disabled?: boolean,
 *   separator?: boolean,
 * }>} items
 * @returns {Promise<string | null>}
 */
export function appContextMenu(anchor, items) {
  return new Promise((resolve) => {
    // Only one menu at a time. If a previous menu somehow leaked (shouldn't
    // happen, but defensive), remove it before opening a new one.
    for (const el of document.querySelectorAll('.context-menu')) el.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    /** @type {HTMLButtonElement[]} */
    const focusables = [];
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'context-menu-item';
      if (item.danger) btn.classList.add('danger');
      if (item.disabled) btn.disabled = true;
      btn.textContent = item.label || '';
      btn.setAttribute('role', 'menuitem');
      btn.tabIndex = -1;
      btn.addEventListener('click', () => close(item.value ?? null));
      btn.addEventListener('mouseenter', () => {
        if (!btn.disabled) btn.focus();
      });
      menu.appendChild(btn);
      if (!item.disabled) focusables.push(btn);
    }

    // Pre-place off-screen so we can measure before positioning.
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = anchor.clientX;
    let y = anchor.clientY;
    if (x + rect.width > vw - 4) x = Math.max(4, vw - rect.width - 4);
    if (y + rect.height > vh - 4) y = Math.max(4, vh - rect.height - 4);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    let resolved = false;
    function close(value) {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('contextmenu', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      menu.remove();
      resolve(value);
    }
    function onOutside(e) {
      if (!menu.contains(/** @type {Node} */ (e.target))) close(null);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
        return;
      }
      if (!focusables.length) return;
      const idx = focusables.indexOf(
        /** @type {HTMLButtonElement} */ (document.activeElement),
      );
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusables[(idx + 1 + focusables.length) % focusables.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusables[(idx - 1 + focusables.length) % focusables.length].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusables[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        focusables[focusables.length - 1].focus();
      } else if ((e.key === 'Enter' || e.key === ' ') && idx >= 0) {
        e.preventDefault();
        focusables[idx].click();
      }
    }
    function onBlur() {
      close(null);
    }
    function onResize() {
      close(null);
    }

    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('contextmenu', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    // Capture-phase scroll handler so inner scrollers (not just window) close.
    window.addEventListener('scroll', onResize, true);

    setTimeout(() => focusables[0]?.focus(), 0);
  });
}

// ---------- sidebar row error pulse ----------
/** @param {string} listId @param {string} itemId */
export function pulseSidebarRow(listId, itemId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(itemId) : itemId;
  const li = list.querySelector(`li[data-id="${safeId}"]`);
  if (!li) return;
  li.classList.remove('pulse-error');
  void (/** @type {HTMLElement} */ (li).offsetWidth);
  li.classList.add('pulse-error');
  setTimeout(() => li.classList.remove('pulse-error'), 1000);
}

/**
 * Positive sidebar signal for just-created library items: if the enclosing
 * `<section data-section="…">` is collapsed, expand it (and persist); scroll
 * the row into view; flash it with `.pulse-success`. Accepts a
 * render-delay so callers can fire the event that re-renders the list,
 * then request the highlight without racing against the reconcile.
 *
 * @param {object} opts
 * @param {string} opts.sectionKey  data-section value, e.g. 'chains'
 * @param {string} opts.listId      id of the <ul>, e.g. 'chains'
 * @param {string} opts.itemId      row's data-id
 */
export function highlightSidebarRow({ sectionKey, listId, itemId }) {
  // Defer one frame so any synchronously-dispatched render event has
  // finished rebuilding the list.
  requestAnimationFrame(() => {
    const section = /** @type {HTMLElement | null} */ (
      document.querySelector(`section[data-section="${sectionKey}"]`)
    );
    if (section && section.classList.contains('collapsed')) {
      section.classList.remove('collapsed');
      const head = section.querySelector('.section-head');
      if (head) head.setAttribute('aria-expanded', 'true');
      safeSetItem(`awk-estra-section-${sectionKey}`, '0');
    }
    const list = document.getElementById(listId);
    if (!list) return;
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(itemId) : itemId;
    const li = /** @type {HTMLElement | null} */ (list.querySelector(`li[data-id="${safeId}"]`));
    if (!li) return;
    // Walk up and open any collapsed tag-group <details> ancestors so the
    // pulse is actually visible. The library's toggle listeners persist the
    // newly-open state — reasonable UX for a just-saved item (the user
    // will want the group open going forward to find it).
    let anc = li.parentElement;
    while (anc && anc.id !== listId) {
      if (anc.tagName === 'DETAILS') {
        const det = /** @type {HTMLDetailsElement} */ (anc);
        if (!det.open) det.open = true;
      }
      anc = anc.parentElement;
    }
    li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    li.classList.remove('pulse-success');
    void li.offsetWidth;
    li.classList.add('pulse-success');
    setTimeout(() => li.classList.remove('pulse-success'), 1300);
  });
}
