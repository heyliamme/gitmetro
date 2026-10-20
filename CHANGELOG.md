# Changelog

## 0.2.1

- The side bar now follows the log tab in front: switching tabs, or picking another
  repository in a log tab, moves the branches and the current-branch card with it.
- The highlighted row in Repositories always matches the repository shown.
- A folder that holds several repositories (opened as one workspace folder) no longer loses
  the GitMetro icon: repositories VS Code's Git finds while it scans, or that are created
  later, now show up without a reload, and the status bar button counts them too.

## 0.2.0

First public release.

- Commit graph drawn as a metro map: curved lines, stations, interchanges for merges.
  Long edges fold into dashed tails you can click to follow.
- Branch sidebar with a current-branch card (upstream, ↑ to push, ↓ to pull, Pull /
  Push / Fetch), pinned branches, folders, remotes and tags.
- Merge commits compared with each parent (**vs P1 / vs P2**); files edited during the
  merge are marked.
- Conflict banner for merge, rebase, cherry-pick, revert and stash pop: open in the
  merge editor, keep ours or theirs, mark resolved, continue, skip or abort.
- Search by message or hash (regex, match case); filter by branch, author, date, path.
- Actions: switch (with smart stash), branch, tag, merge, rebase, pull, push, rename,
  delete, cherry-pick, revert, reset, interactive rebase, amend message, uncommit,
  export patch, compare with working tree, open on GitHub / GitLab / Bitbucket.
- Activity Bar icon: branches in the side bar, the log as an editor tab beside them.
  Also opens from the status bar, or as a bottom-panel tab.
- Multi-root workspaces: every repository in the side bar, a log tab per repository.
- Blame annotations for the whole file, shaded by age, linked to the log.
- File history follows renames; history of selected lines (`git log -L`).
- Worktrees: list, create from a branch or commit, open, lock, remove, prune.
- Cherry-pick with `-x`, and cherry-pick a single file's change from a commit.
- File history from the Explorer and editor context menus.
- `gitmetro.palette`: metro or Atom One Dark / One Light line colours.
- Diffs and patches opened from the log tab open beside it, so the log stays in view;
  in a narrow log the commit details move under the list.
- View → Output → GitMetro logs refreshes and git commands, for bug reports.
- Light on resources: until GitMetro is opened it only checks for a repository; hidden side views release
  their process, the log renders only the rows on screen, and refreshes only reload when
  refs move.
- Off in Restricted Mode; refuses revisions that could be read as git options.
- Works with workspaces opened through a symlink.
