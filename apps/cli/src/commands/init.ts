import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeConfig } from '@weawr/engine/config-merge.mjs';
import { TRACKERS, isTracker, trackerSpec, trackerClass } from '@weawr/engine/adapters/trackers/index.mjs';
import { ask } from '@weawr/engine/adapters/auth.mjs';
import type { Context } from '../context.js';

const GITIGNORE = `# weawr. config.json, instructions.md and prompts/ are committed; these are not.
# runtime state: state.json, runs/<KEY>/, logs/, the owner lock and socket
state/
# per-machine overrides of config.json
config.local.json
# the git worktrees weawr creates for runs
worktrees/
`;

/** `weawr init [--tracker linear|github]`. Asks which tracker on a terminal when not told. */
export async function init(ctx: Context, args: string[] = []): Promise<void> {
  const { paths, pkgDir, promptsRoot } = ctx;
  const flag = args.indexOf('--tracker');
  if (flag >= 0 && !args[flag + 1]) throw new Error(`--tracker needs a name: ${Object.keys(TRACKERS).join(' | ')}`);
  let type = flag >= 0 ? args[flag + 1] : args.find((a) => isTracker(a));
  // Re-running init in a repo that is already set up must not re-scaffold it as a different tracker.
  const already = ctx.hasConfig() ? ctx.config().trackerSpec.type : null;
  if (!type && already) type = already;
  if (!type && process.stdin.isTTY) type = (await ask(`Which issue tracker? [${Object.keys(TRACKERS).join('/')}] (linear) `)).trim();
  const Tracker: any = trackerClass(trackerSpec(type || 'linear'));
  fs.mkdirSync(paths.configDir, { recursive: true });
  const made: string[] = [];
  const put = (p: string, content: string) => { if (!fs.existsSync(p)) { fs.writeFileSync(p, content); made.push(path.relative(paths.repo, p)); } };
  // config.example.json, with the tracker's own adjustments layered over it like config.local.json would be
  const example = mergeConfig(JSON.parse(fs.readFileSync(path.join(pkgDir, 'config.example.json'), 'utf8')), Tracker.exampleConfig || null);
  example.tracker = Tracker.id;
  put(paths.configPath, JSON.stringify(example, null, 2) + '\n');
  put(path.join(paths.configDir, 'instructions.md'), fs.readFileSync(path.join(promptsRoot, 'instructions.example.md'), 'utf8'));
  // .weawr/ carries its own .gitignore so the repo's is left alone
  put(path.join(paths.configDir, '.gitignore'), GITIGNORE);
  // document the token variable, for people who prefer .env.local to `weawr login`
  const envName = ([] as string[]).concat(Tracker.auth?.env || [])[0];
  const ex = path.join(paths.repo, '.env.example');
  const exText = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  if (envName && !new RegExp(`^${envName}=`, 'm').test(exText)) {
    const sep = exText ? (exText.endsWith('\n') ? '\n' : '\n\n') : '';
    fs.appendFileSync(ex, `${sep}# weawr: ${Tracker.label} token — ${Tracker.auth.hint}.\n# Put the real value in .env.local, never here; or skip this and run \`weawr login\`.\n${envName}=\n`);
    made.push(`.env.example (+ ${envName})`);
  }
  // We just told them to put a live token in .env.local. Say so if git would commit it.
  if (envName && !gitIgnores(paths.repo, '.env.local')) {
    console.log(`\n⚠ .env.local is not gitignored in this repository. Add it to ${path.join(paths.repo, '.gitignore')} before you put a token there, or use \`weawr login\` instead, which keeps the token outside the repo.`);
  }
  console.log(made.length ? `wrote in ${paths.repo} for ${Tracker.label}:\n  ${made.join('\n  ')}` : `nothing to do; ${path.relative(paths.repo, paths.configDir)} already initialised`);
  console.log(`\nnext: \`weawr login\` (or put ${envName} in ${path.join(paths.repo, '.env.local')}), edit .weawr/config.json and instructions.md, then \`weawr match "label:ai"\``);
  console.log(`per-machine settings (e.g. a claim label that names this machine) go in .weawr/config.local.json, which is gitignored`);
}

function gitIgnores(repo: string, file: string): boolean {
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: repo, stdio: 'ignore' }); return true; } catch { return false; }
}
