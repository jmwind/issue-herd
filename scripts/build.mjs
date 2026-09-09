#!/usr/bin/env node
// Build every workspace package in dependency order, with nothing but Node and the installed
// devDependencies. This is what `prepare` runs, so `npm install -g github:jmwind/weawr` — where npm,
// not pnpm, installed the clone and Turborepo cannot read the workspace — produces exactly the
// artifact `turbo run build` produces: each package's own `build` script, run in order.
//
// npm's git-dependency preparation is peculiar three times over (the third is below): it runs `prepare` before
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
const ARTIFACT = path.join(root, 'apps', 'cli', 'dist', 'weawr.mjs');

// An installed copy carries the artifact and none of the sources (`files` in package.json). If
// npm ever runs `prepare` there, there is nothing to build and nothing missing.
if (!fs.existsSync(path.join(root, ORDER[0], 'package.json')) && fs.existsSync(ARTIFACT)) {
  process.stdout.write('build: already built (no sources here); nothing to do\n');
  process.exit(0);
}

// npm's third peculiarity: it exports its own settings into the environment of everything it
// spawns, so the `npm install` pacote runs inside the clone to prepare a git dependency inherits
// `--global` — and `npm install -g` with no arguments installs the current directory, as a link.
// Before the real install has begun, the global prefix already holds `<prefix>/lib/node_modules/
// weawr -> <the temporary clone>`; npm deletes that clone when it is done with it, and the user is
// left with a link to nothing (always on Linux, sometimes on macOS). The link is ours — it points
// at this very directory, a clone in npm's cache — so the last `prepare` npm runs in the clone,
// the one before it packs, swaps the link for an empty directory, and the install fills that.
// The first `prepare` (inside that nested install, marked by pacote's _PACOTE_NO_PREPARE_) leaves
// it: the nested install still links its bins through it.
function removeStrayGlobalLink() {
  if (process.env.npm_config_global !== 'true' || process.env._PACOTE_NO_PREPARE_) return;
  const inCacheTmp = root.split(path.sep).includes('_cacache') && path.basename(root).startsWith('git-clone');
  if (!inCacheTmp) return; // `npm install -g .` from a working copy is a link the user asked for
  let prefix = process.env.npm_config_prefix;
  if (!prefix) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
    try { prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return; }
  }
  const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  for (const link of [path.join(prefix, 'lib', 'node_modules', name), path.join(prefix, 'node_modules', name)]) {
    let target;
    try { if (!fs.lstatSync(link).isSymbolicLink()) continue; target = fs.realpathSync(link); } catch { continue; }
    if (target !== fs.realpathSync(root)) continue;
    process.stdout.write(`build: replacing ${link}, npm's link to this temporary clone, with a real directory for the install to fill\n`);
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { continue; /* leave it; the install may still work through it */ } }
    // npm made its destination before it started preparing us, so the path has to exist; only
    // now it is a directory of its own rather than a window onto the clone.
    fs.mkdirSync(link, { recursive: true });
  }
}
removeStrayGlobalLink();

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
