# linear-herd

Watches Linear and, when an issue matches one of your rules, opens a **herdr workspace**, starts
**Claude Code** in it (worktree mode), hands it a written brief, and reports back to the Linear
issue: picked up → waiting for you → PR open. Runs on your own machine, inside herdr, with no
public URL and no third-party orchestrator. Zero dependencies beyond Node 22 and the `herdr` CLI.

**It is project-local.** You run `linear-herd` from inside the repository it should work on. The
rules, the repo-specific instructions for the agent, and the API key all live in that repository,
so they are reviewed and versioned with the code:

```
your-repo/
├── .linear-herd/
│   ├── config.json          rules and defaults                      (committed)
│   ├── instructions.md      how to work in this repo, appended to every brief (committed)
│   ├── prompts/default.md   optional override of the built-in brief template
│   └── state/               state.json, runs/<KEY>/, logs/          (gitignored)
├── .env.local               LINEAR_API_KEY=…                        (gitignored)
└── .env.example             documents LINEAR_API_KEY                (committed)
```

## Install

```bash
npm install -g github:jmwind/linear-herd
```

That puts `linear-herd` on your PATH. `linear-herd --version` shows what you have.

## Update

```bash
linear-herd update
```

Same as rerunning the install; it prints the old and new version. (`npm update -g` does not
reliably refresh packages installed from a git URL, so use this.)

You will not have to remember: every command checks GitHub for a newer version and prints one
reminder line if there is one, and the running watcher re-checks once a day and also sends a herdr
notification. The check is a 4-second fetch of `package.json` on `main`, silent when offline. Set
`LINEAR_HERD_NO_UPDATE_CHECK=1` to turn it off.

## Release a change (maintainers)

Edit, commit as usual, then:

```bash
npm run release
```

That runs the tests, bumps the patch version in `package.json`, commits it, tags `vX.Y.Z`, and
pushes commits and tags. Everyone picks it up with `linear-herd update`. Use
`npm run release:minor` for a feature. To hack on the tool without installing:

```bash
git clone git@github.com:jmwind/linear-herd.git && cd linear-herd && npm link
```

Requires Node 22+, the `herdr` CLI with its server running, `claude` on PATH and logged in, and
`gh` logged in for PRs. No npm dependencies.

## Set up a repository

```bash
cd ~/Code/your-repo
linear-herd init
```

`init` writes `.linear-herd/config.json` and `.linear-herd/instructions.md` from the examples,
adds `.linear-herd/state/` to `.gitignore`, and documents `LINEAR_API_KEY` in `.env.example`. It
never overwrites a file that exists. Then:

1. Linear → Settings → Security & access → **Personal API keys** → New key. Put it in the repo's
   `.env.local` (or `.env`) as `LINEAR_API_KEY=lin_api_...`. The process environment wins over both.
2. In Linear, create the labels your rules use: the trigger label (e.g. `ai`) and the claim label
   (`herdr` by default).
3. Edit `.linear-herd/config.json` (the rules) and `.linear-herd/instructions.md` (what the agent
   must know about this repo: checks to run, things never to run, branch and PR conventions, when
   to stop and ask). Commit both.
4. Smoke-test the herdr plumbing without touching Linear (opens a workspace, starts Claude, has it
   write the result file, finalizes): `linear-herd smoke`. Close the workspace it leaves open when
   you have looked at it.
5. Optional: preview what the config's rules would pick up, with no side effects: `linear-herd dry-run`.
   To try an expression before putting it in the config: `linear-herd match "label:ai and team:ENG"`.

Unit tests for the tool itself: `npm test` in this repo.

## Commands

