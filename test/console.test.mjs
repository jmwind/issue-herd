// The console: the view model from fixtures, the gate, the registry, and the HTTP surface end to
// end on an ephemeral port with a stand-in orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLog, segments, humanWaitMs, indexSnapshot, watchWorkspaces, runState, factoryView, beltItems } from '../src/console/model.mjs';
import { Gate, hashPasscode, verifyPasscode } from '../src/console/passcode.mjs';
import { stampFactory, loadRegistry, isStale, forgetFactory } from '../src/console/registry.mjs';
import { complexity } from '../src/console/git.mjs';
import { createHandler, listen, tailscaleAddresses } from '../src/console/server.mjs';

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
  assert.deepEqual(runState({ status: 'running' }, { agent_status: 'blocked' }), { light: 'red', phrase: 'waiting for input', needsYou: 'blocked' });
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
  assert.equal(gh7.light, 'red'); assert.equal(gh7.phrase, 'impl waiting for input');
  assert.deepEqual(gh7.slots.map((s) => s.light), ['red', 'empty']);
  assert.equal(gh7.size.added, 10);
  // GH-7 is blocked (from 14:10 with no unblock inside the fixture window? no: the log unblocks it, so the live
  // blocked state comes from herdr, and the wait from the log is 4 + 3 minutes)
  assert.equal(gh7.humanWaitMs, 7 * 60e3);
  // GH-8 finished but its agent is still up and idle → "holding"; GH-7's agent is blocked → first
  assert.deepEqual(v.alerts.map((a) => a.kind), ['blocked', 'holding']);
  assert.equal(v.alerts[0].workspaceId, 'w1');
  assert.equal(v.counts.running, 1); assert.equal(v.counts.alerts, 2);
  assert.equal(v.watcher.version, '0.2.4');
  assert.deepEqual(v.rules.map((r) => r.agent), ['claude', 'codex']);
  const belt = beltItems([v]);
  assert.ok(belt.some((b) => b.text === 'GH-9 merged'));
  assert.ok(belt.some((b) => b.text === 'PR #9'));
  assert.ok(belt.some((b) => b.text === 'commit abc1234'));
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
  assert.throws(() => hashPasscode('12'), /at least 4/);
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

/** The HTTP surface with a stand-in orchestrator. */
async function serve(t, { hash = null } = {}) {
  const calls = [];
  const app = { view: () => ({ hostname: 'box', factories: [], belt: [] }), subscribe: () => () => {}, exit: async (a) => { calls.push(a); return 'exited'; }, tail: async () => 'tail text' };
  const gate = new Gate({ hash });
  const { handler } = createHandler({ gate, console: app, hostname: 'box' });
  const bound = await listen({ handler, port: 0, gated: false });
  t.after(() => bound.close());
  return { base: bound.urls[0].replace(/\/$/, ''), calls };
}

test('http: an ungated console serves the app and the state, and refuses cross-origin actions', async (t) => {
  const { base, calls } = await serve(t);
  const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /Factory Floor/);
  const state = await fetch(base + '/api/state'); assert.equal((await state.json()).hostname, 'box');
  const noOrigin = await fetch(base + '/api/exit', { method: 'POST', body: '{}' }); assert.equal(noOrigin.status, 403);
  const other = await fetch(base + '/api/exit', { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' }); assert.equal(other.status, 403);
  const host = new URL(base).host;
  const ok = await fetch(base + '/api/exit', { method: 'POST', headers: { origin: 'http://' + host, 'content-type': 'application/json' }, body: JSON.stringify({ factory: 'f', run: 'GH-1' }) });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, outcome: 'exited' }); assert.deepEqual(calls, [{ factory: 'f', run: 'GH-1' }]);
  assert.equal((await fetch(base + '/app.css')).headers.get('content-type'), 'text/css; charset=utf-8');
});

test('http: a gated console shows the lock page, refuses the API, unlocks with the passcode, and locks out guesses', async (t) => {
  const { base } = await serve(t, { hash: hashPasscode('1357') });
  const host = new URL(base).host, origin = 'http://' + host;
  const page = await fetch(base + '/'); assert.match(await page.text(), /Locked/);
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
