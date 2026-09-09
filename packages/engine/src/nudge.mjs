// Nudges: how the roles on one issue work together without a person carrying messages between
// them.
//
// A reviewer that finds something must be fixed has, until now, one way to say so: a comment on
// the issue. The implementer's agent is sitting idle in the next pane, and nobody tells it. The
// owner reads the comment, opens the pane, types "the reviewer wants X" — and then does the same
// in the other direction when the fix is pushed. That is the loop the roles were meant to run on
// their own.
//
// So a finishing agent may name the role it needs next, in its result:
//
//     "nudge": { "role": "impl", "message": "Two findings must change before merge: …" }
//
// and the watcher relays it: that role's run on the same issue gets another turn straight away,
// with the message in its brief, through the same `herdr agent prompt` a person would have typed.
// The trail stays on the issue — the nudge is in the nudging run's finish comment, and the nudged
// turn's pickup comment says who asked for it — and it is capped: `maxNudges` per issue, after
// which the watcher stops relaying and asks a person in. Two agents that cannot agree should not
// be allowed to disagree for ever.
//
// Everything here is pure. The watcher owns the state and the herdr calls; this file decides.

import { ROLE_RE } from './claim.mjs';

/** How many times, per issue, one role may nudge another before a person is asked in. */
export const DEFAULT_MAX_NUDGES = 6;

/** `maxNudges` as written in config.json, checked. `where` names the file, because this throws at load. */
export function normalizeMaxNudges(n, where = 'config') {
  if (n === null || n === undefined) return DEFAULT_MAX_NUDGES;
  if (n === false) return 0;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${where}: "maxNudges" must be a whole number of 0 or more (0 turns nudging off), not ${JSON.stringify(n)}`);
  return n;
}

/** The longest message a nudge carries. Longer is a report, and reports go on the issue. */
export const MAX_MESSAGE = 4000;

/**
 * The nudges a result asks for: `nudge` may be one `{ role, message }` or a list of them. Returns
 * { nudges, rejected } — a malformed entry is a reason string, never a thrown error, because the
 * result it came in is still a result and the run it ends is still over.
 */
export function nudgesIn(result) {
  const raw = result?.nudge ?? result?.nudges;
  const nudges = []; const rejected = [];
  if (raw === null || raw === undefined) return { nudges, rejected };
  const list = Array.isArray(raw) ? raw : [raw];
  list.forEach((n, i) => {
    const at = list.length > 1 ? `nudge #${i + 1}` : 'nudge';
    if (!n || typeof n !== 'object') { rejected.push(`${at} is ${JSON.stringify(n)}, not { "role", "message" }`); return; }
    const role = typeof n.role === 'string' ? n.role.trim().toLowerCase() : '';
    if (!ROLE_RE.test(role)) { rejected.push(`${at} names no role (got ${JSON.stringify(n.role)})`); return; }
    const message = typeof n.message === 'string' ? n.message.trim() : '';
    if (!message) { rejected.push(`${at} to \`${role}\` has no message`); return; }
    nudges.push({ role, message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message });
  });
  return { nudges, rejected };
}

/** Run statuses a nudge can wake: the run is over, or waiting for its PR, and its session may still be up. */
const NUDGEABLE = new Set(['done', 'stopped', 'awaiting_merge']);
/** Run statuses a nudge has to wait for: the agent is in the middle of a turn. */
const BUSY = new Set(['starting', 'running']);

/**
 * What to do with one nudge. Returns { outcome, reason }:
 *
 *   turn     the target's run is over and its session (or its worktree) is there: give it its
 *            next turn now, with the message in the brief.
 *   queue    the target is in the middle of a turn. Interrupting it would race its own result,
 *            so the nudge waits and becomes its next turn the moment it finishes.
 *   refused  not relayed, and `reason` says why in words that can go on the issue: nudging is off,
 *            the cap is reached, there is no such run, or the run is not one that can be woken.
 *            `capped: true` marks the one refusal that means the agents ran out of road — the
 *            budget is spent — as opposed to nudging never having been on, which nobody needs
 *            to be woken up for.
 *
 * `sent` is how many nudges have been relayed on this issue so far; `max` is the cap. The cap is
 * checked before anything else, because the reason it exists is to be the thing that ends a loop
 * whatever state the loop is in. `busy` is the watcher's word that the target is spoken for even
 * though its status says otherwise: still being supervised while its finish is written up, or
 * already promised a turn by another nudge that has not started yet.
 */
