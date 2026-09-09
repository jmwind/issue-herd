// The factory's configuration: .weawr/config.json with .weawr/config.local.json layered over it,
// every rule expanded with the defaults, checked, and its match expression compiled. Everything
// path-shaped is resolved from a FactoryPaths, never from the process's own directory.
import fs from 'node:fs';
import path from 'node:path';
import { compile } from './expr.mjs';
import { mergeConfig, overridePaths } from './config-merge.mjs';
import { applyRoles, checkBasedOn, checkRoleBranches, normalizePasses, normalizeRole } from './claim.mjs';
import { DEFAULT_MAX_NUDGES, normalizeMaxNudges } from './nudge.mjs';
import { trackerClass, trackerSpec } from './adapters/trackers/index.mjs';
import { LATEST_REVISION, validateTemplate } from '@weawr/recipes';
import type { FactoryPaths } from './paths.js';
import { EMPTY_REGISTRY } from './plugins.js';
import type { PluginRegistry, PluginSpec } from './plugins.js';

export type EventPolicy = Record<string, any>;

export interface Rule {
  name: string;
  match: string;
  compiled: { test(issue: any, ctx: any): boolean };
  repo: string;
  role: string | null;
  passes: number;
  basedOn: string | null;
  enabled?: boolean;
  disabledReason?: string;
  worktree: 'self' | 'herdr' | 'none';
  worktreeDir: string;
  branch: string | null;
  permissionMode: string | null;
  agentKind: string;
  model: string | null;
  effort: string | null;
  agentArgs: string[];
  claudeArgs: string[];
  maxConcurrent: number;
  prompt: string;
  instructions: string;
  instructionsFile: string | null;
  claimLabel: string | null;
  skipIfAssignedToOthers: boolean;
  onPickup: EventPolicy; onDone: EventPolicy; onBlocked: EventPolicy; onIdle: EventPolicy; onMerged: EventPolicy;
  [k: string]: any;
}

export interface FactoryConfig {
  name: string;
  tracker: any;
  trackerSpec: { type: string; [k: string]: any };
  Tracker: any;
  pollSeconds: number;
  lookbackDays: number;
  maxConcurrent: number;
  roles: string[] | null;
  baseBranch: string | null;
  pullBase: boolean;
  maxNudges: number;
  defaults: Record<string, any>;
  rules: Rule[];
  localOverrides: string[];
  /** A fingerprint of the files the config was built from; see configStamp. */
  stamp: string;
  [k: string]: any;
}

export const DEFAULTS = {
  name: null as string | null, // what this watcher is called; its herdr workspace is labelled "<name>Watch". Default: the repo folder name
  tracker: 'linear' as any,    // "linear" | "github", or { "type": "github", "repo": "owner/name", … }; see adapters/trackers/
  pollSeconds: 30,
  lookbackDays: 30,
  maxConcurrent: 3,
  // Which claim roles this project runs, e.g. ["impl", "review"]. null means "whatever the rules
  // ask for"; a list switches on exactly those, so turning a role off is one line rather than
  // deleting the rules that use it. See claim.mjs.
  roles: null as string[] | null,
  // The branch runs are cut from, and the one the watcher's own checkout is kept on. null asks the
  // repository: origin/HEAD, else main or master.
  baseBranch: null as string | null,
  // Fast-forward this checkout onto `baseBranch` when a run is picked up and when a pull request
  // from one is merged. Only ever forwards, only when the checkout is clean and standing on that branch.
  pullBase: true,
  // How many times, per issue, one role may nudge another before the watcher asks a person in. 0 turns it off.
  maxNudges: DEFAULT_MAX_NUDGES,
  // The label on an issue that authorises `weawr merge` (recipe revision 2 and later): a person
  // puts it there, weawr checks it is still there when the merge is asked for.
  mergeLabel: 'auto-merge',
  // How `weawr merge` merges: "squash" | "merge" | "rebase". Repository protections still apply.
  mergeMethod: 'squash',
  defaults: {
    worktree: 'self',                 // who creates the worktree: "self" (weawr), "herdr", or "none" (run in this checkout)
    worktreeDir: '.weawr/worktrees',  // where "self" puts them, relative to the repo (gitignored)
    branch: '{{issueBranchName}}{{roleSuffix}}', // the run's branch, a template; null accepts whatever the tool named it
    permissionMode: 'auto',           // claude --permission-mode: auto (unattended), acceptEdits, plan, …
    agentKind: 'claude',              // `herdr agent start --kind`; herdr is the authority on which agents exist
    model: null,
    effort: null,
    agentArgs: [],                    // extra flags, passed to the agent verbatim, after everything above
    claudeArgs: [],                   // the old name for agentArgs, still honoured
    maxConcurrent: 2,
    prompt: 'prompts/default.md',     // repo override in .weawr/prompts/, else the package's
    instructions: '',                 // inline text appended to the brief …
    instructionsFile: 'instructions.md', // … or a markdown file in .weawr/ (both are included if present)
    claimLabel: 'herdr',              // added to the issue at pickup and checked before; a restart or a second machine cannot take it again
    role: null,                       // null is the old, exclusive claim; a role scopes the label, the comment and the run key
    passes: 1,                        // how many turns this rule may take on one issue
    basedOn: null,                    // whose branch this rule's worktree starts from: another role's name
    skipIfAssignedToOthers: true,
    onPickup: { comment: true, state: 'In Progress', assignToMe: true },
    onDone: { comment: true, state: 'In Review', notify: true, closeWorkspace: false },
    onBlocked: { comment: true, notify: true },
    onIdle: { comment: true, notify: true },
    // A merged PR ends a run. Nothing is torn down unless asked: "onMerged": { "exitAgent": true, "closeWorkspace": true, "removeWorktree": true }
    onMerged: { comment: false, notify: true, exitAgent: false, closeWorkspace: false, removeWorktree: false },
  } as Record<string, any>,
  rules: [] as any[],
};

