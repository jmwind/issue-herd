# How to work in this repository

issue-herd works its own GitHub issues with this file. Keep it short and concrete.

## Read first

- `README.md`: the commands, the config reference, and "Issue trackers" / "Signing in" if the
  issue touches a tracker or auth.
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
