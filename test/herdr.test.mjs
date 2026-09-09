import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Herdr, agentPlacement, isBlocked, isNameTaken, isNotFound, isRunsWorkspace, workspaceOwner } from '../src/herdr.mjs';

/** A stand-in `herdr` that answers `agent get` the way the real one does when the agent is missing. */
function fakeHerdr(stderrJson, exitCode = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fake-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(stderrJson)}' >&2\nexit ${exitCode}\n`, { mode: 0o755 });
  return bin;
}

test('agentGet returns null for herdr\'s agent_not_found, the code it really sends', async () => {
  // Real output: {"error":{"code":"agent_not_found","message":"agent target dev-3304 not found"},"id":"cli:agent:get"}
  const bin = fakeHerdr({ error: { code: 'agent_not_found', message: 'agent target dev-3304 not found' }, id: 'cli:agent:get' });
  const h = new Herdr({ bin });
  assert.equal(await h.agentGet('dev-3304'), null);
});

test('agentGet still throws on other herdr errors', async () => {
  const bin = fakeHerdr({ error: { code: 'server_unavailable', message: 'no server' } });
  const h = new Herdr({ bin });
  await assert.rejects(() => h.agentGet('dev-3304'), /no server/);
});

test('isNotFound matches herdr\'s per-noun codes only', () => {
  assert.equal(isNotFound({ code: 'agent_not_found' }), true);
  assert.equal(isNotFound({ code: 'pane_not_found' }), true);
  assert.equal(isNotFound({ code: 'not_found' }), true);
  assert.equal(isNotFound({ code: 'agent_not_ready' }), false);
  assert.equal(isNotFound({}), false);
  assert.equal(isNotFound(null), false);
});

/**
 * A stand-in `herdr` where the agent is there until it is told to exit: `agent get` answers until
 * `agent prompt` has been called once, and after that it is `agent_not_found`, exactly as herdr
 * reports an agent whose process has gone.
 */
function fakeExitingHerdr({ exits = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-exit-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `d="${dir}"`,
    'if [ "$1 $2" = "agent get" ]; then',
    '  if [ -f "$d/exited" ]; then printf \'%s\' \'{"error":{"code":"agent_not_found","message":"gone"}}\' >&2; exit 1; fi',
    '  printf \'%s\' \'{"result":{"agent":{"agent_status":"idle"}}}\'; exit 0',
    'fi',
    'if [ "$1 $2" = "agent prompt" ]; then',
    `  ${exits ? 'echo "$4" > "$d/exited"' : 'echo "$4" > "$d/prompted"'}; printf '%s' '{"result":{}}'; exit 0`,
    'fi',
    "printf '%s' '{\"result\":{}}'",
  ].join('\n'), { mode: 0o755 });
  return { bin, dir };
}

test('stopAgent asks the agent to exit the way a person would, and waits for it to go', async () => {
  const { bin, dir } = fakeExitingHerdr();
  const h = new Herdr({ bin });
  assert.equal(await h.stopAgent('gh-22', { pollMs: 10, timeoutMs: 2000 }), 'exited');
  assert.equal(fs.readFileSync(path.join(dir, 'exited'), 'utf8').trim(), '/exit', 'Claude Code exits on /exit');
});

test('an agent that ignores /exit is reported, not waited on forever', async () => {
  // The workspace close that follows is the fallback, so this must return rather than hang.
  const { bin } = fakeExitingHerdr({ exits: false });
  const h = new Herdr({ bin });
  assert.equal(await h.stopAgent('gh-22', { pollMs: 10, timeoutMs: 100 }), 'is still running');
});

test('an agent that is already gone is not prompted at all', async () => {
  const bin = fakeHerdr({ error: { code: 'agent_not_found', message: 'agent target gh-22 not found' } });
  const h = new Herdr({ bin });
  assert.equal(await h.stopAgent('gh-22', { pollMs: 10, timeoutMs: 100 }), 'was already gone');
});

test('prompt carries herdr\'s agent_blocked through, so a refused brief can be told apart', async () => {
  // Real output when Claude Code is sitting on its trust dialog: herdr rejects the prompt before
  // sending any input, which is why the brief has to be kept and delivered again later.
  const bin = fakeHerdr({ error: { code: 'agent_blocked', message: 'agent gh-19 is blocked and requires interactive input' }, id: 'cli:agent:prompt' });
  const h = new Herdr({ bin });
  const err = await h.prompt('gh-19', 'read your brief').then(() => null, (e) => e);
  assert.equal(isBlocked(err), true);
  assert.equal(isNameTaken(err), false);
});

