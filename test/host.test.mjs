// Drives the real extension host code against a throwaway clone, with a mocked VS Code API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Module, { createRequire } from 'module';

const require = createRequire(import.meta.url);
import { testRepo } from './fixture.mjs';
const SOURCE = testRepo();
const tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-')));
const repo = path.join(tmp, 'repo');
execFileSync('git', ['clone', '-q', SOURCE, repo]);
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
g('config', 'user.name', 'Tester');
g('config', 'user.email', 't@example.com');

process.env.NODE_PATH = path.resolve('test/stubs');
Module._initPaths();
const vscode = require('vscode');
globalThis.__folders = [{ uri: vscode.Uri.file(repo) }];
vscode.workspace.workspaceFolders = globalThis.__folders;
const { activate } = require('../dist/extension.js');

const store = new Map();
const ctx = {
  subscriptions: [],
  extensionUri: vscode.Uri.file(path.resolve('.')),
  workspaceState: { get: (k) => store.get(k), update: (k, v) => (store.set(k, v), Promise.resolve()) },
};
activate(ctx);
const provider = globalThis.__providers['gitmetro.log'];
const content = globalThis.__providers['gitmetro'];
let msgs = [];
const webview = { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: (m) => msgs.push(m), onDidReceiveMessage: () => ({ dispose() {} }) };
provider.resolveWebviewView({ webview, visible: true, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) });

const send = async (m) => {
  msgs = [];
  await provider.onMessage(m);
  return msgs;
};
const last = (type) => [...msgs].reverse().find((m) => m.type === type);
const answer = (...xs) => globalThis.__answers.push(...xs);
const vlog = globalThis.__vscodeLog;
const eq = (a, b) => assert.deepEqual(a, b);
const ok = (v, what) => assert.ok(v, what);

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('webview html carries a CSP and the bundle', () => {
  assert.match(webview.html, /Content-Security-Policy/);
  assert.match(webview.html, /webview\.js/);
});

test('ready loads repo, refs and the log', async () => {
  await send({ type: 'ready' });
  assert.equal(last('repos').current, repo);
  const st = last('state').state;
  assert.ok(st.refs.length > 0);
  assert.equal(st.head, g('rev-parse', 'HEAD'));
  if (st.refs.some((r) => /^(master|main)$/.test(r.name))) assert.ok(st.favorites.some((f) => /master|main/.test(f)), 'main/master starts as a favourite');
  const log = last('log');
  assert.equal(log.rows.length, +g('rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD'));
});

test('selecting a merge shows changes against each parent, and diffs open', async () => {
  const merge = g('rev-list', '--merges', '-n1', 'HEAD');
  await send({ type: 'select', hashes: [merge] });
  const p = last('changes').payload;
  assert.equal(p.groups.length, 2);
  assert.deepEqual(p.groups.map((x) => x.base), g('show', '-s', '--format=%P', merge).split(' '));
  const grp = p.groups.find((x) => x.files.some((f) => f.status === 'M'));
  const file = grp.files.find((f) => f.status === 'M');
  vlog.length = 0;
  await send({ type: 'openDiff', base: grp.base, target: p.target, file });
  const cmd = vlog.find((l) => l[0] === 'command' && l[1] === 'vscode.diff');
  assert.ok(cmd, 'vscode.diff called');
  const left = vscode.Uri.from({ scheme: 'gitmetro', path: '/' + file.path, query: JSON.stringify({ root: repo, ref: grp.base }) });
  assert.equal(await content.provideTextDocumentContent(left), g('show', `${grp.base}:${file.path}`) + '\n');
});

test('several selected commits give one combined diff', async () => {
  const hs = g('rev-list', '--first-parent', '-n3', 'HEAD').split('\n');
  await send({ type: 'select', hashes: hs });
  const p = last('changes').payload;
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].base, g('rev-parse', `${hs[2]}^`));
});