const WORKTREE_MODES = new Set(['self', 'herdr', 'none']);
export const EVENTS = ['onPickup', 'onDone', 'onBlocked', 'onIdle', 'onMerged'] as const;

export interface ConfigSources {
  paths: FactoryPaths;
  /** Where the bundled prompts live (the CLI's own prompts/ directory, with one subdirectory per recipe revision). */
  promptsRoot: string;
  /** The recipe revision this factory is pinned to; the latest bundled one when not given. */
  recipeRevision?: number;
  /** What the plugins named in the config provide (see plugins.ts). Loaded by the caller: config loading stays synchronous. */
  plugins?: PluginRegistry;
}

/** The plugin specs a config names: committed ones and per-machine ones, each knowing where it came from. */
export function pluginSpecs(paths: FactoryPaths): PluginSpec[] {
  const read = (p: string) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const out: PluginSpec[] = [];
  for (const s of read(paths.configPath)?.plugins || []) if (typeof s === 'string') out.push({ spec: s, source: 'config' });
  for (const s of read(paths.localConfigPath)?.plugins || []) if (typeof s === 'string') out.push({ spec: s, source: 'local' });
  return out;
}

/**
 * Resolve a path named by config (`prompt`, `instructionsFile`): under <repo>/.weawr first, then
 * the bundled prompts directory. Confined on purpose: config.json is committed, so the repository
 * you run in chooses these values, and whatever they name is pasted into the brief an unattended
 * agent follows. An absolute path or a leading ~ would let a repository copy your credentials file
 * into the working tree the agent commits from.
 */
export function expandConfigPath(sources: ConfigSources, p: string, revision: number = sources.recipeRevision ?? LATEST_REVISION): string {
  const { configDir, repo } = sources.paths;
  const inRepo = path.resolve(configDir, p);
  if (inRepo !== configDir && !inRepo.startsWith(configDir + path.sep)) {
    throw new Error(`config path "${p}" must stay inside ${path.relative(repo, configDir)}/`);
  }
  if (fs.existsSync(inRepo)) return inRepo;
  // Bundled prompts are addressed as "prompts/<file>", the layout they have always had; on disk
  // every recipe revision is kept, and the factory's pinned one is the one that answers.
  const rel = p.replace(/^prompts[\\/]/, '');
  const inPkg = path.resolve(sources.promptsRoot, String(revision), rel);
  if (inPkg.startsWith(sources.promptsRoot + path.sep) && fs.existsSync(inPkg)) return inPkg;
  // Files that are not per-revision (the scaffold instructions) live at the root of the bundle.
  const atRoot = path.resolve(sources.promptsRoot, rel);
  if (atRoot.startsWith(sources.promptsRoot + path.sep) && fs.existsSync(atRoot)) return atRoot;
  return inRepo;
}

