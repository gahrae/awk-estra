# Architecture

A one-binary Node server wrapping `awk`, plus a vanilla-ES-module frontend
served from `public/`. No build step, no bundler, no framework. The deploy
unit is a directory.

```
┌──────────────────────────────────────────────┐
│ Browser (http://127.0.0.1:3000)              │
│  ┌────────────────────────────────────────┐  │
│  │ public/js/* — 31 ES modules            │  │
│  │  (editor, pipeline, sidebar, dialogs…) │  │
│  │  ↕  localStorage for library + settings│  │
│  └───────────────┬────────────────────────┘  │
│                  │ fetch(POST /run,/format;  │
│                  │       GET /health,/themes)│
└──────────────────┼───────────────────────────┘
                   │ loopback only (127.0.0.1)
┌──────────────────▼───────────────────────────┐
│ Node server (server.js, ~600 lines)          │
│  ┌──────────────────────────────────────────┐│
│  │ /run       → runAwk   ──┐                ││
│  │ /format    → fmtAwk   ──┤                ││
│  │                         ▼                ││
│  │              spawnWithCaps(cmd, args,    ││
│  │                stdinInput, opts)         ││
│  │              — timeout + byte caps +     ││
│  │                activeProcesses registry  ││
│  │ /health    → liveness + uptime           ││
│  │ /settings/ → list available awk binaries ││
│  │ /themes    → JSON list of loaded themes  ││
│  │ /themes.css→ concatenated theme CSS      ││
│  │ static     → serves public/ with CSP     ││
│  └─────────────┬────────────────────────────┘│
└────────────────┼─────────────────────────────┘
                 │ child_process.spawn
                 ▼
              gawk / awk / mawk
```

## Server

Single file, `server.js`. No dependencies beyond Node's standard library
(`http`, `fs`, `path`, `child_process`).

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/run` | Execute an awk program. Body: `{program, input, vars, binary, args, timeoutMs, maxOutputBytes}`. |
| `POST` | `/format` | Pretty-print an awk program via `gawk -o-`. Body: `{program, timeoutMs?, maxOutputBytes?}`. Returns `{formatted, stderr, code}` (same envelope shape as `/run`). Hard-coded to gawk — `mawk` / one-true-awk don't implement `--pretty-print`. Uses `-o-` (literal dash) rather than `--pretty-print=/dev/stdout` because Linux refuses to reopen a pipe's write end through `/proc/self/fd/1` (ENXIO) under `spawn()`, so the long form silently falls back to stderr under Node's stdio plumbing. |
| `GET` | `/health` | JSON: `{status, uptimeMs, activeProcesses, sandboxEnforced}`. |
| `GET` | `/settings/binaries` | List of `{name, available}` for gawk/awk/mawk + `sandboxEnforced` flag. |
| `GET` | `/themes` | JSON: `[{id, label}]` — one entry per `.css` file discovered in `public/themes/` at boot. Labels come from a `/* name: Foo Bar */` comment on the first line of each file, falling back to a title-cased id. |
| `GET` | `/themes.css` | Concatenation of every theme file — one stylesheet for the whole bundle, so the browser only makes one request and theme swaps are a pure `<html data-theme>` change (no network). |
| `GET` | any other path | Static file from `public/` with security headers. |

### `spawnWithCaps` — shared child-process primitive

Both `/run` (`runAwk`) and `/format` (`formatAwkProgram`) delegate the
timeout, byte-cap, registry, and truncation plumbing to
`spawnWithCaps(cmd, args, stdinInput, opts)`. The wrappers build argv
and massage the envelope shape; the helper owns everything else:

- Spawns the binary with `stdio: [stdinMode, 'pipe', 'pipe']`, where
  `stdinMode` is `'pipe'` when the caller passes a string (including
  `''`, used by `/run`) and `'ignore'` when the caller passes `null`
  (used by `/format`, which feeds the program via argv and doesn't
  read stdin).
- stdout/stderr are capped at `maxOutputBytes`; overflow truncates the
  stdout buffer, SIGKILLs the child mid-stream, and notes the cap in
  stderr. A `timeoutMs` deadline `SIGKILL`s the process with an
  annotated stderr line.
- Every child is added to a module-scoped `Set` (`activeProcesses`) so
  graceful shutdown can `SIGTERM` them on signal.
- Returns `{stdout, stderr, code, killed, truncated}`. Callers today
  fold the flags into their own envelope (`runAwk` → `{stdout, stderr,
  code}`, `formatAwkProgram` → `{formatted, stderr, code}`) so the
  wire shape stays uniform.

### `runAwk` contract (on top of `spawnWithCaps`)

- Server-controlled flags: `--sandbox` is always added for gawk runs
  unless the server was started with `--unsafe` or `UNSAFE_AWK=1`. The
  client cannot drop it — `sandbox: false` in the request body is
  ignored.
- Client-controlled parameters are validated: `binary` must be in
  `ALLOWED_BINARIES = ['gawk', 'awk', 'mawk']`, `timeoutMs` is clamped
  to `[100, 60000]`, `maxOutputBytes` to `[1024, 50MiB]`, `-v
  name=value` rejects names not matching `/^[A-Za-z_][A-Za-z0-9_]*$/`,
  and `args` are length- and NUL-filtered.

### Cross-cutting

- **CSRF**: `POST /run` rejects unless `Content-Type: application/json`
  and (if present) `Origin` matches `http://{Host}`. Both `127.0.0.1` and
  `localhost` resolve against their own Host header, so the usual
  local-dev hostnames work. A simple form submission cannot forge the
  JSON content-type (that requires a preflight).
