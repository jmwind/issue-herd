// The canonical projection, from fixtures: runs, structured events, what herdr says, what the
// tracker said. Ported from the console's model tests; the log parser is gone, so the same run
// history is given as the events the engine records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, humanWaitMs, indexSnapshot, watchWorkspaces, runState, ownsPr, teamView, productionWindows, production, timelineOf, SETTLE_MS } from '../dist/projection.js';
import { complexity } from '../dist/adapters/git-size.mjs';

const T = (h, m, s = 0) => new Date(2026, 8, 7, h, m, s).getTime();
const iso = (h, m, s = 0) => new Date(T(h, m, s)).toISOString();

/** GH-7@impl's history as the engine records it. */
const EVENTS = timelineOf([
  { at: iso(14, 0, 5), kind: 'run.prompted', runKey: 'GH-7@impl' },
  { at: iso(14, 10), kind: 'run.blocked', runKey: 'GH-7@impl' },
  { at: iso(14, 14), kind: 'run.working', runKey: 'GH-7@impl' },
  { at: iso(14, 30), kind: 'run.question', runKey: 'GH-7@impl' },
  { at: iso(14, 33), kind: 'run.working', runKey: 'GH-7@impl' },
  { at: iso(14, 40), kind: 'run.finished', runKey: 'GH-7@impl', data: { status: 'pr_open' } },
  { at: iso(14, 41), kind: 'team.poll', runKey: null },
]);
/** The old fixtures' log lines, read into the events the engine would have recorded for them. */
const LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (\S+?): (.*)$/;
function parseLog(text) {
  if (text === undefined) return EVENTS;
  const events = [];
  for (const raw of String(text).split('\n')) {
    const m = LINE.exec(raw); if (!m) continue;
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString(); const msg = m[8];
    const kind = /^prompted/.test(msg) ? 'run.prompted' : /^blocked\b/.test(msg) ? 'run.blocked' : /^unblocked|^working again/.test(msg) ? 'run.working' : /^(idle|done|unknown) without a result/.test(msg) ? 'run.question' : /^done \(/.test(msg) ? 'run.finished' : /^agent exited without a result/.test(msg) ? 'run.stopped' : /is merged/.test(msg) ? 'run.merged' : null;
    if (kind) events.push({ at, kind, runKey: m[7] });
  }
  return timelineOf(events);
}

test('timelineOf keeps the events that move a run and reads their timestamps', () => {
  assert.deepEqual(EVENTS.map((e) => e.kind), ['working', 'blocked', 'working', 'question', 'working', 'done']);
  assert.equal(EVENTS[1].ts, T(14, 10));
  assert.ok(EVENTS.every((e) => e.key === 'GH-7@impl'));
});

test('segments and human wait: dialogs and questions are a person\'s time, and so is a PR waiting to merge', () => {
  const run = { startedAt: iso(14, 0), finishedAt: iso(14, 40), status: 'awaiting_merge' };
  const segs = segments(run, parseLog(), T(15, 0));
  assert.deepEqual(segs.map((s) => s.kind), ['working', 'blocked', 'working', 'question', 'working', 'done']);
  assert.equal(segs[1].to - segs[1].from, 4 * 60e3);
  // 4 min blocked + 3 min asking + 20 min since the PR opened
  assert.equal(humanWaitMs(run, segs, T(15, 0)), (4 + 3 + 20) * 60e3);
  const quiet = segments({ startedAt: iso(14, 0), status: 'running' }, [], T(14, 5));
  assert.deepEqual(quiet, [{ from: T(14, 0), to: T(14, 5), kind: 'working' }]);
});

const SNAPSHOT = { result: { snapshot: { version: '0.8.2',
  agents: [{ name: 'gh-7-impl', agent_status: 'blocked', workspace_id: 'w1' }, { name: 'gh-8', agent_status: 'idle', workspace_id: 'w2' }],
  workspaces: [{ workspace_id: 'w0', label: 'appWatch' }, { workspace_id: 'w1', label: 'GH-7 impl Fix the thing' }],
  panes: [{ pane_id: 'w0:p1', workspace_id: 'w0', cwd: '/home/me/app', foreground_cwd: '/home/me/app' }],
} } };

test('the snapshot is indexed and watcher workspaces are found by their label', () => {
  const idx = indexSnapshot(SNAPSHOT);
  assert.equal(idx.agents.get('gh-7-impl').agent_status, 'blocked');
  assert.deepEqual(watchWorkspaces(idx), [{ workspaceId: 'w0', label: 'appWatch', name: 'app', cwd: '/home/me/app' }]);
  assert.equal(indexSnapshot(null).agents.size, 0); assert.equal(indexSnapshot(null).available, false); assert.equal(idx.available, true);
});

test('a workspace is open for a run only while the workspace under its id is the run\'s own', () => {
  // herdr numbers workspaces per server session: after a restart, `w1` — recorded on this run when
  // its workspace was made — can be somebody else's. The view must not count that one as ours,
  // or Mark done and Tidy close it (that is how GH-69's agent died).
  const state = { runs: { 'GH-7@impl': { ...fixtureState().runs['GH-7@impl'], workspaceLabel: 'GH-7 impl Fix the thing', worktreePath: '/tmp/wt' } } };
  const open = (snapshot, runs = state.runs) => teamView({ id: 'app', repo: '/r', config: CONFIG, state: { runs }, index: indexSnapshot({ ...snapshot }), now: T(15, 0) }).issues[0].runs[0].workspaceOpen;
  const onR = { checkout_path: '/tmp/wt', is_linked_worktree: true, repo_root: '/r' };
  const onOther = { ...onR, repo_root: '/other' };
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onR }] }), true, 'the label the run gave it, on this repository');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing' }] }), true, 'herdr reporting no repository leaves the name');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-69 impl Rename project to weawr', worktree: onR }] }), false, 'a stranger under our old id');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onOther }] }), false, 'another team\'s GH-7 impl: keys and roles repeat across repositories');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Repair billing export', worktree: onOther }] }), false);
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing, retitled', worktree: onR }] }), false, 'the head of the label is not the label');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'Personal inspection', worktree: onR }] }), false, 'a person\'s workspace reopened on the run\'s worktree, under its recycled id, is not the run\'s');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 review Fix the thing', worktree: onR }] }), false, 'another role\'s workspace is another run\'s');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onR }] }, { 'GH-7': { ...fixtureState().runs['GH-7@impl'], role: null, workspaceLabel: 'GH-7 Fix the thing' } }), false, 'an unroled GH-7 run is not GH-7 impl');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'stranger', worktree: onR }], agents: [{ name: 'gh-7-impl', agent_status: 'working', workspace_id: 'w1' }] }), true, 'our agent standing in it');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'stranger', worktree: onOther }], agents: [{ name: 'gh-7-impl', agent_status: 'working', workspace_id: 'w1' }] }), false, 'an agent of our name on another repository is not ours');
  assert.equal(open({ workspaces: [] }), false, 'gone');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing' }] }, { 'GH-7@impl': fixtureState().runs['GH-7@impl'] }), true, 'a run recorded before labels were kept is matched on the label it must have been given');
  assert.equal(teamView({ id: 'app', repo: '/r', config: CONFIG, state, index: indexSnapshot(null), now: T(15, 0) }).issues[0].runs[0].workspaceOpen, null, 'unknown while herdr is not answering');
  assert.equal(teamView({ id: 'app', repo: '/r', config: CONFIG, state, index: indexSnapshot({}), now: T(15, 0) }).issues[0].runs[0].workspaceLabel, 'GH-7 impl Fix the thing', 'the view carries the label so a close can be checked against it');
});

