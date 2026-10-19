# Contributing to GitMetro

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with your OS, VS Code version, `git --version`, what you did, what you
expected and what happened. A screenshot helps. If the graph looks wrong, the output of
`git log --graph --oneline -30` for that part of history helps more.

## Running from source

Node 22 or newer and git 2.24 or newer.

```bash
git clone https://github.com/heyliamme/gitmetro
cd gitmetro
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host with GitMetro loaded.

## Tests

```bash
npm test
```

The tests build a demo repository (`scripts/demo-repo.mjs`) and run against it:

- `test/graph.test.mjs` checks that every line in the graph is continuous and leads to
  the right parent, across pages too.
- `test/host.test.mjs` drives the extension host code against a throwaway clone with a
  mocked VS Code API: branching, switching, smart switch, cherry-pick, revert, reset,
  merge and rebase conflicts, and refusal of crafted revisions.

To run them against a repository of your own (read-only for the graph tests, a
throwaway clone for the host tests):

```bash
GITMETRO_TEST_REPO=/path/to/repo npm test
```

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile, opens
a generated demo repository, and clicks through GitMetro as a user would: the activity bar,
selecting commits and merges, diffs, filters, branch actions, cherry-pick, revert, reset,
conflicts and the merge editor, push and auto-refresh. VS Code runs headless, so it
doesn't take over your screen. Linux only (it uses Chromium's headless mode), Node 22+, with
`code` on your `PATH` (or set `VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
```

It leaves screenshots of any failing step, and the GitMetro log (View → Output →
GitMetro), in the temporary profile it prints.

## Resource use

GitMetro should stay light. `npm run test:perf` generates a 20,000-commit repository and
opens it in VS Code twice, with and without GitMetro, measuring the extension host's heap,
the log webview's heap and DOM size, and the CPU used while loading, scrolling, committing
and idling. Run it before and after a change that touches loading, refreshing or rendering.
Each headless VS Code uses several inotify instances: if runs fail with `EMFILE`, close
other VS Code windows first.

## The icon

`media/panel-icon.svg` is the mark: a metro line with a branch that leaves it and rejoins it. The store icon
(`assets/icon.svg`, rendered to `media/icon.png`) and the status bar font
(`media/gitmetro-icons.woff`, built by `scripts/build-icon-font.py`) are drawn from it.

## Working on the UI in a browser

The harness runs the real extension host code and serves the real webview, so you can
iterate on the UI with browser devtools:

```bash
npm run build
npm run demo -- /tmp/demo              # or /tmp/demo --conflict
node harness/server.mjs /tmp/demo
# http://localhost:7799/?theme=light&select=merge&text=sync
# headless screenshot: google-chrome --headless=new --virtual-time-budget=8000 --screenshot=out.png <url>
```

## Layout

| Path | |
| --- | --- |
| `src/extension.ts` | Activation: views, commands, status bar |
| `src/view.ts` | Finds the repositories and routes each view's messages to one |
| `src/session.ts` | One repository: its log, watchers and every action |
| `src/git.ts` | Every git command, and parsing |
| `src/graph.ts` | Lane layout for the graph |
| `src/blame.ts` | Blame annotations in the editor |
| `src/content.ts` | Serves files at a revision for diffs |
| `src/protocol.ts` | Message types shared with the webview |
| `webview/` | The UI: plain TypeScript and CSS, no framework |

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include before and after screenshots in light and dark themes.
- Any new git call that takes a revision from the UI goes through `assertRev` and
  `--end-of-options`.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
