// Shared between the extension host and the webview. No imports from vscode here.

export interface Segment {
  /** Lane at the top edge (for top half) or at the center (for bottom half). */
  a: number;
  /** Lane at the center (top half) or at the bottom edge (bottom half). */
  b: number;
  color: number;
}

/** A long edge drawn as a short fading stub instead of holding a lane open. */
export interface Stub {
  /** The commit at the other end. */
  to: string;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  top: Segment[];
  bottom: Segment[];
  /** Hidden edges leaving this commit for a far-away parent. */
  down?: Stub[];
  /** Hidden edges arriving from far-away children. */
  up?: Stub[];
  /** Number of lanes this row needs to draw. */
  width: number;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  subject: string;
}

export interface LogRow extends Commit {
  graph: GraphRow;
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface Ref {
  name: string;        // short name: master, origin/master, v1.0
  full: string;        // refs/heads/master
  kind: RefKind;
  hash: string;        // commit the ref points at (tags peeled)
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** The upstream branch was deleted on the remote. */
  gone?: boolean;
  current?: boolean;
}

export type Palette = 'metro' | 'atom';

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | 'conflicts';

export interface Conflict {
  path: string;
  /** Two-letter `git status` code: UU, AA, DU, UD, AU, UA, DD. */
  code: string;
}

/** A merge, rebase, cherry-pick or revert that stopped half-way. */
export interface Operation {
  kind: OperationKind;
  /** What "ours" means right now, e.g. "main" or "onto 1a2b3c4". */
  ours: string;
  /** What "theirs" means right now, e.g. "feature/login" or "a1b2c3d Fix login". */
  theirs: string;
  conflicts: Conflict[];
  /** Rebase progress, e.g. 2 of 5. */
  step?: number;
  total?: number;
}

/** One line per repository, for the repository list and the switcher. */
export interface RepoSummary {
  root: string;
  name: string;
  branch: string; // '' when detached
  head: string;
  ahead: number;
  behind: number;
  operation?: OperationKind;
  conflicts: number;
}

export interface RepoState {
  root: string;
  head: string;            // commit hash or ''
  branch: string;          // current branch or '' when detached
  refs: Ref[];
  favorites: string[];     // full ref names
  me: string;
  operation?: Operation;
  worktrees: Worktree[];
}

export interface LogFilter {
  text?: string;
  regex?: boolean;
  matchCase?: boolean;
  branches?: string[];     // empty = all
  authors?: string[];
  since?: string;
  until?: string;
  paths?: string[];
  /** History of a line range in one file (git log -L). */
  lines?: { path: string; start: number; end: number };
  /** Follow one file across renames (git log --follow). */
  follow?: boolean;
}

export interface Worktree {
  path: string;
  head: string;
  branch: string; // '' when detached
  main: boolean;
  current: boolean;
  locked?: string; // the reason, or '' when locked without one
  prunable: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: FileStatus;
  path: string;
  oldPath?: string;
}

export interface ChangeGroup {
  /** Left side of the diff. '' for the empty tree. */
  base: string;
  label: string;
  files: FileChange[];
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  commitTime: number;
  body: string;
}

export interface ChangesPayload {
  hashes: string[];
  /** Right side of every diff in the groups. */
  target: string;
  groups: ChangeGroup[];
  /** Files a merge resolved differently from every parent. */
  resolved: string[];
  details?: CommitDetails;
}

// webview -> extension
export type ToHost =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'fetch' }
  | { type: 'loadMore' }
  | { type: 'setRepo'; root: string; openLog?: boolean }
  | { type: 'setFilter'; filter: LogFilter }
  | { type: 'select'; hashes: string[] }
  | { type: 'containing'; hash: string }
  | { type: 'openDiff'; base: string; target: string; file: FileChange; focus?: boolean }
  | { type: 'fileAction'; action: string; target: string; file: FileChange; base?: string }
  | { type: 'commitAction'; action: string; hashes: string[] }
  | { type: 'refAction'; action: string; ref: string }
  | { type: 'toggleFavorite'; ref: string }
  | { type: 'pickPaths' }
  | { type: 'pickDate' }
  | { type: 'conflict'; action: 'open' | 'ours' | 'theirs' | 'resolved'; path: string }
  | { type: 'operation'; action: 'continue' | 'skip' | 'abort' }
  | { type: 'openLog'; reveal?: string; filter?: LogFilter }
  | { type: 'worktree'; action: 'open' | 'openHere' | 'remove' | 'lock' | 'unlock' | 'prune'; path: string };

// extension -> webview
export type ToView =
  | { type: 'repos'; repos: RepoSummary[]; current: string }
  | { type: 'settings'; palette: Palette }
  | { type: 'state'; state: RepoState }
  | { type: 'log'; rows: LogRow[]; append: boolean; hasMore: boolean; filtered: boolean }
  | { type: 'changes'; payload: ChangesPayload }
  | { type: 'containing'; hash: string; refs: string[] }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string }
  | { type: 'reveal'; hash: string }
  | { type: 'setFilter'; filter: LogFilter }
  /** Another view of the same repository changed the filter: show it, don't send it back. */
  | { type: 'filterSync'; filter: LogFilter }
  | { type: 'empty'; message: string };
