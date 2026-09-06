// The issue-tracker contract. issue-herd talks to whichever tracker config.json names through
// this interface, so adding a tracker is one file in src/trackers/ plus one line in
// src/trackers/index.mjs. linear.mjs is the reference implementation; github.mjs is the second one
// and shows how little is needed. Both are ~150 lines with no dependencies.
//
// A tracker is a class:
//
//   static id    = 'github'          // the value of "tracker" in config.json
//   static label = 'GitHub'          // in logs, comments and the agent's brief
//   static auth  = {
//     env:  ['GITHUB_TOKEN'],        // environment variables that carry a token (.env.local / .env are read too)
//     hint: 'what kind of token',    // shown when no credential is found
//   }
//   static async login(ui, opts)     // `issue-herd login`: talk to the person through `ui` (see src/auth.mjs:
//                                    // ui.log / ui.open(url) / ui.ask / ui.askSecret) and return a credential
//                                    // { token, kind, refreshToken?, expiresAt?, ... }. The CLI validates it with
//                                    // me() and saves it in ~/.config/issue-herd/credentials.json.
//   static fallback(options)         // optional: a credential found elsewhere on this machine, or null
//                                    // (GitHub: `gh auth token`). Called after env and the saved credential.
//                                    // Give it { kind: 'borrowed', source } when another tool owns and may
//                                    // rotate the token: `login` then re-reads it every run instead of
//                                    // saving a copy that would go stale.
//   static exampleConfig             // optional: what `issue-herd init` layers over config.example.json
//                                    // for this tracker (same shape as config.json; merged like config.local.json)
//
//   constructor(credential, { options, fetchImpl, onCredential })
//     credential   { token, ... } as returned by login/fallback, or { token } from the environment
//     options      the "tracker" object from config.json ({ type, ...whatever the tracker documents })
//                  plus `cwd`, the repository root; `fetchImpl` for tests; `onCredential(cred)` to
//                  persist a credential the tracker refreshed itself
//   describe()                       optional: one short string for the startup banner ("owner/repo")
//   async me()                       → User (the account the token belongs to)
//   async openIssues({ sinceIso })   → Issue[]   open issues updated since `sinceIso`
//   async issueByKey(identifier)     → Issue | null   a fresh copy (guards are re-checked right before claiming)
//   async comment(issueId, body)     markdown comment on the issue
//   async addLabel(issueId, name)    the claim label; create it if the tracker allows, else throw a clear error
//   async removeLabel(issueId, name)
//   async assign(issue, user)        `user` is what me() returned
//   async setState(issue, name)      move the issue to a workflow state by name (or type). Trackers without
//                                    workflow states document what a state name means for them.
//
// User:  { id, login?, name, displayName, email }        id is whatever assign() needs
// Issue: { id, identifier, ref, title, description, url, priority, priorityLabel, estimate,
//          createdAt, updatedAt, branchName, labels, project, team, assignee, creator, state, cycle, comments }
//   id          what comment/addLabel/assign/setState need (Linear: uuid; GitHub: the issue number)
//   identifier  the key used everywhere a person sees it and as the run's name: DEV-123, GH-7.
//               Must be safe in a file name, a branch name and a herdr agent name.
//   ref         how to reference the issue in a PR so the tracker links it: "DEV-123", "#7"
//   priority    Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low (rules sort urgent first)
//   branchName  the branch the tracker would like a fix on, or null ({{issueBranchName}} in config)
//   labels      [name]                 project { id, name } | null       team { id, key, name } | null
//   assignee    User | null            creator User | null
//   state       { id, name, type } with type one of triage backlog unstarted started completed canceled
//   cycle       { number, isActive } | null
//   comments    [{ body, createdAt, author }]  newest 25 is plenty; the pickup comment guard reads them

const USER_KEYS = ['id', 'name', 'displayName', 'email'];
const ISSUE_KEYS = ['id', 'identifier', 'ref', 'title', 'description', 'url', 'priority', 'priorityLabel', 'estimate',
  'createdAt', 'updatedAt', 'branchName', 'labels', 'project', 'team', 'assignee', 'creator', 'state', 'cycle', 'comments'];
const STATE_TYPES = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']);

/** Throws with a precise message if `issue` is not a valid normalized Issue. Used by the tracker contract test. */
export function checkIssue(issue) {
  const fail = (m) => { throw new Error(`issue ${issue?.identifier ?? '?'}: ${m}`); };
  if (!issue || typeof issue !== 'object') fail('not an object');
  for (const k of ISSUE_KEYS) if (!(k in issue)) fail(`missing "${k}"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(issue.identifier)) fail(`identifier "${issue.identifier}" is not safe for files and branches`);
  if (typeof issue.title !== 'string' || typeof issue.description !== 'string') fail('title and description must be strings');
  if (!Number.isInteger(issue.priority) || issue.priority < 0 || issue.priority > 4) fail('priority must be 0..4');
  for (const k of ['createdAt', 'updatedAt']) if (!Number.isFinite(Date.parse(issue[k]))) fail(`${k} is not a date`);
  if (!Array.isArray(issue.labels) || issue.labels.some((l) => typeof l !== 'string')) fail('labels must be strings');
  if (!issue.state || !STATE_TYPES.has(issue.state.type)) fail(`state.type must be one of ${[...STATE_TYPES].join(' ')}`);
  for (const k of ['assignee', 'creator']) if (issue[k]) for (const u of USER_KEYS) if (!(u in issue[k])) fail(`${k} is missing "${u}"`);
  if (!Array.isArray(issue.comments)) fail('comments must be an array');
  for (const c of issue.comments) if (typeof c.body !== 'string' || typeof c.author !== 'string') fail('comments need body and author');
  return issue;
}

/** Something to call a person by, for logs and the brief. */
export function userDisplay(u) {
  if (!u) return 'unknown';
  return u.email || (u.login ? `@${u.login}` : null) || u.displayName || u.name || String(u.id);
}

export function slugify(s, max = 40) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}
