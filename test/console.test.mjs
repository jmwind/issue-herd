// The console: the view model from fixtures, the gate, the registry, and the HTTP surface end to
// end on an ephemeral port with a stand-in orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLog, segments, humanWaitMs, indexSnapshot, watchWorkspaces, runState, ownsPr, factoryView, productionWindows, production } from '../src/console/model.mjs';
import { Gate, hashPasscode, verifyPasscode } from '../src/console/passcode.mjs';
import { stampFactory, loadRegistry, isStale, forgetFactory } from '../src/console/registry.mjs';
import { complexity } from '../src/console/git.mjs';
import { createHandler, listen, tailscaleAddresses, REPO_URL } from '../src/console/server.mjs';
import { FactoryConsole } from '../src/console/console.mjs';

const T = (h, m, s = 0) => new Date(2026, 8, 7, h, m, s).getTime();
const iso = (h, m, s = 0) => new Date(T(h, m, s)).toISOString();

const LOG = `[2026-09-07 14:00:00] picking up GH-7@impl "Fix the thing" (rule implement, role impl)
[2026-09-07 14:00:05] GH-7@impl: prompted (state working)
[2026-09-07 14:10:00] GH-7@impl: blocked — waiting for approval or input in w1
[2026-09-07 14:14:00] GH-7@impl: unblocked → working
[2026-09-07 14:30:00] GH-7@impl: idle without a result — probably asking a question in w1
[2026-09-07 14:33:00] GH-7@impl: working again
[2026-09-07 14:40:00] GH-7@impl: done (pr_open) https://github.com/o/r/pull/9
[2026-09-07 14:41:00] poll #3: 11 open issues, 0 matched
`;

test('parseLog keeps the lines that move a run and reads their local timestamps', () => {
  const ev = parseLog(LOG);
  assert.deepEqual(ev.map((e) => e.kind), ['working', 'blocked', 'working', 'question', 'working', 'done']);
  assert.equal(ev[1].ts, T(14, 10));
  assert.ok(ev.every((e) => e.key === 'GH-7@impl'));
});

