import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COORDINATOR, agentOf, coordinator, roleByline, table } from '../dist/comments.js';

test('a facts table leaves empty rows out, escapes pipes, folds line breaks, and is a markdown table', () => {
  const t = table([['Role', '`review`'], ['PR', null], ['Notes', 'a | b\nc'], ['Empty', '  ']]);
  assert.equal(t, '| | |\n|---|---|\n| **Role** | `review` |\n| **Notes** | a \\| b<br>c |');
  assert.equal(table([['x', null]]), '');
});

test('every voice is named: a role signs as weawr with its role, the coordinator as Weawr Coordinator, icon first', () => {
  assert.equal(roleByline('review'), '**weawr** as `review`');
  assert.equal(roleByline(null), '**weawr**');
  assert.equal(coordinator('✋ the agent is waiting'), `✋ ${COORDINATOR} — the agent is waiting`);
  assert.equal(coordinator('merged it'), `${COORDINATOR} — merged it`);
  assert.equal(agentOf({ name: 'tech-lead', agentKind: 'codex', model: 'gpt-6-astra', effort: 'high' }), 'rule `tech-lead` · codex `gpt-6-astra` (effort high)');
  assert.equal(agentOf({ name: 'r' }), 'rule `r` · claude');
});
