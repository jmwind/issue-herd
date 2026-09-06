// Role-scoped claims: the lock that lets an implementer and a reviewer hold one issue at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alreadyTaken, applyRoles, checkRoleBranches, claimLabelFor, issueKeyOf,
  normalizeRole, pickCandidates, pickupMarker, runKeyFor,
} from '../src/claim.mjs';

const issue = (over = {}) => ({ identifier: 'GH-7', labels: [], comments: [], assignees: [], assignee: null, ...over });
const rule = (over = {}) => ({ name: 'r', claimLabel: 'herdr', role: null, skipIfAssignedToOthers: true, ...over });
/** What the watcher would post on pickup for this rule. */
const pickupComment = (role) => ({ body: `🐑 ${pickupMarker(role)} on \`mbp\` · herdr workspace \`w3\` · rule \`r\``, author: 'me', createdAt: '2026-01-01T00:00:00Z' });

// ---------------------------------------------------------------- naming

test('a role scopes the claim label, and no role leaves it exactly as it was', () => {
  assert.equal(claimLabelFor(rule()), 'herdr');
  assert.equal(claimLabelFor(rule({ role: 'impl' })), 'herdr:impl');
  // the label name stays configurable, per machine as well as per project
  assert.equal(claimLabelFor(rule({ claimLabel: 'herdr-mbp', role: 'review' })), 'herdr-mbp:review');
  assert.equal(claimLabelFor(rule({ claimLabel: null, role: 'review' })), null);
});

test('a role scopes the run key, and the issue key is recoverable from it', () => {
  assert.equal(runKeyFor('GH-7', null), 'GH-7');
  assert.equal(runKeyFor('GH-7', 'review'), 'GH-7.review');
  assert.equal(issueKeyOf('GH-7.review'), 'GH-7');
  assert.equal(issueKeyOf('GH-7'), 'GH-7');
});

test('roles are checked at config load, because they become labels and directory names', () => {
  assert.equal(normalizeRole(null), null);
  assert.equal(normalizeRole(''), null);
  assert.equal(normalizeRole(' Review '), 'review');
  for (const bad of ['a role', 'rev/iew', '-impl', 'ré', 'a:b']) {
    assert.throws(() => normalizeRole(bad, 'rule "x"'), /rule "x": role/, bad);
  }
  assert.throws(() => normalizeRole(7), /must be a string/);
});

// ---------------------------------------------------------------- alreadyTaken

test('two roles hold the same issue at once without either skipping the other', () => {
  // The acceptance criterion. An issue taken for implementation is still open for review.
  const taken = issue({ labels: ['ai', 'herdr:impl'], comments: [pickupComment('impl')] });
  assert.match(alreadyTaken(taken, rule({ role: 'impl' })), /herdr:impl/);
  assert.equal(alreadyTaken(taken, rule({ role: 'review' })), null);
  assert.equal(alreadyTaken(taken, rule({ role: 'split' })), null);

  // …and once review takes it too, each is held by its own claim and nobody else's.
  const both = issue({ labels: ['herdr:impl', 'herdr:review'], comments: [pickupComment('impl'), pickupComment('review')] });
  assert.match(alreadyTaken(both, rule({ role: 'impl' })), /herdr:impl/);
  assert.match(alreadyTaken(both, rule({ role: 'review' })), /herdr:review/);
  assert.equal(alreadyTaken(both, rule({ role: 'split' })), null);
});

test('with no role configured you get exactly the old, exclusive claim', () => {
  assert.equal(alreadyTaken(issue({ labels: ['ai'] }), rule()), null);
  assert.match(alreadyTaken(issue({ labels: ['ai', 'HERDR'] }), rule()), /'herdr' claim label/);
  assert.match(alreadyTaken(issue({ comments: [pickupComment(null)] }), rule()), /pickup comment/);
  // A roleless claim is a claim on the whole issue, so any pickup comment blocks it — including one
  // written by an older version that knew nothing about roles.
  assert.match(alreadyTaken(issue({ comments: [pickupComment('review')] }), rule()), /pickup comment/);
});

test('the pickup comment is the guard when the claim label differs per machine', () => {
  // Two machines, two claim labels, one role: the comment marker is what stops the second one.
  const mine = rule({ claimLabel: 'herdr-mbp', role: 'review' });
  const theirs = issue({ labels: ['herdr-mini:review'], comments: [pickupComment('review')] });
  assert.match(alreadyTaken(theirs, mine), /'review' pickup comment/);
  // but their review claim still leaves the impl role free
  assert.equal(alreadyTaken(theirs, rule({ claimLabel: 'herdr-mbp', role: 'impl' })), null);
});

test('a person holding the issue holds every role of it', () => {
  const alex = { id: 'u2', displayName: 'Alex' };
  const held = issue({ assignees: [alex], assignee: alex });
  const viewer = { id: 'u1', displayName: 'Me' };
  for (const role of [null, 'impl', 'review']) {
    assert.match(alreadyTaken(held, rule({ role }), viewer), /assigned to Alex/, String(role));
  }
  assert.equal(alreadyTaken(issue({ assignees: [viewer] }), rule({ role: 'review' }), viewer), null);
});