test('segments and human wait: dialogs and questions are a person\'s time, and so is a PR waiting to merge', () => {
  const run = { startedAt: iso(14, 0), finishedAt: iso(14, 40), status: 'awaiting_merge' };
  const segs = segments(run, parseLog(LOG), T(15, 0));
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
  assert.equal(indexSnapshot(null).agents.size, 0);
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

test('factoryView: issues bucketed, role slots in order, alerts ranked, human wait summed', () => {
  const v = factoryView({ id: 'app', repo: '/home/me/app', config: CONFIG, state: fixtureState(), events: parseLog(LOG), index: indexSnapshot(SNAPSHOT), sizes: { 'GH-7@impl': { added: 10, removed: 2, files: 1, paths: ['src/a.mjs'], commits: [{ sha: 'abc1234', subject: 'x' }], complexity: { grade: 'S', why: '1 directory' } } }, registry: { version: '0.2.4', lastPoll: iso(14, 59), pollSeconds: 30 }, now: T(15, 0) });
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
  assert.equal(v.counts.running, 1); assert.equal(v.counts.alerts, 3);
  assert.equal(v.watcher.version, '0.2.4');
  assert.deepEqual(v.rules.map((r) => r.agent), ['claude', 'codex']);
});

test('factoryView: what the tracker and GitHub said lands on the task, and a merged PR moves it to output', () => {
  const runs = { 'GH-8': { rule: 'ai', status: 'done', issueKey: 'GH-8', title: 'x', startedAt: iso(12, 0), finishedAt: iso(12, 30), agentName: 'gh-8', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/9' } } };
  const unknown = factoryView({ id: 'x', repo: '/r', state: { runs }, now: T(13, 0) }).issues[0];
  assert.equal(unknown.issueState, null); assert.equal(unknown.prState, 'open'); assert.equal(unknown.bucket, 'done');
  const known = factoryView({ id: 'x', repo: '/r', state: { runs }, enrich: { issues: { 'GH-8': 'closed' }, prs: { 'https://github.com/o/r/pull/9': 'merged' } }, now: T(13, 0) }).issues[0];
  assert.equal(known.issueState, 'closed'); assert.equal(known.prState, 'merged'); assert.equal(known.bucket, 'merged'); assert.equal(known.merged, true);
  const none = factoryView({ id: 'x', repo: '/r', state: { runs: { 'GH-1': { rule: 'ai', status: 'running', title: 't', startedAt: iso(14, 0), agentName: 'gh-1' } } }, now: T(14, 5) }).issues[0];
  assert.equal(none.prState, 'none');
  // a run that never recorded a PR, but GitHub has one for its branch
  const byBranch = factoryView({ id: 'x', repo: '/r', state: { runs: { 'GH-1': { rule: 'ai', status: 'done', title: 't', startedAt: iso(14, 0), finishedAt: iso(14, 30), agentName: 'gh-1', branch: '1-t', result: { status: 'needs_human' } } } }, enrich: { issues: {}, prs: { 'https://github.com/o/r/pull/2': 'open' }, branches: { '1-t': 'https://github.com/o/r/pull/2' } }, now: T(15, 0) }).issues[0];
  assert.equal(byBranch.prUrl, 'https://github.com/o/r/pull/2'); assert.equal(byBranch.prState, 'open');
});

test('a task a person marked done loses its alerts and sits in output, until a newer run starts on it', () => {
  const runs = { 'GH-1': { rule: 'ai', status: 'failed', title: 'old', startedAt: iso(9, 0), finishedAt: iso(9, 1), agentName: 'gh-1', error: 'boom' } };
  const before = factoryView({ id: 'x', repo: '/r', state: { runs }, now: T(12, 0) });
  assert.equal(before.alerts.length, 1);
  const after = factoryView({ id: 'x', repo: '/r', state: { runs }, cleared: { 'GH-1': T(10, 0) }, now: T(12, 0) });
  assert.equal(after.alerts.length, 0); assert.equal(after.issues[0].cleared, true); assert.equal(after.issues[0].bucket, 'done');
  const retried = factoryView({ id: 'x', repo: '/r', state: { runs: { ...runs, 'GH-1@impl': { rule: 'ai', role: 'impl', status: 'failed', issueKey: 'GH-1', title: 'old', startedAt: iso(11, 0), finishedAt: iso(11, 1), agentName: 'gh-1-impl', error: 'again' } } }, cleared: { 'GH-1': T(10, 0) }, now: T(12, 0) });
  assert.equal(retried.issues[0].cleared, false); assert.ok(retried.alerts.length >= 1, 'the newer run brings the task back');
});

test('a merged task shows as finished even when one of its role runs failed', () => {
  const runs = {
    'GH-5@impl': { rule: 'implement', role: 'impl', status: 'merged', issueKey: 'GH-5', title: 'Logo', startedAt: iso(10, 0), finishedAt: iso(11, 0), agentName: 'gh-5-impl', prUrl: 'https://github.com/o/r/pull/6' },
    'GH-5@review': { rule: 'tech-lead', role: 'review', status: 'failed', issueKey: 'GH-5', title: 'Logo', startedAt: iso(11, 5), finishedAt: iso(11, 6), agentName: 'gh-5-review', error: 'timed out' },
  };
  const v = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, now: T(12, 0) });
  const t = v.issues[0];
  assert.equal(t.bucket, 'merged'); assert.equal(t.light, 'grey'); assert.equal(t.phrase, 'merged');
  assert.deepEqual(t.slots.map((s) => s.light), ['grey', 'red'], 'the failed review is still a fact on its chip');
  assert.deepEqual(v.alerts.map((a) => a.kind), ['failed'], 'and still an alert for a day');
  // a finished, unmerged task is described by its outcome, not by a failed sibling
  const done = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { ...runs, 'GH-5@impl': { ...runs['GH-5@impl'], status: 'done', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/6' } } } }, now: T(12, 0) }).issues[0];
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
  const v = factoryView({ id: 'x', repo: '/r', config, state: { runs }, index: indexSnapshot(idle), now: T(20, 45) });
  const t = v.issues[0];
  assert.deepEqual(v.alerts, [], 'nothing needs a person while usability is still working');
  assert.deepEqual(t.slots.map((s) => [s.light, s.phrase]), [['grey', 'waiting for review'], ['grey', 'has findings'], ['green', 'working']]);
  assert.equal(t.phrase, 'usability working'); assert.equal(t.light, 'green');
  assert.equal(t.humanWaitMs, 0, 'the merge clock has not started');
  // impl running tools while it waits (a monitor on its PR) is the same waiting state, lit
  const busy = factoryView({ id: 'x', repo: '/r', config, state: { runs }, index: indexSnapshot({ agents: [...idle.agents.slice(1), { name: 'gh-45-impl', agent_status: 'working', workspace_id: 'w1' }] }), now: T(20, 45) });
  assert.deepEqual(busy.alerts, []); assert.equal(busy.issues[0].slots[0].light, 'green'); assert.equal(busy.issues[0].slots[0].phrase, 'waiting for review');
  // a dialog in impl's pane is still a person's, whoever else is running
  const blocked = factoryView({ id: 'x', repo: '/r', config, state: { runs }, index: indexSnapshot({ agents: [...idle.agents.slice(1), { name: 'gh-45-impl', agent_status: 'blocked', workspace_id: 'w1' }] }), now: T(20, 45) });
  assert.deepEqual(blocked.alerts.map((a) => a.kind), ['blocked']);
  // usability finishes: now the PR is the person's, one alert for the task, the clock from that moment
  const later = { ...runs, 'GH-45@usability': { ...runs['GH-45@usability'], status: 'done', finishedAt: iso(20, 50), result: { status: 'nothing_to_do', summary: 'USABILITY: OK' } } };
  const done = factoryView({ id: 'x', repo: '/r', config, state: { runs: later }, index: indexSnapshot(idle), now: T(21, 0) });
  assert.deepEqual(done.alerts.map((a) => [a.kind, a.role]), [['merge', 'impl']], 'reviewers who finished are done, not alerts, and no one is "holding" a workspace on a task in flight');
  assert.equal(done.alerts[0].text, 'Pull request open; review has findings, usability found nothing blocking. Waiting for your merge.');
  assert.equal(done.alerts[0].verdicts, 'review has findings, usability found nothing blocking', 'shown under the alert line, where a phone can see it');
  assert.deepEqual(done.issues[0].runs.map((r) => r.ownsPr), [true, false, false]);
  assert.equal(done.alerts[0].sinceMs, 10 * 60e3, 'waited on since usability finished, not since the PR opened');
  assert.equal(done.issues[0].humanWaitMs, 10 * 60e3);
  assert.equal(done.issues[0].phrase, 'impl awaiting your merge');
  // once the task is over, an agent still sitting on a workspace is worth a line again
  const merged = factoryView({ id: 'x', repo: '/r', config, state: { runs: { ...later, 'GH-45@impl': { ...later['GH-45@impl'], status: 'merged', finishedAt: iso(21, 5) } } }, index: indexSnapshot(idle), now: T(21, 10) });
  assert.deepEqual(merged.alerts.map((a) => [a.kind, a.role]), [['holding', 'review'], ['holding', 'impl']], 'longest first; usability\'s agent is still working in this snapshot, so it holds nothing');
  // a lone run that stops for a decision, with no PR anyone else owns, is still a decision
  assert.equal(runState({ status: 'done', result: { status: 'needs_human' } }, null, { reviewer: false }).needsYou, 'needs_human');
  assert.ok(ownsPr(runs['GH-45@impl'])); assert.ok(!ownsPr(runs['GH-45@review']));
});

test('factoryView without roles still lists each run as one slot', () => {
  const v = factoryView({ id: 'x', repo: '/r', config: { rules: [{ name: 'ai', match: 'any:true' }] }, state: { runs: { 'GH-1': { rule: 'ai', status: 'running', title: 't', startedAt: iso(14, 0), agentName: 'gh-1' } } }, index: indexSnapshot({ agents: [{ name: 'gh-1', agent_status: 'working' }] }), now: T(14, 5) });
  assert.deepEqual(v.roles, []);
  assert.deepEqual(v.issues[0].slots, [{ role: 'run', light: 'green', phrase: 'working' }]);
  assert.equal(v.issues[0].phrase, 'working');
  assert.equal(v.issues[0].elapsedMs, 5 * 60e3);
});

test('a failed run stops being an alert after a day', () => {
  const runs = { 'GH-1': { rule: 'ai', status: 'failed', title: 'old', startedAt: iso(1, 0), finishedAt: iso(1, 1), agentName: 'gh-1', error: 'boom' } };
  const fresh = factoryView({ id: 'x', repo: '/r', state: { runs }, now: T(12, 0) });
  assert.deepEqual(fresh.alerts.map((a) => a.kind), ['failed']);
  const old = factoryView({ id: 'x', repo: '/r', state: { runs }, now: T(1, 2) + 86400e3 });
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
  const v = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, events: parseLog(LOG), now: T(15, 0) });
  assert.deepEqual(v.production.today, { finished: 1, merged: 0, workingMs: 33 * 60e3, humanMs: 7 * 60e3 });
  assert.deepEqual(v.production.week, v.production.today);
  assert.deepEqual(v.production.month, { finished: 2, merged: 1, workingMs: (33 + 60) * 60e3, humanMs: 7 * 60e3 });
  assert.equal(v.counts.working, 0);
  // a PR waiting 20 min for its merge is still in flight, not output, and the wait is a person's
  const waiting = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { ...runs, 'GH-7@impl': { ...runs['GH-7@impl'], status: 'awaiting_merge', prUrl: 'https://github.com/o/r/pull/9' } } }, events: parseLog(LOG), now: T(15, 0) });
  assert.deepEqual(waiting.production.today, { finished: 0, merged: 0, workingMs: 33 * 60e3, humanMs: 27 * 60e3 });
  // a run straddling midnight counts today's part only
  const straddle = [{ bucket: 'inflight', runs: [{ segments: [{ from: T(0, 0) - 30 * 60e3, to: T(0, 30), kind: 'working' }], waitingSince: null }] }];
  assert.equal(production(straddle, T(0, 0), T(1, 0)).workingMs, 30 * 60e3);
  // a merged PR keeps the wait it had: the watcher stamps mergedAt and overwrites finishedAt with
  // the moment it noticed, so the wait runs from the agent's own finish (the log's done event) to the merge
  const MLOG = '[2026-09-07 10:00:00] GH-4@impl: prompted (state working)\n[2026-09-07 11:00:00] GH-4@impl: done (pr_open) https://github.com/o/r/pull/4\n[2026-09-07 13:00:10] GH-4@impl: https://github.com/o/r/pull/4 is merged\n';
  const open = { 'GH-4@impl': { rule: 'implement', role: 'impl', status: 'awaiting_merge', issueKey: 'GH-4', title: 'm', startedAt: iso(10, 0), finishedAt: iso(11, 0), agentName: 'gh-4-impl', prUrl: 'https://github.com/o/r/pull/4' } };
  const before = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: open }, events: parseLog(MLOG), now: T(13, 0) });
  assert.deepEqual(before.production.today, { finished: 0, merged: 0, workingMs: 60 * 60e3, humanMs: 120 * 60e3 });
  const merged = { 'GH-4@impl': { ...open['GH-4@impl'], status: 'merged', mergedAt: iso(13, 0), finishedAt: iso(13, 0, 30) } };
  const after = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: merged }, events: parseLog(MLOG), now: T(14, 0) });
  assert.deepEqual(after.production.today, { finished: 1, merged: 1, workingMs: 60 * 60e3, humanMs: 120 * 60e3 }, 'the two hours waited are still there after the merge');
  assert.equal(after.issues[0].humanWaitMs, 120 * 60e3, 'and on the task itself');
  assert.deepEqual(after.issues[0].runs[0].mergeWait, { from: T(11, 0), to: T(13, 0) });
  // with a reviewer that reported at noon the person's wait began then; one still reading at the merge means it never began
  const reviewed = { ...merged, 'GH-4@review': { rule: 'tech-lead', role: 'review', status: 'done', issueKey: 'GH-4', title: 'm', startedAt: iso(11, 1), finishedAt: iso(12, 0), agentName: 'gh-4-review', result: { status: 'nothing_to_do' } } };
  assert.equal(factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: reviewed }, events: parseLog(MLOG), now: T(14, 0) }).production.today.humanMs, 60 * 60e3);
  const reading = { ...reviewed, 'GH-4@review': { ...reviewed['GH-4@review'], status: 'done', finishedAt: iso(13, 30) } };
  assert.equal(factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: reading }, events: parseLog(MLOG), now: T(14, 0) }).production.today.humanMs, 0);
  // without the log the agent's own finish is unknown, and an unknown wait counts as none rather than as the whole run
  assert.equal(factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: merged }, now: T(14, 0) }).production.today.humanMs, 0);
  // an agent that herdr says is working lights the factory up
  const lit = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { 'GH-3@impl': { rule: 'implement', role: 'impl', status: 'running', issueKey: 'GH-3', title: 't', startedAt: iso(14, 50), agentName: 'gh-3-impl' } } }, index: indexSnapshot({ agents: [{ name: 'gh-3-impl', agent_status: 'working' }] }), now: T(15, 0) });
  assert.equal(lit.counts.working, 1);
});

