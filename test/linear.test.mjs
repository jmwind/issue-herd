import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearTracker, normalizeIssue } from '../src/trackers/linear.mjs';
import { checkIssue } from '../src/tracker.mjs';

function fakeFetch(route) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers || {}, body: init.body, json: null };
    try { call.json = JSON.parse(init.body); } catch { /* form-encoded */ }
    calls.push(call);
    const r = route(call) ?? { json: { data: {} } };
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.json), json: async () => r.json };
  };
  f.calls = calls;
  return f;
}

const node = {
  id: 'uuid-1', identifier: 'DEV-12', title: 'Crash on zoom', description: null, url: 'https://linear.app/x/issue/DEV-12', priority: 2, priorityLabel: 'High',
  estimate: 3, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z', branchName: 'jml/dev-12-crash-on-zoom',
  labels: { nodes: [{ name: 'ai' }] }, project: { id: 'p', name: 'GustKit' }, team: { id: 't', key: 'DEV', name: 'Development' },
  assignee: { id: 'u1', name: 'JM', displayName: 'jml', email: 'jml@example.com' }, creator: null,
  state: { id: 's', name: 'Todo', type: 'unstarted' }, cycle: { id: 'c', number: 3, isActive: true },
  comments: { nodes: [{ body: 'hi', createdAt: '2026-09-02T00:00:00Z', user: { name: 'Alex', displayName: 'alex' } }] },
};

test('normalizes a Linear issue into the shared shape', () => {
  const issue = normalizeIssue(node);
  checkIssue(issue);
  assert.equal(issue.ref, 'DEV-12');
  assert.equal(issue.description, '');
  assert.equal(issue.branchName, 'jml/dev-12-crash-on-zoom');
  assert.equal(issue.assignee.login, null);
  assert.deepEqual(issue.comments, [{ body: 'hi', createdAt: '2026-09-02T00:00:00Z', author: 'alex' }]);
  assert.equal(normalizeIssue({ ...node, branchName: null }).branchName, 'dev-12-crash-on-zoom');
});

test('a personal API key goes raw in the header; an OAuth token as Bearer', () => {
  assert.equal(new LinearTracker('lin_api_abc').authHeader(), 'lin_api_abc');
  assert.equal(new LinearTracker({ token: 'lin_oauth_abc' }).authHeader(), 'Bearer lin_oauth_abc');
  assert.equal(new LinearTracker({ kind: 'oauth', token: 'xyz' }).authHeader(), 'Bearer xyz');
});

test('an expiring OAuth token is refreshed first and the new one handed back to be saved', async () => {
  const fetchImpl = fakeFetch(({ url }) => (url.endsWith('/oauth/token')
    ? { json: { access_token: 'new', refresh_token: 'r2', expires_in: 86400 } }
    : { json: { data: { viewer: { id: 'u1', name: 'JM', displayName: 'jml', email: 'jml@example.com' } } } }));
  const saved = [];
  const t = new LinearTracker({ kind: 'oauth', token: 'old', refreshToken: 'r1', expiresAt: Date.now() + 10_000, clientId: 'cid' }, { fetchImpl, onCredential: (c) => saved.push({ ...c }) });
  const me = await t.me();
  assert.equal(me.email, 'jml@example.com');
  assert.equal(fetchImpl.calls[0].url, 'https://api.linear.app/oauth/token');
  assert.equal(fetchImpl.calls[0].body, 'grant_type=refresh_token&refresh_token=r1&client_id=cid');
  assert.equal(fetchImpl.calls[1].headers.Authorization, 'Bearer new');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].refreshToken, 'r2');
  assert.ok(saved[0].expiresAt > Date.now() + 80_000e3);
});

test('a 401 with a refresh token in hand refreshes once and retries', async () => {
  let first = true;
  const fetchImpl = fakeFetch(({ url }) => {
    if (url.endsWith('/oauth/token')) return { json: { access_token: 'new', expires_in: 100 } };
    if (first) { first = false; return { status: 401, json: { errors: [{ message: 'expired' }] } }; }
    return { json: { data: { viewer: { id: 'u1' } } } };
  });
  const t = new LinearTracker({ kind: 'oauth', token: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600e3 }, { fetchImpl });
  assert.equal((await t.me()).id, 'u1');
  assert.deepEqual(fetchImpl.calls.map((c) => c.url.split('/').pop()), ['graphql', 'token', 'graphql']);
});

test('a plain 401 on an API key says where the key comes from', async () => {
  const t = new LinearTracker('lin_api_bad', { fetchImpl: fakeFetch(() => ({ status: 401, json: { errors: [{ message: 'Authentication required' }] } })) });
  await assert.rejects(t.me(), /Linear HTTP 401: Authentication required — run `issue-herd login linear`/);
});

test('concurrent calls share one refresh, so a rotating refresh token is spent once', async () => {
  // the watcher polls while several supervisors comment; each would otherwise spend the same
  // refresh token, and a provider that rotates it rejects all but the first.
  let refreshes = 0;
  const fetchImpl = fakeFetch(({ url }) => {
    if (url.endsWith('/oauth/token')) {
      refreshes++;
      if (refreshes > 1) return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: 'new', refresh_token: 'r2', expires_in: 86400 } };
    }
    return { json: { data: { viewer: { id: 'u1' } } } };
  });
  const saved = [];
  const t = new LinearTracker({ kind: 'oauth', token: 'old', refreshToken: 'r1', expiresAt: Date.now() + 10_000, clientId: 'cid' }, { fetchImpl, onCredential: (c) => saved.push({ ...c }) });
  await Promise.all([t.gql('{a}'), t.gql('{b}'), t.gql('{c}')]);
  assert.equal(refreshes, 1);
  assert.equal(saved.length, 1);
  assert.equal(t.cred.refreshToken, 'r2');
});

test('assignees carries the one assignee Linear allows', () => {
  const issue = normalizeIssue(node);
  assert.equal(issue.assignees.length, 1);
  assert.equal(issue.assignees[0].id, issue.assignee.id);
  assert.deepEqual(normalizeIssue({ ...node, assignee: null }).assignees, []);
});

test('the newest comments are fetched, because the claim marker is the newest comment', async () => {
  // `first: 25` returned the OLDEST 25, so on a thread longer than that the pickup guard could not
  // see its own marker and a second machine would take the issue.
  const fetchImpl = fakeFetch(() => ({ json: { data: { issue: node } } }));
  await new LinearTracker('lin_api_x', { fetchImpl }).issueByKey('DEV-12');
  assert.match(fetchImpl.calls[0].json.query, /comments\(last: 25\)/);
});

test('assign takes the user me() returned', async () => {
  const fetchImpl = fakeFetch(() => ({ json: { data: { issueUpdate: { success: true } } } }));
  await new LinearTracker('lin_api_x', { fetchImpl }).assign({ id: 'uuid-1' }, { id: 'u1', email: 'x' });
  assert.deepEqual(fetchImpl.calls[0].json.variables, { id: 'uuid-1', input: { assigneeId: 'u1' } });
});
