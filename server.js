const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

const ALLOWED_BINARIES = ['gawk', 'awk', 'mawk'];
const MAX_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES_LIMIT = 50 * 1024 * 1024;
// /run request body cap. Generous because multi-file runs (toolbar
// "All Tabs" input mode) can pack several tab contents into `inputs[]`;
// the server binds to 127.0.0.1 so the threat is a runaway client, not
// an abusive remote, and the output/timeout caps already bound what a
// single run can do downstream.
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
// /format's body cap is tighter than /run's because the payload is just
// the awk program — source code, not input data. 10 MiB is already more
// than any sane awk program would hit, and a smaller cap here reduces
// the memory footprint of a surprise big-body request hitting the pretty-
// print path.
const MAX_FORMAT_BODY_BYTES = 10 * 1024 * 1024;
const SANDBOX_ENFORCED = !(process.argv.includes('--unsafe') || process.env.UNSAFE_AWK === '1');
const START_TIME = Date.now();

// Sliding-window rate limit on /run. This server binds to 127.0.0.1 so the
// threat model isn't an abusive remote — it's a runaway client (an infinite
// loop in the UI spamming previews) DoSing the local awk fleet. 100 runs / 10s
// is comfortably above normal interactive use (auto-preview debounce is
// 200ms+, palette typing bursts land in one compute via staleness guards) but
// tight enough to cap a runaway. On limit hit we 429 with a Retry-After.
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 10_000;
/** @type {Map<string, number[]>} */
const rateLimitBuckets = new Map();
function rateLimitCheck(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = rateLimitBuckets.get(ip) || [];
  // Drop expired entries (kept monotonic so the slice is contiguous).
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  const recent = i === 0 ? arr : arr.slice(i);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitBuckets.set(ip, recent);
    return Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
  }
  recent.push(now);
  rateLimitBuckets.set(ip, recent);
  return 0;
}

// Periodic sweep of stale rate-limit buckets. An IP that stops making
// requests would otherwise stay in the Map forever. 60s interval is well
// above the 10s window — every bucket found here is guaranteed expired.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, arr] of rateLimitBuckets) {
    if (!arr.length || arr[arr.length - 1] < cutoff) rateLimitBuckets.delete(ip);
  }
}, 60_000).unref();

// Track child awk processes so SIGTERM/SIGINT can kill them cleanly on
// shutdown. Any leaked process here would outlive the server otherwise.
/** @type {Set<import('child_process').ChildProcess>} */
const activeProcesses = new Set();

