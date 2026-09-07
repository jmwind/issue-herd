// The orchestrator behind `issue-herd console`: finds the factories on this machine, reads what
// each watcher has written, asks herdr once per tick, builds the view, and says when it changed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeConfig } from '../config.mjs';
import { exitCommandFor } from '../agents.mjs';
import { resolveCredential } from '../auth.mjs';
import { trackerClass, trackerSpec } from '../trackers/index.mjs';
import { GitHubTracker, repoFromGit } from '../trackers/github.mjs';
import { prForBranch, prState } from '../pr.mjs';
import { credentialsPath } from '../auth.mjs';
import { isStale, loadRegistry } from './registry.mjs';
import { factoryView, indexSnapshot, parseLog, watchWorkspaces } from './model.mjs';
import { complexity, runSize } from './git.mjs';

const LOG_TAIL = 512 * 1024;
const SIZE_TTL = 30_000;
// Issue and PR state come from the tracker and GitHub: one call per task, refreshed every 90s for
// tasks that are in flight or finished this week, every 30 min for the rest. A few calls a
// minute, well inside either API's budget.
const LIVE_TTL = 90_000;
const OLD_TTL = 30 * 60_000;
const WEEK = 7 * 86400e3;
const LIVE = new Set(['running', 'starting', 'awaiting_merge', 'done']);

/**
 * The process environment plus the tracker's own token variables from the factory's .env.local
 * and .env, which is where the watcher's docs say a per-project token may live. Only those names
 * are read; a repository's .env never gets to set anything of issue-herd's own.
 */
function envWith(repo, names) {
  const env = { ...process.env };
  for (const file of ['.env', '.env.local']) {
    let text; try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
      if (!m || !names.includes(m[1])) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) env[m[1]] = v;
    }
  }
  return env;
}

function readNotes(file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function writeNotes(file, notes) { try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(notes, null, 2) + '\n', { mode: 0o600 }); } catch { /* best effort */ } }

/** A file read only when it changed. */
class Cached {
  constructor(read) { this.read = read; this.stamp = null; this.value = null; }
  get(file) {
    let st; try { st = fs.statSync(file); } catch { this.stamp = null; return (this.value = null); }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp !== this.stamp) { try { this.value = this.read(file, st); this.stamp = stamp; } catch { /* half-written: keep the last good value, retry next tick */ } }
    return this.value;
  }
}

export class FactoryConsole {
  constructor({ herdr, registryFile, log = () => {}, intervalMs = 2000, hostname = os.hostname(), version = null }) {
    this.herdr = herdr; this.registryFile = registryFile; this.log = log; this.intervalMs = intervalMs; this.hostname = hostname; this.version = version;
    this.caches = new Map(); // repo → { config, local, state, log }
    this.live = new Map();   // repo → { tracker, ghToken, issues: Map, prs: Map, busy }
    // Tasks a person marked done in the console. The console's own file, never the watcher's
    // state.json (two writers on one file is how state gets lost); keyed by repo and issue.
    this.notesFile = process.env.ISSUE_HERD_CONSOLE_NOTES || path.join(path.dirname(credentialsPath()), 'console.json');
    this.notes = readNotes(this.notesFile);
    this.sizes = new Map();  // runKey → { at, head, value }
    this.listeners = new Set();
    this.current = { hostname, version, herdr: { connected: false, version: null }, factories: [], generatedAt: new Date().toISOString() };
    this.hash = null;
    this.timer = null;
  }

