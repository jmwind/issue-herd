// Development: compile in watch mode and keep the browser bundle current.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsc = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(here, 'tsconfig.json'), '--watch', '--preserveWatchOutput', '--pretty', 'false'], { stdio: 'inherit' });
const ctx = await context({ entryPoints: [path.join(here, 'dist', 'index.js')], outfile: path.join(here, 'dist', 'browser', 'weawr-client.js'), bundle: true, format: 'iife', globalName: 'WeawrClientModule', platform: 'browser', target: 'es2020', logLevel: 'warning', footer: { js: 'window.WeawrClient = WeawrClientModule.WeawrClient; window.WeawrError = WeawrClientModule.WeawrError;' } });
await ctx.watch();
const stop = () => { tsc.kill(); ctx.dispose().then(() => process.exit(0)); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
