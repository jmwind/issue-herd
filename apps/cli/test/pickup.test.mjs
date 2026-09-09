// The pickup pipeline as a process, against a fake `herdr` on PATH. `weawr smoke` runs the
// real pickUp() over a fake issue and needs no tracker credentials, so a stand-in herdr binary is
// enough to drive the two cases that used to strand a live agent: a first prompt herdr refuses
// because Claude Code is showing a dialog, and a pickup for an issue whose agent is still running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/weawr.mjs', import.meta.url));

/**
 * A `herdr` that answers the calls a pickup makes, in the shapes the real one uses.
 *   mode "blocked-first": `agent prompt` is refused once with agent_blocked, as it is when Claude
 *     Code comes up on its trust dialog; the second prompt is accepted.
 *   mode "adopt": `agent get` always finds an agent, as it does when an earlier attempt at this
 *     issue left its session running.
 *   mode "working": `agent wait` never sees the agent settle — it times out every time, as it does
 *     while an agent that has written its result keeps working (waiting for reviewers to merge).
 * An accepted prompt writes the result.json the brief asks for, which is the agent's whole job here.
 */
function fakeHerdr(t, { mode, cwd }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-herdr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'herdr'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const [noun, verb, ...rest] = process.argv.slice(2);
const dir = ${JSON.stringify(dir)}, mode = ${JSON.stringify(mode)}, cwd = ${JSON.stringify(cwd)};
const bump = (f) => { const n = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim() || 0) + 1; fs.writeFileSync(path.join(dir, f), String(n)); return n; };
const ok = (result) => { process.stdout.write(JSON.stringify({ id: 'fake', result })); process.exit(0); };
const no = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message }, id: 'fake' })); process.exit(1); };
const agent = (name) => ({ agent: 'claude', name, agent_status: 'idle', interactive_ready: true, cwd, foreground_cwd: cwd, pane_id: 'w9:p1', tab_id: 'w9:t1', workspace_id: 'w9' });
fs.appendFileSync(path.join(dir, 'calls.log'), process.argv.slice(2).join(' ') + '\\n');
if (noun === 'agent' && verb === 'get') {
  if (mode === 'adopt' || fs.existsSync(path.join(dir, 'started'))) ok({ agent: agent(rest[0]) });
  no('agent_not_found', 'agent target ' + rest[0] + ' not found');
}
if (noun === 'agent' && verb === 'start') { fs.writeFileSync(path.join(dir, 'started'), '1'); ok({ agent: agent(rest[0]) }); }
if (noun === 'agent' && verb === 'prompt') {
  const n = bump('prompts');
  if (mode === 'blocked-first' && n === 1) no('agent_blocked', 'agent ' + rest[0] + ' is blocked and requires interactive input');
  const brief = /is in (\\S+brief\\.md)/.exec(rest[1] || '');
  // mode "nudge": the first result is a reviewer's, and it asks the implementer to act; whatever
  // turn that starts answers with a plain result, as an implementer that fixed the findings would.
  const result = mode === 'nudge' && n === 1
    ? { status: 'nothing_to_do', summary: 'NOT OK TO MERGE TO MAIN — one finding', nudge: { role: 'impl', message: 'Fix the null check in src/a.mjs:12, then push.' } }
    : mode === 'nudge' ? { status: 'pr_open', prUrl: 'https://github.com/example/repo/pull/1', summary: 'fixed the finding' }
      : { status: 'pr_open', prUrl: 'https://example.test/pr/1', summary: 'fake agent' };
  if (brief) fs.writeFileSync(path.join(path.dirname(brief[1]), 'result.json'), JSON.stringify(result));
  ok({});
}
if (noun === 'agent' && verb === 'wait') { if (mode === 'working' && !rest.includes('--until')) no('timeout', 'agent ' + rest[0] + ' did not settle'); ok({ agent: { agent_status: 'idle' } }); }
if (noun === 'agent' && verb === 'read') { process.stdout.write('fake terminal\\n'); process.exit(0); }
if (noun === 'workspace' && verb === 'create') ok({ workspace: { workspace_id: 'w1' }, tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: 'w1:p1' } });
ok({});
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'prompts'), '0');
  return { dir, calls: () => fs.readFileSync(log, 'utf8'), prompts: () => Number(fs.readFileSync(path.join(dir, 'prompts'), 'utf8')) };
}

/** A git repository configured for weawr, cleaned up when the test ends. */
function repo(t, defaults = null, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-pickup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', rules: [{ name: 'r', match: 'any:true' }], ...(defaults ? { defaults } : {}), ...config }));
  return fs.realpathSync(dir);
}

