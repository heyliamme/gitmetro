// Runs the real extension host code (against a mocked VS Code API) and serves the real
// webview in a browser, bridged over HTTP. For screenshots and UI work without VS Code.
//
//   npm run preview -- <repo> [port]
//   open http://localhost:7799/?theme=light&select=merge&text=sync
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import Module, { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(process.argv[2] || '.');
const port = +(process.argv[3] || 7799);

process.env.NODE_PATH = path.join(root, 'test/stubs');
Module._initPaths();
const vscode = require('vscode');
vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(repo) }];
const { activate } = require(path.join(root, 'dist/extension.js'));
const store = new Map();
activate({
  subscriptions: [],
  extensionUri: vscode.Uri.file(root),
  workspaceState: { get: (k) => store.get(k), update: (k, v) => (store.set(k, v), Promise.resolve()) },
});
const provider = globalThis.__providers['gitmetro.log'];
let queue = [];
provider.resolveWebviewView({
  webview: { options: {}, html: '', cspSource: '', asWebviewUri: (u) => u, postMessage: (m) => queue.push(m), onDidReceiveMessage: () => ({ dispose() {} }) },
  visible: true,
  onDidChangeVisibility: () => ({ dispose() {} }),
  onDidDispose: () => ({ dispose() {} }),
});

const THEMES = {
  dark: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-panel-background:#181818;--vscode-sideBar-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-focusBorder:#0078d4;--vscode-descriptionForeground:#9d9d9d;--vscode-menu-background:#1f1f1f;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-editor-font-family:"Cascadia Code",Menlo,monospace;`,
  light: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#3b3b3b;--vscode-panel-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-panel-border:#e5e5e5;--vscode-list-activeSelectionBackground:#e8e8e8;--vscode-list-activeSelectionForeground:#000;--vscode-list-inactiveSelectionBackground:#e4e6f1;--vscode-list-hoverBackground:#f2f2f2;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-focusBorder:#005fb8;--vscode-descriptionForeground:#717171;--vscode-menu-background:#ffffff;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-editor-font-family:"Cascadia Code",Menlo,monospace;`,
};

const page = (q) => `<!doctype html><html><head><meta charset="utf-8">
<style>:root{${THEMES[q.get('theme') === 'light' ? 'light' : 'dark']}}</style>
<link rel="stylesheet" href="/webview.css"></head><body class="vscode-${q.get('theme') === 'light' ? 'light' : 'dark'}"><div id="app"></div>
<script>
const q = new URLSearchParams(${JSON.stringify(q.toString())});
let st = q.get('hash') ? { showHash: true } : null;
const deliver = (msgs) => msgs.forEach((m) => window.postMessage(m, '*'));
let chain = Promise.resolve();
window.acquireVsCodeApi = () => ({ getState: () => st, setState: (s) => (st = s), postMessage: (m) => {
  chain = chain.then(() => fetch('/msg', { method: 'POST', body: JSON.stringify(m) }).then((r) => r.json()).then(deliver));
}});
// Scripted interactions for screenshots.
let logs = 0;
window.addEventListener('message', (e) => {
  if (e.data.type !== 'log') return;
  logs++;
  if (logs === 1 && q.get('palette')) window.postMessage({ type: 'settings', palette: q.get('palette') }, '*');
  if (logs === 1 && q.get('text')) return setTimeout(() => window.postMessage({ type: 'setFilter', filter: { text: q.get('text') } }, '*'), 50);
  if (logs !== (q.get('text') ? 2 : 1)) return;
  setTimeout(() => {
    const sel = q.get('select');
    if (sel) {
      const rows = [...document.querySelectorAll('.row')];
      const row = sel === 'merge' ? rows.find((r, i) => i > 2 && r.classList.contains('merge')) : rows[+sel];
      row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      document.getElementById('list').focus();
    }
  }, 150);
});
</script><script src="/webview.js"></script></body></html>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/') return res.end(page(url.searchParams));
      if (url.pathname === '/webview.js') return res.end(readFileSync(path.join(root, 'dist/webview.js')));
      if (url.pathname === '/webview.css') {
        res.setHeader('content-type', 'text/css');
        return res.end(readFileSync(path.join(root, 'dist/webview.css')));
      }
      if (url.pathname === '/msg') {
        // Another site open in the same browser could post here (DNS rebinding, a form):
        // accept only same-origin requests addressed to localhost.
        const host = req.headers.host ?? '';
        const origin = req.headers.origin;
        if (req.method !== 'POST' || !/^(localhost|127\.0\.0\.1):\d+$/.test(host) || (origin && origin !== `http://${host}`)) {
          res.writeHead(403).end();
          return;
        }
        let body = '';
        for await (const c of req) body += c;
        await provider.onMessage(JSON.parse(body));
        const out = queue;
        queue = [];
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(out));
      }
      res.statusCode = 404;
      res.end();
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.end(String(e));
    }
  })
  // Localhost only: /msg drives real git actions (merge, push…) with no authentication.
  .listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`));