test('a workspace is open for a run only while the workspace under its id is the run\'s own', () => {
  // herdr numbers workspaces per server session: after a restart, `w1` — recorded on this run when
  // its workspace was made — can be somebody else's. The view must not count that one as ours,
  // or Mark done and Tidy close it (that is how GH-69's agent died).
  const state = { runs: { 'GH-7@impl': { ...fixtureState().runs['GH-7@impl'], workspaceLabel: 'GH-7 impl Fix the thing', worktreePath: '/tmp/wt' } } };
  const open = (snapshot, runs = state.runs) => teamView({ id: 'app', repo: '/r', config: CONFIG, state: { runs }, index: indexSnapshot({ ...snapshot }), now: T(15, 0) }).issues[0].runs[0].workspaceOpen;
  const onR = { checkout_path: '/tmp/wt', is_linked_worktree: true, repo_root: '/r' };
  const onOther = { ...onR, repo_root: '/other' };
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onR }] }), true, 'the label the run gave it, on this repository');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing' }] }), true, 'herdr reporting no repository leaves the name');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-69 impl Rename project to weawr', worktree: onR }] }), false, 'a stranger under our old id');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onOther }] }), false, 'another team\'s GH-7 impl: keys and roles repeat across repositories');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing, retitled', worktree: onR }] }), false, 'the head of the label is not the label');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'Personal inspection', worktree: onR }] }), false, 'a person\'s workspace reopened on the run\'s worktree, under its recycled id, is not the run\'s');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 review Fix the thing', worktree: onR }] }), false, 'another role\'s workspace is another run\'s');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onR }] }, { 'GH-7': { ...fixtureState().runs['GH-7@impl'], role: null, workspaceLabel: 'GH-7 Fix the thing' } }), false, 'an unroled GH-7 run is not GH-7 impl');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'stranger', worktree: onR }], agents: [{ name: 'gh-7-impl', agent_status: 'working', workspace_id: 'w1' }] }), true, 'our agent standing in it');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'stranger', worktree: onOther }], agents: [{ name: 'gh-7-impl', agent_status: 'working', workspace_id: 'w1' }] }), false, 'an agent of our name on another repository is not ours');
  assert.equal(open({ workspaces: [] }), false, 'gone');
  assert.equal(open({ workspaces: [{ workspace_id: 'w1', label: 'GH-7 impl Fix the thing' }] }, { 'GH-7@impl': fixtureState().runs['GH-7@impl'] }), true, 'a run recorded before labels were kept is matched on the label it must have been given');
  assert.equal(teamView({ id: 'app', repo: '/r', config: CONFIG, state, index: indexSnapshot(null), now: T(15, 0) }).issues[0].runs[0].workspaceOpen, null, 'unknown while herdr is not answering');
  assert.equal(teamView({ id: 'app', repo: '/r', config: CONFIG, state, index: indexSnapshot({}), now: T(15, 0) }).issues[0].runs[0].workspaceLabel, 'GH-7 impl Fix the thing', 'the view carries the label so a close can be checked against it');
});

test('runState maps run + agent onto a light, a phrase and whether a person is needed', () => {
  assert.deepEqual(runState({ status: 'running' }, { agent_status: 'blocked' }), { light: 'red', phrase: 'blocked on a dialog', needsYou: 'blocked' });
  assert.equal(runState({ status: 'running' }, { agent_status: 'idle' }).needsYou, 'question');
  assert.equal(runState({ status: 'running' }, null).needsYou, 'gone');
  assert.equal(runState({ status: 'awaiting_merge' }, null).needsYou, 'merge');
  assert.equal(runState({ status: 'done', result: { status: 'needs_human' } }, null).needsYou, 'needs_human');
  assert.equal(runState({ status: 'merged' }, null).needsYou, null);
});

