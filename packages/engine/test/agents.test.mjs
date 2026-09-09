// One rule field, several agents' dialects. The reason this file exists: `"agentKind": "codex"`
// used to start codex and then hand it `--name` and `--permission-mode`, which are Claude Code's
// flags, so the pane died at the prompt and the run was lost before the brief was ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentArgv, describeAgent, exitCommandFor, profileFor, TRANSLATED_KINDS } from '../dist/agents.mjs';

const wanted = { name: 'GH-7.review', permissionMode: 'auto', model: 'a-model', effort: 'high' };

test('the same four wishes become each agent\'s own flags', () => {
  assert.deepEqual(agentArgv({ kind: 'claude', ...wanted }),
    ['--name', 'GH-7.review', '--permission-mode', 'auto', '--model', 'a-model', '--effort', 'high']);
  // codex has no session-name flag, spells effort as a TOML config override, and says "unattended"
  // with automatic approval rather than a permission mode.
  assert.deepEqual(agentArgv({ kind: 'codex', ...wanted }),
    ['--model', 'a-model', '-c', 'model_reasoning_effort="high"', '--approve-for-me']);
});

test('an agent with no profile still runs, on the one flag they all share', () => {
  assert.deepEqual(agentArgv({ kind: 'gemini', ...wanted }), ['--model', 'a-model']);
  assert.deepEqual(agentArgv({ kind: 'grok' }), []);
  assert.deepEqual(TRANSLATED_KINDS, ['claude', 'codex']);
});

test('an unattended run is never given an agent with no boundary left', () => {
  // Claude's "auto" maps to codex's widest *sandboxed* setting, not to
  // --dangerously-bypass-approvals-and-sandbox. Turning a sandbox off has to be typed out by a
  // person in agentArgs; it is not something a permission mode quietly means.
  const args = agentArgv({ kind: 'codex', permissionMode: 'auto' }).join(' ');
  // --approve-for-me *is* the workspace-write sandbox, and codex refuses --sandbox next to it.
  assert.match(args, /--approve-for-me/);
  assert.doesNotMatch(args, /--sandbox/);
  assert.doesNotMatch(args, /dangerously/);
  // an interactive mode asks for no automatic approval at all
  assert.deepEqual(agentArgv({ kind: 'codex', permissionMode: 'plan', model: 'm' }), ['--model', 'm']);
});

test('a rule\'s own flags go last, so they can override anything the profile chose', () => {
  const args = agentArgv({ kind: 'codex', permissionMode: 'auto', extra: ['--dangerously-bypass-approvals-and-sandbox'] });
  assert.equal(args.at(-1), '--dangerously-bypass-approvals-and-sandbox');
  assert.deepEqual(agentArgv({ kind: 'claude', model: 'opus', extra: ['--fallback-model', 'sonnet'] }),
    ['--model', 'opus', '--fallback-model', 'sonnet']);
});

test('nothing asked for means nothing passed', () => {
  assert.deepEqual(agentArgv(), []);
  assert.deepEqual(agentArgv({ kind: 'claude' }), []);
});

test('each agent is asked to leave in its own words', () => {
  assert.equal(exitCommandFor('claude'), '/exit');
  assert.equal(exitCommandFor('codex'), '/quit');
  assert.equal(exitCommandFor('something-new'), '/exit');
});

test('a kind that is an Object property is not a profile', () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.deepEqual(agentArgv({ kind: bad, name: 'x', permissionMode: 'auto', model: 'm' }), ['--model', 'm'], bad);
    assert.equal(typeof profileFor(bad).argv, 'function', bad);
  }
});

test('the startup line says what a rule runs, and stays quiet when it is the default', () => {
  assert.equal(describeAgent({}), 'claude');
  assert.equal(describeAgent({ agentKind: 'codex', model: 'gpt-5-codex', effort: 'high' }), 'codex gpt-5-codex effort high');
});
