// Credentials: where tokens are kept, how they are found, and the browser flows that obtain them.
//
// A tracker's token is looked up in this order (resolveCredential):
//   1. the environment — the tracker's `auth.env` variables; .env.local / .env are loaded into it first
//   2. ~/.config/issue-herd/credentials.json (mode 600), written by `issue-herd login`
//   3. the tracker's own fallback, e.g. GitHub reading `gh auth token`
// `issue-herd login` runs the tracker's static login(ui) — a browser OAuth flow when the tracker
// has a client id, otherwise it opens the page where a token is made and asks for it — validates
// the result and saves it. The flows here are generic; a tracker picks one in a few lines.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------- store

export function credentialsPath() {
  if (process.env.ISSUE_HERD_CREDENTIALS) return process.env.ISSUE_HERD_CREDENTIALS;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'issue-herd', 'credentials.json');
}

export function loadCredentials(file = credentialsPath()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Save `cred` under the tracker id. The file is created 0600 in a 0700 directory. Returns what was saved. */
export function saveCredential(id, cred, file = credentialsPath()) {
  const all = loadCredentials(file);
  all[id] = { ...cred, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not every fs has modes */ }
  return all[id];
}

export function deleteCredential(id, file = credentialsPath()) {
  const all = loadCredentials(file);
  if (!(id in all)) return false;
  delete all[id];
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  return true;
}

/**
 * The credential to use for `Tracker`, or null. Returns { credential, source } where `source`
 * names where it came from for the startup banner ("LINEAR_API_KEY", the file, "gh auth token").
 */
export function resolveCredential(Tracker, { env = process.env, file = credentialsPath(), options = {} } = {}) {
  for (const name of [].concat(Tracker.auth?.env || [])) {
    if (env[name]) return { credential: { kind: 'env', token: env[name] }, source: name };
  }
  const saved = loadCredentials(file)[Tracker.id];
  if (saved?.token) return { credential: saved, source: file.replace(os.homedir(), '~'), saved: true };
  const fb = Tracker.fallback?.(options);
  if (fb?.token) return { credential: fb, source: fb.source || `${Tracker.id} fallback` };
  return null;
}

export function noCredentialError(Tracker) {
  const env = [].concat(Tracker.auth?.env || []);
  return new Error(`no ${Tracker.label} credentials. Run \`issue-herd login ${Tracker.id}\`${env.length ? `, or put ${env[0]} in the repository's .env.local` : ''}${Tracker.auth?.hint ? ` (${Tracker.auth.hint})` : ''}`);
}

// ---------------------------------------------------------------- talking to the person

/** Open a URL in the default browser. Best effort; the URL is always printed as well. */
export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try { const c = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); c.on('error', () => resolve(false)); c.on('spawn', () => { c.unref(); resolve(true); }); }
    catch { resolve(false); }
  });
}

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

/** Like ask, but nothing is echoed (a pasted token stays out of the scrollback). */
export function askSecret(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); resolve(buf); return; }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); } // Ctrl-C
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** What a tracker's login(ui) gets: log a line, open a URL (it is printed too), ask, ask for a secret. */
export function terminalUi() {
  return {
    log: (m) => console.log(m),
    open: async (url) => { console.log(`  ${url}`); const ok = await openBrowser(url); if (!ok) console.log('  (could not open a browser; open that URL yourself)'); return ok; },
    ask, askSecret,
  };
}

// ---------------------------------------------------------------- OAuth flows

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair (RFC 7636, S256). */
export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export const OAUTH_PORT = Number(process.env.ISSUE_HERD_OAUTH_PORT) || 8497;

const DONE_PAGE = (msg) => `<!doctype html><meta charset="utf-8"><title>issue-herd</title><body style="font:16px system-ui;padding:3rem"><h2>issue-herd</h2><p>${msg}</p></body>`;

/**
 * Authorization-code flow with a loopback redirect: start a local server on `port`, send the
 * browser to `authorizeUrl`, wait for the redirect back, exchange the code at `tokenUrl`.
 * PKCE is on by default so no client secret has to ship with the tool (pass `clientSecret`
 * for a provider that insists). Resolves to the token endpoint's JSON.
 * The redirect URI is http://localhost:<port><callbackPath>; register exactly that with the provider.
 */
