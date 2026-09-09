// Nudges: the roles on one issue handing work to each other, capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_NUDGES, MAX_MESSAGE,
  normalizeMaxNudges, nudgeInstructions, nudgeQuote, nudgedByLabel, nudgesIn, nudgesLeft, nudgesSent, planNudge,
} from '../dist/nudge.mjs';

const run = (over = {}) => ({ status: 'done', role: 'impl', pass: 1, claimed: 'herdr:impl', ...over });

// ---------------------------------------------------------------- config

test('maxNudges is a whole number, 0 turns it off, and the default is on', () => {
  assert.equal(normalizeMaxNudges(undefined), DEFAULT_MAX_NUDGES);
  assert.equal(normalizeMaxNudges(null), DEFAULT_MAX_NUDGES);
  assert.ok(DEFAULT_MAX_NUDGES > 0, 'nudging is on unless a config says otherwise');
  assert.equal(normalizeMaxNudges(0), 0);
  assert.equal(normalizeMaxNudges(false), 0);
  assert.equal(normalizeMaxNudges(3), 3);
  assert.throws(() => normalizeMaxNudges(-1, 'config.json'), /config\.json: "maxNudges" must be a whole number of 0 or more/);
  assert.throws(() => normalizeMaxNudges('6'), /"maxNudges"/);
  assert.throws(() => normalizeMaxNudges(1.5), /"maxNudges"/);
});

// ---------------------------------------------------------------- reading a result

