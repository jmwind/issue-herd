// `weawr plugins` and a plugin-provided tracker through the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/weawr.mjs', import.meta.url));
function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-plugcli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  for (const [name, body] of Object.entries(files)) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
  return dir;
}
const run = (dir, args) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, WEAWR_NO_UPDATE_CHECK: '1', XDG_CONFIG_HOME: path.join(dir, 'xdg') } }); return { status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }; };

test('weawr plugins lists what is enabled, what it provides, and what did not load; examples are listed', (t) => {
  const dir = repo(t, {
    '.weawr/config.json': JSON.stringify({ tracker: 'file', plugins: ['examples/file-intake', 'examples/docs-review', './plugins/nope.mjs'], roles: ['impl', 'docs'], rules: [{ name: 'impl', role: 'impl', match: 'label:ai' }, { name: 'docs', use: 'docs', match: 'label:ai' }] }),
    '.weawr/config.local.json': JSON.stringify({ plugins: ['examples/waiting-nudge'] }),
    '.weawr/issues.json': '[]',
  });
  const r = run(dir, ['plugins']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /file-intake 1\.0\.0  \(examples\/file-intake, shipped example\)\n  intake: tracker "file" — in use/);
  assert.match(r.out, /docs-review 1\.0\.0.*\n  roles: docs — used by docs/);
  assert.match(r.out, /waiting-nudge 1\.0\.0.*\n  tasks: long-waits every 15m/);
  assert.match(r.out, /✗ plugin "\.\/plugins\/nope\.mjs" is a path, and a path is only honoured from \.weawr\/config\.local\.json/);
  const ex = run(dir, ['plugins', 'examples']);
  assert.match(ex.out, /examples\/file-intake/); assert.match(ex.out, /examples\/docs-review/); assert.match(ex.out, /examples\/waiting-nudge/);
  // status loads the plugin tracker's config without a tracker credential
  assert.equal(run(dir, ['status']).status, 0);
  // and match reads the issues file through the plugin
  fs.writeFileSync(path.join(dir, '.weawr', 'issues.json'), JSON.stringify([{ id: 7, title: 'From a file', labels: ['ai'] }]));
  const m = run(dir, ['match', 'label:ai']);
  assert.equal(m.status, 0, m.out);
  assert.match(m.out, /F-7 .*From a file/); assert.match(m.out, /1 of 1 open Issues file .* issues match/);
});
