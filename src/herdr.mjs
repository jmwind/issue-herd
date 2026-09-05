// Thin driver over the `herdr` CLI. Every command returns JSON; errors are JSON on stderr, exit 1.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

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

  async renameWorkspace(workspaceId, label) {
    return this.run(['workspace', 'rename', workspaceId, label]);
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

  async agentGet(target) {
    try { const r = await this.run(['agent', 'get', target]); return r.result?.agent || r.result; } catch (err) { if (err.code === 'not_found') return null; throw err; }
  }

  /**
   * Wait for the agent to reach one of `until` states (default: settled = idle|done|blocked).
   * Resolves to the state string, or 'gone' if the agent no longer exists, or 'timeout'.
   * Runs as a detached child so many waits can be outstanding.
   */
  waitAgent(target, { until = [], timeoutMs } = {}) {
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

  /** `agent read` prints plain text, not JSON. */
  async readAgent(target, lines = 60) {
    const { stdout } = await execFileP(this.bin, ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text'], { env: this.env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout);
  }

  async notify(title, body, { sound = 'none' } = {}) {
    try { await this.run(['notification', 'show', title, '--body', body, '--sound', sound]); } catch { /* best effort */ }
  }
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
