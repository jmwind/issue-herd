// `weawr status` and `weawr reset <KEY>`: both go to the running owner when there is one, so a
// reset lands in the watcher's own memory rather than in a file it is about to overwrite.
import { nudgesSent } from '@weawr/engine/nudge.mjs';
import { createApplication, dispatchCommand, makeEngine, takeOwnership } from '../context.js';
import type { Context } from '../context.js';

export async function status(ctx: Context): Promise<void> {
  const cfg = ctx.config();
  const { via, result } = await dispatchCommand(ctx, { type: 'factory.status' }, async () => createApplication(makeEngine(ctx, { cfg, tracker: null })));
  if (!result.ok) throw new Error(result.error.message);
  const s = result.result as any;
  const rows = Object.entries<any>(s.runs);
  if (!rows.length) { console.log(`no runs yet in ${ctx.paths.repo}`); return; }
  console.log(`${'run key'.padEnd(16)} ${'role'.padEnd(8)} ${'run'.padEnd(14)} ${'agent'.padEnd(8)} ${'ws'.padEnd(4)} ${'rule'.padEnd(12)} ${'started'.padEnd(16)} outcome`);
  for (const [k, r] of rows) {
    const agent = r.status === 'running' ? (s.agentStatus?.[k] || 'gone') : '-';
    const outcome = r.result ? `${r.result.status}${r.result.prUrl ? ' ' + r.result.prUrl : ''}` : (r.error || '');
    console.log(`${k.padEnd(16)} ${(r.role || '-').padEnd(8)} ${String(r.status).padEnd(14)} ${agent.padEnd(8)} ${(r.workspaceId || '').padEnd(4)} ${String(r.rule).padEnd(12)} ${String(r.startedAt).slice(0, 16)} ${outcome}  ${r.title || ''}`);
  }
  // Who nudged whom, per issue, against the cap — the conversation the roles had on their own.
  for (const [issueKey, entries] of Object.entries<any[]>(s.nudges || {})) {
    if (!entries?.length) continue;
    console.log(`\n${issueKey}: ${nudgesSent(entries)} of ${s.maxNudges} nudges used`);
    for (const e of entries) console.log(`  ${(e.at || '').slice(0, 16)} ${e.from || '?'} → ${e.to} ${e.outcome}${e.outcome === 'refused' ? '' : `: ${(e.message || '').split('\n')[0].slice(0, 80)}`}`);
  }
  if (via === 'owner') console.log(`\n(answered by the running watcher)`);
}

export async function reset(ctx: Context, key: string | undefined): Promise<void> {
  if (!key) throw new Error('usage: weawr reset <KEY>');
  const cfg = ctx.config();
  const { result } = await dispatchCommand(ctx, { type: 'run.reset', key }, async () => {
    // Nobody owns the factory: take it for the duration of this write, so a watcher starting at
    // the same moment cannot read the state from under us.
    const ownership = takeOwnership(ctx, cfg);
    const app = createApplication(makeEngine(ctx, { cfg, tracker: null, ownership }));
    return { dispatch: async (cmd) => { try { return await app.dispatch(cmd); } finally { ownership.release(); } } };
  });
  if (!result.ok) throw new Error(result.error.message);
  const { forgot } = result.result as { forgot: string[] };
  console.log(forgot.length ? `forgot ${forgot.join(', ')}` : `no run called ${key}`);
}