function fixtureState() {
  return { runs: {
    'GH-7@impl': { rule: 'implement', role: 'impl', status: 'running', issueKey: 'GH-7', title: 'Fix the thing', url: 'https://github.com/o/r/issues/7', startedAt: iso(14, 0), agentName: 'gh-7-impl', workspaceId: 'w1', branch: '7-fix-the-thing-impl', workDir: '/tmp/wt' },
    'GH-8': { rule: 'implement', role: null, status: 'done', issueKey: 'GH-8', title: 'Old one', url: 'https://github.com/o/r/issues/8', startedAt: iso(12, 0), finishedAt: iso(12, 30), agentName: 'gh-8', workspaceId: 'w2', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/9', summary: 'did it' } },
    'GH-9': { rule: 'implement', role: null, status: 'merged', issueKey: 'GH-9', title: 'Merged one', startedAt: iso(10, 0), finishedAt: iso(11, 0), agentName: 'gh-9', prUrl: 'https://github.com/o/r/pull/5' },
  } };
}
const CONFIG = { name: 'app', tracker: 'github', roles: ['impl', 'review'], maxConcurrent: 3, pollSeconds: 30, defaults: { agentKind: 'claude' }, rules: [
  { name: 'implement', role: 'impl', match: 'label:ai', model: 'opus' },
  { name: 'tech-lead', role: 'review', match: 'label:ai and label:ready', agentKind: 'codex', basedOn: 'impl' },
] };

test('teamView: issues bucketed, role slots in order, alerts ranked, human wait summed', () => {
  const v = teamView({ id: 'app', repo: '/home/me/app', config: CONFIG, state: fixtureState(), events: parseLog(), index: indexSnapshot(SNAPSHOT), sizes: { 'GH-7@impl': { added: 10, removed: 2, files: 1, paths: ['src/a.mjs'], commits: [{ sha: 'abc1234', subject: 'x' }], complexity: { grade: 'S', why: '1 directory' } } }, registry: { version: '0.2.4', lastPoll: iso(14, 59), pollSeconds: 30 }, now: T(15, 0) });
  assert.equal(v.name, 'app'); assert.equal(v.tracker, 'github');
  assert.deepEqual(v.roles, ['impl', 'review']);
  assert.deepEqual(v.issues.map((i) => [i.key, i.bucket]), [['GH-7', 'inflight'], ['GH-8', 'done'], ['GH-9', 'merged']]);
  const gh7 = v.issues[0];
  assert.equal(gh7.light, 'red'); assert.equal(gh7.phrase, 'impl blocked on a dialog');
  assert.deepEqual(gh7.slots.map((s) => s.light), ['red', 'empty']);
  assert.equal(gh7.size.added, 10);
  // GH-7 is blocked (from 14:10 with no unblock inside the fixture window? no: the log unblocks it, so the live
  // blocked state comes from herdr, and the wait from the log is 4 + 3 minutes)
  assert.equal(gh7.humanWaitMs, 7 * 60e3);
  // GH-8 finished but its agent is still up and idle → "holding"; GH-7's agent is blocked → first;
  // GH-9 merged this morning with nobody left on it → waits for a person's sign-off, last
  assert.deepEqual(v.alerts.map((a) => [a.kind, a.issueKey]), [['blocked', 'GH-7'], ['holding', 'GH-8'], ['finished', 'GH-9']]);
  assert.equal(v.alerts[0].workspaceId, 'w1');
  assert.deepEqual(v.issues.map((i) => i.runs.map((r) => [r.workspaceId, r.workspaceOpen])), [[['w1', true]], [['w2', true]], [[null, false]]], 'each run says whether herdr still has its workspace: w2 is not in the list but gh-8 is standing in it');
  assert.equal(v.counts.running, 1); assert.equal(v.counts.alerts, 3);
  assert.equal(v.watcher.version, '0.2.4');
  assert.deepEqual(v.rules.map((r) => r.agent), ['claude', 'codex']);
});

test('teamView: what the tracker and GitHub said lands on the task, and a merged PR moves it to output', () => {
  const runs = { 'GH-8': { rule: 'ai', status: 'done', issueKey: 'GH-8', title: 'x', startedAt: iso(12, 0), finishedAt: iso(12, 30), agentName: 'gh-8', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/9' } } };
  const unknown = teamView({ id: 'x', repo: '/r', state: { runs }, now: T(13, 0) }).issues[0];
  assert.equal(unknown.issueState, null); assert.equal(unknown.prState, 'open'); assert.equal(unknown.bucket, 'done');
  const known = teamView({ id: 'x', repo: '/r', state: { runs }, enrich: { issues: { 'GH-8': 'closed' }, prs: { 'https://github.com/o/r/pull/9': 'merged' } }, now: T(13, 0) }).issues[0];
  assert.equal(known.issueState, 'closed'); assert.equal(known.prState, 'merged'); assert.equal(known.bucket, 'merged'); assert.equal(known.merged, true);
  const none = teamView({ id: 'x', repo: '/r', state: { runs: { 'GH-1': { rule: 'ai', status: 'running', title: 't', startedAt: iso(14, 0), agentName: 'gh-1' } } }, now: T(14, 5) }).issues[0];
  assert.equal(none.prState, 'none');
  // a run that never recorded a PR, but GitHub has one for its branch
  const byBranch = teamView({ id: 'x', repo: '/r', state: { runs: { 'GH-1': { rule: 'ai', status: 'done', title: 't', startedAt: iso(14, 0), finishedAt: iso(14, 30), agentName: 'gh-1', branch: '1-t', result: { status: 'needs_human' } } } }, enrich: { issues: {}, prs: { 'https://github.com/o/r/pull/2': 'open' }, branches: { '1-t': 'https://github.com/o/r/pull/2' } }, now: T(15, 0) }).issues[0];
  assert.equal(byBranch.prUrl, 'https://github.com/o/r/pull/2'); assert.equal(byBranch.prState, 'open');
});

test('a task a person marked done loses its alerts and sits in output, until a newer run starts on it', () => {
  const runs = { 'GH-1': { rule: 'ai', status: 'failed', title: 'old', startedAt: iso(9, 0), finishedAt: iso(9, 1), agentName: 'gh-1', error: 'boom' } };
  const before = teamView({ id: 'x', repo: '/r', state: { runs }, now: T(12, 0) });
  assert.equal(before.alerts.length, 1);
  const after = teamView({ id: 'x', repo: '/r', state: { runs }, cleared: { 'GH-1': T(10, 0) }, now: T(12, 0) });
  assert.equal(after.alerts.length, 0); assert.equal(after.issues[0].cleared, true); assert.equal(after.issues[0].bucket, 'done');
  const retried = teamView({ id: 'x', repo: '/r', state: { runs: { ...runs, 'GH-1@impl': { rule: 'ai', role: 'impl', status: 'failed', issueKey: 'GH-1', title: 'old', startedAt: iso(11, 0), finishedAt: iso(11, 1), agentName: 'gh-1-impl', error: 'again' } } }, cleared: { 'GH-1': T(10, 0) }, now: T(12, 0) });
  assert.equal(retried.issues[0].cleared, false); assert.ok(retried.alerts.length >= 1, 'the newer run brings the task back');
});

test('a merged task shows as finished even when one of its role runs failed', () => {
  const runs = {
    'GH-5@impl': { rule: 'implement', role: 'impl', status: 'merged', issueKey: 'GH-5', title: 'Logo', startedAt: iso(10, 0), finishedAt: iso(11, 0), agentName: 'gh-5-impl', prUrl: 'https://github.com/o/r/pull/6' },
    'GH-5@review': { rule: 'tech-lead', role: 'review', status: 'failed', issueKey: 'GH-5', title: 'Logo', startedAt: iso(11, 5), finishedAt: iso(11, 6), agentName: 'gh-5-review', error: 'timed out' },
  };
  const v = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, now: T(12, 0) });
  const t = v.issues[0];
  assert.equal(t.bucket, 'merged'); assert.equal(t.light, 'grey'); assert.equal(t.phrase, 'merged');
  assert.deepEqual(t.slots.map((s) => s.light), ['grey', 'red'], 'the failed review is still a fact on its chip');
  assert.deepEqual(v.alerts.map((a) => a.kind), ['failed'], 'and still an alert for a day');
  // a finished, unmerged task is described by its outcome, not by a failed sibling
  const done = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { ...runs, 'GH-5@impl': { ...runs['GH-5@impl'], status: 'done', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/6' } } } }, now: T(12, 0) }).issues[0];
  assert.equal(done.bucket, 'done'); assert.equal(done.light, 'grey'); assert.equal(done.phrase, 'impl PR open');
});

test('a PR waiting on reviewers is nobody\'s wait, and a reviewer\'s report is not a decision', () => {
  // GH-45 as the screenshot in issue #49 had it: impl's PR is up and the watcher waits for the
  // merge, review has reported, usability is still reading.
  const runs = {
    'GH-45@impl': { rule: 'implement', role: 'impl', status: 'awaiting_merge', issueKey: 'GH-45', title: 'Allow auto-merge', startedAt: iso(20, 0), finishedAt: iso(20, 40), agentName: 'gh-45-impl', workspaceId: 'w1', prUrl: 'https://github.com/o/r/pull/47', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/47' } },
    'GH-45@review': { rule: 'tech-lead', role: 'review', status: 'done', issueKey: 'GH-45', title: 'Allow auto-merge', startedAt: iso(20, 41), finishedAt: iso(20, 42), agentName: 'gh-45-review', workspaceId: 'w2', result: { status: 'needs_human', summary: 'NOT OK TO MERGE TO MAIN' } },
    'GH-45@usability': { rule: 'usability', role: 'usability', status: 'running', issueKey: 'GH-45', title: 'Allow auto-merge', startedAt: iso(20, 41), agentName: 'gh-45-usability', workspaceId: 'w3' },
  };
  const config = { ...CONFIG, roles: ['impl', 'review', 'usability'] };
  const idle = { agents: [{ name: 'gh-45-impl', agent_status: 'idle', workspace_id: 'w1' }, { name: 'gh-45-review', agent_status: 'idle', workspace_id: 'w2' }, { name: 'gh-45-usability', agent_status: 'working', workspace_id: 'w3' }] };
  const v = teamView({ id: 'x', repo: '/r', config, state: { runs }, index: indexSnapshot(idle), now: T(20, 45) });
  const t = v.issues[0];
  assert.deepEqual(v.alerts, [], 'nothing needs a person while usability is still working');
  assert.deepEqual(t.slots.map((s) => [s.light, s.phrase]), [['grey', 'waiting for review'], ['grey', 'has findings'], ['green', 'working']]);
  assert.equal(t.phrase, 'usability working'); assert.equal(t.light, 'green');
  assert.equal(t.humanWaitMs, 0, 'the merge clock has not started');
  // impl running tools while it waits (a monitor on its PR) is the same waiting state, lit
  const busy = teamView({ id: 'x', repo: '/r', config, state: { runs }, index: indexSnapshot({ agents: [...idle.agents.slice(1), { name: 'gh-45-impl', agent_status: 'working', workspace_id: 'w1' }] }), now: T(20, 45) });
  assert.deepEqual(busy.alerts, []); assert.equal(busy.issues[0].slots[0].light, 'green'); assert.equal(busy.issues[0].slots[0].phrase, 'waiting for review');
  // a dialog in impl's pane is still a person's, whoever else is running
  const blocked = teamView({ id: 'x', repo: '/r', config, state: { runs }, index: indexSnapshot({ agents: [...idle.agents.slice(1), { name: 'gh-45-impl', agent_status: 'blocked', workspace_id: 'w1' }] }), now: T(20, 45) });
  assert.deepEqual(blocked.alerts.map((a) => a.kind), ['blocked']);
  // usability finishes: now the PR is the person's, one alert for the task, the clock from that moment
  const later = { ...runs, 'GH-45@usability': { ...runs['GH-45@usability'], status: 'done', finishedAt: iso(20, 50), result: { status: 'nothing_to_do', summary: 'USABILITY: OK' } } };
  const done = teamView({ id: 'x', repo: '/r', config, state: { runs: later }, index: indexSnapshot(idle), now: T(21, 0) });
  assert.deepEqual(done.alerts.map((a) => [a.kind, a.role]), [['merge', 'impl']], 'reviewers who finished are done, not alerts, and no one is "holding" a workspace on a task in flight');
  assert.equal(done.alerts[0].text, 'Pull request open; review has findings, usability found nothing blocking. Waiting for your merge.');
  assert.equal(done.alerts[0].verdicts, 'review has findings, usability found nothing blocking', 'shown under the alert line, where a phone can see it');
  assert.deepEqual(done.issues[0].runs.map((r) => r.ownsPr), [true, false, false]);
  assert.equal(done.alerts[0].sinceMs, 10 * 60e3, 'waited on since usability finished, not since the PR opened');
  assert.equal(done.issues[0].humanWaitMs, 10 * 60e3);
  assert.equal(done.issues[0].phrase, 'impl awaiting your merge');
  // once the task is over, an agent still sitting on a workspace is worth a line again
  const merged = teamView({ id: 'x', repo: '/r', config, state: { runs: { ...later, 'GH-45@impl': { ...later['GH-45@impl'], status: 'merged', finishedAt: iso(21, 5) } } }, index: indexSnapshot(idle), now: T(21, 10) });
  assert.deepEqual(merged.alerts.map((a) => [a.kind, a.role]), [['holding', 'review'], ['holding', 'impl']], 'longest first; usability\'s agent is still working in this snapshot, so it holds nothing');
  // a lone run that stops for a decision, with no PR anyone else owns, is still a decision
  assert.equal(runState({ status: 'done', result: { status: 'needs_human' } }, null, { reviewer: false }).needsYou, 'needs_human');
  assert.ok(ownsPr(runs['GH-45@impl'])); assert.ok(!ownsPr(runs['GH-45@review']));
});

test('an in-flight agent that reads as idle, blocked or gone is not an alert until it has held for the settle window', () => {
  // GH-56: the console reads herdr every 2s, and a run on its way up (no agent yet, then idle until
  // the prompt lands) or between turns bounced the task into Alerts and back.
  const runs = { 'GH-56@impl': { rule: 'implement', role: 'impl', status: 'starting', issueKey: 'GH-56', title: 'Stop the bounce', startedAt: iso(9, 0), agentName: 'gh-56-impl', workspaceId: 'w1' } };
  const at = (index, now, state = runs, seen = memory) => teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: state }, index: indexSnapshot(index), seen, now });
  const memory = {};
  const none = { agents: [] };
  const idle = { agents: [{ name: 'gh-56-impl', agent_status: 'idle', workspace_id: 'w1' }] };
  const working = { agents: [{ name: 'gh-56-impl', agent_status: 'working', workspace_id: 'w1' }] };
  const blocked = { agents: [{ name: 'gh-56-impl', agent_status: 'blocked', workspace_id: 'w1' }] };
  // starting, no agent registered yet: a green "starting" row in Assembling, nothing in Alerts
  let v = at(none, T(9, 0, 2));
  assert.deepEqual(v.alerts, []); assert.equal(v.issues[0].bucket, 'inflight');
  assert.deepEqual([v.issues[0].light, v.issues[0].phrase, v.issues[0].runs[0].settling], ['green', 'impl starting', 'gone']);
  // the agent is up but idle: the prompt has not landed; the clock restarts because the state changed
  const running = { 'GH-56@impl': { ...runs['GH-56@impl'], status: 'running' } };
  v = at(idle, T(9, 0, 20), running);
  assert.deepEqual(v.alerts, []); assert.deepEqual([v.issues[0].light, v.issues[0].phrase, v.issues[0].runs[0].settling], ['green', 'impl working', 'question']);
  // it starts working: remembered as such, so the log cannot later revive an episode the console saw end
  v = at(working, T(9, 0, 30), running);
  assert.deepEqual(v.alerts, []); assert.equal(v.issues[0].runs[0].settling, null); assert.deepEqual(memory, { 'GH-56@impl': { needsYou: null, since: T(9, 0, 30) } });
  // idle again, held for less than the window: still nothing; held for the window: a question, at once
  v = at(idle, T(9, 5, 0), running); assert.deepEqual(v.alerts, []);
  v = at(idle, T(9, 5, 0) + SETTLE_MS - 1, running); assert.deepEqual(v.alerts, []);
  v = at(idle, T(9, 5, 0) + SETTLE_MS, running);
  assert.deepEqual(v.alerts.map((a) => a.kind), ['question']); assert.deepEqual([v.issues[0].light, v.issues[0].phrase], ['yellow', 'impl waiting on you']);
  // leaving an alert state shows at once, and a different alert state starts its own clock
  v = at(blocked, T(9, 6, 0), running); assert.deepEqual(v.alerts, []); assert.equal(v.issues[0].runs[0].settling, 'blocked');
  v = at(blocked, T(9, 6, 0) + SETTLE_MS, running); assert.deepEqual(v.alerts.map((a) => a.kind), ['blocked']);
  v = at(working, T(9, 6, 50), running); assert.deepEqual(v.alerts, []); assert.equal(v.issues[0].phrase, 'impl working');
  // the watcher's log is memory too: a dialog it logged a while ago is settled for a console that just started
  const log = parseLog('[2026-09-07 09:10:00] GH-56@impl: prompted (state working)\n[2026-09-07 09:20:00] GH-56@impl: blocked — waiting for approval or input in w1\n');
  v = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: running }, index: indexSnapshot(blocked), events: log, seen: {}, now: T(9, 30) });
  assert.deepEqual(v.alerts.map((a) => a.kind), ['blocked']);
  // The log seeds the clock only on the console's first look. Afterwards a recovery the console saw
  // ends the episode even though the watcher, on its slower poll, never logged it: the same state
  // coming back two seconds later is a new episode and waits the full window (the reviewer's case).
  for (const [index, kind] of [[blocked, 'blocked'], [idle, 'question']]) {
    const mem = {};
    const logged = parseLog(`[2026-09-07 09:00:00] GH-56@impl: prompted (state working)\n[2026-09-07 09:01:00] GH-56@impl: ${kind === 'blocked' ? 'blocked — waiting for approval or input in w1' : 'idle without a result — probably asking a question in w1'}\n`);
    const look = (idx, now) => teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: running }, index: indexSnapshot(idx), events: logged, seen: mem, now });
    assert.deepEqual(look(index, T(9, 2, 0)).alerts.map((a) => a.kind), [kind], 'first look: the log says it has been so for a minute');
    assert.deepEqual(look(working, T(9, 2, 2)).alerts, [], 'the console saw it recover');
    v = look(index, T(9, 2, 4));
    assert.deepEqual(v.alerts, [], `${kind} again two seconds later is a new episode, whatever the log still says`); assert.equal(v.issues[0].runs[0].settling, kind);
    assert.deepEqual(look(index, T(9, 2, 4) + SETTLE_MS - 1).alerts, []);
    assert.deepEqual(look(index, T(9, 2, 4) + SETTLE_MS).alerts.map((a) => a.kind), [kind], 'and settles after the full window');
  }
  // without a memory the view is instant, as a one-shot reading should be
  assert.deepEqual(at(blocked, T(9, 0, 2), running, null).alerts.map((a) => a.kind), ['blocked']);
  // a run's own finished states are the watcher's call and are not held back
  const failed = { 'GH-56@impl': { ...runs['GH-56@impl'], status: 'failed', finishedAt: iso(9, 1), error: 'no' } };
  assert.deepEqual(at(none, T(9, 1, 1), failed).alerts.map((a) => a.kind), ['failed']);
});

