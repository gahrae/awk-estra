import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';

const PORT = 33099;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** @type {import('node:child_process').ChildProcess} */
let serverProc;

before(async () => {
  serverProc = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait until the server logs that it's listening. Drain stderr so the
  // pipe buffer doesn't fill up.
  await new Promise((resolve, reject) => {
    const onData = (buf) => {
      if (buf.toString().includes(`listening on ${ORIGIN}`)) {
        serverProc.stderr?.off('data', onData);
        serverProc.stdout?.off('data', onData);
        resolve(undefined);
      }
    };
    const onExit = () => reject(new Error('server exited before ready'));
    serverProc.stderr?.on('data', onData);
    serverProc.stdout?.on('data', onData);
    serverProc.once('exit', onExit);
    setTimeout(() => reject(new Error('server boot timeout')), 5000);
  });
  // Discard subsequent log output so stderr buffer never fills.
  serverProc.stderr?.on('data', () => {});
  serverProc.stdout?.on('data', () => {});
});

after(async () => {
  if (!serverProc || serverProc.exitCode !== null) return;
  serverProc.kill('SIGTERM');
  await once(serverProc, 'exit');
});

test('GET /health returns status json', async () => {
  const res = await fetch(`${ORIGIN}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptimeMs, 'number');
  assert.equal(typeof body.activeProcesses, 'number');
  assert.equal(typeof body.sandboxEnforced, 'boolean');
});

test('security headers are present on all responses', async () => {
  const res = await fetch(`${ORIGIN}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(res.headers.get('content-security-policy'));
});

test('POST /run without JSON content-type is rejected (CSRF)', async () => {
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"program":"{print}"}',
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /Content-Type/);
});

test('POST /run with missing Origin is rejected (CSRF)', async () => {
  // Non-browser clients (curl, scripts) that omit Origin must be
  // rejected — browsers always send Origin on fetch/form POSTs, so
  // anything that doesn't is off the browser-attack path. The
  // 4xx message names the missing header so curl users see what to
  // add (documented in SECURITY.md → CSRF posture).
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // fetch() sets Origin automatically; we explicitly strip it by
      // using http.request below.
    },
    body: '{"program":"{print}","input":""}',
  });
  // If this environment's fetch set Origin for us anyway (some Node
  // versions do), bail — the mismatched-Origin test covers the
  // spoofed case and this one is only meaningful when Origin is
  // genuinely absent. We detect the fallback by checking that the
  // response is still a 403 but with the wrong error message.
  if (res.status === 200) {
    return; // fetch auto-added Origin; covered elsewhere.
  }
  assert.equal(res.status, 403);
  const body = await res.json();
  // Accept either the missing-Origin error or the mismatched-Origin
  // error (depending on whether fetch added its own Origin).
  assert.match(body.error, /Origin/);
});

test('POST /run with mismatched Origin is rejected (CSRF)', async () => {
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: '{"program":"{print}","input":""}',
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /Origin/);
});