test('text, user and path filters', async () => {
  const word = g('log', '-1', '--format=%s', '--no-merges').split(/\s+/).find((w) => w.length > 4);
  await send({ type: 'setFilter', filter: { text: word } });
  let rows = last('log').rows;
  assert.ok(rows.length > 0 && rows.every((r) => r.subject.toLowerCase().includes(word.toLowerCase())), 'every row matches the search');
  const hash = g('rev-parse', 'HEAD~2');
  await send({ type: 'setFilter', filter: { text: hash.slice(0, 8) } });
  assert.ok(last('log').rows.some((r) => r.hash === hash), 'hash search finds the commit');
  await send({ type: 'setFilter', filter: { authors: ['Nobody Atall'] } });
  assert.equal(last('log').rows.length, 0);
  const file = g('log', '-1', '--name-only', '--format=', '--no-merges').split('\n')[0];
  await send({ type: 'setFilter', filter: { paths: [file] } });
  rows = last('log').rows;
  assert.equal(rows.length, +g('rev-list', '--count', '--full-history', '--simplify-merges', '--branches', '--remotes', '--tags', 'HEAD', '--', file));
  await send({ type: 'setFilter', filter: {} });
});

test('new branch from a commit, checkout back, delete', async () => {
  const base = g('symbolic-ref', '--short', 'HEAD');
  const at = g('rev-parse', 'HEAD~3');
  answer('gitmetro-test');
  await send({ type: 'commitAction', action: 'newBranch', hashes: [at] });
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'gitmetro-test');
  assert.equal(g('rev-parse', 'HEAD'), at);
  await send({ type: 'refAction', action: 'checkout', ref: `refs/heads/${base}` });
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), base);
  answer('Delete');
  await send({ type: 'refAction', action: 'delete', ref: 'refs/heads/gitmetro-test' });
  assert.equal(g('branch', '--list', 'gitmetro-test'), '');
});

test('remote branch checkout creates a tracking branch', async () => {
  const remote = g('for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n').find((r) => !r.endsWith('/HEAD') && !/\/(master|main)$/.test(r));
  if (!remote) return;
  await send({ type: 'refAction', action: 'checkout', ref: remote });
  const name = remote.replace('refs/remotes/origin/', '');
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), name);
  assert.equal(g('rev-parse', '--abbrev-ref', '@{u}'), `origin/${name}`);
  await send({ type: 'refAction', action: 'checkout', ref: 'refs/heads/' + g('rev-parse', '--abbrev-ref', 'origin/HEAD').replace('origin/', '') });
});

test('smart checkout keeps local changes', async () => {
  const head = g('rev-parse', 'HEAD');
  const file = g('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n')[0];
  g('branch', 'gitmetro-old', 'HEAD~1');
  appendFileSync(path.join(repo, file), '\n// local edit\n');
  answer('Smart Checkout');
  await send({ type: 'refAction', action: 'checkout', ref: 'refs/heads/gitmetro-old' });
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'gitmetro-old');
  assert.match(readFileSync(path.join(repo, file), 'utf8'), /local edit/);
  // If the edit clashes with the target, the pop leaves conflicts for the banner instead of failing.
  await send({ type: 'refresh' });
  const op = last('state').state.operation;
  if (op) assert.equal(op.kind, 'conflicts');
  g('reset', '-q', '--hard');
  g('stash', 'clear');
  g('checkout', '-q', '-f', head);
  g('checkout', '-q', '-');
});

test('compare with local lists working tree changes', async () => {
  const file = g('ls-files').split('\n')[0];
  appendFileSync(path.join(repo, file), '\nchanged\n');
  await send({ type: 'commitAction', action: 'compareWithLocal', hashes: [g('rev-parse', 'HEAD')] });
  const p = last('changes').payload;
  assert.equal(p.target, 'WORKTREE');
  assert.ok(p.groups[0].files.some((f) => f.path === file));
  g('checkout', '--', file);
});

