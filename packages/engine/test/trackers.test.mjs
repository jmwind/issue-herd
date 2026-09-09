// The contract every tracker in src/trackers/index.mjs must meet. Add a tracker, and this runs
// against it for free; the per-tracker tests (github.test.mjs, linear.test.mjs) cover behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKERS, isTracker, mergeSpec, trackerSpec, trackerClass } from '../dist/adapters/trackers/index.mjs';
import { checkIssue, userDisplay } from '../dist/adapters/tracker.mjs';

const METHODS = ['me', 'openIssues', 'issueByKey', 'comment', 'addLabel', 'removeLabel', 'assign', 'setState'];

for (const [id, T] of Object.entries(TRACKERS)) {
  test(`${id}: declares the static contract`, () => {
    assert.equal(T.id, id);
    assert.equal(typeof T.label, 'string');
    assert.ok([].concat(T.auth.env).length, 'auth.env names at least one variable');
    assert.equal(typeof T.auth.hint, 'string');
    assert.equal(typeof T.login, 'function');
    for (const m of METHODS) assert.equal(typeof T.prototype[m], 'function', `${id}.${m}()`);
  });

  test(`${id}: refuses to start without a token and names the way out`, () => {
    assert.throws(() => new T(null, { options: { repo: 'o/r' } }), /weawr login/);
    assert.throws(() => new T({ token: '' }, { options: { repo: 'o/r' } }), /weawr login/);
  });
}

test('trackerSpec accepts a name, an object, or nothing (Linear is the default)', () => {
  assert.deepEqual(trackerSpec(undefined), { type: 'linear' });
  assert.deepEqual(trackerSpec('GitHub'), { type: 'github' });
  assert.deepEqual(trackerSpec({ type: 'github', repo: 'o/r' }), { type: 'github', repo: 'o/r' });
  assert.throws(() => trackerSpec(42), /"tracker" must be/);
});

test('an unknown tracker lists the known ones', () => {
  assert.throws(() => trackerClass({ type: 'jira' }), /unknown tracker "jira"; known: linear, github/);
  assert.equal(trackerClass({ type: 'github' }).label, 'GitHub');
});

test('naming a tracker on the command line keeps the config options for it', () => {
  // `weawr login github` in a GitHub Enterprise repo must sign in to that host, not github.com.
  const configured = { type: 'github', host: 'ghe.corp.com', repo: 'team/app' };
  assert.deepEqual(mergeSpec({ type: 'github' }, configured), configured);
  assert.deepEqual(mergeSpec({ type: 'linear' }, configured), { type: 'linear' }, 'a different tracker keeps nothing');
  assert.deepEqual(mergeSpec(null, configured), configured);
  assert.deepEqual(mergeSpec({ type: 'github' }, null), { type: 'github' });
});

test('isTracker does not walk the prototype chain', () => {
  assert.ok(isTracker('github') && isTracker('linear'));
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, 42]) assert.ok(!isTracker(bad), String(bad));
});

test('checkIssue rejects the mistakes a new tracker is likely to make', () => {
  const good = {
    id: '1', identifier: 'X-1', ref: 'X-1', title: 't', description: '', url: 'u', priority: 0, priorityLabel: null, estimate: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', branchName: null, labels: [], project: null, team: null,
    assignees: [], assignee: null, creator: null, state: { id: 's', name: 'Open', type: 'unstarted' }, cycle: null, comments: [],
  };
  assert.equal(checkIssue(good), good);
  assert.throws(() => checkIssue({ ...good, identifier: '#7' }), /not safe for files and branches/);
  assert.throws(() => checkIssue({ ...good, priority: 'high' }), /priority must be 0..4/);
  assert.throws(() => checkIssue({ ...good, state: { name: 'Open', type: 'open' } }), /state.type must be one of/);
  assert.throws(() => checkIssue({ ...good, assignee: { login: 'x' } }), /assignee is missing "id"/);
  assert.throws(() => checkIssue({ ...good, id: '' }), /id is empty/);
  const me = { id: 'u', login: 'u', name: 'u', displayName: 'u', email: null };
  // the guard that leaves other people's issues alone reads assignees, so it must be complete
  assert.throws(() => checkIssue({ ...good, assignee: me, assignees: [] }), /assignee is not one of assignees/);
  assert.doesNotThrow(() => checkIssue({ ...good, assignee: me, assignees: [me] }));
  assert.throws(() => checkIssue({ ...good, comments: [{ body: 'b', author: 'a' }] }), /no createdAt/);
  const { comments, ...missing } = good;
  assert.throws(() => checkIssue(missing), /missing "comments"/);
});

test('userDisplay prefers an email, then a login, then a name', () => {
  assert.equal(userDisplay({ id: 1, email: 'a@b.c', login: 'a' }), 'a@b.c');
  assert.equal(userDisplay({ id: 1, login: 'jmwind', name: 'JM' }), '@jmwind');
  assert.equal(userDisplay({ id: 1, displayName: 'jml' }), 'jml');
  assert.equal(userDisplay(null), 'unknown');
});
