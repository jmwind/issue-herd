// Durable factory state in SQLite (node:sqlite, no dependency).
//
// What state.json held — runs by key, nudges by issue — is here as rows, and next to it what a
// JSON file could never hold safely: structured events with a durable cursor, immutable attempt
// records, tracked operations (deduplicated by request id), pending external work committed in
// the same transaction as the state change that owes it, and the console's acknowledgements.
//
// One writer: the factory's owner. Readers (a console, `weawr status` with no owner) open it
// read-only. WAL mode lets them read while the owner writes.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FactoryState, NudgeEntry, StateStore } from '../state.js';

export const SCHEMA_VERSION = 1;

export interface EventRecord { seq: number; at: string; kind: string; runKey: string | null; issueKey: string | null; data: Record<string, unknown> }
export interface AttemptRecord { id: string; runKey: string; issueKey: string; pass: number; startedAt: string; spec: Record<string, unknown> }
export interface OperationRecord { id: string; scope: string; requestId: string; kind: string; status: 'accepted' | 'running' | 'completed' | 'failed' | 'partial'; input: unknown; result: unknown; error: string | null; createdAt: string; updatedAt: string }
export interface PendingAction { id: number; runKey: string | null; kind: string; data: Record<string, unknown>; attempts: number; lastError: string | null; createdAt: string; doneAt: string | null; outcome: string | null }
export interface Acknowledgement { issueKey: string; at: string; by: string | null }

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (key TEXT PRIMARY KEY, issue_key TEXT, role TEXT, status TEXT, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nudges (seq INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nudges_issue ON nudges (issue_key);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, run_key TEXT, issue_key TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_run ON events (run_key, seq);
CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, run_key TEXT NOT NULL, issue_key TEXT NOT NULL, pass INTEGER NOT NULL, started_at TEXT NOT NULL, spec TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_run ON attempts (run_key, pass);
CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (scope, request_id));
CREATE TABLE IF NOT EXISTS pending_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT, kind TEXT NOT NULL, json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, done_at TEXT, outcome TEXT);
CREATE INDEX IF NOT EXISTS pending_open ON pending_actions (done_at) WHERE done_at IS NULL;
CREATE TABLE IF NOT EXISTS acknowledgements (issue_key TEXT PRIMARY KEY, at TEXT NOT NULL, by TEXT);
`;

export class UnsupportedSchemaError extends Error {
  constructor(public readonly found: number, public readonly supported: number) {
    super(`this factory's state is schema version ${found}; this weawr understands up to ${supported}. Upgrade weawr; the data was left untouched.`);
  }
}

export class SqliteStore implements StateStore {
  readonly db: DatabaseSync;
  readonly file: string;
  readonly readOnly: boolean;
  private inTransaction = 0;

  private constructor(file: string, db: DatabaseSync, readOnly: boolean) { this.file = file; this.db = db; this.readOnly = readOnly; }

  /** Open for writing (the owner). Creates the schema when the file is new; refuses a newer schema. */
  static open(file: string, { now = () => new Date() } = {}): SqliteStore {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(DDL);
    const store = new SqliteStore(file, db, false);
    const found = store.meta('schema_version');
    if (found === null) { store.setMeta('schema_version', String(SCHEMA_VERSION)); store.setMeta('created_at', now().toISOString()); }
    else if (Number(found) > SCHEMA_VERSION) { db.close(); throw new UnsupportedSchemaError(Number(found), SCHEMA_VERSION); }
    return store;
  }

  /** Open for reading only: a console, a status with no owner. Never creates the file. */
  static openReadOnly(file: string): SqliteStore | null {
    if (!fs.existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const store = new SqliteStore(file, db, true);
    const found = Number(store.meta('schema_version') ?? SCHEMA_VERSION);
    if (found > SCHEMA_VERSION) { db.close(); throw new UnsupportedSchemaError(found, SCHEMA_VERSION); }
    return store;
  }

  close(): void { try { this.db.close(); } catch { /* already */ } }

  meta(key: string): string | null { const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined; return r?.value ?? null; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value); }

