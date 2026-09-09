// `weawr console [--port N]` serves the factory floor; `weawr console set-passcode` sets the
// passcode it asks for. Without a passcode the console binds to loopback only and asks nothing:
// a local console. With one it also binds to this machine's Tailscale address, so a phone on the
// tailnet can open it, and everything is behind the gate.
import os from 'node:os';
import { askSecret, credentialsPath, loadCredentials, saveCredential } from '@weawr/engine/adapters/auth.mjs';
import { Gate, hashPasscode } from '../console/passcode.mjs';
import * as _console from '../console/console.mjs';
import * as _server from '../console/server.mjs';
import { registrationsDir } from '@weawr/engine';
import type { Context } from '../context.js';
// Still JavaScript; used untyped until converted.
const { FactoryConsole } = _console as Record<string, any>;
const { createHandler, listen, tailscaleAddresses } = _server as Record<string, any>;

export async function consoleCommand(ctx: Context, args: string[]): Promise<void> {
  const file = credentialsPath();
  const log = (m: string) => ctx.ui.log(m);
  if (args[0] === 'set-passcode') {
    const a = await askSecret('New console passcode (at least 4 digits): ');
    const b = await askSecret('Again: ');
    if (a === undefined || b === undefined) throw new Error('nothing read from stdin — run set-passcode in a terminal');
    if (a !== b) throw new Error('the two entries differ; nothing changed');
    saveCredential('console', { passcode: hashPasscode(a) }, file);
    const ts = tailscaleAddresses();
    console.log(`✓ console passcode saved in ${file.replace(os.homedir(), '~')} · ${ts.length ? `the console now serves on Tailscale too: ${ts.join(', ')}` : 'no Tailscale address on this machine yet; start the console again once there is one and it will serve there too'}`);
    return;
  }
  if (args[0] === 'clear-passcode') {
    saveCredential('console', {}, file);
    console.log('✓ console passcode cleared · the console serves on loopback only');
    return;
  }
  if (args[0] && args[0] !== '--port' && args[0] !== '--host') throw new Error('usage: weawr console [--port N] [--host ADDR]... | set-passcode | clear-passcode');
  // --host binds one more address by name (the Wi-Fi one, say, when there is no tailnet). Only
  // behind the gate: without a passcode the console is a local console and stays on loopback.
  const hosts = args.flatMap((a, i) => (a === '--host' ? [args[i + 1] ?? ''] : []));
  if (hosts.some((h) => !h || h.startsWith('--'))) throw new Error('usage: weawr console --host <address>');
  if (hosts.some((h) => h === '0.0.0.0' || h === '::')) throw new Error('--host names one address; the console never binds to every interface');
  const portArg = args.indexOf('--port') >= 0 ? (args[args.indexOf('--port') + 1] ?? '') : null;
  const port = portArg === null ? Number(process.env.WEAWR_CONSOLE_PORT || 8498) : Number(portArg);
  if (portArg === '' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`usage: weawr console --port <number>${portArg ? ` (got ${JSON.stringify(portArg)})` : ''}`);
  const gate = new Gate({ hash: loadCredentials(file).console?.passcode || null });
  if (hosts.length && !gate.enabled) throw new Error('--host needs a passcode first (weawr console set-passcode); an ungated console stays on loopback');
  const app = new FactoryConsole({ herdr: ctx.herdr, version: ctx.version, log, registrationsDir: registrationsDir(ctx.userDir) });
  const { handler, broadcast } = createHandler({ gate, console: app, log, webDir: ctx.webDir });
  app.subscribe(() => broadcast());
  let bound;
  try { bound = await listen({ handler, port, gated: gate.enabled, extraHosts: hosts }); }
  catch (e: any) { if (e.code === 'EADDRINUSE') throw new Error(`port ${port} is busy — a console is probably already open at http://127.0.0.1:${port}/ ; use --port N for a second one`); throw e; }
  app.start();
  const where = !gate.enabled ? 'no passcode set (run `weawr console set-passcode`), serving on loopback only'
    : bound.urls.length > 1 ? `passcode set, serving on loopback${tailscaleAddresses().length ? ' and Tailscale' : ''}${hosts.length ? ` and ${hosts.join(', ')}` : ''}` : 'passcode set · no Tailscale address on this machine, so loopback only';
  log(`weawr ${ctx.version} console · ${where}`);
  for (const u of bound.urls) log(`  ${u}`);
  log(`  herdr: ${await ctx.herdr.serverRunning() ? 'connected' : 'NOT RUNNING — agent state will show as gone until it is'}`);
  process.on('uncaughtException', (e: any) => log(`unexpected error (kept running): ${e.stack || e.message}`));
  process.on('unhandledRejection', (e: any) => log(`unexpected error (kept running): ${e?.stack || e?.message || e}`));
  await new Promise(() => {});
}
