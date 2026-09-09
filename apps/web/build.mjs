// The console has no framework and no bundler: the build copies the page and the brand assets it
// links to into dist/, which the CLI build then carries into its own artifact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dist = path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true, maxRetries: 5 });
fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'src'))) { const p = path.join(here, 'src', f); if (fs.statSync(p).isDirectory()) fs.cpSync(p, path.join(dist, f), { recursive: true }); else fs.copyFileSync(p, path.join(dist, f)); }
// The client library, as the browser build @weawr/client makes; the page has no bundler of its own.
const client = path.join(root, 'packages', 'client', 'dist', 'browser', 'weawr-client.js');
if (fs.existsSync(client)) fs.copyFileSync(client, path.join(dist, 'client.js'));
for (const dir of ['icons', 'logo']) fs.cpSync(path.join(root, 'assets', dir), path.join(dist, 'assets', dir), { recursive: true });
