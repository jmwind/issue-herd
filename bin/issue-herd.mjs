#!/usr/bin/env node
// issue-herd — watch an issue tracker (Linear or GitHub Issues); when an issue matches a rule, open
// a git worktree and a herdr workspace, start a coding agent in it, brief it, and report back.
//
//   issue-herd                 run the watcher (foreground; run it inside a herdr pane)
//   issue-herd once            one poll, then exit
//   issue-herd dry-run         show what would be picked up, touch nothing
//   issue-herd match "<expr>"  evaluate an expression against live open issues
//   issue-herd status          show tracked runs
//   issue-herd reset <KEY>     forget a run so the issue can be picked up again
//   issue-herd login [tracker] sign in (browser when possible) and save the token for this machine
//   issue-herd logout [tracker] forget the saved token
//   issue-herd smoke           end-to-end test against herdr with a fake issue (no tracker calls)
//   issue-herd init [--tracker linear|github]   scaffold .issue-herd/ in this repo
//   issue-herd update          reinstall the latest version from GitHub
//   issue-herd --version
//
// Run it from inside the git repository it should work on. Everything is project-local:
//   <repo>/.issue-herd/config.json        which tracker, rules and defaults (committed)
//   <repo>/.issue-herd/config.local.json  per-machine overrides of config.json, same shape (gitignored)
//   <repo>/.issue-herd/instructions.md    repo brief appended to every agent prompt (committed)
//   <repo>/.issue-herd/prompts/default.md optional override of the built-in prompt template
//   <repo>/.issue-herd/state/             state.json, runs/<KEY>/, logs/ (gitignored)
//   <repo>/.env, <repo>/.env.local         LINEAR_API_KEY / GITHUB_TOKEN (gitignored), if you prefer a file
//   ~/.config/issue-herd/credentials.json tokens saved by `issue-herd login` (per user, mode 600)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/expr.mjs';
import { mergeConfig, overridePaths } from '../src/config.mjs';
import { TRACKERS, isTracker, mergeSpec, trackerSpec, trackerClass } from '../src/trackers/index.mjs';
import { slugify, userDisplay } from '../src/tracker.mjs';
import { alreadyTaken, applyRoles, checkBasedOn, checkRoleBranches, claimLabelFor, heldByAPerson, issueKeyOf, normalizePasses, normalizeRole, passLimit, pickCandidates, pickupMarker, runKeyFor, workspaceLabel } from '../src/claim.mjs';
import { ask, credentialsPath, deleteCredential, noCredentialError, resolveCredential, saveCredential, terminalUi } from '../src/auth.mjs';
import { Herdr, agentNameFor, agentPlacement, isBlocked, isNameTaken } from '../src/herdr.mjs';
import { newerVersion } from '../src/version.mjs';
import { desiredBranch, reconcileBranch } from '../src/branch.mjs';
import { catchUp, defaultBranch, makeWorktree, pullBase, removeWorktree } from '../src/worktree.mjs';
import { agentArgv, describeAgent, exitCommandFor, TRANSLATED_KINDS } from '../src/agents.mjs';
import { parsePrUrl, prState, watchesMerge } from '../src/pr.mjs';
import { GitHubTracker } from '../src/trackers/github.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = findRepoRoot(process.cwd());
const CONFIG_DIR = path.join(REPO, '.issue-herd');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'config.local.json'); // per-machine overrides, gitignored
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
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'issue-herd.log'), line + '\n'); } catch { /* ignore */ }
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
  const refused = [];
  for (const file of ENV_FILES) if (fs.existsSync(file)) loadEnvFile(file, refused);
  if (refused.length) console.error(`issue-herd: ignoring ${refused.join(', ')} from the repository's .env — issue-herd's own settings come from your shell, not from a repository`);
}
/**
 * A repository's .env may carry the tracker's token, because that is the documented way to keep one
 * per project. It may NOT carry issue-herd's own settings: ISSUE_HERD_CREDENTIALS would move where
 * tokens are written and read, and ISSUE_HERD_GITHUB_HOST where they are sent. A .env is committed,
 * so honouring those would let any repository you clone and run this in redirect your credentials.
 */
