// `weawr demo`: a team to try weawr on, end to end, against a repository that exists for that.
//
// A scenario is data (apps/cli/demos/<name>/): a team config, the briefs and instructions it
// needs, and the issues to file. `weawr demo <scenario>` clones the demo repository into a team
// directory, gives it the starter codebase the first time, writes the scenario's `.weawr/` into
// the clone, files the issues on GitHub and remembers them in a ledger; you then run the watcher
// (or `pnpm dev`) on that directory and watch. `weawr demo reset` closes what the ledger lists —
// issues, their pull requests and branches — and clears the local state, so the next run starts
// clean. Nothing here touches an issue the ledger does not name unless `--all --yes` says so.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentOwner, describeHolder, teamId, teamPaths, loadConfig, readTeamState, registrationsDir, removeRegistration } from '@weawr/engine';
import type { TeamPaths } from '@weawr/engine';
import { GitHubTracker } from '@weawr/engine/adapters/trackers/github.mjs';
import { resolveCredential, noCredentialError } from '@weawr/engine/adapters/auth.mjs';
import type { Context } from '../context.js';

export const DEMO_REPO = 'jmwind/weawr-demo';
const LEDGER = 'demo.json';
const EXCLUDE = '# weawr demo: the scenario lives in the clone, not in the repository\n.weawr/\n';

export interface DemoIssue { title: string; body: string; labels: string[] }
export interface Scenario {
  name: string;
  dir: string;
  title: string;
  summary: string;
  description: string;
  labels: string[];
  config: Record<string, any>;
  issues: DemoIssue[];
}
export interface Ledger {
  scenario: string;
  repo: string;
  createdAt: string;
  issues: Array<{ number: number; title: string; url: string }>;
}
interface Opts { into: string | null; repo: string; dryRun: boolean; yes: boolean; all: boolean; keepCode: boolean }

/** The scenarios that ship: every directory under `root` with a scenario.json. */
export function listScenarios(root: string): Scenario[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'scenario.json'))).sort().map((name) => {
    const dir = path.join(root, name);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
    return { name, dir, title: s.title, summary: s.summary, description: s.description, labels: s.labels || [], config: s.config, issues: s.issues || [] };
  });
}

/** Where a demo team lives unless `--into` says otherwise: one directory per demo repository, per user. */
export function defaultDemoDir(userDir: string, repo: string): string { return path.join(userDir, 'demos', repo.split('/')[1]); }

export function parseOpts(args: string[]): Opts {
  const opts: Opts = { into: null, repo: DEMO_REPO, dryRun: false, yes: false, all: false, keepCode: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--into') { opts.into = args[++i] || null; if (!opts.into) throw new Error('--into needs a directory'); }
    else if (a === '--repo') { opts.repo = args[++i] || ''; if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error('--repo needs owner/name'); }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--keep-code') opts.keepCode = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
  }
  return opts;
}

export async function demo(ctx: Context, args: string[]): Promise<void> {
  const scenarios = listScenarios(ctx.demosRoot);
  const sub = args[0];
  if (!sub || sub === 'list' || sub === '--help') {
    console.log(`weawr demo <scenario> [--into DIR] [--repo owner/name] [--dry-run]   set a demo team up and file its issues`);
    console.log(`weawr demo reset [--into DIR] [--repo owner/name] [--keep-code] [--all --yes]  close what the last demo filed, put the app back to the starter, clear the local state\n`);
    for (const s of scenarios) console.log(`${s.name.padEnd(10)} ${s.title}\n${' '.repeat(11)}${s.summary}\n`);
    console.log(`the demo repository is ${DEMO_REPO}; a team directory is made under ${defaultDemoDir(ctx.userDir, DEMO_REPO)} unless --into says where`);
    return;
  }
  const opts = parseOpts(args.slice(1));
  if (sub === 'reset') return reset(ctx, opts);
  const scenario = scenarios.find((s) => s.name === sub);
  if (!scenario) throw new Error(`no demo scenario "${sub}" — \`weawr demo list\` shows ${scenarios.map((s) => s.name).join(', ')}`);
  return setup(ctx, scenario, opts);
}

/** The GitHub tracker for the demo repository, authenticated the way every command is (env, saved token, `gh`). */
function githubFor(repo: string, cwd: string): any {
  const options = { type: 'github', repo, cwd };
  const found = resolveCredential(GitHubTracker, { options });
  if (!found) throw noCredentialError(GitHubTracker);
  const t = new (GitHubTracker as any)(found.credential, { options });
  t.check();
  return t;
}

