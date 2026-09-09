// The CLI's HTTP/SSE transport: /api/v1 mapped onto the same application commands the terminal
// uses, one event stream with per-factory cursors, the bundled web console as static files, and
// the gate in front of everything. Browser callers are authenticated by the session cookie and a
// same-origin check; native callers by a device token. No route computes a lifecycle fact: every
// answer is an owner's (or the store's last word, marked so).
//
// The old console routes (/api/state, /api/events, /api/tail, /api/done, /api/undone, /api/tidy,
// /api/exit) are served as compatibility adapters over the same handlers until the next minor
// release; new clients use /api/v1.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, commandSchemas, describeIssues, validate } from '@weawr/protocol';
import type { Envelope, HostSnapshot, OperationView } from '@weawr/protocol';
import type { Command, CommandResult } from '@weawr/engine';
import type { FactoryHub } from './hub.js';
import * as _gate from './gate.mjs';
const { deviceFor } = _gate as Record<string, any>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'weawr_console';
/** The web console's build. The assembled CLI keeps it in web/ next to itself; a test passes the page's own build. */
export const DEFAULT_WEB_DIR = path.join(HERE, 'web');
/** Where the mark in the title bar takes you: the project on GitHub, in a new tab. */
export const REPO_URL = 'https://github.com/jmwind/weawr';
/** The console themes that ship, by the name a browser asks for. */
export const THEMES = ['factorio', 'clean', 'linear', 'github', 'tokyo-night', 'solarized-light'] as const;
const ICONS: Record<string, [string, string]> = { '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };

/** Tailscale's IPv4 range is 100.64.0.0/10; the console binds there when it is gated. */
export function tailscaleAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) for (const i of list || []) {
    if (i.family !== 'IPv4' && (i.family as any) !== 4) continue;
    const [a, b] = i.address.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) out.push(i.address);
  }
  return out;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function readBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data)); req.on('error', reject);
  });
}
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export interface HandlerOptions {
  gate: any;
  hub: FactoryHub;
  hostname?: string;
  log?: (m: string) => void;
  webDir?: string | null;
  /** The console theme the page opens with when the browser has not chosen one: 'factorio' (default) or 'clean'. */
  theme?: string;
  /** Device tokens ({ [name]: record }), for native clients. */
  devices?: () => Record<string, any>;
  version: string;
}

type Principal = { kind: 'session' } | { kind: 'device'; name: string } | { kind: 'open' } | null;

