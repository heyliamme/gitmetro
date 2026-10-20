import type { ChangesPayload, FileChange, LogFilter, LogRow, Palette, Ref, RepoState, RepoSummary, ToHost, ToView, Worktree } from '../src/protocol';
import { icons } from './icons';
import { avatar, closePopup, esc, formatDate, fullDate, MenuItem, PickItem, relative, showMenu, showPicker, splitter } from './ui';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();
const post = (m: ToHost) => api.postMessage(m);

interface UiState {
  sidebarW: number;
  inspectorW: number;
  showSidebar: boolean;
  showInspector: boolean;
  showHash: boolean;
  collapsed: string[];
  fileView: 'tree' | 'list';
  filter: LogFilter;
}

const saved = api.getState() as Partial<UiState> | undefined;
const ui: UiState = {
  sidebarW: 250,
  inspectorW: 380,
  // Opened next to the activity-bar branches: no second branch column unless asked for.
  showSidebar: document.body.dataset.mode !== 'log',
  showInspector: true,
  showHash: false,
  collapsed: ['s:tags'],
  fileView: 'tree',
  filter: {},
  ...(saved ?? {}),
};
const save = () => api.setState(ui);

/** 'sidebar': the narrow activity-bar view, branches only; the log opens in an editor tab. */
const SIDEBAR = document.body.dataset.mode === 'sidebar';
document.body.classList.toggle('mode-sidebar', SIDEBAR);

