#!/usr/bin/env node
// The dependency direction, enforced. Each package may import only from itself and the packages
// listed for it; relative imports may not leave the package; clients (web, mobile, client) may not
// touch Node. A rule that lives only in a document is a rule that is broken by the next refactor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Package → the internal packages it may import. Everything else internal is refused. */
const ALLOWED = {
  'packages/protocol': [],
  'packages/recipes': ['@weawr/protocol'],
  'packages/engine': ['@weawr/recipes', '@weawr/protocol'],
  'packages/client': ['@weawr/protocol'],
  'apps/cli': ['@weawr/engine', '@weawr/recipes', '@weawr/protocol'],
  'apps/web': ['@weawr/client', '@weawr/protocol'],
  'apps/mobile': ['@weawr/client', '@weawr/protocol'],
};
/** Packages that run in a browser or a phone: no Node built-ins, no filesystem, no processes. */
const PORTABLE = new Set(['packages/protocol', 'packages/client', 'apps/web', 'apps/mobile']);
const NODE_ONLY = /^(node:|fs$|path$|os$|child_process$|net$|http$|https$|crypto$|url$|util$|stream$|events$|readline$|tls$|dns$|module$|worker_threads$|sqlite$)/;

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function files(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'build') out.push(...files(p)); }
    else if (/\.(m?[jt]s|tsx)$/.test(e.name) && !/\.d\.m?ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const [pkg, allowed] of Object.entries(ALLOWED)) {
  const src = path.join(root, pkg, 'src');
  for (const file of files(src)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      const where = `${path.relative(root, file)}: "${spec}"`;
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(src + path.sep) && target !== src) problems.push(`${where} leaves ${pkg}/src`);
        continue;
      }
      if (spec.startsWith('@weawr/')) {
        const dep = spec.split('/').slice(0, 2).join('/');
        if (!allowed.includes(dep)) problems.push(`${where}: ${pkg} may not import ${dep} (allowed: ${allowed.join(', ') || 'nothing internal'})`);
        if (dep === '@weawr/engine' && spec !== dep && !pkg.startsWith('apps/cli')) problems.push(`${where}: engine internals are private`);
        continue;
      }
      if (PORTABLE.has(pkg) && NODE_ONLY.test(spec)) problems.push(`${where}: ${pkg} must stay portable (no Node built-ins)`);
    }
  }
}
// Generated artifacts may not point back at a source tree.
for (const dist of ['apps/cli/dist']) {
  const dir = path.join(root, dist);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    // Code only: the bundler's own `// ../../packages/...` boundary comments are not references.
    const text = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const bad of ['/packages/', '/apps/web/src', '"workspace:', "'workspace:"]) if (text.includes(bad)) problems.push(`${dist}/${f} mentions ${bad}`);
  }
}
if (problems.length) { console.error(`import check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log('import check: ok');
