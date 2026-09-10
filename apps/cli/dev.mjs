#!/usr/bin/env node
// The CLI's development task (`turbo run dev` runs it beside every package's compiler in watch
// mode): compile the CLI in watch mode, then run two processes from the compiled output —
//
//   weawr serve --dev   the console and the interface, page served straight from apps/web/src
//                       with a reload pushed to the browser when a web file changes
//   weawr               the watcher, on the team in WEAWR_DEV_TEAM (default: the current
//                       directory when it has a .weawr/config.json, else this repository's own)
//
// — and restart both whenever a package's compiled output changes, the old pair stopped and gone
// before the new one binds the same socket and port. A restart is safe by design: the watcher's
// pending work is durable and its agents are never touched. WEAWR_DEV_PORT moves the
// console; WEAWR_DEV_WATCHER=0 runs the server alone.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const tsc = require.resolve('typescript/bin/tsc');
const children = new Set();
const log = (m) => process.stdout.write(`[dev] ${m}\n`);
const waitFor = (file) => new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); r(); } }, 250); });

function run(name, args, opts = {}) {
  const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { ...process.env, ...(opts.env || {}) } });
  c.stdout.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `[${name}] `)));
  c.stderr.on('data', (d) => process.stderr.write(String(d).replace(/^(?=.)/gm, `[${name}] `)));
  children.add(c); c.on('exit', () => children.delete(c));
  return c;
}

run('tsc', [tsc, '-p', path.join(here, 'tsconfig.json'), '--watch', '--preserveWatchOutput', '--pretty', 'false']);
const main = path.join(here, 'build', 'main.js');
await waitFor(main);
for (const p of ['protocol', 'recipes', 'engine', 'client']) await waitFor(path.join(root, 'packages', p, 'dist', 'index.js'));
await waitFor(path.join(root, 'packages', 'client', 'dist', 'browser', 'weawr-client.js'));
await new Promise((r) => setTimeout(r, 1500)); // let the first compile settle

const env = {
  WEAWR_WEB_DIR: path.join(root, 'apps', 'web', 'src'),
  WEAWR_CLIENT_JS: path.join(root, 'packages', 'client', 'dist', 'browser', 'weawr-client.js'),
  WEAWR_ASSETS_DIR: path.join(root, 'assets'),
  // No WEAWR_PROMPTS_ROOT, WEAWR_PLUGINS_ROOT or WEAWR_DEMOS_ROOT: the compiled output finds those
  // in the source tree by itself (assetDir in src/context.ts), and it has to — the agents run the
  // command the brief names from their own shell, which carries nothing set here.
  WEAWR_NO_UPDATE_CHECK: '1',
};
const port = process.env.WEAWR_DEV_PORT || '8498';
const cwd = process.env.INIT_CWD || process.cwd();
const team = process.env.WEAWR_DEV_TEAM || (fs.existsSync(path.join(cwd, '.weawr', 'config.json')) ? cwd : root);
const withWatcher = process.env.WEAWR_DEV_WATCHER !== '0';

let serve = null, watcher = null;
/** Stop a child and wait for it to be gone: the successor binds the same socket and port. */
const stopped = (c) => new Promise((r) => {
  if (!c || c.exitCode !== null || c.signalCode !== null) return r();
  const t = setTimeout(() => c.kill('SIGKILL'), 5000);
  c.once('exit', () => { clearTimeout(t); r(); });
  c.kill();
});
async function start() {
  await Promise.all([stopped(serve), stopped(watcher)]);
  log(`serve: weawr serve --dev --port ${port}`);
  serve = run('serve', [main, 'serve', '--dev', '--port', port], { env, cwd: root });
  if (withWatcher) {
    log(`watcher: weawr in ${team}`);
    watcher = run('watch', [main], { env, cwd: team });
    watcher.on('exit', (code) => { if (code !== null && code !== 0) log(`the watcher exited with ${code} (a team already watched, herdr down, or no config?); it starts again on the next change`); });
  }
}
await start();
let timer = null, starting = Promise.resolve();
const restart = (why) => { clearTimeout(timer); timer = setTimeout(() => { log(`restart: ${why}`); starting = starting.then(start); }, 800); };
for (const dir of ['packages/protocol/dist', 'packages/recipes/dist', 'packages/engine/dist', 'apps/cli/build']) {
  fs.watch(path.join(root, dir), { recursive: true }, (_ev, file) => { if (file && /\.m?js$/.test(file)) restart(`${dir}/${file}`); });
}
log(`console at http://127.0.0.1:${port}/ · edit apps/web/src and the page reloads · edit a package and both processes restart${withWatcher ? '' : ' · watcher off (WEAWR_DEV_WATCHER=0)'}`);
const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
