import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
import { revUri, shortRef, WORKTREE } from './content';
import { Git, GitError, readableGitError } from './git';
import { GraphLayout } from './graph';
import type { ChangesPayload, Commit, FileChange, LogFilter, Palette, Ref, RepoState, RepoSummary, ToHost, ToView, Worktree } from './protocol';

export const FAVORITES_KEY = 'gitmetro.favorites';


export interface Config {
  pageSize: number;
  order: 'date' | 'topo';
  gitPath: string;
  palette: Palette;
}

/** What a session needs from the provider: shared services and the views showing it. */
export interface SessionHost {
  readonly ctx: vscode.ExtensionContext;
  readonly log: vscode.LogOutputChannel;
  config(): Config;
  /** Posts to every view currently showing this session's repository. */
  post(session: RepoSession, msg: ToView): void;
  visible(session: RepoSession): boolean;
  /** A repository's branch, ahead/behind or conflict state changed. */
  summaryChanged(): void;
  /** git can't be run for this repository any more (or at all). */
  repoProblem(session: RepoSession, message: string): void;
}

/**
 * Everything about one repository: its git, the log's filter and graph, file watching, and
 * every action. One per repository in the workspace; any number of views can show it.
 */
export class RepoSession implements vscode.Disposable {
  readonly git: Git;
  filter: LogFilter = {};
  summary?: RepoSummary;
  private layout = new GraphLayout();
  private loaded = 0;
  private hasMore = false;
  private generation = 0;
  private subjects = new Map<string, string>();
  private refs: Ref[] = [];
  private watchers: vscode.Disposable[] = [];
  private refreshTimer?: NodeJS.Timeout;
  /** The latest selection request of each view (keyed by its reply function), so views don't cancel each other. */
  private selection = new WeakMap<(msg: ToView) => void, string[]>();
  /** Fresh loads (not "load more") in flight: more pages would be based on the old one. */
  private resetting = 0;
  /** Title of the git command running for this repository, if any. */
  private busy?: string;
  private worktreeList: Worktree[] = [];
  private headHash = '';

  constructor(readonly root: string, private readonly host: SessionHost) {
    this.git = new Git(root, host.config().gitPath);
  }

  get name(): string {
    return path.basename(this.root);
  }

  private get ctx() {
    return this.host.ctx;
  }

  private get log() {
    return this.host.log;
  }

  private config(): Config {
    return this.host.config();
  }

  private post(msg: ToView): void {
    this.host.post(this, msg);
  }

  private anyVisible(): boolean {
    return this.host.visible(this);
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log.error(`${this.name}: ${message}`);
    this.post({ type: 'busy', busy: false });
    // The repository went away (.git deleted, folder moved): let the provider re-check.
    if (/not a git repository|no longer exists|ENOENT/.test(message)) this.host.repoProblem(this, message);
    else vscode.window.showErrorMessage(`GitMetro (${this.name}): ${readableGitError(message)}`);
  }

  /** Starts watching and loads the summary. */
  async start(): Promise<void> {
    await this.watch(this.root);
    await this.loadState();
  }

  dispose(): void {
    this.watchers.forEach((d) => d.dispose());
    void this.snapshots?.then((dir) => fs.rm(dir, { recursive: true, force: true })).catch(() => {});
    this.watchers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private async watch(root: string): Promise<void> {
    const git = this.git;
    const common = path.resolve(root, (await git.run(['rev-parse', '--git-common-dir'])).trim());
    const gitDir = path.resolve(root, (await git.run(['rev-parse', '--git-dir'])).trim());
    const patterns = [
      new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,index,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}'),
      new vscode.RelativePattern(vscode.Uri.file(common), '{packed-refs,FETCH_HEAD,refs/**,worktrees/*}'),
    ];
    for (const p of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(p);
      const go = (uri: vscode.Uri) => {
        this.log.trace(`changed: ${path.relative(root, uri.fsPath)}`);
        this.scheduleRefresh(400);
      };
      w.onDidChange(go);
      w.onDidCreate(go);
      w.onDidDelete(go);
      this.watchers.push(w);
    }
  }

  /** Refs and HEAD as of the last loadState, and as of the last time the log was loaded. */
  private lastHeadKey = '';
  private logKey = '';

