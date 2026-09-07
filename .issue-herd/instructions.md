# How to work in this repository

issue-herd works its own GitHub issues with this file. Keep it short and concrete.

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
- `node bin/issue-herd.mjs --help` still prints the command list (it is the file header).
- If you touched the GitHub tracker: `node bin/issue-herd.mjs match "any:true"` in this repo is a
  read-only call against the real API through `gh auth token`.

## Never

- Commit a token, a `credentials.json`, or anything under `.issue-herd/state/`.
- Add an npm dependency; the tool ships with none.
- Change the normalized issue shape without updating `checkIssue()` and both trackers.

## Branch and PR conventions

- PRs target `main`. Put `Fixes #<n>` in the body. Do not merge.
- Releases are cut by a maintainer with `npm run release`; do not bump the version.

## Stop and ask (`needs_human`) when

- The change needs a registered OAuth application, a new tracker's real API, or a design decision
  about the tracker contract.

## The three roles on this repository

Every issue here is shared by three agents, each holding its own claim (`herdr:impl`,
`herdr:review`, `herdr:usability`). The wiring is in `.issue-herd/config.json`; your brief says
which role you are.

- **`impl`** builds the change and opens the PR. When the PR is up and the checks above pass, hand
  off: `gh issue edit <n> --add-label ready-for-review`. That label is the only thing that starts
  the two reviewers — without it, nobody reviews you.
- **`review`** (tech lead) and **`usability`** read that PR and report back as a comment on the
  issue. They do not commit, push, merge, or touch labels: the handoff is the implementer's to
  make and the merge is a human's.

Spend the main agent on thinking. Bulk reading — finding a symbol, summarising a file, checking how
a convention is used elsewhere — goes to sub-agents where your agent has them.
