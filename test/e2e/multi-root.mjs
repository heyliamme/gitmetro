// End-to-end for a multi-root workspace: two repositories open at once, like the
// Source Control view shows them. Run after run.mjs (it reuses the packaged .vsix).
//
//   npm run package && node test/e2e/multi-root.mjs
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `gitmetro-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-e2e-')));
writeFileSync(path.join(root, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const app = path.join(root, 'app');
const docs = path.join(root, 'docs');
execFileSync(process.execPath, ['scripts/demo-repo.mjs', app], { stdio: 'ignore' });
execFileSync('git', ['init', '-q', '-b', 'main', docs]);
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
g(docs, 'config', 'user.name', 'Doc Writer');
g(docs, 'config', 'user.email', 'docs@example.com');
for (const m of ['Start the handbook', 'Add the install guide', 'Explain the release process']) {
  writeFileSync(path.join(docs, 'handbook.md'), `${m}\n`, { flag: 'a' });
  g(docs, 'add', '-A');
  g(docs, 'commit', '-qm', m);
}
const workspace = path.join(root, 'team.code-workspace');
writeFileSync(workspace, JSON.stringify({ folders: [{ path: 'app' }, { path: 'docs' }] }));

const vs = new VSCode(root);
vs.install(vsix, { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'git.autoRepositoryDetection': false });
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  ✖ ${name}\n      ${e.message.split('\n')[0]}`);
    await vs.screenshot(path.join(root, `fail-${results.length}.png`)).catch(() => {});
  }
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const subjects = (ctx) => vs.eval(`[...document.querySelectorAll('#viewport .row .subject')].map((s) => s.textContent)`, ctx);
/** The log webview whose rows include `subject`. */
const logOf = (subject) =>
  waitFor(async () => {
    for (const ctx of vs.contexts.values()) {
      try {
        if ((await subjects(ctx)).includes(subject)) return ctx;
      } catch {
        /* not a log */
      }
    }
    return null;
  }, { what: `log showing "${subject}"` });

try {
  await vs.launch(workspace);
  for (const l of ['Continue without Signing In', 'Get Started']) {
    await vs.eval(`[...document.querySelectorAll('a,button,.monaco-button')].find((e) => e.textContent.trim() === ${JSON.stringify(l)})?.click()`).catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  }
  await vs.command('View: Close All Editors');
  let side;

  await check('the side bar lists both repositories', async () => {
    await vs.eval(`document.querySelector('.activitybar .action-label[aria-label^="GitMetro"]').click()`);
    side = await vs.webview('sidebar');
    const repos = await waitFor(async () => {
      const r = await vs.eval(`[...document.querySelectorAll('#refTree .node.repo .name')].map((n) => n.textContent)`, side);
      return r.length === 2 && r;
    }, { what: 'two repositories' });
    ok(repos.includes('app') && repos.includes('docs'), `listed: ${repos}`);
  });

  await check('clicking a repository opens its own log tab, next to the first', async () => {
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('GitMetro: ')), { what: 'first log tab' });
    await vs.eval(`[...document.querySelectorAll('#refTree .node.repo')].find((n) => n.querySelector('.name').textContent === 'docs').click()`, side);
    await waitFor(async () => (await vs.editorTabs()).includes('GitMetro: docs'), { what: 'docs log tab' });
    const tabs = (await vs.editorTabs()).filter((t) => t.startsWith('GitMetro: '));
    ok(tabs.length === 2, `log tabs: ${tabs}`);
  });

  await check('each log tab shows its own repository', async () => {
    const docsLog = await waitFor(async () => {
      for (const ctx of vs.contexts.values()) {
        try {
          const s = await subjects(ctx);
          if (s[0] === 'Explain the release process') return ctx;
        } catch {
          /* not a log */
        }
      }
      return null;
    }, { what: 'docs log' });
    const s = await subjects(docsLog);
    ok(s.length === 3 && !s.some((x) => x.includes('offline')), `docs log rows: ${s}`);
    await vs.showTab('GitMetro: app');
    const appLog = await waitFor(async () => {
      for (const ctx of vs.contexts.values()) {
        try {
          const s = await subjects(ctx);
          if (s.includes('Tests for the offline queue')) return ctx;
        } catch {
          /* not a log */
        }
      }
      return null;
    }, { what: 'app log' });
    ok((await subjects(appLog)).length > 20, 'app log too short');
  });

  const cardRepo = () => vs.eval(`document.querySelector('.cur-repo')?.textContent`, side);
  const sideRefs = () => vs.eval(`[...document.querySelectorAll('#refTree .node.ref')].map((n) => n.getAttribute('title'))`, side);

  await check('the side bar follows the log tab in front', async () => {
    await vs.showTab('GitMetro: app');
    await waitFor(async () => (await cardRepo()) === 'app', { what: 'side bar on app' });
    ok((await sideRefs()).includes('feature/offline-sync'), 'app branches listed');
    await vs.showTab('GitMetro: docs');
    await waitFor(async () => (await cardRepo()) === 'docs', { what: 'side bar on docs' });
    const refs = await sideRefs();
    ok(refs.includes('main') && !refs.includes('feature/offline-sync'), `refs: ${refs}`);
  });

  await check('picking a repository in a log tab moves the side bar too', async () => {
    await vs.showTab('GitMetro: app');
    await waitFor(async () => (await cardRepo()) === 'app', { what: 'side bar on app' });
    const appLog = await logOf('Tests for the offline queue');
    const docsRoot = await vs.eval(`[...document.getElementById('repoSelect').options].find((o) => o.textContent === 'docs').value`, appLog);
    await vs.eval(`(() => { const s = document.getElementById('repoSelect'); s.value = ${JSON.stringify(docsRoot)}; s.dispatchEvent(new Event('change')); })()`, appLog);
    await waitFor(async () => (await cardRepo()) === 'docs', { what: 'side bar moved to docs' });
  });

  await check('a commit made in one repository refreshes its log, and only its log', async () => {
    const before = (await logOf('Tests for the offline queue').then(subjects)).length;
    g(docs, 'commit', '-q', '--allow-empty', '-m', 'Docs tweak');
    await vs.showTab('GitMetro: docs');
    await waitFor(async () => (await subjects(await logOf('Docs tweak')))[0] === 'Docs tweak', { what: 'docs log refreshed' });
    await vs.showTab('GitMetro: app');
    const after = (await subjects(await logOf('Tests for the offline queue'))).length;
    ok(after === before, `app log changed: ${before} -> ${after}`);
  });

  // GITMETRO_E2E_OUT keeps the screenshot after a passing run (the profile is removed).
  const shot = path.join(process.env.GITMETRO_E2E_OUT ?? root, 'multi-root.png');
  await vs.screenshot(shot);
  console.log(`  screenshot: ${shot}`);
} finally {
  await vs.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
// Keep the profile and screenshot only when something failed.
if (!failed) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(failed ? 1 : 0);
