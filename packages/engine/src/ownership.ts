// Exclusive local ownership of a factory.
//
// Two watchers on one repository would both schedule pickups and both write the state, so the
// first one to start takes a lock and every other one reports who holds it. The lock is an
// SQLite `BEGIN IMMEDIATE` held open on a file of its own: the operating system's advisory lock,
// released the moment the holder's process dies, however it dies. A PID file cannot do that — PIDs
// are reused and a crash leaves the file behind — so the PID here is a calling card for the report,
// never the lock itself. Callers read the card only when the lock is busy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeJsonAtomic, readJson } from './state.js';

export interface OwnerCard {
  factoryId: string;
  hostId: string;
  hostname: string;
  pid: number;
  /** When this process started (ms), so a reused PID is not mistaken for the owner. */
  processStartedAt: number;
  startedAt: string;
  version: string | null;
  socketPath: string | null;
  /** The registered owner's own view of itself; refreshed while it runs. */
  heartbeatAt: string;
}

export interface Ownership {
  card: OwnerCard;
  /** Refresh the calling card's heartbeat; cheap, called every poll. */
  heartbeat(): void;
  /** Give the lock back. Idempotent. */
  release(): void;
}

export type AcquireResult = { ok: true; ownership: Ownership } | { ok: false; holder: OwnerCard | null; reason: string };

export interface AcquireOptions {
  lockPath: string;
  ownerPath: string;
  card: Omit<OwnerCard, 'heartbeatAt' | 'processStartedAt' | 'pid' | 'hostname'> & Partial<Pick<OwnerCard, 'pid' | 'processStartedAt' | 'hostname'>>;
}

/** The moment this process started, from Node's own clock: what tells a live owner from a reused PID. */
export function processStartedAt(): number { return Math.round(Date.now() - process.uptime() * 1000); }

/**
 * Try to become the factory's owner. Never blocks: a busy lock is an answer, not a wait.
 */
export function acquireOwnership({ lockPath, ownerPath, card }: AcquireOptions): AcquireResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(lockPath);
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, since TEXT)');
  } catch (e: any) {
    // Another process may be in the middle of creating the table under its own lock.
    if (/SQLITE_BUSY|locked/i.test(e.message)) return { ok: false, holder: readCard(ownerPath), reason: 'the lock is held' };
    throw e;
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR REPLACE INTO lock (id, pid, since) VALUES (1, ?, ?)').run(process.pid, new Date().toISOString());
  } catch (e: any) {
    db.close();
    if (/SQLITE_BUSY|locked/i.test(e.message)) return { ok: false, holder: readCard(ownerPath), reason: 'another watcher owns this factory' };
    throw e;
  }
  const full: OwnerCard = {
    ...card,
    hostname: card.hostname ?? os.hostname(),
    pid: card.pid ?? process.pid,
    processStartedAt: card.processStartedAt ?? processStartedAt(),
    heartbeatAt: new Date().toISOString(),
  };
  writeJsonAtomic(ownerPath, full);
  let released = false;
  return {
    ok: true,
    ownership: {
      card: full,
      heartbeat() { if (released) return; full.heartbeatAt = new Date().toISOString(); try { writeJsonAtomic(ownerPath, full); } catch { /* best effort */ } },
      release() {
        if (released) return;
        released = true;
        try { db.exec('ROLLBACK'); } catch { /* already gone */ }
        try { db.close(); } catch { /* already gone */ }
        try { fs.rmSync(ownerPath, { force: true }); } catch { /* best effort */ }
      },
    },
  };
}

/** The last owner's calling card, if one was left. Says who; the lock says whether. */
export function readCard(ownerPath: string): OwnerCard | null {
  const c = readJson<OwnerCard | null>(ownerPath, null);
  return c && typeof c === 'object' && typeof c.pid === 'number' ? c : null;
}

/**
 * Is the factory owned right now? Asks the lock, not the card: the lock cannot lie about a dead
 * process. Returns the card when it is, for the report.
 */
export function currentOwner({ lockPath, ownerPath }: { lockPath: string; ownerPath: string }): { owned: boolean; holder: OwnerCard | null } {
  if (!fs.existsSync(lockPath)) return { owned: false, holder: null };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(lockPath);
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return { owned: false, holder: null };
  } catch (e: any) {
    if (/SQLITE_BUSY|locked/i.test(e.message)) return { owned: true, holder: readCard(ownerPath) };
    throw e;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** One line about who holds a factory, for an error message. */
export function describeHolder(holder: OwnerCard | null): string {
  if (!holder) return 'another process holds the factory lock (it left no calling card)';
  return `pid ${holder.pid} on ${holder.hostname}${holder.version ? ` (weawr ${holder.version})` : ''}, since ${holder.startedAt}`;
}
