// Assemble the one file users run. esbuild folds the workspace packages into dist/weawr.mjs
// (Node's own modules stay external), and the runtime assets the code reads relative to itself —
// the web console, the prompt templates, the example config — are copied next to it. Nothing in
// dist/ refers back to a source directory or to a workspace dependency.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(here, '..', '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dist = path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src', 'main.mjs')],
  outfile: path.join(dist, 'weawr.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { __WEAWR_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
});
fs.chmodSync(path.join(dist, 'weawr.mjs'), 0o755);

// The packages' own dist directories, wherever the package manager put them.
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
fs.cpSync(path.join(pkgDir('@weawr/recipes'), 'dist', 'prompts'), path.join(dist, 'prompts'), { recursive: true });
fs.cpSync(path.join(root, 'apps', 'web', 'dist'), path.join(dist, 'web'), { recursive: true });
fs.copyFileSync(path.join(here, 'config.example.json'), path.join(dist, 'config.example.json'));
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: 'weawr', version, type: 'module', private: true }, null, 2) + '\n');
