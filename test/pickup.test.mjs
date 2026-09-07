// The pickup pipeline as a process, against a fake `herdr` on PATH. `issue-herd smoke` runs the
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

const BIN = fileURLToPath(new URL('../bin/issue-herd.mjs', import.meta.url));

/**
 * A `herdr` that answers the calls a pickup makes, in the shapes the real one uses.
 *   mode "blocked-first": `agent prompt` is refused once with agent_blocked, as it is when Claude
 *     Code comes up on its trust dialog; the second prompt is accepted.
 *   mode "adopt": `agent get` always finds an agent, as it does when an earlier attempt at this
 *     issue left its session running.
 * An accepted prompt writes the result.json the brief asks for, which is the agent's whole job here.
 */
function fakeHerdr(t, { mode, cwd }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-herd-herdr-'));
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
  if (brief) fs.writeFileSync(path.join(path.dirname(brief[1]), 'result.json'), JSON.stringify({ status: 'pr_open', prUrl: 'https://example.test/pr/1', summary: 'fake agent' }));
  ok({});
}
if (noun === 'agent' && verb === 'wait') ok({ agent: { agent_status: 'idle' } });
if (noun === 'agent' && verb === 'read') { process.stdout.write('fake terminal\\n'); process.exit(0); }
if (noun === 'workspace' && verb === 'create') ok({ workspace: { workspace_id: 'w1' }, tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: 'w1:p1' } });
ok({});
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'prompts'), '0');
  return { dir, calls: () => fs.readFileSync(log, 'utf8'), prompts: () => Number(fs.readFileSync(path.join(dir, 'prompts'), 'utf8')) };
}

/** A git repository configured for issue-herd, cleaned up when the test ends. */
function repo(t, defaults = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-herd-pickup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.issue-herd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.issue-herd', 'config.json'), JSON.stringify({ tracker: 'linear', rules: [{ name: 'r', match: 'any:true' }], ...(defaults ? { defaults } : {}) }));
  return fs.realpathSync(dir);
}

/** `issue-herd smoke` in `dir`, with the fake herdr first on PATH. Returns { status, out }. */
function smoke(dir, herdr) {
  const r = spawnSync(process.execPath, [BIN, 'smoke'], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ISSUE_HERD_NO_UPDATE_CHECK: '1', PATH: `${herdr.dir}:${process.env.PATH}` },
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

test('a role reaches the herdr sidebar, the agent name and the run key', (t) => {
  // The whole pickup path with a role on it: what herdr is actually asked for is the thing you
  // read in the sidebar, so it is worth asserting against the real calls rather than a helper.
  const dir = repo(t, { role: 'review', model: 'opus', agentKind: 'claude' });
  const herdr = fakeHerdr(t, { mode: 'blocked-first', cwd: dir });
  const r = smoke(dir, herdr);
  assert.equal(r.status, 0, r.out);
  const key = /picking up (SMOKE-\d+\.review)/.exec(r.out)?.[1];
  assert.ok(key, `no role-scoped run key in the log:\n${r.out}`);
  assert.match(r.out, /role review/);
  // the sidebar label is "<issue key> <role> <title>"
  assert.match(herdr.calls(), new RegExp(`workspace create .*--label ${key.replace('.review', '')} review issue-herd smoke test`));
  // the agent is named for the run key, so the two roles on an issue are two agents
  assert.match(herdr.calls(), new RegExp(`agent start ${key.replace('.', '-').toLowerCase()} --kind claude`));
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
