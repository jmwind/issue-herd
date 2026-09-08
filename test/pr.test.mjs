import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, conflictPrompt, conflictStep, conflictsOf, keepMergeable, parsePrUrl, prForBranch, prState, stateOf, watchesMerge } from '../src/pr.mjs';

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
  assert.deepEqual(r, { state: 'merged', mergedAt: '2026-09-06T10:00:00Z', number: 23, url: 'https://github.com/jmwind/issue-herd/pull/23', headSha: null, baseRef: null, conflicts: null });
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

test('conflicts are GitHub\'s "dirty"; "blocked", "behind" and "unstable" are clean; "not computed yet" is neither', () => {
  assert.equal(conflictsOf({ mergeable: false, mergeable_state: 'dirty' }), true);
  assert.equal(conflictsOf({ mergeable: true, mergeable_state: 'clean' }), false);
  // Branch protection, a missing review, a failing check: the branch is not stale, so not the implementer's problem here.
  assert.equal(conflictsOf({ mergeable: true, mergeable_state: 'blocked' }), false);
  assert.equal(conflictsOf({ mergeable: true, mergeable_state: 'behind' }), false);
  assert.equal(conflictsOf({ mergeable: true, mergeable_state: 'unstable' }), false);
  // The first read after a push, while GitHub is still computing: null is "not known yet", and it
  // must stay null — read as "clean" it would forget a conflict that is still there.
  assert.equal(conflictsOf({ mergeable: null, mergeable_state: 'unknown' }), null);
  assert.equal(conflictsOf({}), null);
  assert.equal(conflictsOf(null), null);
});

test('an open PR comes back with its head, base and whether it conflicts', async () => {
  const fetchImpl = fakeFetch({ state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty', head: { sha: 'abc123' }, base: { ref: 'main' } });
  const r = await prState('https://github.com/jmwind/issue-herd/pull/23', { fetchImpl });
  assert.deepEqual(r, { state: 'open', mergedAt: null, number: 23, url: 'https://github.com/jmwind/issue-herd/pull/23', headSha: 'abc123', baseRef: 'main', conflicts: true });
});

test('the implementer is told once per conflict, again when the head moves and still conflicts, and forgotten when clean', () => {
  const dirty = (headSha) => ({ state: 'open', conflicts: true, headSha });
  const clean = (headSha) => ({ state: 'open', conflicts: false, headSha });
  // Fresh conflict: tell it.
  assert.equal(conflictStep({}, dirty('a1')), 'nudge');
  // Same head, still dirty, next minute: already told.
  assert.equal(conflictStep({ conflictHead: 'a1' }, dirty('a1')), null);
  // It pushed a fix (or something else landed) and the PR still conflicts: that is news.
  assert.equal(conflictStep({ conflictHead: 'a1' }, dirty('b2')), 'nudge');
  // Clean again: forget the marker so the next drift is a fresh episode...
  assert.equal(conflictStep({ conflictHead: 'b2' }, clean('b2')), 'clear');
  // ...and a clean PR that was never in conflict is nothing to do at all.
  assert.equal(conflictStep({}, clean('b2')), null);
  assert.equal(conflictStep(undefined, clean('b2')), null);
  // Merged or closed PRs are the merge watch's business, not this one's.
  assert.equal(conflictStep({ conflictHead: 'a1' }, { state: 'merged', conflicts: false }), null);
  assert.equal(conflictStep({}, null), null);
  // A payload without a head sha still gets told exactly once.
  assert.equal(conflictStep({}, dirty(null)), 'nudge');
  assert.equal(conflictStep({ conflictHead: 'unknown' }, dirty(null)), null);
  // GitHub recomputing after a push: dirty → unknown → dirty on the same head is one conflict, told once.
  const unknown = (headSha) => ({ state: 'open', conflicts: null, headSha });
  const run = { conflictHead: 'a1' };
  assert.equal(conflictStep(run, unknown('a1')), null, 'unknown is not "clean again"');
  assert.equal(run.conflictHead, 'a1');
  assert.equal(conflictStep(run, dirty('a1')), null, 'the same head, dirty again, was already told');
  assert.equal(conflictStep({}, unknown('a1')), null, 'and unknown on a PR never in conflict is nothing either');
});

/** A keepMergeable harness: scripted herdr answers, recorded calls. */
function harness({ agent = [], nudge = [] } = {}) {
  const calls = [];
  const next = (script, name) => {
    const a = script.length > 1 ? script.shift() : script[0];
    calls.push(name);
    if (a instanceof Error) throw a;
    return a;
  };
  return {
    calls,
    deps: {
      lookupAgent: async () => next(agent, 'lookup'),
      nudge: async () => next(nudge, 'nudge'),
      tellPerson: async () => { calls.push('tell'); },
      log: () => {},
    },
  };
}
const dirtyPr = (headSha = 'a1') => ({ state: 'open', url: 'https://github.com/o/r/pull/9', baseRef: 'main', conflicts: true, headSha });

test('a herdr that cannot be asked is not a session that is gone: the watcher tries again, then tells the recovered agent', async () => {
  // The bug the tech-lead review found: catch(() => null) on the lookup made a herdr timeout look
  // like an exited agent, which set the marker, told the person, and never told the agent.
  const run = {};
  const h = harness({ agent: [new Error('herdr agent get: timeout'), { name: 'gh-9-impl' }], nudge: [{}] });
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), 'retry');
  assert.equal(run.conflictHead, undefined, 'nothing was told, so nothing is remembered');
  assert.deepEqual(h.calls, ['lookup']);
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), 'nudged');
  assert.equal(run.conflictHead, 'a1');
  assert.deepEqual(h.calls, ['lookup', 'lookup', 'nudge']);
  // Same head next minute: nobody is bothered again.
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), null);
  assert.deepEqual(h.calls, ['lookup', 'lookup', 'nudge']);
});

