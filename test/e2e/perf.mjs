// Resource use in a real VS Code: memory (PSS) and CPU of the whole process tree, with and
// without GitMetro, on a large generated repository.
//
//   npm run package && node test/e2e/perf.mjs [commits]
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(`gitmetro-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const COMMITS = Number(process.argv[2] ?? 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-perf-')));
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Perf\n\temail = perf@example.com\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const repo = path.join(root, 'big');

// A history with feature branches merging back, so the graph has work to do.
function generate() {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const lines = [];
  let mark = 0;
  let t = 1_600_000_000;
  const commit = (ref, msg, from, merge) => {
    mark++;
    t += 60;
    const data = `${msg}\n`;
    lines.push(`commit ${ref}`, `mark :${mark}`, `committer Perf <perf@example.com> ${t} +0000`, `data ${Buffer.byteLength(data)}`, data);
    if (from) lines.push(`from ${from}`);
    if (merge) lines.push(`merge ${merge}`);
    lines.push(`M 644 inline file${mark % 200}.txt`, `data ${String(mark).length + 1}`, `${mark}`, '');
    return `:${mark}`;
  };
  let main = commit('refs/heads/main', 'Initial commit');
  let n = 1;
  let b = 0;
  while (n < COMMITS) {
    const len = 3 + (b % 7);
    let tip = main;
    for (let i = 0; i < len && n < COMMITS; i++, n++) tip = commit(`refs/heads/feature/${b}`, `Feature ${b}: step ${i}`, tip);
    for (let i = 0; i < 2 && n < COMMITS; i++, n++) main = commit('refs/heads/main', `Main work ${n}`, main);
    main = commit('refs/heads/main', `Merge feature/${b}`, main, tip);
    n++;
    b++;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: lines.join('\n') + '\n' });
  execFileSync('git', ['reset', '-q', '--hard', 'main'], { cwd: repo });
  // Keep the branch list realistic: drop most merged feature branches.
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((x) => x.startsWith('feature/'));
  for (const x of branches.slice(0, -40)) execFileSync('git', ['branch', '-q', '-D', x], { cwd: repo });
  execFileSync('git', ['gc', '-q'], { cwd: repo });
}

/** Every process in VS Code's group, by role, with PSS (kB) and CPU ticks. */
function sample(pgid) {
  const out = [];
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) !== pgid) continue;
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      // Swapped-out pages count too: on a machine short of memory PSS alone drops by itself.
      const roll = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = Number(/^Pss:\s+(\d+)/m.exec(roll)?.[1] ?? 0) + Number(/^SwapPss:\s+(\d+)/m.exec(roll)?.[1] ?? 0);
      // utime + stime, plus the children it has reaped (git commands that already exited).
      out.push({ pid, cmd, pss, cpu: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]) });
    } catch {
      /* exited */
    }
  }
  return out;
}
/** Groups the tree by process type, so a change shows where the memory went. */
const byType = (s) => {
  const m = {};
  for (const p of s) {
    const t = /--type=(\S+)/.exec(p.cmd)?.[1] ?? (/^git /.test(p.cmd) ? 'git' : 'main');
    const k = t === 'utility' ? (/node\.mojom\.NodeService/.test(p.cmd) ? 'node' : 'utility') : t;
    m[k] = (m[k] ?? 0) + Math.round(p.pss / 1024);
  }
  return m;
};
const total = (s) => s.reduce((a, p) => a + p.pss, 0);
const ticks = (s) => s.reduce((a, p) => a + p.cpu, 0);
const HZ = 100;

async function settle(vs) {
  // Let startup work finish: wait until the tree stops using CPU.
  let prev = ticks(sample(vs.proc.pid));
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const now = ticks(sample(vs.proc.pid));
    if (now - prev < 10) return;
    prev = now;
  }
}

async function measure(label, withExtension, steps) {
  const vs = new VSCode(path.join(root, label));
  try {
    return await run(vs, label, withExtension, steps);
  } finally {
    await vs.close();
  }
}

async function run(vs, label, withExtension, steps) {
  vs.install(vsix, { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'extensions.autoUpdate': false, 'gitmetro.statusBar': true });
  const inspect = 9900 + Math.floor(Math.random() * 90);
  await vs.launch(repo, [`--inspect-extensions=${inspect}`, ...(withExtension ? [] : ['--disable-extension', `${pkg.publisher}.${pkg.name}`])]);
  // The extension host's own JS heap, after a full GC: what extensions there hold.
  const hostHeap = async () => {
    const [t] = await (await fetch(`http://127.0.0.1:${inspect}/json`)).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let id = 0;
    const call = (method) => new Promise((r) => {
      const my = ++id;
      ws.addEventListener('message', function on(e) {
        const m = JSON.parse(e.data);
        if (m.id === my) (ws.removeEventListener('message', on), r(m.result));
      });
      ws.send(JSON.stringify({ id: my, method }));
    });
    await call('HeapProfiler.enable');
    await call('HeapProfiler.collectGarbage');
    const h = await call('Runtime.getHeapUsage');
    ws.close();
    return Math.round((h.usedSize / 1048576) * 10) / 10;
  };
  for (const label of ['Continue without Signing In', 'Get Started']) {
    await vs.eval(`(() => { const b = [...document.querySelectorAll('a,button,.monaco-button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); })()`).catch(() => {});
    await sleep(700);
  }
  await vs.command('View: Close All Editors');
  await settle(vs);
  const results = {};
  const snap = (name) => {
    const s = sample(vs.proc.pid);
    results[name] = { pssMB: Math.round(total(s) / 1024), procs: s.length, byType: byType(s) };
  };
  const snapHost = async (name) => {
    results[name].hostHeapMB = await hostHeap().catch((e) => String(e));
  };
  const heap = async (name) => {
    const ctx = await vs.webview(['log', 'full'], 5000).catch(() => undefined);
    if (!ctx) return;
    await vs.send('HeapProfiler.collectGarbage', {}, ctx.sessionId).catch(() => {});
    const h = await vs.send('Runtime.getHeapUsage', {}, ctx.sessionId).catch(() => undefined);
    const dom = await vs.eval('document.getElementsByTagName("*").length', ctx).catch(() => undefined);
    const rows = await vs.eval(`document.getElementById('list').scrollHeight / 26 | 0`, ctx).catch(() => undefined);
    if (h) Object.assign(results[name], { webviewHeapMB: Math.round(h.usedSize / 1048576), domNodes: dom, rowsLoaded: rows });
  };
  snap('idle');
  await snapHost('idle');
  for (const [name, fn] of steps) {
    const before = ticks(sample(vs.proc.pid));
    const t0 = Date.now();
    try {
      await fn(vs);
    } catch (e) {
      await vs.screenshot(path.join(process.env.PERF_SHOTS ?? root, `fail-${label}-${name.replace(/\W+/g, '-')}.png`));
      throw e;
    }
    const cpu = (ticks(sample(vs.proc.pid)) - before) / HZ;
    await settle(vs);
    snap(name);
    await heap(name);
    await snapHost(name);
    results[name].cpuS = Math.round(cpu * 10) / 10;
    results[name].wallS = Math.round((Date.now() - t0) / 100) / 10;
  }
  // Idle CPU over a minute with everything open.
  const before = ticks(sample(vs.proc.pid));
  await sleep(60000);
  results.idle60 = { cpuS: (ticks(sample(vs.proc.pid)) - before) / HZ };
  return results;
}

