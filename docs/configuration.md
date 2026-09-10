# Configuration

[← back to the README](../README.md)

Everything weawr does in a repository is decided by two committed files:
`.weawr/config.json` (the rules) and `.weawr/instructions.md` (what an agent must know
about the repo). This page is the reference for both, plus the rule language and per-machine
overrides.

## Setting up a repository

**It is project-local.** You run `weawr` from inside the repository it should work on. The
tracker, the rules and the repo-specific instructions for the agent all live in that repository, so
they are reviewed and versioned with the code. Your token lives with you, not in the repo:

```
your-repo/
├── .weawr/
│   ├── .gitignore           ignores state/ and config.local.json    (committed)
│   ├── config.json          rules and defaults                      (committed)
│   ├── config.local.json    per-machine overrides of config.json    (gitignored)
│   ├── instructions.md      how to work in this repo, appended to every brief (committed)
│   ├── prompts/default.md   optional override of the built-in brief template
│   └── state/               state.json, runs/<KEY>/, logs/          (gitignored)
├── .env.local               LINEAR_API_KEY=… or GITHUB_TOKEN=…, if you prefer a file (gitignored)
└── .env.example             documents that variable                 (committed)

~/.config/weawr/credentials.json   what `weawr login` saved, per user, mode 600
~/.config/weawr/teams/<teamId>.json  one per team running on this machine, stamped by its watcher every poll
```

```bash
cd ~/Code/your-repo
weawr init
```

`init` asks which tracker the repo uses (or take `--tracker linear` / `--tracker github`) and
writes `.weawr/config.json` and `.weawr/instructions.md` from the examples, a
`.weawr/.gitignore` that keeps `state/` and `config.local.json` out of git (your repo's own
`.gitignore` is not touched), and documents the token variable in `.env.example`. It never
overwrites a file that exists, so re-running it in a repo set up by an older version adds only the
missing `.gitignore`. Then:

