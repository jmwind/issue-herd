// Dependency assembly for one invocation: where the repository is, who this host is, the bundled
// prompts, herdr, the tracker, and how an engine is built and owned. Commands take a Context and
// nothing else path-shaped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TeamEngine, JsonStateStore, acquireOwnership, createApplication, currentOwner, describeHolder, teamId, teamPaths, findRepoRoot, hostId, loadConfig, loadEnvFiles, loadPlugins, migrateLegacyState, openOwnerStore, pluginSpecs, readTeamState, registrationsDir, storeStatus, userDir,
} from '@weawr/engine';
import type { Application, CommandResult, ConfigSources, TeamConfig, TeamPaths, Identities, Ownership, PluginRegistry, StateStore } from '@weawr/engine';
import { consoleNotesPath } from './commands/migrate.js';
import { Herdr } from '@weawr/engine/adapters/herdr.mjs';
import { resolveCredential, saveCredential, noCredentialError } from '@weawr/engine/adapters/auth.mjs';
import type { Command } from '@weawr/engine';
import { callOwner, serveIpc } from './transports/ipc.js';
import type { IpcServer } from './transports/ipc.js';
import type { Ui } from './ui.js';

declare const __WEAWR_VERSION__: string | undefined;

/**
 * Where this program's own files are: the assembled artifact keeps prompts/, config.example.json
 * and the web console next to itself, so nothing here reaches back into a source tree.
 */