test('startAgent reports a name already in use as agent_name_taken', async () => {
  // Real output: starting a second agent called gh-19 while the first one is still up.
  const bin = fakeHerdr({ error: { code: 'agent_name_taken', message: 'agent name gh-19 is already used; candidates: pane_id=w1C:p1' }, id: 'cli:agent:start' });
  const h = new Herdr({ bin });
  const err = await h.startAgent({ name: 'gh-19', paneId: 'w1D:p1' }).then(() => null, (e) => e);
  assert.equal(isNameTaken(err), true);
  assert.equal(isBlocked(err), false);
  assert.equal(isNotFound(err), false);
});

test('agentPlacement reads an existing agent as somewhere to work', () => {
  // The fields `agent get` really returns; foreground_cwd is where the agent moved to, cwd where it started.
  const agent = { name: 'gh-19', agent_status: 'idle', pane_id: 'w1C:p1', tab_id: 'w1C:t1', workspace_id: 'w1C', cwd: '/repo', foreground_cwd: '/repo/.weawr/worktrees/gh-19' };
  assert.deepEqual(agentPlacement(agent), { workspaceId: 'w1C', tabId: 'w1C:t1', paneId: 'w1C:p1', cwd: '/repo/.weawr/worktrees/gh-19' });
  assert.equal(agentPlacement({ cwd: '/repo' }).cwd, '/repo');
  assert.equal(agentPlacement(null).cwd, null);
});

/**
 * A stand-in `herdr` whose `agent read` answers the way the real one does for an agent that is
 * working: `recent-unwrapped` is refused with `agent_not_idle` and only `visible` prints anything.
 * Every call is logged so the test can see which sources were asked for.
 */
function fakeBusyReadHerdr({ idle = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-read-'));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `d="${dir}"`,
    'echo "$*" >> "$d/calls"',
    'if [ "$1 $2" = "agent read" ]; then',
    '  src=""; while [ $# -gt 0 ]; do if [ "$1" = "--source" ]; then src="$2"; fi; shift; done',
    `  if [ "$src" = "recent-unwrapped" ] && [ "${idle ? 'yes' : 'no'}" = "no" ]; then`,
    '    printf \'%s\' \'{"error":{"code":"agent_not_idle","message":"cannot read 100 lines while gh-40-impl is working: its alternate-screen history can only be captured by scrolling while idle. Wait and retry, or use --source visible"},"id":"cli:agent:read"}\' >&2; exit 1',
    '  fi',
    '  printf \'%s\\n\' "lines from $src"; exit 0',
    'fi',
    "printf '%s' '{\"result\":{}}'",
  ].join('\n'), { mode: 0o755 });
  return { bin, dir };
}

test('readAgent falls back to the visible screen while the agent is working (GH-41)', async () => {
  // Real refusal: {"error":{"code":"agent_not_idle","message":"cannot read 100 lines while gh-40-impl is working: ..."},"id":"cli:agent:read"}
  const { bin, dir } = fakeBusyReadHerdr();
  const h = new Herdr({ bin });
  assert.equal(await h.readAgent('gh-40-impl', 100), 'lines from visible\n');
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, [
    'agent read gh-40-impl --source recent-unwrapped --lines 100 --format text',
    'agent read gh-40-impl --source visible --lines 100 --format text',
  ]);
});

test('readAgent keeps the fuller history when the agent is idle', async () => {
  const { bin, dir } = fakeBusyReadHerdr({ idle: true });
  const h = new Herdr({ bin });
  assert.equal(await h.readAgent('gh-40-impl', 100), 'lines from recent-unwrapped\n');
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length, 1);
});

