// `weawr serve` end to end: a real owner in another process answering on its socket, an offline
// factory beside it, the versioned routes, the event stream with cursors, commands as tracked
// operations, the compatibility routes, device tokens, and the property that killing the host
// stops nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factoryPaths, writeRegistration, SqliteStore, storePath } from '@weawr/engine';
import { validate, factorySnapshotSchema, hostSnapshotSchema, describeIssues } from '@weawr/protocol';
import { WeawrClient } from '@weawr/client';
import { FactoryHub } from '../build/transports/hub.js';
import { createHandler, listen } from '../build/transports/http.js';
import { Gate, hashPasscode, newDeviceToken } from '../build/transports/gate.mjs';

const ENGINE = fileURLToPath(new URL('../../../packages/engine/dist/index.js', import.meta.url));
const IPC = fileURLToPath(new URL('../build/transports/ipc.js', import.meta.url));
const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));
const WEB = fileURLToPath(new URL('../../web/dist/', import.meta.url));

function repo(t, name, runs) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `weawr-serve-${name}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ name, tracker: 'linear', roles: ['impl', 'review'], defaults: { worktree: 'none' }, rules: [{ name: 'impl', role: 'impl', match: 'any:true' }, { name: 'review', role: 'review', match: 'any:true' }] }));
  const store = SqliteStore.open(storePath(factoryPaths(dir).stateDir));
  store.save({ runs, nudges: {} });
  store.appendEvent('run.prompted', { runKey: Object.keys(runs)[0], data: {} });
  store.close();
  return dir;
}
const RUN = (dir, key, over = {}) => ({ rule: 'impl', role: 'impl', pass: 1, status: 'done', issueKey: key.split('@')[0], title: `Task ${key}`, url: 'https://x/1', startedAt: '2026-09-08T10:00:00Z', finishedAt: '2026-09-08T11:00:00Z', agentName: `${key.toLowerCase().replace('@', '-')}`, workspaceId: 'w1', notified: {}, worktree: 'none', workDir: dir, result: { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1' }, ...over });

/** An owner process: real engine, durable store, a fake herdr whose agents are all up. */
function owner(t, dir, factoryId) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireOwnership, factoryPaths, loadConfig, FactoryEngine, createApplication, openOwnerStore } from ${JSON.stringify(ENGINE)};
    import { serveIpc } from ${JSON.stringify(IPC)};
    const paths = factoryPaths(${JSON.stringify(dir)});
    const r = acquireOwnership({ lockPath: paths.lockPath, ownerPath: paths.ownerPath, card: { factoryId: ${JSON.stringify(factoryId)}, hostId: 'h', startedAt: 'now', version: 'test', socketPath: paths.socketPath } });
    if (!r.ok) { process.stdout.write('busy\\n'); process.exit(2); }
    const stopped = new Set();
    const herdr = {
      async run(args) { if (args[0] === 'api') return { result: { snapshot: { version: '9', agents: [{ name: 'gh-1-impl', agent_status: 'idle', workspace_id: 'w1' }].filter((a) => !stopped.has(a.name)), workspaces: [{ workspace_id: 'w1', label: 'x' }], panes: [] } } }; return {}; },
      async agentGet(n) { return stopped.has(n) ? null : { name: n, agent_status: 'idle', workspace_id: 'w1' }; },
      async stopAgent(n) { stopped.add(n); return 'exited'; },
      async closeWorkspace() {}, async readAgent() { return 'screen text'; }, async notify() {}, async prompt() {},
    };
    const engine = new FactoryEngine({ cfg: loadConfig({ paths, promptsRoot: ${JSON.stringify(PROMPTS)} }), tracker: null, herdr, paths, promptsRoot: ${JSON.stringify(PROMPTS)}, store: openOwnerStore(paths), ids: { hostId: 'h', factoryId: ${JSON.stringify(factoryId)} }, log: () => {}, version: 'test' });
    await serveIpc(createApplication(engine), paths.socketPath);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  return new Promise((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(child); }); child.on('exit', (c) => reject(new Error(`owner exited ${c}`))); });
}

async function host(t, { gate = new Gate({ hash: null }), devices = {} } = {}) {
  const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-regs-'));
  t.after(() => fs.rmSync(regDir, { recursive: true, force: true }));
  const herdr = { async run() { throw new Error('no herdr here'); }, async readAgent() { return 'offline screen'; } };
  const hub = new FactoryHub({ herdr, version: 'test', promptsRoot: PROMPTS, registrations: regDir, legacyRegistry: null, intervalMs: 200, log: () => {} });
  const { handler } = createHandler({ gate, hub, webDir: WEB, devices: () => devices, version: 'test', log: () => {} });
  const bound = await listen({ handler, port: 0, gated: false });
  hub.start();
  t.after(async () => { hub.stop(); await bound.close(); });
  const reg = (factoryId, repo, over = {}) => writeRegistration(regDir, { factoryId, repo, name: path.basename(repo), tracker: 'linear', version: 'test', hostId: 'h', pid: 1, pollSeconds: 30, workspaceId: null, logPath: null, socketPath: factoryPaths(repo).socketPath, statePath: null, lastPoll: new Date().toISOString(), lastSuccessfulPoll: null, lastPollError: null, ...over });
  return { hub, url: bound.urls[0].replace(/\/$/, ''), reg, close: () => bound.close() };
}
const j = (r) => r.json();
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test('serve: an online owner and an offline factory, every fact from the owner or the store, validated against the protocol', async (t) => {
  const on = repo(t, 'online', { 'GH-1@impl': RUN('', 'GH-1@impl') });
  const off = repo(t, 'offline', { 'GH-2@impl': RUN('', 'GH-2@impl') });
  await owner(t, on, 'fon');
  const h = await host(t);
  h.reg('fon', on); h.reg('foff', off, { lastPoll: '2020-01-01T00:00:00Z' });
  const snap = await until(async () => { const s = await fetch(`${h.url}/api/v1/snapshot`).then(j); return s.result.factories.length === 2 ? s.result : null; });
  const v = validate(hostSnapshotSchema, snap);
  assert.ok(v.ok, v.ok ? '' : describeIssues(v.issues));
  const byId = Object.fromEntries(snap.factories.map((f) => [f.factoryId, f]));
  assert.equal(byId.fon.owner.status, 'online'); assert.equal(byId.fon.owner.pid > 0, true); assert.equal(byId.fon.freshness.herdrAt !== null, true);
  assert.equal(byId.fon.issues[0].runs[0].agentAlive, true, 'herdr is the owner\'s, not the host\'s');
  assert.equal(byId.foff.owner.status, 'offline'); assert.equal(byId.foff.issues[0].key, 'GH-2');
  assert.equal(byId.foff.issues[0].runs[0].agentAlive, false, 'no herdr answered for the offline one');
  assert.deepEqual(byId.foff.capabilities, ['task.tail']);
  const one = await fetch(`${h.url}/api/v1/factories/fon/snapshot`).then(j);
  assert.ok(validate(factorySnapshotSchema, one.result).ok);
  const list = await fetch(`${h.url}/api/v1/factories`).then(j);
  assert.deepEqual(list.result.factories.map((f) => [f.factoryId, f.owner.status]).sort(), [['foff', 'offline'], ['fon', 'online']]);
  const task = await fetch(`${h.url}/api/v1/factories/fon/tasks/GH-1`).then(j);
  assert.equal(task.result.key, 'GH-1'); assert.equal(task.result.attempts.length, 0);
  const caps = await fetch(`${h.url}/api/v1/capabilities`).then(j);
  assert.deepEqual(caps.result.protocolVersions, [1]);
  const wrong = await fetch(`${h.url}/api/v1/snapshot`, { headers: { 'x-weawr-protocol': '2' } }).then(j);
  assert.equal(wrong.ok, false); assert.equal(wrong.error.code, 'unsupported_protocol');
  // the page and its client are served from the bundled web build
  assert.match(await fetch(`${h.url}/`).then((r) => r.text()), /<title>Factory Floor<\/title>/);
  assert.match(await fetch(`${h.url}/client.js`).then((r) => r.text()), /WeawrClient/);
  assert.match(await fetch(`${h.url}/themes/clean.css`).then((r) => r.text()), /body\[data-theme="clean"\]/);
  assert.equal((await fetch(`${h.url}/themes/nope.css`)).status, 404, 'themes are served by name only');
  assert.match(await fetch(`${h.url}/`).then((r) => r.text()), /data-theme="factorio"/);
  // the compatibility route still answers, shaped as before
  const legacy = await fetch(`${h.url}/api/state`).then(j);
  assert.equal(legacy.factories.length, 2); assert.equal(legacy.hostname, os.hostname());
});

test('serve: commands are tracked operations answered by the owner; a repeat is one action; an offline factory refuses mutations; a lost host stops nothing', async (t) => {
  const on = repo(t, 'act', { 'GH-1@impl': RUN('', 'GH-1@impl') });
  const off = repo(t, 'away', { 'GH-2@impl': RUN('', 'GH-2@impl') });
  const child = await owner(t, on, 'fact');
  // A client outside a browser sends no Origin, so it acts as a device, with a token.
  const { token, record } = newDeviceToken('test');
  const h = await host(t, { devices: { test: record } });
  h.reg('fact', on); h.reg('faway', off, { lastPoll: '2020-01-01T00:00:00Z' });
  await until(async () => (await fetch(`${h.url}/api/v1/snapshot`).then(j)).result.factories.length === 2);
  const client = new WeawrClient({ baseUrl: h.url, token });
  // same-origin is what a browser sends; here we send it by hand
  const post = (name, body) => fetch(`${h.url}/api/v1/commands/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url }, body: JSON.stringify(body) });
  const cross = await fetch(`${h.url}/api/v1/commands/task.done`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.test' }, body: '{}' }).then(j);
  assert.equal(cross.ok, false); assert.equal(cross.error.code, 'forbidden');
  const bad = await post('task.done', { factory: 'fact' }).then(j);
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'bad_request'); assert.match(bad.error.message, /task: must be a string/);
  const done = await post('task.done', { factory: 'fact', task: 'GH-1', requestId: 'r1' }).then(j);
  assert.equal(done.ok, true); assert.equal(done.result.operation.status, 'completed'); assert.equal(done.result.result.done, true);
  assert.deepEqual(done.result.result.outcomes.map((o) => o.outcome), ['exited']);
  const again = await post('task.done', { factory: 'fact', task: 'GH-1', requestId: 'r1' }).then(j);
  assert.equal(again.result.operation.id, done.result.operation.id, 'the same request is the same operation');
  assert.equal(again.result.result.replayed, true);
  const op = await fetch(`${h.url}/api/v1/factories/fact/operations/${done.result.operation.id}`).then(j);
  assert.equal(op.result.status, 'completed'); assert.equal(op.result.kind, 'task.done');
  const snap = await until(async () => { const s = (await fetch(`${h.url}/api/v1/factories/fact/snapshot`).then(j)).result; return s.issues[0].cleared ? s : null; });
  assert.equal(snap.issues[0].cleared, true, 'the acknowledgement is the owner\'s, and shows');
  // undo through the client, then a tail through the offline path
  const undo = await client.taskUndo('fact', 'GH-1');
  assert.equal(undo.result.done, false);
  const tail = await client.tail('faway', 'GH-2');
  assert.equal(tail.blocks[0].text, 'offline screen'); assert.match(tail.blocks[0].source, /owner is offline/);
  const refused = await post('task.done', { factory: 'faway', task: 'GH-2', requestId: 'r2' }).then(j);
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'owner_offline'); assert.equal(refused.error.retryable, true);
  // the host goes away: the owner is untouched, and a new host finds it again
  await h.close(); h.hub.stop();
  assert.equal(child.exitCode, null, 'the owner is still running');
  const h2 = await host(t); h2.reg('fact', on);
  const back = await until(async () => { const s = (await fetch(`${h2.url}/api/v1/snapshot`).then(j)).result; return s.factories.find((f) => f.factoryId === 'fact')?.owner.status === 'online' ? s : null; });
  assert.equal(back.factories[0].owner.status, 'online');
});

