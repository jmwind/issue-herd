import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepoRoot } from '../dist/paths.js';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('a linked worktree resolves to its main working tree; the main tree and a plain directory resolve to themselves', (t) => {
  // Agents run `weawr merge` from the worktree weawr made for them. The factory — .weawr/, the
  // state — is in the main tree, and an empty look-alike in the worktree would be no factory.
  const main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-paths-')));
  t.after(() => fs.rmSync(main, { recursive: true, force: true }));
  git(main, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(main, 'a'), 'a'); git(main, ['add', '-A']); git(main, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'a']);
  const wt = path.join(main, '.weawr', 'worktrees', 'gh-1');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(main, ['worktree', 'add', '-q', wt, '-b', '1-x']);
  assert.equal(fs.realpathSync(findRepoRoot(wt)), main);
  assert.equal(fs.realpathSync(findRepoRoot(path.join(wt))), main);
  assert.equal(fs.realpathSync(findRepoRoot(main)), main);
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(findRepoRoot(plain), plain);
});
