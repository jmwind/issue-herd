// From state.json to the durable store: inventory, backup, one-transaction import, the console's
// acknowledgements, refusal of a corrupt file, refusal to run twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamPaths } from '../dist/paths.js';
import { inventory, migrateLegacyState } from '../dist/store/migrate.js';
import { readTeamState, storeStatus } from '../dist/store/index.js';

function legacyTeam({ state = null, runDirs = [], notes = null } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-mig-')));
  const paths = teamPaths(repo);
  fs.mkdirSync(paths.runsDir, { recursive: true });
  if (state !== null) fs.writeFileSync(paths.statePath, typeof state === 'string' ? state : JSON.stringify(state));
  for (const d of runDirs) { fs.mkdirSync(path.join(paths.runsDir, d)); fs.writeFileSync(path.join(paths.runsDir, d, 'result.json'), '{}'); }
  const consoleNotesPath = path.join(repo, 'console.json');
  if (notes) fs.writeFileSync(consoleNotesPath, JSON.stringify(notes));
  return { repo, paths, consoleNotesPath };
}
const STATE = { runs: { 'GH-7@impl': { rule: 'impl', role: 'impl', pass: 2, status: 'awaiting_merge', issueKey: 'GH-7', startedAt: '2026-01-01T00:00:00Z', briefPath: '/b' }, 'GH-8': { rule: 'r', status: 'done', startedAt: '2026-01-02T00:00:00Z' } }, nudges: { 'GH-7': [{ from: 'review', to: 'impl', outcome: 'turn', at: 't', message: 'fix' }] } };

test('inventory names what is there and what is odd, without changing anything', () => {
  const f = legacyTeam({ state: STATE, runDirs: ['GH-7@impl', 'SMOKE-1'], notes: { done: { [`${legacyTeam().repo}|GH-1`]: { at: 'x' } } } });
  const inv = inventory({ paths: f.paths, consoleNotesPath: f.consoleNotesPath });
  assert.equal(inv.stateParses, true); assert.equal(inv.runs, 2); assert.equal(inv.nudges, 1);
  assert.deepEqual(inv.orphanRunDirs, ['SMOKE-1']); assert.deepEqual(inv.runsWithoutDir, ['GH-8']);
  assert.equal(inv.consoleNotes, 0, 'another team\'s acknowledgements are not this one\'s');
  assert.equal(inv.storeExists, false);
  assert.equal(storeStatus(f.paths).needsMigration, true);
});

test('migrate backs up, imports runs, nudges, one legacy attempt per run and the acknowledgements, and sets state.json aside', () => {
  const f = legacyTeam({ state: STATE });
  fs.writeFileSync(f.consoleNotesPath, JSON.stringify({ done: { [`${f.repo}|GH-8`]: { at: '2026-01-03T00:00:00Z' }, ['/elsewhere|GH-8']: { at: 'x' } } }));
  const r = migrateLegacyState({ paths: f.paths, consoleNotesPath: f.consoleNotesPath, now: () => new Date('2026-09-08T12:00:00Z') });
  assert.equal(r.migrated, true); assert.equal(r.runs, 2); assert.equal(r.nudges, 1); assert.equal(r.acknowledgements, 1);
  assert.ok(fs.existsSync(path.join(r.backupDir, 'state.json')) && fs.existsSync(path.join(r.backupDir, 'console.json')));
  assert.ok(!fs.existsSync(f.paths.statePath)); assert.ok(fs.existsSync(`${f.paths.statePath}.migrated`));
  const view = readTeamState(f.paths);
  assert.equal(view.kind, 'sqlite');
  assert.equal(view.state.runs['GH-7@impl'].pass, 2);
  assert.deepEqual(view.state.nudges['GH-7'].map((n) => n.message), ['fix']);
  assert.deepEqual(view.store.acknowledgements(), [{ issueKey: 'GH-8', at: '2026-01-03T00:00:00Z', by: 'console' }]);
  const attempts = view.store.attempts('GH-7@impl');
  assert.equal(attempts.length, 1); assert.equal(attempts[0].pass, 2); assert.equal(attempts[0].spec.provenance, 'legacy');
  assert.equal(view.store.eventsAfter(0)[0].kind, 'team.migrated');
  assert.equal(view.store.meta('migrated_from'), f.paths.statePath);
  view.store.close();
  // again: refused, nothing changes
  const again = migrateLegacyState({ paths: f.paths, consoleNotesPath: f.consoleNotesPath });
  assert.equal(again.migrated, false); assert.match(again.reason, /already migrated/);
});

test('a corrupt state.json is refused and preserved; a reader reports it rather than showing an empty team', () => {
  const f = legacyTeam({ state: '{ "runs": { broken' });
  assert.throws(() => migrateLegacyState({ paths: f.paths }), /never treated as an empty team/);
  assert.equal(fs.readFileSync(f.paths.statePath, 'utf8'), '{ "runs": { broken');
  assert.ok(!fs.existsSync(path.join(f.paths.stateDir, 'team.sqlite')) || readTeamState(f.paths).kind === 'sqlite');
  const view = readTeamState(f.paths);
  assert.ok(view.corrupt, 'the reader says so');
});

