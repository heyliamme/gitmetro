# Releasing

Releases are published by the **Release** workflow when a version tag is pushed. It
runs the tests, packages the `.vsix`, publishes to the VS Code Marketplace and Open VSX,
and attaches the `.vsix` to a GitHub release.

## Cutting a release

1. Bump `version` in `package.json` (semver) and add a section to `CHANGELOG.md`.
2. Commit, then tag with the same version and push the tag:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

The workflow refuses to publish if the tag and `package.json` disagree.

## One-time setup

0. **Public repository.** Create `heyliamme/gitmetro` as a **public** repository and push `main`.
   The store pages load README images from it, and CI and the release workflow run there.
   Then Settings → Code security → enable **Private vulnerability reporting** (SECURITY.md and
   the issue templates link to its form).
1. **Environment.** Settings → Environments → New environment `release`. Add yourself as a
   required reviewer, so pushing a tag waits for your approval before anything is published.
   The store tokens below go in this environment, not in repository secrets.
2. **Open VSX namespace.** After creating the token, once: `npx ovsx create-namespace heyliam -p <token>`.
   Without it the first Open VSX publish fails.
3. **Marketplace publisher** `heyliam` at https://marketplace.visualstudio.com/manage.

## Store tokens

The publish job reads two secrets from the `release` environment. A store whose secret is
missing is skipped, so either can be set up later.

| Secret | Store | How to get it |
| --- | --- | --- |
| `VSCE_PAT` | VS Code Marketplace | Azure DevOps → User settings → Personal access tokens. Organization: *All accessible organizations*. Scope: *Marketplace → Manage*. |
| `OVSX_PAT` | Open VSX | open-vsx.org → Settings → Access Tokens (after signing the Eclipse Publisher Agreement). |

Tokens expire; when a publish step fails with 401, renew the token and update the secret.

Azure DevOps retires *global* PATs (the "All accessible organizations" kind) on 1 December
2026. Before then, move the Marketplace step to Microsoft Entra ID: GitHub OIDC with
`azure/login`, then `vsce publish --azure-credential`.

If one store published and the other failed, re-run the workflow: both publish steps use
`--skip-duplicate`.

## Publishing by hand

```bash
npm ci && npm test
npm run package                                   # gitmetro-<version>.vsix
npx vsce publish --packagePath gitmetro-<version>.vsix -p "$VSCE_PAT"
npx ovsx publish gitmetro-<version>.vsix -p "$OVSX_PAT"
```

## Notes

- The README on the store pages loads its images from this GitHub repository, so the
  repository must be public.
- The publisher ID (`heyliam`) is part of the extension's identity. Changing it means a
  new extension listing, so it never changes.