test('serve: the event stream sends a snapshot, then the owner\'s events with cursors; a resume replays only what is new', async (t) => {
  const on = repo(t, 'ev', { 'GH-1@impl': RUN('', 'GH-1@impl') });
  await owner(t, on, 'fev');
  const { token, record } = newDeviceToken('test');
  const h = await host(t, { devices: { test: record } }); h.reg('fev', on);
  await until(async () => (await fetch(`${h.url}/api/v1/snapshot`).then(j)).result.factories.length === 1);
  const client = new WeawrClient({ baseUrl: h.url, token });
  const got = { snapshots: [], events: [] };
  const sub = client.subscribe({ onSnapshot: (s) => got.snapshots.push(s), onEvent: (e) => got.events.push(e) });
  await until(() => got.snapshots.length >= 1);
  const rev = got.snapshots[0].factories[0].revision;
  assert.ok(rev >= 1);
  await client.taskDone('fev', 'GH-1', { requestId: 'e1' });
  await until(() => got.events.some((e) => e.kind === 'task.acknowledged'));
  const seqs = got.events.map((e) => e.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'in order');
  assert.ok(seqs[0] > rev, 'only what came after the snapshot');
  assert.ok(got.events.every((e) => e.factoryId === 'fev'));
  sub.close();
  // a fresh subscription from the cursor gets the events after it, not everything again
  const last = seqs[seqs.length - 1];
  const res = await fetch(`${h.url}/api/v1/factories/fev/events?after=${last - 1}`).then(j);
  assert.deepEqual(res.result.events.map((e) => e.seq), [last]);
  assert.equal(res.result.expired, false);
  const raw = await fetch(`${h.url}/api/v1/events?cursors=fev:${last - 1}`);
  const reader = raw.body.getReader(); let text = '';
  while (!/id: fev:\d+/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  reader.cancel();
  assert.match(text, /event: snapshot/); assert.match(text, new RegExp(`id: fev:${last}\\nevent: event`));
});

test('serve: a gated host locks the page, refuses the API without a session, and lets a device in by token', async (t) => {
  const on = repo(t, 'gated', { 'GH-1@impl': RUN('', 'GH-1@impl') });
  await owner(t, on, 'fg');
  const { token, record } = newDeviceToken('phone');
  const h = await host(t, { gate: new Gate({ hash: hashPasscode('4321') }), devices: { phone: record } });
  h.reg('fg', on);
  await until(async () => (await fetch(`${h.url}/api/v1/capabilities`).then(j)).result.auth.gated);
  assert.match(await fetch(`${h.url}/`).then((r) => r.text()), /passcode|unlock/i);
  const locked = await fetch(`${h.url}/api/v1/snapshot`).then(j);
  assert.equal(locked.ok, false); assert.equal(locked.error.code, 'unauthorized');
  const caps = await fetch(`${h.url}/api/v1/capabilities`).then(j);
  assert.deepEqual(caps.result.auth, { gated: true, mechanisms: ['session-cookie', 'device-token'] });
  // a device: bearer token, no origin, may read and act
  const dev = new WeawrClient({ baseUrl: h.url, token });
  const snap = await until(async () => { try { const s = await dev.hostSnapshot(); return s.factories.length ? s : null; } catch { return null; } });
  assert.equal(snap.factories[0].factoryId, 'fg');
  const r = await dev.taskDone('fg', 'GH-1', { requestId: 'd1' });
  assert.equal(r.result.done, true);
  const wrong = new WeawrClient({ baseUrl: h.url, token: 'wd_wrong' });
  await assert.rejects(() => wrong.hostSnapshot(), (e) => e.code === 'unauthorized');
  // a browser: the passcode issues a cookie session
  const unlock = await fetch(`${h.url}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url }, body: JSON.stringify({ code: '4321' }) });
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers.get('set-cookie').split(';')[0];
  const ok = await fetch(`${h.url}/api/v1/snapshot`, { headers: { cookie } }).then(j);
  assert.equal(ok.ok, true);
  for (let i = 0; i < 5; i++) await fetch(`${h.url}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url }, body: JSON.stringify({ code: '0000' }) });
  const lockedOut = await fetch(`${h.url}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url }, body: JSON.stringify({ code: '4321' }) });
  assert.equal(lockedOut.status, 429);
});
