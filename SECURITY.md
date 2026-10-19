# Security policy

GitMetro runs `git` in your workspace, so bugs that let crafted repository content or
links run unintended git commands are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/gitmetro/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: anything that makes GitMetro run git with arguments the user didn't intend,
read or write files outside the open repository, or execute script in its webview from
repository content (commit messages, branch names, file names).

Out of scope: what git itself does with a repository's own hooks and config. GitMetro
stays off in Restricted Mode for that reason.