export async function oauthCodeFlow({ authorizeUrl, tokenUrl, clientId, clientSecret = '', scope, port = OAUTH_PORT, callbackPath = '/callback', usePkce = true, extra = {}, ui, timeoutMs = 300_000, fetchImpl = fetch }) {
  if (!clientId) throw new Error('oauthCodeFlow needs a clientId');
  const state = b64url(crypto.randomBytes(16));
  const redirectUri = `http://localhost:${port}${callbackPath}`;
  const { verifier, challenge, method } = pkce();
  const url = new URL(authorizeUrl);
  for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, ...extra })) if (v != null) url.searchParams.set(k, String(v));
  if (usePkce) { url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', method); }

  const code = await new Promise((resolve, reject) => {
    const servers = [];
    const finish = (err, value) => { for (const s of servers) { try { s.close(); } catch { /* never listened */ } } clearTimeout(timer); err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('timed out waiting for the browser to come back')), timeoutMs);
    const handler = (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== callbackPath) { res.writeHead(404); res.end(); return; }
      // A request that is not our redirect (wrong state, no code) is refused but does not end the
      // wait: a stale tab or a prefetch must not be able to abort a sign-in. The provider saying
      // the person declined does end it.
      const refuse = (msg) => { res.writeHead(400, { 'content-type': 'text/html' }); res.end(DONE_PAGE(msg)); };
      if (u.searchParams.get('error')) { const msg = `${u.searchParams.get('error')}: ${u.searchParams.get('error_description') || ''}`; refuse(msg); return finish(new Error(msg)); }
      if (u.searchParams.get('state') !== state) return refuse('This is not the sign-in issue-herd is waiting for (state mismatch). Go back to the terminal and try again.');
      const c = u.searchParams.get('code');
      if (!c) return refuse('No code in the redirect.');
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(DONE_PAGE('Signed in. You can close this tab and go back to the terminal.'));
      finish(null, c);
    };
    // Browsers resolve "localhost" to either loopback address; listen on both when we can.
    let listening = 0;
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(handler);
      servers.push(s); // tracked before listen(), so finish() closes it even if it never came up
      s.on('error', (e) => { if (host === '127.0.0.1') finish(new Error(`cannot listen on ${redirectUri}: ${e.message}`)); });
      s.listen(port, host, () => { if (++listening === 1) { ui.log(`Opening your browser to sign in (waiting on ${redirectUri})`); ui.open(url.toString()); } });
    }
  });

  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId });
  if (usePkce) body.set('code_verifier', verifier);
  if (clientSecret) body.set('client_secret', clientSecret);
  return postForm(tokenUrl, body, fetchImpl);
}

/**
 * OAuth device flow (GitHub style): show a code, open the verification page, poll for the token.
 * Resolves to the token endpoint's JSON.
 */
export async function deviceFlow({ deviceUrl, tokenUrl, clientId, scope, ui, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!clientId) throw new Error('deviceFlow needs a clientId');
  const start = await postForm(deviceUrl, new URLSearchParams({ client_id: clientId, scope }), fetchImpl);
  const verify = start.verification_uri_complete || start.verification_uri;
  ui.log(`Enter this code in your browser: ${start.user_code}`);
  await ui.open(verify);
  let interval = (start.interval || 5) * 1000;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await postForm(tokenUrl, new URLSearchParams({ client_id: clientId, device_code: start.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), fetchImpl, { tolerate: true });
    if (r.access_token) return r;
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(r.error_description || r.error || 'device flow failed');
  }
  throw new Error('the code expired before it was entered');
}

/** POST a form, expect JSON back. OAuth errors ({ error }) throw unless `tolerate` (device-flow polling reads them). */
export async function postForm(url, params, fetchImpl = fetch, { tolerate = false } = {}) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: params.toString() });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!json) throw new Error(`${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  if (!tolerate && (json.error || !res.ok)) throw new Error(`${url}: ${json.error_description || json.error || `HTTP ${res.status}`}`);
  return json;
}
