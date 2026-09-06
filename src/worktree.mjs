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
export function makeWorktree({ git, repo, dir = '.issue-herd/worktrees', slug, branch = null }) {
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
  const args = !branch ? ['worktree', 'add', at]
    : onExistingBranch ? ['worktree', 'add', at, branch]
      : ['worktree', 'add', '-b', branch, at];
  if (git(args, repo) === null) {
    throw new Error(`git worktree add failed for ${at}${branch ? ` on ${branch}` : ''} — is the branch checked out somewhere else?`);
  }
  return { path: at, branch, created: true };
}
