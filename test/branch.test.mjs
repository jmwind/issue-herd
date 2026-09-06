import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { branchVars, desiredBranch, isValidBranchName, renderBranch, reconcileBranch } from '../src/branch.mjs';

const issue = { identifier: 'DEV-3298', branchName: 'jml/dev-3298-test-for-herdr' };
const slug = 'dev-3298-test-for-herdr';

test('the default template resolves to the tracker\'s own branch name', () => {
  // A PR on this branch auto-links back to the issue — that is the whole point of the default.
  assert.equal(
    desiredBranch({ template: '{{issueBranchName}}', issue, slug, worktree: 'claude' }),
    'jml/dev-3298-test-for-herdr',
  );
  assert.equal(branchVars({ issue, slug }).linearBranchName, undefined);
});

test('other templates render from slug and key', () => {
  assert.equal(desiredBranch({ template: 'claude/{{slug}}', issue, slug, worktree: 'claude' }), 'claude/dev-3298-test-for-herdr');
  assert.equal(desiredBranch({ template: 'linear/{{slug}}', issue, slug, worktree: 'herdr' }), 'linear/dev-3298-test-for-herdr');
  assert.equal(desiredBranch({ template: 'ai/{{key}}', issue, slug, worktree: 'claude' }), 'ai/dev-3298');
  assert.equal(branchVars({ issue, slug }).KEY, 'DEV-3298');
});

test('the default template gives every role its own branch, and roleless runs the old name', () => {
  // Two runs cannot check one branch out into two worktrees, so a role has to reach the name.
  const t = '{{issueBranchName}}{{roleSuffix}}';
  assert.equal(desiredBranch({ template: t, issue, slug, worktree: 'self' }), 'jml/dev-3298-test-for-herdr');
  assert.equal(desiredBranch({ template: t, issue, slug, worktree: 'self', role: 'review' }), 'jml/dev-3298-test-for-herdr-review');
  assert.equal(desiredBranch({ template: 'herd/{{role}}/{{slug}}', issue, slug, worktree: 'self', role: 'impl' }), 'herd/impl/dev-3298-test-for-herdr');
  // {{roleSuffix}} is empty on a roleless run, which is a value, not an unresolved variable.
  assert.deepEqual(branchVars({ issue, slug }).roleSuffix, '');
  assert.equal(branchVars({ issue, slug, role: 'review' }).role, 'review');
  // A template that names {{role}} on a roleless run still has nothing to render, so: no opinion.
  assert.equal(desiredBranch({ template: 'herd/{{role}}/{{slug}}', issue, slug, worktree: 'self' }), null);
});

test('no worktree means no opinion — never rename the maintainer\'s own checkout', () => {
  assert.equal(desiredBranch({ template: '{{issueBranchName}}', issue, slug, worktree: 'none' }), null);
  assert.equal(desiredBranch({ template: '{{issueBranchName}}', issue, slug, worktree: undefined }), null);
});

test('an unresolved variable yields null, not a half-rendered branch name', () => {
  // `smoke` builds a fake issue with no Linear branch name; it must fall through to whatever the
  // worktree tool named the branch rather than creating "" or "claude/".
  assert.equal(desiredBranch({ template: '{{issueBranchName}}', issue: { identifier: 'SMOKE-1' }, slug, worktree: 'claude' }), null);
  assert.equal(renderBranch('a/{{nope}}', { slug }), null);
});

test('a template git would reject yields null rather than a failing rename', () => {
  for (const bad of ['feature branch', 'foo..bar', 'foo~1', 'refs/heads/x?', '/leading', 'trailing/', 'a//b', 'x.lock', '-dash']) {
    assert.equal(renderBranch(bad, {}), null, bad);
  }
  assert.equal(renderBranch(null, {}), null);
  assert.equal(renderBranch('', {}), null);
});

test('valid names pass the git check', () => {
  for (const ok of ['jml/dev-3298-test', 'claude/dev-1', 'main', 'a/b/c', 'v1.2.3']) {
    assert.ok(isValidBranchName(ok), ok);
  }
});

// ---------------------------------------------------------------- reconcileBranch

/** A git stand-in: `refs` is the set of existing branches, `head` the checked-out one. */
function fakeGit({ head = 'worktree-dev-3298-test', refs = [], failRename = false } = {}) {
  const calls = [];
  const state = { head, refs: new Set([head, ...refs]) };
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return state.head === null ? null : state.head;
    if (args[0] === 'show-ref') return state.refs.has(args[3].replace('refs/heads/', '')) ? '' : null;
    if (args[0] === 'branch' && args[1] === '-m') {
      if (failRename) return null;
      state.refs.delete(args[2]); state.refs.add(args[3]); state.head = args[3];
      return '';
    }
    return null;
  };
  run.calls = calls; run.state = state;
  return run;
}

