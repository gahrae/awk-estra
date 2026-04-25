// @ts-check
// Tag chip-input widget. Renders a list of removable chips + a typing input
// that surfaces a filtered dropdown of existing tags, with a trailing
// "Create 'foo'" row when the query is not already in the suggestion set.
//
// Intentionally storage-shape-agnostic: caller passes `initial` as a string
// array and reads back a string array from `getTags()`. Normalization (lower
// casing, dedupe) happens inside so the widget's output is ready for
// `normalizeTags()` or direct persistence.

function normalizeOne(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {HTMLElement} root container to populate — its previous children are cleared
 * @param {{
 *   initial?: string[],
 *   suggestions?: string[],
 *   placeholder?: string,
 *   inputId?: string,
 * }} [opts]
 * @returns {{ getTags: () => string[], setSuggestions: (list: string[]) => void }}
 */
export function createTagChipInput(root, opts = {}) {
  root.classList.add('tag-chip-input');
  root.replaceChildren();

  const list = document.createElement('div');
  list.className = 'tag-chip-list';
  root.appendChild(list);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-chip-input-field';
  input.placeholder = opts.placeholder || 'Add tag…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (opts.inputId) input.id = opts.inputId;
  list.appendChild(input);

  const dropdown = document.createElement('ul');
  dropdown.className = 'tag-chip-dropdown';
  dropdown.setAttribute('role', 'listbox');
  dropdown.hidden = true;
  root.appendChild(dropdown);

  const tags = new Set((opts.initial || []).map(normalizeOne).filter(Boolean));
  let suggestions = (opts.suggestions || []).map(normalizeOne).filter(Boolean);
  /** @type {{ value: string, isCreate: boolean }[]} */
  let rows = [];
  let highlighted = 0;

  function renderChips() {
    for (const child of Array.from(list.children)) {
      if (child !== input) child.remove();
    }
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.tag = t;
      const label = document.createElement('span');
      label.className = 'tag-chip-label';
      label.textContent = t;
      chip.appendChild(label);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'tag-chip-remove';
      rm.setAttribute('aria-label', `Remove tag ${t}`);
      rm.setAttribute('title', `Remove tag ${t}`);
      rm.textContent = '×';
      rm.addEventListener('mousedown', (e) => {
        // mousedown + preventDefault so the input keeps focus after removing
        e.preventDefault();
      });
      rm.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tags.delete(t);
        renderChips();
        refreshDropdown();
        input.focus();
      });
      chip.appendChild(rm);
      list.insertBefore(chip, input);
    }
  }

  function refreshDropdown() {
    const q = input.value.trim().toLowerCase();
    const matches = suggestions.filter((s) => !tags.has(s) && (!q || s.includes(q)));
    rows = matches.map((v) => ({ value: v, isCreate: false }));
    if (q && !suggestions.includes(q) && !tags.has(q)) {
      rows.push({ value: q, isCreate: true });
    }
    if (!rows.length) {
      dropdown.hidden = true;
      dropdown.replaceChildren();
      return;
    }
    if (highlighted >= rows.length) highlighted = 0;
    dropdown.replaceChildren();
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'tag-chip-dropdown-item';
      if (i === highlighted) li.classList.add('highlighted');
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      if (r.isCreate) {
        const prefix = document.createElement('span');
        prefix.className = 'tag-chip-dropdown-prefix muted';
        prefix.textContent = 'Create ';
        const val = document.createElement('span');
        val.className = 'tag-chip-dropdown-new';
        val.textContent = `"${r.value}"`;
        li.appendChild(prefix);
        li.appendChild(val);
      } else {
        li.textContent = r.value;
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep input focused
        commit(r.value);
      });
      li.addEventListener('mouseenter', () => {
        highlighted = i;
        updateHighlight();
      });
      dropdown.appendChild(li);
    });
    dropdown.hidden = false;
  }

  function updateHighlight() {
    const items = dropdown.querySelectorAll('.tag-chip-dropdown-item');
    items.forEach((el, i) => el.classList.toggle('highlighted', i === highlighted));
  }

  function commit(value) {
    const v = normalizeOne(value);
    input.value = '';
    highlighted = 0;
    if (!v || tags.has(v)) {
      refreshDropdown();
      return;
    }
    tags.add(v);
    renderChips();
    refreshDropdown();
  }

  input.addEventListener('input', () => {
    highlighted = 0;
    refreshDropdown();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (!dropdown.hidden && rows[highlighted]) {
        e.preventDefault();
        commit(rows[highlighted].value);
      } else if (input.value.trim()) {
        e.preventDefault();
        commit(input.value);
      }
    } else if (e.key === 'Backspace' && !input.value) {
      const last = [...tags].pop();
      if (last !== undefined) {
        e.preventDefault();
        tags.delete(last);
        renderChips();
        refreshDropdown();
      }
    } else if (e.key === 'ArrowDown' && !dropdown.hidden) {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, rows.length - 1);
      updateHighlight();
    } else if (e.key === 'ArrowUp' && !dropdown.hidden) {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      updateHighlight();
    } else if (e.key === 'Escape' && !dropdown.hidden) {
      e.preventDefault();
      e.stopPropagation();
      dropdown.hidden = true;
    }
  });

  input.addEventListener('focus', refreshDropdown);
  input.addEventListener('blur', () => {
    // setTimeout so a click on a dropdown row that somehow bypassed our
    // mousedown-preventDefault still gets a chance to commit before we hide.
    setTimeout(() => {
      dropdown.hidden = true;
    }, 150);
  });

  // Clicking chrome (chip list background) focuses the input. `onclick`
  // (not addEventListener) so a second call to createTagChipInput on the
  // same root overwrites rather than stacks.
  root.onclick = (e) => {
    if (e.target === root || e.target === list) input.focus();
  };

  renderChips();

  return {
    getTags: () => [...tags],
    setSuggestions: (next) => {
      suggestions = next.map(normalizeOne).filter(Boolean);
      refreshDropdown();
    },
  };
}
