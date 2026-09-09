// The console page against a fixture host: no repository, no herdr, no tracker — only the
// protocol. The page's own code is checked for what it may and may not talk to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, hostSnapshotSchema } from '@weawr/protocol';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

test('the page talks to weawr only through the client library and /api/v1; the old routes are gone from it', () => {
  const js = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.match(js, /new WeawrClient\(/);
  assert.match(js, /client\.subscribe\(/);
  for (const old of ['/api/state', '/api/events', '/api/tail', '/api/done', '/api/undone', '/api/tidy', '/api/exit', 'EventSource(']) assert.ok(!js.includes(old), `app.js still uses ${old}`);
  assert.ok(!/require\(|from '|import /.test(js), 'no module imports: it is a classic script');
  const html = fs.readFileSync(path.join(SRC, 'app.html'), 'utf8');
  assert.ok(html.indexOf('/client.js') < html.indexOf('/app.js'), 'the client loads before the page');
});

test('the built page is a static site: html, css, js, the client, and the brand assets', () => {
  for (const f of ['app.html', 'app.css', 'app.js', 'unlock.html', 'client.js', 'assets/icons/favicon.svg', 'assets/logo/weawr-mark-reverse.svg']) assert.ok(fs.existsSync(path.join(DIST, f)), f);
  assert.match(fs.readFileSync(path.join(DIST, 'client.js'), 'utf8'), /window\.WeawrClient = /);
});

test('a fixture host that speaks the protocol is all the page needs: the client in Node reads it end to end', async (t) => {
  const { WeawrClient } = await import('@weawr/client');
  const snapshot = { protocolVersion: 1, hostname: 'fixture', version: '0.0.0', herdr: { connected: true, version: '9' }, generatedAt: new Date().toISOString(), factories: [{
    protocolVersion: 1, factoryId: 'fx', id: 'app', name: 'app', repo: '/nowhere', tracker: 'github', generatedAt: new Date().toISOString(), revision: 12,
    owner: { status: 'online', pid: 1, version: '0.0.0', hostname: 'fixture', heartbeatAt: null, observedAt: new Date().toISOString() }, freshness: { herdrAt: null, trackerAt: null, trackerError: null },
    recipeRevision: 2, roles: ['impl'], rules: [{ name: 'impl', role: 'impl', match: 'label:ai', agent: 'claude', model: null, effort: null, basedOn: null, passes: 1, maxConcurrent: 2 }], maxConcurrent: 3, pollSeconds: 30,
    watcher: { version: '0.0.0', lastPoll: null, stale: false, workspaceId: null, pid: 1 }, counts: { running: 0, working: 0, alerts: 0, inflight: 0, merged: 0, done: 1 }, humanWaitMs: 0,
    production: { today: { finished: 1, merged: 0, workingMs: 60000, humanMs: 0 }, week: { finished: 1, merged: 0, workingMs: 60000, humanMs: 0 }, month: { finished: 1, merged: 0, workingMs: 60000, humanMs: 0 } },
    alerts: [], issues: [], live: { tracker: true, github: true, why: null }, capabilities: ['task.done'],
  }] };
  assert.ok(validate(hostSnapshotSchema, snapshot).ok);
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/snapshot') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocolVersion: 1, ok: true, result: snapshot, generatedAt: 'x' })); return; }
    if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(path.join(DIST, 'app.js'))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const client = new WeawrClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const s = await client.hostSnapshot();
  assert.equal(s.factories[0].name, 'app'); assert.equal(client.last.snapshot.factories[0].revision, 12);
});

test('six themes ship: Factorio (the default, overriding nothing) and five flat palettes, each scoped to its own body attribute', () => {
  const factorio = fs.readFileSync(path.join(SRC, 'themes', 'factorio.css'), 'utf8');
  assert.ok(!/\{[^}]*:[^}]*\}/.test(factorio.replace(/\/\*[\s\S]*?\*\//g, '')), 'factorio.css declares nothing: the default look is app.css');
  const names = ['clean', 'linear', 'github', 'tokyo-night', 'solarized-light'];
  for (const name of names) {
    const css = fs.readFileSync(path.join(SRC, 'themes', `${name}.css`), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{/g).map((r) => r.trim());
    assert.ok(rules.length >= 1, name);
    for (const r of rules) if (!/^@media/.test(r)) assert.ok(r.split(',').every((sel) => new RegExp(`^\\s*body\\[data-theme="${name}"\\]`).test(sel)), `${name}: not scoped: ${r}`);
    assert.match(css, /--ground:/, `${name} sets its palette`);
    assert.ok(fs.existsSync(path.join(DIST, 'themes', `${name}.css`)), `${name} shipped`);
  }
  // the flat structure every non-Factorio theme shares lives in app.css, once
  const app = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8');
  assert.match(app, /body\[data-theme\]:not\(\[data-theme="factorio"\]\) \.asm/);
  const js = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.match(js, /var THEMES = \{ factorio: 'Factorio', clean: 'weawr clean', linear: 'Linear', github: 'GitHub', 'tokyo-night': 'Tokyo Night', 'solarized-light': 'Solarized Light' \}/);
  assert.match(js, /localStorage\.setItem\('weawr-theme'/);
  assert.match(js, /data-theme-pick=/);
  const html = fs.readFileSync(path.join(SRC, 'app.html'), 'utf8');
  assert.match(html, /id="theme-css"/); assert.match(html, /data-theme="\{\{theme\}\}"/);
});

test('the page never declares a function and a variable under one name (the belt once ate the connection state)', () => {
  // `var link = …` for the connection and `function link()` for the belt between two plants shared
  // a scope; with two factories on the floor the belt was called on the state object and rendering
  // died, which the console showed as "connecting…" for ever. A hoisted function and a var of the
  // same name is legal JavaScript, so it is checked here.
  const src = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const fns = new Set([...src.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  const vars = new Set([...src.matchAll(/^\s*var\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]));
  const both = [...fns].filter((n) => vars.has(n));
  assert.deepEqual(both, [], `declared as both a function and a var: ${both.join(', ')}`);
});