const ROW_H = 26;
const LANE_W = 16;
// Line colours. 'metro': saturated, readable on light and dark alike.
// 'atom': Atom's One Dark syntax colours, or One Light in a light theme.
const PALETTES: Record<Palette, { dark: string[]; light: string[] }> = {
  metro: {
    dark: ['#2f81f7', '#e5534b', '#3fb950', '#d29922', '#a371f7', '#db61a2', '#1bb5c4', '#f0883e', '#8b949e', '#57ab5a', '#6cb6ff', '#c69026'],
    // Darker twins for light themes: every line at least 3:1 against white.
    light: ['#0969da', '#cf222e', '#1a7f37', '#9a6700', '#8250df', '#bf3989', '#0e7c86', '#bc4c00', '#6e7781', '#116329', '#0550ae', '#7d4e00'],
  },
  atom: {
    dark: ['#61afef', '#e06c75', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#be5046', '#528bff', '#abb2bf'],
    light: ['#4078f2', '#e45649', '#3d7d3c', '#946200', '#a626a4', '#0184bc', '#986801', '#ca1243', '#526fff', '#696c77'],
  },
};
let palette: Palette = 'metro';
const isLight = () => document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
let LINES = PALETTES.metro.dark;
function applyPalette(): void {
  LINES = PALETTES[palette][isLight() ? 'light' : 'dark'];
  document.body.dataset.palette = palette;
}
applyPalette();
// VS Code swaps the body's theme class when the user changes theme.
let wasLight = isLight();
new MutationObserver(() => {
  if (isLight() === wasLight) return; // our own classes (narrow, mode-sidebar) change too
  wasLight = isLight();
  applyPalette();
  renderRows();
  renderSidebar();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ------------------------------------------------------------------ state

let state: RepoState | null = null;
let repos: RepoSummary[] = [];
let currentRepo = '';
let rows: LogRow[] = [];
let indexOf = new Map<string, number>();
let hasMore = false;
let loadingMore = false;
let filtered = false;
let emptyMessage = '';
let refsByHash = new Map<string, Ref[]>();
const selected = new Set<string>();
let anchor = -1;
let cursor = -1;
let changes: ChangesPayload | null = null;
let changesLoading = false;
let parentIx = 0;
const containing = new Map<string, string[]>();
let pendingReveal: string | null = null;
let firstLog: boolean | null = null; // true only while handling the first log of this view
// Put focus back where it was when the view regains it (VS Code focuses the webview, not a control).
let lastFocus: HTMLElement | null = null;
document.addEventListener('focusin', (e) => {
  if (e.target instanceof HTMLElement && e.target !== document.body) lastFocus = e.target;
});
window.addEventListener('focus', () => {
  setTimeout(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    (lastFocus && document.contains(lastFocus) ? lastFocus : SIDEBAR ? refTree : list).focus();
  }, 0);
});
let revealTries = 0;
let filter: LogFilter = ui.filter ?? {};
let sideSel = '';
let fileSel = '';
const folderCollapsed = new Set<string>();

// --------------------------------------------------------------- skeleton

const app = document.getElementById('app')!;
app.innerHTML = `
<aside class="pane sidebar" id="sidebar">
  <div class="current" id="current"></div>
  <div class="bar">
    <div class="search grow">${icons.search}<input id="refSearch" placeholder="Filter branches and tags" spellcheck="false"></div>
    <button class="iconbtn" id="sNew" title="Create branch">${icons.plus}</button>
    <button class="iconbtn" id="sCollapse" title="Collapse all">${icons.collapse}</button>
  </div>
  <div class="tree" id="refTree" tabindex="0" role="tree" aria-label="Branches and tags"></div>
</aside>
<div class="splitter" id="split1"></div>
<main class="pane log">
  <div class="bar toolbar">
    <button class="iconbtn" id="tSidebar" title="Toggle branches">${icons.panelLeft}</button>
    <div class="search query">${icons.search}<input id="textFilter" placeholder="Search messages or hash" spellcheck="false">
      <button class="toggle" id="tCase" title="Match case" aria-pressed="false">Aa</button><button class="toggle" id="tRegex" title="Regular expression" aria-pressed="false">.*</button></div>
    <span class="chips" id="filters"></span>
    <span class="grow"></span>
    <select class="repo-select" id="repoSelect" title="Repository" hidden></select>
    <button class="iconbtn" id="tFetch" title="Fetch all remotes">${icons.fetch}</button>
    <button class="iconbtn" id="tRefresh" title="Reload">${icons.refresh}</button>
    <button class="iconbtn" id="tHash" title="Show hash column">${icons.hash}</button>
    <button class="iconbtn" id="tInspector" title="Toggle commit inspector">${icons.panelRight}</button>
  </div>
  <div class="progress" id="progress"></div>
  <div class="opbar" id="opbar" hidden></div>
  <div class="colhead"><span class="c-msg">Commit</span><span class="c-author">Author</span><span class="c-date">When</span><span class="c-hash" id="hHash">Hash</span></div>
  <div class="list" id="list" tabindex="0" role="listbox" aria-label="Commits" aria-multiselectable="true"><div class="spacer" id="spacer"><div class="viewport" id="viewport"></div></div></div>
</main>
<div class="splitter" id="split2"></div>
<aside class="pane inspector" id="inspector">
  <div class="card" id="card"></div>
  <div class="filesbar" id="filesbar"></div>
  <div class="tree files" id="files" tabindex="0" role="tree" aria-label="Changed files"></div>
</aside>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sidebar = $('sidebar');
const refTree = $('refTree');
const refSearch = $<HTMLInputElement>('refSearch');
const list = $('list');
const spacer = $('spacer');
const viewport = $('viewport');
const inspector = $('inspector');
const card = $('card');
const filesbar = $('filesbar');
const files = $('files');
const textFilter = $<HTMLInputElement>('textFilter');
const repoSelect = $<HTMLSelectElement>('repoSelect');

function layout(): void {
  // Saved widths are preferences; in a narrow view (a diff opened beside the log) the commit
  // list keeps at least a quarter of the width.
  const W = window.innerWidth;
  // Narrow (a diff open beside the log, a slim panel): the inspector goes under the list.
  // ...but not in a short panel: there the inspector stays beside the list, or nothing fits.
  const stacked = W < 760 && window.innerHeight > 420;
  document.body.classList.toggle('stacked', stacked);
  const side = Math.min(ui.sidebarW, Math.max(140, W * 0.3));
  const insp = Math.min(ui.inspectorW, Math.max(220, W * 0.45 - (ui.showSidebar ? side * 0.3 : 0)));
  sidebar.style.width = `${side}px`;
  sidebar.hidden = !ui.showSidebar;
  $('split1').hidden = !ui.showSidebar;
  inspector.style.width = stacked ? '' : `${insp}px`;
  inspector.hidden = !ui.showInspector;
  $('split2').hidden = !ui.showInspector;
  $('tSidebar').classList.toggle('on', ui.showSidebar);
  $('tInspector').classList.toggle('on', ui.showInspector);
  $('tHash').classList.toggle('on', ui.showHash);
  $('tInspector').setAttribute('aria-pressed', String(ui.showInspector));
  $('tHash').setAttribute('aria-pressed', String(ui.showHash));
  $('hHash').hidden = !ui.showHash;
  if (!SIDEBAR) document.body.classList.toggle('narrow', list.clientWidth < 640);
}

splitter($('split1'), 'x', () => sidebar.getBoundingClientRect().width, (v) => {
  ui.sidebarW = Math.max(160, Math.min(v, 560));
  layout();
  save();
});
splitter($('split2'), 'x', () => inspector.getBoundingClientRect().width, (v) => {
  ui.inspectorW = Math.max(240, Math.min(v, window.innerWidth - 320));
  layout();
  renderRows();
  save();
}, true);

// ---------------------------------------------------------------- helpers

/**
 * Where a context menu opens and for what. From the mouse: the item under it. From the keyboard
 * (Shift+F10, the Menu key) the event targets the container: use the selected item instead.
 */
function menuAnchor(e: MouseEvent, container: HTMLElement, item: string, selected: string): { el: HTMLElement; x: number; y: number } | null {
  const hit = (e.target as HTMLElement).closest<HTMLElement>(item);
  if (hit && container.contains(hit)) return { el: hit, x: e.clientX, y: e.clientY };
  const sel = container.querySelector<HTMLElement>(selected);
  if (!sel) return null;
  const r = sel.getBoundingClientRect();
  return { el: sel, x: r.left + Math.min(r.width / 3, 160), y: r.bottom };
}

const short = (h: string) => h.slice(0, 7);
const line = (i: number) => LINES[i % LINES.length];
/** Black or white, whichever reads better on a line colour. */
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.22 ? '#111' : '#fff';
}

function refLabel(full: string): string {
  if (full === 'HEAD') return 'HEAD';
  return full.replace(/^refs\/(heads|remotes|tags)\//, '');
}

const isPinned = (r: Ref) => !!state?.favorites.includes(r.full);

/** The colour of the line a commit sits on, so a branch keeps its colour across the UI. */
function colorOf(hash: string): string | undefined {
  const i = indexOf.get(hash);
  return i === undefined ? undefined : line(rows[i].graph.color);
}

function indexRefs(): void {
  refsByHash = new Map();
  if (!state) return;
  const order = (r: Ref) => (r.current ? 0 : r.kind === 'local' ? 1 : r.kind === 'remote' ? 2 : 3);
  for (const r of state.refs) refsByHash.set(r.hash, [...(refsByHash.get(r.hash) ?? []), r]);
  for (const arr of refsByHash.values()) arr.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- sidebar

interface SNode {
  id: string;
  label: string;
  kind: 'section' | 'folder' | 'ref' | 'repo' | 'worktree';
  ref?: Ref;
  repo?: RepoSummary;
  worktree?: Worktree;
  count?: number;
  children: SNode[];
}

let sideFlat: { node: SNode; depth: number }[] = [];

function folderTree(prefix: string, refs: Ref[], strip: (r: Ref) => string): SNode[] {
  const root: SNode = { id: prefix, label: '', kind: 'folder', children: [] };
  for (const r of refs) {
    const parts = strip(r).split('/');
    let node = root;
    let path = prefix;
    for (const part of parts.slice(0, -1)) {
      path += '/' + part;
      let next = node.children.find((c) => c.kind === 'folder' && c.id === path);
      if (!next) node.children.push((next = { id: path, label: part, kind: 'folder', children: [] }));
      node = next;
    }
    node.children.push({ id: r.full, label: parts[parts.length - 1], kind: 'ref', ref: r, children: [] });
  }
  const sort = (n: SNode) => {
    const rank = (c: SNode) => (c.ref?.current ? 0 : c.kind === 'folder' ? 2 : 1);
    n.children.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function buildSidebar(): SNode[] {
  if (!state) return [];
  const q = refSearch.value.trim().toLowerCase();
  const refs = state.refs.filter((r) => !q || r.name.toLowerCase().includes(q));
  const out: SNode[] = [];
  // Several repositories in the workspace: list them all, like the Source Control view.
  if (repos.length > 1) {
    const shown = repos.filter((r) => !q || r.name.toLowerCase().includes(q));
    if (shown.length)
      out.push({ id: 's:repos', label: 'Repositories', kind: 'section', count: repos.length, children: shown.map((r) => ({ id: 'r:' + r.root, label: r.name, kind: 'repo' as const, repo: r, children: [] })) });
  }
  const pinned = refs.filter(isPinned);
  if (pinned.length)
    out.push({ id: 's:pinned', label: 'Pinned', kind: 'section', count: pinned.length, children: pinned.map((r) => ({ id: 'p:' + r.full, label: r.name, kind: 'ref', ref: r, children: [] })) });
  const local = refs.filter((r) => r.kind === 'local');
  if (local.length) out.push({ id: 's:local', label: 'Branches', kind: 'section', count: local.length, children: folderTree('f:local', local, (r) => r.name) });
  const remote = refs.filter((r) => r.kind === 'remote');
  if (remote.length) {
    const byRemote = new Map<string, Ref[]>();
    for (const r of remote) {
      const name = r.name.split('/')[0];
      byRemote.set(name, [...(byRemote.get(name) ?? []), r]);
    }
    out.push({
      id: 's:remote',
      label: 'Remotes',
      kind: 'section',
      count: remote.length,
      children: [...byRemote.entries()].map(([name, rs]) => ({
        id: `f:remote/${name}`,
        label: name,
        kind: 'folder' as const,
        children: folderTree(`f:remote/${name}`, rs, (r) => r.name.slice(name.length + 1)),
      })),
    });
  }
  const wts = (state.worktrees ?? []).filter((w) => !q || w.path.toLowerCase().includes(q) || w.branch.toLowerCase().includes(q));
  if ((state.worktrees?.length ?? 0) > 1 && wts.length)
    out.push({ id: 's:worktrees', label: 'Worktrees', kind: 'section', count: state.worktrees.length, children: wts.map((w) => ({ id: 'w:' + w.path, label: w.path.split(/[\\/]/).pop() || w.path, kind: 'worktree' as const, worktree: w, children: [] })) });
  const tags = refs.filter((r) => r.kind === 'tag');
  if (tags.length) out.push({ id: 's:tags', label: 'Tags', kind: 'section', count: tags.length, children: folderTree('f:tags', tags, (r) => r.name) });
  return out;
}

function trackBadges(r: Ref): string {
  if (r.gone) return `<span class="badges" title="${esc(r.upstream ?? 'The upstream')} was deleted on the remote"><span class="badge warn">gone</span></span>`;
  if (!r.ahead && !r.behind) return '';
  return `<span class="badges" title="${r.ahead ?? 0} to push, ${r.behind ?? 0} to pull (${esc(r.upstream ?? '')})">${r.ahead ? `<span class="badge out">↑${r.ahead}</span>` : ''}${r.behind ? `<span class="badge in">↓${r.behind}</span>` : ''}</span>`;
}

function renderCurrent(): void {
  const el = $('current');
  if (!state) {
    el.innerHTML = '';
    return;
  }
  const cur = state.refs.find((r) => r.current);
  const name = state.branch || `detached at ${short(state.head)}`;
  const c = colorOf(state.head) ?? 'var(--accent)';
  const repoName = repos.length > 1 ? repos.find((r) => r.root === currentRepo)?.name : undefined;
  el.innerHTML = `
    ${repoName ? `<div class="cur-repo">${icons.mark}<span class="ellip" title="${esc(repoName)}">${esc(repoName)}</span></div>` : ''}
    <div class="cur-main" data-reveal="${esc(state.head)}" title="Show in log">
      <span class="dot" style="--c:${c}"></span>
      <span class="cur-name">${esc(name)}</span>
      ${cur ? trackBadges(cur) : ''}
    </div>
    <div class="cur-sub">${cur?.upstream ? `tracks <b>${esc(cur.upstream)}</b>` : state.branch ? 'no upstream' : 'not on a branch'}</div>
    ${SIDEBAR ? `<button class="btn primary wide" data-act="openLog" title="Open the commit graph in an editor tab">${icons.mark}<span>Open Git Log</span></button>` : ''}
    <div class="cur-actions">
      <button class="btn" data-act="update" ${cur?.upstream ? '' : 'disabled'} title="Pull (Fast-Forward)">${icons.pull}<span>Pull</span></button>
      <button class="btn" data-act="push" ${cur ? '' : 'disabled'} title="Push">${icons.push}<span>Push</span></button>
      <button class="btn" data-act="fetch" title="Fetch all remotes">${icons.fetch}<span>Fetch</span></button>
    </div>`;
}

$('current').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLButtonElement>('[data-act]');
  const cur = state?.refs.find((r) => r.current);
  if (btn) {
    if (btn.dataset.act === 'openLog') post({ type: 'openLog' });
    else if (btn.dataset.act === 'fetch') post({ type: 'fetch' });
    else if (cur) post({ type: 'refAction', action: btn.dataset.act!, ref: cur.full });
    return;
  }
  const rev = t.closest<HTMLElement>('[data-reveal]');
  if (rev) showCommit(rev.dataset.reveal!);
});

/** In the log: select the commit. In the sidebar: bring up the log tab at that commit. */
function showCommit(hash: string): void {
  if (SIDEBAR) post({ type: 'openLog', reveal: hash });
  else revealCommit(hash);
}

/** Restrict the log to one ref, wherever the log is. */
function showOnly(full: string): void {
  if (SIDEBAR) post({ type: 'openLog', filter: { branches: [full] } });
  else applyFilter({ ...filter, branches: [full] });
}

function renderSidebar(): void {
  renderCurrent();
  const searching = !!refSearch.value.trim();
  const collapsed = new Set(ui.collapsed);
  sideFlat = [];
  const walk = (nodes: SNode[], depth: number) => {
    for (const n of nodes) {
      sideFlat.push({ node: n, depth });
      if (n.children.length && (searching || !collapsed.has(n.id))) walk(n.children, depth + 1);
    }
  };
  walk(buildSidebar(), 0);
  if (!sideFlat.length) {
    refTree.innerHTML = `<div class="hint-empty">${!state ? '' : refSearch.value.trim() ? 'No matching branches or tags' : 'No branches yet: make the first commit.'}</div>`;
    return;
  }
  refTree.innerHTML = sideFlat
    .map(({ node: n, depth }) => {
      const open = searching || !collapsed.has(n.id);
      const sel = n.id === sideSel ? ' sel' : '';
      if (n.kind === 'section') {
        return `<div class="section${sel}" role="treeitem" aria-expanded="${open}" data-id="${esc(n.id)}"><span class="tw">${open ? icons.chevronDown : icons.chevronRight}</span><span>${esc(n.label)}</span><span class="count">${n.count}</span></div>`;
      }
      const pad = `padding-left:${depth * 14 + 6}px`;
      if (n.kind === 'repo') {
        const r = n.repo!;
        const cur = r.root === currentRepo;
        const where = r.branch || (r.head ? `detached ${r.head.slice(0, 7)}` : 'no commits');
        const op = r.operation ? `<span class="badge warn" title="${esc(r.operation)} in progress${r.conflicts ? `, ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}` : ''}">${r.conflicts ? `⚠${r.conflicts}` : r.operation}</span>` : '';
        const track = r.ahead || r.behind ? `${r.ahead ? `<span class="badge out">↑${r.ahead}</span>` : ''}${r.behind ? `<span class="badge in">↓${r.behind}</span>` : ''}` : '';
        return `<div class="node repo${cur ? ' current' : ''}${sel}" data-id="${esc(n.id)}" style="${pad}" title="${esc(r.root)}"><span class="tw"></span><span class="muted-ic">${icons.mark}</span><span class="name">${esc(r.name)}</span><span class="repo-branch">${esc(where)}</span><span class="badges">${op}${track}</span></div>`;
      }
      if (n.kind === 'worktree') {
        const w = n.worktree!;
        const where = w.branch || (w.head ? `detached ${w.head.slice(0, 7)}` : '');
        const marks = `${w.main ? '<span class="badge" title="The main worktree: the repository\'s own folder">primary</span>' : ''}${w.locked !== undefined ? `<span class="badge warn" title="Locked${w.locked ? ': ' + esc(w.locked) : ''}">locked</span>` : ''}${w.prunable ? '<span class="badge warn" title="Its folder is gone: prune it">missing</span>' : ''}`;
        return `<div class="node repo${w.current ? ' current' : ''}${sel}" data-id="${esc(n.id)}" style="${pad}" title="${esc(w.path)}${w.current ? ' (this window)' : ''}"><span class="tw"></span><span class="muted-ic">${icons.folder}</span><span class="name">${esc(n.label)}</span><span class="repo-branch">${esc(where)}</span><span class="badges">${marks}</span></div>`;
      }
      if (n.kind === 'folder') {
        return `<div class="node${sel}" data-id="${esc(n.id)}" style="${pad}"><span class="tw">${open ? icons.chevronDown : icons.chevronRight}</span><span class="muted-ic">${icons.folder}</span><span class="name">${esc(n.label)}</span></div>`;
      }
      const r = n.ref!;
      const c = colorOf(r.hash);
      const mark = r.kind === 'tag' ? `<span class="muted-ic">${icons.tag}</span>` : `<span class="dot${r.current ? ' on' : ''}" style="--c:${c ?? 'var(--muted)'}"></span>`;
      const label = n.id.startsWith('p:') ? r.name : n.label;
      const elsewhere = r.kind === 'local' && !r.current ? state!.worktrees?.find((w) => w.branch === r.name && !w.current) : undefined;
      const wtBadge = elsewhere ? `<span class="badge wt" title="Checked out in ${esc(elsewhere.path)}">${esc(elsewhere.path.split(/[\\/]/).pop() || '')}</span>` : '';
      return `<div role="treeitem" aria-selected="${n.id === sideSel}" class="node ref${r.current ? ' current' : ''}${sel}" data-id="${esc(n.id)}" style="${pad}" title="${esc(r.name)}"><span class="tw"></span>${mark}<span class="name">${esc(label)}</span>${isPinned(r) && !n.id.startsWith('p:') ? `<span class="muted-ic small">${icons.pin}</span>` : ''}${wtBadge}${trackBadges(r)}</div>`;
    })
    .join('');
}

function toggleNode(id: string, open?: boolean): void {
  const set = new Set(ui.collapsed);
  const isOpen = !set.has(id);
  if (open === undefined ? isOpen : !open) set.add(id);
  else set.delete(id);
  ui.collapsed = [...set];
  save();
  renderSidebar();
}

function sideNode(id: string | undefined) {
  return sideFlat.find((x) => x.node.id === id);
}

function selectSide(id: string, reveal = true): void {
  sideSel = id;
  renderSidebar();
  refTree.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  const r = sideNode(id)?.node.ref;
  if (reveal && r) showCommit(r.hash);
}

refSearch.addEventListener('input', renderSidebar);
refSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    refTree.focus();
    const first = sideFlat.find((f) => f.node.kind === 'ref');
    if (first) selectSide(first.node.id);
  } else if (e.key === 'Escape') {
    refSearch.value = '';
    renderSidebar();
  }
});

refTree.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
  const f = row && sideNode(row.dataset.id);
  if (!f) return;
  if (f.node.kind === 'worktree') {
    sideSel = f.node.id;
    renderSidebar();
    return;
  }
  if (f.node.kind === 'repo') {
    // In the activity bar: show its branches here and bring up its log tab.
    if (f.node.repo!.root !== currentRepo || SIDEBAR) post({ type: 'setRepo', root: f.node.repo!.root, openLog: SIDEBAR });
    sideSel = f.node.id;
    return;
  }
  if (f.node.kind !== 'ref') {
    sideSel = f.node.id;
    toggleNode(f.node.id);
    return;
  }
  selectSide(f.node.id);
});

refTree.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
  const wt = row && sideNode(row.dataset.id)?.node.worktree;
  if (wt && !wt.current) {
    post({ type: 'worktree', action: 'open', path: wt.path });
    return;
  }
  const r = row && sideNode(row.dataset.id)?.node.ref;
  if (r) showOnly(r.full);
});

refTree.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const at = menuAnchor(e, refTree, '[data-id]', '.sel');
  const row = at?.el;
  const f = row && sideNode(row.dataset.id);
  if (f?.node.kind === 'worktree') {
    const w = f.node.worktree!;
    const wa = (action: 'open' | 'openHere' | 'remove' | 'lock' | 'unlock' | 'prune') => () => post({ type: 'worktree', action, path: w.path });
    showMenu(at!.x, at!.y, [
      { label: 'Open in New Window', run: wa('open'), disabled: w.current },
      { label: 'Open in This Window', run: wa('openHere'), disabled: w.current },
      'sep',
      w.locked !== undefined ? { label: 'Unlock', run: wa('unlock') } : { label: 'Lock', run: wa('lock'), disabled: w.main },
      { label: 'Remove Worktree…', run: wa('remove'), disabled: w.main || w.current },
      { label: 'Prune Missing Worktrees', run: wa('prune'), disabled: !state?.worktrees.some((x) => x.prunable) },
    ]);
    return;
  }
  if (f?.node.kind === 'repo') {
    const root = f.node.repo!.root;
    showMenu(at!.x, at!.y, [
      { label: 'Open Git Log', run: () => post({ type: 'setRepo', root, openLog: true }) },
      { label: 'Show Branches Here', run: () => post({ type: 'setRepo', root }), disabled: root === currentRepo },
    ]);
    return;
  }
  if (!f?.node.ref) return;
  selectSide(f.node.id, false);
  showMenu(at!.x, at!.y, refMenu(f.node.ref));
});

refTree.addEventListener('keydown', (e) => {
  const i = sideFlat.findIndex((f) => f.node.id === sideSel);
  const f = sideFlat[i];
  switch (e.key) {
    case 'ArrowDown':
      if (i < sideFlat.length - 1) selectSide(sideFlat[i + 1].node.id);
      break;
    case 'ArrowUp':
      if (i > 0) selectSide(sideFlat[i - 1].node.id);
      break;
    case 'ArrowRight':
      if (f?.node.children.length) toggleNode(f.node.id, true);
      break;
    case 'ArrowLeft':
      if (f?.node.children.length && !ui.collapsed.includes(f.node.id)) toggleNode(f.node.id, false);
      else
        for (let j = i - 1; j >= 0; j--)
          if (sideFlat[j].depth < (f?.depth ?? 0)) {
            selectSide(sideFlat[j].node.id, false);
            break;
          }
      break;
    case 'Enter':
      if (f?.node.ref) showOnly(f.node.ref.full);
      break;
    case 'Delete':
      if (f?.node.ref && !f.node.ref.current) post({ type: 'refAction', action: 'delete', ref: f.node.ref.full });
      break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) refSearch.focus();
      return;
  }
  e.preventDefault();
});

function refMenu(r: Ref): MenuItem[] {
  const cur = state?.branch || 'HEAD';
  const act = (action: string) => () => post({ type: 'refAction', action, ref: r.full });
  const pin: MenuItem = { label: isPinned(r) ? 'Unpin' : 'Pin to Top', run: () => post({ type: 'toggleFavorite', ref: r.full }) };
  const only: MenuItem = { label: 'Show Only This in Log', run: () => showOnly(r.full) };
  if (r.kind === 'local' && r.current) {
    return [
      { label: 'Create Branch Here…', run: act('newBranch') },
      { label: 'Diff Against Working Tree', run: act('diffWorktree') },
      'sep',
      { label: 'Pull (Fast-Forward)', run: act('update'), disabled: !r.upstream },
      { label: 'Push', run: act('push') },
      { label: 'Push (Force with Lease)', run: act('forcePush') },
      'sep',
      { label: 'Rename…', run: act('rename') },
      'sep',
      only,
      pin,
    ];
  }
  if (r.kind === 'local') {
    // A branch checked out in another worktree can't be switched to or deleted here.
    const elsewhere = !r.current && !!state?.worktrees?.some((w) => w.branch === r.name && !w.current);
    return [
      { label: 'Switch to Branch', run: act('checkout'), disabled: elsewhere },
      { label: `Create Branch from ${r.name}…`, run: act('newBranch') },
      { label: `Switch and Rebase onto ${cur}`, run: act('checkoutRebase'), disabled: !state?.branch },
      { label: 'Create Worktree…', run: act('newWorktree') },
      'sep',
      { label: `What's New Since ${cur}`, run: act('compare') },
      { label: 'Diff Against Working Tree', run: act('diffWorktree') },
      'sep',
      { label: `Merge into ${cur}`, run: act('merge') },
      { label: `Rebase ${cur} onto This`, run: act('rebase') },
      'sep',
      { label: 'Pull (Fast-Forward)', run: act('update'), disabled: !r.upstream },
      { label: 'Push', run: act('push') },
      { label: 'Rename…', run: act('rename') },
      { label: 'Delete Branch', run: act('delete'), key: 'Del', disabled: elsewhere },
      'sep',
      only,
      pin,
    ];
  }
  if (r.kind === 'remote') {
    return [
      { label: 'Switch to Branch (track)', run: act('checkout') },
      { label: 'Create Worktree…', run: act('newWorktree') },
      { label: `Create Branch from ${r.name}…`, run: act('newBranch') },
      'sep',
      { label: `What's New Since ${cur}`, run: act('compare') },
      { label: 'Diff Against Working Tree', run: act('diffWorktree') },
      'sep',
      { label: `Merge into ${cur}`, run: act('merge') },
      { label: `Rebase ${cur} onto This`, run: act('rebase') },
      { label: `Pull into ${cur} (merge)`, run: act('pullMerge'), disabled: !state?.branch },
      { label: `Pull into ${cur} (rebase)`, run: act('pullRebase'), disabled: !state?.branch },
      'sep',
      { label: 'Delete on Remote…', run: act('delete') },
      'sep',
      only,
      pin,
    ];
  }
  return [
    { label: 'Check Out Tag (Detached)', run: act('checkout') },
    { label: `Create Branch from ${r.name}…`, run: act('newBranch') },
    'sep',
    { label: `What's New Since ${cur}`, run: act('compare') },
    { label: 'Diff Against Working Tree', run: act('diffWorktree') },
    { label: `Merge into ${cur}`, run: act('merge') },
    'sep',
    { label: 'Push Tag', run: act('pushTag') },
    { label: 'Delete Tag', run: act('delete') },
    'sep',
    only,
  ];
}

