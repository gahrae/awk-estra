// @ts-check
// Sidebar chrome: section collapse toggles + drag-to-resize handle.

import { $, safeSetItem } from './core.js';
import { LS_KEYS } from './data.js';
import { settings } from './settings.js';

export function setupSectionToggles() {
  const sections = /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('section[data-section]')
  );
  for (const section of sections) {
    const key = section.dataset.section || '';
    const stored = localStorage.getItem(LS_KEYS.sectionCollapsed(key));
    // `sectionsExpanded` stores true=expanded, false=collapsed. Negate
    // to match the local `collapsed` semantics used below. Missing key
    // (sections that predate the user's saved blob) defaults to
    // expanded.
    const defaultCollapsed = settings.ui.sectionsExpanded?.[key] === false;
    const collapsed = stored === null ? defaultCollapsed : stored === '1';
    section.classList.toggle('collapsed', collapsed);
    const head = /** @type {HTMLElement | null} */ (section.querySelector('.section-head'));
    if (!head) continue;
    // The head is a <div> (contains an <h2> and action buttons, which can't
    // nest inside a <button>). Promote it to a focusable toggle via role +
    // tabindex + keyboard handling so screen-reader and keyboard users can
    // expand/collapse the section like sighted mouse users.
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', String(!collapsed));
    head.setAttribute(
      'aria-controls',
      section.querySelector('ul,ol,div:not(.section-head)')?.id || '',
    );
    const toggle = () => {
      const now = !section.classList.contains('collapsed');
      section.classList.toggle('collapsed', now);
      head.setAttribute('aria-expanded', String(!now));
      safeSetItem(LS_KEYS.sectionCollapsed(key), now ? '1' : '0');
    };
    head.addEventListener('click', (e) => {
      if (/** @type {Element} */ (e.target).closest('button')) return;
      toggle();
    });
    head.addEventListener('keydown', (e) => {
      if (/** @type {Element} */ (e.target).closest('button')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
}

/**
 * Force a sidebar section open and persist the state, so follow-up
 * actions taken from the section-head buttons (expand-all / collapse-all
 * tag groups) produce visible results even when the whole section was
 * collapsed.
 *
 * @param {string} key section identifier (e.g. 'snippets')
 */
export function expandSection(key) {
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section[data-section="${key}"]`)
  );
  if (!section || !section.classList.contains('collapsed')) return;
  section.classList.remove('collapsed');
  const head = section.querySelector('.section-head');
  if (head) head.setAttribute('aria-expanded', 'true');
  safeSetItem(LS_KEYS.sectionCollapsed(key), '0');
}

const SIDEBAR_KEY = LS_KEYS.SIDEBAR_WIDTH;

function setSidebarWidth(px) {
  const w = Math.max(160, Math.min(px, Math.floor(window.innerWidth * 0.7)));
  document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  safeSetItem(SIDEBAR_KEY, String(w));
}

export function setupResizer() {
  const def = settings.ui.defaultSidebarWidth;
  const saved = parseInt(localStorage.getItem(SIDEBAR_KEY) || String(def), 10);
  setSidebarWidth(Number.isFinite(saved) ? saved : def);

  const resizer = $('#resizer');
  let startX = 0;
  let startWidth = 0;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    setSidebarWidth(startWidth + dx);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = $('#sidebar').offsetWidth;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  resizer.addEventListener('dblclick', () => setSidebarWidth(settings.ui.defaultSidebarWidth));
}
