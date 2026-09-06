import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Herdr, agentPlacement, isBlocked, isNameTaken, isNotFound } from '../src/herdr.mjs';

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
  const agent = { name: 'gh-19', agent_status: 'idle', pane_id: 'w1C:p1', tab_id: 'w1C:t1', workspace_id: 'w1C', cwd: '/repo', foreground_cwd: '/repo/.issue-herd/worktrees/gh-19' };
  assert.deepEqual(agentPlacement(agent), { workspaceId: 'w1C', tabId: 'w1C:t1', paneId: 'w1C:p1', cwd: '/repo/.issue-herd/worktrees/gh-19' });
  assert.equal(agentPlacement({ cwd: '/repo' }).cwd, '/repo');
  assert.equal(agentPlacement(null).cwd, null);
});
