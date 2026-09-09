import { compile } from '@weawr/engine/expr.mjs';
import { userDisplay } from '@weawr/engine/adapters/tracker.mjs';
import { trackerBanner } from '@weawr/engine';
import type { Context } from '../context.js';

/** `weawr match "<expr>"`: evaluate an expression against live open issues. */
export async function match(ctx: Context, tracker: any, args: string[]): Promise<void> {
  const cfg = ctx.config();
  const expr = args.join(' '); if (!expr) throw new Error('usage: weawr match "<expr>"');
  const rule = compile(expr);
  const viewer = await tracker.me();
  const issues = await tracker.openIssues({ sinceIso: new Date(Date.now() - cfg.lookbackDays * 86400e3).toISOString() });
  const hits = issues.filter((i: any) => rule.test(i, { viewer }));
  for (const i of hits) console.log(`${i.identifier.padEnd(10)} ${(i.state?.name || '').padEnd(12)} [${i.labels.join(',')}] ${i.assignee?.displayName || '-'}  ${i.title}`);
  console.log(`${hits.length} of ${issues.length} open ${trackerBanner(tracker)} issues match (as ${userDisplay(viewer)})`);
}