test('teamView without roles still lists each run as one slot', () => {
  const v = teamView({ id: 'x', repo: '/r', config: { rules: [{ name: 'ai', match: 'any:true' }] }, state: { runs: { 'GH-1': { rule: 'ai', status: 'running', title: 't', startedAt: iso(14, 0), agentName: 'gh-1' } } }, index: indexSnapshot({ agents: [{ name: 'gh-1', agent_status: 'working' }] }), now: T(14, 5) });
  assert.deepEqual(v.roles, []);
  assert.deepEqual(v.issues[0].slots, [{ role: 'run', light: 'green', phrase: 'working' }]);
  assert.equal(v.issues[0].phrase, 'working');
  assert.equal(v.issues[0].elapsedMs, 5 * 60e3);
});

test('a failed run stops being an alert after a day', () => {
  const runs = { 'GH-1': { rule: 'ai', status: 'failed', title: 'old', startedAt: iso(1, 0), finishedAt: iso(1, 1), agentName: 'gh-1', error: 'boom' } };
  const fresh = teamView({ id: 'x', repo: '/r', state: { runs }, now: T(12, 0) });
  assert.deepEqual(fresh.alerts.map((a) => a.kind), ['failed']);
  const old = teamView({ id: 'x', repo: '/r', state: { runs }, now: T(1, 2) + 86400e3 });
  assert.deepEqual(old.alerts, []);
});