async function setup(ctx: Context, scenario: Scenario, opts: Opts): Promise<void> {
  const dir = opts.into || defaultDemoDir(ctx.userDir, opts.repo);
  const log = (m: string) => ctx.ui.log(m);
  log(`${scenario.title}\n${scenario.description}\n`);
  if (opts.dryRun) {
    log(`would clone https://github.com/${opts.repo} into ${dir} (or reuse the clone there), push the starter app if the repository has none,`);
    log(`write the scenario's .weawr/ (${scenario.config.rules.length} rule(s), roles ${JSON.stringify(scenario.config.roles)}), make sure the labels ${scenario.labels.join(', ')} exist, and file:`);
    for (const i of scenario.issues) log(`  - ${i.title}  [${i.labels.join(', ')}]`);
    return;
  }
  ensureClone(dir, opts.repo, log);
  const paths = teamPaths(dir);
  const owner = currentOwner(paths);
  if (owner.owned) log(`note: a watcher owns this team (${describeHolder(owner.holder)}); it will see the new config and issues as it polls`);
  pushStarter(dir, path.join(ctx.demosRoot, 'starter'), log);
  writeScenario(paths, scenario, opts.repo);
  // The config the scenario wrote has to load here, with these prompts, before anything is filed.
  loadConfig({ paths, promptsRoot: ctx.promptsRoot });
  const tracker = githubFor(opts.repo, dir);
  for (const label of scenario.labels) await tracker.ensureLabel(label);
  const ledger = readLedger(paths) || { scenario: scenario.name, repo: opts.repo, createdAt: new Date().toISOString(), issues: [] };
  if (ledger.issues.length) log(`the ledger already lists ${ledger.issues.length} issue(s) from an earlier "${ledger.scenario}" run; \`weawr demo reset\` closes them. Filing the new ones as well.`);
  ledger.scenario = scenario.name; ledger.repo = opts.repo;
  for (const filed of await fileIssues(tracker, scenario.issues)) { ledger.issues.push(filed); log(`filed #${filed.number}: ${filed.title}\n  ${filed.url}`); }
  writeLedger(paths, ledger);
  log(`\nready in ${dir}\n  cd ${dir} && weawr            the watcher, on this team\n  weawr console                   the team room (from anywhere)\n  WEAWR_DEV_TEAM=${dir} pnpm dev   the same, from a weawr checkout, on the development build\n  weawr demo reset --into ${dir}    when you are done: close the issues and PRs, clear the state`);
}

/** Clone the demo repository, or make sure the directory already is a clone of it. */
export function ensureClone(dir: string, repo: string, log: (m: string) => void): void {
  const url = `https://github.com/${repo}.git`;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    log(`cloning ${url} into ${dir}`);
    execFileSync('git', ['clone', '-q', url, dir], { stdio: ['ignore', 'inherit', 'inherit'] });
    useGhCredentials(dir);
    return;
  }
  const origin = git(dir, ['remote', 'get-url', 'origin']).trim();
  if (!originMatches(origin, repo)) throw new Error(`${dir} is a clone of ${origin}, not of ${repo}; pick another --into`);
  useGhCredentials(dir);
  const dirty = git(dir, ['status', '--porcelain']).trim();
  if (dirty) { log(`${dir} has local changes; leaving it as it is`); return; }
  try { git(dir, ['pull', '-q', '--ff-only']); } catch (e: any) { log(`could not fast-forward ${dir} (${e.message.split('\n')[0]}); leaving it as it is`); }
}

/**
 * Pushes from the clone — the starter now, the agents' branches later — go over HTTPS, and outside
 * a terminal git has nobody to ask for a password. `gh` is logged in (it is where the token comes
 * from), and it is a credential helper; the clone (and every worktree cut from it) uses it.
 */
function useGhCredentials(dir: string): void {
  try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); } catch { return; }
  try { if (git(dir, ['config', '--local', '--get', 'credential.helper']).trim()) return; } catch { /* none set */ }
  git(dir, ['config', '--local', 'credential.helper', '!gh auth git-credential']);
}

function originMatches(origin: string, repo: string): boolean {
  const norm = origin.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  return norm.endsWith(`/${repo}`) || norm === repo || norm === `https://github.com/${repo}`;
}

/** The demo repository starts as a README; the issues need code. Commit the starter app and push it. */
export function pushStarter(dir: string, starter: string, log: (m: string) => void): void {
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    log(`the repository has no code yet; adding the starter app (tally) and pushing it to its default branch`);
    fs.cpSync(starter, dir, { recursive: true });
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.name=weawr demo', '-c', 'user.email=weawr-demo@users.noreply.github.com', 'commit', '-q', '-m', 'Starter: tally, the app the weawr demos work on']);
  }
  // Committed here but not there yet — this run, or one whose push failed.
  let ahead = '';
  try { ahead = git(dir, ['rev-list', '@{upstream}..HEAD']).trim(); } catch { ahead = 'no upstream'; }
  if (ahead) { log('pushing the starter app'); git(dir, ['push', '-q', '-u', 'origin', 'HEAD']); }
}

