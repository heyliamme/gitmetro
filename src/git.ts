import { spawn } from 'child_process';
import { existsSync, promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import type { ChangeGroup, Commit, CommitDetails, Conflict, FileChange, FileStatus, LogFilter, Operation, Ref, Worktree } from './protocol';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message);
  }
}

/**
 * Revisions reach git as positional arguments. Anything that could be read as an option
 * (leading '-') or that is not a plausible revision is refused before git sees it.
 */
export function isSafeRev(rev: string): boolean {
  if (!rev || rev.length > 512) return false;
  return rev.split(/\.\.\.?/).every((part) => part === '' || (/^[^\s~:?*[\\\x00-\x1f]+(~\d*|\^\d*|\^\{commit\})*$/.test(part) && !part.startsWith('-')));
}

export function assertRev(rev: string): string {
  if (!isSafeRev(rev)) throw new GitError(`Refusing suspicious revision: ${JSON.stringify(rev).slice(0, 80)}`, '', null);
  return rev;
}

const RS = '\x1e';
const US = '\x1f';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Optional sink for a line per git command; the extension points it at its output channel. */
export let traceGit: ((line: string) => void) | undefined;
export function setGitTrace(fn: ((line: string) => void) | undefined): void {
  traceGit = fn;
}

export class Git {
  constructor(readonly root: string, private readonly bin = 'git') {}

  run(args: string[], opts: { input?: string; allowFail?: boolean; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string> {
    return this.runRaw(args, opts).then((b) => b.toString('utf8'));
  }

  /** Like run, but the bytes as they came: file contents may not be text. */
  runRaw(args: string[], opts: { input?: string; allowFail?: boolean; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Buffer> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      // English messages (we match on some), but the user's character set: LC_ALL=C would
      // make case-insensitive search miss non-ASCII letters.
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_MESSAGES: 'C', LANGUAGE: 'C', ...opts.env };
      delete env.LC_ALL;
      // spawn reports a missing cwd as ENOENT too, which would read as "git is not installed".
      if (!existsSync(this.root)) {
        reject(new GitError(`${this.root} no longer exists: not a git repository`, '', -1));
        return;
      }
      // Cancelling must also stop the helpers git starts (git-remote-https, ssh): on POSIX run it
      // in its own process group and signal the group.
      const group = !!opts.signal && process.platform !== 'win32';
      const p = spawn(this.bin, args, { cwd: this.root, env, signal: group ? undefined : opts.signal, detached: group });
      if (group) {
        const kill = () => {
          try {
            process.kill(-p.pid!, 'SIGTERM');
          } catch {
            /* already gone */
          }
        };
        if (opts.signal!.aborted) kill();
        else opts.signal!.addEventListener('abort', kill, { once: true });
        p.on('close', () => opts.signal!.removeEventListener('abort', kill));
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => err.push(d));
      p.on('error', reject);
      p.on('close', (code) => {
        traceGit?.(`git ${args.slice(0, 3).join(' ')}${args.length > 3 ? ' …' : ''} → ${code} in ${Date.now() - started}ms`);
        const raw = Buffer.concat(out);
        const stderr = Buffer.concat(err).toString('utf8');
        if (opts.signal?.aborted) {
          const e = new Error('cancelled');
          e.name = 'AbortError';
          reject(e);
        } else if (code === 0 || opts.allowFail) resolve(raw);
        else reject(new GitError(stderr.trim() || raw.toString('utf8').trim() || `git ${args[0]} failed (${code})`, stderr, code));
      });
      // git may exit before reading all of stdin (blame on a large unsaved file): not an error.
      p.stdin.on('error', () => {});
      if (opts.input !== undefined) p.stdin.end(opts.input);
      else p.stdin.end();
    });
  }

  static async toplevel(dir: string, bin = 'git'): Promise<string | undefined> {
    try {
      const out = await new Git(dir, bin).run(['rev-parse', '--show-toplevel']);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async head(): Promise<{ hash: string; branch: string }> {
    const hash = (await this.run(['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true })).trim();
    const branch = (await this.run(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })).trim();
    return { hash, branch };
  }

  async me(): Promise<string> {
    return (await this.run(['config', 'user.name'], { allowFail: true })).trim();
  }

  async refs(): Promise<Ref[]> {
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)'].join(US);
    const out = await this.run(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    const refs: Ref[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [full, obj, peeled, upstream, track, head] = line.split(US);
      let kind: Ref['kind'];
      let name: string;
      if (full.startsWith('refs/heads/')) {
        kind = 'local';
        name = full.slice(11);
      } else if (full.startsWith('refs/remotes/')) {
        kind = 'remote';
        name = full.slice(13);
        if (name.endsWith('/HEAD')) continue;
      } else {
        kind = 'tag';
        name = full.slice(10);
      }
      const ref: Ref = { name, full, kind, hash: peeled || obj };
      if (upstream) ref.upstream = upstream;
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      if (ahead) ref.ahead = +ahead[1];
      if (behind) ref.behind = +behind[1];
      if (/\bgone\b/.test(track)) ref.gone = true;
      if (head === '*') ref.current = true;
      refs.push(ref);
    }
    return refs;
  }

  /** Builds the git log arguments for a filter. Commits come out children first. */
  logArgs(filter: LogFilter, order: 'date' | 'topo', skip: number, limit: number, hasHead = true): string[] {
    // An unborn branch (fresh repo, new orphan branch) has no HEAD to log.
    const head = hasHead ? ['HEAD'] : [];
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s'].join(US);
    const args = ['log', `--format=${RS}${fmt}`, order === 'topo' ? '--topo-order' : '--date-order', `--skip=${skip}`, `-n${limit}`];
    if (filter.text) {
      args.push(`--grep=${filter.text}`);
      if (!filter.regex) args.push('--fixed-strings');
      else args.push('--extended-regexp');
      if (!filter.matchCase) args.push('--regexp-ignore-case');
    }
    // --author is matched like --grep: as a fixed string when a plain text search is on
    // (--fixed-strings covers both), else as a basic regex, or an extended one in regex mode.
    // In a basic regex ( ) + ? | { } are literal; escaping them would make them operators.
    const fixed = !!filter.text && !filter.regex;
    const literal = filter.text && filter.regex ? /[.*+?^${}()|[\]\\]/g : /[.*^$[\]\\]/g;
    for (const a of filter.authors ?? []) args.push(`--author=${fixed ? a : a.replace(literal, '\\$&')}`);
    if (filter.since) args.push(`--since=${filter.since}`);
    if (filter.until) args.push(`--until=${filter.until}`);
    if (filter.lines) {
      // Commits that touched these lines, in the current branch's history; no patches.
      const { path, start, end } = filter.lines;
      args.push(`-L${Math.max(1, Math.floor(start))},${Math.max(1, Math.floor(end))}:${path}`, '--no-patch');
      if (filter.branches?.length) args.push('--end-of-options', ...filter.branches.map(assertRev));
      else args.push(...head);
      return args;
    }
    if (filter.follow && filter.paths?.length === 1) {
      // Across renames; git can only follow one file, along the current branch.
      args.push('--follow');
      if (filter.branches?.length) args.push('--end-of-options', ...filter.branches.map(assertRev));
      else args.push(...head);
      args.push('--', filter.paths[0]);
      return args;
    }
    if (filter.paths?.length) args.push('--parents', '--full-history', '--simplify-merges');
    if (filter.branches?.length) args.push('--end-of-options', ...filter.branches.map(assertRev));
    else args.push('--branches', '--remotes', '--tags', ...head);
    args.push('--');
    if (filter.paths?.length) args.push(...filter.paths);
    return args;
  }

  async log(filter: LogFilter, order: 'date' | 'topo', skip: number, limit: number, hasHead = true): Promise<Commit[]> {
    const out = await this.run(this.logArgs(filter, order, skip, limit, hasHead), { allowFail: !!filter.text });
    return parseLog(out);
  }

  async commit(rev: string): Promise<Commit | undefined> {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s'].join(US);
    const out = await this.run(['log', '-1', `--format=${RS}${fmt}`, '--end-of-options', assertRev(rev), '--'], { allowFail: true });
    return parseLog(out)[0];
  }

  async resolve(rev: string): Promise<string | undefined> {
    if (!isSafeRev(rev)) return undefined;
    const out = await this.run(['rev-parse', '-q', '--verify', '--end-of-options', `${rev}^{commit}`], { allowFail: true });
    return out.trim() || undefined;
  }

  async details(hash: string): Promise<CommitDetails> {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%B'].join(US);
    const out = await this.run(['show', '-s', `--format=${fmt}`, '--end-of-options', assertRev(hash)]);
    const [h, p, an, ae, at, cn, ct, ...body] = out.split(US);
    return {
      hash: h,
      parents: p ? p.split(' ') : [],
      author: an,
      email: ae,
      authorTime: +at,
      committer: cn,
      commitTime: +ct,
      body: body.join(US).trimEnd(),
    };
  }

  async diffFiles(base: string, target: string): Promise<FileChange[]> {
    const args = ['diff', '--name-status', '-z', '-M', '-C', '--end-of-options', assertRev(base || EMPTY_TREE)];
    if (target) args.push(assertRev(target));
    args.push('--');
    return parseNameStatus(await this.run(args));
  }

  /** One group per parent; for a merge, each group is the changes relative to that parent. */
  async commitChanges(hash: string, parents: string[], subjects: Map<string, string>): Promise<{ groups: ChangeGroup[]; resolved: string[] }> {
    if (parents.length === 0) {
      return { groups: [{ base: '', label: 'Initial commit', files: await this.diffFiles('', hash) }], resolved: [] };
    }
    const groups = await Promise.all(
      parents.map(async (p, i) => ({
        base: p,
        label:
          parents.length === 1
            ? ''
            : `Changes to parent ${i + 1}: ${p.slice(0, 8)}${subjects.get(p) ? ' ' + subjects.get(p) : ''}`,
        files: await this.diffFiles(p, hash),
      })),
    );
    let resolved: string[] = [];
    if (parents.length > 1) {
      const out = await this.run(['diff-tree', '-r', '--cc', '--name-only', '--no-commit-id', '-z', '--end-of-options', assertRev(hash)], { allowFail: true });
      resolved = out.split('\0').filter(Boolean);
    }
    return { groups, resolved };
  }

  /** A file's bytes at a revision; '' when it doesn't exist there. */
  /**
   * Where lines start..end of the editor's text are in HEAD's version of the file, so
   * `log -L` follows the right lines when the file has edits not committed yet.
   */
  async linesInHead(file: string, text: string, start: number, end: number): Promise<{ start: number; end: number } | 'uncommitted' | 'untracked'> {
    const head = await this.runRaw(['cat-file', 'blob', `HEAD:${file}`], { allowFail: true });
    if (!head.length && !(await this.run(['ls-tree', 'HEAD', '--', file], { allowFail: true })).trim()) return 'untracked';
    // Line endings may differ between the editor and the repository (core.autocrlf): ignore them.
    const lf = (t: string) => t.replace(/\r\n/g, '\n');
    const before = lf(head.toString('utf8'));
    text = lf(text);
    if (before === text) return { start, end };
    // A private folder: the shared temp dir is writable by other users.
    const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'gitmetro-lines-'));
    try {
      await fs.writeFile(nodePath.join(dir, 'a'), before, { mode: 0o600 });
      await fs.writeFile(nodePath.join(dir, 'b'), text, { mode: 0o600 });
      const diff = await this.run(['diff', '--no-index', '--no-ext-diff', '--no-color', '-U0', '--', nodePath.join(dir, 'a'), nodePath.join(dir, 'b')], { allowFail: true });
      return mapRangeToHead(parseHunks(diff), start, end) ?? 'uncommitted';
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async showRaw(rev: string, path: string): Promise<Buffer> {
    if (!rev || !isSafeRev(rev) || path.includes('\0')) return Buffer.alloc(0);
    return this.runRaw(['show', '--end-of-options', `${rev}:${path}`], { allowFail: true });
  }

  /** A file as text for a diff editor: binaries and submodules get a one-line description. */
  async show(rev: string, path: string): Promise<string> {
    if (!rev || !isSafeRev(rev) || path.includes('\0')) return '';
    const entry = (await this.run(['ls-tree', '--end-of-options', rev, '--', path], { allowFail: true })).trim();
    // A submodule is a "commit" entry in the tree: show what git diff shows for it.
    const sub = /^160000 commit ([0-9a-f]{40})\t/.exec(entry);
    if (sub) return `Subproject commit ${sub[1]}\n`;
    const bytes = await this.showRaw(rev, path);
    if (isBinary(bytes)) return `Binary file, ${bytes.length.toLocaleString()} bytes. GitMetro shows images as images; other binaries can't be shown as text.\n`;
    return bytes.toString('utf8');
  }

  async containing(hash: string): Promise<string[]> {
    const out = await this.run(['branch', '-a', '--format=%(refname)', '--contains', assertRev(hash)], { allowFail: true });
    return out
      .split('\n')
      .filter((l) => l.startsWith('refs/') && !l.endsWith('/HEAD'))
      .map((l) => l.replace(/^refs\/(heads|remotes)\//, ''));
  }

  async authors(): Promise<string[]> {
    const out = await this.run(['log', '--branches', '--remotes', '--format=%an', '-n5000'], { allowFail: true });
    const counts = new Map<string, number>();
    for (const a of out.split('\n')) if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }

  private gitDirCache?: string;

  async gitDir(): Promise<string> {
    if (!this.gitDirCache) this.gitDirCache = nodePath.resolve(this.root, (await this.run(['rev-parse', '--git-dir'])).trim());
    return this.gitDirCache;
  }

  async conflicts(): Promise<Conflict[]> {
    const out = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=no'], { allowFail: true });
    const list: Conflict[] = [];
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const code = e.slice(0, 2);
      if (code[0] === 'R' || code[0] === 'C') i++; // rename source follows
      if (/^(UU|AA|DU|UD|AU|UA|DD)$/.test(code)) list.push({ path: e.slice(3), code });
    }
    return list;
  }

  /** The merge, rebase, cherry-pick or revert in progress, if any. */
  async operation(branch: string): Promise<Operation | undefined> {
    const dir = await this.gitDir();
    const read = (f: string) => {
      try {
        return readFileSync(nodePath.join(dir, f), 'utf8').trim();
      } catch {
        return '';
      }
    };
    const describe = async (rev: string) => {
      if (!rev) return '?';
      const name = (await this.run(['name-rev', '--name-only', '--no-undefined', '--exclude=refs/tags/*', rev], { allowFail: true })).trim();
      const subject = (await this.run(['show', '-s', '--format=%s', rev], { allowFail: true })).trim();
      return name && !/[~^]/.test(name) ? name.replace(/^remotes\//, '') : `${rev.slice(0, 7)} ${subject}`.trim();
    };
    let op: Operation | undefined;
    const here = branch || 'HEAD';
    if (existsSync(nodePath.join(dir, 'rebase-apply', 'applying'))) {
      // git am: patches from a mailbox, not a rebase.
      op = { kind: 'am', ours: here, theirs: `patch ${read('rebase-apply/next')} of ${read('rebase-apply/last')}`, conflicts: [] };
    } else if (existsSync(nodePath.join(dir, 'rebase-merge')) || existsSync(nodePath.join(dir, 'rebase-apply'))) {
      const sub = existsSync(nodePath.join(dir, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
      const onto = read(`${sub}/onto`);
      const headName = read(`${sub}/head-name`).replace(/^refs\/heads\//, '');
      const step = +(read(`${sub}/msgnum`) || read(`${sub}/next`)) || undefined;
      const total = +(read(`${sub}/end`) || read(`${sub}/last`)) || undefined;
      // During a rebase "ours" is the branch being rebased onto, "theirs" the commit being replayed.
      op = { kind: 'rebase', ours: `${await describe(onto)} (rebasing onto)`, theirs: `${headName ? headName + ': ' : ''}${await describe(read('REBASE_HEAD'))}`, conflicts: [], step, total };
    } else if (read('MERGE_HEAD')) {
      op = { kind: 'merge', ours: here, theirs: await describe(read('MERGE_HEAD').split('\n')[0]), conflicts: [] };
    } else if (read('CHERRY_PICK_HEAD')) {
      op = { kind: 'cherry-pick', ours: here, theirs: await describe(read('CHERRY_PICK_HEAD')), conflicts: [] };
    } else if (read('REVERT_HEAD')) {
      op = { kind: 'revert', ours: here, theirs: `revert of ${await describe(read('REVERT_HEAD'))}`, conflicts: [] };
    }
    const conflicts = await this.conflicts();
    if (op) op.conflicts = conflicts;
    // Conflicts with nothing in progress: left behind by a stash pop or apply.
    // A squash merge leaves no MERGE_HEAD, only SQUASH_MSG.
    else if (conflicts.length) op = { kind: 'conflicts', ours: here, theirs: read('SQUASH_MSG') ? 'the squash-merged branch' : 'stashed changes', conflicts };
    return op;
  }

  async worktrees(): Promise<Worktree[]> {
    const out = await this.run(['worktree', 'list', '--porcelain'], { allowFail: true });
    const here = nodePath.resolve(this.root);
    const list: Worktree[] = [];
    for (const block of out.split('\n\n')) {
      const fields = new Map<string, string>();
      for (const line of block.split('\n')) {
        if (!line) continue;
        const sp = line.indexOf(' ');
        fields.set(sp < 0 ? line : line.slice(0, sp), sp < 0 ? '' : line.slice(sp + 1));
      }
      const p = fields.get('worktree');
      if (!p) continue;
      list.push({
        path: p,
        head: fields.get('HEAD') ?? '',
        branch: (fields.get('branch') ?? '').replace(/^refs\/heads\//, ''),
        main: list.length === 0,
        current: nodePath.resolve(p) === here,
        locked: fields.has('locked') ? fields.get('locked')! : undefined,
        prunable: fields.has('prunable'),
      });
    }
    return list;
  }

  /** git blame of a file's current text (which may be unsaved), one entry per line. */
  async blame(path: string, contents: string): Promise<BlameLine[]> {
    const out = await this.run(['blame', '--porcelain', '--contents', '-', '--', path], { input: contents });
    const commits = new Map<string, BlameCommit>();
    const lines: BlameLine[] = [];
    const rows = out.split('\n');
    for (let i = 0; i < rows.length; i++) {
      const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(rows[i]);
      if (!head) continue;
      const hash = head[1];
      let c = commits.get(hash);
      if (!c) commits.set(hash, (c = { hash, author: '', authorTime: 0, summary: '' }));
      for (i++; i < rows.length && !rows[i].startsWith('\t'); i++) {
        const r = rows[i];
        if (r.startsWith('author ')) c.author = r.slice(7);
        else if (r.startsWith('author-time ')) c.authorTime = +r.slice(12);
        else if (r.startsWith('summary ')) c.summary = r.slice(8);
      }
      lines[+head[2] - 1] = { commit: c };
    }
    return lines;
  }

  /** Whether `name` is acceptable as a new branch name. */
  async isValidBranchName(name: string): Promise<boolean> {
    if (!name || name.startsWith('-')) return false;
    const out = await this.run(['check-ref-format', '--branch', name], { allowFail: true });
    return out.trim() === name;
  }

  async remotes(): Promise<string[]> {
    return (await this.run(['remote'])).split('\n').filter(Boolean);
  }

  async isDirty(): Promise<boolean> {
    return (await this.run(['status', '--porcelain', '-uno'])).trim().length > 0;
  }
}

export interface BlameCommit {
  hash: string; // all zeros: not committed yet
  author: string;
  authorTime: number;
  summary: string;
}

export interface BlameLine {
  commit: BlameCommit;
}

/** git's error output for a person: the fatal/error lines first, without the hint: chatter. */
export function readableGitError(msg: string): string {
  const known: [RegExp, (m: RegExpExecArray) => string][] = [
    [/'([^']+)' is already (?:used|checked out) by worktree at '([^']+)'/, (m) => `${m[1]} is checked out in another worktree (${m[2]}). Open that worktree, or pick another branch.`],
    [/Unable to create '([^']+index\.lock)': File exists/, () => 'Another git process is running in this repository. If none is, delete .git/index.lock and try again.'],
    [/cannot remove a locked working tree/, () => 'This worktree is locked. Unlock it first.'],
    [/\[rejected\][^\n]*\(fetch first\)|\[rejected\][^\n]*\(non-fast-forward\)/, () => 'The remote has commits you do not have yet. Pull (or fetch and merge) first, then push again.'],
    [/There is no path (\S+) in the commit/, (m) => `${m[1]} isn't committed yet: it has no history.`],
  ];
  for (const [re, say] of known) {
    const m = re.exec(msg);
    if (m) return say(m);
  }
  const lines = msg.split('\n').map((l) => l.trim()).filter((l) => l && !/^hint:/.test(l));
  const key = lines.filter((l) => /^(fatal|error):/.test(l));
  const rest = lines.filter((l) => !/^(fatal|error):/.test(l));
  return [...key, ...rest].join(' ').replace(/^(fatal|error):\s*/, '').slice(0, 400);
}

/**
 * Maps a 1-based line range in the editor to the same lines in HEAD, given the hunks of a
 * `diff -U0 HEAD editor`. Lines only in the editor are skipped; undefined when none are left.
 */
export function mapRangeToHead(hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[], start: number, end: number): { start: number; end: number } | undefined {
  const map = (line: number, dir: 1 | -1): number | undefined => {
    let shift = 0;
    for (const h of hunks) {
      const newEnd = h.newStart + h.newLines - 1;
      // With -U0 a pure deletion has newLines 0 and newStart is the line before it.
      if (h.newLines > 0 && line >= h.newStart && line <= newEnd) {
        // A changed line has no exact counterpart: use the edge of the old block, if any.
        if (h.oldLines === 0) return undefined;
        return dir === 1 ? h.oldStart : h.oldStart + h.oldLines - 1;
      }
      if ((h.newLines > 0 ? h.newStart : h.newStart + 1) > line) break;
      // Old and new line numbers just after this hunk (an empty side counts from the line before).
      const nextOld = h.oldLines ? h.oldStart + h.oldLines : h.oldStart + 1;
      const nextNew = h.newLines ? h.newStart + h.newLines : h.newStart + 1;
      shift = nextOld - nextNew;
    }
    return line + shift;
  };
  for (let a = start; a <= end; a++) {
    const s = map(a, 1);
    if (s === undefined) continue;
    for (let b = end; b >= a; b--) {
      const e = map(b, -1);
      if (e !== undefined) return { start: s, end: Math.max(s, e) };
    }
  }
  return undefined;
}

export function parseHunks(diff: string): { oldStart: number; oldLines: number; newStart: number; newLines: number }[] {
  const out = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({ oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return out;
}

/** git's own heuristic: a NUL in the first 8000 bytes. */
export function isBinary(b: Buffer): boolean {
  return b.subarray(0, 8000).includes(0);
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const [hash, parents, author, email, at, ...subject] = rec.split(US);
    commits.push({
      hash,
      parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
      author,
      email,
      authorTime: +at,
      subject: subject.join(US).replace(/\n+$/, ''),
    });
  }
  return commits;
}

export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const status = code[0] as FileStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: parts[i++] });
    }
  }
  return files;
}
