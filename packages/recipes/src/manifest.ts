// The bundled recipe: which revisions ship, what each asks of an agent, and what a template may say.
//
// A recipe revision is a set of templates and the result/nudge protocol they teach. Revisions are
// kept, not replaced: a factory pinned to revision 1 keeps rendering revision 1 after weawr is
// upgraded, and an active run keeps the words it was given.

export const RECIPE_ID = 'weawr-default';

export interface RecipeRevision {
  revision: number;
  /** The result-file schema version this revision's briefs teach. */
  resultSchema: number;
  templates: readonly string[];
  /** One line for `weawr recipe show` and the upgrade preview. */
  summary: string;
  /** What changed from the previous revision, for the upgrade preview. */
  changes: readonly string[];
}

export const RECIPE_REVISIONS: readonly RecipeRevision[] = [
  {
    revision: 1, resultSchema: 1, templates: ['default.md', 'review-lead.md', 'review-security.md', 'review-usability.md', 'smoke.md'],
    summary: 'the original briefs: prose review verdicts; the implementer merges itself when the issue text grants it',
    changes: [],
  },
  {
    revision: 2, resultSchema: 1, templates: ['default.md', 'review-lead.md', 'review-security.md', 'review-usability.md', 'smoke.md'],
    summary: 'structured review verdicts against a PR head; merges only through `weawr merge`, authorised by the merge label',
    changes: [
      'the implementer never merges by hand; when the issue carries the merge label it runs `weawr merge <run key>`, which checks the label, every reviewing role\'s verdict against the PR\'s current head, and mergeability',
      'reviewers put their verdict in `review: { verdict, prUrl, headSha }` as well as in words; a verdict without a head counts for nothing at merge time',
      'results are written whole (temporary file, then rename) and are checked against the schema; an unreadable result does not finish a turn',
      'new placeholders: {{runKey}}, {{mergeLabel}}, {{worktree}} (the run\'s own working tree, which the briefs now name as the only place to read, run and edit), {{weawr}} (the weawr command that runs this factory, which is what an agent is told to run)',
    ],
  },
];

export const LATEST_REVISION = RECIPE_REVISIONS[RECIPE_REVISIONS.length - 1].revision;

export function revision(n: number): RecipeRevision | null { return RECIPE_REVISIONS.find((r) => r.revision === n) ?? null; }

/** Every placeholder a brief template may use. Anything else is a typo, and a typo renders as nothing. */
export const KNOWN_PLACEHOLDERS: readonly string[] = [
  'tracker', 'identifier', 'ref', 'title', 'description', 'url', 'labels', 'project', 'team', 'priority', 'state', 'assignee', 'comments',
  'repo', 'branch', 'basedOn', 'worktreeMode', 'resultPath', 'runDir', 'rule', 'role', 'pass', 'passes', 'runLines', 'nudgeLines', 'instructions', 'date',
  'runKey', 'mergeLabel', 'worktree', 'weawr',
];

/** What a brief cannot do without: the agent has to know where to write its result. */
export const REQUIRED_PLACEHOLDERS: readonly string[] = ['resultPath'];

/** The highest template protocol a custom template may declare. */
export const TEMPLATE_PROTOCOL = 1;