| command | what it does |
|---|---|
| `linear-herd` | **the watcher.** Reads `.linear-herd/config.json`, evaluates its rules against Linear every `pollSeconds`, picks up matches, supervises them. Run this one in herdr. |
| `linear-herd once` | one poll with the config's rules, then exit (stays up while it supervises anything it picked up) |
| `linear-herd dry-run` | the config's rules, print what would be picked up, change nothing |
| `linear-herd match "<expr>"` | evaluate an ad hoc expression against open issues, change nothing; for testing a rule before adding it |
| `linear-herd status` | tracked runs and their outcome |
| `linear-herd reset <KEY>` | forget a run so the issue can be picked up again |
| `linear-herd smoke` | end-to-end herdr test with a fake issue, no Linear calls |
| `linear-herd init` | scaffold `.linear-herd/` in the current repo |

## Run it in herdr

From the repo directory:

```bash
herdr tab create --label linear-herd --cwd "$PWD" --no-focus
# read .result.root_pane.pane_id from the JSON, then
herdr pane run <pane-id> "linear-herd"
```

One watcher per repository. Run several in separate panes if you have several repos.

Leave that pane alone; the herdr server keeps it alive when you detach. Every issue it picks up
becomes its own workspace in the sidebar, labelled with the issue key, with Claude's status
(working / blocked / done) shown by herdr. Step into any of them and talk to the agent.

### What the pane shows

A startup banner (version, repo, rules, guards, Linear user, herdr connection), then one **live
line** that is rewritten after every poll:

```
14:32:10 poll #48 · 47 open · 1 matched · 0 picked · running 2: DEV-12 w3 working · DEV-15 w4 blocked · next in 30s
```

Anything that *happens* gets its own timestamped line above it and goes to
`.linear-herd/state/logs/linear-herd.log`: an issue picked up (with workspace and working tree), an
issue that matched but was skipped and why (once per issue), an agent blocking on a dialog or
going idle without a result, unblocking, finishing with its status and PR, a failed poll. When
stdout is not a terminal (pm2, a log file) the live line is printed every tenth poll instead.

`linear-herd status` from another pane prints the same picture as a table, with each running
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
| `assignee` | `me`, `none`, name, display name, email | `assignee:none` `assignee:me` |
| `creator` | same as assignee | `creator:me` |
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

## Config reference

```jsonc
{
  "pollSeconds": 30,          // Linear poll interval
  "lookbackDays": 30,         // only consider issues updated in this window
  "maxConcurrent": 3,         // global cap on running agents
  "defaults": {               // every rule inherits these
    "worktree": "claude",     // "claude": claude --worktree <slug> (branch claude/<slug>)
                              // "herdr":  herdr worktree create (branch linear/<slug>, herdr shows it as a worktree)
                              // "none":   pass no worktree flag. If your Claude Code settings default to
                              //           worktree mode, Claude still creates one with a random name.
    "permissionMode": "acceptEdits",  // claude --permission-mode; see `claude --help` for choices
    "claudeArgs": [],         // extra flags for claude, e.g. ["--model", "opus"]
    "maxConcurrent": 2,       // per-rule cap
    "prompt": "prompts/default.md",   // brief template: .linear-herd/prompts/default.md if present, else the built-in
    "instructionsFile": "instructions.md",  // repo brief appended to the prompt; "instructions" (inline string) also works
    "claimLabel": "herdr",            // label added on pickup and checked before pickup; null disables
    "skipIfAssignedToOthers": true,   // leave issues held by other people alone
    "onPickup": { "comment": true, "state": "In Progress", "assignToMe": true },
    "onDone":   { "comment": true, "state": "In Review", "notify": true, "closeWorkspace": false },
    "onBlocked": { "comment": true, "notify": true },   // agent hit a permission/question dialog
    "onIdle":    { "comment": true, "notify": true }    // agent stopped without writing result.json
  },
  "rules": [                  // evaluated in order; first match wins; every rule inherits defaults
    { "name": "ai", "match": "label:ai and team:ENG and not state:started", "enabled": true },
    { "name": "docs", "match": "label:ai and label:docs", "instructionsFile": "instructions-docs.md" }
  ]
}
```

The repository is always the one you run `linear-herd` in (its git top level); rules do not name
a repo.