function log(...args) {
  // Route to stderr so it doesn't mix with anything a redirected stdout
  // consumer (e.g. a test harness) expects.
  console.error(`[${new Date().toISOString()}]`, ...args);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function headers(extra) {
  return Object.assign({}, SECURITY_HEADERS, extra);
}

function rejectCsrf(req) {
  const ct = String(req.headers['content-type'] || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (ct !== 'application/json') {
    return 'Content-Type must be application/json';
  }
  // Origin must be present AND match the request Host. Modern browsers
  // set Origin on every `fetch`/form POST automatically, so the only
  // clients that hit the "missing" branch are non-browser tools like
  // curl; those need to add `-H "Origin: http://127.0.0.1:3000"`
  // explicitly (documented in SECURITY.md → CSRF posture).
  const origin = req.headers.origin;
  const expected = `http://${req.headers.host || ''}`;
  if (!origin) {
    return 'Origin header is required';
  }
  if (origin !== expected) {
    return `Origin not allowed: ${origin}`;
  }
  return null;
}

/**
 * Core child-process primitive shared by `/run` and `/format`. Handles the
 * bookkeeping both paths need identically: timeout clamp + SIGKILL, stdout
 * byte cap with mid-stream SIGKILL on overflow, stderr byte cap, UTF-8
 * decode, and `activeProcesses` registration so graceful shutdown can reap
 * in-flight children.
 *
 * `stdinInput === null` gives the child /dev/null on stdin (used by the
 * format path, which feeds the program via argv). Passing a string
 * (including `''`) pipes + closes stdin with that payload.
 *
 * Returned envelope carries the `killed` / `truncated` flags so callers can
 * choose whether to expose them — today both wrappers fold them into
 * `stderr` so the client sees one annotated channel.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string|null} stdinInput
 * @param {{ timeoutMs?: number, maxOutputBytes?: number, cwd?: string }} [opts]
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, killed:boolean, truncated:boolean}>}
 */
function spawnWithCaps(cmd, args, stdinInput, opts) {
  return new Promise((resolve) => {
    const cfg = opts || {};
    const timeoutMs = Math.max(100, Math.min(Number(cfg.timeoutMs) || 5000, MAX_TIMEOUT_MS));
    const maxOut = Math.max(
      1024,
      Math.min(Number(cfg.maxOutputBytes) || 1048576, MAX_OUTPUT_BYTES_LIMIT),
    );
    const stdinMode = stdinInput == null ? 'ignore' : 'pipe';

    let proc;
    try {
      const spawnOpts = { stdio: [stdinMode, 'pipe', 'pipe'] };
      if (cfg.cwd) spawnOpts.cwd = cfg.cwd;
      proc = spawn(cmd, args, spawnOpts);
    } catch (err) {
      return resolve({
        stdout: '',
        stderr: `spawn error: ${err.message}`,
        code: -1,
        killed: false,
        truncated: false,
      });
    }
    activeProcesses.add(proc);

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let truncated = false;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        // Child already exited before we could signal it — nothing to do.
      }
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      if (stdoutBuf.length + d.length > maxOut) {
        const remaining = Math.max(0, maxOut - stdoutBuf.length);
        stdoutBuf = Buffer.concat([stdoutBuf, d.slice(0, remaining)]);
        truncated = true;
        try {
          proc.kill('SIGKILL');
        } catch (_) {
          // Child already exited before we could signal it — nothing to do.
        }
      } else {
        stdoutBuf = Buffer.concat([stdoutBuf, d]);
      }
    });
    proc.stderr.on('data', (d) => {
      if (stderrBuf.length + d.length > maxOut) {
        const remaining = Math.max(0, maxOut - stderrBuf.length);
        stderrBuf = Buffer.concat([stderrBuf, d.slice(0, remaining)]);
      } else {
        stderrBuf = Buffer.concat([stderrBuf, d]);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      resolve({
        stdout: '',
        stderr: `spawn error: ${err.message}`,
        code: -1,
        killed,
        truncated,
      });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      // Buffer#toString() defaults to UTF-8: any invalid bytes produced by
      // the child (e.g. raw binary from a malicious awk input) become the
      // replacement character U+FFFD. Acceptable for this local UI — callers
      // who need byte-faithful output should use a different path.
      let stderr = stderrBuf.toString();
      if (killed && !truncated) stderr += `\n[killed: exceeded ${timeoutMs}ms timeout]`;
      if (truncated) stderr += `\n[output truncated: exceeded ${maxOut} bytes]`;
      resolve({ stdout: stdoutBuf.toString(), stderr, code, killed, truncated });
    });

    if (stdinInput != null) {
      try {
        proc.stdin.write(stdinInput);
        proc.stdin.end();
      } catch (_) {
        /* proc already exited */
      }
    }
  });
}

/**
 * Sanitize a caller-supplied filename to a safe basename. awk's FILENAME
 * builtin echoes whatever positional arg we pass, so preserving the
 * user's tab title here makes multi-file awk programs readable
 * (BEGINFILE / `FILENAME == "logs.txt"` matches the visible tab name).
 * We only need to neuter characters that would break writing the file
 * on disk or let awk mis-interpret the arg as an option.
 */
function sanitizeInputFilename(name, fallback) {
  let s = String(name == null ? '' : name);
  // Strip path separators + control bytes; they'd escape the tmpdir
  // (`../`) or corrupt the filename. Replaced with `_` rather than
  // dropped so "a/b" still reads distinctly from "ab".
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f/\\]/g, '_');
  // Leading dashes or a lone `.`/`..` would be misread as awk flags or
  // directory refs respectively.
  s = s.replace(/^[-.]+/, '');
  // Cap length so pathological tab titles don't hit the OS filename
  // limit. 120 leaves room for the tmpdir prefix inside PATH_MAX on
  // every supported platform.
  if (s.length > 120) s = s.slice(0, 120);
  return s || fallback;
}

