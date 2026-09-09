#!/usr/bin/env node
// Build every workspace package in dependency order, with nothing but Node and the installed
// devDependencies. This is what `prepare` runs, so `npm install -g github:jmwind/weawr` — where npm,
// not pnpm, installed the clone and Turborepo cannot read the workspace — produces exactly the
// artifact `turbo run build` produces: each package's own `build` script, run in order.
//
// npm's git-dependency preparation runs `prepare` before node_modules/.bin is linked, so the
// tools the scripts name are resolved here and put on PATH through a shim directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ORDER = ['packages/protocol', 'packages/recipes', 'packages/engine', 'packages/client', 'apps/web', 'apps/cli'];

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