$('sNew').addEventListener('click', () => {
  const r = sideNode(sideSel)?.node.ref;
  post({ type: 'refAction', action: 'newBranch', ref: r?.full ?? state?.refs.find((x) => x.current)?.full ?? 'HEAD' });
});
$('sCollapse').addEventListener('click', () => {
  const ids: string[] = [];
  const walk = (ns: SNode[]) =>
    ns.forEach((n) => {
      if (n.children.length && n.kind === 'folder') ids.push(n.id);
      walk(n.children);
    });
  walk(buildSidebar());
  ui.collapsed = [...ids, 's:tags'];
  save();
  renderSidebar();
});

// --------------------------------------------------------------- filters

function applyFilter(f: LogFilter, send = true): void {
  for (const k of Object.keys(f) as (keyof LogFilter)[]) {
    const v = f[k];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || v === false) delete f[k];
  }
  filter = f;
  ui.filter = f;
  save();
  if (textFilter.value !== (f.text ?? '')) textFilter.value = f.text ?? '';
  $('tRegex').classList.toggle('on', !!f.regex);
  $('tCase').classList.toggle('on', !!f.matchCase);
  $('tRegex').setAttribute('aria-pressed', String(!!f.regex));
  $('tCase').setAttribute('aria-pressed', String(!!f.matchCase));
  renderFilters();
  if (send) {
    pendingReveal = null;
    post({ type: 'setFilter', filter: f });
  }
}

