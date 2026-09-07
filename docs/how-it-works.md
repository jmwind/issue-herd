# How it works

[← back to the README](../README.md)

## Running the watcher

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


## What the watcher pane shows

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


## How it avoids double work

Three independent guards, checked before every pickup:

1. **Claim label on the issue** (`claimLabel`, default `herdr`). Added the moment an issue is
   picked up, re-checked with a fresh fetch right before claiming. Survives restarts, a deleted
   `state.json`, and a second machine running issue-herd. It stays on the issue after the run as
   the record that an agent worked it; remove it to let an agent take the issue again. With a
   `role` on the rule the label is `herdr:review`, and only that role's claim is checked.
2. **Pickup comment marker.** The "issue-herd picked this up" comment is also detected, so an
   issue claimed by an older version without the label is still skipped. A role's comment says
   `picked this up as \`review\``, and a role only looks for its own.
3. **Assigned to someone else** (`skipIfAssignedToOthers`, default true). If a human other than
   you holds the issue, it is theirs. On a tracker with several assignees per issue, one other
   person is enough: an issue shared between you and a colleague is still theirs. `onPickup.assignToMe` makes the agent's issues yours, so the
   rule of thumb is: unassigned or assigned to you means available.

Plus the local `state.json`, which is what stops the same watcher re-picking during a run, and
whatever your rule says (`not state:started` excludes anything already In Progress).

