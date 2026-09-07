// The orchestrator behind `issue-herd console`: finds the factories on this machine, reads what
// each watcher has written, asks herdr once per tick, builds the view, and says when it changed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeConfig } from '../config.mjs';
import { exitCommandFor } from '../agents.mjs';
import { isStale, loadRegistry } from './registry.mjs';
import { beltItems, factoryView, indexSnapshot, parseLog, watchWorkspaces } from './model.mjs';
import { complexity, runSize } from './git.mjs';

const LOG_TAIL = 512 * 1024;
const SIZE_TTL = 30_000;
const LIVE = new Set(['running', 'starting', 'awaiting_merge', 'done']);

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
    this.sizes = new Map();  // runKey → { at, head, value }
    this.listeners = new Set();
    this.current = { hostname, version, herdr: { connected: false, version: null }, factories: [], belt: [], generatedAt: new Date().toISOString() };
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
      const view = factoryView({ id, repo: f.repo, config, state, events, index, sizes, registry: f.registry, stale: f.stale, now });
      if (f.workspaceId && !view.watcher.workspaceId) view.watcher.workspaceId = f.workspaceId;
      view.watcher.paneOnly = !!f.paneOnly;
      factories.push(view);
    }
    factories.sort((a, b) => a.name.localeCompare(b.name));
    const next = {
      hostname: this.hostname, version: this.version,
      herdr: { connected: !!snapshot, version: index.version },
      factories, belt: beltItems(factories),
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

  async tail({ factory, run }) {
    const { r } = this.findRun({ factory, run });
    try { return (await this.herdr.readAgent(r.agent, 40)).trim(); } catch (e) { return `(no scrollback: ${e.message})`; }
  }
}
