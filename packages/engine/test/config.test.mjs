import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, overridePaths } from '../dist/config-merge.mjs';

const base = {
  pollSeconds: 30,
  maxConcurrent: 3,
  defaults: { claimLabel: 'herdr', worktree: 'claude', onPickup: { comment: true, state: 'In Progress', assignToMe: true } },
  rules: [
    { name: 'ai', match: 'label:ai', maxConcurrent: 2 },
    { name: 'bugs', match: 'label:bug' },
  ],
};

test('no local file leaves the config untouched', () => {
  assert.equal(mergeConfig(base, null), base);
});

test('top-level scalars override', () => {
  const cfg = mergeConfig(base, { pollSeconds: 5 });
  assert.equal(cfg.pollSeconds, 5);
  assert.equal(cfg.maxConcurrent, 3);
});

test('defaults merge key by key, events one level deeper', () => {
  const cfg = mergeConfig(base, { defaults: { claimLabel: 'herdr-mbp', onPickup: { state: 'Doing' } } });
  assert.equal(cfg.defaults.claimLabel, 'herdr-mbp');
  assert.equal(cfg.defaults.worktree, 'claude');
  assert.deepEqual(cfg.defaults.onPickup, { comment: true, state: 'Doing', assignToMe: true });
});

test('rules merge by name and unknown names are added', () => {
  const cfg = mergeConfig(base, { rules: [{ name: 'bugs', enabled: false }, { name: 'local-only', match: 'label:x' }] });
  assert.deepEqual(cfg.rules.map((r) => r.name), ['ai', 'bugs', 'local-only']);
  assert.deepEqual(cfg.rules[1], { name: 'bugs', match: 'label:bug', enabled: false });
  assert.deepEqual(cfg.rules[0], base.rules[0]);
});

test('merging does not mutate the base config', () => {
  const snapshot = JSON.stringify(base);
  mergeConfig(base, { defaults: { claimLabel: 'x', onPickup: { state: 'y' } }, rules: [{ name: 'ai', enabled: false }] });
  assert.equal(JSON.stringify(base), snapshot);
});

test('overridePaths lists what the local file changes', () => {
  const paths = overridePaths({ pollSeconds: 5, defaults: { claimLabel: 'x', onPickup: { state: 'y' } }, rules: [{ name: 'bugs', enabled: false }] });
  assert.deepEqual(paths, ['pollSeconds', 'defaults.claimLabel', 'defaults.onPickup.state', 'rules[bugs].enabled']);
  assert.deepEqual(overridePaths(null), []);
});

test('onMerged merges one level deep like the other events', () => {
  // Turning one step of the merge cleanup off on this machine must not take the rest with it.
  const withMerge = { ...base, defaults: { ...base.defaults, onMerged: { comment: true, exitAgent: true, closeWorkspace: true, removeWorktree: true } } };
  const cfg = mergeConfig(withMerge, { defaults: { onMerged: { removeWorktree: false } } });
  assert.deepEqual(cfg.defaults.onMerged, { comment: true, exitAgent: true, closeWorkspace: true, removeWorktree: false });
  assert.deepEqual(overridePaths({ defaults: { onMerged: { removeWorktree: false } } }), ['defaults.onMerged.removeWorktree']);
});
