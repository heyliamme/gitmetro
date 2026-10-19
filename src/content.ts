import { realpathSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Git, isSafeRev } from './git';

export const SCHEME = 'gitmetro';
/** Stands for the working tree on the right-hand side of a diff. */
export const WORKTREE = 'WORKTREE';

interface Query {
  root: string;
  ref: string;
}

export function revUri(root: string, ref: string, file: string): vscode.Uri {
  if (ref === WORKTREE) return vscode.Uri.file(path.join(root, file));
  const q: Query = { root, ref };
  // Keep the real file name in the path so the editor picks the right language.
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + file, query: JSON.stringify(q) });
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly gitBin: () => string) {}

  /**
   * Anyone can hand VS Code a URI with this scheme (a link in a document, another
   * extension), so only serve repositories that are open in the workspace.
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: Query;
    try {
      q = JSON.parse(uri.query) as Query;
    } catch {
      return '';
    }
    if (typeof q.root !== 'string' || typeof q.ref !== 'string' || !isSafeRev(q.ref)) return '';
    // Compare real paths: a workspace opened through a symlink (or macOS's /var -> /private/var)
    // still owns the repository git reports.
    const root = real(q.root);
    const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some((f) => {
      const folder = real(f.uri.fsPath);
      const inside = (from: string, to: string) => {
        const rel = path.relative(from, to);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      };
      return inside(root, folder) || inside(folder, root);
    });
    if (!inWorkspace) return '';
    return new Git(q.root, this.gitBin()).show(q.ref, uri.path.slice(1));
  }
}

export function shortRef(ref: string): string {
  if (!ref) return 'empty';
  if (ref === WORKTREE) return 'Local';
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}
