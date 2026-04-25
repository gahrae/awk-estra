// @ts-check
// Shared JSDoc typedefs. This module has no runtime exports — it exists only
// so other modules can reference its types via
//   /** @typedef {import('./types.js').Snippet} Snippet */

/**
 * @typedef {Object} Param
 * @property {string} name
 * @property {string} [default]
 */

/**
 * @typedef {Object} Snippet
 * @property {string} id
 * @property {string} name
 * @property {string} program
 * @property {string} [description]
 * @property {Param[]} [params]
 * @property {boolean} [favorite]
 * @property {string[]} [tags] Lowercased, deduped tags for grouping
 *   (see state.js #normalizeTags). Empty array is not persisted.
 * @property {string} [shortcut] Normalized combo like "Ctrl+Shift+K" that
 *   runs this snippet against the current selection (see shortcuts.js).
 * @property {string} [shortcutInsert] Like `shortcut`, but runs the snippet
 *   with empty input and inserts stdout at the cursor. Mirrors the
 *   Ctrl+click behaviour on a sidebar snippet row.
 * @property {Test[]} [tests] Saved input/expected fixtures. Empty array
 *   is not persisted.
 */

/**
 * @typedef {Object} Test
 * @property {string} id
 * @property {string} [name]
 * @property {string} input
 * @property {string} expected
 * @property {Record<string,string>} [vars] Per-test overrides; missing
 *   var names fall back to the snippet's declared param defaults.
 * @property {boolean} [trimTrailingNewline] Per-test toggle: strip a
 *   single trailing "\n" from both expected and actual before comparing.
 */

/**
 * A chain step either references an existing snippet by id (`snippetId` set)
 * or carries its own inline awk program (`program` set). One of the two is
 * always present; both are typed as optional to avoid union-narrowing noise.
 *
 * @typedef {Object} ChainStep
 * @property {string} id  stable identifier — the key `Chain.stepVars`
 *   uses to hang per-step variable overrides off of. Backfilled by
 *   `ensureChainStepIds` on any legacy chain that predates the field.
 * @property {string} [snippetId]
 * @property {string} [program]
 * @property {string} [name]
 * @property {Param[]} [params]
 * @property {boolean} [disabled] when true, the step is skipped by every
 *   runner (chain run on selection/cursor, chain preview, chain tests) and
 *   omitted from shell exports — its program contributes nothing to the
 *   pipeline and its params are dropped from the chain's var list. Kept on
 *   the chain so it can be re-enabled later; behaves as though the step
 *   were deleted for every other purpose.
 */

/**
 * @typedef {Object} Chain
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {ChainStep[]} steps
 * @property {Record<string,string>} [vars] chain-level overrides for vars
 *   declared by any step. Missing keys fall back to the step's `default`
 *   (or the runtime prompt — see `resolveChainVars`).
 * @property {Record<string, Record<string,string>>} [stepVars] per-step
 *   overrides keyed by `ChainStep.id`. When set for a (step, name) pair,
 *   wins over `chain.vars[name]` and the step's declared default. See
 *   `resolveStepVars` in state.js for the full precedence order.
 * @property {string[]} [perStepNames] Names for which the user has
 *   engaged "Different per step?" mode in the chain dialog. Flips the
 *   `chain.vars` ↔ step-default precedence for that name — step
 *   defaults win, `chain.vars[name]` is a fallback for default-less
 *   steps only. Names appear here even when `stepVars` has no values
 *   for them (the user expanded but left inputs blank), so the mode
 *   survives a round-trip.
 * @property {boolean} [favorite]
 * @property {string} [shortcut] Normalized combo like "Ctrl+Shift+K" that
 *   runs this chain against the current selection (see shortcuts.js).
 * @property {string} [shortcutInsert] Like `shortcut`, but runs the chain
 *   with empty input and inserts stdout at the cursor.
 * @property {Test[]} [tests] Same fixture format as snippets — input fed
 *   through the full chain pipeline, expected = final output.
 */

/**
 * @typedef {Object} TextSnippet
 * @property {string} id
 * @property {string} name
 * @property {string} content
 * @property {boolean} [favorite]
 */

/**
 * @typedef {Object} Template
 * @property {string} id
 * @property {string} name
 * @property {string} body
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {boolean} [favorite]
 */

