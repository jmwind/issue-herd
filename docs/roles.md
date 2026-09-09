# Roles: several agents on one issue

[← back to the README](../README.md)


The claim is a real distributed lock, but on its own it is binary: an issue is taken or it is not.
A **role** splits it into independent locks so an implementer, a reviewer and a splitter can hold
the same issue at the same time without fighting over one label.

Give a rule a `role` and everything the run is keyed by follows it:

| | no role (the default) | `"role": "review"` |
|---|---|---|
| claim label | `herdr` | `herdr:review` |
| pickup comment | `🐑 **issue-herd** picked this up on …` | `🐑 **issue-herd** picked this up as \`review\` on …` |
| run key (`status`, `reset`, `runs/<KEY>/`) | `GH-7` | `GH-7@review` |
| herdr sidebar | `GH-7 Fix the thing` | `GH-7 review Fix the thing` |
| herdr agent | `gh-7` | `gh-7-review` |
| worktree directory | `gh-7-fix-the-thing` | `gh-7-review-fix-the-thing` |
| branch (default template) | `7-fix-the-thing` | `7-fix-the-thing-review` |

```jsonc
{
  "roles": ["impl", "review"],   // which roles this project runs at all
  "rules": [
    { "name": "build",  "role": "impl",   "match": "label:ai and not state:started" },
    { "name": "review", "role": "review", "match": "label:ai and state:started",
      "prompt": "prompts/review-lead.md" }     // a reviewer needs its own brief, not the default one
  ]
}
```

- **Rules only see their own role.** A `review` rule checks `herdr:review` and the `review` pickup
  comment, never `herdr:impl`, so an issue being implemented is still available for review. Within
  one role the first matching rule still wins, exactly as before; across roles, one poll can start
  one run per role.
- **A rule with no role claims the whole issue.** That is the old behaviour, unchanged: its label
  is `herdr`, and *any* pickup comment blocks it. Leave `role` out and nothing about issue-herd
  changes.
- **`"roles"` is the project's switch.** A list disables the rules whose role is not in it, so
  turning reviewer agents off is one line rather than deleting the rules. Omit it and every rule's
  role is active. A rule with no role is never filtered by it.
- **Every role needs its own branch**, because git cannot check one branch out into two worktrees.
  The default template `{{issueBranchName}}{{roleSuffix}}` handles it (`{{roleSuffix}}` is empty
  with no role, so nothing changes for existing configs), and so does anything built from
  `{{slug}}`, which is derived from the run key. Two roles pointed at a branch template that names
  neither is refused at config load, with the fix in the message.
- **The role reaches the agent.** The brief says which claim the run holds and that other agents
  may hold others on the same issue. Point each role at its own `prompt` — the built-in one tells
  the agent to implement the issue and open a PR, which is not what a reviewer should do.
