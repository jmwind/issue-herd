// The brief: the one document an agent is told to read. Rendered from the rule's template with the
// issue, the run and the factory's roles; recipes does the substitution, this decides the words.
import { renderTemplate } from '@weawr/recipes';
import { passLimit } from './claim.mjs';
import { nudgeInstructions, nudgeQuote, nudgedByLabel } from './nudge.mjs';
import type { Rule } from './config.js';

export function renderBrief(template: string, vars: Record<string, string>): string {
  return renderTemplate(template, vars);
}

/**
 * The brief's one line about turns, for a rule allowed more than one of them. The first turn is
 * told it will get another, so it can report and stop instead of trying to settle everything; a
 * later turn is pointed at what it said last time and told that answering the change is the job.
 */
export function passLine(run: any, rule: Rule): string {
  const pass = run.pass || 1;
  // A nudged turn was asked for by another role, not earned by the issue moving on, so it is not
  // measured against `passes`: the turn is numbered, the asker is named, and the ask is quoted.
  if (run.nudges?.length) {
    return `- Turn: **${pass}** on this issue for this rule, because \`${nudgedByLabel(run.nudges)}\` nudged you. Your own
  last turn is in \`${run.previousResultPath || 'the run directory'}\`, and what you said is already a comment on the
  issue; so is the report the nudge came with. This is what it asks of you:

${nudgeQuote(run.nudges)}

  Answering *that* is this turn's job — do not start the work again from the beginning. When you are
  done, write the result file again (the old one was set aside), and nudge back if you need them to
  look once more.`;
  }
  const head = `- Turn: **${pass} of ${passLimit(rule)}** on this issue for this rule.`;
  if (pass === 1) {
    return `${head} You will get another turn if the issue moves on
  after you finish, so it is fine to report what you found and stop rather than trying to settle
  everything now.`;
  }
  return `${head} Your own last turn is in
  \`${run.previousResultPath || 'the run directory'}\`, and what you said is already a comment on the
  issue. Read both first: something changed after you finished, and answering *that* is this turn's
  job — do not start the work again from the beginning.`;
}

export interface Nudging { role: string | null; roles: string[]; left: number; max: number }

export function briefVars({ issue, rule, run, tracker, nudging = null, now = new Date(), runKey = '', mergeLabel = null }: { issue: any; rule: Rule; run: any; tracker: string; nudging?: Omit<Nudging, 'role'> | null; now?: Date; runKey?: string; mergeLabel?: string | null }): Record<string, string> {
  const comments = issue.comments?.length
    ? issue.comments.map((c: any) => `- **${c.author}** (${c.createdAt.slice(0, 10)}): ${c.body.replace(/\r?\n/g, '\n  ')}`).join('\n')
    : '_none_';
  const vars: Record<string, string> = {
    tracker,
    identifier: issue.identifier,
    ref: issue.ref || issue.identifier,
    title: issue.title,
    description: issue.description?.trim() || '_no description_',
    url: issue.url,
    labels: issue.labels.join(', ') || '_none_',
    project: issue.project?.name || '_none_',
    team: issue.team ? `${issue.team.name} (${issue.team.key})` : '_none_',
    priority: issue.priorityLabel || 'none',
    state: issue.state?.name || '',
    assignee: issue.assignee?.displayName || issue.assignee?.name || 'unassigned',
    comments,
    repo: rule.repo,
    branch: run.branch || '(current branch)',
    basedOn: run.basedOn || '',
    // A worktree started from another role's branch already holds the code under review, which is
    // the difference between reading a diff and running its tests. Say so, or the agent will go
    // looking for the change somewhere else.
    _baseLine: run.basedOn
      ? `- **The code you are looking at is already here.** This worktree was created from \`${run.basedOn}\`, the
  implementer's branch, so the change is checked out and you can build it and run its tests in place.
  On a later turn it is fast-forwarded to whatever that branch is now. Do not push from here.`
      : '',
    worktreeMode: rule.worktree,
    resultPath: run.resultPath,
    runDir: run.dir,
    rule: rule.name,
    role: rule.role || 'none',
    pass: String(run.pass || 1),
    passes: String(passLimit(rule)),
    // Only a rule that gets more than one turn says anything about turns, and only a later turn
    // points at what the earlier one left behind. A nudged turn always says so.
    _passLine: passLimit(rule) > 1 || run.nudges?.length ? passLine(run, rule) : '',
    // How to nudge another role, for a run that has one to nudge. Empty for a roleless run, a
    // project with one role, or nudging switched off — a brief must not teach a move it cannot make.
    nudgeLines: nudging ? nudgeInstructions({ role: rule.role, ...nudging }) : '',
    // A whole line, so a roleless brief says nothing about roles at all rather than "role: none".
    _roleLine: rule.role
      ? `- Role: \`${rule.role}\` — this run holds the \`${rule.role}\` claim on the issue. Other agents may hold
  other roles (implementation, review, splitting) on the same issue at the same time: do your role's
  work only, and do not undo or redo theirs.`
      : '',
    instructions: rule.instructions || '',
    date: now.toISOString().slice(0, 10),
    runKey,
    // No label configured: the brief names one that no issue carries, so the route stays closed.
    mergeLabel: mergeLabel || '(no merge label is configured; merging is not available)',
  };
  // One block, not three placeholders: an ordinary run has nothing to say about roles, turns or a
  // base branch, and three empty substitutions leave three blank lines in the middle of the brief.
  vars.runLines = [vars._roleLine, vars._passLine, vars._baseLine].filter(Boolean).join('\n');
  for (const k of ['_roleLine', '_passLine', '_baseLine']) delete vars[k];
  return vars;
}
