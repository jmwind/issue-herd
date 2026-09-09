// Recoverable lifecycle work: what an owner owed when it died is finished by the next one, exactly
// once; a repeated request is one action; a nudged turn waits for a slot like any pickup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FactoryEngine, SqliteStore, createApplication, factoryPaths, loadConfig, storePath } from '@weawr/engine';

const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));
const ISSUE = { id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open', type: 'started' } };

function repo(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-recover-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify(config));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const CONFIG = (over = {}) => ({ tracker: 'linear', roles: ['impl', 'review'], maxNudges: 6, maxConcurrent: 3, defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: true, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: false, notify: false }, onMerged: null }, rules: [{ name: 'impl', role: 'impl', match: 'any:true' }, { name: 'review', role: 'review', match: 'any:true' }], ...over });

function fakeHerdr(repo, { gone = [] } = {}) {
  const started = new Set();
  return {
    prompts: [], started,
    agent: (name) => ({ agent: 'claude', name, agent_status: 'idle', cwd: repo, foreground_cwd: repo, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }),
    async agentGet(name) { return gone.includes(name) && !started.has(name) ? null : this.agent(name); },
    async prompt(name, text) { this.prompts.push({ name, text }); },
    async startAgent({ name }) { started.add(name); return {}; },
    async createWorkspace() { return { workspaceId: 'w2', tabId: 't2', paneId: 'p2' }; },
    waitAgent(name, { until = [] } = {}) { return until.includes('working') ? Promise.resolve('working') : new Promise(() => {}); },
    async readAgent() { return ''; },
    async notify() {},
    async closeWorkspace() {},
  };
}
/** A tracker that records comments and can be told to fail them. */
function fakeTracker({ failComments = false } = {}) {
  const t = {
    comments: [], failComments, issue: { ...ISSUE },
    async me() { return { id: 'me', name: 'me' }; },
    async issueByKey() { return { ...t.issue, comments: t.comments.map((c) => ({ body: c.body, author: 'me', createdAt: c.at })) }; },
    async comment(issueId, body) { if (t.failComments) throw new Error('HTTP 502 from the tracker'); t.comments.push({ issueId, body, at: new Date().toISOString() }); },
    async addLabel() {}, async removeLabel() {}, async assign() {}, async setState() {},
  };
  return t;
}
function finishedRun(dir, role, over = {}) {
  const key = `GH-7@${role}`;
  const runDir = path.join(dir, '.weawr', 'state', 'runs', key);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'issue.json'), JSON.stringify(ISSUE));
  return { rule: role, role, pass: 1, status: 'awaiting_merge', claimed: `herdr:${role}`, issueId: 'i7', issueKey: 'GH-7', title: ISSUE.title, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z', archiveDir: runDir, worktree: 'none', agentName: `gh-7-${role}`, notified: {}, workspaceId: 'w1', paneId: 'p1', workDir: dir, worktreePath: dir, dir: runDir, resultPath: path.join(runDir, 'result.json'), prUrl: 'https://github.com/o/r/pull/1', ...over };
}
function engine(dir, { store, herdr = fakeHerdr(dir), tracker = null, runs = null }) {
  const paths = factoryPaths(dir);
  if (runs) store.save({ runs, nudges: {} });
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  return new FactoryEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', factoryId: 'fac0001' }, log: () => {} });
}

