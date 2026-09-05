#!/usr/bin/env node
// linear-herd — watch Linear, and when an issue matches a rule, open a herdr workspace,
// start Claude Code in it (worktree mode), brief it, and report back to Linear.
//
//   linear-herd                 run the watcher (foreground; run it inside a herdr pane)
//   linear-herd once            one poll, then exit
//   linear-herd dry-run         show what would be picked up, touch nothing
//   linear-herd match "<expr>"  evaluate an expression against live open issues
//   linear-herd status          show tracked runs
//   linear-herd reset <KEY>     forget a run so the issue can be picked up again
//   linear-herd smoke           end-to-end test against herdr with a fake issue (no Linear)
//   linear-herd init            scaffold .linear-herd/ in this repo
//   linear-herd update          reinstall the latest version from GitHub
//   linear-herd --version
//
// Run it from inside the git repository it should work on. Everything is project-local:
//   <repo>/.linear-herd/config.json        rules and defaults (committed)
//   <repo>/.linear-herd/instructions.md    repo brief appended to every agent prompt (committed)
//   <repo>/.linear-herd/prompts/default.md optional override of the built-in prompt template
//   <repo>/.linear-herd/state/             state.json, runs/<KEY>/, logs/ (gitignored)
//   <repo>/.env, <repo>/.env.local         LINEAR_API_KEY (gitignored; document it in .env.example)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/expr.mjs';
import { LinearClient } from '../src/linear.mjs';
import { Herdr, agentNameFor } from '../src/herdr.mjs';
import { newerVersion } from '../src/version.mjs';
import { desiredBranch, reconcileBranch } from '../src/branch.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = findRepoRoot(process.cwd());
const CONFIG_DIR = path.join(REPO, '.linear-herd');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_DIR = path.join(CONFIG_DIR, 'state');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const RUNS_DIR = path.join(STATE_DIR, 'runs');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const ENV_FILES = [path.join(REPO, '.env.local'), path.join(REPO, '.env')]; // first wins; process env beats both

function findRepoRoot(cwd) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return cwd; }
}

// ---------------------------------------------------------------- utilities