/**
 * Normalize `inputs: [{name, content}]` into a disk-ready list: each
 * entry gets a sanitized, per-request-unique basename and the original
 * string content. Returns null on oversize (total bytes beyond the
 * same per-run output cap the caller already agreed to). Pure — no
 * filesystem writes here; the caller materializes.
 */
function prepareMultiInputs(inputs, maxBytes) {
  if (!Array.isArray(inputs) || !inputs.length) return [];
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {{ name: string, content: string }[]} */
  const prepared = [];
  let total = 0;
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i] || {};
    const raw = typeof item.content === 'string' ? item.content : '';
    total += Buffer.byteLength(raw, 'utf8');
    if (total > maxBytes) return { error: `inputs exceed ${maxBytes} bytes` };
    let base = sanitizeInputFilename(item.name, `input${i + 1}`);
    if (used.has(base)) {
      // Keep collisions visible in FILENAME ("log.txt" -> "log.txt~1")
      // so awk programs that key off FILENAME don't silently conflate
      // two differently-sourced tabs that happened to share a title.
      let n = 1;
      while (used.has(`${base}~${n}`)) n++;
      base = `${base}~${n}`;
    }
    used.add(base);
    prepared.push({ name: base, content: raw });
  }
  return prepared;
}

function runAwk(program, input, vars, opts) {
  const cfg = opts || {};
  const binary = ALLOWED_BINARIES.includes(cfg.binary) ? cfg.binary : 'gawk';

  const args = [];
  if (SANDBOX_ENFORCED && binary === 'gawk') args.push('--sandbox');
  if (Array.isArray(cfg.args)) {
    for (const a of cfg.args) {
      if (typeof a !== 'string' || a.length === 0 || a.length > 1000) continue;
      if (a.indexOf('\0') !== -1) continue;
      args.push(a);
    }
  }
  if (vars && typeof vars === 'object') {
    for (const [name, value] of Object.entries(vars)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      args.push('-v', `${name}=${value == null ? '' : String(value)}`);
    }
  }

  // Multi-file path: materialize each {name, content} into a tmpdir and
  // pass filenames as positional args after `--`. awk reads them in
  // order, resetting FNR / setting FILENAME per file and firing
  // BEGINFILE / ENDFILE hooks — the real multi-file semantics that
  // single-string stdin can't provide. When no inputs are given we
  // fall back to the existing stdin path so callers that pre-date the
  // feature keep working.
  const inputs = Array.isArray(cfg.inputs) ? cfg.inputs : null;
  if (inputs && inputs.length) {
    const maxBytes = Math.max(
      1024,
      Math.min(Number(cfg.maxOutputBytes) || 1048576, MAX_OUTPUT_BYTES_LIMIT),
    );
    const prepared = prepareMultiInputs(inputs, maxBytes);
    if (prepared && prepared.error) {
      return Promise.resolve({ stdout: '', stderr: prepared.error, code: -1 });
    }
    let tmpdir;
    try {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'awk-estra-'));
    } catch (err) {
      return Promise.resolve({
        stdout: '',
        stderr: `tmpdir error: ${err.message}`,
        code: -1,
      });
    }
    const basenames = [];
    try {
      for (const item of prepared) {
        const p = path.join(tmpdir, item.name);
        fs.writeFileSync(p, item.content);
        basenames.push(item.name);
      }
    } catch (err) {
      try {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      } catch (_) {
        // Best-effort tmpdir cleanup; a failed rm just leaves a dir
        // in /tmp that the OS will reap at its own pace.
      }
      return Promise.resolve({
        stdout: '',
        stderr: `write error: ${err.message}`,
        code: -1,
      });
    }
    // Pass bare basenames + set cwd so awk's FILENAME is the clean
    // tab-title sanitised name (e.g. `alpha.log`) instead of the tmp
    // absolute path. User programs keying off FILENAME read much
    // more naturally this way.
    args.push('--', program, ...basenames);
    return spawnWithCaps(binary, args, null, {
      timeoutMs: cfg.timeoutMs,
      maxOutputBytes: cfg.maxOutputBytes,
      cwd: tmpdir,
    }).then(
      ({ stdout, stderr, code }) => {
        try {
          fs.rmSync(tmpdir, { recursive: true, force: true });
        } catch (_) {
          // Best-effort tmpdir cleanup; a failed rm just leaves a dir
          // in /tmp that the OS will reap at its own pace.
        }
        return { stdout, stderr, code };
      },
      (err) => {
        try {
          fs.rmSync(tmpdir, { recursive: true, force: true });
        } catch (_) {
          // Best-effort tmpdir cleanup; a failed rm just leaves a dir
          // in /tmp that the OS will reap at its own pace.
        }
        throw err;
      },
    );
  }

  args.push('--', program);

  return spawnWithCaps(binary, args, input || '', {
    timeoutMs: cfg.timeoutMs,
    maxOutputBytes: cfg.maxOutputBytes,
  }).then(({ stdout, stderr, code }) => ({ stdout, stderr, code }));
}

