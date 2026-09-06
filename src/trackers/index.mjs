// Every tracker issue-herd knows. To add one: write src/trackers/<id>.mjs against the contract in
// src/tracker.mjs, import it here, add it to TRACKERS. test/trackers.test.mjs checks the contract.
import { LinearTracker } from './linear.mjs';
import { GitHubTracker } from './github.mjs';

export const TRACKERS = Object.fromEntries([LinearTracker, GitHubTracker].map((T) => [T.id, T]));

/** `"tracker": "github"` or `"tracker": { "type": "github", ... }` → { type, ...options }. */
export function trackerSpec(value) {
  if (value == null || value === '') return { type: 'linear' };
  if (typeof value === 'string') return { type: value.toLowerCase() };
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string') return { ...value, type: value.type.toLowerCase() };
  throw new Error('"tracker" must be a name ("linear", "github") or an object with a "type"');
}

/**
 * The spec to sign in with when the tracker is named on the command line: the config's options
 * (host, repo, …) when it is the same tracker, so `issue-herd login github` in a repo configured
 * for GitHub Enterprise signs in to that host rather than to github.com.
 */
export function mergeSpec(named, configured) {
  if (!named) return configured;
  if (!configured || named.type !== configured.type) return named;
  return { ...configured, ...named };
}

/** True for a name this registry actually defines. `hasOwn`, so "constructor" is not a tracker. */
export function isTracker(type) {
  return typeof type === 'string' && Object.hasOwn(TRACKERS, type);
}

/** The tracker class a config names, or a clear error listing what exists. */
export function trackerClass(spec) {
  if (!isTracker(spec.type)) throw new Error(`unknown tracker "${spec.type}"; known: ${Object.keys(TRACKERS).join(', ')}`);
  return TRACKERS[spec.type];
}
