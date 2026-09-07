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

/** Run statuses that are over, and so can be followed by another pass of the same role. */
const FINISHED = new Set(['done', 'stopped', 'merged']);

/**
 * How many times this rule may chime in on one issue. 1 is the old behaviour: a role takes an
 * issue once and is finished with it.
 */
export function passLimit(rule) {
  const n = rule?.passes;
  return n === null || n === undefined ? 1 : n;
}

/** `passes` as written in config.json, checked. `where` names the rule, because this throws at load. */
export function normalizePasses(passes, where = 'rule') {
  if (passes === null || passes === undefined) return 1;
  if (!Number.isInteger(passes) || passes < 1) throw new Error(`${where}: "passes" must be a whole number of 1 or more, not ${JSON.stringify(passes)}`);
  return passes;
}

/**
 * The last moment this run is answerable for. Both stamps matter: `finishedAt` is when we stopped,
 * and `issueUpdatedAt` is the issue's own clock read *after* we had finished writing to it. The
 * later of the two is the line a change has to be on the far side of — which is what stops a rule
 * with passes left from reading its own closing comment as the change that earns the next pass.
 */
function answeredAt(run) {
  const times = [run?.issueUpdatedAt, run?.finishedAt].map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** Has the issue moved since this run stopped being answerable for it? */
export function issueMovedOn(run, issue) {
  const since = answeredAt(run);
  const now = Date.parse(issue?.updatedAt ?? '');
  return since === null || !Number.isFinite(now) || now > since;
}

/**
 * May this rule take (another) turn on an issue it already has a run for, and does it still hold
 * the claim while doing so? Returns { pass, holdsClaim } or null for "leave it alone".
 *
 * Two different things come out of here:
 *
 *   A **retry** of a failed start. The claim was handed back when the start failed, so the guards
 *   have to be checked again from scratch — hence holdsClaim: false — and the pass number does not
 *   advance, because nothing was said on the issue.
 *
 *   Another **pass**, for a rule allowed more than one. The run finished, the issue has moved since
 *   (someone pushed a fix, a person replied), and the role has turns left: review, then confirm the
 *   fix, then give the thumbs up. The claim label never came off, so it is still ours and the
 *   guards are not re-checked — you cannot lose a lock you are holding.
 *
 * Everything else is null, and that is what stops a reviewer reviewing forever: a finished run with
 * no turns left, or with turns left on an issue nobody has touched, is simply not a candidate.
 */
export function nextPass(run, rule, issue) {
  if (!run) return null;
  if (run.status === 'failed') return issueMovedOn(run, issue) ? { pass: run.pass || 1, holdsClaim: false } : null;
  if (!FINISHED.has(run.status)) return null;              // starting, running, awaiting_merge: still ours
  if ((run.pass || 1) >= passLimit(rule)) return null;      // the role has said its piece
  if (!issueMovedOn(run, issue)) return null;              // nothing has happened worth answering
  return { pass: (run.pass || 1) + 1, holdsClaim: Boolean(run.claimed) };
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
export function pickCandidates({ issues, rules, viewer, matches, runFor, onSkip = () => {} }) {
  const out = [];
  for (const issue of issues) {
    const settled = new Set();
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (settled.has(rule.role || '') ) continue;
      if (!matches(issue, rule)) continue;
      settled.add(rule.role || '');
      const key = runKeyFor(issue.identifier, rule.role);
      const run = runFor(key);
      const again = run ? nextPass(run, rule, issue) : null;
      if (run && !again) continue;                     // this role is busy, or has said its piece
      // A turn we are already holding the claim for needs no guard: the label and the comment on
      // that issue are ours. Everything else is a fresh claim and is checked as one.
      if (!again?.holdsClaim) {
        const why = alreadyTaken(issue, rule, viewer);
        if (why) { onSkip(key, rule, why); continue; }
      }
      out.push({ issue, rule, key, pass: again?.pass || 1, holdsClaim: Boolean(again?.holdsClaim) });
    }
  }
  return out;
}

/**
 * What a run is called in the herdr sidebar: `<issue key> <role> <title>`.
 *
 * The role goes second, before the title, because the sidebar truncates and the title is the part
 * you can afford to lose — you need to see at a glance which agent is implementing GH-7 and which
 * is reviewing it. Only the title is trimmed, so the key and the role always survive; a run with
 * no role reads exactly as it did before.
 */
export function workspaceLabel({ key, role = null, title = '', max = 48 }) {
  const head = role ? `${key} ${role}` : String(key);
  const rest = String(title || '').trim();
  if (!rest) return head.slice(0, max);
  const room = max - head.length - 1;
  return room <= 0 ? head.slice(0, max) : `${head} ${rest.slice(0, room)}`.trim();
}
