// `weawr update [--to vX.Y.Z]`: reinstall from an immutable tag, never from a moving branch, and
// say how to go back. The artifact is one file plus the recipe revisions it bundles, and a recipe
// revision never changes once shipped, so a watcher that is still running keeps rendering exactly
// the words it had; restart it to run the new code. Nothing here rewrites a running process.
import { execFileSync } from 'node:child_process';
import { newerVersion } from '@weawr/engine/version.mjs';
import { INSTALL_SPEC } from '../context.js';
import type { Context } from '../context.js';

/** Print a one-line reminder if GitHub main has a newer version. Quiet otherwise. */
export async function updateReminder(ctx: Context, { notify = false } = {}): Promise<boolean> {
  const latest = await newerVersion(ctx.version);
  if (!latest) return false;
  ctx.ui.log(`⬆ weawr ${latest} is available (you have ${ctx.version}) — run: weawr update`);
  if (notify) await ctx.herdr.notify('weawr update available', `${ctx.version} → ${latest}: run weawr update`);
  return true;
}

/** The tag to install: `--to` as given, else the newest published version, else nothing to do. */
export async function targetTag(ctx: Context, args: string[]): Promise<string | null> {
  const i = args.indexOf('--to');
  if (i >= 0) { const v = args[i + 1]; if (!v) throw new Error('usage: weawr update --to vX.Y.Z'); return v.startsWith('v') ? v : `v${v}`; }
  const latest = await newerVersion(ctx.version);
  return latest ? `v${latest}` : null;
}

export async function update(ctx: Context, args: string[] = []): Promise<void> {
  const tag = await targetTag(ctx, args);
  if (!tag) { console.log(`weawr ${ctx.version} is the newest published version; nothing to do (weawr update --to vX.Y.Z installs a specific one)`); return; }
  const spec = `${INSTALL_SPEC}#${tag}`;
  console.log(`weawr ${ctx.version} → installing ${tag} from ${spec} …`);
  execFileSync('npm', ['install', '-g', spec], { stdio: 'inherit' });
  const now = execFileSync('weawr', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`now ${now}`);
  console.log(`rollback: weawr update --to v${ctx.version}`);
  console.log('watchers that are running keep the code they started with (and the recipe files they had, which never change once shipped); restart each one — Ctrl-C in its pane, then `weawr` again — to run the new version. A watcher started by the new version migrates any older factory state on first start.');
}
