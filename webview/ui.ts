export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const MONTH = (d: Date, year: boolean) => d.toLocaleDateString(undefined, year ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });

/** Compact relative time: now, 12m, 5h, Yesterday, Mon, Oct 9, Oct 9, 2024. */
export function formatDate(sec: number): string {
  const d = new Date(sec * 1000);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 0) return MONTH(d, d.getFullYear() !== now.getFullYear());
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startOfDay) return `${Math.floor(diff / 3600)}h`;
  if (d.getTime() >= startOfDay - 86400000) return 'Yesterday';
  if (d.getTime() >= startOfDay - 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return MONTH(d, d.getFullYear() !== now.getFullYear());
}

export function relative(sec: number): string {
  const diff = Date.now() / 1000 - sec;
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, u] of units) if (diff >= n) {
    const v = Math.floor(diff / n);
    return `${v} ${u}${v === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Initials avatar with a stable colour per name. */
export function avatar(name: string, size = 18): string {
  const parts = name.replace(/[._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? '')).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="--av:${h % 360};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px">${esc(initials)}</span>`;
}

export function fullDate(sec: number): string {
  return new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ------------------------------------------------------------------ menus

export type MenuItem = { label: string; run: () => void; disabled?: boolean; key?: string } | 'sep';

let openPopup: HTMLElement | null = null;
let onClosePopup: (() => void) | null = null;

export function closePopup(): void {
  if (openPopup) {
    openPopup.remove();
    openPopup = null;
    const cb = onClosePopup;
    onClosePopup = null;
    cb?.();
  }
}

function place(node: HTMLElement, x: number, y: number): void {
  document.body.appendChild(node);
  const r = node.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  node.style.left = `${Math.max(2, Math.min(x, vw - r.width - 2))}px`;
  node.style.top = `${y + r.height > vh ? Math.max(2, vh - r.height - 2) : y}px`;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closePopup();
  const menu = el('div', 'menu');
  const live = items.filter((i, n) => !(i === 'sep' && (n === 0 || items[n - 1] === 'sep' || n === items.length - 1)));
  for (const it of live) {
    if (it === 'sep') {
      menu.appendChild(el('div', 'sep'));
      continue;
    }
    const row = el('div', 'item' + (it.disabled ? ' disabled' : ''), `<span>${esc(it.label)}</span>${it.key ? `<span class="key">${esc(it.key)}</span>` : ''}`);
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => {
      closePopup();
      it.run();
    });
    menu.appendChild(row);
  }
  openPopup = menu;
  place(menu, x, y);
  keyNav(menu, '.item:not(.disabled)');
}

function keyNav(container: HTMLElement, selector: string, input?: HTMLInputElement): void {
  let hot = -1;
  const handler = (e: KeyboardEvent) => {
    if (openPopup !== container) {
      document.removeEventListener('keydown', handler, true);
      return;
    }
    const items = [...container.querySelectorAll<HTMLElement>(selector)];
    if (e.key === 'Escape') {
      closePopup();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      hot = (hot + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    } else if (e.key === 'Enter') {
      if (hot < 0 && input && items.length) hot = 0;
      items[hot]?.click();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    items.forEach((it, i) => it.classList.toggle('hot', i === hot));
    items[hot]?.scrollIntoView({ block: 'nearest' });
  };
  document.addEventListener('keydown', handler, true);
  if (input) input.addEventListener('input', () => (hot = -1));
}

export interface PickItem {
  id: string;
  label: string;
  checked?: boolean;
  head?: boolean; // section header
}

/** A searchable list of checkable items. Ctrl/Cmd+click picks several. */
export function showPicker(anchor: HTMLElement, items: PickItem[], onPick: (id: string, multi: boolean) => void, placeholder = 'Search'): void {
  closePopup();
  const popup = el('div', 'popup');
  const search = el('div', 'search', `<input placeholder="${esc(placeholder)}">`);
  const input = search.querySelector('input')!;
  const list = el('div', 'items');
  popup.append(search, list);
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const shown = items.filter((i) => i.head || !q || i.label.toLowerCase().includes(q));
    // Drop headers with nothing under them.
    const visible = shown.filter((i, n) => !i.head || (shown[n + 1] && !shown[n + 1].head));
    list.innerHTML = visible
      .map((i) =>
        i.head
          ? `<div class="head">${esc(i.label)}</div>`
          : `<div class="item" data-id="${esc(i.id)}"><span class="check">${i.checked ? '✓' : ''}</span><span>${esc(i.label)}</span></div>`,
      )
      .join('');
  };
  render();
  input.addEventListener('input', render);
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.item');
    if (!row) return;
    const multi = (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey;
    if (!multi) closePopup();
    onPick(row.dataset.id!, multi);
    if (multi) {
      const it = items.find((i) => i.id === row.dataset.id);
      if (it) it.checked = !it.checked;
      render();
    }
  });
  openPopup = popup;
  const r = anchor.getBoundingClientRect();
  place(popup, r.left, r.bottom + 2);
  input.focus();
  keyNav(popup, '.item', input);
}

document.addEventListener('mousedown', (e) => {
  if (openPopup && !openPopup.contains(e.target as Node)) closePopup();
});
window.addEventListener('blur', closePopup);
window.addEventListener('resize', closePopup);

// --------------------------------------------------------------- splitters

export function splitter(node: HTMLElement, axis: 'x' | 'y', get: () => number, set: (v: number) => void, invert = false): void {
  node.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const initial = get();
    node.classList.add('drag');
    const move = (ev: MouseEvent) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      set(initial + (invert ? -d : d));
    };
    const up = () => {
      node.classList.remove('drag');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
