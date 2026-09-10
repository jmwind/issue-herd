// A snapshot for a team whose owner is not running: what its store last recorded, projected
// the same way, marked offline with the time its facts were last observed. Reads only; a reader
// never enriches or schedules anything, and every mutation is refused until an owner is back.
import os from 'node:os';
import type { TeamSnapshot } from '@weawr/protocol';
import { teamView, indexSnapshot, timelineOf } from './projection.js';
import { readTeamState } from './store/index.js';
import { loadConfig } from './config.js';
import type { ConfigSources } from './config.js';
import { trackerScope } from './identity.js';
import type { Registration } from './registration.js';
import { isStale } from './registration.js';

export function projectOffline({ sources, teamId, registration = null, herdrSnapshot = null, now = Date.now() }: { sources: ConfigSources; teamId: string; registration?: Registration | null; herdrSnapshot?: any; now?: number }): TeamSnapshot {
  const cfg = loadConfig(sources);
  const view = readTeamState(sources.paths);
  try {
    const events = view.store ? timelineOf(view.store.eventsAfter(0, 100_000)) : [];
    const cleared: Record<string, number> = {};
    if (view.store) for (const a of view.store.acknowledgements()) cleared[a.issueKey] = Date.parse(a.at) || 0;
    const revision = view.store ? view.store.lastEventSeq() : 0;
    const recipeRevision = view.store ? Number(view.store.meta('recipe_revision')) || null : null;
    const observedAt = view.store ? (view.store.meta('last_saved_at') || registration?.lastPoll || null) : registration?.lastPoll || null;
    const index = indexSnapshot(herdrSnapshot);
    const v = teamView({
      id: String(cfg.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team', teamId, repo: sources.paths.repo, config: cfg, state: { runs: view.state.runs }, events, index,
      registry: registration, stale: registration ? isStale(registration, now) : true, cleared, seen: null, now, recipeRevision, trackerScope: trackerScope(cfg.trackerSpec),
    });
    return {
      ...v, protocolVersion: 1, generatedAt: new Date(now).toISOString(), revision,
      owner: { status: registration && !isStale(registration, now) ? 'stale' : 'offline', pid: registration?.pid ?? null, version: registration?.version ?? null, hostname: os.hostname(), heartbeatAt: registration?.lastPoll ?? null, observedAt: observedAt || new Date(now).toISOString() },
      freshness: { herdrAt: herdrSnapshot ? new Date(now).toISOString() : null, trackerAt: registration?.lastSuccessfulPoll ?? null, trackerError: registration?.lastPollError ?? (view.corrupt ? `state.json does not parse: ${view.corrupt}` : null) },
      live: { tracker: false, github: false, why: 'the team\'s owner is not running; this is its last recorded state' },
      capabilities: ['task.tail'],
    } as TeamSnapshot;
  } finally { view.store?.close(); }
}
