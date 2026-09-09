#!/usr/bin/env node
// weawr — the executable. Dependency assembly and command routing only: what each command does
// lives in ./commands, the factory itself in @weawr/engine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, makeTracker } from './context.js';
import { HELP, terminal } from './ui.js';
import { init } from './commands/init.js';
import { auth } from './commands/auth.js';
import { reset, status } from './commands/status.js';
import { match } from './commands/match.js';
import { watch } from './commands/watch.js';
import { smoke } from './commands/smoke.js';
import { consoleCommand } from './commands/console.js';
import { update, updateReminder } from './commands/update.js';

export async function main(argv: string[]): Promise<void> {
  const ctx = createContext({ ui: terminal() });
  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') { console.log(ctx.version); return; }
  if (argv[0] === 'update' || argv[0] === 'upgrade') return update(ctx);
  if ((argv[0] || '') === 'init') return init(ctx, argv.slice(1));
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { console.log(HELP); return; }
  ctx.loadEnv();
  const cmd = argv[0] || 'run';
  if (cmd === 'login' || cmd === 'logout') return auth(ctx, cmd, argv.slice(1));
  if (cmd === 'console') return consoleCommand(ctx, argv.slice(1));
  if (!ctx.hasConfig()) throw new Error(`no ${path.relative(process.cwd(), ctx.paths.configPath) || ctx.paths.configPath} — cd into the repo you want to work on and run \`weawr init\``);
  const cfg = ctx.config();
  if (cmd !== 'smoke') await updateReminder(ctx);
  if (cmd === 'status') return status(ctx);
  if (cmd === 'reset') return reset(ctx, argv[1]);
  if (cmd === 'smoke') return smoke(ctx, argv);
  const tracker = makeTracker(ctx, cfg);
  if (cmd === 'match') return match(ctx, tracker, argv.slice(1));
  if (cmd === 'dry-run' || cmd === 'once' || cmd === 'run') return watch(ctx, tracker, cmd);
  throw new Error(`unknown command ${cmd}`);
}

// Run only as the program, not when a test imports the module. (`npm install -g` runs it through a
// symlink, so it is the real path that has to match.)
const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(`weawr: ${e.message}`); process.exit(1); });
