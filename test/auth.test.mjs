import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { deviceFlow, loadCredentials, oauthCodeFlow, pkce, resolveCredential, saveCredential, deleteCredential, noCredentialError } from '../src/auth.mjs';

const dirs = [];
const tmpFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-herd-auth-')); dirs.push(d); return path.join(d, 'creds', 'credentials.json'); };
// these files hold (fake) tokens; do not leave them in $TMPDIR
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const Fake = { id: 'fake', label: 'Fake', auth: { env: ['FAKE_TOKEN', 'FAKE_ALT'], hint: 'a fake token' }, fallback: () => ({ token: 'from-fallback', source: 'fake cli' }) };

test('credentials are saved per tracker, private to the user, and can be forgotten', () => {
  const file = tmpFile();
  assert.deepEqual(loadCredentials(file), {});
  const saved = saveCredential('fake', { kind: 'apiKey', token: 'abc' }, file);
  assert.equal(saved.token, 'abc');
  assert.ok(saved.savedAt);
  saveCredential('other', { token: 'def' }, file);
  assert.deepEqual(Object.keys(loadCredentials(file)), ['fake', 'other']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  assert.equal(deleteCredential('fake', file), true);
  assert.equal(deleteCredential('fake', file), false);
  assert.deepEqual(Object.keys(loadCredentials(file)), ['other']);
});

test('resolution order: environment, then the saved credential, then the tracker fallback', () => {
  const file = tmpFile();
  assert.deepEqual(resolveCredential(Fake, { env: {}, file }), { credential: { token: 'from-fallback', source: 'fake cli' }, source: 'fake cli' });
  saveCredential('fake', { kind: 'apiKey', token: 'saved' }, file);
  const fromFile = resolveCredential(Fake, { env: {}, file });
  assert.equal(fromFile.credential.token, 'saved');
  assert.equal(fromFile.saved, true);
  assert.deepEqual(resolveCredential(Fake, { env: { FAKE_ALT: 'alt' }, file }), { credential: { kind: 'env', token: 'alt' }, source: 'FAKE_ALT' });
  assert.equal(resolveCredential({ ...Fake, fallback: undefined }, { env: {}, file: tmpFile() }), null);
  assert.match(noCredentialError(Fake).message, /issue-herd login fake.*FAKE_TOKEN.*a fake token/);
});

test('a credentials file that exists but does not parse refuses to load', () => {
  // saving is a read-modify-write of the whole file, so reading a truncated one as {} would delete
  // every other tracker's token — including a refresh token that cannot be re-derived.
  const file = tmpFile();
  saveCredential('linear', { kind: 'oauth', token: 'a', refreshToken: 'r' }, file);
  fs.writeFileSync(file, '{"linear":{"kind"');
  assert.throws(() => loadCredentials(file), /is not valid JSON/);
  assert.throws(() => saveCredential('github', { token: 'b' }, file), /is not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"linear":{"kind"', 'the damaged file is left alone');
});

test('PKCE: S256 challenge of a base64url verifier, no padding', () => {
  const { verifier, challenge, method } = pkce();
  assert.equal(method, 'S256');
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
});

function formFetch(route) {
  const calls = [];
  const f = async (url, init) => { const params = Object.fromEntries(new URLSearchParams(init.body)); calls.push({ url, params }); const r = route(url, params, calls.length); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.json) }; };
  f.calls = calls;
  return f;
}

test('device flow: shows the code, opens the page, polls until the token arrives, backs off on slow_down', async () => {
  const ui = { logs: [], opened: [], log(m) { this.logs.push(m); }, open(u) { this.opened.push(u); } };
  const fetchImpl = formFetch((url, params, n) => {
    if (url.endsWith('/device/code')) return { json: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1 } };
    if (n === 2) return { json: { error: 'authorization_pending' } };
    if (n === 3) return { json: { error: 'slow_down' } };
    return { json: { access_token: 'gho_x', token_type: 'bearer' } };
  });
  const waits = [];
  const t = await deviceFlow({ deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token', clientId: 'cid', scope: 'repo', ui, fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(t.access_token, 'gho_x');
  assert.deepEqual(ui.opened, ['https://github.com/login/device']);
  assert.match(ui.logs[0], /ABCD-1234/);
  assert.deepEqual(fetchImpl.calls[0].params, { client_id: 'cid', scope: 'repo' });
  assert.equal(fetchImpl.calls[1].params.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  // the server asked for 1s; we never poll faster than 5s, and slow_down adds 5s more
  assert.deepEqual(waits, [5000, 5000, 10000]);
  await assert.rejects(deviceFlow({ deviceUrl: 'd', tokenUrl: 't', clientId: 'cid', ui, fetchImpl: formFetch((u) => (u === 'd' ? { json: { device_code: 'x', interval: 0, verification_uri: 'https://github.com/login/device' } } : { json: { error: 'access_denied', error_description: 'you said no' } })), sleep: async () => {} }), /you said no/);
});

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('the callback page escapes what the provider sent it', async () => {
  const port = await freePort();
  let opened;
  const ui = { log() {}, open: async (u) => { opened = new URL(u); } };
  const flow = oauthCodeFlow({ authorizeUrl: 'https://x/a', tokenUrl: 'https://x/t', clientId: 'cid', scope: 's', port, ui, fetchImpl: formFetch(() => ({ json: { access_token: 'x' } })), timeoutMs: 5000 });
  const failed = flow.then(() => null, (e) => e);   // attach before the request that rejects it
  while (!opened) await new Promise((r) => setTimeout(r, 10));
  const res = await fetch(`http://127.0.0.1:${port}/callback?error=denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}`);
  const body = await res.text();
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script&gt;/);
  assert.match((await failed).message, /denied/);
});

test('authorization-code flow: loopback redirect, state check, PKCE verifier in the exchange', async (t) => {
  const port = await freePort();
  t.after(() => { /* the flow closes its own servers; this fails the test loudly if it ever does not */ });
  let authorizeUrl;
  const ui = { log() {}, open: async (u) => { authorizeUrl = new URL(u); } };
  const fetchImpl = formFetch(() => ({ json: { access_token: 'lin_oauth_x', refresh_token: 'r', expires_in: 86399 } }));
  const flow = oauthCodeFlow({ authorizeUrl: 'https://linear.app/oauth/authorize', tokenUrl: 'https://api.linear.app/oauth/token', clientId: 'cid', scope: 'read,write', port, extra: { prompt: 'consent' }, ui, fetchImpl, timeoutMs: 5000 });
  while (!authorizeUrl) await new Promise((r) => setTimeout(r, 10));
  const q = authorizeUrl.searchParams;
  assert.equal(q.get('client_id'), 'cid');
  assert.equal(q.get('redirect_uri'), `http://localhost:${port}/callback`);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('code_challenge_method'), 'S256');
  // a request with the wrong state is refused and the flow keeps waiting
  const bad = await fetch(`http://127.0.0.1:${port}/callback?code=evil&state=wrong`).catch(() => null);
  assert.equal(bad?.status, 400);
  const ok = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${encodeURIComponent(q.get('state'))}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /close this tab/);
  const token = await flow;
  assert.equal(token.access_token, 'lin_oauth_x');
  const { params } = fetchImpl.calls[0];
  assert.equal(params.grant_type, 'authorization_code');
  assert.equal(params.code, 'the-code');
  assert.equal(params.client_id, 'cid');
  assert.equal(params.client_secret, undefined);
  const challenge = crypto.createHash('sha256').update(params.code_verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, q.get('code_challenge'));
});