function renderFilters(): void {
  const chip = (id: string, name: string, value: string | undefined) =>
    `<button class="chip${value ? ' active' : ''}" data-f="${id}" title="${esc(value ?? name)}"><span>${esc(value ?? name)}</span>${value ? `<span class="x" data-clear="${id}" title="Clear">${icons.close}</span>` : icons.chevronDown}</button>`;
  const many = (xs: string[] | undefined, fmt = (s: string) => s) => (xs?.length ? (xs.length === 1 ? fmt(xs[0]) : `${fmt(xs[0])} +${xs.length - 1}`) : undefined);
  const date = filter.since || filter.until ? [filter.since && `since ${filter.since}`, filter.until && `until ${filter.until}`].filter(Boolean).join(', ') : undefined;
  $('filters').innerHTML =
    chip('branch', 'Branch', many(filter.branches, refLabel)) +
    chip('user', 'Author', many(filter.authors, (a) => (a === state?.me ? 'Me' : a))) +
    chip('date', 'Date', date) +
    chip('paths', 'Path', filter.lines ? `${filter.lines.path.split('/').pop()}:${filter.lines.start}${filter.lines.end > filter.lines.start ? '–' + filter.lines.end : ''}` : many(filter.paths, (p) => (p.split('/').pop() || p) + (filter.follow ? ' (renames)' : '')));
}

$('filters').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const clear = t.closest<HTMLElement>('[data-clear]');
  if (clear) {
    e.stopPropagation();
    const f = { ...filter };
    const which = clear.dataset.clear;
    if (which === 'branch') delete f.branches;
    if (which === 'user') delete f.authors;
    if (which === 'date') delete f.since, delete f.until;
    if (which === 'paths') delete f.paths, delete f.lines, delete f.follow;
    applyFilter(f);
    return;
  }
  const btn = t.closest<HTMLElement>('[data-f]');
  if (!btn) return;
  ({ branch: branchPicker, user: userPicker, date: datePicker, paths: pathsPicker } as Record<string, (a: HTMLElement) => void>)[btn.dataset.f!]?.(btn);
});

function toggleIn(xs: string[] | undefined, x: string, multi: boolean): string[] {
  const cur = xs ?? [];
  if (!multi) return cur.length === 1 && cur[0] === x ? [] : [x];
  return cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x];
}

function branchPicker(anchorEl: HTMLElement): void {
  const sel = new Set(filter.branches ?? []);
  const items: PickItem[] = [{ id: '*', label: 'All branches', checked: !sel.size }, { id: 'HEAD', label: 'Current branch (HEAD)', checked: sel.has('HEAD') }];
  const refs = state?.refs ?? [];
  const pinned = refs.filter((r) => isPinned(r) || r.current);
  if (pinned.length) items.push({ id: '', label: 'Pinned', head: true }, ...pinned.map((r) => ({ id: r.full, label: r.name, checked: sel.has(r.full) })));
  for (const [kind, title] of [['local', 'Branches'], ['remote', 'Remotes'], ['tag', 'Tags']] as const) {
    const rs = refs.filter((r) => r.kind === kind && !pinned.includes(r));
    if (rs.length) items.push({ id: '', label: title, head: true }, ...rs.map((r) => ({ id: r.full, label: r.name, checked: sel.has(r.full) })));
  }
  showPicker(anchorEl, items, (id, multi) => applyFilter({ ...filter, branches: id === '*' ? [] : toggleIn(filter.branches, id, multi) }), 'Branch or tag — Ctrl+click for several');
}

function userPicker(anchorEl: HTMLElement): void {
  const sel = new Set(filter.authors ?? []);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.author, (counts.get(r.author) ?? 0) + 1);
  const authors = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  const me = state?.me;
  const items: PickItem[] = [{ id: '*', label: 'Everyone', checked: !sel.size }];
  if (me) items.push({ id: me, label: `Me (${me})`, checked: sel.has(me) });
  for (const a of authors) if (a !== me) items.push({ id: a, label: a, checked: sel.has(a) });
  for (const a of sel) if (!items.some((i) => i.id === a)) items.push({ id: a, label: a, checked: true });
  showPicker(anchorEl, items, (id, multi) => applyFilter({ ...filter, authors: id === '*' ? [] : toggleIn(filter.authors, id, multi) }), 'Author — Ctrl+click for several');
}

