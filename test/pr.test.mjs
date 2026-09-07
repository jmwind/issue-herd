import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, parsePrUrl, prForBranch, prState, stateOf, watchesMerge } from '../src/pr.mjs';

/** A fetch that answers one GitHub payload and records what it was asked. */
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init?.headers || {} });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  f.calls = calls;
  return f;
}

test('a pull request URL is read as host, owner, repo and number', () => {
  assert.deepEqual(parsePrUrl('https://github.com/jmwind/issue-herd/pull/23'), { host: 'github.com', owner: 'jmwind', repo: 'issue-herd', number: 23 });
  assert.deepEqual(parsePrUrl('https://ghe.corp.com/team/app/pull/7/files'), { host: 'ghe.corp.com', owner: 'team', repo: 'app', number: 7 });
});

test('anything that is not a pull request URL is not one', () => {
  // result.json is written by the agent, so this is the guard against waiting forever on a URL
  // that can never be merged.
  for (const bad of ['', null, 'https://github.com/jmwind/issue-herd/issues/22', 'https://github.com/jmwind/issue-herd', 'not a url', 'https://github.com/o/r/pull/abc']) {
    assert.equal(parsePrUrl(bad), null, JSON.stringify(bad));
  }
});

test('merged, closed and open are told apart the way GitHub reports them', () => {
  assert.equal(stateOf({ state: 'closed', merged: true, merged_at: '2026-09-06T10:00:00Z' }), 'merged');
  assert.equal(stateOf({ state: 'closed', merged: false, merged_at: null }), 'closed');
  assert.equal(stateOf({ state: 'open', merged: false }), 'open');
  // Some GitHub payloads carry merged_at without `merged`; a merge is a merge.
  assert.equal(stateOf({ state: 'closed', merged_at: '2026-09-06T10:00:00Z' }), 'merged');
});

test('a merged PR comes back with the time it was merged', async () => {
  const fetchImpl = fakeFetch({ state: 'closed', merged: true, merged_at: '2026-09-06T10:00:00Z' });
  const r = await prState('https://github.com/jmwind/issue-herd/pull/23', { token: 'tok', fetchImpl });
  assert.deepEqual(r, { state: 'merged', mergedAt: '2026-09-06T10:00:00Z', number: 23, url: 'https://github.com/jmwind/issue-herd/pull/23' });
  assert.equal(fetchImpl.calls[0].url, 'https://api.github.com/repos/jmwind/issue-herd/pulls/23');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer tok');
});

test('no token is not an error — public repositories answer anyway', async () => {
  const fetchImpl = fakeFetch({ state: 'open' });
  const r = await prState('https://github.com/jmwind/issue-herd/pull/23', { fetchImpl });
  assert.equal(r.state, 'open');
  assert.equal('authorization' in fetchImpl.calls[0].headers, false);
});

test('a PR on a host this machine does not trust is refused, not fetched', async () => {
  // The URL comes from an agent that has read the issue's text; it does not get to say where the
  // Authorization header goes.
  const fetchImpl = fakeFetch({ state: 'closed', merged: true });
  await assert.rejects(
    () => prState('https://github.com.evil.example/jmwind/issue-herd/pull/23', { token: 'tok', fetchImpl }),
    /is not the GitHub host this machine trusts/);
  assert.equal(fetchImpl.calls.length, 0, 'nothing was sent');
});

test('GitHub Enterprise is asked at its own API root', async () => {
  assert.equal(apiBase('github.com'), 'https://api.github.com');
  assert.equal(apiBase('ghe.corp.com'), 'https://ghe.corp.com/api/v3');
  const fetchImpl = fakeFetch({ state: 'open' });
  await prState('https://ghe.corp.com/team/app/pull/7', { host: 'ghe.corp.com', fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'https://ghe.corp.com/api/v3/repos/team/app/pulls/7');
});

test('an HTTP failure says so rather than looking like "not merged yet"', async () => {
  const fetchImpl = fakeFetch({ message: 'Not Found' }, { status: 404 });
  await assert.rejects(() => prState('https://github.com/o/r/pull/1', { fetchImpl }), /404.*Not Found.*no GitHub token/s);
  const unauthorized = fakeFetch({ message: 'Bad credentials' }, { status: 401 });
  await assert.rejects(() => prState('https://github.com/o/r/pull/1', { token: 'dead', fetchImpl: unauthorized }), /401.*Bad credentials/s);
});

test('a rule is watched to the merge unless every onMerged step is off', () => {
  assert.equal(watchesMerge({ onMerged: { comment: true, exitAgent: true, closeWorkspace: true, removeWorktree: true, notify: true } }), true);
  assert.equal(watchesMerge({ onMerged: { comment: true } }), true, 'a comment on merge is reason enough to watch');
  // The shipped default: nothing is torn down, but the merge is still worth telling you about.
  assert.equal(watchesMerge({ onMerged: { comment: false, notify: true, exitAgent: false, closeWorkspace: false, removeWorktree: false } }), true);
  assert.equal(watchesMerge({ onMerged: { exitAgent: false, closeWorkspace: false, removeWorktree: false, comment: false, notify: false } }), false);
  assert.equal(watchesMerge({ onMerged: {} }), false, '"onMerged": null in config lands here');
  assert.equal(watchesMerge({}), false);
});

test('prForBranch asks GitHub for the newest PR whose head is the branch, and says when there is none', async () => {
  const calls = [];
  const fetchImpl = async (url, { headers }) => { calls.push({ url, auth: headers.authorization });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('7-fix') ? [{ html_url: 'https://github.com/o/r/pull/9', number: 9, state: 'open', merged_at: null }] : []) }; };
  const pr = await prForBranch({ repo: 'o/r', branch: '7-fix-the-thing', token: 't', fetchImpl });
  assert.deepEqual(pr, { url: 'https://github.com/o/r/pull/9', number: 9, state: 'open', mergedAt: null });
  assert.match(calls[0].url, /repos\/o\/r\/pulls\?head=o%3A7-fix-the-thing&state=all/);
  assert.equal(calls[0].auth, 'Bearer t');
  assert.equal(await prForBranch({ repo: 'o/r', branch: 'nothing-here', fetchImpl }), null);
  assert.equal(await prForBranch({ repo: null, branch: 'x', fetchImpl }), null);
});
