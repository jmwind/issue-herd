weawr is a team and coordination layer that works on `herdr`. While `herdr` provides a great platform for agents to work. It doesn't provide the description of how a team works together and when and how humans are involved.

weawr uses the tools humans use, and uses them with agents. The control plane is issues and pull requests. Work starts with an issue with context and updates for the team. The handoffs between agents are humans are the same as it's always been between humans.

```
This is an alpha release. For preview. Things will change.
```

https://github.com/user-attachments/assets/0fead16c-385e-4798-b5ac-a1716cc50845

No webhook you have to expose. It is a Node script and
the `herdr` CLI on your laptop. That's it.

## Why you'd want it

- **The team lives in your repo, not in a service.** The tracker, the rules and the agent's briefing all
  live in `.weawr/` inside the repository.
- **You can walk in on any agent.** Every run is a herdr workspace in the sidebar with the issue key
  on it. Step in, read the scrollback, take over, type. Nothing is hidden in a container you cannot
  reach.
- **Answers their own questions** Using herdr APIs, agents can nudge each other with safeguards on how often and
  resolve their reviews, questions themselves.
- **A reviewer that is not the same eyes.** Roles let an implementer and a reviewer hold the same
  issue at once, on different providers and different models, with the reviewer's worktree cut from
  the implementer's actual branch.
- **It knows when it is done.** After the PR opens the run keeps watching it. When it merges you get
  told, and it tears down only what you asked it to.
- **It keeps its PRs mergeable.** While a PR waits on you, other PRs land. When GitHub says one has
  drifted into conflicts, the implementer is sent back to merge the base in and push, so what you
  open to review is still something you can merge.
- **It fails visibly.** An agent stuck on a permission dialog or stopped with a question gets one
  comment on the issue and one notification, naming the workspace to open. It does not sit there
  silently burning an afternoon.

## Install

```bash
npm install -g github:jmwind/weawr
```

## Set up a repository

```bash
cd ~/Code/your-repo
weawr init          # writes .weawr/, gitignores the right things
weawr login         # once per machine, for every repo (uses `gh auth token` if you have it)
weawr smoke         # end-to-end test against herdr with a fake issue, no tracker calls
weawr dry-run       # what your rules would pick up right now, touching nothing
```

Then edit the two files `init` wrote, and commit them:

- **`.weawr/config.json`** — the rules. What to pick up, how many at a time, which agent.
- **`.weawr/instructions.md`** — how to work in *this* repo. The checks to run before a PR,
  the things never to do, your branch and PR conventions, when to stop and ask a human. Every
  agent gets it appended to its brief. This file is most of the difference between a team that
  produces work and one that produces cleanup.

Create the label your rules trigger on (`ai`, say). The claim label is created for you.

Now run the watcher, inside herdr, from the repo the team is working in:

```bash
weawr
```

One watcher per repository. Leave the pane alone — herdr keeps it alive when you detach. You can watch agents coming as going as work is assigned to the team. You'll also want to silence those `herdr` sounds as the agents will be working, pausing, nudging... like a real team. The micro-agent handoffs are in issues and pull request. For now, the only time I just into an actual agent session is when something went wrong or there's permission block.

## Scheduled tasks

Coming soon...

## Console

After a few weeks of using weawr there are two ways that I liked to interact with the tool. The first, is by having a group of lead agents in Grok / Muse that supervise the team for me and give me updates as needed. It's also a great voice interface for creating and assigning issues. 

<p align="center">
<img width="233" height="566" alt="IMG_6421" src="https://github.com/user-attachments/assets/ebc2815b-02eb-4cbb-9cae-e7f0fe6441a2" />
</p>

But when the team is cooking on a lot more tasks, it's also fun to track their work a bit more. So you can run the console for a local web view of the teams and their status. 

```bash
weawr console
```
<p align="center">
<img width="233" height="566" alt="Screenshot 2026-09-11 at 8 11 01 AM" src="https://github.com/user-attachments/assets/169ef450-c630-4caa-9a78-074d25c8aa85" />
<img width="230" height="590" alt="Screenshot 2026-09-11 at 8 10 36 AM" src="https://github.com/user-attachments/assets/6dbb9856-a038-4efc-9493-388009446499" />
</p>

## Example teams

Four configurations, from a one-line team to a two-shift line. Copy one into
`.weawr/config.json` — it is strict JSON, no comments — and every rule inherits `defaults`.
Every key is explained in the [configuration reference](docs/configuration.md).

### One agent, one label

The whole thing. Label an issue `ai`, get a pull request. This is the simplest, but more risky.

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

## Issue rules

The issue rules determine how to assign to your agent team. There is support for Linear and Github for now. It's easy to add new issue providers.

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
weawr match "label:ai and team:ENG"
```

The same fields work on every tracker — the full table, and what each one maps to on GitHub, is in
the [configuration reference](docs/configuration.md#the-rule-language).

## Commands

| command | what it does |
|---|---|
| `weawr` | **the watcher.** Evaluates your rules every `pollSeconds`, picks up matches, supervises them. Config edits are picked up live, no restart. |
| `weawr once` | one poll, then exit (stays up while it supervises what it took) |
| `weawr dry-run` | print what would be picked up, change nothing |
| `weawr match "<expr>"` | evaluate an ad hoc expression against open issues, change nothing |
| `weawr status` | tracked runs, their outcome, and each live agent's state |
| `weawr console` | **the team room**: every team on this machine, in a browser, phone first — what needs you, what is assembling, today's output |
| `weawr reset <KEY>` | forget a run so the issue can be picked up again |
| `weawr login [linear\|github] [--paste]` | sign in and save the token for this machine |
| `weawr logout [linear\|github]` | forget the saved token |
| `weawr smoke` | end-to-end herdr test with a fake issue, no tracker calls |
| `weawr demo [list\|<scenario>\|reset]` | a team to try weawr on: file a scenario's issues on the demo repository, run, reset — see [Trying it out](docs/how-it-works.md#trying-it-out-weawr-demo) |
| `weawr init [--tracker linear\|github]` | scaffold `.weawr/` in the current repo |
| `weawr update` | reinstall from GitHub; prints the old and new version |

## License

MIT. See [LICENSE](LICENSE).
