// Every tracker issue-herd knows. To add one: write src/trackers/<id>.mjs against the contract in
// src/tracker.mjs, import it here, add it to TRACKERS. test/trackers.test.mjs checks the contract.
import { LinearTracker } from './linear.mjs';
import { GitHubTracker } from './github.mjs';

export const TRACKERS = Object.fromEntries([LinearTracker, GitHubTracker].map((T) => [T.id, T]));

/** `"tracker": "github"` or `"tracker": { "type": "github", ... }` → { type, ...options }. */
export function trackerSpec(value) {
  if (value == null || value === '') return { type: 'linear' };
  if (typeof value === 'string') return { type: value.toLowerCase() };
  if (typeof value === 'object' && typeof value.type === 'string') return { ...value, type: value.type.toLowerCase() };
  throw new Error('"tracker" must be a name ("linear", "github") or an object with a "type"');
}

/** The tracker class a config names, or a clear error listing what exists. */
export function trackerClass(spec) {
  const T = TRACKERS[spec.type];
  if (!T) throw new Error(`unknown tracker "${spec.type}"; known: ${Object.keys(TRACKERS).join(', ')}`);
  return T;
}