/**
 * Put the app back to the starter: a demo that merged a feature has changed `main`, and the next
 * scenario's issues describe the starter. A new commit that restores the starter's files, so
 * history stays and nothing is force-pushed; nothing to commit when `main` already is the starter.
 */
export function restoreStarter(dir: string, starter: string, log: (m: string) => void): void {
  const branch = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '') || 'main';
  try { git(dir, ['checkout', '-q', branch]); git(dir, ['pull', '-q', '--ff-only']); } catch (e: any) { log(`could not bring ${branch} up to date (${e.message.split('\n')[0]}); leaving the code as it is`); return; }
  git(dir, ['rm', '-rq', '--cached', '.']);
  for (const f of git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  fs.cpSync(starter, dir, { recursive: true });
  git(dir, ['add', '-A']);
  if (!git(dir, ['status', '--porcelain']).trim()) { log(`${branch} is the starter already`); return; }
  git(dir, ['-c', 'user.name=weawr demo', '-c', 'user.email=weawr-demo@users.noreply.github.com', 'commit', '-q', '-m', 'Demo reset: the app back to the starter']);
  git(dir, ['push', '-q', 'origin', branch]);
  log(`${branch} put back to the starter (a new commit; the demo's merges stay in history)`);
}

/** Write the scenario's `.weawr/` into the clone: config, instructions, briefs, and the ignore rules that keep it out of the repository. */
export function writeScenario(paths: TeamPaths, scenario: Scenario, repo: string): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  const cfg = { tracker: { type: 'github', repo }, ...scenario.config };
  fs.writeFileSync(paths.configPath, JSON.stringify(cfg, null, 2) + '\n');
  for (const f of fs.readdirSync(scenario.dir)) {
    if (f === 'scenario.json') continue;
    fs.cpSync(path.join(scenario.dir, f), path.join(paths.configDir, f), { recursive: true });
  }
  fs.writeFileSync(path.join(paths.configDir, '.gitignore'), 'state/\nconfig.local.json\nworktrees/\n');
  const exclude = path.join(paths.repo, '.git', 'info', 'exclude');
  try {
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.weawr/')) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + EXCLUDE); }
  } catch { /* not a git checkout (tests); the .gitignore inside .weawr still holds */ }
}

/** File the scenario's issues; returns what was made, in order. */
export async function fileIssues(tracker: any, issues: DemoIssue[]): Promise<Ledger['issues']> {
  const made: Ledger['issues'] = [];
  for (const i of issues) {
    const r = await tracker.rest('POST', '/issues', { title: i.title, body: i.body, labels: i.labels });
    made.push({ number: r.number, title: i.title, url: r.html_url });
  }
  return made;
}

export function readLedger(paths: TeamPaths): Ledger | null {
  try { return JSON.parse(fs.readFileSync(path.join(paths.configDir, LEDGER), 'utf8')); } catch { return null; }
}
function writeLedger(paths: TeamPaths, ledger: Ledger): void { fs.writeFileSync(path.join(paths.configDir, LEDGER), JSON.stringify(ledger, null, 2) + '\n'); }

