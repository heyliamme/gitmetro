import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Tests commit with git directly: keep the contributor's global config (signing, hooks) out of it.
const isolated = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-gitconfig-')));
writeFileSync(path.join(isolated, 'config'), '[user]\n\tname = GitMetro Tests\n\temail = tests@example.com\n');
process.env.GIT_CONFIG_GLOBAL = path.join(isolated, 'config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const made = [isolated];
process.on('exit', () =>
  made.forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* Windows may still hold it; it's in the temp dir */
    }
  }),
);

/** GITMETRO_TEST_REPO if set, otherwise a freshly generated demo repository (removed afterwards). */
export function testRepo() {
  if (process.env.GITMETRO_TEST_REPO) return process.env.GITMETRO_TEST_REPO;
  // Real path: macOS tmp is a symlink and Windows runners use 8.3 short names; git reports the long form.
  const parent = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gitmetro-fixture-')));
  made.push(parent);
  const dir = path.join(parent, 'demo');
  execFileSync(process.execPath, [path.resolve('scripts/demo-repo.mjs'), dir], { stdio: ['ignore', 'ignore', 'inherit'] });
  return dir;
}
