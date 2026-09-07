<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/png/lockup-dark.png">
    <img src="assets/logo/png/lockup.png" alt="issue-herd" width="330">
  </picture>
</p>

<p align="center">
  <b>Label an issue. Get a pull request.</b><br>
  A software factory that runs on your own machine, out of your own repo, with your own agents.
</p>

---

issue-herd watches **Linear** or **GitHub Issues**. When an issue matches one of your rules it cuts
a git worktree, opens a **herdr** workspace, starts a **coding agent** in it (Claude Code by
default; codex, gemini, cursor — whatever herdr can start, per rule), hands it a written brief made
from the issue and your repo's own instructions, and then reports back on the issue: picked up →
waiting for you → PR open → merged.

No public URL. No third-party orchestrator. No webhook you have to expose. It is a Node script and
the `herdr` CLI on your laptop, and it has **zero npm dependencies**.

```
[2026-09-07 14:32:41] picking up GH-31 "Retry the upload on 429" (rule ai)
[2026-09-07 14:32:48] GH-31: claude started as agent "gh-31"
[2026-09-07 14:32:49] GH-31: briefed
[2026-09-07 14:35:10] GH-31: blocked — waiting for approval or input in w7
[2026-09-07 14:36:02] GH-31: working again
[2026-09-07 14:38:02] GH-31: done (pr_open) https://github.com/you/app/pull/44
14:38:32 poll #49 · 47 open · 0 matched · 0 picked · running 1: DEV-12 w3 working · 1 awaiting merge · next in 30s
```

One line per thing that happened, and one live line at the bottom rewritten after every poll.

## Why you'd want it

- **It is your repo's factory, not a service.** The tracker, the rules and the agent's briefing all
  live in `.issue-herd/` inside the repository, committed and reviewed like code. Your token stays
  on your machine. Nothing about your codebase leaves your laptop that you did not already send to
  your agent.
- **It never double-works an issue.** Three independent guards — a real claim label written to the
  tracker, the pickup comment, and "somebody else is assigned" — checked with a fresh fetch right
  before claiming. Restart it, delete its state, run it on a second machine: it still will not take
  an issue twice.
- **You can walk in on any agent.** Every run is a herdr workspace in the sidebar with the issue key
  on it. Step in, read the scrollback, take over, type. Nothing is hidden in a container you cannot
  reach.
- **A reviewer that is not the same eyes.** Roles let an implementer and a reviewer hold the same
  issue at once, on different providers and different models, with the reviewer's worktree cut from
  the implementer's actual branch.
- **It knows when it is done.** After the PR opens the run keeps watching it. When it merges you get
  told, and it tears down only what you asked it to.
- **It fails visibly.** An agent stuck on a permission dialog or stopped with a question gets one
  comment on the issue and one notification, naming the workspace to open. It does not sit there
  silently burning an afternoon.

## Install

```bash
npm install -g github:jmwind/issue-herd
```

You need **Node 22+**, the `herdr` CLI with its server running,
an agent on your PATH and logged in (`claude`, `codex`, …), and `gh` logged in so agents can open
pull requests. Update with `issue-herd update`; the watcher tells you when there is a new version.

## Set up a repository

```bash
cd ~/Code/your-repo
issue-herd init          # writes .issue-herd/, gitignores the right things
issue-herd login         # once per machine, for every repo (uses `gh auth token` if you have it)
issue-herd smoke         # end-to-end test against herdr with a fake issue, no tracker calls
issue-herd dry-run       # what your rules would pick up right now, touching nothing
```

Then edit the two files `init` wrote, and commit them:

- **`.issue-herd/config.json`** — the rules. What to pick up, how many at a time, which agent.
- **`.issue-herd/instructions.md`** — how to work in *this* repo. The checks to run before a PR,
  the things never to do, your branch and PR conventions, when to stop and ask a human. Every
  agent gets it appended to its brief. This file is most of the difference between a factory that
  produces work and one that produces cleanup.

Create the label your rules trigger on (`ai`, say). The claim label is created for you.

Now run the watcher, inside herdr, from the repo:

```bash
herdr tab create --label issue-herd --cwd "$PWD" --no-focus
herdr pane run <pane-id> "issue-herd"
```

One watcher per repository. Leave the pane alone — herdr keeps it alive when you detach.

## Example factories

Four configurations, from a one-line factory to a two-shift line. Copy one into
`.issue-herd/config.json` — it is strict JSON, no comments — and every rule inherits `defaults`.
Every key is explained in the [configuration reference](docs/configuration.md).

### One agent, one label

The whole thing. Label an issue `ai`, get a pull request.

```json
{
  "tracker": "github",
  "rules": [
    { "name": "ai", "match": "label:ai and not state:started" }
  ]
}
```

### Two shifts: a builder, and a reviewer who is not the same model

A second opinion is only a second opinion if it is not the same eyes.

