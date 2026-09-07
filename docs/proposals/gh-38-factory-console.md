# Factory console: proposal for #38

A locally hosted, single-page console that shows every issue-herd factory running on this machine,
what each agent is doing, what is waiting on you, and one click to the issue, the PR, or the herdr
workspace. This is the plan the issue asked for before any implementation: the UX, the technical
options with trade-offs, and the questions only the owner can answer.

Mockup: `docs/proposals/gh-38-factory-console-mockup.html` (open it in a browser; it is static,
with example figures). Everything in it is derived from data that already exists on this machine
today, nothing depends on a feature that has yet to be built.

## What we have to work with

Every number in the mockup maps to a source that is already there:

| shown | source | cost |
|---|---|---|
| which factories exist | herdr workspaces labelled `<name>Watch` (`issue-herdWatch`, `gustkitWatch`) → pane cwd → `.issue-herd/config.json` | one `herdr api snapshot` |
| team, rules, roles, caps, guards | `config.json` layered with `config.local.json` (the same `loadConfig` the watcher uses) | file read |
| runs, roles, pass, started/finished, branch, worktree, workspace, result, PR URL | `.issue-herd/state/state.json` (`runs` keyed by `GH-7@impl`) | file read, `fs.watch` |
| live agent state (working / blocked / idle / done / gone), which pane, terminal title | `herdr agent list` or the snapshot; herdr also has a socket subscription `pane.agent_status_changed` | one call per refresh, or push |
| "how often did it work on it" | `state/logs/issue-herd.log` transitions (`blocked`, `working again`, `idle`, `done`) plus `git log` on the run's branch | file read |
| task duration | `startedAt` → `finishedAt` per role; PR opened → merged from GitHub | free |
| lines changed, files | `git diff --shortstat <base>...<branch>` in the worktree (instant, no API); PR `additions`/`deletions` as the fallback once the worktree is gone | local git |
| waiting on you | agent `blocked`; run `stopped`/idle without a result; `result.status = needs_human`; PR approved and mergeable but not merged; a reviewer verdict comment on the issue | derived |
| PR checks, review decision, mergeable | GitHub GraphQL `pullRequest { reviewDecision statusCheckRollup mergeable additions deletions changedFiles }` (extends `src/pr.mjs`) | one query per open PR, cached 60s |
| issue state, labels, assignee, comments | the tracker classes already in `src/trackers/` (`issueByKey`) | cached 60s |
| terminal tail for a blocked agent | `herdr agent read <name>` (already used for the blocked comment) | on demand |
| exit an agent | `Herdr.stopAgent()` (sends `/exit`, waits), then optional `workspace close` and `git worktree remove` | existing code |

## UX

One page, no page scroll. Three regions, each scrolls on its own if it has to:

1. **Factory rail** (left). One factory at a time, picked from the tabs in the header: tracker and
   repo, watcher health (version, last poll, API budget, token source), capacity meter against the
   caps, and the team as condensed rule cards: role, agent and model, the match expression, and how
   many of its slots are in use. Guards in one line.
2. **Issue board** (centre). One row per issue, closed ones hidden behind a filter. Columns: key
   (click → issue), title, one lane chip per role with its live state and time on task, elapsed,
   a two-hour activity sparkline, size (`+212 −64 · 6 files` and a T-shirt complexity with the
   reason on hover), PR (click → PR, with checks / review / merge state underneath), and two icon
   actions: open the herdr workspace, exit the agent. Clicking a row opens a detail drawer below
   the list: a per-role timeline (working / blocked / waiting on you / done as bars on one time
   axis, plus a "you" row so the human wait is visible), the change facts and result summary, and
   the PR's checks with the full action set.
3. **Waiting on you** (right). An inbox ordered by urgency: blocked agents with the dialog text
   pulled from the terminal, agents that asked a question, PRs that are approved and green and
   only need your merge, and finished runs still holding a workspace. Every card has the one
   action that clears it. A second group, "finished, still holding", is where exit-and-clean-up
   lives.

Header: factory tabs with running and needs-you counts, `show closed` and `mine only` filters,
a live indicator with the herdr version and hostname. Footer: the watcher's live line, so the
console shows the same thing the pane does.

Keyboard: `j`/`k` rows, `enter` drawer, `o` issue, `p` PR, `w` workspace, `c` closed, `esc`.

### Beyond the ask: what an "insane" console could add

Ranked by value over effort, all of them layered on the same data model:

- **Human wait time as a first-class number.** The timeline's "you" row summed per issue and per
  factory: how long agents spent waiting on a person. It is the metric that tells you whether the
  factory is agent-bound or human-bound.
- **Cost per issue.** Claude Code writes token usage into its session JSONL under
  `~/.claude/projects/<worktree>/`; codex has its own log. Read once at finish, show $ next to
  lines changed. Cost per line changed per role is the number a manager wants.
- **Throughput strip.** Issues picked up, PRs opened, PRs merged, per day, per factory, as three
  small bars. Median pickup-to-merge.
- **Reviewer verdict parsing.** The review briefs end in `OK TO MERGE TO MAIN` / `USABILITY: OK`;
  the console reads the verdict out of the comment and shows it as a check mark on the PR cell,
  so "all three said yes" is visible without opening GitHub.
- **Reply from the console.** A one-line reply box on a "question" card that goes through
  `herdr agent prompt`. Cheap, and it saves the trip to the pane for a yes/no.
- **Diff preview.** `git diff --stat` and the changed file list in the drawer; a click opens the
  file in the PR.
- **Rule dry-run.** "What would be picked up next poll" from the same evaluator `dry-run` uses,
  so a factory that is not picking things up explains itself.
