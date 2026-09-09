// `weawr recipe show` and `weawr recipe upgrade [--to N] [--dry-run]`: which briefs this factory
// gives its agents, and a reviewable move to a newer bundled revision. New work only — a task that
// started under revision 1 finishes under revision 1.
import { createApplication, dispatchCommand, makeEngine, takeOwnership } from '../context.js';
import type { Context } from '../context.js';

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  const cfg = ctx.config();
  const sub = args[0] || 'show';
  if (sub === 'show') {
    const { result } = await dispatchCommand(ctx, { type: 'recipe.show' }, async () => createApplication(makeEngine(ctx, { cfg, tracker: null })));
    if (!result.ok) throw new Error(result.error.message);
    const r = result.result as any;
    console.log(`recipe ${r.id} revision ${r.revision}${r.latest > r.revision ? ` (revision ${r.latest} is bundled; \`weawr recipe upgrade --dry-run\` shows the difference)` : ' (latest)'} · pinned in the ${r.pinnedIn}`);
    for (const rule of r.rules) console.log(`  ${rule.name}${rule.role ? ` [${rule.role}]` : ''}: ${rule.prompt} (${rule.origin === 'repository' ? 'this repository\'s own template' : 'bundled'}${rule.protocol ? `, template protocol ${rule.protocol}` : ''})`);
    return;
  }
  if (sub !== 'upgrade') throw new Error('usage: weawr recipe [show | upgrade [--to N] [--dry-run]]');
  const toArg = args.indexOf('--to') >= 0 ? Number(args[args.indexOf('--to') + 1]) : undefined;
  if (toArg !== undefined && !Number.isInteger(toArg)) throw new Error('usage: weawr recipe upgrade --to <revision number>');
  const dryRun = args.includes('--dry-run');
  const { result } = await dispatchCommand(ctx, { type: 'recipe.upgrade', to: toArg, dryRun }, async () => {
    if (dryRun) return createApplication(makeEngine(ctx, { cfg, tracker: null }));
    const ownership = takeOwnership(ctx, cfg);
    const app = createApplication(makeEngine(ctx, { cfg, tracker: null, ownership }));
    return { dispatch: async (cmd) => { try { return await app.dispatch(cmd); } finally { ownership.release(); } } };
  });
  if (!result.ok) throw new Error(result.error.message);
  const r = result.result as any;
  console.log(`recipe revision ${r.from} → ${r.to}${r.applied ? ' (applied: new tasks use it; running tasks keep theirs)' : dryRun ? ' (dry run; nothing changed)' : ' (already there)'}`);
  for (const c of r.changes) console.log(`  · ${c}`);
  for (const t of r.templates) {
    if (t.origin === 'repository') { console.log(`\n${t.name}: this repository's own template in .weawr/prompts/ — the bundled change does not apply to it`); continue; }
    if (t.diff === '') { console.log(`\n${t.name}: unchanged`); continue; }
    console.log(`\n${t.name}:\n${t.diff.split('\n').map((l: string) => `  ${l}`).join('\n')}`);
  }
}
