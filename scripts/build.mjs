import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');
if (prod) rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18' },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' },
  // Backend without vscode, for tests and the UI preview (scripts/preview-ui.mjs).
  { ...common, entryPoints: ['src/git.ts', 'src/graph.ts'], outdir: 'dist/core', platform: 'node', format: 'cjs', target: 'node18', bundle: false },
];

const copyCss = () => copyFileSync('webview/style.css', 'dist/webview.css');
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  copyCss();
  (await import('fs')).watch('webview/style.css', () => {
    copyCss();
    console.log('[watch] webview.css copied');
  });
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyCss();
}
