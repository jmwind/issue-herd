// Role-scoped claims: how several agents share one issue without fighting over the same lock.
//
// The claim is a label on the issue, arbitrated by the tracker, and that is what survives a
// restart, a lost state.json and a second machine. Its one weakness was that it was binary: an
// issue was taken or it was not, so a reviewer agent could never look at an issue an implementer
// was already holding.
//
// A role splits the lock into independent namespaces. `herdr:impl` and `herdr:review` are two
// labels, two claims, two runs, two worktrees; neither sees the other. Everything a run is keyed
// by follows the same split — the label, the pickup comment marker, the run key in state.json,
// and through it the agent name, the run directory and the worktree.
//
// No role is the old behaviour, exactly: the label is `herdr`, the run key is the issue key, and
// the claim is exclusive. That is deliberate rather than an accident of the default — a roleless
// claim means "an agent is working this issue", which is a claim on the whole issue, so it is
// blocked by any pickup comment and blocks nothing role-scoped it did not write itself.

/** Roles end up in a label, a branch, a directory and a herdr agent name, so keep them boring. */
export const ROLE_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** The comment that says an agent took the issue. The prefix of every role's marker. */
export const CLAIM_MARKER = '**issue-herd** picked this up';

/**
 * A role as written in config.json, checked. `null`/`''`/undefined mean "no role", which is the
 * single-role default. `where` names the rule in the error, because this throws at config load.
 */
export function normalizeRole(role, where = 'rule') {
  if (role === null || role === undefined || role === '') return null;
  if (typeof role !== 'string') throw new Error(`${where}: "role" must be a string, not ${typeof role}`);
  const r = role.trim().toLowerCase();
  if (!ROLE_RE.test(r)) throw new Error(`${where}: role ${JSON.stringify(role)} must be lower-case letters, digits, "-" or "_" (it becomes a label, a branch and a directory name)`);
  return r;
}

/** The label that holds this rule's claim: "herdr" with no role, "herdr:review" with one. */
export function claimLabelFor(rule) {
  if (!rule?.claimLabel) return null;
  return rule.role ? `${rule.claimLabel}:${rule.role}` : rule.claimLabel;
}

/**
 * The marker that identifies a pickup comment for this role. A roleless marker is a prefix of
 * every role's, so a roleless rule is blocked by any pickup comment while a role only sees its own.
 */
export function pickupMarker(role) {
  return role ? `${CLAIM_MARKER} as \`${role}\`` : CLAIM_MARKER;
}

/** The key a run is filed under: the issue key, plus the role when there is one. */
export function runKeyFor(identifier, role) {
  return role ? `${identifier}.${role}` : String(identifier);
}

/** The issue key a run key belongs to — `issue-herd reset GH-7` has to find `GH-7.review` too. */
export function issueKeyOf(runKey) {
  const i = String(runKey).indexOf('.');
  return i === -1 ? String(runKey) : String(runKey).slice(0, i);
}

/**
 * Returns a reason string if this issue is already held *in this rule's role*, else null.
 *
 * The label and the comment checks are role-scoped, so an issue claimed for implementation is
 * still available for review. The assignee check is not: a person holding the issue holds all of
 * it, and starting any agent on work someone is already doing is the worst outcome.
 */
