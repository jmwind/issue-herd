// The client against a stand-in `weawr serve`: envelopes, errors with codes, commands that carry
// request ids, operations polled to a terminal state, and a subscription that resumes with cursors
// and refetches when told to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WeawrClient, WeawrError, parseSse, newRequestId } from '../dist/index.js';

/** A fake host. `script` decides each request; SSE clients get what `push` writes. */
function host(t, script) {
  const sse = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(script.snapshot(url))}\n\n`);
      sse.add(res); req.on('close', () => sse.delete(res));
      return;
    }
    let body = ''; for await (const c of req) body += c;
    const r = script.request(req.method, url, body ? JSON.parse(body) : null, req.headers);
    res.writeHead(r.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await_listen(server);
  t.after(() => { for (const s of sse) s.end(); server.closeAllConnections(); server.close(); });
  return { url: () => `http://127.0.0.1:${server.address().port}`, push: (event, data) => { for (const s of sse) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }, drop: () => { for (const s of sse) s.destroy(); } };
}
function await_listen(server) { server.listen(0, '127.0.0.1'); }
const okEnv = (result) => ({ protocolVersion: 1, ok: true, result, generatedAt: new Date().toISOString() });
const errEnv = (code, message, status = 400) => ({ status, body: { protocolVersion: 1, ok: false, error: { code, message } } });
const snap = (rev) => ({ protocolVersion: 1, hostname: 'h', version: '1', herdr: { connected: true, version: null }, generatedAt: 'now', factories: [{ factoryId: 'f1', id: 'app', name: 'app', repo: '/r', tracker: 'github', revision: rev, owner: { status: 'online', observedAt: 'now' }, freshness: {}, roles: [], rules: [], watcher: { stale: false }, counts: { running: 0, working: 0, alerts: 0, inflight: 0, merged: 0, done: 0 }, humanWaitMs: 0, production: {}, alerts: [], issues: [] }] });

test('requests are envelopes; an error envelope becomes a WeawrError with its code; a dead host is a transport error', async (t) => {
  await new Promise((r) => setTimeout(r, 10));
  const seen = [];
  const h = host(t, { snapshot: () => snap(1), request: (m, url, body, headers) => {
    seen.push([m, url.pathname, body, headers.authorization || null, headers['x-weawr-protocol']]);
    if (url.pathname === '/api/v1/capabilities') return { body: okEnv({ protocolVersions: [1], version: '1', commands: [], features: {}, auth: { gated: false, mechanisms: [] } }) };
    if (url.pathname === '/api/v1/factories/f1/tasks/GH-7') return errEnv('no_such_task', 'no task GH-7', 404);
    if (url.pathname === '/api/v1/commands/task.done') return { body: okEnv({ operation: { id: 'op1', kind: 'task.done', status: 'running', createdAt: 'a', updatedAt: 'a' }, result: null }) };
    if (url.pathname === '/api/v1/factories/f1/operations/op1') return { body: okEnv({ id: 'op1', kind: 'task.done', status: seen.filter((s) => s[1].endsWith('/op1')).length > 1 ? 'completed' : 'running', result: { done: true }, createdAt: 'a', updatedAt: 'b' }) };
    return { status: 500, body: 'not an envelope' };
  } });
  await new Promise((r) => setTimeout(r, 20));
  const c = new WeawrClient({ baseUrl: h.url(), token: 'wd_x' });
  assert.deepEqual((await c.capabilities()).protocolVersions, [1]);
  assert.equal(seen[0][3], 'Bearer wd_x'); assert.equal(seen[0][4], '1');
  await assert.rejects(() => c.task('f1', 'GH-7'), (e) => e instanceof WeawrError && e.code === 'no_such_task' && e.status === 404);
  await assert.rejects(() => c.request('GET', '/nope'), (e) => e instanceof WeawrError && e.code === 'bad_response');
  const r = await c.taskDone('f1', 'GH-7', { requestId: 'req-9' });
  assert.equal(seen.find((s) => s[1] === '/api/v1/commands/task.done')[2].requestId, 'req-9', 'the request id travels with the command');
  assert.equal(r.operation.status, 'running');
  const op = await c.waitForOperation('f1', 'op1', { pollMs: 5 });
  assert.equal(op.status, 'completed'); assert.deepEqual(op.result, { done: true });
  const dead = new WeawrClient({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(() => dead.capabilities(), (e) => e instanceof WeawrError && e.code === 'transport' && e.retryable);
  assert.notEqual(newRequestId(), newRequestId());
});

test('subscribe: a snapshot, events with cursors, a resnapshot on request, reconnection after a drop with the cursors carried', async (t) => {
  const asked = [];
  const h = host(t, { snapshot: (url) => { asked.push(url.searchParams.get('cursors')); return snap(3); }, request: (m, url) => (url.pathname === '/api/v1/factories/f1/snapshot' ? { body: okEnv({ ...snap(7).factories[0], revision: 7 }) } : errEnv('not_found', 'no', 404)) });
  await new Promise((r) => setTimeout(r, 20));
  const c = new WeawrClient({ baseUrl: h.url() });
  const got = { snapshots: [], events: [], resnaps: [], status: [] };
  const sub = c.subscribe({ onSnapshot: (s) => got.snapshots.push(s), onEvent: (e) => got.events.push(e), onResnapshot: (s, why) => got.resnaps.push([s.revision, why]), onStatus: (s) => got.status.push(s) });
  await until(() => got.snapshots.length === 1);
  assert.equal(sub.connected, true); assert.equal(sub.cursors.get('f1'), 3, 'the snapshot revision is the first cursor');
  h.push('event', { factoryId: 'f1', seq: 4, at: 'x', kind: 'run.blocked', runKey: 'GH-7', issueKey: 'GH-7', data: {} });
  h.push('event', { factoryId: 'f1', seq: 5, at: 'x', kind: 'run.working', runKey: 'GH-7', issueKey: 'GH-7', data: {} });
  await until(() => got.events.length === 2);
  assert.equal(sub.cursors.get('f1'), 5);
  h.push('resnapshot', { factoryId: 'f1', reason: 'expired' });
  await until(() => got.resnaps.length === 1);
  assert.deepEqual(got.resnaps[0], [7, 'expired']); assert.equal(sub.cursors.get('f1'), 7);
  assert.equal(c.last.snapshot.factories[0].revision, 3);
  // the connection drops: the client says so, then comes back after the cursor it had
  h.drop();
  await until(() => got.status.some((s) => !s.connected));
  await until(() => got.snapshots.length === 2, 5000);
  assert.equal(asked[1], 'f1:7', 'the reconnect resumed after the last cursor');
  sub.close();
});

test('parseSse splits a byte stream into messages, joining multi-line data and ignoring comments', async () => {
  const chunks = ['event: a\ndata: 1\n', 'data: 2\n\n: ping\n\nid: 9\ndata: {"x":1}\n\n'];
  const body = new ReadableStream({ start(ctl) { for (const c of chunks) ctl.enqueue(new TextEncoder().encode(c)); ctl.close(); } });
  const out = []; for await (const m of parseSse(body)) out.push(m);
  assert.deepEqual(out, [{ event: 'a', data: '1\n2', id: null }, { event: 'message', data: '{"x":1}', id: '9' }]);
});

async function until(fn, ms = 3000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } }
