// `weawr` (run), `weawr once`, `weawr dry-run`: the watcher itself. Running and polling once take
// the team's ownership and answer on its socket; a dry run reads and touches nothing.
import { createApplication, hostApplication, makeEngine, takeOwnership } from '../context.js';
import type { Context } from '../context.js';
import { updateReminder } from './update.js';

export async function watch(ctx: Context, tracker: any, mode: 'run' | 'once' | 'dry-run'): Promise<void> {
  const cfg = ctx.config();
  if (!(await ctx.herdr.serverRunning())) throw new Error('herdr server is not running (start herdr first)');
  if (mode === 'dry-run') {
    const app = makeEngine(ctx, { cfg, tracker, dry: true });
    const r = await app.pollOnce();
    ctx.ui.log(`${r.scanned} open issues scanned, ${r.candidates} matched, ${r.picked.length} picked`);
    return;
  }
  const ownership = takeOwnership(ctx, cfg);
  const engine = makeEngine(ctx, { cfg, tracker, ownership, register: true });
  engine.hooks.updateReminder = () => updateReminder(ctx, { notify: true });
  const ipc = await hostApplication(ctx, createApplication(engine));
  if (mode === 'once') {
    await engine.resume();
    const r = await engine.pollOnce();
    ctx.ui.log(`${r.scanned} open issues scanned, ${r.candidates} matched, ${r.picked.length} picked`);
    if (engine.supervising.size) { ctx.ui.log(`supervising ${engine.supervising.size} run(s); Ctrl-C when done`); await new Promise(() => {}); }
    await ipc.close();
    ownership.release();
    return;
  }
  // The watcher must outlive its own mistakes: anything that escapes the per-poll and per-run
  // handlers is logged and the loop carries on. Fix the config or the issue and it is retried.
  process.on('uncaughtException', (e: any) => ctx.ui.log(`unexpected error (kept running): ${e.stack || e.message}`));
  process.on('unhandledRejection', (e: any) => ctx.ui.log(`unexpected error (kept running): ${e?.stack || e?.message || e}`));
  // A signal stops scheduling and checkpoints; the agents stay up for their owner to inspect. A
  // second signal exits at once.
  let signalled = false;
  const onSignal = () => { if (signalled) process.exit(130); signalled = true; ctx.ui.log('stopping after this poll (again to exit at once); agents are left running'); engine.stop(); };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) { process.removeAllListeners(sig); process.on(sig, onSignal); }
  await engine.loop();
  await ipc.close();
  ownership.release();
  // The supervisors are parked on herdr waits of hours: the agents are left running, on purpose,
  // but this process is not. Recovery re-attaches to them on the next start.
  ctx.herdr.endWaits?.();
  ctx.ui.log('stopped; the agents are left running');
  process.exit(0);
}
