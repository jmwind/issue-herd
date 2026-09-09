// Plugins: where they may come from, what they may provide, and the three seams end to end —
// a tracker from a plugin feeding a pickup, a role preset becoming a rule with its own brief, a
// scheduled task run when due with the snapshot and its own memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPlugins, parseEvery, resolvePlugin, PLUGIN_API } from '../dist/plugins.js';
import { loadConfig, pluginSpecs } from '../dist/config.js';
import { factoryPaths } from '../dist/paths.js';
import { FactoryEngine } from '../dist/factory.js';

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../../../apps/cli/plugins', import.meta.url));

function repo(config, local = null, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-plugins-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify(config));
  if (local) fs.writeFileSync(path.join(dir, '.weawr', 'config.local.json'), JSON.stringify(local));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sources = (dir) => ({ examplesRoot: EXAMPLES, userRoot: path.join(dir, 'userplugins'), configDir: path.join(dir, '.weawr') });

test('a path is honoured only from config.local.json; a name is a shipped example or an installed package; nothing else loads', async () => {
  const dir = repo({ tracker: 'linear', plugins: ['./plugins/mine.mjs', 'examples/nope', 'not-installed'], rules: [{ name: 'r', match: 'any:true' }] }, { plugins: ['./plugins/mine.mjs', 'examples/waiting-nudge'] },
    { '.weawr/plugins/mine.mjs': "export default { name: 'mine', version: '0.1.0', tasks: [{ name: 't', every: '1h', run() {} }] };" });
  const specs = pluginSpecs(factoryPaths(dir));
  assert.deepEqual(specs.map((s) => [s.spec, s.source]), [['./plugins/mine.mjs', 'config'], ['examples/nope', 'config'], ['not-installed', 'config'], ['./plugins/mine.mjs', 'local'], ['examples/waiting-nudge', 'local']]);
  assert.match(resolvePlugin(specs[0], sources(dir)).error, /only honoured from \.weawr\/config\.local\.json/);
  assert.match(resolvePlugin(specs[1], sources(dir)).error, /no shipped example plugin called "nope" \(have: docs-review, file-intake, waiting-nudge\)/);
  assert.match(resolvePlugin(specs[2], sources(dir)).error, /is not installed/);
  assert.equal(resolvePlugin(specs[3], sources(dir)).from, 'config.local.json');
  const reg = await loadPlugins(specs, sources(dir));
  assert.deepEqual(reg.plugins.map((p) => [p.name, p.from]), [['mine', 'config.local.json'], ['waiting-nudge', 'shipped example']]);
  assert.equal(reg.problems.length, 3);
  assert.deepEqual(reg.tasks.map((t) => [t.plugin, t.name, t.everyMs]), [['mine', 't', 3_600_000], ['waiting-nudge', 'long-waits', 900_000]]);
  // an installed package
  const pkg = path.join(dir, 'userplugins', 'node_modules', 'weawr-plugin-x');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'weawr-plugin-x', version: '2.0.0', main: 'index.mjs' }));
  fs.writeFileSync(path.join(pkg, 'index.mjs'), "export default { name: 'x', version: '2.0.0', roles: { qa: { prompt: 'Test it. {{resultPath}} {{nudgeLines}}' } } };");
  const more = await loadPlugins([{ spec: 'weawr-plugin-x', source: 'config' }], sources(dir));
  assert.equal(more.plugins[0].from, '~/.config/weawr/plugins (2.0.0)'); assert.ok(more.roles.qa);
  // what a plugin may not do
  const bad = await loadPlugins([{ spec: './plugins/bad.mjs', source: 'local' }], sources(repo({ tracker: 'linear', rules: [] }, null, { '.weawr/plugins/bad.mjs': "export default { name: 'bad', api: 9, roles: { 'Bad Role': { prompt: 'x' } } };" })));
  assert.match(bad.problems[0], /needs plugin API 9; this weawr provides 1/);
  const bad2 = await loadPlugins([{ spec: './plugins/bad2.mjs', source: 'local' }], sources(repo({ tracker: 'linear', rules: [] }, null, { '.weawr/plugins/bad2.mjs': "export default { name: 'bad2', roles: { docs: { prompt: 'no result path {{titel}}' } }, tasks: [{ name: 'z', every: 'sometimes', run() {} }], intake: [class { static id = 'half'; async me() {} }] };" })));
  assert.match(bad2.problems.join('\n'), /role preset docs: \{\{titel\}\} is not a placeholder/);
  assert.match(bad2.problems.join('\n'), /task z: "every" must look like/);
  assert.match(bad2.problems.join('\n'), /tracker half lacks openIssues\(\)/);
  assert.equal(PLUGIN_API, 1); assert.equal(parseEvery('2d'), 172_800_000);
});

