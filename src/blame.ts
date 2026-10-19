import * as path from 'path';
import * as vscode from 'vscode';
import { BlameLine, Git } from './git';

const UNCOMMITTED = /^0{40}$/;
const WIDTH = 26; // characters of annotation column

/**
 * Blame annotations down the left of an editor: author and date per
 * block of lines from the same commit, shaded by age, the commit on hover, a click through to
 * the log. Toggled per file; follows edits (blame runs on the editor's text, saved or not).
 */
export class BlameAnnotations implements vscode.Disposable {
  private readonly on = new Set<string>(); // document URIs with annotations turned on
  private readonly decoration = vscode.window.createTextEditorDecorationType({});
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly gitBin: () => string, private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      this.decoration,
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.on.has(e.document.uri.toString()) && this.schedule(e.document, 0))),
      // Re-blaming redraws a decoration per line: on very large files, wait for a longer pause.
      vscode.workspace.onDidChangeTextDocument((e) => this.on.has(e.document.uri.toString()) && this.schedule(e.document, e.document.lineCount > 20000 ? 3000 : 600)),
      vscode.window.onDidChangeActiveColorTheme(() => vscode.window.visibleTextEditors.forEach((e) => this.on.has(e.document.uri.toString()) && this.schedule(e.document, 0))),
      vscode.workspace.onDidCloseTextDocument((d) => this.on.delete(d.uri.toString())),
    );
  }

  private readonly gens = new Map<string, number>();

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }

  async toggle(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) return;
    const key = editor.document.uri.toString();
    if (this.on.delete(key)) {
      for (const e of this.editorsOf(editor.document)) e.setDecorations(this.decoration, []);
      return;
    }
    if (editor.document.uri.scheme !== 'file') {
      vscode.window.showInformationMessage('Blame works on files saved in a Git repository.');
      return;
    }
    this.on.add(key);
    await this.render(editor.document);
  }

  isOn(doc: vscode.TextDocument): boolean {
    return this.on.has(doc.uri.toString());
  }

  private editorsOf(doc: vscode.TextDocument): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document === doc);
  }

  private schedule(doc: vscode.TextDocument, delay: number): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.render(doc), delay));
  }

  private async render(doc: vscode.TextDocument): Promise<void> {
    // An edit can start a new render before the last one returns: only the newest one draws.
    const gen = (this.gens.get(doc.uri.toString()) ?? 0) + 1;
    this.gens.set(doc.uri.toString(), gen);
    const file = doc.uri.fsPath;
    const root = await Git.toplevel(path.dirname(file), this.gitBin());
    if (!root) {
      this.on.delete(doc.uri.toString());
      vscode.window.showInformationMessage(`${path.basename(file)} is not in a Git repository.`);
      return;
    }
    const git = new Git(root, this.gitBin());
    let lines: BlameLine[];
    try {
      lines = await git.blame(path.relative(root, file), doc.getText());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.on.delete(doc.uri.toString());
      this.log.warn(`blame ${file}: ${msg}`);
      vscode.window.showInformationMessage(/no such path|not in the working tree|no such ref/.test(msg) ? `${path.basename(file)} isn't committed yet: nothing to blame.` : `Blame failed: ${msg.split('\n')[0]}`);
      return;
    }
    if (!this.on.has(doc.uri.toString()) || this.gens.get(doc.uri.toString()) !== gen) return;

    // Shade by age: the newest commit in the file is strongest.
    const times = lines.filter((l) => l && !UNCOMMITTED.test(l.commit.hash)).map((l) => l.commit.authorTime);
    // A loop, not Math.max(...times): spreading 100k+ lines overflows the stack.
    let newest = 0;
    for (const t of times) if (t > newest) newest = t;
    let oldest = newest;
    for (const t of times) if (t < oldest) oldest = t;
    const span = Math.max(1, newest - oldest);
    // A lighter age tint on light themes, or the newest lines lose contrast.
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    const options: vscode.DecorationOptions[] = [];
    // One hover per commit, shared by its lines: a big file has few commits but many lines.
    const hovers = new Map<string, vscode.MarkdownString>();
    const date_ = new Map<string, string>();
    let prev = '';
    lines.forEach((l, i) => {
      if (!l || i >= doc.lineCount) return;
      const c = l.commit;
      const fresh = UNCOMMITTED.test(c.hash);
      const first = c.hash !== prev;
      prev = c.hash;
      const age = fresh ? 1 : (c.authorTime - oldest) / span;
      let text = '';
      if (first && fresh) text = 'Not committed yet';
      else if (first) {
        if (!date_.has(c.hash)) date_.set(c.hash, `${shortName(c.author)} · ${date(c.authorTime)}`);
        text = date_.get(c.hash)!;
      }
      let hover = hovers.get(c.hash);
      if (!hover) {
        hover = new vscode.MarkdownString(undefined, true);
        if (fresh) hover.appendMarkdown('**Not committed yet**');
        else {
          hover.isTrusted = { enabledCommands: ['gitmetro.revealCommit'] };
          const args = encodeURIComponent(JSON.stringify([root, c.hash]));
          hover.appendMarkdown(`**${md(c.summary)}**\n\n${md(c.author)} · ${new Date(c.authorTime * 1000).toLocaleString()}\n\n\`${c.hash.slice(0, 8)}\` · [Show in GitMetro](command:gitmetro.revealCommit?${args})`);
        }
        hovers.set(c.hash, hover);
      }
      options.push({
        range: new vscode.Range(i, 0, i, 0),
        hoverMessage: hover,
        renderOptions: {
          before: {
            contentText: pad(text),
            width: `${WIDTH}ch`,
            margin: '0 1.2em 0 0',
            color: new vscode.ThemeColor(first ? 'descriptionForeground' : 'editorLineNumber.foreground'),
            backgroundColor: `rgba(47, 129, 247, ${(light ? 0.03 + age * 0.1 : 0.04 + age * 0.22).toFixed(3)})`,
            fontStyle: fresh ? 'italic' : 'normal',
          },
        },
      });
    });
    for (const e of this.editorsOf(doc)) e.setDecorations(this.decoration, options);
  }
}

const shortName = (name: string) => (name.length > 14 ? name.slice(0, 13) + '…' : name);
const date = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
// Non-breaking spaces: the decoration collapses ordinary trailing spaces.
const pad = (s: string) => (s.length >= WIDTH ? s.slice(0, WIDTH) : s + ' '.repeat(WIDTH - s.length));
const md = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>$~]/g, '\\$&');
