// @ts-check

/**
 * Central event bus for cross-module cohesion without import cycles. Every
 * named CustomEvent the app relies on is listed in `AppEventMap` below —
 * dispatchers and listeners agree on payload shape via `tsc -p
 * jsconfig.json`.
 *
 * Native DOM events (click, input, keydown, submit, change, focus, …) keep
 * using raw `addEventListener`. Only the app's own CustomEvent family
 * routes through this module — the family that previously surfaced as
 * plain `document.dispatchEvent(new CustomEvent('name', { detail }))`
 * calls spread across ten modules.
 *
 * Events ride on `document` (not `window`) for the same reason they
 * always did: every module has a reference to `document`, and `document`
 * is the most targeted root for an app-level bus.
 *
 * Adding a new event: add a property to `AppEventMap`, then dispatch/listen
 * with the new name — tsc errors until payload shapes agree at every site.
 */

/**
 * Shape of the `detail` carried by each named event. `void` means the
 * event carries no payload — dispatchers call `dispatch('name')` and
 * listeners receive `undefined`.
 *
 * Uses an inline object-type rather than `@property` lines so the hyphen-
 * and colon-bearing keys parse correctly in JSDoc: tsc treats quoted keys
 * inside an inline object type as literal string members of the resulting
 * `keyof AppEventMap`.
 *
 * Semantics (kept here so the single source of truth is next to the types):
 *
 * - `settings-saved` — Settings dialog committed a save. Consumers re-read
 *   `settings` and re-render any derived UI.
 * - `settings:edit-snippet` / `settings:edit-chain` — Settings dialog's
 *   "Edit {snippet,chain}" hyperlink fired. main.js closes the settings
 *   dialog and opens the corresponding editor.
 * - `editor-font-settings-changed` — Font family / tab-size changed
 *   without triggering a ResizeObserver reflow. Overlay `<pre>` elements
 *   re-copy styles in the same frame.
 * - `awk-vocabulary-changed` — Syntax-highlight vocabulary (POSIX vs.
 *   gawk extensions) swapped in place; attached highlighters re-paint.
 * - `pipeline:steps-changed` — Pipeline step list mutated (add / remove /
 *   reorder / inline edit). Palette recomputes its pipeline count.
 * - `pipeline:snippets-changed` / `pipeline:chains-changed` — a snippet/
 *   chain referenced by a pipeline step was created / renamed / deleted.
 *   Library + palette re-render affected sections.
 * - `library:snippets-changed` / `library:chains-changed` /
 *   `library:templates-changed` / `library:text-snippets-changed` — any
 *   mutation to the respective library section. Sidebar re-renders.
 * - `library:clone-chain-for-edit` — Detect-FS JSON toast action. main.js
 *   closes the host surface, clones the named chain with a source-aware
 *   name, and opens the clone for edit.
 * - `workspace:loaded` — Workspace restore completed. editor.js rebinds
 *   the editor surface to the newly-active tab.
 * - `tests:run` — a single snippet's or chain's tests finished running.
 *   main.js refreshes the per-row status dots.
 * - `tests:run-all` — run-all completed for a section. main.js re-renders
 *   the section so the "Failing" filter picks up state changes.
 * - `tests:reveal-snippet` / `tests:reveal-chain` — run-on-save failure:
 *   expand the ancestor section / tag group and scroll the row into view.
 * - `safety:blocked` — forbidden-pattern matcher short-circuited a run.
 *   main.js surfaces a toast with a quick-link into Settings → Safety.
 * - `input-mode:changed` — toolbar input-mode toggle flipped, or the
 *   selection-override state changed (i.e. a selection appeared or was
 *   cleared). The toggle re-renders its label; call sites that run awk
 *   query the mode at run time, so they don't need to listen.
 *
 * @typedef {{
 *   'settings-saved': void,
 *   'settings:edit-snippet': { snippetId: string },
 *   'settings:edit-chain': { chainId: string },
 *   'editor-font-settings-changed': void,
 *   'awk-vocabulary-changed': void,
 *   'pipeline:steps-changed': void,
 *   'pipeline:snippets-changed': void,
 *   'pipeline:chains-changed': void,
 *   'library:snippets-changed': void,
 *   'library:chains-changed': void,
 *   'library:templates-changed': void,
 *   'library:text-snippets-changed': void,
 *   'library:clone-chain-for-edit': {
 *     name: string,
 *     source: { kind: 'selection' } | { kind: 'tab', title: string },
 *   },
 *   'workspace:loaded': void,
 *   'tests:run': { snippetId?: string, chainId?: string },
 *   'tests:run-all': { summaries: unknown[] },
 *   'tests:reveal-snippet': { snippetId: string },
 *   'tests:reveal-chain': { chainId: string },
 *   'safety:blocked': { pattern: string, where: string },
 *   'input-mode:changed': void,
 * }} AppEventMap
 */

/**
 * Dispatch one of the app's named events. tsc checks that `detail`
 * matches the shape declared in `AppEventMap`.
 *
 * For payload-free events (`detail: void` in the map), call
 * `dispatch('name')`. For payload-bearing events, pass the detail object.
 *
 * @template {keyof AppEventMap} K
 * @param {K} name
 * @param {AppEventMap[K]} [detail]
 */
export function dispatch(name, detail) {
  document.dispatchEvent(
    detail === undefined ? new CustomEvent(name) : new CustomEvent(name, { detail }),
  );
}

/**
 * Subscribe to one of the app's named events. The handler receives the
 * unwrapped `detail` payload — callers rarely need the raw Event, and
 * unwrapping at the boundary keeps every listener site tight.
 *
 * Returns an `off()` function for callers that need to unsubscribe
 * (rare — most listeners are process-lifetime).
 *
 * @template {keyof AppEventMap} K
 * @param {K} name
 * @param {(detail: AppEventMap[K]) => void} handler
 * @returns {() => void}
 */
export function on(name, handler) {
  /** @param {Event} e */
  const wrapped = (e) => {
    const custom = /** @type {CustomEvent<AppEventMap[K]>} */ (e);
    handler(custom.detail);
  };
  document.addEventListener(name, wrapped);
  return () => document.removeEventListener(name, wrapped);
}