/** The request handler and the SSE fan-out. `hub.subscribe` drives the stream; call nothing else. */
export function createHandler({ gate, hub, hostname = os.hostname(), log = () => {}, webDir = DEFAULT_WEB_DIR, devices = () => ({}), version, theme = 'factorio' }: HandlerOptions) {
  const clients = new Set<{ res: http.ServerResponse; principal: Principal }>();
  const web = webDir && fs.existsSync(webDir) ? webDir : null;
  const asset = (name: string) => (web ? fs.readFileSync(path.join(web, name), 'utf8') : '');
  const pages = web ? { app: asset('app.html'), unlock: asset('unlock.html'), css: asset('app.css'), js: asset('app.js'), client: fs.existsSync(path.join(web, 'client.js')) ? asset('client.js') : '' } : null;
  const icons = Object.fromEntries(Object.entries(ICONS).map(([p, [file, type]]) => { let body: Buffer | null = null; try { body = web ? fs.readFileSync(path.join(web, 'assets', 'icons', file)) : null; } catch { body = null; } return [p, { body, type }]; }));
  const mark = (() => { try { const svg = fs.readFileSync(path.join(web!, 'assets', 'logo', 'weawr-mark-reverse.svg'), 'utf8').replace('<svg ', '<svg class="mark" ').replace(' role="img" aria-label="weawr"', ' aria-hidden="true"'); return `<a class="home" href="${REPO_URL}" target="_blank" rel="noopener" title="weawr on GitHub" aria-label="weawr on GitHub">${svg}</a>`; } catch { return ''; } })();
  const html = (tpl: string) => tpl.replace(/\{\{hostname\}\}/g, hostname).replace(/\{\{gated\}\}/g, gate.enabled ? 'true' : 'false').replace(/\{\{mark\}\}/g, mark).replace(/\{\{theme\}\}/g, theme);
  const themes = web && fs.existsSync(path.join(web, 'themes')) ? Object.fromEntries(fs.readdirSync(path.join(web, 'themes')).filter((f) => f.endsWith('.css')).map((f) => [f.replace(/\.css$/, ''), fs.readFileSync(path.join(web, 'themes', f), 'utf8')])) : {};

  const now = () => new Date().toISOString();
  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const ok = <T,>(res: http.ServerResponse, result: T, code = 200) => send(res, code, { protocolVersion: PROTOCOL_VERSION, ok: true, result, generatedAt: now() } satisfies Envelope<T>);
  const fail = (res: http.ServerResponse, code: number, error: { code: string; message: string; retryable?: boolean; details?: unknown }) => send(res, code, { protocolVersion: PROTOCOL_VERSION, ok: false, error } satisfies Envelope<never>);
  const statusFor = (code: string) => code === 'not_found' || code === 'no_such_run' || code === 'no_such_task' || code === 'no_such_operation' ? 404 : code === 'owner_offline' || code === 'herdr_unavailable' || code === 'tracker_unavailable' ? 503 : code === 'bad_request' ? 400 : code === 'request_reused' || code === 'conflict' ? 409 : code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : 500;
  const relay = (res: http.ServerResponse, r: CommandResult) => (r.ok ? ok(res, r.result) : fail(res, statusFor(r.error.code), { ...r.error, retryable: r.error.code === 'owner_offline' || r.error.code === 'herdr_unavailable' }));
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  const address = (req: http.IncomingMessage) => req.socket.remoteAddress || 'unknown';

  /** Who is asking: a browser session (cookie), a device (bearer token), anyone (ungated), or nobody. */
  function principal(req: http.IncomingMessage): Principal {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(auth)) { const d = deviceFor(auth.replace(/^Bearer\s+/i, '').trim(), devices()); return d ? { kind: 'device', name: d.name } : null; }
    if (!gate.enabled) return { kind: 'open' };
    return gate.check(parseCookies(req.headers.cookie)[COOKIE]) ? { kind: 'session' } : null;
  }
  /** A browser's mutation must come from this origin; a device's carries its token and needs no origin. */
  const mayMutate = (req: http.IncomingMessage, p: Principal) => p?.kind === 'device' || sameOrigin(req);

  function broadcastSnapshot(snapshot: HostSnapshot) {
    if (!clients.size) return;
    const data = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const c of clients) c.res.write(data);
    // the old stream's shape, for a page not yet moved
    const legacy = `event: state\ndata: ${JSON.stringify(legacyView(snapshot))}\n\n`;
    for (const c of legacyClients) c.write(legacy);
  }
  const legacyClients = new Set<http.ServerResponse>();
  hub.subscribe((msg) => {
    if (msg.type === 'snapshot') broadcastSnapshot(msg.snapshot);
    else if (msg.type === 'event') { const data = `id: ${msg.event.factoryId}:${msg.event.seq}\nevent: event\ndata: ${JSON.stringify(msg.event)}\n\n`; for (const c of clients) c.res.write(data); }
    else if (msg.type === 'resnapshot') { const data = `event: resnapshot\ndata: ${JSON.stringify({ factoryId: msg.factoryId, reason: msg.reason })}\n\n`; for (const c of clients) c.res.write(data); }
  });

  /** The v1 command routes, each one application command with the factory named in the body. */
  async function runCommand(name: string, body: any, p: Principal): Promise<CommandResult & { factoryId?: string }> {
    const schema = (commandSchemas as any)[name];
    if (!schema) return { ok: false, error: { code: 'unknown_command', message: `no command ${name}; known: ${Object.keys(commandSchemas).join(', ')}` } };
    const v = validate(schema, body);
    if (!v.ok) return { ok: false, error: { code: 'bad_request', message: describeIssues(v.issues), details: v.issues } };
    const b: any = v.value;
    // Request ids are scoped to the factory and to the caller, so two devices cannot collide.
    const scopedId = `${p?.kind === 'device' ? `device:${p.name}` : 'browser'}:${b.requestId}`;
    const by = p?.kind === 'device' ? `device ${p.name}` : 'console';
    const targets: Array<[string, Command]> = [];
    switch (name) {
      case 'task.done': targets.push([b.factory, { type: 'task.done', issueKey: b.task, requestId: scopedId, by }]); break;
      case 'task.undo': targets.push([b.factory, { type: 'task.undo', issueKey: b.task, requestId: scopedId }]); break;
      case 'task.stop': targets.push([b.factory, { type: 'task.stop', issueKey: b.task, requestId: scopedId }]); break;
      case 'task.reset': targets.push([b.factory, { type: 'run.reset', key: b.task, requestId: scopedId }]); break;
      case 'task.tail': targets.push([b.factory, { type: 'task.tail', issueKey: b.task, lines: b.lines }]); break;
      case 'run.exit': targets.push([b.factory, { type: 'run.exit', runKey: b.run, requestId: scopedId }]); break;
      case 'run.tail': targets.push([b.factory, { type: 'agent.tail', runKey: b.run, lines: b.lines }]); break;
      case 'factory.tidy': {
        const ids = b.factory ? [b.factory] : [...hub.entries.values()].filter((e) => e.online).map((e) => e.factoryId);
        for (const id of ids) targets.push([id, { type: 'factory.tidy', requestId: scopedId }]);
        break;
      }
    }
    if (!targets.length) return { ok: true, result: { operation: null, result: { outcomes: [] } } };
    if (targets.length === 1) {
      const [fid, cmd] = targets[0];
      const r = await hub.dispatch(fid, cmd);
      if (!r.ok) return r;
      const res: any = r.result;
      const op: OperationView | null = res?.operationId ? await operationView(fid, res.operationId) : null;
      return { ok: true, result: { operation: op, result: res }, factoryId: fid };
    }
    // tidy across every factory: partial success is reported as such
    const outcomes: any[] = []; const failures: string[] = [];
    for (const [fid, cmd] of targets) { const r = await hub.dispatch(fid, cmd); if (r.ok) outcomes.push(...((r.result as any).outcomes || []).map((o: any) => ({ factory: fid, ...o }))); else failures.push(`${fid}: ${r.error.message}`); }
    return { ok: true, result: { operation: { id: `tidy-${Date.now()}`, kind: 'factory.tidy', status: failures.length ? (outcomes.length ? 'partial' : 'failed') : 'completed', requestId: b.requestId, factoryId: null, input: b, result: { outcomes }, error: failures.join('; ') || null, createdAt: now(), updatedAt: now(), retry: { safe: true, how: 'send factory.tidy again; closed workspaces stay closed' } }, result: { outcomes, failures } } };
  }

  async function operationView(factoryId: string, id: string): Promise<OperationView | null> {
    const r = await hub.dispatch(factoryId, { type: 'operation.show', id });
    if (!r.ok) return null;
    const o: any = r.result;
    return { id: o.id, kind: o.kind, status: o.status, requestId: o.requestId, factoryId, input: o.input, result: o.result, error: o.error, createdAt: o.createdAt, updatedAt: o.updatedAt, retry: o.status === 'failed' ? { safe: true, how: `send ${o.kind} again with a new request id` } : null };
  }

  async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let m: RegExpExecArray | null;
    const p = principal(req);
    const wants = Number(req.headers['x-weawr-protocol'] || 0);
    try {
      // ---- ungated: the page's static files, the gate itself, health
      if (req.method === 'GET' && pages && url.pathname === '/app.css') return send(res, 200, pages.css, 'text/css; charset=utf-8');
      if (req.method === 'GET' && pages && url.pathname === '/app.js') return send(res, 200, pages.js, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && pages && url.pathname === '/client.js') return send(res, 200, pages.client, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && (m = /^\/themes\/([a-z0-9-]+)\.css$/.exec(url.pathname))) return Object.hasOwn(themes, m[1]) ? send(res, 200, themes[m[1]], 'text/css; charset=utf-8') : send(res, 404, { error: 'no such theme' });
      if (req.method === 'GET' && icons[url.pathname]) { const { body, type } = icons[url.pathname]; return body ? send(res, 200, body, type, { 'cache-control': 'public, max-age=86400' }) : send(res, 404, { error: 'not found' }); }
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, gated: gate.enabled, protocolVersions: [PROTOCOL_VERSION], version });
      if (req.method === 'POST' && url.pathname === '/unlock') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' });
        let code = '';
        try { code = JSON.parse(await readBody(req) || '{}').code || ''; } catch { return send(res, 400, { error: 'bad json' }); }
        const r = gate.tryUnlock(code, address(req));
        if (r.ok) return send(res, 200, { ok: true }, undefined, { 'set-cookie': cookie(r.token, Math.floor(gate.sessionMs / 1000)) });
        log(`console: wrong passcode from ${address(req)}${r.lockedMs ? ` — locked for ${Math.ceil(r.lockedMs / 60000)} min` : ` (${r.attemptsLeft} attempts left)`}`);
        return send(res, r.lockedMs ? 429 : 401, { ok: false, lockedMs: r.lockedMs || 0, attemptsLeft: r.attemptsLeft });
      }
      if (req.method === 'POST' && url.pathname === '/lock') { const t = parseCookies(req.headers.cookie)[COOKIE]; if (t) gate.revoke(t); return send(res, 200, { ok: true }, undefined, { 'set-cookie': cookie('', 0) }); }
      if (req.method === 'GET' && url.pathname === '/') {
        if (!pages) return send(res, 404, 'weawr serve is running without the web console (--no-web); use /api/v1', 'text/plain');
        if (!p) return send(res, 200, html(pages.unlock).replace('{{lockedMs}}', String(gate.lockedFor(address(req)))), 'text/html; charset=utf-8');
        return send(res, 200, html(pages.app), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/capabilities') return ok(res, { protocolVersions: [PROTOCOL_VERSION], version, commands: Object.keys(commandSchemas), features: { sse: true, devices: true, compat: true }, auth: { gated: gate.enabled, mechanisms: gate.enabled ? ['session-cookie', 'device-token'] : ['open', 'device-token'] } });
      if (!p) return fail(res, 401, { code: 'unauthorized', message: gate.enabled ? 'locked: unlock with the passcode, or send a device token' : 'a device token is required for that' });
      if (wants && wants !== PROTOCOL_VERSION) return fail(res, 400, { code: 'unsupported_protocol', message: `this weawr speaks protocol ${PROTOCOL_VERSION}; the client asked for ${wants}. Update whichever is older.` });

      // ---- /api/v1
      if (req.method === 'GET' && url.pathname === '/api/v1/snapshot') return ok(res, hub.current);
      if (req.method === 'GET' && url.pathname === '/api/v1/factories') return ok(res, { factories: hub.current.factories.map((f) => ({ factoryId: f.factoryId, id: f.id, name: f.name, repo: f.repo, tracker: f.tracker, owner: f.owner, capabilities: f.capabilities ?? [] })) });
      if (req.method === 'GET' && (m = /^\/api\/v1\/factories\/([^/]+)\/snapshot$/.exec(url.pathname))) { const e = hub.factory(decodeURIComponent(m[1])); return e?.snapshot ? ok(res, e.snapshot) : fail(res, 404, { code: 'not_found', message: `no factory ${m[1]}` }); }
      if (req.method === 'GET' && (m = /^\/api\/v1\/factories\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname))) {
        const e = hub.factory(decodeURIComponent(m[1])); const task = e?.snapshot?.issues.find((i) => i.key === decodeURIComponent(m![2]));
        if (!e || !task) return fail(res, 404, { code: 'no_such_task', message: `no task ${m[2]} in ${m[1]}` });
        const at = await hub.dispatch(e.factoryId, { type: 'attempt.list', key: task.runs[0]?.key || task.key });
        return ok(res, { ...task, attempts: at.ok ? (at.result as any).attempts : [] });
      }
      if (req.method === 'GET' && (m = /^\/api\/v1\/factories\/([^/]+)\/tasks\/([^/]+)\/tail$/.exec(url.pathname))) { const e = hub.factory(decodeURIComponent(m[1])); if (!e) return fail(res, 404, { code: 'not_found', message: `no factory ${m[1]}` }); return relay(res, await hub.dispatch(e.factoryId, { type: 'task.tail', issueKey: decodeURIComponent(m[2]), lines: Number(url.searchParams.get('lines')) || 100 })); }
      if (req.method === 'GET' && (m = /^\/api\/v1\/factories\/([^/]+)\/runs\/([^/]+)\/tail$/.exec(url.pathname))) { const e = hub.factory(decodeURIComponent(m[1])); if (!e) return fail(res, 404, { code: 'not_found', message: `no factory ${m[1]}` }); return relay(res, await hub.dispatch(e.factoryId, { type: 'agent.tail', runKey: decodeURIComponent(m[2]), lines: Number(url.searchParams.get('lines')) || 100 })); }
      if (req.method === 'GET' && (m = /^\/api\/v1\/factories\/([^/]+)\/operations\/([^/]+)$/.exec(url.pathname))) { const e = hub.factory(decodeURIComponent(m[1])); if (!e) return fail(res, 404, { code: 'not_found', message: `no factory ${m[1]}` }); const op = await operationView(e.factoryId, decodeURIComponent(m[2])); return op ? ok(res, op) : fail(res, 404, { code: 'no_such_operation', message: `no operation ${m[2]}` }); }
      if (req.method === 'GET' && (m = /^\/api\/v1\/factories\/([^/]+)\/events$/.exec(url.pathname))) { const e = hub.factory(decodeURIComponent(m[1])); if (!e) return fail(res, 404, { code: 'not_found', message: `no factory ${m[1]}` }); return ok(res, await hub.eventsAfter(e.factoryId, Number(url.searchParams.get('after')) || 0, Number(url.searchParams.get('limit')) || 200)); }
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(hub.current)}\n\n`);
        // Resume: replay what each owner recorded after the client's cursor, or tell it to resnapshot.
        const cursors = String(url.searchParams.get('cursors') || '').split(',').filter(Boolean).map((c) => { const i = c.lastIndexOf(':'); return [decodeURIComponent(c.slice(0, i)), Number(c.slice(i + 1))] as const; });
        for (const [fid, seq] of cursors) {
          const r = await hub.eventsAfter(fid, seq, 500);
          if (r.expired) res.write(`event: resnapshot\ndata: ${JSON.stringify({ factoryId: fid, reason: 'the cursor is older than the events the owner keeps' })}\n\n`);
          for (const ev of r.events) res.write(`id: ${fid}:${ev.seq}\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`);
        }
        const c = { res, principal: p }; clients.add(c);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 15_000);
        req.on('close', () => { clearInterval(ping); clients.delete(c); });
        return;
      }
      if (req.method === 'POST' && (m = /^\/api\/v1\/commands\/([^/]+)$/.exec(url.pathname))) {
        if (!mayMutate(req, p)) return fail(res, 403, { code: 'forbidden', message: 'a browser may only act from the console\'s own origin; a native client sends a device token' });
        let body: any; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return fail(res, 400, { code: 'bad_request', message: 'the body is not JSON' }); }
        const r = await runCommand(m[1], body, p);
        if (r.ok) log(`console: ${m[1]} ${JSON.stringify(body)} → ${JSON.stringify((r.result as any).result).slice(0, 200)}`);
        if (!r.ok) return fail(res, statusFor(r.error.code), { ...r.error, retryable: r.error.retryable ?? (r.error.code === 'owner_offline' || r.error.code === 'herdr_unavailable') });
        return ok(res, r.result, (r.result as any).operation && !['completed', 'failed', 'partial'].includes((r.result as any).operation.status) ? 202 : 200);
      }

      // ---- compatibility adapters for the pre-v1 console (removed in the next minor release)
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, legacyView(hub.current));
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(legacyView(hub.current))}\n\n`);
        legacyClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 15_000);
        req.on('close', () => { clearInterval(ping); legacyClients.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/tail') {
        const e = hub.factory(url.searchParams.get('factory') || '');
        if (!e) return send(res, 404, { error: 'no such factory' });
        if (url.searchParams.get('issue')) { const r = await hub.dispatch(e.factoryId, { type: 'task.tail', issueKey: url.searchParams.get('issue')! }); return send(res, r.ok ? 200 : 500, r.ok ? { blocks: (r.result as any).blocks } : { error: r.error.message }); }
        const r = await hub.dispatch(e.factoryId, { type: 'agent.tail', runKey: url.searchParams.get('run') || '' });
        return send(res, 200, { text: r.ok ? (r.result as any).text ?? '(no scrollback)' : `(no scrollback: ${r.error.message})` });
      }
      if (req.method === 'POST' && ['/api/done', '/api/undone', '/api/tidy', '/api/exit'].includes(url.pathname)) {
        if (!mayMutate(req, p)) return send(res, 403, { error: 'cross-origin' });
        let body: any; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
        const e = hub.factory(body.factory || '');
        const requestId = `compat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (url.pathname === '/api/tidy') { const r = await runCommand('factory.tidy', { ...(e ? { factory: e.factoryId } : {}), requestId }, p); return send(res, 200, r.ok ? { ok: true, outcomes: (r.result as any).result.outcomes } : { ok: false, error: r.error.message }); }
        if (!e) return send(res, 404, { error: 'no such factory' });
        if (url.pathname === '/api/exit') { const r = await runCommand('run.exit', { factory: e.factoryId, run: body.run, requestId }, p); return send(res, 200, r.ok ? { ok: true, outcome: (r.result as any).result.outcome } : { ok: false, error: r.error.message }); }
        const r = await runCommand(url.pathname === '/api/done' ? 'task.done' : 'task.undo', { factory: e.factoryId, task: body.issue, requestId }, p);
        if (!r.ok) return send(res, 200, { ok: true, done: false, outcomes: [], error: r.error.message });
        const out: any = (r.result as any).result;
        return send(res, 200, { ok: true, done: !!out.done, outcomes: out.outcomes || [], error: out.error || null });
      }
      return req.method === 'GET' && url.pathname.startsWith('/api/') ? fail(res, 404, { code: 'not_found', message: `no route ${url.pathname}` }) : send(res, 404, { error: 'not found' });
    } catch (e: any) {
      log(`serve: ${req.method} ${url.pathname} failed: ${e.message}`);
      if (!res.headersSent) fail(res, 500, { code: 'internal', message: e.message });
    }
  }

  return { handler, clients, broadcast: () => broadcastSnapshot(hub.current) };
}

/** The pre-v1 console's document, from the host snapshot: what a page not yet moved expects. */
export function legacyView(snapshot: HostSnapshot) {
  return { hostname: snapshot.hostname, version: snapshot.version, herdr: snapshot.herdr, generatedAt: snapshot.generatedAt, factories: snapshot.factories.map((f) => ({ ...f, watcher: { ...f.watcher, stale: f.owner.status !== 'online' && f.watcher.stale } })) };
}

/**
 * Listen on loopback, and on every Tailscale address when the console is gated. Never 0.0.0.0.
 * Returns the servers and the URLs they answer on.
 */
export async function listen({ handler, port, gated, extraHosts = [] }: { handler: http.RequestListener; port: number; gated: boolean; extraHosts?: string[] }) {
  const hosts = ['127.0.0.1', ...(gated ? tailscaleAddresses() : []), ...extraHosts];
  const servers: http.Server[] = []; const urls: string[] = [];
  for (const host of [...new Set(hosts)]) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    servers.push(server);
    const p = (server.address() as any).port;
    urls.push(`http://${host}:${p}/`);
  }
  return { servers, urls, port: (servers[0]?.address() as any)?.port as number, close: () => Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }))) };
}