`roles` lets both agents hold the same issue at once, each with its own claim, branch and worktree.
`basedOn` cuts the reviewer's worktree from the *implementer's* branch, so it is reading the actual
change and can run the tests. `passes` gives it three turns — review, confirm the fix, sign off —
and each later turn is granted only when the issue has really moved on, so a reviewer can never be
woken by its own comment. A reviewer also needs its own brief: the built-in one tells an agent to
implement the issue, which is not the job. `prompts/review-lead.md` ships with the tool, alongside
usability and security briefs — a rule can name one without copying it.

```json
{
  "tracker": "linear",
  "maxConcurrent": 4,
  "roles": ["impl", "review"],
  "rules": [
    { "name": "build", "role": "impl", "match": "label:ai and not state:started",
      "model": "opus" },

    { "name": "review", "role": "review", "match": "label:ai and state:\"In Review\"",
      "agentKind": "codex", "model": "gpt-5-codex", "effort": "high",
      "basedOn": "impl", "passes": 3, "prompt": "prompts/review-lead.md" }
  ]
}
```

### A separate desk for docs

Rules are evaluated in order and the first match wins, so the specific one goes first. A docs issue
gets a cheaper model, its own briefing file, and no notification when it lands; everything else
falls through to the general rule.

```json
{
  "tracker": "github",
  "rules": [
    { "name": "docs", "match": "label:ai and label:documentation",
      "model": "haiku", "instructionsFile": "instructions-docs.md",
      "onDone": { "comment": true, "notify": false } },

    { "name": "ai", "match": "label:ai", "model": "opus" }
  ]
}
```

### The night shift, on one machine only

`.issue-herd/config.local.json` is gitignored, has the same shape, and is layered over
`config.json`: top-level keys replace, `defaults` merge key by key, rules merge by `name`. This is
where "my laptop runs it differently" goes without touching what the team committed.

Here that machine runs six at a time, takes only urgent and high priority, leaves docs issues to
somebody else, and stamps its own claim label on what it takes so the issue records which machine
did the work.

```json
{
  "maxConcurrent": 6,
  "defaults": { "claimLabel": "herdr-jml-mbp" },
  "rules": [
    { "name": "docs", "enabled": false },
    { "name": "ai", "match": "label:ai and priority<=2" }
  ]
}
```

## Rules

```
label:ai and team:ENG and not state:started
(label:ai or label:agent) project:Webapp priority<=2
assignee:me state:todo updated<1d
```

`label` `project` `team` `assignee` `creator` `state` `priority` `estimate` `title` `key` `cycle`
`age` `updated` `any`, compared with `:` `=` `!=` `<` `<=` `>` `>=` (`*` wildcards, case
insensitive), combined with `and` `or` `not` and parentheses. Two terms side by side mean `and`.

Try one before you commit it:

```bash
issue-herd match "label:ai and team:ENG"
```

The same fields work on every tracker — the full table, and what each one maps to on GitHub, is in
the [configuration reference](docs/configuration.md#the-rule-language).

## Commands

| command | what it does |
|---|---|
| `issue-herd` | **the watcher.** Evaluates your rules every `pollSeconds`, picks up matches, supervises them. Config edits are picked up live, no restart. |
| `issue-herd once` | one poll, then exit (stays up while it supervises what it took) |
| `issue-herd dry-run` | print what would be picked up, change nothing |
| `issue-herd match "<expr>"` | evaluate an ad hoc expression against open issues, change nothing |
| `issue-herd status` | tracked runs, their outcome, and each live agent's state |
| `issue-herd console` | **the factory floor**: every factory on this machine, in a browser, phone first — what needs you, what is assembling, today's output |
| `issue-herd reset <KEY>` | forget a run so the issue can be picked up again |
| `issue-herd login [linear\|github] [--paste]` | sign in and save the token for this machine |
| `issue-herd logout [linear\|github]` | forget the saved token |
| `issue-herd smoke` | end-to-end herdr test with a fake issue, no tracker calls |
| `issue-herd init [--tracker linear\|github]` | scaffold `.issue-herd/` in the current repo |
| `issue-herd update` | reinstall from GitHub; prints the old and new version |

## Docs

| | |
|---|---|
| [Configuration](docs/configuration.md) | `config.json` reference, the rule language, per-machine overrides |
| [Issue trackers](docs/trackers.md) | Linear and GitHub Issues, what the fields map to, signing in, adding a tracker |
| [Roles](docs/roles.md) | several agents on one issue, a reviewer on another provider, `basedOn`, `passes` |
| [How it works](docs/how-it-works.md) | the guards, a run start to finish, what happens when the PR merges, the console, troubleshooting |
| [Maintainers](docs/maintainers.md) | cutting a release, hacking on the tool |
| [The mark](assets/logo/README.md) | the logo, and the rules for using it |

## License

MIT. See [LICENSE](LICENSE).