- **Each role picks its own agent.** `agentKind`, `model` and `effort` are per rule — see
  [A second opinion](#a-second-opinion-a-reviewer-on-another-provider).
- **A reviewer can hold the code it reviews.** `"basedOn": "impl"` starts this role's worktree from
  that role's branch — see [Reviewing the actual code](#reviewing-the-actual-code-basedon).
- `issue-herd reset GH-7` forgets every role's run on the issue; `issue-herd reset GH-7@review`
  forgets just that one.

## The briefs that ship

`prompt` is resolved in `<repo>/.issue-herd/` first and then in issue-herd's own `prompts/`, so a
rule can name one of these without copying it, and a project overrides one by putting a file of the
same name in `.issue-herd/prompts/`:

| `prompt` | for | says |
|---|---|---|
| `prompts/default.md` | the implementer (the default) | work the issue end to end, open a PR, write `result.json` |
| `prompts/review-lead.md` | a tech-lead review | accuracy, structure, maintainability, performance; ends in `OK TO MERGE TO MAIN` or not |
| `prompts/review-usability.md` | a usability and docs review | walk the getting-started path a newcomer walks; ends in `USABILITY: OK` or the findings |
| `prompts/review-security.md` | a security assessment | attacker-controlled input → effect, one pass, one verdict |
| `prompts/smoke.md` | `issue-herd smoke` | prove the pipeline works, change nothing |

Every one of them is a plain markdown file with `{{placeholders}}`, and the reviewing three all end
with "do not push, do not merge" — the verdict is a comment on the issue, and merging is never a
reviewer's. It is a person's job too, with one exception the implementer's brief spells out: when
the issue itself says the PR may be merged once reviewed, the implementer merges it, and only after
every reviewing role the repository runs has said OK on the issue. One missing or negative verdict
and the PR stays open, and so does a repository with no reviewing role at all — "once reviewed"
with nobody to review it is not a grant. A repository's own instructions can forbid merging
outright.

## A second opinion: a reviewer on another provider

A reviewer is only a second set of eyes if it is not the same eyes. `agentKind`, `model` and
`effort` are per rule, so the implementer and the reviewer can be different agents entirely:

```jsonc
{
  "roles": ["impl", "review"],
  "rules": [
    { "name": "build",  "role": "impl",   "match": "label:ai and not state:started",
      "model": "opus" },
    { "name": "review", "role": "review", "match": "label:ai and state:\"In Review\"",
      "agentKind": "codex", "model": "gpt-5-codex", "effort": "high",
      "passes": 3, "prompt": "prompts/review-lead.md" }
  ]
}
```

`agentKind` goes straight to `herdr agent start --kind`, and herdr is the authority on which
agents it can start — `herdr agent start --help` lists them (claude, codex, gemini, cursor, grok,
copilot, and others). What issue-herd adds is the translation, because everything after `--` is
the agent's *own* command line and the four things a rule asks for are spelled differently by each:

| | Claude Code | codex |
|---|---|---|
| model | `--model opus` | `--model gpt-5-codex` |
| effort | `--effort high` | `-c model_reasoning_effort="high"` |
| unattended | `--permission-mode auto` | `--approve-for-me` (which *is* the workspace-write sandbox) |
| session name | `--name GH-7@review` | (none — herdr's agent name is the name) |
| leaves with | `/exit` | `/quit` |

An agent with no translation still runs: it gets `--model` and whatever the rule puts in
`agentArgs`, which is enough for most of them and means issue-herd does not have to know every
agent's flags before you can use one.

Two things worth knowing:

- **Sign in to each provider yourself**, once per machine (`claude`, `codex login`, …).
  `issue-herd login` is for the *tracker*; it never touches an agent's credentials.
- **Answer each agent's first-run dialogs yourself, once per repository.** codex asks whether it
  trusts a directory the first time it opens one (and about hooks, if you have any). A run that
  starts on that dialog is reported as blocked and waits — nothing is lost — but the cure is to run
  the agent in the repository once by hand, the same way you sign in.
- **`permissionMode` never turns a sandbox off.** It is Claude Code's word, and each agent decides
  what "unattended" means for itself — but none of them may decide it means "no boundary at all".
  codex's `auto` is the widest *sandboxed* setting, not
  `--dangerously-bypass-approvals-and-sandbox`. If you want that, type it into `agentArgs`, which
  is appended last and overrides everything above it.

## Reviewing the actual code: `basedOn`

A worktree is cut from the default branch, which is fine for the rule that is about to write the
change and useless for a rule that is about to read it: the reviewer would hold `main`, and
"run the tests the implementer said passed" is not something it could do.

```jsonc
{ "name": "review", "role": "review", "basedOn": "impl", "match": "…" }
```

`basedOn` names another **role**, and the branch is read from that role's run on the same issue —
what git reported after that worktree was made, never what a template asked for. The reviewer gets
its own branch (`7-fix-the-thing-review`) starting at the implementer's commits, so the change is
checked out, the tests are runnable, and `git diff main...HEAD` is the diff under review. Two
worktrees, two branches, no fighting over a checkout.

On a **later turn** the worktree already exists — and the reason there is a later turn is that the
implementer pushed something. So it is fast-forwarded to whatever that branch is now (`git fetch`,
then `reset --hard`), or the second review would read the first turn's code and conclude its own
findings had been ignored. That reset only ever runs in a worktree issue-herd made for this role,
and only ever moves it onto a *different* branch, so what it discards is a reviewer's scratch
files, never anyone's commits.

`basedOn` needs `"worktree": "self"` — only the mode where issue-herd creates the worktree can
decide where it starts, so the other modes refuse it at config load rather than quietly ignoring it.
A `basedOn` naming a role no rule runs is refused there too: silently, it would be a reviewer on
the default branch and a config that says otherwise.

If the other role has no run on this issue yet, or never settled a branch, you get a log line and
an ordinary worktree. A reviewer on the default branch is a poor review; a failed run is no review
at all. The brief says which it got.

## More than one turn: `passes`

By default a role takes an issue once and is finished with it. `"passes": 3` gives it up to three
turns — review the work, confirm the fix, then give the thumbs up:

```jsonc
{ "name": "review", "role": "review", "passes": 3, "match": "label:ai", "prompt": "prompts/review-lead.md" }
```

A later turn is granted on exactly one condition: **the issue moved on after the last turn
finished.** Someone pushed a fix, a person replied, the state changed. Nothing happening means no
turn, so a reviewer with turns left costs nothing while it waits.

The obvious way for that to become a loop is for the role to answer itself — its own closing
comment bumps the issue, which looks like the issue moving on. So when a rule has turns left,
issue-herd re-reads the issue's own clock *after* it has finished commenting and measures the next
turn against that. A role can never be woken by its own report.

The rest of a later turn is deliberately the same run, not a new one: same run key, same claim
label (it never came off, so the guards are not re-read — you cannot lose a lock you hold), same
worktree, same branch, and the same herdr session if it is still up. What changes is the brief,
which names the turn, points at what the previous turn wrote, and says that answering the change
is the job rather than starting over. The previous `result.json` is moved to `result.pass1.json`
before the new turn starts, so the supervisor cannot mistake the old answer for the new one, and
each turn is archived under its own name in `runs/<KEY>/`.

Two limits worth knowing. Turns are counted in `state.json`, so a watcher that loses its state
treats the role as finished — it fails closed, and `issue-herd reset` is how you hand a turn back
by hand. And a run still waiting for its PR to merge (`awaiting_merge`) is not eligible for another
turn, because that watch would be lost.

## Working together: nudges

`passes` lets a role come back when the issue moves on, but it says nothing about *who* should
move it. A reviewer that finds something wrong writes its verdict on the issue, and the
implementer's agent sits idle in the next pane until a person reads the comment and types "the
reviewer wants X" into it — then does the same in the other direction when the fix is pushed.
That is the loop the roles were meant to run on their own.

So a finishing agent may name the role it needs next, in its result:

```json
{
  "status": "nothing_to_do",
  "summary": "NOT OK TO MERGE TO MAIN — the retry loop can spin for ever …",
  "notes": "src/poll.mjs:41 — …",
  "nudge": { "role": "impl", "message": "Bound the retry loop in src/poll.mjs:41, push, and nudge me back." }
}
```

and issue-herd relays it: the `impl` run on the same issue gets **another turn straight away**,
through the same `herdr agent prompt` a person would have typed. It is the same turn machinery as
`passes` — same run key, claim, worktree and (when it is still up) session; the previous result is
set aside as `result.pass1.json`; the brief names the turn, quotes the nudge, and points at what
the run said last time — but it is asked for by another role rather than earned by the issue moving
on, so it is not measured against `passes`, and it does not wait for a poll. A list of nudges
reaches several roles, which is how an implementer that has pushed a fix hands it back to both
reviewers at once.

The trail stays on the issue. The nudging run's finish comment carries the nudge and what happened
to it; the nudged turn's pickup comment says who asked for it; `issue-herd status` lists the
conversation per issue. A nudge is the *ask* — the report goes in `summary` and `notes` as usual,
and a verdict that needs no action is just a comment.

Three things keep it from running away:

- **It is capped.** `"maxNudges": 6` (top-level, that is the default) is how many nudges the
  agents may relay on one issue, all roles together. The seventh is refused, the finish comment says
  so, and you get a 🙋 comment and notification (`onBlocked`): a person is needed. Raise it in `config.local.json` to let
  them carry on, or `issue-herd reset <issue>` to hand the budget back. `0` turns nudging off, and
  the briefs then say nothing about it.
- **A busy role is not interrupted.** A nudge for a run in the middle of a turn — or already
  promised one by another nudge a moment earlier — is held and becomes its next turn the moment
  that one finishes, together with anything else held meanwhile: two reviewers answering at once
  give the implementer one turn and then another, never two on top of each other. A held nudge
  survives a restart; recovery delivers it, even to a run whose agent died.
- **A person still wins.** Every nudged turn re-reads the issue: one assigned to somebody else in
  the meantime is left alone, exactly as any turn would be. And the briefs tell the agents to write
  `needs_human` rather than nudge again when they are going round in circles or the issue asks for
  a person.

The briefs that ship all teach it (through `{{nudgeLines}}`, which the watcher renders only for a
role with somebody to nudge). A brief of your own that drops the placeholder simply does not offer
the move. Turns started by a nudge are not held by `maxConcurrent`: the session is already there.

## Three roles on GitHub: what this repository runs

issue-herd works its own issues, so `.issue-herd/config.json` in this repository is a worked
example you can read in full. GitHub has no workflow states — `state` is `open` or `closed` — so
the handoff between the roles is a **label the implementer adds when its PR is up**:

```jsonc
{
  "roles": ["impl", "review", "usability"],
  "rules": [
    { "name": "implement", "role": "impl",
      "match": "label:ai and not label:ready-for-review",
      "model": "claude-fable-5-1" },
    { "name": "tech-lead", "role": "review", "basedOn": "impl",
      "match": "label:ai and label:ready-for-review",
      "agentKind": "codex", "model": "gpt-6-astra", "effort": "high",
      "prompt": "prompts/review-lead.md" },
    { "name": "usability", "role": "usability", "basedOn": "impl",
      "match": "label:ai and label:ready-for-review",
      "model": "opus", "effort": "high",
      "prompt": "prompts/review-usability.md" }
  ]
}
```

One issue, three claims: `herdr:impl` while it is being built, then `herdr:review` and
`herdr:usability` in parallel over the same commits (`basedOn: "impl"` gives both reviewers the
implementer's branch, so they run the tests rather than take its word for them). The implementer is
told to add the label in `.issue-herd/instructions.md`, which is the file every brief on this repo
ends with — the reviewers are told to leave labels alone. Three different models, because a review
by the model that wrote the code is a re-read, not a review.

Say who merges in `.issue-herd/instructions.md` too — the scaffolded copy only says "unless the
issue grants it". This repository's says: the owner, unless the issue says "auto merge when
reviewed" (or words to that effect), in which case the implementer merges once `OK TO MERGE TO
MAIN` and `USABILITY: OK` have both landed on the issue. The implementer's brief tells it to stay
up after its result is in, waiting for the two reports, and to merge nothing while either is
missing. That needs `onDone.closeWorkspace` off (the default) on the implementer's rule, and
`onDone.comment` on for every reviewer's — a verdict the implementer cannot see on the issue is a
verdict it will wait for forever. The same open session is what lets the implementer keep its PR
mergeable while the reviews take their time: the watcher tells it when GitHub reports conflicts,
and the brief has it merge the base branch in and push
([how it works](how-it-works.md#keeping-up-with-main)).

Once the reviewers have run, the loop closes without anyone typing: a `NOT OK` review nudges
`impl`, which fixes, pushes and nudges both reviewers back; a second `OK` is a comment the
implementer sees. The implementer's rule stops matching once the label is on, which is fine —
a nudged turn is not a pickup, so `match` is never consulted for it. Six nudges is roughly two
rounds of that before a person is asked in ([Working together](#working-together-nudges)).

Nothing here is GitHub-specific except the handoff: on Linear the same shape uses
`"match": "label:ai and state:\"In Review\""` and `onDone.state`, and no label is needed.
