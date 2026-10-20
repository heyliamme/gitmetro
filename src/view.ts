import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { WORKTREE } from './content';
import { assertRev, Git, readableGitError, setGitTrace } from './git';
import type { LogFilter, Palette, RepoSummary, ToHost, ToView } from './protocol';
import { Config, RepoSession, SessionHost } from './session';

const REPO_KEY = 'gitmetro.repo';

/** One spelling per repository: on Windows the git extension says c:\\ where git says C:\\. */
function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' && /^[a-z]:/.test(r) ? r[0].toUpperCase() + r.slice(1) : r;
}

type Mode = 'full' | 'sidebar' | 'log';

/** A GitMetro webview: the activity-bar view, the bottom-panel view, or a log tab. */
interface View {
  webview: vscode.Webview;
  mode: Mode;
  visible: () => boolean;
  session?: RepoSession;
  /** A log tab belongs to one repository for good. */
  fixedRoot?: string;
  pendingFilter?: LogFilter;
  pendingReveal?: string;
  /** Posts to this view only. One function per view: sessions key per-view state on it. */
  reply: (msg: ToView) => void;
  /** Bumped by every bind, so a slow bind can't overwrite a later one. */
  bindGen: number;
  /** Told there is no repository yet: bound as soon as discovery finds one. */
  waiting?: boolean;
}

/**
 * Owns the views and the repositories. Each repository in the workspace gets a RepoSession;
 * each view shows one of them. The side bar and the panel follow the "active" repository,
 * a log tab stays on the repository it was opened for, so several repositories can be open
 * side by side.
 */
/** The part of VS Code's Git extension API GitMetro uses. */
interface BuiltinGit {
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: readonly { readonly rootUri: vscode.Uri }[];
  readonly onDidOpenRepository: vscode.Event<unknown>;
  readonly onDidCloseRepository: vscode.Event<unknown>;
  readonly onDidChangeState: vscode.Event<unknown>;
}

