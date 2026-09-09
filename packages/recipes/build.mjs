// Ship every recipe revision next to the compiled module, so the CLI build has one place to copy
// from: dist/prompts/<revision>/<template>.md, plus the scaffold instructions.example.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist', 'prompts');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(here, 'prompts'), out, { recursive: true });
