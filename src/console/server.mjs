// The console's HTTP surface: the gate, the page, one JSON snapshot, one event stream, one action.
//
// Everything a browser needs is served from here with no build step and no dependency: the page's
// HTML, CSS and JS are files next to this one. State goes out as one JSON document; changes go
// out over server-sent events so the page is push-based whatever feeds it. Actions are POSTs that
// must carry a session cookie and a same-origin Origin header — a page on another origin, or a
// curl from another process, cannot stop an agent.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'issue_herd_console';

function asset(name) { return fs.readFileSync(path.join(HERE, name), 'utf8'); }
/** Where the mark in the title bar takes you: the project on GitHub, in a new tab. */
export const REPO_URL = 'https://github.com/jmwind/issue-herd';

/** The mark, inlined into the title bar as a link to the repository. Posts in paper on the console's dark ground, the arrow in ember, per assets/logo/README.md. */
function mark() {
  try {
    const svg = fs.readFileSync(path.join(HERE, '..', '..', 'assets', 'logo', 'mark.svg'), 'utf8').replace(/<style>[\s\S]*?<\/style>/, '').replace('stroke="#141210"', 'stroke="#F6F2ED"').replace('width="96" height="96"', 'class="mark"').replace(' role="img" aria-label="issue-herd"', ' aria-hidden="true"');
    return '<a class="home" href="' + REPO_URL + '" target="_blank" rel="noopener" title="issue-herd on GitHub" aria-label="issue-herd on GitHub">' + svg + '</a>';
  } catch { return ''; }
}

/** Tailscale's IPv4 range is 100.64.0.0/10; the console binds there when it is gated. */
export function tailscaleAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces)) for (const i of list || []) {
    if (i.family !== 'IPv4' && i.family !== 4) continue;
    const [a, b] = i.address.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) out.push(i.address);
  }
  return out;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/**
 * Build the request handler. `console` is the orchestrator: view(), subscribe(fn), markDone(), tailTask(), exit(), tail().
 * Returns { handler, broadcast() } — call broadcast() whenever the view changed.
 */
export function createHandler({ gate, console: app, hostname = os.hostname(), log = () => {} }) {
  const clients = new Set();
  const pages = { app: asset('app.html'), unlock: asset('unlock.html'), css: asset('app.css'), js: asset('app.js') };
  const logo = mark();
  const html = (tpl) => tpl.replace(/\{\{hostname\}\}/g, hostname).replace(/\{\{gated\}\}/g, gate.enabled ? 'true' : 'false').replace(/\{\{mark\}\}/g, logo);

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const cookie = (token, maxAge) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  const address = (req) => req.socket.remoteAddress || 'unknown';

  function broadcast() {
    if (!clients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(app.view())}\n\n`;
    for (const res of clients) res.write(data);
  }

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const unlocked = gate.check(token);
    try {
      if (req.method === 'GET' && url.pathname === '/app.css') return send(res, 200, pages.css, 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, pages.js, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, gated: gate.enabled });
      if (req.method === 'POST' && url.pathname === '/unlock') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' });
        let code = '';
        try { code = JSON.parse(await readBody(req) || '{}').code || ''; } catch { return send(res, 400, { error: 'bad json' }); }
        const r = gate.tryUnlock(code, address(req));
        if (r.ok) return send(res, 200, { ok: true }, undefined, { 'set-cookie': cookie(r.token, Math.floor(gate.sessionMs / 1000)) });
        log(`console: wrong passcode from ${address(req)}${r.lockedMs ? ` — locked for ${Math.ceil(r.lockedMs / 60000)} min` : ` (${r.attemptsLeft} attempts left)`}`);
        return send(res, r.lockedMs ? 429 : 401, { ok: false, lockedMs: r.lockedMs || 0, attemptsLeft: r.attemptsLeft });
      }
      if (req.method === 'POST' && url.pathname === '/lock') {
        if (token) gate.revoke(token);
        return send(res, 200, { ok: true }, undefined, { 'set-cookie': cookie('', 0) });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        if (!unlocked) {
          const locked = gate.lockedFor(address(req));
          return send(res, 200, html(pages.unlock).replace('{{lockedMs}}', String(locked)), 'text/html; charset=utf-8');
        }
        return send(res, 200, html(pages.app), 'text/html; charset=utf-8');
      }
      if (!unlocked) return send(res, 401, { error: 'locked' });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, app.view());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(app.view())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 15_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/tail') {
        const factory = url.searchParams.get('factory');
        if (url.searchParams.get('issue')) return send(res, 200, { blocks: await app.tailTask({ factory, issue: url.searchParams.get('issue') }) });
        const text = await app.tail({ factory, run: url.searchParams.get('run') });
        return send(res, 200, { text });
      }
      if (req.method === 'POST' && (url.pathname === '/api/done' || url.pathname === '/api/undone')) {
        if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' });
        let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
        const { done, outcomes = [], error = null } = await app.markDone({ factory: body.factory, issue: body.issue }, url.pathname === '/api/done');
        log(`console: ${body.issue} in ${body.factory} ${error ? error : `marked ${done ? 'done' : 'not done'} by a person`}${outcomes.length || done ? ` → ${outcomes.map((o) => `${o.agent} ${o.outcome}`).join(', ') || 'nothing was running'}` : ''}`);
        return send(res, 200, { ok: true, done, outcomes, error });
      }
      if (req.method === 'POST' && url.pathname === '/api/exit') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' });
        let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
        const outcome = await app.exit({ factory: body.factory, run: body.run });
        log(`console: exit ${body.run} in ${body.factory} → ${outcome}`);
        return send(res, 200, { ok: true, outcome });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`console: ${req.method} ${url.pathname} failed: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  }

  return { handler, broadcast, clients };
}

/**
 * Listen on loopback, and on every Tailscale address when the console is gated. Never 0.0.0.0.
 * Returns the servers and the URLs they answer on.
 */
export async function listen({ handler, port, gated, extraHosts = [] }) {
  const hosts = ['127.0.0.1', ...(gated ? tailscaleAddresses() : []), ...extraHosts];
  const servers = []; const urls = [];
  for (const host of [...new Set(hosts)]) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    servers.push(server);
    const p = server.address().port;
    urls.push(`http://${host}:${p}/`);
  }
  return { servers, urls, port: servers[0]?.address().port, close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) };
}
