// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// generated demo repository, and drives GitMetro the way a user would. Every step is
// checked against git itself. Linux/macOS with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [gitmetro-x.y.z.vsix]
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `gitmetro-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-e2e-')));
// Keep the user's global git config (signing, hooks) away from the demo and from the extension under test.
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Ada Park\n\temail = ada@lumen.example\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const out = process.env.GITMETRO_E2E_OUT || path.join(root, 'shots');
const repo = path.join(root, 'demo');
execFileSync(process.execPath, ['scripts/demo-repo.mjs', repo], { stdio: 'ignore' });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'git.openRepositoryInParentFolders': 'never',
  'git.autoRepositoryDetection': false,
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
};
const vs = new VSCode(root);
vs.install(vsix, settings);

// Runs inside the GitMetro webview.
const H = `(() => {
  const rows = () => [...document.querySelectorAll('#viewport .row')];
  const subj = (r) => r.querySelector('.subject')?.textContent ?? '';
  // Not requestAnimationFrame: a webview that's behind another tab never paints.
  const frame = () => new Promise((r) => setTimeout(r, 60));
  const fire = (el, type, o = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'contextmenu' ? 2 : 0, clientX: 300, clientY: 200, ...o }));
  async function findRow(text) {
    const list = document.getElementById('list');
    list.scrollTop = 0;
    await frame();
    for (let i = 0; i < 400; i++) {
      const r = rows().find((r) => subj(r).includes(text));
      if (r) return r;
      const before = list.scrollTop;
      list.scrollTop += Math.max(100, list.clientHeight * 0.7);
      await frame();
      if (list.scrollTop === before) break;
    }
    throw new Error('row not found: ' + text);
  }
  async function menu(label) {
    await frame();
    const items = [...document.querySelectorAll('.menu .item')];
    const it = items.find((i) => i.textContent.trim().startsWith(label));
    if (!it) throw new Error('menu item "' + label + '" not in: ' + items.map((i) => i.textContent.trim()).join(' | '));
    if (it.classList.contains('disabled')) throw new Error('menu item disabled: ' + label);
    it.click();
    await frame();
  }
  const ref = (name) => [...document.querySelectorAll('#refTree .node.ref')].find((n) => n.getAttribute('title') === name) || (() => { throw new Error('ref not in sidebar: ' + name); })();
  return {
    total: () => Math.round(parseFloat(document.getElementById('spacer').style.height || '0') / 26),
    subjects: () => rows().map(subj),
    authors: () => rows().map((r) => r.querySelector('.author span:last-child')?.textContent.trim()),
    selected: () => rows().filter((r) => r.classList.contains('sel')).map(subj),
    async select(text, o) { fire(await findRow(text), 'mousedown', o); await frame(); return true; },
    // Right-click alone, as a user does: the log selects the row itself. (Selecting first would
    // re-render the rows and leave us holding a detached element.)
    async rowMenu(text, label) { fire(await findRow(text), 'contextmenu'); await menu(label); return true; },
    card: () => document.querySelector('.card-title')?.textContent ?? '',
    filesTitle: () => document.querySelector('#filesbar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    files: () => [...document.querySelectorAll('#files .node.file')].map((n) => n.getAttribute('title')),
    segments: () => [...document.querySelectorAll('.segmented button')].map((b) => b.textContent.trim()),
    async segment(i) { document.querySelectorAll('.segmented button')[i].click(); await frame(); return true; },
    async openFile(p) { const n = [...document.querySelectorAll('#files .node.file')].find((n) => n.getAttribute('title') === p); if (!n) throw new Error('file not listed: ' + p); n.click(); await frame(); return true; },
    async search(text) { const i = document.getElementById('textFilter'); i.value = text; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await frame(); return true; },
    async chip(which, label) { document.querySelector('[data-f="' + which + '"]').click(); await frame(); const it = [...document.querySelectorAll('.popup .item')].find((i) => i.textContent.includes(label)); if (!it) throw new Error('picker item ' + label); it.click(); await frame(); return true; },
    async clearChip(which) { const x = document.querySelector('[data-clear="' + which + '"]'); if (x) x.click(); await frame(); return true; },
    chipText: (which) => document.querySelector('[data-f="' + which + '"]')?.textContent.trim(),
    jumps: () => [...document.querySelectorAll('.row .jump')].map((j) => j.getAttribute('data-jump')),
    async jump(i) { fire(document.querySelectorAll('.row .jump')[i], 'mousedown'); await frame(); return true; },
    async refClick(name, type = 'click') { fire(ref(name), type); await frame(); return true; },
    async refMenu(name, label) { fire(ref(name), 'contextmenu'); await menu(label); return true; },
    refs: () => [...document.querySelectorAll('#refTree .node.ref')].map((n) => n.getAttribute('title')),
    async openSection(id) { const s = document.querySelector('.section[data-id="' + id + '"]'); if (s && s.querySelector('.tw .ic path')?.getAttribute('d')?.startsWith('m6 4')) s.click(); await frame(); return true; },
    async cardAction(act) { document.querySelector('[data-act="' + act + '"]').click(); await frame(); return true; },
    banner: () => { const b = document.getElementById('opbar'); return b.hidden ? null : { text: b.querySelector('.op-text')?.textContent.replace(/\\s+/g, ' ').trim(), files: [...b.querySelectorAll('.cf')].map((c) => c.dataset.path), canContinue: !b.querySelector('[data-op="continue"]')?.disabled }; },
    async conflict(file, action) { document.querySelector('.cf[data-path="' + file + '"] [data-cf="' + action + '"]').click(); await frame(); return true; },
    async op(action) { document.querySelector('[data-op="' + action + '"]').click(); await frame(); return true; },
    palette: () => document.body.dataset.palette,
    lineColors: () => [...new Set([...document.querySelectorAll('.row .ln')].map((p) => p.getAttribute('stroke')))],
    async copyHash() { document.querySelector('[data-copy]').click(); await frame(); return document.querySelector('.toast')?.textContent; },
  };
})()`;
const ctxMode = new Map();
const gm = async (ctx, call) => {
  try {
    return await vs.eval(`${H}.${call}`, ctx);
  } catch (e) {
    if (!/Session with given id not found|Cannot find context/.test(e.message)) throw e;
    // The webview was recreated (tab closed and reopened): find it again by its mode.
    const fresh = await vs.webview(ctxMode.get(ctx) ?? ['log', 'full']);
    Object.assign(ctx, fresh);
    return vs.eval(`${H}.${call}`, ctx);
  }
};

let logCtx;
async function resetLog() {
  // The log has to be on screen: a webview behind another tab doesn't repaint.
  if (!(await vs.eval(`!!document.querySelector('.tabs-container .tab.active')?.textContent.includes('GitMetro')`))) await vs.showTab('GitMetro');
  await vs.eval(`(() => { document.querySelectorAll('[data-clear]').forEach((x) => x.click()); const i = document.getElementById('textFilter'); if (i.value) { i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } })()`, logCtx);
  // Start every step from a log that matches git: what the previous step did must have
  // arrived, or checks would pass against rows that are about to be replaced.
  // (Count alone isn't enough: uncommit then commit again leaves it unchanged.)
  await waitFor(async () => {
    const newest = git('log', '-1', '--date-order', '--branches', '--remotes', '--tags', 'HEAD', '--format=%s');
    return (await gm(logCtx, 'total()')) === count('--branches', '--remotes', '--tags', 'HEAD') && (await gm(logCtx, 'subjects()'))[0] === newest;
  }, { timeout: 8000, what: 'log in sync with git' }).catch(() => {});
}
const results = [];
let step = 0;
async function check(name, fn) {
  step++;
  const t = Date.now();
  try {
    if (logCtx) await resetLog().catch(() => {});
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n')[0]}`);
    try {
      execFileSync('mkdir', ['-p', out]);
      await vs.screenshot(path.join(out, `fail-${String(step).padStart(2, '0')}.png`));
    } catch {
      /* ignore */
    }
    await vs.key('Escape').catch(() => {});
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const count = (...args) => +git('rev-list', '--count', ...args);
const subjectOf = (rev) => git('log', '-1', '--format=%s', rev);

