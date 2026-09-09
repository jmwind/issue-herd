#!/usr/bin/env node
// Build every workspace package in dependency order, with nothing but Node and the installed
// devDependencies. This is what `prepare` runs, so `npm install -g github:jmwind/weawr` — where npm,
// not pnpm, installed the clone and Turborepo cannot read the workspace — produces exactly the
// artifact `turbo run build` produces: each package's own `build` script, run in order.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['packages/protocol', 'packages/recipes', 'packages/engine', 'packages/client', 'apps/web', 'apps/cli'];
const bin = path.join(root, 'node_modules', '.bin');
for (const rel of ORDER) {
  const dir = path.join(root, rel);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const script = pkg.scripts?.build;
  if (!script) continue;
  process.stdout.write(`build ${pkg.name}: ${script}\n`);
  execSync(script, { cwd: dir, stdio: 'inherit', env: { ...process.env, PATH: `${bin}${path.delimiter}${path.join(dir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}` } });
}
