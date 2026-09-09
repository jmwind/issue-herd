// From state.json to the durable store: inventory, backup, one-transaction import, the console's
// acknowledgements, refusal of a corrupt file, refusal to run twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { factoryPaths } from '../dist/paths.js';
import { inventory, migrateLegacyState } from '../dist/store/migrate.js';
import { readFactoryState, storeStatus } from '../dist/store/index.js';

function legacyFactory({ state = null, runDirs = [], notes = null } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-mig-')));
  const paths = factoryPaths(repo);
  fs.mkdirSync(paths.runsDir, { recursive: true });
  if (state !== null) fs.writeFileSync(paths.statePath, typeof state === 'string' ? state : JSON.stringify(state));
  for (const d of runDirs) { fs.mkdirSync(path.join(paths.runsDir, d)); fs.writeFileSync(path.join(paths.runsDir, d, 'result.json'), '{}'); }
  const consoleNotesPath = path.join(repo, 'console.json');
  if (notes) fs.writeFileSync(consoleNotesPath, JSON.stringify(notes));
  return { repo, paths, consoleNotesPath };
}
const STATE = { runs: { 'GH-7@impl': { rule: 'impl', role: 'impl', pass: 2, status: 'awaiting_merge', issueKey: 'GH-7', startedAt: '2026-01-01T00:00:00Z', briefPath: '/b' }, 'GH-8': { rule: 'r', status: 'done', startedAt: '2026-01-02T00:00:00Z' } }, nudges: { 'GH-7': [{ from: 'review', to: 'impl', outcome: 'turn', at: 't', message: 'fix' }] } };

test('inventory names what is there and what is odd, without changing anything', () => {
  const f = legacyFactory({ state: STATE, runDirs: ['GH-7@impl', 'SMOKE-1'], notes: { done: { [`${legacyFactory().repo}|GH-1`]: { at: 'x' } } } });
  const inv = inventory({ paths: f.paths, consoleNotesPath: f.consoleNotesPath });
  assert.equal(inv.stateParses, true); assert.equal(inv.runs, 2); assert.equal(inv.nudges, 1);
  assert.deepEqual(inv.orphanRunDirs, ['SMOKE-1']); assert.deepEqual(inv.runsWithoutDir, ['GH-8']);
  assert.equal(inv.consoleNotes, 0, 'another factory\'s acknowledgements are not this one\'s');
  assert.equal(inv.storeExists, false);
  assert.equal(storeStatus(f.paths).needsMigration, true);
});

test('migrate backs up, imports runs, nudges, one legacy attempt per run and the acknowledgements, and sets state.json aside', () => {
  const f = legacyFactory({ state: STATE });
  fs.writeFileSync(f.consoleNotesPath, JSON.stringify({ done: { [`${f.repo}|GH-8`]: { at: '2026-01-03T00:00:00Z' }, ['/elsewhere|GH-8']: { at: 'x' } } }));
  const r = migrateLegacyState({ paths: f.paths, consoleNotesPath: f.consoleNotesPath, now: () => new Date('2026-09-08T12:00:00Z') });
  assert.equal(r.migrated, true); assert.equal(r.runs, 2); assert.equal(r.nudges, 1); assert.equal(r.acknowledgements, 1);
  assert.ok(fs.existsSync(path.join(r.backupDir, 'state.json')) && fs.existsSync(path.join(r.backupDir, 'console.json')));
  assert.ok(!fs.existsSync(f.paths.statePath)); assert.ok(fs.existsSync(`${f.paths.statePath}.migrated`));
  const view = readFactoryState(f.paths);
  assert.equal(view.kind, 'sqlite');
  assert.equal(view.state.runs['GH-7@impl'].pass, 2);
  assert.deepEqual(view.state.nudges['GH-7'].map((n) => n.message), ['fix']);
  assert.deepEqual(view.store.acknowledgements(), [{ issueKey: 'GH-8', at: '2026-01-03T00:00:00Z', by: 'console' }]);
  const attempts = view.store.attempts('GH-7@impl');
  assert.equal(attempts.length, 1); assert.equal(attempts[0].pass, 2); assert.equal(attempts[0].spec.provenance, 'legacy');
  assert.equal(view.store.eventsAfter(0)[0].kind, 'factory.migrated');
  assert.equal(view.store.meta('migrated_from'), f.paths.statePath);
  view.store.close();
  // again: refused, nothing changes
  const again = migrateLegacyState({ paths: f.paths, consoleNotesPath: f.consoleNotesPath });
  assert.equal(again.migrated, false); assert.match(again.reason, /already migrated/);
});

test('a corrupt state.json is refused and preserved; a reader reports it rather than showing an empty factory', () => {
  const f = legacyFactory({ state: '{ "runs": { broken' });
  assert.throws(() => migrateLegacyState({ paths: f.paths }), /never treated as an empty factory/);
  assert.equal(fs.readFileSync(f.paths.statePath, 'utf8'), '{ "runs": { broken');
  assert.ok(!fs.existsSync(path.join(f.paths.stateDir, 'factory.sqlite')) || readFactoryState(f.paths).kind === 'sqlite');
  const view = readFactoryState(f.paths);
  assert.ok(view.corrupt, 'the reader says so');
});

test('a factory that never had state gets an empty store, marked migrated from nothing', () => {
  const f = legacyFactory();
  const r = migrateLegacyState({ paths: f.paths });
  assert.equal(r.migrated, true); assert.equal(r.runs, 0);
  const view = readFactoryState(f.paths);
  assert.equal(view.kind, 'sqlite'); assert.equal(view.store.meta('migrated_from'), 'none');
  view.store.close();
});
