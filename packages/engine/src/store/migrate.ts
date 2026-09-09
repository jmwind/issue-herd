// From state.json to the durable store, once, under the owner's lock.
//
// Inspect first (`inventory`), then `migrate`: back the legacy files up, import runs and nudges in
// one transaction, bring the console's acknowledgements across, mark the store as migrated, and
// set state.json aside. Never a dual write: after this the JSON file is a backup, not a source. A
// state file that does not parse is a refusal, not an empty factory.
import fs from 'node:fs';
import path from 'node:path';
import { SqliteStore, storePath } from './sqlite.js';
import type { FactoryPaths } from '../paths.js';

export interface Inventory {
  statePath: string;
  stateExists: boolean;
  stateParses: boolean | null;
  stateError: string | null;
  runs: number;
  nudges: number;
  runDirs: string[];
  /** Run directories on disk without a run in state.json, or the reverse: named, not fixed. */
  orphanRunDirs: string[];
  runsWithoutDir: string[];
  storeExists: boolean;
  alreadyMigrated: string | null;
  consoleNotes: number;
  legacyRegistryEntry: boolean;
}

export interface MigrationOptions {
  paths: FactoryPaths;
  /** The console's notes file (~/.config/weawr/console.json), or null to skip acknowledgements. */
  consoleNotesPath?: string | null;
  now?: () => Date;
}

export function inventory({ paths, consoleNotesPath = null }: MigrationOptions): Inventory {
  const inv: Inventory = {
    statePath: paths.statePath, stateExists: fs.existsSync(paths.statePath), stateParses: null, stateError: null, runs: 0, nudges: 0,
    runDirs: [], orphanRunDirs: [], runsWithoutDir: [], storeExists: fs.existsSync(storePath(paths.stateDir)), alreadyMigrated: null,
    consoleNotes: 0, legacyRegistryEntry: false,
  };
  let state: any = null;
  if (inv.stateExists) {
    try { state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8')); inv.stateParses = true; }
    catch (e: any) { inv.stateParses = false; inv.stateError = e.message; }
  }
  if (state && typeof state === 'object') {
    inv.runs = Object.keys(state.runs || {}).length;
    inv.nudges = Object.values(state.nudges || {}).reduce((n: number, l: any) => n + (Array.isArray(l) ? l.length : 0), 0);
  }
  try { inv.runDirs = fs.readdirSync(paths.runsDir).filter((d) => fs.statSync(path.join(paths.runsDir, d)).isDirectory()); } catch { /* none */ }
  const keys = new Set(Object.keys(state?.runs || {}));
  inv.orphanRunDirs = inv.runDirs.filter((d) => !keys.has(d));
  inv.runsWithoutDir = [...keys].filter((k) => !inv.runDirs.includes(k));
  if (inv.storeExists) { const s = SqliteStore.openReadOnly(storePath(paths.stateDir)); inv.alreadyMigrated = s?.meta('migrated_at') ?? null; s?.close(); }
  if (consoleNotesPath) {
    try { const notes = JSON.parse(fs.readFileSync(consoleNotesPath, 'utf8')); inv.consoleNotes = Object.keys(notes?.done || {}).filter((k) => k.startsWith(paths.repo + '|')).length; } catch { /* none */ }
  }
  return inv;
}

export interface MigrationResult { migrated: boolean; reason?: string; backupDir?: string; runs: number; nudges: number; acknowledgements: number }

/**
 * Do it. Call only while holding the factory's ownership. Refuses when the store already says it
 * was migrated, when state.json does not parse, or when there is nothing legacy to import (then
 * the store is simply created).
 */
export function migrateLegacyState(opts: MigrationOptions): MigrationResult {
  const { paths, consoleNotesPath = null, now = () => new Date() } = opts;
  const inv = inventory(opts);
  if (inv.alreadyMigrated) return { migrated: false, reason: `already migrated at ${inv.alreadyMigrated}; ${path.basename(paths.statePath)} is a backup now, not a source`, runs: 0, nudges: 0, acknowledgements: 0 };
  if (inv.stateExists && inv.stateParses === false) throw new Error(`${paths.statePath} is not valid JSON (${inv.stateError}). It was left exactly as it is: fix it, or move it aside deliberately, then run again. A corrupt state file is never treated as an empty factory.`);
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const store = SqliteStore.open(storePath(paths.stateDir), { now });
  try {
    if (!inv.stateExists) { store.setMeta('migrated_at', now().toISOString()); store.setMeta('migrated_from', 'none'); return { migrated: true, runs: 0, nudges: 0, acknowledgements: 0 }; }
    const backupDir = path.join(paths.stateDir, `backup-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(paths.statePath, path.join(backupDir, 'state.json'));
    if (consoleNotesPath && fs.existsSync(consoleNotesPath)) fs.copyFileSync(consoleNotesPath, path.join(backupDir, 'console.json'));
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    const runs = state.runs || {}; const nudges = state.nudges || {};
    let acks = 0;
    store.transaction(() => {
      store.save({ runs, nudges }, now());
      // Every legacy run is one attempt whose provenance is unknown: what we know is what state.json kept.
      for (const [key, run] of Object.entries<any>(runs)) {
        store.recordAttempt({ id: `${key}#${run.pass || 1}-legacy`, runKey: key, issueKey: run.issueKey || key.split('@')[0], pass: run.pass || 1, startedAt: run.startedAt || now().toISOString(), spec: { provenance: 'legacy', recipe: null, brief: run.briefPath ? { path: run.briefPath } : null, rule: run.rule ?? null, role: run.role ?? null, note: 'imported from state.json; the original resolved policy was not recorded' } });
      }
      if (consoleNotesPath) {
        try {
          const notes = JSON.parse(fs.readFileSync(consoleNotesPath, 'utf8'));
          for (const [k, v] of Object.entries<any>(notes?.done || {})) {
            if (!k.startsWith(paths.repo + '|')) continue;
            store.acknowledge(k.slice(paths.repo.length + 1), v?.at || now().toISOString(), 'console');
            acks++;
          }
        } catch { /* no notes */ }
      }
      store.appendEvent('factory.migrated', { data: { from: 'state.json', runs: Object.keys(runs).length, backupDir } }, now());
      store.setMeta('migrated_at', now().toISOString());
      store.setMeta('migrated_from', paths.statePath);
    });
    // The JSON file steps aside only after the store has it. Not deleted: it is the rollback.
    fs.renameSync(paths.statePath, `${paths.statePath}.migrated`);
    return { migrated: true, backupDir, runs: Object.keys(runs).length, nudges: Object.values(nudges).reduce((n: number, l: any) => n + l.length, 0), acknowledgements: acks };
  } finally { store.close(); }
}