test('complexity grades from size facts, with a reason', () => {
  assert.equal(complexity(null), null);
  const s = complexity({ added: 20, removed: 3, files: 2, paths: ['src/a.mjs', 'test/a.test.mjs'], commits: [] });
  assert.equal(s.grade, 'S'); assert.match(s.why, /tests 1:1/);
  const l = complexity({ added: 500, removed: 40, files: 5, paths: ['src/a.mjs', 'src/b/c.mjs', 'package.json'], commits: [] });
  assert.equal(l.grade, 'L'); assert.match(l.why, /dependencies touched/);
});

test('passcode: hash verifies, wrong code fails, gate locks after five misses and sessions expire', () => {
  const hash = hashPasscode('2468');
  assert.ok(verifyPasscode('2468', hash)); assert.ok(!verifyPasscode('2469', hash)); assert.ok(!verifyPasscode('2468', 'garbage'));
  assert.throws(() => hashPasscode('12'), /at least 4 digits/);
  assert.throws(() => hashPasscode('floorpass'), /digits/, 'letters cannot be typed on the phone keypad');
  let t = 1000; const gate = new Gate({ hash, sessionMs: 60_000, now: () => t });
  for (let i = 0; i < 4; i++) assert.equal(gate.tryUnlock('0000', 'a').attemptsLeft, 4 - i);
  const fifth = gate.tryUnlock('0000', 'a');
  assert.ok(fifth.lockedMs > 0); assert.equal(fifth.attemptsLeft, 0);
  assert.equal(gate.tryUnlock('2468', 'a').ok, false, 'even the right code is refused while locked');
  assert.equal(gate.tryUnlock('2468', 'b').ok, true, 'another address is not locked');
  t += 5 * 60e3 + 1;
  const ok = gate.tryUnlock('2468', 'a'); assert.ok(ok.ok);
  assert.ok(gate.check(ok.token)); assert.ok(!gate.check('nope'));
  t += 60_001; assert.ok(!gate.check(ok.token), 'sessions expire');
  assert.ok(new Gate({ hash: null }).check(undefined), 'no passcode: nothing is gated');
});