export class LogViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, SessionHost {
  private readonly views = new Map<vscode.Webview, View>();
  private readonly sessions = new Map<string, RepoSession>();
  private readonly editors = new Map<string, vscode.WebviewPanel>();
  private repos: string[] = [];
  private active?: string;
  private discovering?: Promise<void>;
  private discoverAgain = false;
  /** VS Code's Git hasn't finished its first scan: "no repository" isn't known yet. */
  private scanning = false;
  private discoverTimer?: NodeJS.Timeout;
  private gitApi?: BuiltinGit;
  private summaryTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];
  /** Called after each discovery with the number of repositories (the status bar listens). */
  onReposChanged?: (count: number) => void;

  get repoCount(): number {
    return this.repos.length;
  }
  private gitMissingShown = false;
  /** View → Output → GitMetro: what refreshed and why, and every git command that failed. */
  readonly log = vscode.window.createOutputChannel('GitMetro', { log: true });

  constructor(readonly ctx: vscode.ExtensionContext) {
    setGitTrace((line) => this.log.trace(line));
    this.disposables.push(
      this.log,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => this.configChanged(e)),
      // A safety net for file watching (it can fail, e.g. out of inotify instances): coming back
      // to the window checks for changes. Cheap: the log only reloads when refs moved.
      vscode.window.onDidChangeWindowState((w) => w.focused && this.sessions.forEach((s) => this.visible(s) && s.scheduleRefresh(100))),
    );
  }

  repoProblem(session: RepoSession, message: string): void {
    if (/ENOENT/.test(message) && !/no longer exists/.test(message)) {
      this.gitMissing();
      return;
    }
    // .git deleted, folder moved: look again, and tell its views.
    this.log.warn(`${session.root}: ${message}`);
    session.dispose();
    this.sessions.delete(session.root);
    for (const v of this.views.values()) if (v.session === session) v.session = undefined;
    void this.discover().then(() => {
      for (const v of this.views.values()) if (!v.session) void this.bind(v, v.fixedRoot && this.repos.includes(v.fixedRoot) ? v.fixedRoot : this.active);
    });
  }

  /** The configured git can't be started: say so once, with the way to fix it. */
  private gitMissing(): void {
    if (this.gitMissingShown) return;
    this.gitMissingShown = true;
    void vscode.window.showErrorMessage(`GitMetro: git was not found at "${this.gitBin()}". Install git, or set gitmetro.gitPath.`, 'Open Settings').then((b) => {
      if (b) void vscode.commands.executeCommand('workbench.action.openSettings', 'gitmetro.gitPath');
    });
  }

  private configChanged(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('gitmetro.palette')) {
      for (const v of this.views.values()) v.webview.postMessage({ type: 'settings', palette: this.config().palette } satisfies ToView);
    }
    if (e.affectsConfiguration('gitmetro.gitPath')) {
      this.gitMissingShown = false;
      void this.rebuildSessions();
    } else if (e.affectsConfiguration('gitmetro.pageSize') || e.affectsConfiguration('gitmetro.order')) {
      for (const s of this.sessions.values()) if (this.visible(s)) void s.reloadLog();
    }
  }

  dispose(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    this.sessions.forEach((s) => s.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  config(): Config {
    const c = vscode.workspace.getConfiguration('gitmetro');
    return {
      pageSize: Math.max(100, Number.isFinite(+c.get<number>('pageSize', 3000)) ? Math.floor(+c.get<number>('pageSize', 3000)) : 3000),
      order: c.get<'date' | 'topo'>('order', 'date'),
      gitPath: c.get<string>('gitPath', 'git'),
      palette: c.get<Palette>('palette', 'metro'),
    };
  }

  gitBin(): string {
    return this.config().gitPath;
  }

  /** The repository shown by the first view, for tests and simple callers. */
  get git(): Git | undefined {
    return [...this.views.values()][0]?.session?.git;
  }

  // ------------------------------------------------------------ sessions

  post(session: RepoSession, msg: ToView): void {
    for (const v of this.views.values()) if (v.session === session) v.webview.postMessage(msg);
  }

  visible(session: RepoSession): boolean {
    return [...this.views.values()].some((v) => v.session === session && v.visible());
  }

  summaryChanged(): void {
    // Batches the burst from several repositories refreshing at once.
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined;
      for (const v of this.views.values()) this.postRepos(v);
    }, 150);
  }

  private summaries(): RepoSummary[] {
    return this.repos.map(
      (root) => this.sessions.get(root)?.summary ?? { root, name: path.basename(root), branch: '', head: '', ahead: 0, behind: 0, conflicts: 0 },
    );
  }

  private postRepos(v: View): void {
    if (v.session) v.webview.postMessage({ type: 'repos', repos: this.summaries(), current: v.session.root } satisfies ToView);
  }

  private async rebuildSessions(): Promise<void> {
    this.sessions.forEach((s) => s.dispose());
    this.sessions.clear();
    await this.discover();
    for (const v of this.views.values()) if (v.session) await this.bind(v, v.session.root);
  }

  /** Finds the workspace's repositories; keeps one session per repository. */
  discover(): Promise<void> {
    // Asked again while looking (VS Code's Git found another repository meanwhile): look once more
    // after this pass, or the newcomer would be missed.
    if (this.discovering) {
      this.discoverAgain = true;
      return this.discovering;
    }
    this.discovering = (async () => {
      do {
        this.discoverAgain = false;
        await this.doDiscover();
      } while (this.discoverAgain);
    })().finally(() => (this.discovering = undefined));
    return this.discovering;
  }

  /** Batches the bursts VS Code's Git sends while it scans (one event per repository). */
  private scheduleDiscover(): void {
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => void this.discover(), 300);
  }

  /**
   * VS Code's Git extension, started if it hasn't yet; undefined when it is disabled. It finds
   * repositories over time (scanning subfolders, a repository created later), so GitMetro
   * follows its events rather than asking once at startup, when it may not have looked yet.
   */
  private async builtinGit(): Promise<BuiltinGit | undefined> {
    if (this.gitApi) return this.gitApi;
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(version: 1): BuiltinGit }>('vscode.git');
      if (!ext) return undefined;
      const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
      this.gitApi = api;
      const again = () => this.scheduleDiscover();
      this.disposables.push(api.onDidOpenRepository(again), api.onDidCloseRepository(again), api.onDidChangeState(again));
      return api;
    } catch (e) {
      // Disabled (git.enabled: false) or failed to start: the workspace folders are enough.
      this.log.debug(`vscode.git unavailable: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  private async doDiscover(): Promise<void> {
    const found = new Set<string>();
    // VS Code's Git knows about nested repositories (a folder holding several projects).
    const builtin = await this.builtinGit();
    for (const r of builtin?.repositories ?? []) found.add(norm(r.rootUri.fsPath));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const top = await Git.toplevel(f.uri.fsPath, this.gitBin());
      if (top) found.add(norm(top));
    }
    const dropped: string[] = [];
    for (const root of this.repos) if (this.sessions.has(root) && !found.has(root) && ![...this.views.values()].some((v) => v.fixedRoot === root)) {
      this.sessions.get(root)!.dispose();
      this.sessions.delete(root);
      dropped.push(root);
    }
    this.repos = [...new Set([...found, ...this.sessions.keys()])].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    // Views and menus only show where there is a repository to show.
    void vscode.commands.executeCommand('setContext', 'gitmetro.hasRepo', this.repos.length > 0);
    // The views use the inverse: before activation they must count as shown, or VS Code
    // won't restore the side bar on reload. And only "no repository" once VS Code's Git has
    // finished scanning, or the icon would vanish for a moment and close the side bar.
    const settled = !builtin || builtin.state === 'initialized';
    this.scanning = !settled;
    this.log.debug(`repositories: ${this.repos.length}${settled ? '' : ' (VS Code Git still scanning)'}`);
    if (this.repos.length || settled) void vscode.commands.executeCommand('setContext', 'gitmetro.noRepo', this.repos.length === 0);
    this.onReposChanged?.(this.repos.length);
    // Sessions (a watcher and a few git commands each) only once GitMetro is on screen: at
    // startup the status bar just needs to know there is a repository.
    if (this.views.size) await Promise.all(this.repos.map((root) => this.session(root)));
    const saved = this.ctx.workspaceState.get<string>(REPO_KEY);
    if (!this.active || !this.repos.includes(this.active)) this.active = (saved && this.repos.includes(saved) ? saved : undefined) ?? this.repoOfActiveEditor() ?? this.repos[0];
    // Views that showed a repository no longer in the workspace move to the active one.
    for (const v of this.views.values()) if (v.session && dropped.includes(v.session.root)) void this.bind(v, this.active);
    // Views opened before any repository was found (VS Code's Git still scanning) take one now;
    // views still empty once the scan is over say so.
    if (this.repos.length || settled) for (const v of this.views.values()) if (v.waiting) void this.bind(v, v.fixedRoot ?? this.active);
    this.summaryChanged();
  }

  private async session(root: string): Promise<RepoSession> {
    let s = this.sessions.get(root);
    if (!s) {
      s = new RepoSession(root, this);
      this.sessions.set(root, s);
      await s.start().catch((e) => this.log.warn(`${root}: ${e instanceof Error ? e.message : e}`));
    }
    return s;
  }

  private repoOfActiveEditor(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== 'file') return undefined;
    const file = norm(uri.fsPath);
    return this.repos.filter((r) => file === r || file.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  }

  /** Shows `root` in a view. */
  private async bind(v: View, root: string | undefined): Promise<void> {
    const gen = ++v.bindGen;
    if (root && !this.repos.includes(root)) {
      // A restored tab or a stale root: only bind to a repository that is still in the workspace.
      if (await this.allowed(root)) {
        this.repos.push(root);
        this.summaryChanged();
      } else root = undefined;
    }
    if (gen !== v.bindGen) return;
    if (!root) {
      v.session = undefined;
      v.waiting = true;
      v.webview.postMessage({ type: 'empty', message: this.scanning ? 'Looking for Git repositories…' : 'No Git repository in this workspace.' } satisfies ToView);
      return;
    }
    const session = await this.session(root);
    if (gen !== v.bindGen) return; // a later bind (setRepo) won
    v.session = session;
    v.waiting = false;
    if (v.pendingFilter) {
      v.session.filter = v.pendingFilter;
      v.pendingFilter = undefined;
    }
    this.postRepos(v);
    if (Object.keys(v.session.filter).length) v.webview.postMessage({ type: 'setFilter', filter: v.session.filter } satisfies ToView);
    await v.session.reload();
    if (v.pendingReveal) {
      v.webview.postMessage({ type: 'reveal', hash: v.pendingReveal } satisfies ToView);
      v.pendingReveal = undefined;
    }
  }

  // --------------------------------------------------------------- views

  resolveWebviewView(view: vscode.WebviewView): void {
    const sidebar = view.viewType === 'gitmetro.branches';
    this.attach(view.webview, () => view.visible, view.onDidChangeVisibility, view.onDidDispose, sidebar ? 'sidebar' : 'full');
    if (sidebar) {
      // The activity bar is too narrow for the log: showing the side bar brings up the log tab.
      const openLog = () => {
        if (view.visible && !this.editors.size && vscode.workspace.getConfiguration('gitmetro').get('openLogFromSidebar', true)) void this.openInEditor(undefined, true, true);
      };
      openLog();
      const sub = view.onDidChangeVisibility(openLog);
      view.onDidDispose(() => sub.dispose());
    }
  }

  /**
   * Opens (or brings forward) the log tab for a repository: the given one, the one holding
   * the active editor's file, or the active one. `besideSidebar`: the branches are already
   * in the activity bar, so the tab starts without its own.
   */
  async openInEditor(root?: string, preserveFocus = false, besideSidebar = false): Promise<View | undefined> {
    if (!this.repos.length) await this.discover();
    let target: string | undefined = (root && norm(root)) || this.repoOfActiveEditor() || this.active || this.repos[0];
    if (target && !this.repos.includes(target) && !(await this.allowed(target))) target = undefined;
    if (!target) {
      vscode.window.showInformationMessage('GitMetro: no Git repository in this workspace.');
      return undefined;
    }
    const open = this.editors.get(target);
    if (open) {
      open.reveal(undefined, preserveFocus);
      return this.views.get(open.webview);
    }
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    const title = this.repos.length > 1 ? `GitMetro: ${path.basename(target)}` : 'GitMetro';
    const panel = vscode.window.createWebviewPanel('gitmetro.editor', title, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.png');
    this.editors.set(target, panel);
    panel.onDidDispose(() => this.forgetEditor(panel));
    this.followWhenActive(panel);
    return this.attach(panel.webview, () => panel.visible, panel.onDidChangeViewState, panel.onDidDispose, besideSidebar ? 'log' : 'full', target);
  }

  /** A repository root GitMetro may run git in: the top of a repository inside a workspace folder. */
  private async allowed(root: string): Promise<boolean> {
    const inside = (vscode.workspace.workspaceFolders ?? []).some((f) => {
      const w = norm(f.uri.fsPath);
      return root === w || root.startsWith(w + path.sep) || w.startsWith(root + path.sep);
    });
    if (!inside) return false;
    const top = await Git.toplevel(root, this.gitBin());
    return !!top && norm(top) === root;
  }

  /** The side bar and panel show the repository of the log tab in front, like VS Code's views follow the editor. */
  private async follow(root: string): Promise<void> {
    if (!this.repos.includes(root)) return;
    if (this.active !== root) {
      this.active = root;
      await this.ctx.workspaceState.update(REPO_KEY, root);
    }
    for (const v of this.views.values()) if (!v.fixedRoot && v.session?.root !== root) await this.bind(v, root);
  }

  private followWhenActive(panel: vscode.WebviewPanel): void {
    panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.active) return;
      // Look the root up by identity: the tab may have switched repository since it opened.
      const root = [...this.editors].find(([, p]) => p === panel)?.[0];
      if (root) void this.follow(root);
    });
  }

  /** A tab can change repository, so find it by identity rather than by the root it opened on. */
  private forgetEditor(panel: vscode.WebviewPanel): void {
    for (const [root, p] of this.editors) if (p === panel) this.editors.delete(root);
  }

  private attach(webview: vscode.Webview, visible: () => boolean, onVisibility: vscode.Event<unknown>, onDispose: vscode.Event<void>, mode: Mode, fixedRoot?: string): View {
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = this.html(webview, dist, mode);
    const v: View = { webview, mode, visible, fixedRoot, reply: (msg) => void webview.postMessage(msg), bindGen: 0 };
    this.views.set(webview, v);
    const subs = [
      webview.onDidReceiveMessage((m: ToHost) => this.onMessage(m, webview).catch((e) => this.fail(e))),
      onVisibility(() => {
        if (visible()) v.session?.scheduleRefresh(0);
      }),
    ];
    onDispose(() => {
      this.views.delete(webview);
      subs.forEach((d) => d.dispose());
    });
    return v;
  }

  private html(webview: vscode.Webview, dist: vscode.Uri, mode: Mode): string {
    const nonce = randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}">
</head><body data-mode="${mode}"><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log.error(message);
    if (/spawn .*ENOENT/.test(message)) return this.gitMissing();
    vscode.window.showErrorMessage(`GitMetro: ${readableGitError(message)}`);
  }

  /** Where a diff should open: beside the log when the log is itself an editor tab, so it stays in view. */
  private diffColumn(v: View | undefined): vscode.ViewColumn {
    return v?.fixedRoot ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  }

  // ------------------------------------------------------------- messages

  private async onMessage(m: ToHost, from?: vscode.Webview): Promise<void> {
    // The webview renders repository content; treat what it sends back as untrusted.
    const revs: string[] = [];
    if (m.type === 'select' || m.type === 'commitAction') revs.push(...m.hashes);
    if (m.type === 'containing') revs.push(m.hash);
    if (m.type === 'openDiff') revs.push(m.base, m.target);
    if (m.type === 'fileAction') revs.push(m.target, ...(m.base ? [m.base] : []));
    if (m.type === 'refAction' || m.type === 'toggleFavorite') revs.push(m.ref);
    if (m.type === 'setFilter') revs.push(...(m.filter.branches ?? []));
    if (m.type === 'openLog') revs.push(...(m.reveal ? [m.reveal] : []), ...(m.filter?.branches ?? []));
    for (const r of revs) if (r && r !== WORKTREE) assertRev(r);
    const ps = m.type === 'openDiff' || m.type === 'fileAction' ? [m.file.path, m.file.oldPath] : m.type === 'conflict' ? [m.path] : m.type === 'setFilter' ? [m.filter.lines?.path] : [];
    // Paths only ever reach git after `--` or inside rev:path, so a leading '-' is harmless.
    for (const p of ps) if (p !== undefined && (typeof p !== 'string' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..') || p.includes('\0'))) return;
    const lines = m.type === 'setFilter' ? m.filter.lines : undefined;
    if (lines && !(Number.isInteger(lines.start) && Number.isInteger(lines.end) && lines.start > 0)) return;
    if (m.type === 'setRepo' && !this.repos.includes(norm(m.root))) return;

    const v = (from && this.views.get(from)) ?? [...this.views.values()][0];
    if (!v) return;
    // No repository yet (none found, or git init since): Refresh looks again.
    if (m.type === 'refresh' && !v.session) {
      await this.discover();
      await this.bind(v, v.fixedRoot ?? this.active);
      return;
    }
    switch (m.type) {
      case 'ready':
        v.webview.postMessage({ type: 'settings', palette: this.config().palette } satisfies ToView);
        await this.discover();
        await this.bind(v, v.fixedRoot ?? v.session?.root ?? this.active);
        return;
      case 'setRepo': {
        const root = norm(m.root);
        if (v.fixedRoot) {
          // A log tab switching repository becomes that repository's tab.
          const panel = this.editors.get(v.fixedRoot);
          if (panel && !this.editors.has(root)) {
            this.editors.delete(v.fixedRoot);
            this.editors.set(root, panel);
            v.fixedRoot = root;
            panel.title = this.repos.length > 1 ? `GitMetro: ${path.basename(root)}` : 'GitMetro';
          } else if (panel) {
            this.editors.get(root)!.reveal();
            await this.follow(root);
            return;
          }
        } else {
          this.active = root;
          await this.ctx.workspaceState.update(REPO_KEY, root);
        }
        await this.bind(v, root);
        if (v.fixedRoot) await this.follow(root);
        if (m.openLog) await this.openLogFor(root);
        return;
      }
      case 'openLog': {
        const root = v.session?.root ?? this.active;
        // Revealing a branch's tip from the side bar keeps the keyboard there, so arrow keys go on
        // walking the branch list.
        if (root) await this.openLogFor(root, m.filter, m.reveal, !!m.reveal && !m.filter);
        return;
      }
    }
    if (v.session) {
      const session = v.session;
      const reply = v.reply;
      const others = (msg: ToView) => {
        for (const o of this.views.values()) if (o !== v && o.session === session) o.webview.postMessage(msg);
      };
      await session.handle(m, this.diffColumn(v), reply, others);
    }
  }

  /** Opens a repository's log tab and hands it a filter or a commit to show. */
  private async openLogFor(root: string, filter?: LogFilter, reveal?: string, preserveFocus = false): Promise<void> {
    const existed = this.editors.has(root);
    const tab = await this.openInEditor(root, preserveFocus, true);
    if (!tab) return;
    if (existed && tab.session) {
      // In order: the filter first (the webview reloads and keeps a pending reveal across it).
      if (filter) tab.webview.postMessage({ type: 'setFilter', filter } satisfies ToView);
      if (reveal) tab.webview.postMessage({ type: 'reveal', hash: reveal } satisfies ToView);
    } else {
      tab.pendingFilter = filter;
      tab.pendingReveal = reveal;
    }
  }

  // ------------------------------------------------------------- commands

  /** The repository holding a file, added to the list if it wasn't there yet. */
  private async repoOf(target: vscode.Uri): Promise<string | undefined> {
    if (target.scheme !== 'file') return undefined;
    const top = await Git.toplevel(path.dirname(target.fsPath), this.gitBin());
    if (!top) {
      vscode.window.showInformationMessage('Not inside a Git repository.');
      return undefined;
    }
    const root = norm(top);
    if (!this.repos.includes(root)) {
      if (!(await this.allowed(root))) {
        vscode.window.showInformationMessage('GitMetro only opens repositories inside the workspace.');
        return undefined;
      }
      this.repos.push(root);
      await this.session(root);
    }
    return root;
  }

  /** History of a file (following renames) or a folder. */
  async showFileHistory(uri: vscode.Uri | undefined): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) return;
    const root = await this.repoOf(target);
    if (!root) return;
    const rel = path.relative(root, target.fsPath) || '.';
    let isFile = false;
    try {
      isFile = (await vscode.workspace.fs.stat(target)).type === vscode.FileType.File;
    } catch {
      /* deleted: plain path history */
    }
    await this.openLogFor(root, isFile ? { paths: [rel], follow: true } : { paths: [rel] });
  }

  /** History of the selected lines (or the line under the cursor) of the active editor. */
  async showLineHistory(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const root = await this.repoOf(editor.document.uri);
    if (!root) return;
    const sel = editor.selection;
    const start = Math.min(sel.start.line, sel.end.line) + 1;
    // A selection ending at column 0 of the next line doesn't include that line.
    const endLine = Math.max(sel.start.line, sel.end.line) + 1 - (sel.end.character === 0 && sel.end.line > sel.start.line ? 1 : 0);
    const file = path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/');
    // git log -L numbers lines as HEAD has them: map the editor's lines over any edits since.
    const lines = await new Git(root, this.gitBin()).linesInHead(file, editor.document.getText(), start, Math.max(start, endLine));
    if (lines === 'untracked' || lines === 'uncommitted') {
      vscode.window.showInformationMessage(lines === 'untracked' ? `${path.basename(file)} isn't committed yet: it has no history.` : 'These lines are not committed yet: they have no history.');
      return;
    }
    await this.openLogFor(root, { lines: { path: file, ...lines } });
  }

  /** Brings up a repository's log at a commit (from blame annotations). */
  async revealCommit(root: string, hash: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(hash)) return;
    let r = norm(root);
    if (!this.repos.includes(r)) {
      // Blame works on any workspace file; its repository may not be listed yet.
      if (!(await this.allowed(r))) return;
      this.repos.push(r);
      this.summaryChanged();
    }
    // The commit may be hidden by whatever filter the log has: clear it.
    await this.openLogFor(r, {}, hash);
  }

  async reload(): Promise<void> {
    await this.discover();
    if (!this.repos.length) {
      vscode.window.showInformationMessage('GitMetro: no Git repository in this workspace.');
      return;
    }
    for (const v of this.views.values()) if (!v.session) await this.bind(v, v.fixedRoot ?? this.active);
    await Promise.all([...this.sessions.values()].filter((s) => this.visible(s)).map((s) => s.reload()));
  }

  /** A log tab VS Code restored after a reload. */
  restoreEditor(panel: vscode.WebviewPanel, state: unknown): void {
    const root = typeof (state as { root?: unknown })?.root === 'string' ? norm((state as { root: string }).root) : undefined;
    const target = root ?? this.active ?? this.repos[0];
    if (!target || this.editors.has(target)) {
      panel.dispose();
      return;
    }
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.png');
    this.editors.set(target, panel);
    panel.onDidDispose(() => this.forgetEditor(panel));
    this.followWhenActive(panel);
    this.attach(panel.webview, () => panel.visible, panel.onDidChangeViewState, panel.onDidDispose, 'log', target);
  }
}
