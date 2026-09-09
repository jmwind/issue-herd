// Plugins: how weawr is extended without a fork.
//
// A plugin is an ES module whose default export declares what it provides — nothing more:
//
//   export default {
//     name: 'my-plugin', version: '1.0.0', api: 1,
//     intake: [FileTracker],               // tracker classes on the contract in adapters/tracker.mjs
//     roles: { docs: { prompt, defaults } }, // role presets a rule can `use`
//     tasks: [{ name, every, run }],        // scheduled work, run on the watcher's cadence when due
//   };
//
// Three seams, each an existing one: intake is the tracker seam (`"tracker": "<id>"` in
// config.json), a role preset is a rule with its brief and defaults filled in (`"use": "<name>"`),
// and a scheduled task is a function the owner calls with a snapshot and a way to notify.
//
// Where a plugin may come from is deliberate. A plugin is code the watcher runs, and config.json is
// committed — a repository you clone must not get to run code on your machine by naming a file.
// So: a *path* is honoured only from .weawr/config.local.json (yours, gitignored); a bare *name*
// resolves to a shipped example (`examples/<name>`) or to a package you installed yourself under
// ~/.config/weawr/plugins/node_modules/<name>.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTemplate } from '@weawr/recipes';

export const PLUGIN_API = 1;

export interface RolePreset {
  /** The brief template this role uses (checked like any template). */
  prompt: string;
  /** Rule fields the preset fills in; the rule's own fields win. */
  defaults?: Record<string, unknown>;
  /** One line for `weawr plugins`. */
  summary?: string;
}

export interface TaskContext {
  factory: { id: string; name: string; repo: string };
  /** The factory's canonical snapshot at the moment the task runs. */
  snapshot: any;
  log: (line: string) => void;
  notify: (title: string, body: string) => Promise<void>;
  now: Date;
  /** What this task returned last time, if anything: for tasks that must not repeat themselves. */
  memory: Record<string, unknown>;
}

export interface ScheduledTask {
  name: string;
  /** "30s", "10m", "2h", "1d" */
  every: string;
  run: (ctx: TaskContext) => Promise<unknown> | unknown;
  summary?: string;
}

export interface PluginModule {
  name: string;
  version?: string;
  api?: number;
  intake?: any[];
  roles?: Record<string, RolePreset>;
  tasks?: ScheduledTask[];
}

export interface LoadedPlugin { name: string; version: string | null; from: string; spec: string; provides: { intake: string[]; roles: string[]; tasks: string[] } }

export interface PluginRegistry {
  plugins: LoadedPlugin[];
  trackers: Record<string, any>;
  roles: Record<string, RolePreset & { plugin: string; version: string | null }>;
  tasks: Array<ScheduledTask & { plugin: string; everyMs: number }>;
  problems: string[];
}

export interface PluginSpec { spec: string; source: 'config' | 'local' }

export interface PluginSources {
  /** Where the shipped examples live: <pkgDir>/plugins. */
  examplesRoot: string | null;
  /** The user's own installs: ~/.config/weawr/plugins. */
  userRoot: string | null;
  /** The repository's .weawr directory, for local paths. */
  configDir: string;
}

export const EMPTY_REGISTRY: PluginRegistry = { plugins: [], trackers: {}, roles: {}, tasks: [], problems: [] };