test('an agent herdr has no record of is gone, so the person is told once and the agent never', async () => {
  const run = {};
  const h = harness({ agent: [null] });
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), 'told');
  assert.equal(run.conflictHead, 'a1');
  assert.deepEqual(h.calls, ['lookup', 'tell']);
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), null);
  assert.deepEqual(h.calls, ['lookup', 'tell'], 'not told twice for the same head');
});

test('a prompt herdr refuses (a dialog is up) is owed, not lost', async () => {
  const run = {};
  const blocked = Object.assign(new Error('agent is blocked'), { code: 'agent_blocked' });
  const h = harness({ agent: [{ name: 'gh-9-impl' }], nudge: [blocked, {}] });
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), 'retry');
  assert.equal(run.conflictHead, undefined);
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), 'nudged');
  assert.equal(run.conflictHead, 'a1');
});

test('dirty → unknown → dirty on one head is one conflict, and a clean read ends it', async () => {
  const run = {};
  const h = harness({ agent: [{ name: 'gh-9-impl' }], nudge: [{}] });
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), 'nudged');
  assert.equal(await keepMergeable(run, { ...dirtyPr(), conflicts: null }, h.deps), null, 'GitHub recomputing changes nothing');
  assert.equal(run.conflictHead, 'a1');
  assert.equal(await keepMergeable(run, dirtyPr(), h.deps), null, 'the same conflict is not announced twice');
  assert.equal(await keepMergeable(run, { ...dirtyPr(), conflicts: false }, h.deps), 'cleared');
  assert.equal(run.conflictHead, undefined);
  assert.deepEqual(h.calls.filter((c) => c === 'nudge').length, 1);
});


test('the conflict message says what happened, what to do, and what never to do', () => {
  const msg = conflictPrompt({ prUrl: 'https://github.com/o/r/pull/9', branch: '9-fix-impl', baseRef: 'main', briefPath: '/wt/.issue-herd/state/runs/GH-9@impl/brief.md' });
  assert.match(msg, /^issue-herd: your pull request https:\/\/github\.com\/o\/r\/pull\/9 now conflicts with main/);
  assert.match(msg, /git fetch origin main/);
  assert.match(msg, /git merge origin\/main/);
  assert.match(msg, /`9-fix-impl`/);
  assert.match(msg, /never a rebase, never a force-push/);
  assert.match(msg, /Do not rewrite the result file/);
  assert.match(msg, /runs\/GH-9@impl\/brief\.md/);
  // Without a base ref or brief path it still reads as a sentence.
  const bare = conflictPrompt({ prUrl: 'https://github.com/o/r/pull/9' });
  assert.match(bare, /conflicts with the base branch/);
  assert.match(bare, /git merge origin\/<base>/);
  assert.doesNotMatch(bare, /\(\)/);
});