// ---------------------------------------------------------------- project configuration

test('"roles" decides which roles a project runs; rules for the others are switched off', () => {
  const rules = [rule({ name: 'impl', role: 'impl' }), rule({ name: 'rev', role: 'review' }), rule({ name: 'plain' })];
  applyRoles(rules, ['impl']);
  assert.equal(rules[0].enabled, undefined);
  assert.equal(rules[1].enabled, false);
  assert.match(rules[1].disabledReason, /role "review" is not in "roles"/);
  // A rule with no role is not one of the roles, so the allowlist never touches it.
  assert.equal(rules[2].enabled, undefined);
});

test('no "roles" key means every rule\'s role is active', () => {
  const rules = [rule({ role: 'impl' }), rule({ role: 'review' })];
  applyRoles(rules, null);
  assert.ok(rules.every((r) => r.enabled === undefined));
  assert.throws(() => applyRoles(rules, 'impl'), /must be an array/);
});

test('two roles pointed at one branch is caught at config load, not on the second pickup', () => {
  // git cannot check one branch out into two worktrees, so this config would fail every second
  // pickup with "is the branch checked out somewhere else?" — a long way from the cause.
  const impl = rule({ name: 'impl', role: 'impl', worktree: 'self', branch: '{{issueBranchName}}' });
  const rev = rule({ name: 'rev', role: 'review', worktree: 'self', branch: '{{issueBranchName}}' });
  assert.throws(() => checkRoleBranches([impl, rev]), /both work on branch .*roleSuffix/s);
  // The default template names the role, so it is fine.
  const ok = (b) => [{ ...impl, branch: b }, { ...rev, branch: b }];
  checkRoleBranches(ok('{{issueBranchName}}{{roleSuffix}}'));
  checkRoleBranches(ok('herd/{{role}}/{{slug}}'));
  // {{slug}} alone is enough: the slug is built from the run key, which carries the role.
  checkRoleBranches(ok('herd/{{slug}}'));
  // So is one branch shared by two rules of the *same* role: only one of them can ever match first.
  checkRoleBranches([impl, { ...rev, role: 'impl' }]);
  // And rules that never get a worktree have no branch to collide over.
  checkRoleBranches([{ ...impl, worktree: 'none' }, { ...rev, worktree: 'none' }]);
  checkRoleBranches([impl, { ...rev, enabled: false }]);
});

// ---------------------------------------------------------------- picking a poll's candidates

/** pickCandidates with everything free: no runs in flight, every rule matches, nobody assigned. */
const pick = (issues, rules, over = {}) => pickCandidates({
  issues, rules, viewer: { id: 'u1' }, matches: () => true, busy: () => false, ...over,
});

test('one poll can hand the same issue to an implementer and a reviewer', () => {
  // The acceptance criterion, at the level the watcher actually works: two rules, two roles, two
  // runs on one issue, neither skipping the other.
  const rules = [rule({ name: 'impl', role: 'impl' }), rule({ name: 'rev', role: 'review' })];
  const got = pick([issue()], rules);
  assert.deepEqual(got.map((c) => [c.key, c.rule.name]), [['GH-7.impl', 'impl'], ['GH-7.review', 'rev']]);
});

test('a run in flight blocks its own role and nothing else', () => {
  const rules = [rule({ name: 'impl', role: 'impl' }), rule({ name: 'rev', role: 'review' })];
  const got = pick([issue()], rules, { busy: (key) => key === 'GH-7.impl' });
  assert.deepEqual(got.map((c) => c.key), ['GH-7.review']);
});

test('within one role the first matching rule still wins, and only it', () => {
  const rules = [rule({ name: 'first', role: 'impl' }), rule({ name: 'second', role: 'impl' }), rule({ name: 'plain' })];
  const got = pick([issue()], rules);
  assert.deepEqual(got.map((c) => c.rule.name), ['first', 'plain']);
  // and a rule the project switched off is not consulted, so the next one of its role gets a turn
  rules[0].enabled = false;
  assert.deepEqual(pick([issue()], rules).map((c) => c.rule.name), ['second', 'plain']);
});

test('with no roles anywhere, a poll behaves exactly as it did: one run per issue', () => {
  const rules = [rule({ name: 'a' }), rule({ name: 'b' })];
  assert.deepEqual(pick([issue(), issue({ identifier: 'GH-8' })], rules).map((c) => c.key), ['GH-7', 'GH-8']);
});

test('a guard that fires is reported against the run key it stopped, not the issue', () => {
  const skipped = [];
  const rules = [rule({ name: 'impl', role: 'impl' }), rule({ name: 'rev', role: 'review' })];
  const got = pick([issue({ labels: ['herdr:impl'] })], rules, { onSkip: (key, r, why) => skipped.push([key, r.name, why]) });
  assert.deepEqual(got.map((c) => c.key), ['GH-7.review']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0][0], 'GH-7.impl');
  assert.match(skipped[0][2], /herdr:impl/);
});
