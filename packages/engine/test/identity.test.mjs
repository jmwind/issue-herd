import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentNameFor, attemptId, teamId, hostId, roleRunId, taskId, trackerScope } from '../dist/identity.js';
import { teamPaths, shortHash } from '../dist/paths.js';
import { listRegistrations, isStale, readLegacyRegistry, writeRegistration, removeRegistration } from '../dist/registration.js';

test('agent names: the run key, then the team\'s short hash; herdr\'s 32-char limit is kept; legacy names are unchanged', () => {
  assert.equal(agentNameFor('GH-7@impl'), 'gh-7-impl');
  assert.equal(agentNameFor('GH-7@impl', 'aaaaaa111111'), 'gh-7-impl-aaaaaa');
  assert.notEqual(agentNameFor('GH-7@impl', 'aaaaaa111111'), agentNameFor('GH-7@impl', 'bbbbbb222222'));
  const long = agentNameFor('VERYLONGPROJECTKEY-123456@usability', 'abcdef123456');
  assert.ok(long.length <= 32, long); assert.match(long, /-abcdef$/); assert.match(long, /^[a-z][a-z0-9_-]*$/);
  assert.equal(agentNameFor('7@impl', 'abcdef'), 'i-7-impl-abcdef');
});

test('identities are stable and scoped: host → team → task (with the tracker\'s repo) → role run → attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-id-'));
  const h = hostId(dir);
  assert.equal(hostId(dir), h, 'created once, read after');
  assert.match(h, /^[0-9a-f]{16}$/);
  const f = teamId(h, '/home/me/app');
  assert.equal(f, teamId(h, '/home/me/app'));
  assert.notEqual(f, teamId(h, '/home/me/other'));
  assert.equal(trackerScope({ type: 'github', repo: 'o/r' }), 'github:o/r');
  assert.equal(trackerScope({ type: 'linear', team: 'ENG' }), 'linear:ENG');
  const t = taskId(f, 'github:o/r', 'GH-7');
  assert.notEqual(t, taskId(f, 'github:o/other', 'GH-7'), 'the same issue number in another repository is another task');
  assert.equal(roleRunId(t, 'impl'), `${t}@impl`); assert.equal(roleRunId(t, null), t);
  assert.match(attemptId(roleRunId(t, 'impl'), 2, '2026-09-08T00:00:00Z'), /@impl#2-[a-z0-9]{6}$/);
  assert.equal(shortHash('x'), shortHash('x')); assert.notEqual(shortHash('x'), shortHash('y'));
});

test('teamPaths puts everything under <repo>/.weawr and never reads process.cwd()', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-paths-'));
  const p = teamPaths(repo);
  assert.equal(p.configPath, path.join(fs.realpathSync(repo), '.weawr', 'config.json'));
  assert.equal(p.lockPath, path.join(p.stateDir, 'owner.lock'));
  assert.ok(p.socketPath.length < 104, 'a Unix socket path must fit');
});

test('registrations are one file per team, replaced atomically, and the legacy shared file is still read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-reg-'));
  const reg = (id, repo, lastPoll) => ({ teamId: id, repo, name: path.basename(repo), tracker: 'github', version: '0.2.8', hostId: 'h', pid: 1, pollSeconds: 30, workspaceId: null, logPath: null, socketPath: null, statePath: null, lastPoll, lastSuccessfulPoll: null, lastPollError: null });
  writeRegistration(dir, reg('a', '/r/a', new Date().toISOString()));
  writeRegistration(dir, reg('b', '/r/b', '2020-01-01T00:00:00Z'));
  fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');
  const all = listRegistrations(dir).sort((x, y) => x.teamId.localeCompare(y.teamId));
  assert.deepEqual(all.map((r) => [r.teamId, isStale(r)]), [['a', false], ['b', true]]);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no half-written files left behind');
  assert.equal(removeRegistration(dir, 'b'), true); assert.equal(removeRegistration(dir, 'b'), false);
  const legacy = path.join(dir, 'factories.json');
  fs.writeFileSync(legacy, JSON.stringify({ '/r/old': { name: 'old', tracker: 'linear', pid: 7, pollSeconds: 30, lastPoll: '2026-01-01T00:00:00Z' } }));
  assert.deepEqual(readLegacyRegistry(legacy).map((r) => [r.repo, r.name, r.teamId]), [['/r/old', 'old', 'legacy:/r/old']]);
  assert.deepEqual(readLegacyRegistry(path.join(dir, 'none.json')), []);
});