try {
  await vs.launch(repo);
  console.log(`VS Code up (profile in ${root})`);
  for (const label of ['Continue without Signing In', 'Get Started']) {
    await vs.eval(`(() => { const b = [...document.querySelectorAll('a,button,.monaco-button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); })()`).catch(() => {});
    await sleep(700);
  }
  await vs.command('View: Close All Editors');

  let log, side;

  await check('status bar shows the GitMetro mark', async () => {
    const item = await waitFor(
      () => vs.eval(`(() => { const i = [...document.querySelectorAll('.statusbar-item')].find((e) => e.textContent.includes('GitMetro')); return i ? i.innerHTML : null; })()`),
      { what: 'status bar item' },
    );
    ok(item.includes('codicon-gitmetro-mark'), `status bar icon is not the GitMetro font glyph: ${item.slice(0, 200)}`);
  });

  await check('activity bar icon opens branches in the side bar and the log in an editor tab', async () => {
    await vs.eval(`document.querySelector('.activitybar .action-label[aria-label^="GitMetro"]').click()`);
    side = await vs.webview('sidebar');
    ctxMode.set(side, 'sidebar');
    log = logCtx = await vs.webview('log');
    ctxMode.set(log, ['log', 'full']);
    ok((await vs.editorTabs()).includes('GitMetro'), 'no GitMetro editor tab');
  });

  await check('log lists every commit, newest first', async () => {
    const all = count('--branches', '--remotes', '--tags', 'HEAD');
    await waitFor(async () => (await gm(log, 'total()')) === all, { what: `${all} rows` });
    eq((await gm(log, 'subjects()'))[0], 'Tests for the offline queue', 'first row');
  });

  await check('side bar lists branches, remotes and tags', async () => {
    await gm(side, `openSection('s:tags')`); // tags start collapsed
    const refs = await gm(side, 'refs()');
    for (const r of ['main', 'feature/offline-sync', 'origin/feature/sharing', 'v1.0.1']) ok(refs.includes(r), `missing ${r} in ${refs.join(', ')}`);
  });

  await check('selecting a commit shows its message and files', async () => {
    await gm(log, `select('Drag images into a note')`);
    await waitFor(async () => (await gm(log, 'card()')) === 'Drag images into a note', { what: 'card title' });
    const files = await waitFor(async () => (await gm(log, 'files()')).length && gm(log, 'files()'), { what: 'files' });
    eq(files, git('show', '--format=', '--name-only', ':/Drag images into a note').split('\n'), 'files');
  });

  await check('clicking a file opens a diff with the right contents', async () => {
    await gm(log, `openFile('src/attachments/drop.ts')`);
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('drop.ts')), { what: 'diff tab' });
    // Side-by-side or inline (a narrow group switches to inline): wait for the text itself,
    // the editor renders empty lines before the content arrives.
    await waitFor(async () => (await vs.eval(`[...document.querySelectorAll('.monaco-diff-editor .view-line')].map((v) => v.textContent).join(' ')`)).replace(/\u00a0/g, ' ').includes('// Drag images into a note'), { what: 'diff contents' });
    ok((await vs.eval(`document.querySelectorAll('.editor-group-container').length`)) >= 2, 'diff did not open beside the log');
  });

  await check('a merge commit compares against each parent', async () => {
    await gm(log, `select("Merge branch 'release/1.0' back into main")`);
    const segs = await waitFor(async () => {
      const s = await gm(log, 'segments()');
      return s.length === 2 && s;
    }, { what: 'parent switch' });
    // The newest such merge on any branch: the first match in the log.
    const m = git('log', '-1', '--date-order', '--branches', '--remotes', '--format=%H', '--grep', "Merge branch 'release/1.0' back into main");
    const [p1, p2] = git('show', '-s', '--format=%P', m).split(' ');
    const n1 = git('diff', '--name-only', p1, m).split('\n').filter(Boolean).length;
    const n2 = git('diff', '--name-only', p2, m).split('\n').filter(Boolean).length;
    eq(segs, [`vs P1 ${n1}`, `vs P2 ${n2}`], 'segments');
    await gm(log, 'segment(1)');
    eq((await gm(log, 'files()')).length, n2, 'files vs P2');
  });

  await check('selecting two commits shows their combined diff', async () => {
    await gm(log, `select('Remember the last opened note')`);
    await gm(log, `select('Keyboard shortcut to pin a note', { ctrlKey: true })`);
    await waitFor(async () => (await gm(log, 'selected()')).length === 2, { what: 'two selected' });
    await waitFor(async () => (await gm(log, 'card()')).includes('2 selected commits'), { what: 'combined card' });
  });

  await check('search filters by message and highlights matches', async () => {
    await gm(log, `search('sync')`);
    const subjects = await waitFor(async () => {
      const s = await gm(log, 'subjects()');
      return s.length && s.every((x) => /sync/i.test(x)) && s;
    }, { what: 'filtered rows' });
    eq(subjects.length, git('log', '--branches', '--remotes', '--tags', 'HEAD', '-i', '--fixed-strings', '--grep=sync', '--format=%H').split('\n').length, 'match count');
    ok(await vs.eval(`!!document.querySelector('.subject mark')`, log), 'no highlight');
  });

  await check('search by hash finds the commit', async () => {
    const h = git('log', '-1', '--format=%h', ':/Upgrade the markdown parser');
    await gm(log, `search('${h}')`);
    await waitFor(async () => (await gm(log, 'subjects()')).includes('Upgrade the markdown parser'), { what: 'hash hit' });
    await gm(log, `search('')`);
  });

  await check('author filter', async () => {
    await gm(log, `chip('user', 'Lin Chen')`);
    const authors = await waitFor(async () => {
      const a = await gm(log, 'authors()');
      return a.length && a.every((x) => x === 'Lin Chen') && a;
    }, { what: 'only Lin Chen' });
    eq(authors.length, +git('rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD', '--author=Lin Chen'), 'commit count');
    await gm(log, `clearChip('user')`);
  });

  await check('clicking a branch in the side bar selects its tip in the log', async () => {
    await waitFor(async () => (await gm(log, 'total()')) > 40, { what: 'unfiltered log' });
    await gm(side, `refClick('feature/search')`);
    await waitFor(async () => (await gm(log, 'selected()'))[0] === subjectOf('feature/search'), { what: 'tip selected' });
  });

  await check('double-clicking a branch shows only that branch', async () => {
    await gm(side, `refClick('feature/tags', 'dblclick')`);
    await waitFor(async () => (await gm(log, 'total()')) === count('feature/tags'), { what: 'branch-only log' });
    ok((await gm(log, `chipText('branch')`)).includes('feature/tags'), 'branch chip not set');
    await gm(log, `clearChip('branch')`);
    await waitFor(async () => (await gm(log, 'total()')) > 40, { what: 'filter cleared' });
  });

  await check('file history from the command palette', async () => {
    await vs.key('p', { ctrl: true });
    await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
    await vs.type('src/sync/queue.ts');
    await sleep(900);
    await vs.key('Enter');
    await waitFor(async () => (await vs.editorTabs()).includes('queue.ts') && !(await vs.quickInputVisible()), { what: 'file opened' });
    await vs.command('GitMetro: Show File History in GitMetro');
    log = logCtx = await vs.webview(['log', 'full']);
    ctxMode.set(log, ['log', 'full']);
    const expected = git('log', '--format=%H', '--full-history', '--simplify-merges', '--branches', '--remotes', '--tags', 'HEAD', '--', 'src/sync/queue.ts').split('\n').length;
    await waitFor(async () => (await gm(log, 'total()')) === expected, { what: `${expected} commits touching the file` });
    await gm(log, `clearChip('paths')`);
    await waitFor(async () => (await gm(log, 'total()')) > 40, { what: 'filter cleared' });
    await vs.closeTab('queue.ts');
    ok((await vs.editorTabs()).includes('GitMetro'), 'the log tab was closed instead');
  });

  await check('long edges fold into tails that jump to the other end', async () => {
    const jumps = await gm(log, 'jumps()');
    if (!jumps.length) return; // the visible window may have none
    await gm(log, 'jump(0)');
    const target = subjectOf(jumps[0]);
    await waitFor(async () => (await gm(log, 'selected()'))[0] === target, { what: 'jumped' });
  });

  await check('switch branch from the side bar', async () => {
    await gm(side, `refMenu('feature/search', 'Switch to Branch')`);
    await waitFor(() => git('symbolic-ref', '--short', 'HEAD') === 'feature/search', { what: 'HEAD on feature/search' });
  });

  await check('create a branch from a commit', async () => {
    await gm(log, `rowMenu('Docs: explain the sync design', 'Create Branch Here')`);
    await vs.answerInput('e2e/from-docs');
    await waitFor(() => git('symbolic-ref', '--short', 'HEAD') === 'e2e/from-docs', { what: 'new branch checked out' });
    eq(subjectOf('HEAD'), 'Docs: explain the sync design', 'branch point');
  });

  await check('tag a commit', async () => {
    await gm(log, `rowMenu('Upgrade the markdown parser', 'Tag This Commit')`);
    await vs.answerInput('v-e2e');
    await waitFor(() => git('tag', '-l', 'v-e2e') === 'v-e2e', { what: 'tag' });
    eq(subjectOf('v-e2e'), 'Upgrade the markdown parser', 'tagged commit');
  });

  await check('cherry-pick a commit from another branch', async () => {
    await gm(side, `refMenu('feature/offline-sync', 'Switch to Branch')`);
    await waitFor(() => git('symbolic-ref', '--short', 'HEAD') === 'feature/offline-sync', { what: 'back on offline-sync' });
    await gm(log, `rowMenu('Share a note as a read-only link', 'Cherry-Pick')`);
    await waitFor(() => subjectOf('HEAD') === 'Share a note as a read-only link', { what: 'cherry-picked' });
  });

  await check('revert a commit', async () => {
    await waitFor(async () => (await gm(log, 'subjects()'))[0] === 'Share a note as a read-only link', { what: 'log refreshed' });
    await gm(log, `rowMenu('Share a note as a read-only link', 'Revert')`);
    await waitFor(() => subjectOf('HEAD').startsWith('Revert'), { what: 'revert commit' });
  });

  await check('hard reset to a commit (quick pick + confirmation)', async () => {
    const target = git('log', '-1', '--format=%H', ':/Tests for the offline queue');
    await waitFor(async () => (await gm(log, 'subjects()'))[0].startsWith('Revert'), { what: 'log refreshed' });
    await gm(log, `rowMenu('Tests for the offline queue', 'Move')`);
    await vs.pickQuickItem('Hard');
    await vs.dialogButton('Reset');
    await waitFor(() => git('rev-parse', 'HEAD') === target, { what: 'HEAD moved' });
  });

  await check('uncommit keeps the changes staged', async () => {
    const parent = git('rev-parse', 'HEAD~1');
    await waitFor(async () => (await gm(log, 'subjects()'))[0] === 'Tests for the offline queue', { what: 'log refreshed' });
    await gm(log, `rowMenu('Tests for the offline queue', 'Uncommit')`);
    await waitFor(() => git('rev-parse', 'HEAD') === parent, { what: 'HEAD~1' });
    ok(git('diff', '--cached', '--name-only').includes('test/sync/queue.test.ts'), 'changes not staged');
    git('commit', '-qm', 'Tests for the offline queue');
  });

  await check('diff a commit against the working tree', async () => {
    appendFileSync(path.join(repo, 'README.md'), 'local change\n');
    await waitFor(async () => (await gm(log, 'subjects()'))[0] === 'Tests for the offline queue', { what: 'log refreshed' });
    await gm(log, `rowMenu('Tests for the offline queue', 'Diff Against Working Tree')`);
    await waitFor(async () => (await gm(log, 'card()')).includes('Differences between'), { what: 'worktree comparison' });
    ok((await gm(log, 'files()')).includes('README.md'), 'README.md not listed');
    git('checkout', '--', 'README.md');
  });

  await check('export a patch opens it in an editor', async () => {
    await gm(log, `rowMenu('Tests for the offline queue', 'Export as Patch')`);
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.monaco-editor .view-lines')].some((v) => v.textContent.replace(/\\u00a0/g, ' ').includes('Subject: [PATCH] Tests for the offline queue'))`), { what: 'patch text' });
  });

  await check('smart switch keeps local changes across a checkout', async () => {
    appendFileSync(path.join(repo, 'src/sync/queue.ts'), '// local edit\n');
    await gm(side, `refMenu('main', 'Switch to Branch')`);
    await vs.dialogButton('Smart Checkout');
    await waitFor(() => git('symbolic-ref', '--short', 'HEAD') === 'main', { what: 'switched to main' });
    ok(readFileSync(path.join(repo, 'src/sync/queue.ts'), 'utf8').includes('// local edit') || git('stash', 'list'), 'local edit lost');
    git('reset', '-q', '--hard');
    git('stash', 'clear');
    git('checkout', '-q', 'feature/offline-sync');
  });

  // A branch that clashes with the current one.
  const clash = (name, text) => {
    git('checkout', '-q', '-b', name, 'HEAD~1');
    writeFileSync(path.join(repo, 'src/app.ts'), text);
    git('commit', '-qam', `clash ${name}`);
    git('checkout', '-q', 'feature/offline-sync');
  };
  writeFileSync(path.join(repo, 'src/app.ts'), 'export const mode = "ours";\n');
  git('commit', '-qam', 'ours: set mode');
  clash('e2e/clash', 'export const mode = "theirs";\n');
  clash('e2e/clash2', 'export const mode = "theirs again";\n');

  await check('merge conflict: banner, keep ours, continue', async () => {
    await waitFor(async () => (await gm(side, 'refs()')).includes('e2e/clash'), { what: 'new branch in side bar' });
    await gm(side, `refMenu('e2e/clash', 'Merge into')`);
    const b = await waitFor(() => gm(log, 'banner()'), { what: 'conflict banner' });
    ok(b.text.startsWith('Merging'), `banner: ${b.text}`);
    eq(b.files, ['src/app.ts'], 'conflicted files');
    ok(!b.canContinue, 'continue enabled with conflicts left');
    await gm(log, `conflict('src/app.ts', 'ours')`);
    await waitFor(async () => (await gm(log, 'banner()'))?.canContinue, { what: 'resolved' });
    eq(readFileSync(path.join(repo, 'src/app.ts'), 'utf8'), 'export const mode = "ours";\n', 'kept ours');
    await gm(log, `op('continue')`);
    await waitFor(() => git('show', '-s', '--format=%P', 'HEAD').split(' ').length === 2, { what: 'merge commit' });
    await waitFor(async () => !(await gm(log, 'banner()')), { what: 'banner gone' });
  });

  await check('conflict "Resolve…" opens the three-way merge editor; abort restores', async () => {
    const before = git('rev-parse', 'HEAD');
    await gm(side, `refMenu('e2e/clash2', 'Merge into')`);
    await waitFor(() => gm(log, 'banner()'), { what: 'conflict banner' });
    await gm(log, `conflict('src/app.ts', 'open')`);
    await waitFor(() => vs.eval(`!!document.querySelector('.merge-editor, .merge-editor-view, [class*="mergeEditor"]') || [...document.querySelectorAll('.tabs-container .tab')].some((t) => /Merging/.test(t.textContent))`), { what: 'merge editor' });
    await gm(log, `op('abort')`);
    await vs.dialogButton('Abort');
    await waitFor(() => git('rev-parse', 'HEAD') === before && !existsSync(path.join(repo, '.git', 'MERGE_HEAD')), { what: 'merge aborted' });
  });

  await check('push from the current-branch card', async () => {
    await gm(side, `cardAction('push')`);
    await waitFor(() => git('rev-parse', 'origin/feature/offline-sync') === git('rev-parse', 'HEAD'), { what: 'upstream updated' });
  });

  await check('the log refreshes after a commit made outside VS Code', async () => {
    git('commit', '-q', '--allow-empty', '-m', 'made in a terminal');
    await waitFor(async () => (await gm(log, 'subjects()'))[0] === 'made in a terminal', { timeout: 8000, what: 'auto refresh' });
  });

  await check('copy hash from the commit card', async () => {
    await gm(log, `select('made in a terminal')`);
    await waitFor(async () => (await gm(log, 'card()')) === 'made in a terminal', { what: 'card' });
    eq(await gm(log, 'copyHash()'), 'Hash copied', 'toast');
  });

  await check('palette setting switches the line colours live', async () => {
    const before = await gm(log, 'lineColors()');
    const s = JSON.parse(readFileSync(path.join(vs.ud, 'User', 'settings.json'), 'utf8'));
    s['gitmetro.palette'] = 'atom';
    writeFileSync(path.join(vs.ud, 'User', 'settings.json'), JSON.stringify(s, null, 2));
    await waitFor(async () => (await gm(log, 'palette()')) === 'atom', { what: 'palette applied' });
    const after = await gm(log, 'lineColors()');
    ok(after.includes('#61afef') && !after.includes('#2f81f7'), `colours before ${before} after ${after}`);
  });

  await check('status bar button reopens the log', async () => {
    await vs.command('View: Close All Editors');
    // The exported patch and the aborted merge editor are unsaved: don't keep either.
    for (let i = 0; i < 4; i++) if (!(await vs.dialogButton("Don't Save", 2500).catch(() => false))) break;
    await vs.eval(`[...document.querySelectorAll('.statusbar-item')].find((e) => e.textContent.includes('GitMetro')).querySelector('a, .statusbar-item-label').click()`);
    await vs.webview(['full', 'log']);
    ok((await vs.editorTabs()).includes('GitMetro'), 'no GitMetro tab');
  });

  await check('bottom panel view renders', async () => {
    await vs.command('GitMetro: Open Git Log');
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.panel .composite-bar .action-label')].some((a) => (a.getAttribute('aria-label') || '').startsWith('GitMetro'))`), { what: 'panel tab' });
  });

  await check('blame annotations show who wrote each line', async () => {
    await vs.key('p', { ctrl: true });
    await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
    await vs.type('src/sync/queue.ts');
    await sleep(900);
    await vs.key('Enter');
    await waitFor(async () => (await vs.editorTabs()).includes('queue.ts') && !(await vs.quickInputVisible()), { what: 'file opened' });
    await vs.command('GitMetro: Toggle Blame Annotations');
    const author = git('log', '-1', '--format=%an', '--', 'src/sync/queue.ts');
    // Decorations draw their text with CSS `content:`, so look in the stylesheets, not the DOM.
    await waitFor(async () => (await vs.eval(`[...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } }).join(' ')`)).replace(/\\a0|\u00a0/g, ' ').includes(author.slice(0, 13)), { what: `${author} in the annotations` });
  });

  await check('history of the line under the cursor', async () => {
    await vs.command('View: Hide Panel'); // only the log tab may answer below
    await vs.showTab('queue.ts');
    await vs.command('GitMetro: Show History for Selection in GitMetro');
    log = logCtx = await vs.webview(['log', 'full']);
    ctxMode.set(log, ['log', 'full']);
    const expected = git('log', '-L1,1:src/sync/queue.ts', '--no-patch', '--format=%H', 'HEAD').split('\n').filter(Boolean).length;
    await waitFor(async () => (await gm(log, 'total()')) === expected && (await gm(log, `chipText('paths')`)).includes('queue.ts:1'), { what: `${expected} commits for line 1` });
    await gm(log, `clearChip('paths')`);
    await vs.closeTab('queue.ts');
  });

  await check('no error notifications', async () => {
    const errors = (await vs.notifications()).filter((n) => /failed|error/i.test(n));
    eq(errors, [], 'error notifications');
  });

  await check('no uncaught errors in the GitMetro webviews', async () => {
    const own = vs.pageErrors.filter((e) => /webview\.js|gitmetro/i.test(e) || !/vscode-file|workbench/.test(e));
    eq(own, [], 'webview errors');
  });

  await check('no errors from GitMetro in the extension host log', async () => {
    const logs = path.join(vs.ud, 'logs');
    const lines = [];
    const walk = (d) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.log')) for (const l of readFileSync(p, 'utf8').split('\n')) if (/\[error\]/.test(l) && /gitmetro/i.test(l)) lines.push(l);
      }
    };
    walk(logs);
    eq(lines, [], 'error lines');
  });

  execFileSync('mkdir', ['-p', out]);
  await vs.screenshot(path.join(out, 'final.png'));
} finally {
  await vs.close();
}

const failed = results.filter((r) => !r.ok);
if (!failed.length && !process.env.GITMETRO_E2E_OUT) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}. Screenshots: ${out}`);
process.exit(failed.length ? 1 : 0);
