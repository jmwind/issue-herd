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

export function update(ctx: Context): void {
  console.log(`weawr ${ctx.version} → installing latest from ${INSTALL_SPEC} …`);
  execFileSync('npm', ['install', '-g', INSTALL_SPEC], { stdio: 'inherit' });
  const now = execFileSync('weawr', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`now ${now}`);
}