  view() { return this.current; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  start() { if (!this.timer) { const tick = () => this.tick().catch((e) => this.log(`console tick failed: ${e.message}`)).finally(() => { this.timer = setTimeout(tick, this.intervalMs); }); tick(); } }
  stop() { clearTimeout(this.timer); this.timer = null; }

  /** Registry entries plus watcher workspaces herdr shows, merged by repository path. */
  discover(index) {
    const reg = loadRegistry(this.registryFile);
    const found = new Map();
    for (const [repo, entry] of Object.entries(reg)) found.set(path.resolve(repo), { repo: path.resolve(repo), registry: entry, stale: isStale(entry) });
    for (const w of watchWorkspaces(index)) {
      if (!w.cwd) continue;
      const repo = path.resolve(w.cwd);
      // No registry entry but herdr shows the watcher's workspace: an older watcher, or one that
      // has not polled yet. Its pane being open is the best liveness we have, so it is not stale.
      const f = found.get(repo) || { repo, registry: null, stale: false, paneOnly: true };
      f.workspaceId = w.workspaceId; f.watchName = w.name;
      found.set(repo, f);
    }
    // A worktree issue-herd made is a checkout of the factory, not a factory of its own.
    return [...found.values()].filter((f) => !/[\\/]\.issue-herd[\\/]worktrees[\\/]/.test(f.repo) && fs.existsSync(path.join(f.repo, '.issue-herd', 'config.json')));
  }

  cacheFor(repo) {
    if (!this.caches.has(repo)) this.caches.set(repo, {
      config: new Cached((f) => JSON.parse(fs.readFileSync(f, 'utf8'))),
      local: new Cached((f) => JSON.parse(fs.readFileSync(f, 'utf8'))),
      state: new Cached((f) => JSON.parse(fs.readFileSync(f, 'utf8'))),
      log: new Cached((f, st) => {
        const fd = fs.openSync(f, 'r');
        try { const start = Math.max(0, st.size - LOG_TAIL); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); return parseLog(buf.toString('utf8')); }
        finally { fs.closeSync(fd); }
      }),
    });
    return this.caches.get(repo);
  }

  async sizeFor(key, run, repo, now) {
    if (!run.branch || !LIVE.has(run.status)) return this.sizes.get(key)?.value || null;
    const c = this.sizes.get(key);
    if (c && now - c.at < SIZE_TTL) return c.value;
    const cwd = [run.workDir, run.worktreePath, repo].find((d) => d && fs.existsSync(d));
    const value = await runSize({ cwd, base: run.base || 'main', branch: run.branch });
    const out = value ? { ...value, complexity: complexity(value) } : null;
    this.sizes.set(key, { at: now, value: out });
    return out;
  }

  /** The factory's tracker (and a GitHub token for its PRs), built once from what this machine holds. */
  liveFor(repo, config) {
    if (this.live.has(repo)) return this.live.get(repo);
    const host = process.env.ISSUE_HERD_GITHUB_HOST || 'github.com';
    const entry = { tracker: null, ghToken: null, ghRepo: repoFromGit(repo, host), host, issues: new Map(), prs: new Map(), branches: new Map(), busy: false, why: null };
    try {
      const spec = trackerSpec(config.tracker || 'linear');
      const Tracker = trackerClass(spec);
      const options = { ...spec, cwd: repo };
      const found = resolveCredential(Tracker, { env: envWith(repo, [].concat(Tracker.auth?.env || [])), options });
      if (found) { entry.tracker = new Tracker(found.credential, { options }); entry.tracker.check?.(); }
      else entry.why = `no ${Tracker.label} credentials on this machine`;
      const gh = Tracker === GitHubTracker ? found : resolveCredential(GitHubTracker, { options: { cwd: repo } });
      entry.ghToken = gh?.credential?.token || null;
    } catch (e) { entry.tracker = null; entry.why = e.message; }
    this.live.set(repo, entry);
    return entry;
  }

  /** Refresh what is due for one factory, in the background; the next tick reads the cache. */
  refreshLive(repo, config, view, now) {
    const live = this.liveFor(repo, config);
    if (live.busy) return;
    const due = [];
    for (const iss of view.issues) {
      const recent = iss.bucket === 'inflight' || (iss.finishedAt && now - Date.parse(iss.finishedAt) < WEEK);
      const ttl = recent ? LIVE_TTL : OLD_TTL;
      if (live.tracker && now - (live.issues.get(iss.key)?.at || 0) > ttl) due.push({ kind: 'issue', key: iss.key });
      if (iss.prUrl && live.prs.get(iss.prUrl)?.state !== 'merged' && now - (live.prs.get(iss.prUrl)?.at || 0) > ttl) due.push({ kind: 'pr', url: iss.prUrl });
      // No PR recorded: ask GitHub whether one exists for a run's branch.
      if (!iss.prUrl && live.ghRepo) for (const r of iss.runs) {
        if (!r.branch) continue;
        const b = live.branches.get(r.branch);
        if (b?.state === 'merged' || now - (b?.at || 0) <= ttl) continue;
        due.push({ kind: 'branch', branch: r.branch });
      }
    }
    if (!due.length) return;
    live.busy = true;
    (async () => {
      for (const d of due.slice(0, 12)) {
        try {
          if (d.kind === 'issue') {
            const issue = await live.tracker.issueByKey(d.key);
            const closed = !!issue && (/^(completed|canceled)$/.test(issue.state?.type || '') || /^closed$/i.test(issue.state?.name || ''));
            live.issues.set(d.key, { at: Date.now(), state: issue ? (closed ? 'closed' : 'open') : null, name: issue?.state?.name || null });
          } else if (d.kind === 'branch') {
            const pr = await prForBranch({ repo: live.ghRepo, branch: d.branch, token: live.ghToken, host: live.host });
            live.branches.set(d.branch, { at: Date.now(), url: pr?.url || null, state: pr?.state || null });
            if (pr) live.prs.set(pr.url, { at: Date.now(), state: pr.state });
          } else {
            const pr = await prState(d.url, { token: live.ghToken, host: live.host });
            live.prs.set(d.url, { at: Date.now(), state: pr.state });
          }
        } catch (e) {
          if (d.kind === 'issue') live.issues.set(d.key, { at: Date.now(), state: null, error: e.message });
          else if (d.kind === 'branch') live.branches.set(d.branch, { at: Date.now(), url: null, state: null, error: e.message });
          else live.prs.set(d.url, { at: Date.now(), state: null, error: e.message });
          this.log(`console: ${d.kind === 'issue' ? d.key : d.kind === 'branch' ? d.branch : d.url}: ${e.message.slice(0, 120)}`);
        }
      }
      live.busy = false;
    })();
  }