test('a finish comment the tracker refused is owed, survives the owner, and is sent once by the next owner', async () => {
  const dir = repo(CONFIG());
  const store = SqliteStore.open(storePath(factoryPaths(dir).stateDir));
  const tracker = fakeTracker({ failComments: true });
  const a = engine(dir, { store, tracker, runs: { 'GH-7@impl': finishedRun(dir, 'impl', { status: 'running' }) } });
  fs.writeFileSync(a.state.runs['GH-7@impl'].resultPath, JSON.stringify({ status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1', summary: 'did it' }));
  await a.finalize('GH-7@impl', { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1', summary: 'did it' }, a.cfg.rules[0]);
  // The transition is committed even though the comment failed: the run is done, the comment is owed.
  assert.equal(store.load().runs['GH-7@impl'].status, 'done');
  assert.equal(tracker.comments.length, 0);
  const owed = store.pending();
  assert.equal(owed.length, 1); assert.equal(owed[0].kind, 'tracker.comment'); assert.equal(owed[0].attempts, 1);
  assert.ok(store.eventsAfter(0).some((e) => e.kind === 'run.finished'));
  // The owner dies here. The next one, with a tracker that answers, finishes the work on resume.
  const tracker2 = fakeTracker();
  const b = engine(dir, { store, tracker: tracker2 });
  await b.resume();
  assert.equal(tracker2.comments.length, 1);
  assert.match(tracker2.comments[0].body, /finished GH-7 as `impl`/);
  assert.deepEqual(store.pending(), []);
  // …and a third owner has nothing left to send.
  const c = engine(dir, { store, tracker: tracker2 });
  await c.resume();
  assert.equal(tracker2.comments.length, 1, 'exactly once');
});

test('a comment whose send was uncertain is reconciled against the issue before it is repeated', async () => {
  const dir = repo(CONFIG());
  const store = SqliteStore.open(storePath(factoryPaths(dir).stateDir));
  const tracker = fakeTracker();
  // The comment reached the tracker, but the owner died before recording that (the action is still open).
  const body = '✅ **weawr** finished GH-7 as `impl` with status `pr_open`.\n\nmore';
  tracker.comments.push({ issueId: 'i7', body, at: new Date().toISOString() });
  const id = store.addPending('tracker.comment', { issueId: 'i7', issueKey: 'GH-7', body }, 'GH-7@impl');
  store.settlePending(id, { done: false, error: 'socket hang up' });
  const a = engine(dir, { store, tracker, runs: { 'GH-7@impl': finishedRun(dir, 'impl') } });
  await a.resume();
  assert.equal(tracker.comments.length, 1, 'not posted twice');
  assert.deepEqual(store.pending(), []);
});

test('a repeated request is one reset: the second call replays the first operation', async () => {
  const dir = repo(CONFIG());
  const store = SqliteStore.open(storePath(factoryPaths(dir).stateDir));
  const a = engine(dir, { store, runs: { 'GH-7@impl': finishedRun(dir, 'impl'), 'GH-7@review': finishedRun(dir, 'review', { status: 'done' }) } });
  const app = createApplication(a);
  const r1 = await app.dispatch({ type: 'run.reset', key: 'GH-7', requestId: 'req-1' });
  assert.deepEqual(r1.result.forgot.sort(), ['GH-7@impl', 'GH-7@review']); assert.equal(r1.result.replayed, false);
  // a new run appears in between; the replay must not touch it
  a.state.runs['GH-7@impl'] = finishedRun(dir, 'impl'); a.saveState();
  const r2 = await app.dispatch({ type: 'run.reset', key: 'GH-7', requestId: 'req-1' });
  assert.equal(r2.result.replayed, true); assert.equal(r2.result.operationId, r1.result.operationId);
  assert.deepEqual(Object.keys(a.state.runs), ['GH-7@impl'], 'the replay did nothing');
  const bad = await app.dispatch({ type: 'run.reset', key: 'GH-8', requestId: 'req-1' });
  assert.equal(bad.ok, false); assert.match(bad.error.message, /already used for a different/);
  const shown = await app.dispatch({ type: 'operation.show', id: r1.result.operationId });
  assert.equal(shown.result.status, 'completed');
});

test('a nudged turn waits for a slot: held when the cap is reached, started by the poll that finds room', async () => {
  const dir = repo(CONFIG({ maxConcurrent: 1 }));
  const store = SqliteStore.open(storePath(factoryPaths(dir).stateDir));
  const herdr = fakeHerdr(dir);
  const a = engine(dir, { store, herdr, runs: {
    'GH-7@impl': finishedRun(dir, 'impl'),
    'GH-7@review': finishedRun(dir, 'review', { status: 'done' }),
    'GH-9@impl': finishedRun(dir, 'impl', { status: 'running', issueKey: 'GH-9', agentName: 'gh-9-impl' }),
  } });
  const rule = (n) => a.cfg.rules.find((r) => r.name === n);
  const plan = a.planNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), { status: 'nothing_to_do', nudge: { role: 'impl', message: 'Fix it.' } });
  assert.equal(plan.turns.length, 1);
  await a.carryOutNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), plan);
  const impl = () => a.state.runs['GH-7@impl'];
  assert.equal(impl().status, 'awaiting_merge', 'no turn started: GH-9 holds the only slot');
  assert.deepEqual(impl().queuedNudges.map((n) => n.message), ['Fix it.']);
  assert.equal(herdr.prompts.length, 0);
  assert.ok(store.eventsAfter(0).some((e) => e.kind === 'nudge.held'));
  // the slot frees up; the next poll hands the held ask over
  a.state.runs['GH-9@impl'].status = 'done'; a.saveState();
  await a.deliverHeldNudges();
  assert.equal(impl().status, 'running'); assert.equal(impl().pass, 2);
  assert.equal(herdr.prompts.length, 1);
  assert.equal(store.attempts('GH-7@impl').length, 1, 'the nudged turn recorded its attempt');
  assert.equal(store.attempts('GH-7@impl')[0].spec.nudgedBy[0], 'review');
});

test('every attempt keeps its own brief and policy: the record is not rewritten by a later turn', async () => {
  const dir = repo(CONFIG());
  const store = SqliteStore.open(storePath(factoryPaths(dir).stateDir));
  const herdr = fakeHerdr(dir, { gone: ['gh-7-impl-fac000'] });
  const a = engine(dir, { store, herdr });
  await a.pickUp(ISSUE, a.cfg.rules[0]);
  const first = store.attempts('GH-7@impl');
  assert.equal(first.length, 1);
  assert.equal(first[0].spec.agent.kind, 'claude'); assert.equal(first[0].spec.rule, 'impl');
  assert.equal(first[0].spec.recipe.briefHash.length, 64);
  assert.equal(first[0].spec.weawr.version, '0.0.0');
  // the rule's policy changes, and a second turn starts
  a.cfg.rules[0].model = 'other-model';
  fs.writeFileSync(a.state.runs['GH-7@impl'].resultPath, '{"status":"needs_human"}');
  a.state.runs['GH-7@impl'].status = 'done'; a.saveState();
  await a.pickUp(ISSUE, a.cfg.rules[0], { pass: 2, holdsClaim: true });
  const both = store.attempts('GH-7@impl');
  assert.equal(both.length, 2);
  assert.equal(both[0].spec.agent.model, null, 'the first attempt still says what it was given');
  assert.equal(both[1].spec.agent.model, 'other-model');
  assert.equal(both[0].spec.recipe.templateHash, both[1].spec.recipe.templateHash, 'same template, different policy');
});