/**
 * Run `gawk -o- -- <program>` and capture the pretty-printed source. gawk's
 * pretty-print parses the program and emits a canonical copy without
 * executing any actions (BEGIN included), so it is safe to call on
 * arbitrary user input — `--sandbox` is still passed as defense-in-depth.
 * Hard-coded to `gawk` because `mawk` / one-true-awk don't implement
 * `--pretty-print`.
 *
 * `-o-` (literal dash) rather than `--pretty-print=/dev/stdout`: Linux
 * refuses to re-open a pipe's write end through `/proc/self/fd/1` (ENXIO),
 * and gawk silently falls back to stderr with "sending profile to standard
 * error" under Node's stdio plumbing when given the long form.
 *
 * Returns `{formatted, stderr, code}` — same envelope shape as `/run` so
 * the client handles both uniformly.
 */
function formatAwkProgram(program, opts) {
  const cfg = opts || {};
  const args = ['-o-'];
  if (SANDBOX_ENFORCED) args.push('--sandbox');
  args.push('--', program);

  return spawnWithCaps('gawk', args, null, {
    timeoutMs: cfg.timeoutMs,
    maxOutputBytes: cfg.maxOutputBytes,
  }).then(({ stdout, stderr, code }) => ({ formatted: stdout, stderr, code }));
}

/**
 * Scan `public/themes/*.css` at startup and cache both the list of
 * themes (id + human label) and the concatenated CSS. The id is the
 * filename without extension; the label comes from an optional
 * `/* name: Foo Bar *\/` comment at the top of each file, falling
 * back to a title-cased id (`tokyo-night` → `Tokyo Night`). Themes
 * are expected to scope their rules under `[data-theme="id"]` so all
 * files can be loaded simultaneously and only the matching one wins.
 *
 * The cache is rebuilt on boot **and** on any change inside
 * `public/themes/` (see `watchThemes` below), so dropping a new `.css`
 * file in is picked up without a server restart — the next page load
 * gets it automatically.
 */
const THEMES_DIR = path.join(PUBLIC, 'themes');
/** @type {{ list: {id: string, label: string}[], allCss: string }} */
let themeCache = { list: [], allCss: '' };
function loadThemes() {
  let entries = [];
  try {
    entries = fs.readdirSync(THEMES_DIR, { withFileTypes: true });
  } catch (err) {
    log(`themes: unable to read ${THEMES_DIR}:`, err.message);
    return;
  }
  const list = [];
  const parts = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.css')) continue;
    const id = ent.name.slice(0, -4);
    let css;
    try {
      css = fs.readFileSync(path.join(THEMES_DIR, ent.name), 'utf8');
    } catch (err) {
      log(`themes: skipping ${ent.name}:`, err.message);
      continue;
    }
    const nameMatch = css.match(/\/\*\s*name:\s*(.+?)\s*\*\//);
    const label = nameMatch
      ? nameMatch[1]
      : id
          .split(/[-_]/)
          .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
          .join(' ');
    list.push({ id, label });
    parts.push(`/* ---- ${id} ---- */\n${css}`);
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  themeCache = { list, allCss: parts.join('\n\n') };
  log(`themes: loaded ${list.length} (${list.map((t) => t.id).join(', ')})`);
}
loadThemes();

/**
 * Watch `public/themes/` and re-run `loadThemes()` on any change. Matches
 * the product's "drop a file in" ethos: adding a theme no longer requires
 * a server restart — the next page load picks it up. Already-open clients
 * won't hot-swap (they'd need a refresh to re-fetch `/themes.css` and
 * `/themes`), which is acceptable for a local dev tool.
 *
 * Events are debounced: editor saves often fire multiple `fs.watch` events
 * (temp-write → rename, on editors that atomic-replace), so collapsing
 * them into one `loadThemes()` call avoids redundant rescans.
 *
 * `persistent: false` keeps the watcher from blocking process exit. The
 * watcher is additionally closed in the shutdown handler for cleanliness.
 *
 * If `fs.watch` fails at setup (unsupported filesystem, permissions),
 * hot-reload is logged-disabled — the initial boot-time scan still
 * populates the cache, and behaviour reverts to "restart to pick up
 * changes". Runtime watcher errors (e.g. the directory being deleted)
 * are logged and the existing cache is left in place.
 */
function watchThemes() {
  let timer = null;
  /** @type {import('fs').FSWatcher | null} */
  let watcher = null;
  try {
    watcher = fs.watch(THEMES_DIR, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadThemes();
      }, 100);
    });
    watcher.on('error', (err) => {
      log(`themes: watcher error, hot-reload disabled:`, err.message);
    });
  } catch (err) {
    log(`themes: unable to watch ${THEMES_DIR}, hot-reload disabled:`, err.message);
    return null;
  }
  return watcher;
}
const themeWatcher = watchThemes();

