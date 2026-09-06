# issue-herd

Watches an issue tracker (**Linear** or **GitHub Issues**) and, when an issue matches one of your
rules, opens a **herdr workspace**, starts **Claude Code** in it (worktree mode), hands it a written
brief, and reports back to the issue: picked up → waiting for you → PR open. Runs on your own
machine, inside herdr, with no public URL and no third-party orchestrator. Zero dependencies beyond
Node 22 and the `herdr` CLI.

**It is project-local.** You run `issue-herd` from inside the repository it should work on. The
tracker, the rules and the repo-specific instructions for the agent all live in that repository, so
they are reviewed and versioned with the code. Your token lives with you, not in the repo:

```
your-repo/
├── .issue-herd/
│   ├── .gitignore           ignores state/ and config.local.json    (committed)
│   ├── config.json          rules and defaults                      (committed)
│   ├── config.local.json    per-machine overrides of config.json    (gitignored)
│   ├── instructions.md      how to work in this repo, appended to every brief (committed)
│   ├── prompts/default.md   optional override of the built-in brief template
│   └── state/               state.json, runs/<KEY>/, logs/          (gitignored)
├── .env.local               LINEAR_API_KEY=… or GITHUB_TOKEN=…, if you prefer a file (gitignored)
└── .env.example             documents that variable                 (committed)

~/.config/issue-herd/credentials.json   what `issue-herd login` saved, per user, mode 600
```

## Install

```bash
npm install -g github:jmwind/issue-herd
```

That puts `issue-herd` on your PATH. `issue-herd --version` shows what you have.

## Update

```bash
issue-herd update
```

Same as rerunning the install; it prints the old and new version. (`npm update -g` does not
reliably refresh packages installed from a git URL, so use this.)

You will not have to remember: the watching commands (`issue-herd`, `once`, `dry-run`, `match`,
`status`, `reset`) check GitHub for a newer version and print one reminder line if there is one,
and the running watcher re-checks once a day and also sends a herdr notification. The check is a 4-second fetch of `package.json` on `main`, silent when offline. Set
`ISSUE_HERD_NO_UPDATE_CHECK=1` to turn it off.

## Release a change (maintainers)

Edit, commit as usual, then:

```bash
npm run release
```

**Rename the GitHub repository to `issue-herd` before the first release under this name.** The
update check and `issue-herd update` both point at `jmwind/issue-herd`; until that repository
exists they get a 404, which `newerVersion` cannot tell from "no newer version", so every install
would silently believe it is up to date forever.

That runs the tests, bumps the patch version in `package.json`, commits it, tags `vX.Y.Z`, and
pushes commits and tags. Everyone picks it up with `issue-herd update`. Use
`npm run release:minor` for a feature. To hack on the tool without installing:

```bash
git clone git@github.com:jmwind/issue-herd.git && cd issue-herd && npm link
```

Requires Node 22+, the `herdr` CLI with its server running, `claude` on PATH and logged in, and
`gh` logged in for PRs (with GitHub Issues as the tracker, that login is also the token). No npm
dependencies.

## Set up a repository

```bash
cd ~/Code/your-repo
issue-herd init
```

`init` asks which tracker the repo uses (or take `--tracker linear` / `--tracker github`) and
writes `.issue-herd/config.json` and `.issue-herd/instructions.md` from the examples, a
`.issue-herd/.gitignore` that keeps `state/` and `config.local.json` out of git (your repo's own
`.gitignore` is not touched), and documents the token variable in `.env.example`. It never
overwrites a file that exists, so re-running it in a repo set up by an older version adds only the
missing `.gitignore`. Then:

1. `issue-herd login`. GitHub: if `gh` is logged in that token is used, otherwise a browser
   sign-in. Linear: a browser sign-in when the tool has a Linear OAuth client id (see
   [Signing in](#signing-in)), otherwise it opens the personal-API-keys page and asks you to paste
   the key. Either way the token is saved in `~/.config/issue-herd/credentials.json`, once per
   machine, for every repo. Prefer a file? `LINEAR_API_KEY` / `GITHUB_TOKEN` in the repo's
   `.env.local` (or the process environment) wins over the saved token.
2. Create the trigger label your rules use (e.g. `ai`). The claim label (`herdr` by default) is
   created for you the first time it is needed, on either tracker.
3. Edit `.issue-herd/config.json` (the rules) and `.issue-herd/instructions.md` (what the agent
   must know about this repo: checks to run, things never to run, branch and PR conventions, when
   to stop and ask). Commit both.
4. Smoke-test the herdr plumbing without touching the tracker (opens a workspace, starts Claude, has it
   write the result file, finalizes): `issue-herd smoke`. Close the workspace it leaves open when
   you have looked at it.
5. Optional: preview what the config's rules would pick up, with no side effects: `issue-herd dry-run`.
   To try an expression before putting it in the config: `issue-herd match "label:ai and team:ENG"`.

Unit tests for the tool itself: `npm test` in this repo.

## Commands

| command | what it does |
|---|---|
| `issue-herd` | **the watcher.** Reads `.issue-herd/config.json`, evaluates its rules against the tracker every `pollSeconds`, picks up matches, supervises them. Edits to `config.json` or `instructions.md` are picked up on the next poll, no restart needed; a file that fails to load is reported once and the previous config stays in force until it is fixed. Run this one in herdr. |
| `issue-herd once` | one poll with the config's rules, then exit (stays up while it supervises anything it picked up) |
| `issue-herd dry-run` | the config's rules, print what would be picked up, change nothing |
| `issue-herd match "<expr>"` | evaluate an ad hoc expression against open issues, change nothing; for testing a rule before adding it |
| `issue-herd status` | tracked runs and their outcome |
| `issue-herd reset <KEY>` | forget a run so the issue can be picked up again |
| `issue-herd login [linear\|github] [--paste]` | sign in (browser when possible) and save the token for this machine; `--paste` skips straight to pasting a token |
| `issue-herd logout [linear\|github]` | forget the saved token |
| `issue-herd smoke` | end-to-end herdr test with a fake issue, no tracker calls |
| `issue-herd init [--tracker linear\|github]` | scaffold `.issue-herd/` in the current repo |

## Run it in herdr

From the repo directory:

```bash
herdr tab create --label issue-herd --cwd "$PWD" --no-focus
# read .result.root_pane.pane_id from the JSON, then
herdr pane run <pane-id> "issue-herd"
```

One watcher per repository. Run several in separate panes if you have several repos. When the
watcher starts inside herdr it renames its own workspace to `<name>Watch` (`name` from the config,
default: the repo folder name) so it is easy to spot in the sidebar.

Leave that pane alone; the herdr server keeps it alive when you detach. Every issue it picks up
becomes its own workspace in the sidebar, labelled with the issue key, with Claude's status
(working / blocked / done) shown by herdr. Step into any of them and talk to the agent.

### What the pane shows

A startup banner (version, repo, rules, guards, the tracker account and where its token came from,
herdr connection), then one **live line** that is rewritten after every poll:

```
14:32:10 poll #48 · 47 open · 1 matched · 0 picked · running 2: DEV-12 w3 working · DEV-15 w4 blocked · next in 30s
```

Anything that *happens* gets its own timestamped line above it and goes to
`.issue-herd/state/logs/issue-herd.log`: an issue picked up (with workspace and working tree), an
issue that matched but was skipped and why (once per issue), an agent blocking on a dialog or
going idle without a result, unblocking, finishing with its status and PR, a failed poll. When
stdout is not a terminal (pm2, a log file) the live line is printed every tenth poll instead.

`issue-herd status` from another pane prints the same picture as a table, with each running
agent's live herdr state.

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
[Issue trackers](#issue-trackers) (`team` is the repository, `project` the milestone, `state` is
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
  "defaults": {               // every rule inherits these
    "worktree": "self",       // who creates the git worktree the run works in.
                              // "self":  issue-herd does, with one `git worktree add` on the branch below.
                              //          The directory and the branch are settled before the agent starts,
                              //          so nothing downstream has to discover or correct them.
                              // "herdr": herdr worktree create (herdr shows it as a worktree)
                              // "none":  no worktree. The run works in the checkout you started the
                              //          watcher in, on whatever branch it is already on, and nothing is
                              //          ever renamed. If your Claude Code settings default to worktree
                              //          mode, Claude still makes one with a name of its own choosing.
    "worktreeDir": ".issue-herd/worktrees",  // where "self" puts them, relative to the repo. Must stay
                              // inside the repo, because config.json is committed and this is a path we
                              // create directories in. `init` gitignores it.
    "branch": "{{issueBranchName}}", // what the run's branch is called. The tracker's own branch name is the
                              // default: Linear's auto-links a PR back to the issue, GitHub's is what its
                              // "create a branch" button would name (7-fix-the-thing). Templates may use
                              // {{issueBranchName}}, {{slug}}, {{key}} (dev-3298), {{KEY}} (DEV-3298),
                              // e.g. "claude/{{slug}}" or "herd/{{slug}}". The worktree is created on this
                              // branch, so it is right from the start. null accepts whatever git picks.
                              // Ignored when "worktree" is "none" — that run works on the branch the repo
                              // is already on, and renaming it would move your checkout. Whatever happens,
                              // the brief, the pickup comment and result.json all quote the branch `git`
                              // actually reports, never a name issue-herd hoped for.
    "permissionMode": "auto",         // claude --permission-mode. auto = unattended (the point of a watcher);
                                      // acceptEdits still asks before every command; see `claude --help`
    "claudeArgs": [],         // extra flags for claude, e.g. ["--model", "opus"]
    "maxConcurrent": 2,       // per-rule cap
    "prompt": "prompts/default.md",   // brief template: .issue-herd/prompts/default.md if present, else the built-in
    "instructionsFile": "instructions.md",  // repo brief appended to the prompt; "instructions" (inline string) also works
    "claimLabel": "herdr",            // label added on pickup and checked before pickup; null disables
    "skipIfAssignedToOthers": true,   // leave issues held by other people alone
    "onPickup": { "comment": true, "state": "In Progress", "assignToMe": true },
    "onDone":   { "comment": true, "state": "In Review", "notify": true, "closeWorkspace": false },
    "onBlocked": { "comment": true, "notify": true },   // agent hit a permission/question dialog
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

The repository is always the one you run `issue-herd` in (its git top level); rules do not name
a repo.

### Per-machine overrides: `config.local.json`

Anything that should differ between the machines running issue-herd on the same repo goes in
`.issue-herd/config.local.json`. It is gitignored, has the same shape as `config.json`, and is
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
machine from taking an issue this one already claimed, so keep `onPickup.comment` on.

`state` values in `onPickup`/`onDone` are matched against the team's workflow by name, then by
type, so `"started"` works for any team. Set a key to `null`/`false` to skip that step.

## Issue trackers

`"tracker"` in `config.json` says which one. Everything else (rules, guards, the brief, the
comments) is the same for all of them.

**Linear** (`"tracker": "linear"`, the default). Issues are known by their key (`DEV-123`), the
branch is Linear's own branch name, `state` is the team workflow, comments and state changes go to
the issue. The claim label must exist in Linear.

**GitHub Issues** (`"tracker": "github"`). The repository is the `origin` remote of the repo you run
in; name it explicitly with `{ "type": "github", "repo": "owner/name" }`. Issues are known as `GH-7`
(change the prefix with `"prefix"`), referenced as `#7` in PR text so `Fixes #7` closes them, and
the default branch is `7-fix-the-thing`. Mapping:

- `team` is the repository (`team:issue-herd`) and `project` is the milestone.
- `state` is `open` or `closed`. There are no workflow states, so `init` sets `onPickup.state` and
  `onDone.state` to `null`. Any other state name is **refused**, with an error naming what GitHub
  has: it will not invent a label or close your issue on a guess.
- `priority` comes from labels named `P0`–`P3` or `urgent` / `high` / `medium` / `low`
  (`priority: high` works too). The most urgent label on the issue wins. With no such label the
  priority is "none", so a `priority<=2` rule matches nothing in a repository that does not use them.
- `estimate` and `cycle` are always empty, so any rule using them matches nothing.
- `assignee` and `creator` match `@login`. An issue assigned to several people is left alone unless
  every assignee is you.
- The claim label is created if missing. Pull requests are never treated as issues.

For GitHub Enterprise, set `ISSUE_HERD_GITHUB_HOST=ghe.corp.com` in your shell. That is deliberately
a machine setting rather than a config key: `config.json` is committed, and this value decides where
your token is sent, so a repository you clone may *name* the host it expects but not introduce one.
For the same reason a repository's `.env` cannot set any `ISSUE_HERD_*` variable, and `prompt` and
`instructionsFile` must point inside `.issue-herd/`.

**Adding a tracker** is one file. Write `src/trackers/<name>.mjs` against the contract documented
at the top of [`src/tracker.mjs`](src/tracker.mjs) — a class with `me`, `openIssues`,
`issueByKey`, `comment`, `addLabel`, `removeLabel`, `assign`, `setState` and a static `login` —
returning the normalized issue shape, then add it to `src/trackers/index.mjs`.
[`github.mjs`](src/trackers/github.mjs) is the model: one read query and a few writes, no
dependencies. `test/trackers.test.mjs` checks every registered tracker against the
contract; `checkIssue()` tells a new tracker exactly which field it got wrong.

## Signing in

`issue-herd login [linear|github]` obtains a token, proves it works with a `me` call, and saves it
in `~/.config/issue-herd/credentials.json` (mode 600). Runs before `init` too, when the tracker is
named. `issue-herd logout` forgets it. At startup the banner says which account is in use and where
the token came from. Lookup order:

1. the environment: `LINEAR_API_KEY`, or `GITHUB_TOKEN` / `GH_TOKEN`, read from the process, then
   `<repo>/.env.local`, then `<repo>/.env`
2. the saved credential
3. GitHub only: `gh auth token`, so a machine with `gh` logged in needs no login at all

`login` never copies a token another tool owns: with `gh` logged in it saves nothing and re-reads
`gh auth token` on every run, so a token `gh` rotates keeps working.

How `login` gets the token, per tracker:

- **GitHub**: a device-flow browser sign-in when the tool has a GitHub OAuth app client id;
  otherwise the token `gh` is logged in with, or `gh auth login` (browser) if `gh` is present but
  logged out; otherwise it opens the new-token page (scope `repo`) and asks you to paste the token.
- **Linear**: a browser sign-in (authorization code + PKCE, loopback redirect on
  `http://localhost:8497/callback`, token refreshed automatically before it expires) when the tool
  has a Linear OAuth client id; otherwise it opens Settings → Security & access → Personal API keys
  and asks you to paste the key. `--paste` forces the paste route on either tracker.

The browser flows need an OAuth application registered with the provider, which ships as a client
id in the code (no secret: PKCE for Linear, device flow for GitHub). Maintainers: register one,
then set `LINEAR_CLIENT_ID` in `src/trackers/linear.mjs` (Linear → Settings → API → OAuth
applications, callback `http://localhost:8497/callback`, public client) and `GITHUB_CLIENT_ID` in
`src/trackers/github.mjs` (GitHub → Settings → Developer settings → OAuth Apps, enable device flow).
Until then the same flows can be tried with the `ISSUE_HERD_LINEAR_CLIENT_ID` and
`ISSUE_HERD_GITHUB_CLIENT_ID` environment variables, or per repository with a `clientId` in the
tracker object. `ISSUE_HERD_OAUTH_PORT` moves the loopback port, `ISSUE_HERD_CREDENTIALS` the
credentials file, and `ISSUE_HERD_GITHUB_HOST` names a GitHub Enterprise host. All of these are read
from your shell only, never from a repository's `.env`.

## How it avoids double work

Three independent guards, checked before every pickup:

1. **Claim label on the issue** (`claimLabel`, default `herdr`). Added the moment an issue is
   picked up, re-checked with a fresh fetch right before claiming. Survives restarts, a deleted
   `state.json`, and a second machine running issue-herd. It stays on the issue after the run as
   the record that an agent worked it; remove it to let an agent take the issue again.
2. **Pickup comment marker.** The "issue-herd picked this up" comment is also detected, so an
   issue claimed by an older version without the label is still skipped.
3. **Assigned to someone else** (`skipIfAssignedToOthers`, default true). If a human other than
   you holds the issue, it is theirs. On a tracker with several assignees per issue, one other
   person is enough: an issue shared between you and a colleague is still theirs. `onPickup.assignToMe` makes the agent's issues yours, so the
   rule of thumb is: unassigned or assigned to you means available.

Plus the local `state.json`, which is what stops the same watcher re-picking during a run, and
whatever your rule says (`not state:started` excludes anything already In Progress).

## How a run works

1. Poll the tracker for open issues; evaluate each rule; the first matching rule wins, then the
   guards above are applied. Urgent first, then oldest first.
2. `git worktree add -b <branch> .issue-herd/worktrees/<slug>` — issue-herd makes the worktree, on
   the branch the rule asked for. An existing directory for that issue is reused rather than
   duplicated, and an existing branch is attached to rather than clobbered.
3. `herdr worktree open --path <worktree>` gives it a workspace, so the sidebar shows the run's real
   branch and groups it under the repo. If you already had that checkout open, the run gets its own
   workspace and your shell is left alone.
4. `herdr agent start <key> --kind claude --pane <pane> -- --name KEY --permission-mode …` — started
   in a pane that is already in the worktree, so no `--worktree` flag and nothing to discover
   afterwards. issue-herd then asks git what branch the worktree is on and records the answer, which
   is the confirmation step rather than a correction: the brief, the pickup comment and the PR all
   quote what git reports, never a name issue-herd hoped for.
5. Render the brief template into `<working tree>/.issue-herd/state/runs/<KEY>/brief.md` with the
   issue, comments, and your `instructions.md`, then `herdr agent prompt <key> "read the brief at …
   and follow it"`. The brief and `result.json` live inside Claude's own working tree (gitignored)
   because a path in the main checkout triggers permission dialogs from a worktree; a copy is
   archived under the watcher's `.issue-herd/state/runs/<KEY>/` when the run finishes.
   If Claude comes up on a dialog of its own — the trust prompt in a directory it has not seen —
   herdr will not type into it. That is not a failed run: the prompt is kept, you get the ✋ comment
   and notification, and the supervisor sends the brief the moment you answer the dialog.
6. Comment on the issue, assign it to you, move it to In Progress.
7. A supervisor waits on `herdr agent wait`. When Claude writes `runs/<KEY>/result.json`
   (`pr_open | needs_human | nothing_to_do | failed`, PR URL, summary, testing notes) the watcher
   comments the result on the issue, moves it to In Review on `pr_open`, and sends a herdr
   notification. If Claude gets **blocked** on a permission dialog or **stops** to ask a question,
   you get one comment and one notification telling you which workspace to open.
8. Workspaces are left open so you can inspect, test, and steer.
9. On `pr_open`, the run is not over: issue-herd keeps watching the pull request (once a minute,
   whatever `pollSeconds` says). When GitHub says it is **merged**, you get a notification saying so
   and naming the workspace and worktree the run is still holding, and the run is recorded as
   `merged`. Nothing is torn down unless you asked for it in `onMerged` — see below. A PR **closed
   without merging** just stops being watched.

If you restart the watcher, it re-attaches to agents that are still alive, finalizes any run whose
result file appeared while it was down, and goes on watching the pull requests it had not seen
merged yet. A pickup for an issue whose session is still running — after `issue-herd reset <KEY>`,
or a retry of a start that failed late — reuses that session instead of building a second workspace
beside it, so nothing is left adrift and you keep the pane you have been typing into.

### When the PR is merged

By default a merge is **reported, not acted on**. The review that mattered happened before the
merge, but the agent's session is the record of how the work was done, and throwing that away is
not something to do to somebody who did not ask for it. So the watcher tells you the run is
finished and names what it is still holding; closing it is yours.

Turn on the parts you want, in `defaults` or per rule (and `config.local.json` if you want it on
one machine only):

| key | default | what it does when the PR is merged |
| --- | --- | --- |
| `exitAgent` | `false` | sends the agent `/exit` and waits up to 20s for it to go — Claude Code then writes its own history and stops its own MCP servers, rather than having its pane pulled away |
| `closeWorkspace` | `false` | `herdr workspace close` |
| `removeWorktree` | `false` | `git worktree remove` — never forced, so a worktree with uncommitted or untracked files is kept and the log says so |
| `notify` | `true` | one herdr notification: the PR merged, and which workspace and worktree the run still has |
| `comment` | `false` | the same as a comment on the issue. Off because GitHub already writes the merge into the issue's timeline; worth turning on for Linear, which does not |

`"onMerged": null` switches the whole thing off, including the watching, and a run then finishes at
`pr_open` as it did before any of this existed.

The full cleanup, for a rule whose runs you never want to look at again:

```jsonc
"onMerged": { "exitAgent": true, "closeWorkspace": true, "removeWorktree": true }
```

What that costs you is the agent's terminal scrollback. `result.json` and `brief.md` are archived
into the watcher's own `.issue-herd/state/runs/<KEY>/` before anything is removed, and the diff is
in the PR, but the transcript lives with the session: Claude Code keeps it under
`~/.claude/projects/<the worktree path>/`, so once the worktree is gone there is nowhere left to
`claude --resume` from.

The pull request is read straight from GitHub, whichever tracker the issue came from (a Linear
issue's PR is on GitHub too). It uses the GitHub tracker's token when that is your tracker, and
otherwise whatever this machine has for GitHub — `GITHUB_TOKEN`, `issue-herd login github`, or
`gh auth token`. Without one, only public repositories answer. A `prUrl` pointing anywhere but the
GitHub host this machine trusts is refused rather than fetched: `result.json` is written by an agent
that has read the issue's text, so it does not get to say where your token goes.

## Manual testing and screenshots

The agent has no in-app Browser pane here. The brief tells it to verify with unit tests and to
say when browser verification is still needed. For your own manual pass, open the PR branch or
its worktree in the Claude Code desktop app, or start the worktree's dev servers from the herdr
workspace and open the port in your browser.

## Troubleshooting

- `issue-herd: herdr server is not running` — start `herdr` once; the server stays up.
- `agent start … pane_not_ready` — the workspace shell had not reached its prompt; the watcher
  retries three times. A slow shell init (`nvm` in `.zshrc`) is the usual cause.
- Claude never goes `working` after the prompt — open the workspace; it is probably sitting on
  the trust-this-folder dialog for a new worktree. Answer it once per repo.
- A pickup that failed (`issue-herd status` shows `failed`) is retried by itself: the claim label
  is handed back, and the next time the issue changes on the tracker (an edit, a state change, a
  label) it is a candidate again. Fix what the log complained about and touch the issue.
- Re-run an issue that finished or stopped: remove the `herdr` claim label on the issue, delete the
  pickup comment if you want a clean thread, then `issue-herd reset ENG-123` (or `reset GH-7`). It
  will be picked up on the next poll if the rule still matches.
- `no Linear credentials` / `no GitHub credentials` — run `issue-herd login`, or put the token in
  `.env.local`. A `401` means the token it found (the banner says where) is dead: `login` again.
- `cannot tell which GitHub repository this is` — the `origin` remote is not on github.com; set
  `"tracker": { "type": "github", "repo": "owner/name" }`.
- `no .issue-herd/config.json` — you are not inside a repository that has been set up; `cd` into
  it (any subdirectory works, the git top level is used) or run `issue-herd init`.
- `ISSUE_HERD_DEBUG=1` logs every herdr command.