test('intake from a plugin: the file tracker feeds a pickup, and the claim goes back into the file', async () => {
  const dir = repo({ tracker: 'file', plugins: ['examples/file-intake'], roles: ['impl'], defaults: { worktree: 'none', onPickup: { comment: true, assignToMe: true, state: 'in progress' }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: false, notify: false } }, rules: [{ name: 'impl', role: 'impl', match: 'label:ai' }] }, null,
    { '.weawr/issues.json': JSON.stringify([{ id: 1, title: 'Add a thing', labels: ['ai'] }, { id: 2, title: 'Not for us', labels: [] }]) });
  const paths = factoryPaths(dir);
  const reg = await loadPlugins(pluginSpecs(paths), sources(dir));
  assert.deepEqual(reg.problems, []);
  // without the plugin the config is an error that says why
  assert.throws(() => loadConfig({ paths, promptsRoot: PROMPTS }), /unknown tracker "file".*not enabled on this machine/);
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS, plugins: reg });
  assert.equal(cfg.Tracker.id, 'file'); assert.equal(cfg.Tracker.plugin, 'file-intake');
  const tracker = new cfg.Tracker({ token: 'none' }, { options: { ...cfg.trackerSpec, cwd: dir } });
  tracker.check();
  const started = new Set();
  const herdr = { async agentGet(n) { return started.has(n) ? { name: n, agent_status: 'idle', cwd: dir, workspace_id: 'w' } : null; }, async prompt() {}, async startAgent({ name }) { started.add(name); return {}; }, async createWorkspace() { return { workspaceId: 'w', tabId: 't', paneId: 'p' }; }, waitAgent(n, { until = [] } = {}) { return until.includes('working') ? Promise.resolve('working') : until.includes('idle') ? Promise.resolve('timeout') : new Promise(() => {}); }, async readAgent() { return ''; }, async notify() {} };
  const e = new FactoryEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, ids: { hostId: 'h', factoryId: 'f' }, log: () => {} });
  const r = await e.pollOnce();
  assert.deepEqual(r.picked, ['F-1@impl']); assert.equal(r.scanned, 2);
  const file = JSON.parse(fs.readFileSync(path.join(dir, '.weawr', 'issues.json'), 'utf8'));
  assert.deepEqual(file[0].labels, ['ai', 'herdr:impl'], 'the claim label went into the file');
  assert.equal(file[0].state, 'in progress'); assert.equal(file[0].assignee, 'weawr');
  assert.match(file[0].comments[0].body, /picked this up as `impl`/);
  assert.equal(file[1].comments, undefined);
  assert.equal((await e.pollOnce()).picked.length, 0, 'claimed: not taken twice');
});

