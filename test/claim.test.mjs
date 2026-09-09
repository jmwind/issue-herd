// Role-scoped claims: the lock that lets an implementer and a reviewer hold one issue at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_RE, ROLE_SEPARATOR,
  alreadyTaken, applyRoles, checkBasedOn, checkRoleBranches, claimLabelFor, issueKeyOf,
  heldByAPerson, nextPass, normalizePasses, normalizeRole, passLimit, pickCandidates, pickupMarker,
  LEGACY_CLAIM_MARKER,
  runKeyFor, workspaceLabel,
} from '../src/claim.mjs';

const issue = (over = {}) => ({ identifier: 'GH-7', labels: [], comments: [], assignees: [], assignee: null, ...over });
const rule = (over = {}) => ({ name: 'r', claimLabel: 'herdr', role: null, skipIfAssignedToOthers: true, ...over });
/** What the watcher would post on pickup for this rule. */
const pickupComment = (role) => ({ body: `🧵 ${pickupMarker(role)} on \`mbp\` · herdr workspace \`w3\` · rule \`r\``, author: 'me', createdAt: '2026-01-01T00:00:00Z' });

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
  assert.equal(runKeyFor('GH-7', 'review'), 'GH-7@review');
  assert.equal(issueKeyOf('GH-7@review'), 'GH-7');
  assert.equal(issueKeyOf('GH-7'), 'GH-7');
});