/**
 * @typedef {Object} Tab
 * @property {string} id
 * @property {string} title
 * @property {string} content
 * @property {'on'|'off'} [wordWrap]
 * @property {boolean} [pinned] pinned tabs sort leftmost and are skipped
 *   by bulk-close operations (others/left/right/all). Explicit closes
 *   (context-menu "Close", middle-click, x) still work.
 * @property {string} [sourceSnippetId] id of the text snippet this tab
 *   was opened from. Drives the dirty indicator dot (shown when the
 *   tab's content diverges from the snippet's content). Cleared
 *   implicitly when the snippet is deleted; relinked by "Save as new
 *   snippet" to point at the just-created snippet.
 * @property {boolean} [excluded] when true the tab is skipped when the
 *   toolbar input mode is "All Tabs". Users toggle it manually on any
 *   tab (scratchpads, notes) or implicitly on freshly created result
 *   tabs so output doesn't feed back into the next All-Tabs run.
 */

/**
 * Pipeline step — in-memory representation. May reference a snippet or
 * carry its own inline program. Cached output/error from the last run is
 * attached transiently.
 *
 * @typedef {Object} PipelineStep
 * @property {string} id
 * @property {string} [snippetId]
 * @property {string} [program]
 * @property {string} [name]
 * @property {Param[]} [params]
 * @property {string} [output]
 * @property {boolean} [errored]
 */

/**
 * @typedef {Object} RunResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} code
 */

/**
 * @typedef {Object} ExecSettings
 * @property {string} binary
 * @property {string[]} args
 * @property {number} timeoutMs
 * @property {number} maxOutputBytes
 */

/**
 * @typedef {Object} EditorSettings
 * @property {number} tabSize
 * @property {number} fontSize
 * @property {string} [fontFamily] CSS font-family stack written verbatim
 *   to `--editor-font-family`. Empty = inherit the CSS default
 *   (`'SF Mono', Monaco, Consolas, monospace`). Non-empty values are
 *   prepended to that default, so an unavailable chosen font cascades
 *   through gracefully.
 * @property {string} defaultNewTabText
 * @property {boolean} confirmCloseTabWithContent
 * @property {'dash'|'newline'|'none'} tabMergeSeparator separator inserted
 *   between target and source content during Shift+drop tab merge.
 *   dash = line containing '---'; newline = blank line; none = direct concat.
 * @property {boolean} confirmClearProgram
 * @property {boolean} confirmClearHistory
 * @property {'on'|'off'} defaultWordWrap
 * @property {boolean} lineNumbers
 * @property {boolean} paletteEnterApplies
 * @property {boolean} [stripTrailingNewline] when true, a single
 *   trailing \n is removed from awk output before it's written to the
 *   editor. Off by default — awk's `print` always adds a newline, and
 *   preserving it is the least-surprising default; users who want
 *   single-line-fragment transformations flip this on. Tests and
 *   pipeline intermediate streams see raw stdout regardless.
 */

