#!/usr/bin/env node
// `pnpm demo <scenario>`: the demo, on this checkout. Builds the workspace (cached), sets the
// demo team up with the CLI just built, then runs `pnpm dev` on it: the watcher and the
// console, from the development build, restarting on every edit.
//
//   pnpm demo                 list the scenarios
//   pnpm demo squad           set squad up and run it
//   pnpm demo reset           close what the demo filed, clear its state
//   pnpm demo squad --dry-run say what would be filed; start nothing
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sh = (cmd, cmdArgs, env = {}) => spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

if (sh('pnpm', ['exec', 'turbo', 'run', 'build']) !== 0) process.exit(1);
const { userDir } = await import(path.join(root, 'packages', 'engine', 'dist', 'index.js'));
const { DEMO_REPO, defaultDemoDir } = await import(path.join(root, 'apps', 'cli', 'build', 'commands', 'demo.js'));
const into = args.includes('--into') ? args[args.indexOf('--into') + 1] : defaultDemoDir(userDir(), DEMO_REPO);
const cli = path.join(root, 'apps', 'cli', 'dist', 'weawr.mjs');
const devEnv = { WEAWR_NO_UPDATE_CHECK: '1', WEAWR_DEMOS_ROOT: path.join(root, 'apps', 'cli', 'demos') };

const sub = args[0];
if (!sub || sub === 'list' || sub === 'reset' || args.includes('--dry-run')) {
  const demoArgs = ['demo', ...args];
  if (sub === 'reset' && !args.includes('--into')) demoArgs.push('--into', into);
  process.exit(sh(process.execPath, [cli, ...demoArgs], devEnv));
}
if (sh(process.execPath, [cli, 'demo', ...args, ...(args.includes('--into') ? [] : ['--into', into])], devEnv) !== 0) process.exit(1);
console.log(`\n[demo] starting the watcher and the console on ${into} from this checkout (Ctrl-C stops both; \`pnpm demo reset\` cleans up)\n`);
process.exit(sh('pnpm', ['exec', 'turbo', 'run', 'dev'], { WEAWR_DEV_TEAM: into }));