1. `weawr login`. GitHub: if `gh` is logged in that token is used, otherwise a browser
   sign-in. Linear: a browser sign-in when the tool has a Linear OAuth client id (see
   [Signing in](trackers.md#signing-in)), otherwise it opens the personal-API-keys page and asks you to paste
   the key. Either way the token is saved in `~/.config/weawr/credentials.json`, once per
   machine, for every repo. Prefer a file? `LINEAR_API_KEY` / `GITHUB_TOKEN` in the repo's
   `.env.local` (or the process environment) wins over the saved token.
2. Create the trigger label your rules use (e.g. `ai`). The claim label (`herdr` by default) is
   created for you the first time it is needed, on either tracker.
3. Edit `.weawr/config.json` (the rules) and `.weawr/instructions.md` (what the agent
   must know about this repo: checks to run, things never to run, branch and PR conventions, when
   to stop and ask). Commit both.
4. Smoke-test the herdr plumbing without touching the tracker (opens a workspace, starts Claude, has it
   write the result file, finalizes): `weawr smoke`. Close the workspace it leaves open when
   you have looked at it.
5. Optional: preview what the config's rules would pick up, with no side effects: `weawr dry-run`.
   To try an expression before putting it in the config: `weawr match "label:ai and team:ENG"`.

Unit tests for the tool itself: `npm test` in this repo — see [Maintainers](maintainers.md).

## The rule language

```
label:ai and team:ENG and not state:started
(label:ai or label:agent) project:Webapp priority<=2
assignee:me state:todo updated<1d
```

| field | matches | examples |
|---|---|---|
| `label` | any label on the issue | `label:ai` `label:"needs review"` `label!=blocked` |
| `project` | project name | `project:Webapp` `project:"Alpha *"` |
| `team` | team key or name | `team:ENG` `team:Engineering` |
| `assignee` | `me`, `none`, name, display name, email, `@login` | `assignee:none` `assignee:me` |
| `creator` | same as assignee | `creator:me` `creator:@alex` |
| `state` / `status` | workflow state name **or type** (`triage backlog unstarted started completed canceled`) | `state:Todo` `not state:started` |
| `priority` | `none urgent high medium low` or 0–4; `<` `<=` `>` `>=` treat "none" as lowest | `priority:urgent` `priority<=2` |
| `estimate` | points | `estimate<=3` |
| `title` | substring, or glob with `*` | `title:crash` `title:*zoom*` |
| `key` / `id` | identifier | `key:ENG-123` `key:ENG-*` |
| `cycle` | `current`, `none`, or number | `cycle:current` |
| `age` / `updated` | time since created / updated: `30m 2h 3d 1w` | `age>1d` `updated<2h` |
| `any` | everything | `any:true` |

Operators: `:` or `=` (equals, case-insensitive, `*` wildcard), `!=`, `<`, `<=`, `>`, `>=`.
Combine with `and`, `or`, `not`, parentheses; two terms side by side mean `and`. `and` binds
tighter than `or`.

The same fields work on every tracker; what they map to on GitHub is in
[Issue trackers](trackers.md) (`team` is the repository, `project` the milestone, `state` is
`open` or `closed`, `priority` comes from labels such as `P1` or `priority: high`).

## Config reference

```jsonc
{
  "name": "myapp",            // what this watcher is called. The herdr workspace it runs in is renamed
                              // "<name>Watch" (here: myappWatch) at startup so it is easy to find in the
                              // sidebar. Default: the repo folder name
  "tracker": "linear",        // "linear" (default) or "github"; or an object for options, e.g.
                              // { "type": "github", "repo": "owner/name", "prefix": "GH" }. See Issue trackers below
  "pollSeconds": 30,          // poll interval
  "lookbackDays": 30,         // only consider issues updated in this window
  "maxConcurrent": 3,         // global cap on running agents
  "roles": null,              // which roles this project runs, e.g. ["impl", "review"]. null means "whatever
                              // the rules ask for"; a list disables the rules whose role is not in it. See Roles.
  "baseBranch": null,         // the branch runs are cut from, and the one this checkout is kept on. null asks
                              // the repository: origin/HEAD, else a local main or master. See How it works,
                              // "Keeping up with main"
  "pullBase": true,           // fast-forward the checkout you started the watcher in onto that branch, at
                              // pickup and when one of its PRs is merged. Only forwards, only when the checkout
                              // is clean and standing on it; anything else is reported and left alone
  "mergeLabel": "auto-merge", // the label on an issue that lets `weawr merge <run key>` merge its PR once every
                              // reviewing role has approved the PR's current head (recipe revision 2). null turns
                              // unattended merging off entirely. See Roles.
  "mergeMethod": "squash",    // how `weawr merge` merges: "squash", "merge" or "rebase". GitHub's branch
                              // protection still applies on top.
  "maxNudges": 6,             // how many times, per issue, the roles may hand work to each other (a result's
                              // "nudge" gives another role its next turn) before a person is asked in. 0 turns
                              // it off. See Roles, "Working together"
  "defaults": {               // every rule inherits these
    "worktree": "self",       // who creates the git worktree the run works in.
                              // "self":  weawr does, with one `git worktree add` on the branch below.
                              //          The directory and the branch are settled before the agent starts,
                              //          so nothing downstream has to discover or correct them.
                              // "herdr": herdr worktree create (herdr shows it as a worktree)
                              // "none":  no worktree. The run works in the checkout you started the
                              //          watcher in, on whatever branch it is already on, and nothing is
                              //          ever renamed. If your Claude Code settings default to worktree
                              //          mode, Claude still makes one with a name of its own choosing.
    "worktreeDir": ".weawr/worktrees",  // where "self" puts them, relative to the repo. Must stay
                              // inside the repo, because config.json is committed and this is a path we
                              // create directories in. `init` gitignores it.
    "branch": "{{issueBranchName}}{{roleSuffix}}", // what the run's branch is called. The tracker's own branch
                              // name is the default: Linear's auto-links a PR back to the issue, GitHub's is
                              // what its "create a branch" button would name (7-fix-the-thing). Templates may
                              // use {{issueBranchName}}, {{slug}}, {{key}} (dev-3298), {{KEY}} (DEV-3298),
                              // {{role}} and {{roleSuffix}} ("-review", empty with no role — see Roles),
                              // e.g. "claude/{{slug}}" or "herd/{{slug}}". The worktree is created on this
                              // branch, so it is right from the start. null accepts whatever git picks.
                              // Ignored when "worktree" is "none" — that run works on the branch the repo
                              // is already on, and renaming it would move your checkout. Whatever happens,
                              // the brief, the pickup comment and result.json all quote the branch `git`
                              // actually reports, never a name weawr hoped for.
    "permissionMode": "auto",         // claude --permission-mode. auto = unattended (the point of a watcher);
                                      // acceptEdits still asks before every command; see `claude --help`
    "agentKind": "claude",    // which agent runs: passed to `herdr agent start --kind`
    "model": null,            // e.g. "opus", "gpt-5-codex"
    "effort": null,           // e.g. "high" — reasoning effort, where the agent has one
    "agentArgs": [],          // extra flags, passed to the agent verbatim, after everything above
                              // ("claudeArgs" is the old name and still works). See A second opinion.
    "maxConcurrent": 2,       // per-rule cap
    "prompt": "prompts/default.md",   // brief template: .weawr/prompts/default.md if present, else the built-in
    "instructionsFile": "instructions.md",  // repo brief appended to the prompt; "instructions" (inline string) also works
    "claimLabel": "herdr",            // label added on pickup and checked before pickup; null disables
    "role": null,             // which claim this rule holds: null (the whole issue), or "impl" / "review" /
                              // "split" / any name of your own. The label becomes "herdr:review", and rules
                              // with different roles never see each other's claims. See Roles.
    "passes": 1,              // how many turns this rule gets on one issue. 1 = take it once and be done.
                              // More gives it another turn each time the issue moves on after it finished —
                              // review, then confirm the fix, then the thumbs up. See Roles.
    "basedOn": null,          // a role name: start this rule's worktree from *that* role's branch, so a
                              // reviewer holds the code it is reviewing. Needs "worktree": "self".
                              // null = the default branch. See Roles.
    "skipIfAssignedToOthers": true,   // leave issues held by other people alone
    "onPickup": { "comment": true, "state": "In Progress", "assignToMe": true },
    "onDone":   { "comment": true, "state": "In Review", "notify": true, "closeWorkspace": false },
    "onBlocked": { "comment": true, "notify": true },   // agent hit a permission/question dialog, or
                                                        // its PR conflicts and its session is gone
    "onIdle":    { "comment": true, "notify": true },   // agent stopped without writing result.json
    "onMerged":  { "comment": false, "notify": true, "exitAgent": false,
                   "closeWorkspace": false, "removeWorktree": false }  // the PR from this run was merged
  },
  "rules": [                  // evaluated in order; first match wins; every rule inherits defaults
    { "name": "ai", "match": "label:ai and team:ENG and not state:started", "enabled": true },
    { "name": "docs", "match": "label:ai and label:docs", "instructionsFile": "instructions-docs.md" }
  ]
}
```

The repository is always the one you run `weawr` in (its git top level); rules do not name
a repo.

## Prompt templates

`prompt` names a template: a file in `.weawr/prompts/` (yours), else one of the bundled briefs
(`prompts/default.md`, `prompts/review-lead.md`, …) at the recipe revision the team is pinned
to (`weawr recipe show`). Every template is checked when the config loads: a placeholder weawr
does not fill (`{{titel}}`) or a missing `{{resultPath}}` is an error naming the file, so a typo
is found now rather than as a hole in a brief at 3am. A template of your own may say which
template protocol it was written for — `<!-- weawr-template: protocol=1 -->` on a line of its own;
one that says nothing is taken as protocol 1 and never handed obligations it did not sign up for.

What changes when reaches a running attempt is deliberate. Scheduling limits (`maxConcurrent`,
`pollSeconds`, `lookbackDays`, `maxNudges`, `roles`, a rule's `enabled`) apply live. A rule's
lifecycle policy — worktree mode, agent and model, `onDone`/`onMerged` and the rest — is recorded
on each attempt when it starts and stays with it: editing or removing the rule does not change what
a running attempt does at the end. `weawr task reconfigure <run key>` moves one onto the current
policy, on purpose; `weawr task attempts <run key>` shows what each attempt was given.

## Per-machine overrides: `config.local.json`

Anything that should differ between the machines running weawr on the same repo goes in
`.weawr/config.local.json`. It is gitignored, has the same shape as `config.json`, and is
layered over it: top-level keys replace, `defaults` merges key by key (its `on*` objects one level
deeper), and `rules` merge by `name` (a name that is not in `config.json` is added). The watcher
logs which keys are overridden at startup, and edits to it are picked up live like `config.json`.

```jsonc
{
  "defaults": { "claimLabel": "herdr-jml-mbp" },     // so the label on the issue says where it ran
  "rules": [ { "name": "docs", "enabled": false } ]  // do not run this rule on this machine
}
```

A claim label that does not exist yet is created on first use — a workspace label on Linear, a
repository label on GitHub — so a per-machine claim label like `herdr-mbp` never has to be made by
hand. With a different claim label per machine, the pickup comment marker is what stops a second
machine from taking an issue this one already claimed, so keep `onPickup.comment` on. `claimLabel`
and `role` compose: a `review` rule on `herdr-mbp` claims with `herdr-mbp:review`.

`state` values in `onPickup`/`onDone` are matched against the team's workflow by name, then by
type, so `"started"` works for any team. Set a key to `null`/`false` to skip that step.

