import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { catchUp, makeWorktree, removeWorktree, worktreeRoot } from '../src/worktree.mjs';

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

test('a merged run\'s worktree is handed back, and the branch it was on survives', (t) => {
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-22', branch: 'herd/gh-22' });
  const out = removeWorktree({ git, repo: r, at: made.path });
  assert.deepEqual(out, { removed: true, reason: null });
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(git(['worktree', 'list'], r).includes(made.path), false);
  assert.ok(git(['show-ref', '--verify', 'refs/heads/herd/gh-22'], r), 'the merge is on the branch; only the checkout goes');
});

test('gitignored run state does not stop a worktree from being removed', (t) => {
  // Every run writes brief.md and result.json into .issue-herd/state/ inside its own worktree.
  const r = repo(t);
  fs.writeFileSync(path.join(r, '.gitignore'), '.issue-herd/state/\n.issue-herd/worktrees/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: r });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore state'], { cwd: r });
  const made = makeWorktree({ git, repo: r, slug: 'gh-22', branch: 'herd/gh-22' });
  fs.mkdirSync(path.join(made.path, '.issue-herd/state/runs/GH-22'), { recursive: true });
  fs.writeFileSync(path.join(made.path, '.issue-herd/state/runs/GH-22/result.json'), '{"status":"pr_open"}');
  assert.equal(removeWorktree({ git, repo: r, at: made.path }).removed, true);
});

test('a worktree with work still in it is kept, and says why', (t) => {
  // The PR is merged, but something in there is not committed. A directory is cheaper than
  // whatever that file was.
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-23', branch: 'herd/gh-23' });
  fs.writeFileSync(path.join(made.path, 'notes.txt'), 'not committed anywhere');
  const out = removeWorktree({ git, repo: r, at: made.path });
  assert.equal(out.removed, false);
  assert.match(out.reason, /uncommitted or untracked/);
  assert.ok(fs.existsSync(made.path));
});

test('the repository\'s own checkout is never removed', (t) => {
  // "worktree": "none" runs work in the checkout the watcher was started in.
  const r = repo(t);
  const out = removeWorktree({ git, repo: r, at: r });
  assert.equal(out.removed, false);
  assert.match(out.reason, /the repository itself/);
  assert.ok(fs.existsSync(path.join(r, '.git')));
  assert.deepEqual(removeWorktree({ git, repo: r, at: null }), { removed: false, reason: 'the run had no worktree of its own' });
});

test('a worktree somebody already deleted is pruned, not an error', (t) => {
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-24', branch: 'herd/gh-24' });
  fs.rmSync(made.path, { recursive: true, force: true });
  assert.deepEqual(removeWorktree({ git, repo: r, at: made.path }), { removed: false, reason: 'already gone' });
  assert.equal(git(['worktree', 'list'], r).includes(made.path), false, 'the admin files went too');
});

// ---------------------------------------------------------------- a reviewer's worktree

/** Commit a file on `branch` in `dir`, branching from HEAD the first time. Returns the new sha. */
function commitOn(dir, branch, file, body) {
  const exists = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], dir) !== null;
  git(['checkout', '-q', ...(exists ? [branch] : ['-b', branch])], dir);
  fs.writeFileSync(path.join(dir, file), body);
  git(['add', file], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `add ${file}`], dir);
  const sha = git(['rev-parse', 'HEAD'], dir);
  git(['checkout', '-q', 'main'], dir);
  return sha;
}

test('a reviewer\'s worktree starts from the branch it is reviewing, not from main', (t) => {
  // Without this the reviewer holds main's code, so "run the tests the implementer said passed" is
  // not something it can do — the change it is reviewing is not on disk.
  const dir = repo(t);
  commitOn(dir, '7-fix-the-thing', 'fix.txt', 'the implementation\n');

  const review = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-the-thing-review', base: '7-fix-the-thing' });
  assert.equal(review.created, true);
  assert.equal(review.base, '7-fix-the-thing');
  assert.equal(branchAt(review.path), '7-fix-the-thing-review');
  // its own branch, but the implementer's code
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'the implementation\n');
  // and the implementer's own worktree is untouched by any of it
  const impl = makeWorktree({ git, repo: dir, slug: 'gh-7-impl', branch: '7-fix-the-thing' });
  assert.equal(branchAt(impl.path), '7-fix-the-thing');
});