test('a result may nudge one role or several, and a malformed nudge is a reason, not a crash', () => {
  assert.deepEqual(nudgesIn({ status: 'nothing_to_do' }), { nudges: [], rejected: [] });
  assert.deepEqual(nudgesIn({ nudge: { role: 'impl', message: 'fix the two findings' } }),
    { nudges: [{ role: 'impl', message: 'fix the two findings' }], rejected: [] });
  // a list, and the role is normalized the way config roles are
  const many = nudgesIn({ nudge: [{ role: 'Review', message: ' pushed the fix ' }, { role: 'usability', message: 'docs updated' }] });
  assert.deepEqual(many.nudges, [{ role: 'review', message: 'pushed the fix' }, { role: 'usability', message: 'docs updated' }]);
  assert.deepEqual(many.rejected, []);
  // `nudges` is accepted too — it is the word an agent reaches for when it writes a list
  assert.equal(nudgesIn({ nudges: [{ role: 'impl', message: 'x' }] }).nudges.length, 1);
  // the bad ones are named and the good ones still go through
  const mixed = nudgesIn({ nudge: ['impl', { role: 'impl' }, { role: 'not a role!', message: 'x' }, { role: 'impl', message: 'ok' }] });
  assert.deepEqual(mixed.nudges, [{ role: 'impl', message: 'ok' }]);
  assert.equal(mixed.rejected.length, 3);
  assert.match(mixed.rejected[0], /nudge #1 is "impl", not \{ "role", "message" \}/);
  assert.match(mixed.rejected[1], /nudge #2 to `impl` has no message/);
  assert.match(mixed.rejected[2], /nudge #3 names no role/);
  // a message is an ask, not a report: it is cut, and the cut is visible
  const long = nudgesIn({ nudge: { role: 'impl', message: 'x'.repeat(MAX_MESSAGE + 100) } }).nudges[0].message;
  assert.equal(long.length, MAX_MESSAGE);
  assert.ok(long.endsWith('…'));
});

// ---------------------------------------------------------------- deciding

test('a finished run gets its next turn, a busy one gets the nudge queued', () => {
  const nudge = { role: 'impl', message: 'fix it' };
  for (const status of ['done', 'stopped', 'awaiting_merge']) {
    assert.equal(planNudge({ nudge, from: 'review', targetRun: run({ status }), sent: 0, max: 6 }).outcome, 'turn', status);
  }
  for (const status of ['running', 'starting']) {
    const r = planNudge({ nudge, from: 'review', targetRun: run({ status }), sent: 0, max: 6 });
    assert.equal(r.outcome, 'queue', status);
    assert.match(r.reason, /in the middle of a turn/);
  }
  // a run whose status says done but whose supervisor has not left yet is still busy
  assert.equal(planNudge({ nudge, from: 'review', targetRun: run({ status: 'done' }), sent: 0, max: 6, busy: true }).outcome, 'queue');
});

test('a nudge that cannot be delivered says why in words fit for the issue', () => {
  const nudge = { role: 'impl', message: 'fix it' };
  const refused = (opts) => { const r = planNudge({ nudge, from: 'review', sent: 0, max: 6, ...opts }); assert.equal(r.outcome, 'refused'); return r.reason; };
  assert.match(refused({ targetRun: null }), /no `impl` run is on this issue yet/);
  assert.match(refused({ targetRun: run({ status: 'merged' }) }), /pull request is merged/);
  assert.match(refused({ targetRun: run({ status: 'failed' }) }), /last `impl` start failed/);
  assert.match(refused({ targetRun: run(), from: 'impl' }), /cannot nudge itself/);
  assert.match(refused({ targetRun: run(), max: 0 }), /nudging is off/);
});

test('the cap ends the conversation whatever state it is in, and asks for a person', () => {
  const nudge = { role: 'impl', message: 'fix it' };
  const r = planNudge({ nudge, from: 'review', targetRun: run(), sent: 6, max: 6 });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /nudged each other 6 times on this issue \(`maxNudges` is 6\), so a person needs to step in/);
  // only the spent budget is "capped": nudging that was never on is a refusal nobody is woken for
  assert.equal(r.capped, true);
  assert.equal(planNudge({ nudge, from: 'review', targetRun: run(), sent: 0, max: 0 }).capped, undefined);
  // the cap is checked first: a busy target over the cap is refused, not queued
  assert.equal(planNudge({ nudge, from: 'review', targetRun: run({ status: 'running' }), sent: 6, max: 6 }).outcome, 'refused');
  // and one under it still goes through
  assert.equal(planNudge({ nudge, from: 'review', targetRun: run(), sent: 5, max: 6 }).outcome, 'turn');
});

test('only relayed nudges count against the cap', () => {
  const entries = [
    { from: 'review', to: 'impl', outcome: 'turn' },
    { from: 'impl', to: 'review', outcome: 'queue' },
    { from: 'impl', to: 'security', outcome: 'refused' },
  ];
  assert.equal(nudgesSent(entries), 2);
  assert.equal(nudgesLeft(entries, 6), 4);
  assert.equal(nudgesLeft(entries, 1), 0);
  assert.equal(nudgesLeft(undefined, 6), 6);
});

// ---------------------------------------------------------------- what the brief says

test('the brief quotes the nudge, and names each sender when there are several', () => {
  assert.equal(nudgeQuote([{ from: 'review', message: 'line one\nline two' }]), '  > line one\n  > line two');
  const two = nudgeQuote([{ from: 'review', message: 'fix A' }, { from: 'usability', message: 'fix B' }]);
  assert.match(two, /From `review`:\n  > fix A/);
  assert.match(two, /From `usability`:\n  > fix B/);
  assert.equal(nudgedByLabel([{ from: 'review' }]), 'review');
  assert.equal(nudgedByLabel([{ from: 'review' }, { from: 'usability' }, { from: 'review' }]), 'review and usability');
});

test('a brief teaches nudging only to a role with somebody to nudge', () => {
  const text = nudgeInstructions({ role: 'review', roles: ['impl', 'review', 'usability'], left: 4, max: 6 });
  assert.match(text, /other roles on this issue are `impl`, `usability`/);
  assert.match(text, /"nudge": \{ "role": "impl", "message"/);
  assert.match(text, /\*\*4\*\* nudges left/);
  assert.match(text, /write `needs_human`\s+instead of nudging again/);
  assert.match(nudgeInstructions({ role: 'review', roles: ['impl', 'review'], left: 1, max: 6 }), /\*\*1\*\* nudge left/);
  assert.match(nudgeInstructions({ role: 'review', roles: ['impl', 'review'], left: 0, max: 6 }), /\*\*no nudges left\*\*/);
  // nobody to nudge, no role, or nudging off: not a word
  assert.equal(nudgeInstructions({ role: 'impl', roles: ['impl'], left: 6, max: 6 }), '');
  assert.equal(nudgeInstructions({ role: null, roles: ['impl', 'review'], left: 6, max: 6 }), '');
  assert.equal(nudgeInstructions({ role: 'impl', roles: ['impl', 'review'], left: 0, max: 0 }), '');
});
