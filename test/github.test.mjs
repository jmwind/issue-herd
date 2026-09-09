import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubTracker, issueNumber, priorityFromLabels, repoFromRemote } from '../src/trackers/github.mjs';
import { checkIssue } from '../src/tracker.mjs';
import { compile } from '../src/expr.mjs';

/** A fetch whose replies come from `route(url, init)` → { status?, json }. Records every call. */
function fakeFetch(route) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = route(call) ?? { json: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.json ?? {}), json: async () => r.json };
  };
  f.calls = calls;
  return f;
}

const node = {
  id: 'I_1', number: 7, title: 'Map crashes when zooming past level 12', body: 'Steps to reproduce…', url: 'https://github.com/jmwind/weawr/issues/7',
  state: 'OPEN', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z',
  labels: { nodes: [{ name: 'ai' }, { name: 'priority: high' }] },
  milestone: { number: 2, title: 'v1' },
  assignees: { nodes: [{ login: 'jmwind', name: 'Jean-Michel' }] },
  author: { login: 'alex', name: null },
  comments: { nodes: [{ body: 'me too', createdAt: '2026-09-02T00:00:00Z', author: { login: 'alex' } }] },
};
const page = (nodes, hasNextPage = false) => ({ json: { data: { repository: { issues: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c1' : null } } } } } });
const tracker = (route, options = {}) => new GitHubTracker('ghp_test', { options: { repo: 'jmwind/weawr', ...options }, fetchImpl: fakeFetch(route) });

test('normalizes a GitHub issue into the shared shape', () => {
  const t = tracker(() => null);
  const issue = t.normalize(node);
  checkIssue(issue);
  assert.equal(issue.id, '7');
  assert.equal(issue.identifier, 'GH-7');
  assert.equal(issue.ref, '#7');
  assert.equal(issue.priority, 2);
  assert.equal(issue.priorityLabel, 'High');
  assert.equal(issue.branchName, '7-map-crashes-when-zooming-past-level-12');
  assert.deepEqual(issue.labels, ['ai', 'priority: high']);
  assert.deepEqual(issue.project, { id: '2', name: 'v1' });
  assert.deepEqual(issue.team, { id: 'jmwind/weawr', key: 'weawr', name: 'jmwind/weawr' });
  assert.equal(issue.assignee.login, 'jmwind');
  assert.equal(issue.assignee.displayName, 'jmwind');
  assert.equal(issue.creator.name, 'alex');
  assert.deepEqual(issue.state, { id: 'open', name: 'open', type: 'unstarted' });
  assert.deepEqual(issue.comments, [{ body: 'me too', createdAt: '2026-09-02T00:00:00Z', author: 'alex' }]);
  assert.equal(t.normalize({ ...node, state: 'CLOSED', assignees: { nodes: [] }, milestone: null, labels: { nodes: [] } }).state.type, 'completed');
});

test('rules work on GitHub issues: labels, team, project, assignee:me by login', async () => {
  const t = tracker(({ body }) => (body?.query?.includes('viewer') ? { json: { data: { viewer: { login: 'jmwind', name: 'JM' } } } } : null));
  const issue = t.normalize(node);
  const ctx = { viewer: await t.me(), now: Date.parse('2026-09-05T00:00:00Z') };
  const m = (e) => compile(e).test(issue, ctx);
  assert.ok(m('label:ai and team:weawr and project:v1'));
  assert.ok(m('assignee:me'));
  assert.ok(m('assignee:@jmwind and creator:alex'));
  assert.ok(m('priority<=2 and state:open and not state:started'));
  assert.ok(m('key:GH-7 and age>3d'));
  assert.ok(!m('assignee:none'));
});

test('a custom prefix names the issues', () => {
  assert.equal(tracker(() => null, { prefix: 'LH' }).normalize(node).identifier, 'LH-7');
});

test('with several assignees the token\'s own account wins', async () => {
  // Otherwise skipIfAssignedToOthers would refuse an issue that is already assigned to you.
  const shared = { ...node, assignees: { nodes: [{ login: 'alex', name: 'Alex' }, { login: 'jmwind', name: 'JM' }] } };
  const t = tracker(() => ({ json: { data: { viewer: { login: 'jmwind', name: 'JM' } } } }));
  assert.equal(t.normalize(shared).assignee.login, 'alex', 'before me() there is nothing to prefer');
  await t.me();
  assert.equal(t.normalize(shared).assignee.login, 'jmwind');
  assert.equal(t.normalize({ ...node, assignees: { nodes: [] } }).assignee, null);
});

test('a repository cannot redirect the token to another host', async () => {
  // config.json is committed, so this value travels with whatever repo you run in. Verified end to
  // end: before this check, `me()` sent `Authorization: Bearer <real token>` to the named host.
  const make = (options) => () => new GitHubTracker('t', { options: { repo: 'o/r', ...options }, fetchImpl: fakeFetch(() => null) });
  assert.throws(make({ host: 'evil.example.com' }), /this machine trusts github\.com/);
  assert.throws(make({ host: 'evil.com/api/v3?' }), /this machine trusts github\.com/);
  await assert.rejects(GitHubTracker.login({ log() {}, open() {} }, { host: 'evil.example.com' }), /this machine trusts github\.com/);
  assert.equal(GitHubTracker.fallback({ host: 'evil.example.com' }), null, 'and borrows no token for it either');
  assert.doesNotThrow(make({ host: 'github.com' }), 'naming the default host is fine');
  // An enterprise host is opted into on the machine, by a variable a repo's .env cannot set.
  process.env.WEAWR_GITHUB_HOST = 'ghe.corp.com';
  try {
    const t = new GitHubTracker('t', { options: { repo: 'x/y', host: 'ghe.corp.com' }, fetchImpl: fakeFetch(() => null) });
    assert.equal(t.api, 'https://ghe.corp.com/api/v3');
    assert.equal(t.graphql, 'https://ghe.corp.com/api/graphql');
    assert.throws(make({ host: 'github.com' }), /this machine trusts ghe\.corp\.com/);
  } finally { delete process.env.WEAWR_GITHUB_HOST; }
});

test('config values that reach paths and branch names are validated', () => {
  const make = (options) => () => new GitHubTracker('t', { options: { repo: 'o/r', ...options }, fetchImpl: fakeFetch(() => null) });
  assert.throws(make({ prefix: '../..' }), /"prefix" must be letters and digits/);
  assert.throws(make({ prefix: 'a/b' }), /"prefix" must be letters and digits/);
  assert.doesNotThrow(make({ prefix: 'GH2' }));
  // A repo that cannot be trusted into a URL is treated as unknown, which check() then refuses.
  for (const repo of ['o/r?x=1', '../..', 'a/b/c', 'o r/x']) {
    assert.equal(new GitHubTracker('t', { options: { repo }, fetchImpl: fakeFetch(() => null) }).repo, null, repo);
  }
});

test('the token `gh` owns is marked borrowed, so login re-reads it instead of copying it', () => {
  // Asserted without needing `gh` to be logged in here: the shape is what stops `login` saving a
  // copy that goes stale, so it must hold on CI too.
  const fb = GitHubTracker.fallback({ host: 'github.com' });
  assert.ok(fb === null || (fb.kind === 'borrowed' && fb.source === 'gh auth token'), JSON.stringify(fb));
});

test('openIssues asks for open issues since a date and follows pages', async () => {
  const t = tracker(({ body }) => (body.variables.after ? page([{ ...node, number: 8 }]) : page([node], true)));
  const issues = await t.openIssues({ sinceIso: '2026-08-01T00:00:00Z' });
  assert.deepEqual(issues.map((i) => i.identifier), ['GH-7', 'GH-8']);
  const first = t.fetch.calls[0];
  assert.equal(first.url, 'https://api.github.com/graphql');
  assert.equal(first.headers.authorization, 'Bearer ghp_test');
  assert.equal(first.headers['user-agent'], 'weawr');
  assert.match(first.body.query, /states: OPEN/);
  assert.deepEqual(first.body.variables, { owner: 'jmwind', name: 'weawr', first: 100, after: null, since: '2026-08-01T00:00:00Z' });
  assert.equal(t.fetch.calls[1].body.variables.after, 'c1');
});

test('issueByKey accepts GH-7, #7 and 7', async () => {
  const t = tracker(({ body }) => ({ json: { data: { repository: { issue: body.variables.number === 7 ? node : null } } } }));
  for (const key of ['GH-7', '#7', '7']) assert.equal((await t.issueByKey(key)).identifier, 'GH-7');
  assert.equal(await t.issueByKey('GH-9'), null);
  assert.equal(await t.issueByKey('nope'), null);
  assert.equal(issueNumber('owner/repo#12'), 12);
});

test('writes go through REST by issue number', async () => {
  const seen = [];
  const t = tracker(({ method, url }) => {
    seen.push(`${method} ${url.replace('https://api.github.com/repos/jmwind/weawr', '')}`);
    if (method === 'GET' && url.endsWith('/labels/herdr')) return { status: 404, json: { message: 'Not Found' } };
    if (method === 'DELETE') return { status: 404, json: { message: 'Label does not exist' } };
    if (url.includes('/graphql')) return { json: { data: { viewer: { login: 'jmwind', name: 'JM' } } } };
    return { json: { id: 1, html_url: 'https://github.com/c/1' } };
  });
  const issue = t.normalize(node);
  assert.deepEqual(await t.comment(issue.id, 'hello'), { id: 1, url: 'https://github.com/c/1' });
  await t.addLabel(issue.id, 'herdr');          // label missing → created, then added
  await t.addLabel(issue.id, 'herdr');          // known now → no lookup
  await t.removeLabel(issue.id, 'herdr');       // 404 is fine
  await t.assign(issue, await t.me());
  assert.deepEqual(await t.setState(issue, 'closed'), { name: 'closed', type: 'completed' });
  assert.deepEqual(await t.setState(issue, 'open'), { name: 'open', type: 'unstarted' });
  assert.deepEqual(seen, [
    'POST /issues/7/comments',
    'GET /labels/herdr', 'POST /labels', 'POST /issues/7/labels',
    'POST /issues/7/labels',
    'DELETE /issues/7/labels/herdr',
    'POST https://api.github.com/graphql', 'POST /issues/7/assignees',
    'PATCH /issues/7', 'PATCH /issues/7',
  ]);
  const calls = t.fetch.calls;
  assert.deepEqual(calls[0].body, { body: 'hello' });
  assert.equal(calls[2].body.name, 'herdr');
  assert.deepEqual(calls[3].body, { labels: ['herdr'] });
  assert.deepEqual(calls[7].body, { assignees: ['jmwind'] });
  assert.deepEqual(calls[8].body, { state: 'closed' });
  assert.deepEqual(calls[9].body, { state: 'open' });
});

test('HTTP errors say what happened and, on 401, what to do', async () => {
  const t = tracker(() => ({ status: 401, json: { message: 'Bad credentials' } }));
  await assert.rejects(t.me(), /GitHub HTTP 401: Bad credentials — run `weawr login github`/);
});

test('a token borrowed from gh is re-read once on 401 rather than failing forever', async () => {
  // `gh` rotates its token; the watcher polls for days, so a captured copy goes stale.
  let calls = 0;
  const fetchImpl = fakeFetch(() => (++calls === 1 ? { status: 401, json: { message: 'Bad credentials' } } : { json: { data: { viewer: { login: 'jmwind', name: 'JM' } } } }));
  const t = new GitHubTracker({ kind: 'borrowed', token: 'stale' }, { options: { repo: 'o/r' }, fetchImpl });
  const orig = GitHubTracker.fallback;
  GitHubTracker.fallback = () => ({ kind: 'borrowed', token: 'fresh', source: 'gh auth token' });
  try {
    assert.equal((await t.me()).login, 'jmwind');
    assert.equal(fetchImpl.calls[1].headers.authorization, 'Bearer fresh');
  } finally { GitHubTracker.fallback = orig; }
});

test('an unchanged borrowed token is not retried in a loop', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, json: { message: 'Bad credentials' } }));
  const t = new GitHubTracker({ kind: 'borrowed', token: 'same' }, { options: { repo: 'o/r' }, fetchImpl });
  const orig = GitHubTracker.fallback;
  GitHubTracker.fallback = () => ({ kind: 'borrowed', token: 'same' });
  try {
    await assert.rejects(t.me(), /GitHub HTTP 401/);
    assert.equal(fetchImpl.calls.length, 1);
  } finally { GitHubTracker.fallback = orig; }
});

test('priority comes from labels when the repo uses them, most urgent wins', () => {
  assert.equal(priorityFromLabels(['bug', 'P0']), 1);
  assert.equal(priorityFromLabels(['priority-low']), 4);
  assert.equal(priorityFromLabels(['Priority: Medium']), 3);
  assert.equal(priorityFromLabels(['bug']), 0);
  // label order is the repository's, so an issue re-triaged from low to urgent without the old
  // label removed must still read as urgent, or a priority<=2 rule would never match it
  assert.equal(priorityFromLabels(['low', 'urgent']), 1);
  assert.equal(priorityFromLabels(['urgent', 'low']), 1);
});

test('two runs creating the claim label at once do not fight', async () => {
  // both see 404, both POST; the loser gets 422 already_exists, which is success, not a failure
  let posts = 0;
  const t = tracker(({ method, url }) => {
    if (method === 'GET' && url.includes('/labels/')) return { status: 404, json: { message: 'Not Found' } };
    if (method === 'POST' && (url.endsWith('/labels') && !url.includes('/issues/'))) return ++posts === 1 ? { json: { name: 'herdr' } } : { status: 422, json: { message: 'Validation Failed' } };
    return { json: {} };
  });
  await Promise.all([t.addLabel('7', 'herdr'), t.addLabel('8', 'herdr')]);
  assert.equal(posts, 1, 'the in-flight create is shared');
  const t2 = tracker(({ method, url }) => {
    if (method === 'GET' && url.includes('/labels/')) return { status: 404, json: { message: 'Not Found' } };
    if (method === 'POST' && (url.endsWith('/labels') && !url.includes('/issues/'))) return { status: 422, json: { message: 'Validation Failed' } };
    return { json: {} };
  });
  await assert.doesNotReject(t2.addLabel('7', 'herdr'));
});

test('a label lookup that fails for any other reason is not swallowed', async () => {
  const t = tracker(() => ({ status: 500, json: { message: 'Server Error' } }));
  await assert.rejects(t.addLabel('7', 'herdr'), /GitHub HTTP 500/);
  const t2 = tracker(({ method }) => (method === 'DELETE' ? { status: 500, json: { message: 'Server Error' } } : { json: {} }));
  await assert.rejects(t2.removeLabel('7', 'herdr'), /GitHub HTTP 500/, 'only 404 is tolerated on removal');
});

test('the repository comes from the origin remote in any of its spellings', () => {
  for (const url of ['git@github.com:jmwind/weawr.git', 'https://github.com/jmwind/weawr', 'https://github.com/jmwind/weawr.git/', 'ssh://git@github.com/jmwind/weawr.git', 'git://github.com/jmwind/weawr.git', 'https://user@github.com/jmwind/weawr']) {
    assert.equal(repoFromRemote(url), 'jmwind/weawr', url);
  }
  assert.equal(repoFromRemote('git@gitlab.com:x/y.git'), null);
  assert.equal(repoFromRemote('git@ghe.corp.com:x/y.git', 'ghe.corp.com'), 'x/y');
  assert.equal(repoFromRemote(''), null);
});

test('without a recognisable repository the tracker says how to name one', () => {
  const t = new GitHubTracker('t', { options: { cwd: '/', repo: null }, fetchImpl: fakeFetch(() => null) });
  assert.throws(() => t.check(), /"tracker": \{ "type": "github", "repo": "owner\/name" \}/);
});
