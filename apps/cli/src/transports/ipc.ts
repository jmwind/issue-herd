// The owner's private local endpoint: newline-delimited JSON over a Unix socket that only this
// user can open. Every request is one Command for the application; every answer is its
// CommandResult. A transport failure (no socket, refused, timed out) is reported as its own error
// code, so "the owner is offline" is never mistaken for "the agent is gone".
import fs from 'node:fs';
import net from 'node:net';
import type { Application, Command, CommandResult } from '@weawr/engine';

export const OWNER_OFFLINE = 'owner_offline';

export interface IpcServer { close(): Promise<void>; path: string }

/** Host `app` on `socketPath`. Call only while holding the factory's ownership: a stale socket file is removed. */
export function serveIpc(app: Application, socketPath: string, log: (m: string) => void = () => {}): Promise<IpcServer> {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(socketPath, { force: true }); } catch { /* not there */ }
    const server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', async (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let req: { id?: unknown; command?: Command } = {};
          try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ id: null, ok: false, error: { code: 'bad_request', message: 'not JSON' } }) + '\n'); continue; }
          const result = req.command && typeof req.command === 'object' ? await app.dispatch(req.command) : { ok: false as const, error: { code: 'bad_request', message: 'no command' } };
          sock.write(JSON.stringify({ id: req.id ?? null, ...result }) + '\n');
        }
      });
      sock.on('error', (e) => log(`ipc: ${e.message}`));
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      try { if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
      resolve({ path: socketPath, close: () => new Promise((r) => { server.close(() => { try { fs.rmSync(socketPath, { force: true }); } catch { /* gone */ } r(); }); }) });
    });
  });
}

/** One command to the owner at `socketPath`. Resolves to its CommandResult; a transport failure is { ok: false, error: { code: 'owner_offline' } }. */
export function callOwner(socketPath: string, command: Command, { timeoutMs = 15_000 } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const offline = (why: string) => resolve({ ok: false, error: { code: OWNER_OFFLINE, message: `the factory's owner is not answering on ${socketPath}: ${why}` } });
    let sock: net.Socket;
    try { sock = net.connect(socketPath); } catch (e: any) { return offline(e.message); }
    const timer = setTimeout(() => { sock.destroy(); offline('timed out'); }, timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, command }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try { const { id: _id, ...rest } = JSON.parse(buf.slice(0, i)); resolve(rest as CommandResult); }
      catch { resolve({ ok: false, error: { code: 'bad_response', message: 'the owner answered with something that is not JSON' } }); }
    });
    sock.on('error', (e: any) => { clearTimeout(timer); offline(e.code || e.message); });
  });
}