function serveStatic(req, res) {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC, url));
  // Guard against path traversal. `startsWith(PUBLIC)` alone would
  // accept a sibling like `/foo/bar-evil` when PUBLIC is `/foo/bar`;
  // require either an exact match or that the next character is the
  // platform path separator so only entries literally under PUBLIC pass.
  const under =
    filePath === PUBLIC ||
    filePath.startsWith(PUBLIC + path.sep);
  if (!under) {
    res.writeHead(403, headers());
    return res.end('forbidden');
  }
  // `fs.readFile` follows symlinks. A user who can write to `public/`
  // could plant a symlink that resolves outside PUBLIC, and we'd serve
  // the target. That's out of threat model for this tool (anyone who
  // can write to `public/` can just edit the JS directly and it runs
  // in the browser) but worth calling out here; see SECURITY.md →
  // "Trust boundary" for the full statement.
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, headers());
      return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, headers({ 'Content-Type': MIME[ext] || 'application/octet-stream' }));
    res.end(data);
  });
}

/**
 * Probe whether an awk binary is available on PATH. Scoped to the allow-list
 * explicitly — the `--version` exit-code heuristic is unreliable for
 * arbitrary binaries (e.g. `bash --version` also exits 0), so refusing
 * anything outside the allow-list is a defense-in-depth check on top of the
 * call-site guards.
 */
function checkAwkBinary(name) {
  if (!ALLOWED_BINARIES.includes(name)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const proc = spawn(name, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    let done = false;
    proc.on('error', () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    });
    proc.on('close', (code) => {
      if (!done) {
        done = true;
        resolve(code === 0 || code === null);
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        try {
          proc.kill('SIGKILL');
        } catch (_) {}
        resolve(false);
      }
    }, 1000);
  });
}

let shuttingDown = false;

