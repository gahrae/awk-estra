# Security

## Threat model

Awk-estra is a **local single-user developer tool**. The server binds
to `127.0.0.1` and is never exposed to a network. The user has a shell on
the same host and could run any awk program directly; the server exists to
give them a UI, not to add a privilege boundary on top of `awk`.

The threats we defend against:

1. **Cross-origin attacks from a malicious site the user visits in the
   same browser session.** The user's browser can reach
   `http://127.0.0.1:3000`. A page on `evil.example` could try to submit
   forms or `fetch()` requests to it. A successful `POST /run` would
   execute arbitrary awk on the user's machine — and with most awk
   variants, that means file reads / writes / `system()`.
2. **A buggy or runaway client (this app's own UI).** Infinite preview
   loops, pathological regexes, runaway pipelines.
3. **An XSS regression in the frontend.** If user-controlled data ever
   reaches `innerHTML` unescaped, the resulting script could
   `fetch('/run', …)` and execute arbitrary awk via the same
   same-origin path the legit UI uses.
4. **An accidentally-listed, dangerous binary.** `checkBinary('/bin/bash')`
   would happily report bash as "available" because `bash --version` exits 0. The allow-list is the only thing keeping that out of `--binary`.

The threats we explicitly do **not** defend against:

- An attacker with shell access on the same machine. They can run awk
  directly.
- A compromised gawk binary on `PATH`. Trust in the awk we spawn is
  inherited from the OS.
- Browser zero-days.

## Trust boundary for `public/`

Anything under `public/` is trusted at the same level as the server
itself: the browser loads it with the app's origin, and any JS there
can reach `POST /run` without further checks. Concretely:

- **Static file serving follows symlinks.** `serveStatic` uses
  `fs.readFile`; a symlink planted in `public/` resolves to its target
  before we read it. A user who can write into `public/` can therefore
  exfiltrate arbitrary files off the local machine through the web
  view. This is intentional: the same user can just edit `public/js/*`
  and execute arbitrary JS in the browser, so a symlink read offers no
  additional capability.
- **Themes in `public/themes/`** are concatenated into `/themes.css`
  without sandboxing the CSS. A rogue theme file can style the app but
  can't escape the CSP.

If you ever deploy awk-estra in a context where `public/` is writable
by someone other than the user running the server (e.g. shared dev
box), either `chmod` the directory to the server's user only, or fork
`serveStatic` to resolve + validate via `fs.realpath` before reading.

## CSRF posture

`POST /run` requires:

1. `Content-Type: application/json` (case-insensitive). HTML forms cannot
   send this without a CORS preflight, which the server doesn't honor for
   cross-origin requests, so the browser blocks the request before it
   reaches us. Plain HTML form submissions with `text/plain` /
   `application/x-www-form-urlencoded` / `multipart/form-data` are
   rejected with `403`.
2. **`Origin` header is required, and must match the request `Host`.**
   Origin is set by the browser on every `fetch` and on cross-origin
   form submissions; it can't be spoofed by a webpage. A request from
   `evil.example` to `127.0.0.1:3000` would carry
   `Origin: https://evil.example` and fail the comparison. Non-browser
   clients (curl, HTTP libraries) must supply the header explicitly:
   `-H "Origin: http://127.0.0.1:3000"`. A missing Origin is rejected
   with `403` — browsers always send it, so the only clients that hit
   that branch are tools that can set it on request.

Combined with `Content-Security-Policy: default-src 'self'`, a successful
attack would require either (a) a same-origin XSS in our own frontend
(see below), (b) a browser bug, or (c) the user explicitly disabling
both.

## Sandbox

By default the server adds `--sandbox` to every `gawk` invocation.
`gawk --sandbox` disables `system()`, `getline` from a command, and
`print > "file"` redirections. That's the strongest guarantee available
without containerization.

```bash
npm start             # gawk --sandbox enforced (default)
npm run start:unsafe  # drop --sandbox
UNSAFE_AWK=1 npm start  # equivalent
```

The sandbox flag is **server-controlled, not client-controlled**. A
`{"sandbox": false}` field in a `/run` request body is silently ignored;
the server consults its own startup configuration.

`/settings/binaries` exposes the current `sandboxEnforced` value
read-only so the UI can surface the policy in the settings dialog.

When gawk returns a sandbox rejection (stderr containing the phrase
`sandbox mode` — covers `system()`, file redirections, pipe I/O, file
`getline`, and `@load`), `runAwk` in the browser appends a short hint
listing what's blocked and the `npm run start:unsafe` / `UNSAFE_AWK=1
npm start` commands. UX affordance only — the sandbox policy itself
remains server-controlled.

### Sandbox limits

`--sandbox` is a `gawk`-only flag. **Selecting `awk` or `mawk` runs the
program unsandboxed**, even when the server enforces `--sandbox` policy
overall. The settings dialog notes this; the server doesn't refuse the
selection. If you need uniform enforcement, restrict
`ALLOWED_BINARIES` in `server.js` to `['gawk']` only.

A program that needs to escape the sandbox can still consume
arbitrary CPU and produce arbitrary output. Resource caps below address
that surface.

## In-browser safety layer (unsafe mode only)

When the server is started with `--unsafe` — or when the user picks
`awk` / `mawk` as the binary, which is silently unsandboxed — the
frontend turns on three complementary UX safeguards. These are **not
security boundaries**; they address the self-foot-gun that auto-preview
creates (typing `system("rm -rf /")` letter-by-letter fires partial
commands, typing `system("mkdir a")` creates `a`, `ap`, `app`, …). A
determined author with local shell access can bypass all of them
trivially by string concatenation or by running awk directly; the
explicit goal is "you shouldn't be able to destroy your laptop with a
typo in the preview pane", not "this program cannot run dangerous
code".

1. **Side-effect gate.** `findSideEffects` in `safety.js` tokenizes the
   program and detects constructs that reach outside awk (`system()`,
   `getline`, `|`, `|&`, `print > "…"`). If any is present, auto-preview
   stops firing on keystroke and shows an explicit **Run preview**
   button instead. The user can opt back into auto-preview via
   **Settings → Safety → Auto-preview programs with side effects** if
   the friction isn't worth it.
2. **Forbidden-pattern blocklist.** Before every run, `findForbiddenMatches`
   tests the awk source and every variable value against a
   case-insensitive regex list seeded with 10 families of destructive
   commands (`rm -rf /`, `mkfs`, `dd of=/dev/…`, `curl … | sh`, and
   more). Hits short-circuit the request before it leaves the browser.
   The list is user-editable and supports `#` comments; invalid regex
   entries are skipped with a console warning. A live "Test a command"
   input and a pinned "Saved command checks" section let the user
   verify and regression-test their regex list without reading the
   regexes.
3. **Unsafe-mode banner.** A persistent red banner at the top of the
   page surfaces the sandboxEnforced-false state with a direct link
   into the safety settings.

The authoritative defenses remain the server-side sandbox flag, the
CSRF posture, and the resource caps. The in-browser layer makes unsafe
mode *survivable* during a long editing session; it does not make it
safe in the way the sandbox does.

## Resource limits on `/run`

| Limit             | Value                        | Purpose                                       |
| ----------------- | ---------------------------- | --------------------------------------------- |
| Request body size | 50 MiB                       | DoS via giant input.                          |
| `timeoutMs`       | clamped to `[100, 60000]`    | Wall-clock cap; `SIGKILL` on expiry.          |
| `maxOutputBytes`  | clamped to `[1 KiB, 50 MiB]` | stdout/stderr cap; truncate + note in stderr. |
| Rate limit        | 100 runs / 10 s per IP       | Cap on a runaway client looping previews.     |

Truncation marks the response so the client can warn the user. The
deadline kills the process — its parent cleans up the `Set` of tracked
children.

## Frontend hardening

- **CSP**: `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; connect-src 'self';
frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The one
  loosening is `'unsafe-inline'` on `style-src` for runtime
  `el.style.foo = …` writes. There is no `'unsafe-inline'` on
  `script-src`, so an XSS sink that injects an `<script>` tag is blocked.
- **`X-Content-Type-Options: nosniff`**, **`Referrer-Policy: no-referrer`**,
  **`X-Frame-Options: DENY`** on every response.
- **Render discipline.** Every `innerHTML` template literal in the
  frontend has been audited (#16 in the code review). User-supplied
  strings (snippet names, template names, awk programs) are written via
  `textContent`, `createElement`/`appendChild`, or `escapeHtml`. The one
  call site that intentionally writes trusted HTML
  (`renderAwkReferenceInto`) carries a docstring naming the boundary.
- **`pulseSidebarRow`** uses `CSS.escape` on the `data-id` value before
  composing a `[data-id="…"]` selector.

## Operational notes

- The server logs every response to stderr with method, path, status, and
  duration. Useful for spotting unexpected `/run` traffic.
- `/health` exposes `activeProcesses` (in-flight awk children) and
  `sandboxEnforced` so external monitors can sanity-check the policy at
  any time.
- Graceful shutdown SIGTERMs all tracked awk children on SIGTERM/SIGINT,
  force-kills holdouts after 2 s. No orphan `awk` processes survive a
  signal.
- Library state lives in browser `localStorage`, not on the server. The
  server is fully stateless — it can be restarted at any time without
  losing user data.

## Reporting an issue

This is a personal/developer tool with no public deployment. If you find
a security issue and would like to discuss it privately, open a confidential
issue or contact the author directly.
