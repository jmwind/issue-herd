import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWorktree, worktreeRoot } from '../src/worktree.mjs';

const git = (args, cwd) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

/** A real repository with one commit, removed when the test ends. */
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-herd-wt-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* going away anyway */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: dir });
  return fs.realpathSync(dir);
}

const branchAt = (dir) => git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);

test('the worktree exists on the branch we asked for, before anything else runs', (t) => {
  // The whole point: no discovery, no rename. The directory and the branch are both settled here,
  // so the brief, the herdr workspace, the pickup comment and the PR can all quote them.
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-7-fix-the-thing', branch: 'jml/gh-7-fix-the-thing' });
  assert.equal(made.created, true);
  assert.equal(made.path, path.join(r, '.issue-herd/worktrees/gh-7-fix-the-thing'));
  assert.ok(fs.existsSync(made.path));
  assert.equal(branchAt(made.path), 'jml/gh-7-fix-the-thing');
  assert.equal(branchAt(r), 'main', 'the maintainer\'s own checkout is untouched');
});

test('a second run for the same issue reuses the directory instead of piling up', (t) => {
  // `issue-herd reset <KEY>` then another pickup should land in the same place.
  const r = repo(t);
  const first = makeWorktree({ git, repo: r, slug: 'gh-7', branch: 'jml/gh-7' });
  fs.writeFileSync(path.join(first.path, 'scratch.txt'), 'work in progress');
  const again = makeWorktree({ git, repo: r, slug: 'gh-7', branch: 'jml/gh-7' });
  assert.equal(again.created, false);
  assert.equal(again.path, first.path);
  assert.equal(fs.readFileSync(path.join(again.path, 'scratch.txt'), 'utf8'), 'work in progress');
});

test('an existing branch is attached to, never clobbered', (t) => {
  // An earlier run's commits are not ours to throw away.
  const r = repo(t);
  execFileSync('git', ['branch', 'jml/gh-9'], { cwd: r });
  const made = makeWorktree({ git, repo: r, slug: 'gh-9', branch: 'jml/gh-9' });
  assert.equal(branchAt(made.path), 'jml/gh-9');
});

test('two issues get two worktrees on two branches', (t) => {
  const r = repo(t);
  const a = makeWorktree({ git, repo: r, slug: 'gh-1', branch: 'herd/gh-1' });
  const b = makeWorktree({ git, repo: r, slug: 'gh-2', branch: 'herd/gh-2' });
  assert.notEqual(a.path, b.path);
  assert.equal(branchAt(a.path), 'herd/gh-1');
  assert.equal(branchAt(b.path), 'herd/gh-2');
});

test('no branch asked for means git picks, and we still get a worktree', (t) => {
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'smoke-1', branch: null });
  assert.ok(fs.existsSync(made.path));
  assert.ok(branchAt(made.path));
});

test('a branch checked out somewhere else fails loudly rather than silently', (t) => {
  const r = repo(t);
  // main is checked out in the repo itself, so git refuses to check it out again
  assert.throws(() => makeWorktree({ git, repo: r, slug: 'gh-3', branch: 'main' }), /git worktree add failed/);
});

test('a directory in the way that is not a worktree is an error, not a surprise', (t) => {
  const r = repo(t);
  const inTheWay = path.join(r, '.issue-herd/worktrees/gh-4');
  fs.mkdirSync(inTheWay, { recursive: true });
  fs.writeFileSync(path.join(inTheWay, 'somebody-elses.txt'), 'x');
  assert.throws(() => makeWorktree({ git, repo: r, slug: 'gh-4', branch: 'herd/gh-4' }), /is not a worktree of this repository/);
});

test('worktreeDir cannot point outside the repository', () => {
  // config.json is committed, so this is a path a repository you cloned would otherwise choose.
  for (const bad of ['/tmp/anywhere', '../../elsewhere', '.issue-herd/../../up']) {
    assert.throws(() => worktreeRoot('/repo', bad), /must stay inside the repository/, bad);
  }
  assert.equal(worktreeRoot('/repo', '.issue-herd/worktrees'), '/repo/.issue-herd/worktrees');
  assert.equal(worktreeRoot('/repo', 'wt'), '/repo/wt');
});

test('makeWorktree needs a slug', () => {
  assert.throws(() => makeWorktree({ git, repo: '/repo', slug: '' }), /needs a slug/);
});