test('registry: stamp, read back, staleness, forget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-reg-')); const file = path.join(dir, 'factories.json');
  fs.writeFileSync(file, 'not json'); assert.deepEqual(loadRegistry(file), {}, 'a corrupt registry reads as empty');
  const e = stampFactory({ repo: '/r/app', name: 'app', tracker: 'github', version: '1.0.0', pollSeconds: 30 }, file, new Date(T(14, 0)));
  assert.equal(loadRegistry(file)['/r/app'].name, 'app');
  assert.equal(isStale(e, T(14, 1)), false); assert.equal(isStale(e, T(14, 2)), true, 'three polls missed');
  assert.equal(isStale({}), true);
  assert.equal(forgetFactory('/r/app', file), true); assert.deepEqual(loadRegistry(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailscale addresses are the 100.64/10 IPv4 ones only', () => {
  assert.deepEqual(tailscaleAddresses({ lo: [{ family: 'IPv4', address: '127.0.0.1' }], ts: [{ family: 'IPv4', address: '100.101.7.22' }, { family: 'IPv6', address: 'fd7a::1' }], en0: [{ family: 'IPv4', address: '192.168.1.5' }] }), ['100.101.7.22']);
});

test('markDone: the one action — every agent still up on the task gets its exit command, the decision is recorded, undo leaves the agents alone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-console-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ISSUE_HERD_CONSOLE_NOTES = path.join(dir, 'console.json');
  t.after(() => { delete process.env.ISSUE_HERD_CONSOLE_NOTES; });
  const stopped = [];
  const herdr = { run: async () => null, stopAgent: async (agent, opts) => { stopped.push([agent, opts.exitCommand]); return 'exited'; } };
  const app = new FactoryConsole({ herdr, registryFile: path.join(dir, 'factories.json'), hostname: 'box' });
  app.current.factories = [{ id: 'f', repo: '/r', issues: [{ key: 'GH-1', runs: [
    { key: 'GH-1@impl', role: 'impl', agent: 'gh-1-impl', agentKind: 'claude', agentAlive: true },
    { key: 'GH-1@review', role: 'review', agent: 'gh-1-review', agentKind: 'codex', agentAlive: true },
    { key: 'GH-1@usability', role: 'usability', agent: 'gh-1-usability', agentKind: 'claude', agentAlive: false },
  ] }] }];
  const done = await app.markDone({ factory: 'f', issue: 'GH-1' });
  assert.equal(done.done, true);
  assert.deepEqual(done.outcomes.map((o) => [o.role, o.outcome]), [['impl', 'exited'], ['review', 'exited']], 'only the agents still up are closed');
  assert.deepEqual(stopped, [['gh-1-impl', '/exit'], ['gh-1-review', '/quit']], 'each agent gets its own exit command');
  assert.ok(JSON.parse(fs.readFileSync(process.env.ISSUE_HERD_CONSOLE_NOTES, 'utf8')).done['/r|GH-1'].at, 'the decision is the console\'s own note');
  const undone = await app.markDone({ factory: 'f', issue: 'GH-1' }, false);
  assert.deepEqual(undone, { done: false, outcomes: [] });
  assert.equal(stopped.length, 2, 'undo does not touch the agents');
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.ISSUE_HERD_CONSOLE_NOTES, 'utf8')).done, {});
  await assert.rejects(app.markDone({ factory: 'f', issue: 'GH-9' }), /no task GH-9/);
  // An agent that will not go keeps the task where it is: nothing recorded, the card stays.
  herdr.stopAgent = async (agent) => (agent === 'gh-1-review' ? 'is still running' : 'exited');
  const stuck = await app.markDone({ factory: 'f', issue: 'GH-1' });
  assert.equal(stuck.done, false);
  assert.match(stuck.error, /review \(gh-1-review\) still running; not marked done/);
  assert.deepEqual(stuck.outcomes.map((o) => o.outcome), ['exited', 'is still running'], 'what happened to each agent is still reported');
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.ISSUE_HERD_CONSOLE_NOTES, 'utf8')).done, {}, 'a partial shutdown is not a done note');
  app.stop();
});