  async tick() {
    const now = Date.now();
    let snapshot = null;
    try { snapshot = await this.herdr.run(['api', 'snapshot'], { timeoutMs: 10_000 }); } catch { snapshot = null; }
    const index = indexSnapshot(snapshot);
    const factories = [];
    const seenIds = new Set();
    for (const f of this.discover(index)) {
      const c = this.cacheFor(f.repo);
      const dir = path.join(f.repo, '.issue-herd');
      const config = mergeConfig(c.config.get(path.join(dir, 'config.json')) || {}, c.local.get(path.join(dir, 'config.local.json')));
      const state = c.state.get(path.join(dir, 'state', 'state.json')) || { runs: {} };
      const events = c.log.get(path.join(dir, 'state', 'logs', 'issue-herd.log')) || [];
      const sizes = {};
      for (const [key, run] of Object.entries(state.runs || {})) { const s = await this.sizeFor(key, run, f.repo, now); if (s) sizes[key] = s; }
      let id = String(config.name || f.registry?.name || f.watchName || path.basename(f.repo)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'factory';
      while (seenIds.has(id)) id += '-2';
      seenIds.add(id);
      const live = this.liveFor(f.repo, config);
      const enrich = { issues: Object.fromEntries([...live.issues].map(([k, v]) => [k, v.state])), prs: Object.fromEntries([...live.prs].map(([k, v]) => [k, v.state])), branches: Object.fromEntries([...live.branches].filter(([, v]) => v.url).map(([k, v]) => [k, v.url])) };
      const cleared = {};
      for (const [k, v] of Object.entries(this.notes.done || {})) if (k.startsWith(f.repo + '|')) cleared[k.slice(f.repo.length + 1)] = Date.parse(v.at) || 0;
      const view = factoryView({ id, repo: f.repo, config, state, events, index, sizes, registry: f.registry, stale: f.stale, enrich, cleared, now });
      if (f.workspaceId && !view.watcher.workspaceId) view.watcher.workspaceId = f.workspaceId;
      view.watcher.paneOnly = !!f.paneOnly;
      view.live = { tracker: !!live.tracker, github: !!live.ghToken, why: live.why };
      this.refreshLive(f.repo, config, view, now);
      factories.push(view);
    }
    factories.sort((a, b) => a.name.localeCompare(b.name));
    const next = {
      hostname: this.hostname, version: this.version,
      herdr: { connected: !!snapshot, version: index.version },
      factories,
      generatedAt: new Date(now).toISOString(),
    };
    // Elapsed times move every tick; only a change in what is *shown* is worth a push.
    const hash = crypto.createHash('sha1').update(JSON.stringify(next, (k, v) => (k === 'elapsedMs' || k === 'humanWaitMs' || k === 'sinceMs' || k === 'generatedAt' || k === 'segments') ? undefined : v)).digest('hex');
    this.current = next;
    if (hash !== this.hash) { this.hash = hash; for (const fn of this.listeners) { try { fn(next); } catch { /* listener's problem */ } } }
    return next;
  }

  findRun({ factory, run }) {
    const f = this.current.factories.find((x) => x.id === factory);
    const r = f?.issues.flatMap((i) => i.runs).find((x) => x.key === run);
    if (!f || !r) throw new Error(`no run ${run} in factory ${factory}`);
    return { f, r };
  }

  /** Send the agent its own exit command and let it shut down the way it wants. */
  async exit({ factory, run }) {
    const { r } = this.findRun({ factory, run });
    const outcome = await this.herdr.stopAgent(r.agent, { exitCommand: exitCommandFor(r.agentKind) });
    this.sizes.delete(run);
    setTimeout(() => this.tick().catch(() => {}), 500);
    return outcome;
  }

  findTask({ factory, issue }) {
    const f = this.current.factories.find((x) => x.id === factory);
    const iss = f?.issues.find((i) => i.key === issue);
    if (!f || !iss) throw new Error(`no task ${issue} in factory ${factory}`);
    return { f, iss };
  }

  /** A person decided the task is done: its alerts go, and it moves to output. Undone by a new run on it, or by hand. */
  markDone({ factory, issue }, done = true) {
    const { f } = this.findTask({ factory, issue });
    this.notes.done ||= {};
    const k = `${f.repo}|${issue}`;
    if (done) this.notes.done[k] = { at: new Date().toISOString() }; else delete this.notes.done[k];
    writeNotes(this.notesFile, this.notes);
    setTimeout(() => this.tick().catch(() => {}), 50);
    return done;
  }

  /** One button per task: every agent still up on it is sent its own exit command. */
  async closeTask({ factory, issue }) {
    const { iss } = this.findTask({ factory, issue });
    const outcomes = [];
    for (const r of iss.runs) {
      if (!r.agentAlive) continue;
      const outcome = await this.herdr.stopAgent(r.agent, { exitCommand: exitCommandFor(r.agentKind) });
      outcomes.push({ run: r.key, role: r.role, agent: r.agent, outcome });
      this.sizes.delete(r.key);
    }
    setTimeout(() => this.tick().catch(() => {}), 500);
    return outcomes;
  }

  /** The last `lines` of every agent that worked on the task, one block per role, for a read-only look. */
  async tailTask({ factory, issue, lines = 100 }) {
    const { iss } = this.findTask({ factory, issue });
    const out = [];
    for (const r of iss.runs) {
      let text;
      if (!r.agentAlive) text = null;
      else { try { text = (await this.herdr.readAgent(r.agent, lines)).trim(); } catch (e) { text = `(no scrollback: ${e.message})`; } }
      out.push({ run: r.key, role: r.role, agent: r.agent, agentKind: r.agentKind, alive: r.agentAlive, phrase: r.phrase, text });
    }
    return out;
  }

  async tail({ factory, run }) {
    const { r } = this.findRun({ factory, run });
    try { return (await this.herdr.readAgent(r.agent, 100)).trim(); } catch (e) { return `(no scrollback: ${e.message})`; }
  }
}
