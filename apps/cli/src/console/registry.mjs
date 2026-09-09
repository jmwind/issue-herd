// Which factories run on this machine.
//
// The console shows every factory at once, so it has to find them. The watcher is the authority:
// every poll it stamps one small entry here, keyed by the repository path, and the console lists
// the entries and marks one stale when its last poll is older than a few of its own intervals.
// The file sits next to credentials.json (per user, never in a repository) but is not a
// credential: a corrupt registry is reset, not refused, because nothing in it is irreplaceable.
import fs from 'node:fs';
import path from 'node:path';
import { credentialsPath } from '@weawr/engine/adapters/auth.mjs';

export function registryPath() {
  return process.env.WEAWR_REGISTRY || path.join(path.dirname(credentialsPath()), 'factories.json');
}

/** Every registered factory, keyed by repository path. {} when there is no file or it is unreadable. */
export function loadRegistry(file = registryPath()) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

/**
 * Record that the watcher for `repo` is alive. Called once per poll; `lastPoll` is what the console
 * reads liveness from. Returns the entry as saved. Never throws: a watcher must not die because
 * its registry could not be written.
 */
export function stampFactory({ repo, name, tracker = null, version = null, pid = process.pid, pollSeconds = 30, workspaceId = null, logPath = null }, file = registryPath(), now = new Date()) {
  const entry = { name, tracker, version, pid, pollSeconds, workspaceId, logPath, lastPoll: now.toISOString() };
  try {
    const all = loadRegistry(file);
    all[repo] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
  return entry;
}

/** Forget a factory (its repository is gone, say). */
export function forgetFactory(repo, file = registryPath()) {
  const all = loadRegistry(file);
  if (!Object.hasOwn(all, repo)) return false;
  delete all[repo];
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  return true;
}

/** A watcher that has missed `factor` of its own polls is presumed gone. */
export function isStale(entry, now = Date.now(), factor = 3) {
  const last = Date.parse(entry?.lastPoll || '');
  if (!Number.isFinite(last)) return true;
  return now - last > Math.max(10, Number(entry.pollSeconds) || 30) * 1000 * factor;
}