test('production: what came out today, this week and this month, and time on its own against time waiting on a person', () => {
  // 2026-09-07 is a Monday: today and this week begin together, the month a week earlier.
  const w = productionWindows(T(15, 0));
  assert.equal(w.today, T(0, 0)); assert.equal(w.week, T(0, 0)); assert.equal(w.month, new Date(2026, 8, 1).getTime());
  assert.equal(productionWindows(new Date(2026, 8, 9, 12).getTime()).week, T(0, 0), 'Wednesday belongs to Monday\'s week');
  const runs = {
    // finished this afternoon: 40 min of run, 7 of them a person's (from the log)
    'GH-7@impl': { rule: 'implement', role: 'impl', status: 'done', issueKey: 'GH-7', title: 'Fix', startedAt: iso(14, 0), finishedAt: iso(14, 40), agentName: 'gh-7-impl', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/9' } },
    // merged last week: counts for the month only, and its hour of work is outside today's window
    'GH-2': { rule: 'implement', status: 'merged', issueKey: 'GH-2', title: 'Old', startedAt: new Date(2026, 8, 3, 10).toISOString(), finishedAt: new Date(2026, 8, 3, 11).toISOString(), agentName: 'gh-2', prUrl: 'https://github.com/o/r/pull/3' },
    // merged in August: outside every window
    'GH-1': { rule: 'implement', status: 'merged', issueKey: 'GH-1', title: 'Older', startedAt: new Date(2026, 7, 20, 10).toISOString(), finishedAt: new Date(2026, 7, 20, 12).toISOString(), agentName: 'gh-1', prUrl: 'https://github.com/o/r/pull/1' },
  };
  const v = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, events: parseLog(), now: T(15, 0) });
  assert.deepEqual(v.production.today, { finished: 1, merged: 0, workingMs: 33 * 60e3, humanMs: 7 * 60e3 });
  assert.deepEqual(v.production.week, v.production.today);
  assert.deepEqual(v.production.month, { finished: 2, merged: 1, workingMs: (33 + 60) * 60e3, humanMs: 7 * 60e3 });
  assert.equal(v.counts.working, 0);
  // a PR waiting 20 min for its merge is still in flight, not output, and the wait is a person's
  const waiting = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { ...runs, 'GH-7@impl': { ...runs['GH-7@impl'], status: 'awaiting_merge', prUrl: 'https://github.com/o/r/pull/9' } } }, events: parseLog(), now: T(15, 0) });
  assert.deepEqual(waiting.production.today, { finished: 0, merged: 0, workingMs: 33 * 60e3, humanMs: 27 * 60e3 });
  // a run straddling midnight counts today's part only
  const straddle = [{ bucket: 'inflight', runs: [{ segments: [{ from: T(0, 0) - 30 * 60e3, to: T(0, 30), kind: 'working' }], waitingSince: null }] }];
  assert.equal(production(straddle, T(0, 0), T(1, 0)).workingMs, 30 * 60e3);
  // a merged PR keeps the wait it had: the watcher stamps mergedAt and overwrites finishedAt with
  // the moment it noticed, so the wait runs from the agent's own finish (the log's done event) to the merge
  const MLOG = '[2026-09-07 10:00:00] GH-4@impl: prompted (state working)\n[2026-09-07 11:00:00] GH-4@impl: done (pr_open) https://github.com/o/r/pull/4\n[2026-09-07 13:00:10] GH-4@impl: https://github.com/o/r/pull/4 is merged\n';
  const open = { 'GH-4@impl': { rule: 'implement', role: 'impl', status: 'awaiting_merge', issueKey: 'GH-4', title: 'm', startedAt: iso(10, 0), finishedAt: iso(11, 0), agentName: 'gh-4-impl', prUrl: 'https://github.com/o/r/pull/4' } };
  const before = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: open }, events: parseLog(MLOG), now: T(13, 0) });
  assert.deepEqual(before.production.today, { finished: 0, merged: 0, workingMs: 60 * 60e3, humanMs: 120 * 60e3 });
  assert.deepEqual(before.issues[0].runs[0].mergeWait, { from: T(11, 0), to: null }, 'an open wait has no end, so the view is the same from tick to tick');
  const merged = { 'GH-4@impl': { ...open['GH-4@impl'], status: 'merged', mergedAt: iso(13, 0), finishedAt: iso(13, 0, 30) } };
  const after = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: merged }, events: parseLog(MLOG), now: T(14, 0) });
  assert.deepEqual(after.production.today, { finished: 1, merged: 1, workingMs: 60 * 60e3, humanMs: 120 * 60e3 }, 'the two hours waited are still there after the merge');
  assert.equal(after.issues[0].humanWaitMs, 120 * 60e3, 'and on the task itself');
  assert.deepEqual(after.issues[0].runs[0].mergeWait, { from: T(11, 0), to: T(13, 0) });
  // with a reviewer that reported at noon the person's wait began then; one still reading at the merge means it never began
  const reviewed = { ...merged, 'GH-4@review': { rule: 'tech-lead', role: 'review', status: 'done', issueKey: 'GH-4', title: 'm', startedAt: iso(11, 1), finishedAt: iso(12, 0), agentName: 'gh-4-review', result: { status: 'nothing_to_do' } } };
  assert.equal(teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: reviewed }, events: parseLog(MLOG), now: T(14, 0) }).production.today.humanMs, 60 * 60e3);
  const reading = { ...reviewed, 'GH-4@review': { ...reviewed['GH-4@review'], status: 'done', finishedAt: iso(13, 30) } };
  assert.equal(teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: reading }, events: parseLog(MLOG), now: T(14, 0) }).production.today.humanMs, 0);
  // without the log the agent's own finish is unknown, and an unknown wait counts as none rather than as the whole run
  assert.equal(teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: merged }, now: T(14, 0) }).production.today.humanMs, 0);
  // an agent that herdr says is working lights the team up
  const lit = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { 'GH-3@impl': { rule: 'implement', role: 'impl', status: 'running', issueKey: 'GH-3', title: 't', startedAt: iso(14, 50), agentName: 'gh-3-impl' } } }, index: indexSnapshot({ agents: [{ name: 'gh-3-impl', agent_status: 'working' }] }), now: T(15, 0) });
  assert.equal(lit.counts.working, 1);
});

