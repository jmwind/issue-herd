# How to work in this repository

weawr works its own GitHub issues with this file. Keep it short and concrete.

## Read first

- `README.md` for what the tool is and the commands; `docs/configuration.md` for the config
  reference and the rule language; `docs/trackers.md` if the issue touches a tracker or auth;
  `docs/roles.md` for anything about roles, reviewers or `passes`.
- Keep them in step: a change to behaviour that the docs describe updates the doc in the same PR,
  and `assets/logo/README.md` is the authority on the mark.
- `src/tracker.mjs` before changing anything under `src/trackers/`: it is the contract every
  tracker must meet.

## Checks to run before opening a PR

- `npm test` (Node's built-in runner, no dependencies). Add or extend a test in `test/` for what
  you changed; tracker changes must keep `test/trackers.test.mjs` green.
- `node bin/weawr.mjs --help` still prints the command list (it is the file header).
- If you touched the GitHub tracker: `node bin/weawr.mjs match "any:true"` in this repo is a
  read-only call against the real API through `gh auth token`.

## Never

- Commit a token, a `credentials.json`, or anything under `.weawr/state/`.
- Add an npm dependency; the tool ships with none.
- Change the normalized issue shape without updating `checkIssue()` and both trackers.

## Branch and PR conventions

- PRs target `main`. Put `Fixes #<n>` in the body. Do not merge unless the issue says you may —
  see "Who merges" below.
- Releases are cut by a maintainer with `npm run release`; do not bump the version.

## Stop and ask (`needs_human`) when

- The change needs a registered OAuth application, a new tracker's real API, or a design decision
  about the tracker contract.

## The three roles on this repository

Every issue here is shared by three agents, each holding its own claim (`herdr:impl`,
`herdr:review`, `herdr:usability`). The wiring is in `.weawr/config.json`; your brief says
which role you are.

- **`impl`** builds the change and opens the PR. When the PR is up and the checks above pass, hand
  off: `gh issue edit <n> --add-label ready-for-review`. That label is the only thing that starts
  the two reviewers — without it, nobody reviews you.
- **`review`** (tech lead) and **`usability`** read that PR and report back as a comment on the
  issue. They do not commit, push, merge, or touch labels: the handoff is the implementer's to
  make, and the merge is never theirs.
- **Talk to each other, not to the owner.** A reviewer whose verdict is `NOT OK` or has blocking
  findings puts them in `notes` *and* nudges the implementer in its result
  (`"nudge": { "role": "impl", "message": "<what must change>" }`) — a comment alone leaves the
  implementer's agent idle. The implementer fixes, pushes to the same PR, writes its result again
  with the same PR URL, and nudges back the reviewer(s) that asked (`[{ "role": "review", … },
  { "role": "usability", … }]`) naming the commits to re-read. An `OK` verdict needs no nudge. The
  issue has `maxNudges` (six) of these before weawr asks the owner in; if you cannot agree
  before then, or the owner has asked to be involved, write `needs_human` and say why.

## Who merges

The owner, unless the issue says otherwise. When the issue description, or a comment on it from
the owner, says the PR may be merged once reviewed ("auto merge when reviewed", "happy for you to
merge"), the **implementer** merges it — after **both** reviewers have reported on the issue and
neither said no: `review` with `OK TO MERGE TO MAIN` and `usability` with `USABILITY: OK`. Both,
not one; a report that has not arrived is not a yes, and a `NOT OK` or a blocking usability finding
means the PR stays open for the owner. Then `gh pr merge <n> --merge` (`main` is merge commits),
check `gh pr view <n> --json state` says `MERGED`, and say on the issue that you merged and why you
were allowed to. Write `result.json` before you start waiting for the reviewers, not after the merge.

Spend the main agent on thinking. Bulk reading — finding a symbol, summarising a file, checking how
a convention is used elsewhere — goes to sub-agents where your agent has them.
