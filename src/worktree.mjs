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
//
// Choosing the branch is only half of it: a worktree also has to be cut from the right *commit*.
// git's own start point is this checkout's HEAD, and in a repository whose merges happen on the
// remote — every pull request this tool opens — nothing ever moves that. That is what baseTip(),
// defaultBranch() and pullBase() are for: fetch, then start from the tip, and keep the checkout the
// watcher lives in from quietly falling behind the branch it is supposed to be on.

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
 * The branch a run's work is cut from when no role says otherwise: what `origin/HEAD` points at,
 * else a local `main` or `master`, else the branch this checkout is standing on. Null when even
 * that is nothing (a detached or empty checkout) — then a worktree starts where it always did.
 *
 * Asked, rather than configured, because the answer is a property of the repository and getting it
 * wrong is silent: a run cut from the wrong branch looks exactly like a run cut from the right one.
 */
export function defaultBranch({ git, repo }) {
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo);
  if (head) return head.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repo) !== null) return name;
  }
  const on = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  return on && on !== 'HEAD' ? on : null;
}

/**
 * Where `base` really is: `{ ref, at }`, a display name and the commit behind it.
 *
 * Everything that starts or moves a worktree comes through here, because "where is main?" has a
 * wrong answer that is easy to reach. Merges land on the remote; the watcher's own checkout only
 * learns about them when something fetches, and nothing did. So: ask origin first, then take
 * whichever of the local branch and origin's copy contains the other. No remote, or no network, is
 * not a failure — the local ref is then the best we have, and a genuine divergence keeps the local
 * branch, because commits that are only here are still somebody's and this is not the place to
 * decide about them.
 */
export function baseTip({ git, at, base }) {
  if (!base) return null;
  git(['fetch', '--quiet', 'origin', base], at);
  const read = (ref, name) => {
    const sha = git(['rev-parse', '--verify', '--quiet', ref], at);
    return sha ? { ref: name, at: sha } : null;
  };
  const local = read(`refs/heads/${base}`, base);
  const remote = read(`refs/remotes/origin/${base}`, `origin/${base}`);
  if (!local) return remote;
  if (!remote || local.at === remote.at) return local;
  return git(['merge-base', '--is-ancestor', local.at, remote.at], at) !== null ? remote : local;
}

/**
 * Fast-forward the checkout the watcher itself runs in onto `base`.
 *
 * Worktrees are cut from the tip whatever this checkout says, so this is not what keeps a run's
 * code current — it is what keeps *the checkout* current: `worktree: "none"` runs work in it
 * directly, `worktree: "herdr"` cuts from its HEAD, the config the watcher reloads is read out of
 * it, and it is the directory its owner opens. Left alone in a factory where every merge lands on
 * the remote, it silently falls months behind.
 *
 * Nothing here can lose work. It moves only a clean checkout, only when it is standing on `base`,
 * only forwards, and never with a merge: a dirty tree, another branch, or commits of its own are
 * all reported and left exactly as they are. Never throws, for the same reason catchUp() does not.
 */
export function pullBase({ git, repo, base }) {
  if (!base) return { pulled: false, reason: 'no base branch to pull' };
  const on = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  if (on !== base) return { pulled: false, reason: `the checkout is on ${on || 'no branch'}, not ${base}` };
  // Untracked files are not a reason to refuse — a fast-forward that would overwrite one is
  // refused by git itself, and the answer we want then is git's.
  if (git(['status', '--porcelain', '-uno'], repo)) return { pulled: false, reason: 'the checkout has uncommitted changes' };
  const before = git(['rev-parse', 'HEAD'], repo);
  const tip = baseTip({ git, at: repo, base });
  if (!tip) return { pulled: false, reason: `no branch or origin branch called ${base}` };
  if (tip.at === before) {
    // baseTip keeps the local branch when the two have diverged — and here the local branch *is*
    // this checkout, so it comes back as its own tip. "Already up to date" would then be hiding the
    // one state anybody needs to hear about: work here that no merge will ever bring back.
    const origin = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], repo);
    const diverged = origin && origin !== before && git(['merge-base', '--is-ancestor', origin, before], repo) === null;
    return { pulled: false, reason: diverged ? `${base} here and origin/${base} have each moved on` : 'already up to date', at: before };
  }
  // `--ff-only` is the enforcement, not a check we make and then trust: git refuses anything that
  // is not a fast-forward, and its refusal is the answer we want.
  if (git(['merge', '--ff-only', tip.at], repo) === null) return { pulled: false, reason: 'git would not fast-forward it' };
  return { pulled: true, from: before, at: tip.at, ref: tip.ref };
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
  // `base` is where a new branch starts, and it starts from the tip of it — baseTip() asks origin
  // first. A reviewer's worktree is worth nothing cut from the default branch: it has to hold the
  // code it is reviewing, or "run the tests the implementer said passed" is not a thing it can do.
  // An implementer's is worth little cut from a default branch that is three merges behind, which
  // is what `git worktree add` with no start point gives you — whatever this checkout happens to be
  // standing on, and nothing pulls that. An existing branch is attached to as it stands — catchUp()
  // is what moves it on, because that is a decision about someone's commits.
  const from = branch && !onExistingBranch ? baseTip({ git, at: repo, base }) : null;
  if (base && branch && !onExistingBranch && !from) {
    throw new Error(`there is nothing called ${base}, here or on origin, to start ${branch} from`);
  }
  // The start point is a commit, never a name: cutting the branch from `origin/main` by name would
  // leave git calling main its upstream, and a run's branch answers to nobody but itself.
  const start = from ? [from.at] : [];
  const args = !branch ? ['worktree', 'add', at]
    : onExistingBranch ? ['worktree', 'add', at, branch]
      : ['worktree', 'add', '-b', branch, at, ...start];
  if (git(args, repo) === null) {
    throw new Error(`git worktree add failed for ${at}${branch ? ` on ${branch}` : ''}${from ? ` from ${from.ref}` : ''} — is the branch checked out somewhere else?`);
  }
  return { path: at, branch, base: from ? from.ref : null, created: true };
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
  const tip = baseTip({ git, at, base });
  if (!tip) return { moved: false, reason: `no branch or origin branch called ${base}` };
  if (tip.at === before) return { moved: false, reason: 'already up to date', at: tip.at };
  if (git(['reset', '--hard', tip.at], at) === null) return { moved: false, reason: 'git would not move it' };
  return { moved: true, from: before, at: tip.at, ref: tip.ref };
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