/**
 * @typedef {Object} UiSettings
 * @property {string} theme id of the active theme (filename in
 *   public/themes/ without the .css extension — e.g. 'dark', 'light',
 *   'dracula'). Unknown ids render against the fallback palette in
 *   style.css's `:root` block rather than erroring out.
 * @property {'compact'|'normal'|'roomy'} [density] UI chrome density —
 *   scales button padding, sidebar row heights, and section-header
 *   padding via `body.density-<value>` CSS classes. Editor font-size
 *   is a separate setting (Editor → Font size) and isn't affected.
 * @property {number} defaultSidebarWidth
 * @property {boolean} referenceDefaultShown when true, the reference
 *   panel is visible by default inside snippet-edit / pipeline dialogs.
 *   Off by default (panel is hidden until the user opens it).
 * @property {boolean} paletteDefaultAdvanced
 * @property {boolean} showRestoreDefaults
 * @property {boolean} [showRunAllTests] when true (the default), the
 *   ▶ "Run all tests" button in the Snippets / Chains sidebar section
 *   headers is visible — provided the section actually has any tests
 *   attached. The button still stays hidden if no snippet / chain has
 *   a test, so turning the setting on doesn't surface a button that
 *   would do nothing.
 * @property {'add'|'move'} dragToTagMode
 * @property {Record<string, boolean>} sectionsExpanded keyed by sidebar
 *   section id (`snippets` / `chains` / `templates` / `text-snippets`);
 *   `true` = section starts expanded on load, `false` = collapsed.
 * @property {Record<string, boolean>} paletteSectionsExpanded keyed by
 *   palette list section id (`snippets` / `templates` / `history`);
 *   `true` = expanded on open, `false` = collapsed.
 * @property {'both'|'snippets'|'chains'} [runnerScope] which kinds the
 *   Ctrl+O runner lists on open. Toggled by the chips inside the runner
 *   dialog; saved back here so repeat opens land on the user's preferred
 *   mix. Defaults to 'both' when missing.
 * @property {boolean} [highlightGawkExtensions] when true (the default),
 *   the awk tokenizer / highlighter recognises gawk-specific keywords,
 *   builtins, and variables alongside POSIX ones — `gensub`, `asort`,
 *   `PROCINFO`, `IGNORECASE`, etc. Flip off for a pure-POSIX view when
 *   writing programs that must run under mawk or one-true-awk.
 * @property {boolean} [warnGawkOnly] when true (the default), insert
 *   actions that introduce gawk-only syntax (e.g. the Columns picker
 *   inserting `FIELDWIDTHS`) show a portability warning toast each time.
 *   Flip off to silence the warnings.
 * @property {boolean} [showGawkButtons] when true (the default), the
 *   buttons that insert non-POSIX (gawk-only) syntax — Fixed Columns…
 *   (FIELDWIDTHS) and Field Pattern… (FPAT) — appear across the
 *   command palette, snippet editor, and inline pipeline step editors.
 *   Flip off when targeting POSIX awk / mawk / one-true-awk. Syntax
 *   highlighting of gawk extensions is unaffected.
 * @property {boolean} [showFormatButton] when true (the default), the
 *   Format button that runs `gawk --pretty-print` against the current
 *   program is visible. Orthogonal to `showGawkButtons` since
 *   formatting cleans up existing code rather than inserting
 *   gawk-specific syntax.
 * @property {boolean} [formatReplaceTabs] when true (the default),
 *   the Format button replaces the leading run of tabs on each line
 *   of gawk's pretty-print output with `formatTabSpaces` spaces per
 *   tab. Tabs elsewhere on a line (comment bodies, trailing-comment
 *   alignment, regex literals) are left alone — they're user content,
 *   not indentation. Off lets gawk's native tab indentation through
 *   unchanged.
 * @property {number} [formatTabSpaces] number of spaces each leading
 *   tab is replaced with when `formatReplaceTabs` is on. Default 2;
 *   clamped to [1, 8] in the settings dialog.
 */

/**
 * @typedef {Object} PipelineSettings
 * @property {boolean} autoPreviewOnStepChange
 * @property {'stop'|'skip'} onError
 * @property {boolean} clearOutputsOnSelectionChange
 * @property {boolean} acceptDefaultsWithoutPrompting when true, chain runs
 *   silently use chain.vars / step defaults; when false, every declared var
 *   is prompted for (prefilled from chain/step) on each run.
 */

/**
 * @typedef {Object} SafetyTest
 * @property {string} id
 * @property {string} text the command to run through findForbiddenMatches.
 * @property {'prevent' | 'allow'} expect the verdict the user expects —
 *   `prevent` means at least one pattern should match; `allow` means no
 *   pattern should match.
 */

/**
 * @typedef {Object} SafetySettings
 * @property {boolean} requireManualPreview when true, no preview ever
 *   auto-runs; the user must explicitly click Run preview.
 * @property {boolean} [autoPreviewSideEffects] when true, the side-effect
 *   gate is disabled — programs containing pipes / `system()` / `getline`
 *   / `>` redirects still auto-preview on every keystroke. Only honoured
 *   when `requireManualPreview` is false (manual-only wins). Off by
 *   default: the side-effect gate is the main defence against a
 *   half-typed `system("rm …")` executing mid-keystroke in unsafe mode.
 * @property {string[]} forbiddenPatterns JavaScript regex sources,
 *   matched case-insensitively. If any matches the awk source or a var
 *   value, execution is blocked with an error. Lines starting with `#`
 *   are comments; blank lines and invalid regex entries are skipped
 *   (the latter with a console warning). See safety.js >
 *   findForbiddenMatches, awk.js > runAwk.
 * @property {SafetyTest[]} [tests] user-saved command checks — each test
 *   re-runs on every edit of the patterns list and surfaces a pass/fail
 *   badge, so the user can lock in "this should stay blocked / this
 *   should stay allowed" expectations alongside the regexes themselves.
 */

