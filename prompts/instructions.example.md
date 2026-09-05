# How to work in this repository

<!-- linear-herd appends this file to every agent brief. Keep it short and concrete: the agent
     also reads the repo's own AGENTS.md / CLAUDE.md, so put only what a one-shot autonomous
     session needs to get right. Delete these comments. -->

## Read first

- `AGENTS.md` (or `CLAUDE.md`) and anything it says to read before starting.

## Checks to run before opening a PR

- The scoped checks for what you touched, e.g. `npm test` in the affected package.
- Never weaken or skip a failing check to go green.

## Never

- Run the full release build or anything that fights a running dev server.
- Restart servers or processes you did not start.

## Branch and PR conventions

- Branch names: `claude/<slug>`. PRs target `main`. Title with the issue key. Do not merge.

## Stop and ask (`needs_human`) when

- The change needs an architecture decision, a new dependency, or a credential you do not have.
