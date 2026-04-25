// Preloaded via `node --test --import ./test/setup.js`.
// The client modules reference a handful of browser globals at module-load
// time (notably `navigator.platform` for `IS_MAC`, and `document` for the
// `events.js` typed-event bus which wires module-scope listeners from
// `editor.js` on import). Stub just enough to let them import cleanly
// under Node — tests that actually exercise the DOM either build their
// own minimal nodes (see `test/dom-stub.js` for `reconcile.test.js`) or
// mock the DOM in-test.
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = /** @type {any} */ ({ platform: 'Linux' });
}
if (typeof globalThis.document === 'undefined') {
  // Minimal stand-in: `addEventListener` is called by `events.on()` at
  // module load, so it has to at least exist. Handlers registered here
  // are never fired (no real events are dispatched in unit tests), so
  // the registry can be a black hole.
  globalThis.document = /** @type {any} */ ({
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
}