function datePicker(anchorEl: HTMLElement): void {
  const opts: [string, string][] = [
    ['', 'Any time'],
    ['24 hours ago', 'Past day'],
    ['7 days ago', 'Past week'],
    ['30 days ago', 'Past month'],
    ['1 year ago', 'Past year'],
  ];
  const items: PickItem[] = opts.map(([id, label]) => ({ id: id || '*', label, checked: (filter.since ?? '') === id && !filter.until }));
  items.push({ id: '?', label: 'Custom range…' });
  showPicker(anchorEl, items, (id) => {
    if (id === '?') post({ type: 'pickDate' });
    else applyFilter({ ...filter, since: id === '*' ? undefined : id, until: undefined });
  });
}

function pathsPicker(anchorEl: HTMLElement): void {
  const items: PickItem[] = [{ id: '*', label: 'Whole repository', checked: !filter.paths?.length }];
  for (const p of filter.paths ?? []) items.push({ id: p, label: p, checked: true });
  items.push({ id: '?', label: 'Choose files or folders…' });
  showPicker(anchorEl, items, (id) => {
    if (id === '?') post({ type: 'pickPaths' });
    else applyFilter({ ...filter, paths: id === '*' ? [] : (filter.paths ?? []).filter((p) => p !== id) });
  });
}

let textTimer: number | undefined;
textFilter.addEventListener('input', () => {
  clearTimeout(textTimer);
  textTimer = window.setTimeout(() => applyFilter({ ...filter, text: textFilter.value.trim() }), 400);
});
textFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(textTimer);
    applyFilter({ ...filter, text: textFilter.value.trim() });
  } else if (e.key === 'Escape') {
    textFilter.value = '';
    applyFilter({ ...filter, text: '' });
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    list.focus();
    if (!selected.size && rows.length) selectRow(0, false, false);
  }
});
$('tRegex').addEventListener('click', () => applyFilter({ ...filter, regex: !filter.regex }, !!filter.text));
$('tCase').addEventListener('click', () => applyFilter({ ...filter, matchCase: !filter.matchCase }, !!filter.text));

const toggleUi = (key: 'showSidebar' | 'showInspector' | 'showHash') => () => {
  ui[key] = !ui[key];
  save();
  layout();
  renderRows();
};
$('tSidebar').addEventListener('click', toggleUi('showSidebar'));
$('tInspector').addEventListener('click', toggleUi('showInspector'));
$('tHash').addEventListener('click', toggleUi('showHash'));
$('tRefresh').addEventListener('click', () => post({ type: 'refresh' }));
$('tFetch').addEventListener('click', () => post({ type: 'fetch' }));
repoSelect.addEventListener('change', () => post({ type: 'setRepo', root: repoSelect.value }));

// ------------------------------------------------------------------- log

const X = (l: number) => l * LANE_W + LANE_W / 2 + 4;

/** A smooth S-curve between two lanes over half a row. */
function seg(a: number, b: number, y0: number, y1: number): string {
  const xa = X(a);
  const xb = X(b);
  if (a === b) return `M${xa} ${y0}V${y1}`;
  const k = (y1 - y0) * 0.6;
  return `M${xa} ${y0}C${xa} ${y0 + k} ${xb} ${y1 - k} ${xb} ${y1}`;
}

function graphSvg(r: LogRow, isHead: boolean): string {
  const g = r.graph;
  const stubs = (g.down?.length ?? 0) + (g.up?.length ?? 0);
  const w = (g.width + (stubs ? 1 : 0)) * LANE_W + 8;
  const H = ROW_H;
  const byColor = new Map<number, string[]>();
  const add = (c: number, d: string) => byColor.set(c, [...(byColor.get(c) ?? []), d]);
  for (const s of g.top) add(s.color, seg(s.a, s.b, 0, H / 2));
  for (const s of g.bottom) add(s.color, seg(s.a, s.b, H / 2, H));
  let out = '';
  for (const [c, ds] of byColor) out += `<path d="${ds.join('')}" stroke="${line(c)}" class="ln"/>`;
  const cx = X(g.lane);
  const cy = H / 2;
  // Long edges: a short dashed tail that fades out; click to follow it.
  const sx = X(g.width);
  const tail = (to: string, c: number, down: boolean) => {
    const ty = down ? H : 0;
    const d = `M${cx} ${cy}C${cx + 6} ${cy} ${sx} ${(cy + ty) / 2} ${sx} ${ty}`;
    out += `<g class="jump" data-jump="${to}"><title>${down ? 'Continues to' : 'Comes from'} ${short(to)} — click to follow</title><path d="${d}" class="hit"/><path d="${d}" stroke="${line(c)}" class="tail"/><circle cx="${sx}" cy="${down ? H - 2.5 : 2.5}" r="2" fill="${line(c)}"/></g>`;
  };
  (g.down ?? []).forEach((s) => tail(s.to, s.color, true));
  (g.up ?? []).forEach((s) => tail(s.to, s.color, false));
  const c = line(g.color);
  if (isHead) out += `<circle cx="${cx}" cy="${cy}" r="9" fill="${c}" opacity=".22"/><circle cx="${cx}" cy="${cy}" r="5.2" fill="${c}"/><circle cx="${cx}" cy="${cy}" r="2" fill="var(--bg)"/>`;
  else if (r.parents.length > 1) out += `<circle cx="${cx}" cy="${cy}" r="5" fill="var(--bg)" stroke="var(--fg)" stroke-width="2"/>`;
  else out += `<circle cx="${cx}" cy="${cy}" r="4.3" fill="var(--bg)" stroke="${c}" stroke-width="2.4"/>`;
  return `<svg class="g" width="${w}" height="${H}">${out}</svg>`;
}

// Compiled once per filter, not per row; a regex that won't compile (or is suspiciously long)
// just isn't highlighted. git searches with its own engine either way.
let hlKey = '';
let hlRe: RegExp | null = null;
function highlighter(): RegExp | null {
  const key = `${filter.text}\u0000${filter.regex}\u0000${filter.matchCase}`;
  if (key === hlKey) return hlRe;
  hlKey = key;
  hlRe = null;
  const q = filter.text;
  if (q && q.length <= 200) {
    try {
      hlRe = new RegExp(filter.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), filter.matchCase ? 'g' : 'gi');
    } catch {
      hlRe = null;
    }
  }
  return hlRe;
}

function highlight(text: string): string {
  const re = highlighter();
  if (!re) return esc(text);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** Ref pills in the commit's line colour. A local branch level with its upstream shows as one pill. */
function pills(hash: string, c: string, max = 2): string {
  const refs = refsByHash.get(hash) ?? [];
  const detached = state && !state.branch && state.head === hash;
  if (!refs.length && !detached) return '';
  const merged = new Set<string>();
  const out: string[] = [];
  if (detached) out.push(`<span class="pill head" style="--c:${c};--head-text:${textOn(c)}">HEAD</span>`);
  for (const r of refs) {
    if (merged.has(r.full)) continue;
    if (r.kind === 'tag') {
      out.push(`<span class="pill tag" title="tag ${esc(r.name)}">${icons.tag}<span>${esc(r.name)}</span></span>`);
      continue;
    }
    if (r.kind === 'local' && r.upstream) {
      const up = refs.find((x) => x.kind === 'remote' && x.name === r.upstream);
      if (up) merged.add(up.full);
    }
    const synced = r.kind === 'local' && r.upstream && merged.has('refs/remotes/' + r.upstream);
    const name = r.kind === 'remote' ? `<span class="dim">${esc(r.name.split('/')[0])}/</span>${esc(r.name.slice(r.name.indexOf('/') + 1))}` : esc(r.name);
    out.push(
      `<span class="pill ${r.current ? 'head' : r.kind}" style="--c:${c};--head-text:${textOn(c)}" title="${esc(r.full)}${synced ? ` = ${esc(r.upstream!)}` : ''}"><span>${name}</span>${synced ? `<span class="sync" title="Level with ${esc(r.upstream!)}">${icons.cloud}</span>` : ''}</span>`,
    );
  }
  const shown = out.slice(0, max);
  if (out.length > max) shown.push(`<span class="pill more" title="${esc(refs.map((r) => r.name).join('\n'))}">+${out.length - max}</span>`);
  return `<span class="pills">${shown.join('')}</span>`;
}

let rafPending = false;
function renderRows(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    drawRows();
  });
}

function drawRows(): void {
  if (SIDEBAR) return; // rows are kept only to colour the branch dots
  if (!rows.length) {
    spacer.style.height = '0px';
    viewport.style.transform = '';
    viewport.innerHTML = `<div class="empty">${esc(emptyMessage || (filtered && Object.keys(filter).length ? 'No commits match these filters.' : 'Loading history…'))}</div>`;
    return;
  }
  spacer.style.height = `${rows.length * ROW_H + (hasMore ? 30 : 0)}px`;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_H) + 8);
  const head = state?.head;
  const me = state?.me;
  let html = '';
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const cls = ['row'];
    if (selected.has(r.hash)) cls.push('sel');
    if (r.parents.length > 1) cls.push('merge');
    if (r.hash === head) cls.push('head');
    html +=
      `<div class="${cls.join(' ')}" data-i="${i}" role="option" aria-selected="${selected.has(r.hash)}" id="row-${i}">` +
      `${graphSvg(r, r.hash === head)}` +
      `<span class="msg">${pills(r.hash, line(r.graph.color), document.body.classList.contains('stacked') || list.clientWidth < 700 ? 1 : 2)}<span class="subject">${highlight(r.subject)}</span></span>` +
      `<span class="author${r.author === me ? ' me' : ''}" title="${esc(r.author)} <${esc(r.email)}>">${avatar(r.author, 16)}<span>${esc(r.author)}</span></span>` +
      `<span class="date" title="${esc(fullDate(r.authorTime))}">${esc(formatDate(r.authorTime))}</span>` +
      (ui.showHash ? `<span class="hash">${short(r.hash)}</span>` : '') +
      `</div>`;
  }
  if (hasMore && last === rows.length) html += `<div class="more">Loading more…</div>`;
  viewport.style.transform = `translateY(${first * ROW_H}px)`;
  viewport.innerHTML = html;
  if (cursor >= first && cursor < last) list.setAttribute('aria-activedescendant', `row-${cursor}`);
  else list.removeAttribute('aria-activedescendant');
  if (hasMore && !loadingMore && last >= rows.length - 40) {
    loadingMore = true;
    post({ type: 'loadMore' });
  }
}

