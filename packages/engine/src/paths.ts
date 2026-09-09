// Where a factory keeps its things. Computed once from the repository root and handed to
// everything else, so two engines for two repositories can live in one process and nothing reads
// process.cwd() at import time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FactoryPaths {
  /** The repository root (real path). */
  repo: string;
  /** <repo>/.weawr — committed config, instructions, prompt overrides. */
  configDir: string;
  configPath: string;
  /** Per-machine overrides of config.json, gitignored. */
  localConfigPath: string;
  /** <repo>/.weawr/state — everything runtime, gitignored. */
  stateDir: string;
  statePath: string;
  runsDir: string;
  logDir: string;
  logPath: string;
  /** The exclusive-ownership lock and the owner's calling card, next to the state. */
  lockPath: string;
  ownerPath: string;
  /** The private local endpoint the owner answers on. */
  socketPath: string;
  /** Repository .env files, first wins; the process environment beats both. */
  envFiles: string[];
}

export function factoryPaths(repo: string): FactoryPaths {
  const root = realpathOr(repo);
  const configDir = path.join(root, '.weawr');
  const stateDir = path.join(configDir, 'state');
  return {
    repo: root,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    localConfigPath: path.join(configDir, 'config.local.json'),
    stateDir,
    statePath: path.join(stateDir, 'state.json'),
    runsDir: path.join(stateDir, 'runs'),
    logDir: path.join(stateDir, 'logs'),
    logPath: path.join(stateDir, 'logs', 'weawr.log'),
    lockPath: path.join(stateDir, 'owner.lock'),
    ownerPath: path.join(stateDir, 'owner.json'),
    socketPath: socketPathFor(root, stateDir),
    envFiles: [path.join(root, '.env.local'), path.join(root, '.env')],
  };
}

/**
 * Unix socket paths are limited to ~104 bytes on macOS, and a repository can live anywhere, so the
 * socket goes under the user's own directory, named for the repository, unless the state directory
 * is short enough to hold it.
 */
function socketPathFor(repo: string, stateDir: string): string {
  const inState = path.join(stateDir, 'owner.sock');
  if (process.platform === 'win32') return `\\\\.\\pipe\\weawr-${shortHash(repo)}`;
  if (inState.length < 90) return inState;
  return path.join(os.tmpdir(), `weawr-${shortHash(repo)}.sock`);
}

/**
 * The repository that contains `cwd`, or `cwd` itself when it is not one. A linked worktree — the
 * kind weawr makes for a run — resolves to the main working tree, because the factory (its
 * `.weawr/`, its state) lives there: `weawr merge` and `weawr result` are run by agents from
 * inside their worktrees, and must find the factory that started them, not an empty one.
 */
export function findRepoRoot(cwd: string): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let top: string;
  try { top = git(['rev-parse', '--show-toplevel']); } catch { return cwd; }
  try {
    const common = path.resolve(cwd, git(['rev-parse', '--git-common-dir']));
    const main = path.dirname(common);
    if (path.basename(common) === '.git' && realpathOr(main) !== realpathOr(top)) return main;
  } catch { /* an older git, or a bare repository: the toplevel is what there is */ }
  return top;
}

/** Where per-user weawr files live: credentials, host id, factory registrations. */
export function userDir(): string {
  if (process.env.WEAWR_CREDENTIALS) return path.dirname(process.env.WEAWR_CREDENTIALS);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'weawr');
}

function realpathOr(p: string): string { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

export function shortHash(s: string, n = 8): string {
  // FNV-1a, 52 bits, base36: short, stable, dependency-free. Not a security boundary.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0; }
  return (h1.toString(36) + h2.toString(36)).slice(0, n);
}