/** `weawr smoke` in `dir`, with the fake herdr first on PATH. Returns { status, out }. */
function smoke(dir, herdr, args = []) {
  const r = spawnSync(process.execPath, [BIN, 'smoke', ...args], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, WEAWR_NO_UPDATE_CHECK: '1', PATH: `${herdr.dir}:${process.env.PATH}` },
  });
  return { status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('a brief herdr will not take yet is delivered later, not thrown away', (t) => {
  // Reproduced before the fix: `agent prompt` answering agent_blocked failed the whole pickup, so a
  // live agent was left in a workspace nobody watched, holding a brief it had never been told to read.
  const dir = repo(t);
  const herdr = fakeHerdr(t, { mode: 'blocked-first', cwd: dir });
  const r = smoke(dir, herdr);
  assert.match(r.out, /has not taken the brief yet/);
  assert.match(r.out, /it is showing a dialog/);
  assert.doesNotMatch(r.out, /failed to start a session|pickup .* failed/);
  assert.equal(herdr.prompts(), 2, 'the supervisor sends the brief again once the agent takes input');
  assert.match(r.out, /done/);
  assert.equal(r.status, 0);
});

test('a pickup for an issue whose agent is still running reuses that session', (t) => {
  // Reproduced before the fix: the second pickup built another workspace and then died on
  // "agent name gh-19 is already used", leaving an empty workspace behind and the real session adrift.
  const dir = repo(t);
  const herdr = fakeHerdr(t, { mode: 'adopt', cwd: dir });
  const r = smoke(dir, herdr);
  assert.match(r.out, /is already running .*; reusing that session/);
  assert.doesNotMatch(herdr.calls(), /agent start/);
  assert.doesNotMatch(herdr.calls(), /workspace create/);
  assert.equal(r.status, 0);
});

test('a result written by an agent that keeps working is finalized without waiting for it to stop', (t) => {
  // GH-45: the implementer may merge its own PR once the reviewers say OK, so it writes result.json
  // and then waits for them. The supervisor used to wait up to six hours for the agent to settle
  // before reading the file, so the very handoff that starts those reviewers never happened.
  const dir = repo(t);
  const herdr = fakeHerdr(t, { mode: 'working', cwd: dir });
  const r = smoke(dir, herdr);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /done/);
  // The wait is bounded to a minute, so the next read of result.json is never far away.
  assert.match(herdr.calls(), /agent wait \S+ --timeout 60000\n/);
  assert.doesNotMatch(herdr.calls(), /agent wait \S+ --timeout 21600000/);
});

test('a role reaches the herdr sidebar, the agent name and the run key', (t) => {
  // The whole pickup path with a role on it: what herdr is actually asked for is the thing you
  // read in the sidebar, so it is worth asserting against the real calls rather than a helper.
  const dir = repo(t, { role: 'review', model: 'opus', agentKind: 'claude' });
  const herdr = fakeHerdr(t, { mode: 'blocked-first', cwd: dir });
  const r = smoke(dir, herdr);
  assert.equal(r.status, 0, r.out);
  const key = /picking up (SMOKE-\d+@review)/.exec(r.out)?.[1];
  assert.ok(key, `no role-scoped run key in the log:\n${r.out}`);
  assert.match(r.out, /role review/);
  // the sidebar label is "<issue key> <role> <title>"
  assert.match(herdr.calls(), new RegExp(`workspace create .*--label ${key.replace('@review', '')} review weawr smoke test`));
  // the agent is named for the run key, so the two roles on an issue are two agents
  assert.match(herdr.calls(), new RegExp(`agent start ${key.replace('@', '-').toLowerCase()} --kind claude`));
  // and the rule's model reaches the agent's own command line
  assert.match(herdr.calls(), /--model opus/);
});

test('a rule that may chime in more than once says so in the brief', (t) => {
  const dir = repo(t, { role: 'review', passes: 3 });
  const herdr = fakeHerdr(t, { mode: 'blocked-first', cwd: dir });
  const r = smoke(dir, herdr);
  assert.equal(r.status, 0, r.out);
  const brief = /is in (\S+brief\.md)/.exec(herdr.calls());
  assert.ok(brief, `no brief path in the herdr calls:\n${herdr.calls()}`);
  const text = fs.readFileSync(brief[1], 'utf8');
  assert.match(text, /Turn: \*\*1 of 3\*\*/);
  assert.match(text, /You will get another turn if the issue moves on/);
  assert.match(text, /Role: `review`/);
});