list.addEventListener('scroll', renderRows);
window.addEventListener('resize', () => {
  layout();
  renderRows();
});
new ResizeObserver(() => {
  layout();
  renderRows();
}).observe(list);

let selectTimer: number | undefined;
function selectionChanged(): void {
  renderRows();
  clearTimeout(selectTimer);
  const hashes = selectedHashes();
  if (!hashes.length) {
    changes = null;
    changesLoading = false;
    renderInspector();
    return;
  }
  changesLoading = true;
  renderInspector();
  selectTimer = window.setTimeout(() => post({ type: 'select', hashes }), 80);
}

function selectRow(i: number, extend: boolean, toggle: boolean): void {
  if (i < 0 || i >= rows.length) return;
  if (toggle) {
    const h = rows[i].hash;
    if (selected.has(h)) selected.delete(h);
    else selected.add(h);
    anchor = i;
  } else if (extend && anchor >= 0) {
    selected.clear();
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
    for (let k = a; k <= b; k++) selected.add(rows[k].hash);
  } else {
    selected.clear();
    selected.add(rows[i].hash);
    anchor = i;
  }
  cursor = i;
  ensureVisible(i);
  selectionChanged();
}

function ensureVisible(i: number, center = false): void {
  const top = i * ROW_H;
  const outside = top < list.scrollTop || top + ROW_H > list.scrollTop + list.clientHeight;
  if (center) {
    if (outside) list.scrollTop = top - list.clientHeight / 2 + ROW_H / 2;
  } else if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
}

function revealCommit(hash: string): void {
  const i = indexOf.get(hash);
  if (i !== undefined) {
    pendingReveal = null;
    selected.clear();
    selected.add(hash);
    anchor = cursor = i;
    ensureVisible(i, true);
    selectionChanged();
    return;
  }
  if (hasMore && revealTries < 20) {
    pendingReveal = hash;
    revealTries++;
    if (!loadingMore) {
      loadingMore = true;
      post({ type: 'loadMore' });
    }
  } else {
    pendingReveal = null;
    toast(filtered ? 'That commit is hidden by the current filters.' : 'That commit is not in the loaded history.');
  }
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  let t = document.querySelector<HTMLElement>('.toast');
  if (!t) document.body.appendChild((t = Object.assign(document.createElement('div'), { className: 'toast' })));
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('on'), 2600);
}

list.addEventListener('mousedown', (e) => {
  const jump = (e.target as Element).closest?.('[data-jump]');
  if (jump && e.button === 0) {
    e.preventDefault();
    list.focus();
    revealCommit(jump.getAttribute('data-jump')!);
    return;
  }
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (!row || e.button !== 0) return;
  selectRow(+row.dataset.i!, e.shiftKey, e.ctrlKey || e.metaKey);
});

list.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const at = menuAnchor(e, list, '.row', '.row.sel');
  if (!at) return;
  const i = +at.el.dataset.i!;
  if (!selected.has(rows[i].hash)) selectRow(i, false, false);
  list.focus();
  showMenu(at.x, at.y, commitMenu());
});

function selectedHashes(): string[] {
  return rows.filter((r) => selected.has(r.hash)).map((r) => r.hash);
}

function commitMenu(): MenuItem[] {
  const hashes = selectedHashes();
  const one = hashes.length === 1;
  const row = rows[indexOf.get(hashes[0])!];
  const isHead = one && hashes[0] === state?.head;
  const act = (action: string) => () => {
    // These fill the inspector themselves: drop the pending "show this commit" request.
    if (action === 'compareWithLocal') clearTimeout(selectTimer);
    post({ type: 'commitAction', action, hashes });
  };
  const n = hashes.length > 1 ? ` (${hashes.length})` : '';
  return [
    { label: `Copy Hash${n}`, run: act('copyHash'), key: 'Ctrl+C' },
    { label: 'Copy Message', run: act('copySubject') },
    { label: 'Open on Remote', run: act('browse'), disabled: !one },
    'sep',
    { label: `Cherry-Pick onto ${state?.branch || 'HEAD'}${n}`, run: act('cherryPick'), disabled: hashes.includes(state?.head ?? '') },
    { label: `Cherry-Pick, Noting the Source (-x)${n}`, run: act('cherryPickX'), disabled: hashes.includes(state?.head ?? '') },
    { label: `Revert${n}`, run: act('revert') },
    { label: 'Export as Patch', run: act('createPatch') },
    'sep',
    { label: 'Create Branch Here…', run: act('newBranch'), disabled: !one },
    { label: 'Create Worktree Here…', run: act('newWorktree'), disabled: !one },
    { label: 'Tag This Commit…', run: act('newTag'), disabled: !one },
    { label: 'Check Out Commit (Detached)', run: act('checkout'), disabled: !one },
    { label: 'Diff Against Working Tree', run: act('compareWithLocal'), disabled: !one },
    'sep',
    { label: `Move ${state?.branch || 'HEAD'} Here (Reset)…`, run: act('reset'), disabled: !one },
    { label: 'Rebase Interactively from Here…', run: act('interactiveRebase'), disabled: !one },
    { label: 'Amend Message…', run: act('rewordHead'), disabled: !isHead },
    { label: 'Uncommit (Keep Changes)', run: act('undoCommit'), disabled: !isHead || (row?.parents.length ?? 0) > 1 },
    'sep',
    { label: 'Go to Parent', run: goParent, disabled: !one || !row?.parents.length, key: '→' },
    { label: 'Go to Child', run: goChild, disabled: !one, key: '←' },
  ];
}

function goParent(): void {
  const r = rows[cursor];
  if (r?.parents[0]) revealCommit(r.parents[0]);
}

function goChild(): void {
  const r = rows[cursor];
  if (!r) return;
  for (let i = cursor - 1; i >= 0; i--)
    if (rows[i].parents.includes(r.hash)) {
      revealCommit(rows[i].hash);
      return;
    }
}