async function reset(ctx: Context, opts: Opts): Promise<void> {
  const dir = opts.into || defaultDemoDir(ctx.userDir, opts.repo);
  const log = (m: string) => ctx.ui.log(m);
  if (!fs.existsSync(dir)) throw new Error(`no demo team at ${dir} (nothing to reset; --into names another directory)`);
  const paths = teamPaths(dir);
  const ledger = readLedger(paths);
  if (!ledger && !opts.all) { log(`no ledger in ${paths.configDir}: nothing was filed from here. \`--all --yes\` closes every open issue labelled ai in ${opts.repo}, every open PR, and every branch but the default one.`); return; }
  if (opts.all && !opts.yes) throw new Error(`--all closes every open issue labelled ai, every open PR and every branch but the default one in ${opts.repo}; say --yes to mean it`);
  const owner = currentOwner(paths);
  if (owner.owned) throw new Error(`a watcher owns this team (${describeHolder(owner.holder)}); stop it first, then reset`);
  const repo = ledger?.repo || opts.repo;
  if (opts.dryRun) {
    log(`would close ${ledger ? ledger.issues.map((i) => `#${i.number}`).join(', ') : 'every open ai issue'} in ${repo}, their PRs and branches, and set ${paths.stateDir} aside`);
    return;
  }
  const tracker = githubFor(repo, dir);
  const closed = await resetRemote(tracker, ledger, { all: opts.all, log });
  log(`closed ${closed.issues} issue(s), ${closed.prs} pull request(s); deleted ${closed.branches} branch(es)`);
  await resetLocal(ctx, paths, log);
  if (!opts.keepCode) restoreStarter(dir, path.join(ctx.demosRoot, 'starter'), log);
  fs.rmSync(path.join(paths.configDir, LEDGER), { force: true });
  log(`reset; \`weawr demo <scenario> --into ${dir}\` starts again`);
}

/**
 * Close the demo's issues and everything that grew from them on GitHub. With `all`, every open
 * issue labelled `ai`, every open PR and every branch but the default one — for a repository that
 * exists for demos and nothing else.
 */
export async function resetRemote(tracker: any, ledger: Ledger | null, { all = false, log = (_m: string) => {} } = {}): Promise<{ issues: number; prs: number; branches: number }> {
  const out = { issues: 0, prs: 0, branches: 0 };
  const numbers: number[] = ledger ? ledger.issues.map((i) => i.number) : [];
  if (all) {
    const open = await tracker.rest('GET', '/issues?state=open&labels=ai&per_page=100');
    for (const i of open) if (!i.pull_request && !numbers.includes(i.number)) numbers.push(i.number);
  }
  const prs: any[] = await tracker.rest('GET', '/pulls?state=open&per_page=100');
  const defaultBranch = (await tracker.rest('GET', '')).default_branch || 'main';
  const branches: string[] = (await tracker.rest('GET', '/branches?per_page=100')).map((b: any) => b.name).filter((b: string) => b !== defaultBranch);
  const ofIssue = (n: number, name: string) => new RegExp(`^${n}-`).test(name);
  const doomedBranches = new Set<string>();
  for (const pr of prs) {
    const mine = all || numbers.some((n) => ofIssue(n, pr.head?.ref || '') || new RegExp(`(^|[^\\w])#${n}([^\\d]|$)`).test(pr.body || ''));
    if (!mine) continue;
    await tracker.rest('PATCH', `/pulls/${pr.number}`, { state: 'closed' });
    out.prs++; log(`closed PR #${pr.number} (${pr.head?.ref})`);
    if (pr.head?.ref) doomedBranches.add(pr.head.ref);
  }
  for (const b of branches) if (all || numbers.some((n) => ofIssue(n, b))) doomedBranches.add(b);
  for (const b of doomedBranches) {
    try { await tracker.rest('DELETE', `/git/refs/heads/${b}`); out.branches++; }
    catch (e: any) { if (e.status !== 422 && e.status !== 404) throw e; }
  }
  for (const n of numbers) {
    let issue: any;
    try { issue = await tracker.rest('GET', `/issues/${n}`); } catch (e: any) { if (e.status === 404) continue; throw e; }
    for (const l of issue.labels || []) if (/^herdr/.test(l.name)) await tracker.removeLabel(n, l.name);
    if (issue.state !== 'closed') { await tracker.rest('PATCH', `/issues/${n}`, { state: 'closed', state_reason: 'not_planned' }); out.issues++; }
  }
  return out;
}

/** Forget the team's runs on this machine: their herdr workspaces, the worktrees, the state (set aside, not deleted) and the registration. */
export async function resetLocal(ctx: Pick<Context, 'userDir' | 'ids' | 'herdr'>, paths: TeamPaths, log: (m: string) => void): Promise<void> {
  // The runs' workspaces, and the watcher's own: what a person would otherwise close by hand.
  const view = readTeamState(paths);
  const runs = Object.values<any>(view.state.runs || {}).filter((r) => r.workspaceId);
  try { view.store?.close(); } catch { /* read-only */ }
  let closed = 0;
  for (const r of runs) {
    try { await ctx.herdr.closeWorkspaceOf(r.workspaceId, { label: r.workspaceLabel ?? null, repo: paths.repo, agentName: r.agentName ?? null }); closed++; }
    catch (e: any) { log(`could not close workspace ${r.workspaceId}: ${e.message}`); }
  }
  const regFile = path.join(registrationsDir(ctx.userDir), `${teamId(ctx.ids.hostId, paths.repo)}.json`);
  try {
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    if (reg.workspaceId) { await ctx.herdr.closeWorkspace(reg.workspaceId); closed++; }
  } catch { /* no registration, or herdr said no; nothing to close */ }
  if (closed) log(`closed ${closed} herdr workspace(s)`);
  try { git(paths.repo, ['worktree', 'prune']); } catch { /* not a checkout */ }
  const worktrees = path.join(paths.configDir, 'worktrees');
  if (fs.existsSync(worktrees)) {
    for (const w of fs.readdirSync(worktrees)) { try { git(paths.repo, ['worktree', 'remove', '--force', path.join(worktrees, w)]); } catch { /* fall through to rm */ } }
    fs.rmSync(worktrees, { recursive: true, force: true });
  }
  if (fs.existsSync(paths.stateDir)) {
    const aside = `${paths.stateDir}.reset-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(paths.stateDir, aside);
    log(`state set aside in ${aside}`);
  }
  removeRegistration(registrationsDir(ctx.userDir), teamId(ctx.ids.hostId, paths.repo));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
