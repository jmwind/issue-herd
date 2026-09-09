// Ownership and the private dispatch, from the command line: a mutation goes to the running owner
// over its socket, a factory held by a silent owner is not mutated behind its back, and a
// transport failure reads as "the owner is not answering", never as an absent agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callOwner, serveIpc, OWNER_OFFLINE } from '../build/transports/ipc.js';
import { factoryPaths, readFactoryState } from '@weawr/engine';
function runsIn(dir) { const v = readFactoryState(factoryPaths(dir)); const runs = v.state.runs; v.store?.close(); return runs; }

const BIN = fileURLToPath(new URL('../dist/weawr.mjs', import.meta.url));
const ENGINE = fileURLToPath(new URL('../../../packages/engine/dist/index.js', import.meta.url));
const IPC = fileURLToPath(new URL('../build/transports/ipc.js', import.meta.url));
const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));

function repo(t, runs) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-owner-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', rules: [{ name: 'r', match: 'any:true' }] }));
  fs.writeFileSync(path.join(dir, '.weawr', 'state', 'state.json'), JSON.stringify({ runs }));
  return dir;
}
const run = (dir, args) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, WEAWR_NO_UPDATE_CHECK: '1' } }); return { status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }; };
const RUNS = { 'GH-7': { rule: 'r', status: 'done', startedAt: '2026-01-01T00:00', title: 'a' }, 'GH-8': { rule: 'r', status: 'done', startedAt: '2026-01-01T00:00', title: 'b' } };

/** A process that owns `dir`'s factory; with `serve`, it also answers on the factory's socket. */
function owner(t, dir, { serve }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireOwnership, factoryPaths, loadConfig, FactoryEngine, createApplication } from ${JSON.stringify(ENGINE)};
    import { serveIpc } from ${JSON.stringify(IPC)};
    const paths = factoryPaths(${JSON.stringify(dir)});
    const r = acquireOwnership({ lockPath: paths.lockPath, ownerPath: paths.ownerPath, card: { factoryId: 'f', hostId: 'h', startedAt: 'now', version: 'test', socketPath: ${serve ? 'paths.socketPath' : 'null'} } });
    if (!r.ok) { process.stdout.write('busy\\n'); process.exit(2); }
    if (${serve}) {
      const engine = new FactoryEngine({ cfg: loadConfig({ paths, promptsRoot: ${JSON.stringify(PROMPTS)} }), tracker: null, herdr: { async agentGet() { return null; } }, paths, promptsRoot: ${JSON.stringify(PROMPTS)}, ids: { hostId: 'h', factoryId: 'f' }, log: () => {} });
      await serveIpc(createApplication(engine), paths.socketPath);
    }
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(child); if (String(d).includes('busy')) reject(new Error('fixture could not take the lock')); });
    child.on('exit', (code) => reject(new Error(`the owner fixture exited with ${code}`)));
  });
}

test('with a running owner, status and reset are answered by it, and the file it wrote agrees', async (t) => {
  const dir = repo(t, RUNS);
  await owner(t, dir, { serve: true });
  const st = run(dir, ['status']);
  assert.equal(st.status, 0, st.out);
  assert.match(st.out, /answered by the running watcher/);
  const rs = run(dir, ['reset', 'GH-7']);
  assert.equal(rs.status, 0, rs.out);
  assert.match(rs.out, /forgot GH-7/);
  assert.deepEqual(Object.keys(runsIn(dir)), ['GH-8']);
});

test('a factory held by an owner that is not answering is not mutated behind its back', async (t) => {
  const dir = repo(t, RUNS);
  await owner(t, dir, { serve: false });
  const rs = run(dir, ['reset', 'GH-7']);
  assert.equal(rs.status, 1);
  assert.match(rs.out, /already being watched|not answering/);
  assert.deepEqual(Object.keys(runsIn(dir)).sort(), ['GH-7', 'GH-8'], 'nothing was forgotten');
  // A second watcher is refused too, and told who has it.
  const once = run(dir, ['smoke']);
  assert.equal(once.status, 1);
  assert.match(once.out, /already being watched: pid \d+/);
});

test('a transport failure is its own error, distinguishable from an agent being gone', async () => {
  const r = await callOwner(path.join(os.tmpdir(), `weawr-nobody-${process.pid}.sock`), { type: 'ping' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, OWNER_OFFLINE);
});

test('a successor on the same socket path is not unplugged when its predecessor closes', async (t) => {
  // A restart hands over this way: the new owner binds the path before the old one has finished
  // closing. The old close removes only the socket it made, so the new owner stays reachable.
  const sock = path.join(os.tmpdir(), `weawr-handover-${process.pid}.sock`);
  const app = (name) => ({ async dispatch() { return { ok: true, result: name }; } });
  const first = await serveIpc(app('first'), sock);
  const second = await serveIpc(app('second'), sock);
  t.after(() => second.close());
  await first.close();
  first.removeIfOwn(); // what the exit hook does, again: still not its socket to remove
  assert.ok(fs.existsSync(sock), 'the socket file is still there');
  const r = await callOwner(sock, { type: 'ping' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result, 'second');
});

test('with no owner, reset takes the lock for the write and gives it back', (t) => {
  const dir = repo(t, RUNS);
  const rs = run(dir, ['reset', 'GH-8']);
  assert.equal(rs.status, 0, rs.out);
  assert.match(rs.out, /forgot GH-8/);
  assert.ok(!fs.existsSync(path.join(dir, '.weawr/state/owner.json')), 'no owner card left behind');
});