test('commit actions: copy, cherry-pick, revert, hard reset, tag', async () => {
  await send({ type: 'commitAction', action: 'copyHash', hashes: [g('rev-parse', 'HEAD')] });
  assert.equal(await vscode.env.clipboard.readText(), g('rev-parse', 'HEAD'));
  const start = g('rev-parse', 'HEAD');
  await send({ type: 'commitAction', action: 'revert', hashes: [start] });
  assert.equal(g('rev-parse', 'HEAD~1'), start);
  assert.match(g('log', '-1', '--format=%s'), /^Revert/);
  answer(2, 'Reset');
  await send({ type: 'commitAction', action: 'reset', hashes: [start] });
  assert.equal(g('rev-parse', 'HEAD'), start);
  answer('v-gitmetro');
  await send({ type: 'commitAction', action: 'newTag', hashes: [start] });
  assert.equal(g('rev-parse', 'v-gitmetro^{commit}'), start);
  answer('Delete');
  await send({ type: 'refAction', action: 'delete', ref: 'refs/tags/v-gitmetro' });
  assert.equal(g('tag', '-l', 'v-gitmetro'), '');
});

test('compare branch with current shows its changes and filters the log', async () => {
  const home = g('rev-parse', '--abbrev-ref', 'HEAD');
  g('checkout', '-q', '-b', 'e2e/compare');
  writeFileSync(path.join(repo, 'compare.txt'), 'only on the branch\n');
  g('add', 'compare.txt');
  g('commit', '-q', '-m', 'compare commit');
  g('checkout', '-q', home);
  await send({ type: 'refresh' });
  await send({ type: 'refAction', action: 'compare', ref: 'refs/heads/e2e/compare' });
  const ch = last('changes').payload;
  ok(ch.groups[0].label.includes('e2e/compare'), 'labelled with the branch');
  eq(ch.groups[0].files.map((f) => f.path), ['compare.txt']);
  assert.deepEqual(last('setFilter').filter.branches, ['HEAD..refs/heads/e2e/compare']);
  g('branch', '-q', '-D', 'e2e/compare');
});

test('file history command sets a path filter', async () => {
  const file = path.join(repo, g('ls-files').split('\n')[0]);
  await send({ type: 'ready' });
  globalThis.__panel = undefined;
  await provider.showFileHistory(vscode.Uri.file(file));
  // It opens (or reuses) the repository's log tab and filters it once the tab is ready.
  const panel = globalThis.__panel;
  assert.ok(panel, 'log tab opened');
  await provider.onMessage({ type: 'ready' }, panel.webview);
  assert.deepEqual(panel.webview.sent.find((m) => m.type === 'setFilter')?.filter.paths, [path.relative(repo, file)]);
  await provider.onMessage({ type: 'setFilter', filter: {} }, panel.webview);
  panel.dispose();
});

function conflictSetup() {
  const base = g('symbolic-ref', '--short', 'HEAD');
  writeFileSync(path.join(repo, 'conflict.txt'), 'line one\n');
  g('add', 'conflict.txt');
  g('commit', '-qm', 'add conflict.txt');
  for (const [b, text] of [['side-a', 'from a\n'], ['side-b', 'from b\n'], ['side-c', 'from c\n']]) {
    g('checkout', '-qb', b, base);
    writeFileSync(path.join(repo, 'conflict.txt'), text);
    g('commit', '-qam', `change on ${b}`);
  }
  g('checkout', '-q', 'side-a');
  return base;
}