list.addEventListener('keydown', (e) => {
  const page = Math.max(1, Math.floor(list.clientHeight / ROW_H) - 1);
  const c = cursor;
  switch (e.key) {
    case 'ArrowDown':
      selectRow(Math.min(rows.length - 1, c + 1), e.shiftKey, false);
      break;
    case 'ArrowUp':
      selectRow(Math.max(0, c - 1), e.shiftKey, false);
      break;
    case 'PageDown':
      selectRow(Math.min(rows.length - 1, c + page), e.shiftKey, false);
      break;
    case 'PageUp':
      selectRow(Math.max(0, c - page), e.shiftKey, false);
      break;
    case 'Home':
      selectRow(0, e.shiftKey, false);
      break;
    case 'End':
      selectRow(rows.length - 1, e.shiftKey, false);
      break;
    case 'ArrowRight':
      goParent();
      break;
    case 'ArrowLeft':
      goChild();
      break;
    case 'Enter':
      // Land on the first file, so Enter and Shift+F10 work without an arrow key first.
      if (!fileFlat.some((n) => n.id === fileSel)) {
        const first = fileFlat.find((n) => n.kind === 'file');
        if (first) {
          fileSel = first.id;
          renderFiles();
        }
      }
      files.focus();
      break;
    case 'a':
      if (!(e.ctrlKey || e.metaKey)) return;
      rows.forEach((r) => selected.add(r.hash));
      selectionChanged();
      break;
    case 'c':
      if (!(e.ctrlKey || e.metaKey) || !selected.size) return;
      post({ type: 'commitAction', action: 'copyHash', hashes: selectedHashes() });
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------ operation

const CODE_TEXT: Record<string, string> = {
  UU: 'both changed',
  AA: 'both added',
  DU: 'deleted on ours, changed on theirs',
  UD: 'changed on ours, deleted on theirs',
  AU: 'added on ours',
  UA: 'added on theirs',
  DD: 'deleted on both',
};

function renderOperation(): void {
  const bar = $('opbar');
  const op = state?.operation;
  bar.hidden = !op;
  if (!op) return;
  const verb = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', am: 'Applying patches', conflicts: 'Unresolved changes' }[op.kind];
  const inProgress = op.kind !== 'conflicts';
  const n = op.conflicts.length;
  const progress = op.step && op.total ? ` · step ${op.step} of ${op.total}` : '';
  const files = op.conflicts
    .map(
      (c) => `<div class="cf" data-path="${esc(c.path)}">
        <span class="st" title="${esc(CODE_TEXT[c.code] ?? c.code)}">!</span>
        <span class="cf-name" title="${esc(c.path)}">${esc(c.path)}</span>
        <span class="muted small cf-why">${esc(CODE_TEXT[c.code] ?? c.code)}</span>
        <button class="mini primary" data-cf="open" ${c.code === 'UU' || c.code === 'AA' ? '' : 'disabled'}>Resolve…</button>
        <button class="mini" data-cf="ours" title="${esc(op.ours)}">Keep ours</button>
        <button class="mini" data-cf="theirs" title="${esc(op.theirs)}">Keep theirs</button>
        <button class="mini" data-cf="resolved" title="Stage the file as it is now">Mark resolved</button>
      </div>`,
    )
    .join('');
  bar.innerHTML = `
    <div class="op-head">
      <span class="op-ic">${n ? '⚠' : '✓'}</span>
      <div class="op-text"><b>${verb}${progress}</b> — ${n ? `${n} conflict${n === 1 ? '' : 's'} to resolve` : 'all conflicts resolved'}
        <div class="muted small">ours = <b>${esc(op.ours)}</b> · theirs = <b>${esc(op.theirs)}</b></div></div>
      <span class="grow"></span>
      ${inProgress ? `<button class="mini primary" data-op="continue" ${n ? 'disabled title="Resolve every conflict first"' : ''}>Continue</button>` : ''}
      ${inProgress && op.kind !== 'merge' ? '<button class="mini" data-op="skip" title="Drop this commit and go on">Skip</button>' : ''}
      ${inProgress ? '<button class="mini danger" data-op="abort">Abort</button>' : ''}
    </div>
    ${op.kind === 'conflicts' && op.theirs === 'stashed changes' ? '<div class="muted small op-note">If these came from a stash pop, the changes also stay in the stash: once they are resolved, check <code>git stash list</code> before dropping it.</div>' : ''}
    ${files ? `<div class="cf-list">${files}</div>` : ''}`;
}

$('opbar').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const op = t.closest<HTMLButtonElement>('[data-op]');
  if (op && !op.disabled) post({ type: 'operation', action: op.dataset.op as 'continue' | 'skip' | 'abort' });
  const cf = t.closest<HTMLButtonElement>('[data-cf]');
  const row = t.closest<HTMLElement>('[data-path]');
  if (cf && row && !cf.disabled) post({ type: 'conflict', action: cf.dataset.cf as 'open' | 'ours' | 'theirs' | 'resolved', path: row.dataset.path! });
});
$('opbar').addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  if (row && !(e.target as HTMLElement).closest('button')) post({ type: 'conflict', action: 'open', path: row.dataset.path! });
});

// ------------------------------------------------------------- inspector

interface FNode {
  id: string;
  name: string;
  depth: number;
  kind: 'dir' | 'file';
  file?: FileChange;
  count?: number;
  open?: boolean;
}

let fileFlat: FNode[] = [];

function currentGroup() {
  return changes?.groups[Math.min(parentIx, (changes?.groups.length ?? 1) - 1)];
}

function buildFiles(): FNode[] {
  const g = currentGroup();
  if (!g) return [];
  const byPath = (a: FileChange, b: FileChange) => a.path.localeCompare(b.path);
  if (ui.fileView === 'list') return [...g.files].sort(byPath).map((f) => ({ id: f.path, name: f.path, depth: 0, kind: 'file' as const, file: f }));
  interface Dir {
    dirs: Map<string, Dir>;
    files: FileChange[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of g.files) {
    let d = root;
    for (const p of f.path.split('/').slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  const count = (d: Dir): number => d.files.length + [...d.dirs.values()].reduce((s, x) => s + count(x), 0);
  const out: FNode[] = [];
  const walk = (d: Dir, prefix: string, depth: number) => {
    for (const [name, sub] of [...d.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      let label = name;
      let node = sub;
      let path = prefix + name;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [n2, s2] = [...node.dirs.entries()][0];
        label += '/' + n2;
        path += '/' + n2;
        node = s2;
      }
      const open = !folderCollapsed.has(path);
      out.push({ id: 'd:' + path, name: label, depth, kind: 'dir', count: count(node), open });
      if (open) walk(node, path + '/', depth + 1);
    }
    for (const f of [...d.files].sort(byPath)) out.push({ id: f.path, name: f.path.split('/').pop()!, depth, kind: 'file', file: f });
  };
  walk(root, '', 0);
  return out;
}

function renderInspector(): void {
  renderCard();
  renderFiles();
}

function sameSelection(): boolean {
  if (!changes) return false;
  const hs = selectedHashes();
  return hs.length === changes.hashes.length && hs.every((h, i) => h === changes!.hashes[i]);
}

function renderCard(): void {
  if (!changes && !changesLoading) {
    card.innerHTML = `<div class="card-empty"><div class="big">${icons.mark}</div>Select a commit to inspect it.<br><span class="muted">Shift/Ctrl+click to compare several.</span></div>`;
    return;
  }
  if (changesLoading && !sameSelection() && !(changes && !changes.hashes.length)) {
    card.innerHTML = `<div class="card-empty">Loading…</div>`;
    return;
  }
  const c = changes!;
  const d = c.details;
  if (!d) {
    card.innerHTML = `<div class="card-title">${esc(c.groups[0]?.label || `${c.hashes.length} commit${c.hashes.length === 1 ? '' : 's'}`)}</div>`;
    return;
  }
  const [subject, ...rest] = d.body.split('\n');
  const body = rest.join('\n').trim();
  const col = colorOf(d.hash) ?? 'var(--accent)';
  const inRefs = containing.get(d.hash);
  if (!inRefs) {
    containing.set(d.hash, []);
    post({ type: 'containing', hash: d.hash });
  }
  const reach = inRefs?.length
    ? `<div class="reach"><span class="muted">In branches:</span> ${inRefs
        .slice(0, 8)
        .map((n) => `<span class="pill ${n.includes('/') && !state?.refs.some((r) => r.kind === 'local' && r.name === n) ? 'remote' : 'local'}" style="--c:${col}">${esc(n)}</span>`)
        .join('')}${inRefs.length > 8 ? `<a data-more>+${inRefs.length - 8} more</a>` : ''}</div>`
    : '';
  const committed = d.committer !== d.author ? `<div class="muted small">committed by ${esc(d.committer)} · ${esc(relative(d.commitTime))}</div>` : '';
  card.innerHTML = `
    <div class="card-title">${esc(subject)}</div>
    <div class="who">${avatar(d.author, 22)}<div><div><b>${esc(d.author)}</b> <span class="muted">${esc(d.email)}</span></div><div class="muted small" title="${esc(fullDate(d.authorTime))}">${esc(relative(d.authorTime))} · ${esc(fullDate(d.authorTime))}</div>${committed}</div></div>
    ${body ? `<div class="body">${esc(body)}</div>` : ''}
    <div class="chips-row">
      <button class="hchip" data-copy="${d.hash}" title="Copy full hash">${icons.copy}<code>${short(d.hash)}</code></button>
      ${d.parents.map((p, i) => `<button class="hchip parent" data-reveal="${p}" title="Go to parent ${i + 1}">${d.parents.length > 1 ? `P${i + 1} ` : '↳ '}<code>${short(p)}</code></button>`).join('')}
    </div>
    ${reach}`;
}

card.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const copy = t.closest<HTMLElement>('[data-copy]');
  if (copy) {
    post({ type: 'commitAction', action: 'copyHash', hashes: [copy.dataset.copy!] });
    toast('Hash copied');
  }
  const rev = t.closest<HTMLElement>('[data-reveal]');
  if (rev) revealCommit(rev.dataset.reveal!);
  if (t.closest('[data-more]') && changes?.details) {
    const names = containing.get(changes.details.hash) ?? [];
    t.closest('.reach')!.innerHTML = `<span class="muted">In branches:</span> ${names.map((n) => `<span class="pill local" style="--c:var(--accent)">${esc(n)}</span>`).join('')}`;
  }
});

function renderFiles(): void {
  if (!changes || (changesLoading && !sameSelection() && changes.hashes.length)) {
    filesbar.innerHTML = '';
    files.innerHTML = '';
    return;
  }
  const c = changes;
  const merge = c.groups.length > 1;
  const g = currentGroup();
  if (!g) {
    filesbar.innerHTML = '';
    files.innerHTML = '';
    return;
  }
  const seg = merge
    ? `<div class="segmented" role="tablist">${c.groups
        .map((x, i) => {
          const label = x.label.replace(/^Changes to parent \d+: [0-9a-f]+ ?/, '');
          return `<button role="tab" aria-selected="${i === parentIx}" class="${i === parentIx ? 'on' : ''}" data-parent="${i}" title="Changes this merge brought relative to parent ${i + 1}${label ? ': ' + esc(label) : ''}">vs P${i + 1} <span class="n">${x.files.length}</span></button>`;
        })
        .join('')}</div>`
    : `<span class="files-title">${g.files.length} file${g.files.length === 1 ? '' : 's'} changed</span>`;
  filesbar.innerHTML = `${seg}<span class="grow"></span>
    <button class="iconbtn${ui.fileView === 'tree' ? ' on' : ''}" data-view="tree" title="Folders">${icons.tree}</button>
    <button class="iconbtn${ui.fileView === 'list' ? ' on' : ''}" data-view="list" title="Flat list">${icons.list}</button>
    <button class="iconbtn" data-diff title="Open diff (Enter)">${icons.diff}</button>`;
  fileFlat = buildFiles();
  const resolved = new Set(c.resolved);
  if (!fileFlat.length) {
    files.innerHTML = `<div class="hint-empty">${merge ? 'Identical to this parent — the merge took everything from here.' : 'No file changes.'}</div>`;
    return;
  }
  files.innerHTML =
    (merge && c.resolved.length ? `<div class="note">${c.resolved.length} file${c.resolved.length === 1 ? ' was' : 's were'} edited during the merge (marked ✎).</div>` : '') +
    fileFlat
      .map((n) => {
        const pad = `padding-left:${n.depth * 14 + 6}px`;
        const sel = n.id === fileSel ? ' sel' : '';
        if (n.kind === 'dir')
          return `<div class="node${sel}" data-id="${esc(n.id)}" style="${pad}"><span class="tw">${n.open ? icons.chevronDown : icons.chevronRight}</span><span class="muted-ic">${icons.folder}</span><span class="name">${esc(n.name)}</span><span class="count">${n.count}</span></div>`;
        const f = n.file!;
        const dir = ui.fileView === 'list' && n.name.includes('/') ? n.name.slice(0, n.name.lastIndexOf('/') + 1) : '';
        const base = dir ? n.name.slice(dir.length) : n.name;
        return `<div class="node file st-${f.status}${sel}" data-id="${esc(n.id)}" style="${pad}" title="${esc(f.path)}"><span class="st">${f.status}</span><span class="name">${dir ? `<span class="muted">${esc(dir)}</span>` : ''}${esc(base)}</span>${f.oldPath ? `<span class="muted small ell">from ${esc(f.oldPath)}</span>` : ''}${resolved.has(f.path) && merge ? `<span class="edited" title="Edited during the merge: differs from every parent">✎</span>` : ''}</div>`;
      })
      .join('');
}

filesbar.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const p = t.closest<HTMLElement>('[data-parent]');
  if (p) {
    parentIx = +p.dataset.parent!;
    fileSel = '';
    renderFiles();
  }
  const v = t.closest<HTMLElement>('[data-view]');
  if (v) {
    ui.fileView = v.dataset.view as 'tree' | 'list';
    save();
    renderFiles();
  }
  if (t.closest('[data-diff]')) openFile(fileFlat.find((n) => n.id === fileSel) ?? fileFlat.find((n) => n.kind === 'file'), true);
});

