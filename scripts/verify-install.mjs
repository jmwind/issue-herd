#!/usr/bin/env node
// A release is acceptable only when the produced artifact installs into a clean prefix and works
// from a repository that is not this one. Workspace execution proves nothing about the package.
//
//   node scripts/verify-install.mjs         pack the root, install the tarball, exercise it
//   node scripts/verify-install.mjs --git   the real path: npm install -g git+file://<this repo>
//                                           (clones HEAD, so commit first; runs `prepare` under npm)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-verify-'));
const prefix = path.join(tmp, 'prefix');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const fail = (m) => { console.error(`verify-install: ${m}`); process.exit(1); };
const env = { ...process.env, WEAWR_NO_UPDATE_CHECK: '1', npm_config_update_notifier: 'false' };

try {
  let spec;
  if (process.argv.includes('--git')) {
    spec = `git+file://${root}`;
    console.log(`installing ${spec} (clone + prepare under npm)`);
  } else {
    const out = sh('npm', ['pack', '--pack-destination', tmp, '--ignore-scripts'], { cwd: root, env }).trim().split('\n').pop();
    spec = path.join(tmp, out);
    console.log(`packed ${out}`);
    // The tarball must carry the artifact and nothing that reaches back into the source tree.
    const listing = sh('tar', ['tzf', spec]);
    if (!/package\/apps\/cli\/dist\/weawr\.mjs/.test(listing)) fail('the tarball has no apps/cli/dist/weawr.mjs — build first');
    if (/package\/(packages|apps\/web)\//.test(listing)) fail('the tarball includes source packages');
    if (/package\/apps\/cli\/src\//.test(listing)) fail('the tarball includes apps/cli/src');
  }
  // npm 11 runs a git dependency's prepare script only when allowed by name; older npm ignores the flag.
  console.log(`npm ${sh('npm', ['--version'], { env }).trim()} on node ${process.version} (${process.platform})`);
  sh('npm', ['install', '-g', '--prefix', prefix, '--allow-scripts=weawr', '--loglevel=notice', spec], { cwd: tmp, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const bin = path.join(prefix, process.platform === 'win32' ? '' : 'bin', 'weawr');
  if (!fs.existsSync(bin)) {
    // Say what npm did install, so a missing artifact can be told from a missing link.
    const installed = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'weawr');
    const tree = (dir, depth) => { try { return fs.readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return depth > 0 && fs.statSync(p).isDirectory() ? [p, ...tree(p, depth - 1)] : [p]; }); } catch (e) { return [`${dir}: ${e.message}`]; } };
    fail(`npm exited 0 but ${bin} does not exist. Under ${prefix}:\n${tree(prefix, 3).map((p) => path.relative(prefix, p)).join('\n')}\napps/cli/dist: ${tree(path.join(installed, 'apps/cli/dist'), 1).map((p) => path.relative(installed, p)).join(', ')}`);
  }
  const version = sh(bin, ['--version'], { env }).trim();
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== expected) fail(`installed weawr reports ${version}, expected ${expected}`);
  console.log(`installed weawr ${version} into ${prefix}`);

  // A separate repository, initialised with the installed tool, then read back by it.
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo); sh('git', ['init', '-q', repo]);
  const init = sh(bin, ['init', '--tracker', 'github'], { cwd: repo, env });
  if (!/config\.json/.test(init)) fail(`init did not write a config:\n${init}`);
  const status = spawnSync(bin, ['status'], { cwd: repo, env, encoding: 'utf8' });
  if (status.status !== 0) fail(`status failed in the fresh repo:\n${status.stdout}${status.stderr}`);
  console.log('init + status ok in a fresh repository');

  // The bundled console serves its page and assets from the installed artifact.
  const con = spawn(bin, ['console', '--port', '0'], { cwd: repo, env: { ...env, WEAWR_CREDENTIALS: path.join(tmp, 'creds.json'), WEAWR_REGISTRY: path.join(tmp, 'factories.json'), WEAWR_CONSOLE_NOTES: path.join(tmp, 'notes.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`console did not announce a URL:\n${logs}`)), 20_000);
    const look = (d) => { logs += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(logs); if (m) { clearTimeout(t); resolve(m[1]); } };
    con.stdout.on('data', look); con.stderr.on('data', look);
    con.on('exit', (c) => reject(new Error(`console exited ${c}:\n${logs}`)));
  });
  try {
    for (const [p, re] of [['', /<title>[^<]+<\/title>/], ['app.js', /Team Room, the page/], ['app.css', /./], ['favicon.svg', /<svg/], ['health', /"ok":true/]]) {
      const res = await fetch(url + p);
      const body = await res.text();
      if (res.status !== 200 || !re.test(body)) fail(`GET /${p} → ${res.status}, body did not match ${re}`);
    }
    console.log(`console served its page and assets at ${url}`);
  } finally { con.kill(); }
  console.log('verify-install: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
