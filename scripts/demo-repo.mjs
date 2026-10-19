// Builds a fictional repository with a realistic shape: feature branches, merges,
// a release line, tags, a remote with branches ahead and behind.
// Used as the test fixture and for screenshots.
//
//   node scripts/demo-repo.mjs <dir> [--conflict]
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Ignore the user's global git config (commit signing, hooks, templates): the demo must build anywhere.
const emptyConfig = path.join(mkdtempSync(path.join(tmpdir(), 'gitmetro-gitconfig-')), 'config');
writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

if (!process.argv[2]) {
  console.error('usage: node scripts/demo-repo.mjs <dir> [--conflict]');
  process.exit(2);
}
const dir = path.resolve(process.argv[2]);
const withConflict = process.argv.includes('--conflict');
const origin = dir + '.origin.git';
const peer = dir + '.peer';
for (const d of [dir, origin, peer]) rmSync(d, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const people = [
  ['Ada Park', 'ada@lumen.example'],
  ['Marco Silva', 'marco@lumen.example'],
  ['Priya Raman', 'priya@lumen.example'],
  ['Jonas Weber', 'jonas@lumen.example'],
  ['Lin Chen', 'lin@lumen.example'],
];

// Commits spread evenly over the past ~6 weeks; the newest land minutes ago.
const now = Math.floor(Date.now() / 1000);
let clock = now - 42 * 86400;
let ticksLeft = 38; // roughly the number of commits and merges below
const tick = (min = 0, max = 0) => {
  const step = max ? 60 * (min + Math.floor(rand() * (max - min))) : ((now - 5400 - clock) / Math.max(1, ticksLeft--)) * (0.4 + rand() * 1.2);
  return (clock = Math.min(now - 120, clock + Math.max(60, Math.floor(step))));
};
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function git(cwd, args, who = people[0]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who[0],
      GIT_AUTHOR_EMAIL: who[1],
      GIT_COMMITTER_NAME: who[0],
      GIT_COMMITTER_EMAIL: who[1],
      GIT_AUTHOR_DATE: `${clock} +0000`,
      GIT_COMMITTER_DATE: `${clock} +0000`,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

const g = (args, who) => git(dir, args, who);
function edit(file, line, cwd = dir) {
  const f = path.join(cwd, file);
  mkdirSync(path.dirname(f), { recursive: true });
  if (existsSync(f)) appendFileSync(f, line + '\n');
  else writeFileSync(f, line + '\n');
}
function commit(who, msg, files, cwd = dir) {
  if (clock > now - 5400) tick(9, 22);
  else tick();
  for (const f of files) edit(f, `// ${msg}`, cwd);
  git(cwd, ['add', '-A'], who);
  git(cwd, ['commit', '-q', '-m', msg], who);
}
function merge(who, branch, into, msg) {
  tick(15, 120);
  g(['checkout', '-q', into], who);
  g(['merge', '-q', '--no-ff', '-m', msg ?? `Merge branch '${branch}' into ${into}`, branch], who);
}
const [ada, marco, priya, jonas, lin] = people;

g(['init', '-q', '-b', 'main']);
g(['config', 'user.name', ada[0]]);
g(['config', 'user.email', ada[1]]);
commit(ada, 'Initial commit: Lumen Notes', ['README.md', 'package.json']);
commit(ada, 'Set up editor shell and routing', ['src/app.ts', 'src/router.ts']);
commit(marco, 'Add note model and local storage', ['src/notes/model.ts', 'src/notes/store.ts']);
commit(ada, 'Add CI workflow', ['.github/workflows/ci.yml']);
g(['tag', '-a', 'v0.1.0', '-m', 'First preview']);

// Feature: markdown preview
g(['checkout', '-q', '-b', 'feature/markdown-preview']);
commit(priya, 'Render markdown in a side preview', ['src/preview/render.ts']);
commit(priya, 'Sync scroll between editor and preview', ['src/preview/scroll.ts']);
g(['checkout', '-q', 'main']);
commit(marco, 'Fix crash when a note title is empty', ['src/notes/model.ts']);
g(['checkout', '-q', 'feature/markdown-preview']);
commit(priya, 'Support task lists and tables', ['src/preview/render.ts', 'src/preview/tables.ts']);
merge(ada, 'feature/markdown-preview', 'main');

// Feature: tags and search, overlapping
g(['checkout', '-q', '-b', 'feature/tags', 'main']);
commit(jonas, 'Add tags to notes', ['src/notes/tags.ts', 'src/notes/model.ts']);
g(['checkout', '-q', '-b', 'feature/search', 'main']);
commit(lin, 'Full-text search index', ['src/search/index.ts']);
g(['checkout', '-q', 'feature/tags']);
commit(jonas, 'Tag picker in the sidebar', ['src/ui/tag-picker.ts']);
g(['checkout', '-q', 'feature/search']);
commit(lin, 'Rank results by recency and match quality', ['src/search/rank.ts']);
commit(lin, 'Highlight matches in results', ['src/search/highlight.ts', 'src/ui/results.ts']);
merge(ada, 'feature/tags', 'main');
g(['checkout', '-q', 'feature/search']);
tick();
g(['merge', '-q', '--no-ff', '-m', "Merge branch 'main' into feature/search", 'main'], lin);
commit(lin, 'Search inside tags with #tag syntax', ['src/search/index.ts', 'src/notes/tags.ts']);
merge(marco, 'feature/search', 'main');
g(['tag', '-a', 'v0.2.0', '-m', 'Tags and search']);

// Release line
g(['checkout', '-q', '-b', 'release/1.0', 'main']);
commit(ada, 'Bump version to 1.0.0', ['package.json']);
g(['checkout', '-q', 'main']);
g(['checkout', '-q', '-b', 'fix/export-encoding']);
commit(marco, 'Export notes as UTF-8 with BOM on Windows', ['src/export/file.ts']);
merge(ada, 'fix/export-encoding', 'release/1.0');
g(['tag', '-a', 'v1.0.0', '-m', 'Lumen Notes 1.0']);
merge(ada, 'release/1.0', 'main', "Merge branch 'release/1.0' back into main");

// Two features in parallel, one long-lived
g(['checkout', '-q', '-b', 'feature/offline-sync', 'main']);
commit(jonas, 'Queue edits while offline', ['src/sync/queue.ts']);
g(['checkout', '-q', '-b', 'feature/themes', 'main']);
commit(priya, 'Theme tokens and a dark theme', ['src/ui/theme.ts', 'src/ui/tokens.ts']);
g(['checkout', '-q', 'feature/offline-sync']);
commit(jonas, 'Replay queued edits on reconnect', ['src/sync/queue.ts', 'src/sync/replay.ts']);
g(['checkout', '-q', 'main']);
commit(lin, 'Speed up startup by lazy-loading the preview', ['src/app.ts', 'src/preview/render.ts']);
g(['checkout', '-q', 'feature/themes']);
commit(priya, 'High-contrast theme', ['src/ui/theme.ts']);
merge(ada, 'feature/themes', 'main');
for (let i = 0; i < 6; i++) {
  const who = people[(i + 1) % people.length];
  const [msg, file] = [
    ['Keyboard shortcut to pin a note', 'src/ui/shortcuts.ts'],
    ['Fix sidebar flicker when resizing', 'src/ui/sidebar.ts'],
    ['Translate settings screen to German', 'src/i18n/de.json'],
    ['Remember the last opened note', 'src/app.ts'],
    ['Docs: explain the sync design', 'docs/sync.md'],
    ['Upgrade the markdown parser', 'package.json'],
  ][i];
  commit(who, msg, [file]);
}
g(['checkout', '-q', 'feature/offline-sync']);
commit(jonas, 'Resolve edit conflicts with last-writer-wins', ['src/sync/merge.ts']);
tick();
g(['merge', '-q', '--no-ff', '-m', "Merge branch 'main' into feature/offline-sync", 'main'], jonas);
commit(jonas, 'Show sync status in the status bar', ['src/ui/status.ts', 'src/sync/queue.ts']);
g(['checkout', '-q', 'release/1.0']);
g(['checkout', '-q', '-b', 'fix/search-crash']);
commit(lin, 'Fix search crash on emoji in titles', ['src/search/index.ts']);
merge(marco, 'fix/search-crash', 'release/1.0');
g(['tag', '-a', 'v1.0.1', '-m', 'Patch release']);
merge(marco, 'release/1.0', 'main', "Merge branch 'release/1.0' back into main");
g(['checkout', '-q', '-b', 'feature/attachments', 'main']);
commit(priya, 'Drag images into a note', ['src/attachments/drop.ts']);
commit(priya, 'Store attachments next to the note', ['src/attachments/store.ts']);

// Remote: push, then someone else moves main and feature/attachments on.
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
g(['remote', 'add', 'origin', origin]);
g(['push', '-q', 'origin', 'main', 'release/1.0', 'feature/offline-sync', 'feature/attachments', '--tags']);
g(['branch', '-q', '--set-upstream-to=origin/main', 'main']);
g(['branch', '-q', '--set-upstream-to=origin/release/1.0', 'release/1.0']);
g(['branch', '-q', '--set-upstream-to=origin/feature/offline-sync', 'feature/offline-sync']);
execFileSync('git', ['clone', '-q', origin, peer]);
git(peer, ['checkout', '-q', 'main'], marco);
commit(marco, 'Fix note list sorting for identical timestamps', ['src/notes/store.ts'], peer);
commit(ada, 'Update screenshots in README', ['README.md'], peer);
git(peer, ['checkout', '-q', '-b', 'feature/sharing'], lin);
commit(lin, 'Share a note as a read-only link', ['src/share/link.ts'], peer);
git(peer, ['push', '-q', 'origin', 'main', 'feature/sharing'], marco);
g(['fetch', '-q', 'origin']);

// Current work: two local commits on offline-sync not pushed yet, from the last hour.
g(['checkout', '-q', 'feature/offline-sync']);
clock = now - 50 * 60;
commit(jonas, 'Retry failed uploads with backoff', ['src/sync/replay.ts']);
commit(jonas, 'Tests for the offline queue', ['test/sync/queue.test.ts']);

if (withConflict) {
  // Both sides changed the same lines: merging main stops with a conflict.
  writeFileSync(path.join(dir, 'src/app.ts'), 'export const startup = "offline-first";\n');
  commit(jonas, 'Start in offline mode by default', []);
  g(['checkout', '-q', 'main']);
  writeFileSync(path.join(dir, 'src/app.ts'), 'export const startup = "lazy-preview";\n');
  commit(lin, 'Make lazy preview the default startup', []);
  g(['checkout', '-q', 'feature/offline-sync']);
  try {
    g(['merge', '-q', 'main'], jonas);
  } catch {
    /* expected: conflict */
  }
}

rmSync(peer, { recursive: true, force: true });
console.log(dir);