/** Whether a rule's template comes from the repository (custom) or the bundled recipe. */
export function templateOrigin(sources: ConfigSources, p: string): 'repository' | 'bundled' | 'missing' {
  const inRepo = path.resolve(sources.paths.configDir, p);
  if (fs.existsSync(inRepo)) return 'repository';
  return fs.existsSync(expandConfigPath(sources, p)) ? 'bundled' : 'missing';
}

function readInstructions(sources: ConfigSources, file: string | null): string {
  if (!file) return '';
  const p = expandConfigPath(sources, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

export function loadConfig(sources: ConfigSources): FactoryConfig {
  const { paths } = sources;
  if (!fs.existsSync(paths.configPath)) throw new Error(`no config at ${paths.configPath}`);
  const readConfigFile = (p: string) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e: any) { throw new Error(`${path.relative(paths.repo, p)} is not valid JSON: ${e.message}`); } };
  const local = fs.existsSync(paths.localConfigPath) ? readConfigFile(paths.localConfigPath) : null;
  const raw = mergeConfig(readConfigFile(paths.configPath), local);
  const cfg: any = { ...DEFAULTS, ...raw, defaults: { ...DEFAULTS.defaults, ...(raw.defaults || {}) } };
  cfg.localOverrides = overridePaths(local);
  cfg.name = String(cfg.name || path.basename(paths.repo)).trim() || 'weawr';
  cfg.maxNudges = normalizeMaxNudges(cfg.maxNudges, path.relative(paths.repo, paths.configPath));
  const plugins = sources.plugins ?? EMPTY_REGISTRY;
  cfg.trackerSpec = trackerSpec(cfg.tracker);
  // A tracker from a plugin, else a built-in one; an id nobody provides names the plugin problem when there is one.
  if (Object.hasOwn(plugins.trackers, cfg.trackerSpec.type)) cfg.Tracker = plugins.trackers[cfg.trackerSpec.type];
  else {
    try { cfg.Tracker = trackerClass(cfg.trackerSpec); }
    catch (e: any) { throw new Error(`${e.message}${plugins.problems.length ? `; plugins: ${plugins.problems.join('; ')}` : ''}${raw.plugins?.length && !plugins.plugins.length ? ' (the plugins named in config.json are not enabled on this machine; see docs/plugins.md)' : ''}`); }
  }
  cfg.plugins = plugins;
  cfg.rules = (raw.rules || []).map((r: any, i: number) => {
    if (!r.match) throw new Error(`rule #${i + 1} (${r.name || 'unnamed'}) has no "match"`);
    // `use` names a role preset a plugin provides: its defaults under the rule's own fields, its brief as the prompt.
    let preset: any = null;
    if (r.use !== undefined) {
      if (typeof r.use !== 'string' || !Object.hasOwn(plugins.roles, r.use)) throw new Error(`rule #${i + 1} (${r.name || 'unnamed'}): "use" is ${JSON.stringify(r.use)}, which no enabled plugin provides as a role preset${Object.keys(plugins.roles).length ? ` (have: ${Object.keys(plugins.roles).join(', ')})` : ''}${plugins.problems.length ? `; plugins: ${plugins.problems.join('; ')}` : ''}`);
      preset = plugins.roles[r.use];
    }
    const rule: any = { ...cfg.defaults, ...(preset?.defaults || {}), ...(preset ? { role: r.use } : {}), ...r, name: r.name || `rule-${i + 1}`, repo: paths.repo };
    if (preset) { rule.promptText = preset.prompt; rule.prompt = `plugin:${preset.plugin}/${r.use}`; rule.templateOrigin = `plugin:${preset.plugin}${preset.version ? `@${preset.version}` : ''}`; }
    rule.role = normalizeRole(rule.role, `rule "${rule.name}"`);
    rule.passes = normalizePasses(rule.passes, `rule "${rule.name}"`);
    rule.basedOn = normalizeRole(rule.basedOn, `rule "${rule.name}" ("basedOn")`);
    if (rule.basedOn && rule.basedOn === rule.role) throw new Error(`rule "${rule.name}": "basedOn" is its own role (${rule.role}) — a worktree cannot start from itself`);
    // Only "self" mode creates the worktree, so only "self" mode can decide where it starts.
    if (rule.basedOn && rule.worktree !== 'self') throw new Error(`rule "${rule.name}": "basedOn" needs "worktree": "self" (weawr creates the worktree, so it can start it from another role's branch); this rule is ${JSON.stringify(rule.worktree)}`);
    for (const k of EVENTS) {
      // `"onMerged": null` (or false) — in the rule or in the defaults — turns that step off entirely.
      const own = k in r ? r[k] : cfg.defaults[k];
      rule[k] = !own ? {} : { ...(cfg.defaults[k] || {}), ...own };
    }
    if (!WORKTREE_MODES.has(rule.worktree)) {
      throw new Error(`rule "${rule.name}": unknown worktree mode ${JSON.stringify(rule.worktree)} — use "self" (weawr creates it), "herdr", or "none"`);
    }
    try { rule.compiled = compile(rule.match); } catch (e: any) { throw new Error(`rule "${rule.name}": ${e.message}`); }
    rule.instructions = [rule.instructions, readInstructions(sources, rule.instructionsFile)].filter(Boolean).join('\n\n');
    // The template is checked here, where the fix is one file away, not at 3am when a brief
    // renders with a hole in it. A disabled rule's template is still checked: it is still a rule.
    if (rule.promptText) {
      const check = validateTemplate(rule.promptText);
      if (!check.ok) throw new Error(`rule "${rule.name}": the preset's brief: ${check.problems.join('; ')}`);
      rule.templateProtocol = check.protocol;
    } else if (rule.prompt) {
      const origin = templateOrigin(sources, rule.prompt);
      if (origin === 'missing') throw new Error(`rule "${rule.name}": prompt ${JSON.stringify(rule.prompt)} is not a file in ${path.relative(paths.repo, paths.configDir)}/ or in the bundled recipe`);
      const check = validateTemplate(fs.readFileSync(expandConfigPath(sources, rule.prompt), 'utf8'));
      if (!check.ok) throw new Error(`rule "${rule.name}": prompt ${JSON.stringify(rule.prompt)}${origin === 'repository' ? '' : ' (bundled)'}: ${check.problems.join('; ')}`);
      rule.templateOrigin = origin; rule.templateProtocol = check.protocol;
    }
    return rule as Rule;
  });
  cfg.mergeLabel = String(cfg.mergeLabel || '').trim() || null;
  if (!['squash', 'merge', 'rebase'].includes(cfg.mergeMethod)) throw new Error(`"mergeMethod" must be "squash", "merge" or "rebase", not ${JSON.stringify(cfg.mergeMethod)}`);
  checkBasedOn(checkRoleBranches(applyRoles(cfg.rules, cfg.roles)));
  cfg.stamp = configStamp(sources, cfg);
  return cfg as FactoryConfig;
}

/**
 * A fingerprint of every file the config is built from: config.json, config.local.json (present
 * or not) and each rule's instructions file. The watcher compares it before every poll and
 * reloads when it changes, so editing a rule takes effect without a restart.
 */
export function configStamp(sources: ConfigSources, cfg: { rules: Array<{ instructionsFile?: string | null }> }): string {
  const files = new Set([sources.paths.configPath, sources.paths.localConfigPath]);
  for (const r of cfg.rules) if (r.instructionsFile) files.add(expandConfigPath(sources, r.instructionsFile));
  return [...files].map((f) => { try { const st = fs.statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return `${f}:missing`; } }).join('|');
}

/**
 * Load the repository's .env files into `env` (first file wins; what is already set beats both).
 * A repository's .env may carry the tracker's token; it may NOT carry weawr's own settings —
 * WEAWR_CREDENTIALS would move where tokens are written and read, WEAWR_GITHUB_HOST where they are
 * sent, and a .env is committed. Returns the names that were refused.
 */
export function loadEnvFiles(files: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const refused: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (/^WEAWR_/.test(m[1])) { refused.push(m[1]); continue; }
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (env[m[1]] === undefined) env[m[1]] = v;
    }
  }
  return refused;
}
