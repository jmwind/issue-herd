// The team engine: what used to be the `Weawr` class inside the CLI, with every dependency
// handed in — repository paths, config sources, the state store, the clock, git, herdr, the
// tracker, the logger — so two engines for two repositories can share one process, and a test
// can drive one without standing in its repository.
//
// The lifecycle itself is unchanged by the move: pickup → supervise → finalize → (awaiting merge →)
// merged, with claims, nudges and turns exactly as documented in docs/how-it-works.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as _tracker from './adapters/tracker.mjs';
import * as _claim from './claim.mjs';
import * as _auth from './adapters/auth.mjs';
import * as _herdr from './adapters/herdr.mjs';
import { agentOf, coordinator, roleByline, table } from './comments.js';
import * as _branch from './adapters/branch.mjs';
import * as _worktree from './adapters/worktree.mjs';
import * as _agents from './agents.mjs';
import * as _pr from './adapters/pr.mjs';
import * as _nudge from './nudge.mjs';
import * as _github from './adapters/trackers/github.mjs';
// The adapters are still JavaScript. Their inferred types (a `= null` default infers `null`) are
// worse than none, so they are used untyped here until each is converted.
const { userDisplay, slugify } = _tracker as Record<string, any>;
const { alreadyTaken, claimLabelFor, heldByAPerson, issueKeyOf, passLimit, pickCandidates, pickupMarker, runKeyFor, workspaceLabel } = _claim as Record<string, any>;
const { resolveCredential } = _auth as Record<string, any>;
const { agentPlacement, isBlocked, isNameTaken, isStalled, workspaceOwner } = _herdr as Record<string, any>;
const { desiredBranch, reconcileBranch } = _branch as Record<string, any>;
const { catchUp, defaultBranch, makeWorktree, pullBase, removeWorktree } = _worktree as Record<string, any>;
const { agentArgv, describeAgent, exitCommandFor } = _agents as Record<string, any>;
const { conflictPrompt, keepMergeable, mergePr, parsePrUrl, prState, watchesMerge } = _pr as Record<string, any>;
const { nudgedByLabel, nudgesIn, nudgesLeft, nudgesSent, planNudge } = _nudge as Record<string, any>;
const { GitHubTracker } = _github as Record<string, any>;
import { briefVars, renderBrief } from './brief.js';
import { configStamp, expandConfigPath, loadConfig } from './config.js';
import type { ConfigSources, TeamConfig } from './config.js';
import { agentNameFor } from './identity.js';
import type { Identities } from './identity.js';
import type { TeamPaths } from './paths.js';
import { writeRegistration } from './registration.js';
import type { Registration } from './registration.js';
import { JsonStateStore, readJson } from './state.js';
import { isDurable } from './store/index.js';
import type { PendingAction } from './store/sqlite.js';
import { attemptId, roleRunId, taskId, trackerScope } from './identity.js';
import { LATEST_REVISION, RECIPE_ID, contentHash, diffTemplates, revision as recipeRevisionInfo } from '@weawr/recipes';
import { describeIssues, validateResult, verdictOf } from '@weawr/protocol';
import type { TeamSnapshot } from '@weawr/protocol';
import { Enricher } from './enrich.js';
import { teamView, indexSnapshot, timelineOf } from './projection.js';
import { trackerScope as scopeOf } from './identity.js';
import * as _gitSize from './adapters/git-size.mjs';
const { complexity, runSize } = _gitSize as Record<string, any>;
import * as _ghTracker from './adapters/trackers/github.mjs';
const { repoFromGit } = _ghTracker as Record<string, any>;
import type { TeamState, StateStore } from './state.js';
import type { Ownership } from './ownership.js';

/** Run git in `cwd`. Returns trimmed stdout, or null if git failed — callers must tolerate null. */
export type GitRunner = (args: string[], cwd: string) => string | null;

/** The default git runner: bounded in time and output, never throws. */
export const defaultGit: GitRunner = (args?: any, cwd?: any) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { return null; }
};

export interface EngineHooks {
  /** The heartbeat line, rewritten in place on a TTY. */
  live?: (text: string) => void;
  /** Once a day from the loop: is a newer weawr available? The CLI decides how to say so. */
  updateReminder?: () => Promise<unknown>;
}

export interface RegistrationTarget { dir: string; socketPath?: string | null; ownership?: Ownership | null }

export interface EngineOptions {
  cfg: TeamConfig;
  tracker: any;
  herdr: any;
  dry?: boolean;
  paths: TeamPaths;
  /** Where the bundled prompt templates live. */
  promptsRoot: string;
  store?: StateStore;
  ids: Identities;
  version?: string;
  /** How to invoke this weawr from a shell, for briefs: `weawr` when it is the one on PATH, else the explicit command. */
  cli?: string | null;
  git?: GitRunner;
  clock?: () => Date;
  log?: (line: string) => void;
  live?: (text: string) => void;
  hooks?: EngineHooks;
  registration?: RegistrationTarget | null;
  /** For pull-request calls to GitHub; a test hands in its own. */
  fetchImpl?: typeof fetch;
}

