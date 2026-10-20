import * as vscode from 'vscode';
import { BlameAnnotations } from './blame';
import { RevisionContentProvider, SCHEME } from './content';
import { LogViewProvider } from './view';

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new LogViewProvider(ctx);
  ctx.subscriptions.push(
    provider,
    // The side bar and panel views are rebuilt from the host's state when shown again, so they
    // don't keep a renderer process alive while hidden. Log tabs do (scroll and selection).
    vscode.window.registerWebviewViewProvider('gitmetro.log', provider),
    vscode.window.registerWebviewViewProvider('gitmetro.branches', provider),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(() => provider.gitBin())),
    vscode.commands.registerCommand('gitmetro.show', () => vscode.commands.executeCommand('gitmetro.log.focus')),
    vscode.commands.registerCommand('gitmetro.openEditor', (root?: unknown) => provider.openInEditor(typeof root === 'string' ? root : undefined)),
    vscode.commands.registerCommand('gitmetro.refresh', () => provider.reload()),
    vscode.commands.registerCommand('gitmetro.fileHistory', (uri?: vscode.Uri) => provider.showFileHistory(uri)),
    vscode.commands.registerCommand('gitmetro.lineHistory', () => provider.showLineHistory()),
    vscode.commands.registerCommand('gitmetro.revealCommit', (root: unknown, hash: unknown) => typeof root === 'string' && typeof hash === 'string' && provider.revealCommit(root, hash)),
  );
  // Log tabs come back after a window reload.
  ctx.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('gitmetro.editor', {
      deserializeWebviewPanel: async (panel, state) => provider.restoreEditor(panel, state),
    }),
  );
  const blame = new BlameAnnotations(() => provider.gitBin(), provider.log);
  ctx.subscriptions.push(blame, vscode.commands.registerCommand('gitmetro.toggleBlame', (uri?: vscode.Uri) =>
    blame.toggle(uri instanceof vscode.Uri ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) : undefined)));

  void provider.discover();

  // A way in that doesn't depend on finding the panel tab.
  const item = vscode.window.createStatusBarItem('gitmetro.status', vscode.StatusBarAlignment.Left, -100);
  item.name = 'GitMetro';
  item.text = '$(gitmetro-mark) GitMetro';
  item.tooltip = 'Open the GitMetro log in an editor tab';
  item.command = 'gitmetro.openEditor';
  // Only in windows that have a repository (nested ones count: GitMetro's own count, not the
  // workspace folders), and only if the user wants it.
  const sync = () => {
    if (vscode.workspace.getConfiguration('gitmetro').get('statusBar', true) && provider.repoCount > 0) item.show();
    else item.hide();
  };
  sync();
  provider.onReposChanged = sync;
  ctx.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitmetro') && sync()),
  );
}

export function deactivate(): void {}