test('a finished task waits in Alerts for a person\'s sign-off whatever became of its agents, and leaves on Mark done or after a day', () => {
  // Auto-merged, every agent exited by onMerged: nobody is holding anything, and it still needs a person.
  const runs = {
    'GH-60@impl': { rule: 'implement', role: 'impl', status: 'merged', issueKey: 'GH-60', title: 'Auto-merged', startedAt: iso(9, 0), finishedAt: iso(9, 30), agentName: 'gh-60-impl', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/61' } },
    'GH-60@review': { rule: 'tech-lead', role: 'review', status: 'done', issueKey: 'GH-60', title: 'Auto-merged', startedAt: iso(9, 5), finishedAt: iso(9, 20), agentName: 'gh-60-review', result: { status: 'nothing_to_do', summary: 'OK TO MERGE TO MAIN' } },
  };
  const v = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, now: T(10, 0) });
  assert.equal(v.issues[0].bucket, 'merged');
  assert.deepEqual(v.alerts.map((a) => [a.kind, a.issueKey, a.role, a.light]), [['finished', 'GH-60', 'impl', 'yellow']]);
  assert.equal(v.alerts[0].text, 'Merged #61; review found nothing blocking. Look it over and mark it done.');
  assert.equal(v.alerts[0].verdicts, 'review found nothing blocking');
  assert.equal(v.alerts[0].sinceMs, 30 * 60e3, 'waiting since the last run finished');
  // One card per task: a task that already has a card (here, an agent holding on) gets no second.
  const holding = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, index: indexSnapshot({ agents: [{ name: 'gh-60-impl', agent_status: 'idle', workspace_id: 'w1' }] }), now: T(10, 0) });
  assert.deepEqual(holding.alerts.map((a) => a.kind), ['holding']);
  // Mark done clears it; a day later it is history either way.
  assert.deepEqual(factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, cleared: { 'GH-60': T(10, 0) }, now: T(10, 1) }).alerts, []);
  assert.deepEqual(factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs }, now: T(9, 31) + 86400e3 }).alerts, []);
  // A task with nothing finished yet, or still in flight, is not "finished".
  const busy = factoryView({ id: 'x', repo: '/r', config: CONFIG, state: { runs: { ...runs, 'GH-60@usability': { rule: 'usability', role: 'usability', status: 'running', issueKey: 'GH-60', title: 'Auto-merged', startedAt: iso(9, 40), agentName: 'gh-60-usability' } } }, index: indexSnapshot({ agents: [{ name: 'gh-60-usability', agent_status: 'working', workspace_id: 'w2' }] }), now: T(10, 0) });
  assert.deepEqual(busy.alerts, []);
});

