// Thin driver over the `herdr` CLI. Every command returns JSON; errors are JSON on stderr, exit 1.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { workspaceLabel } from './claim.mjs';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Herdr {
  constructor({ bin = 'herdr', env = process.env, log = () => {} } = {}) {
    this.bin = bin;
    this.env = env;
    this.log = log;
  }

  async run(args, { timeoutMs = 60_000 } = {}) {
    this.log(`herdr ${args.map(quoteForLog).join(' ')}`);
    try {
      const { stdout } = await execFileP(this.bin, args, { env: this.env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return parseJson(stdout);
    } catch (err) {
      const detail = err.stderr ? parseJsonLoose(err.stderr) : null;
      const msg = detail?.error?.message || detail?.error?.code || err.stderr?.trim() || err.message;
      const e = new Error(`herdr ${args[0]} ${args[1] || ''}: ${msg}`);
      e.code = detail?.error?.code;
      e.detail = detail;
      throw e;
    }
  }

  async serverRunning() {
    try { await this.run(['workspace', 'list']); return true; } catch { return false; }
  }

  /** Create a workspace at `cwd`. Returns { workspaceId, tabId, paneId }. */
  async createWorkspace({ cwd, label, focus = false, env = {} }) {
    const args = ['workspace', 'create', '--cwd', cwd, '--label', label, focus ? '--focus' : '--no-focus'];
    for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
    const r = await this.run(args);
    return pickIds(r.result);
  }

  /** Create a git worktree from `cwd` and open it as a workspace. Returns { workspaceId, tabId, paneId, path, branch }. */
  async createWorktree({ cwd, branch, base, label, focus = false }) {
    const args = ['worktree', 'create', '--cwd', cwd, '--branch', branch, '--label', label, focus ? '--focus' : '--no-focus'];
    if (base) args.push('--base', base);
    const r = await this.run(args, { timeoutMs: 180_000 });
    const ids = pickIds(r.result);
    const wt = r.result.worktree || r.result;
    return { ...ids, path: wt.path || r.result.path, branch: wt.branch || branch, raw: r.result };
  }

  async closeWorkspace(workspaceId) {
    return this.run(['workspace', 'close', workspaceId]);
  }

  /** The workspace, or null when herdr has none by that id (its code is `workspace_not_found`). */
  async workspaceGet(workspaceId) {
    try { const r = await this.run(['workspace', 'get', workspaceId]); return r.result?.workspace || r.result; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  /**
   * Close a run's workspace — but only if the workspace herdr has under that id is still the run's.
   *
   * herdr numbers workspaces per server session: once it has been restarted (an upgrade, say), the
   * id a run recorded is handed out again to the next workspace made after the one it named was
   * closed. Closing by id alone then pulls the pane out from under whoever got it — that is how the
   * agent on GH-69 died the day herdr 0.9.0 arrived, to a Mark done on another issue whose
   * long-closed workspace had been `w3J`. `owner` is what the run knows about its workspace, see
   * workspaceOwner(). Returns 'closed', 'was already closed', or `was reused by herdr for
   * "<label>"`; throws only when herdr refuses the close itself.
   */
  async closeWorkspaceOf(workspaceId, owner = {}) {
    const ws = await this.workspaceGet(workspaceId);
    if (!ws) return 'was already closed';
    let ours = isRunsWorkspace(ws, owner);
    if (!ours && owner.agentName) {
      const agent = await this.agentGet(owner.agentName).catch(() => null);
      ours = !!agent && agent.workspace_id === workspaceId;
    }
    if (!ours) return `was reused by herdr for "${ws.label || workspaceId}"`;
    await this.closeWorkspace(workspaceId);
    return 'closed';
  }

  async renameWorkspace(workspaceId, label) {
    return this.run(['workspace', 'rename', workspaceId, label]);
  }

  /**
   * Open an existing git worktree checkout of the repo at `cwd` as a herdr worktree workspace
   * (herdr shows its branch and groups it under the repo's workspace). If that checkout is already
   * open, herdr returns the existing workspace and `alreadyOpen` is true.
   * Returns { workspaceId, tabId, paneId, alreadyOpen }.
   */
  async openWorktree({ cwd, path: checkout, label, focus = false }) {
    const args = ['worktree', 'open', '--cwd', cwd, '--path', checkout, focus ? '--focus' : '--no-focus'];
    if (label) args.push('--label', label);
    const r = await this.run(args);
    return { ...pickIds(r.result), alreadyOpen: !!r.result.already_open, raw: r.result };
  }

  /**
   * Start an agent in an existing shell pane. Resolves when herdr sees it ready.
   * `agentArgs` are passed to the agent binary after `--`.
   */
  async startAgent({ name, kind = 'claude', paneId, agentArgs = [], timeoutMs = 120_000 }) {
    const args = ['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', String(timeoutMs)];
    if (agentArgs.length) args.push('--', ...agentArgs);
    return this.run(args, { timeoutMs: timeoutMs + 15_000 });
  }

  async prompt(target, text) {
    return this.run(['agent', 'prompt', target, text]);
  }

  /**
   * Ask the agent to exit, and wait until herdr stops seeing it.
   *
   * `/exit` is what a person types in Claude Code, so it is what the agent is sent: the tool gets
   * to write its own history and shut its own MCP servers down instead of having the pane pulled
   * out from under it. That is the "shutdown steps specific to that agent" part — a coding tool
   * that stops differently gets its own line here, not an instruction in somebody's brief.
   *
   * Never throws, and never insists: closing the workspace is the caller's fallback, so this
   * reports what happened ('exited', 'was already gone', 'is still running') and returns.
   */
  async stopAgent(name, { exitCommand = '/exit', timeoutMs = 20_000, pollMs = 1000 } = {}) {
    try {
      if (!(await this.agentGet(name))) return 'was already gone';
      await this.prompt(name, exitCommand);
    } catch (err) {
      if (isNotFound(err)) return 'was already gone';
      this.log(`agent ${name} could not be asked to exit: ${err.message}`);
      return 'is still running';
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const agent = await this.agentGet(name).catch(() => 'unreadable');
      if (agent === null) return 'exited';
    }
    return 'is still running';
  }

  /** The agent, or null when herdr has no agent by that name (its code is `agent_not_found`). */
  async agentGet(target) {
    try { const r = await this.run(['agent', 'get', target]); return r.result?.agent || r.result; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  /**
   * Wait for the agent to reach one of `until` states (default: settled = idle|done|blocked).
   * Resolves to the state string, or 'gone' if the agent no longer exists, or 'timeout'.
   *
   * herdr 0.9 ends a wait whose agent stops being that agent — it exited, was released or
   * replaced, or its pane was moved to another workspace — with `agent_not_running`. That says the
   * wait is over, not what became of the agent, so ask: no agent by that name any more is 'gone';
   * one that is still there (the pane moved) is waited on again for whatever time is left.
   */
  async waitAgent(target, { until = [], timeoutMs } = {}) {
    const deadline = timeoutMs ? Date.now() + timeoutMs : null;
    for (;;) {
      const left = deadline ? deadline - Date.now() : null;
      if (left !== null && left < 1000) return 'timeout';
      const st = await this.waitAgentOnce(target, { until, timeoutMs: left });
      if (st !== 'error:agent_not_running') return st;
      if (!(await this.agentGet(target).catch(() => null))) return 'gone';
      await sleep(1000);
    }
  }

  /** One `agent wait`, as a detached child so many waits can be outstanding. Never rejects. */
  waitAgentOnce(target, { until = [], timeoutMs } = {}) {
    const args = ['agent', 'wait', target];
    for (const u of until) args.push('--until', u);
    if (timeoutMs) args.push('--timeout', String(timeoutMs));
    this.log(`herdr ${args.join(' ')}`);
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => {
        if (code === 0) {
          const j = parseJsonLoose(out);
          resolve(j?.result?.agent?.agent_status || j?.result?.agent_status || j?.result?.state || 'unknown');
        } else {
          const j = parseJsonLoose(err);
          const c = j?.error?.code || '';
          if (/not_found|no_agent|released/.test(c)) resolve('gone');
          else if (/timeout/.test(c)) resolve('timeout');
          else resolve(`error:${c || err.trim().slice(0, 120)}`);
        }
      });
      child.on('error', () => resolve('error:spawn'));
    });
  }

  /**
   * `agent read` prints plain text, not JSON. `recent-unwrapped` is the agent's alternate-screen
   * history, which herdr can only capture by scrolling the pane, so it refuses with
   * `agent_not_idle` while the agent is working. That is exactly when a person wants to look, so
   * fall back to the visible screen: fewer lines, but what is on the pane right now.
   */
  async readAgent(target, lines = 60) {
    try {
      return await this.readAgentSource(target, 'recent-unwrapped', lines);
    } catch (err) {
      if (err.code !== 'agent_not_idle') throw err;
      return this.readAgentSource(target, 'visible', lines);
    }
  }

  async readAgentSource(target, source, lines) {
    try {
      const { stdout } = await execFileP(this.bin, ['agent', 'read', target, '--source', source, '--lines', String(lines), '--format', 'text'], { env: this.env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return String(stdout);
    } catch (err) {
      const detail = err.stderr ? parseJsonLoose(err.stderr) : null;
      const msg = detail?.error?.message || detail?.error?.code || err.stderr?.trim() || err.message;
      const e = new Error(`herdr agent read: ${msg}`);
      e.code = detail?.error?.code;
      e.detail = detail;
      throw e;
    }
  }

  async notify(title, body, { sound = 'none' } = {}) {
    try { await this.run(['notification', 'show', title, '--body', body, '--sound', sound]); } catch { /* best effort */ }
  }
}

/** herdr's not-found codes are per noun: `agent_not_found`, `pane_not_found`, ... */
export function isNotFound(err) { return /(^|_)not_found$/.test(err?.code || ''); }

/**
 * herdr refuses to type into an agent that is sitting on an approval or question dialog: `agent
 * prompt` answers `agent_blocked` and sends nothing. The prompt is not lost, it is not yet
 * deliverable — the caller should keep it and try again once the agent takes input.
 */
export function isBlocked(err) { return err?.code === 'agent_blocked'; }

/**
 * Agent names are unique across the herdr server, so a second `agent start` under a name that is
 * already running is refused with `agent_name_taken`. For us that is never a failure: the agent it
 * names is the session for this issue, already up.
 */
export function isNameTaken(err) { return err?.code === 'agent_name_taken'; }

/**
 * Whether the workspace herdr shows under a run's id is the run's own: it carries the label the run
 * gave it, or it is the git worktree the run was opened on. A run that recorded neither cannot be
 * told apart from a stranger, and a stranger's workspace is the one thing this must never say yes
 * to. Where the run's agent stands is the third kind of evidence; that needs a live herdr, so it is
 * the caller's (closeWorkspaceOf(), and the console's view).
 */
export function isRunsWorkspace(ws, { label = null, path: checkout = null } = {}) {
  if (!ws) return false;
  if (label && ws.label === label) return true;
  const at = ws.worktree?.checkout_path;
  if (checkout && at && ws.worktree?.is_linked_worktree && path.resolve(at) === path.resolve(checkout)) return true;
  return false;
}

/**
 * What a run knows about its workspace, for isRunsWorkspace(): the label it was given (recorded at
 * pickup; rebuilt from the run's key, role and title for runs recorded before it was), the worktree
 * it was opened on, and the agent it hosts.
 */
export function workspaceOwner(run) {
  if (!run) return {};
  const label = run.workspaceLabel || (run.issueKey ? workspaceLabel({ key: run.issueKey, role: run.role, title: run.title }) : null);
  return { label, path: run.worktreePath || null, agentName: run.agentName || null };
}

/** Where an existing agent sits, in the shape the workspace calls return. */
export function agentPlacement(agent) {
  return {
    workspaceId: agent?.workspace_id,
    tabId: agent?.tab_id,
    paneId: agent?.pane_id,
    cwd: agent?.foreground_cwd || agent?.cwd || null,
  };
}

function pickIds(result) {
  const ws = result.workspace || {};
  const tab = result.tab || {};
  const pane = result.root_pane || result.pane || {};
  return {
    workspaceId: ws.workspace_id || ws.id,
    tabId: tab.tab_id || tab.id,
    paneId: pane.pane_id || pane.id,
  };
}

function parseJson(s) {
  const t = String(s).trim();
  if (!t) return {};
  return JSON.parse(t);
}
function parseJsonLoose(s) {
  try { return parseJson(s); } catch { return null; }
}
function quoteForLog(a) { return /[\s"']/.test(a) ? JSON.stringify(a.length > 80 ? a.slice(0, 77) + '...' : a) : a; }

/** Herdr agent names must match [a-z][a-z0-9_-]{0,31}. */
export function agentNameFor(identifier) {
  let s = String(identifier).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(s)) s = 'i-' + s;
  return s.slice(0, 32);
}