  /** Run `fn` in one transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction++;
    try { const v = fn(); this.db.exec('COMMIT'); return v; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    finally { this.inTransaction--; }
  }

  // ---------------------------------------------------------------- StateStore

  load(): FactoryState {
    const runs: Record<string, any> = {};
    for (const r of this.db.prepare('SELECT key, json FROM runs ORDER BY key').all() as Array<{ key: string; json: string }>) runs[r.key] = JSON.parse(r.json);
    const nudges: Record<string, NudgeEntry[]> = {};
    for (const n of this.db.prepare('SELECT issue_key, json FROM nudges ORDER BY seq').all() as Array<{ issue_key: string; json: string }>) (nudges[n.issue_key] ??= []).push(JSON.parse(n.json));
    return { runs, nudges };
  }

  /**
   * Persist the whole state: every run upserted, runs that are gone deleted, the nudge log
   * replaced. One transaction, so a reader sees the old state or the new one.
   */
  save(state: FactoryState, now = new Date()): void {
    this.transaction(() => {
      const keep = new Set(Object.keys(state.runs));
      const existing = (this.db.prepare('SELECT key FROM runs').all() as Array<{ key: string }>).map((r) => r.key);
      const del = this.db.prepare('DELETE FROM runs WHERE key = ?');
      for (const k of existing) if (!keep.has(k)) del.run(k);
      const up = this.db.prepare('INSERT INTO runs (key, issue_key, role, status, json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET issue_key = excluded.issue_key, role = excluded.role, status = excluded.status, json = excluded.json, updated_at = excluded.updated_at WHERE json IS NOT excluded.json');
      for (const [k, run] of Object.entries(state.runs)) up.run(k, run.issueKey ?? null, run.role ?? null, run.status ?? null, JSON.stringify(run), now.toISOString());
      this.db.exec('DELETE FROM nudges');
      const ins = this.db.prepare('INSERT INTO nudges (issue_key, json) VALUES (?, ?)');
      for (const [issue, list] of Object.entries(state.nudges || {})) for (const e of list) ins.run(issue, JSON.stringify(e));
      this.setMeta('last_saved_at', now.toISOString());
    });
  }

  // ---------------------------------------------------------------- events

  appendEvent(kind: string, { runKey = null, issueKey = null, data = {} }: { runKey?: string | null; issueKey?: string | null; data?: Record<string, unknown> } = {}, at = new Date()): EventRecord {
    const r = this.db.prepare('INSERT INTO events (at, kind, run_key, issue_key, json) VALUES (?, ?, ?, ?, ?) RETURNING seq').get(at.toISOString(), kind, runKey, issueKey, JSON.stringify(data)) as { seq: number };
    return { seq: Number(r.seq), at: at.toISOString(), kind, runKey, issueKey, data };
  }

  /** Events after `cursor` (a seq), oldest first, at most `limit`. */
  eventsAfter(cursor = 0, limit = 500, runKey: string | null = null): EventRecord[] {
    const rows = runKey
      ? this.db.prepare('SELECT * FROM events WHERE seq > ? AND run_key = ? ORDER BY seq LIMIT ?').all(cursor, runKey, limit)
      : this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(cursor, limit);
    return (rows as any[]).map((r) => ({ seq: Number(r.seq), at: r.at, kind: r.kind, runKey: r.run_key, issueKey: r.issue_key, data: JSON.parse(r.json) }));
  }