export function alreadyTaken(issue, rule, viewer) {
  const label = claimLabelFor(rule);
  if (label && issue.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return `already carries the '${label}' claim label`;
  const marker = pickupMarker(rule.role);
  if ((issue.comments || []).some((c) => c.body.includes(marker))) {
    return rule.role ? `an issue-herd '${rule.role}' pickup comment is already on it` : 'an issue-herd pickup comment is already on it';
  }
  // Every assignee, not just the one on show: an issue held by you *and* someone else is still
  // someone else's.
  if (rule.skipIfAssignedToOthers && viewer) {
    const held = issue.assignees || (issue.assignee ? [issue.assignee] : []);
    const others = held.filter((a) => a.id !== viewer.id);
    if (others.length) return `assigned to ${others.map((a) => a.displayName || a.name).join(', ')}`;
  }
  return null;
}

/**
 * Which roles a project runs. `roles: ["impl", "review"]` in config.json switches on exactly those;
 * a rule whose role is not listed is disabled the same way `"enabled": false` disables one, so
 * turning a role off is one line and does not mean deleting the rules that use it. A rule with no
 * role is never filtered — it is the whole-issue claim, not one of the roles.
 *
 * Mutates and returns `rules`, because that is what loadConfig is building.
 */
export function applyRoles(rules, roles) {
  if (roles === null || roles === undefined) return rules;
  if (!Array.isArray(roles)) throw new Error('"roles" must be an array of role names, e.g. ["impl", "review"]');
  const active = new Set(roles.map((r, i) => normalizeRole(r, `roles[${i}]`)).filter(Boolean));
  for (const rule of rules) {
    if (!rule.role || active.has(rule.role)) continue;
    rule.enabled = false;
    rule.disabledReason = `role "${rule.role}" is not in "roles" (${[...active].join(', ') || 'none'})`;
  }
  return rules;
}

/**
 * True if a branch template renders differently per role. {{role}} and {{roleSuffix}} say so
 * outright; {{slug}} does too, because a run's slug is built from its run key, which carries the
 * role (`gh-7-review-fix-the-thing`).
 */
function templateKnowsRole(template) {
  return typeof template === 'string' && /\{\{\s*(role|roleSuffix|slug)\s*\}\}/.test(template);
}

/**
 * Two runs cannot check out one branch, so two roles on the same issue need two branch names.
 * Caught here, at config load, rather than as a `git worktree add` failure on the second pickup
 * of every issue — the config is wrong, and the fix is one template away.
 */
export function checkRoleBranches(rules) {
  const eligible = rules.filter((r) => r.enabled !== false && r.worktree !== 'none' && r.branch && !templateKnowsRole(r.branch));
  const byTemplate = new Map();
  for (const r of eligible) {
    const seen = byTemplate.get(r.branch) || [];
    if (seen.length && seen.some((o) => (o.role || null) !== (r.role || null))) {
      const other = seen.find((o) => (o.role || null) !== (r.role || null));
      throw new Error(`rules "${other.name}" (role ${other.role || 'none'}) and "${r.name}" (role ${r.role || 'none'}) both work on branch ${JSON.stringify(r.branch)}, so the second run could not get a worktree — give each role its own branch, e.g. "${r.branch}{{roleSuffix}}"`);
    }
    seen.push(r);
    byTemplate.set(r.branch, seen);
  }
  return rules;
}

/**
 * Which (issue, rule) pairs a poll should pick up.
 *
 * First matching rule wins, as it always did — but once per role, so an issue already being
 * implemented is still a candidate for review. A rule with no role is its own, exclusive role
 * here: nothing else roleless is considered for that issue, which is the old behaviour exactly.
 *
 * The callbacks are the watcher's, so this stays pure and testable: `matches(issue, rule)` runs
 * the rule expression, `busy(runKey, issue)` says an existing run still holds that key, and
 * `onSkip(runKey, rule, why)` reports a guard that fired. Returns [{ issue, rule, key }].
 */
export function pickCandidates({ issues, rules, viewer, matches, busy, onSkip = () => {} }) {
  const out = [];
  for (const issue of issues) {
    const settled = new Set();
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (settled.has(rule.role || '')) continue;
      if (!matches(issue, rule)) continue;
      settled.add(rule.role || '');
      const key = runKeyFor(issue.identifier, rule.role);
      if (busy(key, issue)) continue;
      const why = alreadyTaken(issue, rule, viewer);
      if (why) { onSkip(key, rule, why); continue; }
      out.push({ issue, rule, key });
    }
  }
  return out;
}