test('claude mode: the tool-named branch is renamed onto the one we want', () => {
  // The bug this whole module exists for: `claude --worktree <slug>` makes `worktree-<slug>`,
  // while the brief promised `jml/dev-3298-test`. Rename, and report the name that now exists.
  const git = fakeGit({ head: 'worktree-dev-3298-test' });
  const r = reconcileBranch({ git, cwd: '/wt', want: 'jml/dev-3298-test' });
  assert.deepEqual(r, { branch: 'jml/dev-3298-test', action: 'renamed', from: 'worktree-dev-3298-test' });
  assert.equal(git.state.head, 'jml/dev-3298-test');
});

test('herdr mode: the branch is already what we asked for, so nothing is renamed', () => {
  const git = fakeGit({ head: 'linear/dev-3298-test' });
  const r = reconcileBranch({ git, cwd: '/wt', want: 'linear/dev-3298-test' });
  assert.deepEqual(r, { branch: 'linear/dev-3298-test', action: 'kept' });
  assert.ok(!git.calls.some((c) => c.startsWith('branch -m')));
});

test('no wanted name: take what the tool made, do not rename', () => {
  const git = fakeGit({ head: 'worktree-smoke-1' });
  assert.deepEqual(reconcileBranch({ git, cwd: '/wt', want: null }), { branch: 'worktree-smoke-1', action: 'kept' });
  assert.ok(!git.calls.some((c) => c.startsWith('branch -m')));
});

test('an occupied name is left alone — a rerun must not steal an earlier run\'s branch', () => {
  const git = fakeGit({ head: 'worktree-dev-3298-test', refs: ['jml/dev-3298-test'] });
  const r = reconcileBranch({ git, cwd: '/wt', want: 'jml/dev-3298-test' });
  assert.deepEqual(r, { branch: 'worktree-dev-3298-test', action: 'taken', want: 'jml/dev-3298-test' });
});

test('a failed rename still reports the branch that exists, never the one we wanted', () => {
  const git = fakeGit({ head: 'worktree-dev-3298-test', failRename: true });
  const r = reconcileBranch({ git, cwd: '/wt', want: 'jml/dev-3298-test' });
  assert.equal(r.branch, 'worktree-dev-3298-test');
  assert.equal(r.action, 'failed');
});

test('the maintainer\'s own checkout is read but never renamed', () => {
  // agentCwd falls back to the repo root when Claude never moved into a worktree. Renaming there
  // would move the branch under the maintainer's feet — the worst thing this module could do.
  const git = fakeGit({ head: 'main' });
  const r = reconcileBranch({ git, cwd: '/Users/jml/Code/repo/', want: 'jml/dev-3298-test', repo: '/Users/jml/Code/repo' });
  assert.deepEqual(r, { branch: 'main', action: 'kept' });
  assert.ok(!git.calls.some((c) => c.startsWith('branch -m')));
  // A worktree under that repo is still fair game.
  const wt = fakeGit({ head: 'worktree-dev-3298-test' });
  assert.equal(reconcileBranch({ git: wt, cwd: '/Users/jml/Code/repo/.claude/worktrees/x', want: 'jml/dev-3298-test', repo: '/Users/jml/Code/repo' }).action, 'renamed');
});

test('an unreadable or detached worktree names no branch at all', () => {
  assert.deepEqual(reconcileBranch({ git: () => null, cwd: '/nope', want: 'x' }), { branch: null, action: 'unreadable' });
  assert.deepEqual(reconcileBranch({ git: () => 'HEAD', cwd: '/wt', want: 'x' }), { branch: null, action: 'detached' });
});

test('against real git: the rename happens and HEAD follows it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-herd-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (args, cwd) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  execFileSync('git', ['init', '-q', '-b', 'worktree-dev-3298-test', dir]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });

  const r = reconcileBranch({ git: g, cwd: dir, want: 'jml/dev-3298-test' });
  assert.deepEqual(r, { branch: 'jml/dev-3298-test', action: 'renamed', from: 'worktree-dev-3298-test' });
  assert.equal(g(['rev-parse', '--abbrev-ref', 'HEAD'], dir), 'jml/dev-3298-test');

  // Idempotent: a second pass finds it already right.
  assert.deepEqual(reconcileBranch({ git: g, cwd: dir, want: 'jml/dev-3298-test' }), { branch: 'jml/dev-3298-test', action: 'kept' });
});