- **A complexity opinion from a model.** A button in the drawer that asks a small model to grade
  the diff (risk, test coverage, blast radius) and caches the answer in the run directory. Opt-in
  because it costs tokens.
- **Sound and badge.** A tab title `(3) Factory Floor` and an optional chime when something new
  lands in "waiting on you", so the browser tab can stay in the background.

## Technical options

### A. Where the console lives

| | 1. `issue-herd console` subcommand (recommended) | 2. separate package, framework front end | 3. each watcher serves its own page |
|---|---|---|---|
| dependencies | none: `node:http`, one HTML file, vanilla JS, SSE | Vite + React (or similar) | none |
| reuses config, trackers, auth, herdr driver, pr.mjs | yes, direct import | no, duplicated or extracted into a shared package | yes |
| cross-factory view | yes, one process discovers all factories | yes | no, one port per factory, no roll-up |
| rich UI effort | higher discipline: no build step, one file of vanilla JS | easier for a large UI | same as 1 |
| install | already installed | second install, second update path | already installed |
| respects "never add an npm dependency" | yes | no | yes |

Recommendation: 1. It is the only option that keeps the tool's contract (zero deps, one install)
and gives the cross-factory view the issue asks for. The single-file front end is the cost; keep
it disciplined (a data model, a render function, no framework) and split into a few files under
`src/console/` served by the same process.

### B. Live data: poll or subscribe

| | poll `herdr api snapshot` + `state.json` every 2s | herdr socket subscription (`pane.agent_status_changed`) + `fs.watch` |
|---|---|---|
| effort | small, the driver exists | new: talk to the socket directly, protocol 20, reconnect |
| latency | up to 2s | immediate |
| robustness | trivially restartable | needs reconnect logic, and a poll fallback anyway |

Recommendation: poll first, with SSE from the console process to the browser so the page is
already push-based; add the subscription later behind the same event stream. The browser never
knows which one is behind it.

### C. Finding factories

| | herdr `*Watch` workspaces | a registry the watcher writes (`~/.config/issue-herd/factories.json`) | both |
|---|---|---|---|
| works when herdr is running | yes | yes | yes |
| works for a watcher run outside herdr | no | yes | yes |
| stale entries | a closed workspace disappears | needs a liveness stamp per poll | registry with `lastPoll`, workspaces as confirmation |

Recommendation: both. The watcher stamps `{ repo, name, pid, lastPoll, version }` on every poll
(one small write to an existing per-user directory); the console lists registry entries and marks
one stale when `lastPoll` is older than three polls. The `*Watch` workspace is what the "open
watcher" button targets.

### D. Reading run state

Read `state.json` and the log directly (recommended) rather than adding an IPC channel to the
watcher. The file is the source of truth, is already written after every change, and the console
is a reader: a half-written file is retried on the next tick. An IPC channel would be a second
protocol to design, version, and keep compatible across watcher versions on one machine.

### E. Complexity

Three tiers, cheapest first, each optional:

1. **Size** from git: added, removed, files, directories touched, tests added versus code added,
   new files versus edits, dependency manifests touched. Free and instant.
2. **T-shirt heuristic** from those facts: S/M/L/XL with a reason string ("new module, contract
   change, 3 trackers"). Deterministic, explainable, no tokens. This is what the mockup shows.
3. **A model's opinion** on the diff, on demand, cached. Off by default.

### F. Actions and safety

The page is a local web server with buttons that stop agents, so:

- bind to `127.0.0.1` only, on a port from config (`console.port`, default 8498, next to the OAuth
  port);
- a random token in the URL printed at startup, checked on every request, so another local process
  or a drive-by page cannot call it;
- state-changing actions are `POST` with an `Origin` check; the browser confirms exit and clean-up
  with what it is about to do ("send `/exit` to gh-35, close w1X, remove the worktree, 0
  uncommitted files");
- "exit" reuses `stopAgent()` and the `onMerged` cleanup code path, and never forces a worktree
  removal, exactly as the watcher does not.

### G. Tracker enrichment

The trackers already normalise issues; the console needs a few more fields per open PR. Extend
`src/pr.mjs` with one GraphQL query (`reviewDecision`, `statusCheckRollup`, `mergeable`,
`additions`, `deletions`, `changedFiles`, `reviews`). Linear issues get the same PR data because
the PR is on GitHub either way. Cache for 60s per PR and reuse the tracker's rate-limit budget
line in the rail.

## Phasing

1. **Read-only console.** `issue-herd console`: factory tabs, rail, issue board with live agent
   state, elapsed, activity, size from git, links to issue and PR, "waiting on you" from herdr
   state and results. SSE. Registry write in the watcher. Docs and tests for the data model.
2. **Actions.** Open workspace (`herdr workspace focus`), exit agent, exit-and-clean-up, reply to
   a question. Token, Origin check, confirmations.
3. **GitHub and Linear enrichment.** PR checks, review decision, mergeable, verdict parsing,
   PR-based size for runs whose worktree is gone.
4. **Extras**, each its own PR: human wait time, cost per issue, throughput strip, model opinion
   on complexity, dry-run panel.

## Decisions needed before implementation

1. Option A: the subcommand with a zero-dependency front end, or is a framework acceptable for
   this one surface (which would mean relaxing the no-dependency rule for a `console/` package)?
2. Discovery: is a per-user registry written by the watcher acceptable, or should the console rely
   on herdr alone?
3. Should "exit" also offer clean-up (close workspace, remove worktree), or strictly stop the agent?
4. Which extras from the list are worth doing in phase 1 rather than later? Human wait time is
   cheap and, in my view, the most telling.
5. Port and URL scheme: a fixed local port with a token, or a randomly chosen port each start?