test('a team that never had state gets an empty store, marked migrated from nothing', () => {
  const f = legacyTeam();
  const r = migrateLegacyState({ paths: f.paths });
  assert.equal(r.migrated, true); assert.equal(r.runs, 0);
  const view = readTeamState(f.paths);
  assert.equal(view.kind, 'sqlite'); assert.equal(view.store.meta('migrated_from'), 'none');
  view.store.close();
});

// ---------------------------------------------------------------- a live legacy team
import { TeamEngine } from '../dist/team.js';
import { loadConfig } from '../dist/config.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));

test('a legacy team with a live session is migrated and resumed: the result is read once, nothing is picked up twice, the agent is untouched', async () => {
  // As an existing install looks the morning after `weawr update`: state.json with a run whose
  // agent is still up in herdr and whose result.json it has just written.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-legacy-live-')));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, '.weawr', 'state', 'runs', 'GH-3@impl'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', roles: ['impl'], defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: true, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: false, notify: false }, onMerged: null }, rules: [{ name: 'impl', role: 'impl', match: 'any:true' }] }));
  const paths = teamPaths(repo);
  const runDir = path.join(paths.runsDir, 'GH-3@impl');
  const issue = { id: 'i3', identifier: 'GH-3', ref: 'GH-3', title: 'Live one', description: '', url: 'u', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open', type: 'started' }, priority: 3 };
  fs.writeFileSync(path.join(runDir, 'issue.json'), JSON.stringify(issue));
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'pr_open', prUrl: 'https://github.com/o/r/pull/3', summary: 'done it' }));
  const legacyRun = { rule: 'impl', role: 'impl', pass: 1, status: 'running', claimed: 'herdr:impl', issueId: 'i3', issueKey: 'GH-3', title: 'Live one', startedAt: '2026-09-08T10:00:00Z', archiveDir: runDir, worktree: 'none', agentName: 'gh-3-impl', notified: {}, workspaceId: 'w3', paneId: 'p3', workDir: repo, dir: runDir, resultPath: path.join(runDir, 'result.json'), briefPath: path.join(runDir, 'brief.md') };
  fs.writeFileSync(paths.statePath, JSON.stringify({ runs: { 'GH-3@impl': legacyRun }, nudges: {} }));
  // the owner starts: migration under its lock, then resume
  const r = migrateLegacyState({ paths });
  assert.equal(r.migrated, true); assert.equal(r.runs, 1);
  const view = readTeamState(paths); view.store.close();
  const herdr = { prompts: [], stops: [], async agentGet(n) { return n === 'gh-3-impl' ? { name: n, agent_status: 'idle', cwd: repo, workspace_id: 'w3' } : null; }, async prompt(n, t) { this.prompts.push([n, t]); }, async startAgent() { throw new Error('must not start a second agent'); }, async createWorkspace() { throw new Error('must not make a second workspace'); }, waitAgent() { return new Promise(() => {}); }, async readAgent() { return ''; }, async notify() {}, async stopAgent(n) { this.stops.push(n); return 'exited'; }, async closeWorkspace() {} };
  const tracker = { comments: [], async me() { return { id: 'me', name: 'me' }; }, async openIssues() { return [issue]; }, async issueByKey() { return issue; }, async comment(id, body) { this.comments.push(body); }, async addLabel() { throw new Error('must not claim again'); }, async removeLabel() {}, async assign() {}, async setState() {} };
  const { SqliteStore, storePath } = await import('../dist/store/sqlite.js');
  const store = SqliteStore.open(storePath(paths.stateDir));
  const e = new TeamEngine({ cfg: loadConfig({ paths, promptsRoot: PROMPTS }), tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'f' }, log: () => {} });
  assert.equal(e.recipeRevision, 1, 'a migrated team keeps the briefs it was running');
  assert.equal(e.state.runs['GH-3@impl'].agentName, 'gh-3-impl', 'the live agent keeps its name');
  await e.resume();
  const run = e.state.runs['GH-3@impl'];
  assert.equal(run.status, 'done', 'the result it had written was read');
  assert.equal(tracker.comments.length, 1, 'reported once');
  assert.match(tracker.comments[0], /as `impl` finished GH-3/);
  assert.deepEqual(herdr.stops, [], 'the session is left as it was');
  // the next poll sees the same issue and picks nothing up again
  const poll = await e.pollOnce();
  assert.deepEqual(poll.picked, []); assert.equal(poll.candidates, 0);
  assert.equal(tracker.comments.length, 1, 'no second report');
  assert.equal(store.attempts('GH-3@impl').length, 1); assert.equal(store.attempts('GH-3@impl')[0].spec.provenance, 'legacy');
  store.close();
});