test('a run key can always be read back, whatever the tracker calls its issues', () => {
  // checkIssue() lets an identifier hold dots, dashes and underscores, so a "." separator made
  // "V1.2.review" ambiguous: issue V1.2 in role "review", or issue V1 in role "2.review"?
  // `weawr reset V1.2` read it the second way and forgot the wrong runs. No identifier and
  // no role can contain the separator, so there is exactly one way to split.
  for (const id of ['GH-7', 'DEV-123', 'V1.2', 'a_b-c.d', '7']) {
    assert.equal(issueKeyOf(runKeyFor(id, 'review')), id, id);
    assert.equal(issueKeyOf(runKeyFor(id, null)), id, `${id} roleless`);
    assert.ok(!ROLE_SEPARATOR.match(ROLE_RE), 'the separator must not be a legal role character');
  }
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

test('a pickup comment written under the old name (issue-herd) still counts as a claim, in its role', () => {
  // The rename (#71) changed the marker's first word. Issues claimed before it must not be taken twice.
  const legacy = (role) => ({ body: `🐑 ${pickupMarker(role, LEGACY_CLAIM_MARKER)} on \`mbp\` · herdr workspace \`w3\` · rule \`r\``, author: 'me', createdAt: '2026-01-01T00:00:00Z' });
  assert.match(legacy('impl').body, /\*\*issue-herd\*\* picked this up as `impl`/);
  assert.match(alreadyTaken(issue({ comments: [legacy('impl')] }), rule({ role: 'impl' })), /a weawr 'impl' pickup comment/);
  assert.equal(alreadyTaken(issue({ comments: [legacy('impl')] }), rule({ role: 'review' })), null, 'the old marker is still role-scoped');
  assert.match(alreadyTaken(issue({ comments: [legacy(null)] }), rule()), /a weawr pickup comment/);
  assert.match(pickupMarker('impl'), /^\*\*weawr\*\* picked this up as `impl`$/, 'new pickups are written under the new name');
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

test('"basedOn" has to name a role some rule runs, or the reviewer quietly gets main', () => {
  const impl = rule({ name: 'impl', role: 'impl' });
  const rev = rule({ name: 'rev', role: 'review', basedOn: 'impl' });
  checkBasedOn([impl, rev]);
  assert.throws(() => checkBasedOn([impl, { ...rev, basedOn: 'implementer' }]),
    /rule "rev": "basedOn" is "implementer", which no rule has as its "role" \(roles here: impl, review\)/);
  // A role switched off by "roles" is still a role this project has: turning it back on is one edit.
  checkBasedOn([{ ...impl, enabled: false }, rev]);
});

// ---------------------------------------------------------------- picking a poll's candidates

/** pickCandidates with everything free: no runs in flight, every rule matches, nobody assigned. */
const pick = (issues, rules, over = {}) => pickCandidates({
  issues, rules, viewer: { id: 'u1' }, matches: () => true, runFor: () => null, ...over,
});

test('one poll can hand the same issue to an implementer and a reviewer', () => {
  // The acceptance criterion, at the level the watcher actually works: two rules, two roles, two
  // runs on one issue, neither skipping the other.
  const rules = [rule({ name: 'impl', role: 'impl' }), rule({ name: 'rev', role: 'review' })];
  const got = pick([issue()], rules);
  assert.deepEqual(got.map((c) => [c.key, c.rule.name]), [['GH-7@impl', 'impl'], ['GH-7@review', 'rev']]);
});

test('a run in flight blocks its own role and nothing else', () => {
  const rules = [rule({ name: 'impl', role: 'impl' }), rule({ name: 'rev', role: 'review' })];
  const running = { status: 'running', pass: 1, claimed: 'herdr:impl' };
  const got = pick([issue()], rules, { runFor: (key) => (key === 'GH-7@impl' ? running : null) });
  assert.deepEqual(got.map((c) => c.key), ['GH-7@review']);
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
  assert.deepEqual(got.map((c) => c.key), ['GH-7@review']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0][0], 'GH-7@impl');
  assert.match(skipped[0][2], /herdr:impl/);
});

// ---------------------------------------------------------------- the sidebar

test('the herdr label puts the role between the key and the title', () => {
  assert.equal(workspaceLabel({ key: 'GH-7', title: 'Fix the thing' }), 'GH-7 Fix the thing');
  assert.equal(workspaceLabel({ key: 'GH-7', role: 'review', title: 'Fix the thing' }), 'GH-7 review Fix the thing');
  // The title is what gets trimmed; the key and the role always survive, because they are the
  // whole point of reading the sidebar.
  const long = workspaceLabel({ key: 'DEV-3298', role: 'review-security', title: 'A'.repeat(200) });
  assert.ok(long.startsWith('DEV-3298 review-security A'), long);
  assert.equal(long.length, 48);
  assert.equal(workspaceLabel({ key: 'GH-7', role: 'impl', title: '' }), 'GH-7 impl');
});

// ---------------------------------------------------------------- more than one turn

const finished = (over = {}) => ({ status: 'done', pass: 1, claimed: 'herdr:review', finishedAt: '2026-01-01T00:00:00Z', ...over });
const moved = (iso) => issue({ updatedAt: iso });

test('one pass is the default, and a finished run never gets another turn', () => {
  assert.equal(passLimit(rule()), 1);
  assert.equal(passLimit(rule({ passes: 3 })), 3);
  assert.equal(nextPass(finished(), rule({ role: 'review' }), moved('2026-06-01T00:00:00Z')), null);
});

test('a role with turns left gets one only when the issue has moved on since it finished', () => {
  const r = rule({ role: 'review', passes: 3 });
  // nothing has happened since we finished: not a candidate
  assert.equal(nextPass(finished(), r, moved('2025-12-31T00:00:00Z')), null);
  // someone pushed a fix afterwards: our turn again, and the claim was never handed back
  assert.deepEqual(nextPass(finished(), r, moved('2026-01-02T00:00:00Z')), { pass: 2, holdsClaim: true });
  // …until the turns run out
  assert.equal(nextPass(finished({ pass: 3 }), r, moved('2026-01-02T00:00:00Z')), null);
});

test('a role never answers its own closing comment', () => {
  // The loop this would otherwise be: our own report bumps the issue, the next poll reads that as
  // "the issue moved on", and the reviewer reviews its own review for ever. finalize() stamps the
  // issue's clock after it has finished writing, and that stamp is what the next turn is measured
  // against — even though it is later than finishedAt.
  const r = rule({ role: 'review', passes: 5 });
  const ourOwnComment = finished({ issueUpdatedAt: '2026-01-01T00:05:00Z' });
  assert.equal(nextPass(ourOwnComment, r, moved('2026-01-01T00:05:00Z')), null);
  // A person replying after that is a real change, and earns the next turn.
  assert.deepEqual(nextPass(ourOwnComment, r, moved('2026-01-01T00:06:00Z')), { pass: 2, holdsClaim: true });
});

test('a run still going is never given another turn', () => {
  const r = rule({ role: 'review', passes: 3 });
  for (const status of ['starting', 'running', 'awaiting_merge']) {
    assert.equal(nextPass(finished({ status }), r, moved('2026-06-01T00:00:00Z')), null, status);
  }
});

test('a failed start is still retried, and re-checks the guards because the claim came off', () => {
  // The pre-roles behaviour, preserved: a failed run is a candidate again once the issue changes,
  // and it does not use up a turn. holdsClaim is false, so pickCandidates re-runs alreadyTaken.
  const failed = { status: 'failed', pass: 1, finishedAt: '2026-01-01T00:00:00Z' };
  assert.deepEqual(nextPass(failed, rule({ passes: 1 }), moved('2026-01-02T00:00:00Z')), { pass: 1, holdsClaim: false });
  assert.equal(nextPass(failed, rule({ passes: 1 }), moved('2025-12-31T00:00:00Z')), null);
});

test('a turn we already hold the claim for skips the guards it would fail', () => {
  // Our own label and our own pickup comment are on the issue by now. Re-reading the guards would
  // refuse the very turn we granted, so a held claim is not re-acquired.
  const rules = [rule({ name: 'rev', role: 'review', passes: 2 })];
  const held = issue({ labels: ['herdr:review'], comments: [pickupComment('review')], updatedAt: '2026-01-02T00:00:00Z' });
  const skipped = [];
  const got = pickCandidates({
    issues: [held], rules, viewer: { id: 'u1' }, matches: () => true,
    runFor: () => finished(), onSkip: (k, r, why) => skipped.push(why),
  });
  assert.deepEqual(got.map((c) => [c.key, c.pass, c.holdsClaim]), [['GH-7@review', 2, true]]);
  assert.deepEqual(skipped, []);
  // A second machine, with no run of its own for that role, is still refused by the label.
  const other = pickCandidates({ issues: [held], rules, viewer: { id: 'u1' }, matches: () => true, runFor: () => null, onSkip: (k, r, why) => skipped.push(why) });
  assert.deepEqual(other, []);
  assert.match(skipped[0], /herdr:review/);
});

test('"passes" is checked at config load', () => {
  assert.equal(normalizePasses(undefined), 1);
  assert.equal(normalizePasses(4), 4);
  for (const bad of [0, -1, 1.5, '3', true]) {
    assert.throws(() => normalizePasses(bad, 'rule "x"'), /rule "x": "passes"/, String(bad));
  }
});

test('a person taking the issue over ends the role\'s remaining turns', () => {
  // The bug this is here for: a turn we already hold the claim for skips the claim guards, and it
  // used to skip *every* guard with them — so a reviewer with turns left would start another one
  // on an issue a colleague had just assigned to themselves. The claim guards are ours to skip;
  // the person guard never is.
  const alex = { id: 'u2', displayName: 'Alex' };
  const viewer = { id: 'u1' };
  const rules = [rule({ name: 'rev', role: 'review', passes: 3 })];
  const taken = issue({
    labels: ['herdr:review'], comments: [pickupComment('review')],
    assignees: [alex], assignee: alex, updatedAt: '2026-01-02T00:00:00Z',
  });
  const skipped = [];
  const got = pickCandidates({
    issues: [taken], rules, viewer, matches: () => true,
    runFor: () => finished(), onSkip: (k, r, why) => skipped.push([k, why]),
  });
  assert.deepEqual(got, []);
  assert.deepEqual(skipped, [['GH-7@review', 'assigned to Alex']]);

  // and with nobody else on it, the turn is still granted
  const free = issue({ labels: ['herdr:review'], comments: [pickupComment('review')], updatedAt: '2026-01-02T00:00:00Z' });
  const ok = pickCandidates({ issues: [free], rules, viewer, matches: () => true, runFor: () => finished() });
  assert.deepEqual(ok.map((c) => [c.key, c.pass]), [['GH-7@review', 2]]);
});

test('the person guard is separate from the claim guards, and answers on its own', () => {
  const alex = { id: 'u2', displayName: 'Alex' };
  const viewer = { id: 'u1' };
  assert.equal(heldByAPerson(issue({ assignees: [alex] }), rule(), viewer), 'assigned to Alex');
  assert.equal(heldByAPerson(issue({ assignees: [viewer] }), rule(), viewer), null);
  assert.equal(heldByAPerson(issue({ assignees: [] }), rule(), viewer), null);
  // switched off by config, or with nobody to compare against, it has no opinion
  assert.equal(heldByAPerson(issue({ assignees: [alex] }), rule({ skipIfAssignedToOthers: false }), viewer), null);
  assert.equal(heldByAPerson(issue({ assignees: [alex] }), rule(), null), null);
  // an issue held by you *and* someone else is still someone else's
  assert.equal(heldByAPerson(issue({ assignees: [viewer, alex] }), rule(), viewer), 'assigned to Alex');
});

test('an agent that died without a result does not spend the role\'s turns by itself', () => {
  // "stopped" is a finished run, so it is eligible for another turn — but the watcher comments on
  // the issue when it happens, and that comment is a change to the issue. Without the same stamp
  // finalize uses, a rule with three turns would burn all three on a session that keeps dying,
  // inside two polls, before anyone could look at it.
  const r = rule({ role: 'review', passes: 3 });
  const died = { status: 'stopped', pass: 1, claimed: 'herdr:review', finishedAt: '2026-01-01T00:00:00Z' };
  // unstamped: our own "the agent died" comment reads as the issue moving on
  assert.deepEqual(nextPass(died, r, moved('2026-01-01T00:00:01Z')), { pass: 2, holdsClaim: true });
  // stamped, as superviseLoop now does: it takes a real change to earn the retry
  const stamped = { ...died, issueUpdatedAt: '2026-01-01T00:00:01Z' };
  assert.equal(nextPass(stamped, r, moved('2026-01-01T00:00:01Z')), null);
  assert.deepEqual(nextPass(stamped, r, moved('2026-01-01T00:05:00Z')), { pass: 2, holdsClaim: true });
});