test('a role preset from a plugin becomes a rule with the plugin\'s brief and defaults, recorded on the attempt', async () => {
  const dir = repo({ tracker: 'linear', plugins: ['examples/docs-review'], roles: ['impl', 'docs'], defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: false, notify: false } },
    rules: [{ name: 'impl', role: 'impl', match: 'any:true' }, { name: 'docs-check', use: 'docs', match: 'any:true', effort: 'high', basedOn: null }] });
  const paths = factoryPaths(dir);
  const reg = await loadPlugins(pluginSpecs(paths), sources(dir));
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS, plugins: reg });
  const rule = cfg.rules[1];
  assert.equal(rule.role, 'docs'); assert.equal(rule.passes, 3, 'the preset\'s default');
  assert.equal(rule.basedOn, null, 'the rule\'s own field wins over the preset (basedOn needs a self worktree, which this fixture has not)');
  assert.equal(rule.effort, 'high', 'the rule\'s own field wins over the preset');
  assert.equal(rule.prompt, 'plugin:docs-review/docs'); assert.equal(rule.templateOrigin, 'plugin:docs-review@1.0.0');
  assert.match(rule.promptText, /documentation reviewer/);
  assert.throws(() => loadConfig({ paths, promptsRoot: PROMPTS, plugins: { ...reg, roles: {} } }), /"use" is "docs", which no enabled plugin provides/);
  // a pickup renders the plugin's brief
  const started = new Set();
  const herdr = { async agentGet(n) { return started.has(n) ? { name: n, agent_status: 'idle', cwd: dir, workspace_id: 'w' } : null; }, async prompt() {}, async startAgent({ name }) { started.add(name); return {}; }, async createWorkspace() { return { workspaceId: 'w', tabId: 't', paneId: 'p' }; }, waitAgent(n, { until = [] } = {}) { return until.includes('working') ? Promise.resolve('working') : until.includes('idle') ? Promise.resolve('timeout') : new Promise(() => {}); }, async readAgent() { return ''; }, async notify() {} };
  const { SqliteStore, storePath } = await import('../dist/store/sqlite.js');
  const store = SqliteStore.open(storePath(paths.stateDir));
  const e = new FactoryEngine({ cfg, tracker: null, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', factoryId: 'f' }, log: () => {} });
  const issue = { id: 'i1', identifier: 'GH-1', ref: 'GH-1', title: 'T', description: '', url: 'u', labels: [], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open' } };
  await e.pickUp(issue, rule);
  const brief = fs.readFileSync(e.state.runs['GH-1@docs'].briefPath, 'utf8');
  assert.match(brief, /# Docs review of Linear issue GH-1: T/);
  assert.match(brief, /Working with the other roles/, 'nudging is taught: the preset carries {{nudgeLines}}');
  assert.equal(store.attempts('GH-1@docs')[0].spec.recipe.templateOrigin, 'plugin:docs-review@1.0.0');
  store.close();
});

test('a scheduled task runs when due, with the snapshot, and keeps what it returned', async () => {
  const dir = repo({ tracker: 'linear', roles: ['impl'], defaults: { worktree: 'none' }, rules: [{ name: 'impl', role: 'impl', match: 'any:true' }] }, { plugins: ['examples/waiting-nudge', './plugins/count.mjs'] },
    { '.weawr/plugins/count.mjs': "export default { name: 'count', tasks: [{ name: 'runs', every: '10m', run({ snapshot, memory }) { return { n: (memory.n || 0) + 1, tasks: snapshot.issues.length }; } }, { name: 'boom', every: '1s', run() { throw new Error('kaput'); } }] };" });
  const paths = factoryPaths(dir);
  const reg = await loadPlugins(pluginSpecs(paths), sources(dir));
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS, plugins: reg });
  const notes = []; const logs = [];
  let now = Date.parse('2026-09-09T10:00:00Z');
  const herdr = { async run() { return { result: { snapshot: { agents: [], workspaces: [], panes: [] } } }; }, async agentGet() { return null; }, async notify(t, b) { notes.push([t, b]); } };
  const runs = { 'GH-1@impl': { rule: 'impl', role: 'impl', pass: 1, status: 'awaiting_merge', issueKey: 'GH-1', title: 'Waiting one', startedAt: '2026-09-09T07:00:00Z', finishedAt: '2026-09-09T07:30:00Z', agentName: 'gh-1-impl', notified: {}, worktree: 'none', prUrl: 'https://github.com/o/r/pull/1', result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1' } } };
  const { SqliteStore, storePath } = await import('../dist/store/sqlite.js');
  const store = SqliteStore.open(storePath(paths.stateDir)); store.save({ runs, nudges: {} });
  const e = new FactoryEngine({ cfg, tracker: null, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', factoryId: 'f' }, log: (l) => logs.push(l), clock: () => new Date(now) });
  assert.deepEqual(await e.runDueTasks(), ['waiting-nudge/long-waits', 'count/runs'], 'the failing task is not counted as run');
  assert.equal(notes.length, 1); assert.match(notes[0][1], /Waiting one.*for 150 minutes/);
  assert.ok(logs.some((l) => /count\/boom failed: kaput/.test(l)), 'a failing task is a log line');
  assert.deepEqual(await e.runDueTasks(), [], 'nothing is due a moment later');
  now += 11 * 60_000;
  assert.deepEqual(await e.runDueTasks(), ['count/runs'], 'the 10-minute one is due again (and the failing one tried again, quietly)');
  now += 16 * 60_000;
  await e.runDueTasks();
  assert.equal(notes.length, 1, 'the long-wait task told once, thanks to its memory');
  assert.equal(e.taskRuns.get('count/runs').memory.n, 3, 'three rounds where it was due; the memory carried each time');
  store.close();
});
