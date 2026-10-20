// End-to-end: a workspace folder that is not a repository itself but holds several (like
// ~/projects). Only VS Code's Git extension finds them, and only after it has scanned, so
// GitMetro has to pick them up when they appear, not just once at startup.
//
//   npm run package && node test/e2e/nested.mjs
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `gitmetro-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-e2e-')));
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = T\n\temail = t@example.com\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const projects = path.join(root, 'projects');
mkdirSync(projects);
for (const name of ['alpha', 'beta', 'gamma']) {
  const dir = path.join(projects, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(path.join(dir, 'README.md'), `${name}\n`);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', `Start ${name}`], { cwd: dir });
}

const vs = new VSCode(root);
// VS Code's defaults: the Git extension scans subfolders for repositories.
vs.install(vsix, { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'extensions.autoUpdate': false });
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

try {
  await vs.launch(projects);
  await check('the status bar button and the activity bar icon stay for a folder of repositories', async () => {
    // The status bar button only shows once GitMetro has found repositories: past that point
    // the icon must still be there (before, it vanished once activation found none).
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.statusbar-item')].some((e) => e.textContent.includes('GitMetro'))`), { timeout: 30000, what: 'status bar button' });
    await new Promise((r) => setTimeout(r, 1500));
    ok(await vs.eval(`!!document.querySelector('.activitybar .action-label[aria-label^="GitMetro"]')`), 'activity bar icon gone');
  });
  await check('the side bar lists every nested repository', async () => {
    await vs.eval(`document.querySelector('.activitybar .action-label[aria-label^="GitMetro"]').click()`);
    const side = await vs.webview('sidebar');
    const names = await waitFor(async () => {
      const r = await vs.eval(`[...document.querySelectorAll('#refTree .node.repo .name')].map((n) => n.textContent)`, side);
      return r.length === 3 && r;
    }, { timeout: 20000, what: 'three repositories' });
    ok(['alpha', 'beta', 'gamma'].every((n) => names.includes(n)), `listed: ${names}`);
  });
  await check('a repository created later shows up without a reload', async () => {
    const dir = path.join(projects, 'delta');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    writeFileSync(path.join(dir, 'README.md'), 'delta\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'Start delta'], { cwd: dir });
    const side = await vs.webview('sidebar');
    await waitFor(async () => (await vs.eval(`[...document.querySelectorAll('#refTree .node.repo .name')].map((n) => n.textContent)`, side)).includes('delta'), { timeout: 30000, what: 'delta listed' });
  });
  const shot = path.join(process.env.GITMETRO_E2E_OUT ?? root, 'nested.png');
  await vs.screenshot(shot);
  console.log(`  screenshot: ${shot}`);
} finally {
  await vs.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (!failed) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
else console.log(`  kept: ${root}`);
process.exit(failed ? 1 : 0);
