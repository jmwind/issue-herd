import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, parse, tokenize } from '../dist/expr.mjs';

const now = Date.parse('2026-09-05T12:00:00Z');
const viewer = { id: 'u-me', email: 'jml@seapeopleapp.com' };
const ctx = { viewer, now };

const issue = {
  identifier: 'DEV-123',
  title: 'Map crashes when zooming past level 12',
  labels: ['ai', 'Bug'],
  project: { name: 'GustKit' },
  team: { key: 'DEV', name: 'Development' },
  assignee: null,
  creator: { id: 'u-alex', name: 'alex@frangeti.dev', displayName: 'alex' },
  state: { name: 'Todo', type: 'unstarted' },
  priority: 2, // high
  estimate: 3,
  cycle: { number: 7, isActive: true },
  createdAt: '2026-09-03T12:00:00Z', // 2d old
  updatedAt: '2026-09-05T11:00:00Z', // 1h ago
};
const mine = { ...issue, identifier: 'DEV-124', assignee: { id: 'u-me', email: 'jml@seapeopleapp.com', displayName: 'jml' }, state: { name: 'In Progress', type: 'started' }, priority: 0, labels: ['Feature'], cycle: null };

const m = (expr, iss = issue) => compile(expr).test(iss, ctx);

test('people match by login too, with or without the @, and "me" by login when there is no email (GitHub)', () => {
  const gh = { ...issue, assignee: { id: 'jmwind', login: 'jmwind', name: 'JM', displayName: 'jmwind', email: null } };
  const ghCtx = { viewer: { id: 'jmwind', login: 'jmwind', email: null }, now };
  assert.ok(compile('assignee:me').test(gh, ghCtx));
  assert.ok(compile('assignee:@jmwind').test(gh, ghCtx));
  assert.ok(compile('assignee:jmwind').test(gh, ghCtx));
  assert.ok(!compile('assignee:me').test(gh, { viewer: { id: 'other', login: 'other' }, now }));
  // a tracker whose id is not the login (a numeric account id, say) still resolves "me" by login
  const numeric = { ...issue, assignee: { id: 4711, login: 'jmwind', name: 'JM', displayName: 'jmwind', email: null } };
  assert.ok(compile('assignee:me').test(numeric, { viewer: { id: 'u-me', login: 'jmwind', email: null }, now }));
  assert.ok(!compile('assignee:me').test(numeric, { viewer: { id: 'u-me', login: 'someone', email: null }, now }));
});

test('tokenizer handles quotes, operators and parens', () => {
  const toks = tokenize('label:"needs review" and (priority>=2 or not team:DEV)');
  assert.deepEqual(toks.map((t) => t.t), ['word', 'op', 'value', 'and', '(', 'word', 'op', 'word', 'or', 'not', 'word', 'op', 'word', ')']);
});

test('label match is case-insensitive and any-of', () => {
  assert.equal(m('label:ai'), true);
  assert.equal(m('label:AI'), true);
  assert.equal(m('label:bug'), true);
  assert.equal(m('label:feature'), false);
  assert.equal(m('label!=feature'), true);
  assert.equal(m('tag:ai'), true);
});

test('project, team key and team name', () => {
  assert.equal(m('project:gustkit'), true);
  assert.equal(m('project:"Sea People"'), false);
  assert.equal(m('team:DEV'), true);
  assert.equal(m('team:development'), true);
  assert.equal(m('team:MAR'), false);
});

test('assignee me / none / name', () => {
  assert.equal(m('assignee:none'), true);
  assert.equal(m('assignee:me'), false);
  assert.equal(m('assignee:me', mine), true);
  assert.equal(m('assignee:none', mine), false);
  assert.equal(m('assignee:jml', mine), true);
  assert.equal(m('assignee!=me', mine), false);
  assert.equal(m('creator:alex'), true);
  assert.equal(m('creator:me'), false);
});

test('state by name or type', () => {
  assert.equal(m('state:todo'), true);
  assert.equal(m('state:unstarted'), true);
  assert.equal(m('state:started'), false);
  assert.equal(m('status:started', mine), true);
  assert.equal(m('not state:started'), true);
});

test('priority words and comparisons treat no-priority as lowest', () => {
  assert.equal(m('priority:high'), true);
  assert.equal(m('priority:2'), true);
  assert.equal(m('priority<=2'), true);   // urgent or high
  assert.equal(m('priority<=2', mine), false); // no priority is not <= high
  assert.equal(m('priority:none', mine), true);
  assert.equal(m('priority>=3'), false);
  assert.equal(m('priority>=3', mine), true);  // none counts as lower than low
});

test('title substring and glob, key, estimate, cycle', () => {
  assert.equal(m('title:crash'), true);
  assert.equal(m('title:*zoom*'), true);
  assert.equal(m('title:"zooming past"'), true);
  assert.equal(m('title:rocket'), false);
  assert.equal(m('key:DEV-123'), true);
  assert.equal(m('id:dev-1*'), true);
  assert.equal(m('estimate<=3'), true);
  assert.equal(m('estimate>3'), false);
  assert.equal(m('cycle:current'), true);
  assert.equal(m('cycle:7'), true);
  assert.equal(m('cycle:none', mine), true);
});

test('age and updated durations', () => {
  assert.equal(m('age>1d'), true);
  assert.equal(m('age>3d'), false);
  assert.equal(m('age>=48h'), true);
  assert.equal(m('updated<2h'), true);
  assert.equal(m('updated<30m'), false);
  assert.equal(m('age<1w'), true);
});

test('boolean combinators, implicit and, precedence, parens', () => {
  assert.equal(m('label:ai and team:DEV'), true);
  assert.equal(m('label:ai team:DEV'), true);          // implicit and
  assert.equal(m('label:ai team:MAR'), false);
  assert.equal(m('label:nope or team:DEV'), true);
  assert.equal(m('label:nope or team:MAR'), false);
  assert.equal(m('not label:ai'), false);
  assert.equal(m('not (label:ai and team:MAR)'), true);
  // and binds tighter than or
  assert.equal(m('label:nope and team:DEV or project:gustkit'), true);
  assert.equal(m('label:nope and (team:DEV or project:gustkit)'), false);
  assert.equal(m('any:true'), true);
});

test('the default gustkit rule', () => {
  const rule = 'label:ai and team:DEV and not state:started and not state:triage';
  assert.equal(m(rule), true);
  assert.equal(m(rule, { ...issue, state: { name: 'In Progress', type: 'started' } }), false);
  assert.equal(m(rule, { ...issue, labels: ['Bug'] }), false);
  assert.equal(m(rule, { ...issue, team: { key: 'MAR', name: 'Marketing' } }), false);
});

test('syntax errors are reported, unknown fields rejected at eval', () => {
  assert.throws(() => parse('label:'), SyntaxError);
  assert.throws(() => parse('(label:ai'), SyntaxError);
  assert.throws(() => parse('label:ai and'), SyntaxError);
  assert.throws(() => parse('label:"unterminated'), SyntaxError);
  assert.throws(() => parse('and label:ai'), SyntaxError);
  assert.throws(() => m('colour:blue'), /unknown field/);
});
