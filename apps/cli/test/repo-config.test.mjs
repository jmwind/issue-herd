// weawr works its own issues, so this repository's `.weawr/config.json` is both the
// dogfood and an example other projects copy. Nothing else in the suite reads the committed
// config: a rule pointing at a prompt that was renamed, or a role missing from "roles", would be
// found by the watcher at 3am and reported as one line in a log nobody is reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const CONFIG_DIR = path.join(REPO, '.weawr');
const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));

/** What the CLI's expand() does: `.weawr/<p>` if it is there, else the package's own copy. */
// Bundled prompts live one directory per recipe revision; the latest is what a fresh factory gets.
const resolve = (p) => [path.join(CONFIG_DIR, p), path.join(REPO, 'packages/recipes/prompts/2', path.basename(p))].find((f) => fs.existsSync(f)) || null;

test('the config this repository runs on itself loads', () => {
  // `status` is the cheapest command that builds the whole config: it validates every rule, both
  // role guards and every prompt path, and touches no tracker.
  const r = spawnSync(process.execPath, [path.join(REPO, 'apps/cli/dist/weawr.mjs'), 'status'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, WEAWR_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(r.status, 0, `${r.stdout || ''}${r.stderr || ''}`);
});

test('every role its rules use is one this project runs', () => {
  // A role left out of "roles" is disabled, silently and by design — which is the right behaviour
  // for turning a reviewer off, and the wrong one for a role someone just added.
  const used = [...new Set(cfg.rules.map((r) => r.role).filter(Boolean))].sort();
  assert.deepEqual([...cfg.roles].sort(), used);
});

test('every prompt and instructions file a rule names is there', () => {
  for (const rule of cfg.rules) {
    for (const key of ['prompt', 'instructionsFile']) {
      const named = rule[key] ?? cfg.defaults[key];
      if (!named) continue;
      assert.ok(resolve(named), `rule "${rule.name}": ${key} ${JSON.stringify(named)} is not a file`);
    }
  }
});