  /** The newest event's seq — the cursor a fresh snapshot is consistent with. */
  lastEventSeq(): number { const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }; return Number(r.seq); }
  /** The oldest event still kept; a cursor before it has expired. */
  firstEventSeq(): number { const r = this.db.prepare('SELECT COALESCE(MIN(seq), 0) AS seq FROM events').get() as { seq: number }; return Number(r.seq); }

  // ---------------------------------------------------------------- attempts

  recordAttempt(a: AttemptRecord): void {
    this.db.prepare('INSERT INTO attempts (id, run_key, issue_key, pass, started_at, spec) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING').run(a.id, a.runKey, a.issueKey, a.pass, a.startedAt, JSON.stringify(a.spec));
  }
  attempts(runKey: string): AttemptRecord[] {
    return (this.db.prepare('SELECT * FROM attempts WHERE run_key = ? ORDER BY pass, started_at').all(runKey) as any[]).map((r) => ({ id: r.id, runKey: r.run_key, issueKey: r.issue_key, pass: Number(r.pass), startedAt: r.started_at, spec: JSON.parse(r.spec) }));
  }
  attempt(id: string): AttemptRecord | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as any;
    return r ? { id: r.id, runKey: r.run_key, issueKey: r.issue_key, pass: Number(r.pass), startedAt: r.started_at, spec: JSON.parse(r.spec) } : null;
  }

  // ---------------------------------------------------------------- operations

  /**
   * Begin an operation for (scope, requestId). Repeating a request returns the original
   * operation; reusing an id for different input is refused. Returns { op, fresh }.
   */
  beginOperation({ id, scope, requestId, kind, input }: { id: string; scope: string; requestId: string; kind: string; input: unknown }, now = new Date()): { op: OperationRecord; fresh: boolean } {
    return this.transaction(() => {
      const existing = this.operationByRequest(scope, requestId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input) || existing.kind !== kind) throw new Error(`request ${requestId} was already used for a different ${existing.kind} (${JSON.stringify(existing.input)}); a request id names one action`);
        return { op: existing, fresh: false };
      }
      const at = now.toISOString();
      this.db.prepare('INSERT INTO operations (id, scope, request_id, kind, status, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, scope, requestId, kind, 'accepted', JSON.stringify(input ?? null), at, at);
      return { op: this.operation(id)!, fresh: true };
    });
  }
  updateOperation(id: string, { status, result, error }: { status: OperationRecord['status']; result?: unknown; error?: string | null }, now = new Date()): void {
    this.db.prepare('UPDATE operations SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(result ?? null), error ?? null, now.toISOString(), id);
  }
  operation(id: string): OperationRecord | null { const r = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any; return r ? opOf(r) : null; }
  operationByRequest(scope: string, requestId: string): OperationRecord | null { const r = this.db.prepare('SELECT * FROM operations WHERE scope = ? AND request_id = ?').get(scope, requestId) as any; return r ? opOf(r) : null; }
  /** Operations that were accepted or running when the last owner stopped. */
  unfinishedOperations(): OperationRecord[] { return (this.db.prepare("SELECT * FROM operations WHERE status IN ('accepted', 'running') ORDER BY created_at").all() as any[]).map(opOf); }

  // ---------------------------------------------------------------- pending external work

  addPending(kind: string, data: Record<string, unknown>, runKey: string | null = null, now = new Date()): number {
    const r = this.db.prepare('INSERT INTO pending_actions (run_key, kind, json, created_at) VALUES (?, ?, ?, ?) RETURNING id').get(runKey, kind, JSON.stringify(data), now.toISOString()) as { id: number };
    return Number(r.id);
  }
  pending(): PendingAction[] { return (this.db.prepare('SELECT * FROM pending_actions WHERE done_at IS NULL ORDER BY id').all() as any[]).map(pendingOf); }
  pendingFor(runKey: string): PendingAction[] { return (this.db.prepare('SELECT * FROM pending_actions WHERE done_at IS NULL AND run_key = ? ORDER BY id').all(runKey) as any[]).map(pendingOf); }
  /** Record one try at a pending action: done (with an outcome) or failed (kept, with the error). */
  settlePending(id: number, { done, outcome = null, error = null }: { done: boolean; outcome?: string | null; error?: string | null }, now = new Date()): void {
    if (done) this.db.prepare('UPDATE pending_actions SET attempts = attempts + 1, done_at = ?, outcome = ?, last_error = ? WHERE id = ?').run(now.toISOString(), outcome, error, id);
    else this.db.prepare('UPDATE pending_actions SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id);
  }
  /** Give up on a pending action without doing it (an owner decided it no longer applies). */
  dropPending(id: number, why: string, now = new Date()): void { this.db.prepare("UPDATE pending_actions SET done_at = ?, outcome = 'dropped', last_error = ? WHERE id = ?").run(now.toISOString(), why, id); }

  // ---------------------------------------------------------------- acknowledgements

  acknowledge(issueKey: string, at: string, by: string | null = null): void { this.db.prepare('INSERT INTO acknowledgements (issue_key, at, by) VALUES (?, ?, ?) ON CONFLICT (issue_key) DO UPDATE SET at = excluded.at, by = excluded.by').run(issueKey, at, by); }
  unacknowledge(issueKey: string): boolean { return Number((this.db.prepare('DELETE FROM acknowledgements WHERE issue_key = ?').run(issueKey) as any).changes) > 0; }
  acknowledgements(): Acknowledgement[] { return (this.db.prepare('SELECT issue_key, at, by FROM acknowledgements').all() as any[]).map((r) => ({ issueKey: r.issue_key, at: r.at, by: r.by })); }
}

function opOf(r: any): OperationRecord { return { id: r.id, scope: r.scope, requestId: r.request_id, kind: r.kind, status: r.status, input: JSON.parse(r.input), result: r.result ? JSON.parse(r.result) : null, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at }; }
function pendingOf(r: any): PendingAction { return { id: Number(r.id), runKey: r.run_key, kind: r.kind, data: JSON.parse(r.json), attempts: Number(r.attempts), lastError: r.last_error, createdAt: r.created_at, doneAt: r.done_at, outcome: r.outcome }; }

/** Where a factory's durable state lives: next to the JSON file it replaces. */
export function storePath(stateDir: string): string { return path.join(stateDir, 'factory.sqlite'); }