export function planNudge({ nudge, from, targetRun, sent, max, busy = false }) {
  if (max === 0) return { outcome: 'refused', reason: 'nudging is off (`maxNudges` is 0)' };
  if (sent >= max) return { outcome: 'refused', capped: true, reason: `the agents have already nudged each other ${sent} time${sent === 1 ? '' : 's'} on this issue (\`maxNudges\` is ${max}), so a person needs to step in` };
  if (from && nudge.role === from) return { outcome: 'refused', reason: 'a role cannot nudge itself' };
  if (!targetRun) return { outcome: 'refused', reason: `no \`${nudge.role}\` run is on this issue yet` };
  if (BUSY.has(targetRun.status) || (busy && NUDGEABLE.has(targetRun.status))) return { outcome: 'queue', reason: `\`${nudge.role}\` is in the middle of a turn; it gets this as its next one` };
  if (targetRun.status === 'merged') return { outcome: 'refused', reason: `the \`${nudge.role}\` run is over: its pull request is merged` };
  if (targetRun.status === 'failed') return { outcome: 'refused', reason: `the last \`${nudge.role}\` start failed; the next poll retries it` };
  if (!NUDGEABLE.has(targetRun.status)) return { outcome: 'refused', reason: `the \`${nudge.role}\` run is ${targetRun.status}` };
  return { outcome: 'turn', reason: `\`${nudge.role}\` gets its next turn now` };
}

/** The nudges relayed on an issue so far — the number the cap is measured against. */
export function nudgesSent(entries) {
  return (entries || []).filter((e) => e.outcome === 'turn' || e.outcome === 'queue').length;
}

/** How many nudges are left on an issue. */
export function nudgesLeft(entries, max) {
  return Math.max(0, max - nudgesSent(entries));
}

/**
 * The nudges a turn was woken by, as the brief shows them. One nudge is one quote; several — an
 * implementer whose fix both reviewers were waiting on, say — are listed with who sent each.
 */
export function nudgeQuote(nudges) {
  const quote = (text) => text.split(/\r?\n/).map((l) => `  > ${l}`).join('\n');
  if (nudges.length === 1) return quote(nudges[0].message);
  return nudges.map((n) => `  From \`${n.from}\`:\n${quote(n.message)}`).join('\n\n');
}

/** Who a turn was nudged by, for a log line or a comment: "review", or "review and usability". */
export function nudgedByLabel(nudges) {
  const who = [...new Set(nudges.map((n) => n.from))];
  return who.length <= 1 ? who.join('') : `${who.slice(0, -1).join(', ')} and ${who.at(-1)}`;
}

/**
 * The paragraph of a brief that says how to nudge. Only a run with a role and somebody to nudge
 * gets one: a roleless run holds the whole issue, and a project with one role has nobody else.
 * `roles` is every role the project runs; `left` is how many nudges the issue has left.
 */
export function nudgeInstructions({ role, roles, left, max }) {
  if (!role || max === 0) return '';
  const others = (roles || []).filter((r) => r && r !== role);
  if (!others.length) return '';
  const named = others.map((r) => `\`${r}\``).join(', ');
  const budget = left > 0
    ? `The agents on this issue have **${left}** nudge${left === 1 ? '' : 's'} left before weawr stops relaying them and asks a person in`
    : 'The agents on this issue have **no nudges left**: weawr will not relay another, so anything that still needs another role needs a person';
  return `**Working with the other roles.** The other roles on this issue are ${named}. When your result needs
one of them to act — a reviewer whose findings must be fixed, an implementer who has pushed the fix
and wants it looked at again — say so in the result and weawr hands your message to that
role's agent as its next turn, without waiting for a person:

\`\`\`json
"nudge": { "role": "${others[0]}", "message": "What you need from it, specifically: the findings to fix, or the commits to re-read." }
\`\`\`

A list of them nudges several roles. Put the full report in \`summary\`/\`notes\` as usual — the
nudge is the ask, not the report — and do not nudge when you have nothing to ask: a verdict that
needs no action is just a comment on the issue.

${budget}. If you are going round in circles, or the issue asks for a person, write \`needs_human\`
instead of nudging again.`;
}