test('merge conflict: detected, keep ours, continue', async () => {
  conflictSetup();
  await send({ type: 'refAction', action: 'merge', ref: 'refs/heads/side-b' });
  await send({ type: 'refresh' });
  const op = last('state').state.operation;
  assert.equal(op.kind, 'merge');
  assert.equal(op.ours, 'side-a');
  assert.match(op.theirs, /side-b/);
  assert.deepEqual(op.conflicts, [{ path: 'conflict.txt', code: 'UU' }]);
  await send({ type: 'operation', action: 'continue' });
  assert.ok(g('rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'continue refused while conflicts remain');
  await send({ type: 'conflict', action: 'ours', path: 'conflict.txt' });
  assert.equal(readFileSync(path.join(repo, 'conflict.txt'), 'utf8'), 'from a\n');
  await send({ type: 'operation', action: 'continue' });
  assert.equal(g('show', '-s', '--format=%P', 'HEAD').split(' ').length, 2, 'merge commit created');
  await send({ type: 'refresh' });
  assert.equal(last('state').state.operation, undefined);
});

test('rebase conflict: labels sides, keep theirs, continue', async () => {
  g('checkout', '-q', 'side-c');
  await send({ type: 'refAction', action: 'rebase', ref: 'refs/heads/side-b' });
  await send({ type: 'refresh' });
  const op = last('state').state.operation;
  assert.equal(op.kind, 'rebase');
  assert.match(op.ours, /side-b.*rebasing onto/);
  assert.match(op.theirs, /side-c/);
  await send({ type: 'conflict', action: 'theirs', path: 'conflict.txt' });
  assert.equal(readFileSync(path.join(repo, 'conflict.txt'), 'utf8'), 'from c\n', '"theirs" during a rebase is the commit being replayed');
  await send({ type: 'operation', action: 'continue' });
  assert.equal(g('rev-parse', 'HEAD~1'), g('rev-parse', 'side-b'));
  assert.equal(g('symbolic-ref', '--short', 'HEAD'), 'side-c');
});

test('merge conflict: mark resolved warns on markers, abort restores', async () => {
  g('checkout', '-qb', 'side-d', 'side-b~1');
  writeFileSync(path.join(repo, 'conflict.txt'), 'from d\n');
  g('commit', '-qam', 'change on side-d');
  const before = g('rev-parse', 'HEAD');
  await send({ type: 'refAction', action: 'merge', ref: 'refs/heads/side-b' });
  assert.equal((await provider.git.conflicts()).length, 1);
  answer(undefined); // decline "still contains conflict markers"
  await send({ type: 'conflict', action: 'resolved', path: 'conflict.txt' });
  assert.equal((await provider.git.conflicts()).length, 1, 'not staged while markers remain');
  answer('Abort');
  await send({ type: 'operation', action: 'abort' });
  assert.equal(g('rev-parse', 'HEAD'), before);
  assert.throws(() => g('rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'no merge in progress');
});

test('crafted revision URIs and webview messages are refused', async () => {
  const evil = vscode.Uri.from({ scheme: 'gitmetro', path: '/x', query: JSON.stringify({ root: repo, ref: '--output=/tmp/gitmetro-pwned' }) });
  assert.equal(await content.provideTextDocumentContent(evil), '');
  const outside = vscode.Uri.from({ scheme: 'gitmetro', path: '/etc/passwd', query: JSON.stringify({ root: '/', ref: 'HEAD' }) });
  assert.equal(await content.provideTextDocumentContent(outside), '');
  await assert.rejects(provider.onMessage({ type: 'select', hashes: ['--output=/tmp/x'] }));
  await assert.rejects(provider.onMessage({ type: 'setFilter', filter: { branches: ['--exec=touch /tmp/x'] } }));
});

test('the log also opens as an editor tab; views of the same repository share its log', async () => {
  await send({ type: 'setFilter', filter: { authors: ['Nobody Atall'] } });
  await globalThis.__commands['gitmetro.openEditor']();
  const panel = globalThis.__panel;
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await provider.onMessage({ type: 'ready' }, panel.webview);
  assert.deepEqual(panel.webview.sent.find((m) => m.type === 'setFilter')?.filter, { authors: ['Nobody Atall'] }, 'a view that opens later joins the current filter');
  assert.ok(panel.webview.sent.some((m) => m.type === 'log'), 'editor tab receives the log');
  msgs = [];
  await provider.onMessage({ type: 'setFilter', filter: {} }, panel.webview);
  assert.ok(msgs.some((m) => m.type === 'log'), 'panel view gets the log too');
  panel.dispose();
});

test('several repositories: one session each, a log tab per repository', async () => {
  const second = path.join(tmp, 'second');
  execFileSync('git', ['init', '-q', '-b', 'main', second]);
  const g2 = (...a) => execFileSync('git', a, { cwd: second, encoding: 'utf8' }).trim();
  g2('config', 'user.name', 'T'); g2('config', 'user.email', 't@e.x');
  g2('commit', '-q', '--allow-empty', '-m', 'only commit in second');
  const saved = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [...saved, { uri: vscode.Uri.file(second) }];
  await send({ type: 'ready' });
  const list = last('repos');
  assert.deepEqual(list.repos.map((r) => r.root).sort(), [repo, second].sort(), 'both repositories listed');
  const entry = list.repos.find((r) => r.root === second);
  eq([entry.name, entry.branch], ['second', 'main']);
  // Each repository's log tab shows only its own commits.
  await globalThis.__commands['gitmetro.openEditor'](second);
  const tab2 = globalThis.__panel;
  await provider.onMessage({ type: 'ready' }, tab2.webview);
  assert.match(tab2.title, /second/);
  eq(tab2.webview.sent.filter((m) => m.type === 'log').pop().rows.map((r) => r.subject), ['only commit in second']);
  await globalThis.__commands['gitmetro.openEditor'](repo);
  const tab1 = globalThis.__panel;
  assert.notEqual(tab1, tab2, 'a second tab, not the same one');
  await provider.onMessage({ type: 'ready' }, tab1.webview);
  ok(tab1.webview.sent.filter((m) => m.type === 'log').pop().rows.length > 1, 'first repository log');
  // The side views switch repository; the log tabs stay put.
  tab2.webview.sent = [];
  await send({ type: 'setRepo', root: second });
  eq(last('repos').current, second);
  ok(!tab2.webview.sent.some((m) => m.type === 'repos' && m.current !== second), 'tab 2 unchanged');
  // An action in one repository leaves the other alone.
  const before = g('rev-parse', 'HEAD');
  await provider.onMessage({ type: 'commitAction', action: 'newTag', hashes: [g2('rev-parse', 'HEAD')] }, tab2.webview).catch(() => {});
  eq(g('rev-parse', 'HEAD'), before);
  await send({ type: 'setRepo', root: repo });
  vscode.workspace.workspaceFolders = saved;
  tab1.dispose();
  tab2.dispose();
});

test('diffs work when the workspace is opened through a symlink', async () => {
  const link = path.join(tmp, 'link');
  try {
    (await import('fs')).symlinkSync(repo, link, 'junction');
  } catch {
    return; // no symlink permission (Windows without developer mode)
  }
  const saved = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(link) }];
  const file = g('ls-files').split('\n')[0];
  const uri = vscode.Uri.from({ scheme: 'gitmetro', path: '/' + file, query: JSON.stringify({ root: repo, ref: 'HEAD' }) });
  assert.equal(await content.provideTextDocumentContent(uri), g('show', `HEAD:${file}`) + '\n');
  vscode.workspace.workspaceFolders = saved;
});

test('activity bar: showing the sidebar opens the log tab; clicking a branch reveals it there', async () => {
  globalThis.__panel = undefined;
  const side = { options: {}, html: '', cspSource: '', asWebviewUri: (u) => u, sent: [], postMessage(m) { this.sent.push(m); }, onDidReceiveMessage: () => ({ dispose() {} }) };
  provider.resolveWebviewView({ viewType: 'gitmetro.branches', webview: side, visible: true, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) });
  assert.match(side.html, /data-mode="sidebar"/);
  await new Promise((r) => setTimeout(r, 50));
  const panel = globalThis.__panel;
  assert.ok(panel, 'log tab opened with the sidebar');
  await provider.onMessage({ type: 'ready' }, side);
  const tip = g('rev-parse', 'HEAD~1');
  await provider.onMessage({ type: 'openLog', reveal: tip }, side);
  await provider.onMessage({ type: 'ready' }, panel.webview); // the new tab's webview finishing its load
  assert.deepEqual(panel.webview.sent.filter((m) => m.type === 'reveal').map((m) => m.hash), [tip]);
  panel.webview.sent = [];
  await provider.onMessage({ type: 'openLog', reveal: tip }, side); // tab already open: reveal right away
  assert.deepEqual(panel.webview.sent.filter((m) => m.type === 'reveal').map((m) => m.hash), [tip]);
  panel.dispose();
});

test('a diff opened from the log tab goes beside it; from the panel it replaces the active editor', async () => {
  await globalThis.__commands['gitmetro.openEditor']();
  const panel = globalThis.__panel;
  await provider.onMessage({ type: 'ready' }, panel.webview);
  const h = g('rev-parse', 'HEAD');
  const file = { status: 'M', path: g('show', '--format=', '--name-only', 'HEAD').split('\n')[0] || 'README.md' };
  const diffColumn = () => JSON.parse(vlog.filter((l) => l[0] === 'command' && l[1] === 'vscode.diff').pop().at(-1)).viewColumn;
  await provider.onMessage({ type: 'openDiff', base: `${h}~1`.replace('~1', ''), target: h, file }, panel.webview);
  eq(diffColumn(), vscode.ViewColumn.Beside);
  await provider.onMessage({ type: 'openDiff', base: h, target: h, file }, webview);
  eq(diffColumn(), vscode.ViewColumn.Active);
  panel.dispose();
});

test('authors with regex characters and non-ASCII searches are found', async () => {
  for (const [who, msg] of [['Bob (CI)', 'ci: release'], ['Ann+Lee', 'docs: notes'], ['Lê Văn', 'Đã sửa lỗi đăng nhập']]) {
    g('-c', `user.name=${who}`, 'commit', '-q', '--allow-empty', '-m', msg);
  }
  for (const who of ['Bob (CI)', 'Ann+Lee']) {
    await send({ type: 'setFilter', filter: { authors: [who] } });
    eq(last('log').rows.map((r) => r.author), [who]);
  }
  // Case-insensitive search must fold non-ASCII letters (git runs with the user's charset).
  await send({ type: 'setFilter', filter: { text: 'đã sửa' } });
  eq(last('log').rows.map((r) => r.subject), ['Đã sửa lỗi đăng nhập']);
  await send({ type: 'setFilter', filter: {} });
});

test('a "load more" racing a reload never duplicates rows', async () => {
  for (let i = 0; i < 230; i++) g('commit', '-q', '--allow-empty', '-m', `bulk ${i}`);
  globalThis.__config = { pageSize: 100 };
  // Replay what the webview does with each log message.
  let rows = [];
  const apply = () => {
    for (const m of msgs) if (m.type === 'log') rows = m.append ? rows.concat(m.rows) : m.rows;
  };
  msgs = [];
  await provider.onMessage({ type: 'refresh' });
  apply();
  msgs = [];
  // setFilter resets the log at once (unlike refresh, which reads refs first), then "load more"
  // arrives while that first page is still being read: the window the bug lived in.
  await Promise.all([provider.onMessage({ type: 'setFilter', filter: {} }), provider.onMessage({ type: 'loadMore' })]);
  apply();
  ok(rows.length >= 100, `rows: ${rows.length}`);
  const hashes = rows.map((r) => r.hash);
  eq(new Set(hashes).size, hashes.length);
  delete globalThis.__config;
  await send({ type: 'refresh' });
});

test('history of selected lines matches git log -L', async () => {
  const file = 'src/sync/queue.ts';
  const expected = g('log', '-L1,2:' + file, '--no-patch', '--format=%H', 'HEAD').split('\n').filter(Boolean);
  await send({ type: 'setFilter', filter: { lines: { path: file, start: 1, end: 2 } } });
  eq(last('log').rows.map((r) => r.hash), expected);
  ok(expected.length > 0, 'the range has history');
  await send({ type: 'setFilter', filter: {} });
});

test('line history maps editor lines over edits not committed yet', async () => {
  const { Git } = require('../dist/core/git.js');
  const file = 'src/sync/queue.ts';
  const head = g('show', `HEAD:${file}`) + '\n';
  const git = new Git(repo);
  // Three new lines on top: editor line 5 is HEAD line 2.
  eq(await git.linesInHead(file, 'a\nb\nc\n' + head, 4, 5), { start: 1, end: 2 });
  eq(await git.linesInHead(file, 'a\nb\nc\n' + head, 1, 3), 'uncommitted');
  eq(await git.linesInHead(file, head, 1, 2), { start: 1, end: 2 });
  eq(await git.linesInHead(file, head.replace(/\n/g, '\r\n'), 2, 2), { start: 2, end: 2 });
  eq(await git.linesInHead('not-there.ts', 'x\n', 1, 1), 'untracked');
});

test('file history follows a rename', async () => {
  g('mv', 'src/sync/replay.ts', 'src/sync/replayer.ts');
  g('commit', '-qm', 'Rename replay to replayer');
  // Every commit that touched the old path, the rename itself included (it deletes that path).
  const before = +g('rev-list', '--count', 'HEAD', '--', 'src/sync/replay.ts');
  await send({ type: 'setFilter', filter: { paths: ['src/sync/replayer.ts'], follow: true } });
  const rows = last('log').rows;
  eq(rows[0].subject, 'Rename replay to replayer');
  eq(rows.length, before);
  ok(rows.some((r) => r.subject === 'Replay queued edits on reconnect'), 'commits from before the rename are there');
  await send({ type: 'setFilter', filter: {} });
});

test('worktrees: create from a commit, listed in the state, removed', async () => {
  const target = path.join(tmp, 'wt-docs');
  const at = g('log', '-1', '--format=%H', ':/Docs: explain the sync design');
  answer(target, 'e2e/wt-docs', undefined); // folder, branch name, then dismiss "open it?"
  await send({ type: 'commitAction', action: 'newWorktree', hashes: [at] });
  const wts = last('state').state.worktrees;
  const w = wts.find((x) => x.path === target);
  ok(w, `worktree listed: ${JSON.stringify(wts)}`);
  eq([w.branch, w.head], ['e2e/wt-docs', at]);
  answer('Remove');
  await send({ type: 'worktree', action: 'remove', path: target });
  ok(!last('state').state.worktrees.some((x) => x.path === target), 'removed');
  // Paths git didn't list are ignored.
  await send({ type: 'worktree', action: 'remove', path: '/' });
  g('branch', '-D', 'e2e/wt-docs');
});

test('blame attributes each line, and marks edits not committed yet', async () => {
  const { Git } = require('../dist/core/git.js');
  const file = 'src/sync/queue.ts';
  const text = readFileSync(path.join(repo, file), 'utf8');
  const git = new Git(repo);
  const lines = await git.blame(file, text);
  eq(lines.length, text.split('\n').filter((x, i, a) => i < a.length - 1 || x).length);
  const firstCommit = g('log', '--format=%H', '--diff-filter=A', '--', file).split('\n').pop();
  eq(lines[0].commit.hash, firstCommit);
  const edited = await git.blame(file, 'brand new first line\n' + text);
  ok(/^0{40}$/.test(edited[0].commit.hash), 'edit not committed');
  eq(edited[1].commit.hash, firstCommit);
});

test('cherry-pick one file of a commit, and cherry-pick with -x', async () => {
  // A commit on a side branch that changes two files; take only one of them.
  const before = g('rev-parse', 'HEAD');
  const home = g('symbolic-ref', '--short', 'HEAD');
  g('checkout', '-q', '-b', 'e2e/two-files');
  appendFileSync(path.join(repo, 'README.md'), 'readme change\n');
  appendFileSync(path.join(repo, 'src/app.ts'), '// app change\n');
  g('commit', '-qam', 'Touch README and app');
  const pick = g('rev-parse', 'HEAD');
  g('checkout', '-q', home);
  await send({ type: 'fileAction', action: 'applyChange', target: pick, base: g('rev-parse', `${pick}~1`), file: { status: 'M', path: 'src/app.ts' } });
  eq(g('rev-parse', 'HEAD'), before); // applied to the working tree, not committed
  const changed = g('status', '--porcelain').split('\n').map((l) => l.slice(3));
  eq(changed, ['src/app.ts']);
  ok(readFileSync(path.join(repo, 'src/app.ts'), 'utf8').endsWith('// app change\n'), 'change applied');
  g('reset', '-q', '--hard');
  await send({ type: 'commitAction', action: 'cherryPickX', hashes: [pick] });
  ok(g('log', '-1', '--format=%B').includes(`(cherry picked from commit ${pick})`), 'source noted');
  g('reset', '-q', '--hard', before);
  g('branch', '-q', '-D', 'e2e/two-files');
});

test('cherry-picking a copied file leaves its source alone', async () => {
  const home = g('rev-parse', '--abbrev-ref', 'HEAD');
  const before = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'e2e/copy');
  writeFileSync(path.join(repo, 'orig.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
  g('add', 'orig.txt');
  g('commit', '-qm', 'orig');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'copy.txt'), readFileSync(path.join(repo, 'orig.txt')));
  writeFileSync(path.join(repo, 'orig.txt'), readFileSync(path.join(repo, 'orig.txt'), 'utf8').replace('line 0', 'line 0 CHANGED'));
  g('add', '-A');
  g('commit', '-qm', 'copy and edit');
  const pick = g('rev-parse', 'HEAD');
  g('checkout', '-q', home);
  g('checkout', '-q', base, '--', 'orig.txt');
  g('reset', '-q');
  await send({ type: 'fileAction', action: 'applyChange', target: pick, base, file: { status: 'C', path: 'copy.txt', oldPath: 'orig.txt' } });
  ok(existsSync(path.join(repo, 'copy.txt')), 'copy applied');
  ok(!readFileSync(path.join(repo, 'orig.txt'), 'utf8').includes('CHANGED'), 'source untouched');
  g('reset', '-q', '--hard', before);
  rmSync(path.join(repo, 'orig.txt'), { force: true });
  g('clean', '-qfd');
  g('branch', '-q', '-D', 'e2e/copy');
});

