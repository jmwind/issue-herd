// The durable store: what state.json held, plus events with a cursor, immutable attempts, tracked
// operations and pending external work — all committed together, and readable while written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, UnsupportedSchemaError, SCHEMA_VERSION } from '../dist/store/sqlite.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-store-')), 'team.sqlite');

test('save/load round-trips runs and nudges, deletes what is gone, and a reader sees whole states only', () => {
  const file = tmp();
  const s = SqliteStore.open(file);
  s.save({ runs: { 'GH-7@impl': { status: 'running', issueKey: 'GH-7', role: 'impl' }, 'GH-8': { status: 'done' } }, nudges: { 'GH-7': [{ from: 'review', to: 'impl', outcome: 'turn', at: 't', message: 'm' }] } });
  const r = SqliteStore.openReadOnly(file);
  assert.deepEqual(Object.keys(r.load().runs).sort(), ['GH-7@impl', 'GH-8']);
  assert.equal(r.load().nudges['GH-7'][0].message, 'm');
  s.save({ runs: { 'GH-8': { status: 'merged' } }, nudges: {} });
  assert.deepEqual(r.load(), { runs: { 'GH-8': { status: 'merged' } }, nudges: {} });
  assert.throws(() => r.save({ runs: {}, nudges: {} }), /readonly|read-only|attempt to write/i);
  assert.equal(SqliteStore.openReadOnly(tmp()), null, 'a reader never creates the file');
  s.close(); r.close();
});

test('a transaction commits the state, its event and the work it owes together, or none of it', () => {
  const s = SqliteStore.open(tmp());
  assert.throws(() => s.transaction(() => {
    s.save({ runs: { 'GH-1': { status: 'done' } }, nudges: {} });
    s.appendEvent('run.finished', { runKey: 'GH-1' });
    s.addPending('tracker.comment', { body: 'x' }, 'GH-1');
    throw new Error('crash before commit');
  }), /crash/);
  assert.deepEqual(s.load().runs, {}); assert.equal(s.lastEventSeq(), 0); assert.deepEqual(s.pending(), []);
  s.transaction(() => {
    s.save({ runs: { 'GH-1': { status: 'done' } }, nudges: {} });
    s.appendEvent('run.finished', { runKey: 'GH-1', data: { status: 'pr_open' } });
    s.addPending('tracker.comment', { body: 'x' }, 'GH-1');
  });
  assert.equal(s.load().runs['GH-1'].status, 'done');
  assert.equal(s.eventsAfter(0)[0].kind, 'run.finished');
  assert.equal(s.pending()[0].kind, 'tracker.comment');
  // pending work is tried, recorded, and retried until done or given up
  const [a] = s.pending();
  s.settlePending(a.id, { done: false, error: 'HTTP 502' });
  assert.equal(s.pending()[0].attempts, 1); assert.equal(s.pending()[0].lastError, 'HTTP 502');
  s.settlePending(a.id, { done: true, outcome: 'commented' });
  assert.deepEqual(s.pending(), []);
  s.close();
});

test('events have a durable cursor; resuming after it replays only what is new', () => {
  const s = SqliteStore.open(tmp());
  for (let i = 1; i <= 5; i++) s.appendEvent(`e${i}`);
  assert.deepEqual(s.eventsAfter(0).map((e) => e.kind), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(s.eventsAfter(3).map((e) => e.seq), [4, 5]);
  assert.equal(s.lastEventSeq(), 5); assert.equal(s.firstEventSeq(), 1);
  assert.deepEqual(s.eventsAfter(5), []);
  s.close();
});

test('an attempt is written once and never updated; the same id again is ignored', () => {
  const s = SqliteStore.open(tmp());
  const spec = { recipe: { briefHash: 'abc' }, policy: { agentKind: 'claude' } };
  s.recordAttempt({ id: 'GH-7@impl#1-x', runKey: 'GH-7@impl', issueKey: 'GH-7', pass: 1, startedAt: 't1', spec });
  s.recordAttempt({ id: 'GH-7@impl#1-x', runKey: 'GH-7@impl', issueKey: 'GH-7', pass: 1, startedAt: 't1', spec: { recipe: { briefHash: 'CHANGED' } } });
  assert.equal(s.attempt('GH-7@impl#1-x').spec.recipe.briefHash, 'abc');
  s.recordAttempt({ id: 'GH-7@impl#2-y', runKey: 'GH-7@impl', issueKey: 'GH-7', pass: 2, startedAt: 't2', spec });
  assert.deepEqual(s.attempts('GH-7@impl').map((a) => a.pass), [1, 2], 'every attempt is kept, the first included');
  s.close();
});

test('operations: a repeated request id returns the original; the same id for different input is refused', () => {
  const s = SqliteStore.open(tmp());
  const a = s.beginOperation({ id: 'op1', scope: 'task:GH-7', requestId: 'r1', kind: 'task.done', input: { key: 'GH-7' } });
  assert.equal(a.fresh, true); assert.equal(a.op.status, 'accepted');
  s.updateOperation('op1', { status: 'completed', result: { closed: 2 } });
  const again = s.beginOperation({ id: 'op2', scope: 'task:GH-7', requestId: 'r1', kind: 'task.done', input: { key: 'GH-7' } });
  assert.equal(again.fresh, false); assert.equal(again.op.id, 'op1'); assert.deepEqual(again.op.result, { closed: 2 });
  assert.throws(() => s.beginOperation({ id: 'op3', scope: 'task:GH-7', requestId: 'r1', kind: 'task.done', input: { key: 'GH-8' } }), /already used for a different/);
  // another scope (another team, another caller) may reuse the id
  assert.equal(s.beginOperation({ id: 'op4', scope: 'task:GH-9', requestId: 'r1', kind: 'task.done', input: { key: 'GH-9' } }).fresh, true);
  assert.equal(s.operation('nope'), null);
  s.close();
});

test('a store from a newer weawr is refused and left untouched', () => {
  const file = tmp();
  const s = SqliteStore.open(file); s.setMeta('schema_version', String(SCHEMA_VERSION + 1)); s.save({ runs: { X: { status: 'done' } }, nudges: {} }); s.close();
  assert.throws(() => SqliteStore.open(file), UnsupportedSchemaError);
  assert.throws(() => SqliteStore.openReadOnly(file), /schema version 2/);
  // the file is intact: sqlite itself still reads the run
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
  db.close();
});