test('complexity grades from size facts, with a reason', () => {
  assert.equal(complexity(null), null);
  const s = complexity({ added: 20, removed: 3, files: 2, paths: ['src/a.mjs', 'test/a.test.mjs'], commits: [] });
  assert.equal(s.grade, 'S'); assert.match(s.why, /tests 1:1/);
  const l = complexity({ added: 500, removed: 40, files: 5, paths: ['src/a.mjs', 'src/b/c.mjs', 'package.json'], commits: [] });
  assert.equal(l.grade, 'L'); assert.match(l.why, /dependencies touched/);
});

test('a finished task waits in Alerts for a person\'s sign-off whatever became of its agents, and leaves on Mark done or after a day', () => {
  // Auto-merged, every agent exited by onMerged: nobody is holding anything, and it still needs a person.
  const runs = {
    'GH-60@impl': { rule: 'implement', role: 'impl', status: 'merged', issueKey: 'GH-60', title: 'Auto-merged', startedAt: iso(9, 0), finishedAt: iso(9, 30), agentName: 'gh-60-impl', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/61' } },
    'GH-60@review': { rule: 'tech-lead', role: 'review', status: 'done', issueKey: 'GH-60', title: 'Auto-merged', startedAt: iso(9, 5), finishedAt: iso(9, 20), agentName: 'gh-60-review', result: { status: 'nothing_to_do', summary: 'OK TO MERGE TO MAIN' } },
  };
  const v = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, now: T(10, 0) });
  assert.equal(v.issues[0].bucket, 'merged');
  assert.deepEqual(v.alerts.map((a) => [a.kind, a.issueKey, a.role, a.light]), [['finished', 'GH-60', 'impl', 'yellow']]);
  assert.equal(v.alerts[0].text, 'Merged #61; review found nothing blocking. Look it over and mark it done.');
  assert.equal(v.alerts[0].verdicts, 'review found nothing blocking');
  assert.equal(v.alerts[0].sinceMs, 30 * 60e3, 'waiting since the last run finished');
  // One card per task: a task that already has a card (here, an agent holding on) gets no second.
  const holding = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, index: indexSnapshot({ agents: [{ name: 'gh-60-impl', agent_status: 'idle', workspace_id: 'w1' }] }), now: T(10, 0) });
  assert.deepEqual(holding.alerts.map((a) => a.kind), ['holding']);
  // Mark done clears it; a day later it is history either way.
  assert.deepEqual(teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, cleared: { 'GH-60': T(10, 0) }, now: T(10, 1) }).alerts, []);
  assert.deepEqual(teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, now: T(9, 31) + 86400e3 }).alerts, []);
  // A task with nothing finished yet, or still in flight, is not "finished".
  const busy = teamView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { ...runs, 'GH-60@usability': { rule: 'usability', role: 'usability', status: 'running', issueKey: 'GH-60', title: 'Auto-merged', startedAt: iso(9, 40), agentName: 'gh-60-usability' } } }, index: indexSnapshot({ agents: [{ name: 'gh-60-usability', agent_status: 'working', workspace_id: 'w2' }] }), now: T(10, 0) });
  assert.deepEqual(busy.alerts, []);
});

/** The HTTP surface with a stand-in orchestrator. */
async function serve(t, { hash = null } = {}) {
  const calls = [];
  const app = { view: () => ({ hostname: 'box', teams: [] }), subscribe: () => () => {}, exit: async (a) => { calls.push(a); return 'exited'; }, tail: async () => 'tail text',
    markDone: async (a, done) => { calls.push({ done: a, value: done }); return { done, outcomes: done ? [{ run: 'GH-1@impl', role: 'impl', agent: 'gh-1-impl', outcome: 'exited', workspaceId: 'w1', workspace: 'closed' }] : [] }; },
    tidy: async (a) => { calls.push({ tidy: a }); return [{ team: 'f', issue: 'GH-2', run: 'GH-2@impl', role: 'impl', workspaceId: 'w2', workspace: 'closed' }]; },
    tailTask: async () => [{ run: 'GH-1@impl', role: 'impl', agent: 'gh-1-impl', agentKind: 'claude', alive: true, phrase: 'working', text: 'impl lines' }, { run: 'GH-1@review', role: 'review', agent: 'gh-1-review', agentKind: 'codex', alive: false, phrase: 'done', text: null }] };
  const gate = new Gate({ hash });
  const { handler } = createHandler({ gate, console: app, hostname: 'box', webDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)) });
  const bound = await listen({ handler, port: 0, gated: false });
  t.after(() => bound.close());
  return { base: bound.urls[0].replace(/\/$/, ''), calls };
}


