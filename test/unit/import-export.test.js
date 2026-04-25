// @ts-check
// Unit tests for the import-export schema-version gate.
// `classifyImportVersion` is a pure function; the broader import flow
// is DOM-coupled (file picker + confirm dialog) and is covered
// implicitly by the existing e2e workflow — we only assert on the
// version-classification contract here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyImportVersion,
  EXPORT_SCHEMA_VERSION,
} from '../../public/js/import-export.js';

test('classifyImportVersion: matching version → ok', () => {
  assert.equal(
    classifyImportVersion({ version: EXPORT_SCHEMA_VERSION }),
    'ok',
  );
});

test('classifyImportVersion: older known version → ok', () => {
  // When we bump to v2, a v1 file should still be loadable without
  // friction (migration happens in applyImportPayload, not the gate).
  assert.equal(classifyImportVersion({ version: 1 }, 5), 'ok');
});

test('classifyImportVersion: strictly-higher version → future', () => {
  assert.equal(
    classifyImportVersion({ version: EXPORT_SCHEMA_VERSION + 1 }),
    'future',
  );
  assert.equal(classifyImportVersion({ version: 999 }), 'future');
});

test('classifyImportVersion: missing version field → unversioned', () => {
  assert.equal(classifyImportVersion({ snippets: [] }), 'unversioned');
});

test('classifyImportVersion: non-numeric version → unversioned', () => {
  // A hand-edited file could have `version: "1"` as a string; treat
  // that the same as a missing version and prompt the user rather
  // than guessing at the type.
  assert.equal(classifyImportVersion({ version: '1' }), 'unversioned');
  assert.equal(classifyImportVersion({ version: null }), 'unversioned');
  assert.equal(classifyImportVersion({ version: true }), 'unversioned');
});

test('classifyImportVersion: non-object input → unversioned (defensive)', () => {
  assert.equal(classifyImportVersion(null), 'unversioned');
  assert.equal(classifyImportVersion(undefined), 'unversioned');
  assert.equal(classifyImportVersion('just a string'), 'unversioned');
  assert.equal(classifyImportVersion(42), 'unversioned');
});

test('classifyImportVersion: respects caller-provided supported version', () => {
  // The default `supported` is EXPORT_SCHEMA_VERSION but callers can
  // pass a lower number to simulate an older build reading a newer
  // file — the same gate should fire.
  assert.equal(classifyImportVersion({ version: 2 }, 1), 'future');
  assert.equal(classifyImportVersion({ version: 1 }, 1), 'ok');
});
