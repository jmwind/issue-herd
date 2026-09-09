#!/usr/bin/env node
// Build every workspace package in dependency order, with nothing but Node and the installed
// devDependencies. This is what `prepare` runs, so `npm install -g github:jmwind/weawr` — where npm,
// not pnpm, installed the clone and Turborepo cannot read the workspace — produces exactly the
// artifact `turbo run build` produces: each package's own `build` script, run in order.
//
// npm's git-dependency preparation is peculiar twice over: it runs `prepare` before
// node_modules/.bin is linked, and under `npm install -g` the inner install inherits the global
// flag, so the clone's devDependencies are not installed at all when `prepare` runs. So this
// script installs its own toolchain when it is missing (a local, script-free, no-save install with
// the inherited npm configuration stripped), and resolves the tools itself rather than trusting
// PATH, exposing them through a shim directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ORDER = ['packages/protocol', 'packages/recipes', 'packages/engine', 'packages/client', 'apps/web', 'apps/cli'];

function toolchainPresent() { try { require.resolve('typescript/bin/tsc'); require.resolve('esbuild'); return true; } catch { return false; } }
if (!toolchainPresent()) {
  process.stdout.write('build: dev toolchain not installed; installing it locally (no-save)\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
  execFileSync('npm', ['install', '--no-save', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'], { cwd: root, stdio: 'inherit', env });
  if (!toolchainPresent()) throw new Error('build: the dev toolchain is still missing after npm install');
}

const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-build-'));
const shim = (name, entry) => {
  const target = require.resolve(entry);
  if (process.platform === 'win32') fs.writeFileSync(path.join(shims, `${name}.cmd`), `@node "${target}" %*\r\n`);
  else fs.writeFileSync(path.join(shims, name), `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
};
shim('tsc', 'typescript/bin/tsc');

try {
  for (const rel of ORDER) {
    const dir = path.join(root, rel);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const script = pkg.scripts?.build;
    if (!script) continue;
    process.stdout.write(`build ${pkg.name}: ${script}\n`);
    const PATH = [shims, path.join(root, 'node_modules', '.bin'), path.join(dir, 'node_modules', '.bin'), process.env.PATH].join(path.delimiter);
    execSync(script, { cwd: dir, stdio: 'inherit', env: { ...process.env, PATH, Path: PATH } });
  }
} finally {
  fs.rmSync(shims, { recursive: true, force: true });
}