/** How long one `herdr agent wait` may block before the supervisor re-reads result.json. */
const RESULT_CHECK_MS = 60_000;
/** How often the watcher may ask GitHub about the same pull request, whatever `pollSeconds` says. */
const PR_POLL_MS = 60_000;
const sleep = (ms: number) => new Promise((r?: any) => setTimeout(r, ms));
/** How long herdr is given to see the agent start on a brief, how many times the brief is offered, and the pause between. */
const PROMPT_UPTAKE_MS = 20_000;
const PROMPT_ATTEMPTS = 3;
const PROMPT_RETRY_MS = 4_000;
/** How long a brief that landed keeps an agent busy, at the least: quiet again inside this is a brief that did not land. */
const PROMPT_SETTLE_MS = 8_000;
function ts(d: Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function hms(d: Date) { return d.toTimeString().slice(0, 8); }
/** The sidebar label for the watcher's own herdr workspace. */
export function watchLabel(name: string) { return `${name}Watch`; }
export function trackerBanner(tracker?: any) { const what = tracker.describe?.(); return `${tracker.constructor.label}${what ? ` ${what}` : ''}`; }

export class TeamEngine {
  cfg: TeamConfig;
  tracker: any;
  herdr: any;
  dry: boolean;
  state: TeamState;
  supervising = new Set<string>();
  /** Run keys promised a nudged turn that has not started yet — see planNudges. */
  reserved = new Set<string>();
  resupervise?: Set<string>;
  warned?: Set<string>;
  pr: { host: string; token: string | null } | null = null;
  readonly paths: TeamPaths;
  readonly sources: ConfigSources;
  readonly store: StateStore;
  readonly ids: Identities;
  readonly version: string;
  readonly cli: string | null;
  readonly git: GitRunner;
  readonly clock: () => Date;
  readonly hooks: EngineHooks;
  readonly fetchImpl: typeof fetch;
  private readonly logger: (line: string) => void;
  /** Where the process announces itself on this machine; null for an engine that should not (a test, a dry run). */
  registration: RegistrationTarget | null;
  /** Set by stop(): the loop finishes its poll, checkpoints, and returns. Agents are left exactly as they are. */
  stopping = false;
  /** The recipe revision this team renders new work with. Pinned in the store; changed only by upgradeRecipe(). */
  recipeRevision: number;
  /** Observations for the snapshot: herdr's index (cached briefly), sizes, enrichment, the settle memory. */
  private herdrCache: { at: number; index: any; snapshot: any } | null = null;
  private sizes = new Map<string, { at: number; value: any }>();
  private seen: Record<string, any> = {};
  private enricher: Enricher | null = null;
  private snapshotCache: { at: number; value: TeamSnapshot } | null = null;
  /** How long a snapshot is served from memory before it is recomputed. */
  static readonly SNAPSHOT_TTL_MS = 1500;
  static readonly HERDR_TTL_MS = 2000;
  private wake: (() => void) | null = null;
  /** How many times a pending external action is tried before it is left for a person. */
  static readonly MAX_PENDING_ATTEMPTS = 3;

  constructor({ cfg, tracker, herdr, dry = false, paths, promptsRoot, store, ids, version = '0.0.0', cli = null, git = defaultGit, clock = () => new Date(), log, live, hooks = {}, registration = null, fetchImpl = fetch }: EngineOptions) {
    this.cfg = cfg;
    this.tracker = tracker; // null in smoke mode
    this.herdr = herdr;
    this.dry = dry;
    this.paths = paths;
    this.sources = { paths, promptsRoot };
    this.store = store ?? new JsonStateStore(paths.statePath);
    this.ids = ids;
    this.version = version;
    this.cli = cli;
    this.git = git;
    this.clock = clock;
    this.hooks = { live: live ?? (() => {}), ...hooks };
    this.fetchImpl = fetchImpl;
    this.logger = log ?? ((line?: any) => console.log(line));
    this.registration = registration;
    this.state = this.store.load();
    // A team keeps the recipe it was set up with until told otherwise. A brand-new store takes
    // the latest bundled one and remembers it; a migrated one was pinned by the migration.
    let pinned = isDurable(this.store) ? Number(this.store.meta('recipe_revision')) || 0 : 0;
    if (!pinned) { pinned = LATEST_REVISION; if (isDurable(this.store) && !this.store.readOnly) this.store.setMeta('recipe_revision', String(pinned)); }
    this.recipeRevision = pinned;
    this.sources.recipeRevision = pinned;
  }

  /**
   * The rule a run lives under, for lifecycle decisions: the live rule with the policy the run was
   * started under laid over it. A rule that was edited does not change a running attempt's
   * cleanup, agent or merge policy; a rule that was removed leaves the run its saved policy rather
   * than today's defaults. Scheduling limits (maxConcurrent, enabled) stay live. `weawr task
   * reconfigure` is the explicit way to move an active run onto the current policy.
   */
  ruleFor(run: any): any {
    const live = this.cfg.rules.find((r: any) => r.name === run.rule) || null;
    const pinned = run.policy && typeof run.policy === 'object' ? run.policy : {};
    if (!live) return { ...this.cfg.defaults, ...pinned, name: run.rule, repo: this.paths.repo, role: run.role ?? null, maxConcurrent: this.cfg.defaults.maxConcurrent };
    return { ...live, ...pinned, maxConcurrent: live.maxConcurrent, enabled: live.enabled };
  }

  /** Move an active run onto the current config's policy for its rule: explicit, logged, evented. */
  reconfigure(key: string): { policy: Record<string, unknown>; changed: string[] } {
    const run = this.state.runs[key];
    if (!run) throw new Error(`no run ${key}`);
    const live = this.cfg.rules.find((r: any) => r.name === run.rule);
    if (!live) throw new Error(`run ${key}: its rule "${run.rule}" is not in the config any more, so there is no current policy to move it onto`);
    const next = policyOf(live);
    const before = run.policy || {};
    const changed = Object.keys(next).filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify(next[k]));
    run.policy = next;
    this.commit(() => { this.saveState(); this.emit('run.reconfigured', key, { changed }); });
    this.log(`${key}: policy moved onto the current config (${changed.length ? changed.join(', ') : 'nothing changed'})`);
    return { policy: next, changed };
  }

  /**
   * Read a run's result file. null when there is none (or it is half-written and does not parse
   * yet); { invalid } when it parses but does not check — which is reported once per distinct
   * content and never finalized, so a person can have the agent fix it.
   */
  async readResult(key: string, run: any, rule: any): Promise<{ result: any } | { invalid: true } | null> {
    if (!run.resultPath || !fs.existsSync(run.resultPath)) return null;
    const raw = readJson(run.resultPath, undefined);
    if (raw === undefined) return null;
    const checked = validateResult(raw);
    if (checked.ok) { if (run.invalidResult) { delete run.invalidResult; this.saveState(); } return { result: checked.value }; }
    const why = describeIssues(checked.issues);
    const hash = contentHash(JSON.stringify(raw));
    if (run.invalidResult?.hash !== hash) {
      run.invalidResult = { hash, at: this.clock().toISOString(), issues: checked.issues };
      this.commit(() => { this.saveState(); this.emit('run.result_invalid', key, { issues: checked.issues }); });
      this.log(`${key}: result.json does not check and will not finish the turn: ${why}`);
      await this.report(key, rule, rule.onBlocked, coordinator(`⚠️ the result file for ${key} was written but does not check, so the turn is not finished: ${why}. Ask the agent in herdr workspace \`${run.workspaceId}\` to rewrite \`${run.resultPath}\` (whole, via a temporary file renamed into place).`), 'request');
    }
    return { invalid: true };
  }

  /**
   * Accept a result on the agent's behalf: checked here, written whole (temporary file, then
   * rename) where the supervisor reads it. What `weawr result` hands in.
   */
  submitResult(key: string, result: unknown): { accepted: true; path: string } {
    const run = this.state.runs[key];
    if (!run) throw new Error(`no run ${key}`);
    if (run.status !== 'running' && run.status !== 'starting') throw new Error(`run ${key} is ${run.status}; a result is only taken from a running turn`);
    const checked = validateResult(result);
    if (!checked.ok) throw new Error(`the result does not check: ${describeIssues(checked.issues)}`);
    fs.mkdirSync(path.dirname(run.resultPath), { recursive: true });
    const tmp = `${run.resultPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(checked.value, null, 2) + '\n');
    fs.renameSync(tmp, run.resultPath);
    this.emit('run.result_submitted', key, { status: checked.value.status });
    this.log(`${key}: result submitted through weawr (${checked.value.status})`);
    return { accepted: true, path: run.resultPath };
  }

  /**
   * Merge a run's pull request — the one deterministic route to an unattended merge. Every check
   * is against what is true now: the merge label on the issue, every reviewing role's structured
   * verdict for the PR's current head, the PR open and mergeable. GitHub enforces branch
   * protection on top, and refuses when the head moves between the check and the merge.
   */
  /**
   * The checks a merge needs, against what is true now: the merge label on the issue, the pull
   * request open and mergeable, every reviewing role's structured verdict approving its current
   * head. Shared by the merge itself and by the coordinator's readiness check after a verdict.
   */
  async mergeChecks(key: string): Promise<{ ok: boolean; reason: string | null; checks: Array<{ check: string; ok: boolean; detail: string }>; run: any; prUrl: string | null; issueKey: string; head: string | null; reviewers: string[] }> {
    const run = this.state.runs[key];
    const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
    const issueKey = run?.issueKey || issueKeyOf(key);
    const refuse = (reason: string) => ({ ok: false, reason, checks, run, prUrl: run?.prUrl || null, issueKey, head: null as string | null, reviewers: [] as string[] });
    if (!run) return refuse(`no run ${key}`);
    const prUrl = parsePrUrl(run.prUrl) ? run.prUrl : parsePrUrl(run.result?.prUrl) ? run.result.prUrl : null;
    if (!prUrl) return refuse(`${key} has no pull request to merge`);
    if (!this.tracker) return refuse('no tracker: the merge label cannot be checked');
    if (!this.cfg.mergeLabel) return refuse('no mergeLabel is configured for this team, so nothing can authorise an unattended merge');
    // 1. authorisation: the label, on the issue, now
    let fresh: any = null;
    try { fresh = await this.tracker.issueByKey(issueKey); } catch (e: any) { return refuse(`could not read ${issueKey} to check the merge label: ${e.message}`); }
    const labelled = !!fresh?.labels?.some((l: string) => l.toLowerCase() === this.cfg.mergeLabel.toLowerCase());
    checks.push({ check: 'authorised', ok: labelled, detail: labelled ? `${issueKey} carries the ${this.cfg.mergeLabel} label` : `${issueKey} does not carry the ${this.cfg.mergeLabel} label (or could not be read)` });
    // 2. the pull request, now
    let pr: any;
    try { pr = await this.askPr(prUrl); } catch (e: any) { return refuse(`could not read ${prUrl}: ${e.message}`); }
    checks.push({ check: 'pr_open', ok: pr.state === 'open', detail: `${prUrl} is ${pr.state}` });
    checks.push({ check: 'pr_mergeable', ok: pr.conflicts !== true, detail: pr.conflicts === true ? 'GitHub reports conflicts with the base' : pr.conflicts === null ? 'GitHub has not computed mergeability yet' : 'no conflicts' });
    const head: string | null = pr.headSha || null;
    // 3. every reviewing role's verdict, for this head
    const reviewers = [...new Set(this.cfg.rules.filter((r: any) => r.enabled !== false && r.role && r.role !== run.role).map((r: any) => r.role as string))];
    if (!reviewers.length) checks.push({ check: 'verdicts', ok: false, detail: 'this team runs no reviewing role, so nothing can approve the head' });
    for (const role of reviewers) {
      const rr = this.state.runs[runKeyFor(issueKey, role)];
      const v = verdictOf(rr?.result || null);
      const sameHead = !!(head && v.headSha && (head.startsWith(v.headSha) || v.headSha.startsWith(head)));
      const ok = v.source === 'structured' && v.verdict === 'approved' && sameHead;
      checks.push({ check: `verdict:${role}`, ok, detail: !rr?.result ? `${role} has not reported` : v.source === 'legacy' ? `${role} gave a prose verdict (${v.verdict}) that names no head, so it cannot approve ${head?.slice(0, 7)}` : v.verdict !== 'approved' ? `${role}: ${v.verdict}` : !sameHead ? `${role} approved ${v.headSha?.slice(0, 7) || 'an unnamed head'}, but the PR is now at ${head?.slice(0, 7)}` : `${role} approved ${head?.slice(0, 7)}` });
    }
    const failed = checks.filter((c) => !c.ok);
    return { ok: !failed.length, reason: failed.length ? failed.map((c) => c.detail).join('; ') : null, checks, run, prUrl, issueKey, head, reviewers };
  }

  /**
   * Merge a run's pull request — the one deterministic route to an unattended merge. Every check
   * is against what is true now (mergeChecks). GitHub enforces branch protection on top, and
   * refuses when the head moves between the check and the merge.
   */
  async mergeRun(key: string, { requestedBy = 'cli' }: { requestedBy?: string } = {}): Promise<{ merged: boolean; reason: string | null; checks: Array<{ check: string; ok: boolean; detail: string }>; prUrl: string | null; headSha: string | null }> {
    const c = await this.mergeChecks(key);
    const { run, prUrl, issueKey, head, reviewers, checks } = c;
    if (!c.ok) { if (run) this.emit('run.merge_refused', key, { checks }); return { merged: false, reason: c.reason, checks, prUrl, headSha: head }; }
    // 4. merge, guarded by the head we checked
    let outcome: any;
    try { outcome = await mergePr(prUrl, { token: this.pr?.token, host: this.pr?.host, method: this.cfg.mergeMethod, sha: head, fetchImpl: this.fetchImpl }); }
    catch (e: any) { this.emit('run.merge_refused', key, { checks, error: e.message }); return { merged: false, reason: e.message, checks, prUrl, headSha: head }; }
    this.commit(() => { run.mergeRequestedAt = this.clock().toISOString(); run.mergedBy = requestedBy; this.saveState(); this.emit('run.merge_requested', key, { prUrl, headSha: head, by: requestedBy, method: this.cfg.mergeMethod }); });
    this.log(`${key}: ${prUrl} merged (${this.cfg.mergeMethod}) at ${head?.slice(0, 7)} — ${this.cfg.mergeLabel} on ${issueKey}, ${reviewers.join(', ')} approved`);
    const body = `${coordinator(`🔀 merged ${prUrl} (${this.cfg.mergeMethod}) at \`${head?.slice(0, 7)}\`, on behalf of \`${run.role || run.rule}\`.`)}\n\n${table([
      ['Authorised by', `the \`${this.cfg.mergeLabel}\` label on ${issueKey}`],
      ['Approved by', reviewers.map((r) => `\`${r}\``).join(', ')],
      ['Head', `\`${head?.slice(0, 7)}\``],
      ['Merged as', this.cfg.mergeMethod],
    ])}`;
    await this.performOwed([{ id: this.owe('tracker.comment', { issueId: run.issueId, issueKey, body }, key), kind: 'tracker.comment', data: { issueId: run.issueId, issueKey, body }, runKey: key }]);
    return { merged: !!outcome.merged, reason: null, checks, prUrl, headSha: head };
  }

  /**
   * What an upgrade to `to` would change, per bundled template, and — unless `dryRun` — do it.
   * Affects new work only: every run keeps the revision its turns were started with.
   */
  upgradeRecipe(to: number = LATEST_REVISION, { dryRun = false } = {}): { from: number; to: number; applied: boolean; templates: Array<{ name: string; origin: 'bundled' | 'repository'; diff: string | null }>; changes: string[] } {
    const from = this.recipeRevision;
    const target = recipeRevisionInfo(to);
    if (!target) throw new Error(`recipe revision ${to} is not bundled with this weawr (latest: ${LATEST_REVISION})`);
    const templates: Array<{ name: string; origin: 'bundled' | 'repository'; diff: string | null }> = [];
    for (const name of target.templates) {
      const inRepo = path.join(this.paths.configDir, 'prompts', name);
      if (fs.existsSync(inRepo)) { templates.push({ name, origin: 'repository', diff: null }); continue; }
      const read = (rev: number) => { try { return fs.readFileSync(path.join(this.sources.promptsRoot, String(rev), name), 'utf8'); } catch { return ''; } };
      const before = read(from), after = read(to);
      templates.push({ name, origin: 'bundled', diff: before === after ? '' : diffTemplates(before, after) });
    }
    const changes = [...target.changes];
    if (!dryRun && to !== from) {
      this.recipeRevision = to; this.sources.recipeRevision = to;
      this.commit(() => { if (isDurable(this.store)) this.store.setMeta('recipe_revision', String(to)); this.emit('team.recipe_upgraded', null, { from, to }); });
      this.log(`recipe: revision ${from} → ${to}; runs already started keep revision ${from}`);
    }
    return { from, to, applied: !dryRun && to !== from, templates, changes };
  }

  /** An event: its own line, on screen (through the injected logger) and in the team's log file. */
  log(...a: unknown[]): void {
    const line = `[${ts(this.clock())}] ${a.join(' ')}`;
    this.logger(line);
    try { fs.mkdirSync(this.paths.logDir, { recursive: true }); fs.appendFileSync(this.paths.logPath, line + '\n'); } catch { /* ignore */ }
  }

  saveState(): void { this.store.save(this.state); }

  /**
   * Commit a transition: the state, its event(s) and the external work it owes, in one transaction
   * when the store can do that (the durable one), else simply in sequence. Returns what `fn` returns.
   */
  commit<T>(fn: () => T): T {
    return isDurable(this.store) ? this.store.transaction(fn) : fn();
  }

  /** A structured event about a run (or the team). What projections and histories are built from. */
  emit(kind: string, runKey: string | null = null, data: Record<string, unknown> = {}): void {
    if (!isDurable(this.store)) return;
    const run = runKey ? this.state.runs[runKey] : null;
    try { this.store.appendEvent(kind, { runKey, issueKey: run?.issueKey ?? (runKey ? issueKeyOf(runKey) : null), data }, this.clock()); } catch (e: any) { this.logger(`event ${kind} not recorded: ${e.message}`); }
  }

  /**
   * Record external work owed by a committed transition. Performed after the commit by
   * performPending(); an owner that dies in between finds it on resume. Without a durable store
   * the work is simply done now.
   */
  owe(kind: string, data: Record<string, unknown>, runKey: string | null = null): number | null {
    if (!isDurable(this.store)) return null;
    return this.store.addPending(kind, data, runKey, this.clock());
  }

  /** Do the pending actions with these ids now (or, with no durable store, the same work directly). */
  async performOwed(owed: Array<{ id: number | null; kind: string; data: Record<string, unknown>; runKey: string | null }>): Promise<void> {
    for (const o of owed) {
      if (o.id === null) { try { await this.performAction(o.kind, o.data, o.runKey); } catch (e: any) { this.log(`${o.runKey || 'team'}: ${o.kind} failed: ${e.message}`); } continue; }
      await this.performPending({ id: o.id, kind: o.kind, data: o.data, runKey: o.runKey, attempts: 0, lastError: null, createdAt: '', doneAt: null, outcome: null });
    }
  }

  /** One try at a pending action, recorded either way. Never throws. */
  async performPending(a: PendingAction): Promise<boolean> {
    try {
      const outcome = await this.performAction(a.kind, a.data, a.runKey);
      if (isDurable(this.store)) this.store.settlePending(a.id, { done: true, outcome: outcome ?? 'done' }, this.clock());
      return true;
    } catch (e: any) {
      if (isDurable(this.store)) this.store.settlePending(a.id, { done: false, error: e.message }, this.clock());
      this.log(`${a.runKey || 'team'}: ${a.kind} failed (${e.message}); ${a.attempts + 1 < TeamEngine.MAX_PENDING_ATTEMPTS ? 'will try again' : 'giving up after ' + (a.attempts + 1) + ' tries'}`);
      return false;
    }
  }

  /**
   * The external side effects a transition can owe. Each is safe to try again: herdr and the
   * tracker are asked what is already true before anything irreversible is repeated.
   */
  async performAction(kind: string, d: Record<string, any>, runKey: string | null): Promise<string | null> {
    switch (kind) {
      case 'tracker.comment': {
        if (!this.tracker) return 'no tracker';
        await this.tracker.comment(d.issueId, d.body);
        return 'commented';
      }
      case 'tracker.setState': { if (!this.tracker) return 'no tracker'; await this.tracker.setState(d.issue, d.state); return `state ${d.state}`; }
      case 'tracker.assign': { if (!this.tracker) return 'no tracker'; await this.tracker.assign(d.issue, await this.tracker.me()); return 'assigned'; }
      case 'tracker.removeLabel': { if (!this.tracker) return 'no tracker'; await this.tracker.removeLabel(d.issueId, d.label); return `removed ${d.label}`; }
      case 'herdr.notify': { await this.herdr.notify(d.title, d.body, { sound: d.sound || 'none' }); return 'notified'; }
      case 'herdr.closeWorkspace': {
        // Only if the workspace under that id is still the run's: herdr numbers workspaces per
        // server session, and a stranger under the run's old id is reported and left alone.
        try { return typeof this.herdr.closeWorkspaceOf === 'function' ? await this.herdr.closeWorkspaceOf(d.workspaceId, d.owner || {}) : (await this.herdr.closeWorkspace(d.workspaceId), 'closed'); }
        catch (e: any) { if (/not_found/.test(e?.code || '')) return 'was already closed'; throw e; }
      }
      case 'herdr.stopAgent': {
        // stopAgent asks herdr whether the agent is still there before it types anything, so a retry
        // after an uncertain outcome does not send /exit into a session that already left.
        const how = await this.herdr.stopAgent(d.agentName, { exitCommand: d.exitCommand });
        if (how === 'is still running') throw new Error(`agent ${d.agentName} is still running`);
        return how;
      }
      case 'worktree.remove': {
        const r = removeWorktree({ git: this.git, repo: d.repo, at: d.at });
        return r.removed ? 'removed' : `kept: ${r.reason}`;
      }
      default: throw new Error(`unknown pending action ${kind}`);
    }
  }

  /**
   * Retry what earlier owners (or earlier polls) left undone. A comment is reconciled first: if the
   * issue already carries it, the retry is recorded as delivered rather than posted twice.
   */
  async drainPending(): Promise<void> {
    if (!isDurable(this.store)) return;
    for (const a of this.store.pending()) {
      if (a.attempts >= TeamEngine.MAX_PENDING_ATTEMPTS) continue;
      if (a.kind === 'tracker.comment' && a.attempts > 0 && this.tracker && a.data.issueKey) {
        try {
          const fresh = await this.tracker.issueByKey(a.data.issueKey);
          const first = String(a.data.body).split('\n')[0];
          if (fresh?.comments?.some((c: any) => c.body.split('\n')[0] === first && Date.parse(c.createdAt) >= Date.parse(a.createdAt) - 60_000)) {
            this.store.settlePending(a.id, { done: true, outcome: 'already on the issue' }, this.clock());
            continue;
          }
        } catch { /* cannot tell; try the send */ }
      }
      await this.performPending(a);
    }
  }

  /** Stop scheduling, checkpoint, return from loop(). Nothing is done to agents: they are the owner's to inspect. */
  stop(): void { this.stopping = true; this.wake?.(); }

  /** The template a rule names, read from the repository's .weawr/ or the bundled prompts. */
  readTemplate(name: string, revision: number = this.recipeRevision, rule: any = null): string {
    // A plugin's role preset carries its brief as text; everything else is a file.
    if (rule?.promptText) return rule.promptText;
    const fromRule = rule ? null : this.cfg.rules.find((r: any) => r.prompt === name && r.promptText);
    if (fromRule) return fromRule.promptText;
    return fs.readFileSync(expandConfigPath(this.sources, name, revision), 'utf8');
  }

  /**
   * How many runs occupy a slot: running, starting, and the runs reserved for a nudged turn that has
   * not started yet. `except` leaves one key out — the run whose own admission is being decided.
   */
  runningCount(ruleName?: string | null, except: string | null = null) {
    let n = 0;
    for (const [key, r] of Object.entries<any>(this.state.runs)) {
      if (key === except) continue;
      if (ruleName && r.rule !== ruleName) continue;
      if (r.status === 'running' || r.status === 'starting' || this.reserved.has(key)) n++;
    }
    return n;
  }

  /** Would starting a turn for `rule` on `key` exceed the global or the rule's cap? */
  atCapacity(rule: any, key: string): string | null {
    if (this.runningCount(null, key) >= this.cfg.maxConcurrent) return `global cap ${this.cfg.maxConcurrent} reached`;
    if (this.runningCount(rule.name, key) >= rule.maxConcurrent) return `rule ${rule.name} cap ${rule.maxConcurrent} reached`;
    return null;
  }

  async pollOnce() {
    if (!this.dry) { await this.drainPending(); await this.checkMerges(); await this.deliverHeldNudges(); }
    const since = new Date(this.clock().getTime() - this.cfg.lookbackDays * 86400e3).toISOString();
    const viewer = await this.tracker.me();
    const issues = await this.tracker.openIssues({ sinceIso: since });
    const ctx = { viewer, now: this.clock().getTime() };
    const candidates = pickCandidates({
      issues, rules: this.cfg.rules, viewer,
      matches: (issue?: any, rule?: any) => { try { return rule.compiled.test(issue, ctx); } catch (e: any) { this.log(`rule ${rule.name}: ${e.message}`); return false; } },
      runFor: (key?: any) => this.state.runs[key] || null,
      onSkip: (key?: any, rule?: any, why?: any) => this.warnOnce(`taken:${key}`, `${key} matches ${rule.name} but is skipped: ${why}`),
    });
    // urgent first, then oldest first
    candidates.sort((a?: any, b?: any) => (prio(a.issue) - prio(b.issue)) || (Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt)));
    const picked = []; const waiting = [];
    for (const c of candidates) {
      if (this.runningCount() >= this.cfg.maxConcurrent) { waiting.push(c.key); this.warnOnce(`cap:${c.key}`, `${c.key} matches but waits: global cap ${this.cfg.maxConcurrent} reached`); continue; }
      if (this.runningCount(c.rule.name) >= c.rule.maxConcurrent) { waiting.push(c.key); this.warnOnce(`cap:${c.key}`, `${c.key} matches but waits: rule ${c.rule.name} cap ${c.rule.maxConcurrent} reached`); continue; }
      if (this.dry) { this.log(`DRY would pick ${c.key} "${c.issue.title}" via rule ${c.rule.name}${c.rule.role ? ` as ${c.rule.role}` : ''}${c.pass > 1 ? ` (pass ${c.pass})` : ''}`); continue; }
      try { await this.pickUp(c.issue, c.rule, { pass: c.pass, holdsClaim: c.holdsClaim }); picked.push(c.key); }
      catch (e: any) { this.log(`pickup ${c.key} failed: ${e.message}`); }
    }
    return { scanned: issues.length, candidates: candidates.length, picked, waiting };
  }

  warnOnce(key: string, msg: string) { (this.warned ??= new Set()); if (!this.warned.has(key)) { this.warned.add(key); this.log(msg); } }

  /** How many runs are done but still waiting for their pull request to be merged. */
  awaitingMerge() { return Object.values(this.state.runs).filter((r?: any) => r.status === 'awaiting_merge').length; }
  /** ...and how many of those GitHub currently reports as conflicting with their base. */
  inConflict() { return Object.values(this.state.runs).filter((r?: any) => r.status === 'awaiting_merge' && r.conflictHead).length; }

  /** "DEV-12 w3 working · DEV-15 w4 blocked" for the heartbeat and `status`. */
  async runningSummary() {
    const parts = [];
    for (const [key, run] of Object.entries(this.state.runs)) {
      if (run.status !== 'running') continue;
      const a = await this.herdr.agentGet(run.agentName).catch(() => null);
      parts.push(`${key} ${run.workspaceId || '?'} ${a?.agent_status || 'gone'}`);
    }
    return parts;
  }

  /**
   * Start a run, or another turn of one. `pass` numbers the turn; `holdsClaim` says the claim label
   * is already ours (a later turn) so only the person guard is re-read; `nudges` is what woke a
   * turn another role asked for — [{ from, message }] — and goes into the brief.
   */
  async pickUp(issue?: any, rule?: any, { pass = 1, holdsClaim = false, nudges = [] }: any = {}) {
    // The run key carries the role, so two roles on one issue are two runs: two state entries, two
    // agent names, two worktrees, two run directories. `issue.identifier` is still what the tracker
    // is asked about — never the run key. A retry of *this* role finds its own previous run, and
    // with it the session that may still be up; another role's run is a different key entirely.
    const key = runKeyFor(issue.identifier, rule.role);
    const previous = this.state.runs[key]; // a run we are retrying; its session may still be up
    // Whatever woke this turn, the nudges held for the run while it was busy are answered by it
    // too: they are asks about this issue, and the next turn is the next turn.
    if (previous?.queuedNudges?.length) nudges = [...nudges, ...previous.queuedNudges];
    const slug = `${slugify(key, 48)}-${slugify(issue.title, 32)}`.replace(/-+$/, '');
    const archiveDir = path.join(this.paths.runsDir, key); // in the watcher's checkout: issue.json now, result.json copied on finish
    fs.mkdirSync(archiveDir, { recursive: true });
    const run: any = {
      rule: rule.name, role: rule.role || null, pass, status: 'starting',
      issueId: issue.id, issueKey: issue.identifier, title: issue.title, url: issue.url,
      startedAt: this.clock().toISOString(), archiveDir,
      // `wantBranch` is what we want it called; `branch` is what git says it is, filled in by
      // settleBranch once the worktree exists. Nothing downstream may report a name we only guessed.
      wantBranch: desiredBranch({ template: rule.branch, issue, slug, worktree: rule.worktree, role: rule.role }),
      branch: null,
      worktree: rule.worktree, agentName: previous?.agentName || agentNameFor(key, this.ids.teamId), notified: {},
      // The nudges this turn answers, if it is one another role asked for. And the pull request the
      // previous turn opened: a turn spent answering a reviewer ends with the same PR, and the
      // watch on it must not be lost to a result that forgot to repeat the URL.
      nudges: nudges.length ? nudges : undefined,
      prUrl: previous?.prUrl || undefined,
      // The recipe a task started under is the recipe its later turns get; an upgrade is for new tasks.
      recipeRevision: previous?.recipeRevision ?? this.recipeRevision,
      // The policy this attempt runs under, as resolved now; ruleFor() lays it over the live rule.
      policy: policyOf(rule),
    };
    run.ids = this.idsFor(issue, rule, key, run);
    this.state.runs[key] = run;
    this.commit(() => { this.saveState(); this.emit('run.picking_up', key, { pass, nudgedBy: nudges.map((n: any) => n.from) }); });
    const turn = nudges.length ? `, turn ${pass}, nudged by ${nudgedByLabel(nudges)}` : pass > 1 ? `, pass ${pass} of ${passLimit(rule)}` : '';
    this.log(`picking up ${key} "${issue.title}" (rule ${rule.name}${rule.role ? `, role ${rule.role}` : ''}${turn})`);

    // Claim on Linear first, so a second watcher (or this one after a crash) sees it before any work starts.
    // Nothing has been built yet, so if the claim cannot be made the run is forgotten rather than left
    // behind as `starting` — a stale `starting` run is what resume() trips over on the next start.
    const claimLabel = claimLabelFor(rule);
    if (this.tracker && claimLabel) {
      try {
        // The fresh fetch happens either way — this is the last look before any work starts. What
        // changes is what counts as taken: a further turn of a role whose claim never came off must
        // not be refused by its own label and its own pickup comment, but a person who took the
        // issue over since the last turn still ends it.
        const fresh = await this.tracker.issueByKey(issue.identifier);
        const why = fresh && (holdsClaim ? heldByAPerson(fresh, rule, await this.tracker.me()) : alreadyTaken(fresh, rule, await this.tracker.me()));
        if (why) throw new Error(`skipped, ${why}`);
        await this.tracker.addLabel(issue.id, claimLabel);
      } catch (e: any) {
        this.commit(() => { delete this.state.runs[key]; this.saveState(); this.emit('run.skipped', null, { key, why: e.message }); });
        throw e;
      }
      run.claimed = claimLabel; this.commit(() => { this.saveState(); this.emit('run.claimed', key, { label: claimLabel }); });
    }

    try {
      // 0. Whatever mode this rule runs in, the checkout the watcher lives in is about to be the
      //    starting point for a run — literally so in "none" and "herdr" modes — and merges land on
      //    the remote, not here. This is the moment it is worth being current.
      this.freshenCheckout(key);

      // 1. An earlier attempt at this issue may have left its session running: a start that failed
      //    after `agent start` succeeded, or an `weawr reset` followed by another pickup. herdr
      //    agent names are unique, so building a second workspace and starting a second agent under
      //    the same name cannot work — it is refused with `agent_name_taken`, and what it leaves
      //    behind is an empty workspace and a live session nobody is watching. That session is this
      //    issue's session, and it is the one the owner has been typing into. Take it back.
      const found = await this.herdr.agentGet(run.agentName).catch((e?: any) => { this.log(`${key}: could not ask herdr about agent ${run.agentName}: ${e.message}`); return null; });
      const existing = found && isOurAgent(found, rule.repo, previous) ? found : null;
      if (found && !existing) this.log(`${key}: an agent called "${run.agentName}" is running in ${found.foreground_cwd || found.cwd}, which is not this repository; leaving it alone`);

      // 2. workspace (+ worktree)
      // "GH-7 review Fix the thing" — the role sits right after the key so the sidebar shows who
      // is doing what without opening anything.
      const label = workspaceLabel({ key: issue.identifier, role: rule.role, title: issue.title });
      let ws;
      if (existing) {
        ws = agentPlacement(existing);
        run.adopted = true;
        run.worktreePath = ws.cwd;
        this.log(`${key}: agent "${run.agentName}" is already running (${existing.agent_status}) in ${ws.cwd}; reusing that session`);
        // A reviewer's session that is still up is the common case for a later turn, and the whole
        // reason there is a later turn is that the implementer pushed something since. Its worktree
        // has to move too, or it re-reads the code it already reviewed. Only a worktree weawr
        // made for this role, and only while the agent is not typing in it.
        if (rule.worktree === 'self' && rule.basedOn && ws.cwd) {
          run.basedOn = this.baseBranchFor(issue, rule, key);
          const ours = previous?.worktreePath && path.resolve(previous.worktreePath) === path.resolve(ws.cwd);
          if (run.basedOn && ours && existing.agent_status !== 'working') {
            const r = catchUp({ git: this.git, repo: rule.repo, at: ws.cwd, base: run.basedOn });
            this.log(`${key}: ${r.moved ? `caught up to ${run.basedOn} (${String(r.from).slice(0, 7)} → ${String(r.at).slice(0, 7)})` : `not moved onto ${run.basedOn}: ${r.reason}`}`);
          } else if (run.basedOn) {
            this.log(`${key}: not catching ${ws.cwd} up to ${run.basedOn}: ${ours ? 'the agent is working in it' : 'it is not a worktree weawr made for this role'}`);
          }
        }
      } else if (rule.worktree === 'herdr') {
        ws = await this.herdr.createWorktree({ cwd: rule.repo, branch: run.wantBranch || `herd/${slug}`, label });
        run.worktreePath = ws.path;
      } else if (rule.worktree === 'self') {
        // `basedOn` is a role's branch and stays that way — it is what a later turn is caught up
        // to, and catching an implementer up to main would throw its commits away. With no role
        // base the start point is the default branch, which is what the config has always promised
        // and what `git worktree add` on its own does not do: its default is this checkout's HEAD.
        run.basedOn = this.baseBranchFor(issue, rule, key);
        const from = run.basedOn || this.baseBranch();
        const made = makeWorktree({ git: this.git, repo: rule.repo, dir: rule.worktreeDir, slug, branch: run.wantBranch || `herd/${slug}`, base: from });
        run.worktreePath = made.path;
        this.log(`${key}: worktree ${made.created ? 'created' : 'reused'} at ${made.path}${made.base ? ` from ${made.base}` : ''}`);
        // Anything but a worktree we just cut from the base is potentially behind it: a directory
        // reused from an earlier turn, and also a fresh directory put back on a branch that already
        // existed (the worktree was removed but the branch survived). Both leave this turn reading
        // the last turn's code, which is how a reviewer confirms its own findings were ignored.
        if (run.basedOn && !made.base) {
          const r = catchUp({ git: this.git, repo: rule.repo, at: made.path, base: run.basedOn });
          this.log(`${key}: ${r.moved ? `caught up to ${run.basedOn} (${String(r.from).slice(0, 7)} → ${String(r.at).slice(0, 7)})` : `not moved onto ${run.basedOn}: ${r.reason}`}`);
        }
        ws = await this.workspaceIn(made.path, rule.repo, label);
      } else {
        ws = await this.herdr.createWorkspace({ cwd: rule.repo, label, env: { HERD_ISSUE: key } });
      }
      Object.assign(run, { workspaceId: ws.workspaceId, tabId: ws.tabId, paneId: ws.paneId });
      // The label is how the run recognises its workspace later: herdr reuses a closed workspace's
      // id after a restart, so an id alone can name somebody else's by the time anything closes
      // it (see closeRunWorkspace). An adopted session keeps whatever its workspace is called.
      run.workspaceLabel = label;
      if (existing) { try { run.workspaceLabel = (await this.herdr.workspaceGet(ws.workspaceId))?.label || label; } catch { /* keep ours */ } }
      this.saveState();
      this.log(`${key}: workspace ${ws.workspaceId} pane ${ws.paneId}`);

      fs.writeFileSync(path.join(archiveDir, 'issue.json'), JSON.stringify(issue, null, 2));

      // 3. start claude (an adopted session is already up)
      if (!existing) {
        const agentArgs = agentArgv({
          kind: rule.agentKind, name: key, permissionMode: rule.permissionMode,
          model: rule.model, effort: rule.effort,
          extra: [...(rule.agentArgs || []), ...(rule.claudeArgs || [])],
        });
        await sleep(1500); // let the shell reach its prompt
        await this.startAgentWithRetry({ name: run.agentName, paneId: ws.paneId, agentArgs, kind: rule.agentKind || 'claude' });
        this.log(`${key}: ${rule.agentKind || 'claude'} started as agent "${run.agentName}"`);
      }

      // 4. brief — written INSIDE the working tree the agent actually uses, under the gitignored
      // .weawr/state/, so reading and writing it needs no permission dialog. A path in the main
      // checkout does not work from a worktree.
      let workDir = run.worktreePath;
      if (workDir) {
        // We know where we put it, but a Claude Code setting that forces its own worktree can still
        // move the agent, and the brief has to be written where the agent really is. herdr wins.
        const seen = await this.herdr.agentGet(run.agentName).then((a?: any) => a?.foreground_cwd || a?.cwd).catch(() => null);
        if (seen && path.resolve(seen) !== path.resolve(workDir)) {
          this.log(`${key}: the agent is in ${seen}, not the worktree we made; using that`);
          workDir = seen;
        }
      } else {
        workDir = await this.agentCwd(run.agentName, rule);
      }
      run.workDir = workDir;
      // Settle the branch before the brief is rendered and before the tracker is told: both quote it.
      this.settleBranch(key, run, rule, workDir);
      run.dir = path.join(workDir, '.weawr', 'state', 'runs', key);
      run.resultPath = path.join(run.dir, 'result.json');
      fs.mkdirSync(run.dir, { recursive: true });
      // A further pass reuses the worktree, so the last pass's result.json is still sitting there.
      // Left alone, the supervisor would read it the moment this agent paused and finalize the new
      // pass with the old pass's answer. Move it aside — under a name the agent can still read,
      // because "what did I say last time" is the whole point of having another turn.
      if (pass > 1 && fs.existsSync(run.resultPath)) {
        run.previousResultPath = path.join(run.dir, `result.pass${pass - 1}.json`);
        try { fs.renameSync(run.resultPath, run.previousResultPath); }
        catch (e: any) { this.log(`${key}: could not set the previous result aside (${e.message}); removing it instead`); fs.rmSync(run.resultPath, { force: true }); run.previousResultPath = null; }
      }
      const brief = renderBrief(this.readTemplate(rule.prompt, run.recipeRevision, rule), briefVars({ issue, rule, run, tracker: this.cfg.Tracker.label, cli: this.cli, nudging: this.nudging(issue.identifier), runKey: key, mergeLabel: this.cfg.mergeLabel }));
      run.briefPath = path.join(run.dir, 'brief.md');
      fs.writeFileSync(run.briefPath, brief);
      // The attempt's immutable record: which words it was given and under which policy. Written
      // once, never updated; later facts are events.
      const attempt = this.attemptSpec(issue, rule, run, brief, key);
      run.attemptId = attempt.id;
      this.commit(() => { this.saveState(); if (isDurable(this.store)) this.store.recordAttempt(attempt); this.emit('run.briefed', key, { attemptId: attempt.id, briefHash: attempt.spec.briefHash }); });
      this.log(`${key}: working tree ${workDir}`);

      // 5. prompt. The session is up and briefed, so from here on the run is the supervisor's:
      // a prompt herdr will not take yet (Claude Code came up on its trust dialog, say) is a run
      // waiting for its owner, not a failed one. Failing here used to abandon a live agent that had
      // never been told what to do, and then collide with it on the retry.
      run.promptText = `You are working ${this.cfg.Tracker.label} issue ${key}. Your full brief is in ${run.briefPath} — read that file first and follow it exactly.`;
      run.pendingPrompt = true;
      run.status = 'running'; this.commit(() => { this.saveState(); this.emit('run.running', key, {}); });
      const sent = await this.deliverPrompt(key, run);
      if (sent) {
        const st = await this.herdr.waitAgent(run.agentName, { until: ['working'], timeoutMs: 30_000 });
        this.log(`${key}: prompted (state ${st})`);
      }

      // 5. tell the tracker. The session is up and briefed by now, so nothing here may fail the run.
      if (this.tracker && rule.onPickup.comment) {
        // pickupMarker() writes the role into the first words, because this comment is also the
        // guard: a reader sees who holds which role, and alreadyTaken() greps for its own.
        const turn = nudges.length ? `${pass}, nudged by ${nudges.map((n?: any) => `\`${n.from}\``).join(' and ')}`
          : passLimit(rule) > 1 ? `${pass} of ${passLimit(rule)}` : null;
        // A nudged turn is expected to find its session up, so "took this back over" — the words
        // for a session an earlier attempt left adrift — would be the wrong story. The marker stays
        // a prefix either way, because alreadyTaken() greps for it.
        const how = nudges.length ? `${pickupMarker(rule.role)} again`
          : run.adopted ? pickupMarker(rule.role).replace('picked this up', 'took this back over') : pickupMarker(rule.role);
        const body = `🧵 ${how} on \`${os.hostname()}\`\n\n${table([
          ['Role', rule.role ? `\`${rule.role}\` — ${agentOf(rule)}` : agentOf(rule)],
          ['Turn', turn],
          ['Branch', run.branch ? `\`${run.branch}\`` : null],
          ['Workspace', `herdr \`${run.workspaceId}\` · agent \`${run.agentName}\``],
        ])}\n\n_I'll post the PR link here when it is ready._`;
        await this.performOwed([{ id: this.owe('tracker.comment', { issueId: issue.id, issueKey: issue.identifier, body }, key), kind: 'tracker.comment', data: { issueId: issue.id, issueKey: issue.identifier, body }, runKey: key }]);
      }
      if (!sent) {
        run.notified.blocked = true; this.saveState();
        await this.report(key, rule, rule.onBlocked, coordinator(`✋ the \`${rule.role || rule.name}\` agent for ${key} is not taking input yet — answer whatever it is showing in herdr workspace \`${run.workspaceId}\` and weawr will send it the brief.${await this.tail(run.agentName, 12)}`), 'request');
      }
      const owed: Array<{ id: number | null; kind: string; data: Record<string, unknown>; runKey: string | null }> = [];
      if (this.tracker && rule.onPickup.assignToMe) owed.push({ id: this.owe('tracker.assign', { issue: slimIssue(issue) }, key), kind: 'tracker.assign', data: { issue: slimIssue(issue) }, runKey: key });
      if (this.tracker && rule.onPickup.state) owed.push({ id: this.owe('tracker.setState', { issue: slimIssue(issue), state: rule.onPickup.state }, key), kind: 'tracker.setState', data: { issue: slimIssue(issue), state: rule.onPickup.state }, runKey: key });
      await this.performOwed(owed);

      this.supervise(key);
    } catch (e: any) {
      run.status = 'failed'; run.error = e.message; run.finishedAt = this.clock().toISOString();
      this.commit(() => { this.saveState(); this.emit('run.failed', key, { error: e.message }); });
      if (this.tracker) {
        const body = coordinator(`⚠️ could not start the \`${rule.role || rule.name}\` session for ${key}: ${e.message}`);
        await this.performOwed([{ id: this.owe('tracker.comment', { issueId: issue.id, issueKey: issue.identifier, body }, key), kind: 'tracker.comment', data: { issueId: issue.id, issueKey: issue.identifier, body }, runKey: key }]);
        await this.releaseClaim(key, run);
      }
      throw e;
    }
  }

  /**
   * After a failed start: give the claim label back so the issue can be taken again, and record
   * the issue's updatedAt as it stands *after* our own cleanup. nextPass() compares against that,
   * so our comment and label removal do not count as the user changing the issue.
   */
  async releaseClaim(key?: any, run?: any) {
    if (!this.tracker) return;
    if (run.claimed) {
      const data = { issueId: run.issueId, label: run.claimed };
      await this.performOwed([{ id: this.owe('tracker.removeLabel', data, key), kind: 'tracker.removeLabel', data, runKey: key }]);
    }
    try { run.issueUpdatedAt = (await this.tracker.issueByKey(run.issueKey || issueKeyOf(key)))?.updatedAt || null; } catch { /* finishedAt is the fallback */ }
    this.saveState();
  }

  /**
   * The branch this rule's worktree should start from, or null for the default branch.
   *
   * `basedOn` names another *role*, and the branch is read from that role's run on this same
   * issue — which is the only place the truth lives, because it is what git reported after that
   * worktree was made rather than what its template asked for. No such run, or a run that never
   * settled a branch, is a log line and a normal worktree: a reviewer looking at the default
   * branch is a poor review, and a failed run is no review at all.
   */
  baseBranchFor(issue?: any, rule?: any, key?: any) {
    if (!rule.basedOn) return null;
    const from = this.state.runs[runKeyFor(issue.identifier, rule.basedOn)];
    if (!from) { this.log(`${key}: no '${rule.basedOn}' run on ${issue.identifier} yet, so its worktree starts from the default branch`); return null; }
    if (!from.branch) { this.log(`${key}: the '${rule.basedOn}' run has no branch of its own, so this worktree starts from the default branch`); return null; }
    return from.branch;
  }

  /**
   * The branch a run is cut from when no role says otherwise, and the branch this checkout is meant
   * to be standing on. Asked each time rather than remembered: it is two cheap git calls, and a
   * config reload can change `baseBranch` under us.
   */
  baseBranch() {
    return this.cfg.baseBranch || defaultBranch({ git: this.git, repo: this.paths.repo });
  }

  /**
   * Keep the watcher's own checkout on the tip of that branch.
   *
   * A "self" worktree does not need this — it is cut from the tip whatever this checkout says — but
   * everything else does: a `worktree: "none"` run works in this directory, `"herdr"` cuts from its
   * HEAD, the config reloaded before every poll is read out of it, and it is the directory its
   * owner opens. Nothing here can lose work (see pullBase), so the only thing to report is movement:
   * a refusal is warned about once, because "you are on a branch of your own" is a state, not an
   * event, and it would otherwise be a line in the log for every pickup for the rest of the day.
   */
  freshenCheckout(why?: any) {
    if (!this.cfg.pullBase) return null;
    // One thing a fast-forward can disturb: a `worktree: "none"` run has an agent working in this
    // directory right now, and moving the floor under it is not the sort of help anybody wants.
    const busy = Object.values(this.state.runs).find((r?: any) => r.status === 'running' && r.workDir && path.resolve(r.workDir) === this.paths.repo);
    if (busy) return { pulled: false, reason: `${busy.issueKey} is working in it` };
    const base = this.baseBranch();
    const r = pullBase({ git: this.git, repo: this.paths.repo, base });
    if (r.pulled) this.log(`${why}: this checkout fast-forwarded onto ${r.ref} (${String(r.from).slice(0, 7)} → ${String(r.at).slice(0, 7)})`);
    else if (r.reason !== 'already up to date') this.warnOnce(`pullBase:${r.reason}`, `this checkout is not being pulled onto ${base}: ${r.reason}`);
    return r;
  }

  /** The directory Claude is working in: the worktree it created, or the repo. Polls herdr until it settles. */
  async agentCwd(name?: any, rule?: any) {
    const deadline = this.clock().getTime() + (rule.worktree === 'none' ? 4_000 : 25_000);
    let last = rule.repo;
    while (this.clock().getTime() < deadline) {
      const a = await this.herdr.agentGet(name);
      const cwd = a?.foreground_cwd || a?.cwd;
      if (cwd && cwd !== rule.repo) return cwd;   // worktree mode: Claude moved
      if (cwd) last = cwd;
      await sleep(1000);
    }
    return last;
  }

  /**
   * Reconcile the branch we wanted with the branch that exists, and record the truth in run.branch.
   *
   * We create the worktree on the branch we want, so this is normally just the confirmation step:
   * ask this.git, record what it says, move on. It still matters. A Claude Code setting that forces its
   * own worktree can put the agent somewhere we did not choose, and then renaming onto the name we
   * promised is how the brief, the pickup comment and the PR keep telling the same story. Anything
   * that goes wrong is a log line, never a failed run — a run on an unexpected branch name is fine,
   * a run whose brief lies is not.
   *
   * The one thing it must never do is rename a branch in the maintainer's own checkout, which is
   * why a workDir equal to the repo is read but never renamed.
   */
  settleBranch(key?: any, run?: any, rule?: any, workDir?: any) {
    if (rule.worktree === 'none') { run.branch = null; return null; }
    if (path.resolve(workDir) === path.resolve(rule.repo)) this.log(`${key}: no worktree of its own; leaving the branch in ${workDir} alone`);
    // An adopted session may already have commits and an upstream on the branch it is on, so the
    // name it is standing on wins over the one this pickup would have chosen. Only a session we
    // just started is renameable.
    const { branch, action, from, want } = reconcileBranch({ git: this.git, cwd: workDir, want: run.adopted ? null : run.wantBranch, repo: rule.repo });
    run.branch = branch;
    this.saveState();
    if (action === 'renamed') this.log(`${key}: branch ${from} → ${branch}`);
    else if (action === 'taken') this.log(`${key}: branch ${want} already exists, staying on ${branch}`);
    else if (action === 'failed') this.log(`${key}: could not rename ${branch} → ${want}, staying on ${branch}`);
    else if (action === 'unreadable') this.log(`${key}: no branch readable in ${workDir}; the brief will not name one`);
    else if (action === 'detached') this.log(`${key}: ${workDir} is on a detached HEAD; the brief will not name a branch`);
    else this.log(`${key}: branch ${branch}`);
    return branch;
  }

  /**
   * A herdr workspace sitting in `dir`. `worktree open` is preferred because herdr then shows the
   * run's real branch and groups it under the repo, and it hands back a fresh shell pane to start
   * the agent in. A plain workspace is the fallback: if you already had that checkout open, herdr
   * returns your workspace and your shell, which is not ours to start an agent in.
   */
  async workspaceIn(dir?: any, repo?: any, label?: any) {
    try {
      const wt = await this.herdr.openWorktree({ cwd: repo, path: dir, label });
      if (wt.paneId && !wt.alreadyOpen) return wt;
      if (wt.alreadyOpen) this.log(`  ${dir} is already open in herdr; giving the run its own workspace`);
    } catch (e: any) {
      this.log(`  herdr worktree open failed (${e.message}); using a plain workspace`);
    }
    return this.herdr.createWorkspace({ cwd: dir, label });
  }

  async startAgentWithRetry(opts?: any) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.herdr.startAgent(opts); }
      catch (e: any) {
        lastErr = e;
        if (e.code === 'agent_not_ready') return; // started but sitting on a startup dialog; supervise() will see 'blocked'
        // Our own previous attempt in this loop may have started it after all; anyone else's agent
        // by that name is not ours to prompt.
        if (isNameTaken(e) && (await this.herdr.agentGet(opts.name).catch(() => null))?.pane_id === opts.paneId) return;
        if (!/pane_not_ready|not at.*prompt|busy|shell/i.test(e.message)) throw e;
        await sleep(2000 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /**
   * Hand the agent the one prompt that makes it a run: "your brief is in <file>". Returns true when
   * herdr took it.
   *
   * herdr will not type into an agent that is showing a dialog — `agent prompt` answers
   * `agent_blocked` and sends nothing — and Claude Code shows one the first time it runs in a
   * directory. So the prompt is kept on the run and tried again by the supervisor as soon as the
   * agent takes input, which is the whole difference between a session that carries on once its
   * owner answers the dialog and one that sits there forever having never been told what to do.
   */
  async deliverPrompt(key?: any, run?: any) {
    if (!run.pendingPrompt) return true;
    // "Took it" means seen working afterwards, not "typed": an agent redrawing its screen after
    // that dialog swallows what is typed and sits at an empty prompt, and a supervisor that
    // believed the brief was in would then wait on it for ever. Herdr confirms the uptake; a
    // stalled submission is sent again, a few times, before the agent is left to be prompted
    // when it next takes input.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.herdr.prompt(run.agentName, run.promptText, { wait: true, until: ['working', 'blocked'], timeoutMs: PROMPT_UPTAKE_MS });
        // herdr saw it start; a brief that landed keeps it busy for longer than a startup screen's
        // flicker does (codex, briefed the second it came up, reported working and sat at its
        // empty prompt). Back at idle within moments, with no result written, means it never had it.
        const settled = await this.herdr.waitAgent(run.agentName, { until: ['idle', 'done'], timeoutMs: PROMPT_SETTLE_MS });
        if ((settled === 'idle' || settled === 'done') && !fs.existsSync(run.resultPath)) {
          if (attempt < PROMPT_ATTEMPTS) { this.log(`${key}: the agent went quiet right after the brief without starting on it; sending it again`); await sleep(PROMPT_RETRY_MS); continue; }
          this.log(`${key}: the agent has not taken the brief yet (it did not start on it); will try again when it takes input`);
          return false;
        }
        run.pendingPrompt = false; this.commit(() => { this.saveState(); this.emit('run.prompted', key, {}); });
        this.log(`${key}: briefed`);
        return true;
      } catch (e: any) {
        if (isStalled(e) && attempt < PROMPT_ATTEMPTS) {
          this.log(`${key}: the agent did not take the brief (it was not listening yet); sending it again`);
          await sleep(PROMPT_RETRY_MS);
          continue;
        }
        this.log(`${key}: the agent has not taken the brief yet (${isBlocked(e) ? 'it is showing a dialog' : isStalled(e) ? 'it did not start on it' : e.message}); will try again when it takes input`);
        return false;
      }
    }
  }

  /** Follow a run until it produces result.json or the agent disappears. Safe to call again after restart. */
  supervise(key?: any) {
    // A turn started while this key's supervisor is still finishing — the queued nudge a run hands
    // over as its own finish ends — must not be lost to "already supervised": the loop that is
    // leaving was watching the previous turn. Note it, and start again once that loop is gone.
    if (this.supervising.has(key)) { (this.resupervise ??= new Set()).add(key); return; }
    this.supervising.add(key);
    this.superviseLoop(key).catch((e?: any) => this.log(`${key}: supervisor crashed: ${e.stack || e.message}`)).finally(() => {
      this.supervising.delete(key);
      if (this.resupervise?.delete(key) && this.state.runs[key]?.status === 'running') this.supervise(key);
    });
  }

  async superviseLoop(key?: any) {
    const run = this.state.runs[key];
    const rule = this.ruleFor(run);
    const name = run.agentName;
    while (run.status === 'running') {
      // A brief herdr would not take at pickup is owed to the agent; give it the moment it will.
      if (run.pendingPrompt && await this.deliverPrompt(key, run)) run.notified.blocked = false;
      // Bounded, not "until it settles": a result is read on every turn of this loop, so an agent
      // that writes result.json and keeps working — the implementer the issue let merge, waiting
      // for the reviewers' verdicts — is finalized within a minute rather than when it finally
      // stops. Otherwise the handoff its result was meant to make would wait on the reviews it
      // is waiting for. A `timeout` answer just comes back round.
      const st = await this.herdr.waitAgent(name, { timeoutMs: RESULT_CHECK_MS });
      const read = await this.readResult(key, run, rule);
      if (read && 'result' in read) { await this.finalize(key, read.result, rule); return; }
      if (st === 'gone') {
        run.status = 'stopped'; run.finishedAt = this.clock().toISOString(); this.commit(() => { this.saveState(); this.emit('run.stopped', key, { why: 'agent exited without a result' }); });
        this.log(`${key}: agent exited without a result`);
        await this.report(key, rule, rule.onIdle, coordinator(`🛑 the \`${rule.role || rule.name}\` agent session for ${key} ended without writing a result. Workspace \`${run.workspaceId}\` is still open for inspection.`));
        // Stamp for the same reason finalize does, and here it matters more: a rule with turns left
        // would otherwise read our own "the agent died" comment as the issue moving on and start
        // the next turn immediately, burning every turn on a session that keeps dying.
        await this.stampAnswered(key, run, rule);
        // A nudge held for this turn still stands, and a fresh session in the same worktree can
        // answer it — that is what a nudged turn of a stopped run does.
        await this.deliverQueuedNudges(key);
        return;
      }
      if (st === 'timeout') continue;
      if (st === 'blocked') {
        this.log(`${key}: blocked — waiting for approval or input in ${run.workspaceId}`);
        this.emit('run.blocked', key, { workspaceId: run.workspaceId });
        if (!run.notified.blocked) {
          run.notified.blocked = true; this.saveState();
          const tail = await this.tail(name, 12);
          await this.report(key, rule, rule.onBlocked, coordinator(`✋ the \`${rule.role || rule.name}\` agent for ${key} is waiting for approval or input in herdr workspace \`${run.workspaceId}\`.${tail}`), 'request');
        }
        const next = await this.herdr.waitAgent(name, { until: ['working', 'idle', 'done'], timeoutMs: 6 * 3600e3 });
        this.log(`${key}: unblocked → ${next}`);
        this.emit('run.working', key, { after: 'blocked' });
        run.notified.blocked = false;
        continue;
      }
      if (st === 'idle' || st === 'done' || st === 'unknown') {
        // An agent that never took its brief is not asking a question; it is waiting to be told.
        // Round again: the brief is offered every time it takes input.
        if (run.pendingPrompt) { await sleep(PROMPT_RETRY_MS); continue; }
        // Claude finished a turn without writing result.json — probably asked a question in chat.
        this.log(`${key}: ${st} without a result — probably asking a question in ${run.workspaceId}`);
        this.emit('run.question', key, { workspaceId: run.workspaceId });
        if (!run.notified.idle) {
          run.notified.idle = true; this.saveState();
          const tail = await this.tail(name, 15);
          await this.report(key, rule, rule.onIdle, coordinator(`💬 the \`${rule.role || rule.name}\` agent for ${key} stopped without a result and is probably asking a question. Answer it in herdr workspace \`${run.workspaceId}\`.${tail}`), 'request');
        }
        await this.herdr.waitAgent(name, { until: ['working'], timeoutMs: 6 * 3600e3 });
        this.log(`${key}: working again`);
        this.emit('run.working', key, { after: 'question' });
        run.notified.idle = false;
        continue;
      }
      this.log(`${key}: unexpected wait result ${st}; retrying in 30s`);
      await sleep(30_000);
    }
  }

  async tail(name?: any, lines?: any) {
    try {
      const text = (await this.herdr.readAgent(name, lines + 20)).trim().split('\n').filter((l?: any) => l.trim()).slice(-lines).join('\n');
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`` : '';
    } catch { return ''; }
  }

  async finalize(key?: any, result?: any, rule?: any) {
    const run = this.state.runs[key];
    run.status = 'done'; run.result = result; run.finishedAt = this.clock().toISOString();
    this.commit(() => { this.saveState(); this.emit('run.finished', key, { status: result.status || 'unknown', prUrl: result.prUrl || null, attemptId: run.attemptId || null }); });
    // keep a copy in the watcher's checkout; the worktree may be removed later
    // `result.json` and `brief.md` are always the latest pass; a rule that chimes in more than once
    // also keeps each pass under its own name, so the record of what it said when survives.
    try {
      fs.mkdirSync(run.archiveDir, { recursive: true });
      for (const f of ['result.json', 'brief.md']) {
        const src = path.join(run.dir, f);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(run.archiveDir, f));
        if ((run.pass || 1) > 1) fs.copyFileSync(src, path.join(run.archiveDir, f.replace(/\.(\w+)$/, `.pass${run.pass}.$1`)));
      }
    } catch { /* best effort */ }
    const status = result.status || 'unknown';
    const icon = status === 'pr_open' ? '✅' : status === 'needs_human' ? '🙋' : status === 'nothing_to_do' ? '🤷' : '❌';
    const verdict = result.review?.verdict ? `\`${result.review.verdict}\`${result.review.headSha ? ` at \`${String(result.review.headSha).slice(0, 7)}\`` : ''}${result.review.prUrl ? ` for ${result.review.prUrl}` : ''}` : null;
    const lines = [`${icon} ${roleByline(run.role)} finished ${run.issueKey || key} with status \`${status}\`.`];
    const facts: Array<[string, unknown]> = [
      ['Role', run.role ? `\`${run.role}\` — ${agentOf(rule)}` : agentOf(rule)],
      ['Turn', (run.pass || 1) > 1 || passLimit(rule) > 1 ? `${run.pass || 1}${passLimit(rule) > 1 ? ` of ${passLimit(rule)}` : ''}` : null],
      ['Status', `\`${status}\``],
      ['PR', result.prUrl || null],
      ['Branch', result.branch ? `\`${result.branch}\`` : null],
      ['Verdict', verdict],
    ];
    // A merged PR is what says the run is over; until then the workspace and the worktree stay up
    // for whoever reviews it. A prUrl that is not a pull request URL is not followed — the agent
    // wrote it, and the watcher will not sit waiting for a merge that can never be seen.
    // A turn spent answering a reviewer ends with the PR it already had, so a result that leaves
    // the URL out keeps the watch the previous turn started.
    const prUrl = parsePrUrl(result.prUrl) ? result.prUrl : parsePrUrl(run.prUrl) ? run.prUrl : null;
    const watch = status === 'pr_open' && watchesMerge(rule) && prUrl ? prUrl : null;
    facts.push(['Workspace', watch ? `herdr \`${run.workspaceId}\` and the worktree stay up until ${watch} is merged` : `herdr \`${run.workspaceId}\` is still open`]);
    lines.push('', table(facts));
    if (result.summary) lines.push(`\n${result.summary}`);
    if (result.testing) lines.push(`\n**How to test**\n${result.testing}`);
    if (result.notes) lines.push(`\n**Notes**\n${result.notes}`);
    // What the agent asked of the other roles, and what will happen to each ask. Decided here, and
    // said in this comment, so the issue records the handoff next to the report that made it; the
    // turns themselves start after the comment is up, so their pickup comments follow it.
    const relay = this.planNudges(key, run, rule, result);
    if (relay.lines.length) lines.push('', ...relay.lines);
    this.log(`${key}: done (${status}) ${result.prUrl || ''}`);
    await this.report(key, rule, rule.onDone, lines.join('\n'), 'done');
    await this.carryOutNudges(key, run, rule, relay);
    const owed: Array<{ id: number | null; kind: string; data: Record<string, unknown>; runKey: string | null }> = [];
    if (this.tracker && rule.onDone.state && status === 'pr_open') {
      const data = { issue: { ...slimIssue(readJson(path.join(run.archiveDir, 'issue.json'), {})), id: run.issueId }, state: rule.onDone.state };
      owed.push({ id: this.owe('tracker.setState', data, key), kind: 'tracker.setState', data, runKey: key });
    }
    if (rule.onDone.closeWorkspace && run.workspaceId) { const data = { workspaceId: run.workspaceId, owner: workspaceOwner(run, this.paths.repo) }; owed.push({ id: this.owe('herdr.closeWorkspace', data, key), kind: 'herdr.closeWorkspace', data, runKey: key }); }
    if (watch) {
      run.prUrl = watch; run.status = 'awaiting_merge';
      this.commit(() => { this.saveState(); this.emit('run.awaiting_merge', key, { prUrl: watch }); });
      this.log(`${key}: waiting for ${watch} to be merged before shutting the run down`);
    }
    await this.performOwed(owed);
    await this.stampAnswered(key, run, rule);
    // Nudges that arrived while this turn was running were held for it. It is over: hand them over.
    await this.deliverQueuedNudges(key);
    // A verdict may have been the last one the merge was waiting for.
    if (result.review?.verdict === 'approved') await this.askForMergeIfReady(run.issueKey || issueKeyOf(key));
  }

  /**
   * After a reviewing role's approval: when the issue carries the merge label and every reviewing
   * role approves the pull request's current head, the implementer is asked — once per head — to
   * run `weawr merge`. Its session is idle after its result and would never notice on its own: a
   * reviewer's approval is a comment on the issue, not a nudge. The ask is the coordinator's, so
   * it is not counted against what the agents may nudge each other.
   */
  async askForMergeIfReady(issueKey: string) {
    for (const [implKey, run] of Object.entries<any>(this.state.runs)) {
      if ((run.issueKey || issueKeyOf(implKey)) !== issueKey || run.status !== 'awaiting_merge') continue;
      let c: Awaited<ReturnType<TeamEngine['mergeChecks']>>;
      try { c = await this.mergeChecks(implKey); } catch (e: any) { this.log(`${implKey}: could not check whether it is ready to merge: ${e.message}`); continue; }
      if (!c.ok || !c.head) { this.log(`${implKey}: not ready to merge yet (${c.reason})`); continue; }
      // Once per head, remembered on the issue's nudge trail: a later turn replaces the run object.
      const trail = (this.state.nudges[issueKey] ??= []);
      if (trail.some((n: any) => n.from === 'coordinator' && n.outcome === 'merge' && n.head === c.head)) continue;
      const who = c.reviewers.map((r) => `\`${r}\``).join(', ');
      const message = `Every reviewing role (${who}) has approved ${c.prUrl} at \`${c.head.slice(0, 7)}\`, and ${issueKey} carries \`${this.cfg.mergeLabel}\`. Run \`${this.cli || 'weawr'} merge ${implKey}\` from your worktree now, then write your result file again. If it refuses, say why in the result and stop.`;
      const at = this.clock().toISOString();
      const nudge = { from: 'coordinator', message, at };
      trail.push({ from: 'coordinator', to: run.role, at, outcome: 'merge', head: c.head, message: message.slice(0, 200) }); this.saveState();
      this.log(`${implKey}: ${who.replace(/`/g, '')} approved ${c.head.slice(0, 7)}; asking \`${run.role || run.rule}\` to run weawr merge`);
      this.emit('run.merge_ready', implKey, { prUrl: c.prUrl, headSha: c.head, reviewers: c.reviewers });
      // On the issue whatever the rule's comment policy says, like the merge itself: this is the
      // moment the trail has to show, or a merge appears out of nowhere.
      const body = coordinator(`🔀 every reviewing role (${who}) approved ${c.prUrl} at \`${c.head.slice(0, 7)}\`, and ${issueKey} carries \`${this.cfg.mergeLabel}\`: asking \`${run.role || run.rule}\` to run \`${this.cli || 'weawr'} merge ${implKey}\`.`);
      await this.performOwed([{ id: this.owe('tracker.comment', { issueId: run.issueId, issueKey, body }, implKey), kind: 'tracker.comment', data: { issueId: run.issueId, issueKey, body }, runKey: implKey }]);
      if (this.supervising.has(implKey) || this.reserved.has(implKey) || run.status === 'running' || run.status === 'starting') { (run.queuedNudges ??= []).push(nudge); this.saveState(); continue; }
      this.reserved.add(implKey);
      await this.startNudgedTurn(implKey, [nudge], 'coordinator');
    }
  }

  /**
   * What the run is called when it says who it is nudging, and what the brief says about nudging:
   * every role the project runs, and how many nudges this issue has left.
   */
  nudging(issueKey: string): { roles: string[]; left: number; max: number } {
    const roles = [...new Set(this.cfg.rules.filter((r?: any) => r.enabled !== false && r.role).map((r?: any) => r.role))];
    return { roles, left: nudgesLeft(this.state.nudges[issueKey], this.cfg.maxNudges), max: this.cfg.maxNudges };
  }

  /**
   * Decide what happens to each nudge a result asked for, without doing any of it yet. Returns
   * { lines, turns, queued }: the lines for the finish comment, the nudged turns to start, and the
   * nudges to hold for a run that is busy. Every decision is written into state.nudges as it is
   * made, because the cap is counted from there and a decision is a decision whether or not the
   * herdr call after it works.
   */
  planNudges(key?: any, run?: any, rule?: any, result?: any) {
    const { nudges, rejected } = nudgesIn(result);
    const lines = rejected.map((r?: any) => `⚠️ Nudge ignored: ${r}.`);
    const plan: { lines: string[]; turns: any[]; queued: any[]; capped: any } = { lines, turns: [], queued: [], capped: null };
    if (!nudges.length) return plan;
    const issueKey = run.issueKey || issueKeyOf(key);
    const from = run.role || null;
    const entries = (this.state.nudges[issueKey] ??= []);
    for (const nudge of nudges) {
      const targetKey = runKeyFor(issueKey, nudge.role);
      const targetRun = this.state.runs[targetKey] || null;
      // A target is busy when its status says so, and also when its status says done but it is
      // spoken for: its supervisor is still writing up its finish, or another nudge — the other
      // reviewer's, planned a moment ago — has already promised it a turn that has not started.
      // Either way a second turn started now would land on top of the first and replace it, so
      // the ask is held and coalesced into the turn after. The promise is made here, at planning
      // time, because the comments between planning and starting take seconds.
      const busy = this.supervising.has(targetKey) || this.reserved.has(targetKey);
      const { outcome, reason, capped } = planNudge({ nudge, from, targetRun, sent: nudgesSent(entries), max: this.cfg.maxNudges, busy });
      entries.push({ from, to: nudge.role, at: this.clock().toISOString(), outcome, message: nudge.message.slice(0, 200) });
      const icon = outcome === 'refused' ? '🙋' : '👉';
      lines.push(`${icon} **Nudge → \`${nudge.role}\`** — ${reason}.\n> ${nudge.message.replace(/\r?\n/g, '\n> ')}`);
      this.log(`${key}: nudge → ${targetKey}: ${outcome} (${reason.replace(/`/g, '')})`);
      this.emit('nudge.planned', key, { to: targetKey, outcome, reason: reason.replace(/`/g, '') });
      const held = { from: from || rule.name, message: nudge.message, at: this.clock().toISOString() };
      if (outcome === 'turn') { this.reserved.add(targetKey); plan.turns.push({ targetKey, nudge: held }); }
      else if (outcome === 'queue') plan.queued.push({ targetKey, nudge: held });
      else if (capped && !plan.capped) plan.capped = { to: nudge.role, nudge: held, reason };
    }
    this.saveState();
    return plan;
  }

  /**
   * Do what planNudges decided: hold the nudges for busy runs, start the turns, and if the cap
   * ended the conversation, say so where a person will hear it — the finish comment already says
   * it, but that is one comment among several, and this is the moment somebody is needed.
   */
  async carryOutNudges(key?: any, run?: any, rule?: any, plan?: any) {
    for (const { targetKey, nudge } of plan.queued) {
      const target = this.state.runs[targetKey];
      if (!target) continue;
      (target.queuedNudges ??= []).push(nudge); this.saveState();
      // The turn it was waiting on may have ended between the decision and now, in which case
      // nobody else is going to hand this over.
      if (!this.supervising.has(targetKey)) await this.deliverQueuedNudges(targetKey);
    }
    for (const { targetKey, nudge } of plan.turns) await this.startNudgedTurn(targetKey, [nudge], key);
    if (plan.capped) {
      const issueKey = run.issueKey || issueKeyOf(key);
      await this.report(key, rule, rule.onBlocked, coordinator(`🙋 the agents on ${issueKey} have nudged each other ${this.cfg.maxNudges} times, which is the limit (\`maxNudges\`), and \`${run.role || rule.name}\` still needs \`${plan.capped.to}\` to act. A person needs to step in: read the reports on the issue and answer in the workspace of whichever agent should go next, or raise \`maxNudges\` in \`.weawr/config.local.json\` to let them carry on.`), 'request');
    }
  }

  /**
   * Another turn of `targetKey`, asked for by another role. The same pickup as any later turn —
   * same run key, claim, worktree and (when it is still up) session; the previous result is set
   * aside and the brief carries the nudge. `askedBy` is the run that asked, for the log.
   *
   * A failure here is reported and swallowed: the nudging run is already over, and the fact that
   * its ask could not be delivered is what the owner needs to hear, not a crashed supervisor.
   */
  async startNudgedTurn(targetKey?: any, nudges?: any, askedBy?: any) {
    const target = this.state.runs[targetKey];
    if (!target) { this.reserved.delete(targetKey); return false; }
    // Last look before the turn starts: another handoff may have started one since this was
    // planned (a start sets the status before it does anything else). Then this ask joins the
    // queue and rides the turn after, rather than landing on top of a turn in progress.
    if (target.status === 'running' || target.status === 'starting') {
      (target.queuedNudges ??= []).push(...nudges); this.saveState();
      this.log(`${targetKey}: nudged by ${askedBy} while a turn is in progress; held for its next turn`);
      return false;
    }
    // A nudged turn takes a slot like any pickup. With none free it waits, held on the run, and
    // the next poll with room hands it over — the same admission ordinary pickups go through.
    const targetRule = this.cfg.rules.find((r: any) => r.name === target.rule);
    const full = targetRule ? this.atCapacity(targetRule, targetKey) : null;
    if (full) {
      (target.queuedNudges ??= []).push(...nudges); this.saveState();
      this.reserved.delete(targetKey);
      this.log(`${targetKey}: nudged by ${askedBy}, but ${full}; held until a slot is free`);
      this.emit('nudge.held', targetKey, { by: askedBy, why: full });
      return false;
    }
    try { return await this.startNudgedTurnNow(targetKey, target, nudges, askedBy); }
    finally { this.reserved.delete(targetKey); }
  }

  async startNudgedTurnNow(targetKey?: any, target?: any, nudges?: any, askedBy?: any) {
    const rule = this.cfg.rules.find((r?: any) => r.name === target.rule);
    const issueKey = target.issueKey || issueKeyOf(targetKey);
    let why = null;
    if (!rule) why = `its rule "${target.rule}" is no longer in the config`;
    else if (rule.enabled === false) why = `its rule "${rule.name}" is disabled${rule.disabledReason ? ` (${rule.disabledReason})` : ''}`;
    let issue = null;
    if (!why) {
      // The issue as it is now, so the brief quotes the reports that led here. The archived copies
      // are the fallback for a tracker that is not answering, and the only copies in smoke mode:
      // the target's own, else the nudging run's — it is the same issue.
      if (this.tracker) { try { issue = await this.tracker.issueByKey(issueKey); } catch (e: any) { this.log(`${targetKey}: could not re-read ${issueKey} for the nudged turn (${e.message}); using the archived copy`); } }
      for (const dir of [target.archiveDir, this.state.runs[askedBy]?.archiveDir]) issue ||= dir ? readJson(path.join(dir, 'issue.json'), null) : null;
      if (!issue) why = 'the issue could not be read';
    }
    if (why) {
      this.log(`${targetKey}: nudged by ${askedBy}, but no turn can start: ${why}`);
      if (this.tracker) { try { await this.tracker.comment(target.issueId, `⚠️ \`${target.role || target.rule}\` was nudged but cannot take a turn: ${why}.`); } catch { /* ignore */ } }
      return false;
    }
    try {
      await this.pickUp(issue, rule, { pass: (target.pass || 1) + 1, holdsClaim: Boolean(target.claimed), nudges });
      return true;
    } catch (e: any) {
      this.log(`${targetKey}: the nudged turn could not start: ${e.message}`);
      return false;
    }
  }

  /** Runs holding nudges that could not start for want of a slot: try them again, oldest first. */
  async deliverHeldNudges() {
    for (const key of Object.keys(this.state.runs)) {
      const run = this.state.runs[key];
      if (!run.queuedNudges?.length || run.status === 'running' || run.status === 'starting' || this.reserved.has(key)) continue;
      await this.deliverQueuedNudges(key);
    }
  }

  /** Give a run that has just finished the nudges that were held while it was busy. */
  async deliverQueuedNudges(key?: any) {
    const run = this.state.runs[key];
    const held = run?.queuedNudges;
    if (!held?.length) return;
    // A turn in progress keeps them: they are delivered when it finishes, never over the top of it.
    // So does a turn promised but not started — it will pick them up as it starts (see pickUp).
    if (run.status === 'running' || run.status === 'starting' || this.reserved.has(key)) return;
    run.queuedNudges = []; this.saveState();
    this.reserved.add(key);
    await this.startNudgedTurn(key, held, held.map((n?: any) => n.from).join(', '));
  }

  /**
   * The other half of a run. The agent stopped when the PR was open; the workspace and the worktree
   * are still there because a reviewer may want them. When GitHub says the PR is merged, they are
   * not needed any more, so the agent is asked to exit, the workspace closes and the worktree goes
   * back — the part of a run nobody should have to write into their instructions.
   *
   * A PR closed without merging is a person's decision about work in progress, so nothing is torn
   * down: the run simply stops being watched.
   */
  async checkMerges() {
    for (const [key, run] of Object.entries(this.state.runs)) {
      if (run.status !== 'awaiting_merge' || !run.prUrl) continue;
      if (run.prCheckedAt && this.clock().getTime() - Date.parse(run.prCheckedAt) < PR_POLL_MS) continue;
      const rule: any = this.ruleFor(run);
      let pr = null;
      try { pr = await this.askPr(run.prUrl); }
      catch (e: any) { this.warnOnce(`pr:${key}:${e.message}`, `${key}: cannot read ${run.prUrl}, so a merge cannot be seen: ${e.message}`); }
      run.prCheckedAt = this.clock().toISOString(); this.saveState();
      if (!pr) continue;
      if (pr.state === 'open') { await this.keepMergeable(key, run, rule, pr); continue; }
      if (pr.state === 'closed') {
        run.status = 'done'; run.finishedAt ||= this.clock().toISOString(); this.commit(() => { this.saveState(); this.emit('run.pr_closed', key, { prUrl: run.prUrl }); });
        this.log(`${key}: ${run.prUrl} was closed without merging; leaving workspace ${run.workspaceId} and the worktree alone`);
        continue;
      }
      run.mergedAt = pr.mergedAt || this.clock().toISOString();
      this.commit(() => { this.saveState(); this.emit('run.merged', key, { prUrl: run.prUrl, mergedAt: run.mergedAt }); });
      this.log(`${key}: ${run.prUrl} is merged`);
      // That merge is a commit on the base branch that this checkout does not have. Runs are cut
      // from the tip either way, but the directory you and the "none"/"herdr" modes work in is not.
      this.freshenCheckout(key);
      const did = await this.shutdown(key, run, rule);
      run.status = 'merged'; run.finishedAt = this.clock().toISOString(); this.commit(() => { this.saveState(); this.emit('run.closed', key, { did }); });
      // The notification only carries the first line, and with nothing switched on the thing you
      // need from it is what is still standing — so that goes first and the URL follows.
      const lines = did.length
        ? [coordinator(`🎉 ${key} is finished — ${run.prUrl} is merged, so the run was shut down.`), '', ...did.map((d?: any) => `- ${d}`)]
        : [coordinator(`🎉 ${key} is finished — its PR is merged. ${this.leftStanding(run, rule)}`), '', run.prUrl];
      await this.report(key, rule, rule.onMerged, lines.join('\n'), 'done');
      await this.stampAnswered(key, run, rule);
    }
  }

  /**
   * An open pull request that has drifted into conflicts is one nobody can merge, and the person
   * it is waiting on is the one least placed to fix it. The implementer's brief makes the PR its
   * own to keep mergeable until it is merged or closed; this is the half of that it cannot do
   * itself — noticing. The watcher is already asking GitHub about the PR once a minute, so when
   * the answer says "dirty" the implementer's session, still up in its pane, is typed the one
   * message that sends it back to work. Once per conflict, not once a minute; a session that has
   * gone — exited by hand, or `onDone.closeWorkspace` — has nobody to tell, so the person is told
   * instead, through the same channels as a blocked agent. The decisions are in src/pr.mjs; this
   * is the wiring to herdr, the tracker and state.json.
   */
  async keepMergeable(key?: any, run?: any, rule?: any, pr?: any) {
    const base = pr.baseRef || 'the base branch';
    const did = await keepMergeable(run, pr, {
      log: (m?: any) => this.log(`${key}: ${m}`),
      lookupAgent: () => (run.agentName ? this.herdr.agentGet(run.agentName) : null),
      nudge: () => this.herdr.prompt(run.agentName, conflictPrompt({ prUrl: run.prUrl, branch: run.branch, baseRef: pr.baseRef, briefPath: run.dir ? path.join(run.dir, 'brief.md') : null })),
      tellPerson: () => this.report(key, rule, rule.onBlocked, coordinator(`⚠️ ${run.prUrl} conflicts with \`${base}\` and the implementer's session for ${key} has ended, so nobody is there to bring the branch up to date. Merge \`${base}\` into \`${run.branch || 'the branch'}\` by hand, or open a new session on it.`), 'request'),
    });
    if (did && did !== 'retry') this.saveState();
  }

  /**
   * Shut a merged run down — only as far as `onMerged` was asked to, which by default is not at all.
   * When every step is switched on the order is the only one that works: the agent exits first (it
   * is a process with its own idea of how to stop), then its workspace closes, and only then does
   * the worktree go, a directory nothing is standing in any more.
   *
   * Every step reports rather than throws. A merge has already happened; refusing to do the rest of
   * the cleanup because herdr was restarted, or because the worktree has scratch files in it, would
   * be the wrong trade.
   */
  async shutdown(key?: any, run?: any, rule?: any) {
    const policy = rule.onMerged || {};
    const did: string[] = [];
    // Each step is recorded as owed before it is tried, so a crash in the middle of a teardown
    // resumes the teardown rather than forgetting it. Each step tolerates being tried again.
    const step = async (kind: string, data: Record<string, unknown>, say: (outcome: string) => string) => {
      const id = this.owe(kind, data, key);
      let outcome: string;
      try { outcome = (await this.performAction(kind, data, key)) ?? 'done'; if (id !== null && isDurable(this.store)) this.store.settlePending(id, { done: true, outcome }, this.clock()); }
      catch (e: any) { outcome = `not done (${e.message})`; if (id !== null && isDurable(this.store)) this.store.settlePending(id, { done: false, error: e.message }, this.clock()); }
      this.log(`${key}: ${say(outcome)}`);
      did.push(say(outcome));
    };
    if (policy.exitAgent && run.agentName) await step('herdr.stopAgent', { agentName: run.agentName, exitCommand: exitCommandFor(rule.agentKind) }, (o) => `Agent \`${run.agentName}\` ${o.startsWith('not done') ? 'is still running' : o}.`);
    if (policy.closeWorkspace && run.workspaceId) await step('herdr.closeWorkspace', { workspaceId: run.workspaceId, owner: workspaceOwner(run, this.paths.repo) }, (o) => `herdr workspace \`${run.workspaceId}\` ${o.startsWith('not done') ? `is still open (${o.slice(9)}` : o}.`);
    if (policy.removeWorktree && run.worktree !== 'none') {
      const at = run.worktreePath || run.workDir;
      const where = at ? path.relative(rule.repo, at) || at : '(none)';
      await step('worktree.remove', { repo: rule.repo, at }, (o) => `Worktree \`${where}\` ${o === 'removed' ? 'removed' : o.replace(/^kept: /, 'kept: ')}.`);
    }
    return did;
  }

  /**
   * What a finished run still has open. This is the first line of the merge report, so it is also
   * the whole herdr notification (120 characters of it) — hence the worktree's directory name
   * rather than its path: it is what the herdr sidebar shows you anyway.
   */
  leftStanding(run?: any, rule?: any) {
    const bits = [];
    if (run.workspaceId) bits.push(`workspace \`${run.workspaceId}\``);
    const at = run.worktree !== 'none' && rule ? run.worktreePath || run.workDir : null;
    if (at && path.resolve(at) !== path.resolve(rule.repo)) bits.push(`worktree \`${path.basename(at)}\``);
    return bits.length ? `Its ${bits.join(' and ')} ${bits.length > 1 ? 'are' : 'is'} still open.` : 'Nothing was left open.';
  }

  /**
   * Ask GitHub about a run's pull request. The GitHub tracker's own token when that is the tracker,
   * otherwise whatever this machine has for GitHub (GITHUB_TOKEN, a saved login, `gh auth token`),
   * because a Linear issue's fix is a GitHub PR too. Resolved once, on the first PR to be watched.
   */
  async askPr(url?: any) {
    if (!this.pr) {
      const options = { ...(this.cfg.trackerSpec.type === 'github' ? this.cfg.trackerSpec : {}), cwd: this.paths.repo };
      const token = this.tracker instanceof GitHubTracker
        ? this.tracker.token
        : resolveCredential(GitHubTracker, { options })?.credential?.token || null;
      this.pr = { host: GitHubTracker.host(options), token };
      this.log(`  pull requests: ${this.pr.host}${token ? '' : ' (no GitHub token on this machine; only public repositories will answer)'}`);
    }
    return prState(url, { ...this.pr, fetchImpl: this.fetchImpl });
  }

  /**
   * Record the issue's own clock as it stands *after* we have finished writing to it.
   *
   * This is what stops a role with passes left from answering itself. Its closing comment bumps
   * the issue's updatedAt, and "the issue moved on since we finished" is exactly the test that
   * earns the next pass — so without this a reviewer would review its own review, for ever. Only
   * worth the extra fetch when another pass is actually possible.
   */
  async stampAnswered(key?: any, run?: any, rule?: any) {
    if (!this.tracker || passLimit(rule) <= 1) return;
    try { run.issueUpdatedAt = (await this.tracker.issueByKey(run.issueKey || issueKeyOf(key)))?.updatedAt || null; this.saveState(); }
    catch { /* finishedAt is the fallback, and it is already later than everything we wrote */ }
  }

  async report(key: string, rule: any, policy: any, body: string, sound = 'none') {
    const run = this.state.runs[key];
    const owed: Array<{ id: number | null; kind: string; data: Record<string, unknown>; runKey: string | null }> = [];
    this.commit(() => {
      this.saveState();
      if (policy?.comment && this.tracker) { const data = { issueId: run.issueId, issueKey: run.issueKey || issueKeyOf(key), body }; owed.push({ id: this.owe('tracker.comment', data, key), kind: 'tracker.comment', data, runKey: key }); }
      if (policy?.notify) { const data = { title: `weawr ${key}`, body: body.split('\n')[0].replace(/[*`]/g, '').slice(0, 120), sound }; owed.push({ id: this.owe('herdr.notify', data, key), kind: 'herdr.notify', data, runKey: key }); }
      this.emit('run.reported', key, { comment: !!(policy?.comment && this.tracker), notify: !!policy?.notify, firstLine: body.split('\n')[0].slice(0, 200) });
    });
    await this.performOwed(owed);
  }

  /** After a restart, re-attach to runs that were in flight, after finishing what the last owner left undone. */
  async resume() {
    await this.drainPending();
    // A verdict that landed while the watcher was down may have been the last one.
    for (const issueKey of new Set(Object.entries<any>(this.state.runs).filter(([, r]) => r.status === 'awaiting_merge').map(([k, r]) => r.issueKey || issueKeyOf(k)))) {
      try { await this.askForMergeIfReady(issueKey); } catch (e: any) { this.log(`${issueKey}: merge readiness not checked: ${e.message}`); }
    }
    for (const [key, run] of Object.entries<any>(this.state.runs)) {
      // A nudge held for a run that finished while the watcher was down is still owed.
      if (run.queuedNudges?.length && run.status !== 'running' && run.status !== 'starting') { await this.deliverQueuedNudges(key); continue; }
      if (run.status !== 'running' && run.status !== 'starting') continue;
      const rule = this.ruleFor(run);
      const read = await this.readResult(key, run, rule);
      if (read && 'result' in read) { await this.finalize(key, read.result, rule); continue; }
      let agent;
      try { agent = await this.herdr.agentGet(run.agentName); }
      catch (e: any) { this.log(`${key}: could not check agent ${run.agentName}, leaving the run as ${run.status}: ${e.message}`); continue; }
      if (!agent) {
        const was = run.status;
        if (was === 'starting') {
          // Died mid-start. Treat it like a failed start: hand the claim back so the issue can be
          // taken again. A start that never even got a workspace left nothing behind, so forget it
          // outright and let the next poll try again.
          await this.releaseClaim(key, run);
          if (!run.workspaceId) { delete this.state.runs[key]; this.saveState(); this.log(`${key}: was starting before restart and never got a workspace; forgetting it`); continue; }
          run.status = 'failed'; run.error ??= 'the watcher stopped before the session was up';
        } else {
          run.status = 'stopped';
        }
        run.finishedAt = this.clock().toISOString(); this.commit(() => { this.saveState(); this.emit(run.status === 'failed' ? 'run.failed' : 'run.stopped', key, { why: 'agent gone across a restart' }); });
        this.log(`${key}: was ${was} before restart, agent is gone → ${run.status}`);
        // A nudge held for the turn that died is still owed, and with the default one pass no
        // poll will ever revive this run to answer it. A fresh session in the same worktree does.
        if (run.status === 'stopped') await this.deliverQueuedNudges(key);
        continue;
      }
      run.status = 'running'; this.saveState();
      this.log(`${key}: re-attached to agent ${run.agentName}`);
      this.supervise(key);
    }
  }

  /**
   * Tell the console this team is alive: one small entry per repository in a per-user file,
   * stamped every poll. `weawr console` lists the entries and marks one stale when its last
   * poll is older than a few of its intervals. Best effort; never fails a poll.
   */
  register(extra: Partial<Registration> = {}) {
    if (!this.registration) return;
    const now = this.clock().toISOString();
    this.lastRegistration = {
      teamId: this.ids.teamId, repo: this.paths.repo, name: this.cfg.name, tracker: this.cfg.Tracker.id, version: this.version,
      hostId: this.ids.hostId, pid: process.pid, pollSeconds: this.cfg.pollSeconds, workspaceId: process.env.HERDR_WORKSPACE_ID || null,
      logPath: this.paths.logPath, socketPath: this.registration.socketPath ?? null, statePath: this.paths.statePath,
      lastPoll: now, lastSuccessfulPoll: this.lastRegistration?.lastSuccessfulPoll ?? null, lastPollError: this.lastRegistration?.lastPollError ?? null,
      ...extra,
    };
    writeRegistration(this.registration.dir, this.lastRegistration);
    this.registration.ownership?.heartbeat();
  }
  lastRegistration: Registration | null = null;

  /** Rename the herdr workspace this watcher runs in to "<name>Watch" so it is easy to find in the sidebar. */
  async labelOwnWorkspace() {
    const id = process.env.HERDR_WORKSPACE_ID;
    if (!id) return;
    const label = watchLabel(this.cfg.name);
    try { await this.herdr.renameWorkspace(id, label); this.log(`  workspace ${id} labelled "${label}"`); }
    catch (e: any) { this.log(`  could not label workspace ${id} "${label}": ${e.message}`); }
  }

  /**
   * Re-read .weawr/config.json (and the instructions files it names) if any of them changed
   * on disk since the config was last loaded. A config that fails to parse is reported and ignored:
   * the watcher keeps running on the last good one until the file is fixed. Runs already in flight
   * keep their rule by name; a rule that was removed falls back to the defaults for its reports.
   */
  reloadConfigIfChanged() {
    const stamp = configStamp(this.sources, this.cfg);
    if (stamp === this.cfg.stamp) return false;
    let next;
    try { next = loadConfig(this.sources); }
    catch (e: any) {
      this.cfg.stamp = stamp; // do not re-report the same broken file every poll
      this.log(`config changed but could not be loaded, keeping the previous one: ${e.message}`);
      return false;
    }
    const before = this.cfg;
    this.cfg = next;
    this.warned = new Set(); // rules changed, so "matches but is skipped" notes may no longer apply
    this.log(`config reloaded: watching ${next.rules.filter((r?: any) => r.enabled !== false).length} rule(s) every ${next.pollSeconds}s`);
    this.logRules();
    if (next.name !== before.name) this.labelOwnWorkspace().catch(() => {});
    return true;
  }

  logRules() {
    for (const r of this.cfg.rules) {
      const off = r.enabled === false ? ` (disabled${r.disabledReason ? `: ${r.disabledReason}` : ''})` : '';
      const runs = describeAgent(r);
      this.log(`  rule ${r.name}${r.role ? ` [${r.role}]` : ''}${off}: ${r.match}  →  ${r.repo}${runs === 'claude' ? '' : `  (${runs})`}`);
    }
    const roles = [...new Set(this.cfg.rules.filter((r?: any) => r.enabled !== false && r.role).map((r?: any) => r.role))];
    this.log(`  guards: claim label ${this.cfg.defaults.claimLabel || 'off'}${roles.length ? ` scoped to role(s) ${roles.join(', ')}` : ''}, skip issues assigned to others: ${this.cfg.defaults.skipIfAssignedToOthers ? 'on' : 'off'}; caps: ${this.cfg.maxConcurrent} total`);
    if (this.cfg.localOverrides.length) this.log(`  overrides from ${path.basename(this.paths.localConfigPath)}: ${this.cfg.localOverrides.join(', ')}`);
  }

  async loop() {
    this.log(`weawr ${this.version} in ${this.paths.repo}: watching ${this.cfg.rules.filter((r?: any) => r.enabled !== false).length} rule(s) every ${this.cfg.pollSeconds}s`);
    this.logRules();
    const who = await this.tracker.me().then(userDisplay).catch((e?: any) => `NOT REACHABLE (${e.message.slice(0, 80)})`);
    this.log(`  ${trackerBanner(this.tracker)}: ${who} (token from ${this.tracker.source || '?'}) · herdr: ${await this.herdr.serverRunning() ? 'connected' : 'NOT RUNNING'}`);
    await this.labelOwnWorkspace();
    await this.resume();
    this.register();
    let nextUpdateCheck = this.clock().getTime() + 24 * 3600e3; // startup already checked
    let polls = 0;
    for (;;) {
      polls++;
      let summary;
      try {
        this.reloadConfigIfChanged();
        const r = await this.pollOnce();
        this.register({ lastSuccessfulPoll: this.clock().toISOString(), lastPollError: null });
        if (r.picked.length) this.log(`poll #${polls}: ${r.scanned} open issues, ${r.candidates} matched, picked ${r.picked.join(', ')}`);
        const running = await this.runningSummary();
        summary = `${hms(this.clock())} poll #${polls} · ${r.scanned} open · ${r.candidates} matched · ${r.picked.length} picked${r.waiting.length ? ` · ${r.waiting.length} waiting for a slot` : ''} · running ${running.length}${running.length ? `: ${running.join(' · ')}` : ''}${this.awaitingMerge() ? ` · ${this.awaitingMerge()} awaiting merge${this.inConflict() ? ` (${this.inConflict()} in conflict)` : ''}` : ''} · next in ${this.cfg.pollSeconds}s${this.tracker.budget?.() ? ` · ${this.tracker.budget()}` : ''}`;
      } catch (e: any) {
        this.warnOnce(`poll:${e.message}`, `poll #${polls} failed: ${e.message} (further identical failures show only in the live line)`);
        this.register({ lastPollError: String(e.message).slice(0, 200) });
        summary = `${hms(this.clock())} poll #${polls} FAILED (${e.message.slice(0, 60)}) · retry in ${this.cfg.pollSeconds}s`;
      }
      this.hooks.live?.(summary);
      if (this.clock().getTime() >= nextUpdateCheck) { nextUpdateCheck = this.clock().getTime() + 24 * 3600e3; await this.hooks.updateReminder?.(); }
      await this.runDueTasks();
      if (this.stopping) break;
      await new Promise<void>((r) => { this.wake = r; setTimeout(r, this.cfg.pollSeconds * 1000); });
      this.wake = null;
      if (this.stopping) break;
    }
    this.log(`stopping: scheduling halted; ${this.supervising.size} supervised run(s) and their agents are left as they are`);
    this.saveState();
  }

  /** Drop the memoised snapshot so the next request recomputes it (after an action). */
  invalidateSnapshot(): void { this.snapshotCache = null; this.herdrCache = null; }

  /** herdr's whole snapshot as an index, asked at most every couple of seconds. null index when herdr is away. */
  async herdrIndex(): Promise<{ index: any; observedAt: string | null }> {
    const now = this.clock().getTime();
    if (this.herdrCache && now - this.herdrCache.at < TeamEngine.HERDR_TTL_MS) return { index: this.herdrCache.index, observedAt: this.herdrCache.snapshot ? new Date(this.herdrCache.at).toISOString() : null };
    let snapshot: any = null;
    try { snapshot = await this.herdr.run(['api', 'snapshot'], { timeoutMs: 10_000 }); } catch { snapshot = null; }
    const index = indexSnapshot(snapshot);
    this.herdrCache = { at: now, index, snapshot };
    return { index, observedAt: snapshot ? new Date(now).toISOString() : null };
  }

  /** The enricher, built once from what this owner holds: its tracker and this machine's GitHub token. */
  enrichment(): Enricher {
    if (this.enricher) return this.enricher;
    const host = process.env.WEAWR_GITHUB_HOST || 'github.com';
    let ghToken: string | null = null;
    try { ghToken = this.tracker instanceof GitHubTracker ? this.tracker.token : resolveCredential(GitHubTracker, { options: { cwd: this.paths.repo } })?.credential?.token || null; } catch { ghToken = null; }
    this.enricher = new Enricher({ tracker: this.tracker, ghRepo: repoFromGit(this.paths.repo, host), ghToken, host, fetchImpl: this.fetchImpl, log: (m) => this.log(m), clock: () => this.clock().getTime() });
    return this.enricher;
  }

  async sizeFor(key: string, run: any, now: number): Promise<any> {
    const LIVE = new Set(['running', 'starting', 'awaiting_merge', 'done']);
    if (!run.branch || !LIVE.has(run.status)) return this.sizes.get(key)?.value || null;
    const c = this.sizes.get(key);
    if (c && now - c.at < 30_000) return c.value;
    const cwd = [run.workDir, run.worktreePath, this.paths.repo].find((d) => d && fs.existsSync(d));
    const value = await runSize({ cwd, base: run.base || this.cfg.baseBranch || 'main', branch: run.branch });
    const out = value ? { ...value, complexity: complexity(value) } : null;
    this.sizes.set(key, { at: now, value: out });
    return out;
  }

  /**
   * The canonical snapshot of this team: what every client renders. Computed from the store's
   * runs and events, herdr's index, the sizes and the enrichment; memoised briefly. `owner` says
   * this process is online; a reader building a snapshot for an offline team uses
   * projectOffline() instead.
   */
  async snapshot(): Promise<TeamSnapshot> {
    const nowMs = this.clock().getTime();
    if (this.snapshotCache && nowMs - this.snapshotCache.at < TeamEngine.SNAPSHOT_TTL_MS) return this.snapshotCache.value;
    const { index, observedAt: herdrAt } = await this.herdrIndex();
    const runs: Record<string, any> = {};
    for (const [key, run] of Object.entries<any>(this.state.runs)) runs[key] = liveResult(run);
    const sizes: Record<string, any> = {};
    for (const [key, run] of Object.entries(runs)) { const sz = await this.sizeFor(key, run, nowMs); if (sz) sizes[key] = sz; }
    const events = isDurable(this.store) ? timelineOf(this.store.eventsAfter(0, 100_000)) : [];
    const cleared: Record<string, number> = {};
    if (isDurable(this.store)) for (const a of this.store.acknowledgements()) cleared[a.issueKey] = Date.parse(a.at) || 0;
    const enricher = this.enrichment();
    const view = teamView({
      id: slug(this.cfg.name), teamId: this.ids.teamId, repo: this.paths.repo, config: this.cfg, state: { runs }, events, index, sizes,
      registry: this.lastRegistration, stale: false, enrich: enricher.view(), cleared, seen: this.seen, now: nowMs,
      recipeRevision: this.recipeRevision, trackerScope: scopeOf(this.cfg.trackerSpec),
    });
    enricher.refresh(view.issues, nowMs);
    if (!view.watcher.workspaceId && process.env.HERDR_WORKSPACE_ID) view.watcher.workspaceId = process.env.HERDR_WORKSPACE_ID;
    view.watcher.pid = process.pid; view.watcher.version = this.version;
    const snapshot: TeamSnapshot = {
      ...view,
      protocolVersion: 1,
      generatedAt: new Date(nowMs).toISOString(),
      revision: isDurable(this.store) ? this.store.lastEventSeq() : 0,
      owner: { status: 'online', pid: process.pid, version: this.version, hostname: os.hostname(), heartbeatAt: new Date(nowMs).toISOString(), observedAt: new Date(nowMs).toISOString() },
      freshness: { herdrAt, trackerAt: enricher.lastAskedAt ? new Date(enricher.lastAskedAt).toISOString() : (this.lastRegistration?.lastSuccessfulPoll ?? null), trackerError: enricher.lastError ?? this.lastRegistration?.lastPollError ?? null },
      live: { tracker: !!this.tracker, github: !!enricher.sources.ghToken, why: this.tracker ? null : 'no tracker in this process' },
      capabilities: ['task.done', 'task.undo', 'task.stop', 'task.tail', 'task.reset', 'run.exit', 'run.tail', 'team.tidy', 'run.merge', 'recipe.upgrade'],
    } as TeamSnapshot;
    this.snapshotCache = { at: nowMs, value: snapshot };
    return snapshot;
  }

  /** When each plugin task last ran, and what it returned: what "due" and "do not repeat yourself" are measured against. */
  private taskRuns = new Map<string, { at: number; memory: Record<string, unknown> }>();

  /** Run every plugin task whose interval has passed. A task's failure is a log line, never the watcher's. */
  async runDueTasks(): Promise<string[]> {
    const ran: string[] = [];
    const tasks = this.cfg.plugins?.tasks || [];
    if (!tasks.length) return ran;
    const now = this.clock().getTime();
    let snapshot: any = null;
    for (const t of tasks) {
      const key = `${t.plugin}/${t.name}`;
      const last = this.taskRuns.get(key);
      if (last && now - last.at < t.everyMs) continue;
      snapshot ??= await this.snapshot().catch(() => null);
      const memory = last?.memory ?? {};
      try {
        const out = await t.run({ team: { id: this.ids.teamId, name: this.cfg.name, repo: this.paths.repo }, snapshot, log: (line: string) => this.log(`${key}: ${line}`), notify: (title: string, body: string) => this.herdr.notify(title, body, { sound: 'none' }), now: new Date(now), memory });
        this.taskRuns.set(key, { at: now, memory: out && typeof out === 'object' ? { ...memory, ...(out as object) } : memory });
        this.emit('plugin.task_ran', null, { task: key });
        ran.push(key);
      } catch (e: any) {
        this.taskRuns.set(key, { at: now, memory });
        this.log(`${key} failed: ${e.message}`);
      }
    }
    return ran;
  }

  /** The stable ids for a run, recorded on it at pickup. */
  idsFor(issue: any, rule: any, key: string, run: any) {
    const task = taskId(this.ids.teamId, trackerScope(this.cfg.trackerSpec), issue.identifier);
    return { hostId: this.ids.hostId, teamId: this.ids.teamId, taskId: task, roleRunId: roleRunId(task, rule.role || null), attemptId: attemptId(roleRunId(task, rule.role || null), run.pass || 1, run.startedAt) };
  }

  /**
   * The immutable record of one attempt: the exact brief, its hash, the template's hash, the
   * rule's policy as resolved for it, the agent, and the versions. What "which words was it given,
   * under which rules" is answered from, whatever the config says later.
   */
  attemptSpec(issue: any, rule: any, run: any, brief: string, key: string) {
    let templateHash: string | null = null; let instructionsHash: string | null = null;
    try { templateHash = contentHash(this.readTemplate(rule.prompt, run.recipeRevision, rule)); } catch { /* unknown */ }
    if (rule.instructions) instructionsHash = contentHash(rule.instructions);
    const policy: Record<string, unknown> = { ...policyOf(rule), maxConcurrent: rule.maxConcurrent ?? null, instructionsFile: rule.instructionsFile ?? null, mergeLabel: this.cfg.mergeLabel, mergeMethod: this.cfg.mergeMethod };
    const head = this.git(['rev-parse', 'HEAD'], run.workDir || this.paths.repo);
    return {
      id: run.ids?.attemptId || attemptId(key, run.pass || 1, run.startedAt),
      runKey: key, issueKey: issue.identifier, pass: run.pass || 1, startedAt: run.startedAt,
      spec: {
        provenance: 'recorded', ids: run.ids || null,
        recipe: { id: RECIPE_ID, revision: run.recipeRevision ?? this.recipeRevision, template: rule.prompt, templateOrigin: rule.templateOrigin || null, templateHash, instructionsHash, briefHash: contentHash(brief), briefPath: run.briefPath, resultSchema: 1 },
        briefHash: contentHash(brief),
        rule: rule.name, role: rule.role || null, policy,
        agent: { kind: rule.agentKind || 'claude', model: rule.model || null, effort: rule.effort || null, permissionMode: rule.permissionMode || null, args: [...(rule.agentArgs || []), ...(rule.claudeArgs || [])].map(String), name: run.agentName },
        weawr: { version: this.version, protocol: 1 },
        repository: { root: this.paths.repo, head, branch: run.branch || null, basedOn: run.basedOn || null, workDir: run.workDir || null },
        issue: { updatedAt: issue.updatedAt || null, labels: issue.labels || [] },
        nudgedBy: (run.nudges || []).map((n: any) => n.from),
      },
    };
  }
}

function prio(issue?: any) { return issue.priority === 0 ? 5 : issue.priority; }

/**
 * Is the agent herdr found under this run's name the session for *this* run? Agent names are made
 * from the run key, so two repositories watched on the same machine can both want "gh-20", and
 * adopting the other one's would brief an agent working in someone else's checkout. It is ours
 * when it sits inside this repository, or when it is in the workspace the previous attempt made.
 * (A different role on the same issue is a different run key, so it is never a candidate here.)
 */
function isOurAgent(agent?: any, repo?: any, previous?: any) {
  const cwd = agent?.foreground_cwd || agent?.cwd;
  const root = path.resolve(repo);
  if (cwd && (path.resolve(cwd) === root || path.resolve(cwd).startsWith(root + path.sep))) return true;
  return !!(previous?.workspaceId && previous.workspaceId === agent?.workspace_id);
}


/** The fields a tracker's assign/setState need, without the issue's text. Nothing secret, nothing large. */
function slimIssue(issue: any) {
  if (!issue || typeof issue !== 'object') return issue;
  const { id, identifier, ref, url, team, project, state, assignee, assignees, labels } = issue;
  return { id, identifier, ref, url, team, project, state, assignee, assignees, labels };
}

/** The lifecycle policy a rule resolves to: what an attempt is pinned to. Scheduling limits are not policy. */
export const PINNED_POLICY = ['worktree', 'worktreeDir', 'branch', 'permissionMode', 'agentKind', 'model', 'effort', 'agentArgs', 'claudeArgs', 'prompt', 'claimLabel', 'role', 'passes', 'basedOn', 'skipIfAssignedToOthers', 'onPickup', 'onDone', 'onBlocked', 'onIdle', 'onMerged'] as const;
export function policyOf(rule: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PINNED_POLICY) out[k] = rule?.[k] === undefined ? null : JSON.parse(JSON.stringify(rule[k]));
  return out;
}

/**
 * The watcher reads a run's result once, when the agent first stops. An agent that keeps going and
 * rewrites it (a plan that became a PR) leaves the record behind; the file in the worktree is the
 * agent's latest word, so when it parses, checks and differs, it wins in the view.
 */
function liveResult(run: any): any {
  if (!run.resultPath || !(run.status === 'done' || run.status === 'awaiting_merge')) return run;
  const live = readJson(run.resultPath, null);
  if (!live || typeof live !== 'object' || !(live as any).status || !validateResult(live).ok || JSON.stringify(live) === JSON.stringify(run.result)) return run;
  return { ...run, result: live, prUrl: run.prUrl || (live as any).prUrl || null, resultIsLive: true };
}

function slug(name: string): string { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team'; }
