// `weawr demo`: every shipped scenario is a team that loads, with briefs that check; the
// starter app the scenarios file issues against passes its own tests; the issues are filed and
// reset through the GitHub API in the shapes it uses — all without a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteStore, teamPaths, loadConfig, storePath } from '@weawr/engine';
import { GitHubTracker } from '@weawr/engine/adapters/trackers/github.mjs';
import { validateTemplate } from '@weawr/recipes';
import { defaultDemoDir, fileIssues, listScenarios, parseOpts, pushStarter, readLedger, resetLocal, resetRemote, restoreStarter, writeScenario } from '../build/commands/demo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'dist', 'weawr.mjs');
const DEMOS = path.join(HERE, '..', 'demos');
const PROMPTS = path.join(HERE, '..', '..', '..', 'packages', 'recipes', 'prompts');

const tmp = (t, prefix = 'weawr-demo-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A fetch whose replies come from `route(call)`; records every call. */
function fakeFetch(route) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = route(call) ?? { json: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.json ?? {}), json: async () => r.json };
  };
  f.calls = calls;
  return f;
}
const tracker = (route) => new GitHubTracker('ghp_test', { options: { repo: 'jmwind/weawr-demo' }, fetchImpl: fakeFetch(route) });

const scenarios = listScenarios(DEMOS);

test('the scenarios ship, each with a title, a summary, issues, and rules', () => {
  assert.deepEqual(scenarios.map((s) => s.name), ['bake-off', 'basic', 'basic-auto', 'squad']);
  for (const s of scenarios) {
    assert.ok(s.title && s.summary && s.description, `${s.name} describes itself`);
    assert.ok(s.issues.length >= 1, `${s.name} files at least one issue`);
    assert.ok(s.config.rules.length >= 1, `${s.name} has rules`);
    for (const i of s.issues) assert.ok(i.labels.includes('ai'), `${s.name}: every issue carries the ai label so a rule matches it`);
    for (const i of s.issues) for (const l of i.labels) if (['ready-for-review', 'auto-merge', 'bake-off'].includes(l)) assert.ok(s.labels.includes(l), `${s.name}: label ${l} is created before it is used`);
  }
});

test('every scenario writes a team that loads, on GitHub, with its briefs checking as templates', (t) => {
  for (const s of scenarios) {
    const repo = tmp(t, `weawr-demo-${s.name}-`);
    git(repo, ['init', '-q']);
    const paths = teamPaths(repo);
    writeScenario(paths, s, 'jmwind/weawr-demo');
    assert.ok(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('.weawr/'), `${s.name}: the scenario is kept out of the repository`);
    const written = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
    assert.deepEqual(written.tracker, { type: 'github', repo: 'jmwind/weawr-demo' });
    const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
    assert.equal(cfg.Tracker.id, 'github', s.name);
    // GitHub has no workflow states: a Linear-shaped state would make the first pickup throw.
    for (const r of cfg.rules) { assert.equal(r.onPickup.state, null, `${s.name}/${r.name}`); assert.equal(r.onDone.state, null, `${s.name}/${r.name}`); }
    for (const f of fs.existsSync(path.join(paths.configDir, 'prompts')) ? fs.readdirSync(path.join(paths.configDir, 'prompts')) : []) {
      const check = validateTemplate(fs.readFileSync(path.join(paths.configDir, 'prompts', f), 'utf8'));
      assert.deepEqual(check.problems, [], `${s.name}/prompts/${f}: ${check.problems.join('; ')}`);
    }
  }
});

test('squad: reviewers are cut from the developer\'s branch and dispatched by the label the developer is told to add', () => {
  const s = scenarios.find((x) => x.name === 'squad');
  const reviewers = s.config.rules.filter((r) => r.role !== 'dev');
  assert.equal(reviewers.length, 2);
  for (const r of reviewers) { assert.equal(r.basedOn, 'dev'); assert.match(r.match, /label:ready-for-review/); assert.ok(r.passes >= 2); }
  assert.notEqual(reviewers[0].agentKind || 'claude', reviewers[1].agentKind || 'claude', 'a second opinion is another provider');
  assert.match(fs.readFileSync(path.join(s.dir, 'instructions-dev.md'), 'utf8'), /--add-label ready-for-review/);
});