test('a reviewer on another provider is started in that provider\'s own dialect', (t) => {
  // The second-set-of-eyes case: the reviewer role runs codex while the implementer runs Claude.
  // What matters is the argv after `--`, because that is the agent's own command line and getting
  // it wrong kills the pane at the prompt rather than failing anywhere visible.
  const dir = repo(t, { role: 'review', agentKind: 'codex', model: 'gpt-5-codex', effort: 'high' });
  const herdr = fakeHerdr(t, { mode: 'blocked-first', cwd: dir });
  const r = smoke(dir, herdr);
  assert.equal(r.status, 0, r.out);
  const start = herdr.calls().split('\n').find((l) => l.startsWith('agent start'));
  assert.ok(start, `no agent start in:\n${herdr.calls()}`);
  assert.match(start, /--kind codex/);
  assert.match(start, /-- --model gpt-5-codex -c model_reasoning_effort="high" --approve-for-me$/);
  // none of Claude Code's flags reach it
  assert.doesNotMatch(start, /--permission-mode/);
  assert.doesNotMatch(start, /--name SMOKE/);
  assert.doesNotMatch(start, /--effort/);
});

/**
 * The same, as a clone with a real `origin` behind it — which is where a factory's merges land, and
 * the reason a checkout nobody pulls falls behind the code its runs are supposed to start from.
 */
function clonedRepo(t) {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-origin-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-clone-'));
  t.after(() => { for (const d of [origin, dir]) fs.rmSync(d, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: origin });
  execFileSync('git', ['clone', '-q', origin, dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', rules: [{ name: 'r', match: 'any:true' }] }));
  return { at: fs.realpathSync(dir), origin };
}

test('the checkout a run works in is pulled up to the base branch first', (t) => {
  // `smoke` runs in "none" mode: the run works in this checkout, on the branch it is standing on.
  // Every merge in the factory lands on origin, and nothing here ever hears about it — so by the
  // third pull request the agent is reading code that was replaced days ago.
  const { at, origin } = clonedRepo(t);
  fs.writeFileSync(path.join(origin, 'merged.txt'), 'a pull request that landed\n');
  execFileSync('git', ['add', 'merged.txt'], { cwd: origin });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'merge a pull request'], { cwd: origin });

  const herdr = fakeHerdr(t, { mode: 'normal', cwd: at });
  const r = smoke(at, herdr);
  assert.match(r.out, /fast-forwarded onto origin\/main/);
  assert.equal(fs.readFileSync(path.join(at, 'merged.txt'), 'utf8'), 'a pull request that landed\n');
  assert.equal(r.status, 0);
});

/**
 * An issue with a finished `impl` run on it, as state.json records one: done, its result in, its
 * session (per the fake herdr) still up in `dir`. This is what a reviewer's nudge wakes.
 */
function seedImplRun(dir, key) {
  const runDir = path.join(dir, '.weawr', 'state', 'runs', `${key}@impl`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'pr_open', prUrl: 'https://github.com/example/repo/pull/1', summary: 'first turn' }));
  const run = {
    rule: 'impl', role: 'impl', pass: 1, status: 'awaiting_merge', claimed: 'herdr:impl',
    issueId: 'fake', issueKey: key, title: 'weawr smoke test', url: 'https://linear.app/example',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z',
    archiveDir: path.join(dir, '.weawr', 'state', 'runs', `${key}@impl`),
    worktree: 'none', agentName: `${key.toLowerCase()}-impl`, notified: {}, workspaceId: 'w9', paneId: 'w9:p1',
    workDir: dir, dir: runDir, resultPath: path.join(runDir, 'result.json'), prUrl: 'https://github.com/example/repo/pull/1',
    result: { status: 'pr_open', prUrl: 'https://github.com/example/repo/pull/1' },
  };
  const statePath = path.join(dir, '.weawr', 'state', 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ runs: { [`${key}@impl`]: run } }));
  return { runDir, state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) };
}

/** The reviewer-and-implementer pair this repository runs, in "none" worktree mode so no commits are needed. */
const TWO_ROLES = { roles: ['impl', 'review'], rules: [{ name: 'r', match: 'any:true' }, { name: 'impl', role: 'impl', match: 'any:true', worktree: 'none' }] };

