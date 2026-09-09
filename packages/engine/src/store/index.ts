// Which store a factory has, and how to open it for the purpose at hand.
import fs from 'node:fs';
import { JsonStateStore, readJson } from '../state.js';
import type { FactoryState, StateStore } from '../state.js';
import { SqliteStore, storePath } from './sqlite.js';
import type { FactoryPaths } from '../paths.js';

export type StoreKind = 'sqlite' | 'legacy-json' | 'none';

/** What is on disk for this factory, without opening anything for writing. */
export function storeStatus(paths: FactoryPaths): { kind: StoreKind; needsMigration: boolean; sqlitePath: string } {
  const sqlitePath = storePath(paths.stateDir);
  if (fs.existsSync(sqlitePath)) return { kind: 'sqlite', needsMigration: false, sqlitePath };
  if (fs.existsSync(paths.statePath)) return { kind: 'legacy-json', needsMigration: true, sqlitePath };
  return { kind: 'none', needsMigration: false, sqlitePath };
}

/**
 * The owner's store. Call after taking ownership and after migrating a legacy state.json (see
 * store/migrate.ts); a legacy file that is still there is a refusal here, never a silent fallback.
 */
export function openOwnerStore(paths: FactoryPaths): SqliteStore {
  const st = storeStatus(paths);
  if (st.needsMigration) throw new Error(`${paths.statePath} has not been migrated to the durable store; run \`weawr migrate\` (or start the watcher, which migrates under its lock)`);
  return SqliteStore.open(st.sqlitePath);
}

/**
 * The state as a reader sees it: the durable store read-only when there is one, else the legacy
 * JSON file (a factory nobody has upgraded yet), else empty. `corrupt` says the legacy file exists
 * but does not parse, which a reader must show rather than hide.
 */
export function readFactoryState(paths: FactoryPaths): { state: FactoryState; kind: StoreKind; corrupt: string | null; store: SqliteStore | null } {
  const st = storeStatus(paths);
  if (st.kind === 'sqlite') {
    const store = SqliteStore.openReadOnly(st.sqlitePath);
    if (store) return { state: store.load(), kind: 'sqlite', corrupt: null, store };
  }
  if (st.kind === 'legacy-json') {
    try { JSON.parse(fs.readFileSync(paths.statePath, 'utf8')); } catch (e: any) { return { state: { runs: {}, nudges: {} }, kind: 'legacy-json', corrupt: e.message, store: null }; }
    return { state: new JsonStateStore(paths.statePath).load(), kind: 'legacy-json', corrupt: null, store: null };
  }
  return { state: { runs: {}, nudges: {} }, kind: 'none', corrupt: null, store: null };
}

/** True when a store can commit pending work and events (the durable one). */
export function isDurable(store: StateStore): store is SqliteStore { return store instanceof SqliteStore; }

export { readJson };
