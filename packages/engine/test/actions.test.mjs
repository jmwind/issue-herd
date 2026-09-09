// The actions a person takes on a task, now the owner's: mark done is a composed shutdown that
// acknowledges only when every step succeeded; undo leaves agents alone; tidy closes only what a
// person already signed off; herdr away refuses rather than records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FactoryEngine } from '../dist/factory.js';
import { factoryPaths } from '../dist/paths.js';
import { loadConfig } from '../dist/config.js';
import { SqliteStore, storePath } from '../dist/store/sqlite.js';
import { markDone, undoDone, tidy, stopTask, tailTask, HERDR_AWAY } from '../dist/actions.js';

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-actions-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', roles: ['impl', 'review'], defaults: { worktree: 'none' }, rules: [{ name: 'implement', role: 'impl', match: 'any:true' }, { name: 'tech-lead', role: 'review', match: 'any:true', agentKind: 'codex' }] }));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A herdr whose snapshot lists these agents; stopAgent works unless the name is in `stubborn`. */
// Workspaces are listed under the label the run gave them (`GH-7 impl x` for w-impl), since herdr
// 0.9's ownership check matches on it; `labels` overrides that per id.
const labelFor = (id) => ({ 'w-impl': 'GH-7 impl x', 'w-review': 'GH-7 review x', 'w-8': 'GH-8 impl x', 'w-9': 'GH-9 impl x' }[id] || id);
function fakeHerdr({ agents = {}, workspaces = [], stubborn = [], away = false, reused = {}, labels = {} } = {}) {
  const h = {
    prompts: [], closed: [], owners: [], agents: { ...agents },
    async run(args) { if (away) throw new Error('no server'); if (args[0] === 'api') return { result: { snapshot: { version: '1', agents: Object.entries(this.agents).map(([name, a]) => ({ name, ...a })), workspaces: workspaces.map((id) => ({ workspace_id: id, label: labels[id] || labelFor(id) })), panes: [] } } }; return {}; },
    async agentGet(n) { return this.agents[n] ? { name: n, ...this.agents[n] } : null; },
    async prompt(n, text) { this.prompts.push([n, text]); if (stubborn.includes(n)) return; delete this.agents[n]; },
    async stopAgent(n, { exitCommand }) { if (!this.agents[n]) return 'was already gone'; await this.prompt(n, exitCommand); return this.agents[n] ? 'is still running' : 'exited'; },
    async closeWorkspace(id) { if (!workspaces.includes(id)) { const e = new Error('no such workspace'); e.code = 'workspace_not_found'; throw e; } this.closed.push(id); workspaces = workspaces.filter((w) => w !== id); },
    // herdr 0.9: a close checks the workspace is still the run's; `reused` names ids that now belong to somebody else.
    async closeWorkspaceOf(id, owner) { if (reused[id]) return `was reused by herdr for "${reused[id]}"`; this.owners.push([id, owner]); if (!workspaces.includes(id)) return 'was already closed'; await this.closeWorkspace(id); return 'closed'; },
    async readAgent(n) { return `screen of ${n}`; }, async notify() {},
  };
  return h;
}
function engine(dir, runs, herdr) {
  const paths = factoryPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir)); store.save({ runs, nudges: {} });
  return { e: new FactoryEngine({ cfg: loadConfig({ paths, promptsRoot: PROMPTS }), tracker: null, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', factoryId: 'f' }, log: () => {} }), store };
}
const run = (key, role, rule, over = {}) => ({ rule, role, pass: 1, status: 'done', issueKey: key.split('@')[0], title: 'x', startedAt: '2026-09-08T10:00:00Z', finishedAt: '2026-09-08T11:00:00Z', agentName: key.toLowerCase().replace('@', '-'), workspaceId: `w-${role}`, notified: {}, worktree: 'none', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1' }, ...over });

test('markDone: every agent still up gets its own exit command, every workspace closes, the decision is recorded; undo leaves them alone', async () => {
  const dir = repo();
  const herdr = fakeHerdr({ agents: { 'gh-7-impl': { agent_status: 'idle', workspace_id: 'w-impl' }, 'gh-7-review': { agent_status: 'idle', workspace_id: 'w-review' } }, workspaces: ['w-impl', 'w-review'] });
  const { e, store } = engine(dir, { 'GH-7@impl': run('GH-7@impl', 'impl', 'implement'), 'GH-7@review': run('GH-7@review', 'review', 'tech-lead') }, herdr);
  const r = await markDone(e, 'GH-7');
  assert.equal(r.done, true);
  assert.deepEqual(herdr.prompts, [['gh-7-impl', '/exit'], ['gh-7-review', '/quit']], 'each agent in its own dialect');
  assert.deepEqual(herdr.closed, ['w-impl', 'w-review']);
  assert.deepEqual(r.outcomes.map((o) => [o.role, o.outcome, o.workspace]), [['impl', 'exited', 'closed'], ['review', 'exited', 'closed']]);
  assert.deepEqual(herdr.owners.map(([id, o]) => [id, o.repo === dir, o.agentName]), [['w-impl', true, 'gh-7-impl'], ['w-review', true, 'gh-7-review']], 'each close names the run it is for, so herdr can check the workspace is still the run\'s');
  assert.deepEqual(store.acknowledgements().map((a) => a.issueKey), ['GH-7']);
  assert.ok(store.eventsAfter(0).some((ev) => ev.kind === 'task.acknowledged'));
  const snap = await e.snapshot();
  assert.equal(snap.issues[0].cleared, true); assert.equal(snap.issues[0].bucket, 'done');
  undoDone(e, 'GH-7');
  assert.deepEqual(store.acknowledgements(), []);
  assert.equal((await e.snapshot()).issues[0].cleared, false);
  assert.equal(herdr.prompts.length, 2, 'undo touched no agent');
  await assert.rejects(() => markDone(e, 'GH-9'), /no task GH-9/);
});

test('markDone and tidy: an id herdr has since given to another workspace is reported and left alone, and does not keep the task in Alerts', async () => {
  // The GH-69 story: Mark done on GH-66 closed w3J, which had become GH-69's session after a herdr restart.
  const dir = repo();
  const herdr = fakeHerdr({ workspaces: ['w-impl', 'w-review'], reused: { 'w-review': 'GH-69 impl Rename project to weawr' } });
  const { e, store } = engine(dir, { 'GH-7@impl': run('GH-7@impl', 'impl', 'implement'), 'GH-7@review': run('GH-7@review', 'review', 'tech-lead') }, herdr);
  const r = await markDone(e, 'GH-7');
  assert.equal(r.done, true, 'somebody else\'s workspace under our old id is not a workspace still on the task');
  assert.deepEqual(r.outcomes.map((o) => o.workspace), ['closed', 'was reused by herdr for "GH-69 impl Rename project to weawr"']);
  assert.deepEqual(herdr.closed, ['w-impl']);
  assert.deepEqual(store.acknowledgements().map((a) => a.issueKey), ['GH-7']);
  assert.deepEqual(await tidy(e), [], 'nothing of ours is left to tidy; the stranger is not counted');
});

test('markDone: an agent that will not exit keeps the task where it is, and nothing is recorded', async () => {
  const dir = repo();
  const herdr = fakeHerdr({ agents: { 'gh-7-impl': { agent_status: 'working', workspace_id: 'w-impl' } }, workspaces: ['w-impl'], stubborn: ['gh-7-impl'] });
  const { e, store } = engine(dir, { 'GH-7@impl': run('GH-7@impl', 'impl', 'implement') }, herdr);
  const r = await markDone(e, 'GH-7');
  assert.equal(r.done, false); assert.match(r.error, /still running; not marked done/);
  assert.deepEqual(r.outcomes.map((o) => [o.outcome, o.workspace]), [['is still running', 'left open']]);
  assert.deepEqual(store.acknowledgements(), []);
  assert.deepEqual(herdr.closed, [], 'a workspace with a live agent is not pulled away');
});

test('markDone, tidy and stop: herdr not answering is not a shutdown — refused with the reason, nothing recorded', async () => {
  const dir = repo();
  const herdr = fakeHerdr({ away: true });
  const { e, store } = engine(dir, { 'GH-7@impl': run('GH-7@impl', 'impl', 'implement') }, herdr);
  const r = await markDone(e, 'GH-7');
  assert.equal(r.done, false); assert.equal(r.error, HERDR_AWAY);
  assert.deepEqual(store.acknowledgements(), []);
  await assert.rejects(() => tidy(e), new RegExp(HERDR_AWAY.slice(0, 20)));
  await assert.rejects(() => stopTask(e, 'GH-7'), /herdr is not answering/);
});

test('tidy closes the workspaces of exited agents on tasks already marked done, and nothing else; tail reads what is up', async () => {
  const dir = repo();
  const herdr = fakeHerdr({ agents: { 'gh-8-impl': { agent_status: 'idle', workspace_id: 'w-8' } }, workspaces: ['w-impl', 'w-8', 'w-9'] });
  const { e, store } = engine(dir, {
    'GH-7@impl': run('GH-7@impl', 'impl', 'implement'),                                   // done, signed off, agent gone → tidied
    'GH-8@impl': run('GH-8@impl', 'impl', 'implement', { workspaceId: 'w-8' }),            // signed off, but its agent is still up → left alone
    'GH-9@impl': run('GH-9@impl', 'impl', 'implement', { workspaceId: 'w-9' }),            // not signed off → left alone
  }, herdr);
  store.acknowledge('GH-7', '2026-09-08T12:00:00Z'); store.acknowledge('GH-8', '2026-09-08T12:00:00Z');
  const out = await tidy(e);
  assert.deepEqual(out.map((o) => [o.issue, o.workspaceId, o.workspace]), [['GH-7', 'w-impl', 'closed']]);
  const blocks = await tailTask(e, 'GH-8');
  assert.equal(blocks[0].text, 'screen of gh-8-impl'); assert.equal(blocks[0].source, 'herdr');
  const gone = await tailTask(e, 'GH-7');
  assert.equal(gone[0].text, null); assert.equal(gone[0].alive, false);
  const stopped = await stopTask(e, 'GH-8');
  assert.deepEqual(stopped.outcomes.map((o) => o.outcome), ['exited']);
  assert.deepEqual(store.acknowledgements().map((a) => a.issueKey).sort(), ['GH-7', 'GH-8'], 'stopping acknowledges nothing new');
});