test('a reviewer\'s nudge gives the implementer its next turn, through herdr, with the ask in its brief', (t) => {
  // GH-61: a reviewer that found something wrong could only say so on the issue, and the
  // implementer's agent sat idle in the next pane until a person carried the message over.
  const dir = repo(t, { role: 'review', worktree: 'none' }, TWO_ROLES);
  const seeded = seedImplRun(dir, 'SMOKE-1');
  const herdr = fakeHerdr(t, { mode: 'nudge', cwd: dir });
  const r = smoke(dir, herdr, ['--key', 'SMOKE-1']);
  assert.equal(r.status, 0, r.out);
  // the review's result asked for impl, and the watcher gave impl a turn
  assert.match(r.out, /SMOKE-1@review: nudge → SMOKE-1@impl: turn/);
  assert.match(r.out, /picking up SMOKE-1@impl .*turn 2, nudged by review/);
  // it went to the implementer's own session — the herdr API, not a comment somebody has to read
  assert.match(herdr.calls(), /agent prompt smoke-1-impl /);
  assert.doesNotMatch(herdr.calls(), /agent start smoke-1-impl/);
  // the brief quotes the ask, says whose turn this is, and points at the last turn's result
  const brief = fs.readFileSync(path.join(seeded.runDir, 'brief.md'), 'utf8');
  assert.match(brief, /Turn: \*\*2\*\* on this issue for this rule, because `review` nudged you/);
  assert.match(brief, /> Fix the null check in src\/a\.mjs:12, then push\./);
  assert.match(brief, /result\.pass1\.json/);
  assert.ok(fs.existsSync(path.join(seeded.runDir, 'result.pass1.json')), 'the first turn\'s result was set aside, not overwritten');
  // and the brief teaches the implementer to nudge back, with the budget
  assert.match(brief, /other roles on this issue are `review`/);
  assert.match(brief, /\*\*5\*\* nudges left/);
  // the implementer's turn ran to a result and the watch on its PR survived
  const s = seeded.state();
  assert.equal(s.runs['SMOKE-1@impl'].pass, 2);
  assert.equal(s.runs['SMOKE-1@impl'].status, 'awaiting_merge');
  assert.equal(s.runs['SMOKE-1@impl'].prUrl, 'https://github.com/example/repo/pull/1');
  assert.deepEqual(s.nudges['SMOKE-1'].map((e) => [e.from, e.to, e.outcome]), [['review', 'impl', 'turn']]);
});

test('with maxNudges 0 the nudge is refused and nobody is woken', (t) => {
  const dir = repo(t, { role: 'review', worktree: 'none' }, { ...TWO_ROLES, maxNudges: 0 });
  const seeded = seedImplRun(dir, 'SMOKE-2');
  const herdr = fakeHerdr(t, { mode: 'nudge', cwd: dir });
  const r = smoke(dir, herdr, ['--key', 'SMOKE-2']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /SMOKE-2@review: nudge → SMOKE-2@impl: refused \(nudging is off/);
  assert.doesNotMatch(herdr.calls(), /agent prompt smoke-2-impl/);
  assert.equal(seeded.state().runs['SMOKE-2@impl'].pass, 1);
  // and the reviewer's brief did not teach a move it could not make
  const brief = /is in (\S+brief\.md)/.exec(herdr.calls());
  assert.doesNotMatch(fs.readFileSync(brief[1], 'utf8'), /Working with the other roles/);
});

test('a nudge over the cap is refused and the issue is handed to a person', (t) => {
  const dir = repo(t, { role: 'review', worktree: 'none' }, { ...TWO_ROLES, maxNudges: 1 });
  const seeded = seedImplRun(dir, 'SMOKE-3');
  // one nudge already spent on this issue
  const statePath = path.join(dir, '.weawr', 'state', 'state.json');
  const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  s.nudges = { 'SMOKE-3': [{ from: 'impl', to: 'review', at: '2026-01-01T02:00:00Z', outcome: 'turn', message: 'look again' }] };
  fs.writeFileSync(statePath, JSON.stringify(s));
  const herdr = fakeHerdr(t, { mode: 'nudge', cwd: dir });
  const r = smoke(dir, herdr, ['--key', 'SMOKE-3']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /nudge → SMOKE-3@impl: refused \(the agents have already nudged each other 1 time on this issue/);
  assert.doesNotMatch(herdr.calls(), /agent prompt smoke-3-impl/);
  // the person is told through the notification the smoke rule keeps on
  assert.match(herdr.calls(), /notification show weawr SMOKE-3@review --body .*have nudged each other 1 times, which is the limit/);
  assert.equal(seeded.state().runs['SMOKE-3@impl'].pass, 1);
});
