// `weawr migrate [--dry-run]`: from state.json to the durable store, under the team's lock.
// The watcher does the same on start when it finds a legacy file; this is the explicit,
// inspectable path — see docs/architecture.md, "Migration".
import path from 'node:path';
import { inventory, migrateLegacyState } from '@weawr/engine';
import { credentialsPath } from '@weawr/engine/adapters/auth.mjs';
import { takeOwnership } from '../context.js';
import type { Context } from '../context.js';

export function consoleNotesPath(): string { return process.env.WEAWR_CONSOLE_NOTES || path.join(path.dirname(credentialsPath()), 'console.json'); }

export async function migrate(ctx: Context, args: string[]): Promise<void> {
  const cfg = ctx.config();
  const opts = { paths: ctx.paths, consoleNotesPath: consoleNotesPath() };
  const inv = inventory(opts);
  const rel = (p: string) => path.relative(ctx.paths.repo, p) || p;
  console.log(`team ${cfg.name} (${ctx.paths.repo})`);
  console.log(`  state.json: ${!inv.stateExists ? 'none' : inv.stateParses ? `${inv.runs} run(s), ${inv.nudges} nudge record(s)` : `DOES NOT PARSE — ${inv.stateError}`}`);
  console.log(`  run directories: ${inv.runDirs.length}${inv.orphanRunDirs.length ? ` (${inv.orphanRunDirs.length} without a run in state.json: ${inv.orphanRunDirs.slice(0, 5).join(', ')}${inv.orphanRunDirs.length > 5 ? '…' : ''})` : ''}${inv.runsWithoutDir.length ? ` (${inv.runsWithoutDir.length} run(s) without a directory: ${inv.runsWithoutDir.slice(0, 5).join(', ')})` : ''}`);
  console.log(`  console acknowledgements for this team: ${inv.consoleNotes}`);
  console.log(`  durable store: ${inv.storeExists ? (inv.alreadyMigrated ? `present, migrated at ${inv.alreadyMigrated}` : 'present') : 'not yet created'}`);
  if (args.includes('--dry-run') || args.includes('--inspect')) {
    console.log(inv.alreadyMigrated ? '\nnothing to do: already migrated' : inv.stateParses === false ? '\nrefusing: fix or deliberately move the state file first; it will not be treated as an empty team' : `\nwould: back up to ${rel(ctx.paths.stateDir)}/backup-<time>/, import runs and nudges in one transaction, import ${inv.consoleNotes} acknowledgement(s), rename state.json to state.json.migrated`);
    return;
  }
  // Under the lock: a running watcher would be writing the file this reads.
  const ownership = takeOwnership(ctx, cfg);
  try {
    const r = migrateLegacyState(opts);
    if (!r.migrated) { console.log(`\nnothing to do: ${r.reason}`); return; }
    console.log(`\nmigrated ${r.runs} run(s), ${r.nudges} nudge record(s), ${r.acknowledgements} acknowledgement(s)${r.backupDir ? `; backup in ${rel(r.backupDir)}` : ''}`);
    console.log(`rollback: stop weawr, move ${rel(ctx.paths.statePath)}.migrated back to state.json and remove team.sqlite* — only before new work has started; afterwards the store is the truth`);
  } finally { ownership.release(); }
}