function loadEnvFile(file, refused = []) {
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (/^ISSUE_HERD_/.test(m[1])) { refused.push(m[1]); continue; }
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
/** The sidebar label for the watcher's own herdr workspace. */
function watchLabel(name) { return `${name}Watch`; }
/**
 * Resolve a path named by config (`prompt`, `instructionsFile`): under <repo>/.issue-herd first,
 * then the package's own prompts/.
 *
 * Confined on purpose. config.json is committed, so the repository you run in chooses these values,
 * and whatever they name is read and pasted into the brief an unattended agent is told to follow.
 * Were an absolute path or a leading ~ allowed, `"instructionsFile":
 * "~/.config/issue-herd/credentials.json"` would copy your tokens into a file inside the working
 * tree that agent commits from.
 */
function expand(p) {
  const inRepo = path.resolve(CONFIG_DIR, p);
  if (inRepo !== CONFIG_DIR && !inRepo.startsWith(CONFIG_DIR + path.sep)) {
    throw new Error(`config path "${p}" must stay inside ${path.relative(REPO, CONFIG_DIR)}/`);
  }
  if (fs.existsSync(inRepo)) return inRepo;
  const inPkg = path.resolve(PKG_DIR, p);
  if (inPkg.startsWith(PKG_DIR + path.sep) && fs.existsSync(inPkg)) return inPkg;
  return inRepo;
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
  tracker: 'linear',   // "linear" | "github", or { "type": "github", "repo": "owner/name", … }; see src/trackers/
  pollSeconds: 30,
  lookbackDays: 30,
  maxConcurrent: 3,
  // Which claim roles this project runs, e.g. ["impl", "review"]. null means "whatever the rules
  // ask for"; a list switches on exactly those, so turning a role off is one line rather than
  // deleting the rules that use it. See src/claim.mjs.
  roles: null,
  // The branch runs are cut from, and the one the watcher's own checkout is kept on. null asks the
  // repository: origin/HEAD, else main or master. Merges land on the remote, so both halves of this
  // start with a fetch — without it every worktree is cut from whatever this checkout was standing
  // on the last time somebody pulled it by hand, which in a factory is old code.
  baseBranch: null,
  // Fast-forward this checkout onto `baseBranch` when a run is picked up and when a pull request
  // from one is merged. Only ever forwards, only when the checkout is clean and standing on that
  // branch: anything else is reported and left alone. Turn it off if the directory you started the
  // watcher in is yours to move.
  pullBase: true,
  defaults: {
    // Who creates the git worktree a run works in. "self" is issue-herd, with one `git worktree
    // add` on the branch below, so the directory and the branch are both settled before the agent
    // starts and nothing downstream has to discover or correct them. "herdr" hands the job to
    // `herdr worktree create`. "none" runs in the checkout you started the watcher in, on whatever
    // branch it is already on, and never renames anything.
    worktree: 'self',
    worktreeDir: '.issue-herd/worktrees',   // where "self" puts them, relative to the repo (gitignored)
    // The branch a run works on, as a template over {{issueBranchName}} / {{slug}} / {{key}} / {{KEY}}.
    // The tracker's own branch name is the default (Linear's auto-links a PR back to the issue;
    // GitHub's is what its "create a branch" button would name). In "herdr" mode it is passed to
    // `herdr worktree create --branch`; in "claude" mode the worktree is renamed onto it before the
    // agent is prompted. null accepts whatever the tool named it.
    branch: '{{issueBranchName}}{{roleSuffix}}',
    permissionMode: 'auto',        // claude --permission-mode: auto (unattended), acceptEdits (asks before commands), plan, …
    // Which coding agent runs, on which model, at what effort. All three are per rule, which is
    // the point: a reviewer role is only a second opinion if it is not the same model that wrote
    // the code. `agentKind` goes straight to `herdr agent start --kind` — herdr is the authority on
    // which agents it can start — and src/agents.mjs turns the other three into that agent's own
    // flags (Claude Code takes `--effort high`, codex takes `-c model_reasoning_effort="high"`).
    agentKind: 'claude',
    model: null,
    effort: null,
    agentArgs: [],                  // extra flags, passed to the agent verbatim, after everything above
    claudeArgs: [],                 // the old name for agentArgs, still honoured
    maxConcurrent: 2,
    prompt: 'prompts/default.md',   // repo override in .issue-herd/prompts/, else the package's
    instructions: '',               // inline text appended to the brief …
    instructionsFile: 'instructions.md', // … or a markdown file in .issue-herd/ (both are included if present)
    // Guards against double work. The claim label is added to the issue the moment it is picked up and
    // checked before pickup, so a restart, a lost state.json, or a second machine cannot take it again.
    claimLabel: 'herdr',
    // The claim's role. null is the old, exclusive claim on the whole issue; a role ("impl",
    // "review", "split") scopes the label, the pickup comment and the run key, so rules with
    // different roles hold the same issue at the same time without seeing each other.
    role: null,
    // How many times this rule may chime in on one issue. 1 means it takes the issue once and is
    // finished with it, which is what every rule did before this existed. More than that gives the
    // role another turn each time the issue moves on after it stopped — review, then confirm the
    // fix, then give the thumbs up — and never otherwise.
    passes: 1,
    // Whose branch this rule's worktree starts from: the name of another role. A reviewer cut from
    // the default branch cannot run the tests the implementer said passed — it does not have the
    // code. With "basedOn": "impl" the worktree is created at that role's branch, and on a later
    // turn it is fast-forwarded to whatever that branch is now. null starts from the default
    // branch, which is what every rule did before this existed.
    basedOn: null,
    skipIfAssignedToOthers: true,
    onPickup: { comment: true, state: 'In Progress', assignToMe: true },
    onDone: { comment: true, state: 'In Review', notify: true, closeWorkspace: false },
    onBlocked: { comment: true, notify: true },
    onIdle: { comment: true, notify: true },
    // A merged PR is what says a run is over, so the watcher keeps following the pull request and
    // tells you when it lands. What it does NOT do is tidy up behind you: exiting the agent throws
    // away the session you might still want to read, and none of the three teardown steps is worth
    // doing to somebody who did not ask. Turn on the ones you want, per rule or per machine:
    //   "onMerged": { "exitAgent": true, "closeWorkspace": true, "removeWorktree": true }
    // The notification names the workspace and the worktree either way, so shutting a finished run
    // down by hand is one glance rather than a hunt. `comment` is off because GitHub already writes
    // the merge into the issue's own timeline; on Linear it is worth turning on.
    onMerged: { comment: false, notify: true, exitAgent: false, closeWorkspace: false, removeWorktree: false },
  },
  rules: [],
};

const WORKTREE_MODES = new Set(['self', 'herdr', 'none']);
const EVENTS = ['onPickup', 'onDone', 'onBlocked', 'onIdle', 'onMerged'];
/** How often the watcher may ask GitHub about the same pull request, whatever `pollSeconds` says. */
const PR_POLL_MS = 60_000;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`no config at ${CONFIG_PATH}`);
  const readConfigFile = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${path.relative(REPO, p)} is not valid JSON: ${e.message}`); } };
  const local = fs.existsSync(LOCAL_CONFIG_PATH) ? readConfigFile(LOCAL_CONFIG_PATH) : null;
  const raw = mergeConfig(readConfigFile(CONFIG_PATH), local);
  const cfg = { ...DEFAULTS, ...raw, defaults: { ...DEFAULTS.defaults, ...(raw.defaults || {}) } };
  cfg.localOverrides = overridePaths(local);
  cfg.name = String(cfg.name || path.basename(REPO)).trim() || 'issue-herd';
  cfg.trackerSpec = trackerSpec(cfg.tracker);
  cfg.Tracker = trackerClass(cfg.trackerSpec);
  cfg.rules = (raw.rules || []).map((r, i) => {
    if (!r.match) throw new Error(`rule #${i + 1} (${r.name || 'unnamed'}) has no "match"`);
    const rule = { ...cfg.defaults, ...r, name: r.name || `rule-${i + 1}`, repo: REPO };
    rule.role = normalizeRole(rule.role, `rule "${rule.name}"`);
    rule.passes = normalizePasses(rule.passes, `rule "${rule.name}"`);
    rule.basedOn = normalizeRole(rule.basedOn, `rule "${rule.name}" ("basedOn")`);
    if (rule.basedOn && rule.basedOn === rule.role) throw new Error(`rule "${rule.name}": "basedOn" is its own role (${rule.role}) — a worktree cannot start from itself`);
    // Only "self" mode creates the worktree, so only "self" mode can decide where it starts.
    // Accepting it quietly elsewhere would give you a reviewer on the default branch and a config
    // that says otherwise.
    if (rule.basedOn && rule.worktree !== 'self') throw new Error(`rule "${rule.name}": "basedOn" needs "worktree": "self" (issue-herd creates the worktree, so it can start it from another role's branch); this rule is ${JSON.stringify(rule.worktree)}`);
    for (const k of EVENTS) {
      // `"onMerged": null` (or false) — in the rule or in the defaults — turns that step off
      // entirely, rather than falling back to the very defaults it is trying to switch off.
      const own = k in r ? r[k] : cfg.defaults[k];
      rule[k] = !own ? {} : { ...(cfg.defaults[k] || {}), ...own };
    }
    if (!WORKTREE_MODES.has(rule.worktree)) {
      throw new Error(`rule "${rule.name}": unknown worktree mode ${JSON.stringify(rule.worktree)} — use "self" (issue-herd creates it), "herdr", or "none"`);
    }
    try { rule.compiled = compile(rule.match); } catch (e) { throw new Error(`rule "${rule.name}": ${e.message}`); }
    rule.instructions = [rule.instructions, readInstructions(rule.instructionsFile)].filter(Boolean).join('\n\n');
    return rule;
  });
  checkBasedOn(checkRoleBranches(applyRoles(cfg.rules, cfg.roles)));
  cfg.stamp = configStamp(cfg);
  return cfg;
}

/**
 * A fingerprint of every file the config is built from: config.json, config.local.json (present
 * or not) and each rule's instructions file. The watcher compares it before every poll and
 * reloads when it changes, so editing a rule takes effect without a restart. (Prompt templates
 * are read at pickup time, so they never need a reload.)
 */
