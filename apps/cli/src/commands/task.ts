// Task-level commands an agent or a person runs against the factory's owner:
//   weawr merge <run-key> [--request-id ID]     the deterministic merge (recipe revision 2+)
//   weawr result <run-key> --file F | --json J  hand in a result through weawr, checked and written whole
//   weawr task reconfigure <run-key>            move an active run onto the current policy
//   weawr task attempts <run-key>               every attempt's record
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createApplication, dispatchCommand, makeEngine, makeTracker, takeOwnership } from '../context.js';
import type { Context } from '../context.js';

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

export async function merge(ctx: Context, args: string[]): Promise<void> {
  const key = args.find((a) => !a.startsWith('--'));
  if (!key) throw new Error('usage: weawr merge <run-key> [--request-id ID] [--json]');
  const cfg = ctx.config();
  const requestId = flag(args, '--request-id') || `merge-${key}-${crypto.randomBytes(4).toString('hex')}`;
  const { result } = await dispatchCommand(ctx, { type: 'run.merge', key, requestId, requestedBy: process.env.HERDR_AGENT_NAME ? `agent ${process.env.HERDR_AGENT_NAME}` : 'cli' }, async () => {
    // No owner running: merging still needs the factory's lock, its tracker and its GitHub token.
    const ownership = takeOwnership(ctx, cfg);
    const app = createApplication(makeEngine(ctx, { cfg, tracker: makeTracker(ctx, cfg), ownership }));
    return { dispatch: async (cmd) => { try { return await app.dispatch(cmd); } finally { ownership.release(); } } };
  });
  if (!result.ok) throw new Error(result.error.message);
  const r = result.result as any;
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); if (!r.merged) process.exitCode = 2; return; }
  for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.detail}`);
  if (r.merged) console.log(`merged ${r.prUrl} at ${String(r.headSha).slice(0, 7)}`);
  else { console.log(`not merged: ${r.reason}`); process.exitCode = 2; }
}

export async function submitResult(ctx: Context, args: string[]): Promise<void> {
  const key = args.find((a) => !a.startsWith('--'));
  const file = flag(args, '--file'); const json = flag(args, '--json');
  if (!key || (!file && !json)) throw new Error('usage: weawr result <run-key> --file <result.json> | --json \'{"status":…}\'');
  let parsed: unknown;
  try { parsed = JSON.parse(json ?? fs.readFileSync(file!, 'utf8')); } catch (e: any) { throw new Error(`the result is not valid JSON: ${e.message}`); }
  const cfg = ctx.config();
  const requestId = flag(args, '--request-id') || `result-${key}-${crypto.randomBytes(4).toString('hex')}`;
  const { result, via } = await dispatchCommand(ctx, { type: 'run.submitResult', key, result: parsed, requestId }, async () => {
    const ownership = takeOwnership(ctx, cfg);
    const app = createApplication(makeEngine(ctx, { cfg, tracker: null, ownership }));
    return { dispatch: async (cmd) => { try { return await app.dispatch(cmd); } finally { ownership.release(); } } };
  });
  if (!result.ok) throw new Error(result.error.message);
  const r = result.result as any;
  console.log(`accepted: ${r.path}${via === 'owner' ? ' (the watcher will finish the turn within a minute)' : ' (no watcher is running; it will be read when one starts)'}`);
}

export async function task(ctx: Context, args: string[]): Promise<void> {
  const sub = args[0]; const key = args[1];
  if (sub === 'reconfigure') {
    if (!key) throw new Error('usage: weawr task reconfigure <run-key>');
    const cfg = ctx.config();
    const { result } = await dispatchCommand(ctx, { type: 'run.reconfigure', key }, async () => {
      const ownership = takeOwnership(ctx, cfg);
      const app = createApplication(makeEngine(ctx, { cfg, tracker: null, ownership }));
      return { dispatch: async (cmd) => { try { return await app.dispatch(cmd); } finally { ownership.release(); } } };
    });
    if (!result.ok) throw new Error(result.error.message);
    const r = result.result as any;
    console.log(r.changed.length ? `${key}: now on the current policy; changed: ${r.changed.join(', ')}` : `${key}: already on the current policy`);
    return;
  }
  if (sub === 'attempts') {
    if (!key) throw new Error('usage: weawr task attempts <run-key>');
    const cfg = ctx.config();
    const { result } = await dispatchCommand(ctx, { type: 'attempt.list', key }, async () => createApplication(makeEngine(ctx, { cfg, tracker: null })));
    if (!result.ok) throw new Error(result.error.message);
    const { attempts } = result.result as any;
    if (!attempts.length) { console.log(`no attempts recorded for ${key}`); return; }
    for (const a of attempts) {
      const sp = a.spec || {};
      console.log(`${a.id}\n  pass ${a.pass} started ${a.startedAt}${sp.provenance === 'legacy' ? ' (imported from state.json; original policy unknown)' : ''}`);
      if (sp.recipe) console.log(`  recipe ${sp.recipe.id || '?'} rev ${sp.recipe.revision ?? '?'} · template ${sp.recipe.template} (${sp.recipe.templateOrigin || '?'}) ${String(sp.recipe.templateHash || '').slice(0, 12)} · brief ${String(sp.recipe.briefHash || '').slice(0, 12)}`);
      if (sp.agent) console.log(`  agent ${sp.agent.kind}${sp.agent.model ? ` ${sp.agent.model}` : ''}${sp.agent.effort ? ` effort ${sp.agent.effort}` : ''} as ${sp.agent.name} · weawr ${sp.weawr?.version}`);
      if (sp.repository) console.log(`  repository head ${String(sp.repository.head || '').slice(0, 7)} branch ${sp.repository.branch || '-'}${sp.repository.basedOn ? ` from ${sp.repository.basedOn}` : ''}`);
      if (sp.policy) console.log(`  policy: agentKind ${sp.policy.agentKind}, worktree ${sp.policy.worktree}, onMerged ${JSON.stringify(sp.policy.onMerged)}`);
    }
    return;
  }
  throw new Error('usage: weawr task reconfigure <run-key> | weawr task attempts <run-key>');
}