/** "30s" | "10m" | "2h" | "1d" → milliseconds. Throws on anything else. */
export function parseEvery(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(s).trim());
  if (!m) throw new Error(`"every" must look like 30s, 10m, 2h or 1d, not ${JSON.stringify(s)}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** Where a plugin spec resolves to, or why it does not. */
export function resolvePlugin(spec: PluginSpec, sources: PluginSources): { file: string; from: string } | { error: string } {
  const s = spec.spec;
  if (s.startsWith('.') || path.isAbsolute(s)) {
    if (spec.source !== 'local') return { error: `plugin ${JSON.stringify(s)} is a path, and a path is only honoured from .weawr/config.local.json (a committed config must not run code from a clone); put it there, or ship it as a named package` };
    const file = path.resolve(sources.configDir, s);
    return fs.existsSync(file) ? { file, from: 'config.local.json' } : { error: `plugin ${JSON.stringify(s)}: no file at ${file}` };
  }
  if (s.startsWith('examples/')) {
    const name = s.slice('examples/'.length).replace(/\.mjs$/, '');
    const file = sources.examplesRoot ? path.join(sources.examplesRoot, `${name}.mjs`) : null;
    if (file && fs.existsSync(file)) return { file, from: 'shipped example' };
    return { error: `no shipped example plugin called ${JSON.stringify(name)}${sources.examplesRoot && fs.existsSync(sources.examplesRoot) ? ` (have: ${fs.readdirSync(sources.examplesRoot).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')).join(', ')})` : ''}` };
  }
  if (sources.userRoot) {
    const dir = path.join(sources.userRoot, 'node_modules', s);
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const entry = path.join(dir, (j.exports && typeof j.exports === 'string') ? j.exports : j.module || j.main || 'index.mjs');
      if (fs.existsSync(entry)) return { file: entry, from: `~/.config/weawr/plugins (${j.version || '?'})` };
      return { error: `plugin ${s}: ${entry} does not exist` };
    }
  }
  return { error: `plugin ${JSON.stringify(s)} is not installed: put it in ${sources.userRoot ? path.join(sources.userRoot, 'node_modules') : '~/.config/weawr/plugins/node_modules'} (npm install --prefix ~/.config/weawr/plugins ${s}), or name a shipped example (examples/<name>)` };
}

/** Load every plugin named, collecting what they provide. Problems are named, never fatal at once: the caller decides. */
export async function loadPlugins(specs: PluginSpec[], sources: PluginSources): Promise<PluginRegistry> {
  const reg: PluginRegistry = { plugins: [], trackers: {}, roles: {}, tasks: [], problems: [] };
  for (const spec of specs) {
    const where = resolvePlugin(spec, sources);
    if ('error' in where) { reg.problems.push(where.error); continue; }
    let mod: any;
    try { mod = (await import(pathToFileURL(where.file).href)).default; } catch (e: any) { reg.problems.push(`plugin ${spec.spec}: could not load ${where.file}: ${e.message}`); continue; }
    if (!mod || typeof mod !== 'object' || typeof mod.name !== 'string') { reg.problems.push(`plugin ${spec.spec}: the module's default export must be { name, … }`); continue; }
    const api = mod.api ?? 1;
    if (api > PLUGIN_API) { reg.problems.push(`plugin ${mod.name} needs plugin API ${api}; this weawr provides ${PLUGIN_API} — upgrade weawr`); continue; }
    const loaded: LoadedPlugin = { name: mod.name, version: mod.version ?? null, from: where.from, spec: spec.spec, provides: { intake: [], roles: [], tasks: [] } };
    for (const T of mod.intake || []) {
      if (typeof T !== 'function' || typeof T.id !== 'string') { reg.problems.push(`plugin ${mod.name}: an intake entry is not a tracker class with a static id`); continue; }
      for (const m of ['me', 'openIssues', 'issueByKey', 'comment', 'addLabel', 'removeLabel', 'assign', 'setState']) if (typeof T.prototype?.[m] !== 'function') reg.problems.push(`plugin ${mod.name}: tracker ${T.id} lacks ${m}()`);
      if (reg.trackers[T.id]) reg.problems.push(`plugin ${mod.name}: tracker id ${T.id} is already provided by another plugin`);
      T.plugin = mod.name;
      reg.trackers[T.id] = T; loaded.provides.intake.push(T.id);
    }
    for (const [role, preset] of Object.entries<any>(mod.roles || {})) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(role)) { reg.problems.push(`plugin ${mod.name}: role preset ${JSON.stringify(role)} must be lower-case letters, digits, - or _`); continue; }
      if (!preset || typeof preset.prompt !== 'string') { reg.problems.push(`plugin ${mod.name}: role preset ${role} needs a prompt (the brief's text)`); continue; }
      const check = validateTemplate(preset.prompt);
      if (!check.ok) { reg.problems.push(`plugin ${mod.name}: role preset ${role}: ${check.problems.join('; ')}`); continue; }
      reg.roles[role] = { ...preset, plugin: mod.name, version: mod.version ?? null }; loaded.provides.roles.push(role);
    }
    for (const t of mod.tasks || []) {
      if (!t || typeof t.name !== 'string' || typeof t.run !== 'function') { reg.problems.push(`plugin ${mod.name}: a task needs a name and a run()`); continue; }
      let everyMs: number;
      try { everyMs = parseEvery(t.every); } catch (e: any) { reg.problems.push(`plugin ${mod.name}: task ${t.name}: ${e.message}`); continue; }
      reg.tasks.push({ ...t, plugin: mod.name, everyMs }); loaded.provides.tasks.push(t.name);
    }
    reg.plugins.push(loaded);
  }
  return reg;
}
