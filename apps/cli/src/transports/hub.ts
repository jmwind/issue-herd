// The team hub behind `weawr serve`: which teams this host has, who owns each, and one
// place that forwards commands and gathers snapshots. It parses no logs, decides no lifecycle
// policy and enriches nothing — every fact is the owner's, or the store's last word when the
// owner is away. Snapshots are gathered on a tick; events are pulled from each owner after its
// last cursor and fanned out to subscribers with per-team cursors.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentOwner, teamPaths, isStale, listRegistrations, projectOffline, readLegacyRegistry, registrationsDir, userDir, watchWorkspaces, indexSnapshot } from '@weawr/engine';
import type { Command, CommandResult, TeamPaths, Registration } from '@weawr/engine';
import type { EventView, TeamSnapshot, HostSnapshot } from '@weawr/protocol';
import { callOwner, OWNER_OFFLINE } from './ipc.js';

export interface HubOptions {
  herdr: any;
  version: string;
  promptsRoot: string;
  hostname?: string;
  registrations?: string;
  legacyRegistry?: string | null;
  intervalMs?: number;
  log?: (m: string) => void;
  clock?: () => number;
}

export interface TeamEntry { teamId: string; repo: string; paths: TeamPaths; registration: Registration | null; online: boolean; socketPath: string | null; snapshot: TeamSnapshot | null; error: string | null }

export type HubListener = (msg: { type: 'snapshot'; snapshot: HostSnapshot } | { type: 'event'; event: EventView } | { type: 'resnapshot'; teamId: string; reason: string }) => void;

export class TeamHub {
  readonly herdr: any; readonly version: string; readonly promptsRoot: string; readonly hostname: string; readonly registrations: string; readonly legacyRegistry: string | null; readonly intervalMs: number; readonly log: (m: string) => void; readonly clock: () => number;
  entries = new Map<string, TeamEntry>();
  current: HostSnapshot;
  private hash: string | null = null;
  private listeners = new Set<HubListener>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private herdrSnapshot: any = null;
  /** Per team: the last event seq forwarded to subscribers (so replay is the owner's, not ours). */
  private forwarded = new Map<string, number>();

  constructor({ herdr, version, promptsRoot, hostname = os.hostname(), registrations = registrationsDir(userDir()), legacyRegistry = path.join(userDir(), 'factories.json'), intervalMs = 2000, log = () => {}, clock = Date.now }: HubOptions) {
    this.herdr = herdr; this.version = version; this.promptsRoot = promptsRoot; this.hostname = hostname; this.registrations = registrations; this.legacyRegistry = legacyRegistry; this.intervalMs = intervalMs; this.log = log; this.clock = clock;
    this.current = { protocolVersion: 1, hostname, version, herdr: { connected: false, version: null }, generatedAt: new Date(clock()).toISOString(), teams: [] };
  }