test('bake-off: two developers on different models and a judge that starts with them; nudges enough for two rounds', () => {
  const s = scenarios.find((x) => x.name === 'bake-off');
  const [a, b, judge] = ['dev-a', 'dev-b', 'judge'].map((role) => s.config.rules.find((r) => r.role === role));
  assert.ok(a && b && judge);
  assert.equal(a.match, b.match); assert.equal(judge.match, a.match, 'the judge holds the issue from the start, so the developers can nudge it');
  assert.notEqual(a.model, b.model);
  assert.ok(s.config.maxNudges >= 10, 'two rounds of judge→devs→judge take ten nudges');
  const brief = fs.readFileSync(path.join(s.dir, 'prompts', 'bake-off-judge.md'), 'utf8');
  for (const p of ['{{resultPath}}', '{{nudgeLines}}', '{{runLines}}', 'gh pr ready', 'gh pr close']) assert.ok(brief.includes(p), `judge brief has ${p}`);
  assert.match(fs.readFileSync(path.join(s.dir, 'instructions-dev.md'), 'utf8'), /--draft/);
});

test('basic-auto: every issue carries auto-merge, the gate is cut from the developer\'s branch and only runs tests', () => {
  const s = scenarios.find((x) => x.name === 'basic-auto');
  for (const i of s.issues) assert.ok(i.labels.includes('auto-merge'), i.title);
  const gate = s.config.rules.find((r) => r.role === 'ci');
  assert.equal(gate.basedOn, 'dev'); assert.match(gate.match, /ready-for-review/); assert.equal(gate.effort, 'low');
  const brief = fs.readFileSync(path.join(s.dir, 'prompts', 'ci-gate.md'), 'utf8');
  for (const p of ['{{resultPath}}', '{{nudgeLines}}', '{{runLines}}', '{{worktree}}', 'changes_requested']) assert.ok(brief.includes(p), `gate brief has ${p}`);
  assert.match(fs.readFileSync(path.join(s.dir, 'instructions-dev.md'), 'utf8'), /--add-label ready-for-review/);
});

test('the starter app passes its own tests and runs', (t) => {
  const dir = tmp(t, 'tally-');
  fs.cpSync(path.join(DEMOS, 'starter'), dir, { recursive: true });
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const env = { ...process.env, TALLY_FILE: path.join(dir, 't.json') };
  assert.equal(execFileSync(process.execPath, ['bin/tally.mjs', 'add', 'coffee', '2'], { cwd: dir, env, encoding: 'utf8' }).trim(), 'coffee: 2');
});

test('the starter is committed and pushed to a repository that has none', (t) => {
  const bare = tmp(t, 'weawr-demo-origin-'); git(bare, ['init', '-q', '--bare', '-b', 'main']);
  const clone = tmp(t, 'weawr-demo-clone-'); git(clone, ['init', '-q', '-b', 'main']); git(clone, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(clone, 'README.md'), '# demo\n'); git(clone, ['add', '-A']); git(clone, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'readme']); git(clone, ['push', '-q', 'origin', 'main']);
  const lines = [];
  pushStarter(clone, path.join(DEMOS, 'starter'), (m) => lines.push(m));
  assert.ok(fs.existsSync(path.join(clone, 'package.json')));
  assert.match(git(bare, ['ls-tree', '--name-only', 'main']), /package\.json/);
  assert.match(git(bare, ['ls-tree', '--name-only', 'main']), /AGENTS\.md/);
});