test('errors read like sentences: fatal line first, hints dropped', async () => {
  const { readableGitError } = require('../dist/core/git.js');
  eq(readableGitError('hint: a\nhint: b\nfatal: Not possible to fast-forward, aborting.'), 'Not possible to fast-forward, aborting.');
  eq(readableGitError('To origin\n ! [rejected] main -> main (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected'), 'The remote has commits you do not have yet. Pull (or fetch and merge) first, then push again.');
  eq(readableGitError("fatal: 'main' is already used by worktree at '/w/main'"), 'main is checked out in another worktree (/w/main). Open that worktree, or pick another branch.');
});

test('a second action while one runs is refused, not run twice', async () => {
  const count = () => vlog.filter((l) => l[0] === 'progress' && l[1] === 'Fetch').length;
  const before = count();
  const first = provider.onMessage({ type: 'fetch' });
  const second = provider.onMessage({ type: 'fetch' });
  await Promise.all([first, second]);
  eq(count() - before, 1);
});

test('a restored log tab comes back on its repository', async () => {
  const second = path.join(tmp, 'restored');
  execFileSync('git', ['init', '-q', '-b', 'main', second]);
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--allow-empty', '-m', 'restored commit'], { cwd: second });
  const saved = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [...saved, { uri: vscode.Uri.file(second) }];
  const ser = globalThis.__providers['serializer:gitmetro.editor'];
  ok(ser, 'serializer registered');
  const listeners = [];
  const panel = { title: 'GitMetro', visible: true, reveal() {}, onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: (f) => (listeners.push(f), { dispose() {} }), dispose: () => listeners.forEach((f) => f()), webview: { options: {}, html: '', cspSource: '', asWebviewUri: (u) => u, sent: [], postMessage(m) { this.sent.push(m); }, onDidReceiveMessage: () => ({ dispose() {} }) } };
  await ser.deserializeWebviewPanel(panel, { root: second });
  await provider.onMessage({ type: 'ready' }, panel.webview);
  eq(panel.webview.sent.filter((m) => m.type === 'repos').pop()?.current, second);
  eq(panel.webview.sent.filter((m) => m.type === 'log').pop()?.rows.map((r) => r.subject), ['restored commit']);
  panel.dispose();
  // A tab saved on a folder that is not in the workspace does not run git there.
  vscode.workspace.workspaceFolders = saved;
  await provider.reload();
  const outside = { ...panel, webview: { ...panel.webview, sent: [], postMessage(m) { this.sent.push(m); } } };
  await ser.deserializeWebviewPanel(outside, { root: second });
  await provider.onMessage({ type: 'ready' }, outside.webview);
  ok(!outside.webview.sent.some((m) => m.type === 'log' && m.rows.some((r) => r.subject === 'restored commit')), 'outside repository not shown');
  outside.dispose();
});

test('a deleted repository folder is not reported as git missing', async () => {
  const { Git } = require('../dist/core/git.js');
  const gone = path.join(tmp, 'deleted-repo');
  await assert.rejects(new Git(gone).run(['status']), /no longer exists: not a git repository/);
});

test('no errors were shown', () => {
  assert.deepEqual(vlog.filter((l) => l[0] === 'error'), []);
});