function configStamp(cfg) {
  const files = new Set([CONFIG_PATH, LOCAL_CONFIG_PATH]);
  for (const r of cfg.rules) if (r.instructionsFile) files.add(expand(r.instructionsFile));
  return [...files].map((f) => { try { const st = fs.statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return `${f}:missing`; } }).join('|');
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

/**
 * The brief's one line about turns, for a rule allowed more than one of them. The first turn is
 * told it will get another, so it can report and stop instead of trying to settle everything; a
 * later turn is pointed at what it said last time and told that answering the change is the job.
 */
function passLine(run, rule) {
  const pass = run.pass || 1;
  const head = `- Turn: **${pass} of ${passLimit(rule)}** on this issue for this rule.`;
  if (pass === 1) {
    return `${head} You will get another turn if the issue moves on
  after you finish, so it is fine to report what you found and stop rather than trying to settle
  everything now.`;
  }
  return `${head} Your own last turn is in
  \`${run.previousResultPath || 'the run directory'}\`, and what you said is already a comment on the
  issue. Read both first: something changed after you finished, and answering *that* is this turn's
  job — do not start the work again from the beginning.`;
}

function briefVars({ issue, rule, run, tracker }) {
  const comments = issue.comments?.length
    ? issue.comments.map((c) => `- **${c.author}** (${c.createdAt.slice(0, 10)}): ${c.body.replace(/\r?\n/g, '\n  ')}`).join('\n')
    : '_none_';
  const vars = {
    tracker,
    identifier: issue.identifier,
    ref: issue.ref || issue.identifier,
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
    basedOn: run.basedOn || '',
    // A worktree started from another role's branch already holds the code under review, which is
    // the difference between reading a diff and running its tests. Say so, or the agent will go
    // looking for the change somewhere else.
    _baseLine: run.basedOn
      ? `- **The code you are looking at is already here.** This worktree was created from \`${run.basedOn}\`, the
  implementer's branch, so the change is checked out and you can build it and run its tests in place.
  On a later turn it is fast-forwarded to whatever that branch is now. Do not push from here.`
      : '',
    worktreeMode: rule.worktree,
    resultPath: run.resultPath,
    runDir: run.dir,
    rule: rule.name,
    role: rule.role || 'none',
    pass: String(run.pass || 1),
    passes: String(passLimit(rule)),
    // Only a rule that gets more than one turn says anything about turns, and only a later turn
    // points at what the earlier one left behind.
    _passLine: passLimit(rule) > 1 ? passLine(run, rule) : '',
    // A whole line, so a roleless brief says nothing about roles at all rather than "role: none".
    _roleLine: rule.role
      ? `- Role: \`${rule.role}\` — this run holds the \`${rule.role}\` claim on the issue. Other agents may hold
  other roles (implementation, review, splitting) on the same issue at the same time: do your role's
  work only, and do not undo or redo theirs.`
      : '',
    instructions: rule.instructions || '',
    date: new Date().toISOString().slice(0, 10),
  };
  // One block, not three placeholders: an ordinary run has nothing to say about roles, turns or a
  // base branch, and three empty substitutions leave three blank lines in the middle of the brief.
  vars.runLines = [vars._roleLine, vars._passLine, vars._baseLine].filter(Boolean).join('\n');
  for (const k of ['_roleLine', '_passLine', '_baseLine']) delete vars[k];
  return vars;
}

// ---------------------------------------------------------------- core

class IssueHerd {
  constructor({ cfg, tracker, herdr, dry = false }) {
    this.cfg = cfg;
    this.tracker = tracker; // null in smoke mode
    this.herdr = herdr;
    this.dry = dry;
    this.state = loadState();
    this.supervising = new Set();
  }

  runningCount(ruleName) {
    return Object.values(this.state.runs).filter((r) => r.status === 'running' && (!ruleName || r.rule === ruleName)).length;
  }

  async pollOnce() {
    if (!this.dry) await this.checkMerges();
    const since = new Date(Date.now() - this.cfg.lookbackDays * 86400e3).toISOString();
    const viewer = await this.tracker.me();
    const issues = await this.tracker.openIssues({ sinceIso: since });
    const ctx = { viewer, now: Date.now() };
    const candidates = pickCandidates({
      issues, rules: this.cfg.rules, viewer,
      matches: (issue, rule) => { try { return rule.compiled.test(issue, ctx); } catch (e) { log(`rule ${rule.name}: ${e.message}`); return false; } },
      runFor: (key) => this.state.runs[key] || null,
      onSkip: (key, rule, why) => this.warnOnce(`taken:${key}`, `${key} matches ${rule.name} but is skipped: ${why}`),
    });
    // urgent first, then oldest first
    candidates.sort((a, b) => (prio(a.issue) - prio(b.issue)) || (Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt)));
    const picked = []; const waiting = [];
    for (const c of candidates) {
      if (this.runningCount() >= this.cfg.maxConcurrent) { waiting.push(c.key); this.warnOnce(`cap:${c.key}`, `${c.key} matches but waits: global cap ${this.cfg.maxConcurrent} reached`); continue; }
      if (this.runningCount(c.rule.name) >= c.rule.maxConcurrent) { waiting.push(c.key); this.warnOnce(`cap:${c.key}`, `${c.key} matches but waits: rule ${c.rule.name} cap ${c.rule.maxConcurrent} reached`); continue; }
      if (this.dry) { log(`DRY would pick ${c.key} "${c.issue.title}" via rule ${c.rule.name}${c.rule.role ? ` as ${c.rule.role}` : ''}${c.pass > 1 ? ` (pass ${c.pass})` : ''}`); continue; }
      try { await this.pickUp(c.issue, c.rule, { pass: c.pass, holdsClaim: c.holdsClaim }); picked.push(c.key); }
      catch (e) { log(`pickup ${c.key} failed: ${e.message}`); }
    }
    return { scanned: issues.length, candidates: candidates.length, picked, waiting };
  }

  warnOnce(key, msg) { (this.warned ??= new Set()); if (!this.warned.has(key)) { this.warned.add(key); log(msg); } }

  /** How many runs are done but still waiting for their pull request to be merged. */
  awaitingMerge() { return Object.values(this.state.runs).filter((r) => r.status === 'awaiting_merge').length; }

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

  async pickUp(issue, rule, { pass = 1, holdsClaim = false } = {}) {
    // The run key carries the role, so two roles on one issue are two runs: two state entries, two
    // agent names, two worktrees, two run directories. `issue.identifier` is still what the tracker
    // is asked about — never the run key. A retry of *this* role finds its own previous run, and
    // with it the session that may still be up; another role's run is a different key entirely.
    const key = runKeyFor(issue.identifier, rule.role);
    const previous = this.state.runs[key]; // a run we are retrying; its session may still be up
    const slug = `${slugify(key, 48)}-${slugify(issue.title, 32)}`.replace(/-+$/, '');
    const archiveDir = path.join(RUNS_DIR, key); // in the watcher's checkout: issue.json now, result.json copied on finish
    fs.mkdirSync(archiveDir, { recursive: true });
    const run = {
      rule: rule.name, role: rule.role || null, pass, status: 'starting',
      issueId: issue.id, issueKey: issue.identifier, title: issue.title, url: issue.url,
      startedAt: new Date().toISOString(), archiveDir,
      // `wantBranch` is what we want it called; `branch` is what git says it is, filled in by
      // settleBranch once the worktree exists. Nothing downstream may report a name we only guessed.
      wantBranch: desiredBranch({ template: rule.branch, issue, slug, worktree: rule.worktree, role: rule.role }),
      branch: null,
      worktree: rule.worktree, agentName: agentNameFor(key), notified: {},
    };
    this.state.runs[key] = run; saveState(this.state);
    log(`picking up ${key} "${issue.title}" (rule ${rule.name}${rule.role ? `, role ${rule.role}` : ''}${pass > 1 ? `, pass ${pass} of ${passLimit(rule)}` : ''})`);

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
      } catch (e) {
        delete this.state.runs[key]; saveState(this.state);
        throw e;
      }
      run.claimed = claimLabel; saveState(this.state);
    }

    try {
      // 0. Whatever mode this rule runs in, the checkout the watcher lives in is about to be the
      //    starting point for a run — literally so in "none" and "herdr" modes — and merges land on
      //    the remote, not here. This is the moment it is worth being current.
      this.freshenCheckout(key);

      // 1. An earlier attempt at this issue may have left its session running: a start that failed
      //    after `agent start` succeeded, or an `issue-herd reset` followed by another pickup. herdr
      //    agent names are unique, so building a second workspace and starting a second agent under
      //    the same name cannot work — it is refused with `agent_name_taken`, and what it leaves
      //    behind is an empty workspace and a live session nobody is watching. That session is this
      //    issue's session, and it is the one the owner has been typing into. Take it back.
      const found = await this.herdr.agentGet(run.agentName).catch((e) => { log(`${key}: could not ask herdr about agent ${run.agentName}: ${e.message}`); return null; });
      const existing = found && isOurAgent(found, rule.repo, previous) ? found : null;
      if (found && !existing) log(`${key}: an agent called "${run.agentName}" is running in ${found.foreground_cwd || found.cwd}, which is not this repository; leaving it alone`);

      // 2. workspace (+ worktree)
      // "GH-7 review Fix the thing" — the role sits right after the key so the sidebar shows who
      // is doing what without opening anything.
      const label = workspaceLabel({ key: issue.identifier, role: rule.role, title: issue.title });
      let ws;
      if (existing) {
        ws = agentPlacement(existing);
        run.adopted = true;
        run.worktreePath = ws.cwd;
        log(`${key}: agent "${run.agentName}" is already running (${existing.agent_status}) in ${ws.cwd}; reusing that session`);
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
        const made = makeWorktree({ git, repo: rule.repo, dir: rule.worktreeDir, slug, branch: run.wantBranch || `herd/${slug}`, base: from });
        run.worktreePath = made.path;
        log(`${key}: worktree ${made.created ? 'created' : 'reused'} at ${made.path}${made.base ? ` from ${made.base}` : ''}`);
        // Anything but a worktree we just cut from the base is potentially behind it: a directory
        // reused from an earlier turn, and also a fresh directory put back on a branch that already
        // existed (the worktree was removed but the branch survived). Both leave this turn reading
        // the last turn's code, which is how a reviewer confirms its own findings were ignored.
        if (run.basedOn && !made.base) {
          const r = catchUp({ git, repo: rule.repo, at: made.path, base: run.basedOn });
          log(`${key}: ${r.moved ? `caught up to ${run.basedOn} (${String(r.from).slice(0, 7)} → ${String(r.at).slice(0, 7)})` : `not moved onto ${run.basedOn}: ${r.reason}`}`);
        }
        ws = await this.workspaceIn(made.path, rule.repo, label);
      } else {
        ws = await this.herdr.createWorkspace({ cwd: rule.repo, label, env: { HERD_ISSUE: key } });
      }
      Object.assign(run, { workspaceId: ws.workspaceId, tabId: ws.tabId, paneId: ws.paneId });
      saveState(this.state);
      log(`${key}: workspace ${ws.workspaceId} pane ${ws.paneId}`);

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
        log(`${key}: claude started as agent "${run.agentName}"`);
      }

      // 4. brief — written INSIDE the working tree the agent actually uses, under the gitignored
      // .issue-herd/state/, so reading and writing it needs no permission dialog. A path in the main
      // checkout does not work from a worktree.
      let workDir = run.worktreePath;
      if (workDir) {
        // We know where we put it, but a Claude Code setting that forces its own worktree can still
        // move the agent, and the brief has to be written where the agent really is. herdr wins.
        const seen = await this.herdr.agentGet(run.agentName).then((a) => a?.foreground_cwd || a?.cwd).catch(() => null);
        if (seen && path.resolve(seen) !== path.resolve(workDir)) {
          log(`${key}: the agent is in ${seen}, not the worktree we made; using that`);
          workDir = seen;
        }
      } else {
        workDir = await this.agentCwd(run.agentName, rule);
      }
      run.workDir = workDir;
      // Settle the branch before the brief is rendered and before the tracker is told: both quote it.
      this.settleBranch(key, run, rule, workDir);
      run.dir = path.join(workDir, '.issue-herd', 'state', 'runs', key);
      run.resultPath = path.join(run.dir, 'result.json');
      fs.mkdirSync(run.dir, { recursive: true });
      // A further pass reuses the worktree, so the last pass's result.json is still sitting there.
      // Left alone, the supervisor would read it the moment this agent paused and finalize the new
      // pass with the old pass's answer. Move it aside — under a name the agent can still read,
      // because "what did I say last time" is the whole point of having another turn.
      if (pass > 1 && fs.existsSync(run.resultPath)) {
        run.previousResultPath = path.join(run.dir, `result.pass${pass - 1}.json`);
        try { fs.renameSync(run.resultPath, run.previousResultPath); }
        catch (e) { log(`${key}: could not set the previous result aside (${e.message}); removing it instead`); fs.rmSync(run.resultPath, { force: true }); run.previousResultPath = null; }
      }
      const brief = renderBrief(rule.prompt, briefVars({ issue, rule, run, tracker: this.cfg.Tracker.label }));
      run.briefPath = path.join(run.dir, 'brief.md');
      fs.writeFileSync(run.briefPath, brief);
      saveState(this.state);
      log(`${key}: working tree ${workDir}`);

      // 5. prompt. The session is up and briefed, so from here on the run is the supervisor's:
      // a prompt herdr will not take yet (Claude Code came up on its trust dialog, say) is a run
      // waiting for its owner, not a failed one. Failing here used to abandon a live agent that had
      // never been told what to do, and then collide with it on the retry.
      run.promptText = `You are working ${this.cfg.Tracker.label} issue ${key}. Your full brief is in ${run.briefPath} — read that file first and follow it exactly.`;
      run.pendingPrompt = true;
      run.status = 'running'; saveState(this.state);
      const sent = await this.deliverPrompt(key, run);
      if (sent) {
        const st = await this.herdr.waitAgent(run.agentName, { until: ['working'], timeoutMs: 30_000 });
        log(`${key}: prompted (state ${st})`);
      }

      // 5. tell the tracker. The session is up and briefed by now, so nothing here may fail the run.
      if (this.tracker && rule.onPickup.comment) {
        // pickupMarker() writes the role into the first words, because this comment is also the
        // guard: a reader sees who holds which role, and alreadyTaken() greps for its own.
        const held = [`herdr workspace \`${run.workspaceId}\``, `agent \`${run.agentName}\``, `rule \`${rule.name}\``];
        if (passLimit(rule) > 1) held.unshift(`pass ${pass} of ${passLimit(rule)}`);
        if (run.branch) held.push(`branch \`${run.branch}\``);
        const how = run.adopted ? pickupMarker(rule.role).replace('picked this up', 'took this back over') : pickupMarker(rule.role);
        try { await this.tracker.comment(issue.id, `🐑 ${how} on \`${os.hostname()}\` · ${held.join(' · ')}\n\nI'll post the PR link here when it is ready.`); }
        catch (e) { log(`${key}: pickup comment failed: ${e.message}`); }
      }
      if (!sent) {
        run.notified.blocked = true; saveState(this.state);
        await this.report(key, rule, rule.onBlocked, `✋ The agent for ${key} is not taking input yet — answer whatever it is showing in herdr workspace \`${run.workspaceId}\` and issue-herd will send it the brief.${await this.tail(run.agentName, 12)}`, 'request');
      }
      if (this.tracker && rule.onPickup.assignToMe) { try { await this.tracker.assign(issue, await this.tracker.me()); } catch (e) { log(`${key}: assign failed: ${e.message}`); } }
      if (this.tracker && rule.onPickup.state) { try { await this.tracker.setState(issue, rule.onPickup.state); } catch (e) { log(`${key}: state failed: ${e.message}`); } }

      this.supervise(key);
    } catch (e) {
      run.status = 'failed'; run.error = e.message; run.finishedAt = new Date().toISOString(); saveState(this.state);
      if (this.tracker) {
        try { await this.tracker.comment(issue.id, `⚠️ issue-herd failed to start a session: ${e.message}`); } catch { /* ignore */ }
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
  async releaseClaim(key, run) {
    if (!this.tracker) return;
    if (run.claimed) {
      try { await this.tracker.removeLabel(run.issueId, run.claimed); log(`${key}: removed the '${run.claimed}' claim label`); }
      catch (e) { log(`${key}: could not remove the '${run.claimed}' claim label: ${e.message}`); }
    }
    try { run.issueUpdatedAt = (await this.tracker.issueByKey(run.issueKey || issueKeyOf(key)))?.updatedAt || null; } catch { /* finishedAt is the fallback */ }
    saveState(this.state);
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
  baseBranchFor(issue, rule, key) {
    if (!rule.basedOn) return null;
    const from = this.state.runs[runKeyFor(issue.identifier, rule.basedOn)];
    if (!from) { log(`${key}: no '${rule.basedOn}' run on ${issue.identifier} yet, so its worktree starts from the default branch`); return null; }
    if (!from.branch) { log(`${key}: the '${rule.basedOn}' run has no branch of its own, so this worktree starts from the default branch`); return null; }
    return from.branch;
  }

  /**
   * The branch a run is cut from when no role says otherwise, and the branch this checkout is meant
   * to be standing on. Asked each time rather than remembered: it is two cheap git calls, and a
   * config reload can change `baseBranch` under us.
   */
  baseBranch() {
    return this.cfg.baseBranch || defaultBranch({ git, repo: REPO });
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
  freshenCheckout(why) {
    if (!this.cfg.pullBase) return null;
    // One thing a fast-forward can disturb: a `worktree: "none"` run has an agent working in this
    // directory right now, and moving the floor under it is not the sort of help anybody wants.
    const busy = Object.values(this.state.runs).find((r) => r.status === 'running' && r.workDir && path.resolve(r.workDir) === REPO);
    if (busy) return { pulled: false, reason: `${busy.issueKey} is working in it` };
    const base = this.baseBranch();
    const r = pullBase({ git, repo: REPO, base });
    if (r.pulled) log(`${why}: this checkout fast-forwarded onto ${r.ref} (${String(r.from).slice(0, 7)} → ${String(r.at).slice(0, 7)})`);
    else if (r.reason !== 'already up to date') this.warnOnce(`pullBase:${r.reason}`, `this checkout is not being pulled onto ${base}: ${r.reason}`);
    return r;
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
   * We create the worktree on the branch we want, so this is normally just the confirmation step:
   * ask git, record what it says, move on. It still matters. A Claude Code setting that forces its
   * own worktree can put the agent somewhere we did not choose, and then renaming onto the name we
   * promised is how the brief, the pickup comment and the PR keep telling the same story. Anything
   * that goes wrong is a log line, never a failed run — a run on an unexpected branch name is fine,
   * a run whose brief lies is not.
   *
   * The one thing it must never do is rename a branch in the maintainer's own checkout, which is
   * why a workDir equal to the repo is read but never renamed.
   */
  settleBranch(key, run, rule, workDir) {
    if (rule.worktree === 'none') { run.branch = null; return null; }
    if (path.resolve(workDir) === path.resolve(rule.repo)) log(`${key}: no worktree of its own; leaving the branch in ${workDir} alone`);
    // An adopted session may already have commits and an upstream on the branch it is on, so the
    // name it is standing on wins over the one this pickup would have chosen. Only a session we
    // just started is renameable.
    const { branch, action, from, want } = reconcileBranch({ git, cwd: workDir, want: run.adopted ? null : run.wantBranch, repo: rule.repo });
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
   * A herdr workspace sitting in `dir`. `worktree open` is preferred because herdr then shows the
   * run's real branch and groups it under the repo, and it hands back a fresh shell pane to start
   * the agent in. A plain workspace is the fallback: if you already had that checkout open, herdr
   * returns your workspace and your shell, which is not ours to start an agent in.
   */
  async workspaceIn(dir, repo, label) {
    try {
      const wt = await this.herdr.openWorktree({ cwd: repo, path: dir, label });
      if (wt.paneId && !wt.alreadyOpen) return wt;
      if (wt.alreadyOpen) log(`  ${dir} is already open in herdr; giving the run its own workspace`);
    } catch (e) {
      log(`  herdr worktree open failed (${e.message}); using a plain workspace`);
    }
    return this.herdr.createWorkspace({ cwd: dir, label });
  }

  async startAgentWithRetry(opts) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.herdr.startAgent(opts); }
      catch (e) {
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
  async deliverPrompt(key, run) {
    if (!run.pendingPrompt) return true;
    try {
      await this.herdr.prompt(run.agentName, run.promptText);
      run.pendingPrompt = false; saveState(this.state);
      log(`${key}: briefed`);
      return true;
    } catch (e) {
      log(`${key}: the agent has not taken the brief yet (${isBlocked(e) ? 'it is showing a dialog' : e.message}); will try again when it takes input`);
      return false;
    }
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
      // A brief herdr would not take at pickup is owed to the agent; give it the moment it will.
      if (run.pendingPrompt && await this.deliverPrompt(key, run)) run.notified.blocked = false;
      const st = await this.herdr.waitAgent(name, { timeoutMs: 6 * 3600e3 });
      const result = readJson(run.resultPath, null);
      if (result) { await this.finalize(key, result, rule); return; }
      if (st === 'gone') {
        run.status = 'stopped'; run.finishedAt = new Date().toISOString(); saveState(this.state);
        log(`${key}: agent exited without a result`);
        await this.report(key, rule, rule.onIdle, `🛑 The agent session for ${key} ended without writing a result. Workspace \`${run.workspaceId}\` is still open for inspection.`);
        // Stamp for the same reason finalize does, and here it matters more: a rule with turns left
        // would otherwise read our own "the agent died" comment as the issue moving on and start
        // the next turn immediately, burning every turn on a session that keeps dying.
        await this.stampAnswered(key, run, rule);
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
    const lines = [`${icon} **issue-herd** finished ${run.issueKey || key}${run.role ? ` as \`${run.role}\`` : ''} with status \`${status}\`.`];
    if (result.prUrl) lines.push(`\nPR: ${result.prUrl}`);
    if (result.branch) lines.push(`Branch: \`${result.branch}\``);
    if (result.summary) lines.push(`\n${result.summary}`);
    if (result.testing) lines.push(`\n**How to test**\n${result.testing}`);
    if (result.notes) lines.push(`\n**Notes**\n${result.notes}`);
    // A merged PR is what says the run is over; until then the workspace and the worktree stay up
    // for whoever reviews it. A prUrl that is not a pull request URL is not followed — the agent
    // wrote it, and the watcher will not sit waiting for a merge that can never be seen.
    const watch = status === 'pr_open' && watchesMerge(rule) && parsePrUrl(result.prUrl) ? result.prUrl : null;
    lines.push(watch
      ? `\n_herdr workspace \`${run.workspaceId}\` and the run's worktree stay up until ${watch} is merged._`
      : `\n_herdr workspace \`${run.workspaceId}\` is still open._`);
    log(`${key}: done (${status}) ${result.prUrl || ''}`);
    await this.report(key, rule, rule.onDone, lines.join('\n'), 'done');
    if (this.tracker && rule.onDone.state && status === 'pr_open') {
      try { await this.tracker.setState({ ...readJson(path.join(run.archiveDir, 'issue.json'), {}), id: run.issueId }, rule.onDone.state); }
      catch (e) { log(`${key}: onDone state failed: ${e.message}`); }
    }
    if (rule.onDone.closeWorkspace && run.workspaceId) { try { await this.herdr.closeWorkspace(run.workspaceId); } catch { /* ignore */ } }
    if (watch) {
      run.prUrl = watch; run.status = 'awaiting_merge'; saveState(this.state);
      log(`${key}: waiting for ${watch} to be merged before shutting the run down`);
    }
    await this.stampAnswered(key, run, rule);
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
      if (run.prCheckedAt && Date.now() - Date.parse(run.prCheckedAt) < PR_POLL_MS) continue;
      const rule = this.cfg.rules.find((r) => r.name === run.rule) || { ...this.cfg.defaults, repo: REPO };
      let pr = null;
      try { pr = await this.askPr(run.prUrl); }
      catch (e) { this.warnOnce(`pr:${key}:${e.message}`, `${key}: cannot read ${run.prUrl}, so a merge cannot be seen: ${e.message}`); }
      run.prCheckedAt = new Date().toISOString(); saveState(this.state);
      if (!pr || pr.state === 'open') continue;
      if (pr.state === 'closed') {
        run.status = 'done'; run.finishedAt ||= new Date().toISOString(); saveState(this.state);
        log(`${key}: ${run.prUrl} was closed without merging; leaving workspace ${run.workspaceId} and the worktree alone`);
        continue;
      }
      run.mergedAt = pr.mergedAt || new Date().toISOString();
      log(`${key}: ${run.prUrl} is merged`);
      // That merge is a commit on the base branch that this checkout does not have. Runs are cut
      // from the tip either way, but the directory you and the "none"/"herdr" modes work in is not.
      this.freshenCheckout(key);
      const did = await this.shutdown(key, run, rule);
      run.status = 'merged'; run.finishedAt = new Date().toISOString(); saveState(this.state);
      // The notification only carries the first line, and with nothing switched on the thing you
      // need from it is what is still standing — so that goes first and the URL follows.
      const lines = did.length
        ? [`🎉 ${key} is finished — ${run.prUrl} is merged, so the run was shut down.`, '', ...did.map((d) => `- ${d}`)]
        : [`🎉 ${key} is finished — its PR is merged. ${this.leftStanding(run, rule)}`, '', run.prUrl];
      await this.report(key, rule, rule.onMerged, lines.join('\n'), 'done');
      await this.stampAnswered(key, run, rule);
    }
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
  async shutdown(key, run, rule) {
    const policy = rule.onMerged || {};
    const did = [];
    if (policy.exitAgent && run.agentName) {
      const how = await this.herdr.stopAgent(run.agentName, { exitCommand: exitCommandFor(rule.agentKind) });
      log(`${key}: agent ${run.agentName} ${how}`);
      did.push(`Agent \`${run.agentName}\` ${how}.`);
    }
    if (policy.closeWorkspace && run.workspaceId) {
      try { await this.herdr.closeWorkspace(run.workspaceId); log(`${key}: workspace ${run.workspaceId} closed`); did.push(`herdr workspace \`${run.workspaceId}\` closed.`); }
      catch (e) { log(`${key}: could not close workspace ${run.workspaceId}: ${e.message}`); did.push(`herdr workspace \`${run.workspaceId}\` is still open (${e.message}).`); }
    }
    if (policy.removeWorktree && run.worktree !== 'none') {
      const at = run.worktreePath || run.workDir;
      const r = removeWorktree({ git, repo: rule.repo, at });
      const where = at ? path.relative(rule.repo, at) || at : '(none)';
      log(`${key}: worktree ${where}: ${r.removed ? 'removed' : `kept — ${r.reason}`}`);
      did.push(r.removed ? `Worktree \`${where}\` removed.` : `Worktree \`${where}\` kept: ${r.reason}.`);
    }
    return did;
  }

  /**
   * What a finished run still has open. This is the first line of the merge report, so it is also
   * the whole herdr notification (120 characters of it) — hence the worktree's directory name
   * rather than its path: it is what the herdr sidebar shows you anyway.
   */
  leftStanding(run, rule) {
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
  async askPr(url) {
    if (!this.pr) {
      const options = { ...(this.cfg.trackerSpec.type === 'github' ? this.cfg.trackerSpec : {}), cwd: REPO };
      const token = this.tracker instanceof GitHubTracker
        ? this.tracker.token
        : resolveCredential(GitHubTracker, { options })?.credential?.token || null;
      this.pr = { host: GitHubTracker.host(options), token };
      log(`  pull requests: ${this.pr.host}${token ? '' : ' (no GitHub token on this machine; only public repositories will answer)'}`);
    }
    return prState(url, this.pr);
  }

  /**
   * Record the issue's own clock as it stands *after* we have finished writing to it.
   *
   * This is what stops a role with passes left from answering itself. Its closing comment bumps
   * the issue's updatedAt, and "the issue moved on since we finished" is exactly the test that
   * earns the next pass — so without this a reviewer would review its own review, for ever. Only
   * worth the extra fetch when another pass is actually possible.
   */
  async stampAnswered(key, run, rule) {
    if (!this.tracker || passLimit(rule) <= 1) return;
    try { run.issueUpdatedAt = (await this.tracker.issueByKey(run.issueKey || issueKeyOf(key)))?.updatedAt || null; saveState(this.state); }
    catch { /* finishedAt is the fallback, and it is already later than everything we wrote */ }
  }

  async report(key, rule, policy, body, sound = 'none') {
    const run = this.state.runs[key];
    if (policy?.comment && this.tracker) { try { await this.tracker.comment(run.issueId, body); } catch (e) { log(`${key}: comment failed: ${e.message}`); } }
    if (policy?.notify) await this.herdr.notify(`issue-herd ${key}`, body.split('\n')[0].replace(/[*`]/g, '').slice(0, 120), { sound });
  }

  /** After a restart, re-attach to runs that were in flight. */
  async resume() {
    for (const [key, run] of Object.entries(this.state.runs)) {
      if (run.status !== 'running' && run.status !== 'starting') continue;
      const rule = this.cfg.rules.find((r) => r.name === run.rule) || this.cfg.defaults;
      const result = run.resultPath ? readJson(run.resultPath, null) : null;
      if (result) { await this.finalize(key, result, rule); continue; }
      let agent;
      try { agent = await this.herdr.agentGet(run.agentName); }
      catch (e) { log(`${key}: could not check agent ${run.agentName}, leaving the run as ${run.status}: ${e.message}`); continue; }
      if (!agent) {
        const was = run.status;
        if (was === 'starting') {
          // Died mid-start. Treat it like a failed start: hand the claim back so the issue can be
          // taken again. A start that never even got a workspace left nothing behind, so forget it
          // outright and let the next poll try again.
          await this.releaseClaim(key, run);
          if (!run.workspaceId) { delete this.state.runs[key]; saveState(this.state); log(`${key}: was starting before restart and never got a workspace; forgetting it`); continue; }
          run.status = 'failed'; run.error ??= 'the watcher stopped before the session was up';
        } else {
          run.status = 'stopped';
        }
        run.finishedAt = new Date().toISOString(); saveState(this.state);
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

  /**
   * Re-read .issue-herd/config.json (and the instructions files it names) if any of them changed
   * on disk since the config was last loaded. A config that fails to parse is reported and ignored:
   * the watcher keeps running on the last good one until the file is fixed. Runs already in flight
   * keep their rule by name; a rule that was removed falls back to the defaults for its reports.
   */
  reloadConfigIfChanged() {
    const stamp = configStamp(this.cfg);
    if (stamp === this.cfg.stamp) return false;
    let next;
    try { next = loadConfig(); }
    catch (e) {
      this.cfg.stamp = stamp; // do not re-report the same broken file every poll
      log(`config changed but could not be loaded, keeping the previous one: ${e.message}`);
      return false;
    }
    const before = this.cfg;
    this.cfg = next;
    this.warned = new Set(); // rules changed, so "matches but is skipped" notes may no longer apply
    log(`config reloaded: watching ${next.rules.filter((r) => r.enabled !== false).length} rule(s) every ${next.pollSeconds}s`);
    this.logRules();
    if (next.name !== before.name) this.labelOwnWorkspace().catch(() => {});
    return true;
  }

  logRules() {
    for (const r of this.cfg.rules) {
      const off = r.enabled === false ? ` (disabled${r.disabledReason ? `: ${r.disabledReason}` : ''})` : '';
      const runs = describeAgent(r);
      log(`  rule ${r.name}${r.role ? ` [${r.role}]` : ''}${off}: ${r.match}  →  ${r.repo}${runs === 'claude' ? '' : `  (${runs})`}`);
    }
    const roles = [...new Set(this.cfg.rules.filter((r) => r.enabled !== false && r.role).map((r) => r.role))];
    log(`  guards: claim label ${this.cfg.defaults.claimLabel || 'off'}${roles.length ? ` scoped to role(s) ${roles.join(', ')}` : ''}, skip issues assigned to others: ${this.cfg.defaults.skipIfAssignedToOthers ? 'on' : 'off'}; caps: ${this.cfg.maxConcurrent} total`);
    if (this.cfg.localOverrides.length) log(`  overrides from ${path.basename(LOCAL_CONFIG_PATH)}: ${this.cfg.localOverrides.join(', ')}`);
  }

  async loop() {
    log(`issue-herd ${PKG.version} in ${REPO}: watching ${this.cfg.rules.filter((r) => r.enabled !== false).length} rule(s) every ${this.cfg.pollSeconds}s`);
    this.logRules();
    const who = await this.tracker.me().then(userDisplay).catch((e) => `NOT REACHABLE (${e.message.slice(0, 80)})`);
    log(`  ${trackerBanner(this.tracker)}: ${who} (token from ${this.tracker.source || '?'}) · herdr: ${await this.herdr.serverRunning() ? 'connected' : 'NOT RUNNING'}`);
    await this.labelOwnWorkspace();
    await this.resume();
    let nextUpdateCheck = Date.now() + 24 * 3600e3; // startup already checked
    let polls = 0;
    for (;;) {
      polls++;
      let summary;
      try {
        this.reloadConfigIfChanged();
        const r = await this.pollOnce();
        if (r.picked.length) log(`poll #${polls}: ${r.scanned} open issues, ${r.candidates} matched, picked ${r.picked.join(', ')}`);
        const running = await this.runningSummary();
        summary = `${hms()} poll #${polls} · ${r.scanned} open · ${r.candidates} matched · ${r.picked.length} picked${r.waiting.length ? ` · ${r.waiting.length} waiting for a slot` : ''} · running ${running.length}${running.length ? `: ${running.join(' · ')}` : ''}${this.awaitingMerge() ? ` · ${this.awaitingMerge()} awaiting merge` : ''} · next in ${this.cfg.pollSeconds}s${this.tracker.budget?.() ? ` · ${this.tracker.budget()}` : ''}`;
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

/**
 * Is the agent herdr found under this run's name the session for *this* run? Agent names are made
 * from the run key, so two repositories watched on the same machine can both want "gh-20", and
 * adopting the other one's would brief an agent working in someone else's checkout. It is ours
 * when it sits inside this repository, or when it is in the workspace the previous attempt made.
 * (A different role on the same issue is a different run key, so it is never a candidate here.)
 */
function isOurAgent(agent, repo, previous) {
  const cwd = agent?.foreground_cwd || agent?.cwd;
  const root = path.resolve(repo);
  if (cwd && (path.resolve(cwd) === root || path.resolve(cwd).startsWith(root + path.sep))) return true;
  return !!(previous?.workspaceId && previous.workspaceId === agent?.workspace_id);
}

// ---------------------------------------------------------------- commands

const GITIGNORE = `# issue-herd. config.json, instructions.md and prompts/ are committed; these are not.
# runtime state: state.json, runs/<KEY>/, logs/
state/
# per-machine overrides of config.json
config.local.json
# the git worktrees issue-herd creates for runs
worktrees/
`;

/** `issue-herd init [--tracker linear|github]`. Asks which tracker on a terminal when not told. */
async function init(args = []) {
  const flag = args.indexOf('--tracker');
  if (flag >= 0 && !args[flag + 1]) throw new Error(`--tracker needs a name: ${Object.keys(TRACKERS).join(' | ')}`);
  let type = flag >= 0 ? args[flag + 1] : args.find((a) => isTracker(a));
  // Re-running init in a repo that is already set up must not re-scaffold it as a different tracker.
  const already = fs.existsSync(CONFIG_PATH) ? loadConfig().trackerSpec.type : null;
  if (!type && already) type = already;
  if (!type && process.stdin.isTTY) type = (await ask(`Which issue tracker? [${Object.keys(TRACKERS).join('/')}] (linear) `)).trim();
  const Tracker = trackerClass(trackerSpec(type || 'linear'));
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const made = [];
  const put = (p, content) => { if (!fs.existsSync(p)) { fs.writeFileSync(p, content); made.push(path.relative(REPO, p)); } };
  // config.example.json, with the tracker's own adjustments layered over it like config.local.json would be
  const example = mergeConfig(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'config.example.json'), 'utf8')), Tracker.exampleConfig || null);
  example.tracker = Tracker.id;
  put(CONFIG_PATH, JSON.stringify(example, null, 2) + '\n');
  put(path.join(CONFIG_DIR, 'instructions.md'), fs.readFileSync(path.join(PKG_DIR, 'prompts', 'instructions.example.md'), 'utf8'));
  // .issue-herd/ carries its own .gitignore so the repo's is left alone
  put(path.join(CONFIG_DIR, '.gitignore'), GITIGNORE);
  // document the token variable, for people who prefer .env.local to `issue-herd login`
  const envName = [].concat(Tracker.auth?.env || [])[0];
  const ex = path.join(REPO, '.env.example');
  const exText = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  if (envName && !new RegExp(`^${envName}=`, 'm').test(exText)) {
    const sep = exText ? (exText.endsWith('\n') ? '\n' : '\n\n') : '';
    fs.appendFileSync(ex, `${sep}# issue-herd: ${Tracker.label} token — ${Tracker.auth.hint}.\n# Put the real value in .env.local, never here; or skip this and run \`issue-herd login\`.\n${envName}=\n`);
    made.push(`.env.example (+ ${envName})`);
  }
  // We just told them to put a live token in .env.local. Say so if git would commit it — this
  // directory's own .gitignore cannot cover a file at the repo root, and we do not edit theirs.
  if (envName && git(['check-ignore', '-q', '.env.local'], REPO) === null) {
    console.log(`\n⚠ .env.local is not gitignored in this repository. Add it to ${path.join(REPO, '.gitignore')} before you put a token there, or use \`issue-herd login\` instead, which keeps the token outside the repo.`);
  }
  console.log(made.length ? `wrote in ${REPO} for ${Tracker.label}:\n  ${made.join('\n  ')}` : `nothing to do; ${path.relative(REPO, CONFIG_DIR)} already initialised`);
  console.log(`\nnext: \`issue-herd login\` (or put ${envName} in ${path.join(REPO, '.env.local')}), edit .issue-herd/config.json and instructions.md, then \`issue-herd match "label:ai"\``);
  console.log(`per-machine settings (e.g. a claim label that names this machine) go in .issue-herd/config.local.json, which is gitignored`);
}

/** The tracker config.json names, authenticated from the environment, the saved credential, or the tracker's own fallback. */
function makeTracker(cfg) {
  const { Tracker } = cfg;
  const options = { ...cfg.trackerSpec, cwd: REPO };
  const found = resolveCredential(Tracker, { options });
  if (!found) throw noCredentialError(Tracker);
  // a token the tracker refreshes itself goes back where it came from; env tokens are the user's to manage
  const onCredential = found.saved ? (cred) => saveCredential(Tracker.id, cred) : null;
  const tracker = new Tracker(found.credential, { options, onCredential });
  tracker.check?.();
  tracker.source = found.source;
  return tracker;
}

function trackerBanner(tracker) {
  const what = tracker.describe?.();
  return `${tracker.constructor.label}${what ? ` ${what}` : ''}`;
}

/** `issue-herd login [tracker] [--paste]` and `issue-herd logout [tracker]`. Works before `init` when the tracker is named. */
async function auth(cmd, args) {
  const paste = args.includes('--paste');
  const named = args.find((a) => !a.startsWith('--'));
  const configured = fs.existsSync(CONFIG_PATH) ? loadConfig().trackerSpec : null;
  if (!named && !configured) throw new Error(`which tracker? issue-herd ${cmd} <${Object.keys(TRACKERS).join('|')}>`);
  // Naming the tracker must not throw away the config's options for it, or `login github` in a
  // GitHub Enterprise repo would sign in to github.com and save a token the watcher cannot use.
  const spec = mergeSpec(named ? trackerSpec(named) : null, configured);
  const Tracker = trackerClass(spec);
  const file = credentialsPath();
  const shown = file.replace(os.homedir(), '~');
  if (cmd === 'logout') { console.log(deleteCredential(Tracker.id, file) ? `forgot the ${Tracker.label} token in ${shown}` : `no ${Tracker.label} token saved in ${shown}`); return; }
  const options = { ...spec, cwd: REPO };
  const cred = await Tracker.login(terminalUi(), { paste, ...options });
  const tracker = new Tracker(cred, { options });
  const user = await tracker.me(); // proves the token works before it is saved
  const who = `${trackerBanner(tracker)}: signed in as ${userDisplay(user)}`;
  if (cred.kind === 'borrowed') {
    // The credential belongs to another tool that can rotate it (`gh`). Copying it here would go
    // stale and, being ahead of the fallback in the lookup order, would keep being used after it did.
    console.log(`✓ ${who} · nothing saved: the token comes from ${cred.source} on every run`);
    return;
  }
  const saved = saveCredential(Tracker.id, { ...cred, user: userDisplay(user) }, file);
  console.log(`✓ ${who} · ${saved.kind} token saved in ${shown}`);
  for (const name of [].concat(Tracker.auth?.env || [])) if (process.env[name]) console.log(`note: ${name} is set (environment or .env.local) and takes precedence over the saved token`);
}

const PKG = readJson(path.join(PKG_DIR, 'package.json'), { version: '0.0.0', repository: {} });
const INSTALL_SPEC = 'github:jmwind/issue-herd';

/** Print a one-line reminder if GitHub main has a newer version. Quiet otherwise. */
async function updateReminder({ notify = false } = {}) {
  const latest = await newerVersion(PKG.version);
  if (!latest) return false;
  log(`⬆ issue-herd ${latest} is available (you have ${PKG.version}) — run: issue-herd update`);
  if (notify) await new Herdr().notify('issue-herd update available', `${PKG.version} → ${latest}: run issue-herd update`);
  return true;
}

function update() {
  console.log(`issue-herd ${PKG.version} → installing latest from ${INSTALL_SPEC} …`);
  execFileSync('npm', ['install', '-g', INSTALL_SPEC], { stdio: 'inherit' });
  const now = execFileSync('issue-herd', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`now ${now}`);
}

async function main(argv) {
  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') { console.log(PKG.version); return; }
  if (argv[0] === 'update' || argv[0] === 'upgrade') return update();
  if ((argv[0] || '') === 'init') return init(argv.slice(1));
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  loadEnv();
  const cmd = argv[0] || 'run';
  if (cmd === 'login' || cmd === 'logout') return auth(cmd, argv.slice(1));
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`no ${path.relative(process.cwd(), CONFIG_PATH) || CONFIG_PATH} — cd into the repo you want to work on and run \`issue-herd init\``);
  const cfg = loadConfig();
  if (cmd !== 'smoke') await updateReminder();
  const herdr = new Herdr({ log: (m) => process.env.ISSUE_HERD_DEBUG && log('  $', m) });

  if (cmd === 'status') {
    const s = loadState();
    const rows = Object.entries(s.runs);
    if (!rows.length) { console.log(`no runs yet in ${REPO}`); return; }
    console.log(`${'run key'.padEnd(16)} ${'role'.padEnd(8)} ${'run'.padEnd(14)} ${'agent'.padEnd(8)} ${'ws'.padEnd(4)} ${'rule'.padEnd(12)} ${'started'.padEnd(16)} outcome`);
    for (const [k, r] of rows) {
      let agent = '-';
      if (r.status === 'running') { const a = await herdr.agentGet(r.agentName).catch(() => null); agent = a?.agent_status || 'gone'; }
      const outcome = r.result ? `${r.result.status}${r.result.prUrl ? ' ' + r.result.prUrl : ''}` : (r.error || '');
      console.log(`${k.padEnd(16)} ${(r.role || '-').padEnd(8)} ${r.status.padEnd(14)} ${agent.padEnd(8)} ${(r.workspaceId || '').padEnd(4)} ${r.rule.padEnd(12)} ${r.startedAt.slice(0, 16)} ${outcome}  ${r.title || ''}`);
    }
    return;
  }
  if (cmd === 'reset') {
    const key = argv[1]; if (!key) throw new Error('usage: issue-herd reset <KEY>');
    // Naming the issue forgets every role's run on it (GH-7 clears GH-7, GH-7.impl, GH-7.review);
    // naming one run key forgets only that one.
    const s = loadState();
    const gone = Object.keys(s.runs).filter((k) => k === key || issueKeyOf(k) === key);
    for (const k of gone) delete s.runs[k];
    saveState(s);
    console.log(gone.length ? `forgot ${gone.join(', ')}` : `no run called ${key}`);
    return;
  }
  if (cmd === 'smoke') return smoke({ cfg, herdr, argv });

  const tracker = makeTracker(cfg);

  if (cmd === 'match') {
    const expr = argv.slice(1).join(' '); if (!expr) throw new Error('usage: issue-herd match "<expr>"');
    const rule = compile(expr);
    const viewer = await tracker.me();
    const issues = await tracker.openIssues({ sinceIso: new Date(Date.now() - cfg.lookbackDays * 86400e3).toISOString() });
    const hits = issues.filter((i) => rule.test(i, { viewer }));
    for (const i of hits) console.log(`${i.identifier.padEnd(10)} ${(i.state?.name || '').padEnd(12)} [${i.labels.join(',')}] ${i.assignee?.displayName || '-'}  ${i.title}`);
    console.log(`${hits.length} of ${issues.length} open ${trackerBanner(tracker)} issues match (as ${userDisplay(viewer)})`);
    return;
  }

  if (!(await herdr.serverRunning())) throw new Error('herdr server is not running (start herdr first)');
  const app = new IssueHerd({ cfg, tracker, herdr, dry: cmd === 'dry-run' });

  if (cmd === 'dry-run' || cmd === 'once') {
    if (cmd === 'once') await app.resume();
    const r = await app.pollOnce();
    log(`${r.scanned} open issues scanned, ${r.candidates} matched, ${r.picked.length} picked`);
    if (cmd === 'once' && app.supervising.size) { log(`supervising ${app.supervising.size} run(s); Ctrl-C when done`); await new Promise(() => {}); }
    return;
  }
  if (cmd === 'run') {
    // The watcher must outlive its own mistakes: anything that escapes the per-poll and per-run
    // handlers is logged and the loop carries on. Fix the config or the issue and it is retried.
    process.on('uncaughtException', (e) => log(`unexpected error (kept running): ${e.stack || e.message}`));
    process.on('unhandledRejection', (e) => log(`unexpected error (kept running): ${e?.stack || e?.message || e}`));
    return app.loop();
  }
  throw new Error(`unknown command ${cmd}`);
}

/** End-to-end herdr test with a fake issue: workspace → claude → brief → result.json → finalize. No tracker calls. */
async function smoke({ cfg, herdr, argv }) {
  const rule = {
    ...cfg.defaults, name: 'smoke', repo: REPO, worktree: argv.includes('--worktree') ? cfg.defaults.worktree : 'none',
    // Relative, so expand() finds the package's own copy; an absolute path is refused, since a
    // repository must not be able to name a file outside .issue-herd/ for the brief.
    prompt: 'prompts/smoke.md', instructions: '',
    onPickup: { comment: false }, onDone: { comment: false, notify: true, closeWorkspace: false },
    onBlocked: { comment: false, notify: true }, onIdle: { comment: false, notify: true },
  };
  rule.compiled = compile('any:true');
  rule.role = normalizeRole(rule.role, 'smoke rule');
  const key = `SMOKE-${Date.now().toString().slice(-4)}`;
  const nowIso = new Date().toISOString();
  const issue = {
    id: 'fake', identifier: key, ref: key, title: 'issue-herd smoke test', description: 'Prove the herdr pipeline works end to end.',
    url: 'https://linear.app/example', priority: 3, priorityLabel: 'Medium', labels: ['ai'], project: null,
    team: { id: 't', key: 'SMK', name: 'Smoke' }, assignee: null, creator: null, state: { name: 'Todo', type: 'unstarted' },
    cycle: null, comments: [], createdAt: nowIso, updatedAt: nowIso,
  };
  const app = new IssueHerd({ cfg: { ...cfg, rules: [rule] }, tracker: null, herdr });
  await app.pickUp(issue, rule);
  // The run is filed under its run key, which carries the rule's role — `defaults.role` in
  // config.json reaches the smoke rule like any other default, so this is not always the issue key.
  const runKey = runKeyFor(key, rule.role);
  log(`smoke: waiting for ${runKey} to finish…`);
  while (app.state.runs[runKey].status === 'running') await sleep(2000);
  const run = app.state.runs[runKey];
  log(`smoke: ${run.status} ${JSON.stringify(run.result || run.error || '')}`);
  console.log(`\nSmoke run ${runKey}: ${run.status}. herdr workspace ${run.workspaceId} left open; clean up with:\n  herdr workspace close ${run.workspaceId}\n  issue-herd reset ${runKey}`);
  process.exit(run.status === 'done' ? 0 : 1);
}

main(process.argv.slice(2)).catch((e) => { console.error(`issue-herd: ${e.message}`); process.exit(1); });
