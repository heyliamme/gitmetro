// Stand-in for the 'vscode' module (resolved through NODE_PATH): just enough of the VS Code API to drive the extension host code in node.
const path = require('path');
const log = (globalThis.__vscodeLog = []);
const answers = (globalThis.__answers = []); // queued replies for input boxes / pickers / modals
class Uri {
  constructor(o) { Object.assign(this, { scheme: 'file', path: '', query: '', ...o }); }
  get fsPath() { return this.path; }
  static file(p) { return new Uri({ scheme: 'file', path: p }); }
  static from(o) { return new Uri(o); }
  static parse(s) { return new Uri({ scheme: 'https', path: s }); }
  static joinPath(u, ...ps) { return new Uri({ ...u, path: path.join(u.path, ...ps) }); }
  toString() { return `${this.scheme}:${this.path}${this.query ? '?' + this.query : ''}`; }
}
const ev = () => () => ({ dispose() {} });
const reply = (kind, ...args) => { log.push([kind, ...args]); return Promise.resolve(answers.length ? answers.shift() : undefined); };
const providers = (globalThis.__providers = {});
const commands = (globalThis.__commands = {});
let clip = '';
module.exports = {
  Uri,
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  ProgressLocation: { Notification: 15 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  FileType: { File: 1, Directory: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(t) { this.value += t; return this; } },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2 },
  workspace: {
    workspaceFolders: globalThis.__folders,
    // globalThis.__config: settings a test wants, keyed without the 'gitmetro.' prefix.
    getConfiguration: () => ({ get: (k, d) => (globalThis.__config && k in globalThis.__config ? globalThis.__config[k] : d) }),
    onDidChangeWorkspaceFolders: ev(),
    onDidChangeConfiguration: ev(),
    onDidChangeTextDocument: ev(),
    onDidCloseTextDocument: ev(),
    createFileSystemWatcher: () => ({ onDidChange: ev(), onDidCreate: ev(), onDidDelete: ev(), dispose() {} }),
    registerTextDocumentContentProvider: (s, p) => ((providers[s] = p), { dispose() {} }),
    fs: { stat: (u) => require('fs').promises.stat(u.fsPath).then((st) => ({ type: st.isDirectory() ? 2 : 1 })), readFile: (u) => require('fs').promises.readFile(u.fsPath).then((b) => new Uint8Array(b)) },
    openTextDocument: (o) => (log.push(['openTextDocument', o]), Promise.resolve(o)),
  },
  window: {
    registerWebviewViewProvider: (id, p) => ((providers[id] = p), { dispose() {} }),
    registerWebviewPanelSerializer: (id, s) => ((providers['serializer:' + id] = s), { dispose() {} }),
    showErrorMessage: (...a) => reply('error', ...a),
    showWarningMessage: (m, o, ...items) => reply('warning', m, ...items),
    showInformationMessage: (...a) => reply('info', ...a),
    showInputBox: (o) => reply('input', o.prompt),
    showQuickPick: (items, o) => reply('quickPick', o?.title).then((a) => (typeof a === 'number' ? items[a] : a)),
    showOpenDialog: () => reply('openDialog'),
    showTextDocument: (d) => (log.push(['showTextDocument', String(d)]), Promise.resolve()),
    withProgress: (o, f) => (log.push(['progress', o.title]), f({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })),
    setStatusBarMessage: (m) => log.push(['status', m]),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: ev(),
    onDidChangeActiveColorTheme: ev(),
    onDidChangeWindowState: ev(),
    activeColorTheme: { kind: 2 },
    visibleTextEditors: [],
    createOutputChannel: () => Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'appendLine', 'show', 'dispose'].map((k) => [k, () => {}])),
    createWebviewPanel: (id, title) => {
      const listeners = [];
      const panel = (globalThis.__panel = {
        title,
        visible: true,
        reveal() {},
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: (f) => (listeners.push(f), { dispose() {} }),
        dispose: () => listeners.forEach((f) => f()),
        webview: { options: {}, html: '', cspSource: '', asWebviewUri: (u) => u, sent: [], postMessage(m) { this.sent.push(m); }, onDidReceiveMessage: () => ({ dispose() {} }) },
      });
      return panel;
    },
    createTerminal: (o) => ({ show() {}, sendText: (t) => log.push(['terminal', t]) }),
  },
  commands: {
    registerCommand: (id, f) => ((commands[id] = f), { dispose() {} }),
    executeCommand: (id, ...a) => (log.push(['command', id, ...a.map((x) => (x && typeof x === 'object' && !(x instanceof Uri) ? JSON.stringify(x) : String(x)))]), Promise.resolve()),
  },
  extensions: { getExtension: () => undefined },
  env: { shell: '/bin/bash', clipboard: { writeText: (t) => ((clip = t), Promise.resolve()), readText: () => Promise.resolve(clip) }, openExternal: (u) => log.push(['openExternal', String(u)]) },
};
