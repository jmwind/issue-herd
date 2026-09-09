// The watcher class in-process, with a fake herdr object and no tracker: the handoffs between
// roles (GH-61) are a matter of ordering between runs, which a subprocess per run cannot show.
//
// bin/weawr.mjs resolves the repository from process.cwd() when it is imported, so this file
// stands in a throwaway repository first and imports the module after. Node runs each test file
// in its own process, so the chdir is nobody else's problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/weawr.mjs', import.meta.url).href;

const REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-herd-')));
execFileSync('git', ['init', '-q', REPO]);
fs.mkdirSync(path.join(REPO, '.weawr'), { recursive: true });
fs.writeFileSync(path.join(REPO, '.weawr', 'config.json'), JSON.stringify({
  tracker: 'linear', roles: ['impl', 'review', 'usability'], maxNudges: 6,
  defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: false, notify: true }, onBlocked: { comment: false, notify: true }, onIdle: { comment: false, notify: false } },
  rules: [
    { name: 'impl', role: 'impl', match: 'any:true' },
    { name: 'review', role: 'review', match: 'any:true' },
    { name: 'usability', role: 'usability', match: 'any:true' },
  ],
}));
process.chdir(REPO);
const { Weawr, loadConfig } = await import(BIN);
process.on('exit', () => fs.rmSync(REPO, { recursive: true, force: true }));

const STATE = path.join(REPO, '.weawr', 'state', 'state.json');
const ISSUE = { id: 'i1', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open' } };

/**
 * A herdr with every agent already up in REPO, whose `agent wait` never returns: a nudged turn is
 * started, briefed and left running, which is what these tests want to see. `prompts` records
 * every prompt sent, `notifications` every notification.
 */
function fakeHerdr({ gone = [] } = {}) {
  const started = new Set();
  return {
    prompts: [], notifications: [],
    agent: (name) => ({ agent: 'claude', name, agent_status: 'idle', cwd: REPO, foreground_cwd: REPO, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }),
    async agentGet(name) { return gone.includes(name) && !started.has(name) ? null : this.agent(name); },
    async prompt(name, text) { this.prompts.push({ name, text }); },
    async startAgent({ name }) { started.add(name); return {}; },
    async createWorkspace() { return { workspaceId: 'w2', tabId: 't2', paneId: 'p2' }; },
    async openWorktree() { throw new Error('not in these tests'); },
    waitAgent(name, { until = [] } = {}) { return until.includes('working') ? Promise.resolve('working') : new Promise(() => {}); },
    async readAgent() { return ''; },
    async notify(title, body) { this.notifications.push({ title, body }); },
  };
}

/** A finished run on GH-7 for `role`, its result in place, as state.json would record it. */
function finishedRun(role, over = {}) {
  const key = `GH-7@${role}`;
  const dir = path.join(REPO, '.weawr', 'state', 'runs', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1' }));
  fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(ISSUE));
  return {
    rule: role, role, pass: 1, status: 'awaiting_merge', claimed: `herdr:${role}`, issueId: 'i1', issueKey: 'GH-7', title: ISSUE.title,
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z', archiveDir: dir, worktree: 'none',
    agentName: `gh-7-${role}`, notified: {}, workspaceId: 'w1', paneId: 'p1', workDir: REPO, worktreePath: REPO, dir, resultPath: path.join(dir, 'result.json'),
    prUrl: 'https://github.com/o/r/pull/1', ...over,
  };
}

function app({ runs, nudges = {}, herdr = fakeHerdr() }) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ runs, nudges }));
  const a = new Weawr({ cfg: loadConfig(), tracker: null, herdr });
  return { a, herdr, rule: (name) => a.cfg.rules.find((r) => r.name === name) };
}

const brief = (run) => fs.readFileSync(path.join(run.dir, 'brief.md'), 'utf8');