/**
 * @typedef {Object} Settings
 * @property {ExecSettings} exec
 * @property {EditorSettings} editor
 * @property {UiSettings} ui
 * @property {PipelineSettings} pipeline
 * @property {{ saveDebounceMs: number }} data
 * @property {{ maxLines: number }} preview
 * @property {{ runOnSave: boolean, showUnknownStatus: boolean }} tests
 * @property {SafetySettings} safety
 * @property {Record<string, string | null>} [systemShortcuts] user
 *   overrides for built-in keyboard actions (see `SYSTEM_ACTIONS` in
 *   shortcuts.js). Absent key = use default; string = override combo;
 *   empty string / null = disabled (no combo fires the action).
 * @property {{ fpat?: PresetRow[], timestamp?: PresetRow[] }} [presets]
 *   User-edited preset lists for the FPAT picker (`fpat`) and the
 *   strftime picker (`timestamp`). Absent = picker falls back to
 *   `DEFAULT_FPAT_PRESETS` / `DEFAULT_STRFTIME_PRESETS` in data.js.
 *   Managed by the Presets editor in settings/presets-editor.js.
 * @property {ScriptExportSettings} [scriptExport]
 *   Customisation for the snippet and chain dialogs' "Download script" button:
 *   whether to flatten each step's awk program onto one line, what
 *   file extension to use, and the template itself (with
 *   `{SCRIPT_NAME}` / `{AWK_PIPE_CMD}` / `{VARIABLES_BLOCK}` /
 *   `{STEP_NAMES_LIST}` / `{STEP_NAMES_LIST_NUMBERED}` /
 *   `{USAGE_EXAMPLE}` tokens). Does not affect the per-step /
 *   per-pipeline "Copy as shell" buttons — those stay one-line clipboard
 *   output.
 */

/**
 * @typedef {Object} ScriptExportSettings
 * @property {boolean} flatten If true, each step's awk program is
 *   collapsed via `flattenAwkProgram` before shell-quoting. If false,
 *   the program keeps its original newlines inside the `'…'` (shell
 *   literal strings tolerate embedded newlines).
 * @property {string} extension File extension appended to the sanitized
 *   chain name. A missing leading `.` is added; passing an empty string
 *   yields a filename with no extension.
 * @property {string} template The template body. Tokens of the form
 *   `{NAME}` are substituted at download time — see
 *   `DEFAULT_SCRIPT_EXPORT_TEMPLATE` in data.js for the full set.
 */

/**
 * A single preset row in `Settings.presets.{fpat,timestamp}`. `id` is
 * a stable identifier used by the picker to detect "this preset was
 * modified from its shipped default" and surface a per-row Reset button.
 *
 * @typedef {Object} PresetRow
 * @property {string} id
 * @property {string} label
 * @property {string} pattern
 * @property {string} description
 */

/**
 * @typedef {Object} ServerPolicy
 * @property {{ name: string, available: boolean }[]} binaries
 * @property {boolean} sandboxEnforced
 */

/**
 * @typedef {Object} AppState
 * @property {Snippet[]} snippets
 * @property {Chain[]} chains
 * @property {TextSnippet[]} textSnippets
 * @property {Template[]} templates
 * @property {Tab[]} tabs
 * @property {string|null} activeTabId
 * @property {PipelineStep[]} pipeline
 * @property {Record<string, string>} pipelineVars
 * @property {Record<string, Record<string, string>>} pipelineStepVars per-step
 *   variable overrides keyed by step id — mirrors `Chain.stepVars` so a chain
 *   loaded into the pipeline keeps its per-step values when re-run or exported.
 * @property {string[]} pipelinePerStepNames variable names that behave as
 *   per-step (mode flag) — mirrors `Chain.perStepNames`. Empty for pipelines
 *   not loaded from a per-step chain.
 * @property {number|null} activeStep
 * @property {Workspace[]} workspaces
 * @property {'currentTab'|'allTabs'} inputMode toolbar toggle that
 *   selects what awk runs consume as input. A visible text selection in
 *   the active tab always wins over this value (selection is processed
 *   in place). Not persisted — resets to 'currentTab' on page load so
 *   the multi-tab mode is never silently carried across sessions.
 */

/**
 * Named snapshot of the editor tab set — deep copy of `tabs` plus the
 * id that was active at save time. Loading replaces `state.tabs` /
 * `state.activeTabId` with these values verbatim. Each workspace has
 * its own uid; `savedAt` is the epoch-ms timestamp, used for display
 * and list ordering.
 *
 * @typedef {Object} Workspace
 * @property {string} id
 * @property {string} name
 * @property {Tab[]} tabs
 * @property {string|null} activeTabId
 * @property {number} savedAt
 */

export {};
