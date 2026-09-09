// Branch naming for a run.
//
// One run, one branch name, true everywhere: the brief the agent reads, the pickup comment on the
// issue, and the PR it opens. That used to be a guess. In `worktree: "claude"` mode weawr
// does not create the branch — `claude --worktree <slug>` does, and it names it by its own scheme
// (`worktree-<slug>`), so the brief promised a `claude/<slug>` that never existed, while the
// tracker's own `branchName` was a third name again.
//
// So: render the name we *want* from a template, hand it to whatever creates the worktree when we
// can (herdr mode), rename to it when we cannot (claude mode), and in both cases finish by asking
// git what the branch actually is. Observation always wins over intent — if the rename is refused,
// the brief still names the branch the agent is really standing on.

/** Two paths pointing at the same directory, ignoring a trailing slash. */
function samePath(a, b) {
  const norm = (p) => String(p).replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** Refs git rejects: control chars/space, ~^:?*[\, "..", "@{", a leading or trailing -/., "//", ".lock". */
const INVALID = /[\x00-\x20~^:?*[\\]|\.\.|@\{|^[-/.]|[-/.]$|\/\/|\.lock$/;

export function isValidBranchName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !INVALID.test(name);
}

/**
 * Render a branch template ("{{issueBranchName}}", "claude/{{slug}}", …).
 * Returns null — meaning "no opinion, take what the tool made" — for an empty template, an
 * unresolved variable (the fake issue in `smoke` has no tracker branch name), or a name git would
 * reject. Never throws: a bad template must not be able to fail a run. A variable that is present
 * and empty ({{roleSuffix}} on a roleless run) renders as nothing and is not "unresolved".
 */
export function renderBranch(template, vars = {}) {
  if (!template || typeof template !== 'string') return null;
  let missing = false;
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) { missing = true; return ''; }
    return String(v);
  });
  if (missing) return null;
  return isValidBranchName(out) ? out : null;
}

/**
 * The variables a branch template may use.
 *
 * A variable with nothing behind it is null, not "", so that renderBranch can tell "this issue has
 * no branch name" from "this run has no role" — `roleSuffix` is legitimately empty and must still
 * render, which is what makes the default template safe for roleless and role-scoped runs alike.
 */
export function branchVars({ issue, slug, role = null }) {
  return {
    issueBranchName: issue?.branchName || null,
    slug: slug || null,
    key: issue?.identifier ? issue.identifier.toLowerCase() : null,
    KEY: issue?.identifier || null,
    role: role || null,
    roleSuffix: role ? `-${role}` : '',
  };
}

/**
 * The branch this run wants, or null to accept whatever the worktree tool created.
 * Always null without a worktree: `worktree: "none"` runs on the branch the repo is already on,
 * and renaming that would move the maintainer's own checkout.
 */
export function desiredBranch({ template, issue, slug, worktree, role = null }) {
  if (worktree === 'none' || !worktree) return null;
  return renderBranch(template, branchVars({ issue, slug, role }));
}

/**
 * Reconcile `want` with the branch that actually exists in `cwd`, renaming onto it when it is safe.
 * `git(args, cwd)` must return trimmed stdout, or null when git failed.
 *
 * Returns `{ branch, action }` where `branch` is what git will report afterwards — never a name we
 * merely hoped for — and `action` says what happened, for the log. Nothing here throws: a run on an
 * unexpected branch is fine, a run whose brief names a branch that does not exist is not.
 *
 * Renaming is safe at the one moment this is called: the worktree exists, the agent has not been
 * prompted, so the branch carries no commits of ours and no upstream. It is *not* safe in the
 * maintainer's own checkout — pass `repo` and a `cwd` that is the repo root is read but never
 * renamed, which is what happens when the agent never moved into a worktree.
 */
export function reconcileBranch({ git, cwd, want, repo = null }) {
  if (repo && samePath(cwd, repo)) want = null;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!current) return { branch: null, action: 'unreadable' };
  if (current === 'HEAD') return { branch: null, action: 'detached' };
  if (!want || want === current) return { branch: current, action: 'kept' };
  // `show-ref --quiet` prints nothing and exits 1 when the ref is absent, so null means "free".
  if (git(['show-ref', '--verify', '--quiet', `refs/heads/${want}`], cwd) !== null) {
    return { branch: current, action: 'taken', want };
  }
  if (git(['branch', '-m', current, want], cwd) === null) return { branch: current, action: 'failed', want };
  return { branch: want, action: 'renamed', from: current };
}
