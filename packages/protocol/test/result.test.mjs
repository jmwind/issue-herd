import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeIssues, s, validate, validateResult, verdictOf } from '../dist/index.js';

test('the schema language names the path and the problem', () => {
  const sch = s.object({ a: s.string(), b: s.optional(s.number({ integer: true })), c: s.array(s.enum(['x', 'y'])) }, { extra: 'refuse' });
  const r = validate(sch, { a: 1, b: 1.5, c: ['x', 'z'], d: true });
  assert.equal(r.ok, false);
  assert.equal(describeIssues(r.issues), 'a: must be a string, not number; b: must be a whole number; c[1]: must be one of "x", "y", not "z"; d: is not a field here');
  assert.deepEqual(validate(sch, { a: 'ok', c: [] }), { ok: true, value: { a: 'ok', b: undefined, c: [] } });
});

test('a result must have a known status; optional fields are checked when present; extras are kept', () => {
  assert.equal(validateResult({ status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1', extra: 'kept' }).ok, true);
  const bad = validateResult({ status: 'done', nudge: { role: 'Impl!', message: '' } });
  assert.equal(bad.ok, false);
  assert.match(describeIssues(bad.issues), /status: must be one of "pr_open"/);
  assert.match(describeIssues(bad.issues), /nudge.role: must match/);
  assert.match(describeIssues(bad.issues), /nudge.message: must be at least 1/);
  assert.equal(validateResult('not an object').ok, false);
  assert.equal(validateResult({ status: 'pr_open', schemaVersion: 2 }).ok, false, 'a newer result format is refused, not guessed at');
  assert.match(describeIssues(validateResult({ status: 'pr_open', schemaVersion: 2 }).issues), /upgrade weawr/);
});

test('review verdicts: structured when given, legacy prose only where unambiguous, never with a head', () => {
  assert.deepEqual(verdictOf({ status: 'nothing_to_do', review: { verdict: 'approved', prUrl: 'u', headSha: 'abc1234' } }), { verdict: 'approved', source: 'structured', headSha: 'abc1234', prUrl: 'u' });
  assert.equal(verdictOf({ status: 'needs_human', summary: 'NOT OK TO MERGE TO MAIN — one finding' }).verdict, 'changes_requested');
  assert.deepEqual(verdictOf({ status: 'nothing_to_do', summary: 'USABILITY: OK, nothing blocking' }), { verdict: 'approved', source: 'legacy', headSha: null, prUrl: null });
  assert.equal(verdictOf({ status: 'nothing_to_do', summary: 'Looks fine to me, I think it is OK to merge' }).verdict, 'unknown');
  assert.equal(verdictOf({ status: 'nothing_to_do', summary: 'USABILITY: FINDINGS — 3 (2 blocking)\nmore' }).verdict, 'changes_requested');
  assert.equal(verdictOf({ status: 'nothing_to_do', summary: 'USABILITY: FINDINGS — 3 (0 blocking)' }).verdict, 'approved');
  assert.equal(verdictOf({ status: 'nothing_to_do', summary: 'SECURITY: NO FINDINGS — clean' }).verdict, 'approved');
  assert.equal(verdictOf({ status: 'nothing_to_do', summary: 'SECURITY: FINDINGS — 2 (highest: low)' }).verdict, 'unknown', 'findings of unknown weight are not a verdict');
  assert.equal(validateResult({ status: 'nothing_to_do', review: { verdict: 'lgtm' } }).ok, false);
  assert.equal(validateResult({ status: 'nothing_to_do', review: { verdict: 'approved', headSha: 'not a sha' } }).ok, false);
});