A rule with `"passes"` above 1 is the one deliberate exception: it may take an issue again, but
only after the issue has moved on since it last finished, and only up to the number of turns it was
given. See [More than one turn](roles.md#more-than-one-turn-passes).


## How a run works

1. Poll the tracker for open issues; evaluate each rule; the first matching rule wins — once per
   role, so an issue can start a run per role — then the guards above are applied. Urgent first,
   then oldest first.
2. `git worktree add -b <branch> .issue-herd/worktrees/<slug> <tip of the base branch>` — issue-herd
   makes the worktree, on the branch the rule asked for and cut from the tip of what it is based on
   (see [Keeping up with `main`](#keeping-up-with-main)). An existing directory for that issue is
   reused rather than duplicated, and an existing branch is attached to rather than clobbered.
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

## Keeping up with `main`

Merges happen on the remote. Nothing in a git repository pulls itself, so the checkout you started
the watcher in hears about them only when something fetches — and `git worktree add` with no start
point cuts the new branch from *that* checkout's HEAD. Left alone, the first merge puts every run
after it on old code, and their pull requests come back full of conflicts nobody wrote.

So two things happen, at every pickup and again whenever the watcher sees one of its pull requests
merged:

- **A run's branch is cut from the tip of its base**, not from wherever the checkout is standing:
  `git fetch origin <base>`, then start from whichever of `<base>` and `origin/<base>` contains the
  other. The base is the default branch — `baseBranch`, or what `origin/HEAD` says — or another
  role's branch where the rule says [`basedOn`](roles.md#reviewing-the-actual-code-basedon); a later
  turn on a worktree that already exists is fast-forwarded the same way. The branch is cut from a
  commit rather than from a name, so nothing ends up quietly tracking `main`.
- **The checkout itself is fast-forwarded** onto that branch, because `"worktree": "none"` runs work
  in it, `"herdr"` worktrees are cut from its HEAD, and the config the watcher reloads before every
  poll is read out of it. This one can be refused, and refusing is the point: a dirty tree, a branch
  of your own, commits that were never pushed, or a `"none"` run whose agent is working in the
  directory right now are each left exactly as they are, and said so in the log. It is only ever a
  fast-forward — never a merge, never a rebase, never a reset. `"pullBase": false` turns it off
  entirely.

Neither needs a remote or a network: a fetch that fails is not an error, and the local branch is
then the best answer there is.

## When the PR is merged

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

## The console: `issue-herd console`

The watcher pane tells one factory's story in text. The console shows every factory on the machine
in a browser, phone first, and is built from one question: *what changes what you do next?*

```bash
issue-herd console                 # http://127.0.0.1:8498/
issue-herd console set-passcode    # gate it, and serve it on this machine's Tailscale address too
```

Three screens, in Factorio's idiom because a factory is what this is:

- **Overview.** A factory picker in the title bar (one machine runs several), then **Alerts** — one
  card per thing only a person can clear: an agent blocked on a dialog (with "read scrollback"),
  an agent that stopped to ask, a run that ended `needs_human`, a pull request waiting for your
  merge, a finished run still holding its workspace — then **Assembling**, one row per open issue
  with a status light, a module slot per role, a short state phrase and the time on task, then
  **Output today**. The belt under the title bar carries the factory's real output (commits, PRs,
  merges, lines changed). The footer sums how long you were waited on.
- **Issue detail.** Links to the issue and the PR, a timeline bar per role (working, blocked,
  asking, done) plus a "you" row, lines added and removed with a size grade and its reason,
  each role's report, and the exit button.
- **Factory picker.** Every factory with its tracker, last poll, running and alert counts, a
  watcher not seen for three polls marked stale, and the chosen factory's rules in three lines.

**Where it reads from.** Each watcher stamps `~/.config/issue-herd/factories.json` every poll
(name, tracker, version, last poll); the console lists those entries, plus any `<name>Watch`
workspace herdr shows, and reads each factory's `config.json`, `state.json` and log directly. Agent
state is one `herdr api snapshot` per tick (every 2s). Lines changed come from `git diff` in the
run's worktree. Nothing is written except the registry, and no tracker is called.

**Exit.** The button sends the agent its own exit command (`/exit` for Claude Code, `/quit` for
codex) and lets it shut down the way it wants. The workspace and the worktree stay; `onMerged`
is still where clean-up is configured.

**The gate.** With no passcode the console binds to loopback only and asks nothing. With one
(`set-passcode`; stored as a salted scrypt hash in `credentials.json`, never in a repository) it
also binds to this machine's Tailscale address, never `0.0.0.0`, and nothing about any factory is
served before the passcode: a correct entry sets an `HttpOnly`, `SameSite=Strict` cookie for a day;
five wrong entries from one address lock the gate for five minutes and are logged; actions are
POSTs checked for a same-origin `Origin`. Tailscale encrypts the wire, so the console speaks plain
HTTP. `--port N` or `ISSUE_HERD_CONSOLE_PORT` changes the port; `console clear-passcode` goes
back to loopback only.

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
- Re-run an issue that finished or stopped: remove the `herdr` claim label on the issue (with roles,
  the one for the role you want back — `herdr:review`), delete the pickup comment if you want a
  clean thread, then `issue-herd reset ENG-123` (or `reset GH-7`, which forgets every role's run on
  the issue; `reset GH-7@review` forgets one). It will be picked up on the next poll if the rule
  still matches.
- `no Linear credentials` / `no GitHub credentials` — run `issue-herd login`, or put the token in
  `.env.local`. A `401` means the token it found (the banner says where) is dead: `login` again.
- `cannot tell which GitHub repository this is` — the `origin` remote is not on github.com; set
  `"tracker": { "type": "github", "repo": "owner/name" }`.
- `no .issue-herd/config.json` — you are not inside a repository that has been set up; `cd` into
  it (any subdirectory works, the git top level is used) or run `issue-herd init`.
- `ISSUE_HERD_DEBUG=1` logs every herdr command.

## Updating

```bash
issue-herd update
```

Same as rerunning the install; it prints the old and new version. (`npm update -g` does not
reliably refresh packages installed from a git URL, so use this.)

You will not have to remember: the watching commands (`issue-herd`, `once`, `dry-run`, `match`,
`status`, `reset`) check GitHub for a newer version and print one reminder line if there is one,
and the running watcher re-checks once a day and also sends a herdr notification. The check is a 4-second fetch of `package.json` on `main`, silent when offline. Set
`ISSUE_HERD_NO_UPDATE_CHECK=1` to turn it off.
