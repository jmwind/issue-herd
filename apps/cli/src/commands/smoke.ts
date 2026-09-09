// End-to-end herdr test with a fake issue: workspace → agent → brief → result.json → finalize. No tracker calls.
import { compile } from '@weawr/engine/expr.mjs';
import { normalizeRole, runKeyFor } from '@weawr/engine/claim.mjs';
import { createApplication, hostApplication, makeEngine, takeOwnership } from '../context.js';
import type { Context } from '../context.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smoke(ctx: Context, argv: string[]): Promise<void> {
  const cfg = ctx.config();
  const rule: any = {
    ...cfg.defaults, name: 'smoke', repo: ctx.paths.repo, worktree: argv.includes('--worktree') ? cfg.defaults.worktree : 'none',
    // Relative, so the config resolver finds the bundled copy; an absolute path is refused, since a
    // repository must not be able to name a file outside .weawr/ for the brief.
    prompt: 'prompts/smoke.md', instructions: '',
    onPickup: { comment: false }, onDone: { comment: false, notify: true, closeWorkspace: false },
    onBlocked: { comment: false, notify: true }, onIdle: { comment: false, notify: true },
  };
  rule.compiled = compile('any:true');
  rule.role = normalizeRole(rule.role, 'smoke rule');
  // `--key SMOKE-1` names the fake issue, so a test can seed state.json with another role's run on
  // it before the smoke run starts — the only way to drive a nudge without a tracker.
  const keyFlag = argv.indexOf('--key');
  const key = keyFlag !== -1 && argv[keyFlag + 1] ? argv[keyFlag + 1] : `SMOKE-${Date.now().toString().slice(-4)}`;
  const nowIso = new Date().toISOString();
  const issue = {
    id: 'fake', identifier: key, ref: key, title: 'weawr smoke test', description: 'Prove the herdr pipeline works end to end.',
    url: 'https://linear.app/example', priority: 3, priorityLabel: 'Medium', labels: ['ai'], project: null,
    team: { id: 't', key: 'SMK', name: 'Smoke' }, assignee: null, creator: null, state: { name: 'Todo', type: 'unstarted' },
    cycle: null, comments: [], createdAt: nowIso, updatedAt: nowIso,
  };
  // A smoke run starts an agent and writes the state, so it is an owner like any watcher.
  const ownership = takeOwnership(ctx, cfg);
  // The repository's own rules ride along behind the smoke rule: a smoke result that nudges another
  // role needs that role's rule to give it a turn, and the brief lists the roles the project runs.
  const app = makeEngine(ctx, { cfg: { ...cfg, rules: [rule, ...cfg.rules] }, tracker: null, ownership });
  const ipc = await hostApplication(ctx, createApplication(app));
  await app.pickUp(issue, rule);
  // The run is filed under its run key, which carries the rule's role — `defaults.role` in
  // config.json reaches the smoke rule like any other default, so this is not always the issue key.
  const runKey = runKeyFor(key, rule.role);
  app.log(`smoke: waiting for ${runKey} to finish…`);
  while (app.state.runs[runKey].status === 'running') await sleep(2000);
  // A result that nudged another role started that role's turn; it is part of the pipeline too.
  while (app.supervising.size) await sleep(500);
  const run = app.state.runs[runKey];
  app.log(`smoke: ${run.status} ${JSON.stringify(run.result || run.error || '')}`);
  console.log(`\nSmoke run ${runKey}: ${run.status}. herdr workspace ${run.workspaceId} left open; clean up with:\n  herdr workspace close ${run.workspaceId}\n  weawr reset ${runKey}`);
  await ipc.close();
  ownership.release();
  process.exit(run.status === 'done' ? 0 : 1);
}