const server = http.createServer((req, res) => {
  const started = Date.now();
  let awkProgram;
  const logOnFinish = () => {
    let msg = `${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`;
    if (awkProgram !== undefined) {
      const preview = awkProgram.length > 200 ? awkProgram.slice(0, 200) + '…' : awkProgram;
      msg += `\n  program: ${preview}`;
    }
    log(msg);
  };
  res.on('finish', logOnFinish);
  res.on('close', () => {
    // Fired without 'finish' when the client hangs up mid-response. Log too.
    if (!res.writableEnded) logOnFinish();
  });

  if (shuttingDown) {
    res.writeHead(503, headers({ 'Content-Type': 'text/plain', Connection: 'close' }));
    return res.end('server shutting down');
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, headers({ 'Content-Type': 'application/json' }));
    return res.end(
      JSON.stringify({
        status: 'ok',
        uptimeMs: Date.now() - START_TIME,
        activeProcesses: activeProcesses.size,
        sandboxEnforced: SANDBOX_ENFORCED,
      }),
    );
  }
  if (req.method === 'GET' && req.url === '/settings/binaries') {
    Promise.all(
      ALLOWED_BINARIES.map((b) => checkAwkBinary(b).then((ok) => ({ name: b, available: ok }))),
    ).then((list) => {
      res.writeHead(200, headers({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify({ binaries: list, sandboxEnforced: SANDBOX_ENFORCED }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/run') {
    const csrfErr = rejectCsrf(req);
    if (csrfErr) {
      res.writeHead(403, headers({ 'Content-Type': 'application/json' }));
      return res.end(JSON.stringify({ error: csrfErr }));
    }
    const clientIp = req.socket.remoteAddress || 'unknown';
    const retryAfter = rateLimitCheck(clientIp);
    if (retryAfter > 0) {
      res.writeHead(
        429,
        headers({
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        }),
      );
      return res.end(
        JSON.stringify({
          error: `Rate limit: max ${RATE_LIMIT_MAX} runs per ${RATE_LIMIT_WINDOW_MS / 1000}s. Retry in ${retryAfter}s.`,
        }),
      );
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
      }
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const { program, input, inputs, vars, binary, args, timeoutMs, maxOutputBytes } = parsed;
        awkProgram = program || '';
        const result = await runAwk(program || '', input || '', vars || {}, {
          binary,
          args,
          timeoutMs,
          maxOutputBytes,
          inputs,
        });
        res.writeHead(200, headers({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, headers({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/format') {
    const csrfErr = rejectCsrf(req);
    if (csrfErr) {
      res.writeHead(403, headers({ 'Content-Type': 'application/json' }));
      return res.end(JSON.stringify({ error: csrfErr }));
    }
    // Share the /run rate-limit bucket — both spawn gawk processes, so the
    // runaway-client cap applies to the sum. Format is user-initiated
    // (button / shortcut), so it shouldn't normally approach the limit.
    const clientIp = req.socket.remoteAddress || 'unknown';
    const retryAfter = rateLimitCheck(clientIp);
    if (retryAfter > 0) {
      res.writeHead(
        429,
        headers({
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        }),
      );
      return res.end(
        JSON.stringify({
          error: `Rate limit: max ${RATE_LIMIT_MAX} runs per ${RATE_LIMIT_WINDOW_MS / 1000}s. Retry in ${retryAfter}s.`,
        }),
      );
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_FORMAT_BODY_BYTES) {
        req.destroy();
      }
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const { program, timeoutMs, maxOutputBytes } = parsed;
        awkProgram = program || '';
        const result = await formatAwkProgram(program || '', { timeoutMs, maxOutputBytes });
        res.writeHead(200, headers({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, headers({ 'Content-Type': 'application/json' }));
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/themes') {
    res.writeHead(200, headers({ 'Content-Type': 'application/json' }));
    return res.end(JSON.stringify(themeCache.list));
  }
  if (req.method === 'GET' && req.url === '/themes.css') {
    res.writeHead(200, headers({ 'Content-Type': 'text/css; charset=utf-8' }));
    return res.end(themeCache.allCss);
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405, headers());
  res.end('method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`awk-estra listening on http://127.0.0.1:${PORT}`);
  log(
    SANDBOX_ENFORCED
      ? 'sandbox: ENFORCED (--sandbox added for gawk runs)'
      : 'sandbox: DISABLED (started with --unsafe or UNSAFE_AWK=1)',
  );
});

/**
 * Graceful shutdown: stop accepting new connections, SIGTERM any in-flight
 * awk child processes, wait briefly, then SIGKILL holdouts. Prior to this,
 * SIGINT/SIGTERM on the server left orphan `awk` processes running until
 * their own timeouts fired.
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down`);
  server.close((err) => {
    if (err) log('server.close error:', err.message);
  });
  if (themeWatcher) {
    try {
      themeWatcher.close();
    } catch (_) {
      /* already closed */
    }
  }
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch (_) {
      /* already exited */
    }
  }
  // Force-kill any holdouts after a short grace period.
  const killDeadline = setTimeout(() => {
    for (const proc of activeProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        // Child already exited between the iteration start and this
        // kill attempt — fine, the grace period did its job.
      }
    }
  }, 2000);
  killDeadline.unref();
  // Exit once the server is fully closed. If something pathological keeps it
  // alive past 5s, exit anyway so the signal is honored.
  const forceExit = setTimeout(() => {
    log('shutdown timed out, exiting');
    process.exit(1);
  }, 5000);
  forceExit.unref();
  server.on('close', () => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