/** The HTTP surface with a stand-in orchestrator. */
async function serve(t, { hash = null } = {}) {
  const calls = [];
  const app = { view: () => ({ hostname: 'box', factories: [] }), subscribe: () => () => {}, exit: async (a) => { calls.push(a); return 'exited'; }, tail: async () => 'tail text',
    markDone: async (a, done) => { calls.push({ done: a, value: done }); return { done, outcomes: done ? [{ run: 'GH-1@impl', role: 'impl', agent: 'gh-1-impl', outcome: 'exited' }] : [] }; },
    tailTask: async () => [{ run: 'GH-1@impl', role: 'impl', agent: 'gh-1-impl', agentKind: 'claude', alive: true, phrase: 'working', text: 'impl lines' }, { run: 'GH-1@review', role: 'review', agent: 'gh-1-review', agentKind: 'codex', alive: false, phrase: 'done', text: null }] };
  const gate = new Gate({ hash });
  const { handler } = createHandler({ gate, console: app, hostname: 'box' });
  const bound = await listen({ handler, port: 0, gated: false });
  t.after(() => bound.close());
  return { base: bound.urls[0].replace(/\/$/, ''), calls };
}

test('http: an ungated console serves the app and the state, and refuses cross-origin actions', async (t) => {
  const { base, calls } = await serve(t);
  const page = await fetch(base + '/'); assert.equal(page.status, 200); const body = await page.text(); assert.match(body, /Factory Floor/);
  assert.match(body, new RegExp('<a class="home" href="' + REPO_URL + '" target="_blank" rel="noopener"[^>]*><svg[^>]*class="mark"'), 'the mark in the title bar opens the repository in a new tab');
  const state = await fetch(base + '/api/state'); assert.equal((await state.json()).hostname, 'box');
  const noOrigin = await fetch(base + '/api/exit', { method: 'POST', body: '{}' }); assert.equal(noOrigin.status, 403);
  const other = await fetch(base + '/api/exit', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' }); assert.equal(other.status, 403);
  const host = new URL(base).host;
  const ok = await fetch(base + '/api/exit', { method: 'POST', headers: { origin: 'http://' + host, 'content-type': 'application/json' }, body: JSON.stringify({ factory: 'f', run: 'GH-1' }) });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, outcome: 'exited' }); assert.deepEqual(calls, [{ factory: 'f', run: 'GH-1' }]);
  assert.equal((await fetch(base + '/app.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  const done = await fetch(base + '/api/done', { method: 'POST', headers: { origin: 'http://' + host, 'content-type': 'application/json' }, body: JSON.stringify({ factory: 'f', issue: 'GH-1' }) });
  assert.deepEqual(await done.json(), { ok: true, done: true, outcomes: [{ run: 'GH-1@impl', role: 'impl', agent: 'gh-1-impl', outcome: 'exited' }], error: null }, 'marking done reports what happened to the agents it closed');
  assert.deepEqual(calls.at(-1), { done: { factory: 'f', issue: 'GH-1' }, value: true });
  assert.equal((await fetch(base + '/api/done', { method: 'POST', body: '{}' })).status, 403, 'marking done is same-origin only');
  assert.equal((await fetch(base + '/api/undone', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/close', { method: 'POST', headers: { origin: 'http://' + host }, body: '{}' })).status, 404, 'there is no separate close: Mark done is the one action');
  const blocks = (await (await fetch(base + '/api/tail?factory=f&issue=GH-1')).json()).blocks;
  assert.deepEqual(blocks.map((b) => [b.role, b.alive]), [['impl', true], ['review', false]]);
});

test('http: a gated console shows the lock page, refuses the API, unlocks with the passcode, and locks out guesses', async (t) => {
  const { base } = await serve(t, { hash: hashPasscode('1357') });
  const host = new URL(base).host, origin = 'http://' + host;
  const page = await fetch(base + '/'); const lock = await page.text(); assert.match(lock, /Locked/);
  assert.match(lock, new RegExp('<a class="home" href="' + REPO_URL + '" target="_blank"'), 'the lock page links the mark too');
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const wrong = await fetch(base + '/unlock', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: '0000' }) });
  assert.equal(wrong.status, 401); assert.equal((await wrong.json()).attemptsLeft, 4);
  const right = await fetch(base + '/unlock', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: '1357' }) });
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(';')[0];
  assert.equal((await fetch(base + '/api/state', { headers: { cookie: session } })).status, 200);
  assert.match(await (await fetch(base + '/', { headers: { cookie: session } })).text(), /app\.js/);
  const tail = await fetch(base + '/api/tail?factory=f&run=GH-1', { headers: { cookie: session } }); assert.deepEqual(await tail.json(), { text: 'tail text' });
  for (let i = 0; i < 5; i++) await fetch(base + '/unlock', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x' }) });
  const locked = await fetch(base + '/unlock', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: '1357' }) });
  assert.equal(locked.status, 429);
  assert.match(await (await fetch(base + '/')).text(), /Gate locked|Locked/);
  const out = await fetch(base + '/lock', { method: 'POST', headers: { cookie: session } }); assert.equal(out.status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { cookie: session } })).status, 401, 'locking revokes the session');
});