test('two reviewers nudging one idle implementer start one turn, and the second ask rides the next', async () => {
  // Reproduced before the fix: both reviews planned a turn against the implementer while their
  // finish comments were in flight, so the second pickup landed on top of a turn in progress —
  // replacing its state, rewriting its brief and setting its result aside. Now the first plan
  // reserves the target and the second is held for the turn after.
  const { a, herdr, rule } = app({ runs: { 'GH-7@impl': finishedRun('impl'), 'GH-7@review': finishedRun('review', { status: 'done' }), 'GH-7@usability': finishedRun('usability', { status: 'done' }) } });
  const ask = (role, message) => ({ status: 'nothing_to_do', summary: 'NOT OK', nudge: { role: 'impl', message } });
  // Both plan before either carries out — the finish comments are what sit between the two.
  const p1 = a.planNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), ask('review', 'Fix the null check.'));
  const p2 = a.planNudges('GH-7@usability', a.state.runs['GH-7@usability'], rule('usability'), ask('usability', 'Document the flag.'));
  assert.equal(p1.turns.length, 1);
  assert.equal(p2.turns.length, 0);
  assert.equal(p2.queued.length, 1, 'the second ask is held, not started on top of the first');
  await a.carryOutNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), p1);
  await a.carryOutNudges('GH-7@usability', a.state.runs['GH-7@usability'], rule('usability'), p2);
  const impl = a.state.runs['GH-7@impl'];
  assert.equal(impl.status, 'running');
  assert.equal(impl.pass, 2, 'exactly one turn started');
  assert.equal(herdr.prompts.filter((p) => p.name === 'gh-7-impl').length, 1);
  assert.match(brief(impl), /because `review` nudged you/);
  assert.deepEqual(impl.queuedNudges.map((n) => n.message), ['Document the flag.']);
  assert.deepEqual(a.state.nudges['GH-7'].map((e) => e.outcome), ['turn', 'queue']);
  assert.ok(fs.existsSync(path.join(impl.dir, 'result.pass1.json')));
  assert.ok(!fs.existsSync(path.join(impl.dir, 'result.pass2.json')), 'the running turn was not set aside by a second start');

  // The turn ends: the held ask becomes turn 3, with the usability reviewer's words in the brief.
  fs.writeFileSync(impl.resultPath, JSON.stringify({ status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1' }));
  await a.finalize('GH-7@impl', JSON.parse(fs.readFileSync(impl.resultPath, 'utf8')), rule('impl'));
  const next = a.state.runs['GH-7@impl'];
  assert.equal(next.pass, 3);
  assert.equal(next.status, 'running');
  assert.match(brief(next), /because `usability` nudged you/);
  assert.match(brief(next), /> Document the flag\./);
  assert.deepEqual(next.queuedNudges ?? [], []);
  assert.equal(herdr.prompts.filter((p) => p.name === 'gh-7-impl').length, 2);
});

test('a nudge held for a run whose agent died before a restart is delivered by recovery', async () => {
  // Reproduced before the fix: resume() turned the run into `stopped` and moved on, and with the
  // default single pass no poll would ever revive it, so the reviewer's ask sat in state.json
  // until somebody restarted again.
  const herdr = fakeHerdr({ gone: ['gh-7-impl'] });
  const { a, rule } = app({
    herdr,
    runs: { 'GH-7@impl': finishedRun('impl', { status: 'running', queuedNudges: [{ from: 'review', message: 'Bound the retry loop.', at: '2026-01-01T02:00:00Z' }] }) },
    nudges: { 'GH-7': [{ from: 'review', to: 'impl', outcome: 'queue', at: '2026-01-01T02:00:00Z', message: 'Bound the retry loop.' }] },
  });
  fs.rmSync(a.state.runs['GH-7@impl'].resultPath); // it died without writing one
  await a.resume();
  const impl = a.state.runs['GH-7@impl'];
  assert.equal(impl.status, 'running', 'a fresh session answers the held ask');
  assert.equal(impl.pass, 2);
  assert.match(brief(impl), /because `review` nudged you/);
  assert.match(brief(impl), /> Bound the retry loop\./);
  assert.equal(herdr.prompts.filter((p) => p.name === 'gh-7-impl').length, 1);
  assert.ok(rule('impl'));
});

test('nudging that is switched off is refused quietly; only a spent budget wakes a person', async () => {
  // Reproduced before the fix: the refusal for `maxNudges: 0` matched the cap check's pattern,
  // so the owner was told the agents had exhausted their zero interactions.
  const { a, herdr, rule } = app({ runs: { 'GH-7@impl': finishedRun('impl'), 'GH-7@review': finishedRun('review', { status: 'done' }) } });
  a.cfg.maxNudges = 0;
  const off = a.planNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), { status: 'nothing_to_do', nudge: { role: 'impl', message: 'x' } });
  assert.equal(off.capped, null);
  await a.carryOutNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), off);
  assert.equal(herdr.notifications.length, 0);
  assert.equal(a.state.runs['GH-7@impl'].pass, 1);
  // and the real thing still does
  a.cfg.maxNudges = 1;
  a.state.nudges['GH-7'] = [{ from: 'impl', to: 'review', outcome: 'turn', at: '2026-01-01T02:00:00Z', message: 'look' }];
  const spent = a.planNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), { status: 'nothing_to_do', nudge: { role: 'impl', message: 'x' } });
  assert.ok(spent.capped);
  await a.carryOutNudges('GH-7@review', a.state.runs['GH-7@review'], rule('review'), spent);
  assert.equal(herdr.notifications.length, 1);
  assert.match(herdr.notifications[0].body, /nudged each other 1 times, which is the limit/);
});
