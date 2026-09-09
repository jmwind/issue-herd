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
given. See [More than one turn](roles.md#more-than-one-turn-passes). A role can also be given a
turn by *another role*: a result that says `"nudge": { "role": "impl", "message": "…" }` hands
that role its next turn at once, through `herdr agent prompt`, without waiting for a poll or for
the issue to move — capped per issue by `maxNudges`, after which a person is asked in. See
[Working together](roles.md#working-together-nudges).


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
7. A supervisor waits on `herdr agent wait`, a minute at a time, and looks for
   `runs/<KEY>/result.json` after each wait. (herdr 0.9 ends a wait whose agent has exited, been
   released or moved pane with `agent_not_running`; the supervisor then asks herdr whether the
   agent is still there, and reads "no" as the session having ended.) When Claude writes it
   (`pr_open | needs_human | nothing_to_do | failed`, PR URL, summary, testing notes) the watcher
   comments the result on the issue, moves it to In Review on `pr_open`, and sends a herdr
   notification — whether or not the agent has stopped, so an implementer that stays up to merge
   once the reviewers agree still hands off to them the moment its result is in. If Claude gets
   **blocked** on a permission dialog or **stops** to ask a question, you get one comment and one
   notification telling you which workspace to open.
8. Workspaces are left open so you can inspect, test, and steer.
9. On `pr_open`, the run is not over: issue-herd keeps watching the pull request (once a minute,
   whatever `pollSeconds` says). Merging is yours, unless the issue said the PR may be merged once
   reviewed — then the implementer merges it itself, and only after every reviewing role has said
   OK on the issue; a repository with no reviewing role has nothing to say OK, so the PR waits for
   you ([roles](roles.md#the-briefs-that-ship)). When GitHub says it is **merged**, you get a
   notification saying so and naming the workspace and worktree the run is still holding, and the
   run is recorded as `merged`. Nothing is torn down unless you asked for it in `onMerged` — see
   below. A PR **closed without merging** just stops being watched. While it is open, the same
   once-a-minute read also notices when it has drifted into **conflicts** with its base — see
   [Keeping up with `main`](#keeping-up-with-main).

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

The third thing is the pull request itself, after it is open. Several issues being worked at once
means several PRs waiting on one person, and the ones that wait longest are the ones the others
land on top of — by the time someone reviews, GitHub says *This branch has conflicts*, and the
person least placed to resolve them is the reviewer. So the implementer's brief makes the PR **its
own to keep mergeable until it is merged or closed**, and the watcher does the half of that a
stopped session cannot: the read it already makes of every open PR once a minute also returns
GitHub's `mergeable_state`, and when that says `dirty` the implementer's session — still up in its
pane, because `onDone.closeWorkspace` is off — is typed one message saying so. The brief tells it
what to do with that: fetch, **merge** the base branch in (never a rebase, never a force-push — the
branch has been pushed and the reviewers have it), resolve, re-run the checks, push, and say on the
PR what it merged in. It is told once per conflict, not once a minute: the head the PR had when it
was told is remembered, the same conflicts on the same commits are nothing new, and a PR that reads
clean again forgets the marker so the next drift is a fresh episode. The watcher's heartbeat counts
these as `awaiting merge (1 in conflict)`.

If the session is gone — exited by hand, or by `onDone.closeWorkspace` — there is nobody to tell,
so you are told instead, once per conflict, through the same `onBlocked` comment and notification a
blocked agent gets. `"onMerged": null` switches the PR watch off altogether, and this with it.

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
| `closeWorkspace` | `false` | `herdr workspace close` — only if the workspace under the run's id is still the run's (see Mark done) |
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

Four screens, in Factorio's idiom because a factory is what this is:

- **All factories.** The page the console opens on: every factory on the machine as one plant,
  with a belt running from each down to the next. A plant shows its name, tracker and
  repository, who works there (the roles, or the rules when it has none, and the agents behind
  them), and a production table — tasks finished today, this week and this month (and how many
  merged), the agents' time working *on its own* against the time spent *waiting on you*, with
  the share it ran alone — plus its alert and assembling counts. A plant whose agent is working
  looks like it: the assembler's gears turn, its lamp and the slot lights go green and cargo rides the
  belt out of it; an idle plant stands still; one whose watcher has gone dark is dimmed with a
  red light. Tap a plant for its floor. Today, the week and the month begin at local midnight,
  Monday and the first; a run that straddles a boundary counts the part inside the window.
- **Overview.** One factory's floor. The factory picker in the title bar switches factories or
  goes back to all of them (the mark beside it opens issue-herd on GitHub in a new tab), then
  the factory itself at a glance — its tracker and
  repository, every rule with the role it plays, the agent and model behind it and the issues it
  matches, and whether the watcher is alive — with the legend for the lights under it. Then
  **Alerts** (one card per task that needs a person, with what to do about it), **Assembling**
  (one row per open issue, with the roles on it and how long it has waited on you), and **Output
  today** (one plain line per finished task; the roles are on the detail screen). Every task shows
  lines added and removed with a size grade, and the state of its issue and its pull request. The
  belt across the top carries the factory's four numbers.
- **Issue detail.** Links to the issue and the PR, a timeline bar per role (working, blocked,
  waiting on you, done) plus a "you" row, lines added and removed with a size grade and its reason,
  each role's report, a merged scrollback (the last 100 lines of every agent on the task, one
  block per role in that role's colour, read only; while an agent is working, herdr can only
  give the screen it is showing right now, so the block is shorter), and one **Mark done** button.
- **Factory picker.** In the title bar on every screen: all factories, then each one with its
  tracker, last poll, running and alert counts, and a watcher not seen for three polls marked
  stale.

**What raises an alert.** A person actually being the one waited for: a dialog, a question, a
decision, a failure, or a pull request no role is still working on. A task that has finished —
merged, or done with nothing left for anyone — gets a card too, *waiting for your sign-off*,
whatever became of its agents (exited on their own, exited by `onMerged`, or still holding a
workspace): it stays in Alerts, and out of Output, until a person marks it done or a day has
passed. While any role is still running on a task, the
implementer's open PR is *waiting for review* — a fact on its chip, not an alert, and not your
wait time — and a reviewer that has finished is done: its report is a line on the task (*found
nothing blocking*, *has findings*), never a decision of its own. The merge alert shows those
verdicts under its line, and its clock starts when the last reviewer finished.

An agent still in flight that reads as idle, blocked or missing has to stay that way for 45
seconds before it is an alert. Each of those is what a run looks like on its way somewhere else
— herdr has not registered the agent yet, Claude Code is on its startup dialog, the prompt has
not landed, one turn ended a moment before the next — and the console reads herdr every two
seconds, so without the wait a task bounced between Alerts and Assembling. Until the state has
held, the row stays green in Assembling; once it has, the card appears; leaving an alert state
shows at once. A dialog or question the watcher has already logged counts from the log's time,
so a console started next to a long-blocked agent does not wait again. Results the watcher wrote
(a decision, a failure, a stop) are its call and are never held back.

**Where it reads from.** Each watcher stamps `~/.config/issue-herd/factories.json` every poll
(name, tracker, version, last poll); the console lists those entries, plus any `<name>Watch`
workspace herdr shows, and reads each factory's `config.json`, `state.json` and log directly. Agent
state is one `herdr api snapshot` per tick (every 2s). Lines changed come from `git diff` in the
run's worktree. A run's `result.json` in its worktree is read live, so an agent that rewrote it
after the watcher recorded the first version (a plan that became a PR) is shown as it stands.
The issue's state (open, closed) and the PR's (open, closed, merged) come from the
tracker and GitHub with the credentials this machine already has (the saved login, `gh`, or the
factory's own `.env.local`); a run that never recorded a PR gets the one GitHub has for its
branch. One call per task, every 90s for tasks in flight or finished this
week and every 30 minutes for older ones; without a credential those fields are not shown.
Nothing is written except the registry.

**Mark done.** The one action on a task, and a person's to take: a finished task sits in Alerts
— even after an auto-merge — until someone has looked at it (the reports, the scrollback) and
says it is done. The button sends every agent still up on the task its own exit command
(`/exit` for Claude Code, `/quit` for codex, each shutting down the way it wants), then closes
every run's herdr workspace — the ones whose agent just left and the ones whose agent had
already exited, every role on the task — so the panes leave the herdr window instead of piling
up there as exited sessions; then it clears the task's alerts and moves it to output. That takes
a few seconds when an agent has to shut down, so from the click until the task lands in output
the button turns a gear and says what it is doing ("Closing 2 agents and 3 workspaces…", "Moving
to output…") and the card runs a progress strip; a refusal puts the button back with the reason
in a toast. The decision is recorded in `~/.config/issue-herd/console.json` (the console's own
file, never the watcher's state); a newer run on the task brings it back, and so does Undo on the
detail screen (without restarting the agents or reopening the workspaces). An agent that does not
exit (herdr could not prompt it, or it did not go within the timeout) keeps the task in Alerts and
nothing is recorded — its workspace is left alone, too, rather than pulled out from under it — and
a workspace herdr would not close does the same: a task with an agent or a workspace still on it
is not done, whatever was clicked, and the toast says which. A workspace is only ever closed if it
is still the run's: herdr numbers workspaces per server session, so after a restart (an upgrade,
say) the id a run recorded can belong to a workspace made later for somebody else — the console
checks the label the run gave it, the worktree it was opened on, or that the run's agent is standing
in it, and a stranger's workspace under the run's old id is reported ("was reused by herdr for …")
and left alone, without keeping the task in Alerts. While herdr is not answering at all
the button is refused outright, for the same reason: with nothing visible, nothing can be closed,
and a sign-off that closed nothing would be the pile again. Worktrees stay, and so do the run's
archived `brief.md` and `result.json`: the pane was never the long-term record. `onMerged` is
still where automatic clean-up is configured; Mark done is a person's sign-off, which is why it
closes what `onMerged` by default keeps.

**Tidy.** Tasks marked done before Mark done closed workspaces left a pile. When any task marked
done still has a workspace open for an agent that has exited, the Output section's header shows
*Tidy N workspaces*: one click, one confirm, and those workspaces are closed (for the factory on
screen, or all of them from the overview). Agents still up are never touched by it, and neither is
a workspace that herdr has since given the run's old id to (it is not counted in the N).

**The gate.** With no passcode the console binds to loopback only and asks nothing. With one
(`set-passcode`, at least four digits because the phone's keypad has no letters; stored as a
salted scrypt hash in `credentials.json`, never in a repository) it
also binds to this machine's Tailscale address, never `0.0.0.0`, and nothing about any factory is
served before the passcode: a correct entry sets an `HttpOnly`, `SameSite=Strict` cookie for a day;
five wrong entries from one address lock the gate for five minutes and are logged; actions are
POSTs checked for a same-origin `Origin`. Tailscale encrypts the wire, so the console speaks plain
HTTP. `--port N` or `ISSUE_HERD_CONSOLE_PORT` changes the port; `console clear-passcode` goes
back to loopback only. No tailnet? `--host 192.168.1.20` binds one named address as well (your
Wi-Fi one, for a phone on the same network), gated the same way; it is refused without a passcode,
and `0.0.0.0` is refused always.

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
