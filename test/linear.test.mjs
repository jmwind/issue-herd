import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearClient } from '../src/linear.mjs';

/** A fake Linear that has no labels until one is created. Records every mutation. */
function fakeLinear({ labels = [] } = {}) {
  const calls = [];
  const fetchImpl = async (_url, { body }) => {
    const { query, variables } = JSON.parse(body);
    calls.push({ query, variables });
    let data;
    if (query.includes('issueLabels(')) {
      data = { issueLabels: { nodes: labels.filter((l) => l.name.toLowerCase() === variables.name.toLowerCase()) } };
    } else if (query.includes('issueLabelCreate(')) {
      const created = { id: `lbl-${labels.length + 1}`, name: variables.input.name, team: null };
      labels.push(created);
      data = { issueLabelCreate: { success: true, issueLabel: created } };
    } else if (query.includes('issueAddLabel(') || query.includes('issueRemoveLabel(')) {
      data = { [query.includes('Add') ? 'issueAddLabel' : 'issueRemoveLabel']: { success: true } };
    } else {
      throw new Error(`unexpected query ${query}`);
    }
    return { ok: true, json: async () => ({ data }) };
  };
  return { client: new LinearClient('lin_api_test', { fetchImpl }), calls, labels };
}

test('addLabel creates a missing claim label instead of refusing', async () => {
  const { client, calls, labels } = fakeLinear();
  await client.addLabel('issue-1', 'herdr-jml-mbp');
  assert.deepEqual(labels.map((l) => l.name), ['herdr-jml-mbp']);
  const add = calls.find((c) => c.query.includes('issueAddLabel('));
  assert.equal(add.variables.labelId, 'lbl-1');
  // created as a workspace label: no teamId in the input
  const create = calls.find((c) => c.query.includes('issueLabelCreate('));
  assert.deepEqual(create.variables.input, { name: 'herdr-jml-mbp' });
});

test('an existing label is reused, case-insensitively, and only looked up once', async () => {
  const { client, calls, labels } = fakeLinear({ labels: [{ id: 'lbl-x', name: 'Herdr', team: null }] });
  await client.addLabel('issue-1', 'herdr');
  await client.addLabel('issue-2', 'herdr');
  assert.equal(labels.length, 1);
  assert.equal(calls.filter((c) => c.query.includes('issueLabels(')).length, 1);
  assert.equal(calls.filter((c) => c.query.includes('issueLabelCreate(')).length, 0);
  assert.ok(calls.filter((c) => c.query.includes('issueAddLabel(')).every((c) => c.variables.labelId === 'lbl-x'));
});

test('removeLabel of a label Linear does not have is a no-op, not a create', async () => {
  const { client, calls, labels } = fakeLinear();
  await client.removeLabel('issue-1', 'herdr');
  assert.equal(labels.length, 0);
  assert.equal(calls.filter((c) => c.query.includes('issueRemoveLabel(')).length, 0);
});
