# linear-herd

Watches Linear and, when an issue matches one of your rules, opens a **herdr workspace**, starts
**Claude Code** in it (worktree mode), hands it a written brief, and reports back to the Linear
issue: picked up → waiting for you → PR open. Runs on your own machine, inside herdr, with no
public URL and no third-party orchestrator. Zero dependencies beyond Node 22 and the `herdr` CLI.

```
repo (this)                          config home: ~/.linear-herd  (or $LINEAR_HERD_HOME)
├── bin/linear-herd.mjs   the CLI    ├── config.json         rules, defaults
├── src/expr.mjs          rule lang  ├── .env                LINEAR_API_KEY (never commit)
├── src/linear.mjs        GraphQL    ├── prompts/default.md  your copy of the brief template (optional)
├── src/herdr.mjs         herdr CLI  ├── runs/<KEY>/         per-issue: issue.json, brief.md, result.json
├── prompts/default.md    template   ├── state.json          what has been picked up
├── config.example.json              └── logs/linear-herd.log
└── test/
```

## Install

```bash
git clone <this repo> ~/Code/linear-herd
cd ~/Code/linear-herd && npm link        # puts `linear-herd` on your PATH
linear-herd init                         # writes ~/.linear-herd/{config.json,.env,prompts/default.md}
```

Requires Node 22+, the `herdr` CLI with its server running, `claude` on PATH and logged in, and
`gh` logged in for PRs. No npm dependencies.

## Setup (once)

1. Linear → Settings → Security & access → **Personal API keys** → New key. Paste it into
   `~/.linear-herd/.env` as `LINEAR_API_KEY=lin_api_...`.
2. In Linear, create the labels your rules use: the trigger label (e.g. `ai`) and the claim label
   (`herdr` by default).
3. Edit `~/.linear-herd/config.json`: one rule per repo.
4. Unit tests: `npm test`.
5. Smoke-test the herdr plumbing without touching Linear (opens a workspace, starts Claude, has it
   write the result file, finalizes): `linear-herd smoke ~/Code/your-repo`. Close the workspace it
   leaves open when you have looked at it.
6. Check a rule against live issues, no side effects: `linear-herd match "label:ai and team:DEV"`,
   then `linear-herd dry-run`.

## Run it in herdr

```bash
herdr tab create --label linear-herd --no-focus
# read .result.root_pane.pane_id from the JSON, then
herdr pane run <pane-id> "linear-herd"
```

Leave that pane alone; the herdr server keeps it alive when you detach. Every issue it picks up
becomes its own workspace in the sidebar, labelled with the issue key, with Claude's status
(working / blocked / done) shown by herdr. Step into any of them and talk to the agent.

## The rule language

```
label:ai and team:DEV and not state:started
(label:ai or label:agent) project:GustKit priority<=2
assignee:me state:todo updated<1d
```

| field | matches | examples |
|---|---|---|
| `label` | any label on the issue | `label:ai` `label:"needs review"` `label!=blocked` |
| `project` | project name | `project:GustKit` `project:"Alpha *"` |
| `team` | team key or name | `team:DEV` `team:Development` |
| `assignee` | `me`, `none`, name, display name, email | `assignee:none` `assignee:me` |
| `creator` | same as assignee | `creator:me` |
| `state` / `status` | workflow state name **or type** (`triage backlog unstarted started completed canceled`) | `state:Todo` `not state:started` |
| `priority` | `none urgent high medium low` or 0–4; `<` `<=` `>` `>=` treat "none" as lowest | `priority:urgent` `priority<=2` |
| `estimate` | points | `estimate<=3` |
| `title` | substring, or glob with `*` | `title:crash` `title:*zoom*` |
| `key` / `id` | identifier | `key:DEV-123` `key:DEV-*` |
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
    "prompt": "prompts/default.md",   // brief template; {{placeholders}} listed in the file
    "claimLabel": "herdr",            // label added on pickup and checked before pickup; null disables
    "skipIfAssignedToOthers": true,   // leave issues held by other people alone
    "onPickup": { "comment": true, "state": "In Progress", "assignToMe": true },
    "onDone":   { "comment": true, "state": "In Review", "notify": true, "closeWorkspace": false },
    "onBlocked": { "comment": true, "notify": true },   // agent hit a permission/question dialog
    "onIdle":    { "comment": true, "notify": true }    // agent stopped without writing result.json
  },
  "rules": [
    { "name": "gustkit", "match": "label:ai and team:DEV and not state:started",
      "repo": "~/Code/gustkit", "instructions": "repo-specific guidance appended to the brief",
      "enabled": true }
  ]
}
```

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
3. Render `prompts/default.md` into `runs/<KEY>/brief.md` with the issue, comments, and your
   rule's `instructions`.
4. `herdr agent start <key> --kind claude --pane <pane> -- --name KEY --worktree <slug> --permission-mode …`
   then `herdr agent prompt <key> "read the brief at … and follow it"`.
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
  a clean thread, then `linear-herd reset DEV-123`. It will be picked up on the next poll if the
  rule still matches.
- `LINEAR_HERD_DEBUG=1` logs every herdr command.