test('readAgent reports other herdr errors by their message, not the raw JSON', async () => {
  const bin = fakeHerdr({ error: { code: 'agent_not_found', message: 'agent target gh-40-impl not found' }, id: 'cli:agent:read' });
  const h = new Herdr({ bin });
  await assert.rejects(() => h.readAgent('gh-40-impl'), (e) => e.code === 'agent_not_found' && /agent target gh-40-impl not found/.test(e.message) && !/\{"error"/.test(e.message));
});

/**
 * A stand-in `herdr` scripted per subcommand: `script[name]` is a shell snippet for `agent wait`,
 * `agent get`, `workspace get`, `workspace close`; anything else answers `{"result":{}}`. `$d` is
 * a scratch directory the snippets can leave markers in.
 */
function scriptedHerdr(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-script-'));
  const bin = path.join(dir, 'herdr');
  const lines = ['#!/bin/sh', `d="${dir}"`];
  for (const [cmd, body] of Object.entries(script)) lines.push(`if [ "$1 $2" = "${cmd}" ]; then`, body, 'exit 0', 'fi');
  lines.push("printf '%s' '{\"result\":{}}'");
  fs.writeFileSync(bin, lines.join('\n') + '\n', { mode: 0o755 });
  return { bin, dir };
}
const err = (code, message) => `printf '%s' '${JSON.stringify({ error: { code, message } })}' >&2; exit 1`;

test('waitAgent: herdr 0.9 ends a wait on an agent that exited with agent_not_running, which is "gone" once the agent really is', async () => {
  // Real output: {"error":{"code":"agent_not_running","message":"..."},"id":"cli:agent:wait"} — the
  // code issue-herd logged as "unexpected wait result" on GH-69 and slept 30s on, instead of
  // reading the agent as gone.
  const { bin } = scriptedHerdr({ 'agent wait': err('agent_not_running', 'agent gh-69-impl is not running'), 'agent get': err('agent_not_found', 'agent target gh-69-impl not found') });
  const h = new Herdr({ bin });
  assert.equal(await h.waitAgent('gh-69-impl', { timeoutMs: 5000 }), 'gone');
});

test('waitAgent: agent_not_running with the agent still there (its pane moved) waits again, and a timeout is still a timeout', async () => {
  const { bin, dir } = scriptedHerdr({
    'agent wait': `if [ -f "$d/asked" ]; then printf '%s' '{"result":{"agent":{"agent_status":"idle"}}}'; exit 0; fi; touch "$d/asked"; ${err('agent_not_running', 'moved')}`,
    'agent get': `printf '%s' '{"result":{"agent":{"name":"gh-1","agent_status":"working","workspace_id":"w2"}}}'`,
  });
  const h = new Herdr({ bin });
  assert.equal(await h.waitAgent('gh-1', { timeoutMs: 5000 }), 'idle', 'the second wait answers');
  fs.rmSync(path.join(dir, 'asked'));
  assert.equal(await h.waitAgent('gh-1', { timeoutMs: 1500 }), 'timeout', 'no time left for a second wait is a timeout, not a spin');
  assert.equal(await h.waitAgent('gh-1', { until: ['working'], timeoutMs: 100 }), 'timeout');
});

test('waitAgent: a lookup herdr cannot answer after agent_not_running is not an exit — it is asked again, and runs out as a timeout', async () => {
  // A socket error or a timeout on `agent get` says nothing about the agent; 'gone' would have the
  // supervisor write a live run off and stop watching for its result.
  const flaky = scriptedHerdr({
    'agent wait': `if [ -f "$d/looked" ]; then printf '%s' '{"result":{"agent":{"agent_status":"idle"}}}'; exit 0; fi; ${err('agent_not_running', 'moved')}`,
    'agent get': `if [ -f "$d/failed" ]; then touch "$d/looked"; printf '%s' '{"result":{"agent":{"name":"gh-1","agent_status":"working"}}}'; exit 0; fi; touch "$d/failed"; echo 'connect ECONNREFUSED' >&2; exit 1`,
  });
  assert.equal(await new Herdr({ bin: flaky.bin }).waitAgent('gh-1', { timeoutMs: 8000 }), 'idle', 'one failed lookup, then the agent answers and the wait carries on');
  const down = scriptedHerdr({ 'agent wait': err('agent_not_running', 'moved'), 'agent get': "echo 'connect ECONNREFUSED' >&2; exit 1" });
  assert.equal(await new Herdr({ bin: down.bin }).waitAgent('gh-1', { timeoutMs: 2500 }), 'timeout', 'herdr not answering runs the wait out; it never becomes gone');
  assert.match(await new Herdr({ bin: down.bin }).waitAgent('gh-1'), /^error:/, 'with no deadline the failure is the caller\'s to retry on');
});

test('waitAgent still reads the codes it always did', async () => {
  const h1 = new Herdr({ bin: scriptedHerdr({ 'agent wait': err('agent_not_found', 'gone') }).bin });
  assert.equal(await h1.waitAgent('x', { timeoutMs: 5000 }), 'gone');
  const h2 = new Herdr({ bin: scriptedHerdr({ 'agent wait': err('timeout', 'timed out waiting for agent status') }).bin });
  assert.equal(await h2.waitAgent('x', { timeoutMs: 5000 }), 'timeout');
  const h3 = new Herdr({ bin: scriptedHerdr({ 'agent wait': `printf '%s' '{"result":{"agent":{"agent_status":"blocked"}}}'` }).bin });
  assert.equal(await h3.waitAgent('x', { timeoutMs: 5000 }), 'blocked');
});

test('isRunsWorkspace: exactly the label the run gave it, on this repository; a head, a checkout, another repository, or nothing is no', () => {
  const owner = { label: 'GH-7 impl Fix the thing', repo: '/home/me/a', agentName: 'gh-7-impl' };
  const onA = { checkout_path: '/home/me/a/.issue-herd/worktrees/gh-7-impl', is_linked_worktree: true, repo_root: '/home/me/a' };
  const onB = { ...onA, checkout_path: '/home/me/b/.issue-herd/worktrees/gh-7-impl', repo_root: '/home/me/b' };
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onA }, owner), true);
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: { ...onA, repo_root: '/home/me/a/' } }, owner), true, 'repository paths are compared resolved');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Fix the thing' }, owner), true, 'a workspace herdr reports no repository for can only be matched by name');
  // Issue keys and roles are not unique across repositories: repo B's GH-7 impl is not ours.
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onB }, owner), false, 'the same label on another repository');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Repair billing export', worktree: onB }, owner), false);
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Fix the thing, retitled', worktree: onA }, owner), false, 'the head of the label is not the label');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 impl Fix the thing', worktree: onA }, { label: 'GH-7 Fix the thing', repo: '/home/me/a' }), false, 'an unroled GH-7 run is not GH-7 impl');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-7 review Fix the thing', worktree: onA }, owner), false, 'another role on the same issue is another run');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'GH-69 impl Rename project to weawr', worktree: onA }, owner), false);
  // The worktree outlives the workspace: a person reopening it in a workspace of their own, which
  // inherits the run's old id after a restart, must not be closed by the run's clean-up.
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'Personal inspection', worktree: onA }, owner), false, 'a checkout is no evidence');
  // The run's own agent standing in it, on this repository.
  const agent = { name: 'gh-7-impl', workspace_id: 'w1' };
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'renamed by hand', worktree: onA }, owner, agent), true);
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'renamed by hand', worktree: onB }, owner, agent), false, 'repo B\'s gh-7-impl, started once ours had exited, is not ours');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'renamed by hand', worktree: onA }, owner, { name: 'gh-7-review', workspace_id: 'w1' }), false, 'another agent');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'renamed by hand', worktree: onA }, owner, { name: 'gh-7-impl', workspace_id: 'w2' }), false, 'our agent, elsewhere');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1', label: 'x' }, {}), false, 'a run that recorded nothing cannot claim anything');
  assert.equal(isRunsWorkspace({ workspace_id: 'w1' }, owner), false, 'no label, no claim');
  assert.equal(isRunsWorkspace(null, owner), false);
  assert.equal(isRunsWorkspace(undefined), false);
});

