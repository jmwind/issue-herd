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
//   linear-herd smoke [repo]    end-to-end test against herdr with a fake issue (no Linear)
//   linear-herd init            write a starter config, .env and prompt into the config home
//
// Config home: $LINEAR_HERD_HOME or ~/.linear-herd — config.json, .env, state.json, runs/, logs/, prompts/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/expr.mjs';
import { LinearClient } from '../src/linear.mjs';
import { Herdr, agentNameFor } from '../src/herdr.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.LINEAR_HERD_HOME ? expandTilde(process.env.LINEAR_HERD_HOME) : path.join(os.homedir(), '.linear-herd');
const CONFIG_PATH = path.join(HOME, 'config.json');
const ENV_PATH = path.join(HOME, '.env');
const STATE_PATH = path.join(HOME, 'state.json');
const RUNS_DIR = path.join(HOME, 'runs');
const LOG_DIR = path.join(HOME, 'logs');

// ---------------------------------------------------------------- utilities

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(...a) {
  const line = `[${ts()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'linear-herd.log'), line + '\n'); } catch { /* ignore */ }
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
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
function expandTilde(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
/** Resolve a config path: ~ and absolute as-is; relative first against the config home, then the package. */
function expand(p) {
  p = expandTilde(p);
  if (path.isAbsolute(p)) return p;
  const inHome = path.join(HOME, p);
  if (fs.existsSync(inHome)) return inHome;
  const inPkg = path.join(PKG_DIR, p);
  return fs.existsSync(inPkg) ? inPkg : inHome;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- config

const DEFAULTS = {
  pollSeconds: 30,
  lookbackDays: 30,
  maxConcurrent: 3,
  defaults: {
    worktree: 'claude',            // "claude" (claude --worktree), "herdr" (herdr worktree create), or "none"
    permissionMode: 'acceptEdits', // passed to `claude --permission-mode`; any other flag goes in claudeArgs
    claudeArgs: [],
    maxConcurrent: 2,
    prompt: 'prompts/default.md',
    instructions: '',
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
  cfg.rules = (raw.rules || []).map((r, i) => {
    if (!r.match) throw new Error(`rule #${i + 1} (${r.name || 'unnamed'}) has no "match"`);
    if (!r.repo) throw new Error(`rule "${r.name || i + 1}" has no "repo"`);
    const rule = { ...cfg.defaults, ...r, name: r.name || `rule-${i + 1}`, repo: expand(r.repo) };
    for (const k of ['onPickup', 'onDone', 'onBlocked', 'onIdle']) rule[k] = { ...cfg.defaults[k], ...(r[k] || {}) };
    try { rule.compiled = compile(rule.match); } catch (e) { throw new Error(`rule "${rule.name}": ${e.message}`); }
    return rule;
  });
  return cfg;
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
        if (why) { if (!this.warned?.has(issue.identifier)) { (this.warned ??= new Set()).add(issue.identifier); log(`${issue.identifier} matches ${rule.name} but is skipped: ${why}`); } break; }
        candidates.push({ issue, rule }); break;
      }
    }
    // urgent first, then oldest first
    candidates.sort((a, b) => (prio(a.issue) - prio(b.issue)) || (Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt)));
    const picked = [];
    for (const c of candidates) {
      if (this.runningCount() >= this.cfg.maxConcurrent) { log(`global cap ${this.cfg.maxConcurrent} reached; ${c.issue.identifier} waits`); break; }
      if (this.runningCount(c.rule.name) >= c.rule.maxConcurrent) { log(`rule ${c.rule.name} cap ${c.rule.maxConcurrent} reached; ${c.issue.identifier} waits`); continue; }
      if (this.dry) { log(`DRY would pick ${c.issue.identifier} "${c.issue.title}" via rule ${c.rule.name}`); continue; }
      try { await this.pickUp(c.issue, c.rule); picked.push(c.issue.identifier); }
      catch (e) { log(`pickup ${c.issue.identifier} failed: ${e.message}`); }
    }
    return { scanned: issues.length, candidates: candidates.length, picked };
  }

  async pickUp(issue, rule) {
    const key = issue.identifier;
    const slug = `${key.toLowerCase()}-${slugify(issue.title, 32)}`.replace(/-+$/, '');
    const dir = path.join(RUNS_DIR, key);
    fs.mkdirSync(dir, { recursive: true });
    const run = {
      rule: rule.name, status: 'starting', issueId: issue.id, title: issue.title, url: issue.url,
      startedAt: new Date().toISOString(), dir, resultPath: path.join(dir, 'result.json'),
      branch: rule.worktree === 'herdr' ? `linear/${slug}` : rule.worktree === 'claude' ? `claude/${slug}` : null,
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
        ws = await this.herdr.createWorktree({ cwd: rule.repo, branch: run.branch, label });
        run.worktreePath = ws.path;
      } else {
        ws = await this.herdr.createWorkspace({ cwd: rule.repo, label, env: { LINEAR_ISSUE: key, LINEAR_HERD_RUN: dir } });
      }
      Object.assign(run, { workspaceId: ws.workspaceId, tabId: ws.tabId, paneId: ws.paneId });
      saveState(this.state);
      log(`${key}: workspace ${ws.workspaceId} pane ${ws.paneId}`);

      // 2. brief
      fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(issue, null, 2));
      const brief = renderBrief(rule.prompt, briefVars({ issue, rule, run }));
      const briefPath = path.join(dir, 'brief.md');
      fs.writeFileSync(briefPath, brief);
      run.briefPath = briefPath;

      // 3. start claude
      // --add-dir makes the run directory (brief.md, result.json) part of Claude's workspace so reading and
      // writing it does not trigger a permission dialog under acceptEdits.
      const agentArgs = ['--name', key, '--add-dir', dir];
      if (rule.worktree === 'claude') agentArgs.push('--worktree', slug);
      if (rule.permissionMode) agentArgs.push('--permission-mode', rule.permissionMode);
      agentArgs.push(...(rule.claudeArgs || []));
      await sleep(1500); // let the shell reach its prompt
      await this.startAgentWithRetry({ name: run.agentName, paneId: ws.paneId, agentArgs });
      log(`${key}: claude started as agent "${run.agentName}"`);

      // 4. prompt
      await this.herdr.prompt(run.agentName, `You are working Linear issue ${key}. Your full brief is in ${briefPath} — read that file first and follow it exactly.`);
      const st = await this.herdr.waitAgent(run.agentName, { until: ['working'], timeoutMs: 30_000 });
      log(`${key}: prompted (state ${st})`);
      run.status = 'running'; saveState(this.state);

      // 5. tell Linear
      if (this.linear && rule.onPickup.comment) {
        const host = os.hostname();
        await this.linear.comment(issue.id, `🐑 **linear-herd** picked this up on \`${host}\` · herdr workspace \`${ws.workspaceId}\` · rule \`${rule.name}\`${run.branch ? ` · branch \`${run.branch}\`` : ''}\n\nI'll post the PR link here when it is ready.`);
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
        if (!run.notified.blocked) {
          run.notified.blocked = true; saveState(this.state);
          const tail = await this.tail(name, 12);
          await this.report(key, rule, rule.onBlocked, `✋ The agent for ${key} is waiting for approval or input in herdr workspace \`${run.workspaceId}\`.${tail}`, 'request');
        }
        await this.herdr.waitAgent(name, { until: ['working', 'idle', 'done'], timeoutMs: 6 * 3600e3 });
        run.notified.blocked = false;
        continue;
      }
      if (st === 'idle' || st === 'done' || st === 'unknown') {
        // Claude finished a turn without writing result.json — probably asked a question in chat.
        if (!run.notified.idle) {
          run.notified.idle = true; saveState(this.state);
          const tail = await this.tail(name, 15);
          await this.report(key, rule, rule.onIdle, `💬 The agent for ${key} stopped without a result and is probably asking a question. Answer it in herdr workspace \`${run.workspaceId}\`.${tail}`, 'request');
        }
        await this.herdr.waitAgent(name, { until: ['working'], timeoutMs: 6 * 3600e3 });
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
      try { await this.linear.setState({ id: run.issueId, team: readJson(path.join(run.dir, 'issue.json'), {}).team }, rule.onDone.state); }
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
      const result = readJson(run.resultPath, null);
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

  async loop() {
    log(`linear-herd watching ${this.cfg.rules.filter((r) => r.enabled !== false).length} rule(s) every ${this.cfg.pollSeconds}s`);
    for (const r of this.cfg.rules) log(`  rule ${r.name}${r.enabled === false ? ' (disabled)' : ''}: ${r.match}  →  ${r.repo}`);
    await this.resume();
    for (;;) {
      try {
        const r = await this.pollOnce();
        if (r.picked.length) log(`poll: ${r.scanned} open issues, ${r.candidates} matched, picked ${r.picked.join(', ')}`);
      } catch (e) { log(`poll failed: ${e.message}`); }
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
  fs.mkdirSync(path.join(HOME, 'prompts'), { recursive: true });
  const made = [];
  const put = (rel, content) => { const p = path.join(HOME, rel); if (!fs.existsSync(p)) { fs.writeFileSync(p, content); made.push(p); } };
  put('config.json', fs.readFileSync(path.join(PKG_DIR, 'config.example.json'), 'utf8'));
  put('.env', '# linear-herd secrets. Never commit this file.\n# Linear → Settings → Security & access → Personal API keys → New key\nLINEAR_API_KEY=\n\n# LINEAR_HERD_DEBUG=1   # log every herdr command\n');
  put('prompts/default.md', fs.readFileSync(path.join(PKG_DIR, 'prompts', 'default.md'), 'utf8'));
  console.log(made.length ? `wrote:\n  ${made.join('\n  ')}` : `nothing to do; ${HOME} already initialised`);
  console.log(`\nnext: put your Linear API key in ${path.join(HOME, '.env')}, edit ${CONFIG_PATH}, then \`linear-herd match "label:ai"\``);
}

async function main(argv) {
  if ((argv[0] || '') === 'init') return init();
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  loadEnv();
  const cmd = argv[0] || 'run';
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`no config at ${CONFIG_PATH} — run \`linear-herd init\` first`);
  const cfg = loadConfig();
  const herdr = new Herdr({ log: (m) => process.env.LINEAR_HERD_DEBUG && log('  $', m) });

  if (cmd === 'status') {
    const s = loadState();
    const rows = Object.entries(s.runs);
    if (!rows.length) { console.log('no runs'); return; }
    for (const [k, r] of rows) console.log(`${k.padEnd(10)} ${r.status.padEnd(9)} ${(r.workspaceId || '').padEnd(4)} ${r.rule.padEnd(14)} ${r.startedAt.slice(0, 16)}  ${r.result?.prUrl || r.error || ''}  ${r.title || ''}`);
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
  const repoArg = argv.slice(1).find((a) => !a.startsWith('--'));
  const repo = repoArg ? expand(repoArg) : cfg.rules[0]?.repo;
  if (!repo) throw new Error('usage: linear-herd smoke <repo-dir> [--worktree]');
  const rule = {
    ...cfg.defaults, name: 'smoke', repo, worktree: argv.includes('--worktree') ? cfg.defaults.worktree : 'none',
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
