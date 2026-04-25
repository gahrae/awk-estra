// Minimal DOM node mock for testing `reconcileKeyedList`. The reconciler
// only touches ~6 DOM properties/methods, so a full jsdom install would
// be 60+ transitive packages for no extra fidelity at this layer.
//
// Each node behaves like an element: it has `dataset`, knows its parent
// and children, resolves `firstChild` / `nextSibling` against the parent's
// child list, and supports `insertBefore` / `remove`. Iteration via
// `Array.from(node.children)` works because `children` is a real array.

export function makeNode() {
  const node = {
    dataset: {},
    parentNode: /** @type {any} */ (null),
    /** @type {any[]} */
    children: [],
    get firstChild() {
      return this.children[0] || null;
    },
    get nextSibling() {
      if (!this.parentNode) return null;
      const arr = this.parentNode.children;
      const i = arr.indexOf(this);
      return i >= 0 && i + 1 < arr.length ? arr[i + 1] : null;
    },
    insertBefore(/** @type {any} */ child, /** @type {any} */ ref) {
      if (child.parentNode && child.parentNode !== this) {
        child.parentNode._detach(child);
      } else if (child.parentNode === this) {
        // Moving within same parent — detach in place first so insertion
        // index math is correct.
        this._detach(child);
      }
      child.parentNode = this;
      if (ref == null) {
        this.children.push(child);
      } else {
        const i = this.children.indexOf(ref);
        if (i < 0) this.children.push(child);
        else this.children.splice(i, 0, child);
      }
      return child;
    },
    _detach(/** @type {any} */ child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
    },
    remove() {
      if (this.parentNode) this.parentNode._detach(this);
    },
  };
  return node;
}
