// The browser build: one classic script that defines `WeawrClient` for the console page (which has
// no bundler), next to the ESM the TypeScript compiler emits for everyone else.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const here = path.dirname(fileURLToPath(import.meta.url));
await build({ entryPoints: [path.join(here, 'dist', 'index.js')], outfile: path.join(here, 'dist', 'browser', 'weawr-client.js'), bundle: true, format: 'iife', globalName: 'WeawrClientModule', platform: 'browser', target: 'es2020', legalComments: 'none', logLevel: 'warning', footer: { js: 'window.WeawrClient = WeawrClientModule.WeawrClient; window.WeawrError = WeawrClientModule.WeawrError;' } });