export const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
// The version is stamped in at build time; a module run straight from the compiler's output falls
// back to the package it was built from.
export const VERSION: string = typeof __WEAWR_VERSION__ !== 'undefined' ? __WEAWR_VERSION__ : (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG_DIR, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
export const INSTALL_SPEC = 'github:jmwind/weawr';

/**
 * Where a runtime asset directory is. The assembled artifact keeps each next to itself; a module
 * run straight from the compiler's output (apps/cli/build — what `pnpm dev` runs, and therefore
 * the command its briefs tell agents to run) has none there and reads it from the source tree it
 * was built in. The fallback is what lets `weawr merge` work from an agent's shell, which carries
 * none of dev.mjs's environment. An environment variable still names another place outright.
 */
export function assetDir(name: string, fromSource: string, env: NodeJS.ProcessEnv = process.env, pkgDir: string = PKG_DIR): string {
  const named = env[`WEAWR_${name.toUpperCase()}_ROOT`];
  if (named) return named;
  const beside = path.join(pkgDir, name);
  if (fs.existsSync(beside)) return beside;
  const inSource = path.resolve(pkgDir, '..', fromSource);
  return fs.existsSync(inSource) ? inSource : beside;
}

export interface Context {
  ui: Ui;
  version: string;
  /** How a shell reaches this very weawr: `weawr` when that is what PATH resolves to, else the explicit command. What briefs tell agents to run. */
  cli: string;
  pkgDir: string;
  promptsRoot: string;
  /** The shipped example plugins. */
  pluginsRoot: string;
  /** The shipped demo scenarios and the starter app they work on. */
  demosRoot: string;
  webDir: string;
  paths: TeamPaths;
  sources: ConfigSources;
  userDir: string;
  ids: Identities;
  herdr: any;
  /** Load (or reload) the repository's config. Throws when there is none or it is invalid. Plugins must be loaded first (see plugins()). */
  config(): TeamConfig;
  /** The plugins the config names, loaded once per process. */
  plugins(): Promise<PluginRegistry>;
  hasConfig(): boolean;
  /** Load the repository's .env files into the process environment (tracker tokens only). */
  loadEnv(): void;
}

/**
 * The command that reaches this program from a shell. Agents are told to run `weawr merge` and
 * `weawr result`; a machine with a development build, or two installs, must have them run the
 * weawr that runs their team, so unless PATH resolves `weawr` to this very file the brief
 * carries the explicit command.
 */
export function cliCommand(argv1: string | undefined = process.argv[1], env: NodeJS.ProcessEnv = process.env): string {
  if (!argv1) return 'weawr';
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const self = real(argv1);
  const name = process.platform === 'win32' ? 'weawr.cmd' : 'weawr';
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const found = real(path.join(dir, name));
    if (!found) continue;
    return found === self ? 'weawr' : `${quote(process.execPath)} ${quote(argv1)}`;
  }
  return `${quote(process.execPath)} ${quote(argv1)}`;
}
const quote = (p: string) => (/[\s"']/.test(p) ? JSON.stringify(p) : p);

export function createContext({ ui, cwd = process.cwd() }: { ui: Ui; cwd?: string }): Context {
  const paths = teamPaths(findRepoRoot(cwd));
  // Next to the artifact; from the source tree when this is the compiler's output (see assetDir).
  const promptsRoot = assetDir('prompts', path.join('..', '..', 'packages', 'recipes', 'prompts'));
  const pluginsRoot = assetDir('plugins', 'plugins');
  const demosRoot = assetDir('demos', 'demos');
  const sources: ConfigSources = { paths, promptsRoot };
  const uDir = userDir();
  const host = hostId(uDir);
  const ids = { hostId: host, teamId: teamId(host, paths.repo) };
  let cfg: TeamConfig | null = null;
  let reg: Promise<PluginRegistry> | null = null;
  return {
    ui, version: VERSION, cli: cliCommand(), pkgDir: PKG_DIR, promptsRoot, pluginsRoot, demosRoot, webDir: process.env.WEAWR_WEB_DIR || path.join(PKG_DIR, 'web'), paths, sources, userDir: uDir, ids,
    herdr: new (Herdr as any)({ log: (m: string) => { if (process.env.WEAWR_DEBUG) ui.log('  $', m); } }),
    config() { return (cfg ??= loadConfig(sources)); },
    plugins() { return (reg ??= loadPlugins(pluginSpecs(paths), { examplesRoot: pluginsRoot, userRoot: path.join(uDir, 'plugins'), configDir: paths.configDir }).then((r) => { sources.plugins = r; cfg = null; return r; })); },
    hasConfig() { return fs.existsSync(paths.configPath); },
    loadEnv() {
      const refused = loadEnvFiles(paths.envFiles);
      if (refused.length) console.error(`weawr: ignoring ${refused.join(', ')} from the repository's .env — weawr's own settings come from your shell, not from a repository`);
    },
  };
}

/** The tracker config.json names, authenticated from the environment, the saved credential, or the tracker's own fallback. */
export function makeTracker(ctx: Context, cfg: TeamConfig): any {
  const { Tracker } = cfg;
  const options = { ...cfg.trackerSpec, cwd: ctx.paths.repo };
  const found = resolveCredential(Tracker, { options });
  if (!found) throw noCredentialError(Tracker);
  // a token the tracker refreshes itself goes back where it came from; env tokens are the user's to manage
  const onCredential = found.saved ? (cred: any) => saveCredential(Tracker.id, cred) : null;
  const tracker = new Tracker(found.credential, { options, onCredential });
  tracker.check?.();
  tracker.source = found.source;
  return tracker;
}

export interface EngineBuild { cfg: TeamConfig; tracker: any; dry?: boolean; ownership?: Ownership | null; register?: boolean }

/**
 * The store an engine uses. An owner gets the durable store — after migrating a legacy state.json
 * under its lock, once — and a reader gets a read-only view of whatever is there. A legacy file
 * that does not parse stops an owner with the reason, never as an empty team.
 */
export function storeFor(ctx: Context, ownership: Ownership | null): StateStore {
  const st = storeStatus(ctx.paths);
  if (ownership) {
    if (st.needsMigration) {
      const r = migrateLegacyState({ paths: ctx.paths, consoleNotesPath: consoleNotesPath() });
      if (r.migrated) ctx.ui.log(`migrated ${r.runs} run(s) and ${r.nudges} nudge record(s) from state.json into the durable store${r.backupDir ? ` (backup: ${r.backupDir})` : ''}`);
    }
    return openOwnerStore(ctx.paths);
  }
  const view = readTeamState(ctx.paths);
  if (view.corrupt) throw new Error(`${ctx.paths.statePath} is not valid JSON (${view.corrupt}); refusing to read it as an empty team`);
  if (view.store) return view.store;
  return new JsonStateStore(ctx.paths.statePath);
}

/** An engine for this repository, logging through the terminal, registered on this machine when it owns the team. */
export function makeEngine(ctx: Context, { cfg, tracker, dry = false, ownership = null, register = false }: EngineBuild): TeamEngine {
  return new TeamEngine({
    cfg, tracker, herdr: ctx.herdr, dry, paths: ctx.paths, promptsRoot: ctx.promptsRoot, ids: ctx.ids, version: ctx.version, cli: ctx.cli,
    store: storeFor(ctx, ownership),
    log: (line) => ctx.ui.print(line), live: (text) => ctx.ui.live(text),
    registration: register ? { dir: registrationsDir(ctx.userDir), socketPath: ctx.paths.socketPath, ownership } : null,
  });
}

/**
 * Become the team's owner for the rest of this process, or explain who already is. Every command
 * that schedules, mutates or reconciles goes through here.
 */
export function takeOwnership(ctx: Context, cfg: TeamConfig): Ownership {
  const r = acquireOwnership({ lockPath: ctx.paths.lockPath, ownerPath: ctx.paths.ownerPath, card: { teamId: ctx.ids.teamId, hostId: ctx.ids.hostId, startedAt: new Date().toISOString(), version: ctx.version, socketPath: ctx.paths.socketPath } });
  if (!r.ok) throw new Error(`${cfg.name} is already being watched: ${describeHolder(r.holder)}. Stop that watcher first, or work on it through it (weawr status, weawr reset <KEY>).`);
  const release = () => { try { r.ownership.release(); } catch { /* best effort */ } };
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { release(); process.exit(130); });
  return r.ownership;
}

/** Host the application on the owner's private socket. */
export async function hostApplication(ctx: Context, app: Application): Promise<IpcServer> {
  const server = await serveIpc(app, ctx.paths.socketPath, (m) => ctx.ui.log(m));
  // Only our own socket file: a successor may already be listening at that path (a restart).
  process.once('exit', () => server.removeIfOwn());
  return server;
}

/**
 * Dispatch a command to whoever should answer it: the running owner over its socket when there
 * is one, else `local(app)` — a fresh application over an engine this process built itself (for
 * a read, no ownership; for a mutation, the caller takes it first).
 */
export async function dispatchCommand(ctx: Context, cmd: Command, local: () => Promise<Application>): Promise<{ via: 'owner' | 'local'; result: CommandResult }> {
  const owner = currentOwner({ lockPath: ctx.paths.lockPath, ownerPath: ctx.paths.ownerPath });
  if (owner.owned && owner.holder?.socketPath) {
    const result = await callOwner(owner.holder.socketPath, cmd);
    // An owner that holds the lock but does not answer is a real situation (it is starting, or
    // wedged); say so rather than quietly acting behind its back.
    return { via: 'owner', result };
  }
  return { via: 'local', result: await (await local()).dispatch(cmd) };
}

export { createApplication };