test('a run with no events shows its start-to-end stretch and reports a floor, marked partial — never a made-up dialog wait', () => {
  const runs = { 'GH-1': { rule: 'ai', status: 'awaiting_merge', issueKey: 'GH-1', title: 't', startedAt: iso(9, 0), finishedAt: iso(9, 30), agentName: 'gh-1', prUrl: 'https://github.com/o/r/pull/1', result: { status: 'pr_open' } } };
  const v = teamView({ id: 'x', repo: '/r', state: { runs }, events: [], now: T(10, 0) });
  const r = v.issues[0].runs[0];
  assert.equal(r.evidence, 'partial'); assert.deepEqual(r.segments.map((s) => s.kind), ['working', 'done']);
  assert.equal(r.humanWaitMs, 30 * 60e3, 'the merge wait is a recorded fact');
  assert.equal(v.issues[0].evidence, 'partial');
  // and a run the engine started is known even before its first event
  const live = teamView({ id: 'x', repo: '/r', state: { runs: { 'GH-2': { rule: 'ai', status: 'running', title: 't', startedAt: iso(11, 0), agentName: 'gh-2' } } }, events: [], now: T(11, 5) });
  assert.equal(live.issues[0].runs[0].evidence, 'events');
  assert.equal(teamView({ id: 'x', repo: '/r', state: { runs: { 'GH-7@impl': { rule: 'r', status: 'done', startedAt: iso(14, 0), finishedAt: iso(14, 40), agentName: 'gh-7-impl', result: { status: 'pr_open' } } } }, events: EVENTS, now: T(15, 0) }).issues[0].evidence, 'events');
});

test('a task carries its attention and its verdicts as data, decided by the projection', () => {
  const runs = {
    'GH-5@impl': { rule: 'implement', role: 'impl', status: 'awaiting_merge', issueKey: 'GH-5', title: 'x', startedAt: iso(10, 0), finishedAt: iso(11, 0), agentName: 'gh-5-impl', prUrl: 'https://github.com/o/r/pull/6', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/6' } },
    'GH-5@review': { rule: 'tech-lead', role: 'review', status: 'done', issueKey: 'GH-5', title: 'x', startedAt: iso(11, 0), finishedAt: iso(11, 30), agentName: 'gh-5-review', result: { status: 'nothing_to_do', summary: 'OK', review: { verdict: 'approved', prUrl: 'https://github.com/o/r/pull/6', headSha: 'abc1234' } } },
  };
  const v = teamView({ id: 'x', repo: '/r', config: { roles: ['impl', 'review'], rules: [{ name: 'implement', role: 'impl' }, { name: 'tech-lead', role: 'review' }] }, state: { runs }, now: T(12, 0) });
  const t = v.issues[0];
  assert.equal(t.attention, 'merge');
  assert.equal(t.runs[1].result.verdict, 'approved'); assert.equal(t.runs[1].result.verdictSource, 'structured'); assert.equal(t.runs[1].result.verdictHead, 'abc1234');
  assert.equal(t.runs[0].result.verdict, null);
});