test('workspaceOwner: what a run recorded, or the label it must have been given, and the repository it is in', () => {
  assert.deepEqual(workspaceOwner({ workspaceLabel: 'GH-7 impl Fix', worktreePath: '/tmp/wt', agentName: 'gh-7-impl', issueKey: 'GH-7', role: 'impl', title: 'Fix the thing' }, '/home/me/a'), { label: 'GH-7 impl Fix', repo: '/home/me/a', agentName: 'gh-7-impl' });
  assert.deepEqual(workspaceOwner({ issueKey: 'GH-7', role: 'impl', title: 'Fix the thing', agentName: 'gh-7-impl' }), { label: 'GH-7 impl Fix the thing', repo: null, agentName: 'gh-7-impl' });
  assert.deepEqual(workspaceOwner({ issueKey: 'GH-8', title: 'Old one' }), { label: 'GH-8 Old one', repo: null, agentName: null });
  assert.deepEqual(workspaceOwner(null), {});
});

test('closeWorkspaceOf closes the run\'s own workspace and leaves a stranger under the same id alone', async () => {
  const ws = (label, root = '/home/me/issue-herd') => `printf '%s' '{"result":{"type":"workspace_info","workspace":{"workspace_id":"w3J","label":"${label}","worktree":{"checkout_path":"${root}/.issue-herd/worktrees/gh-69-impl","is_linked_worktree":true,"repo_root":"${root}"}}}}'`;
  const A = '/home/me/issue-herd';
  const close = 'touch "$d/closed"; printf \'%s\' \'{"result":{}}\'';
  // Real story: GH-66's usability run had w3J; herdr was restarted for 0.9.0, GH-69 got w3J, and
  // Mark done on GH-66 closed it. The workspace under w3J is GH-69's by label and by worktree.
  const s1 = scriptedHerdr({ 'workspace get': ws('GH-69 impl Rename project to weawr'), 'workspace close': close, 'agent get': err('agent_not_found', 'gone') });
  assert.equal(await new Herdr({ bin: s1.bin }).closeWorkspaceOf('w3J', { label: 'GH-66 usability Close herdr workspaces on mark', repo: A, agentName: 'gh-66-usability' }), 'was reused by herdr for "GH-69 impl Rename project to weawr"');
  assert.equal(fs.existsSync(path.join(s1.dir, 'closed')), false, 'not closed');
  // Another repository's GH-69 impl, under the same recycled id: same key, same role, even the
  // same title would not make it ours — herdr says which repository the workspace is on.
  const sB = scriptedHerdr({ 'workspace get': ws('GH-69 impl Rename project to weawr', '/home/me/other-repo'), 'workspace close': close, 'agent get': `printf '%s' '{"result":{"agent":{"name":"gh-69-impl","workspace_id":"w3J"}}}'` });
  assert.equal(await new Herdr({ bin: sB.bin }).closeWorkspaceOf('w3J', { label: 'GH-69 impl Rename project to weawr', repo: A, agentName: 'gh-69-impl' }), 'was reused by herdr for "GH-69 impl Rename project to weawr"');
  assert.equal(fs.existsSync(path.join(sB.dir, 'closed')), false, 'not ours by label, and not by the agent of the same name standing in it either');
  const sU = scriptedHerdr({ 'workspace get': ws('GH-69 impl Rename project to weawr'), 'workspace close': close, 'agent get': err('agent_not_found', 'gone') });
  assert.equal(await new Herdr({ bin: sU.bin }).closeWorkspaceOf('w3J', { label: 'GH-69 Rename project to weawr', repo: A, agentName: 'gh-69' }), 'was reused by herdr for "GH-69 impl Rename project to weawr"', 'an unroled GH-69 run is not GH-69 impl');
  assert.equal(fs.existsSync(path.join(sU.dir, 'closed')), false);
  // A person who reopened GH-69's worktree in a workspace of their own, under the same recycled
  // id: the checkout is GH-69's, the workspace is not.
  const s0 = scriptedHerdr({ 'workspace get': ws('Personal inspection'), 'workspace close': close, 'agent get': err('agent_not_found', 'gone') });
  assert.equal(await new Herdr({ bin: s0.bin }).closeWorkspaceOf('w3J', { label: 'GH-69 impl Rename project to weawr', repo: A, agentName: 'gh-69-impl' }), 'was reused by herdr for "Personal inspection"');
  assert.equal(fs.existsSync(path.join(s0.dir, 'closed')), false, 'somebody\'s workspace on our old checkout is not ours');
  assert.equal(await new Herdr({ bin: s1.bin }).closeWorkspaceOf('w3J', { label: 'GH-69 impl Rename project to weawr', repo: A, agentName: 'gh-69-impl' }), 'closed');
  assert.equal(fs.existsSync(path.join(s1.dir, 'closed')), true, 'the owner\'s close goes through');
  // The run's agent standing in the workspace is enough on its own.
  const s2 = scriptedHerdr({ 'workspace get': ws('renamed by hand'), 'workspace close': close, 'agent get': `printf '%s' '{"result":{"agent":{"name":"gh-69-impl","workspace_id":"w3J"}}}'` });
  assert.equal(await new Herdr({ bin: s2.bin }).closeWorkspaceOf('w3J', { label: 'GH-69 impl Something else', repo: A, agentName: 'gh-69-impl' }), 'closed');
  assert.equal(fs.existsSync(path.join(s2.dir, 'closed')), true);
  // Gone already: what we wanted.
  const s3 = scriptedHerdr({ 'workspace get': err('workspace_not_found', 'workspace w3J not found') });
  assert.equal(await new Herdr({ bin: s3.bin }).closeWorkspaceOf('w3J', { label: 'x' }), 'was already closed');
  // A close herdr refuses is the caller's to report.
  const s4 = scriptedHerdr({ 'workspace get': ws('GH-69 impl Rename project to weawr'), 'workspace close': err('workspace_busy', 'nope') });
  await assert.rejects(new Herdr({ bin: s4.bin }).closeWorkspaceOf('w3J', { label: 'GH-69 impl Rename project to weawr' }), /nope/);
});