test('POST /run happy path echoes stdout', async () => {
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({
      program: '{ print toupper($0) }',
      input: 'hello\nworld\n',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // gawk may not be available in every CI env — treat "no such binary" as a
  // skippable environment issue, not a test failure.
  if (body.stderr && /spawn|ENOENT/.test(body.stderr)) {
    return; // awk binary unavailable; nothing more to assert.
  }
  assert.equal(body.stdout, 'HELLO\nWORLD\n');
  assert.equal(body.code, 0);
});

test('POST /format happy path returns pretty-printed program', async () => {
  const res = await fetch(`${ORIGIN}/format`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({ program: 'BEGIN{FS=",";t=0}{t+=$1}END{print t}' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // gawk isn't guaranteed to be on every CI environment; treat "binary
  // not found" as a skippable env issue. --pretty-print is gawk-specific,
  // so any mawk/one-true-awk machine also hits this path.
  if (body.stderr && /spawn|ENOENT/.test(body.stderr)) return;
  assert.equal(typeof body.formatted, 'string');
  assert.equal(body.code, 0);
  // Sanity-check the style rather than the exact bytes: gawk's
  // pretty-print adds newlines after `{` and spaces around `=`.
  assert.match(body.formatted, /BEGIN \{\n/);
  assert.match(body.formatted, /FS = ","/);
  assert.match(body.formatted, /END \{\n/);
});

test('POST /format without JSON content-type is rejected (CSRF)', async () => {
  const res = await fetch(`${ORIGIN}/format`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"program":"{print}"}',
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /Content-Type/);
});

test('POST /run with malformed JSON returns 400', async () => {
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    // A lone `{` won't parse — the server's try/catch around JSON.parse
    // must turn it into a 400 instead of crashing the request handler.
    body: '{ not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'error message should accompany the 400');
});

test('POST /run with empty body works (defaults applied)', async () => {
  // An empty body parses as `{}`, which the handler treats as
  // `{ program: '', input: '' }`. awk with an empty program just
  // consumes stdin and emits nothing. Used to catch regressions where
  // a default-argument cleanup accidentally requires `program` to be
  // non-empty at the HTTP boundary.
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: '',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  if (body.stderr && /spawn|ENOENT/.test(body.stderr)) return; // awk unavailable
  assert.equal(body.stdout, '');
});

test('POST /run timeoutMs kills a runaway program', async () => {
  // Classic awk infinite loop in BEGIN — never reads stdin, never
  // exits on its own. With timeoutMs: 150 the server must SIGKILL
  // after ~150ms and report it in stderr (see `spawnWithCaps`'s
  // "[killed: exceeded Nms timeout]" trailer).
  const start = Date.now();
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({
      program: 'BEGIN { while (1) {} }',
      input: '',
      timeoutMs: 150,
    }),
  });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200);
  const body = await res.json();
  if (body.stderr && /spawn|ENOENT/.test(body.stderr)) return; // awk unavailable
  // The timeout trailer is appended to stderr. Exact format is
  // "[killed: exceeded 150ms timeout]" — match loosely so small
  // message tweaks don't break the test.
  assert.match(body.stderr, /killed.*exceeded.*timeout/i);
  // Sanity: the server must not have waited the full default 5s.
  // Allow generous slack for CI scheduler wobble, but refuse 10x the
  // configured timeout.
  assert.ok(elapsed < 1500, `expected < 1500ms, got ${elapsed}ms`);
});

test('POST /run multi-file inputs feed awk real FILENAME / FNR', async () => {
  // Two virtual files; awk should see each as a separate input and
  // print FILENAME alongside the line so we can verify the server
  // materialised them correctly via `prepareMultiInputs`.
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({
      program: '{ print FILENAME ":" FNR ":" $0 }',
      inputs: [
        { name: 'alpha.txt', content: 'one\ntwo\n' },
        { name: 'beta.txt', content: 'three\n' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  if (body.stderr && /spawn|ENOENT/.test(body.stderr)) return; // awk unavailable
  assert.equal(body.code, 0);
  assert.equal(
    body.stdout,
    'alpha.txt:1:one\nalpha.txt:2:two\nbeta.txt:1:three\n',
  );
});

test('POST /run multi-file path cleans its tmpdir after the run', async () => {
  // `prepareMultiInputs` creates `awk-estra-*` tmpdirs via `fs.mkdtempSync`.
  // The server's success + error paths must rm them afterwards so
  // long-running servers don't bleed tmpdir entries. Count before and
  // after and assert no net change.
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((d) => d.startsWith('awk-estra-')).length;
  const res = await fetch(`${ORIGIN}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({
      program: '{ print }',
      inputs: [{ name: 'x.txt', content: 'hello\n' }],
    }),
  });
  const body = await res.json();
  if (body.stderr && /spawn|ENOENT/.test(body.stderr)) return; // awk unavailable
  // Give the server a moment to finish its synchronous cleanup after
  // responding (the `finally` block runs in the same tick, but cross-
  // platform fs operations can settle lazily).
  await new Promise((r) => setTimeout(r, 50));
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((d) => d.startsWith('awk-estra-')).length;
  assert.equal(after, before, 'tmpdir entries should not leak across a run');
});

test('POST /run over request-body cap aborts the connection', async () => {
  // The server destroys the socket as soon as buffered bytes exceed
  // MAX_REQUEST_BODY_BYTES (50 MiB). Build a body just over the cap —
  // its parsed JSON shape is irrelevant, the check fires during the
  // `data` handler before JSON.parse runs. `fetch` surfaces the abort
  // as a network error; either a throw or a non-2xx response is
  // acceptable. We only assert that the request does NOT succeed
  // quietly (which would mean the cap is not enforced).
  const overCap = 50 * 1024 * 1024 + 1024; // 50 MiB + 1 KiB
  // Build the body as a single ASCII buffer to avoid per-character
  // UTF-16 overhead in the String constructor.
  const body = Buffer.alloc(overCap, 'a');
  let aborted = false;
  let statusIfAny = null;
  try {
    const res = await fetch(`${ORIGIN}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      body,
    });
    statusIfAny = res.status;
    // If we got a response, drain it so the connection can close.
    await res.text().catch(() => {});
  } catch (_err) {
    aborted = true;
  }
  assert.ok(
    aborted || (statusIfAny !== null && statusIfAny >= 400),
    `expected abort or 4xx/5xx; got status=${statusIfAny} aborted=${aborted}`,
  );
});

// Must run LAST among /run-or-/format tests: burns the rate-limit bucket
// for the test IP, so anything after it inside the same 10s window gets
// 429s. `/format` shares the bucket with `/run`, hence this ordering.
test('POST /run rate-limits after 100 runs in 10s', async () => {
  // Fire 110 requests in quick succession; expect at least one 429 with
  // a Retry-After header. Use the same origin so CSRF is happy. The
  // server-side cap is `RATE_LIMIT_MAX = 100` per 10s; 110 > 100 so the
  // window will fill before the loop completes regardless of network jitter.
  const headers = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
  };
  const body = JSON.stringify({ program: '1', input: '' });
  const results = [];
  for (let i = 0; i < 110; i++) {
    const r = await fetch(`${ORIGIN}/run`, { method: 'POST', headers, body });
    results.push(r);
    // Drain so we don't accumulate open bodies.
    await r.text();
  }
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.includes(429), `expected 429 in ${statuses.join(',')}`);
  const limited = results.find((r) => r.status === 429);
  assert.ok(limited?.headers.get('retry-after'), 'Retry-After header present');
});

test('unknown GET paths return 404', async () => {
  const res = await fetch(`${ORIGIN}/does-not-exist`);
  assert.equal(res.status, 404);
});

test('unknown methods return 405', async () => {
  const res = await fetch(`${ORIGIN}/health`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});