  subscribe(fn: HubListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start(): void { if (!this.timer) { const tick = () => this.tick().catch((e) => this.log(`hub tick failed: ${e.message}`)).finally(() => { this.timer = setTimeout(tick, this.intervalMs); }); tick(); } }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** Registered teams, plus watcher workspaces herdr shows for repositories that have a config. */
  discover(): TeamEntry[] {
    const found = new Map<string, TeamEntry>();
    const add = (repo: string, registration: Registration | null, teamId: string | null) => {
      const real = (() => { try { return fs.realpathSync(repo); } catch { return path.resolve(repo); } })();
      if (/[\\/]\.weawr[\\/]worktrees[\\/]/.test(real) || !fs.existsSync(path.join(real, '.weawr', 'config.json'))) return;
      const id = teamId && !teamId.startsWith('legacy:') ? teamId : `f-${crypto.createHash('sha1').update(real).digest('hex').slice(0, 12)}`;
      const prev = found.get(real);
      found.set(real, { teamId: id, repo: real, paths: teamPaths(real), registration: registration ?? prev?.registration ?? null, online: false, socketPath: null, snapshot: prev?.snapshot ?? null, error: null });
    };
    if (this.legacyRegistry) for (const r of readLegacyRegistry(this.legacyRegistry)) add(r.repo, r, null);
    for (const r of listRegistrations(this.registrations)) add(r.repo, r, r.teamId);
    if (this.herdrSnapshot) for (const w of watchWorkspaces(indexSnapshot(this.herdrSnapshot))) if (w.cwd) add(w.cwd, null, null);
    return [...found.values()];
  }

  async tick(): Promise<HostSnapshot> {
    if (this.ticking) return this.current;
    this.ticking = true;
    try {
      try { this.herdrSnapshot = await this.herdr.run(['api', 'snapshot'], { timeoutMs: 10_000 }); } catch { this.herdrSnapshot = null; }
      const now = this.clock();
      const next = new Map<string, TeamEntry>();
      for (const e of this.discover()) {
        const prev = this.entries.get(e.teamId);
        const owner = currentOwner({ lockPath: e.paths.lockPath, ownerPath: e.paths.ownerPath });
        e.online = owner.owned && !!owner.holder?.socketPath;
        e.socketPath = owner.holder?.socketPath ?? null;
        if (owner.holder?.teamId && owner.holder.teamId !== e.teamId && !owner.holder.teamId.startsWith('legacy')) e.teamId = owner.holder.teamId;
        if (e.online && e.socketPath) {
          const r = await callOwner(e.socketPath, { type: 'team.snapshot' }, { timeoutMs: 8000 });
          if (r.ok) { e.snapshot = r.result as TeamSnapshot; e.error = null; }
          else { e.error = r.error.message; e.snapshot = prev?.snapshot ? { ...prev.snapshot, owner: { ...prev.snapshot.owner, status: 'stale' } } : this.offline(e, now); }
          await this.pullEvents(e);
        } else {
          try { e.snapshot = this.offline(e, now); e.error = null; } catch (err: any) { e.error = err.message; e.snapshot = prev?.snapshot ?? null; }
        }
        if (e.snapshot) { e.snapshot.teamId = e.teamId; if (e.registration && e.snapshot.owner.status !== 'online') e.snapshot.owner.heartbeatAt = e.registration.lastPoll; }
        next.set(e.teamId, e);
      }
      this.entries = next;
      const teams = [...next.values()].map((e) => e.snapshot).filter((s): s is TeamSnapshot => !!s).sort((a, b) => a.name.localeCompare(b.name));
      const idx = indexSnapshot(this.herdrSnapshot);
      const snap: HostSnapshot = { protocolVersion: 1, hostname: this.hostname, version: this.version, herdr: { connected: !!this.herdrSnapshot, version: idx.version }, generatedAt: new Date(now).toISOString(), teams };
      // Elapsed times move every tick; only a change in what is *shown* is worth a push.
      const hash = crypto.createHash('sha1').update(JSON.stringify(snap, (k, v) => (/Ms$/.test(k) || k === 'generatedAt' || k === 'observedAt' || k === 'heartbeatAt' || k === 'segments') ? undefined : v)).digest('hex');
      this.current = snap;
      if (hash !== this.hash) { this.hash = hash; this.emit({ type: 'snapshot', snapshot: snap }); }
      return snap;
    } finally { this.ticking = false; }
  }

  private offline(e: TeamEntry, now: number): TeamSnapshot {
    const stale = e.registration && !isStale(e.registration, now);
    const s = projectOffline({ sources: { paths: e.paths, promptsRoot: this.promptsRoot }, teamId: e.teamId, registration: e.registration, herdrSnapshot: this.herdrSnapshot, now });
    if (stale) s.owner.status = 'stale';
    return s;
  }

  /** Events the owner recorded since we last forwarded; pushed to subscribers in order. */
  private async pullEvents(e: TeamEntry): Promise<void> {
    if (!e.socketPath) return;
    const after = this.forwarded.get(e.teamId) ?? (e.snapshot?.revision ?? 0);
    const r = await callOwner(e.socketPath, { type: 'events.after', cursor: after, limit: 500 }, { timeoutMs: 8000 });
    if (!r.ok) return;
    const { events } = r.result as { events: any[] };
    for (const ev of events) { this.forwarded.set(e.teamId, ev.seq); this.emit({ type: 'event', event: { teamId: e.teamId, ...ev } }); }
    if (!this.forwarded.has(e.teamId)) this.forwarded.set(e.teamId, after);
  }

  private emit(msg: Parameters<HubListener>[0]): void { for (const fn of this.listeners) { try { fn(msg); } catch { /* listener's problem */ } } }

  team(teamId: string): TeamEntry | null {
    return this.entries.get(teamId) ?? [...this.entries.values()].find((e) => e.snapshot?.id === teamId) ?? null;
  }

  /** Events after `cursor` for one team, straight from its owner (or none when it is away), with expiry. */
  async eventsAfter(teamId: string, cursor: number, limit = 200): Promise<{ events: EventView[]; expired: boolean; offline: boolean }> {
    const e = this.team(teamId);
    if (!e?.online || !e.socketPath) return { events: [], expired: false, offline: true };
    const r = await callOwner(e.socketPath, { type: 'events.after', cursor, limit });
    if (!r.ok) return { events: [], expired: false, offline: true };
    const res = r.result as { events: any[]; expired: boolean };
    return { events: res.events.map((ev) => ({ teamId: e.teamId, ...ev })), expired: !!res.expired, offline: false };
  }

  /**
   * A command for one team: to its owner over the private socket. With no owner, reads that
   * herdr alone can answer (a tail) are answered here; every mutation is refused as owner_offline.
   */
  async dispatch(teamId: string, cmd: Command): Promise<CommandResult> {
    const e = this.team(teamId);
    if (!e) return { ok: false, error: { code: 'not_found', message: `no team ${teamId} on this host` } };
    if (e.online && e.socketPath) {
      const r = await callOwner(e.socketPath, cmd, { timeoutMs: 60_000 });
      if (r.ok || r.error.code !== OWNER_OFFLINE) return r;
    }
    if (cmd.type === 'task.tail' && e.snapshot) {
      const task = e.snapshot.issues.find((i) => i.key === (cmd as any).issueKey);
      if (!task) return { ok: false, error: { code: 'no_such_task', message: `no task ${(cmd as any).issueKey}` } };
      const blocks = [];
      for (const r of task.runs) {
        let text: string | null = null;
        if (r.agent) { try { text = String(await this.herdr.readAgent(r.agent, (cmd as any).lines ?? 100)).trim(); } catch (err: any) { text = `(no scrollback: ${err.message})`; } }
        blocks.push({ run: r.key, role: r.role, agent: r.agent, agentKind: r.agentKind, alive: !!text, phrase: r.phrase, text, source: text ? 'herdr (the owner is offline)' : 'none', observedAt: new Date(this.clock()).toISOString() });
      }
      return { ok: true, result: { blocks } };
    }
    if (cmd.type === 'team.snapshot' && e.snapshot) return { ok: true, result: e.snapshot };
    return { ok: false, error: { code: OWNER_OFFLINE, message: `the owner of ${e.snapshot?.name || teamId} is not running; start \`weawr\` in ${e.repo} — nothing was changed` } };
  }
}