`state` values in `onPickup`/`onDone` are matched against the team's workflow by name, then by
type, so `"started"` works for any team. Set a key to `null`/`false` to skip that step.

## How it avoids double work

Three independent guards, checked before every pickup:

1. **Claim label on the issue** (`claimLabel`, default `herdr`). Added the moment an issue is
   picked up, re-checked with a fresh fetch right before claiming. Survives restarts, a deleted
   `state.json`, and a second machine running linear-herd. It stays on the issue after the run as
   the record that an agent worked it; remove it to let an agent take the issue again.
2. **Pickup comment marker.** The "linear-herd picked this up" comment is also detected, so an
   issue claimed by an older version without the label is still skipped.
3. **Assigned to someone else** (`skipIfAssignedToOthers`, default true). If a human other than
   you holds the issue, it is theirs. `onPickup.assignToMe` makes the agent's issues yours, so the
   rule of thumb is: unassigned or assigned to you means available.

Plus the local `state.json`, which is what stops the same watcher re-picking during a run, and
whatever your rule says (`not state:started` excludes anything already In Progress).

## How a run works

1. Poll Linear for open issues; evaluate each rule; the first matching rule wins, then the guards
   above are applied. Urgent first, then oldest first.
2. `herdr workspace create --cwd <repo> --label "<KEY> <title>" --no-focus` (or `herdr worktree
   create` in herdr worktree mode).
3. `herdr agent start <key> --kind claude --pane <pane> -- --name KEY --worktree <slug> --permission-mode …`,
   then ask herdr which directory Claude is now working in (the worktree it created).
4. Render the brief template into `<working tree>/.linear-herd/state/runs/<KEY>/brief.md` with the
   issue, comments, and your `instructions.md`, then `herdr agent prompt <key> "read the brief at …
   and follow it"`. The brief and `result.json` live inside Claude's own working tree (gitignored)
   because a path in the main checkout triggers permission dialogs from a worktree; a copy is
   archived under the watcher's `.linear-herd/state/runs/<KEY>/` when the run finishes.
5. Comment on the issue, assign it to you, move it to In Progress.
6. A supervisor waits on `herdr agent wait`. When Claude writes `runs/<KEY>/result.json`
   (`pr_open | needs_human | nothing_to_do | failed`, PR URL, summary, testing notes) the watcher
   comments the result on the issue, moves it to In Review on `pr_open`, and sends a herdr
   notification. If Claude gets **blocked** on a permission dialog or **stops** to ask a question,
   you get one comment and one notification telling you which workspace to open.
7. Workspaces are left open so you can inspect, test, and steer. Close them yourself.

If you restart the watcher, it re-attaches to agents that are still alive and finalizes any run
whose result file appeared while it was down.

## Manual testing and screenshots

The agent has no in-app Browser pane here. The brief tells it to verify with unit tests and to
say when browser verification is still needed. For your own manual pass, open the PR branch or
its worktree in the Claude Code desktop app, or start the worktree's dev servers from the herdr
workspace and open the port in your browser.

## Troubleshooting

- `linear-herd: herdr server is not running` — start `herdr` once; the server stays up.
- `agent start … pane_not_ready` — the workspace shell had not reached its prompt; the watcher
  retries three times. A slow shell init (`nvm` in `.zshrc`) is the usual cause.
- Claude never goes `working` after the prompt — open the workspace; it is probably sitting on
  the trust-this-folder dialog for a new worktree. Answer it once per repo.
- Re-run an issue: remove the `herdr` claim label in Linear, delete the pickup comment if you want
  a clean thread, then `linear-herd reset ENG-123`. It will be picked up on the next poll if the
  rule still matches.
- `no .linear-herd/config.json` — you are not inside a repository that has been set up; `cd` into
  it (any subdirectory works, the git top level is used) or run `linear-herd init`.
- `LINEAR_HERD_DEBUG=1` logs every herdr command.
