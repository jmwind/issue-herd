// `weawr plugins`: which plugins this factory enables, where each came from, what it provides,
// and what did not load. `weawr plugins examples` lists what ships with weawr.
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.js';

export async function plugins(ctx: Context, args: string[]): Promise<void> {
  if (args[0] === 'examples') {
    const dir = ctx.pluginsRoot;
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')) : [];
    for (const f of names) {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 12).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join(' ').replace(/\s+/g, ' ').trim();
      console.log(`examples/${f.replace(/\.mjs$/, '')}\n  ${head.slice(0, 220)}`);
    }
    if (!names.length) console.log('no shipped examples found');
    return;
  }
  const reg = await ctx.plugins();
  const cfg = ctx.config();
  if (!reg.plugins.length && !reg.problems.length) { console.log(`no plugins enabled for ${cfg.name} (add "plugins": [...] to .weawr/config.json or config.local.json; \`weawr plugins examples\` lists what ships)`); return; }
  for (const p of reg.plugins) {
    console.log(`${p.name}${p.version ? ` ${p.version}` : ''}  (${p.spec}, ${p.from})`);
    if (p.provides.intake.length) console.log(`  intake: ${p.provides.intake.map((id) => `tracker "${id}"${cfg.trackerSpec.type === id ? ' — in use' : ''}`).join(', ')}`);
    if (p.provides.roles.length) console.log(`  roles: ${p.provides.roles.map((r) => `${r}${cfg.rules.some((x: any) => x.templateOrigin?.startsWith(`plugin:${p.name}`) && x.role === r) ? ' — used by ' + cfg.rules.filter((x: any) => x.templateOrigin?.startsWith(`plugin:${p.name}`) && x.role === r).map((x: any) => x.name).join(', ') : ''}`).join(', ')}`);
    if (p.provides.tasks.length) console.log(`  tasks: ${reg.tasks.filter((t) => t.plugin === p.name).map((t) => `${t.name} every ${t.every}`).join(', ')}`);
  }
  for (const problem of reg.problems) console.log(`✗ ${problem}`);
}
