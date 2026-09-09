// `weawr serve [--port N] [--host ADDR] [--no-web]` — the CLI's transport host for every factory
// on this machine: the versioned HTTP/SSE interface and, unless --no-web, the bundled console.
// `weawr console` is the same command by its older name, plus the passcode and device
// subcommands. Killing it stops nothing: owners keep running; starting it again restores the view.
import os from 'node:os';
import { askSecret, credentialsPath, loadCredentials, saveCredential } from '@weawr/engine/adapters/auth.mjs';
import * as _gate from './../transports/gate.mjs';
import { FactoryHub } from '../transports/hub.js';
import { createHandler, listen, tailscaleAddresses } from '../transports/http.js';
import type { Context } from '../context.js';
const { Gate, hashPasscode, newDeviceToken } = _gate as Record<string, any>;

export async function serve(ctx: Context, args: string[], { asConsole = false } = {}): Promise<void> {
  const file = credentialsPath();
  const log = (m: string) => ctx.ui.log(m);
  if (args[0] === 'set-passcode') {
    const a = await askSecret('New console passcode (at least 4 digits): ');
    const b = await askSecret('Again: ');
    if (a === undefined || b === undefined) throw new Error('nothing read from stdin — run set-passcode in a terminal');
    if (a !== b) throw new Error('the two entries differ; nothing changed');
    saveCredential('console', { ...(loadCredentials(file).console || {}), passcode: hashPasscode(a) }, file);
    const ts = tailscaleAddresses();
    console.log(`✓ console passcode saved in ${file.replace(os.homedir(), '~')} · ${ts.length ? `the console now serves on Tailscale too: ${ts.join(', ')}` : 'no Tailscale address on this machine yet; start the console again once there is one and it will serve there too'}`);
    return;
  }
  if (args[0] === 'clear-passcode') {
    const c = loadCredentials(file).console || {}; delete c.passcode;
    saveCredential('console', c, file);
    console.log('✓ console passcode cleared · the console serves on loopback only');
    return;
  }
  if (args[0] === 'device') {
    const c = loadCredentials(file).console || {}; const devices = c.devices || {};
    const sub = args[1]; const name = args[2];
    if (sub === 'add') {
      if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('usage: weawr console device add <name>   (letters, digits, - and _)');
      if (devices[name]) throw new Error(`a device called ${name} exists; revoke it first`);
      const { token, record } = newDeviceToken(name);
      saveCredential('console', { ...c, devices: { ...devices, [name]: record } }, file);
      console.log(`device ${name} added. Its token, shown once — put it in the app as its weawr token:\n\n  ${token}\n\nIt authenticates as \`Authorization: Bearer <token>\` against ${ctx.version ? `weawr ${ctx.version}` : 'this host'}; revoke with: weawr console device revoke ${name}`);
      return;
    }
    if (sub === 'list') { const names = Object.keys(devices); console.log(names.length ? names.map((n) => `${n}  (added ${devices[n].createdAt})`).join('\n') : 'no devices'); return; }
    if (sub === 'revoke') { if (!name || !devices[name]) throw new Error(`no device called ${name || '?'}`); delete devices[name]; saveCredential('console', { ...c, devices }, file); console.log(`device ${name} revoked`); return; }
    throw new Error('usage: weawr console device add <name> | list | revoke <name>');
  }
  if (args[0] && !args[0].startsWith('--')) throw new Error(`usage: weawr ${asConsole ? 'console' : 'serve'} [--port N] [--host ADDR]... [--no-web] [--theme factorio|clean] | set-passcode | clear-passcode | device add|list|revoke`);
  const themeArg = args.indexOf('--theme') >= 0 ? args[args.indexOf('--theme') + 1] : (process.env.WEAWR_CONSOLE_THEME || 'factorio');
  if (!['factorio', 'clean'].includes(themeArg || '')) throw new Error('--theme is factorio or clean');
  // --host binds one more address by name (the Wi-Fi one, say, when there is no tailnet). Only
  // behind the gate: without a passcode the console is a local console and stays on loopback.
  const hosts = args.flatMap((a, i) => (a === '--host' ? [args[i + 1] ?? ''] : []));
  if (hosts.some((h) => !h || h.startsWith('--'))) throw new Error('usage: weawr serve --host <address>');
  if (hosts.some((h) => h === '0.0.0.0' || h === '::')) throw new Error('--host names one address; the console never binds to every interface');
  const portArg = args.indexOf('--port') >= 0 ? (args[args.indexOf('--port') + 1] ?? '') : null;
  const port = portArg === null ? Number(process.env.WEAWR_CONSOLE_PORT || 8498) : Number(portArg);
  if (portArg === '' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`usage: weawr serve --port <number>${portArg ? ` (got ${JSON.stringify(portArg)})` : ''}`);
  const creds = () => loadCredentials(file).console || {};
  const gate = new Gate({ hash: creds().passcode || null });
  if (hosts.length && !gate.enabled) throw new Error('--host needs a passcode first (weawr console set-passcode); an ungated console stays on loopback');
  const hub = new FactoryHub({ herdr: ctx.herdr, version: ctx.version, promptsRoot: ctx.promptsRoot, log });
  const { handler } = createHandler({ gate, hub, log, webDir: args.includes('--no-web') ? null : ctx.webDir, devices: () => creds().devices || {}, version: ctx.version, theme: themeArg });
  let bound;
  try { bound = await listen({ handler, port, gated: gate.enabled, extraHosts: hosts }); }
  catch (e: any) { if (e.code === 'EADDRINUSE') throw new Error(`port ${port} is busy — a console is probably already open at http://127.0.0.1:${port}/ ; use --port N for a second one`); throw e; }
  hub.start();
  const where = !gate.enabled ? 'no passcode set (run `weawr console set-passcode`), serving on loopback only'
    : bound.urls.length > 1 ? `passcode set, serving on loopback${tailscaleAddresses().length ? ' and Tailscale' : ''}${hosts.length ? ` and ${hosts.join(', ')}` : ''}` : 'passcode set · no Tailscale address on this machine, so loopback only';
  log(`weawr ${ctx.version} ${asConsole ? 'console' : 'serve'} · ${where}${args.includes('--no-web') ? ' · interface only (/api/v1), no web console' : ''}`);
  for (const u of bound.urls) log(`  ${u}`);
  log(`  herdr: ${await ctx.herdr.serverRunning() ? 'connected' : 'NOT RUNNING — agent state will show as gone until it is'}`);
  process.on('uncaughtException', (e: any) => log(`unexpected error (kept running): ${e.stack || e.message}`));
  process.on('unhandledRejection', (e: any) => log(`unexpected error (kept running): ${e?.stack || e?.message || e}`));
  await new Promise(() => {});
}