- **Rate limit**: sliding-window limiter on `/run` and `/format` — both
  spawn gawk processes, so they share the bucket (100 req / 10 s per IP).
  Threat model is a runaway UI client (infinite preview loop), not an
  abusive remote — the server binds to loopback.
- **Headers**: every response carries CSP (`default-src 'self'`;
  `style-src` includes `'unsafe-inline'` for runtime `el.style.*` writes),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `base-uri 'self'`, `form-action 'self'`.
- **Graceful shutdown**: SIGTERM/SIGINT flip a `shuttingDown` flag
  (new requests get `503`), close the HTTP server, SIGTERM tracked awk
  children, force-kill holdouts after 2 s, exit.
- **Logging**: every response logs `[ISO] METHOD /url -> status (Nms)` to
  stderr via a small `log(...)` helper.

## Frontend

The frontend is a set of roughly single-responsibility ES modules under
`public/js/`. No framework; cross-module communication is either static
imports (for stateless helpers and exported functions) or named events
routed through `events.js` where a static edge would create a cycle.

| Module | Responsibility |
|---|---|
| `core.js` | DOM primitives (`$`), escape helpers, toast queue, `<dialog>` confirm/prompt/choose shims, `appContextMenu(anchor, items)` (non-modal keyboard-navigable popover), `safeSetItem` (quota-aware localStorage), staleness guard, reconciler, `preventEnterFormSubmit` helper. |
| `data.js` | Frozen `LS_KEYS` table, `DEFAULT_SETTINGS`, `AWK_REFERENCE`, keyword/builtin/var sets. Exports `DEFAULT_FPAT_PRESETS` / `DEFAULT_STRFTIME_PRESETS` used to seed `DEFAULT_SETTINGS.presets.{fpat,timestamp}` and to back the per-row "Reset to default" in the Presets editor. Re-exports seeds from `seeds/*.js` (snippets, chains, templates, text snippets). |
| `types.js` | Shared JSDoc typedefs (`Snippet`, `Chain`, `Settings`, …). No runtime exports. |
| `events.js` | `dispatch(name, detail)` + `on(name, handler)` typed wrappers over `document.dispatchEvent` / `addEventListener`. Owns the `AppEventMap` JSDoc typedef — the single source of truth for every named cross-module event and its payload shape. tsc enforces payload agreement between dispatchers and listeners. |
| `html.js` | Tagged-template `html\`…\`` helper that auto-escapes every interpolated value, passes through nested `html\`\`` fragments and arrays unmodified, and exposes a `raw(s)` escape hatch for trusted strings (pre-escaped highlighter output, author-controlled templates, etc.). Returns an `HtmlFragment` with a `toString()` so `el.innerHTML = html\`…\`` works via native string coercion. Reuses `core.escapeHtml`. ~95 LOC, no runtime deps. Migration is opt-in and incremental: sites that interpolate user content (`pipeline.js`'s step meta, and future additions) use `html\``; static templates and already-safe render paths can keep their plain backtick strings until they're next touched. |
| `state.js` | Mutable `state` object (snippets/chains/tabs/pipeline/…), `loadState` / `saveState`, `chainParamList`, `resolveChainVars`, `normalizeTags`, `allSnippetTags` / `allChainTags` / `allTemplateTags`, seed helpers (`seedSnippets` / `seedChains` / `seedTemplates` / `seedTextSnippets`, sharing `instantiateSeedChain` for `seedId` resolution) and `restoreDefaultSnippets` / `restoreDefaultChains` / `restoreDefaultTemplates` / `restoreDefaultTextSnippets`. Per-step chain-variable plumbing also lives here: `resolveStepVars(chain, step, overlay)` layers step default → `chain.vars` → `chain.stepVars[step.id]` → overlay, flipping the first two for names listed in `chain.perStepNames`; `chainParamUsage(chain)` walks the step list to report which steps declare each param name (with 1-based indices for step-numbered labels); `planChainVarsPrompt(chain, acceptDefaults)` emits one row per still-unsettled param, per-step-split when any step has a stored override so duplicate names don't collapse back into a single prompt; `applyChainPromptAnswers(rows, answers)` turns the flat answer map back into `{chainOverlay, stepOverlay}`; `ensureChainStepIds(chain)` back-fills ids on legacy chains; `pruneOrphanStepVars(chain)` drops `stepVars` entries for steps that no longer exist or params no longer declared, and strips `perStepNames` entries whose name isn't declared by any step. `pipelineParamList` / `collectPipelineVars` feed the legacy flat path; per-step pipeline consumers build a synth chain object and call `resolveStepVars` instead. |
| `settings/presets-editor.js` | Presets editor for the Settings dialog (Field patterns / Timestamp sub-sections). `setupPresetsEditor(settings)` seeds the working arrays from `settings.presets.{fpat,timestamp}` (falling back to `DEFAULT_FPAT_PRESETS` / `DEFAULT_STRFTIME_PRESETS` if the stored list is missing or empty), wires drag-reorder + add + delete + per-row Reset + Restore-defaults + live counter, and returns a `{ commit() }` handle. On dialog Save, `commit()` strips empty-label / empty-value rows, regenerates duplicate ids, and writes the staged edits back to `settings.presets`. Cancel requires no rollback because the live `settings` object isn't touched until commit. |
| `settings.js` | Persistent user prefs + server-policy fetch. Fires `settings-saved` on save. `loadSettings` runs `migrateLegacySettings` on the parsed blob before deepMerge, converting flipped-polarity keys (`hideGawkButtons` → `showGawkButtons`, `referenceDefaultHidden` → `referenceDefaultShown`, `hideFormatButton` → `showFormatButton`) so saved values survive the affirmative-phrasing rename. **Theme**: `resolveTheme(choice)` resolves `'auto'` (the default) via `matchMedia('(prefers-color-scheme: dark)')`; a module-level `matchMedia` listener re-applies the resolved theme mid-session when the OS flips and the user has auto selected. Theme live-preview swaps `<html data-theme="…">` on every select-change (resolving `'auto'` → `dark` / `light`) and reverts on close-without-save. **Font family & size**: `settings.editor.fontFamily` (empty = fallback stack) is written to `--editor-font-family` by `applySettings`; `--editor-font-size` gets `settings.editor.fontSize + 'px'`. Both have live-preview inside the dialog that captures `original*` on open and reverts on cancel. `clearStaleOverlayFontInlineStyles()` sweeps every `.hl-pre` to wipe stale `pre.style.fontFamily` / `pre.style.tabSize` inline overrides (left over from pre-fix builds) and dispatches `editor-font-settings-changed` so `editor.js` / `awk.js` re-run their `syncStyles` in the same frame — without the event, reflow-free setting changes (font-family, tab-size) don't retrigger the ResizeObserver-driven sync. **Density**: `applyDensity(density)` toggles `body.density-compact` / `body.density-roomy`; those classes override a two-layer set of CSS custom properties — hand-tuned `--density-btn-*` / `--density-sidebar-row-*` / `--density-tab-*` / etc. for specific surfaces, plus a global `--density-scale` (0.8 / 1 / 1.2) applied to most `font-size`/`padding`/`margin`/`gap` declarations via `calc(X * var(--density-scale, 1))` so new UI surfaces are density-aware by default. Delegates the **Presets editor** to `settings/presets-editor.js` — `setupPresetsEditor(settings)` returns a `{ commit }` handle that the Save path invokes. Owns the **Script export** fieldset directly (flatten checkbox, extension input, template textarea with a Reset-to-default button that hides while the live value matches the shipped default): reads `settings.scriptExport` into the dialog on open, commits the three fields back on Save. Dialog scroll resets to 0 on every open via two `requestAnimationFrame`s post-`showModal()` so the user lands at the top even after scrolling to Save the previous time. |
| `shortcuts.js` | `normalizeShortcut` (KeyboardEvent → canonical combo), `formatShortcut`, `matchesShortcut`, `isUsableCombo`, `findConflicts` (against snippets / app / system shortcuts; each conflict tagged `blocking`). Also owns the `SYSTEM_ACTIONS` registry (`openPalette`, `openRunner`, `find`, …) plus `effectiveSystemShortcuts(settings)` and `defaultSystemCombo(id)`, consumed by `main.js`'s keydown dispatcher and the System-shortcuts settings UI. |
| `awk.js` | Tokenizer + syntax-highlight overlay attachment; `runAwk(program, input, vars)` fetch wrapper (appends a short restart hint whenever stderr mentions `sandbox mode`); `formatAwk(program)` fetch wrapper for `POST /format` (normalises server-error envelopes to the same `{formatted, stderr, code}` shape `runAwk` does for runs); `flattenAwkProgram` collapses multi-line programs to a single line with valid `;` separators for the pipeline's shell-quoted export. Gates every run through the forbidden-pattern matcher in `safety.js` before hitting the server. BEGIN-block utilities: `findBeginBodyStartOffset` / `findBeginAssignmentRange` / `extractBeginIoAssignments` (used by Detect FS and Copy I/O). Input-shape detectors used by Detect FS: `detectFieldSeparator` (allowlist + punctuation discovery), `detectDefaultFsUsable` (whitespace fallback), `detectJsonArray`; plus `fsLabel` / `fsAwkLiteral` for toast rendering and awk string escaping. |
| `safety.js` | In-browser safety layer for unsafe mode. `findSideEffects` (tokenized scan for `system()` / pipe / `getline` / `>` redirects, used to gate auto-preview), `findForbiddenMatches` (case-insensitive regex blocklist with `#` comments and invalid-regex tolerance), `shouldGatePreview({ requireManualPreview, autoPreviewSideEffects })`, `DEFAULT_FORBIDDEN_PATTERNS`, plus two DOM helpers that keep safety.js pure (no cycle with `settings.js`): `renderManualPreviewPrompt(outEl, reason, onRun, onChangeSetting?)` — renders **Run preview** (primary) + a dim secondary **Change setting** link that the caller wires to `openSettingsDialog({ scrollTo: 'set-safety-manual-preview-row' | 'set-safety-auto-side-effects-row' })` so the flash frames the specific toggle rather than the whole fieldset; and `appendSafetyChangeSettingIfBlocked(containerEl, stderr, onChangeSetting)` — appended at every `stderr.textContent = …` render site across pipeline / dialogs / palette so the durable inline link remains once the `safety:blocked` toast fades. `isSafetyBlockedStderr(text)` + `SAFETY_BLOCKED_PREFIX` constant are the shared prefix check. |
| `editor.js` | Tabs (right-click menu, middle-click close, bulk close with single confirm, duplicate, pinning with leftmost sort, drag-reorder + Shift-drop merge, quick-switcher dialog with MRU-tiebreak ranking, dirty-dot vs. source text snippet, save-as-snippet, Ctrl-click for blank new tab), the overlay `<pre>` sync (transform-based), wrap toggle, find/replace panel, file drop, undo/redo buttons. |
| `workspaces.js` | Named workspaces — save/load/overwrite/rename/delete snapshots of the tab strip. Owns the workspaces dialog. Fires `workspace:loaded` after a load; editor.js subscribes to rebind the editor surface (event boundary avoids an editor ↔ workspaces cycle). |
| `pipeline.js` | Pipeline panel, auto-preview, inline-step dialog, shell-command export. Also exports `buildShellScriptFromTemplate(chainName, steps, vars, opts)` — the chain dialog's "Download script" button routes through it. Honours `settings.scriptExport`: `{SCRIPT_NAME}` / `{AWK_PIPE_CMD}` / `{VARIABLES_BLOCK}` / `{STEP_NAMES_LIST}` / `{STEP_NAMES_LIST_NUMBERED}` / `{USAGE_EXAMPLE}` tokens substitute in two passes (first pass swallows empty tokens sitting alone on a template line; second pass inline-substitutes all others). Per-step awk programs are optionally flattened via `flattenAwkProgram` per the `flatten` setting; filename is `sanitize(chainName) + normaliseExtension(extension)` with an empty extension yielding a dotless filename. Does NOT affect the per-step / per-pipeline `Copy shell` buttons — those continue to use `buildStepsShellCommand` for single-line clipboard output. Per-step chain variables render as numbered shell vars: `planChainScriptVars(chain)` walks declared params and emits a `name_N` var per using step when `opts.perStepNames` lists the name and ≥2 steps use it; `buildStepAwkInvocation` renders each step's `awk -v name="$name_N" …` line; a name-in-perStepNames that only one step uses falls back to the legacy unnumbered form so one-step cases don't grow a stray `_1`. Chain-to-pipeline loading carries per-step values through as first-class pipeline state rather than inlining them: `loadChainIntoPipeline` copies `chain.vars` / `chain.stepVars` / `chain.perStepNames` into `state.pipelineVars` / `pipelineStepVars` / `pipelinePerStepNames` and preserves chain step ids via `chainStepToPipelineStep`, so the pipeline UI mirrors the chain dialog's per-step rows and `resolveStepVars` finds the right overrides at run time. `appendChainToPipeline` assigns fresh step ids (so repeat appends of the same chain don't let `pipelineStepVars` entries cross-contaminate), remaps incoming step-var overrides to the new ids, and auto-promotes a name to per-step whenever pre-append resolved values disagree with the incoming chain's — `shouldPromoteOnAppend` encodes the decision (existing was already per-step, incoming declared per-step, or combined resolved values disagree) and `snapshotPipelineStepVar` writes per-step entries only when runtime resolution wouldn't already produce the same value from the step's own default or the post-merge chain-level fallback, keeping `pipelineStepVars` minimal. `resolvedByStepId` is the shared helper that joins a `chainParamUsage` map with a resolve function so existing and incoming values are computed uniformly. `savePipelineAsChain` round-trips the whole shape: step ids, per-step overrides (pruned of entries whose step id is no longer in the pipeline), the per-step names flag, and chain-level vars all flow back into the new chain. Step removal prunes the step's `pipelineStepVars` entry. |
| `dialogs.js` | Barrel re-exporting from `dialogs/*` plus the snippet / template / chain / run-vars modal editors themselves and their internal helpers (`wireTestsSection`, `wireSnippetFork`, `wireSnippetPreview`, `wireShortcutRow`, `renderChainDialogSteps`, `renderChainSnippetPicker`, `rememberSectionOpenState`, the template picker — `attachTemplatePicker` + `renderTemplateChipList` — etc.). The large picker widgets, the Format-button wiring, and the awk reference panel live in sibling files (see rows below) and are re-exported so existing `import … from './dialogs.js'` call sites continue to work unchanged. |
| `dialogs/pickers.js` | The four gawk-feature picker wiring helpers — `wireDetectFsButton`, `wireColumnsButton`, `wireFpatButton`, `wireStrftimeButton` — plus their self-contained internals. `wireDetectFsButton` encapsulates the JSON → FS → default-whitespace detection cascade and the four splice paths (replace existing FS, inject into existing BEGIN, scaffold on empty, prepend new BEGIN). The Columns picker (FIELDWIDTHS) supports click-to-toggle boundaries on a ruler or sample text, Auto-detect from columns-of-spaces alignment, and Fit to the widest full-input line; Insert splices `BEGIN { FIELDWIDTHS = "…" }` and appends `{ print $1, …, $N }` so the preview shows each field. The FPAT picker reads its preset list from `settings.presets.fpat` (seeded from `DEFAULT_FPAT_PRESETS`) — preset dropdown, live color-coded field preview (JS regex semantics — note that gawk's dialect differs in longest-match alternation, POSIX classes, and empty-match behaviour, so a future iteration should swap the preview for a real-awk call against the sample), plus `BEGIN { FPAT = "…" }` splice on Insert. The strftime picker reads its preset list from `settings.presets.timestamp` (seeded from `DEFAULT_STRFTIME_PRESETS`) with 13 presets, a live preview against "now" and a fixed reference moment (Tue 5 Mar 2024, 09:07:03) so padding codes exercise cleanly, and a collapsible 36-code cheatsheet; Insert drops `strftime("FORMAT")` at the cursor — an expression splice, not a BEGIN assignment. All three gawk-only pickers route through `showGawkInsertToast` — the portability toast carries a "Disable this warning" action button that opens Settings scrolled to `settings.ui.warnGawkOnly`. |
| `dialogs/format.js` | `wireFormatButton(btn, ta)` — shared by the snippet editor and the command palette. POSTs to `/format`, replaces the textarea content via `editTextRange` (one `Ctrl+Z` to undo), and optionally converts leading-tab indentation to spaces per `settings.ui.formatReplaceTabs` / `formatTabSpaces` (gawk emits tab-indented output; the program textarea can't type tabs, so the default is "replace with 2 spaces"). |
| `dialogs/reference.js` | `renderAwkReferenceInto(root)` plus the three mount-point wrappers (`renderSnippetReference`, `renderPaletteReference`, `renderInlineStepReference`). Per-section open state persists across panel opens and across the three surfaces that share this renderer via `LS_KEYS.REF_SECTIONS_OPEN`. |
| `tag-chip-input.js` | Self-contained chip widget used for tag entry in the snippet / chain / template dialogs (filter dropdown + "Create 'foo'" row + keyboard commit / remove). |
| `library.js` | Sidebar list rendering (`renderSnippets` / `renderChains` / `renderTextSnippets` / `renderTemplates`), tag-group actions (rename / clone / delete), drag-to-retag, sort-mode and bulk-group toggles. Exports `cloneChain(original, desiredName?)` — factored out of the sidebar Duplicate handler so both it and the Detect-FS-on-JSON "Clone chain for edit" flow share one path. |
| `palette.js` | `Ctrl+K` command palette: ad-hoc awk with live preview, pipeline mode, per-session vars. Hosts the same Detect FS / Fixed Columns / Field Pattern / Timestamp / **Format** picker buttons as the snippet editor via the shared `wireFormatButton` / `wireFpatButton` / … helpers from `dialogs.js`. Apply with no program (and no pipeline to carry the run) shows a "Nothing to run" toast and focuses the input. Writes to `#palette-input` go through `editTextRange` (execCommand-based) at every in-session site — snippet chip click, history restore, `paletteClear` after Apply / Add-to-pipeline / Save-as-snippet — so native Ctrl+Z / Ctrl+Y walk the textarea's undo stack; only the fresh-session reset in `openPalette` uses direct `.value = ''` to intentionally wipe the stack. Clicking a chip also calls `resetPaletteSearchAndSections()` which clears the filter and restores the three list sections to their persisted collapsed state. A `suppressSectionPersist` counter with a `setTimeout(0)` deferred decrement gates the `<details>` `toggle` event from rewriting LS during programmatic expansions — needed because the toggle fires on the task queue, so a synchronous `try/finally` flag would already have reset by the time the listener ran, polluting the stored preference. |
| `runner.js` | `Ctrl+O` Runner modal — typeahead over snippets + chains, one-click to run against the editor selection. Snippets / Chains chips scope the list; scope is persisted in `settings.ui.runnerScope`. Session-scoped **pin** (📌) toggles keep-open mode; **Shift+Enter** / Shift-click fires one keep-open run without latching the pin; both reset every open (intentionally not persisted — "sometimes I want a streak right now"). The dialog is **always closed before the run commits**, because a modal `<dialog>` marks outside-elements `inert` — without the close, `editTextRange(#editor, …)` inside `writeRunnerOutput` couldn't re-focus the editor and `execCommand('insertText')` fell through to the runner input, landing the transformation output in the dialog's text field instead. For keep-open runs the dialog is reopened via `reopenRunnerAfterRun(wasPinned)` after the write awaits and the selection re-snapshots. After a commit the written range `[start, start + stdout.length]` is reselected on `#editor` so a keep-open streak chains off the transformation; on final close the selection collapses to a caret after the last character. |
| `sidebar.js` | Section collapse toggles (`setupSectionToggles`, `expandSection`), drag-to-resize splitter. |
| `tests.js` | Runs snippet / chain tests, caches per-item pass/fail summaries, dispatches `tests:run` / `tests:run-all` events. |
| `import-export.js` | Library JSON round-trip. |
| `main.js` | Entry point. Loads state + settings, wires keyboard shortcuts, calls module `setup*` functions, auto-opens the welcome dialog on first launch. Owns the shared `setSidebarHidden(hidden)` helper that the `◀ Sidebar` button (inside `#sidebar`), the `▶` reveal button (absolute-positioned at the top-left of `#editor-area`, only visible when `body.sidebar-hidden`), and the `toggleSidebar` system shortcut all call. Hidden state persists under `LS_KEYS.SIDEBAR_HIDDEN` and is applied during init before the first paint so reloads don't flash the sidebar in. CSS collapses the main grid to a single `1fr` track while hidden — setting `grid-template-columns: 0 0 1fr` doesn't work because auto-placement would drop `#editor-area` into track 1 (0px) instead of track 3. |

### Module boundary rules

- **Stateless utilities live in `core.js` or `data.js`.** Other modules
  import them; they never import from other modules.
- **No module writes to another module's state.** `state.js` owns
  `state`; mutations happen through `state.js` exports or from call sites
  that hold the module's invariants (e.g. library renderers can assign
  `state.snippets = …` when the user deletes a row, but dialogs fire
  `dispatch('library:snippets-changed')` instead).
- **Circular edges are avoided by dispatching through `events.js`.**
  Every named cross-module event is declared in the `AppEventMap`
  JSDoc typedef in `events.js`, and dispatchers/listeners use its
  `dispatch(name, detail)` / `on(name, handler)` wrappers so tsc
  enforces payload agreement at every site. Adding a new event is a
  two-step change: add a property to `AppEventMap`, then dispatch and
  listen with the new name; tsc errors at every site until the shapes
  agree. The current event catalog (see `events.js` for payloads and
  semantics) covers settings lifecycle (`settings-saved`,
  `settings:edit-snippet`, `settings:edit-chain`), pipeline state
  (`pipeline:steps-changed`, `pipeline:snippets-changed`,
  `pipeline:chains-changed`), library mutations
  (`library:snippets-changed`, `library:chains-changed`,
  `library:templates-changed`, `library:text-snippets-changed`,
  `library:clone-chain-for-edit` — dispatched by the Detect FS JSON
  toast's action button, main.js closes the current dialog / palette,
  calls `cloneChain` with a source-aware name `(tab-title)` /
  `(selection N)`, and reopens the new chain in the chain dialog),
  workspaces (`workspace:loaded`), tests (`tests:run`, `tests:run-all`,
  `tests:reveal-snippet`, `tests:reveal-chain`), safety
  (`safety:blocked` — dispatched by `runAwk` when the forbidden-
  pattern matcher short-circuits a run; main.js turns it into a toast
  with a quick-link into Settings → Safety), and two editor-surface
  bridges (`awk-vocabulary-changed` — dispatched by `applySettings`
  after `rebuildAwkVocabulary` swaps the POSIX-vs-gawk-extensions sets
  in place; each attached highlighter re-runs against the new
  vocabulary — and `editor-font-settings-changed` — dispatched when
  font-family / tab-size change without triggering a ResizeObserver
  reflow; overlay `<pre>` elements re-copy styles in the same frame).
- **Renders are keyed reconcilers, not `innerHTML =` rebuilds.** The
  four sidebar lists and the tab strip reuse `<li data-id>` / `.tab`
  nodes across renders via `core.reconcileKeyedList`, so focus, hover,
  and outstanding transitions survive. Clicks are delegated to the
  container once per list.

## Data model

All user data lives in one `localStorage` blob under
`awk-estra-v1` (versioned for future migrations). Schema:

```ts
interface AppState {
  snippets: Snippet[];
  chains: Chain[];
  textSnippets: TextSnippet[];
  templates: Template[];
  tabs: Tab[];
  activeTabId: string | null;
  pipeline: PipelineStep[];
  pipelineVars: Record<string, string>;
  pipelineStepVars: Record<string, Record<string, string>>;  // per-step overrides, keyed by step.id — mirrors Chain.stepVars so a loaded chain's per-step shape survives
  pipelinePerStepNames: string[];                            // mode flag — mirrors Chain.perStepNames
  activeStep: number | null;
  workspaces: Workspace[];
}

interface Snippet {
  id: string;              // uid()
  name: string;
  program: string;         // awk source
  description?: string;
  params?: Param[];        // surfaced as -v NAME=VALUE at run time
  favorite?: boolean;
  tags?: string[];         // lowercased, deduped, sorted (see normalizeTags)
  shortcut?: string;       // normalized combo, e.g. "Ctrl+Shift+K" or "F3"
  tests?: Test[];          // input / expected fixtures, optional per-test vars
}

interface Param { name: string; default?: string; }

interface Test {
  id: string;
  name?: string;
  input: string;
  expected: string;
  vars?: Record<string, string>;       // overrides the snippet's defaults
  trimTrailingNewline?: boolean;
}

interface Chain {
  id: string; name: string;
  description?: string;
  steps: ChainStep[];      // sn.id refs or inline {program, params} — every step has an id
  vars?: Record<string, string>;            // chain-level overrides (flat mode default)
  stepVars?: Record<string, Record<string, string>>;  // per-step overrides, keyed by step.id
  perStepNames?: string[]; // var names whose `Different per step?` toggle is engaged — flips precedence so each step's default (or stepVars override) wins over chain.vars
  favorite?: boolean;
  tags?: string[];
  tests?: Test[];          // input → full pipeline → expected
}

interface ChainStep {
  id: string;              // required — stepVars keys on it
  snippetId?: string;      // or inline:
  name?: string;
  program?: string;
  params?: Param[];
}

interface PipelineStep {
  id: string;
  snippetId?: string;      // or inline:
  name?: string;
  program?: string;
  params?: Param[];
  output?: string;         // last-run intermediate
  errored?: boolean;
}

interface TextSnippet { id; name; content; favorite?; }
interface Template    { id; name; body; description?; tags?; favorite?; }
interface Tab         { id; title; content; wordWrap?: 'on'|'off'; pinned?: boolean; sourceSnippetId?; }
interface Workspace   { id; name; tabs: Tab[]; activeTabId; savedAt; }
```

Ancillary per-feature state (section collapse, sidebar width, dialog
sizes, welcome-seen flag, etc.) lives under its own key — see
`LS_KEYS` in `data.js`. Settings live under
`awk-estra-settings`.

### Persistence discipline

- Every `localStorage.setItem` call routes through
  `core.safeSetItem`, which swallows `QuotaExceededError` and fires a
  throttled toast (max one per 30 s).
- Debounced writes: the editor's `input` listener persists tab content
  through `saveState` on a 400 ms debounce (configurable). A
  `beforeunload` flush catches pending changes.
- Library mutations flush immediately via `saveState()` at each call
  site — these are user-initiated and low-frequency.

## The overlay editor trick

The main editor is a single `<textarea>` (so the browser owns selection,
caret, undo, IME, spellcheck). Syntax highlighting / find-match
highlighting are rendered via a transparent `<pre class="hl-pre">` in the
same grid cell, with a nested `<div class="hl-pre-inner">` whose CSS
transform mirrors the textarea's scroll offset. Transforms are composited,
so the overlay stays locked to the textarea through fast scrolling without
the one-frame lag that `pre.scrollTop = textarea.scrollTop` suffers from.

`scrollbar-gutter: stable` on both elements keeps content widths identical
so soft-wrap breaks at the same positions in both layers.

### Keeping the two layers in sync

Both the textarea and the overlay `<pre>` read `font-family`, `font-size`,
and `tab-size` from the same CSS custom properties
(`--editor-font-family`, `--editor-font-size`, `--editor-tab-size`),
resolved against the `.hl-textarea` / `.hl-pre` selectors. `syncStyles`
in `editor.js` (for `#editor`'s find-match overlay) and `awk.js` (for
every awk-program textarea with a highlighter) copies the **remaining**
per-textarea properties — padding, border widths, `font-size` (for the
reflow that fires the ResizeObserver), `font-weight`, `line-height`,
`letter-spacing` — as inline styles onto the `<pre>` so layout stays
aligned.

`tab-size` and `font-family` were deliberately removed from the inline-
sync list: they change without triggering reflow, so the ResizeObserver
doesn't fire, and a stale inline `pre.style.fontFamily` would override
the CSS rule the next time the user changed the setting — the
textarea would retypeset but the overlay wouldn't, producing "ghost
text" where selection rectangles landed at the new glyph widths but
visible glyphs painted at the old widths. `settings.js`'s
`clearStaleOverlayFontInlineStyles` wipes any inline `fontFamily` /
`tabSize` left over from a pre-fix build and dispatches
`editor-font-settings-changed`; both `syncStyles` callers listen for
that event to re-copy the (now-correct) computed padding / border /
font-size in the same frame as the custom-property change.

## Themes

Themes live as individual CSS files in `public/themes/`, each scoping its
rules under `[data-theme="<id>"]`. Activation is a single attribute
write on `<html>`; because every theme file can co-exist in the DOM
(only the matching selector wins), switching costs zero network.

```
┌──────────────────────────────────────────────────┐
│ public/themes/                                   │
│   dark.css      "/* name: Dark */                │
│                 [data-theme='dark'] {            │
│                   --bg: #1e1e1e; --text: …;      │
│                 }"                               │
│   light.css     ...                              │
│   dracula.css   ...                              │
│   tokyo-night.css ...                            │
│   catppuccin-mocha.css ...                       │
│   (16 total: 10 dark, 5 light, 1 high-contrast)  │
└──────────────────┬───────────────────────────────┘
                   │ scanned at boot + on any change
                   │   (fs.watch, 100ms debounce)
┌──────────────────▼───────────────────────────────┐
│ loadThemes() in server.js                        │
│  - reads public/themes/*.css                     │
│  - parses /* name: … */ header per file          │
│  - caches {list, allCss}                         │
│                                                  │
│ watchThemes() re-runs loadThemes on any          │
│   add/change/rename inside the directory;        │
│   persistent: false so it doesn't block exit.    │
│                                                  │
│  GET /themes    → [{id, label}, …]               │
│  GET /themes.css→ concatenation                  │
└──────────────────────────────────────────────────┘
```

The contract between `style.css` and theme files is "theme files set
CSS custom properties, style.css reads them." Besides the baseline set
(`--bg`, `--text`, `--panel`, `--border`, `--accent`, `--danger`,
`--btn-bg*`, `--tok-*`), a secondary set covers elements whose
theme-specific values don't reduce cleanly to the baseline — selection
tint (`--selection-bg`), primary-button text (`--primary-btn-text`),
the unsafe-mode banner (`--banner-bg` / `--banner-text` /
`--banner-link-hover` / `--banner-strong-text`), and per-field highlight
alphas for the Columns / FPAT dialogs (`--cp-field-0..5`, `--fp-field-0..5`).
Each has a dark-tuned default baked in via `var(--name, fallback)` in
style.css, so a theme file that only declares the baseline set still
renders correctly on a dark surface; light themes opt in to the rest.

Adding a theme: drop a new `.css` file in `public/themes/` and define
the variables you want to change under `[data-theme="<id>"]`. The
`watchThemes()` `fs.watch` on that directory re-runs `loadThemes()`
(debounced 100 ms) so the cache picks it up without a server restart;
the theme shows up in the dropdown on the next page load. Already-open
clients won't hot-swap — they need a refresh to re-fetch
`/themes.css` and `/themes`. If the filesystem doesn't support
`fs.watch`, the watcher setup is logged-disabled and the behaviour
reverts to "restart to pick up changes".

## Code formatting

The snippet editor's Format button runs the current program through
`gawk --pretty-print` server-side (`POST /format`; see endpoint table
above). Two client-side wrinkles worth noting:

- **Tab → spaces**. gawk pretty-prints with hard tabs for indentation,
  but the program textarea drops `Tab` keystrokes to the next focusable
  element rather than inserting a tab character — so raw tabs produce
  output the user can't hand-edit. After the server response lands,
  `wireFormatButton` strips only the leading run of tabs on each line
  via `/^\t+/gm`, replacing each with `settings.ui.formatTabSpaces`
  spaces (default 2, clamp `[1, 8]`). Inline tabs inside comments,
  between code and a trailing `#` comment (gawk inserts an alignment
  tab there), and raw tabs inside a `/regex/` literal are left alone —
  they're user content, not indentation. String-literal tabs don't
  need to be handled specially because gawk emits them as the
  two-char escape `\t` in the pretty-printed source.
- **Undo survives**. The replacement goes through `editTextRange(ta,
  0, ta.value.length, formatted)` — a single native edit — so one
  `Ctrl+Z` restores the pre-format source. On a parse error (non-zero
  exit from gawk) the textarea is left untouched and the gawk stderr
  surfaces in an `appAlert`.

## Testing

`node:test` suite in `test/`. 243 tests across twelve files:

- `test/unit/core.test.js` — escape helpers, staleness guard.
- `test/unit/awk-tokenize.test.js` — tokenizer + regex-context detection +
  `flattenAwkProgram` (shell-copy single-line collapse: inserts `;`
  between statements separated by newlines, drops comments, respects
  continuation punct / `&&` / `||` / `else` / `do` / control-expression
  closing parens / `\` line continuation) +
  `extractBeginIoAssignments` / `findBeginBodyStartOffset` (used by the
  inline-step "Copy I/O settings from preceding steps" button — walks
  top-level assignments inside `BEGIN { … }` for the cross-step vars
  `FS` / `OFS` / `RS` / `ORS` / `FIELDWIDTHS` / `FPAT` / `CONVFMT` /
  `OFMT`, handling nested braces, strings containing `}` / `;`, and
  trailing line comments).
- `test/unit/state.test.js` — chain/pipeline param resolution, including
  per-step variables: `resolveStepVars` precedence under flat vs per-step
  mode, `planChainVarsPrompt` row generation (chain-global vs per-step-
  split when any step has a stored override), `applyChainPromptAnswers`
  round-trip, and `pruneOrphanStepVars` cleanup on step / param removal.
- `test/unit/tests-module.test.js` — chain test runner under per-step
  chains: `resolveChainTestVars(chain, step, test)` resolves the right
  value for each step of a chain run, and test-level `vars` still win
  over everything else as an explicit per-test overlay.
- `test/unit/reconcile.test.js` — DOM reconciler (`core.reconcileKeyedList`):
  identity-preservation on reorder / reuse, eviction of strays without
  `data-id`, append / delete / empty-input round-trips. Uses a small
  in-test DOM stub (`test/dom-stub.js`, ~50 LOC) rather than jsdom —
  the reconciler only touches ~6 DOM APIs so a full browser env would
  be overkill.
- `test/unit/shortcuts.test.js` — `normalizeShortcut` / `matchesShortcut`
  / `isUsableCombo` / `resolveMod` / `formatShortcut`. Fake KeyboardEvent
  objects (no DOM needed) cover canonical-modifier-ordering, single-char
  uppercasing, named keys, the F1–F24 policy, Shift-only bans on
  single-char keys, and the `Mod+` → platform resolution.
- `test/unit/tokenizer-cross-consumer.test.js` — the single tokenizer in
  `awk.js` feeds three consumers (syntax highlight, `safety.findSideEffects`,
  `flattenAwkProgram`). These tests protect the invariant that all three
  agree on string / regex / comment boundaries: e.g. `|` inside a string
  literal must not trigger `'pipe to command'`; `#` inside a regex must
  not be stripped as a comment. Catches silent tokenizer drift that would
  otherwise let the auto-preview gate disagree with what the highlighter
  paints.
- `test/unit/script-export.test.js` — `buildShellScriptFromTemplate`
  (chain dialog's "Download script" button). Covers every template
  token (`{SCRIPT_NAME}`, `{AWK_PIPE_CMD}`, `{VARIABLES_BLOCK}`,
  `{STEP_NAMES_LIST}`, `{STEP_NAMES_LIST_NUMBERED}`,
  `{USAGE_EXAMPLE}` — including the nested `{SCRIPT_NAME}` expansion
  inside `{USAGE_EXAMPLE}`), the flatten on/off toggle (multi-line
  awk round-trips verbatim inside single quotes when off), extension
  normalisation (no-dot → add dot, empty → no dot, multi-segment like
  `.tar.gz` passes through), and filename-stem sanitisation. Also
  covers the per-step shell-var machinery: `perStepNames` with ≥2
  using steps emits numbered `name_N="${name_N:-default}"` vars with
  each step's awk invocation wired to its own slot; a `perStepNames`
  entry used by only one step stays unnumbered; flat chains (no
  `perStepNames`) keep the legacy single-var shape. Pipeline-shell
  regressions (`buildPipelineShellCommand`) lock in that
  `state.pipelineStepVars` + `state.pipelinePerStepNames` carry
  through so Copy-as-shell produces distinct `cmd=base64` /
  `cmd=base64 -d` invocations after a chain is loaded into the
  pipeline.
- `test/server.test.js` — spawns the server on an ephemeral port, asserts
  HTTP contracts (health, CSRF on `/run` and `/format`, happy-path format
  output, rate limit, 404/405). The rate-limit test runs last in its
  file because it deliberately fills the shared bucket for the test IP
  and would 429-poison any `/run` or `/format` test that ran after it.

Overlay `syncStyles` wiring is still not tested directly — that one
genuinely needs a layout engine (computed styles, ResizeObserver) that
jsdom doesn't provide either.

`public/js/package.json` carries `{"type": "module"}` so Node resolves the
client modules as ESM without affecting the CommonJS server.
