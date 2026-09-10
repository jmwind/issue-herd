// Which teams run on this machine, and how to reach them.
//
// Each owner writes one small file of its own — <userDir>/teams/<teamId>.json, replaced
// atomically — so two watchers never read-modify-write one shared list. The files are discovery:
// they say where a team is and where its owner answers. The lock (ownership.ts) says whether
// the owner is alive; a registration's own heartbeat is a hint for a UI that has no lock access.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './state.js';

export interface Registration {
  teamId: string;
  repo: string;
  name: string;
  tracker: string | null;
  version: string | null;
  hostId: string;
  pid: number;
  pollSeconds: number;
  workspaceId: string | null;
  logPath: string | null;
  socketPath: string | null;
  statePath: string | null;
  lastPoll: string;
  /** The tracker's own view of health, separate from the process being alive. */
  lastSuccessfulPoll: string | null;
  lastPollError: string | null;
}

export function registrationsDir(userDir: string): string {
  return process.env.WEAWR_REGISTRY_DIR || path.join(userDir, 'teams');
}

/** Write (replace) this team's registration. Never throws: a watcher must not die because it could not announce itself. */
export function writeRegistration(dir: string, reg: Registration): void {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); writeJsonAtomic(path.join(dir, `${reg.teamId}.json`), reg); } catch { /* best effort */ }
}

export function removeRegistration(dir: string, teamId: string): boolean {
  const file = path.join(dir, `${teamId}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** Every registration on this machine. Corrupt files are skipped, not fatal: nothing here is irreplaceable. */
export function listRegistrations(dir: string): Registration[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: Registration[] = [];
  for (const f of names) {
    const r = readJson<Registration | null>(path.join(dir, f), null);
    if (r && typeof r === 'object' && typeof r.repo === 'string' && typeof r.teamId === 'string') out.push(r);
  }
  return out;
}

/** A watcher that has missed `factor` of its own polls is presumed gone (a hint; the lock is the truth). */
export function isStale(entry: { lastPoll?: string; pollSeconds?: number } | null | undefined, now = Date.now(), factor = 3): boolean {
  const last = Date.parse(entry?.lastPoll || '');
  if (!Number.isFinite(last)) return true;
  return now - last > Math.max(10, Number(entry?.pollSeconds) || 30) * 1000 * factor;
}

/**
 * The legacy shared registry (~/.config/weawr/factories.json, one object keyed by repository
 * path), read so a console on a new version still lists teams an old watcher stamps. The
 * migration command removes it once every team has an owner writing its own file.
 */
export function readLegacyRegistry(file: string): Registration[] {
  const all = readJson<Record<string, any>>(file, {});
  if (!all || typeof all !== 'object' || Array.isArray(all)) return [];
  return Object.entries(all).map(([repo, e]) => ({
    teamId: `legacy:${repo}`, repo, name: e?.name || path.basename(repo), tracker: e?.tracker ?? null, version: e?.version ?? null,
    hostId: 'legacy', pid: Number(e?.pid) || 0, pollSeconds: Number(e?.pollSeconds) || 30, workspaceId: e?.workspaceId ?? null,
    logPath: e?.logPath ?? null, socketPath: null, statePath: null, lastPoll: e?.lastPoll || '', lastSuccessfulPoll: null, lastPollError: null,
  }));
}