test('no base is the old behaviour: a branch cut from wherever the repository is', (t) => {
  const dir = repo(t);
  commitOn(dir, '7-fix-the-thing', 'fix.txt', 'x\n');
  const made = makeWorktree({ git, repo: dir, slug: 'plain', branch: 'plain-branch' });
  assert.equal(made.base, null);
  assert.equal(fs.existsSync(path.join(made.path, 'fix.txt')), false, 'started from main, which has no fix.txt');
});

test('a later turn is caught up to what the branch is now', (t) => {
  // The second turn of a reviewer exists *because* the implementer pushed something. Reusing the
  // worktree without moving it would review the first turn's code again and confirm its own
  // findings were never addressed.
  const dir = repo(t);
  commitOn(dir, '7-fix', 'fix.txt', 'first attempt\n');
  const review = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-review', base: '7-fix' });
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'first attempt\n');

  const after = commitOn(dir, '7-fix', 'fix.txt', 'addressed the review\n');
  // the second pickup reuses the directory, so the move is catchUp's job
  const again = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-review', base: '7-fix' });
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(path.join(again.path, 'fix.txt'), 'utf8'), 'first attempt\n', 'reuse alone does not move it');

  const moved = catchUp({ git, repo: dir, at: again.path, base: '7-fix' });
  assert.equal(moved.moved, true);
  assert.equal(moved.at, after);
  assert.equal(fs.readFileSync(path.join(again.path, 'fix.txt'), 'utf8'), 'addressed the review\n');

  // idempotent: a turn where nothing moved says so rather than pretending it did
  const nothing = catchUp({ git, repo: dir, at: again.path, base: '7-fix' });
  assert.deepEqual({ moved: nothing.moved, reason: nothing.reason }, { moved: false, reason: 'already up to date' });
});

test('catching up never throws, whatever it is pointed at', (t) => {
  // A reviewer on slightly old code is a worse review; a failed run is no review at all.
  const dir = repo(t);
  const wt = makeWorktree({ git, repo: dir, slug: 'w', branch: 'w-branch' });
  assert.match(catchUp({ git, repo: dir, at: wt.path, base: 'no-such-branch' }).reason, /no branch or origin branch/);
  assert.equal(catchUp({ git, repo: dir, at: null, base: 'x' }).moved, false);
  assert.equal(catchUp({ git, repo: dir, at: wt.path, base: null }).moved, false);
});

test('a worktree put back on an existing branch is not silently left behind', () => {
  // The case the "was it just created?" test missed: onMerged.removeWorktree (or a person) removes
  // the directory but the branch survives, so the next turn re-creates the worktree *on that
  // branch* — `base` is ignored, and the run looks brand new. Without catching up, the reviewer
  // reads the code from the turn before and confirms its own findings were never addressed.
  const dir = repo({ after: () => {} });
  try {
    commitOn(dir, '7-fix', 'f.txt', 'v1\n');
    const first = makeWorktree({ git, repo: dir, slug: 'rev', branch: '7-fix-review', base: '7-fix' });
    assert.equal(first.base, '7-fix');
    const v2 = commitOn(dir, '7-fix', 'f.txt', 'v2\n');
    git(['worktree', 'remove', '--force', first.path], dir);

    const again = makeWorktree({ git, repo: dir, slug: 'rev', branch: '7-fix-review', base: '7-fix' });
    assert.equal(again.created, true, 'the directory really is new');
    assert.equal(again.base, null, 'but it did not start from the base — the branch already existed');
    assert.equal(fs.readFileSync(path.join(again.path, 'f.txt'), 'utf8'), 'v1\n', 'so it is behind');
    // `!made.base` is the condition that catches this; `!made.created` did not.
    assert.equal(catchUp({ git, repo: dir, at: again.path, base: '7-fix' }).at, v2);
    assert.equal(fs.readFileSync(path.join(again.path, 'f.txt'), 'utf8'), 'v2\n');
  } finally {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* going away */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