function ts() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function hms() { return new Date().toTimeString().slice(0, 8); }
const TTY = process.stdout.isTTY;
let liveLine = false;
/** An event: its own line, on screen and in the log file. Clears the live heartbeat line first. */
function log(...a) {
  const line = `[${ts()}] ${a.join(' ')}`;
  if (liveLine && TTY) { process.stdout.write('\r\x1b[2K'); liveLine = false; }
  console.log(line);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'linear-herd.log'), line + '\n'); } catch { /* ignore */ }
}
/** The heartbeat: one line that is overwritten in place on a TTY, printed every 10th time otherwise. */
let heartbeats = 0;
function live(text) {
  heartbeats++;
  if (TTY) { process.stdout.write(`\r\x1b[2K${text}`); liveLine = true; }
  else if (heartbeats % 10 === 1) console.log(text);
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }
function loadEnv() {
  for (const file of ENV_FILES) if (fs.existsSync(file)) loadEnvFile(file);
}
function loadEnvFile(file) {
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
function slugify(s, max = 40) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}
/** The sidebar label for the watcher's own herdr workspace. */
function watchLabel(name) { return `${name}Watch`; }
function expandTilde(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
/** Resolve a config path: ~ and absolute as-is; relative first against <repo>/.linear-herd, then the package. */
function expand(p) {
  p = expandTilde(p);
  if (path.isAbsolute(p)) return p;
  const inRepo = path.join(CONFIG_DIR, p);
  if (fs.existsSync(inRepo)) return inRepo;
  const inPkg = path.join(PKG_DIR, p);
  return fs.existsSync(inPkg) ? inPkg : inRepo;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Run git in `cwd`. Returns trimmed stdout, or null if git failed — callers must tolerate null. */
function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// ---------------------------------------------------------------- config

const DEFAULTS = {
  name: null,          // what this watcher is called; its herdr workspace is labelled "<name>Watch". Default: the repo folder name
  pollSeconds: 30,
  lookbackDays: 30,
  maxConcurrent: 3,
  defaults: {
    worktree: 'claude',            // "claude" (claude --worktree), "herdr" (herdr worktree create), or "none"
    // The branch a run works on, as a template over {{linearBranchName}} / {{slug}} / {{key}} / {{KEY}}.
    // Linear's own branch name is the default because a PR on it auto-links back to the issue. In
    // "herdr" mode it is passed to `herdr worktree create --branch`; in "claude" mode the worktree
    // is renamed onto it before the agent is prompted. null accepts whatever the tool named it.
    branch: '{{linearBranchName}}',
    permissionMode: 'auto',        // claude --permission-mode: auto (unattended), acceptEdits (asks before commands), plan, …
    claudeArgs: [],
    maxConcurrent: 2,
    prompt: 'prompts/default.md',   // repo override in .linear-herd/prompts/, else the package's
    instructions: '',               // inline text appended to the brief …
    instructionsFile: 'instructions.md', // … or a markdown file in .linear-herd/ (both are included if present)
    // Guards against double work. The claim label is added to the issue the moment it is picked up and
    // checked before pickup, so a restart, a lost state.json, or a second machine cannot take it again.
    claimLabel: 'herdr',
    skipIfAssignedToOthers: true,
    onPickup: { comment: true, state: 'In Progress', assignToMe: true },
    onDone: { comment: true, state: 'In Review', notify: true, closeWorkspace: false },
    onBlocked: { comment: true, notify: true },
    onIdle: { comment: true, notify: true },
  },
  rules: [],
};

function loadConfig() {
  const raw = readJson(CONFIG_PATH, null);
  if (!raw) throw new Error(`no config at ${CONFIG_PATH}`);
  const cfg = { ...DEFAULTS, ...raw, defaults: { ...DEFAULTS.defaults, ...(raw.defaults || {}) } };
  cfg.name = String(cfg.name || path.basename(REPO)).trim() || 'linear-herd';
  cfg.rules = (raw.rules || []).map((r, i) => {
    if (!r.match) throw new Error(`rule #${i + 1} (${r.name || 'unnamed'}) has no "match"`);
    const rule = { ...cfg.defaults, ...r, name: r.name || `rule-${i + 1}`, repo: REPO };
    for (const k of ['onPickup', 'onDone', 'onBlocked', 'onIdle']) rule[k] = { ...cfg.defaults[k], ...(r[k] || {}) };
    try { rule.compiled = compile(rule.match); } catch (e) { throw new Error(`rule "${rule.name}": ${e.message}`); }
    rule.instructions = [rule.instructions, readInstructions(rule.instructionsFile)].filter(Boolean).join('\n\n');
    return rule;
  });
  return cfg;
}

function readInstructions(file) {
  if (!file) return '';
  const p = expand(file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

// ---------------------------------------------------------------- state

function loadState() { return readJson(STATE_PATH, { runs: {} }); }
function saveState(s) { writeJson(STATE_PATH, s); }

// ---------------------------------------------------------------- brief

function renderBrief(templatePath, vars) {
  const t = fs.readFileSync(expand(templatePath), 'utf8');
  return t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
}

function briefVars({ issue, rule, run }) {
  const comments = issue.comments?.length
    ? issue.comments.map((c) => `- **${c.author}** (${c.createdAt.slice(0, 10)}): ${c.body.replace(/\r?\n/g, '\n  ')}`).join('\n')
    : '_none_';
  return {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description?.trim() || '_no description_',
    url: issue.url,
    labels: issue.labels.join(', ') || '_none_',
    project: issue.project?.name || '_none_',
    team: issue.team ? `${issue.team.name} (${issue.team.key})` : '_none_',
    priority: issue.priorityLabel || 'none',
    state: issue.state?.name || '',
    assignee: issue.assignee?.displayName || issue.assignee?.name || 'unassigned',
    comments,
    repo: rule.repo,
    branch: run.branch || '(current branch)',
    worktreeMode: rule.worktree,
    resultPath: run.resultPath,
    runDir: run.dir,
    rule: rule.name,
    instructions: rule.instructions || '',
    date: new Date().toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------- core

class LinearHerd {
  constructor({ cfg, linear, herdr, dry = false }) {
    this.cfg = cfg;
    this.linear = linear;   // null in smoke mode
    this.herdr = herdr;
    this.dry = dry;
    this.state = loadState();
    this.supervising = new Set();
  }

  runningCount(ruleName) {
    return Object.values(this.state.runs).filter((r) => r.status === 'running' && (!ruleName || r.rule === ruleName)).length;
  }

  async pollOnce() {
    const since = new Date(Date.now() - this.cfg.lookbackDays * 86400e3).toISOString();
    const viewer = await this.linear.me();
    const issues = await this.linear.openIssues({ sinceIso: since });
    const ctx = { viewer, now: Date.now() };
    const candidates = [];
    for (const issue of issues) {
      if (this.state.runs[issue.identifier]) continue;
      for (const rule of this.cfg.rules) {
        if (rule.enabled === false) continue;
        let ok = false;
        try { ok = rule.compiled.test(issue, ctx); } catch (e) { log(`rule ${rule.name}: ${e.message}`); }
        if (!ok) continue;
        const why = alreadyTaken(issue, rule, viewer);
        if (why) { this.warnOnce(`taken:${issue.identifier}`, `${issue.identifier} matches ${rule.name} but is skipped: ${why}`); break; }
        candidates.push({ issue, rule }); break;
      }
    }
    // urgent first, then oldest first
    candidates.sort((a, b) => (prio(a.issue) - prio(b.issue)) || (Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt)));
    const picked = []; const waiting = [];
    for (const c of candidates) {
      if (this.runningCount() >= this.cfg.maxConcurrent) { waiting.push(c.issue.identifier); this.warnOnce(`cap:${c.issue.identifier}`, `${c.issue.identifier} matches but waits: global cap ${this.cfg.maxConcurrent} reached`); continue; }
      if (this.runningCount(c.rule.name) >= c.rule.maxConcurrent) { waiting.push(c.issue.identifier); this.warnOnce(`cap:${c.issue.identifier}`, `${c.issue.identifier} matches but waits: rule ${c.rule.name} cap ${c.rule.maxConcurrent} reached`); continue; }
      if (this.dry) { log(`DRY would pick ${c.issue.identifier} "${c.issue.title}" via rule ${c.rule.name}`); continue; }
      try { await this.pickUp(c.issue, c.rule); picked.push(c.issue.identifier); }
      catch (e) { log(`pickup ${c.issue.identifier} failed: ${e.message}`); }
    }
    return { scanned: issues.length, candidates: candidates.length, picked, waiting };
  }

  warnOnce(key, msg) { (this.warned ??= new Set()); if (!this.warned.has(key)) { this.warned.add(key); log(msg); } }

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

  async pickUp(issue, rule) {
    const key = issue.identifier;
    const slug = `${key.toLowerCase()}-${slugify(issue.title, 32)}`.replace(/-+$/, '');
    const archiveDir = path.join(RUNS_DIR, key); // in the watcher's checkout: issue.json now, result.json copied on finish
    fs.mkdirSync(archiveDir, { recursive: true });
    const run = {
      rule: rule.name, status: 'starting', issueId: issue.id, title: issue.title, url: issue.url,
      startedAt: new Date().toISOString(), archiveDir,
      // `wantBranch` is what we want it called; `branch` is what git says it is, filled in by
      // settleBranch once the worktree exists. Nothing downstream may report a name we only guessed.
      wantBranch: desiredBranch({ template: rule.branch, issue, slug, worktree: rule.worktree }),
      branch: null,
      worktree: rule.worktree, agentName: agentNameFor(key), notified: {},
    };
    this.state.runs[key] = run; saveState(this.state);
    log(`picking up ${key} "${issue.title}" (rule ${rule.name})`);

    // Claim on Linear first, so a second watcher (or this one after a crash) sees it before any work starts.
    if (this.linear && rule.claimLabel) {
      const fresh = await this.linear.issueByKey(key);
      const why = fresh && alreadyTaken(fresh, rule, await this.linear.me());
      if (why) { delete this.state.runs[key]; saveState(this.state); throw new Error(`skipped, ${why}`); }
      await this.linear.addLabel(issue.id, rule.claimLabel);
      run.claimed = rule.claimLabel; saveState(this.state);
    }

    try {
      // 1. workspace (+ worktree)
      const label = `${key} ${issue.title}`.slice(0, 48);
      let ws;
      if (rule.worktree === 'herdr') {
        ws = await this.herdr.createWorktree({ cwd: rule.repo, branch: run.wantBranch || `linear/${slug}`, label });
        run.worktreePath = ws.path;
      } else {
        ws = await this.herdr.createWorkspace({ cwd: rule.repo, label, env: { LINEAR_ISSUE: key } });
      }
      Object.assign(run, { workspaceId: ws.workspaceId, tabId: ws.tabId, paneId: ws.paneId });
      saveState(this.state);
      log(`${key}: workspace ${ws.workspaceId} pane ${ws.paneId}`);

      fs.writeFileSync(path.join(archiveDir, 'issue.json'), JSON.stringify(issue, null, 2));

      // 2. start claude
      const agentArgs = ['--name', key];
      if (rule.worktree === 'claude') agentArgs.push('--worktree', slug);
      if (rule.permissionMode) agentArgs.push('--permission-mode', rule.permissionMode);
      agentArgs.push(...(rule.claudeArgs || []));
      await sleep(1500); // let the shell reach its prompt
      await this.startAgentWithRetry({ name: run.agentName, paneId: ws.paneId, agentArgs });
      log(`${key}: claude started as agent "${run.agentName}"`);

      // 3. brief — written INSIDE the working tree Claude actually uses (herdr reports it), under the
      // gitignored .linear-herd/state/, so reading and writing it needs no permission dialog. A path in the
      // main checkout does not work when Claude runs in a worktree.
      const workDir = run.worktreePath || await this.agentCwd(run.agentName, rule);
      run.workDir = workDir;
      // Settle the branch before the brief is rendered and before Linear is told: both quote it.
      this.settleBranch(key, run, rule, workDir);
      // Now that the worktree exists, give it a herdr workspace of its own so the sidebar shows its branch.
      await this.adoptWorktree(key, run, rule, workDir, label);
      run.dir = path.join(workDir, '.linear-herd', 'state', 'runs', key);
      run.resultPath = path.join(run.dir, 'result.json');
      fs.mkdirSync(run.dir, { recursive: true });
      const brief = renderBrief(rule.prompt, briefVars({ issue, rule, run }));
      run.briefPath = path.join(run.dir, 'brief.md');
      fs.writeFileSync(run.briefPath, brief);
      saveState(this.state);
      log(`${key}: working tree ${workDir}`);

      // 4. prompt
      await this.herdr.prompt(run.agentName, `You are working Linear issue ${key}. Your full brief is in ${run.briefPath} — read that file first and follow it exactly.`);
      const st = await this.herdr.waitAgent(run.agentName, { until: ['working'], timeoutMs: 30_000 });
      log(`${key}: prompted (state ${st})`);
      run.status = 'running'; saveState(this.state);

      // 5. tell Linear
      if (this.linear && rule.onPickup.comment) {
        const host = os.hostname();
        await this.linear.comment(issue.id, `🐑 **linear-herd** picked this up on \`${host}\` · herdr workspace \`${run.workspaceId}\` · rule \`${rule.name}\`${run.branch ? ` · branch \`${run.branch}\`` : ''}\n\nI'll post the PR link here when it is ready.`);
      }
      if (this.linear && rule.onPickup.assignToMe) { try { await this.linear.assign(issue, (await this.linear.me()).id); } catch (e) { log(`${key}: assign failed: ${e.message}`); } }
      if (this.linear && rule.onPickup.state) { try { await this.linear.setState(issue, rule.onPickup.state); } catch (e) { log(`${key}: state failed: ${e.message}`); } }

      this.supervise(key);
    } catch (e) {
      run.status = 'failed'; run.error = e.message; run.finishedAt = new Date().toISOString(); saveState(this.state);
      if (this.linear) {
        try { await this.linear.comment(issue.id, `⚠️ linear-herd failed to start a session: ${e.message}`); } catch { /* ignore */ }
        if (run.claimed) { try { await this.linear.removeLabel(issue.id, run.claimed); } catch { /* ignore */ } }
      }
      throw e;
    }
  }

  /** The directory Claude is working in: the worktree it created, or the repo. Polls herdr until it settles. */
  async agentCwd(name, rule) {
    const deadline = Date.now() + (rule.worktree === 'none' ? 4_000 : 25_000);
    let last = rule.repo;
    while (Date.now() < deadline) {
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
   * In "claude" mode the worktree is created by `claude --worktree <slug>`, which names the branch
   * itself — so the only way to get the name we want is to rename onto it, and the only way to know
   * the name is to ask git. Renaming is safe here: this runs before the agent is prompted, so the
   * branch has no commits of ours and no upstream. Anything that goes wrong is a log line, never a
   * failed run — a run on an unexpected branch name is fine, a run whose brief lies is not.
   *
   * The one thing it must never do is rename a branch in the maintainer's own checkout. `agentCwd`
   * falls back to the repo root when Claude has not moved into a worktree before its timeout, so a
   * workDir equal to the repo is read but never renamed.
   */
  settleBranch(key, run, rule, workDir) {
    if (rule.worktree === 'none') { run.branch = null; return null; }
    if (path.resolve(workDir) === path.resolve(rule.repo)) log(`${key}: no worktree of its own; leaving the branch in ${workDir} alone`);
    const { branch, action, from, want } = reconcileBranch({ git, cwd: workDir, want: run.wantBranch, repo: rule.repo });
    run.branch = branch;
    saveState(this.state);
    if (action === 'renamed') log(`${key}: branch ${from} → ${branch}`);
    else if (action === 'taken') log(`${key}: branch ${want} already exists, staying on ${branch}`);
    else if (action === 'failed') log(`${key}: could not rename ${branch} → ${want}, staying on ${branch}`);
    else if (action === 'unreadable') log(`${key}: no branch readable in ${workDir}; the brief will not name one`);
    else if (action === 'detached') log(`${key}: ${workDir} is on a detached HEAD; the brief will not name a branch`);
    else log(`${key}: branch ${branch}`);
    return branch;
  }

  /**
   * In "claude" mode the herdr workspace is created at the repo root *before* Claude makes its
   * worktree, so herdr's sidebar shows the repo's branch (main), not the run's. Once the worktree
   * exists and its branch is settled, re-home the run: open the checkout as a herdr worktree
   * workspace (herdr then shows the real branch and groups it under the repo), move Claude's pane
   * into it, and drop the placeholder. If the user already opened that checkout themselves (herdr's
   * New button does this), Claude joins their workspace as a second tab and their shell is kept.
   * Best effort: a run left in the placeholder workspace is still a perfectly good run.
   */
  async adoptWorktree(key, run, rule, workDir, label) {
    if (rule.worktree !== 'claude' || path.resolve(workDir) === path.resolve(rule.repo)) return;
    const placeholder = { workspaceId: run.workspaceId, paneId: run.paneId };
    try {
      const wt = await this.herdr.openWorktree({ cwd: rule.repo, path: workDir, label });
      if (!wt.workspaceId || wt.workspaceId === placeholder.workspaceId) return;
      const moved = await this.herdr.movePaneToWorkspace(placeholder.paneId, wt.workspaceId);
      if (!moved.changed) { log(`${key}: herdr did not move pane ${placeholder.paneId}; staying in workspace ${placeholder.workspaceId}`); return; }
      Object.assign(run, { workspaceId: wt.workspaceId, tabId: moved.tabId, paneId: moved.paneId });
      saveState(this.state);
      if (wt.alreadyOpen) {
        try { await this.herdr.renameWorkspace(wt.workspaceId, label); } catch { /* keep their name */ }
      } else if (wt.paneId) {
        try { await this.herdr.closePane(wt.paneId); } catch { /* a spare shell is harmless */ }
      }
      if (moved.closedWorkspaceId !== placeholder.workspaceId) { try { await this.herdr.closeWorkspace(placeholder.workspaceId); } catch { /* ignore */ } }
      log(`${key}: moved into herdr worktree workspace ${wt.workspaceId} pane ${run.paneId}${wt.alreadyOpen ? ' (it was already open)' : ''}`);
    } catch (e) {
      log(`${key}: could not give the worktree its own herdr workspace: ${e.message}`);
    }
  }

  async startAgentWithRetry(opts) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.herdr.startAgent(opts); }
      catch (e) {
        lastErr = e;
        if (e.code === 'agent_not_ready') return; // started but sitting on a startup dialog; supervise() will see 'blocked'
        if (!/pane_not_ready|not at.*prompt|busy|shell/i.test(e.message)) throw e;
        await sleep(2000 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /** Follow a run until it produces result.json or the agent disappears. Safe to call again after restart. */
  supervise(key) {
    if (this.supervising.has(key)) return;
    this.supervising.add(key);
    this.superviseLoop(key).catch((e) => log(`${key}: supervisor crashed: ${e.stack || e.message}`)).finally(() => this.supervising.delete(key));
  }

  async superviseLoop(key) {
    const run = this.state.runs[key];
    const rule = this.cfg.rules.find((r) => r.name === run.rule) || this.cfg.defaults;
    const name = run.agentName;
    while (run.status === 'running') {
      const st = await this.herdr.waitAgent(name, { timeoutMs: 6 * 3600e3 });
      const result = readJson(run.resultPath, null);
      if (result) { await this.finalize(key, result, rule); return; }
      if (st === 'gone') {
        run.status = 'stopped'; run.finishedAt = new Date().toISOString(); saveState(this.state);
        log(`${key}: agent exited without a result`);
        await this.report(key, rule, rule.onIdle, `🛑 The agent session for ${key} ended without writing a result. Workspace \`${run.workspaceId}\` is still open for inspection.`);
        return;
      }
      if (st === 'timeout') continue;
      if (st === 'blocked') {
        log(`${key}: blocked — waiting for approval or input in ${run.workspaceId}`);
        if (!run.notified.blocked) {
          run.notified.blocked = true; saveState(this.state);
          const tail = await this.tail(name, 12);
          await this.report(key, rule, rule.onBlocked, `✋ The agent for ${key} is waiting for approval or input in herdr workspace \`${run.workspaceId}\`.${tail}`, 'request');
        }
        const next = await this.herdr.waitAgent(name, { until: ['working', 'idle', 'done'], timeoutMs: 6 * 3600e3 });
        log(`${key}: unblocked → ${next}`);
        run.notified.blocked = false;
        continue;
      }
      if (st === 'idle' || st === 'done' || st === 'unknown') {
        // Claude finished a turn without writing result.json — probably asked a question in chat.
        log(`${key}: ${st} without a result — probably asking a question in ${run.workspaceId}`);
        if (!run.notified.idle) {
          run.notified.idle = true; saveState(this.state);
          const tail = await this.tail(name, 15);
          await this.report(key, rule, rule.onIdle, `💬 The agent for ${key} stopped without a result and is probably asking a question. Answer it in herdr workspace \`${run.workspaceId}\`.${tail}`, 'request');
        }
        await this.herdr.waitAgent(name, { until: ['working'], timeoutMs: 6 * 3600e3 });
        log(`${key}: working again`);
        run.notified.idle = false;
        continue;
      }
      log(`${key}: unexpected wait result ${st}; retrying in 30s`);
      await sleep(30_000);
    }
  }

  async tail(name, lines) {
    try {
      const text = (await this.herdr.readAgent(name, lines + 20)).trim().split('\n').filter((l) => l.trim()).slice(-lines).join('\n');
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`` : '';
    } catch { return ''; }
  }

  async finalize(key, result, rule) {
    const run = this.state.runs[key];
    run.status = 'done'; run.result = result; run.finishedAt = new Date().toISOString(); saveState(this.state);
    // keep a copy in the watcher's checkout; the worktree may be removed later
    try { fs.mkdirSync(run.archiveDir, { recursive: true }); for (const f of ['result.json', 'brief.md']) { const src = path.join(run.dir, f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(run.archiveDir, f)); } } catch { /* best effort */ }
    const status = result.status || 'unknown';
    const icon = status === 'pr_open' ? '✅' : status === 'needs_human' ? '🙋' : status === 'nothing_to_do' ? '🤷' : '❌';
    const lines = [`${icon} **linear-herd** finished ${key} with status \`${status}\`.`];
    if (result.prUrl) lines.push(`\nPR: ${result.prUrl}`);
    if (result.branch) lines.push(`Branch: \`${result.branch}\``);
    if (result.summary) lines.push(`\n${result.summary}`);
    if (result.testing) lines.push(`\n**How to test**\n${result.testing}`);
    if (result.notes) lines.push(`\n**Notes**\n${result.notes}`);
    lines.push(`\n_herdr workspace \`${run.workspaceId}\` is still open._`);
    log(`${key}: done (${status}) ${result.prUrl || ''}`);
    await this.report(key, rule, rule.onDone, lines.join('\n'), 'done');
    if (this.linear && rule.onDone.state && status === 'pr_open') {
      try { await this.linear.setState({ id: run.issueId, team: readJson(path.join(run.archiveDir, 'issue.json'), {}).team }, rule.onDone.state); }
      catch (e) { log(`${key}: onDone state failed: ${e.message}`); }
    }
    if (rule.onDone.closeWorkspace && run.workspaceId) { try { await this.herdr.closeWorkspace(run.workspaceId); } catch { /* ignore */ } }
  }

  async report(key, rule, policy, body, sound = 'none') {
    const run = this.state.runs[key];
    if (policy?.comment && this.linear) { try { await this.linear.comment(run.issueId, body); } catch (e) { log(`${key}: comment failed: ${e.message}`); } }
    if (policy?.notify) await this.herdr.notify(`linear-herd ${key}`, body.split('\n')[0].replace(/[*`]/g, '').slice(0, 120), { sound });
  }

  /** After a restart, re-attach to runs that were in flight. */
  async resume() {
    for (const [key, run] of Object.entries(this.state.runs)) {
      if (run.status !== 'running' && run.status !== 'starting') continue;
      const rule = this.cfg.rules.find((r) => r.name === run.rule) || this.cfg.defaults;
      const result = run.resultPath ? readJson(run.resultPath, null) : null;
      if (result) { await this.finalize(key, result, rule); continue; }
      const agent = await this.herdr.agentGet(run.agentName);
      if (!agent) {
        const was = run.status;
        run.status = was === 'starting' ? 'failed' : 'stopped'; run.finishedAt = new Date().toISOString(); saveState(this.state);
        log(`${key}: was ${was} before restart, agent is gone → ${run.status}`);
        continue;
      }
      run.status = 'running'; saveState(this.state);
      log(`${key}: re-attached to agent ${run.agentName}`);
      this.supervise(key);
    }
  }

  /** Rename the herdr workspace this watcher runs in to "<name>Watch" so it is easy to find in the sidebar. */
  async labelOwnWorkspace() {
    const id = process.env.HERDR_WORKSPACE_ID;
    if (!id) return;
    const label = watchLabel(this.cfg.name);
    try { await this.herdr.renameWorkspace(id, label); log(`  workspace ${id} labelled "${label}"`); }
    catch (e) { log(`  could not label workspace ${id} "${label}": ${e.message}`); }
  }

  async loop() {
    log(`linear-herd ${PKG.version} in ${REPO}: watching ${this.cfg.rules.filter((r) => r.enabled !== false).length} rule(s) every ${this.cfg.pollSeconds}s`);
    for (const r of this.cfg.rules) log(`  rule ${r.name}${r.enabled === false ? ' (disabled)' : ''}: ${r.match}  →  ${r.repo}`);
    log(`  guards: claim label ${this.cfg.defaults.claimLabel || 'off'}, skip issues assigned to others: ${this.cfg.defaults.skipIfAssignedToOthers ? 'on' : 'off'}; caps: ${this.cfg.maxConcurrent} total`);
    const who = await this.linear.me().then((u) => u.email).catch((e) => `NOT REACHABLE (${e.message.slice(0, 80)})`);
    log(`  Linear: ${who} · herdr: ${await this.herdr.serverRunning() ? 'connected' : 'NOT RUNNING'}`);
    await this.labelOwnWorkspace();
    await this.resume();
    let nextUpdateCheck = Date.now() + 24 * 3600e3; // startup already checked
    let polls = 0;
    for (;;) {
      polls++;
      let summary;
      try {
        const r = await this.pollOnce();
        if (r.picked.length) log(`poll #${polls}: ${r.scanned} open issues, ${r.candidates} matched, picked ${r.picked.join(', ')}`);
        const running = await this.runningSummary();
        summary = `${hms()} poll #${polls} · ${r.scanned} open · ${r.candidates} matched · ${r.picked.length} picked${r.waiting.length ? ` · ${r.waiting.length} waiting for a slot` : ''} · running ${running.length}${running.length ? `: ${running.join(' · ')}` : ''} · next in ${this.cfg.pollSeconds}s`;
      } catch (e) {
        this.warnOnce(`poll:${e.message}`, `poll #${polls} failed: ${e.message} (further identical failures show only in the live line)`);
        summary = `${hms()} poll #${polls} FAILED (${e.message.slice(0, 60)}) · retry in ${this.cfg.pollSeconds}s`;
      }
      live(summary);
      if (Date.now() >= nextUpdateCheck) { nextUpdateCheck = Date.now() + 24 * 3600e3; await updateReminder({ notify: true }); }
      await sleep(this.cfg.pollSeconds * 1000);
    }
  }
}

function prio(issue) { return issue.priority === 0 ? 5 : issue.priority; }

const CLAIM_MARKER = '**linear-herd** picked this up';

/** Returns a reason string if some agent or person already owns this issue, else null. */
function alreadyTaken(issue, rule, viewer) {
  if (rule.claimLabel && issue.labels.some((l) => l.toLowerCase() === rule.claimLabel.toLowerCase())) return `already carries the '${rule.claimLabel}' claim label`;
  if ((issue.comments || []).some((c) => c.body.includes(CLAIM_MARKER))) return 'a linear-herd pickup comment is already on it';
  if (rule.skipIfAssignedToOthers && issue.assignee && viewer && issue.assignee.id !== viewer.id) return `assigned to ${issue.assignee.displayName || issue.assignee.name}`;
  return null;
}

// ---------------------------------------------------------------- commands

function init() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const made = [];
  const put = (p, content) => { if (!fs.existsSync(p)) { fs.writeFileSync(p, content); made.push(path.relative(REPO, p)); } };
  put(CONFIG_PATH, fs.readFileSync(path.join(PKG_DIR, 'config.example.json'), 'utf8'));
  put(path.join(CONFIG_DIR, 'instructions.md'), fs.readFileSync(path.join(PKG_DIR, 'prompts', 'instructions.example.md'), 'utf8'));
  // gitignore the runtime state
  const gi = path.join(REPO, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\.linear-herd\/state\/?$/m.test(giText)) { fs.appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}\n# linear-herd runtime state (config.json and instructions.md are committed)\n.linear-herd/state/\n`); made.push('.gitignore (+ .linear-herd/state/)'); }
  // document the key
  const ex = path.join(REPO, '.env.example');
  const exText = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  if (!/^LINEAR_API_KEY=/m.test(exText)) { fs.appendFileSync(ex, `${exText && !exText.endsWith('\n') ? '\n' : ''}\n# linear-herd: Linear personal API key (Settings → Security & access → Personal API keys).\n# Put the real value in .env.local, never here.\nLINEAR_API_KEY=\n`); made.push('.env.example (+ LINEAR_API_KEY)'); }
  console.log(made.length ? `wrote in ${REPO}:\n  ${made.join('\n  ')}` : `nothing to do; ${path.relative(REPO, CONFIG_DIR)} already initialised`);
  console.log(`\nnext: add LINEAR_API_KEY to ${path.join(REPO, '.env.local')}, edit .linear-herd/config.json and instructions.md, then \`linear-herd match "label:ai"\``);
}

const PKG = readJson(path.join(PKG_DIR, 'package.json'), { version: '0.0.0', repository: {} });
const INSTALL_SPEC = 'github:jmwind/linear-herd';

/** Print a one-line reminder if GitHub main has a newer version. Quiet otherwise. */
async function updateReminder({ notify = false } = {}) {
  const latest = await newerVersion(PKG.version);
  if (!latest) return false;
  log(`⬆ linear-herd ${latest} is available (you have ${PKG.version}) — run: linear-herd update`);
  if (notify) await new Herdr().notify('linear-herd update available', `${PKG.version} → ${latest}: run linear-herd update`);
  return true;
}

function update() {
  console.log(`linear-herd ${PKG.version} → installing latest from ${INSTALL_SPEC} …`);
  execFileSync('npm', ['install', '-g', INSTALL_SPEC], { stdio: 'inherit' });
  const now = execFileSync('linear-herd', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`now ${now}`);
}

async function main(argv) {
  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') { console.log(PKG.version); return; }
  if (argv[0] === 'update' || argv[0] === 'upgrade') return update();
  if ((argv[0] || '') === 'init') return init();
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  loadEnv();
  const cmd = argv[0] || 'run';
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`no ${path.relative(process.cwd(), CONFIG_PATH) || CONFIG_PATH} — cd into the repo you want to work on and run \`linear-herd init\``);
  const cfg = loadConfig();
  if (cmd !== 'smoke') await updateReminder();
  const herdr = new Herdr({ log: (m) => process.env.LINEAR_HERD_DEBUG && log('  $', m) });

  if (cmd === 'status') {
    const s = loadState();
    const rows = Object.entries(s.runs);
    if (!rows.length) { console.log(`no runs yet in ${REPO}`); return; }
    console.log(`${'issue'.padEnd(10)} ${'run'.padEnd(9)} ${'agent'.padEnd(8)} ${'ws'.padEnd(4)} ${'rule'.padEnd(12)} ${'started'.padEnd(16)} outcome`);
    for (const [k, r] of rows) {
      let agent = '-';
      if (r.status === 'running') { const a = await herdr.agentGet(r.agentName).catch(() => null); agent = a?.agent_status || 'gone'; }
      const outcome = r.result ? `${r.result.status}${r.result.prUrl ? ' ' + r.result.prUrl : ''}` : (r.error || '');
      console.log(`${k.padEnd(10)} ${r.status.padEnd(9)} ${agent.padEnd(8)} ${(r.workspaceId || '').padEnd(4)} ${r.rule.padEnd(12)} ${r.startedAt.slice(0, 16)} ${outcome}  ${r.title || ''}`);
    }
    return;
  }
  if (cmd === 'reset') {
    const key = argv[1]; if (!key) throw new Error('usage: linear-herd reset <KEY>');
    const s = loadState(); delete s.runs[key]; saveState(s); console.log(`forgot ${key}`); return;
  }
  if (cmd === 'smoke') return smoke({ cfg, herdr, argv });

  const linear = new LinearClient(process.env.LINEAR_API_KEY);

  if (cmd === 'match') {
    const expr = argv.slice(1).join(' '); if (!expr) throw new Error('usage: linear-herd match "<expr>"');
    const rule = compile(expr);
    const viewer = await linear.me();
    const issues = await linear.openIssues({ sinceIso: new Date(Date.now() - cfg.lookbackDays * 86400e3).toISOString() });
    const hits = issues.filter((i) => rule.test(i, { viewer }));
    for (const i of hits) console.log(`${i.identifier.padEnd(10)} ${(i.state?.name || '').padEnd(12)} [${i.labels.join(',')}] ${i.assignee?.displayName || '-'}  ${i.title}`);
    console.log(`${hits.length} of ${issues.length} open issues match`);
    return;
  }

  if (!(await herdr.serverRunning())) throw new Error('herdr server is not running (start herdr first)');
  const app = new LinearHerd({ cfg, linear, herdr, dry: cmd === 'dry-run' });

  if (cmd === 'dry-run' || cmd === 'once') {
    if (cmd === 'once') await app.resume();
    const r = await app.pollOnce();
    log(`${r.scanned} open issues scanned, ${r.candidates} matched, ${r.picked.length} picked`);
    if (cmd === 'once' && app.supervising.size) { log(`supervising ${app.supervising.size} run(s); Ctrl-C when done`); await new Promise(() => {}); }
    return;
  }
  if (cmd === 'run') return app.loop();
  throw new Error(`unknown command ${cmd}`);
}

/** End-to-end herdr test with a fake issue: workspace → claude → brief → result.json → finalize. No Linear calls. */
async function smoke({ cfg, herdr, argv }) {
  const rule = {
    ...cfg.defaults, name: 'smoke', repo: REPO, worktree: argv.includes('--worktree') ? cfg.defaults.worktree : 'none',
    prompt: path.join(PKG_DIR, 'prompts', 'smoke.md'), instructions: '',
    onPickup: { comment: false }, onDone: { comment: false, notify: true, closeWorkspace: false },
    onBlocked: { comment: false, notify: true }, onIdle: { comment: false, notify: true },
  };
  rule.compiled = compile('any:true');
  const key = `SMOKE-${Date.now().toString().slice(-4)}`;
  const nowIso = new Date().toISOString();
  const issue = {
    id: 'fake', identifier: key, title: 'linear-herd smoke test', description: 'Prove the herdr pipeline works end to end.',
    url: 'https://linear.app/example', priority: 3, priorityLabel: 'Medium', labels: ['ai'], project: null,
    team: { id: 't', key: 'SMK', name: 'Smoke' }, assignee: null, creator: null, state: { name: 'Todo', type: 'unstarted' },
    cycle: null, comments: [], createdAt: nowIso, updatedAt: nowIso,
  };
  const app = new LinearHerd({ cfg: { ...cfg, rules: [rule] }, linear: null, herdr });
  await app.pickUp(issue, rule);
  log(`smoke: waiting for ${key} to finish…`);
  while (app.state.runs[key].status === 'running') await sleep(2000);
  const run = app.state.runs[key];
  log(`smoke: ${run.status} ${JSON.stringify(run.result || run.error || '')}`);
  console.log(`\nSmoke run ${key}: ${run.status}. herdr workspace ${run.workspaceId} left open; clean up with:\n  herdr workspace close ${run.workspaceId}\n  linear-herd reset ${key}`);
  process.exit(run.status === 'done' ? 0 : 1);
}

main(process.argv.slice(2)).catch((e) => { console.error(`linear-herd: ${e.message}`); process.exit(1); });