test('reset puts main back to the starter with a new commit, and says so when it already is', (t) => {
  const bare = tmp(t, 'weawr-demo-origin-'); git(bare, ['init', '-q', '--bare', '-b', 'main']);
  const clone = tmp(t, 'weawr-demo-clone-'); git(clone, ['clone', '-q', bare, '.']); git(clone, ['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(clone, 'README.md'), '# demo\n'); git(clone, ['add', '-A']); git(clone, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'readme']); git(clone, ['push', '-q', '-u', 'origin', 'main']);
  git(clone, ['remote', 'set-head', 'origin', 'main']);
  pushStarter(clone, path.join(DEMOS, 'starter'), () => {});
  // A demo merged a feature: a file changed, a file added.
  fs.appendFileSync(path.join(clone, 'src', 'store.mjs'), '\nexport const top = () => [];\n'); fs.writeFileSync(path.join(clone, 'test', 'top.test.mjs'), '');
  git(clone, ['add', '-A']); git(clone, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'feature']); git(clone, ['push', '-q', 'origin', 'main']);
  const lines = [];
  restoreStarter(clone, path.join(DEMOS, 'starter'), (m) => lines.push(m));
  assert.match(lines.join('\n'), /put back to the starter/);
  const tree = git(bare, ['ls-tree', '-r', '--name-only', 'main']).split('\n').sort();
  assert.ok(!tree.includes('test/top.test.mjs'), 'the added file is gone');
  assert.equal(git(bare, ['show', 'main:src/store.mjs']), fs.readFileSync(path.join(DEMOS, 'starter', 'src', 'store.mjs'), 'utf8'), 'the changed file is the starter\'s again');
  assert.match(git(bare, ['log', '--oneline', 'main']), /Demo reset: the app back to the starter\n.*feature/s, 'a new commit on top; the feature stays in history');
  lines.length = 0;
  restoreStarter(clone, path.join(DEMOS, 'starter'), (m) => lines.push(m));
  assert.match(lines.join('\n'), /is the starter already/);
});

test('filing writes the issues in order and the ledger remembers their numbers', async () => {
  let n = 40;
  const t = tracker(({ method, url }) => (method === 'POST' && url.endsWith('/issues') ? { status: 201, json: { number: ++n, html_url: `https://github.com/jmwind/weawr-demo/issues/${n}` } } : null));
  const s = scenarios.find((x) => x.name === 'basic');
  const filed = await fileIssues(t, s.issues);
  assert.deepEqual(filed.map((f) => f.number), [41, 42]);
  assert.equal(filed[0].title, s.issues[0].title);
  assert.deepEqual(t.fetch.calls.map((c) => c.body.labels), s.issues.map((i) => i.labels));
});

test('reset closes the ledger\'s issues, their PRs and branches, strips the claim labels, and touches nothing else', async () => {
  const ledger = { scenario: 'basic', repo: 'jmwind/weawr-demo', createdAt: 'x', issues: [{ number: 41, title: 'a', url: 'u' }] };
  const t = tracker(({ method, url }) => {
    if (method === 'GET' && url.endsWith('/repos/jmwind/weawr-demo')) return { json: { default_branch: 'main' } };
    if (method === 'GET' && url.includes('/pulls?')) return { json: [{ number: 9, head: { ref: '41-fix-the-thing' }, body: 'Fixes #41' }, { number: 10, head: { ref: '99-unrelated' }, body: 'Fixes #99' }] };
    if (method === 'GET' && url.includes('/branches?')) return { json: [{ name: 'main' }, { name: '41-fix-the-thing' }, { name: '41-fix-the-thing-review' }, { name: '99-unrelated' }] };
    if (method === 'GET' && url.endsWith('/issues/41')) return { json: { number: 41, state: 'open', labels: [{ name: 'ai' }, { name: 'herdr' }, { name: 'herdr:review' }] } };
    if (method === 'GET' && url.includes('/labels/')) return { json: {} };
    return { json: {} };
  });
  const out = await resetRemote(t, ledger);
  assert.deepEqual(out, { issues: 1, prs: 1, branches: 2 });
  const calls = t.fetch.calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com/repos/jmwind/weawr-demo', '')}`);
  assert.ok(calls.includes('PATCH /pulls/9'), 'the demo PR is closed');
  assert.ok(!calls.includes('PATCH /pulls/10'), 'an unrelated PR is left alone');
  assert.ok(calls.includes('DELETE /git/refs/heads/41-fix-the-thing') && calls.includes('DELETE /git/refs/heads/41-fix-the-thing-review'));
  assert.ok(!calls.some((c) => c.includes('99-unrelated')));
  assert.ok(calls.includes('DELETE /issues/41/labels/herdr') && calls.includes('DELETE /issues/41/labels/herdr%3Areview'));
  assert.ok(calls.includes('PATCH /issues/41'));
});

test('the local reset closes the runs\' workspaces, sets the state aside, removes worktrees, and forgets the registration', async (t) => {
  const repo = tmp(t, 'weawr-demo-local-');
  git(repo, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repo, 'a'), 'a'); git(repo, ['add', '-A']); git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'a']);
  const paths = teamPaths(repo);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const store = SqliteStore.open(storePath(paths.stateDir));
  store.save({ runs: { 'GH-1@dev': { status: 'running', workspaceId: 'w7', workspaceLabel: 'GH-1 dev x', agentName: 'gh-1-dev' }, 'GH-2': { status: 'done', workspaceId: null } }, nudges: {} });
  store.close();
  fs.mkdirSync(path.join(paths.configDir, 'worktrees'), { recursive: true });
  git(repo, ['worktree', 'add', '-q', path.join(paths.configDir, 'worktrees', 'gh-1'), '-b', '1-x']);
  const userDir = tmp(t, 'weawr-user-');
  const closed = [];
  const ctx = { userDir, ids: { hostId: 'h' }, herdr: { async closeWorkspaceOf(id, owner) { closed.push([id, owner.label]); return 'closed'; }, async closeWorkspace(id) { closed.push([id, 'watch']); } } };
  const lines = [];
  await resetLocal(ctx, paths, (m) => lines.push(m));
  assert.deepEqual(closed, [['w7', 'GH-1 dev x']], 'the running run\'s workspace is closed through the owner check; a run with none is skipped');
  assert.ok(!fs.existsSync(paths.stateDir));
  assert.ok(fs.readdirSync(paths.configDir).some((d) => d.startsWith('state.reset-')), 'the state is set aside, not deleted');
  assert.ok(!fs.existsSync(path.join(paths.configDir, 'worktrees')));
  assert.doesNotMatch(git(repo, ['worktree', 'list']), /gh-1/);
});

