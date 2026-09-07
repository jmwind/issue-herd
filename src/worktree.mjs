// Where a run's worktree comes from.
//
// issue-herd makes it, with one `git worktree add`, at a path it chooses and on the branch it
// wants. That is the whole point: everything downstream — the herdr workspace, the brief, the
// pickup comment, the PR — can name the directory and the branch up front, because there is
// nothing left to discover or correct.
//
// It used to be the agent's job. `claude --worktree <slug>` created it, which meant the branch was
// named by the tool's own scheme and had to be renamed afterwards, the herdr workspace had to be
// created at the repo root before the directory existed and then re-homed once it did, and the
// watcher had to poll herdr for up to 25 seconds to find out where the agent had gone. All three of
// those existed only because something else owned this step. None of them survive it moving here,
// and the next coding tool we support inherits none of that, because starting a process in a
// directory is something every tool can do.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The directory a run's worktrees live in. Relative to the repository, and required to stay inside
 * it: `worktreeDir` comes from the committed config.json, and this is a path we create directories
 * in, so a repository you cloned does not get to choose somewhere else on your disk.
 */
export function worktreeRoot(repo, dir) {
  const root = path.resolve(repo, dir);
  if (root !== repo && !root.startsWith(repo + path.sep)) {
    throw new Error(`"worktreeDir" must stay inside the repository: ${JSON.stringify(dir)}`);
  }
  return root;
}

/**
 * Create, or reuse, the worktree for a run. `git(args, cwd)` returns trimmed stdout, or null when
 * git failed — the same shape src/branch.mjs takes.
 *
 * Returns { path, branch, created }. `branch` is what was asked for, not a promise about what git
 * ended up on; as everywhere else in this tool, the caller asks git for the truth afterwards.
 *
 * Reuse is deliberate. `issue-herd reset <KEY>` followed by another pickup should land in the same
 * place rather than accumulating `-2` directories, and an existing branch is attached to rather
 * than clobbered, because an earlier run's commits are not ours to throw away.
 */
export function makeWorktree({ git, repo, dir = '.issue-herd/worktrees', slug, branch = null, base = null }) {
  if (!slug) throw new Error('makeWorktree needs a slug');
  const root = worktreeRoot(repo, dir);
  const at = path.join(root, slug);

  if (fs.existsSync(at)) {
    const top = git(['rev-parse', '--show-toplevel'], at);
    if (top && path.resolve(top) === at) return { path: at, branch, created: false };
    throw new Error(`${at} already exists and is not a worktree of this repository`);
  }

  fs.mkdirSync(root, { recursive: true });
  const onExistingBranch = branch && git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo) !== null;
  // `base` is where a new branch starts. A reviewer's worktree is worth nothing cut from the
  // default branch: it has to hold the code it is reviewing, or "run the tests the implementer
  // said passed" is not a thing it can do. An existing branch is attached to as it stands —
  // catchUp() is what moves it on, because that is a decision about someone's commits.
  const start = base && !onExistingBranch ? [base] : [];
  const args = !branch ? ['worktree', 'add', at]
    : onExistingBranch ? ['worktree', 'add', at, branch]
      : ['worktree', 'add', '-b', branch, at, ...start];
  if (git(args, repo) === null) {
    throw new Error(`git worktree add failed for ${at}${branch ? ` on ${branch}` : ''}${start.length ? ` from ${base}` : ''} — is the branch checked out somewhere else?`);
  }
  return { path: at, branch, base: start.length ? base : null, created: true };
}

/**
 * Point an existing worktree at what `base` is now. This is the second turn of a reviewer: the
 * worktree is already there from the first turn, and the whole reason there is a second turn is
 * that the implementer pushed something since.
 *
 * Deliberately blunt — `reset --hard` — and deliberately narrow. It runs only in a worktree
 * issue-herd made for a role whose work is reading, so the thing it throws away is a reviewer's
 * scratch files, never anybody's commits: `base` is a different branch, and this one is only ever
 * fast-forwarded onto it. Returns what happened, and never throws; a reviewer looking at slightly
 * old code is a worse review, while a failed run is no review at all.
 */
export function catchUp({ git, repo, at, base }) {
  if (!at || !base) return { moved: false, reason: 'nothing to catch up to' };
  const before = git(['rev-parse', 'HEAD'], at);
  // A base another machine owns exists here only as a remote branch, so try to bring it up to date
  // first. No remote, or no network, is not a failure: the local ref is then the best we have.
  git(['fetch', '--quiet', 'origin', base], at);
  const target = ['refs/heads/' + base, 'refs/remotes/origin/' + base]
    .find((ref) => git(['show-ref', '--verify', '--quiet', ref], at) !== null);
  if (!target) return { moved: false, reason: `no branch or origin branch called ${base}` };
  const to = git(['rev-parse', target], at);
  if (!to) return { moved: false, reason: `could not read ${target}` };
  if (to === before) return { moved: false, reason: 'already up to date', at: to };
  if (git(['reset', '--hard', to], at) === null) return { moved: false, reason: 'git would not move it' };
  return { moved: true, from: before, at: to, ref: target };
}

/**
 * Give a finished run's worktree back, once its PR is merged. `git worktree remove` deletes the
 * checkout and the admin files in one step, and refuses when the tree has uncommitted or untracked
 * work in it — which is exactly the answer we want, so nothing here forces it. A worktree that is
 * kept is a log line, never an error: the merge already happened, and the cleanup lagging behind
 * costs a directory, while a forced delete costs whatever was in it.
 *
 * Returns { removed, reason }. The repository's own checkout is never removed, whatever a run
 * recorded as its working directory.
 */
export function removeWorktree({ git, repo, at }) {
  if (!at) return { removed: false, reason: 'the run had no worktree of its own' };
  const dir = path.resolve(at);
  if (dir === path.resolve(repo)) return { removed: false, reason: 'the run worked in the repository itself' };
  if (!fs.existsSync(dir)) { git(['worktree', 'prune'], repo); return { removed: false, reason: 'already gone' }; }
  if (git(['worktree', 'remove', dir], repo) !== null) return { removed: true, reason: null };
  return { removed: false, reason: 'git would not remove it (uncommitted or untracked files?) — remove it by hand when you are done with it' };
}
