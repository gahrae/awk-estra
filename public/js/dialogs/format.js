// @ts-check
// Format button wiring. Used by the snippet editor dialog AND the command
// palette to run a program through `gawk --pretty-print` server-side (via
// `POST /format`). Self-contained: no sibling dialog deps.

import { appAlert, editTextRange, showToast } from '../core.js';
import { formatAwk } from '../awk.js';
import { settings } from '../settings.js';

/**
 * Wire a "Format" button to a program textarea. Click runs the current
 * program through `gawk --pretty-print` server-side; on success replaces
 * the textarea content via a single `editTextRange` edit so one `Ctrl+Z`
 * rolls back. On parse error the gawk stderr surfaces in an `appAlert`
 * and the textarea is left untouched.
 *
 * Leading-tab indentation is converted to spaces per
 * `settings.ui.formatReplaceTabs` / `formatTabSpaces` (default 2 spaces,
 * clamp `[1, 8]`): gawk emits tab-indented output, but the program
 * textarea drops Tab keystrokes to the next focusable element, so raw
 * tabs leave the output un-editable by hand. Only leading indentation
 * is touched — tabs inside comments, between code and a trailing `#`
 * comment, or inside a regex literal pass through unchanged. String-
 * literal tabs don't need special handling because gawk emits them as
 * the two-char escape `\t`.
 *
 * @param {HTMLButtonElement | null} btn
 * @param {HTMLTextAreaElement} ta
 */
export function wireFormatButton(btn, ta) {
  if (!btn) return;
  btn.onclick = async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    btn.disabled = true;
    try {
      const result = await formatAwk(ta.value);
      if (result.code !== 0 || !result.formatted) {
        const detail = (result.stderr || '').trim();
        appAlert(
          detail
            ? `gawk --pretty-print failed:\n\n${detail}`
            : 'gawk --pretty-print returned no output. Is gawk installed on the server?',
          { level: 'error', title: 'Format failed' },
        );
        return;
      }
      // gawk indents with hard tabs but the program textarea drops Tab
      // keystrokes to the next focusable element, so raw indentation
      // leaves the user with output they can't hand-edit. Replace only
      // the leading run of tabs on each line — everything after the
      // first non-tab character is user content that may legitimately
      // contain tabs:
      //   - comments preserve raw tabs verbatim ("# a\tb")
      //   - pretty-print inserts an alignment tab between code and a
      //     trailing same-line comment
      //   - /regex/ literals with a raw tab survive as a raw tab
      // String literals are the only place tabs get escaped to `\t`
      // automatically — everything else would be silently mangled by a
      // global replace.
      let formatted = result.formatted;
      if (settings.ui.formatReplaceTabs !== false) {
        const n = Number.isFinite(settings.ui.formatTabSpaces)
          ? Math.max(1, Math.min(8, settings.ui.formatTabSpaces))
          : 2;
        const spaces = ' '.repeat(n);
        formatted = formatted.replace(/^\t+/gm, (run) => spaces.repeat(run.length));
      }
      if (formatted === ta.value) {
        showToast({
          title: 'Already formatted',
          body: 'gawk --pretty-print produced output identical to the current program.',
          level: 'info',
          duration: 2500,
        });
        return;
      }
      editTextRange(ta, 0, ta.value.length, formatted);
      ta.dispatchEvent(new Event('input'));
      showToast({
        title: 'Formatted',
        body: 'Program reformatted via gawk --pretty-print. Ctrl+Z to undo.',
        level: 'info',
        duration: 2500,
      });
    } finally {
      btn.disabled = false;
    }
  };
}