test('options: --into, --repo, --dry-run; an unknown option is refused; the default directory is per user and repo', () => {
  const o = parseOpts(['--into', '/tmp/x', '--repo', 'me/demo', '--dry-run']);
  assert.deepEqual(o, { into: '/tmp/x', repo: 'me/demo', dryRun: true, yes: false, all: false, keepCode: false });
  assert.throws(() => parseOpts(['--repo', 'nope']), /owner\/name/);
  assert.throws(() => parseOpts(['--bogus']), /unknown option/);
  assert.equal(defaultDemoDir('/u', 'jmwind/weawr-demo'), '/u/demos/weawr-demo');
});

test('the command: list needs no team, and --dry-run files nothing', (t) => {
  const nowhere = tmp(t, 'weawr-nowhere-');
  const run = (args) => spawnSync(process.execPath, [BIN, 'demo', ...args], { cwd: nowhere, encoding: 'utf8', env: { ...process.env, WEAWR_NO_UPDATE_CHECK: '1' } });
  const list = run(['list']);
  assert.equal(list.status, 0, list.stderr);
  for (const s of ['basic', 'squad', 'bake-off']) assert.ok(list.stdout.includes(s), `lists ${s}`);
  const dry = run(['squad', '--dry-run', '--into', path.join(nowhere, 'f')]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would clone https:\/\/github.com\/jmwind\/weawr-demo/);
  assert.match(dry.stdout, /tally top/);
  assert.ok(!fs.existsSync(path.join(nowhere, 'f')));
  const bad = run(['nope']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no demo scenario "nope"/);
  assert.equal(readLedger(teamPaths(nowhere)), null);
});
