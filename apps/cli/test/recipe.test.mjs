// Recipes are pinned and results are checked: an upgrade is a decision that affects new tasks, a
// running task keeps its words and its policy, a result that does not check finishes nothing, and
// a merge happens only through the one route that verifies label, verdicts and head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TeamEngine, SqliteStore, createApplication, teamPaths, loadConfig, storePath } from '@weawr/engine';
import { LATEST_REVISION } from '@weawr/recipes';

const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));
const ISSUE = (over = {}) => ({ id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open', type: 'started' }, ...over });

function repo(config, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-recipe-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify(config));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const CONFIG = (over = {}) => ({ tracker: 'linear', roles: ['impl', 'review'], maxNudges: 6, defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: true }, onIdle: { comment: false, notify: false }, onMerged: { notify: true } }, rules: [{ name: 'impl', role: 'impl', match: 'any:true' }, { name: 'review', role: 'review', match: 'any:true', prompt: 'prompts/review-lead.md' }], ...over });

function fakeHerdr(repo, { gone = [] } = {}) {
  const started = new Set();
  return {
    prompts: [], started, notifications: [],
    agent: (name) => ({ agent: 'claude', name, agent_status: 'idle', cwd: repo, foreground_cwd: repo, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }),
    async agentGet(name) { return gone.includes(name) && !started.has(name) ? null : this.agent(name); },
    async prompt(name, text) { this.prompts.push({ name, text }); },
    async startAgent({ name }) { started.add(name); return {}; },
    async createWorkspace() { return { workspaceId: 'w2', tabId: 't2', paneId: 'p2' }; },
    // Working: a wait for it answers at once. Idle/done (the settle check after a brief): the agent kept working, so that wait runs out. Anything else parks the supervisor, as a live agent would.
    waitAgent(name, { until = [] } = {}) { return until.includes('working') ? Promise.resolve('working') : until.includes('idle') ? Promise.resolve('timeout') : new Promise(() => {}); },
    async readAgent() { return ''; },
    async notify(title, body) { this.notifications.push({ title, body }); },
    async closeWorkspace() {},
  };
}
function engine(dir, { store = SqliteStore.open(storePath(teamPaths(dir).stateDir)), herdr = fakeHerdr(dir, { gone: ['gh-7-impl-fac000', 'gh-7-review-fac000'] }), tracker = null, runs = null, version = '9.9.9' } = {}) {
  const paths = teamPaths(dir);
  if (runs) store.save({ runs, nudges: {} });
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  const e = new TeamEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: () => {}, version });
  return { e, store, herdr, rule: (n) => e.cfg.rules.find((r) => r.name === n) };
}
const brief = (run) => fs.readFileSync(path.join(run.dir, 'brief.md'), 'utf8');

test('a custom template with a typo, a missing result path, or a future protocol is refused at config load', () => {
  for (const [body, re] of [['Hi {{titel}} write {{resultPath}}', /\{\{titel\}\} is not a placeholder/], ['no result path here {{title}}', /\{\{resultPath\}\} is missing/], ['<!-- weawr-template: protocol=7 -->\n{{resultPath}}', /protocol 7.*upgrade weawr/]]) {
    const dir = repo(CONFIG(), { '.weawr/prompts/default.md': body });
    assert.throws(() => loadConfig({ paths: teamPaths(dir), promptsRoot: PROMPTS }), re);
  }
  const ok = repo(CONFIG(), { '.weawr/prompts/default.md': 'Legacy custom brief: {{title}} → {{resultPath}} {{nudgeLines}}' });
  const cfg = loadConfig({ paths: teamPaths(ok), promptsRoot: PROMPTS });
  assert.equal(cfg.rules[0].templateOrigin, 'repository'); assert.equal(cfg.rules[0].templateProtocol, 1);
  assert.equal(cfg.rules[1].templateOrigin, 'bundled');
});