  scheduleRefresh(delay: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      // Nobody is looking at this repo's log: keep its summary (branch, ahead/behind) current only.
      if (!this.anyVisible()) {
        this.loadState().catch((e) => this.log.warn(`${this.name}: ${e instanceof Error ? e.message : e}`));
        return;
      }
      this.refreshIfChanged().catch((e) => this.fail(e));
    }, delay);
  }

  /** Reloads the log only when refs moved since it was loaded, so index churn does not reset it. */
  private async refreshIfChanged(): Promise<void> {
    await this.loadState();
    const moved = this.lastHeadKey !== this.logKey;
    this.log.debug(`${this.name}: refresh: refs ${moved ? 'moved, reloading the log' : 'unchanged'}`);
    if (moved) await this.reloadLog();
  }

  async reload(): Promise<void> {
    await this.loadState();
    await this.reloadLog();
  }

  async loadState(): Promise<void> {
    const git = this.git;
    const [head, refs, me, worktrees] = await Promise.all([git.head(), git.refs(), git.me(), git.worktrees()]);
    const operation = await git.operation(head.branch);
    // Conflicts from our own per-file cherry-pick: name the commit, not a stash.
    if (operation?.kind === 'conflicts' && this.applying) operation.theirs = `the change from ${this.applying}`;
    if (!operation?.conflicts.length) this.applying = undefined;
    this.refs = refs;
    const favorites = this.favorites();
    if (!this.ctx.workspaceState.get(FAVORITES_KEY + ':' + git.root + ':init')) {
      for (const r of refs) {
        if ((r.kind === 'local' || r.kind === 'remote') && /(^|\/)(main|master)$/.test(r.name) && !favorites.includes(r.full)) favorites.push(r.full);
      }
      await this.ctx.workspaceState.update(FAVORITES_KEY + ':' + git.root, favorites);
      await this.ctx.workspaceState.update(FAVORITES_KEY + ':' + git.root + ':init', true);
    }
    this.lastHeadKey = head.hash + head.branch + refs.map((r) => r.full + r.hash).join() + worktrees.map((w) => w.path + w.branch + w.head).join();
    this.worktreeList = worktrees;
    this.headHash = head.hash;
    const state: RepoState = { root: git.root, head: head.hash, branch: head.branch, refs, favorites: this.favorites(), me, operation, worktrees };
    this.post({ type: 'state', state });
    const cur = refs.find((r) => r.current);
    const summary: RepoSummary = {
      root: git.root,
      name: this.name,
      branch: head.branch,
      head: head.hash,
      ahead: cur?.ahead ?? 0,
      behind: cur?.behind ?? 0,
      operation: operation?.kind,
      conflicts: operation?.conflicts.length ?? 0,
    };
    if (JSON.stringify(summary) !== JSON.stringify(this.summary)) {
      this.summary = summary;
      this.host.summaryChanged();
    }
  }

  private favorites(): string[] {
    return [...(this.ctx.workspaceState.get<string[]>(FAVORITES_KEY + ':' + this.git.root) ?? [])];
  }

  // ------------------------------------------------------------------ log

  /** Filters whose results aren't a closed graph: only parents within the results are drawn. */
  private isGraphFilter(f: LogFilter): boolean {
    return !!(f.text || f.authors?.length || f.since || f.until || f.lines || f.follow);
  }

  async reloadLog(): Promise<void> {
    this.logKey = this.lastHeadKey;
    this.loaded = 0;
    this.subjects.clear();
    this.layout = new GraphLayout();
    this.resetting++;
    try {
      await this.loadPage(false);
    } finally {
      this.resetting--;
    }
  }

  async loadPage(append: boolean): Promise<void> {
    const git = this.git;
    if (!append && !this.headHash && !this.refs.some((r) => r.kind !== 'tag') && !this.filter.branches?.length) {
      // A fresh `git init`: nothing to log, and git would only say "bad revision HEAD".
      this.post({ type: 'log', rows: [], append: false, hasMore: false, filtered: false });
      this.post({ type: 'empty', message: 'No commits yet. Make the first commit and it shows up here.' });
      this.post({ type: 'busy', busy: false });
      return;
    }
    const gen = ++this.generation;
    const { pageSize, order } = this.config();
    const filter = this.filter;
    this.post({ type: 'busy', busy: true });
    let commits: Commit[];
    try {
      commits = await git.log(filter, order, this.loaded, pageSize, !!this.headHash);
    } catch (e) {
      this.log.warn(`git log failed: ${e instanceof Error ? e.message : e}`);
      if (gen !== this.generation) return;
      // Bad revision in the branch filter or a bad regex: show nothing rather than break the view.
      this.post({ type: 'log', rows: [], append: false, hasMore: false, filtered: true });
      this.post({ type: 'busy', busy: false });
      if (e instanceof GitError) vscode.window.showWarningMessage(`Git log: ${e.message.split('\n')[0]}`);
      return;
    }
    if (gen !== this.generation) {
      this.log.debug(`log page ${gen} superseded`);
      return;
    }
    this.log.debug(`log page ${gen}: ${commits.length} commits${append ? ' (more)' : ''}`);
    this.hasMore = commits.length === pageSize;
    this.loaded += commits.length;

    if (!append && filter.text && /^[0-9a-f]{4,40}$/i.test(filter.text.trim())) {
      const hash = await git.resolve(filter.text.trim());
      if (hash && !commits.some((c) => c.hash === hash)) {
        const c = await git.commit(hash);
        if (c) commits.unshift(c);
      }
    }

    if (this.isGraphFilter(filter)) {
      if (!append) this.layout = new GraphLayout(new Set());
      for (const c of commits) this.layout.known!.add(c.hash);
    }
    for (const c of commits) this.subjects.set(c.hash, c.subject);
    const rows = this.layout.add(commits);
    if (gen !== this.generation) return;
    this.post({
      type: 'log',
      rows,
      append,
      hasMore: this.hasMore,
      filtered: !!(this.isGraphFilter(filter) || filter.paths?.length || filter.branches?.length || filter.lines),
    });
    this.post({ type: 'busy', busy: false });
  }

  // -------------------------------------------------------------- changes

  private readonly broadcast = (msg: ToView) => this.post(msg);

  async showChanges(hashes: string[], reply: (msg: ToView) => void = this.broadcast): Promise<void> {
    const git = this.git;
    this.selection.set(reply, hashes);
    if (hashes.length === 0) return;
    let payload: ChangesPayload;
    if (hashes.length === 1) {
      const details = await git.details(hashes[0]);
      const { groups, resolved } = await git.commitChanges(details.hash, details.parents, this.subjectsWithRefs());
      payload = { hashes, target: details.hash, groups, resolved, details };
    } else {
      // hashes arrive in log order: newest first.
      const newest = hashes[0];
      const oldest = await git.details(hashes[hashes.length - 1]);
      const base = oldest.parents[0] ?? '';
      payload = {
        hashes,
        target: newest,
        groups: [{ base, label: `${hashes.length} selected commits: everything from ${base ? shortRef(base) : 'the start'} to ${shortRef(newest)}, including commits between them`, files: await git.diffFiles(base, newest) }],
        resolved: [],
      };
    }
    if (this.selection.get(reply) !== hashes) return;
    reply({ type: 'changes', payload });
  }

  private subjectsWithRefs(): Map<string, string> {
    const m = new Map(this.subjects);
    for (const r of this.refs) {
      if (r.kind === 'tag') continue;
      const s = m.get(r.hash);
      if (s !== undefined && !s.startsWith('[')) m.set(r.hash, `[${r.name}] ${s}`);
    }
    return m;
  }

  private async openDiff(base: string, target: string, file: FileChange, focus = true, viewColumn = vscode.ViewColumn.Active): Promise<void> {
    const root = this.git.root;
    if (IMAGE.test(file.path) && target !== WORKTREE) {
      // Images: write both versions out so VS Code's image viewer can show them side by side.
      const left = file.status === 'A' ? undefined : await this.snapshot(base, file.oldPath ?? file.path);
      const right = file.status === 'D' ? undefined : await this.snapshot(target, file.path);
      if (left && right) {
        await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file.path)} (${shortRef(base)} ↔ ${shortRef(target)})`, { preview: true, preserveFocus: !focus, viewColumn });
        return;
      }
      const one = left ?? right;
      if (one) await vscode.commands.executeCommand('vscode.open', one, { preview: true, preserveFocus: !focus, viewColumn });
      return;
    }
    const left = file.status === 'A' ? revUri(root, '', file.path) : revUri(root, base, file.oldPath ?? file.path);
    const right = file.status === 'D' ? revUri(root, '', file.path) : revUri(root, target, file.path);
    const title = `${path.basename(file.path)} (${shortRef(base)} ↔ ${shortRef(target)})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: !focus, viewColumn });
  }

  /** A file at a revision, written to a temporary file (for viewers that need a real file). */
  private async snapshot(rev: string, file: string): Promise<vscode.Uri | undefined> {
    if (!rev) return undefined;
    const bytes = await this.git.showRaw(rev, file);
    if (!bytes.length) return undefined;
    const hash = await this.git.run(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).then((s) => s.trim(), () => '');
    if (!/^[0-9a-f]{40,64}$/.test(hash)) return undefined;
    // A private folder (mode 0700) per session: the shared temp dir is writable by other users.
    this.snapshots ??= fs.mkdtemp(path.join(os.tmpdir(), 'gitmetro-'));
    const out = path.join(await this.snapshots, hash.slice(0, 12), file.split('/').filter((p) => p && p !== '..' && p !== '.').join(path.sep));
    if (!out.startsWith(await this.snapshots)) return undefined;
    await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
    await fs.rm(out, { force: true });
    await fs.writeFile(out, bytes, { flag: 'wx', mode: 0o600 });
    return vscode.Uri.file(out);
  }
  private snapshots?: Promise<string>;
  /** The commit a per-file cherry-pick came from, while its conflicts are open. */
  private applying?: string;

  // -------------------------------------------------------------- actions

  private async exec(title: string, args: string[], opts: { refreshLog?: boolean; env?: Record<string, string>; input?: string } = {}): Promise<boolean> {
    const git = this.git;
    // One command at a time per repository: a double-click on Push must not push twice.
    if (this.busy) {
      vscode.window.setStatusBarMessage(`GitMetro: ${this.busy} is still running`, 3000);
      return false;
    }
    this.busy = title;
    this.log.debug(`${title}: started`);
    // Network commands can hang on a remote that never answers: let the user cancel, and make
    // git and ssh give up on a dead connection rather than wait forever.
    const network = ['fetch', 'pull', 'push'].includes(args[0]);
    const env = network ? { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=20', GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '60', ...opts.env } : opts.env;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: network }, (_p, token) => {
        const abort = new AbortController();
        token?.onCancellationRequested(() => abort.abort());
        return git.run(args, { env, input: opts.input, signal: abort.signal });
      });
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        vscode.window.setStatusBarMessage(`GitMetro: ${title} cancelled`, 3000);
        return false;
      }
      const msg = readableGitError(e instanceof Error ? e.message : String(e));
      this.log.error(`${title}: ${e instanceof Error ? e.message : e}`);
      const { branch } = await git.head();
      const op = await git.operation(branch);
      if (op?.conflicts.length) {
        vscode.window.showWarningMessage(`${title} stopped: ${op.conflicts.length} conflict${op.conflicts.length === 1 ? '' : 's'} to resolve. They are listed at the top of the Git log.`);
        vscode.commands.executeCommand('gitmetro.openEditor', this.root);
      } else if (/is now empty|nothing to commit/.test(msg) && op && op.kind !== 'conflicts') {
        // The change is already there: the only way on is to skip it.
        const skip = await vscode.window.showWarningMessage(`${title}: this commit changes nothing here, it is already applied.`, 'Skip It', 'Abort');
        if (skip) {
          this.busy = undefined;
          await this.exec(`${skip === 'Skip It' ? 'Skip' : 'Abort'} ${op.kind}`, [op.kind as string, skip === 'Skip It' ? '--skip' : '--abort'], { env: { GIT_EDITOR: 'true' } });
        }
      } else {
        void vscode.window.showErrorMessage(`${title} failed: ${msg}`, 'Show Log').then((b) => b && this.log.show());
      }
      return false;
    } finally {
      this.busy = undefined;
      if (opts.refreshLog !== false) await this.reload().catch((e) => this.fail(e));
    }
  }

  private async checkout(target: string, extra: string[] = []): Promise<void> {
    const git = this.git;
    if (this.busy) {
      vscode.window.setStatusBarMessage(`GitMetro: ${this.busy} is still running`, 3000);
      return;
    }
    try {
      this.busy = `Checkout ${target}`;
      try {
        await git.run(['checkout', ...extra, target]);
      } finally {
        this.busy = undefined;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/would be overwritten|commit your changes or stash/i.test(msg)) {
        const pick = await vscode.window.showWarningMessage(
          'Your local changes would be overwritten by checkout.',
          { modal: true, detail: msg },
          'Smart Checkout',
          'Force Checkout',
        );
        if (pick === 'Smart Checkout') {
          if (!(await this.exec('Smart checkout', ['stash', 'push', '--include-untracked', '-m', `gitmetro smart checkout to ${target}`], { refreshLog: false }))) return this.reload();
          const ok = await this.exec(`Checkout ${target}`, ['checkout', ...extra, target], { refreshLog: false });
          if (!ok) {
            // Don't leave the user's work in the stash because the switch failed.
            await git.run(['stash', 'pop'], { allowFail: true });
            return this.reload();
          }
          try {
            await git.run(['stash', 'pop']);
          } catch {
            vscode.window.showWarningMessage(
              `Switched to ${target}, but your changes clash with it. The clashing files are listed at the top of the Git log; your changes also stay in the stash until you drop it.`,
            );
          }
          return;
        }
        if (pick === 'Force Checkout') {
          await this.exec(`Checkout ${target}`, ['checkout', '-f', ...extra, target]);
          return;
        }
        return;
      }
      vscode.window.showErrorMessage(`Checkout failed: ${msg}`);
    } finally {
      await this.reload();
    }
  }

  private async askName(prompt: string, value = ''): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      prompt,
      value,
      validateInput: async (v) => (!v.trim() ? 'Required' : (await this.git.isValidBranchName(v.trim())) ? undefined : 'Not a valid branch or tag name'),
    });
    return name?.trim();
  }

  private async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  private terminal(cmd: string): void {
    const t = vscode.window.createTerminal({ name: 'Git', cwd: this.git.root });
    t.show();
    t.sendText(cmd);
  }

  private async commitAction(action: string, hashes: string[], viewColumn: vscode.ViewColumn, reply: (msg: ToView) => void): Promise<void> {
    const git = this.git;
    const h = hashes[0];
    const short = h.slice(0, 8);
    switch (action) {
      case 'copyHash':
        await vscode.env.clipboard.writeText(hashes.join(' '));
        vscode.window.setStatusBarMessage(`Copied ${hashes.length > 1 ? hashes.length + ' hashes' : short}`, 2000);
        return;
      case 'copySubject': {
        const out = await git.run(['show', '-s', '--format=%B', ...hashes]);
        await vscode.env.clipboard.writeText(out.trim());
        return;
      }
      case 'checkout':
        return this.checkout(h, ['--detach']);
      case 'newBranch': {
        const name = await this.askName(`New branch from ${short}`);
        if (name) await this.checkout(h, ['-b', name]);
        return;
      }
      case 'newTag': {
        const name = await this.askName(`New tag on ${short}`);
        if (name) await this.exec(`Tag ${name}`, ['tag', name, h]);
        return;
      }
      case 'cherryPick':
      case 'cherryPickX':
        // log order is newest first; apply oldest first. -x records where each came from.
        await this.exec(`Cherry-pick ${hashes.length === 1 ? short : hashes.length + ' commits'}`, ['cherry-pick', ...(action === 'cherryPickX' ? ['-x'] : []), ...(await this.mainline(hashes)), ...[...hashes].reverse()]);
        return;
      case 'revert':
        await this.exec(`Revert ${hashes.length === 1 ? short : hashes.length + ' commits'}`, ['revert', '--no-edit', ...(await this.mainline(hashes)), ...hashes]);
        return;
      case 'reset': {
        const mode = await vscode.window.showQuickPick(
          [
            { label: 'Soft', mode: '--soft', detail: 'Files and index stay as they are; the reset commits become staged changes.' },
            { label: 'Mixed', mode: '--mixed', detail: 'Files stay as they are; the index is reset.' },
            { label: 'Hard', mode: '--hard', detail: 'Files and index are reset. Uncommitted changes are lost.' },
            { label: 'Keep', mode: '--keep', detail: 'Like hard, but aborts if local changes would be lost.' },
          ],
          { title: `Reset current branch to ${short}` },
        );
        if (!mode) return;
        if (mode.mode === '--hard' && !(await this.confirm(`Hard reset to ${short}?`, 'Reset', 'Uncommitted changes will be lost.'))) return;
        await this.exec(`Reset ${mode.label.toLowerCase()} to ${short}`, ['reset', mode.mode, h]);
        return;
      }
      case 'undoCommit':
        await this.exec('Undo commit', ['reset', '--soft', 'HEAD~1']);
        return;
      case 'rewordHead': {
        const body = (await git.run(['show', '-s', '--format=%B', 'HEAD'])).trim();
        const msg = await vscode.window.showInputBox({ prompt: 'Edit commit message', value: body });
        if (msg && msg.trim() !== body) await this.exec('Edit commit message', ['commit', '--amend', '--only', '-m', msg]);
        return;
      }
      case 'interactiveRebase': {
        const d = await git.details(h);
        if (!/^[0-9a-f]{40}$/.test(d.hash)) return;
        // ~1 rather than ^: ^ is an escape in cmd.exe and a glob in zsh.
        const gitPath = this.config().gitPath;
        if (/["`$]/.test(gitPath)) return;
        // PowerShell runs a quoted path only behind the call operator.
        const bin = gitPath === 'git' ? 'git' : `${/pwsh|powershell/i.test(vscode.env.shell) ? '& ' : ''}"${gitPath}"`;
        this.terminal(d.parents.length ? `${bin} rebase -i ${d.hash}~1` : `${bin} rebase -i --root`);
        return;
      }
      case 'compareWithLocal': {
        this.selection.set(reply, []); // this view's "show this commit" still in flight must not overwrite this
        const files = await git.diffFiles(h, '');
        reply({
          type: 'changes',
          payload: { hashes, target: WORKTREE, groups: [{ base: h, label: `Differences between ${short} and local`, files }], resolved: [] },
        });
        return;
      }
      case 'newWorktree':
        return this.newWorktree(h, short, false);
      case 'createPatch': {
        const parts = await Promise.all([...hashes].reverse().map((x) => git.run(['format-patch', '--stdout', '-1', x])));
        const out = parts.join('');
        const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
        await vscode.window.showTextDocument(doc, { viewColumn });
        return;
      }
      case 'browse': {
        const url = await this.remoteCommitUrl(h);
        if (url) vscode.env.openExternal(vscode.Uri.parse(url));
        else vscode.window.showInformationMessage('No supported remote URL for this repository.');
        return;
      }
    }
  }

  /** Merges can only be cherry-picked or reverted relative to a parent: use the first (the branch merged into). */
  private async mainline(hashes: string[]): Promise<string[]> {
    const parents = await Promise.all(hashes.map((h) => this.git.run(['show', '-s', '--format=%P', h])));
    return parents.some((p) => p.trim().split(' ').length > 1) ? ['-m', '1'] : [];
  }

  private async remoteCommitUrl(hash: string): Promise<string | undefined> {
    const remotes = await this.git.remotes();
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) return undefined;
    let url = (await this.git.run(['remote', 'get-url', remote], { allowFail: true })).trim();
    url = url.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@([^/:]+)(:\d+)?\//, 'https://$1/').replace(/\.git$/, '');
    if (!/^https?:\/\//.test(url)) return undefined;
    url = url.replace(/\/\/[^@/]+@/, '//');
    if (/gitlab/.test(url)) return `${url}/-/commit/${hash}`;
    if (/bitbucket/.test(url)) return `${url}/commits/${hash}`;
    return `${url}/commit/${hash}`;
  }

  private async worktreeAction(action: 'open' | 'openHere' | 'remove' | 'lock' | 'unlock' | 'prune', wtPath: string): Promise<void> {
    if (action === 'prune') {
      await this.exec('Prune worktrees', ['worktree', 'prune']);
      return;
    }
    // Only paths git itself listed: the message comes from the webview.
    const wt = (await this.git.worktrees()).find((w) => w.path === wtPath);
    if (!wt) return;
    switch (action) {
      case 'open':
      case 'openHere':
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: action === 'open' });
        return;
      case 'lock':
        await this.exec(`Lock ${path.basename(wt.path)}`, ['worktree', 'lock', '--end-of-options', wt.path]);
        return;
      case 'unlock':
        await this.exec(`Unlock ${path.basename(wt.path)}`, ['worktree', 'unlock', '--end-of-options', wt.path]);
        return;
      case 'remove': {
        if (wt.main || wt.current) return;
        if (!(await this.confirm(`Remove the worktree at ${wt.path}?`, 'Remove', 'Its folder will be deleted. The branch is kept.'))) return;
        try {
          await this.git.run(['worktree', 'remove', '--end-of-options', wt.path]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const dirty = /contains modified or untracked files|is dirty/.test(msg);
          if (dirty && (await this.confirm(`${path.basename(wt.path)} has uncommitted changes. Remove it anyway?`, 'Remove Anyway', 'Those changes are lost.'))) {
            await this.exec(`Remove ${path.basename(wt.path)}`, ['worktree', 'remove', '--force', '--end-of-options', wt.path]);
          } else if (!dirty) vscode.window.showErrorMessage(`Remove worktree failed: ${msg}`);
        }
        await this.reload();
        return;
      }
    }
  }

  /** Checks out a branch (or a new one from a commit) in a new folder next to this repository. */
  private async newWorktree(ref: string, label: string, isBranch: boolean, branchName?: string): Promise<void> {
    const parent = path.dirname(this.root);
    const suggested = path.join(parent, `${this.name}-${(branchName ?? label).replace(/[\\/]/g, '-')}`);
    const where = await vscode.window.showInputBox({ prompt: `Folder for a worktree of ${label}`, value: suggested, valueSelection: [parent.length + 1, suggested.length] });
    if (!where) return;
    const target = path.resolve(this.root, where);
    // git would create the branch first and only then refuse the folder.
    const used = await fs.readdir(target).then((f) => f.length > 0, () => false);
    if (used) {
      vscode.window.showWarningMessage(`${target} already exists and is not empty. Pick another folder.`);
      return;
    }
    let args: string[];
    if (isBranch) {
      args = ['worktree', 'add', '--end-of-options', target, ref];
    } else {
      // For a remote branch, the local branch is named after it (origin/x → x), unless that's taken.
      const free = branchName && !this.refs.some((r) => r.kind === 'local' && r.name === branchName);
      const name = await this.askName(`New branch for the worktree at ${path.basename(target)}`, free ? branchName : path.basename(target));
      if (!name) return;
      args = ['worktree', 'add', '-b', name, '--end-of-options', target, ref];
    }
    if (!(await this.exec(`Create worktree ${path.basename(target)}`, args))) return;
    const pick = await vscode.window.showInformationMessage(`Worktree created at ${target}.`, 'Open in New Window', 'Open Here');
    if (pick) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: pick === 'Open in New Window' });
  }

  /** origin when there is one, else the first remote. */
  private async defaultRemote(): Promise<string | undefined> {
    const remotes = await this.git.remotes();
    return remotes.includes('origin') ? 'origin' : remotes[0];
  }

  private async needRemote(): Promise<string | undefined> {
    const r = await this.defaultRemote();
    if (!r) vscode.window.showInformationMessage(`${this.name} has no remote. Add one with git remote add.`);
    return r;
  }

  private findRef(full: string): Ref | undefined {
    return this.refs.find((r) => r.full === full);
  }

  private async refAction(action: string, full: string, reply: (msg: ToView) => void): Promise<void> {
    const git = this.git;
    // The ref may have been created outside the view since the last refresh.
    if (!this.findRef(full) && full !== 'HEAD') this.refs = await git.refs();
    const ref = this.findRef(full) ?? (full === 'HEAD' ? { name: 'HEAD', full: 'HEAD', kind: 'head' as const, hash: '' } : undefined);
    if (!ref) return;
    const name = ref.name;
    const { branch } = await git.head();
    switch (action) {
      case 'checkout': {
        if (ref.kind === 'remote') {
          const local = name.slice(name.indexOf('/') + 1);
          const existing = this.refs.find((r) => r.kind === 'local' && r.name === local);
          if (existing) return this.checkout(local);
          return this.checkout(name, ['-b', local, '--track']);
        }
        if (ref.kind === 'tag') return this.checkout(name, ['--detach']);
        return this.checkout(name);
      }
      case 'newBranch': {
        const base = ref.kind === 'remote' ? name.slice(name.indexOf('/') + 1) : '';
        const nb = await this.askName(`New branch from ${name}`, base ? `${base}-copy` : '');
        if (nb) await this.checkout(name, ['-b', nb]);
        return;
      }
      case 'merge':
        await this.exec(`Merge ${name} into ${branch || 'HEAD'}`, ['merge', '--no-edit', name]);
        return;
      case 'rebase':
        await this.exec(`Rebase ${branch || 'HEAD'} onto ${name}`, ['rebase', name]);
        return;
      case 'checkoutRebase':
        if (await this.exec(`Checkout ${name}`, ['checkout', name], { refreshLog: false }))
          await this.exec(`Rebase ${name} onto ${branch}`, ['rebase', branch]);
        else await this.reload();
        return;
      case 'pullMerge':
      case 'pullRebase': {
        const [remote, ...rest] = name.split('/');
        await this.exec(`Pull ${name}`, ['pull', action === 'pullRebase' ? '--rebase' : '--no-rebase', remote, rest.join('/')]);
        return;
      }
      case 'update': {
        if (ref.gone) {
          vscode.window.showInformationMessage(`${name}'s upstream ${ref.upstream} was deleted on the remote. Push to recreate it, or delete the local branch.`);
          return;
        }
        if (ref.current) {
          await this.exec(`Update ${name}`, ['pull', '--ff-only']);
        } else if (ref.upstream) {
          const [remote, ...rest] = ref.upstream.split('/');
          await this.exec(`Update ${name}`, ['fetch', remote, `${rest.join('/')}:${name}`]);
        }
        return;
      }
      case 'push':
      case 'forcePush': {
        const force = action === 'forcePush';
        if (force && !(await this.confirm(`Force push ${name}?`, 'Force Push', 'Uses --force-with-lease.'))) return;
        const flags = force ? ['--force-with-lease'] : [];
        if (ref.upstream) {
          await this.exec(`${force ? 'Force push' : 'Push'} ${name}`, ['push', ...flags, ref.upstream.split('/')[0], `${name}:${ref.upstream.split('/').slice(1).join('/')}`]);
        } else {
          const remote = await this.needRemote();
          if (remote) await this.exec(`${force ? 'Force push' : 'Push'} ${name}`, ['push', ...flags, '-u', remote, name]);
        }
        return;
      }
      case 'rename': {
        const nn = await this.askName(`Rename ${name}`, name);
        if (nn && nn !== name) await this.exec(`Rename ${name}`, ['branch', '-m', name, nn]);
        return;
      }
      case 'delete': {
        if (ref.kind === 'local') {
          if (!(await this.confirm(`Delete branch ${name}?`, 'Delete'))) return;
          try {
            await git.run(['branch', '-d', name]);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/not fully merged/.test(msg) && (await this.confirm(`${name} is not fully merged. Delete anyway?`, 'Force Delete'))) {
              await this.exec(`Delete ${name}`, ['branch', '-D', name]);
              return;
            }
            if (!/not fully merged/.test(msg)) vscode.window.showErrorMessage(msg);
          }
          await this.reload();
        } else if (ref.kind === 'remote') {
          if (!(await this.confirm(`Delete remote branch ${name}?`, 'Delete', 'This pushes the deletion to the remote.'))) return;
          const [remote, ...rest] = name.split('/');
          await this.exec(`Delete ${name}`, ['push', remote, '--delete', rest.join('/')]);
        } else if (ref.kind === 'tag') {
          if (!(await this.confirm(`Delete tag ${name}?`, 'Delete'))) return;
          await this.exec(`Delete tag ${name}`, ['tag', '-d', name]);
        }
        return;
      }
      case 'newWorktree': {
        // A remote branch gets a local tracking branch in the new worktree.
        if (ref.kind === 'remote') return this.newWorktree(ref.full, name, false, name.slice(name.indexOf('/') + 1));
        const checkedOut = this.worktreeList.find((w) => w.branch === name);
        if (checkedOut) {
          vscode.window.showInformationMessage(`${name} is already checked out in ${checkedOut.path}.`);
          return;
        }
        return this.newWorktree(name, name, ref.kind === 'local');
      }
      case 'pushTag': {
        const remote = await this.needRemote();
        if (remote) await this.exec(`Push tag ${name}`, ['push', remote, `refs/tags/${name}`]);
        return;
      }
      case 'compare': {
        this.selection.set(reply, []);
        const base = (await git.run(['merge-base', 'HEAD', ref.full])).trim();
        const files = await git.diffFiles(base, ref.full);
        reply({
          type: 'changes',
          payload: { hashes: [], target: ref.hash, groups: [{ base, label: `Changes on ${name} since it left ${branch || 'HEAD'}`, files }], resolved: [] },
        });
        reply({ type: 'setFilter', filter: { ...this.filter, branches: [`HEAD..${ref.full}`] } });
        return;
      }
      case 'diffWorktree': {
        this.selection.set(reply, []);
        const files = await git.diffFiles(ref.full, '');
        reply({
          type: 'changes',
          payload: { hashes: [], target: WORKTREE, groups: [{ base: ref.hash, label: `Differences between ${name} and local`, files }], resolved: [] },
        });
        return;
      }
    }
  }

  private async fileAction(action: string, target: string, file: FileChange, viewColumn: vscode.ViewColumn, reply: (msg: ToView) => void, base = ''): Promise<void> {
    const root = this.git.root;
    switch (action) {
      case 'openRevision':
        await vscode.window.showTextDocument(revUri(root, target, file.path), { preview: true, viewColumn });
        return;
      case 'openLocal':
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, file.path)), { viewColumn });
        return;
      case 'compareLocal':
        await vscode.commands.executeCommand(
          'vscode.diff',
          revUri(root, target, file.path),
          vscode.Uri.file(path.join(root, file.path)),
          `${path.basename(file.path)} (${shortRef(target)} ↔ Local)`,
          { viewColumn },
        );
        return;
      case 'history':
        reply({ type: 'setFilter', filter: { paths: [file.path], follow: true } });
        return;
      case 'copyPath':
        await vscode.env.clipboard.writeText(file.path);
        return;
      case 'applyChange': {
        // Cherry-pick one file: this commit's change to it, applied to the working tree with a
        // three-way merge so it still lands when the file has moved on since.
        if (target === WORKTREE || !base) return;
        // The old path only for a rename: a copy's source is a different file, with its own change.
        // Fixed prefixes and no external diff tool, whatever the user's diff settings are.
        const patch = await this.git.run([
          'diff', '--binary', '-M', '--no-ext-diff', '--no-color', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative',
          '--end-of-options', base, target, '--', ...(file.status === 'R' && file.oldPath ? [file.oldPath] : []), file.path,
        ]);
        if (!patch.trim()) {
          vscode.window.showInformationMessage(`${shortRef(target)} doesn't change ${path.basename(file.path)}: nothing to apply.`);
          return;
        }
        this.applying = shortRef(target);
        // --3way needs the file to match the index; with unstaged edits, apply on top of them instead.
        const dirty = await this.git.run(['diff', '--quiet', '--', file.path]).then(() => false, () => true);
        await this.exec(`Apply ${path.basename(file.path)} from ${shortRef(target)}`, ['apply', ...(dirty ? [] : ['--3way']), '--whitespace=nowarn', '-'], { input: patch });
        return;
      }
      case 'getFromRevision':
        if (target === WORKTREE) return;
        if (await this.confirm(`Replace local ${file.path} with the version from ${shortRef(target)}?`, 'Get'))
          await this.exec(`Get ${file.path}`, file.status === 'D' ? ['rm', '-q', '--', file.path] : ['checkout', target, '--', file.path]);
        return;
    }
  }

  // ------------------------------------------------------------ conflicts

  private async conflictAction(action: 'open' | 'ours' | 'theirs' | 'resolved', file: string): Promise<void> {
    const git = this.git;
    const conflict = (await git.conflicts()).find((c) => c.path === file);
    const uri = vscode.Uri.file(path.join(git.root, file));
    switch (action) {
      case 'open':
        try {
          // VS Code's own three-way merge editor, from the built-in Git extension.
          await vscode.commands.executeCommand('git.openMergeEditor', uri);
        } catch {
          await vscode.window.showTextDocument(uri);
        }
        return;
      case 'ours':
      case 'theirs': {
        if (!conflict) return;
        // DU: deleted on our side, UD: deleted on theirs. Keeping the deleting side removes the file.
        const deleted = action === 'ours' ? conflict.code[0] === 'D' : conflict.code[1] === 'D';
        if (deleted) await this.exec(`Keep deletion of ${file}`, ['rm', '-q', '--', file]);
        else {
          if (await this.exec(`Keep ${action} for ${file}`, ['checkout', `--${action}`, '--', file], { refreshLog: false })) await this.exec(`Mark ${file} resolved`, ['add', '--', file]);
          else await this.reload();
        }
        return;
      }
      case 'resolved': {
        let text = '';
        try {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          // Deleted in the working tree: staging the deletion resolves it.
          await this.exec(`Mark ${file} resolved`, ['rm', '-q', '--cached', '--', file]);
          return;
        }
        if (/^(<{7}|>{7})( |$)/m.test(text) && !(await this.confirm(`${file} still contains conflict markers. Mark it resolved anyway?`, 'Mark Resolved'))) return;
        await this.exec(`Mark ${file} resolved`, ['add', '--', file]);
        return;
      }
    }
  }

  private async operationAction(action: 'continue' | 'skip' | 'abort'): Promise<void> {
    const git = this.git;
    const { branch } = await git.head();
    const op = await git.operation(branch);
    if (!op || op.kind === 'conflicts') return this.reload();
    if (action === 'abort' && !(await this.confirm(`Abort the ${op.kind}?`, 'Abort', 'Everything goes back to how it was before it started; resolutions made so far are discarded.'))) return;
    if (action === 'continue' && op.conflicts.length) {
      vscode.window.showWarningMessage(`Resolve the remaining ${op.conflicts.length} conflict${op.conflicts.length === 1 ? '' : 's'} first.`);
      return;
    }
    if (action === 'skip' && op.kind === 'merge') return;
    // Continue would open an editor for the message: take git's prepared one.
    await this.exec(`${action[0].toUpperCase()}${action.slice(1)} ${op.kind}`, [op.kind as string, `--${action}`], { env: { GIT_EDITOR: 'true' } });
  }

  // ------------------------------------------------------------- messages

  /**
   * Messages about this repository, from a view showing it. `column`: where editors it opens
   * should go. `reply`: to that view only (its selection, its inspector). `others`: every other
   * view showing this repository.
   */
  async handle(m: ToHost, column: vscode.ViewColumn, reply: (msg: ToView) => void, others: (msg: ToView) => void): Promise<void> {
    switch (m.type) {
      case 'refresh':
        await this.reload();
        return;
      case 'fetch':
        if (!(await this.needRemote())) return;
        await this.exec('Fetch', ['fetch', '--all', '--prune']);
        return;
      case 'loadMore':
        if (this.hasMore && this.resetting === 0) await this.loadPage(true);
        return;
      case 'setFilter':
        this.filter = m.filter;
        others({ type: 'filterSync', filter: m.filter });
        await this.reloadLog();
        return;
      case 'select':
        await this.showChanges(m.hashes, reply).catch((e) => {
          reply({ type: 'changes', payload: { hashes: m.hashes, target: m.hashes[0] ?? '', groups: [], resolved: [] } });
          this.fail(e);
        });
        return;
      case 'containing':
        reply({ type: 'containing', hash: m.hash, refs: await this.git.containing(m.hash) });
        return;
      case 'openDiff':
        await this.openDiff(m.base, m.target, m.file, m.focus, column);
        return;
      case 'fileAction':
        await this.fileAction(m.action, m.target, m.file, column, reply, m.base ?? '');
        return;
      case 'commitAction':
        await this.commitAction(m.action, m.hashes, column, reply);
        return;
      case 'refAction':
        await this.refAction(m.action, m.ref, reply);
        return;
      case 'toggleFavorite': {
        const favs = this.favorites();
        const i = favs.indexOf(m.ref);
        if (i >= 0) favs.splice(i, 1);
        else favs.push(m.ref);
        await this.ctx.workspaceState.update(FAVORITES_KEY + ':' + this.git.root, favs);
        await this.loadState();
        return;
      }
      case 'conflict':
        await this.conflictAction(m.action, m.path);
        return;
      case 'operation':
        await this.operationAction(m.action);
        return;
      case 'worktree':
        await this.worktreeAction(m.action, m.path);
        return;
      case 'pickPaths': {
        const picked = await vscode.window.showOpenDialog({
          defaultUri: vscode.Uri.file(this.git.root),
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
          title: 'Show history of',
        });
        if (!picked) return;
        const paths = picked.map((u) => path.relative(this.git.root, u.fsPath) || '.').filter((p) => !p.startsWith('..'));
        reply({ type: 'setFilter', filter: { ...this.filter, paths } });
        return;
      }
      case 'pickDate': {
        const since = await vscode.window.showInputBox({ prompt: 'Show commits since (e.g. 2026-10-01, "2 weeks ago")', value: this.filter.since ?? '' });
        if (since === undefined) return;
        const until = await vscode.window.showInputBox({ prompt: 'Until (leave empty for now)', value: this.filter.until ?? '' });
        if (until === undefined) return;
        reply({ type: 'setFilter', filter: { ...this.filter, since: since || undefined, until: until || undefined } });
        return;
      }
    }
  }
}
