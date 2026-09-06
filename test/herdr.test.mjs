import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Herdr, isNotFound } from '../src/herdr.mjs';

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