test('a new team takes the latest recipe; a migrated one is pinned to 1; an upgrade moves new tasks only', async () => {
  const dir = repo(CONFIG());
  const { e, store, rule } = engine(dir);
  assert.equal(e.recipeRevision, LATEST_REVISION);
  // pin it back to 1, as a migrated legacy team is
  store.setMeta('recipe_revision', '1');
  const { e: one, herdr, rule: r1 } = engine(dir, { store, herdr: fakeHerdr(dir, { gone: ['gh-7-impl-fac000'] }) });
  assert.equal(one.recipeRevision, 1);
  await one.pickUp(ISSUE(), r1('impl'));
  const first = one.state.runs['GH-7@impl'];
  assert.equal(first.recipeRevision, 1);
  assert.match(brief(first), /Do not merge unless the issue says you may/, 'revision 1 words');
  assert.equal(store.attempts('GH-7@impl')[0].spec.recipe.revision, 1);
  // upgrade: a preview first, with a diff a person can read
  const preview = one.upgradeRecipe(2, { dryRun: true });
  assert.equal(preview.applied, false); assert.equal(one.recipeRevision, 1);
  assert.match(preview.templates.find((t) => t.name === 'default.md').diff, /^\+\s+\*\*Never merge the PR yourself\*\*/m);
  assert.ok(preview.changes.length >= 3);
  const done = one.upgradeRecipe(2);
  assert.equal(done.applied, true); assert.equal(one.recipeRevision, 2); assert.equal(store.meta('recipe_revision'), '2');
  // the existing task's next turn keeps revision 1, with fresh issue context
  fs.writeFileSync(first.resultPath, JSON.stringify({ status: 'needs_human', summary: 'q' }));
  first.status = 'done'; one.saveState();
  await one.pickUp(ISSUE({ title: 'Fix the thing (renamed)' }), r1('impl'), { pass: 2, holdsClaim: true });
  const second = one.state.runs['GH-7@impl'];
  assert.equal(second.recipeRevision, 1);
  assert.match(brief(second), /Do not merge unless the issue says you may/);
  assert.match(brief(second), /Fix the thing \(renamed\)/, 'current issue context');
  // a new task gets revision 2
  await one.pickUp(ISSUE({ id: 'i8', identifier: 'GH-8', ref: 'GH-8' }), r1('impl'));
  const fresh = one.state.runs['GH-8@impl'];
  assert.equal(fresh.recipeRevision, 2);
  assert.match(brief(fresh), /Never merge the PR yourself/);
  assert.match(brief(fresh), /weawr merge GH-8@impl/);
  assert.match(brief(fresh), /`auto-merge` label/);
  assert.equal(store.attempts('GH-8@impl')[0].spec.recipe.revision, 2);
  void e; void rule; void herdr;
});

test('a run keeps the policy it started under when its rule changes or disappears; reconfigure is explicit', async () => {
  const dir = repo(CONFIG());
  const { e, store, rule } = engine(dir);
  await e.pickUp(ISSUE(), rule('impl'));
  const run = e.state.runs['GH-7@impl'];
  assert.deepEqual(run.policy.onMerged, { notify: true });
  // the rule is edited under the run
  e.cfg.rules[0].onMerged = { notify: true, exitAgent: true, closeWorkspace: true };
  e.cfg.rules[0].agentKind = 'codex';
  assert.deepEqual(e.ruleFor(run).onMerged, { notify: true }, 'pinned');
  assert.equal(e.ruleFor(run).agentKind, 'claude', 'pinned');
  // …and removed altogether
  e.cfg.rules = e.cfg.rules.filter((r) => r.name !== 'impl');
  assert.equal(e.ruleFor(run).agentKind, 'claude'); assert.equal(e.ruleFor(run).name, 'impl'); assert.deepEqual(e.ruleFor(run).onMerged, { notify: true });
  assert.throws(() => e.reconfigure('GH-7@impl'), /not in the config any more/);
  // put it back, changed, and move the run explicitly
  e.cfg.rules.unshift({ ...rule('review'), name: 'impl', role: 'impl', agentKind: 'codex', onMerged: { notify: false } });
  const r = e.reconfigure('GH-7@impl');
  assert.ok(r.changed.includes('agentKind') && r.changed.includes('onMerged'));
  assert.equal(e.ruleFor(run).agentKind, 'codex');
  assert.ok(store.eventsAfter(0).some((ev) => ev.kind === 'run.reconfigured'));
});