function openFile(n: FNode | undefined, focus: boolean): void {
  const g = currentGroup();
  if (!n?.file || !g || !changes) return;
  post({ type: 'openDiff', base: g.base, target: changes.target, file: n.file, focus });
}

files.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
  const n = row && fileFlat.find((x) => x.id === row.dataset.id);
  if (!n) return;
  fileSel = n.id;
  if (n.kind === 'dir') {
    const path = n.id.slice(2);
    if (n.open) folderCollapsed.add(path);
    else folderCollapsed.delete(path);
  } else openFile(n, false);
  renderFiles();
});
files.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
  openFile(row ? fileFlat.find((x) => x.id === row.dataset.id) : undefined, true);
});
files.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const at = menuAnchor(e, files, '[data-id]', '.node.sel');
  const row = at?.el;
  const n = row && fileFlat.find((x) => x.id === row.dataset.id);
  if (!n?.file || !changes) return;
  fileSel = n.id;
  renderFiles();
  const file = n.file;
  const target = changes.target;
  const wt = target === 'WORKTREE';
  const base = currentGroup()?.base ?? '';
  const fa = (action: string) => () => post({ type: 'fileAction', action, target, file, base });
  showMenu(at!.x, at!.y, [
    { label: 'Open Diff', run: () => openFile(n, true), key: 'Enter' },
    { label: 'Diff Against Working Tree', run: fa('compareLocal'), disabled: wt || file.status === 'D' },
    'sep',
    { label: 'Open This Version', run: fa('openRevision'), disabled: wt || file.status === 'D' },
    { label: 'Open Working Copy', run: fa('openLocal'), disabled: file.status === 'D' },
    { label: 'Restore This Version to Working Tree…', run: fa('getFromRevision'), disabled: wt },
    { label: 'Cherry-Pick This File’s Change', run: fa('applyChange'), disabled: wt || !base },
    'sep',
    { label: 'File History', run: fa('history') },
    { label: 'Copy Path', run: fa('copyPath') },
  ]);
});
files.addEventListener('keydown', (e) => {
  const i = fileFlat.findIndex((n) => n.id === fileSel);
  const n = fileFlat[i];
  switch (e.key) {
    case 'ArrowDown':
      if (i < fileFlat.length - 1) fileSel = fileFlat[i + 1].id;
      break;
    case 'ArrowUp':
      if (i > 0) fileSel = fileFlat[i - 1].id;
      break;
    case 'ArrowRight':
      if (n?.kind === 'dir') folderCollapsed.delete(n.id.slice(2));
      break;
    case 'ArrowLeft':
      if (n?.kind === 'dir') folderCollapsed.add(n.id.slice(2));
      break;
    case 'Enter':
      openFile(n, true);
      return;
    default:
      return;
  }
  e.preventDefault();
  renderFiles();
  files.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') openFile(fileFlat.find((x) => x.id === fileSel), false);
});

// -------------------------------------------------------------- messages

window.addEventListener('message', (ev: MessageEvent<ToView>) => {
  const m = ev.data;
  switch (m.type) {
    case 'repos':
      repos = m.repos;
      if (m.current !== currentRepo) {
        currentRepo = m.current;
        // A highlighted repository row follows the repository now shown, so the list never
        // highlights one repository while the card shows another.
        if (sideSel.startsWith('r:')) sideSel = 'r:' + currentRepo;
        (ui as UiState & { root?: string }).root = currentRepo; // lets a restored tab find its repository
        save();
        rows = [];
        indexOf = new Map();
        selected.clear();
        changes = null;
        containing.clear();
        emptyMessage = '';
        renderInspector();
      }
      repoSelect.hidden = repos.length < 2;
      repoSelect.innerHTML = repos.map((r) => `<option value="${esc(r.root)}"${r.root === currentRepo ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
      repoSelect.title = currentRepo;
      renderSidebar();
      return;
    case 'settings':
      palette = m.palette;
      applyPalette();
      renderRows();
      renderSidebar();
      renderCard();
      return;
    case 'state':
      state = m.state;
      indexRefs();
      renderOperation();
      renderSidebar();
      renderFilters();
      renderRows();
      return;
    case 'log':
      loadingMore = false;
      firstLog = firstLog === null ? true : false;
      emptyMessage = '';
      hasMore = m.hasMore;
      filtered = m.filtered;
      if (m.append) {
        const start = rows.length;
        rows = rows.concat(m.rows);
        m.rows.forEach((r, k) => indexOf.set(r.hash, start + k));
      } else {
        rows = m.rows;
        indexOf = new Map(rows.map((r, i) => [r.hash, i]));
        revealTries = 0;
        const before = selected.size;
        for (const h of [...selected]) if (!indexOf.has(h)) selected.delete(h);
        cursor = anchor = rows.findIndex((r) => selected.has(r.hash));
        // The filter hid the selected commits: don't keep showing them.
        if (before && selected.size !== before && changes?.hashes.length) {
          changes = null;
          if (selected.size) selectionChanged();
          else renderInspector();
        }
        if (!m.rows.length) list.scrollTop = 0;
      }
      renderRows();
      renderSidebar();
      if (pendingReveal) revealCommit(pendingReveal);
      // Open on HEAD, ready for the keyboard.
      else if (firstLog && !SIDEBAR && !selected.size && state?.head && indexOf.has(state.head)) {
        revealCommit(state.head);
        list.focus();
      }
      return;
    case 'changes':
      if (changes?.hashes.join() !== m.payload.hashes.join() || !m.payload.hashes.length) {
        parentIx = 0;
        folderCollapsed.clear();
      }
      changes = m.payload;
      changesLoading = false;
      fileSel = '';
      renderInspector();
      return;
    case 'containing':
      containing.set(m.hash, m.refs);
      if (changes?.details?.hash === m.hash) renderCard();
      return;
    case 'busy':
      $('progress').classList.toggle('on', m.busy);
      return;
    case 'reveal':
      if (!SIDEBAR) revealCommit(m.hash);
      return;
    case 'setFilter':
      applyFilter({ ...m.filter });
      return;
    case 'filterSync':
      applyFilter({ ...m.filter }, false);
      return;
    case 'empty':
      rows = [];
      emptyMessage = m.message;
      renderRows();
      if (SIDEBAR && !state) $('current').innerHTML = `<div class="hint-empty">${esc(m.message)}</div>`;
      return;
    case 'error':
      toast(m.message);
      return;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopup();
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && document.activeElement !== textFilter) {
    e.preventDefault();
    textFilter.focus();
    textFilter.select();
  }
});

layout();
applyFilter({ ...filter }, false);
renderInspector();
renderRows();
// The sidebar shares the log's filter through the host; it never sets one on its own.
if (!SIDEBAR && Object.keys(filter).length) post({ type: 'setFilter', filter });
post({ type: 'ready' });
