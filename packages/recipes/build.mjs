// Ship the prompt files next to the compiled module, so the CLI build has one place to copy from.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist', 'prompts');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'prompts'))) fs.copyFileSync(path.join(here, 'prompts', f), path.join(out, f));