generate();
console.log(`repository: ${COMMITS} commits, ${execFileSync('git', ['branch'], { cwd: repo, encoding: 'utf8' }).split('\n').length - 1} branches`);
const log = async (vs) => vs.webview(['log', 'full'], 30000);
const rows = () => `document.querySelectorAll('.row').length`;
const steps = [
  [
    'open log',
    async (vs) => {
      await vs.command('GitMetro: Open Git Log in Editor');
      const ctx = await log(vs);
      await waitFor(async () => (await vs.eval(rows(), ctx)) > 10, { timeout: 30000, what: 'rows' });
    },
  ],
  [
    'scroll 5000 commits',
    async (vs) => {
      const ctx = await log(vs);
      for (let i = 0; i < 60; i++) {
        await vs.eval(`(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight; })()`, ctx);
        await sleep(250);
      }
    },
  ],
  [
    'external commits x20',
    async () => {
      for (let i = 0; i < 20; i++) {
        writeFileSync(path.join(repo, 'churn.txt'), `${i}\n`);
        execFileSync('git', ['commit', '-qam', `Churn ${i}`, '--allow-empty'], { cwd: repo });
        await sleep(300);
      }
    },
  ],
];
// Editing files without committing: VS Code's own git refreshes the index each time, which
// GitMetro's watcher sees. Run with and without GitMetro to see what it adds.
const edits = [
  'edit files x20',
  async () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(path.join(repo, `file${i}.txt`), `edited ${i}\n`);
      await sleep(500);
    }
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: repo });
  },
];
steps.push(edits);
const off = await measure('without', false, [edits]);
const on = await measure('with', true, steps);
console.log(JSON.stringify({ without: off, with: on }, null, 2));
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
