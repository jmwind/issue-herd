// The console has no framework and no bundler: the build copies the page and the brand assets it
// links to into dist/, which the CLI build then carries into its own artifact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'src'))) fs.copyFileSync(path.join(here, 'src', f), path.join(dist, f));
for (const dir of ['icons', 'logo']) fs.cpSync(path.join(root, 'assets', dir), path.join(dist, 'assets', dir), { recursive: true });