test('a result that does not check is reported once and never finalized; a fixed one finishes the turn', async () => {
  const dir = repo(CONFIG());
  const { e, store, herdr, rule } = engine(dir);
  await e.pickUp(ISSUE(), rule('impl'));
  const run = e.state.runs['GH-7@impl'];
  fs.writeFileSync(run.resultPath, JSON.stringify({ status: 'done', prUrl: 42 }));
  assert.deepEqual(await e.readResult('GH-7@impl', run, e.ruleFor(run)), { invalid: true });
  assert.equal(run.status, 'running');
  assert.equal(herdr.notifications.length, 1); assert.match(herdr.notifications[0].body, /does not check/);
  assert.deepEqual(await e.readResult('GH-7@impl', run, e.ruleFor(run)), { invalid: true });
  assert.equal(herdr.notifications.length, 1, 'the same broken file is reported once');
  assert.ok(store.eventsAfter(0).some((ev) => ev.kind === 'run.result_invalid'));
  // a newer schema than this weawr knows is refused too, not guessed at
  fs.writeFileSync(run.resultPath, JSON.stringify({ status: 'pr_open', schemaVersion: 99 }));
  assert.deepEqual(await e.readResult('GH-7@impl', run, e.ruleFor(run)), { invalid: true });
  assert.equal(herdr.notifications.length, 2);
  // half-written: nothing yet
  fs.writeFileSync(run.resultPath, '{"status": "pr_op');
  assert.equal(await e.readResult('GH-7@impl', run, e.ruleFor(run)), null);
  // fixed
  fs.writeFileSync(run.resultPath, JSON.stringify({ status: 'needs_human', summary: 'a question' }));
  const read = await e.readResult('GH-7@impl', run, e.ruleFor(run));
  assert.equal(read.result.status, 'needs_human'); assert.equal(run.invalidResult, undefined);
  // and `weawr result` hands one in, checked and whole
  assert.throws(() => e.submitResult('GH-7@impl', { status: 'nope' }), /does not check/);
  const ok = e.submitResult('GH-7@impl', { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1' });
  assert.equal(JSON.parse(fs.readFileSync(ok.path, 'utf8')).status, 'pr_open');
  assert.equal(fs.readdirSync(path.dirname(ok.path)).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('when the last reviewer approves the current head and the label is on, the coordinator asks the implementer to merge, once per head', async () => {
  // Reproduced in the squad demo: both reviewers approved, the issue carried auto-merge, and the
  // implementer's session sat idle — a verdict is a comment, and nothing woke it to run the merge.
  const dir = repo(CONFIG());
  const calls = [];
  const gh = { state: 'open', head: 'abcdef1234567', conflicts: false, labels: ['ai', 'auto-merge'] };
  const tracker = { async me() { return { id: 'me' }; }, async issueByKey(k) { return ISSUE({ identifier: k, labels: gh.labels }); }, async comment(id, body) { calls.push(['comment', body]); }, async addLabel() {}, async removeLabel() {}, async assign() {}, async setState() {} };
  const fetchImpl = async () => new Response(JSON.stringify({ state: gh.state, merged: false, head: { sha: gh.head }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean' }), { status: 200 });
  const prUrl = 'https://github.com/o/r/pull/9';
  const runs = {
    'GH-7@impl': { rule: 'impl', role: 'impl', pass: 1, status: 'awaiting_merge', issueId: 'i7', issueKey: 'GH-7', title: 't', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z', agentName: 'gh-7-impl', workspaceId: 'w1', prUrl, result: { status: 'pr_open', prUrl }, notified: {}, worktree: 'none', workDir: dir, dir: path.join(dir, '.weawr', 'state', 'runs', 'GH-7@impl'), resultPath: path.join(dir, '.weawr', 'state', 'runs', 'GH-7@impl', 'result.json'), briefPath: path.join(dir, '.weawr', 'state', 'runs', 'GH-7@impl', 'brief.md') },
    'GH-7@review': { rule: 'review', role: 'review', pass: 1, status: 'done', issueId: 'i7', issueKey: 'GH-7', title: 't', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T02:00:00Z', agentName: 'gh-7-review', workspaceId: 'w2', result: { status: 'nothing_to_do', review: { verdict: 'approved', prUrl, headSha: 'abcdef1' } }, notified: {}, worktree: 'none', workDir: dir },
  };
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir)); store.save({ runs, nudges: {} });
  const e = new TeamEngine({ cfg: loadConfig({ paths, promptsRoot: PROMPTS }), tracker, herdr: fakeHerdr(dir), paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: () => {}, fetchImpl });
  e.pr = { host: 'github.com', token: 'tok' };
  await e.askForMergeIfReady('GH-7');
  const asks = calls.filter((c) => c[0] === 'comment' && /Weawr Coordinator/.test(c[1]) && /asking `impl` to run `weawr merge GH-7@impl`/.test(c[1]));
  assert.equal(asks.length, 1, calls.map((c) => c[1]).join('\n---\n'));
  assert.ok(e.state.nudges['GH-7'].some((n) => n.from === 'coordinator' && n.outcome === 'merge' && n.head === 'abcdef1234567'), 'the ask is on the trail, with its head, without spending the agents\' budget');
  // Asked once per head: a second look, same head, asks nothing more.
  await e.askForMergeIfReady('GH-7');
  assert.equal(calls.filter((c) => c[0] === 'comment' && /asking `impl`/.test(c[1])).length, 1);
  // Not ready — the reviewer's approval is for another head — asks nothing.
  gh.head = 'fffffff000000';
  await e.askForMergeIfReady('GH-7');
  assert.equal(calls.filter((c) => c[0] === 'comment' && /asking `impl`/.test(c[1])).length, 1);
});

test('merge: the label now, every reviewer\'s structured approval of the current head, an open mergeable PR — and nothing less', async () => {
  const dir = repo(CONFIG());
  const calls = [];
  const gh = { state: 'open', head: 'abcdef1234567', conflicts: false, labels: ['ai'] };
  const tracker = {
    async me() { return { id: 'me' }; },
    async issueByKey(k) { return ISSUE({ identifier: k, labels: gh.labels }); },
    async comment(id, body) { calls.push(['comment', body]); },
    async addLabel() {}, async removeLabel() {}, async assign() {}, async setState() {},
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method || 'GET', url, init.body ? JSON.parse(init.body) : null]);
    if (init.method === 'PUT') return new Response(JSON.stringify({ merged: true, sha: 'merged123' }), { status: 200 });
    return new Response(JSON.stringify({ state: gh.state, merged: false, head: { sha: gh.head }, base: { ref: 'main' }, mergeable: !gh.conflicts, mergeable_state: gh.conflicts ? 'dirty' : 'clean' }), { status: 200 });
  };
  const prUrl = 'https://github.com/o/r/pull/9';
  const runs = {
    'GH-7@impl': { rule: 'impl', role: 'impl', pass: 1, status: 'awaiting_merge', issueId: 'i7', issueKey: 'GH-7', title: 't', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z', agentName: 'gh-7-impl', notified: {}, worktree: 'none', workDir: dir, prUrl, result: { status: 'pr_open', prUrl } },
    'GH-7@review': { rule: 'review', role: 'review', pass: 1, status: 'done', issueId: 'i7', issueKey: 'GH-7', title: 't', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T02:00:00Z', agentName: 'gh-7-review', notified: {}, worktree: 'none', result: { status: 'nothing_to_do', summary: 'OK TO MERGE TO MAIN — fine' } },
  };
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir)); store.save({ runs, nudges: {} });
  const e = new TeamEngine({ cfg: loadConfig({ paths, promptsRoot: PROMPTS }), tracker, herdr: fakeHerdr(dir), paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: () => {}, fetchImpl });
  e.pr = { host: 'github.com', token: 'tok' };
  const app = createApplication(e);
  const attempt = () => app.dispatch({ type: 'run.merge', key: 'GH-7@impl' }).then((r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; });
  // 1. no label
  let r = await attempt();
  assert.equal(r.merged, false); assert.match(r.reason, /does not carry the auto-merge label/);
  // 2. label, but a legacy prose verdict names no head
  gh.labels = ['ai', 'auto-merge'];
  r = await attempt();
  assert.equal(r.merged, false); assert.match(r.reason, /prose verdict.*names no head/);
  // 3. a structured approval of another head
  e.state.runs['GH-7@review'].result = { status: 'nothing_to_do', review: { verdict: 'approved', prUrl, headSha: '9999999' } };
  r = await attempt();
  assert.equal(r.merged, false); assert.match(r.reason, /approved 9999999, but the PR is now at abcdef1/);
  // 4. changes requested for the right head
  e.state.runs['GH-7@review'].result = { status: 'needs_human', review: { verdict: 'changes_requested', prUrl, headSha: 'abcdef1' } };
  r = await attempt();
  assert.equal(r.merged, false); assert.match(r.reason, /review: changes_requested/);
  // 5. approved for the right head, but conflicts
  e.state.runs['GH-7@review'].result = { status: 'nothing_to_do', review: { verdict: 'approved', prUrl, headSha: 'abcdef1' } };
  gh.conflicts = true;
  r = await attempt();
  assert.equal(r.merged, false); assert.match(r.reason, /conflicts/);
  assert.ok(!calls.some((c) => c[0] === 'PUT'), 'GitHub was never asked to merge');
  assert.equal(store.eventsAfter(0).filter((ev) => ev.kind === 'run.merge_refused').length, 5, 'every refusal was recorded');
  // 6. everything in order: merged, guarded by the head, said on the issue, recorded
  gh.conflicts = false;
  r = await attempt();
  assert.equal(r.merged, true, r.reason);
  const put = calls.find((c) => c[0] === 'PUT');
  assert.ok(put && put[1].endsWith('/repos/o/r/pulls/9/merge'), 'GitHub was asked to merge the PR');
  assert.deepEqual(put[2], { merge_method: 'squash', sha: 'abcdef1234567' }, 'guarded by the head that was approved');
  assert.match(calls.find((c) => c[0] === 'comment')[1], /merged https:\/\/github.com\/o\/r\/pull\/9 \(squash\) at `abcdef1`/);
  assert.ok(store.eventsAfter(0).some((ev) => ev.kind === 'run.merge_requested'));
  assert.equal(e.state.runs['GH-7@impl'].mergedBy, 'cli');
  // 7. the same request again is one merge, replayed
  const r1 = await app.dispatch({ type: 'run.merge', key: 'GH-7@impl', requestId: 'm1' });
  const r2 = await app.dispatch({ type: 'run.merge', key: 'GH-7@impl', requestId: 'm1' });
  assert.equal(r2.result.replayed, true); assert.equal(r2.result.operationId, r1.result.operationId);
});
